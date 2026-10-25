import { expect, test, type Locator, type Page } from '@playwright/test';
import * as XLSX from 'xlsx';
import { waitForPersistence, backupButton, downloadVia, exportButton, goTo, pickFile, recorded, selectOperation, startEmpty, storageBytes, waitForApp } from './helpers.ts';
import { snapshotOf, draftOf } from './conflict-helpers.ts';

const formOf = (page: Page) => page.getByRole('form', { name: '操作の入力' });
async function choose(page: Page, key: string): Promise<Locator> {
  await goTo(page, 'stock');
  await selectOperation(formOf(page).locator('[name=op]'), key);
  return formOf(page);
}
async function create(page: Page): Promise<string> {
  const form = await choose(page, 'templateSave');
  await form.getByLabel('セット名（120文字まで）').fill('架空PQSセット');
  await form.locator('[name=templateProduct]').selectOption('R');
  await form.locator('[name=templateProductUnit]').selectOption('台');
  for (const [i, item, unit, quantity] of [[0, 'P', '個', '2'], [1, 'Q', '個', '1'], [2, 'S', '本', '4']] as const) {
    if (i > 0) await form.getByRole('button', { name: '明細を追加', exact: true }).click();
    await form.locator(`[name=t${i}item]`).selectOption(item);
    await form.locator(`[name=t${i}unit]`).selectOption(unit);
    await form.locator(`[name=t${i}perSet]`).fill(quantity);
    await form.locator(`[name=t${i}location]`).selectOption('S1');
  }
  await expect(form.locator('[name=templateBasis]')).toHaveValue('label');
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
  const snapshot = await snapshotOf(page);
  const template = Object.values(snapshot.supply.receiptTemplates)[0];
  if (!template) throw new Error('登録した構成がない');
  return template.id;
}
async function preview(page: Page, id: string): Promise<Locator> {
  const form = await choose(page, 'templateReceive');
  await form.locator('[name=template]').selectOption(id);
  await form.locator('[name=project]').selectOption('A-001');
  await form.locator('[name=sets]').fill('10');
  await form.getByRole('button', { name: '予定数を展開' }).click();
  await expect(form.locator('[name=actual0]')).toHaveValue('20');
  await expect(form.locator('[name=actual1]')).toHaveValue('10');
  await expect(form.locator('[name=actual2]')).toHaveValue('40');
  return form;
}
test('要件1〜3: 行編集、数量修正、まとめて受け取り、再読込、変更・削除後の履歴と出力・復元', async ({ page }) => {
  await startEmpty(page);
  const id = await create(page), before = await storageBytes(page), form = await preview(page, id);
  await page.screenshot({ path: '.local-logs/receipt-templates/three-row-preview.png', fullPage: true });
  expect(await storageBytes(page)).toEqual(before);
  await form.locator('[name=actual0]').fill('19');
  await form.locator('[name=actual1]').fill('0');
  await form.locator('[name=templateConfirmed]').check();
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
  const saved = await snapshotOf(page);
  expect(Object.values(saved.supply.receipts).map(r => [r.received, r.provisional])).toEqual([[19, true], [40, true]]);
  expect(saved.supply.receiptTemplates[id]?.rows.map(row => row.perSet)).toEqual([2, 1, 4]);
  const batch = saved.supply.log.find(e => e.kind === 'templateReceipt');
  expect(batch).toMatchObject({ sets: 10, project: { kind: 'case', id: 'A-001' }, vendor: null, template: { name: '架空PQSセット', product: 'R', project: null }, rows: [{ quantity: 19 }, { quantity: 0, lotId: null }, { quantity: 40 }] });
  await page.reload(); await waitForApp(page);
  expect((await snapshotOf(page)).supply.receiptTemplates[id]).toEqual(saved.supply.receiptTemplates[id]);
  const edit = await choose(page, 'templateSave');
  await edit.locator('[name=template]').selectOption(id);
  await expect(edit.locator('[name=t2perSet]')).toHaveValue('4');
  await edit.locator('[name=templateName]').fill('変更後の構成');
  await edit.getByRole('button', { name: '記録する', exact: true }).click();
  const remove = await choose(page, 'templateDelete');
  await remove.locator('[name=template]').selectOption(id);
  await remove.getByRole('button', { name: '記録する', exact: true }).click();
  await goTo(page, 'supply');
  const source = page.locator('#supply ol[aria-label="供給の記録の履歴"] li').filter({ hasText: 'まとめて受け取り ' });
  await expect(source).toContainText('架空PQSセット');
  await expect(source).toContainText('19個');
  const backup = await downloadVia(page, backupButton), excel = await downloadVia(page, exportButton);
  const book = XLSX.read(excel.bytes, { type: 'array' });
  expect(XLSX.utils.sheet_to_csv(book.Sheets['供給の履歴']!)).toContain('架空PQSセット');
  await goTo(page, 'management');
  await page.getByRole('button', { name: '練習用の台帳で初期化' }).click();
  await page.getByRole('button', { name: '初期化する', exact: true }).click();
  expect((await snapshotOf(page)).supply.receiptTemplates).toEqual({});
  await pickFile(page, backup.path);
  await page.getByRole('region', { name: '復元の確認' }).getByRole('button', { name: '復元する', exact: true }).click();
  await waitForPersistence(page);
  expect(Object.keys((await snapshotOf(page)).supply.receipts)).toHaveLength(2);
});

test('要件2.1: 確認後の数量・セット数・日時変更は確認を失効し、エラーでも入力と保存を保つ', async ({ page }) => {
  await startEmpty(page); const id = await create(page), form = await preview(page, id), before = await storageBytes(page);
  const confirm = form.locator('[name=templateConfirmed]');
  await confirm.check(); await form.locator('[name=actual2]').fill('-1');
  await expect(confirm).not.toBeChecked();
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('確認してください');
  await confirm.check(); await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(form.locator('[name=actual2]')).toHaveValue('-1');
  expect(await storageBytes(page)).toEqual(before);
  await form.locator('[name=actual2]').fill('40'); await confirm.check();
  await form.locator('[name=occurredAt]').fill('2026-10-19T10:00'); await expect(confirm).not.toBeChecked();
  await confirm.check(); await form.locator('[name=sets]').fill('2');
  await expect(confirm).not.toBeChecked(); await expect(form.locator('[name=actual0]')).toHaveCount(0);
  await form.getByRole('button', { name: '予定数を展開' }).click();
  await expect(form.locator('[data-template-preview]')).toContainText('A-001');
  await form.locator('[name=project]').selectOption('common');
  await expect(form.locator('[name=actual0]')).toHaveCount(0);
});

for (const rejected of ['未確認', '不正数量']) test(`要件2.1・3.2・ADR-019: ${rejected}の同じ入力欄の再送は最初の担当者と入力した日時を保持する`, async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-19T09:00:00+09:00'));
  await startEmpty(page); const id = await create(page), form = await preview(page, id);
  const before = await storageBytes(page), confirm = form.locator('[name=templateConfirmed]');
  if (rejected === '不正数量') { await form.locator('[name=actual2]').fill('-1'); await confirm.check(); }
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('記録していない');
  expect(await storageBytes(page)).toEqual(before);
  await page.clock.setFixedTime(new Date('2026-10-19T10:00:00+09:00'));
  await page.locator('#actor').selectOption('架空担当B');
  await expect(confirm).not.toBeChecked();
  await form.locator('[name=actual2]').fill('40'); await confirm.check();
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
  const saved = await snapshotOf(page);
  expect(saved.ledger.history).toHaveLength(3);
  expect(saved.ledger.history.map(e => e.actor)).toEqual(['架空担当A', '架空担当A', '架空担当A']);
  expect(saved.supply.log.filter(e => e.kind === 'receiptRecord' || e.kind === 'templateReceipt').map(e => e.actor)).toEqual(Array(4).fill('架空担当A'));
  expect(saved.ledger.history.map(e => e.recordedAt)).toEqual(Array(3).fill('2026-10-19T09:00:00+09:00'));
});

test('要件2.3: 保存を試みたまとめて受け取りは担当者を変えて再送しても最初の担当者を保持する', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-19T09:00:00+09:00'));
  await startEmpty(page); const id = await create(page);
  await page.goto('/?test'); await waitForApp(page);
  const form = await preview(page, id);
  await page.evaluate(() => window.fuzzyStockTest!.failMidwayAt(1));
  await form.locator('[name=templateConfirmed]').check();
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#save')).toContainText('保存できなかった');
  expect(Object.keys((await snapshotOf(page)).supply.receipts)).toHaveLength(0);
  await page.clock.setFixedTime(new Date('2026-10-19T10:00:00+09:00'));
  await page.locator('#actor').selectOption('架空担当B');
  await form.locator('[name=templateConfirmed]').check();
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
  const saved = await snapshotOf(page);
  expect(Object.keys(saved.supply.receipts)).toHaveLength(3);
  expect(saved.supply.log.filter(e => e.kind === 'templateReceipt').map(e => e.actor)).toEqual(['架空担当A']);
  expect(saved.supply.log.filter(e => e.kind === 'templateReceipt').map(e => e.recordedAt)).toEqual(['2026-10-19T09:00:00+09:00']);
});

test('要件2.3: 保存応答不明の全明細を再読込・同じ操作で再試行しても一回だけ受け入れる', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-19T09:00:00+09:00'));
  await startEmpty(page); const id = await create(page);
  await page.goto('/?test'); await waitForApp(page);
  const form = await preview(page, id);
  await page.evaluate(() => {
    if (!window.fuzzyStockTest) throw new Error('試験URLが必要');
    window.fuzzyStockTest.loseResponseAt(1);
  });
  await form.locator('[name=templateConfirmed]').check();
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#save')).toContainText('保存結果不明');
  const bytes = await storageBytes(page), pending = JSON.parse(bytes['fuzzy-stock/pending'] ?? 'null');
  expect(pending.pending.units).toHaveLength(1);
  await page.reload(); await waitForApp(page);
  await page.clock.setFixedTime(new Date('2026-10-19T10:00:00+09:00'));
  await page.locator('#actor').selectOption('架空担当B');
  await page.getByRole('button', { name: '再試行する', exact: true }).click();
  expect(Object.keys((await snapshotOf(page)).supply.receipts)).toHaveLength(3);
  expect((await snapshotOf(page)).supply.log.filter(e => e.kind === 'templateReceipt')).toHaveLength(1);
  expect((await snapshotOf(page)).supply.log.filter(e => e.kind === 'templateReceipt').map(e => e.actor)).toEqual(['架空担当A']);
  expect((await snapshotOf(page)).supply.log.filter(e => e.kind === 'templateReceipt').map(e => e.recordedAt)).toEqual(['2026-10-19T09:00:00+09:00']);
});

test('要件3.2: 320pxとキーボードで行を追加・削除して入力を保持し、画面移動で失わない', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 }); await startEmpty(page);
  const form = await choose(page, 'templateSave');
  await form.locator('[name=templateName]').fill('架空の狭い画面');
  const add = form.getByRole('button', { name: '明細を追加', exact: true });
  await add.focus(); await page.keyboard.press('Enter');
  await expect(form.locator('[name=t1item]')).toBeFocused();
  await form.locator('[name=t1item]').selectOption('Q'); await form.locator('[name=t1unit]').selectOption('個');
  await form.locator('[name=t1perSet]').fill('3');
  await form.getByRole('button', { name: '明細1を削除', exact: true }).click();
  await expect(form.locator('[name=t0item]')).toHaveValue('Q'); await expect(form.locator('[name=t0perSet]')).toHaveValue('3');
  await goTo(page, 'supply'); await goTo(page, 'stock');
  await expect(form.locator('[name=templateName]')).toHaveValue('架空の狭い画面');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('要件3.2: 別画面の更新で未保存の追加明細を競合証拠へ残す', async ({ page, context }) => {
  await startEmpty(page); const id = await create(page);
  const other = await context.newPage(); await other.goto('/'); await waitForApp(other);
  const form = await choose(other, 'templateSave');
  await form.locator('[name=templateName]').fill('未保存の構成');
  await form.getByRole('button', { name: '明細を追加', exact: true }).click();
  await form.locator('[name=t1item]').selectOption('S'); await form.locator('[name=t1unit]').selectOption('本'); await form.locator('[name=t1perSet]').fill('17');
  const remove = await choose(page, 'templateDelete'); await remove.locator('[name=template]').selectOption(id); await remove.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(other.locator('#conflict')).toContainText('未解消');
  const draft = await draftOf(other);
  expect(draft).toContain('未保存の構成'); expect(draft).toContain('17'); expect(draft).toContain('明細2の');
});

test('要件1.2・3.2: 上限50明細を画面から保存・展開・まとめて受け取りでき、51行目を明示的に拒む', async ({ page }) => {
  test.setTimeout(90000);
  await startEmpty(page);
  const form = await choose(page, 'templateSave');
  await form.locator('[name=templateName]').fill('架空50部品');
  await form.locator('[name=templateProduct]').selectOption('R');
  await form.locator('[name=templateProductUnit]').selectOption('台');
  for (let i = 0; i < 50; i++) {
    if (i > 0) await form.getByRole('button', { name: '明細を追加', exact: true }).click();
    await form.locator(`[name=t${i}item]`).selectOption('P');
    await form.locator(`[name=t${i}unit]`).selectOption('個');
    await form.locator(`[name=t${i}perSet]`).fill('1');
    await form.locator(`[name=t${i}location]`).selectOption('S1');
  }
  await form.getByRole('button', { name: '明細を追加', exact: true }).click();
  await expect(form).toContainText('明細は50行までです');
  await expect(form.locator('[name=t49perSet]')).toHaveValue('1');
  await expect(form.locator('[name=t50item]')).toHaveCount(0);
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
  const id = Object.values((await snapshotOf(page)).supply.receiptTemplates)[0]?.id;
  if (!id) throw new Error('50明細の構成が保存されていない');
  const receive = await choose(page, 'templateReceive');
  await receive.locator('[name=template]').selectOption(id); await receive.locator('[name=project]').selectOption('common'); await receive.locator('[name=sets]').fill('2');
  await receive.getByRole('button', { name: '予定数を展開' }).click();
  await expect(receive.locator('[name=actual49]')).toHaveValue('2');
  await expect(receive.locator('[name^=actual]')).toHaveCount(50);
  await receive.locator('[name=templateConfirmed]').check();
  await receive.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
  expect(Object.values((await snapshotOf(page)).supply.receipts).map(row => row.received)).toEqual(Array.from({ length: 50 }, () => 2));
});

test('セット要件3: 紙の欠品リストの不足数を入れると受け取った数が予定−不足になり、手配先への依頼として未着分が残る', async ({ page }) => {
  await startEmpty(page);
  const id = await create(page), form = await preview(page, id);
  await form.locator('[name=shortfall1]').fill('3');
  await expect(form.locator('[name=actual1]')).toHaveValue('7');
  await form.locator('[name=shortfall1]').fill('');
  await expect(form.locator('[name=actual1]')).toHaveValue('10');
  await form.locator('[name=shortfall1]').fill('3');
  await form.locator('[name=templateConfirmed]').check();
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('手配先');
  const before = await storageBytes(page);
  expect(Object.keys((await snapshotOf(page)).supply.receipts)).toHaveLength(0);
  await expect(form.locator('[name=shortfall1]')).toHaveValue('3');
  await form.locator('[name=vendor]').fill('架空商社');
  await form.locator('[name=templateConfirmed]').check();
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
  expect(await storageBytes(page)).not.toEqual(before);
  const saved = await snapshotOf(page);
  expect(Object.values(saved.supply.receipts).map(r => r.received)).toEqual([20, 7, 40]);
  const requests = Object.values(saved.supply.requests);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ item: 'Q', quantity: 3, vendor: '架空商社', project: { kind: 'case', id: 'A-001' }, arrivals: [] });
  expect(saved.supply.log.find(e => e.kind === 'templateReceipt')).toMatchObject({ vendor: '架空商社', rows: [{ shortfall: 0 }, { shortfall: 3, quantity: 7 }, { shortfall: 0 }] });
  await goTo(page, 'supply');
  const source = page.locator('#supply ol[aria-label="供給の記録の履歴"] li').filter({ hasText: 'まとめて受け取り ' });
  await expect(source).toContainText('予定10個・不足3個・受け取り7個');
  await expect(page.locator('#supply')).toContainText('未着3個');
  await page.reload(); await waitForApp(page);
  expect((await snapshotOf(page)).supply.requests).toEqual(saved.supply.requests);
  await goTo(page, 'stock');
  await recorded(page, 'receive', { newId: 'R9', item: 'Q', unit: '個', project: 'A-001', location: 'S1', basis: 'counted', value: '3', r1request: requests[0]!.id, r1arrived: '3', r1good: '3' }, null);
  expect((await snapshotOf(page)).supply.requests[requests[0]!.id]?.arrivals).toMatchObject([{ receiptLotId: 'R9', arrived: 3, good: 3 }]);
  await goTo(page, 'supply');
  await expect(page.locator('#supply')).not.toContainText('未着3個');
});
