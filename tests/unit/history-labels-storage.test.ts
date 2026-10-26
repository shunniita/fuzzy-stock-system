import { afterEach, describe, expect, test } from 'vitest';
import { changeMasters, practiceLedger, type Meta } from '../../src/domain/ledger.ts';
import { allocateArrival, emptySupply, receiveLot, recordRequest } from '../../src/domain/supply.ts';
import { captureItemLabels, type EventItemLabels } from '../../src/domain/history-labels.ts';
import { backupTextOf, crc32, readBackup } from '../../src/ui/backup.ts';
import { attemptOf, commit, faults, fingerprintOf, initial, inquire, load, parse, retry, serialize, serializePending, targetsOf, type Pending, type Snapshot, type StoreLike, type UnitState } from '../../src/ui/storage.ts';
import { decodePending } from '../../src/ui/storageparse.ts';
import { legacyJson } from '../fixtures/history-labels.ts';
import { receiveTemplate, saveReceiptTemplate, type ReceiptTemplate } from '../../src/domain/receipt-template.ts';

const at = '2026-10-24T09:00:00+09:00';
const later = '2026-10-24T10:00:00+09:00';
const meta = (eventId: string): Meta => ({ eventId, occurredAt: at, recordedAt: at, actor: '架空担当A' });
const lot = (id: string) => ({ id, item: 'P', unit: '個', project: { kind: 'common' as const }, location: 'S1' });
class Memory implements StoreLike {
  readonly data = new Map<string, string>();
  readonly writes: string[] = [];
  loseAtHead: number | null = null;
  heads = 0;
  failBeforeSlot = false;
  failNextHeadRead = false;
  getItem(key: string): string | null {
    if (key === 'fuzzy-stock/head' && this.failNextHeadRead) { this.failNextHeadRead = false; throw new Error('架空の障害後head読取失敗'); }
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.writes.push(key);
    if (key.includes('/slot-') && this.failBeforeSlot) { this.failBeforeSlot = false; this.failNextHeadRead = true; throw new Error('架空の最初の写し前障害'); }
    this.data.set(key, value);
    if (key === 'fuzzy-stock/head' && ++this.heads === this.loseAtHead) throw new Error('架空のhead確定後応答喪失');
  }
  removeItem(key: string): void { this.writes.push(key); this.data.delete(key); }
}
const operation = (opId = 'op20') => ({ opId, opLabel: '架空受入と充当', fingerprint: fingerprintOf('架空受け取りと割り当て', {}), values: {}, actor: '架空担当A', startedAt: at, savingSince: at });
function fixture() {
  const base = receiveLot(practiceLedger, emptySupply, meta('base'), lot('base-lot'), 'counted', 10);
  let supply = base.supply;
  for (const id of ['request1', 'request2']) supply = recordRequest(supply, base.ledger.masters, meta(id), { project: { kind: 'common' }, item: 'P', unit: '個', quantity: 2, vendor: '架空商社', requestedOn: '2026-10-24', reply: { kind: 'none' } });
  const current = initial(base.ledger, supply), store = new Memory();
  store.data.set('fuzzy-stock/head', 'A'); store.data.set('fuzzy-stock/slot-A', serialize(current));
  const first = receiveLot(current.ledger, current.supply, meta('op20-r'), lot('received-lot'), 'counted', 4);
  const second = { ledger: first.ledger, supply: allocateArrival(first.ledger, first.supply, meta('op20-a1'), 'request1', { receiptLotId: 'received-lot', arrived: 1, good: 1 }) };
  const third = { ledger: second.ledger, supply: allocateArrival(second.ledger, second.supply, meta('op20-a2'), 'request2', { receiptLotId: 'received-lot', arrived: 1, good: 1 }) };
  let before = { ledger: current.ledger, supply: current.supply };
  const units: UnitState[] = [first, second, third].map(state => {
    const unit = { ...state, conflictReviews: [], targets: targetsOf(before, state) };
    before = state; return unit;
  });
  return { current, store, units, op: operation() };
}
type OldVersion = 1 | 4 | 5 | 6 | 7 | 8;
const versions = [1, 4, 5, 6, 7, 8] satisfies OldVersion[];
// 正当な今回の架空状態だけから旧書式を生成する。拒否対象を加えた後には適用しない。
function oldFields(value: unknown, version: OldVersion): string {
  return JSON.stringify(JSON.parse(legacyJson(value)), (key, entry: unknown) =>
    (version < 3 && key === 'masters') || (version < 5 && key === 'unitSteps') || (version < 6 && key === 'conflictReviews') || (version < 7 && key === 'receiptTemplates') ? undefined : entry);
}
function oldSnapshot(s: Snapshot, version: OldVersion): string {
  const value = version === 1 ? s : JSON.parse(serialize(s));
  return oldFields({ ...value, version }, version);
}
function oldPending(p: Pending, version: OldVersion): string {
  const envelope = JSON.parse(oldFields(JSON.parse(serializePending(p)), version));
  return JSON.stringify(version === 1 ? { ...envelope.pending, ...(envelope.quantities === undefined ? {} : { quantities: envelope.quantities }) } : { ...envelope, version });
}
function loaded(store: Memory) {
  const value = load(store);
  if (value.kind !== 'ok') throw new Error(`正当な保存が必要: ${value.kind}`);
  return value;
}
function active(store: Memory): Snapshot {
  return parse(store.data.get(`fuzzy-stock/slot-${store.data.get('fuzzy-stock/head')}`)!);
}
type Interruption = 'unstarted' | 'partial1' | 'unknown1' | 'unknown2';
function interrupted(version: OldVersion, mode: Interruption) {
  const f = fixture();
  let pending: Pending;
  const saved = mode === 'unstarted' ? 0 : mode === 'unknown2' ? 2 : 1;
  if (mode === 'unstarted') {
    pending = { ...f.op, baseRevision: f.current.revision, progress: 'saving', unknownSince: null, units: f.units };
  } else {
    if (mode === 'partial1') faults.failMidwayAt = 2;
    else f.store.loseAtHead = saved;
    const result = commit(f.store, f.current, f.op, f.units);
    expect(result.kind).toBe(mode === 'partial1' ? 'partial' : 'unknown');
    if (result.kind !== 'partial' && result.kind !== 'unknown') throw new Error('途中保存が必要');
    pending = result.pending;
  }
  f.store.loseAtHead = null;
  for (const slot of ['A', 'B']) {
    const key = `fuzzy-stock/slot-${slot}`, text = f.store.data.get(key);
    if (text !== undefined) f.store.data.set(key, oldSnapshot(parse(text), version));
  }
  f.store.data.set('fuzzy-stock/pending', oldPending(pending, version));
  f.store.writes.length = 0;
  return { ...f, saved };
}
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
function backupOfText(text: string): Uint8Array {
  return bytes(JSON.stringify({ notice: '架空試験', format: 'fuzzy-stock-backup', version: 1, createdAt: at, crc32: crc32(bytes(`${at}\n${text}`)).toString(16).padStart(8, '0'), snapshot: text }));
}
afterEach(() => { faults.failMidwayAt = null; faults.loseResponseAt = null; });

describe('履歴表示 task5 真正旧pendingの非破壊読込と未保存分の再試行', () => {
  const cases = versions.flatMap(version => (['unstarted', 'partial1', 'unknown1', 'unknown2'] satisfies Interruption[]).map(mode => ({ version, mode })));
  test.each(cases)('版$version/$mode は旧snapshotと共に読み、未保存分だけ確定して再送を重複させない', ({ version, mode }) => {
    const { store, saved, op } = interrupted(version, mode), before = new Map(store.data);
    const read = loaded(store);
    expect(store.data).toEqual(before); expect(store.writes).toEqual([]);
    const oldText = store.data.get(`fuzzy-stock/slot-${store.data.get('fuzzy-stock/head')}`)!;
    expect(readBackup(backupOfText(oldText))).toMatchObject({ kind: 'ok', snapshot: read.snapshot });
    const pending = read.pending;
    if (pending === null) throw new Error('未完のpendingが必要');
    for (const unit of pending.units) for (const event of [...unit.ledger.history, ...unit.supply.log]) expect(event.itemLabels).toEqual({ kind: 'legacy-unavailable' });
    expect(inquire(store, pending)).toEqual({ snapshot: read.snapshot, savedUnits: saved, total: 3 });
    expect(store.data).toEqual(before); expect(store.writes).toEqual([]);
    const result = retry(store, read.snapshot, pending, '架空確認者B', later);
    expect(result.kind).toBe('saved');
    if (result.kind !== 'saved') throw new Error('残りの保存が必要');
    const final = result.snapshot, last = pending.units.at(-1)!;
    expect(final.ledger).toEqual(last.ledger); expect(final.supply).toEqual(last.supply);
    expect(final.revision).toBe(3); expect(final.version).toBe(11);
    expect(final.ops.op20!.units).toEqual([['op20-r', 'op20-r-c'], ['op20-a1'], ['op20-a2']]);
    expect(store.writes.filter(key => key.includes('/slot-'))).toHaveLength(3 - saved);
    expect(final.saveChecks).toEqual(mode === 'partial1' ? [] : [{ opId: 'op20', opLabel: op.opLabel, attempt: attemptOf(pending), openedAt: at,
      savedTargets: ['まとまりreceived-lot', '依頼request1', '依頼request2'], unsavedTargets: [], resolution: { outcome: 'retried', actor: '架空確認者B', at: later } }]);
    expect(store.data.has('fuzzy-stock/pending')).toBe(false);
    const beforeInquiry = new Map(store.data), writesBeforeInquiry = store.writes.length;
    expect(inquire(store, pending)).toEqual({ snapshot: final, savedUnits: 3, total: 3 });
    expect(store.data).toEqual(beforeInquiry); expect(store.writes).toHaveLength(writesBeforeInquiry);
    expect(parse(serialize(final))).toEqual(final);
    expect(readBackup(bytes(backupTextOf(final, at)))).toMatchObject({ kind: 'ok', snapshot: final });
    const immutable = new Map(store.data); store.writes.length = 0;
    const changedProposal = pending.units.map(unit => rewritten(unit, 'ledger', replacement('name')));
    const resent = commit(store, final, op, changedProposal);
    expect(resent.kind).toBe(mode === 'partial1' ? 'duplicate' : 'recovered');
    expect(retry(store, final, pending, '架空確認者B', later).kind).toBe(mode === 'partial1' ? 'conflict' : 'recovered');
    expect(active(store)).toEqual(final); expect(store.data).toEqual(immutable); expect(store.writes).toEqual([]);
    expect(new Set(final.ledger.history.map(e => e.eventId)).size).toBe(final.ledger.history.length);
    expect(new Set(final.supply.log.map(e => e.eventId)).size).toBe(final.supply.log.length);
  });
  test.each(versions)('旧版%sのpendingへ新欄を混ぜた場合は、正常対照と同じ数量表のまま拒否しbytesを維持する', version => {
    const { store } = interrupted(version, 'unstarted');
    const value = JSON.parse(store.data.get('fuzzy-stock/pending')!);
    expect(() => decodePending(value)).not.toThrow();
    const p = version === 1 ? value : value.pending;
    p.units[0].ledger.history[0].itemLabels = { kind: 'legacy-unavailable' };
    store.data.set('fuzzy-stock/pending', JSON.stringify(value));
    const before = new Map(store.data);
    expect(() => decodePending(value)).toThrow('旧版は履歴品目表示を持たない');
    expect(load(store)).toMatchObject({ kind: 'unreadable', reason: expect.stringContaining('itemLabels') });
    expect(store.data).toEqual(before); expect(store.writes).toEqual([]);
  });
});

type Column = 'ledger' | 'supply';
type LabelChange = 'name' | 'code' | 'code-null' | 'recorded-to-legacy' | 'legacy-to-recorded';
function replacement(mode: LabelChange): EventItemLabels {
  if (mode === 'recorded-to-legacy') return { kind: 'legacy-unavailable' };
  const original = captureItemLabels(practiceLedger.masters, ['P']);
  return { kind: 'recorded', items: { P: { name: mode === 'name' ? '架空の別の当時名称' : original.items.P!.name, code: mode === 'code' ? 'OLD-CODE' : mode === 'code-null' ? null : original.items.P!.code } } };
}
function rewritten(unit: UnitState, column: Column, labels: EventItemLabels): UnitState {
  return column === 'ledger' ? { ...unit, ledger: { ...unit.ledger, history: unit.ledger.history.map((e, i) => i === 0 ? { ...e, itemLabels: labels } : e) } }
    : { ...unit, supply: { ...unit.supply, log: unit.supply.log.map((e, i) => i === 0 ? { ...e, itemLabels: labels } : e) } };
}
describe('履歴表示 task5 単独復号と基準付き接頭辞検査を区別する', () => {
  const cases = (['ledger', 'supply'] satisfies Column[]).flatMap(column => (['name', 'code', 'code-null', 'recorded-to-legacy', 'legacy-to-recorded'] satisfies LabelChange[]).map(mode => ({ column, mode })));
  test.each(cases)('$column/$mode は3境界で形式上受理しても、既存headへのappend/retryでは拒否する', ({ column, mode }) => {
    const f = fixture(), current = mode === 'legacy-to-recorded' ? parse(oldSnapshot(f.current, 8)) : f.current;
    const next = receiveLot(current.ledger, current.supply, meta('op21-r'), lot('new-lot'), 'counted', 1);
    const unit = rewritten({ ...next, conflictReviews: [], targets: targetsOf(current, next) }, column, replacement(mode));
    const independent = initial(unit.ledger, unit.supply);
    expect(parse(serialize(independent))).toEqual(independent);
    expect(readBackup(backupOfText(serialize(independent)))).toMatchObject({ kind: 'ok', snapshot: independent });
    const pending: Pending = { ...operation('op21'), baseRevision: current.revision, progress: 'partial', unknownSince: null, units: [unit] };
    expect(decodePending(JSON.parse(serializePending(pending)))).toEqual(pending);
    const store = new Memory(); store.data.set('fuzzy-stock/head', 'A'); store.data.set('fuzzy-stock/slot-A', serialize(current));
    const before = new Map(store.data);
    expect(commit(store, current, operation('op21'), [unit])).toMatchObject({ kind: 'failed', reason: expect.stringContaining('履歴が現在の状態に続いていない') });
    expect(store.data).toEqual(before); expect(store.writes).toEqual([]);
    store.data.set('fuzzy-stock/pending', serializePending(pending));
    const beforeRetry = new Map(store.data), read = loaded(store);
    expect(retry(store, read.snapshot, read.pending!, '架空確認者B', later)).toMatchObject({ kind: 'failed', reason: expect.stringContaining('履歴が現在の状態に続いていない') });
    expect(store.data).toEqual(beforeRetry); expect(store.writes).toEqual([]);
  });
  test.each(['recorded', 'legacy'] as const)('%s接頭辞を保つ正常な改名と新規追記は、旧表示と数量を保持して受理する', kind => {
    const f = fixture(), current = kind === 'legacy' ? parse(oldSnapshot(f.current, 8)) : f.current;
    const renamed = changeMasters(current.ledger, meta('op21-name'), { action: 'rename', type: 'item', id: 'P', name: '架空の現在名称', reason: '架空改名' });
    const next = receiveLot(renamed, current.supply, meta('op21-r'), lot('new-lot'), 'counted', 1);
    const unit = { ...next, conflictReviews: [], targets: targetsOf(current, next) };
    f.store.data.set('fuzzy-stock/slot-A', serialize(current));
    const result = commit(f.store, current, operation('op21'), [unit]);
    expect(result.kind).toBe('saved');
    if (result.kind !== 'saved') throw new Error('正当な末尾追記が必要');
    expect(result.snapshot.ledger.history.slice(0, current.ledger.history.length)).toEqual(current.ledger.history);
    expect(result.snapshot.supply.log.slice(0, current.supply.log.length)).toEqual(current.supply.log);
    expect(result.snapshot.ledger.lots['base-lot']).toEqual(current.ledger.lots['base-lot']);
    expect(result.snapshot.ledger.history.at(-1)).toHaveProperty('itemLabels.items.P.name', '架空の現在名称');
    expect(result.snapshot.supply.log.at(-1)).toHaveProperty('itemLabels.items.P.name', '架空の現在名称');
    expect(parse(serialize(result.snapshot))).toEqual(result.snapshot);
  });
});

describe('履歴表示 task6 完成済み供給提案と固定組立treeの復旧', () => {
  test.each(['duplicate', 'recovered'] as const)('完成済み供給提案の当時name/code改変を再送しても%sを返し、保存bytes・履歴・数量を書き換えない', expected => {
    const f = fixture();
    if (expected === 'recovered') f.store.loseAtHead = 3;
    let result;
    try { result = commit(f.store, f.current, f.op, f.units); }
    finally { f.store.loseAtHead = null; }
    expect(result.kind).toBe(expected === 'recovered' ? 'unknown' : 'saved');
    if (result.kind === 'unknown') {
      const read = loaded(f.store); result = retry(f.store, read.snapshot, read.pending!, '架空確認者B', later);
    }
    if (result.kind !== 'saved' && result.kind !== 'recovered') throw new Error('完成済みの保存が必要');
    const final = result.snapshot, before = new Map(f.store.data);
    f.store.writes.length = 0;
    const proposal = f.units.map(unit => rewritten(unit, 'supply', { kind: 'recorded', items: { P: { name: '架空の改変名', code: 'CHANGED' } } }));
    const proposalPending: Pending = { ...f.op, baseRevision: f.current.revision, progress: 'saving', unknownSince: null, units: proposal };
    expect(decodePending(JSON.parse(serializePending(proposalPending))).units).toEqual(proposal);
    const resent = commit(f.store, final, f.op, proposal);
    expect(resent).toMatchObject({ kind: expected, snapshot: final });
    expect(f.store.data).toEqual(before); expect(f.store.writes).toEqual([]);
    expect(active(f.store).ledger).toEqual(final.ledger); expect(active(f.store).supply).toEqual(final.supply);
    expect(final.supply.log[0]).toHaveProperty('itemLabels.items.P', { name: '架空部品P', code: 'P' });
  });

  test.each(['unstarted', 'partial1', 'unknown1', 'unknown2'] satisfies Interruption[])('schema9 tree/%sから未保存単位だけ復旧し、旧pinと当時表示・業務数量を保持する', mode => {
    const f = treeFixture();
    const saved = mode === 'unstarted' ? 0 : mode === 'unknown2' ? 2 : 1;
    if (mode === 'unstarted') f.store.failBeforeSlot = true;
    else if (mode === 'partial1') faults.failMidwayAt = 2;
    else f.store.loseAtHead = saved;
    let result;
    try { result = commit(f.store, f.current, f.op, f.units); }
    finally { f.store.loseAtHead = null; f.store.failBeforeSlot = false; f.store.failNextHeadRead = false; faults.failMidwayAt = null; faults.loseResponseAt = null; }
    expect(result.kind).toBe(mode === 'partial1' ? 'partial' : 'unknown');
    const original = new Map(f.store.data); f.store.writes.length = 0;
    const read = loaded(f.store), p = read.pending!;
    expect(p.units).toEqual(f.units); expect(inquire(f.store, p)).toEqual({ snapshot: read.snapshot, savedUnits: saved, total: 2 });
    expect(f.store.data).toEqual(original); expect(f.store.writes).toEqual([]);
    const recovered = retry(f.store, read.snapshot, p, '架空確認者B', later);
    expect(recovered.kind).toBe(mode === 'unknown2' ? 'recovered' : 'saved');
    if (recovered.kind !== 'saved' && recovered.kind !== 'recovered') throw new Error('組立の残り保存か保存済み確認が必要');
    const final = recovered.snapshot;
    expect(final.ledger).toEqual(f.last.ledger); expect(final.supply).toEqual(f.last.supply);
    expect(final.revision).toBe(mode === 'unknown2' ? 3 : 2);
    expect(f.store.writes.filter(key => key.includes('/slot-'))).toHaveLength(mode === 'unknown2' ? 1 : 2 - saved);
    expect(final.ops.op30!.units).toEqual(f.ids);
    expect(final.saveChecks).toEqual(mode === 'partial1' ? [] : [{ opId: 'op30', opLabel: f.op.opLabel, attempt: attemptOf(p), openedAt: at,
      savedTargets: [...new Set(f.units.flatMap(unit => unit.targets))], unsavedTargets: [], resolution: { outcome: mode === 'unknown2' ? 'saved' : 'retried', actor: '架空確認者B', at: later } }]);
    expect(Object.values(final.ledger.lots).map(lot => lot.item)).toEqual(['P', 'P', 'Q', 'P', 'X']);
    expect(Object.values(final.supply.receipts).map(receipt => receipt.received)).toEqual([20, 20, 30, 20, 7]);
    expect(Object.values(final.supply.requests)).toMatchObject([{ item: 'X', quantity: 3, vendor: '架空商社', arrivals: [] }]);
    const batches = final.supply.log.filter(event => event.kind === 'templateReceipt');
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveProperty('itemLabels.items.X', { name: '架空組立X', code: null });
    expect(batches[1]).toHaveProperty('itemLabels.items.X', { name: '架空改名後X', code: null });
    for (const batch of batches) expect(batch.template.rows[1]!.assembly).toEqual(f.child);
    expect(final.supply.receiptTemplates.child!.rows[0]!.perSet).toBe(4);
    expect(final.supply.receiptTemplates.parent!.rows[1]!.assembly).toEqual(f.child);
    expect(f.store.data.has('fuzzy-stock/pending')).toBe(false);
    const stable = new Map(f.store.data); f.store.writes.length = 0;
    expect(loaded(f.store).snapshot).toEqual(final);
    expect(readBackup(bytes(backupTextOf(final, at)))).toMatchObject({ kind: 'ok', snapshot: final });
    expect(inquire(f.store, p)).toEqual({ snapshot: final, savedUnits: 2, total: 2 });
    expect(commit(f.store, final, f.op, f.units)).toMatchObject({ kind: mode === 'partial1' ? 'duplicate' : 'recovered', snapshot: final });
    expect(f.store.data).toEqual(stable); expect(f.store.writes).toEqual([]);
  });
});

function treeFixture() {
  const ledger: typeof practiceLedger = { ...practiceLedger, masters: { ...practiceLedger.masters, items: { ...practiceLedger.masters.items,
    X: { ...practiceLedger.masters.items.R!, id: 'X', code: null, name: '架空組立X', units: ['台'], unitSteps: { 台: 1 }, trial: true },
  } } };
  const row = (item: string, unit: string, perSet: number) => ({ item, unit, perSet, location: 'S1' });
  const child: ReceiptTemplate = { id: 'child', name: '架空子構成', product: 'X', productUnit: '台', project: null, basis: 'counted', rows: [row('P', '個', 2), row('Q', '個', 3)] };
  const parent: ReceiptTemplate = { id: 'parent', name: '架空親構成', product: 'R', productUnit: '台', project: null, basis: 'label', rows: [row('P', '個', 2), { ...row('X', '台', 1), assembly: child }] };
  const supply = saveReceiptTemplate(ledger, saveReceiptTemplate(ledger, emptySupply, meta('base-child'), child), meta('base-parent'), parent);
  const current = initial(ledger, supply), store = new Memory();
  store.data.set('fuzzy-stock/head', 'A'); store.data.set('fuzzy-stock/slot-A', serialize(current));
  const project = { kind: 'case', id: 'A-001' } as const;
  const first = receiveTemplate({ ledger, supply }, meta('op30-parts'), parent.id, project, 10, [20, 20, 30].map(quantity => ({ quantity, shortfall: 0 })), null, ['assembled', 'parts']);
  const renamed = changeMasters(first.ledger, meta('op30-rename'), { action: 'rename', type: 'item', id: 'X', name: '架空改名後X', reason: '架空改名' });
  const revised = saveReceiptTemplate(renamed, first.supply, meta('op30-child'), { ...child, rows: [row('P', '個', 4), row('Q', '個', 3)] });
  const last = receiveTemplate({ ledger: renamed, supply: revised }, meta('op30-assembled'), parent.id, project, 10, [{ quantity: 20, shortfall: 0 }, { quantity: 7, shortfall: 3 }], '架空商社', ['assembled', 'assembled']);
  let before = { ledger: current.ledger, supply: current.supply };
  const ids: string[][] = [];
  const units = [first, last].map(state => {
    const targets = targetsOf(before, state);
    ids.push([...state.ledger.history.slice(before.ledger.history.length), ...state.supply.log.slice(before.supply.log.length)].map(event => event.eventId));
    before = state; return { ...state, targets, conflictReviews: [] };
  });
  return { current, store, units, last, child, ids, op: { ...operation('op30'), opLabel: '架空組立の二単位保存' } };
}
