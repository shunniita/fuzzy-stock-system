import { expect, test, type Locator, type Page } from '@playwright/test';
import { goTo, lot, recorded, selectOperation, startEmpty, storageBytes, waitForApp } from './helpers.ts';
import { snapshotOf } from './conflict-helpers.ts';

const formOf = (page: Page) => page.getByRole('form', { name: '操作の入力' });
async function choose(page: Page, key: string): Promise<Locator> {
  await goTo(page, 'stock');
  await selectOperation(formOf(page).locator('[name=op]'), key);
  return formOf(page);
}

async function prepare(page: Page): Promise<void> {
  await startEmpty(page);
  await recorded(page, 'register', lot('S-1', 'S', 'S1', 'counted', '200', { unit: '本' }), '09:00');
  await recorded(page, 'register', lot('P-1', 'P', 'S1', 'counted', '50'), '09:00');
  const form = await choose(page, 'templateSave');
  await form.getByLabel('セット名（120文字まで）').fill('架空製品Rの構成');
  await form.locator('[name=templateProduct]').selectOption('R');
  await form.locator('[name=templateProductUnit]').selectOption('台');
  for (const [i, item, unit, quantity] of [[0, 'S', '本', '4'], [1, 'P', '個', '1']] as const) {
    if (i > 0) await form.getByRole('button', { name: '明細を追加', exact: true }).click();
    await form.locator(`[name=t${i}item]`).selectOption(item);
    await form.locator(`[name=t${i}unit]`).selectOption(unit);
    await form.locator(`[name=t${i}perSet]`).fill(quantity);
    await form.locator(`[name=t${i}location]`).selectOption('S1');
  }
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
}

async function startForm(page: Page, id: string): Promise<Locator> {
  const form = await choose(page, 'recipeStart');
  await form.locator('[name=process]').selectOption('R組立');
  await form.locator('[name=newId]').fill(id);
  await form.locator('[name=item]').selectOption('R');
  await form.locator('[name=project]').selectOption('A-001');
  await form.locator('[name=location]').selectOption('T');
  await form.locator('[name=basis]').selectOption('counted');
  await form.locator('[name=value]').fill('20');
  await form.locator('[name=occurredAt]').fill('2026-09-29T12:00');
  const recipe = form.locator('[name=recipe]');
  await recipe.selectOption({ index: 1 });
  await form.getByRole('button', { name: '使用候補を出す' }).click();
  return form;
}

test('AT-43: 20台分の候補から追加使用2本を反映し、確定した使用だけを減らす', async ({ page }) => {
  await prepare(page);
  const before = await storageBytes(page), form = await startForm(page, 'W1');
  await expect(form.locator('[name=e0u0value]')).toHaveValue('80');
  await expect(form.locator('[name=e1u0value]')).toHaveValue('20');
  await expect(form).toContainText('台数20台から求めた候補です');
  // 候補の表示だけでは保存しない（1.4）。
  expect(await storageBytes(page)).toEqual(before);
  await form.locator('[name=e0u0lot]').selectOption('S-1');
  await form.locator('[name=e0u0value]').fill('82');
  await expect(form.locator('[data-estimate-total]').first()).toContainText('算出との差+2本');
  await form.locator('[name=e1decision]').selectOption('exclude');
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('確認してください');
  await form.locator('[name=estimateConfirmed]').check();
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
  const saved = await snapshotOf(page);
  const s1 = saved.ledger.lots['S-1']!.quantity, p1 = saved.ledger.lots['P-1']!.quantity;
  expect(s1.kind === 'known' ? s1.numeric.value : null).toBe(118);
  expect(p1.kind === 'known' ? p1.numeric.value : null).toBe(50);
  expect(saved.supply.log.find(e => e.kind === 'usageEstimate')).toMatchObject({ sets: 20, rows: [{ calculated: 80, confirmed: 82, decision: 'use' }, { calculated: 20, confirmed: null, decision: 'exclude' }] });
  await page.reload(); await waitForApp(page);
  expect((await snapshotOf(page)).supply.log).toEqual(saved.supply.log);
  await goTo(page, 'supply');
  await expect(page.locator('#supply ol[aria-label="供給の記録の履歴"] li').filter({ hasText: 'セット推計 ' })).toContainText('算出80本→確定82本（差+2本）');
});

test('AT-43: 同じ入力で推計と手入力に同じ材料を入れると重ねて減らさず、構成未登録は推計を保留する', async ({ page }) => {
  await prepare(page);
  const form = await startForm(page, 'W2');
  await form.locator('[name=e0u0lot]').selectOption('S-1');
  await form.locator('[name=e1u0lot]').selectOption('P-1');
  await form.locator('[name=m1lot]').selectOption('S-1');
  await form.locator('[name=m1basis]').selectOption('counted');
  await form.locator('[name=m1value]').fill('80');
  await form.locator('[name=estimateConfirmed]').check();
  const before = await storageBytes(page);
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('推計の明細1と同じ品目・単位');
  expect(await storageBytes(page)).toEqual(before);
  // 候補を出し直したら、前の候補で付けた確認を引き継がない（3.8）。
  await form.getByRole('button', { name: '使用候補を出す' }).click();
  await expect(form.locator('[name=estimateConfirmed]')).not.toBeChecked();
  const other = await choose(page, 'recipeStart');
  await other.locator('[name=item]').selectOption('P');
  await expect(other.locator('[data-recipe-status]')).toContainText('構成未登録');
  await expect(other.getByRole('button', { name: '使用候補を出す' })).toBeHidden();
});
