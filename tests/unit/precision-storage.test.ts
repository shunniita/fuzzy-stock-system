import { afterEach, describe, expect, test } from 'vitest';
import { beginRework, changeMasters, changeStage, practiceLedger as practiceBase, recordProvisional, recordReworkPart, recordStop, recount, register, start, updateStop, use, type Ledger, type Meta, type NewMaster } from '../../src/domain/ledger.ts';
import { withProcesses } from './process-fixture.ts';
const practiceLedger = withProcesses(practiceBase, { id: '架空工程', criterion: 'workEnd' });
import * as masters from '../../src/domain/masters.ts';
import { applyNeedImport, previewNeedImport } from '../../src/domain/need-import.ts';
import type { Quantity } from '../../src/domain/quantity.ts';
import type { Step } from '../../src/domain/scalar.ts';
import { allocateArrival, declareShortage, emptySupply, receiveLot, recordRequest, registerNeed, reviseArrival, reviseNeed, reviseReceipt, type Supply } from '../../src/domain/supply.ts';
import { backupTextOf, crc32, readBackup } from '../../src/ui/backup.ts';
import { abandon, commit, faults, initial, inquire, load, parse, retry, serialize, type Snapshot, type StoreLike } from '../../src/ui/storage.ts';
import { decodePending } from '../../src/ui/storageparse.ts';
import { legacyPrecisionCases } from '../fixtures/precision-legacy/cases.ts';

const at = '2026-10-14T10:00:00+09:00';
const meta = (eventId: string): Meta => ({ eventId, occurredAt: at, recordedAt: at, actor: '架空担当A' });
const item = (unitSteps: Record<string, number> = { 個: 1, kg: 0.1 }): Extract<NewMaster, { type: 'item' }> =>
  ({ type: 'item', code: 'D', name: '架空小数部品', units: ['個', 'kg'], unitSteps: unitSteps as Record<string, Step>, trial: true, source: null });
const registered = (): Ledger => changeMasters(practiceLedger, meta('op1'), { action: 'register', master: item() });
const stepOf = (itemId: string, unit: string): number =>
  masters.quantityStepOf(registered().masters, itemId, unit);
const wire = (): string => serialize(initial(registered(), emptySupply));
type RawItem = { unitSteps?: Record<string, number>; units: string[] };
type RawLedger = { masters: { items: Record<string, RawItem> }; history: { kind: string; masters?: { before: RawItem | null; after: RawItem }[] }[] };
type RawSnapshot = { version: number; ledger: RawLedger };
const raw = (): RawSnapshot => JSON.parse(wire());
const storeOf = () => {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } } satisfies StoreLike & { data: Map<string, string> };
};
function backup(wire: string): Uint8Array {
  const bytes = new TextEncoder();
  return bytes.encode(JSON.stringify({ notice: '架空試験', format: 'fuzzy-stock-backup', version: 1, createdAt: at, snapshot: wire, crc32: crc32(bytes.encode(`${at}\n${wire}`)).toString(16).padStart(8, '0') }));
}
function reject(wire: string): void {
  expect(() => parse(wire)).toThrow();
  expect(readBackup(backup(wire)).kind).toBe('unreadable');
  const store = storeOf(); store.data.set('fuzzy-stock/head', 'A'); store.data.set('fuzzy-stock/slot-A', wire);
  const before = [...store.data]; expect(load(store).kind).toBe('unreadable'); expect([...store.data]).toEqual(before);
}
function partial() {
  const first = registered();
  const second = changeMasters(first, meta('op2'), { action: 'rename', type: 'item', id: 'D', name: '架空改名', reason: '試験' });
  const store = storeOf(), current = initial(practiceLedger, emptySupply);
  store.data.set('fuzzy-stock/head', 'A'); store.data.set('fuzzy-stock/slot-A', serialize(current));
  faults.failMidwayAt = 2;
  const result = commit(store, current, { opId: 'op3', opLabel: '二単位登録', fingerprint: '原入力', values: { 数量: '007\r\n' }, actor: '架空担当A', startedAt: at, savingSince: at },
    [{ conflictReviews: [], ledger: first, supply: emptySupply, targets: ['D'] }, { conflictReviews: [], ledger: second, supply: emptySupply, targets: ['D'] }]);
  if (result.kind !== 'partial') throw Error(`部分保存にならない: ${result.kind}`);
  return { store, result };
}
afterEach(() => { faults.failMidwayAt = null; faults.loseResponseAt = null; });

describe('Task2: 登録情報精度の不変契約と版5', () => {
  test('複数単位を明示登録し、現在と登録履歴へ凍結する', () => {
    const ledger = registered();
    expect(ledger.masters.items['D']?.unitSteps).toEqual({ 個: 1, kg: 0.1 });
    expect(Object.isFrozen(ledger.masters.items['D']?.unitSteps)).toBe(true);
    expect(ledger.history[0]).toMatchObject({ masters: [{ after: { unitSteps: { 個: 1, kg: 0.1 } } }] });
    expect(stepOf('D', 'kg')).toBe(0.1); expect(stepOf('D', '個')).toBe(1);
    expect(stepOf('unknown', 'kg')).toBe(1); expect(stepOf('D', 'unknown')).toBe(1);
    expect(stepOf('constructor', 'kg')).toBe(1);
  });
  test.each([{}, { 個: 1 }, { 個: 1, kg: 0.05 }, { 個: 1, kg: 0.1, extra: 1 }])('単位キー・許容精度の不正を登録前に拒否 %j', unitSteps => {
    expect(() => changeMasters(practiceLedger, meta('op1'), { action: 'register', master: item(unitSteps) })).toThrow();
    expect(practiceLedger.history).toHaveLength(0);
  });
  test('特殊な単位名も自前の精度欄として扱い、登録入力を共有しない', () => {
    const units = ['__proto__', 'constructor'];
    const unitSteps: Record<string, Step> = Object.fromEntries(units.map(unit => [unit, 0.1 as const]));
    const ledger = changeMasters(practiceLedger, meta('op1'), { action: 'register', master: { ...item(), type: 'item', units, unitSteps } });
    unitSteps['constructor'] = 1;
    expect(masters.quantityStepOf(ledger.masters, 'D', '__proto__')).toBe(0.1);
    expect(masters.quantityStepOf(ledger.masters, 'D', 'constructor')).toBe(0.1);
    const snapshot = initial(ledger, emptySupply); expect(parse(serialize(snapshot))).toEqual(snapshot);
  });
  test('登録情報名・コード・中断・試行変更を経ても同じ精度', () => {
    let ledger = registered();
    ledger = changeMasters(ledger, meta('op2'), { action: 'rename', type: 'item', id: 'D', name: '改名', reason: '試験' });
    ledger = changeMasters(ledger, meta('op3'), { action: 'code', type: 'item', id: 'D', code: '007', reason: '試験' });
    ledger = changeMasters(ledger, meta('op4'), { action: 'deactivate', type: 'item', id: 'D', reason: '試験' });
    ledger = changeMasters(ledger, meta('op5'), { action: 'trial', type: 'item', id: 'D', trial: false, review: null, reason: '試験' });
    const s = initial(ledger, emptySupply); expect(parse(serialize(s))).toEqual(s);
    expect(s.ledger.masters.items['D']?.unitSteps).toEqual({ 個: 1, kg: 0.1 });
  });
  test('版5往復・backup外版1を保ち、小数数量も保存へ通す', () => {
    const s = initial(registered(), emptySupply);
    expect(JSON.parse(serialize(s)).version).toBe(12); expect(parse(serialize(s))).toEqual(s);
    const text = backupTextOf(s, at), outer = JSON.parse(text);
    expect(outer.version).toBe(1); expect(JSON.parse(outer.snapshot).version).toBe(12);
    const read = readBackup(new TextEncoder().encode(text)); expect(read.kind).toBe('ok');
    if (read.kind === 'ok') expect(read.snapshot).toEqual(s);
    const decimal = initial(register(s.ledger, meta('op2'), { id: 'fraction', item: 'D', unit: 'kg', location: 'S1', project: { kind: 'common' } }, 'counted', 0.1), emptySupply);
    expect(parse(serialize(decimal))).toEqual(decimal);
  });
  for (const place of ['current', 'history'] as const) for (const bad of [undefined, {}, { 個: 1, kg: 0.05 }, { 個: 1, kg: 0.1, extra: 1 }]) {
    test(`版5 ${place}の精度欠落/改変を無変更拒否: ${JSON.stringify(bad)}`, () => {
      const value = raw(), target = place === 'current' ? value.ledger.masters.items['D']! : value.ledger.history[0]!.masters![0]!.after;
      if (bad === undefined) delete target.unitSteps; else target.unitSteps = bad;
      reject(JSON.stringify(value));
    });
  }
  test('許容値であっても同一IDの歴史的精度との不一致を拒否', () => {
    const value = raw(); value.ledger.masters.items['D']!.unitSteps = { 個: 1, kg: 1 }; reject(JSON.stringify(value));
  });
  test('同一IDの歴史的単位の差を拒否', () => {
    const value = raw(); value.ledger.masters.items['D']!.units = ['個']; value.ledger.masters.items['D']!.unitSteps = { 個: 1 }; reject(JSON.stringify(value));
  });
  test('精度の丸め原文をsnapshotとCRC正しいbackupでも拒否', () => {
    reject(wire().replaceAll('"kg":0.1', '"kg":0.10000000000000001'));
    reject(wire().replaceAll('"個":1', '"個":1.0000000000000001'));
    reject(wire().replace('"version":12', '"version":12.000000000000001'));
  });
});

describe('Task2: 旧原文と全pending単位', () => {
  for (const c of legacyPrecisionCases.filter(c => c.kind !== 'backup')) test(`${c.id}: 精度1補完は現在/歴史/全pending単位だけに行い原入力は不変`, () => {
    const input = JSON.parse(c.wire), before = JSON.stringify(input);
    const ledgers = c.kind === 'snapshot' ? [parse(c.wire).ledger] : decodePending(input).units.map(u => u.ledger);
    for (const ledger of ledgers) {
      for (const m of Object.values(ledger.masters.items)) expect(m.unitSteps).toEqual(Object.fromEntries(m.units.map(u => [u, 1])));
      for (const e of ledger.history) if (e.kind === 'master') for (const pair of e.masters) for (const m of [pair.before, pair.after]) if (m?.type === 'item') expect(m.unitSteps).toEqual(Object.fromEntries(m.units.map(u => [u, 1])));
    }
    expect(JSON.stringify(input)).toBe(before);
  });
  test('旧版で新精度属性を黙って捨てない', () => {
    const c = legacyPrecisionCases.find(c => c.id === 'snapshot-v3')!;
    const value = JSON.parse(c.wire) as RawSnapshot; value.ledger.masters.items['P']!.unitSteps = { 個: 0.1 }; reject(JSON.stringify(value));
  });
  test('版5pendingの二単位と整数数量・原入力を再読込/照会/再送で一回だけ保存', () => {
    const { store, result } = partial();
    const input = JSON.parse(store.getItem('fuzzy-stock/pending')!);
    expect(input.version).toBe(12);
    const decoded = decodePending(input); expect(decoded.units.map(u => u.ledger.masters.items['D']?.unitSteps)).toEqual([{ 個: 1, kg: 0.1 }, { 個: 1, kg: 0.1 }]);
    expect(inquire(store, decoded).savedUnits).toBe(1);
    expect(retry(store, result.snapshot, decoded, '架空担当A', at).kind).toBe('saved');
    const read = load(store); expect(read.kind).toBe('ok');
    if (read.kind === 'ok') { expect(read.pending).toBeNull(); expect(read.snapshot.ledger.history.map(e => e.eventId)).toEqual(['op1', 'op2']); expect(read.snapshot.version).toBe(12); }
  });
  for (const index of [0, 1]) test(`版5pending単位${index + 1}の欠落を拒否し保存を維持`, () => {
    const { store } = partial(), input = JSON.parse(store.getItem('fuzzy-stock/pending')!);
    delete input.pending.units[index].ledger.masters.items.D.unitSteps;
    const text = JSON.stringify(input); store.data.set('fuzzy-stock/pending', text); const before = [...store.data];
    expect(() => decodePending(input)).toThrow(); expect(load(store).kind).toBe('unreadable'); expect([...store.data]).toEqual(before);
  });
  test('pendingの原文精度改変を丸めず拒否', () => {
    const { store } = partial(); store.data.set('fuzzy-stock/pending', store.getItem('fuzzy-stock/pending')!.replaceAll('"kg":0.1', '"kg":0.10000000000000001'));
    const before = [...store.data]; expect(load(store).kind).toBe('unreadable'); expect([...store.data]).toEqual(before);
  });
});


describe('Task2: 精度変更の保存境界と応答喪失', () => {
  test('登録情報履歴のない既存品目も現在→保存候補で精度を変更できない', () => {
    const store = storeOf(), current = initial(practiceLedger, emptySupply);
    store.data.set('fuzzy-stock/head', 'A'); store.data.set('fuzzy-stock/slot-A', serialize(current));
    const candidate = register(practiceLedger, meta('op1'), { id: 'x', item: 'P', unit: '個', location: 'S1', project: { kind: 'common' } }, 'counted', 1);
    const changed = { ...candidate, masters: { ...candidate.masters, items: { ...candidate.masters.items, P: { ...candidate.masters.items.P!, unitSteps: { 個: 0.1 as const } } } } };
    const before = [...store.data];
    const result = commit(store, current, { opId: 'op2', opLabel: '改変', fingerprint: 'f', values: {}, actor: '架空担当A', startedAt: at, savingSince: at }, [{ conflictReviews: [], ledger: changed, supply: emptySupply, targets: ['x'] }]);
    expect(result.kind).toBe('failed'); expect([...store.data]).toEqual(before);
  });
  test('各pending単位が単独では正しくても、単位間の精度差を拒否', () => {
    const { store } = partial(), input = JSON.parse(store.getItem('fuzzy-stock/pending')!);
    input.pending.units[1].ledger.masters.items.P.unitSteps = { 個: 0.1 };
    expect(() => decodePending(input)).toThrow('変更できない');
  });
  test('pending内では同じ改変でもheadとの精度差を読取/照会/再送で拒否', () => {
    const { store, result } = partial(), input = JSON.parse(store.getItem('fuzzy-stock/pending')!);
    for (const unit of input.pending.units) unit.ledger.masters.items.P.unitSteps = { 個: 0.1 };
    const pending = decodePending(input); store.data.set('fuzzy-stock/pending', JSON.stringify(input)); const before = [...store.data];
    expect(load(store).kind).toBe('unreadable'); expect(() => inquire(store, pending)).toThrow('変更できない');
    expect(retry(store, result.snapshot, pending, '架空担当A', at).kind).toBe('conflict'); expect([...store.data]).toEqual(before);
  });
  test('pendingで一度欠けて再出現したIDも最初の精度を保つ', () => {
    const { store } = partial(), input = JSON.parse(store.getItem('fuzzy-stock/pending')!);
    const last = structuredClone(input.pending.units[1]);
    delete input.pending.units[1].ledger.masters.items.P;
    last.ledger.masters.items.P.unitSteps = { 個: 0.1 };
    input.pending.units.push(last);
    expect(() => decodePending(input)).toThrow('変更できない');
  });
  test('最初の候補で品番・コードを欠いても後の候補の精度変更を無書込み拒否', () => {
    const store = storeOf(), current = initial(practiceLedger, emptySupply);
    store.data.set('fuzzy-stock/head', 'A'); store.data.set('fuzzy-stock/slot-A', serialize(current));
    const first = register(practiceLedger, meta('op1'), { id: 'x', item: 'P', unit: '個', location: 'S1', project: { kind: 'common' } }, 'counted', 1);
    const items = { ...first.masters.items }; delete items['P'];
    const absent = { ...first, masters: { ...first.masters, items } };
    const second = register(first, meta('op2'), { id: 'y', item: 'P', unit: '個', location: 'S1', project: { kind: 'common' } }, 'counted', 1);
    const changed = { ...second, masters: { ...second.masters, items: { ...second.masters.items, P: { ...second.masters.items.P!, unitSteps: { 個: 0.1 as const } } } } };
    const before = [...store.data];
    const result = commit(store, current, { opId: 'op3', opLabel: '改変', fingerprint: 'f', values: {}, actor: '架空担当A', startedAt: at, savingSince: at }, [{ conflictReviews: [], ledger: absent, supply: emptySupply, targets: ['x'] }, { conflictReviews: [], ledger: changed, supply: emptySupply, targets: ['y'] }]);
    expect(result.kind).toBe('failed'); expect([...store.data]).toEqual(before);
  });
  test('版5pendingでmastersを欠いた単位を旧扱いにしない', () => {
    const { store } = partial(), input = JSON.parse(store.getItem('fuzzy-stock/pending')!);
    delete input.pending.units[1].ledger.masters; expect(() => decodePending(input)).toThrow('masters');
  });
  test('旧版trial履歴afterへ精度属性を追加しても旧補完で隠さない', () => {
    const c = legacyPrecisionCases.find(c => c.id === 'snapshot-v4')!;
    const value = JSON.parse(c.wire) as RawSnapshot;
    value.ledger.history.find(e => e.kind === 'master')!.masters![0]!.after.unitSteps = { 個: 1 };
    reject(JSON.stringify(value));
  });
  test.each([1, 2])('保存済み%d単位で応答を失っても同じ精度を一回だけ確定', saved => {
    const first = registered(), second = changeMasters(first, meta('op2'), { action: 'rename', type: 'item', id: 'D', name: '改名', reason: '試験' });
    const store = storeOf(), current = initial(practiceLedger, emptySupply);
    store.data.set('fuzzy-stock/head', 'A'); store.data.set('fuzzy-stock/slot-A', serialize(current));
    const write = store.setItem; let heads = 0;
    store.setItem = (key, value) => { write(key, value); if (key === 'fuzzy-stock/head' && ++heads === saved) throw Error('応答喪失'); };
    const result = commit(store, current, { opId: 'op3', opLabel: '登録', fingerprint: 'f', values: { 原文: '007\r\n' }, actor: '架空担当A', startedAt: at, savingSince: at }, [{ conflictReviews: [], ledger: first, supply: emptySupply, targets: ['D'] }, { conflictReviews: [], ledger: second, supply: emptySupply, targets: ['D'] }]);
    expect(result.kind).toBe('unknown'); if (result.kind !== 'unknown') throw Error('不明保存が必要');
    store.setItem = write;
    const loaded = load(store); if (loaded.kind !== 'ok' || loaded.pending === null) throw Error('照会の証拠が必要');
    expect(loaded.pending.values).toEqual({ 原文: '007\r\n' });
    expect(inquire(store, loaded.pending).savedUnits).toBe(saved);
    expect(retry(store, loaded.snapshot, loaded.pending, '架空担当A', at).kind).toBe(saved === 1 ? 'saved' : 'recovered');
    const final = load(store); if (final.kind !== 'ok') throw Error('再読込が必要');
    expect(final.pending).toBeNull(); expect(final.snapshot.ledger.history.map(e => e.eventId)).toEqual(['op1', 'op2']);
    expect(final.snapshot.ledger.masters.items.D?.unitSteps).toEqual({ 個: 1, kg: 0.1 });
  });
});

describe('Task5: 保存と履歴の全数量を精度文脈に照合する', () => {
  const project = { kind: 'case', id: 'A-001' } as const;
  const lotOf = (id: string, unit = 'kg') => ({ id, item: 'D', unit, location: 'S1', project });
  const need = (value: number, unit = 'kg', item = 'D') => ({ project, item, unit, required: { basis: 'counted' as const, value }, dueDate: null, source: '架空必要一覧', revision: '初版' });
  const big = 562949953421312;
  const known = (id: string, value: number, observed = value): Quantity =>
    ({ kind: 'known', numeric: { value, approximate: false, unconfirmed: 'none' }, computed: false, terms: [{ sign: 1, observation: { id, basis: 'counted', value: observed } }] });
  function decimalState(): Snapshot {
    let l = register(registered(), meta('r1'), lotOf('x'), 'counted', 1);
    l = use(l, meta('u1'), 'x', 'counted', 0.9, '架空使用', 'notIncluded');
    l = recount(l, meta('c1'), 'x', 0, { kind: 'unknown' }, 'notIncluded');
    l = register(l, meta('r2'), lotOf('n', '個'), 'counted', 2);
    l = recordProvisional(l, meta('p1'), { direction: 'found', item: 'D', location: 'S1', basis: 'counted', value: 1, note: '単位なし' });
    let s: Supply = registerNeed(emptySupply, l.masters, meta('n1'), need(1));
    s = recordRequest(s, l.masters, meta('q1'), { project, item: 'D', unit: 'kg', quantity: 0.3, vendor: '架空仕入先', requestedOn: '2026-10-14', reply: { kind: 'none' } });
    const got = receiveLot(l, s, meta('rc1'), lotOf('rc'), 'counted', 0.2);
    s = allocateArrival(got.ledger, got.supply, meta('a1'), 'q1', { receiptLotId: 'rc', arrived: 0.2, good: 0.1 });
    s = declareShortage(s, l.masters, meta('d1'), { project, item: 'D', unit: 'kg', value: 0.1, reason: '架空不足' });
    l = recordStop(got.ledger, meta('st1'), { process: '架空工程', item: 'D', unit: 'kg', project, reason: '架空停止', affected: null, shortage: { item: 'D', unit: 'kg', value: 0.1 } });
    return initial(l, s);
  }
  type Loose = Record<string, unknown>;
  const event = (s: Snapshot, id: string): Loose => s.ledger.history.find(e => e.eventId === id) as unknown as Loose;
  const log = (s: Snapshot, id: string): Loose => s.supply.log.find(e => e.eventId === id) as unknown as Loose;
  type Mutable = { ledger: { lots: Record<string, Loose>; stops: Record<string, Loose>; history: { eventId: string; changes: { after: Loose }[] }[] }; supply: Record<string, Record<string, Loose>> };

  test('小数・負の差・減算termsをsnapshot/backup/保存先で往復し同じ値を保つ', () => {
    const s = decimalState();
    expect(event(s, 'c1').difference).toMatchObject({ numeric: { value: -0.1 } });
    expect(s.ledger.history.find(e => e.eventId === 'u1')?.changes[0]?.after.quantity.terms).toContainEqual({ sign: -1, observation: { id: 'u1', basis: 'counted', value: 0.9 } });
    expect(s.supply.requests.q1?.arrivals[0]).toMatchObject({ arrived: 0.2, good: 0.1 });
    expect(parse(serialize(s))).toEqual(s);
    const read = readBackup(new TextEncoder().encode(backupTextOf(s, at))); expect(read.kind).toBe('ok');
    if (read.kind === 'ok') expect(read.snapshot).toEqual(s);
    const store = storeOf(); store.data.set('fuzzy-stock/head', 'A'); store.data.set('fuzzy-stock/slot-A', serialize(s));
    const loaded = load(store); expect(loaded.kind).toBe('ok'); if (loaded.kind === 'ok') expect(loaded.snapshot).toEqual(s);
  });

  test('同じ数量参照を整数単位からも指す共有は、先に小数精度で検査済みでも拒否', () => {
    const value = JSON.parse(serialize(decimalState()));
    expect(typeof value.ledger.lots.x.quantity).toBe('number');
    // 整数値の数量は小数単位からの共有でも意味が変わらないので受理する。
    const shared = structuredClone(value); shared.ledger.lots.rc.quantity = value.ledger.lots.n.quantity;
    expect(parse(JSON.stringify(shared)).ledger.lots.rc?.quantity).toEqual(decimalState().ledger.lots.n?.quantity);
    // 現在lotは x→n の順に検査されるので、小数単位で検査済みの参照を整数単位から指す。
    value.ledger.lots.n.quantity = value.ledger.lots.x.quantity;
    reject(JSON.stringify(value));
  });

  const tampers: [string, (s: Mutable) => void][] = [
    ['現在lotの2^49', s => { s.ledger.lots.x!.quantity = known('t', big); }],
    ['整数単位lotの0.1', s => { s.ledger.lots.n!.quantity = known('t', 0.1); }],
    ['負の観測', s => { s.ledger.lots.x!.quantity = known('t', 0.1, -0.1); }],
    ['不明の直前値', s => { s.ledger.lots.n!.quantity = { kind: 'unknown', before: known('t', 0.1), terms: [] }; }],
    ['履歴changesのafter', s => { s.ledger.history.find(e => e.eventId === 'r2')!.changes[0]!.after.quantity = known('t', 0.1); }],
    ['数え直しの差', s => { event(s as unknown as Snapshot, 'c1').difference = known('t', big); }],
    ['数え直しの値', s => { event(s as unknown as Snapshot, 'c1').value = big; }],
    ['最終数え直し', s => { s.ledger.lots.x!.lastCount = { value: big, eventId: 'c1' }; }],
    ['使用の値', s => { event(s as unknown as Snapshot, 'u1').value = big; }],
    ['単位なし仮の記録', s => { event(s as unknown as Snapshot, 'p1').value = 0.1; }],
    ['中断の影響数', s => { s.ledger.stops.st1!.affected = big; }],
    ['中断の不足材料', s => { (event(s as unknown as Snapshot, 'st1').stop as Loose).shortage = { item: 'D', unit: '個', value: 0.1 }; }],
    ['必要明細', s => { s.supply.needs!.n1!.required = { basis: 'counted', value: big }; }],
    ['必要明細の履歴', s => { log(s as unknown as Snapshot, 'n1').need = { ...need(0.1, '個'), id: 'n1' }; }],
    ['未知品目の小数', s => { s.supply.needs!.n1!.item = 'ZZ'; s.supply.needs!.n1!.required = { basis: 'counted', value: 0.1 }; log(s as unknown as Snapshot, 'n1').need = s.supply.needs!.n1; }],
    ['依頼数', s => { s.supply.requests!.q1!.quantity = big; }],
    ['依頼の履歴', s => { (log(s as unknown as Snapshot, 'q1').request as Loose).quantity = big; }],
    ['届いた数', s => { ((s.supply.requests!.q1!.arrivals as Loose[])[0]!).arrived = big; }],
    ['到着の履歴', s => { (log(s as unknown as Snapshot, 'a1').arrival as Loose).good = big; }],
    ['実受け取り', s => { s.supply.receipts!.rc!.received = big; }],
    ['実受け取りの履歴', s => { log(s as unknown as Snapshot, 'rc1-c').received = big; }],
    ['申告', s => { s.supply.declarations!.d1!.value = big; }],
    ['申告の履歴', s => { (log(s as unknown as Snapshot, 'd1').declaration as Loose).unit = '個'; }],
  ];
  test.each(tampers)('保存候補の改変を無変更で拒否: %s', (_name, tamper) => {
    const s = structuredClone(decimalState());
    tamper(s as unknown as Mutable);
    reject(serialize(s));
  });

  test('版4へ落とした小数の候補を整数として開かない', () => {
    const value = JSON.parse(serialize(decimalState()), (key, entry: unknown) => (key === 'consumable' || key === 'processes' || key === 'nextProcess') ? undefined : entry);
    value.version = 4;
    delete value.ledger.masters.items.D.unitSteps;
    for (const e of value.ledger.history) for (const pair of e.masters ?? []) { delete pair.after?.unitSteps; delete pair.before?.unitSteps; }
    reject(JSON.stringify(value));
  });

  const row = (value: number, unit = 'kg') => JSON.stringify({ format: 'fuzzy-stock-need-row', version: 1, source: '架空必要一覧', line: '1', revision: '初版', previousRevision: null, caseCode: '未登録', itemCode: 'D', unit, required: { basis: 'counted', value }, dueDate: null });
  function held(ledger = registered()): Snapshot {
    const preview = previewNeedImport(emptySupply, ledger.masters, row(0.1));
    expect(preview.decision.kind).toBe('hold');
    return initial(ledger, applyNeedImport(emptySupply, ledger.masters, meta('op2'), row(0.1), preview.token));
  }
  test('保留した取込原文の小数を往復し、品目コード変更後も当時の精度で読む', () => {
    const s = held(); expect(parse(serialize(s))).toEqual(s);
    const renamed = initial(changeMasters(s.ledger, meta('op3'), { action: 'code', type: 'item', id: 'D', code: 'D2', reason: '試験' }), s.supply);
    expect(parse(serialize(renamed))).toEqual(renamed);
  });
  test.each([['整数単位', row(0.1, '個')], ['小数上限超過', row(big)]])('保留した取込原文の%sを拒否', (_name, bad) => {
    const s = structuredClone(held());
    const input = log(s, 'op2').input as Loose;
    input.raw = bad; input.row = JSON.parse(bad);
    reject(serialize(s));
  });

  function decimalPartial() {
    const first = register(registered(), meta('r1'), lotOf('x'), 'counted', 0.3);
    const second = use(first, meta('u1'), 'x', 'counted', 0.1, '架空使用', 'notIncluded');
    const store = storeOf(), current = initial(practiceLedger, emptySupply);
    store.data.set('fuzzy-stock/head', 'A'); store.data.set('fuzzy-stock/slot-A', serialize(current));
    faults.failMidwayAt = 2;
    const result = commit(store, current, { opId: 'op3', opLabel: '小数二単位', fingerprint: '原入力', values: { 数量: '0.10' }, actor: '架空担当B', startedAt: at, savingSince: at },
      [{ conflictReviews: [], ledger: first, supply: emptySupply, targets: ['x'] }, { conflictReviews: [], ledger: second, supply: emptySupply, targets: ['x'] }]);
    if (result.kind !== 'partial') throw Error(`部分保存にならない: ${result.kind}`);
    return { store, result, current };
  }
  test('小数の部分保存を照会し、同じ候補・担当者・日時・操作IDで一回だけ再送', () => {
    const { store, result } = decimalPartial();
    const loaded = load(store); if (loaded.kind !== 'ok' || loaded.pending === null) throw Error('保存中の候補が必要');
    expect(loaded.pending).toMatchObject({ opId: 'op3', fingerprint: '原入力', values: { 数量: '0.10' }, actor: '架空担当B', startedAt: at });
    expect(loaded.pending.units.map(u => u.ledger.lots.x?.quantity)).toEqual(result.pending.units.map(u => u.ledger.lots.x?.quantity));
    expect(inquire(store, loaded.pending).savedUnits).toBe(1);
    expect(retry(store, loaded.snapshot, loaded.pending, '架空担当A', at).kind).toBe('saved');
    const final = load(store); if (final.kind !== 'ok') throw Error('再読込が必要');
    expect(final.pending).toBeNull(); expect(final.snapshot.ledger.history.map(e => e.eventId)).toEqual(['op1', 'r1', 'u1']);
    expect(final.snapshot.ledger.lots.x?.quantity).toMatchObject({ numeric: { value: 0.2 } });
    expect(final.snapshot.ops.op3?.fingerprint).toBe('原入力');
    const after = [...store.data];
    expect(retry(store, final.snapshot, loaded.pending, '架空担当A', at).kind).not.toBe('saved'); expect([...store.data]).toEqual(after);
  });
  test('別ページの古い入力からの再送は競合として無変更', () => {
    const { store, result, current } = decimalPartial(); const before = [...store.data];
    expect(retry(store, current, result.pending, '架空担当A', at).kind).toBe('conflict'); expect([...store.data]).toEqual(before);
  });
  test('pending単位の整数lotへ小数を入れた改変を読込で拒否し保存を維持', () => {
    const { store } = decimalPartial(), input = JSON.parse(store.getItem('fuzzy-stock/pending')!);
    const unit = input.pending.units[1].ledger;
    unit.lots.x.unit = '個';
    for (const e of unit.history) for (const c of e.changes) { if (c.before) c.before.unit = '個'; c.after.unit = '個'; }
    store.data.set('fuzzy-stock/pending', JSON.stringify(input)); const before = [...store.data];
    expect(() => decodePending(input)).toThrow(); expect(load(store).kind).toBe('unreadable'); expect([...store.data]).toEqual(before);
  });
  test.each([1, 2])('小数で保存済み%d単位の応答を失っても一回だけ確定', saved => {
    const first = register(registered(), meta('r1'), lotOf('x'), 'counted', 0.3), second = use(first, meta('u1'), 'x', 'counted', 0.1, '架空使用', 'notIncluded');
    const store = storeOf(), current = initial(practiceLedger, emptySupply);
    store.data.set('fuzzy-stock/head', 'A'); store.data.set('fuzzy-stock/slot-A', serialize(current));
    const write = store.setItem; let heads = 0;
    store.setItem = (key, value) => { write(key, value); if (key === 'fuzzy-stock/head' && ++heads === saved) throw Error('応答喪失'); };
    const result = commit(store, current, { opId: 'op3', opLabel: '小数', fingerprint: 'f', values: { 数量: '0.1' }, actor: '架空担当A', startedAt: at, savingSince: at }, [{ conflictReviews: [], ledger: first, supply: emptySupply, targets: ['x'] }, { conflictReviews: [], ledger: second, supply: emptySupply, targets: ['x'] }]);
    expect(result.kind).toBe('unknown');
    store.setItem = write;
    const loaded = load(store); if (loaded.kind !== 'ok' || loaded.pending === null) throw Error('照会の証拠が必要');
    expect(inquire(store, loaded.pending).savedUnits).toBe(saved);
    expect(retry(store, loaded.snapshot, loaded.pending, '架空担当A', at).kind).toBe(saved === 1 ? 'saved' : 'recovered');
    const final = load(store); if (final.kind !== 'ok') throw Error('再読込が必要');
    expect(final.pending).toBeNull(); expect(final.snapshot.ledger.history.map(e => e.eventId)).toEqual(['op1', 'r1', 'u1']);
    expect(final.snapshot.ledger.lots.x?.quantity).toMatchObject({ numeric: { value: 0.2 } });
  });
});

describe('Task5: 保存原文の各数量位置を個別に改変しても拒否する', () => {
  const project = { kind: 'case', id: 'A-001' } as const;
  const process = { id: '架空工程', criterion: 'workEnd' } as const;
  const big = 562949953421312;
  const tm = (eventId: string, minute: number): Meta => {
    const time = `2026-10-14T11:${String(minute).padStart(2, '0')}:00+09:00`;
    return { eventId, occurredAt: time, recordedAt: time, actor: '架空担当A' };
  };
  const lotOf = (id: string, unit = 'kg') => ({ id, item: 'D', unit, location: 'S1', project });
  function revisedState(): Snapshot {
    let l = register(registered(), tm('x', 1), lotOf('x'), 'counted', 1);
    l = use(l, tm('u1', 2), 'x', 'counted', 0.9, '架空使用');
    l = recount(l, tm('c1', 3), 'x', 0.1, { kind: 'unknown' });
    l = register(l, tm('n', 4), lotOf('n', '個'), 'counted', 2);
    l = start(l, tm('w', 5), lotOf('w', '個'), process, 'counted', 20, []);
    l = changeStage(l, tm('f', 6), 'w', 'f', 'counted', 20, { kind: 'awaitingHandover', process });
    l = beginRework(l, tm('rw', 7), 'f', 'repair', 'counted', 2, '修理');
    l = recordReworkPart(l, tm('discard', 8), { action: 'discard', reworkId: 'rw', subjectLotId: 'repair', item: 'D', unit: 'kg', value: 0.1, reason: '廃棄' });
    l = recordStop(l, tm('st1', 9), { process: process.id, item: 'D', unit: 'kg', project, reason: '架空停止', affected: null, shortage: { item: 'D', unit: 'kg', value: 0.1 } });
    l = updateStop(l, tm('su', 10), 'st1', 0);
    let s: Supply = registerNeed(emptySupply, l.masters, tm('n1', 11), { project, item: 'D', unit: 'kg', required: { basis: 'counted', value: 1 }, dueDate: null, source: '架空必要一覧', revision: '初版' });
    s = reviseNeed(s, l.masters, tm('nr', 12), 'n1', { required: { basis: 'counted', value: 0.5 }, dueDate: null, source: '架空必要一覧', revision: '第2版' });
    s = recordRequest(s, l.masters, tm('q1', 13), { project, item: 'D', unit: 'kg', quantity: 0.3, vendor: '架空仕入先', requestedOn: '2026-10-14', reply: { kind: 'none' } });
    const got = receiveLot(l, s, tm('rc1', 14), lotOf('rc'), 'counted', 0.2);
    l = got.ledger;
    s = allocateArrival(l, got.supply, tm('a1', 15), 'q1', { receiptLotId: 'rc', arrived: 0.2, good: 0.2 });
    s = reviseArrival(l, s, tm('ar', 16), 'q1', s.requests.q1!.arrivals[0]!.id, { arrived: 0.2, good: 0.1 });
    s = reviseReceipt(l, s, tm('rr', 17), 'rc', 0.3, '訂正');
    return initial(l, s);
  }
  type Raw = {
    ledger: { lots: Record<string, { quantity: number }>; stops: Record<string, { affected: number | null; shortage: { value: number } | null }>; history: { eventId: string; changes: { before: { quantity: number } | null }[]; [key: string]: unknown }[] };
    supply: { log: { eventId: string; [key: string]: unknown }[] };
    quantities: { items: unknown[]; terms: unknown[]; parts: unknown[] };
  };
  const event = (v: Raw, id: string) => v.ledger.history.find(e => e.eventId === id)!;
  const log = (v: Raw, id: string) => v.supply.log.find(e => e.eventId === id)!;
  const push = (list: unknown[], entry: unknown): number => list.push(entry) - 1;
  const numericOf = (value: number) => ({ value, approximate: false, unconfirmed: 'none' });
  const knownItem = (v: Raw, value: number, terms = 0): number => push(v.quantities.items, { kind: 'known', numeric: numericOf(value), computed: false, terms });
  // 並びの番号は節の位置+1。親0は空の並び。
  const termList = (v: Raw, value: number): number => push(v.quantities.terms, [0, 1, '改変', 'counted', value]) + 1;
  const partList = (v: Raw, item: number): number => push(v.quantities.parts, [0, item]) + 1;
  const partly = (v: Raw, numeric: number | null, before: number | null): number => {
    const unknown = push(v.quantities.items, { kind: 'unknown', before, terms: 0 });
    return push(v.quantities.items, { kind: 'partlyUnknown', numeric: numeric === null ? null : numericOf(numeric), unknownParts: partList(v, unknown), terms: 0 });
  };

  const tampers: [string, (v: Raw) => void][] = [
    ['整数lotの観測だけ0.1', v => { v.ledger.lots.n!.quantity = knownItem(v, 1, termList(v, 0.1)); }],
    ['整数lotの不明数量の観測0.1', v => { v.ledger.lots.n!.quantity = push(v.quantities.items, { kind: 'unknown', before: null, terms: termList(v, 0.1) }); }],
    ['小数lotの観測だけ2^49', v => { v.ledger.lots.x!.quantity = knownItem(v, 1, termList(v, big)); }],
    ['整数lotの一部不明の数値0.1', v => { v.ledger.lots.n!.quantity = partly(v, 0.1, null); }],
    ['整数lotの不明部分の直前値0.1', v => { v.ledger.lots.n!.quantity = partly(v, 1, knownItem(v, 0.1)); }],
    ['数え直しのcomparedだけ', v => { event(v, 'c1').compared = knownItem(v, big); }],
    ['履歴changesのbeforeだけ', v => { event(v, 'u1').changes[0]!.before!.quantity = knownItem(v, big); }],
    ['必要明細の改訂after', v => { (log(v, 'nr').after as { required: { value: number } }).required.value = big; }],
    ['必要明細の改訂before', v => { (log(v, 'nr').before as { required: { value: number } }).required.value = big; }],
    ['実受け取りの訂正after', v => { log(v, 'rr').after = big; }],
    ['実受け取りの訂正before', v => { log(v, 'rr').before = big; }],
    ['到着の訂正after', v => { (log(v, 'ar').after as { good: number }).good = big; }],
    ['到着の訂正before', v => { (log(v, 'ar').before as { arrived: number }).arrived = big; }],
    ['中断更新のprevious', v => { event(v, 'su').previous = big; }],
    ['中断更新のaffected', v => { event(v, 'su').affected = big; }],
    ['やり直し・修理部品廃棄の値', v => { event(v, 'discard').value = big; }],
    ['現在の中断だけ', v => { v.ledger.stops.st1!.shortage!.value = big; }],
    ['中断記録のstopだけ', v => { (event(v, 'st1').stop as { shortage: { value: number } }).shortage.value = big; }],
  ];
  test('改変前の原文は読める', () => {
    const s = revisedState(); expect(parse(serialize(s))).toEqual(s);
  });
  test.each(tampers)('原文の改変を無変更で拒否: %s', (_name, tamper) => {
    const value = JSON.parse(serialize(revisedState())) as Raw;
    tamper(value);
    reject(JSON.stringify(value));
  });

  const row = (code: string | null, value: number) => JSON.stringify({ format: 'fuzzy-stock-need-row', version: 1, source: '架空必要一覧', line: '1', revision: '初版', previousRevision: null, caseCode: '未登録', itemCode: code, unit: 'kg', required: { basis: 'counted', value }, dueDate: null });
  type CodeChange = [eventId: string, minute: number, id: string, code: string];
  const recode = (l: Ledger, changes: CodeChange[]): Ledger =>
    changes.reduce((next, [eventId, minute, id, code]) => changeMasters(next, tm(eventId, minute), { action: 'code', type: 'item', id, code, reason: '試験' }), l);
  // 保留の前の付け替えは保留時の登録情報に反映し、後の付け替えは保留の後で台帳へ足す。
  function heldState(hold: [eventId: string, minute: number], code: string | null, value: number, before: CodeChange[], after: CodeChange[]): Snapshot {
    const l = recode(registered(), before);
    const preview = previewNeedImport(emptySupply, l.masters, row(code, value));
    expect(preview.decision.kind).toBe('hold');
    const s = applyNeedImport(emptySupply, l.masters, tm(...hold), row(code, value), preview.token);
    const state = initial(recode(l, after), s);
    expect(parse(serialize(state))).toEqual(state);
    return state;
  }
  function tamperedHeld(state: Snapshot, holdId: string, code: string | null, value: number): string {
    const raw = JSON.parse(serialize(state)) as Raw;
    const input = log(raw, holdId).input as { raw: string; row: { required: { value: number } } };
    input.raw = row(code, value); input.row.required.value = value;
    return JSON.stringify(raw);
  }
  test('時計が巻き戻っても操作番号の順で保留時の持ち主を決め、後から同じコードを得た小数品目の精度を使わない', () => {
    const s = heldState(['op5', 30], 'P', 1, [], [['op6', 20, 'P', 'P9'], ['op7', 25, 'D', 'P']]);
    expect(() => previewNeedImport(emptySupply, registered().masters, row('P', 0.1))).toThrow();
    reject(tamperedHeld(s, 'op5', 'P', 0.1));
  });
  test('早い時計で記録された後の操作番号の付け替えがあっても、小数品目で保留した行を読む', () => {
    heldState(['op5', 30], 'D', 0.1, [], [['op6', 20, 'D', 'D9'], ['op7', 25, 'P', 'D']]);
  });
  test('どの品目も持たなかったコードの保留行は整数として読み、小数への改変を拒否', () => {
    reject(tamperedHeld(heldState(['op5', 1], 'ZZ', 1, [], []), 'op5', 'ZZ', 0.1));
  });
  test('保留と同じ操作番号の付け替えは前後不明として、全ての持ち主の精度に合うことを求める', () => {
    reject(tamperedHeld(heldState(['op6', 30], 'P', 1, [], [['op6-m1', 1, 'P', 'P9'], ['op6-m2', 2, 'D', 'P']]), 'op6', 'P', 0.1));
  });
  test('操作番号を持たない保留も前後不明として扱う', () => {
    reject(tamperedHeld(heldState(['imp', 30], 'P', 1, [], [['op6', 1, 'P', 'P9'], ['op7', 2, 'D', 'P']]), 'imp', 'P', 0.1));
  });
  test('保留より前の操作番号の付け替えは前として扱い、そのときの持ち主の小数精度で読む', () => {
    heldState(['op6', 1], 'P', 0.1, [['op5', 30, 'P', 'P9'], ['op5-m', 31, 'D', 'P']], []);
  });
  test('品目コードのない保留行は整数として読み、小数への改変を拒否', () => {
    reject(tamperedHeld(heldState(['op5', 1], null, 1, [], []), 'op5', null, 0.1));
  });
  const qx = { ...item(), code: 'QX', name: '架空小数部品QX', units: ['kg'], unitSteps: { kg: 0.1 as const } };
  const qxId = (l: Ledger): string => Object.values(l.masters.items).find(m => m.name === qx.name)!.id;
  function heldOn(l: Ledger, hold: [eventId: string, minute: number]): Supply {
    const preview = previewNeedImport(emptySupply, l.masters, row('QX', 1));
    expect(preview.decision.kind).toBe('hold');
    return applyNeedImport(emptySupply, l.masters, tm(...hold), row('QX', 1), preview.token);
  }
  test('コードを外した後の保留は、外された小数品目の精度を引き継がない', () => {
    let l = changeMasters(practiceLedger, tm('op1', 1), { action: 'register', master: qx });
    l = changeMasters(l, tm('op2', 2), { action: 'code', type: 'item', id: qxId(l), code: 'QX9', reason: '試験' });
    const state = initial(l, heldOn(l, ['op3', 3])); expect(parse(serialize(state))).toEqual(state);
    reject(tamperedHeld(state, 'op3', 'QX', 0.1));
  });
  test('登録前の保留は、後でそのコードを得た小数品目の精度を使わない', () => {
    const s = heldOn(practiceLedger, ['op1', 1]);
    const state = initial(changeMasters(practiceLedger, tm('op2', 2), { action: 'register', master: qx }), s);
    expect(parse(serialize(state))).toEqual(state);
    reject(tamperedHeld(state, 'op1', 'QX', 0.1));
  });
});

describe('Task5: 合計が上限を超える保存を復号で拒否する（ADR-035）', () => {
  const MAX = Number.MAX_SAFE_INTEGER;
  const tm = (eventId: string, minute: number): Meta => {
    const time = `2026-10-14T12:${String(minute).padStart(2, '0')}:00+09:00`;
    return { eventId, occurredAt: time, recordedAt: time, actor: '架空担当A' };
  };
  const request = (quantity: number, id = 'A-001') => ({ project: { kind: 'case' as const, id }, item: 'P', unit: '個', quantity, vendor: '架空仕入先', requestedOn: '2026-10-14', reply: { kind: 'none' as const } });
  const twoRequests = (l: Ledger, second = 'A-001'): Supply =>
    recordRequest(recordRequest(emptySupply, l.masters, tm('op2', 2), request(MAX)), l.masters, tm('op3', 3), request(1, second));

  test('同じ群の依頼MAXと1の写しをparse・backup復元・保存先読込で無変更拒否', () => {
    reject(serialize(initial(registered(), twoRequests(registered()))));
  });
  test('精度違反と合計超過を併せ持つ写しは精度の理由で拒否する', () => {
    const value = JSON.parse(serialize(initial(registered(), twoRequests(registered()))));
    value.supply.requests.op3.quantity = 0.1;
    expect(() => parse(JSON.stringify(value))).toThrow('精度に合わない');
    reject(JSON.stringify(value));
  });
  test('合計が上限を超える未保存のpending単位は読め、再送は書く側で拒否し、破棄で写しを読める状態に戻す', () => {
    const l = registered(), store = storeOf(), current = initial(practiceLedger, emptySupply);
    store.data.set('fuzzy-stock/head', 'A'); store.data.set('fuzzy-stock/slot-A', serialize(current));
    faults.failMidwayAt = 2;
    const first = recordRequest(emptySupply, l.masters, tm('op2', 2), request(MAX));
    const result = commit(store, current, { opId: 'op9', opLabel: '依頼二件', fingerprint: 'f', values: {}, actor: '架空担当A', startedAt: at, savingSince: at },
      [{ conflictReviews: [], ledger: l, supply: first, targets: ['op2'] }, { conflictReviews: [], ledger: l, supply: twoRequests(l, 'A-002'), targets: ['op3'] }]);
    expect(result.kind).toBe('partial');
    const input = JSON.parse(store.getItem('fuzzy-stock/pending')!);
    input.pending.units[1].supply.requests.op3.project.id = 'A-001';
    input.pending.units[1].supply.log.find((e: { eventId: string }) => e.eventId === 'op3').request.project.id = 'A-001';
    store.data.set('fuzzy-stock/pending', JSON.stringify(input)); const before = [...store.data];
    const loaded = load(store); if (loaded.kind !== 'ok' || loaded.pending === null) throw Error(`保存中の候補が必要: ${loaded.kind}`);
    expect(inquire(store, loaded.pending)).toMatchObject({ savedUnits: 1, total: 2 });
    expect(retry(store, loaded.snapshot, loaded.pending, '架空担当A', at)).toMatchObject({ kind: 'failed', reason: expect.stringContaining('上限') });
    expect([...store.data]).toEqual(before);
    expect(abandon(store, loaded.snapshot, loaded.pending, '架空担当A', at).kind).toBe('settled');
    const final = load(store); if (final.kind !== 'ok') throw Error('破棄後の写しが必要');
    expect(final.pending).toBeNull(); expect(Object.keys(final.snapshot.supply.requests)).toEqual(['op2']);
  });
  test('旧版4の固定原文に上限を超える依頼の組を足した記録も読まない', () => {
    const c = legacyPrecisionCases.find(c => c.id === 'snapshot-v4')!;
    expect(() => parse(c.wire)).not.toThrow();
    const value = JSON.parse(c.wire);
    const stored = (id: string, quantity: number) => ({ id, ...request(quantity), orderConfirmedBy: null, cancelled: null, arrivals: [] });
    value.supply.requests = { ...value.supply.requests, 'over-1': stored('over-1', MAX), 'over-2': stored('over-2', 1) };
    reject(JSON.stringify(value));
  });
  test('上限ちょうどの正しい記録は読める：MAXの保管単位、MAXの受け取りをMAXの依頼へ割り当て', () => {
    const lot = { id: 'rc', item: 'P', unit: '個', project: { kind: 'case' as const, id: 'A-001' }, location: 'S1' };
    const single = initial(register(registered(), tm('op2', 2), { ...lot, id: 'max' }, 'counted', MAX), emptySupply);
    expect(parse(serialize(single))).toEqual(single);
    const l = registered(), s = recordRequest(emptySupply, l.masters, tm('op2', 2), request(MAX));
    const got = receiveLot(l, s, tm('op3', 3), lot, 'counted', MAX);
    const allocated = initial(got.ledger, allocateArrival(got.ledger, got.supply, tm('op4', 4), 'op2', { receiptLotId: 'rc', arrived: MAX, good: MAX }));
    expect(parse(serialize(allocated))).toEqual(allocated);
  });
});
