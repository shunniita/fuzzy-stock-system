import { expect, test, type Page } from '@playwright/test';
import { crc32 } from '../../src/ui/backup.ts';
import type { Snapshot } from '../../src/ui/storage.ts';
import { decodePending, decodeSnapshot } from '../../src/ui/storageparse.ts';
import { waitForPersistence, selectOperation, goTo, backupButton, cell, downloadVia, jsonFile, lot, opLabels, pickFile, record, recorded, row, set, storageBytes, waitForApp } from './helpers.ts';

test.use({ trace: 'retain-on-failure' });

for (const oldResult of ['success', 'invalid', 'error'] as const) {
  test(`FH-F1A-14追補・4.1: 先の版5読込が後から${oldResult}になっても、新しく選んだ小数バックアップだけを復元する`, async ({ page }) => {
    const errors = pageErrors(page);
    await begin(page, '/');
    await recorded(page, 'register', kg('first', 'S1', 'counted', '0.5'), '08:00');
    const first = await downloadVia(page, backupButton);
    await goTo(page, 'stock');
    await recorded(page, 'register', kg('second', 'S1', 'label', '0.3'), '09:00');
    const selected = await stored(page);
    const second = await downloadVia(page, backupButton);
    await goTo(page, 'stock');
    await recorded(page, 'register', kg('current', 'S1', 'approximate', '0.7'), '10:00');
    const before = await stored(page);

    // File入力と復号は実物を使い、先に選んだファイルのI/O完了順だけを制御する。
    await page.evaluate(outcome => {
      const read = File.prototype.arrayBuffer;
      const released = new Promise<void>(resolve => window.addEventListener('release-old-restore', () => resolve(), { once: true }));
      File.prototype.arrayBuffer = async function (): Promise<ArrayBuffer> {
        const bytes = await read.call(this);
        if (this.name === 'old-restore.json') {
          document.documentElement.dataset.oldRestoreRead = 'waiting';
          await released;
          if (outcome === 'error') throw new Error('架空の旧ファイル読込エラー');
        }
        return bytes;
      };
    }, oldResult);
    const oldText = oldResult === 'invalid' ? '架空の壊れたバックアップ' : new TextDecoder().decode(first.bytes);
    await pickFile(page, jsonFile('old-restore.json', oldText));
    await expect(page.locator('html')).toHaveAttribute('data-old-restore-read', 'waiting');
    await expect(confirmation(page)).toHaveCount(0);
    expect(await stored(page)).toEqual(before);

    await pickFile(page, jsonFile('new-restore.json', new TextDecoder().decode(second.bytes)));
    await expect(confirmation(page)).toContainText('保管単位2件');
    const selectedConfirmation = await confirmation(page).innerText();
    await page.evaluate(async () => {
      window.dispatchEvent(new Event('release-old-restore'));
      // 解放したPromiseと、その結果を受けるハンドラーのmicrotaskを終えてから観測する。
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    });
    await expect(confirmation(page)).toHaveText(selectedConfirmation, { useInnerText: true });
    await expect(page.locator('#management-feedback')).not.toContainText('復元に使えない');
    expect(await stored(page)).toEqual(before);

    await confirmation(page).getByRole('button', { name: '復元する', exact: true }).click();
    const restored = await stored(page);
    for (const key of ['ledger', 'supply', 'ops', 'saveChecks', 'opFloor'] as const) expect(restored.snapshot[key]).toEqual(selected.snapshot[key]);
    expect(restored.pending).toBeNull();
    await goTo(page, 'stock');
    await expect(cell(page, 'first', '記録上の数と根拠')).toHaveText('0.5kg・数えた');
    await expect(cell(page, 'second', '記録上の数と根拠')).toHaveText('0.3kg・表示の数（ラベル・パッケージ）・中身未確認');
    await expect(row(page, 'current')).toHaveCount(0);
    await page.reload();
    await waitForApp(page);
    expect(await stored(page)).toEqual(restored);
    await expect(cell(page, 'second', '記録上の数と根拠')).toHaveText('0.3kg・表示の数（ラベル・パッケージ）・中身未確認');
    expect(errors).toEqual([]);
  });
}

const form = (page: Page) => page.getByRole('form', { name: '操作の入力' });
const group = (page: Page) => page.locator('#supply article[data-group="A-001/D/kg"]');
const confirmation = (page: Page) => page.getByRole('region', { name: '復元の確認' });
const notice = (page: Page) => page.locator('#management-feedback .notice');
const kg = (id: string, location: string, basis: string, value: string, extra: Record<string, string> = {}) =>
  ({ ...lot(id, 'D', location, basis, value, extra), unit: 'kg' });

function pageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  return errors;
}

// 0.1kg単位の架空品目Dだけを持つ空の台帳から始める。?testは保存障害の入口を開く。
async function begin(page: Page, url: '/' | '/?test'): Promise<void> {
  await page.clock.setFixedTime(new Date('2026-10-05T04:00:00+09:00'));
  await page.goto(url);
  await goTo(page, 'management');
  await page.getByRole('button', { name: '練習用の台帳で初期化' }).click();
  await page.getByRole('button', { name: '初期化する', exact: true }).click();
  await goTo(page, 'stock');
  await selectOperation(form(page).locator('[name=op]'), { label: opLabels.masterItem });
  for (const [name, value] of Object.entries({ code: 'D', name: '架空小数材料D', units: 'kg', 'unitStep-kg': '0.1' })) await set(form(page).locator(`[name="${name}"]`), value);
  await form(page).getByRole('button', { name: '記録する' }).click();
  await expect(page.getByRole('status')).toContainText('記録した');
}

async function stored(page: Page) {
  await waitForPersistence(page);
  const bytes = await storageBytes(page);
  const text = bytes[`fuzzy-stock/slot-${bytes['fuzzy-stock/head']}`];
  if (typeof text !== 'string') throw new Error('保存済みの写しが必要');
  const pendingText = bytes['fuzzy-stock/pending'];
  return { bytes, snapshot: decodeSnapshot(JSON.parse(text)), pending: typeof pendingText === 'string' ? decodePending(JSON.parse(pendingText)) : null };
}

async function fault(page: Page, kind: 'failMidwayAt' | 'loseResponseAt', unit: number): Promise<void> {
  await page.evaluate(({ kind, unit }) => {
    if (!window.fuzzyStockTest) throw new Error('試験用URLの保存障害を使う');
    window.fuzzyStockTest[kind](unit);
  }, { kind, unit });
}

const requestIds = (snapshot: Snapshot): string[] => Object.keys(snapshot.supply.requests).sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
const arrivalsOf = (snapshot: Snapshot, id: string) => snapshot.supply.requests[id]?.arrivals.map(a => ({ receiptLotId: a.receiptLotId, arrived: a.arrived, good: a.good }));
const valueOf = (snapshot: Snapshot, id: string) => {
  const quantity = snapshot.ledger.lots[id]?.quantity;
  return quantity?.kind === 'known' ? quantity.numeric.value : quantity?.kind;
};

const alternativeSource = { alternative: true, alternativeSource: '架空原票K', alternativeEntry: 'K-01', alternativeActor: '架空原票記入者C' };
const expectedSources = [{ operation: 'use', source: { source: '架空原票K', entry: 'K-01', originalActor: '架空原票記入者C' } }];
const sourcesOf = (snapshot: Snapshot) => snapshot.ledger.history.flatMap(e => e.kind === 'alternativeRecord' ? [{ operation: e.operation, operationId: e.operationId, source: e.source }] : []);

// 4.1は同じ判定の再現を求めるので、構造の一致に加えて画面の一覧・不足・案件・用途・フォロー・履歴・確認事項の文字も比べる。
async function shownJudgement(page: Page): Promise<string[]> {
  await goTo(page, 'supply');
  await page.locator('[name=case-project]').selectOption('A-001');
  await goTo(page, 'stock');
  const list = await page.locator('#list').innerText();
  await goTo(page, 'supply');
  const supply = await page.locator('#supply').innerText();
  const project = await page.locator('#case').innerText();
  const followup = await page.locator('#followup').innerText();
  await goTo(page, 'issues');
  const history = await page.locator('#history').innerText();
  const issues = await page.locator('#issues').innerText();
  return [list, supply, project, followup, history, issues];
}

test('4.1・2.3・3.2・3.4: 小数の記録は再読込とバックアップ復元で値・根拠・履歴・元の資料・対応依頼を保ち、同じ不足と未着を示す', async ({ page }) => {
  const errors = pageErrors(page);
  await begin(page, '/');
  await recorded(page, 'needRegister', { project: 'A-001', item: 'D', unit: 'kg', basis: 'counted', value: '1.2', dueDate: '2026-10-10', source: '架空の必要部品一覧', revision: '初版' }, '07:00');
  await recorded(page, 'receive', { newId: 'R1', item: 'D', unit: 'kg', project: 'A-001', location: 'S1', basis: 'counted', value: '0.9' }, '08:00');
  await recorded(page, 'requestRecord', { project: 'A-001', item: 'D', unit: 'kg', quantity: '0.3', vendor: '架空の仕入先X', requestedOn: '2026-09-29', replyKind: 'none', replyDate: '' }, '09:00');
  const [request] = requestIds((await stored(page)).snapshot);
  if (request === undefined) throw new Error('依頼が必要');
  await goTo(page, 'stock');
  await recorded(page, 'receive', { newId: 'R2', item: 'D', unit: 'kg', project: 'A-001', location: 'S1', basis: 'counted', value: '0.2', r1request: request, r1arrived: '0.2', r1good: '0.2' }, '10:00');
  // 共通在庫に置き、案件・用途A-001の不足の判定へ混ぜない。
  await recorded(page, 'register', kg('L1', 'S2', 'label', '0.5', { project: 'common' }), '10:10');
  await recorded(page, 'register', kg('E1', 'S2', 'approximate', '1.3', { project: 'common' }), '10:20');
  await recorded(page, 'register', kg('U1', 'S2', 'unknown', '', { project: 'common' }), '10:30');
  await recorded(page, 'use', { ...alternativeSource, lot: 'L1', basis: 'approximate', value: '0.1', usedFor: '架空作業' }, '10:40');
  await goTo(page, 'supply');
  await expect(group(page)).toContainText('不足 0.1kg');
  await expect(group(page)).toContainText('依頼の未着 0.1kg');
  await goTo(page, 'stock');
  await expect(cell(page, 'R1', '記録上の数と根拠')).toHaveText('0.9kg・数えた');
  const before = await stored(page);
  const shown = await shownJudgement(page);
  expect(valueOf(before.snapshot, 'L1')).toBe(0.4);
  expect(valueOf(before.snapshot, 'E1')).toBe(1.3);
  expect(valueOf(before.snapshot, 'U1')).toBe('unknown');
  expect(arrivalsOf(before.snapshot, request)).toEqual([{ receiptLotId: 'R2', arrived: 0.2, good: 0.2 }]);
  const sources = sourcesOf(before.snapshot);
  expect(sources).toMatchObject(expectedSources);
  const marked = before.snapshot.ledger.history.find(e => e.eventId === sources[0]?.operationId);
  expect(marked).toMatchObject({ kind: 'use' });
  expect(JSON.stringify(marked)).toContain('"L1"');

  await page.reload();
  await waitForApp(page);
  expect(await stored(page)).toEqual(before);
  expect(sourcesOf((await stored(page)).snapshot)).toEqual(sources);
  expect(await shownJudgement(page)).toEqual(shown);

  const backup = await downloadVia(page, backupButton);
  const backedUp = decodeSnapshot(JSON.parse(String(JSON.parse(new TextDecoder().decode(backup.bytes)).snapshot)));
  expect(backedUp.ledger).toEqual(before.snapshot.ledger);
  expect(backedUp.supply).toEqual(before.snapshot.supply);
  await goTo(page, 'stock');
  await recorded(page, 'use', { lot: 'R1', basis: 'counted', value: '0.3', usedFor: '架空作業' }, '11:00');
  await expect(cell(page, 'R1', '記録上の数と根拠')).toHaveText('記録上の数0.6kg');

  await pickFile(page, backup.path);
  await confirmation(page).getByRole('button', { name: '復元する', exact: true }).click();
  await goTo(page, 'stock');
  await expect(cell(page, 'R1', '記録上の数と根拠')).toHaveText('0.9kg・数えた');
  const restored = await stored(page);
  for (const key of ['ledger', 'supply', 'ops', 'saveChecks', 'opFloor'] as const) expect(restored.snapshot[key]).toEqual(before.snapshot[key]);
  expect(restored.pending).toBeNull();
  expect(sourcesOf(restored.snapshot)).toEqual(sources);
  expect(await shownJudgement(page)).toEqual(shown);
  await page.reload();
  await waitForApp(page);
  expect(await stored(page)).toEqual(restored);
  expect(await shownJudgement(page)).toEqual(shown);
  // 復元後も同じ元の資料の再入力は二重の使用にしない。
  await expect(await record(page, 'use', { ...alternativeSource, lot: 'L1', basis: 'counted', value: '0.1', usedFor: '同じ元資料の再入力' }, '11:10')).toContainText('記録済み');
  expect(await stored(page)).toEqual(restored);
  expect(errors).toEqual([]);
});

test('4.2: 小数の使用の保存失敗は保存内容を変えず入力を残し、送り直しで一回だけ減らす', async ({ page }) => {
  const errors = pageErrors(page);
  await begin(page, '/?test');
  await recorded(page, 'register', kg('R1', 'S1', 'counted', '0.5'), '08:00');
  const before = await stored(page);
  await fault(page, 'failMidwayAt', 1);
  const values = { lot: 'R1', basis: 'counted', value: '0.1', usedFor: '架空作業' };
  await record(page, 'use', values, '09:00');
  await expect(page.locator('#save')).toContainText('保存できなかった（記録されていない）');
  for (const [name, value] of Object.entries(values)) await expect(form(page).locator(`[name=${name}]`)).toHaveValue(value);
  // 失敗した書込みは見出しの指さない側の写しにだけ残るので、見出し・写し・未完了入力で比べる。
  const failed = await stored(page);
  expect(failed.snapshot).toEqual(before.snapshot);
  expect(failed.pending).toBeNull();
  expect(failed.bytes['fuzzy-stock/head']).toBe(before.bytes['fuzzy-stock/head']);
  await goTo(page, 'stock');
  await expect(cell(page, 'R1', '記録上の数と根拠')).toHaveText('0.5kg・数えた');
  await form(page).getByRole('button', { name: '記録する' }).click();
  await expect(page.getByRole('status')).toContainText('記録した');
  const saved = await stored(page);
  expect(valueOf(saved.snapshot, 'R1')).toBe(0.4);
  expect(saved.snapshot.ledger.history.filter(event => event.kind === 'use')).toHaveLength(1);
  await page.reload();
  await waitForApp(page);
  expect(await stored(page)).toEqual(saved);
  await expect(cell(page, 'R1', '記録上の数と根拠')).toHaveText('記録上の数0.4kg');
  expect(errors).toEqual([]);
});

// 受け取りと割り当て2行は保存単位3つ（受け取り、割り当て1、割り当て2）になる。
const modes = [
  { name: '既知の一部保存', mid: 2, label: '一部だけ保存した', resend: '記録し直す', inquiry: '3単位中2単位が保存済み' },
  { name: '第一単位の確定後の応答喪失', mid: 1, label: '保存結果不明', resend: '再試行する', inquiry: '3単位中1単位が保存済み' },
  { name: '全単位の保存後の応答喪失', mid: 3, label: '保存結果不明', resend: '再試行する', inquiry: '3単位中3単位が保存済み' },
] as const;

for (const mode of modes) test(`4.2・3.2: ${mode.name}は照会で保存内容を変えず、一回の送り直しで小数の受け取りと割り当てを一回だけ反映する`, async ({ page }) => {
  const errors = pageErrors(page);
  await begin(page, '/?test');
  const request = { project: 'A-001', item: 'D', unit: 'kg', quantity: '0.3', vendor: '架空の仕入先X', requestedOn: '2026-09-29', replyKind: 'none', replyDate: '' };
  await recorded(page, 'requestRecord', request, '08:00');
  await recorded(page, 'requestRecord', request, '08:10');
  const [r1, r2] = requestIds((await stored(page)).snapshot);
  if (r1 === undefined || r2 === undefined) throw new Error('依頼2件が必要');
  if (mode.mid === 2) await fault(page, 'failMidwayAt', 3);
  else if (mode.mid === 3) await fault(page, 'loseResponseAt', 1);
  else await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key: string, value: string): void {
      original.call(this, key, value);
      if (key === 'fuzzy-stock/head') {
        Storage.prototype.setItem = original;
        throw new Error('試験用：第一単位のhead確定後の応答喪失');
      }
    };
  });
  await goTo(page, 'stock');
  await record(page, 'receive', kg('P1', 'S1', 'counted', '0.4', { r1request: r1, r1arrived: '0.2', r1good: '0.2', r2request: r2, r2arrived: '0.2', r2good: '0.1' }), '09:00');
  await expect(page.locator('#save')).toContainText(mode.label);
  const mid = await stored(page);
  if (mid.pending === null) throw new Error('未完了の入力が必要');
  const opId = mid.pending.opId;
  expect(mid.pending.progress).toBe(mode.mid === 2 ? 'partial' : 'saving');
  expect(mid.pending.values).toMatchObject({ '割り当て1の届いた数': '0.2', '割り当て2の不足の解消に充てた使える数': '0.1' });
  expect(mid.snapshot.ops[opId]?.units).toHaveLength(mode.mid);
  expect(valueOf(mid.snapshot, 'P1')).toBe(0.4);
  expect(arrivalsOf(mid.snapshot, r1)).toEqual(mode.mid >= 2 ? [{ receiptLotId: 'P1', arrived: 0.2, good: 0.2 }] : []);
  expect(arrivalsOf(mid.snapshot, r2)).toEqual(mode.mid === 3 ? [{ receiptLotId: 'P1', arrived: 0.2, good: 0.1 }] : []);
  await goTo(page, 'issues');
  if (mode.mid !== 2) await expect(page.locator(`#issues tr[data-save-issue="${opId}"]`)).toContainText('未解決');

  await page.reload();
  await waitForApp(page);
  expect(await stored(page)).toEqual(mid);
  await page.getByRole('button', { name: '照会する', exact: true }).click();
  await expect(page.locator('#save')).toContainText(mode.inquiry);
  expect(await stored(page)).toEqual(mid);

  await page.getByRole('button', { name: mode.resend, exact: true }).click();
  await expect(page.locator('#save')).toContainText(mode.mid === 3 ? '保存済みだった' : `保存した（操作ID：${opId}）`);
  await goTo(page, 'issues');
  if (mode.mid !== 2) await expect(page.locator(`#issues tr[data-save-issue="${opId}"]`)).toContainText('解消済み');
  const saved = await stored(page);
  expect(saved.pending).toBeNull();
  expect(saved.snapshot.ops[opId]?.units).toHaveLength(3);
  expect(saved.snapshot.saveChecks.map(check => [check.opId, check.resolution.outcome])).toEqual(mode.mid === 2 ? [] : [[opId, mode.mid === 3 ? 'saved' : 'retried']]);
  expect(valueOf(saved.snapshot, 'P1')).toBe(0.4);
  expect(arrivalsOf(saved.snapshot, r1)).toEqual([{ receiptLotId: 'P1', arrived: 0.2, good: 0.2 }]);
  expect(arrivalsOf(saved.snapshot, r2)).toEqual([{ receiptLotId: 'P1', arrived: 0.2, good: 0.1 }]);
  expect(saved.snapshot.ledger.history.filter(event => event.kind === 'register' && event.changes.some(change => change.after.id === 'P1'))).toHaveLength(1);
  expect(saved.snapshot.supply.log.filter(event => event.kind === 'receiptRecord')).toHaveLength(1);
  if (mode.mid === 3) {
    expect(saved.snapshot.ledger).toEqual(mid.snapshot.ledger);
    expect(saved.snapshot.supply).toEqual(mid.snapshot.supply);
  }
  await goTo(page, 'supply');
  await expect(group(page)).toContainText('依頼の未着 0.2kg');
  await page.reload();
  await waitForApp(page);
  expect(await stored(page)).toEqual(saved);
  await goTo(page, 'supply');
  await expect(group(page)).toContainText('依頼の未着 0.2kg');
  expect(errors).toEqual([]);
});

test('4.2: 別ページで保存された後の古い小数の入力は拒否し、保存内容を上書きしない', async ({ page, context }) => {
  const errors = pageErrors(page);
  await begin(page, '/');
  const other = await context.newPage();
  const otherErrors = pageErrors(other);
  await other.goto('/');
  await waitForApp(other);
  await selectOperation(form(other).locator('[name=op]'), { label: opLabels.register });
  for (const [name, value] of Object.entries(kg('stale', 'S2', 'counted', '0.3'))) await set(form(other).locator(`[name=${name}]`), value);
  await form(other).locator('[name=occurredAt]').fill('2026-09-29T09:00');
  const stale = await form(other).elementHandle();
  if (stale === null) throw new Error('古い入力欄を保持する');
  await goTo(page, 'stock');
  await recorded(page, 'register', kg('writer', 'S1', 'counted', '0.7'), '08:00');
  const saved = await stored(page);
  await expect(other.locator('#save')).toContainText('別の画面で記録が保存された');
  await stale.evaluate(node => node.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await expect(other.locator('#input')).toContainText('再読込してください');
  await expect(other.locator('#input')).toContainText('記録していない');
  expect(await stored(other)).toEqual(saved);
  expect(await stored(page)).toEqual(saved);
  await expect(row(other, 'stale')).toHaveCount(0);
  await other.getByRole('button', { name: '再読込する', exact: true }).click();
  await expect(cell(other, 'writer', '記録上の数と根拠')).toHaveText('0.7kg・数えた');
  await other.close();
  expect([...errors, ...otherErrors]).toEqual([]);
});

// 写しの文字列を直接書き換え、検査値は作り直す。JSON.parse→stringifyでは0.90000000000000001が0.9へ返ってきた物、改変にならない。
function tamperedBackup(backupText: string, edit: (snapshotText: string) => string) {
  const envelope: Record<string, unknown> = JSON.parse(backupText);
  const original = String(envelope.snapshot);
  const snapshot = edit(original);
  expect(snapshot).not.toBe(original);
  const checksum = crc32(new TextEncoder().encode(`${String(envelope.createdAt)}\n${snapshot}`)).toString(16).padStart(8, '0');
  return jsonFile('tampered.json', JSON.stringify({ ...envelope, snapshot, crc32: checksum }));
}

const quantityToken = /(?<=[:,[])0\.9(?=[,\]}])/g;
type RawItem = { code: string; unitSteps: Record<string, number> };
type RawSnapshot = { ledger: { history: { kind: string; masters?: { after: RawItem }[] }[] } };
const historicalStep = (text: string): string => {
  const value: RawSnapshot = JSON.parse(text);
  const registered = value.ledger.history.flatMap(event => event.masters ?? []).find(pair => pair.after.code === 'D');
  if (registered === undefined) throw new Error('品目Dの登録履歴が必要');
  registered.after.unitSteps = { kg: 1 };
  return JSON.stringify(value);
};

const tampers = [
  { name: '丸められる数値原文', edit: (text: string) => text.replace(quantityToken, '0.90000000000000001'), reason: '記録がJSONとして読めない' },
  { name: '精度属性を整数へ揃えて書き換えた小数の数量', edit: (text: string) => text.replaceAll('"kg":0.1', '"kg":1'), reason: '数量が品目・単位の精度に合わない' },
  { name: '許容外の精度属性', edit: (text: string) => text.replaceAll('"kg":0.1', '"kg":0.2'), reason: '単位 kg の最小単位は1または0.1にする' },
  { name: '履歴と異なる精度', edit: historicalStep, reason: '同じ品目IDの単位と最小単位は現在と履歴で一致することが必要' },
] as const;

test('4.3・4.1: 不正な数値原文・精度属性・歴史的精度を含む復元候補と保存先の写しは拒否し、現在の保存を保つ', async ({ page }) => {
  const errors = pageErrors(page);
  await begin(page, '/');
  await recorded(page, 'receive', { newId: 'R1', item: 'D', unit: 'kg', project: 'A-001', location: 'S1', basis: 'counted', value: '0.9' }, '08:00');
  const backup = await downloadVia(page, backupButton);
  const backupText = new TextDecoder().decode(backup.bytes);
  await goTo(page, 'stock');
  await recorded(page, 'register', kg('kept', 'S1', 'label', '0.3'), '09:00');
  const current = await storageBytes(page);

  for (const tamper of tampers) {
    await test.step(tamper.name, async () => {
      await pickFile(page, tamperedBackup(backupText, tamper.edit));
      await expect(notice(page)).toContainText(`記録の検査を通らない`);
      await expect(notice(page)).toContainText(tamper.reason);
      await expect(confirmation(page)).toHaveCount(0);
      expect(await storageBytes(page)).toEqual(current);
    });
  }
  // 改変していない同じバックアップは受け付ける（拒否の原因が改変だけであることの対照）。取り消して保存は変えない。
  await pickFile(page, backup.path);
  await expect(confirmation(page)).toBeVisible();
  await confirmation(page).getByRole('button', { name: 'やめる', exact: true }).click();
  expect(await storageBytes(page)).toEqual(current);
  await goTo(page, 'stock');
  await expect(cell(page, 'kept', '記録上の数と根拠')).toHaveText('0.3kg・表示の数（ラベル・パッケージ）・中身未確認');

  const corrupted = await page.evaluate(source => {
    const key = `fuzzy-stock/slot-${localStorage.getItem('fuzzy-stock/head')}`;
    const text = localStorage.getItem(key) ?? '';
    const changed = text.replace(new RegExp(source, 'g'), '0.90000000000000001');
    if (changed === text) throw new Error('改変する数値原文が必要');
    localStorage.setItem(key, changed);
    return Object.fromEntries(Object.keys(localStorage).sort().map(k => [k, localStorage.getItem(k)]));
  }, quantityToken.source);
  await page.reload();
  await expect(page.locator('#save')).toContainText('保存された記録を読み込めない');
  await expect(page.getByRole('form', { name: '操作の入力' })).toHaveCount(0);
  expect(await storageBytes(page)).toEqual(corrupted);
  expect(errors).toEqual([]);
});
