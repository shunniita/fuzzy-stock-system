import { expect, test as base, type Page } from '@playwright/test';
import * as XLSX from 'xlsx';
import { practiceLedger, type Meta } from '../../src/domain/ledger.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { receiveTemplate, saveReceiptTemplate, type ReceiptTemplate } from '../../src/domain/receipt-template.ts';
import { initial, serialize } from '../../src/ui/storage.ts';
import { legacyJson } from '../fixtures/history-labels.ts';
import { snapshotOf } from './conflict-helpers.ts';
import { waitForPersistence, backupButton, cell, downloadVia, exportButton, goTo, lot, pickFile, record, recorded, row, selectOperation, startEmpty, storageBytes, waitForApp } from './helpers.ts';

const test = base.extend<{ pageErrors: string[] }>({
  pageErrors: [async ({ page }, use) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.clock.setFixedTime(new Date('2026-09-29T09:00:00+09:00'));
    await use(errors); expect(errors).toEqual([]);
  }, { auto: true }],
});
const formOf = (page: Page) => page.getByRole('form', { name: '操作の入力' });
async function choose(page: Page, op: string) {
  await goTo(page, 'stock'); await selectOperation(formOf(page).locator('[name=op]'), op); return formOf(page);
}
async function submit(page: Page) {
  await formOf(page).getByRole('button', { name: '記録する', exact: true }).click();
  await waitForPersistence(page);
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
}
async function recipeRow(page: Page, index: number, item: string, unit: string, perSet: string) {
  const form = formOf(page);
  if (index > 0) await form.getByRole('button', { name: '明細を追加', exact: true }).click();
  await form.locator(`[name=t${index}item]`).selectOption(item); await form.locator(`[name=t${index}unit]`).selectOption(unit);
  await form.locator(`[name=t${index}perSet]`).fill(perSet); await form.locator(`[name=t${index}location]`).selectOption('S1');
}
async function assembly(page: Page) {
  await startEmpty(page);
  await recorded(page, 'masterItem', { codeNone: true, name: '架空組立X', units: '台' }, '08:00');
  const x = Object.values((await snapshotOf(page)).ledger.masters.items).find(item => item.name === '架空組立X')!.id;
  let form = await choose(page, 'templateSave');
  await form.locator('[name=templateName]').fill('架空Xの固定構成'); await form.locator('[name=templateProduct]').selectOption(x);
  await form.locator('[name=templateProductUnit]').selectOption('台');
  await recipeRow(page, 0, 'Q', '個', '3'); await recipeRow(page, 1, 'S', '本', '1'); await submit(page);
  const child = Object.values((await snapshotOf(page)).supply.receiptTemplates)[0]!;
  form = await choose(page, 'templateSave'); await form.locator('[name=templateName]').fill('架空Rの親構成');
  await form.locator('[name=templateProduct]').selectOption('R'); await form.locator('[name=templateProductUnit]').selectOption('台');
  await recipeRow(page, 0, 'P', '個', '2'); await recipeRow(page, 1, x, '台', '1');
  await form.locator('[name=t1source]').selectOption(child.id); await submit(page);
  const snapshot = await snapshotOf(page), parent = Object.values(snapshot.supply.receiptTemplates).find(t => t.product === 'R')!;
  expect(snapshot.ledger.lots).toEqual({}); expect(snapshot.supply.requests).toEqual({});
  return { x, child, parent };
}
async function preview(page: Page, parent: string, route: 'assembled' | 'parts') {
  const form = await choose(page, 'templateReceive'); await form.locator('[name=template]').selectOption(parent);
  await expect(form.getByLabel('製作数量（台・正の整数）', { exact: true })).toHaveValue('1');
  await form.locator('[name=project]').selectOption('A-001'); await form.locator('[name=sets]').fill('10');
  await form.locator('[name=route1]').selectOption(route); await form.getByRole('button', { name: '予定数を展開' }).click();
  return form;
}
const supplyHistory = (page: Page) => page.locator('#supply ol[aria-label="供給の記録の履歴"]');
const csv = (book: XLSX.WorkBook, sheet: string) => XLSX.utils.sheet_to_csv(book.Sheets[sheet]!);
const excelRows = (book: XLSX.WorkBook, sheet: string) => XLSX.utils.sheet_to_json<string[]>(book.Sheets[sheet]!, { header: 1, raw: true });

test('AR01/02/04-07/10: assembled欠品→正式化・改名・子削除→後日手動割り当て、当時履歴/現在Excel/復元を分けて保つ', async ({ page }) => {
  const { x, child, parent } = await assembly(page), form = await preview(page, parent.id, 'assembled');
  await expect(form.locator('[name^=actual]')).toHaveCount(2);
  await form.locator('[name=shortfall1]').fill('3'); await expect(form.locator('[name=actual1]')).toHaveValue('7');
  await form.locator('[name=vendor]').fill('架空商社'); await form.locator('[name=templateConfirmed]').check(); await submit(page);
  const first = await snapshotOf(page), batch = first.supply.log.find(event => event.kind === 'templateReceipt')!;
  if (batch.kind !== 'templateReceipt') throw new Error('まとめて受け取りが必要');
  const request = Object.values(first.supply.requests)[0]!, xLot = batch.rows[1]!.lotId!;
  expect(Object.values(first.ledger.lots).map(value => value.item)).toEqual(['P', x]);
  expect(Object.values(first.supply.receipts).map(value => value.received)).toEqual([20, 7]);
  expect(Object.values(first.supply.requests)).toMatchObject([{ item: x, quantity: 3, vendor: '架空商社' }]);
  expect(batch).toHaveProperty(`itemLabels.items.${x}`, { name: '架空組立X', code: null });
  await recorded(page, 'masterCode', { target: `item:${x}`, code: '0007', reason: '架空正式化' }, '10:00');
  await recorded(page, 'masterRename', { target: `item:${x}`, name: '架空正式X', reason: '架空改名' }, '10:10');
  await recorded(page, 'masterRename', { target: 'item:Q', name: '架空Q改名後', reason: '架空改名' }, '10:20');
  let edit = await choose(page, 'templateSave'); await edit.locator('[name=template]').selectOption(child.id);
  await edit.locator('[name=t0perSet]').fill('4'); await submit(page);
  edit = await choose(page, 'templateDelete'); await edit.locator('[name=template]').selectOption(child.id); await submit(page);
  expect((await snapshotOf(page)).supply.receiptTemplates[parent.id]!.rows[1]!.assembly).toEqual(child);
  await goTo(page, 'stock');
  await recorded(page, 'receive', { newId: 'later-X', item: x, unit: '台', project: 'A-001', location: 'S1', basis: 'counted', value: '3' }, '11:00');
  expect((await snapshotOf(page)).supply.requests[request.id]!.arrivals).toEqual([]);
  await recorded(page, 'allocate', { receipt: 'later-X', request: request.id, arrived: '3', good: '3' }, '11:10');
  const final = await snapshotOf(page);
  expect(Object.values(final.supply.receipts).map(value => value.received)).toEqual([20, 7, 3]);
  expect(final.ledger.lots[xLot]).toEqual(first.ledger.lots[xLot]);
  expect(final.supply.requests[request.id]).toMatchObject({ item: x, quantity: 3, arrivals: [{ receiptLotId: 'later-X', arrived: 3, good: 3 }] });
  expect(final.supply.log.find(event => event.eventId === batch.eventId)).toEqual(batch);
  expect(final.supply.log.find(event => event.kind === 'requestRecord' && event.request.id === request.id)).toHaveProperty(`itemLabels.items.${x}`, { name: '架空組立X', code: null });
  await expect(cell(page, xLot, '品目')).toHaveText('0007'); await row(page, xLot).getByRole('button', { name: xLot, exact: true }).click();
  await expect(page.locator('#detail dl').first()).toContainText('架空正式X（0007）');
  await goTo(page, 'supply');
  const oldBatch = supplyHistory(page).locator('li').filter({ hasText: `まとめて受け取り ${batch.eventId}：` });
  await expect(oldBatch).toContainText('正式コード未登録「架空組立X」'); await expect(oldBatch).toContainText('Q「架空部品Q」');
  await expect(oldBatch).toContainText('S「架空共通ネジS」'); await expect(oldBatch).toContainText('3個/台');
  await expect(oldBatch).not.toContainText('架空正式X'); await expect(oldBatch).not.toContainText('架空Q改名後');
  await expect(page.locator('#supply')).toContainText('依頼の未着の解消：未着なし');
  const latest = final.supply.log.find(event => event.kind === 'receiptRecord' && event.lotId === 'later-X')!;
  await expect(supplyHistory(page).locator('li').filter({ hasText: latest.eventId })).toContainText('0007「架空正式X」');
  const view = await downloadVia(page, exportButton), book = XLSX.read(view.bytes, { type: 'array' });
  const oldExport = excelRows(book, '供給の履歴').find(value => value[0] === batch.eventId)!.join(' ');
  expect(oldExport).toContain('正式コード未登録「架空組立X」'); expect(oldExport).toContain('Q「架空部品Q」'); expect(oldExport).not.toContain('架空正式X');
  expect(excelRows(book, '保管単位').find(value => value[0] === xLot)?.slice(0, 3)).toEqual([xLot, '0007', '架空正式X']);
  const backup = await downloadVia(page, backupButton);
  await goTo(page, 'stock'); await recorded(page, 'masterRename', { target: `item:${x}`, name: '架空復元前の変更', reason: '架空' }, '12:00');
  const changed = await snapshotOf(page);
  await pickFile(page, backup.path); await page.getByRole('region', { name: '復元の確認' }).getByRole('button', { name: '復元する', exact: true }).click(); await page.getByRole('region', { name: '復元の確認' }).waitFor({ state: 'hidden' });
  await page.reload(); await waitForApp(page);
  const restored = await snapshotOf(page); expect(restored.ledger).toEqual(final.ledger); expect(restored.supply).toEqual(final.supply);
  expect(restored).toMatchObject({ revision: changed.revision + 1, lastWriter: 'init', ops: final.ops, saveChecks: final.saveChecks, opFloor: final.opFloor, conflictReviews: final.conflictReviews });
  await goTo(page, 'supply'); await expect(supplyHistory(page).locator('li').filter({ hasText: `まとめて受け取り ${batch.eventId}：` })).toContainText('正式コード未登録「架空組立X」');
});

test('AR13: コード衝突の警告と別画面の取消は無変更、確認した付替えでもX/Yの現物・履歴・pinを混同しない', async ({ page, context }) => {
  const { x, child, parent } = await assembly(page);
  await recorded(page, 'register', lot('Y-lot', 'Q', 'S2', 'counted', '5'), '08:30');
  const form = await preview(page, parent.id, 'assembled'); await form.locator('[name=templateConfirmed]').check(); await submit(page);
  const before = await snapshotOf(page), raw = await storageBytes(page);
  const assignment = { target: `item:${x}`, code: 'Q', reason: '架空対応変更' };
  await expect(await record(page, 'masterCode', assignment, '10:00')).toContainText('確認が必要'); expect(await storageBytes(page)).toEqual(raw);
  const other = await context.newPage(); const errors: string[] = []; other.on('pageerror', error => errors.push(error.message)); await other.goto('/'); await waitForApp(other);
  await expect(await record(other, 'masterCode', assignment, '10:00')).toContainText('何も保存していない');
  await selectOperation(formOf(other).locator('[name=op]'), 'masterRename');
  expect(await storageBytes(other)).toEqual(raw); expect((await snapshotOf(other)).ledger).toEqual(before.ledger);
  await formOf(page).locator('[name=confirmed]').check(); await submit(page);
  const after = await snapshotOf(page);
  expect(after.ledger.masters.items[x]!.code).toBe('Q'); expect(after.ledger.masters.items.Q!.code).toBeNull();
  expect(after.ledger.lots).toEqual(before.ledger.lots); expect(after.supply).toEqual(before.supply);
  expect(after.ledger.history.slice(0, before.ledger.history.length)).toEqual(before.ledger.history);
  expect(after.supply.receiptTemplates[parent.id]!.rows[1]!.assembly).toEqual(child);
  await expect(cell(page, 'Y-lot', '品目')).toContainText('架空部品Q');
  await row(page, 'Y-lot').getByRole('button', { name: 'Y-lot', exact: true }).click();
  const yEvent = before.ledger.history.find(event => event.kind === 'register' && event.changes[0]?.after.id === 'Y-lot')!;
  await expect(page.locator('#detail ol li').filter({ hasText: yEvent.eventId }).first()).toContainText('Q「架空部品Q」');
  const view = await downloadVia(page, exportButton), book = XLSX.read(view.bytes, { type: 'array' });
  const currentY = excelRows(book, '保管単位').find(value => value[0] === 'Y-lot')!;
  expect(currentY.slice(0, 3)).toEqual(['Y-lot', '（仮）架空部品Q', '架空部品Q（品番・コードなし（仮））']);
  expect(csv(book, '台帳の履歴')).toContain('Q「架空部品Q」'); expect(errors).toEqual([]); await other.close();
});

test('履歴7: reworkPartの本当の入れ子use/registerは、後の改名後も各元イベントの当時名を詳細とExcelへ出す', async ({ page }) => {
  await startEmpty(page); await recorded(page, 'register', lot('parts', 'P', 'S1', 'counted', '100'), '08:00');
  await recorded(page, 'start', { newId: 'work', item: 'R', project: 'A-001', location: 'T', process: 'R組立', basis: 'counted', value: '20', m1lot: 'parts', m1basis: 'counted', m1value: '20' }, '09:00');
  await recorded(page, 'finish', { lot: 'work', childId: 'inspect', basis: 'counted', value: '20' }, '10:00');
  await recorded(page, 'inspect', { lot: 'inspect', childId: 'finished', basis: 'counted', value: '20' }, '11:00');
  await recorded(page, 'reworkBegin', { lot: 'finished', childId: 'repair', basis: 'counted', value: '2', reason: '架空手直し' }, '12:00');
  const reworkId = (await snapshotOf(page)).ledger.history.find(event => event.kind === 'rework')!.eventId;
  await recorded(page, 'reworkReplace', { reworkId, subjectLotId: 'repair', lot: 'parts', value: '2', reason: '架空交換の当時表示' }, '12:30');
  await recorded(page, 'masterRename', { target: 'item:P', name: '架空回収時P', reason: '架空改名' }, '13:00');
  await recorded(page, 'reworkRecover', { reworkId, subjectLotId: 'repair', newId: 'recovered', item: 'P', location: 'S1', value: '1', reason: '架空回収の当時表示' }, '13:10');
  await recorded(page, 'masterRename', { target: 'item:P', name: '架空最終P', reason: '架空改名' }, '13:20');
  await row(page, 'repair').getByRole('button', { name: 'repair', exact: true }).click();
  const replace = page.locator('#detail ol li').filter({ hasText: '架空交換の当時表示' }).first();
  await expect(replace).toContainText('交換使用 操作'); await expect(replace).toContainText('P「架空部品P」'); await expect(replace).not.toContainText('架空最終P');
  const recovery = page.locator('#detail ol li').filter({ hasText: '架空回収の当時表示' }).first();
  await expect(recovery).toContainText('回収 操作'); await expect(recovery).toContainText('P「架空回収時P」'); await expect(recovery).not.toContainText('架空最終P');
  const snapshot = await snapshotOf(page), events = snapshot.ledger.history.filter(event => event.kind === 'reworkPart');
  const view = await downloadVia(page, exportButton), book = XLSX.read(view.bytes, { type: 'array' });
  expect(excelRows(book, '台帳の履歴').find(value => value[0] === events[0]!.eventId)!.join(' ')).toContain('P「架空部品P」');
  expect(excelRows(book, '台帳の履歴').find(value => value[0] === events[1]!.eventId)!.join(' ')).toContain('P「架空回収時P」');
});

test('履歴7/AR10: 真正schema8 flatのbootは非破壊、旧履歴の不明と現在名を新記録・Excel・backup復元後も区別する', async ({ page }) => {
  await startEmpty(page);
  const at = '2026-09-29T08:00:00+09:00', meta: Meta = { eventId: 'old-save', actor: '架空担当A', occurredAt: at, recordedAt: at };
  const ledger = { ...practiceLedger, masters: { ...practiceLedger.masters, items: { ...practiceLedger.masters.items, P: { ...practiceLedger.masters.items.P!, name: '架空旧版の現在P' } } } };
  const flat: ReceiptTemplate = { id: 'old-flat', name: '架空旧平面', product: 'R', project: null, basis: 'label', rows: [{ item: 'P', unit: '個', perSet: 2, location: 'S1' }] };
  const supply = saveReceiptTemplate(ledger, emptySupply, meta, flat);
  const received = receiveTemplate({ ledger, supply }, { ...meta, eventId: 'old-receive' }, flat.id, { kind: 'case', id: 'A-001' }, 5, [{ quantity: 10, shortfall: 0 }], null);
  const raw = JSON.parse(legacyJson(JSON.parse(serialize(initial(received.ledger, received.supply))))); raw.version = 8;
  for (const key of ['itemLabels', 'productUnit', 'assembly', 'routes']) expect(JSON.stringify(raw)).not.toContain(`"${key}"`);
  const text = JSON.stringify(raw);
  await page.evaluate(value => { localStorage.clear(); localStorage.setItem('fuzzy-stock/head', 'A'); localStorage.setItem('fuzzy-stock/slot-A', value); }, text);
  const original = await storageBytes(page); await page.reload(); await waitForApp(page); expect(await storageBytes(page)).toEqual(original);
  const oldId = Object.keys(received.ledger.lots)[0]!; await goTo(page, 'stock'); await row(page, oldId).getByRole('button', { name: oldId, exact: true }).click();
  await expect(page.locator('#detail dl').first()).toContainText('架空旧版の現在P');
  const legacy = page.locator('#detail ol li').filter({ hasText: '当時の名称・コード不明' }).first();
  await expect(legacy).toContainText('P（当時の名称・コード不明）'); await expect(legacy).not.toContainText('架空旧版の現在P');
  let view = await downloadVia(page, exportButton), book = XLSX.read(view.bytes, { type: 'array' });
  expect(csv(book, '台帳の履歴')).toContain('P（当時の名称・コード不明）'); expect(csv(book, '供給の履歴')).toContain('当時の名称・コード不明');
  expect(excelRows(book, '保管単位').find(value => value[0] === oldId)?.slice(0, 3)).toEqual([oldId, 'P', '架空旧版の現在P']);
  await goTo(page, 'stock'); await recorded(page, 'receive', { newId: 'new-P', item: 'P', unit: '個', project: 'A-001', location: 'S1', basis: 'counted', value: '1' }, '12:00');
  const saved = await snapshotOf(page); expect(saved.ledger.history[0]!.itemLabels).toEqual({ kind: 'legacy-unavailable' });
  expect(saved.ledger.history.at(-1)).toHaveProperty('itemLabels.items.P.name', '架空旧版の現在P');
  const backup = await downloadVia(page, backupButton); await pickFile(page, backup.path);
  await page.getByRole('region', { name: '復元の確認' }).getByRole('button', { name: '復元する', exact: true }).click(); await page.getByRole('region', { name: '復元の確認' }).waitFor({ state: 'hidden' });
  await page.reload(); await waitForApp(page);
  const restored = await snapshotOf(page); expect(restored.ledger).toEqual(saved.ledger); expect(restored.supply).toEqual(saved.supply);
  view = await downloadVia(page, exportButton); book = XLSX.read(view.bytes, { type: 'array' }); expect(csv(book, '台帳の履歴')).toContain('P（当時の名称・コード不明）');
});

test('AR03/12: parts受け取りのP20/Q30/S10を明示材料として一度だけ使い、作業終了・確認の完了では再消費しない', async ({ page }) => {
  const { x, parent } = await assembly(page), before = await storageBytes(page), form = await preview(page, parent.id, 'parts');
  await form.locator('[data-assembly-reference] summary').focus(); await page.keyboard.press('Enter'); expect(await storageBytes(page)).toEqual(before);
  for (const [i, value] of ['20', '30', '10'].entries()) await expect(form.locator(`[name=actual${i}]`)).toHaveValue(value);
  await form.locator('[name=templateConfirmed]').check(); await submit(page);
  const received = await snapshotOf(page), materials = Object.values(received.ledger.lots);
  expect(materials.map(material => material.item)).toEqual(['P', 'Q', 'S']); expect(materials.some(material => material.item === x)).toBe(false);
  await recorded(page, 'start', { newId: 'R-work', item: 'R', unit: '台', project: 'A-001', location: 'T', process: 'R組立', basis: 'counted', value: '10',
    m1lot: materials[0]!.id, m1basis: 'counted', m1value: '20', m2lot: materials[1]!.id, m2basis: 'counted', m2value: '30', m3lot: materials[2]!.id, m3basis: 'counted', m3value: '10' }, '10:00');
  const started = await snapshotOf(page), uses = started.ledger.history.filter(event => event.kind === 'use'); expect(uses).toHaveLength(3);
  expect(uses.map(event => [event.lotId, event.value])).toEqual(materials.map((material, i) => [material.id, [20, 30, 10][i]]));
  const quantities = materials.map(material => started.ledger.lots[material.id]!.quantity);
  for (const quantity of quantities) expect(quantity).toMatchObject({ kind: 'known', numeric: { value: 0 } });
  await recorded(page, 'finish', { lot: 'R-work', childId: 'R-inspect', basis: 'counted', value: '10' }, '11:00');
  await recorded(page, 'inspect', { lot: 'R-inspect', childId: 'R-finished', basis: 'counted', value: '10' }, '12:00');
  const finished = await snapshotOf(page); expect(finished.ledger.history.filter(event => event.kind === 'use')).toEqual(uses);
  expect(materials.map(material => finished.ledger.lots[material.id]!.quantity)).toEqual(quantities);
  await expect(cell(page, 'R-finished', '記録上の数と根拠')).toContainText('10台');
  await expect(cell(page, 'R-finished', '作業の状態')).toContainText('完成（渡す前）');
  await page.setViewportSize({ width: 320, height: 740 }); const edit = await choose(page, 'templateSave'); await edit.locator('[name=template]').selectOption(parent.id);
  await edit.locator('[data-assembly-reference] summary').click(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.local-logs/assembly-20261024/history-labels-e2e-assembly-320px.png', fullPage: true });
});
