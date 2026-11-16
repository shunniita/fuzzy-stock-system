import { expect, test } from '@playwright/test';
import { goTo, lot, record, recorded, selectOperation, startEmpty, storageBytes, waitForPersistence } from './helpers.ts';

for (const action of ['edit', 'switch'] as const) test(`UX再点検: 入力拒否は${action}で消える`, async ({ page }) => {
  await startEmpty(page);
  await record(page, 'register', {});
  await expect(page.locator('#save')).toContainText('記録していない');
  const before = await storageBytes(page);
  const form = page.getByRole('form', { name: '操作の入力' });
  if (action === 'edit') await form.locator('[name=newId]').fill('fixed');
  else await selectOperation(form.locator('[name=op]'), 'move');
  await expect(page.locator('#save')).not.toContainText('記録していない');
  await expect(page.locator('#input > [role=status]')).toHaveCount(0);
  expect(await storageBytes(page)).toEqual(before);
});

test('UX再点検: 包含の回答は失敗色にせず、回答して記録できる', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('stock', 'P', 'S1', 'counted', '50'), '09:00');
  await record(page, 'use', { lot: 'stock', basis: 'counted', value: '5', usedFor: '架空の用途' }, '08:00');
  await expect(page.locator('#save')).toContainText('回答が必要');
  await expect.soft(page.locator('#save [data-tone]')).toHaveAttribute('data-tone', 'info');
  await expect.soft(page.locator('#input > [role=status]')).not.toHaveClass('error');
  const form = page.getByRole('form', { name: '操作の入力' });
  await form.locator('[name=inclusion]').selectOption('included');
  await expect(page.locator('#save')).not.toContainText('回答が必要');
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
});

test('UX再点検: 元の資料の名称確認も失敗色にせず、確認して記録できる', async ({ page }) => {
  await startEmpty(page);
  await record(page, 'masterSource', { type: 'item', code: 'P', sourceName: '架空部品P（元の資料の名称）', sourceRevision: '2' }, '08:30');
  await expect(page.locator('#save')).toContainText('確認が必要');
  await expect.soft(page.locator('#save [data-tone]')).toHaveAttribute('data-tone', 'info');
  await expect.soft(page.locator('#input > [role=status]')).not.toHaveClass('error');
  const form = page.getByRole('form', { name: '操作の入力' });
  await form.locator('[name=confirmed]').check();
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
});

for (const op of ['move', 'splitMove'] as const) test(`UX再点検: ${op}の移動先から現在地を除き、対象変更にも追従する`, async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('one', 'P', 'S1', 'counted', '50'), '08:00');
  await recorded(page, 'register', lot('two', 'P', 'S2', 'counted', '50'), '08:00');
  const form = page.getByRole('form', { name: '操作の入力' });
  await selectOperation(form.locator('[name=op]'), op);
  await form.locator('[name=lot]').selectOption('one');
  const destination = form.locator('[name=location]');
  await expect.soft(destination.locator('option[value=S1]')).toHaveJSProperty('disabled', true);
  await destination.selectOption('S2');
  await form.locator('[name=lot]').selectOption('two');
  await expect(destination).toHaveValue('');
  await expect(destination.locator('option[value=S2]')).toHaveJSProperty('disabled', true);
  await expect(destination.locator('option[value=S1]')).toHaveJSProperty('disabled', false);
});

test('UX再点検: 場所の登録はコード、在庫の詳細は場所名も示す', async ({ page }) => {
  await startEmpty(page);
  const form = page.getByRole('form', { name: '操作の入力' });
  await selectOperation(form.locator('[name=op]'), 'masterLocation');
  await expect.soft(form.getByLabel('コード', { exact: true })).toHaveCount(1);
  await recorded(page, 'register', lot('stock', 'P', 'S1', 'counted', '50'), '08:00');
  const place = await page.locator('#list tr[data-lot=stock] td').nth(3).innerText();
  await page.locator('#list tr[data-lot=stock]').getByRole('button').click();
  await expect(page.locator('#detail dt').filter({ hasText: /^場所$/ }).locator('+ dd')).toHaveText(place);
});

for (const width of [1440, 390]) test(`UX再点検: 幅${width}で入れる入力とEnter後の結果が画面内に見える`, async ({ page }) => {
  await page.setViewportSize({ width, height: 720 });
  await page.addInitScript(() => localStorage.setItem('fuzzy-stock-mode', 'simple'));
  await startEmpty(page);
  await goTo(page, 'stock');
  await page.locator('#list').getByRole('button', { name: '入れる', exact: true }).click();
  const form = page.getByRole('form', { name: '操作の入力' });
  await expect.soft(form.locator('[name=item]')).toBeInViewport({ ratio: 1 });
  await form.locator('[name=item]').selectOption('P');
  await form.locator('[name=location]').selectOption('S1');
  await form.locator('[name=basis]').selectOption('counted');
  await form.locator('[name=value]').fill('12');
  await form.locator('[name=value]').press('Enter');
  await waitForPersistence(page);
  const status = page.locator('#input > [role=status]');
  await expect(status).toContainText('記録した');
  await expect(status).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: `.local-logs/ux-review-20261113/result-${width}.png`, fullPage: false });
});

for (const op of ['handover', 'split', 'splitMove', 'stageFix', 'surplusAllocate', 'finish', 'inspect', 'toNext', 'spareSwap', 'reworkReplace'] as const) test(`UX再点検: ${op}でも数量超過を入力中に示す`, async ({ page }) => {
  await startEmpty(page);
  const stage = op === 'finish' ? 'working' : op === 'inspect' ? 'inspecting' : op === 'toNext' ? 'awaitingHandover' : 'none';
  await recorded(page, 'register', lot('stock', 'P', 'S1', 'counted', '50', { stage, process: stage === 'none' ? '' : 'R組立' }), '08:00');
  if (op === 'spareSwap') await recorded(page, 'hold', { lot: 'stock', reason: 'spare' }, '08:10');
  const before = await storageBytes(page);
  const form = page.getByRole('form', { name: '操作の入力' });
  await selectOperation(form.locator('[name=op]'), op);
  await form.locator('[name=lot]').selectOption('stock');
  if (op !== 'spareSwap' && op !== 'reworkReplace') await form.locator('[name=basis]').selectOption('counted');
  await form.locator('[name=value]').fill('60');
  await expect(form.locator('#quantity-warning-value')).toContainText('記録上の数50個を超える');
  await form.locator('[name=value]').fill('50');
  await expect(form.locator('#quantity-warning-value')).toBeHidden();
  expect(await storageBytes(page)).toEqual(before);
});

for (const op of ['start', 'recipeStart'] as const) test(`UX再点検: ${op}の同じ材料の使用は順番に試算し、後入力の包含にも従う`, async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('stock', 'P', 'S1', 'counted', '50'), '08:00');
  const before = await storageBytes(page);
  const form = page.getByRole('form', { name: '操作の入力' });
  await selectOperation(form.locator('[name=op]'), op);
  await form.locator('[name=occurredAt]').fill('2026-09-29T09:00');
  for (const i of [1, 2]) {
    await form.locator(`[name=m${i}lot]`).selectOption('stock');
    await form.locator(`[name=m${i}basis]`).selectOption('counted');
    await form.locator(`[name=m${i}value]`).fill('30');
  }
  await expect(form.locator('#quantity-warning-m1value')).toBeHidden();
  await expect(form.locator('#quantity-warning-m2value')).toContainText('先の材料入力を差し引いた残り20個を超える');
  await form.locator('[name=m1value]').fill('60');
  await expect(form.locator('#quantity-warning-m1value')).toBeVisible();
  await expect(form.locator('#quantity-warning-m2value')).toBeHidden();
  await form.locator('[name=m1basis]').selectOption('unknown');
  await form.locator('[name=m1value]').fill('');
  await form.locator('[name=m2value]').fill('60');
  await expect(form.locator('#quantity-warning-m2value')).toBeHidden();
  await form.locator('[name=m1basis]').selectOption('counted');
  await form.locator('[name=m1value]').fill('60');
  await form.locator('[name=occurredAt]').fill('2026-09-29T08:00');
  await expect(form.locator('#quantity-warning-m1value')).toBeHidden();
  expect(await storageBytes(page)).toEqual(before);
});

for (const op of ['split', 'splitMove'] as const) test(`UX再点検: ${op}で独自IDの連番を提案し、手編集は対象変更でも保持する`, async ({ page }) => {
  await startEmpty(page);
  for (const id of ['WATER-01', 'WATER-02', 'custom']) await recorded(page, 'register', lot(id, 'P', 'S1', 'counted', '50'), '08:00');
  const form = page.getByRole('form', { name: '操作の入力' });
  await selectOperation(form.locator('[name=op]'), op);
  await form.locator('[name=lot]').selectOption('WATER-01');
  await expect(form.locator('[name=childId]')).toHaveValue('WATER-03');
  await form.locator('[name=lot]').selectOption('custom');
  await expect(form.locator('[name=childId]')).toHaveValue('');
  await form.locator('[name=childId]').fill('manual-id');
  await form.locator('[name=lot]').selectOption('WATER-02');
  await expect(form.locator('[name=childId]')).toHaveValue('manual-id');
});
