import { expect, test, type Page } from '@playwright/test';
import { decodeSnapshot } from '../../src/ui/storageparse.ts';
import { selectOperation, goTo, answer, backupButton, cell, downloadVia, lot, pickFile, record, recorded, row, set, startEmpty, storageBytes, waitForApp } from './helpers.ts';

const source = (entry: string) => ({ alternative: true, alternativeSource: '架空元票<img src=x onerror=alert(1)>', alternativeEntry: entry, alternativeActor: '架空原票記入B' });
const panelOf = (page: Page) => page.getByRole('region', { name: 'この保管単位の証拠', exact: true });
async function detail(page: Page, id: string) {
  await goTo(page, 'stock');
  await row(page, id).getByRole('button', { name: id, exact: true }).click();
  return panelOf(page);
}
const request = { project: 'A-001', item: 'P', quantity: '10', vendor: '架空依頼先', requestedOn: '2026-09-29', replyKind: 'none' };

async function snapshot(page: Page) {
  const raw = await page.evaluate(() => localStorage.getItem(`fuzzy-stock/slot-${localStorage.getItem('fuzzy-stock/head')}`));
  if (!raw) throw Error('保存済みの台帳がない');
  return decodeSnapshot(JSON.parse(raw));
}

test('四入口と材料側の元の資料を物品詳細で参照し、閲覧で数量や保存を変えない', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('p', 'P', 'S1', 'counted', '20'), '08:00');
  await recorded(page, 'register', lot('q', 'Q', 'S1', 'counted', '20'), '08:00');
  await recorded(page, 'use', { ...source('001'), lot: 'p', basis: 'counted', value: '2', usedFor: '架空作業' }, '09:00');
  await recorded(page, 'move', { ...source('002'), lot: 'p', location: 'T' }, '09:10');
  await recorded(page, 'start', { ...source('003'), ...lot('work', 'R', 'T', 'counted', '1'), process: 'R組立', m1lot: 'p', m1basis: 'counted', m1value: '3', m2lot: 'q', m2basis: 'counted', m2value: '1' }, '09:20');
  await recorded(page, 'receive', { ...source('004'), ...lot('received', 'P', 'S1', 'label', '8') }, '09:30');
  const bytes = await storageBytes(page);
  const panel = await detail(page, 'p');
  await expect(panel.locator('[data-source]')).toHaveCount(3);
  await expect(panel).toContainText('架空原票記入B');
  await expect(panel).toContainText('元の資料「架空元票<img src=x onerror=alert(1)>」');
  await expect(panel).toContainText('動き「001」');
  await expect(panel).toContainText('動き「002」');
  await expect(panel).toContainText('全処理の完了ではない');
  const material = panel.locator('[data-source]').filter({ hasText: '動き「003」' }).getByRole('list', { name: 'この材料の使用' });
  await expect(material).toContainText('3個');
  await expect(material).not.toContainText('1個');
  await expect(panel.locator('img, script, a')).toHaveCount(0);
  await detail(page, 'q');
  await expect(panel.locator('[data-source]')).toHaveCount(1);
  await expect(panel.getByRole('list', { name: 'この材料の使用' })).toContainText('1個');
  await detail(page, 'work');
  await expect(panel).toContainText('動き「003」');
  await expect(panel.getByRole('list', { name: 'この材料の使用' })).toHaveCount(0);
  await detail(page, 'received');
  await expect(panel).toContainText('動き「004」');
  await expect(panel.getByRole('region', { name: 'この保管単位の実受け取り', exact: true })).toContainText('8個（仮の実際に受け取った数）');
  await expect(panel).toContainText('読取記録はない');
  await expect(cell(page, 'p', '記録上の数と根拠')).toContainText('15個');
  expect(await storageBytes(page)).toEqual(bytes);
});

test('複数依頼と訂正・取消を示し、同じ依頼の別受け取りや未割り当ての依頼を混ぜない', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'requestRecord', request, '07:00');
  await recorded(page, 'requestRecord', { ...request, vendor: '架空第二依頼先' }, '07:10');
  await recorded(page, 'requestRecord', { ...request, vendor: '架空未割り当て依頼先' }, '07:20');
  await recorded(page, 'receive', { ...source('001'), ...lot('in', 'P', 'S1', 'counted', '8'), r1request: 'op1', r1arrived: '4', r1good: '3', r2request: 'op2', r2arrived: '4', r2good: '4' }, '08:00');
  await recorded(page, 'receive', { ...lot('other', 'P', 'S1', 'counted', '5'), r1request: 'op1', r1arrived: '5', r1good: '5' }, '08:10');
  await recorded(page, 'arrivalRevise', { arrival: 'op1/op4-a1', arrived: '3', good: '2' }, '09:00');
  await recorded(page, 'receiptRevise', { receipt: 'in', received: '7', reason: '架空の実受入の訂正' }, '09:10');
  await recorded(page, 'orderConfirm', { request: 'op1' }, '09:15');
  await recorded(page, 'replyRecord', { request: 'op1', replyKind: 'answered', replyDate: '2026-09-30' }, '09:20');
  await recorded(page, 'requestCancel', { request: 'op1', reason: '架空の取消理由' }, '09:30');
  const bytes = await storageBytes(page), panel = await detail(page, 'in');
  const one = panel.getByRole('article', { name: '依頼op1', exact: true });
  await expect(one).toContainText('この実受け取りから：到着3個・良品2個');
  await expect(one).toContainText('依頼数量10個');
  await expect(one).toContainText('相手が回答した予定日2026-09-30');
  await expect(one).toContainText('取消済み');
  await expect(one).toContainText('架空の取消理由');
  await expect(one).toContainText('到着4→3・良品3→2');
  await expect(one).not.toContainText('保管単位other');
  await expect(one).not.toContainText('到着5');
  await expect(panel.getByRole('article', { name: '依頼op2', exact: true })).toContainText('この実受け取りから：到着4個・良品4個');
  await expect(panel).not.toContainText('架空未割り当て依頼先');
  await expect(panel.getByRole('region', { name: 'この保管単位の実受け取り', exact: true })).toContainText('届いた数7個（確定）');
  await expect(panel).toContainText('8→7');
  await expect(panel).toContainText('架空の実受入の訂正');
  await expect(cell(page, 'in', '記録上の数と根拠')).toContainText('8個');
  expect(await storageBytes(page)).toEqual(bytes);
});

test('実際の日時の訂正・使用取消・未反映でも元の資料と現在の操作状態をたどれる', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('p', 'P', 'S1', 'counted', '20'), '08:00');
  await recorded(page, 'use', { ...source('001'), lot: 'p', basis: 'counted', value: '2', usedFor: '架空作業' }, '09:00');
  await recorded(page, 'correctTime', { target: 'op2', corrected: '2026-09-29T09:30' }, '10:00');
  await recorded(page, 'void', { target: 'op2', reason: '架空の誤記' }, '11:00');
  await record(page, 'use', { ...source('002'), lot: 'p', basis: 'counted', value: '3', usedFor: '架空の遅れた入力' }, '07:00');
  await answer(page, 'unknown');
  const panel = await detail(page, 'p');
  const corrected = panel.locator('[data-source]').filter({ hasText: '動き「001」' });
  await expect(corrected).toContainText('09:30');
  await expect(corrected).toContainText('訂正前 2026-09-29 09:00');
  await expect(corrected).toContainText('取消');
  await expect(panel.locator('[data-source]').filter({ hasText: '動き「002」' })).toContainText('親から減らしていない（未適用）');
  await expect(cell(page, 'p', '記録上の数と根拠')).toContainText('20個');
});

test('分割・統合・案件・用途振替の詳細リンクで元の受け取りをたどり、子へ全量を表示しない', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'requestRecord', request, '07:00');
  await recorded(page, 'receive', { ...source('001'), ...lot('original', 'P', 'S1', 'counted', '10'), r1request: 'op1', r1arrived: '10', r1good: '10' }, '08:00');
  await recorded(page, 'register', lot('target', 'P', 'T', 'counted', '2'), '08:10');
  await recorded(page, 'splitMove', { lot: 'original', childId: 'child', basis: 'counted', value: '4', location: 'T' }, '09:00');
  await recorded(page, 'merge', { lot: 'child', target: 'target' }, '10:00');
  await recorded(page, 'transfer', { lot: 'original', childId: 'transferred', toProject: 'B-001', basis: 'counted', value: '2' }, '11:00');
  await recorded(page, 'move', { lot: 'original', location: 'S2' }, '12:00');
  const before = await storageBytes(page), panel = await detail(page, 'target');
  await expect(panel).toContainText('この保管単位自体の実受け取りの記録はない');
  await expect(panel.locator('[data-source]')).toHaveCount(0);
  await page.locator('#detail').getByRole('button', { name: 'child', exact: true }).click();
  await expect(panel).toContainText('この保管単位自体の実受け取りの記録はない');
  await page.locator('#detail').getByRole('button', { name: 'original', exact: true }).click();
  await expect(panel).toContainText('動き「001」');
  await expect(panel.getByRole('region', { name: 'この保管単位の実受け取り', exact: true })).toContainText('届いた数10個');
  await expect(panel.getByRole('article', { name: '依頼op1' })).toContainText('到着10個');
  await expect(cell(page, 'original', '記録上の数と根拠')).toContainText('4個');
  await detail(page, 'transferred');
  await expect(panel).toContainText('この保管単位自体の実受け取りの記録はない');
  await expect(panel.getByRole('article', { name: '依頼op1' })).toHaveCount(0);
  expect(await storageBytes(page)).toEqual(before);
});

test('不明の受け取り・所属解消と仮受け取りの使い切り・使用取消の現在状態を区別する', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'receive', { ...source('001'), ...lot('unknown', 'P', 'S1', 'unknown', '', { project: 'unassigned' }) }, '08:00');
  await recorded(page, 'assignProject', { lot: 'unknown', project: 'A-001', reason: '架空原票の確認' }, '09:00');
  const panel = await detail(page, 'unknown');
  await expect(panel).toContainText('動き「001」');
  const receipt = panel.getByRole('region', { name: 'この保管単位の実受け取り', exact: true }).locator('p').first();
  await expect(receipt).toHaveText('届いた数数が不明（未確認）。現在の記録上の数とは別の記録。');
  await recorded(page, 'receive', lot('label', 'P', 'S1', 'label', '5'), '10:00');
  await recorded(page, 'use', { lot: 'label', basis: 'counted', value: '5', usedFor: '架空の使い切り' }, '11:00');
  await detail(page, 'label');
  await expect(receipt).toContainText('5個（確定）');
  const form = page.getByRole('form', { name: '操作の入力' });
  await selectOperation(form.locator('[name=op]'), 'void');
  const target = await form.locator('[name=target] option').filter({ hasText: '架空の使い切り' }).getAttribute('value');
  if (!target) throw Error('取消対象の使用記録がない');
  await goTo(page, 'stock');
  await recorded(page, 'void', { target, reason: '架空誤記の取消' }, '12:00');
  await detail(page, 'label');
  await expect(receipt).toContainText('5個（仮の実際に受け取った数）');
  await expect(panel).toContainText('直接対応する元の資料の記録はない');
});

test('読取原文の先頭空白・改行を証拠欄に保ち、文字として表示する', async ({ page }) => {
  await startEmpty(page);
  const form = page.getByRole('form', { name: '操作の入力' }), code = page.getByRole('region', { name: 'コード入力補助' });
  await selectOperation(form.locator('[name=op]'), 'receive');
  await set(form.locator('[name=project]'), 'A-001');
  await set(form.locator('[name=location]'), 'S1');
  await code.getByRole('button', { name: '現在の案件・用途を保持' }).click();
  await code.getByRole('button', { name: '現在の場所を保持' }).click();
  const raw = ' LABA|A-001|P\t\r\n';
  await code.getByLabel('読取原文・品目ID').evaluate((element, value) => {
    const data = new DataTransfer(); data.setData('text/plain', value);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, raw);
  await code.getByRole('button', { name: '解釈', exact: true }).click();
  await code.getByLabel('コードの入力先').selectOption('item');
  await code.locator('[data-code-options]').getByRole('button', { name: /架空部品P/ }).click();
  await set(form.locator('[name=newId]'), 'scanned');
  await set(form.locator('[name=value]'), '5');
  await code.getByRole('button', { name: 'この対象で続ける' }).click();
  await form.getByRole('button', { name: '記録する' }).click();
  await expect(page.getByRole('status')).toContainText('記録した');
  await goTo(page, 'stock');
  const before = await storageBytes(page), panel = await detail(page, 'scanned');
  const scan = panel.getByRole('region', { name: '読取証拠' });
  expect(await scan.textContent()).toContain(raw);
  expect(await scan.locator('li').evaluate(e => getComputedStyle(e).whiteSpace)).toBe('pre-wrap');
  await expect(scan.locator('a, img, script')).toHaveCount(0);
  await expect(panel).toContainText('直接対応する元の資料の記録はない');
  expect(await storageBytes(page)).toEqual(before);
});

test('第二割り当ての拒否でも第一の対応を残し、再割り当て・再読込・バックアップ復元後も参照できる', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'requestRecord', request, '07:00');
  await recorded(page, 'requestRecord', { ...request, vendor: '架空第二依頼先' }, '07:10');
  await expect(await record(page, 'receive', { ...source('001'), ...lot('in', 'P', 'S1', 'counted', '8'), r1request: 'op1', r1arrived: '4', r1good: '4', r2request: 'op2', r2arrived: '5', r2good: '5' }, '08:00')).toContainText('割り当ては拒否');
  const rejected = await storageBytes(page), panel = await detail(page, 'in');
  await expect(panel.getByRole('article', { name: '依頼op1' })).toContainText('到着4個・良品4個');
  await expect(panel.getByRole('article', { name: '依頼op2' })).toHaveCount(0);
  await expect(panel).toContainText('動き「001」');
  expect(await storageBytes(page)).toEqual(rejected);
  await recorded(page, 'allocate', { receipt: 'in', request: 'op2', arrived: '4', good: '3' }, '09:00');
  await detail(page, 'in');
  await expect(panel.getByRole('article', { name: '依頼op2' })).toContainText('到着4個・良品3個');
  const saved = await snapshot(page), backup = await downloadVia(page, backupButton);
  await page.reload(); await waitForApp(page);
  const reloaded = await storageBytes(page);
  await detail(page, 'in');
  await expect(panel.getByRole('article', { name: '依頼op1' })).toContainText('到着4個');
  await expect(panel).toContainText('動き「001」');
  expect(await storageBytes(page)).toEqual(reloaded);
  await recorded(page, 'move', { lot: 'in', location: 'S2' }, '10:00');
  await pickFile(page, backup.path);
  await page.getByRole('region', { name: '復元の確認' }).getByRole('button', { name: '復元する', exact: true }).click(); await page.getByRole('region', { name: '復元の確認' }).waitFor({ state: 'hidden' });
  await page.reload(); await waitForApp(page);
  const restored = await storageBytes(page);
  await detail(page, 'in');
  await expect(panel.getByRole('article', { name: '依頼op2' })).toContainText('到着4個・良品3個');
  await expect(panel.locator('[data-source]')).toHaveCount(1);
  expect((await snapshot(page)).ledger).toEqual(saved.ledger);
  expect((await snapshot(page)).supply).toEqual(saved.supply);
  expect(await storageBytes(page)).toEqual(restored);
});

test('割り当てが全部拒否された受け取りは参照中の対応なしと表示し、後の明示割り当てを反映する', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'requestRecord', request, '07:00');
  await expect(await record(page, 'receive', { ...source('001'), ...lot('in', 'P', 'S1', 'counted', '8'), r1request: 'op1', r1arrived: '9', r1good: '9' }, '08:00')).toContainText('割り当ては拒否');
  const panel = await detail(page, 'in');
  await expect(panel.getByRole('article', { name: '依頼op1' })).toHaveCount(0);
  await expect(panel).toContainText('現在参照している記録に、この実受け取りへの割り当てはない');
  await expect(panel.locator('[data-source]')).toHaveCount(1);
  await expect(cell(page, 'in', '記録上の数と根拠')).toContainText('8個');
  await recorded(page, 'allocate', { receipt: 'in', request: 'op1', arrived: '8', good: '7' }, '09:00');
  await detail(page, 'in');
  await expect(panel.getByRole('article', { name: '依頼op1' })).toContainText('到着8個・良品7個');
  await expect(panel).not.toContainText('この実受け取りへの割り当てはない');
  await expect(panel.locator('[data-source]')).toHaveCount(1);
});

for (const mode of ['partial', 'unknown-receipt', 'unknown-partial', 'unknown-all'] as const) test(`保存途中の参照(${mode})は対応済みを残し、照会・再試行で二重に表示しない`, async ({ page }) => {
  await startEmpty(page); await page.goto('/?test'); await waitForApp(page);
  await recorded(page, 'requestRecord', request, '07:00');
  await recorded(page, 'requestRecord', { ...request, vendor: '架空第二依頼先' }, '07:10');
  await page.evaluate(kind => {
    if (kind === 'partial') window.fuzzyStockTest!.failMidwayAt(3);
    else if (kind === 'unknown-all') window.fuzzyStockTest!.loseResponseAt(2);
    else {
      const original = Storage.prototype.setItem;
      let heads = 0;
      Storage.prototype.setItem = function(key: string, value: string): void {
        original.call(this, key, value);
        if (key === 'fuzzy-stock/head' && ++heads === (kind === 'unknown-receipt' ? 1 : 2)) {
          Storage.prototype.setItem = original;
          throw new Error('試験用：保存単位のhead確定後に応答喪失');
        }
      };
    }
  }, mode);
  await goTo(page, 'stock');
  await record(page, 'receive', { ...source('001'), ...lot('in', 'P', 'S1', 'counted', '8'), r1request: 'op1', r1arrived: '4', r1good: '4', r2request: 'op2', r2arrived: '4', r2good: '3' }, '08:00');
  await expect(page.locator('#save')).toContainText(mode === 'partial' ? '一部だけ保存した' : '保存結果不明');
  const stored = await snapshot(page);
  const firstSaved = mode !== 'unknown-receipt';
  expect(stored.supply.requests['op1']?.arrivals).toHaveLength(firstSaved ? 1 : 0);
  expect(stored.supply.requests['op2']?.arrivals).toHaveLength(mode === 'unknown-all' ? 1 : 0);
  const initialBytes = await storageBytes(page), initialPanel = await detail(page, 'in');
  await expect(initialPanel.getByRole('article', { name: '依頼op1' })).toHaveCount(firstSaved ? 1 : 0);
  if (firstSaved) await expect(initialPanel.getByRole('article', { name: '依頼op1' })).toContainText('到着4個・良品4個');
  else await expect(initialPanel).toContainText('現在参照している記録に、この実受け取りへの割り当てはない');
  await expect(initialPanel.getByRole('article', { name: '依頼op2' })).toHaveCount(mode === 'unknown-all' ? 1 : 0);
  await expect(page.locator('#save')).toContainText(mode === 'partial' ? '一部だけ保存した' : '保存結果不明');
  expect(await storageBytes(page)).toEqual(initialBytes);
  await page.reload(); await waitForApp(page);
  const pendingBytes = await storageBytes(page), panel = await detail(page, 'in');
  await expect(panel.getByRole('article', { name: '依頼op1' })).toHaveCount(firstSaved ? 1 : 0);
  if (firstSaved) await expect(panel.getByRole('article', { name: '依頼op1' })).toContainText('到着4個・良品4個');
  await expect(panel.getByRole('article', { name: '依頼op2' })).toHaveCount(mode === 'unknown-all' ? 1 : 0);
  await expect(panel.locator('[data-source]')).toHaveCount(1);
  if (firstSaved) await expect(panel).not.toContainText('この実受け取りへの割り当てはない');
  else await expect(panel).toContainText('現在参照している記録に、この実受け取りへの割り当てはない');
  await expect(page.locator('#save')).toContainText(mode === 'partial' ? '一部だけ保存した' : '保存結果不明');
  expect(await storageBytes(page)).toEqual(pendingBytes);
  await page.getByRole('button', { name: '照会する', exact: true }).click();
  await page.getByRole('button', { name: mode === 'partial' ? '記録し直す' : '再試行する', exact: true }).click();
  await goTo(page, 'stock');
  await detail(page, 'in');
  await expect(panel.getByRole('article', { name: '依頼op1' })).toContainText('到着4個・良品4個');
  await expect(panel.getByRole('article', { name: '依頼op2' })).toContainText('到着4個・良品3個');
  await expect(panel.locator('[data-source]')).toHaveCount(1);
  const saved = await snapshot(page);
  expect(saved.supply.requests['op1']?.arrivals).toHaveLength(1);
  expect(saved.supply.requests['op2']?.arrivals).toHaveLength(1);
  expect(saved.ledger.history.filter(e => e.kind === 'alternativeRecord')).toHaveLength(1);
  await expect(cell(page, 'in', '記録上の数と根拠')).toContainText('8個');
});

test('数量精度・2.1/2.2/3.3: 選択受け取りの0.1と0.2を正確に合算し、別受け取りを混ぜず再読込でも保つ', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'masterItem', { code: 'D', name: '架空小数材料D', units: 'kg', 'unitStep-kg': '0.1' }, '06:00');
  await recorded(page, 'requestRecord', { ...request, item: 'D', unit: 'kg', quantity: '1' }, '07:00');
  const requestId = Object.keys((await snapshot(page)).supply.requests)[0];
  if (!requestId) throw new Error('依頼が記録されていない');
  await goTo(page, 'stock');
  await recorded(page, 'receive', { ...source('小数001'), ...lot('fraction', 'D', 'S1', 'counted', '0.3'), unit: 'kg', r1request: requestId, r1arrived: '0.1', r1good: '0.1' }, '08:00');
  await recorded(page, 'allocate', { receipt: 'fraction', request: requestId, arrived: '0.2', good: '0.2' }, '08:10');
  await recorded(page, 'receive', { ...lot('other-fraction', 'D', 'S1', 'counted', '0.1'), unit: 'kg', r1request: requestId, r1arrived: '0.1', r1good: '0.1' }, '08:20');
  const before = await storageBytes(page), saved = await snapshot(page);
  expect(saved.supply.requests[requestId]?.arrivals.filter(a => a.receiptLotId === 'fraction').map(a => [a.arrived, a.good])).toEqual([[0.1, 0.1], [0.2, 0.2]]);
  const panel = await detail(page, 'fraction');
  await expect(panel.getByRole('article', { name: `依頼${requestId}`, exact: true })).toContainText('この実受け取りから：到着0.3kg・良品0.3kg');
  await expect(panel).not.toContainText('other-fraction');
  await expect(panel.locator('[data-source]')).toHaveCount(1);
  expect(await storageBytes(page)).toEqual(before);
  await page.reload(); await waitForApp(page);
  await detail(page, 'fraction');
  await expect(panel.getByRole('article', { name: `依頼${requestId}`, exact: true })).toContainText('この実受け取りから：到着0.3kg・良品0.3kg');
  expect(await snapshot(page)).toEqual(saved);
  expect(await storageBytes(page)).toEqual(before);
});
