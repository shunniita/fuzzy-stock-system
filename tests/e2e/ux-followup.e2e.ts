import { expect, test } from '@playwright/test';
import { goTo, lot, record, recorded, selectOperation, startEmpty, storageBytes, waitForApp, openCodeInput } from './helpers.ts';

declare global {
  interface Window {
    followupSaveStates: { text: string; tone: string | null }[];
  }
}

test('FH-UX: 入力拒否は初回も保存成功後もヘッダーに示し、記録を変えない', async ({ page }) => {
  await startEmpty(page);
  const before = await storageBytes(page);
  await record(page, 'register', {});
  await expect.soft(page.locator('#save [data-tone]')).toHaveAttribute('data-tone', 'error');
  await expect.soft(page.locator('#save')).toContainText('記録していない');
  expect(await storageBytes(page)).toEqual(before);
  await recorded(page, 'register', lot('stock', 'P', 'S1', 'counted', '50'), '08:00');
  await recorded(page, 'use', { lot: 'stock', basis: 'counted', value: '60', usedFor: '架空の組立' }, '09:00');
  await goTo(page, 'issues');
  const row = page.getByRole('row').filter({ hasText: '負数になるため未反映' }).first();
  const issue = await row.getByRole('button', { name: /^op\d+$/ }).innerText();
  const saved = await storageBytes(page);
  await record(page, 'resolve', { issue, outcome: 'apply' }, '10:00');
  await expect(page.locator('#save [data-tone]')).toHaveAttribute('data-tone', 'error');
  await expect(page.locator('#save')).toContainText('適用すると負数になる');
  await expect(page.locator('#save')).not.toContainText('保存した（');
  await expect(page.locator('#input > [role=status]')).toContainText('適用すると負数になる');
  expect(await storageBytes(page)).toEqual(saved);
});

test('FH-UX: 正常な保存の途中を中立に示し、完了後だけ成功を示す', async ({ page }) => {
  await startEmpty(page);
  await page.evaluate(() => {
    window.followupSaveStates = [];
    const save = document.getElementById('save');
    if (save === null) throw new Error('保存欄がない');
    new MutationObserver(() => {
      window.followupSaveStates.push({ text: save.innerText, tone: save.querySelector('[data-tone]')?.getAttribute('data-tone') ?? null });
    }).observe(save, { childList: true, subtree: true, characterData: true });
  });
  await recorded(page, 'register', lot('stock', 'P', 'S1', 'counted', '50'), '08:00');
  const saving = (await page.evaluate(() => window.followupSaveStates)).filter(state => state.text.includes('保存中'));
  expect(saving.length).toBeGreaterThan(0);
  for (const state of saving) {
    expect(state.tone).toBe('info');
    expect(state.text).not.toContain('記録を入力できます');
    expect(state.text).not.toContain('エラー');
  }
  await expect(page.locator('#save [data-tone]')).toHaveAttribute('data-tone', 'success');
});

test('FH-UX: 実際の保存失敗を示した後も、次の入力拒否の理由をヘッダーに示す', async ({ page }) => {
  await startEmpty(page);
  await page.goto('/?test');
  await waitForApp(page);
  await page.evaluate(() => {
    if (window.fuzzyStockTest === undefined) throw new Error('保存障害の試験設定がない');
    window.fuzzyStockTest.failMidwayAt(1);
  });
  await record(page, 'register', lot('stock', 'P', 'S1', 'counted', '50'), '08:00');
  await expect(page.locator('#save [data-tone]')).toHaveAttribute('data-tone', 'error');
  await expect(page.locator('#save')).toContainText('保存できなかった（記録されていない）');
  const before = await storageBytes(page);
  await record(page, 'register', { newId: '' }, '08:00');
  const reason = await page.locator('#input > [role=status]').innerText();
  await expect(page.locator('#save')).toContainText(reason);
  await expect(page.locator('#save')).not.toContainText('保存できなかった（');
  expect(await storageBytes(page)).toEqual(before);
});

test('FH-UX: 入力先と検索を一組にし、検索・候補表示だけでは入力や台帳を変えない', async ({ page }) => {
  await startEmpty(page);
  const form = page.getByRole('form', { name: '操作の入力' });
  const code = page.getByRole('region', { name: 'コード入力補助' });
  await openCodeInput(page);
  const search = code.getByRole('button', { name: '検索', exact: true });
  await expect(search).toBeDisabled();
  const group = code.getByRole('group', { name: '検索して入力する対象' });
  await expect(group.getByLabel('コードの入力先')).toHaveValue('');
  await expect(group).toContainText('入力先を選んでから検索');
  const query = group.getByRole('searchbox', { name: '名称・品番・コードで検索' });
  await query.fill('P');
  const before = await storageBytes(page);
  await group.getByLabel('コードの入力先').selectOption('item');
  await expect(query).toHaveAttribute('placeholder', '品目の名称・品番・コード');
  await search.click();
  await expect(code.locator('[data-code-options]').getByRole('button', { name: /架空部品P/ })).toBeVisible();
  await expect(form.locator('[name=item]')).toHaveValue('');
  expect(await storageBytes(page)).toEqual(before);
  await code.locator('[data-code-options]').getByRole('button', { name: /架空部品P/ }).click();
  await expect(form.locator('[name=item]')).toHaveValue('P');
  expect(await storageBytes(page)).toEqual(before);
  await selectOperation(form.locator('[name=op]'), 'merge');
  await expect(code.getByRole('button', { name: '検索', exact: true })).toBeDisabled();
  await expect(code.getByLabel('コードの入力先')).toHaveValue('');
});
