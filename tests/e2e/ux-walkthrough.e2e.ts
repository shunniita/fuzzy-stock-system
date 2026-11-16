import { expect, test } from '@playwright/test';
import { lot, record, recorded, startEmpty } from './helpers.ts';
import { snapshotOf } from './conflict-helpers.ts';

for (const basis of ['counted', 'label', 'approximate', 'unknown'] as const) {
  test('UX必須3: 使用の注意は' + basis + 'の数量と入力に追従し、超過も記録できる', async ({ page }) => {
    await startEmpty(page);
    await recorded(page, 'register', lot('stock', 'P', 'S1', basis, basis === 'unknown' ? '' : '50'), '08:00');
    const form = page.getByRole('form', { name: '操作の入力' });
    await page.locator('#list tr[data-lot="stock"]').getByRole('button').click();
    await page.locator('#detail [data-op=use]').click();
    const before = await snapshotOf(page);
    await form.locator('[name=basis]').selectOption('counted');
    await form.locator('[name=value]').fill('60');
    const warning = form.locator('#quantity-warning-value');
    if (basis === 'counted' || basis === 'label') {
      await expect(warning).toBeVisible();
      await expect(warning).toContainText('記録上の数50個を超える');
      await expect(warning).toContainText('差し引くと負数になる');
    } else await expect(warning).toBeHidden();
    await form.locator('[name=value]').fill('50');
    await expect(warning).toBeHidden();
    await expect(form.locator('[name=value]')).not.toHaveAccessibleDescription(/を超える/);
    await form.locator('[name=value]').fill('49');
    await expect(warning).toBeHidden();
    await form.locator('[name=basis]').selectOption('unknown');
    await form.locator('[name=value]').fill('');
    await expect(warning).toBeHidden();
    expect(await snapshotOf(page)).toEqual(before);
    await form.locator('[name=basis]').selectOption('counted');
    await form.locator('[name=value]').fill('60');
    await form.locator('[name=usedFor]').fill('架空の試作');
    await form.getByRole('button', { name: '記録する', exact: true }).click();
    await expect(page.locator('#input > [role=status]')).toContainText('記録した');
    const after = (await snapshotOf(page)).ledger;
    if (basis !== 'unknown') {
      expect(after.history.at(-1)).toMatchObject({ kind: 'use', applied: false });
      expect(after.lots['stock']?.quantity).toEqual(before.ledger.lots['stock']?.quantity);
      expect(Object.values(after.issues)).toContainEqual(expect.objectContaining({ reason: 'negative', resolution: null }));
    }
  });
}

test('UX必須3: 負数の適用拒否で手順を示し、数えてから反映済みとして閉じる', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('stock', 'P', 'S1', 'counted', '50'), '08:00');
  await recorded(page, 'use', { lot: 'stock', basis: 'counted', value: '60', usedFor: '架空の試作' }, '09:00');
  const pending = (await snapshotOf(page)).ledger;
  const issue = Object.values(pending.issues).find(i => i.reason === 'negative')!;
  await record(page, 'resolve', { issue: issue.id, outcome: 'apply' }, '10:00');
  const status = page.locator('#input > [role=status]');
  await expect(status).toContainText('適用すると負数になる');
  await expect(status).toContainText('数えて確認・訂正');
  await expect(status).toContainText('閉じる（数量に反映済み・適用しない）');
  await expect(page.locator('[name=outcome]')).toContainText('この保管単位の数量へ反映');
  expect((await snapshotOf(page)).ledger).toEqual(pending);
  await recorded(page, 'recount', { lot: 'stock', value: '0', causeUnknown: true }, '11:00');
  await recorded(page, 'resolve', { issue: issue.id, outcome: 'close' }, '12:00');
  const after = (await snapshotOf(page)).ledger;
  expect(after.issues[issue.id]?.resolution?.outcome).toBe('close');
  expect(after.lots['stock']?.quantity).toMatchObject({ kind: 'known', numeric: { value: 0 } });
});
