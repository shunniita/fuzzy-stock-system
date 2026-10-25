import { expect, test, type Page } from '@playwright/test';
import * as XLSX from 'xlsx';
import { decodePending, decodeSnapshot } from '../../src/ui/storageparse.ts';
import { selectOperation, goTo, answer, backupButton, cell, downloadVia, exportButton, lot, opLabels, pickFile, record, recorded, set, startEmpty, storageBytes, waitForApp } from './helpers.ts';

test.use({ trace: 'retain-on-failure' });
const source = (entry: string) => ({ alternative: true, alternativeSource: '架空原票A', alternativeEntry: entry, alternativeActor: '架空原票記入者B' });
const formOf = (page: Page) => page.getByRole('form', { name: '操作の入力' });
async function snapshot(page: Page) {
  await waitForApp(page);
  const raw = await page.evaluate(() => localStorage.getItem(`fuzzy-stock/slot-${localStorage.getItem('fuzzy-stock/head')}`));
  if (!raw) throw Error('保存なし');
  return decodeSnapshot(JSON.parse(raw));
}

test('四入口の元の資料・原文・数量根拠を保存し、復元とxlsxでも元の資料の再入力を防ぐ', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('P-52', 'P', 'S1', 'counted', '52'), '08:00');
  await recorded(page, 'use', { ...source('001a'), lot: 'P-52', basis: 'counted', value: '8', usedFor: '架空使用' }, '09:00');
  await formOf(page).locator('[name=alternative]').check();
  await expect(formOf(page)).toContainText('先行版では開けません');
  await recorded(page, 'move', { ...source('002'), lot: 'P-52', location: 'T' }, '09:10');
  await recorded(page, 'start', { ...source('003'), ...lot('work', 'P', 'T', 'counted', '1'), process: 'R組立', m1lot: 'P-52', m1basis: 'counted', m1value: '2' }, '09:20');
  await recorded(page, 'receive', { ...source('004'), ...lot('received', 'P', 'S1', 'label', '10') }, '09:30');
  await expect(cell(page, 'P-52', '記録上の数と根拠')).toContainText('42個');
  await expect(cell(page, 'received', '記録上の数と根拠')).toContainText('表示の数（ラベル・パッケージ）');
  const completed = await snapshot(page), markers = completed.ledger.history.filter(e => e.kind === 'alternativeRecord');
  expect(markers.map(e => e.operation)).toEqual(['use', 'move', 'start', 'receive']);
  expect(markers[0]?.source).toEqual({ source: '架空原票A', entry: '001a', originalActor: '架空原票記入者B' });
  const bytes = await storageBytes(page);
  await expect(await record(page, 'use', { ...source('004'), lot: 'P-52', basis: 'counted', value: '1', usedFor: '別入口でも同原票' }, '10:00')).toContainText('記録済み');
  expect(await storageBytes(page)).toEqual(bytes);
  const exported = XLSX.read((await downloadVia(page, exportButton)).bytes, { type: 'array' });
  const history = JSON.stringify(XLSX.utils.sheet_to_json(exported.Sheets['台帳の履歴']!));
  expect(history).toContain('架空原票A'); expect(history).toContain('架空原票記入者B'); expect(history).toContain('001a');
  const backup = await downloadVia(page, backupButton);
  await goTo(page, 'stock');
  await recorded(page, 'use', { ...source('005'), lot: 'P-52', basis: 'counted', value: '1', usedFor: '別の動き' }, '10:10');
  await pickFile(page, backup.path);
  const confirm = page.getByRole('region', { name: '復元の確認' });
  await expect(confirm).toContainText('復元時点より後の原票は別途照合');
  await confirm.getByRole('button', { name: '復元する', exact: true }).click(); await page.getByRole('region', { name: '復元の確認' }).waitFor({ state: 'hidden' });
  await page.reload();
  expect((await snapshot(page)).ledger).toEqual(completed.ledger);
  await expect(await record(page, 'move', { ...source('002'), lot: 'P-52', location: 'S1' }, '10:20')).toContainText('記録済み');
});

test('必須・前後空白を無変更で拒否し、後入力解除と対象外操作に元の資料を混ぜない', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('p', 'P', 'S1', 'counted', '20'), '08:00');
  const bytes = await storageBytes(page), form = formOf(page);
  await expect(await record(page, 'use', { ...source('001'), alternativeSource: ' A', lot: 'p', basis: 'counted', value: '2', usedFor: '架空' }, '09:00')).toContainText('前後の空白');
  expect(await storageBytes(page)).toEqual(bytes);
  await form.locator('[name=alternativeSource]').fill('A'); await form.locator('[name=alternativeActor]').fill(' ');
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('原票記入者'); expect(await storageBytes(page)).toEqual(bytes);
  await form.locator('[name=alternative]').uncheck();
  await expect(form.locator('[name=alternativeSource]')).toHaveCount(0);
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('記録した');
  const normal = await snapshot(page); expect(normal.ledger.history.some(e => e.kind === 'alternativeRecord')).toBe(false);
  expect(JSON.stringify(normal.ops)).not.toContain('alternativeSource');
  await form.locator('[name=alternative]').check(); await form.locator('[name=alternativeSource]').fill('残してはいけない原票');
  await recorded(page, 'register', lot('other', 'P', 'S1', 'label', '3'), '10:00');
  await expect(form.locator('[name=alternative]')).toHaveCount(0);
  expect(JSON.stringify((await snapshot(page)).ledger)).not.toContain('残してはいけない原票');
});

test('棚卸前の元の資料は包含済みでも不明でも52から減らさず、再入力を拒否する', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('p', 'P', 'S1', 'counted', '52'), '10:00');
  for (const inclusion of ['included', 'unknown'] as const) {
    await goTo(page, 'stock');
    await record(page, 'use', { ...source(inclusion), lot: 'p', basis: 'counted', value: '8', usedFor: '棚卸前' }, '09:00');
    await answer(page, inclusion);
    await expect(cell(page, 'p', '記録上の数と根拠')).toHaveText('52個・数えた');
    const saved = await snapshot(page), primary = saved.ledger.history.at(-1)!;
    expect(primary).toMatchObject({ kind: 'use', applied: false, inclusion });
    expect(saved.ledger.issues[primary.eventId]?.resolution === null).toBe(inclusion === 'unknown');
    const bytes = await storageBytes(page);
    await expect(await record(page, 'use', { ...source(inclusion), lot: 'p', basis: 'counted', value: '8', usedFor: '再入力' }, '09:00')).toContainText('記録済み');
    expect(await storageBytes(page)).toEqual(bytes);
  }
});

test('作業の開始の二行目の材料拒否と最初の保存失敗は、元の資料も現物も確定しない', async ({ page }) => {
  await startEmpty(page); await page.goto('/?test'); await waitForApp(page);
  await recorded(page, 'register', lot('p', 'P', 'S1', 'counted', '20'), '08:00');
  const before = await snapshot(page), bytes = await storageBytes(page);
  const fields = { ...source('start'), ...lot('w', 'P', 'T', 'counted', '1'), process: 'R組立', m1lot: 'p', m1basis: 'counted', m1value: '2', m2lot: 'p' };
  await expect(await record(page, 'start', fields, '09:00')).toContainText('材料2の数量の根拠');
  expect(await storageBytes(page)).toEqual(bytes);
  await page.evaluate(() => window.fuzzyStockTest!.failMidwayAt(1));
  await record(page, 'move', { ...source('move'), lot: 'p', location: 'T' }, '09:00');
  await expect(page.locator('#save')).toContainText('保存できなかった');
  expect(await snapshot(page)).toEqual(before);
  expect(await page.evaluate(() => localStorage.getItem('fuzzy-stock/pending'))).toBeNull();
  await formOf(page).getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('記録した');
  expect((await snapshot(page)).ledger.history.filter(e => e.kind === 'alternativeRecord')).toHaveLength(1);
});

const request = { project: 'A-001', item: 'P', quantity: '10', vendor: '架空仕入先', requestedOn: '2026-09-29', replyKind: 'none' };
test('受け取り後の割り当て拒否でも元の資料は記録済みで、既存受け取りへの再割り当てを使える', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'requestRecord', request, '08:00');
  await expect(await record(page, 'receive', { ...source('receive'), ...lot('in', 'P', 'S1', 'counted', '8'), r1request: 'op1', r1arrived: '9', r1good: '9' }, '09:00')).toContainText('割り当ては拒否');
  const received = await snapshot(page); expect(received.supply.requests['op1']?.arrivals).toEqual([]);
  const bytes = await storageBytes(page);
  await expect(await record(page, 'receive', { ...source('receive'), ...lot('in-again', 'P', 'S1', 'counted', '8') }, '09:00')).toContainText('記録済み');
  expect(await storageBytes(page)).toEqual(bytes);
  await recorded(page, 'allocate', { receipt: 'in', request: 'op1', arrived: '8', good: '8' }, '09:00');
  const after = await snapshot(page);
  expect(after.supply.log.filter(e => e.kind === 'receiptRecord')).toHaveLength(1);
  expect(after.ledger.history.filter(e => e.kind === 'alternativeRecord')).toHaveLength(1);
  expect(after.supply.requests['op1']?.arrivals).toHaveLength(1);
});

for (const kind of ['partial', 'unknown'] as const) test(`受け取りの${kind}保存から再読込・再試行して元の資料と受け取りを一回だけ残す`, async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-14T05:00:00+09:00'));
  await startEmpty(page); await page.goto('/?test'); await waitForApp(page);
  await recorded(page, 'requestRecord', request, '08:00');
  await expect(page.locator('#updated')).toHaveText('最終記録更新：2026-10-14 05:00（日本時間）');
  await page.clock.setFixedTime(new Date('2026-10-14T05:10:00+09:00'));
  await page.evaluate(mode => mode === 'partial' ? window.fuzzyStockTest!.failMidwayAt(2) : window.fuzzyStockTest!.loseResponseAt(1), kind);
  await record(page, 'receive', { ...source('receipt'), ...lot('in', 'P', 'S1', 'counted', '8'), r1request: 'op1', r1arrived: '8', r1good: '8' }, '09:00');
  await expect(page.locator('#save')).toContainText(kind === 'partial' ? '一部だけ保存した' : '保存結果不明');
  await expect(page.locator('#updated')).toHaveText('最終記録更新：2026-10-14 05:10（日本時間）');
  const pending = decodePending(JSON.parse(await page.evaluate(() => localStorage.getItem('fuzzy-stock/pending')) ?? 'null'));
  expect(pending.values).toMatchObject({ '元の資料の識別名・番号': '架空原票A', '元の資料の動きの番号': 'receipt', '原票記入者（入力担当とは別）': '架空原票記入者B' });
  expect(pending.units[0]?.ledger.history.filter(e => e.kind === 'alternativeRecord')).toHaveLength(1);
  await page.reload(); await waitForApp(page);
  await expect(page.locator('#save')).toContainText('架空原票A');
  await expect(page.locator('#updated')).toHaveText('最終記録更新：2026-10-14 05:10（日本時間）');
  await page.getByRole('button', { name: '照会する', exact: true }).click();
  await page.getByRole('button', { name: kind === 'partial' ? '記録し直す' : '再試行する', exact: true }).click();
  const saved = await snapshot(page);
  expect(saved.ledger.history.filter(e => e.kind === 'alternativeRecord')).toHaveLength(1);
  expect(saved.supply.log.filter(e => e.kind === 'receiptRecord')).toHaveLength(1);
  expect(saved.supply.requests['op1']?.arrivals).toHaveLength(1);
  expect(saved.ledger.lots['in']?.quantity).toMatchObject({ numeric: { value: 8 } });
  await expect(await record(page, 'receive', { ...source('receipt'), ...lot('again', 'P', 'S1', 'counted', '8') }, '09:00')).toContainText('記録済み');
});

test('操作切替え後の古い入力は元の操作へ結び付き、同一再送は一回、元の資料だけの変更は拒否する', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('p', 'P', 'S1', 'counted', '20'), '08:00');
  const form = formOf(page);
  await selectOperation(form.locator('[name=op]'), { label: opLabels.use });
  for (const [name, value] of Object.entries({ ...source('001'), lot: 'p', basis: 'counted', value: '2', usedFor: '架空' })) await set(form.locator(`[name=${name}]`), value);
  await form.locator('[name=occurredAt]').fill('2026-09-29T09:00');
  const old = await form.elementHandle(); if (!old) throw Error('元の入力が必要');
  await selectOperation(form.locator('[name=op]'), { label: opLabels.register });
  await old.evaluate(node => node.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  const saved = await snapshot(page), bytes = await storageBytes(page);
  expect(saved.ledger.history.filter(e => e.kind === 'alternativeRecord')).toMatchObject([{ operation: 'use', source: { entry: '001' } }]);
  expect(saved.ledger.lots['p']?.quantity).toMatchObject({ numeric: { value: 18 } });
  await old.evaluate(node => node.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await expect(page.locator('#save')).toContainText('保存済み。もう一度は記録しない');
  expect(await storageBytes(page)).toEqual(bytes);
  await old.evaluate(node => {
    const input = node.querySelector('[name=alternativeEntry]'); if (!(input instanceof HTMLInputElement)) throw Error('元の資料番号なし');
    input.value = '別番号'; node.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await expect(page.locator('#input')).toContainText('違う内容で使用済み'); expect(await storageBytes(page)).toEqual(bytes);
});

test('別ページの更新で古くなった元の資料入力は無変更で拒否する', async ({ page, context }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('p', 'P', 'S1', 'counted', '20'), '08:00');
  const other = await context.newPage(); await other.goto('/'); await waitForApp(other);
  const form = formOf(other); await selectOperation(form.locator('[name=op]'), { label: opLabels.use });
  for (const [name, value] of Object.entries({ ...source('001'), lot: 'p', basis: 'counted', value: '2', usedFor: '架空' })) await set(form.locator(`[name=${name}]`), value);
  const old = await form.elementHandle(); if (!old) throw Error('古い入力なし');
  await goTo(page, 'stock');
  await recorded(page, 'move', { lot: 'p', location: 'T' }, '09:00');
  await expect(other.locator('#input')).toContainText('別の画面で記録が保存された');
  const bytes = await storageBytes(page);
  await old.evaluate(node => node.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await expect(other.locator('#input')).toContainText('再読込');
  expect(await storageBytes(page)).toEqual(bytes);
  expect((await snapshot(page)).ledger.history.some(e => e.kind === 'alternativeRecord')).toBe(false);
  await other.close();
});
