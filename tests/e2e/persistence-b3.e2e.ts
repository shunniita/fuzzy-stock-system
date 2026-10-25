import { chromium, expect, test, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { decodePending, decodeSnapshot } from '../../src/ui/storageparse.ts';
import type { Snapshot } from '../../src/ui/storage.ts';
import { waitForPersistence, selectOperation, goTo, cell, lot, record, recorded, row, set, startEmpty, waitForApp } from './helpers.ts';

const origin = 'http://127.0.0.1:4182';
const receiptLabel = '000007|架空の箱・同じラベル';
const receiptTime = new Date('2026-10-05T03:00:00+09:00');
const confirmationTime = new Date('2026-10-05T03:10:00+09:00');

// 再読込後の起動失敗を数量の不一致と取り違えないよう、失敗時にも配信・実行エラーを残す。
const bootDiagnostics = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const messages: string[] = [];
  bootDiagnostics.set(page, messages);
  page.on('pageerror', error => messages.push(`pageerror: ${error.message}`));
  page.on('requestfailed', request => messages.push(`requestfailed: ${request.url()} ${request.failure()?.errorText}`));
  page.on('response', response => { if (response.status() >= 400) messages.push(`HTTP ${response.status()}: ${response.url()}`); });
});
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) await info.attach('boot-diagnostics', { body: JSON.stringify(bootDiagnostics.get(page) ?? []), contentType: 'application/json' });
});

async function stored(page: Page) {
  await waitForPersistence(page);
  const bytes = await page.evaluate(() => Object.fromEntries(
    Object.keys(localStorage).sort().map(key => [key, localStorage.getItem(key)]),
  ));
  const head = bytes['fuzzy-stock/head'];
  if (head !== 'A' && head !== 'B') throw new Error('保存先の見出しが必要');
  const text = bytes[`fuzzy-stock/slot-${head}`];
  if (typeof text !== 'string') throw new Error('保存済みの写しが必要');
  const value: unknown = JSON.parse(text);
  const pendingText = bytes['fuzzy-stock/pending'];
  const pendingValue: unknown = typeof pendingText === 'string' ? JSON.parse(pendingText) : null;
  return { bytes, snapshot: decodeSnapshot(value), pending: pendingValue === null ? null : decodePending(pendingValue) };
}

function receiptOnce(snapshot: Snapshot, id: string, value: number): void {
  expect(snapshot.supply.receipts[id]).toMatchObject({ received: value });
  expect(snapshot.supply.log.filter(event => event.kind === 'receiptRecord' && event.lotId === id)).toHaveLength(1);
  expect(snapshot.ledger.history.filter(event => event.kind === 'register' && event.changes.some(change => change.after.id === id))).toHaveLength(1);
  expect(snapshot.ledger.lots[id]?.quantity).toMatchObject({ kind: 'known', numeric: { value } });
}

function pageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  return errors;
}

async function attachEvidence(testInfo: TestInfo, name: string, evidence: unknown): Promise<void> {
  await testInfo.attach(name, { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
}

async function visibleEvidence(page: Page) {
  await goTo(page, 'stock');
  await row(page, '0007').getByRole('button', { name: '0007', exact: true }).click();
  const shown: Record<string, string> = {};
  for (const [destination, ids] of [
    ['stock', ['list', 'detail']], ['issues', ['history']], ['supply', ['supply', 'case', 'followup']],
    ['issues', ['issues']], ['stock', ['production', 'updated']],
  ] as const) {
    await goTo(page, destination);
    for (const id of ids) shown[id] = await page.locator(`#${id}`).innerText();
  }
  return shown;
}

async function unknownReceipt(page: Page, id: string): Promise<void> {
  await page.evaluate(() => {
    if (!window.fuzzyStockTest) throw new Error('試験用のURLで保存障害を指定する');
    window.fuzzyStockTest.loseResponseAt(1);
  });
  await record(page, 'receive', lot(id, 'P', 'S1', 'counted', '8', { label: receiptLabel }));
  await expect(page.locator('#save')).toContainText('保存結果不明');
}

test('AT-38前半・1.3: 受け取り直後にEdgeを正常終了し、同じ専用profileで全記録・根拠・割り当てを再表示する', async ({}, testInfo) => {
  const profile = testInfo.outputPath('edge-profile');
  const options = { channel: 'msedge', baseURL: origin, timezoneId: 'Asia/Tokyo', locale: 'ja-JP' };
  let context: BrowserContext | null = null;
  const errors: string[] = [];
  const loadingErrors: string[] = [];
  let phase = '初回Edge起動';
  try {
    context = await test.step(phase, () => chromium.launchPersistentContext(profile, options));
    phase = '初回ページ作成';
    const first = await context.newPage();
    first.on('pageerror', error => errors.push(error.message));
    first.on('requestfailed', request => loadingErrors.push(`${request.url()}: ${request.failure()?.errorText}`));
    first.on('console', message => { if (message.type() === 'error') loadingErrors.push(message.text()); });
    await first.clock.setFixedTime(receiptTime);
    phase = '初回画面の起動と初期化';
    await startEmpty(first);
    phase = '架空データの記録';
    expect(await first.evaluate(() => typeof window.fuzzyStockTest)).toBe('undefined');
    await expect(first.locator('body')).not.toContainText('保存後の応答を失わせる');
    await recorded(first, 'needRegister', { project: 'A-001', item: 'P', basis: 'counted', value: '20', dueDate: '2026-10-10', source: '架空の必要部品表', revision: '第1版' });
    await recorded(first, 'requestRecord', { project: 'A-001', item: 'P', quantity: '6', vendor: '架空仕入先甲', requestedOn: '2026-10-01', replyKind: 'none' });
    await recorded(first, 'requestRecord', { project: 'A-001', item: 'P', quantity: '10', vendor: '架空仕入先乙', requestedOn: '2026-10-02', replyKind: 'answered', replyDate: '2026-10-07' });
    await recorded(first, 'register', lot('unknown-screws', 'V', 'S2', 'unknown', '', { unit: '本', project: 'common' }));
    await recorded(first, 'remainder', { lot: 'unknown-screws', level: 'few' });
    await recorded(first, 'register', lot('return-box', 'Q', 'S2', 'counted', '2'));
    await recorded(first, 'hold', { lot: 'return-box', reason: 'returnPending' }, '13:00');
    await recorded(first, 'handover', { lot: 'return-box', basis: 'counted', value: '2', counterpart: '架空の返却先' }, '14:00');
    await recorded(first, 'returnAck', { handover: 'op8' }, '15:00');
    await recorded(first, 'stop', { process: 'R組立', item: 'R', project: 'A-001', reason: '架空の作業停止', affectedUnknown: true });
    await recorded(first, 'register', lot('unapplied-box', 'P', 'S2', 'label', '10'));
    await record(first, 'use', { lot: 'unapplied-box', basis: 'counted', value: '15', usedFor: '架空作業' }, '13:00');
    await goTo(first, 'issues');
    await expect(first.locator('#issues tr[data-issue="op12"]')).toContainText('負数になるため未反映');
    await recorded(first, 'receive', lot('0007', 'P', 'S1', 'counted', '12', {
      label: receiptLabel, r1request: 'op2', r1arrived: '6', r1good: '6', r2request: 'op3', r2arrived: '4', r2good: '4',
    }));
    await goTo(first, 'stock');
    await expect(row(first, '0007')).toContainText('12個');
    await goTo(first, 'supply');
    await expect(first.locator('#supply')).toContainText(receiptLabel);
    const before = await stored(first);
    expect(before.pending).toBeNull();
    receiptOnce(before.snapshot, '0007', 12);
    expect(before.snapshot.supply.receipts['0007']).toMatchObject({ label: receiptLabel, provisional: false });
    expect(before.snapshot.supply.requests['op2']?.arrivals).toEqual([{ id: 'op13-a1', receiptLotId: '0007', arrived: 6, good: 6 }]);
    expect(before.snapshot.supply.requests['op3']?.arrivals).toEqual([{ id: 'op13-a2', receiptLotId: '0007', arrived: 4, good: 4 }]);
    expect(before.snapshot.ops['op13']?.units).toEqual([['op13', 'op13-c'], ['op13-a1'], ['op13-a2']]);
    expect(before.snapshot.ledger.lots['0007']?.quantity.terms).toEqual([{ sign: 1, observation: { id: 'op13', basis: 'counted', value: 12 } }]);
    expect(before.snapshot.ledger.lots['0007']?.lastCount).toMatchObject({ eventId: 'op13', value: 12 });
    expect(before.snapshot.supply.needs['op1']).toMatchObject({ source: '架空の必要部品表', revision: '第1版' });
    expect(before.snapshot.ledger.lots['unknown-screws']?.quantity.kind).toBe('unknown');
    expect(before.snapshot.supply.levels['unknown-screws']).toMatchObject({ level: 'few', eventId: 'op5' });
    expect(before.snapshot.ledger.issues).toEqual({ op12: { id: 'op12', lotId: 'unapplied-box', reason: 'negative', resolution: null } });
    expect(before.snapshot.ledger.stops['op10']).toMatchObject({ id: 'op10', process: 'R組立', reason: '架空の作業停止', affected: null, resumedBy: null });
    expect(before.snapshot.supply.acks).toEqual({ op8: 'op9' });
    await goTo(first, 'stock');
    await expect(row(first, 'unapplied-box')).toContainText('10個');
    await expect(first.locator('#production')).toContainText('架空の作業停止');
    await goTo(first, 'supply');
    await expect(first.locator('#supply')).toContainText('返品の受付確認：引渡しop8');
    phase = '再起動前の表示と証拠';
    const shown = await visibleEvidence(first);
    await attachEvidence(testInfo, 'before-restart.json', { profile, origin, ...before, shown });
    await first.screenshot({ path: testInfo.outputPath('before-restart.png'), fullPage: true });
    phase = '初回Edgeの正常終了';
    await test.step(phase, () => context!.close());
    context = null;

    phase = '同じプロファイルでEdge再起動';
    context = await test.step(phase, () => chromium.launchPersistentContext(profile, options));
    phase = '再起動後のページ作成';
    const second = await context.newPage();
    second.on('pageerror', error => errors.push(error.message));
    second.on('requestfailed', request => loadingErrors.push(`${request.url()}: ${request.failure()?.errorText}`));
    second.on('console', message => { if (message.type() === 'error') loadingErrors.push(message.text()); });
    await second.clock.setFixedTime(receiptTime);
    phase = '再起動後の画面と保存値の確認';
    await second.goto(origin);
    await waitForApp(second);
    expect(await second.evaluate(() => location.origin)).toBe(origin);
    expect(await second.evaluate(() => typeof window.fuzzyStockTest)).toBe('undefined');
    await goTo(second, 'stock');
    await expect(row(second, '0007')).toContainText('12個');
    await goTo(second, 'stock');
    await expect(row(second, 'unknown-screws')).toContainText('数が不明');
    const after = await stored(second);
    expect(after).toEqual(before);
    expect(await visibleEvidence(second)).toEqual(shown);
    await attachEvidence(testInfo, 'after-restart.json', { profile, origin, ...after, shown: await visibleEvidence(second) });
    await second.screenshot({ path: testInfo.outputPath('after-restart.png'), fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    await attachEvidence(testInfo, 'restart-diagnostics.json', { phase, errors, loadingErrors, status: testInfo.status, expectedStatus: testInfo.expectedStatus });
    await context?.close();
  }
});

test('AT-23・3.1〜3.3・3.5: 古い受け取りフォームの再送と変更を区別し、同じラベルの別箱を追加する', async ({ page }) => {
  const errors = pageErrors(page);
  await startEmpty(page);
  const form = page.getByRole('form', { name: '操作の入力' });
  await selectOperation(form.locator('[name=op]'), 'receive');
  for (const [name, value] of Object.entries(lot('0007', 'P', 'S1', 'label', '8', { label: receiptLabel }))) await set(form.locator(`[name=${name}]`), value);
  await form.locator('[name=occurredAt]').fill('2026-09-29T12:00');
  const old = await form.elementHandle();
  if (old === null) throw new Error('受け取りの入力欄を保持する');
  await form.getByRole('button', { name: '記録する' }).click();
  const saved = await stored(page);
  receiptOnce(saved.snapshot, '0007', 8);
  expect(saved.snapshot.supply.receipts['0007']?.label).toBe(receiptLabel);
  await page.locator('#actor').selectOption({ index: 1 });
  await selectOperation(page.getByRole('form', { name: '操作の入力' }).locator('[name=op]'), 'use');
  expect(await old.evaluate(node => node.isConnected)).toBe(false);
  await old.evaluate(node => node.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await expect(page.locator('#save')).toContainText('保存済み。もう一度は記録しない');
  expect(await stored(page)).toEqual(saved);
  await old.evaluate(node => {
    const input = node.querySelector('[name=newId]');
    if (!(input instanceof HTMLInputElement)) throw new Error('新しいIDの入力欄が必要');
    input.value = 'changed-box';
    node.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await expect(page.locator('#input')).toContainText('違う内容で使用済み');
  expect(await stored(page)).toEqual(saved);
  await goTo(page, 'stock');
  await expect(row(page, 'changed-box')).toHaveCount(0);
  await recorded(page, 'receive', lot('0008', 'P', 'S1', 'label', '8', { label: receiptLabel }));
  const distinct = await stored(page);
  receiptOnce(distinct.snapshot, '0007', 8);
  receiptOnce(distinct.snapshot, '0008', 8);
  expect(Object.keys(distinct.snapshot.ops)).toEqual(['op1', 'op3']);
  expect(distinct.snapshot.supply.receipts['0008']?.label).toBe(receiptLabel);
  await expect(page.getByRole('list', { name: '絞り込んだ範囲の集計' })).toContainText('16個');
  await page.reload();
  expect(await stored(page)).toEqual(distinct);
  await goTo(page, 'supply');
  await expect(page.locator('#supply')).toContainText(receiptLabel);
  expect(errors).toEqual([]);
});

test('AT-24・AT-38後半・4.1〜4.4・4.6・4.8〜4.10: 保存結果不明の照会は保存先を変えず、明示確定だけが証跡を残す', async ({ page }, testInfo) => {
  const errors = pageErrors(page);
  await page.clock.setFixedTime(receiptTime);
  await startEmpty(page);
  await page.goto('/?test');
  await recorded(page, 'register', lot('unapplied-box', 'P', 'S2', 'label', '10'));
  await record(page, 'use', { lot: 'unapplied-box', basis: 'counted', value: '15', usedFor: '架空作業' }, '13:00');
  await expect(row(page, 'unapplied-box')).toContainText('10個');
  await goTo(page, 'issues');
  await expect(page.locator('#history')).toContainText('親から減らしていない（未適用）');
  await unknownReceipt(page, 'unknown-receipt');
  const unresolved = await stored(page);
  const pending = unresolved.pending;
  if (pending === null) throw new Error('保存結果不明の入力が必要');
  expect(pending.opId).toBe('op3');
  expect(pending.units).toHaveLength(1);
  expect(pending.units[0]?.targets).toEqual(['まとまりunknown-receipt']);
  expect(pending.values).toMatchObject({ 'ラベル文字列（任意）': receiptLabel, '数量の根拠': '数えた' });
  receiptOnce(unresolved.snapshot, 'unknown-receipt', 8);
  expect(unresolved.snapshot.ops[pending.opId]?.units).toEqual([['op3', 'op3-c']]);
  expect(unresolved.snapshot.saveChecks).toEqual([]);
  const issue = page.locator('#issues tr[data-save-issue="op3"]');
  await goTo(page, 'issues');
  await expect(issue).toContainText('保存結果不明');
  await expect(issue).toContainText('確認が必要（未解決）');
  await expect(page.locator('#issues tr[data-issue]')).toContainText('負数になるため未反映');
  await expect(page.locator('#issues').getByRole('columnheader', { name: '照合する内容・操作', exact: true })).toBeVisible();
  await expect(page.getByRole('form', { name: '操作の入力' })).toHaveCount(0);
  await goTo(page, 'management');
  await page.getByRole('button', { name: '練習用の台帳で初期化' }).click();
  await expect(page.getByRole('region', { name: '初期化の確認' })).toContainText('確かめてから初期化');
  await expect(page.getByRole('button', { name: '初期化する', exact: true })).toHaveCount(0);
  expect(await stored(page)).toEqual(unresolved);
  await page.reload();
  expect(await stored(page)).toEqual(unresolved);
  await expect(page.locator('#save')).toContainText(receiptLabel);
  await expect(page.locator('#save')).toContainText('unknown-receipt');
  await expect(page.locator('#save')).toContainText('数えた');
  await goTo(page, 'issues');
  await expect(issue).toContainText('未解決');
  await page.getByRole('button', { name: '照会する', exact: true }).click();
  await expect(page.locator('#save')).toContainText('照会の結果：1単位中1単位が保存済み');
  await expect(page.locator('#save')).toContainText('単位1：保存済み');
  expect(await stored(page)).toEqual(unresolved);
  await expect(issue).toContainText('確認が必要（未解決）');
  await expect(page.getByRole('form', { name: '操作の入力' })).toHaveCount(0);
  await attachEvidence(testInfo, 'unknown-after-inquiry.json', unresolved);
  await page.locator('#actor').selectOption({ index: 1 });
  const actor = await page.locator('#actor').inputValue();
  await page.clock.setFixedTime(confirmationTime);
  await page.getByRole('button', { name: '保存済みとして確定する', exact: true }).click();
  const resolved = await stored(page);
  expect(resolved.pending).toBeNull();
  expect(resolved.snapshot.saveChecks).toEqual([{
    opId: pending.opId, opLabel: pending.opLabel, attempt: JSON.stringify([pending.opId, pending.startedAt, pending.fingerprint]),
    openedAt: pending.savingSince, savedTargets: ['まとまりunknown-receipt'], unsavedTargets: [],
    resolution: { outcome: 'saved', actor, at: '2026-10-05T03:10:00+09:00' },
  }]);
  expect(resolved.snapshot.ledger).toEqual(unresolved.snapshot.ledger);
  expect(resolved.snapshot.supply).toEqual(unresolved.snapshot.supply);
  expect(resolved.snapshot.ops).toEqual(unresolved.snapshot.ops);
  receiptOnce(resolved.snapshot, 'unknown-receipt', 8);
  await goTo(page, 'issues');
  await expect(issue).toContainText('解消済み');
  await expect(issue).toContainText(`確認者 ${actor}`);
  await expect(issue).toContainText('保存済みだった');
  await expect(page.getByRole('form', { name: '操作の入力' })).toHaveCount(1);
  for (let reload = 0; reload < 2; reload++) {
    await page.reload();
    expect(await stored(page)).toEqual(resolved);
    await goTo(page, 'issues');
    await expect(issue).toContainText('解消済み');
    await expect(page.getByRole('button', { name: '照会する', exact: true })).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});

test('UI-06: 対象不明の仮の記録と保存結果不明を同時に区別し、保存を確定しても仮の記録は残る', async ({ page }) => {
  await startEmpty(page); await page.goto('/?test'); await waitForApp(page);
  await recorded(page, 'provisional', { direction: 'found', item: '', location: 'T', basis: 'unknown', note: '架空AT45元不明の箱' });
  await unknownReceipt(page, 'AT45-unknown-save');
  const provisional = page.locator('#issues tr[data-issue]').filter({ hasText: '架空AT45元不明の箱' });
  const saving = page.locator('#issues tr[data-save-issue]');
  await goTo(page, 'issues');
  await expect(provisional).toHaveCount(1); await expect(saving).toHaveCount(1);
  await expect(provisional).toContainText('適用対象不明（仮の記録）');
  await expect(provisional).toContainText('対象なし（仮の記録）');
  await expect(provisional).toContainText('台帳に足していない');
  await expect(provisional).not.toContainText('保存結果不明');
  await expect(saving).toContainText('保存結果不明');
  await expect(saving).toContainText('AT45-unknown-save');
  await expect(saving).not.toContainText('架空AT45元不明の箱');
  await page.reload(); await waitForApp(page);
  await goTo(page, 'issues');
  await expect(provisional).toContainText('確認が必要（未解決）'); await expect(saving).toContainText('確認が必要（未解決）');
  await page.getByRole('button', { name: '照会する', exact: true }).click();
  await page.getByRole('button', { name: '保存済みとして確定する', exact: true }).click();
  await expect(saving).toContainText('解消済み'); await expect(provisional).toContainText('確認が必要（未解決）');
  await goTo(page, 'stock');
  await expect(cell(page, 'AT45-unknown-save', '記録上の数と根拠')).toHaveText('8個・数えた');
});

test('AT-23・AT-24・AT-38後半・4.5: 応答喪失の再試行は同じ操作IDを照合し、保存済みの受け取りを再加算しない', async ({ page }) => {
  const errors = pageErrors(page);
  await page.clock.setFixedTime(receiptTime);
  await startEmpty(page);
  await page.goto('/?test');
  await waitForApp(page);
  await unknownReceipt(page, 'retry-receipt');
  const before = await stored(page);
  const pending = before.pending;
  if (pending === null) throw new Error('再試行する保存中の入力が必要');
  receiptOnce(before.snapshot, 'retry-receipt', 8);
  await page.reload();
  expect(await stored(page)).toEqual(before);
  await page.clock.setFixedTime(confirmationTime);
  await page.getByRole('button', { name: '再試行する', exact: true }).click();
  await expect(page.locator('#save')).toContainText(`記録済みの解消（操作ID：${pending.opId}）`);
  await expect(page.locator('#save')).toContainText('保存済みだった');
  const after = await stored(page);
  expect(after.pending).toBeNull();
  expect(after.snapshot.saveChecks).toHaveLength(1);
  expect(after.snapshot.saveChecks[0]).toMatchObject({ opId: pending.opId, savedTargets: ['まとまりretry-receipt'], unsavedTargets: [], resolution: { outcome: 'saved', at: '2026-10-05T03:10:00+09:00' } });
  expect(after.snapshot.ledger).toEqual(before.snapshot.ledger);
  expect(after.snapshot.supply).toEqual(before.snapshot.supply);
  expect(after.snapshot.ops).toEqual(before.snapshot.ops);
  receiptOnce(after.snapshot, 'retry-receipt', 8);
  await goTo(page, 'issues');
  await expect(page.locator('#issues')).toContainText('保存済みだった');
  await expect(page.locator('#issues')).not.toContainText('再試行で保存した');
  await page.reload();
  expect(await stored(page)).toEqual(after);
  await expect(row(page, 'retry-receipt')).toContainText('8個');
  expect(errors).toEqual([]);
});

test('UI-07・QTY-12a・4.6: 保存結果の確定時刻は全体の更新に含め、現物の数量根拠・確認時点は変えない', async ({ page }) => {
  const errors = pageErrors(page);
  await page.clock.setFixedTime(receiptTime);
  await startEmpty(page);
  await page.goto('/?test');
  await waitForApp(page);
  await unknownReceipt(page, 'timed-receipt');
  const before = await stored(page);
  const quantity = await cell(page, 'timed-receipt', '記録上の数と根拠').innerText();
  const counted = await cell(page, 'timed-receipt', '最後に数えた数').innerText();
  const lotUpdated = await cell(page, 'timed-receipt', '最終記録更新').innerText();
  await expect(page.locator('#updated')).toHaveText('最終記録更新：2026-10-05 03:00（日本時間）');
  await page.getByRole('button', { name: '照会する', exact: true }).click();
  await page.clock.setFixedTime(confirmationTime);
  await page.getByRole('button', { name: '保存済みとして確定する', exact: true }).click();
  const after = await stored(page);
  expect(after.snapshot.ledger).toEqual(before.snapshot.ledger);
  expect(after.snapshot.supply).toEqual(before.snapshot.supply);
  await expect(page.locator('#updated')).toHaveText('最終記録更新：2026-10-05 03:10（日本時間）');
  await expect(cell(page, 'timed-receipt', '記録上の数と根拠')).toHaveText(quantity);
  await expect(cell(page, 'timed-receipt', '最後に数えた数')).toHaveText(counted);
  await expect(cell(page, 'timed-receipt', '最終記録更新')).toHaveText(lotUpdated);
  await page.reload();
  expect(await stored(page)).toEqual(after);
  await expect(page.locator('#updated')).toHaveText('最終記録更新：2026-10-05 03:10（日本時間）');
  await expect(cell(page, 'timed-receipt', '最後に数えた数')).toHaveText(counted);
  expect(errors).toEqual([]);
});
