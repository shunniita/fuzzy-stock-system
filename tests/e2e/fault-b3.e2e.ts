import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { decodePending, decodeSnapshot } from '../../src/ui/storageparse.ts';
import type { Snapshot } from '../../src/ui/storage.ts';
import { waitForPersistence, selectOperation, goTo, cell, lot, record, recorded, row, set, waitForApp } from './helpers.ts';

const startedAt = new Date('2026-10-05T04:00:00+09:00');
const retriedAt = new Date('2026-10-05T04:10:00+09:00');
const resolvedAt = new Date('2026-10-05T04:20:00+09:00');
const label = '000039|架空の分納箱';

type BootstrapDiagnostics = {
  pageErrors: string[];
  console: { type: string; text: string }[];
  failedRequests: { url: string; error: string | null }[];
  responses: { url: string; status: number }[];
};
const diagnostics = new WeakMap<Page, BootstrapDiagnostics>();
test.use({ trace: 'retain-on-failure' });
test.beforeEach(({ page }) => {
  const captured: BootstrapDiagnostics = { pageErrors: [], console: [], failedRequests: [], responses: [] };
  diagnostics.set(page, captured);
  page.on('pageerror', error => captured.pageErrors.push(error.message));
  page.on('console', message => captured.console.push({ type: message.type(), text: message.text() }));
  page.on('requestfailed', request => captured.failedRequests.push({ url: request.url(), error: request.failure()?.errorText ?? null }));
  page.on('response', response => captured.responses.push({ url: response.url(), status: response.status() }));
});
test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  const state = await page.evaluate(() => ({
    url: location.href, readyState: document.readyState,
    scripts: Array.from(document.scripts, script => ({ src: script.src, type: script.type })),
    actorOptions: document.querySelectorAll('#actor option').length,
    forms: document.querySelectorAll('#input form').length,
    resources: performance.getEntriesByType('resource').map(entry => ({ name: entry.name, duration: entry.duration })),
  }));
  await evidence(testInfo, 'bootstrap-diagnostics.json', { ...diagnostics.get(page), state, errors: testInfo.errors });
});

function pageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  return errors;
}

async function empty(page: Page): Promise<void> {
  await page.clock.setFixedTime(startedAt);
  await page.goto('/?test');
  await goTo(page, 'management');
  await page.getByRole('button', { name: '練習用の台帳で初期化' }).click();
  await page.getByRole('button', { name: '初期化する', exact: true }).click();
  await goTo(page, 'stock');
}

async function bytesOf(page: Page) {
  return page.evaluate(() => Object.fromEntries(
    Object.keys(localStorage).sort().map(key => [key, localStorage.getItem(key)]),
  ));
}

async function stored(page: Page) {
  await waitForPersistence(page);
  const bytes = await bytesOf(page);
  const head = bytes['fuzzy-stock/head'];
  if (head !== 'A' && head !== 'B') throw new Error('保存先の見出しが必要');
  const text = bytes[`fuzzy-stock/slot-${head}`];
  if (typeof text !== 'string') throw new Error('保存済みの写しが必要');
  const value: unknown = JSON.parse(text);
  const pendingText = bytes['fuzzy-stock/pending'];
  const pendingValue: unknown = typeof pendingText === 'string' ? JSON.parse(pendingText) : null;
  return { bytes, snapshot: decodeSnapshot(value), pending: pendingValue === null ? null : decodePending(pendingValue) };
}

async function fault(page: Page, kind: 'failMidwayAt' | 'loseResponseAt', unit: number): Promise<void> {
  await page.evaluate(({ kind, unit }) => {
    if (!window.fuzzyStockTest) throw new Error('試験用URLの保存障害を使う');
    window.fuzzyStockTest[kind](unit);
  }, { kind, unit });
}

async function evidence(testInfo: TestInfo, name: string, value: unknown): Promise<void> {
  await testInfo.attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
}

function receiptOnce(snapshot: Snapshot): void {
  expect(snapshot.supply.receipts['partial-box']).toMatchObject({ received: 8, label });
  expect(snapshot.supply.log.filter(event => event.kind === 'receiptRecord' && event.lotId === 'partial-box')).toHaveLength(1);
  expect(snapshot.ledger.history.filter(event => event.kind === 'register' && event.changes.some(change => change.after.id === 'partial-box'))).toHaveLength(1);
  expect(snapshot.ledger.lots['partial-box']?.quantity).toMatchObject({ kind: 'known', numeric: { value: 8 } });
}

async function partialReceipt(page: Page, kind: 'failMidwayAt' | 'loseResponseAt'): Promise<void> {
  const request = { project: 'A-001', item: 'P', quantity: '4', vendor: '架空仕入先', requestedOn: '2026-09-29', replyKind: 'none' };
  await recorded(page, 'requestRecord', request, '08:00');
  await recorded(page, 'requestRecord', request, '08:10');
  if (kind === 'failMidwayAt') await fault(page, kind, 3);
  else await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    let heads = 0;
    Storage.prototype.setItem = function(key: string, value: string): void {
      original.call(this, key, value);
      if (key === 'fuzzy-stock/head' && ++heads === 2) {
        Storage.prototype.setItem = original;
        throw new Error('試験用：head確定後の書込応答喪失');
      }
    };
  });
  await record(page, 'receive', lot('partial-box', 'P', 'S1', 'counted', '8', {
    label, r1request: 'op1', r1arrived: '4', r1good: '4', r2request: 'op2', r2arrived: '4', r2good: '4',
  }), '09:00');
  await expect(page.locator('#save')).toContainText(kind === 'failMidwayAt' ? '一部だけ保存した' : '保存結果不明');
  const state = await stored(page);
  receiptOnce(state.snapshot);
  expect(state.snapshot.ops['op3']?.units).toEqual([['op3', 'op3-c'], ['op3-a1']]);
  expect(state.snapshot.supply.requests['op1']?.arrivals).toEqual([{ id: 'op3-a1', receiptLotId: 'partial-box', arrived: 4, good: 4 }]);
  expect(state.snapshot.supply.requests['op2']?.arrivals).toEqual([]);
}

async function blockedReset(page: Page): Promise<void> {
  const before = await bytesOf(page);
  await expect(page.getByRole('form', { name: '操作の入力' })).toHaveCount(0);
  await goTo(page, 'management');
  await page.getByRole('button', { name: '練習用の台帳で初期化' }).click();
  await expect(page.getByRole('region', { name: '初期化の確認' })).toContainText('確かめてから初期化');
  await expect(page.getByRole('button', { name: '初期化する', exact: true })).toHaveCount(0);
  expect(await bytesOf(page)).toEqual(before);
}

async function inquirePartial(page: Page): Promise<void> {
  const before = await bytesOf(page);
  await page.getByRole('button', { name: '照会する', exact: true }).click();
  await expect(page.locator('#save')).toContainText('照会の結果：3単位中2単位が保存済み');
  await expect(page.locator('#save')).toContainText('単位1：保存済み');
  await expect(page.locator('#save')).toContainText('単位2：保存済み');
  await expect(page.locator('#save')).toContainText('単位3：未保存');
  await expect(page.locator('#save')).toContainText('op3-a2');
  expect(await bytesOf(page)).toEqual(before);
}

test('AT-39・2.1〜2.3・2.6: 分割と棚から作業台への移動は保存途中の失敗で全体が未適用、入力と根拠を保つ', async ({ page }, testInfo) => {
  const errors = pageErrors(page);
  await empty(page);
  await recorded(page, 'register', lot('source', 'P', 'S1', 'counted', '10'), '08:00');
  const before = await stored(page);
  await goTo(page, 'issues');
  const history = await page.locator('#history').innerText();
  await fault(page, 'failMidwayAt', 1);
  const values = { lot: 'source', childId: 'moved', basis: 'counted', value: '3', location: 'T' };
  await record(page, 'splitMove', values, '09:00');
  await expect(page.locator('#save')).toContainText('保存できなかった（記録されていない）');
  await expect(page.getByRole('status')).not.toContainText('記録した');
  const form = page.getByRole('form', { name: '操作の入力' });
  for (const [name, value] of Object.entries(values)) await expect(form.locator(`[name=${name}]`)).toHaveValue(value);
  const failed = await stored(page);
  expect(failed.snapshot).toEqual(before.snapshot);
  expect(failed.pending).toBeNull();
  expect(failed.bytes['fuzzy-stock/head']).toBe(before.bytes['fuzzy-stock/head']);
  await goTo(page, 'stock');
  await expect(cell(page, 'source', '記録上の数と根拠')).toHaveText('10個・数えた');
  await expect(cell(page, 'source', '場所')).toHaveText('S1');
  await expect(row(page, 'moved')).toHaveCount(0);
  await goTo(page, 'issues');
  expect(await page.locator('#history').innerText()).toBe(history);
  await evidence(testInfo, 'split-move-failed.json', { before, failed, values });
  await page.reload();
  expect((await stored(page)).snapshot).toEqual(before.snapshot);
  await expect(row(page, 'moved')).toHaveCount(0);
  await recorded(page, 'splitMove', values, '09:00');
  const saved = await stored(page);
  expect(saved.snapshot.ops['op2']?.units).toEqual([['op2', 'op2-m']]);
  await expect(cell(page, 'source', '記録上の数と根拠')).toHaveText('記録上の数7個');
  await expect(cell(page, 'moved', '記録上の数と根拠')).toHaveText('3個・数えた');
  await expect(cell(page, 'moved', '場所')).toHaveText('T');
  await page.reload();
  expect(await stored(page)).toEqual(saved);
  expect(errors).toEqual([]);
});

test('AT-39・2.1〜2.3・2.6: 二つの材料の使用と作業の開始は保存途中で全体が未適用、再記録も材料を一度だけ減らす', async ({ page }, testInfo) => {
  const errors = pageErrors(page);
  await empty(page);
  await recorded(page, 'register', lot('P1', 'P', 'T', 'counted', '10'), '08:00');
  await recorded(page, 'register', lot('Q1', 'Q', 'T', 'counted', '12'), '08:10');
  const before = await stored(page);
  const values = { process: 'R組立', newId: 'R1', item: 'R', project: 'A-001', location: 'T', basis: 'counted', value: '4', m1lot: 'P1', m1basis: 'counted', m1value: '3', m2lot: 'Q1', m2basis: 'counted', m2value: '4' };
  await fault(page, 'failMidwayAt', 1);
  await record(page, 'start', values, '09:00');
  await expect(page.locator('#save')).toContainText('保存できなかった（記録されていない）');
  const form = page.getByRole('form', { name: '操作の入力' });
  for (const [name, value] of Object.entries(values)) await expect(form.locator(`[name=${name}]`)).toHaveValue(value);
  const failed = await stored(page);
  expect(failed.snapshot).toEqual(before.snapshot);
  expect(failed.pending).toBeNull();
  await goTo(page, 'stock');
  await expect(cell(page, 'P1', '記録上の数と根拠')).toHaveText('10個・数えた');
  await expect(cell(page, 'Q1', '記録上の数と根拠')).toHaveText('12個・数えた');
  await expect(row(page, 'R1')).toHaveCount(0);
  await evidence(testInfo, 'materials-start-failed.json', { before, failed, values });
  await page.reload();
  expect((await stored(page)).snapshot).toEqual(before.snapshot);
  await expect(row(page, 'R1')).toHaveCount(0);
  await recorded(page, 'start', values, '09:00');
  const saved = await stored(page);
  expect(saved.snapshot.ops['op3']?.units).toEqual([['op3-u1', 'op3-u2', 'op3']]);
  expect(saved.snapshot.ledger.history.filter(event => event.kind === 'use')).toHaveLength(2);
  expect(saved.snapshot.ledger.history.filter(event => event.kind === 'start')).toHaveLength(1);
  await expect(cell(page, 'P1', '記録上の数と根拠')).toHaveText('記録上の数7個');
  await expect(cell(page, 'Q1', '記録上の数と根拠')).toHaveText('記録上の数8個');
  await expect(cell(page, 'R1', '記録上の数と根拠')).toHaveText('4台・数えた');
  await page.reload();
  expect(await stored(page)).toEqual(saved);
  expect(errors).toEqual([]);
});

test('2.4・2.5・4.7・5.2: 受け取りと割り当て2行の一部保存は入力・ID・対象を保ち、照会は無変更、残り1行だけ再記録する', async ({ page }, testInfo) => {
  const errors = pageErrors(page);
  await empty(page);
  await partialReceipt(page, 'failMidwayAt');
  const partial = await stored(page);
  if (partial.pending === null) throw new Error('一部保存の入力が必要');
  expect(partial.pending).toMatchObject({ opId: 'op3', progress: 'partial', unknownSince: null, startedAt: '2026-10-05T04:00:00+09:00' });
  expect(partial.pending.values).toMatchObject({ 'ラベル文字列（任意）': label, '割り当て2の依頼': 'op2：案件・用途A-001・品目P・4個（架空仕入先、未回答）', '割り当て2の届いた数': '4', '割り当て2の不足の解消に充てた使える数': '4' });
  expect(partial.pending.units.map(unit => unit.targets)).toEqual([['まとまりpartial-box'], ['依頼op1', 'まとまりpartial-box'], ['依頼op2', 'まとまりpartial-box']]);
  await expect(page.locator('#save')).toContainText('保存した単位：1, 2');
  await expect(page.locator('#save')).toContainText('保存できなかった単位：3');
  await expect(page.locator('#save')).toContainText(label);
  await goTo(page, 'issues');
  await expect(page.locator('#issues')).not.toContainText('保存結果不明');
  await blockedReset(page);
  await inquirePartial(page);
  await page.reload();
  expect(await stored(page)).toEqual(partial);
  await inquirePartial(page);
  await evidence(testInfo, 'partial-after-inquiry.json', partial);
  await page.getByRole('button', { name: '記録し直す', exact: true }).click();
  await expect(page.locator('#save')).toContainText('保存した（操作ID：op3）');
  const saved = await stored(page);
  receiptOnce(saved.snapshot);
  expect(saved.pending).toBeNull();
  expect(saved.snapshot.saveChecks).toEqual([]);
  expect(saved.snapshot.ops['op3']?.units).toEqual([['op3', 'op3-c'], ['op3-a1'], ['op3-a2']]);
  expect(saved.snapshot.supply.requests['op1']?.arrivals).toEqual(partial.snapshot.supply.requests['op1']?.arrivals);
  expect(saved.snapshot.supply.requests['op2']?.arrivals).toEqual([{ id: 'op3-a2', receiptLotId: 'partial-box', arrived: 4, good: 4 }]);
  await page.reload();
  expect(await stored(page)).toEqual(saved);
  expect(errors).toEqual([]);
});

test('2.4・4.7・ADR-019: 既知の一部保存の取りやめはpendingだけ片付け、保存済みと未保存を分け、確認事項を作らない', async ({ page }, testInfo) => {
  const errors = pageErrors(page);
  await empty(page);
  await partialReceipt(page, 'failMidwayAt');
  const before = await stored(page);
  await page.evaluate(() => {
    const write = Storage.prototype.setItem;
    const remove = Storage.prototype.removeItem;
    const calls: string[] = [];
    Storage.prototype.setItem = function(key, value) {
      calls.push(`set:${key}`); document.documentElement.dataset['faultWrites'] = JSON.stringify(calls);
      return write.call(this, key, value);
    };
    Storage.prototype.removeItem = function(key) {
      calls.push(`remove:${key}`); document.documentElement.dataset['faultWrites'] = JSON.stringify(calls);
      return remove.call(this, key);
    };
  });
  await page.getByRole('button', { name: '取りやめる', exact: true }).click();
  await waitForPersistence(page);
  await expect(page.locator('#save')).toContainText('取りやめた（操作ID：op3）');
  await expect(page.locator('#save')).toContainText('結果：未保存の残りを取りやめた');
  await expect(page.locator('#save')).toContainText('保存済みの対象：保管単位partial-box, 依頼op1');
  await expect(page.locator('#save')).toContainText('未保存の対象：依頼op2, 保管単位partial-box');
  await expect(page.locator('#save')).not.toContainText('記録済みの解消');
  const after = await stored(page);
  const { 'fuzzy-stock/pending': removed, ...remaining } = before.bytes;
  expect(removed).toBeTruthy();
  expect(after.bytes).toEqual(remaining);
  expect(after.snapshot).toEqual(before.snapshot);
  expect(after.pending).toBeNull();
  expect(after.snapshot.saveChecks).toEqual([]);
  expect(await page.locator('html').getAttribute('data-fault-writes')).toBe(JSON.stringify(['remove:fuzzy-stock/pending']));
  receiptOnce(after.snapshot);
  await evidence(testInfo, 'known-partial-abandoned.json', { before, after });
  await page.reload();
  expect(await stored(page)).toEqual(after);
  await recorded(page, 'declare', { lot: 'partial-box', note: '架空の次の入力' }, '10:00');
  expect((await stored(page)).snapshot.ops['op6']).toBeDefined();
  expect(errors).toEqual([]);
});

test('ADR-019・10.3: 既知の一部保存の削除結果を読み直せなければ競合で中断し、pendingをsavingへ書き直さない', async ({ page }) => {
  const errors = pageErrors(page);
  await empty(page);
  await partialReceipt(page, 'failMidwayAt');
  const before = await stored(page);
  await page.evaluate(() => {
    const read = Storage.prototype.getItem;
    const write = Storage.prototype.setItem;
    const remove = Storage.prototype.removeItem;
    let readback = false;
    const calls: string[] = [];
    Storage.prototype.setItem = function(key, value) {
      calls.push(`set:${key}`); document.documentElement.dataset['faultWrites'] = JSON.stringify(calls);
      return write.call(this, key, value);
    };
    Storage.prototype.getItem = function(key) {
      if (readback && key === 'fuzzy-stock/pending') { readback = false; throw new Error('架空の削除結果の読込失敗'); }
      return read.call(this, key);
    };
    Storage.prototype.removeItem = function(key) {
      calls.push(`remove:${key}`); document.documentElement.dataset['faultWrites'] = JSON.stringify(calls);
      if (key === 'fuzzy-stock/pending') { readback = true; throw new Error('架空の削除結果不明'); }
      return remove.call(this, key);
    };
  });
  await page.getByRole('button', { name: '取りやめる', exact: true }).click();
  await waitForPersistence(page);
  await expect(page.locator('#save')).toContainText('再読込してください');
  await expect(page.getByRole('form', { name: '操作の入力' })).toHaveCount(0);
  expect(await stored(page)).toEqual(before);
  expect(await page.locator('html').getAttribute('data-fault-writes')).toBe(JSON.stringify(['remove:fuzzy-stock/pending']));
  await page.getByRole('button', { name: '再読込する', exact: true }).click();
  expect(await stored(page)).toEqual(before);
  await expect(page.locator('#save')).toContainText('一部だけ保存した');
  await page.getByRole('button', { name: '取りやめる', exact: true }).click();
  await waitForPersistence(page);
  expect((await stored(page)).pending).toBeNull();
  expect(errors).toEqual([]);
});

test('4.1・4.3・4.6・4.7: 不明だった一部保存の再試行失敗はunknownSinceを保持し、取りやめの解消は保存済み・未保存の対象を正確に残す', async ({ page }, testInfo) => {
  const errors = pageErrors(page);
  await empty(page);
  await partialReceipt(page, 'loseResponseAt');
  const unknown = await stored(page);
  if (unknown.pending === null) throw new Error('保存結果不明の入力が必要');
  const issue = page.locator('#issues tr[data-save-issue="op3"]');
  await goTo(page, 'issues');
  await expect(issue).toContainText('未解決');
  await page.clock.setFixedTime(retriedAt);
  await fault(page, 'failMidwayAt', 1);
  await page.getByRole('button', { name: '再試行する', exact: true }).click();
  await expect(page.locator('#save')).toContainText('保存結果不明');
  await expect(page.locator('#save')).toContainText('保存結果不明の確認事項は未解決');
  await expect(page.locator('#save')).toContainText('試験用の保存途中失敗');
  const failed = await stored(page);
  expect(failed.snapshot).toEqual(unknown.snapshot);
  expect(failed.pending).toMatchObject({ progress: 'partial', unknownSince: '2026-10-05T04:00:00+09:00', savingSince: '2026-10-05T04:10:00+09:00', opId: 'op3', startedAt: unknown.pending.startedAt, fingerprint: unknown.pending.fingerprint, values: unknown.pending.values, units: unknown.pending.units });
  await blockedReset(page);
  await page.reload();
  expect(await stored(page)).toEqual(failed);
  await goTo(page, 'issues');
  await expect(issue).toContainText('未解決');
  await inquirePartial(page);
  await page.locator('#actor').selectOption('架空担当B');
  await page.clock.setFixedTime(resolvedAt);
  await page.getByRole('button', { name: '取りやめる', exact: true }).click();
  await waitForPersistence(page);
  const settled = await stored(page);
  expect(settled.pending).toBeNull();
  expect(settled.snapshot.saveChecks).toEqual([{
    opId: 'op3', opLabel: unknown.pending.opLabel, attempt: JSON.stringify(['op3', unknown.pending.startedAt, unknown.pending.fingerprint]),
    openedAt: '2026-10-05T04:00:00+09:00', savedTargets: ['まとまりpartial-box', '依頼op1'], unsavedTargets: ['依頼op2', 'まとまりpartial-box'],
    resolution: { outcome: 'remainderAbandoned', actor: '架空担当B', at: '2026-10-05T04:20:00+09:00' },
  }]);
  expect(settled.snapshot.ledger).toEqual(unknown.snapshot.ledger);
  expect(settled.snapshot.supply).toEqual(unknown.snapshot.supply);
  expect(settled.snapshot.ops).toEqual(unknown.snapshot.ops);
  await goTo(page, 'issues');
  await expect(issue).toContainText('解消済み');
  await expect(issue).toContainText('未保存の残りを取りやめた');
  await expect(issue).toContainText('確認者 架空担当B');
  await evidence(testInfo, 'unknown-partial-abandoned.json', { unknown, failed, settled });
  await page.reload();
  expect(await stored(page)).toEqual(settled);
  receiptOnce(settled.snapshot);
  expect(errors).toEqual([]);
});

test('4.6・4.10: 取りやめの確定後に応答を失っても再読込は同じ解消を復旧し、未保存の割り当てを追加しない', async ({ page }, testInfo) => {
  const errors = pageErrors(page);
  await empty(page);
  await partialReceipt(page, 'loseResponseAt');
  await page.clock.setFixedTime(resolvedAt);
  await page.evaluate(() => {
    const read = Storage.prototype.getItem;
    const write = Storage.prototype.setItem;
    let readback = false;
    Storage.prototype.setItem = function(key, value) {
      write.call(this, key, value);
      if (key === 'fuzzy-stock/head') readback = true;
    };
    Storage.prototype.getItem = function(key) {
      if (readback && key === 'fuzzy-stock/head') { readback = false; throw new Error('架空の解消の復旧読込失敗'); }
      return read.call(this, key);
    };
  });
  await fault(page, 'loseResponseAt', 1);
  await page.getByRole('button', { name: '取りやめる', exact: true }).click();
  await waitForPersistence(page);
  await expect(page.locator('#save')).toContainText('保存された記録を読み込めない');
  await expect(page.locator('#save')).toContainText('架空の解消の復旧読込失敗');
  await expect(page.locator('#save')).not.toContainText('保存できなかった');
  const committed = await stored(page);
  expect(committed.pending?.progress).toBe('saving');
  expect(committed.snapshot.saveChecks).toHaveLength(1);
  expect(committed.snapshot.saveChecks[0]).toMatchObject({ savedTargets: ['まとまりpartial-box', '依頼op1'], unsavedTargets: ['依頼op2', 'まとまりpartial-box'], resolution: { outcome: 'remainderAbandoned' } });
  await page.reload();
  await expect(page.locator('#save')).toContainText('記録済みの解消（操作ID：op3）');
  await expect(page.locator('#save')).toContainText('未保存の残りを取りやめた');
  const recovered = await stored(page);
  expect(recovered.snapshot).toEqual(committed.snapshot);
  expect(recovered.pending).toBeNull();
  receiptOnce(recovered.snapshot);
  expect(recovered.snapshot.supply.requests['op2']?.arrivals).toEqual([]);
  await evidence(testInfo, 'abandon-response-loss-recovered.json', { committed, recovered });
  await page.reload();
  expect(await stored(page)).toEqual(recovered);
  expect(errors).toEqual([]);
});

test('4.1・4.3・4.10: head確定後の例外と読込失敗でも未保存と断定せず、pendingと受け取り一件を保つ', async ({ page }) => {
  const errors = pageErrors(page);
  await empty(page);
  await page.evaluate(() => {
    const read = Storage.prototype.getItem;
    const write = Storage.prototype.setItem;
    let interrupted = false;
    let readback = false;
    Storage.prototype.setItem = function(key, value) {
      write.call(this, key, value);
      if (!interrupted && key === 'fuzzy-stock/head') { interrupted = true; readback = true; throw new Error('架空のhead確定後の例外'); }
    };
    Storage.prototype.getItem = function(key) {
      if (readback && key === 'fuzzy-stock/head') { readback = false; throw new Error('架空のhead読込失敗'); }
      return read.call(this, key);
    };
  });
  await record(page, 'receive', lot('partial-box', 'P', 'S1', 'counted', '8', { label }), '09:00');
  await expect(page.locator('#save')).toContainText('保存結果不明');
  await expect(page.locator('#save')).not.toContainText('保存できなかった');
  const committed = await stored(page);
  receiptOnce(committed.snapshot);
  expect(committed.pending?.opId).toBe('op1');
  await page.reload();
  expect(await stored(page)).toEqual(committed);
  const beforeInquiry = await bytesOf(page);
  await page.getByRole('button', { name: '照会する', exact: true }).click();
  expect(await bytesOf(page)).toEqual(beforeInquiry);
  await expect(page.locator('#save')).toContainText('1単位中1単位が保存済み');
  await page.getByRole('button', { name: '保存済みとして確定する', exact: true }).click();
  const settled = await stored(page);
  receiptOnce(settled.snapshot);
  expect(settled.pending).toBeNull();
  expect(settled.snapshot.saveChecks).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('10.3: 同じBrowserContextの別ページの保存は古い入力の送信を拒み、元の記録を上書きせず再読込する', async ({ page, context }) => {
  const errors = pageErrors(page);
  await empty(page);
  const other = await context.newPage();
  const otherErrors = pageErrors(other);
  await other.goto('/');
  await waitForApp(other);
  expect(await other.evaluate(() => typeof window.fuzzyStockTest)).toBe('undefined');
  const form = other.getByRole('form', { name: '操作の入力' });
  for (const [name, value] of Object.entries(lot('stale-box', 'Q', 'S2', 'counted', '3'))) await set(form.locator(`[name=${name}]`), value);
  await form.locator('[name=occurredAt]').fill('2026-09-29T09:00');
  const stale = await form.elementHandle();
  if (stale === null) throw new Error('古い入力欄を保持する');
  await recorded(page, 'register', lot('writer-box', 'P', 'S1', 'counted', '8'), '08:00');
  const saved = await stored(page);
  await expect(other.locator('#save')).toContainText('別の画面で記録が保存された');
  await stale.evaluate(node => node.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await expect(other.locator('#input')).toContainText('再読込してください');
  expect(await stored(other)).toEqual(saved);
  expect(await stored(page)).toEqual(saved);
  await goTo(other, 'stock');
  await expect(row(other, 'stale-box')).toHaveCount(0);
  await goTo(other, 'management');
  await other.getByRole('button', { name: '練習用の台帳で初期化' }).click();
  await goTo(other, 'management');
  await expect(other.getByRole('button', { name: '初期化する', exact: true })).toHaveCount(0);
  expect(await stored(other)).toEqual(saved);
  await other.getByRole('button', { name: '再読込する', exact: true }).click();
  await goTo(other, 'stock');
  await expect(row(other, 'writer-box')).toContainText('8個');
  expect(await stored(other)).toEqual(saved);
  await other.close();
  expect([...errors, ...otherErrors]).toEqual([]);
});

for (const corruption of ['nested-snapshot', 'nested-pending', 'orphan-pending', 'invalid-head', 'missing-head-slot']) {
  test(`1.6・8.4・8.5: 読み込めない記録 ${corruption} は理由を示し、取消まで全bytesを保ち、明示初期化だけで置き換える`, async ({ page }, testInfo) => {
    const errors = pageErrors(page);
    await empty(page);
    await recorded(page, 'register', lot('keep-box', 'P', 'S1', 'counted', '8'), '08:00');
    if (corruption === 'nested-pending' || corruption === 'orphan-pending') {
      await fault(page, 'loseResponseAt', 1);
      await record(page, 'receive', lot('partial-box', 'P', 'S1', 'counted', '8', { label }), '09:00');
    }
    const valid = await stored(page);
    switch (corruption) {
      case 'nested-snapshot': {
        const keep = valid.snapshot.ledger.lots['keep-box'];
        if (keep === undefined) throw new Error('壊す前の保管単位が必要');
        const malformed = { ...valid.snapshot, ledger: { ...valid.snapshot.ledger, lots: { ...valid.snapshot.ledger.lots, 'keep-box': { ...keep, quantity: { ...keep.quantity, numeric: { value: '8' } } } } } };
        await page.evaluate(text => localStorage.setItem(`fuzzy-stock/slot-${localStorage.getItem('fuzzy-stock/head')}`, text), JSON.stringify(malformed));
        break;
      }
      case 'nested-pending': {
        if (valid.pending === null || valid.pending.units[0] === undefined) throw new Error('壊す前の保存中の入力が必要');
        const malformed = { ...valid.pending, units: [{ ...valid.pending.units[0], targets: [7] }] };
        await page.evaluate(text => localStorage.setItem('fuzzy-stock/pending', text), JSON.stringify(malformed));
        break;
      }
      case 'orphan-pending':
        await page.evaluate(() => {
          localStorage.removeItem('fuzzy-stock/head');
          localStorage.removeItem('fuzzy-stock/slot-A');
          localStorage.removeItem('fuzzy-stock/slot-B');
        });
        break;
      case 'invalid-head':
        await page.evaluate(() => localStorage.setItem('fuzzy-stock/head', 'C'));
        break;
      case 'missing-head-slot':
        await page.evaluate(() => localStorage.removeItem(`fuzzy-stock/slot-${localStorage.getItem('fuzzy-stock/head')}`));
        break;
    }
    const corrupted = await bytesOf(page);
    await page.reload();
    await expect(page.locator('#save')).toContainText('保存された記録を読み込めない');
    await expect(page.locator('#save')).toContainText('理由：');
    await expect(page.locator('#list')).toBeHidden();
    await expect(page.getByRole('form', { name: '操作の入力' })).toHaveCount(0);
    expect(await bytesOf(page)).toEqual(corrupted);
    await page.getByRole('button', { name: '保存された記録を消して初期化する', exact: true }).click();
    await expect(page.getByRole('region', { name: '初期化の確認' })).toContainText('保存済みの記録は消え');
    expect(await bytesOf(page)).toEqual(corrupted);
    await page.getByRole('button', { name: 'やめる', exact: true }).click();
    expect(await bytesOf(page)).toEqual(corrupted);
    await evidence(testInfo, `unreadable-${corruption}.json`, { corruption, bytes: corrupted });
    await page.getByRole('button', { name: '保存された記録を消して初期化する', exact: true }).click();
    await page.getByRole('button', { name: '初期化する', exact: true }).click();
    await expect(page.locator('#list')).toBeVisible();
    const reset = await stored(page);
    expect(reset.pending).toBeNull();
    expect(reset.snapshot.ops).toEqual({});
    expect(reset.snapshot.saveChecks).toEqual([]);
    await expect(row(page, 'keep-box')).toHaveCount(0);
    await expect(row(page, 'partial-box')).toHaveCount(0);
    await page.reload();
    expect(await stored(page)).toEqual(reset);
    expect(errors).toEqual([]);
  });
}

test('8.4・8.5・5.3: 通常URLに保存障害の入口はなく、初期化の取消は入力と保存bytesを保ち、同じ入力を記録できる', async ({ page }) => {
  const errors = pageErrors(page);
  await empty(page);
  await page.goto('/');
  await waitForApp(page);
  expect(await page.evaluate(() => typeof window.fuzzyStockTest)).toBe('undefined');
  await expect(page.locator('body')).not.toContainText('保存後の応答を失わせる');
  await recorded(page, 'register', lot('keep-box', 'P', 'S1', 'counted', '8'), '08:00');
  const before = await stored(page);
  const form = page.getByRole('form', { name: '操作の入力' });
  const values = lot('draft-box', 'Q', 'S2', 'label', '3');
  for (const [name, value] of Object.entries(values)) await set(form.locator(`[name=${name}]`), value);
  await form.locator('[name=occurredAt]').fill('2026-09-29T09:00');
  const original = await form.elementHandle();
  if (original === null) throw new Error('取消前の入力欄を保持する');
  await goTo(page, 'management');
  await page.getByRole('button', { name: '練習用の台帳で初期化' }).click();
  await expect(page.getByRole('region', { name: '初期化の確認' })).toContainText('保存済みの記録は消え');
  expect(await stored(page)).toEqual(before);
  await page.getByRole('button', { name: 'やめる', exact: true }).click();
  expect(await stored(page)).toEqual(before);
  expect(await original.evaluate(node => node.isConnected)).toBe(true);
  await goTo(page, 'stock');
  for (const [name, value] of Object.entries(values)) await expect(form.locator(`[name=${name}]`)).toHaveValue(value);
  await expect(form.locator('[name=occurredAt]')).toHaveValue('2026-09-29T09:00');
  await form.getByRole('button', { name: '記録する' }).click();
  await expect(page.locator('#save')).toContainText('保存した（操作ID：op2）');
  await goTo(page, 'stock');
  await expect(row(page, 'draft-box')).toContainText('3個・表示の数（ラベル・パッケージ）・中身未確認');
  const savedDraft = await stored(page);
  expect(savedDraft.snapshot.ops['op2']?.units).toEqual([['op2']]);
  expect(savedDraft.snapshot.ledger.history).toHaveLength(2);
  await goTo(page, 'management');
  await page.getByRole('button', { name: '練習用の台帳で初期化' }).click();
  await page.getByRole('button', { name: '初期化する', exact: true }).click();
  const reset = await stored(page);
  expect(reset.snapshot.ledger.lots).toEqual({});
  expect(reset.snapshot.ops).toEqual({});
  expect(reset.snapshot.opFloor).toBe(1);
  expect(reset.snapshot.revision).toBeGreaterThan(before.snapshot.revision);
  await goTo(page, 'stock');
  await expect(row(page, 'keep-box')).toHaveCount(0);
  await page.reload();
  expect(await stored(page)).toEqual(reset);
  expect(errors).toEqual([]);
});


test('レビューP2: 全保存の確定失敗後も再読込は結果不明を示し、一部保存と言わない', async ({ page }) => {
  const errors = pageErrors(page);
  await empty(page);
  await fault(page, 'loseResponseAt', 1);
  await record(page, 'receive', lot('confirmed-box', 'P', 'S1', 'counted', '8'));
  await expect(page.locator('#save')).toContainText('保存結果不明');
  const before = await stored(page);
  await page.getByRole('button', { name: '照会する', exact: true }).click();
  await fault(page, 'failMidwayAt', 1);
  await page.getByRole('button', { name: '保存済みとして確定する', exact: true }).click();
  expect((await stored(page)).snapshot).toEqual(before.snapshot);
  await page.reload();
  await expect(page.locator('#save')).toContainText('保存結果不明');
  await expect(page.locator('#save')).not.toContainText('一部だけ保存した');
  await page.getByRole('button', { name: '照会する', exact: true }).click();
  await expect(page.locator('#save')).toContainText('1単位中1単位が保存済み');
  await page.getByRole('button', { name: '保存済みとして確定する', exact: true }).click();
  await expect(page.locator('#save')).toContainText('保存済みだった');
  expect(errors).toEqual([]);
});

test('レビューP2: 未保存の結果不明から再試行の一単位目が失敗しても、一部保存と言わない', async ({ page }) => {
  const errors = pageErrors(page);
  await empty(page);
  await page.evaluate(() => {
    const write = Storage.prototype.setItem;
    const read = Storage.prototype.getItem;
    let failed = false;
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith('fuzzy-stock/slot-')) { failed = true; Storage.prototype.setItem = write; throw new Error('架空の保存失敗'); }
      write.call(this, key, value);
    };
    Storage.prototype.getItem = function(key) {
      if (failed && key === 'fuzzy-stock/head') { Storage.prototype.getItem = read; throw new Error('架空の読込失敗'); }
      return read.call(this, key);
    };
  });
  await record(page, 'receive', lot('unsaved-box', 'P', 'S1', 'counted', '8'));
  await expect(page.locator('#save')).toContainText('保存結果不明');
  await fault(page, 'failMidwayAt', 1);
  await page.getByRole('button', { name: '再試行する', exact: true }).click();
  await page.reload();
  await expect(page.locator('#save')).toContainText('保存結果不明');
  await expect(page.locator('#save')).not.toContainText('一部だけ保存した');
  await page.getByRole('button', { name: '照会する', exact: true }).click();
  await expect(page.locator('#save')).toContainText('1単位中0単位が保存済み');
  await page.getByRole('button', { name: '取りやめる', exact: true }).click();
  await waitForPersistence(page);
  await expect(page.locator('#save')).toContainText('未保存のまま取りやめた');
  expect(errors).toEqual([]);
});

test('要件5.1: 途中の応答喪失設定でも、受け取りと二つの割り当てをすべて保存して結果だけ返さない', async ({ page }) => {
  const errors = pageErrors(page);
  await empty(page);
  const request = { project: 'A-001', item: 'P', quantity: '4', vendor: '架空仕入先', requestedOn: '2026-09-29', replyKind: 'none' };
  await recorded(page, 'requestRecord', request, '08:00');
  await recorded(page, 'requestRecord', request, '08:10');
  await fault(page, 'loseResponseAt', 2);
  await record(page, 'receive', lot('partial-box', 'P', 'S1', 'counted', '8', { label, r1request: 'op1', r1arrived: '4', r1good: '4', r2request: 'op2', r2arrived: '4', r2good: '4' }), '09:00');
  await expect(page.locator('#save')).toContainText('保存結果不明');
  const before = await stored(page);
  expect(before.snapshot.ops['op3']?.units).toHaveLength(3);
  expect(before.snapshot.supply.requests['op2']?.arrivals).toEqual([{ id: 'op3-a2', receiptLotId: 'partial-box', arrived: 4, good: 4 }]);
  receiptOnce(before.snapshot);
  await page.getByRole('button', { name: '再試行する', exact: true }).click();
  await expect(page.locator('#save')).toContainText('保存済みだった');
  expect((await stored(page)).snapshot.supply).toEqual(before.snapshot.supply);
  expect(errors).toEqual([]);
});

for (const unknown of [false, true]) test('レビューP3: 一部保存の取りやめ後の古いフォーム再送は対象を分ける unknown=' + unknown, async ({ page }) => {
  const errors = pageErrors(page);
  await empty(page);
  const request = { project: 'A-001', item: 'P', quantity: '4', vendor: '架空仕入先', requestedOn: '2026-09-29', replyKind: 'none' };
  await recorded(page, 'requestRecord', request, '08:00');
  await recorded(page, 'requestRecord', request, '08:10');
  const form = page.getByRole('form', { name: '操作の入力' });
  await selectOperation(form.locator('[name=op]'), 'receive');
  for (const [name, value] of Object.entries(lot('partial-box', 'P', 'S1', 'counted', '8', { label, r1request: 'op1', r1arrived: '4', r1good: '4', r2request: 'op2', r2arrived: '4', r2good: '4' }))) await set(form.locator('[name=' + name + ']'), value);
  await form.locator('[name=occurredAt]').fill('2026-09-29T09:00');
  const old = await form.elementHandle();
  if (old === null) throw new Error('受け取りフォームが必要');
  if (unknown) await page.evaluate(() => {
    const original = Storage.prototype.setItem; let heads = 0;
    Storage.prototype.setItem = function(key, value) {
      original.call(this, key, value);
      if (key === 'fuzzy-stock/head' && ++heads === 2) { Storage.prototype.setItem = original; throw new Error('架空のhead応答喪失'); }
    };
  });
  else await fault(page, 'failMidwayAt', 3);
  await form.getByRole('button', { name: '記録する' }).click();
  await page.getByRole('button', { name: '取りやめる', exact: true }).click();
  await waitForPersistence(page);
  const before = await bytesOf(page);
  await old.evaluate(node => node.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await expect(page.locator('#save')).toContainText('未保存の残りを取りやめた');
  await expect(page.locator('#save')).toContainText('未保存の対象：依頼op2');
  expect(await bytesOf(page)).toEqual(before);
  receiptOnce((await stored(page)).snapshot);
  expect(errors).toEqual([]);
});


test('レビュー回帰: 入力中に保存値が壊れた場合も読み込み不能で止め、確認付き初期化を案内する', async ({ page }) => {
  const errors = pageErrors(page);
  await empty(page);
  const form = page.getByRole('form', { name: '操作の入力' });
  await selectOperation(form.locator('[name=op]'), 'receive');
  for (const [name, value] of Object.entries(lot('corrupt-box', 'P', 'S1', 'counted', '8'))) await set(form.locator('[name=' + name + ']'), value);
  const before = await page.evaluate(() => {
    const head = localStorage.getItem('fuzzy-stock/head');
    localStorage.setItem('fuzzy-stock/slot-' + head, '{format:fuzzy-stock-f0,version:1}');
    return Object.fromEntries(Object.keys(localStorage).sort().map(key => [key, localStorage.getItem(key)]));
  });
  await form.getByRole('button', { name: '記録する' }).click();
  await expect(page.locator('#save')).toContainText('保存された記録を読み込めない');
  await expect(page.getByRole('form', { name: '操作の入力' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存された記録を消して初期化する', exact: true })).toBeVisible();
  expect(await bytesOf(page)).toEqual(before);
  expect(errors).toEqual([]);
});
