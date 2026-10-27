import legacyText from '../fixtures/consumables-v10/partial.json?raw';
import { afterEach, describe, expect, test } from 'vitest';
import { changeMasters, practiceLedger, type Ledger } from '../../src/domain/ledger.ts';
import { fixedMasters } from '../../src/domain/masters.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { commit, faults, initial, load, parse, replace, retry, serialize, serializePending, type Pending, type Snapshot, type StoreLike, type UnitState } from '../../src/ui/storage.ts';
import { decodePending } from '../../src/ui/storageparse.ts';
import { backupTextOf, readBackup } from '../../src/ui/backup.ts';

const legacy: { initial: string; complete: string; data: [string, string][] } = JSON.parse(legacyText);
const raw = () => JSON.parse(serialize(initial(practiceLedger, emptySupply)));

describe('共通消耗品4.2・4.3・4.5: 保存版11と旧版', () => {
  test('練習初期値だけに架空の設定を持ち、固定の旧版補完値には足さない', () => {
    expect(practiceLedger.masters.items.S?.consumable).toEqual({ pieceUnit: '本', rule: { threshold: 3000, standardOrder: { value: 1, unit: '箱' } } });
    expect(practiceLedger.masters.items.V?.consumable).toEqual({ pieceUnit: '本', rule: null });
    expect(fixedMasters.items.S?.consumable).toBeNull();
    expect(parse(serialize(initial(practiceLedger, emptySupply)))?.ledger.masters).toEqual(practiceLedger.masters);
    expect(raw().version).toBe(11);
  });

  test('旧writerの現在と履歴は設定なしへ移行する', () => {
    for (const text of [legacy.initial, legacy.complete]) {
      const decoded = parse(text);
      expect(decoded).not.toBeNull();
      for (const item of Object.values(decoded!.ledger.masters.items)) expect(item.consumable).toBeNull();
      for (const event of decoded!.ledger.history) if (event.kind === 'master') {
        for (const pair of event.masters) for (const item of [pair.before, pair.after]) if (item?.type === 'item') expect(item.consumable).toBeNull();
      }
    }
  });

  test.each([
    { pieceUnit: '未登録', rule: null },
    { pieceUnit: '箱', rule: null },
    { pieceUnit: '本', rule: { threshold: -1, standardOrder: { value: 1, unit: '箱' } } },
    { pieceUnit: '本', rule: { threshold: 0.1, standardOrder: { value: 1, unit: '箱' } } },
    { pieceUnit: '本', rule: { threshold: 0, standardOrder: { value: 0, unit: '箱' } } },
    { pieceUnit: '本', rule: { threshold: 1, standardOrder: { value: 1, unit: '袋' } } },
    { pieceUnit: '本', rule: null, ignored: true },
  ])('不正な設定を拒否する: %j', setting => {
    const value = raw();
    value.ledger.masters.items.S.consumable = setting;
    expect(() => parse(JSON.stringify(value))).toThrow();
  });

  test('版11の必須欄欠落と旧版への新欄注入を拒否する', () => {
    const current = raw();
    delete current.ledger.masters.items.S.consumable;
    expect(() => parse(JSON.stringify(current))).toThrow();
    const old = JSON.parse(legacy.initial);
    old.ledger.masters.items.S.consumable = null;
    expect(() => parse(JSON.stringify(old))).toThrow();
  });

  test('未知の入り数は最初の境界だけで、その後に既知の値を持つ', () => {
    const value = raw();
    value.ledger.masters.items.S.packaging.perBox = [{ from: null, value: null }, { from: '2026-10-02T08:00:00+09:00', value: 10 }];
    expect(parse(JSON.stringify(value))).not.toBeNull();
    value.ledger.masters.items.S.packaging.perBox[1].value = null;
    expect(() => parse(JSON.stringify(value))).toThrow();
  });
});

class Memory implements StoreLike {
  readonly data: Map<string, string>;
  writes = 0;
  constructor(data: [string, string][] = []) { this.data = new Map(data); }
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { this.writes++; this.data.set(key, value); }
  removeItem(key: string): void { this.writes++; this.data.delete(key); }
}
const at = '2026-10-27T09:00:00+09:00';
const meta = (eventId: string) => ({ eventId, occurredAt: at, recordedAt: at, actor: '架空担当A' });
const config = { pieceUnit: '個', rule: { threshold: 0.3, standardOrder: { value: 1, unit: '袋' } } };
const operation = { opId: 'op30', opLabel: '架空の包装・補充設定', fingerprint: '設定の原文 001\r\n', values: { threshold: '0.30', reason: '架空の設定' }, actor: '架空担当A', startedAt: at, savingSince: at };
const unit = (ledger: Ledger): UnitState => ({ ledger, supply: emptySupply, conflictReviews: [], targets: ['品目D'] });
function setup() {
  const store = new Memory();
  const current = replace(store, null, parse(legacy.complete));
  const packed = changeMasters(current.ledger, meta('op30a'), { action: 'packaging', id: 'D', boxUnit: '袋', pieceUnit: '個', value: 10, reason: '包装を確認' });
  const configured = changeMasters(packed, meta('op30b'), { action: 'consumable', id: 'D', setting: config, reason: '補充基準を設定' });
  return { store, current, units: [unit(packed), unit(configured)] };
}

afterEach(() => { faults.failMidwayAt = null; faults.loseResponseAt = null; });

describe('共通消耗品4.1–4.5: 保存途中と復元', () => {
  test('旧writer固定資料の原文hashを保持する', async () => {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(legacyText));
    expect([...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('')).toBe('4617172f539aa4c59a18237271045cfc0a0eccd2060a3dfcf86ade9679e48c2b');
  });

  test('旧版の一部保存を非破壊で読み、原入力・指紋・全unitを保持して残りだけ確定する', () => {
    const store = new Memory(legacy.data), original = [...store.data];
    const loaded = load(store);
    if (loaded.kind !== 'ok' || loaded.pending === null) throw new Error('旧版の一部保存を読めない');
    expect(store.writes).toBe(0); expect([...store.data]).toEqual(original);
    const raw: { pending: Pending } = JSON.parse(store.getItem('fuzzy-stock/pending')!);
    const { units: _, ...metadata } = loaded.pending;
    const { units: __, ...rawMetadata } = raw.pending;
    expect(metadata).toEqual(rawMetadata);
    expect(loaded.pending.units).toHaveLength(2);
    for (const state of [loaded.snapshot, ...loaded.pending.units]) for (const item of Object.values(state.ledger.masters.items)) expect(item.consumable).toBeNull();
    const done = retry(store, loaded.snapshot, loaded.pending, '架空担当A', at);
    expect(done.kind).toBe('saved');
    if (done.kind !== 'saved') throw new Error('旧版の再試行に失敗');
    expect(done.snapshot.ledger).toEqual(parse(legacy.complete).ledger);
    expect(done.snapshot.ops[loaded.pending.opId]?.fingerprint).toBe(raw.pending.fingerprint);
    expect(store.getItem('fuzzy-stock/pending')).toBeNull();
    const bytes = [...store.data];
    expect(retry(store, done.snapshot, loaded.pending, '架空担当A', at).kind).toBe('conflict');
    expect(commit(store, done.snapshot, loaded.pending, loaded.pending.units).kind).toBe('duplicate');
    expect([...store.data]).toEqual(bytes);
    const again = load(store);
    if (again.kind !== 'ok') throw new Error('再読込できない');
    expect(again.snapshot.ledger.history).toHaveLength(2);
  });

  test.each(['partial', 'unknown'] as const)('%sでも設定と元入力を保ち、再試行・復元後に一度だけ履歴が残る', mode => {
    const { store, current, units } = setup();
    if (mode === 'partial') faults.failMidwayAt = 2; else faults.loseResponseAt = 1;
    expect(commit(store, current, operation, units).kind).toBe(mode);
    const loaded = load(store);
    if (loaded.kind !== 'ok' || loaded.pending === null) throw new Error('保存途中を読めない');
    expect(loaded.pending).toMatchObject(operation);
    expect(loaded.pending.units.map(state => state.ledger.masters.items.D?.consumable)).toEqual([null, config]);
    const done = retry(store, loaded.snapshot, loaded.pending, '架空担当A', at);
    expect(done.kind).toBe(mode === 'partial' ? 'saved' : 'recovered');
    if (done.kind !== 'saved' && done.kind !== 'recovered') throw new Error('再試行に失敗');
    expect(done.snapshot.ledger.history.map(event => event.eventId)).toEqual(['op1', 'op2', 'op30a', 'op30b']);
    expect(done.snapshot.supply).toEqual(current.supply);
    expect(done.snapshot.ledger.lots).toEqual(current.ledger.lots);
    const backup = readBackup(new TextEncoder().encode(backupTextOf(done.snapshot, at)));
    if (backup.kind !== 'ok') throw new Error('backupを読めない');
    expect(backup.snapshot).toEqual(done.snapshot);
    const restored = new Memory();
    replace(restored, null, backup.snapshot);
    const reloaded = load(restored);
    if (reloaded.kind !== 'ok') throw new Error('復元先を読めない');
    expect(reloaded.snapshot.ledger.masters.items.D?.consumable).toEqual(config);
    expect(reloaded.snapshot.ledger.history).toEqual(done.snapshot.ledger.history);
  });

  test.each([0, 1])('pendingの第%d単位だけの改変は読込で拒否する', index => {
    const { units } = setup();
    const pending: Pending = { ...operation, baseRevision: 0, progress: 'partial', unknownSince: null, units };
    const wire: { pending: Pending } = JSON.parse(serializePending(pending));
    wire.pending.units[index]!.ledger.masters.items.D!.consumable = { pieceUnit: '個', rule: null };
    expect(() => decodePending(wire)).toThrow('設定');
  });

  test('現在値だけの変更は保存前に拒否し、保存先を変えない', () => {
    const { store, current, units } = setup();
    const modified = structuredClone(units[0]!);
    modified.ledger.masters.items.D!.consumable = config;
    const bytes = [...store.data], writes = store.writes;
    expect(commit(store, current, operation, [modified]).kind).toBe('failed');
    expect([...store.data]).toEqual(bytes); expect(store.writes).toBe(writes);
  });

  test('履歴だけの改変もbackupの形に包んでも拒否する', () => {
    const { units } = setup();
    const snapshot: Snapshot = structuredClone(initial(units[1]!.ledger, emptySupply));
    const event = snapshot.ledger.history.at(-1);
    if (event?.kind !== 'master') throw new Error('設定履歴がない');
    const before = event.masters[0]?.before;
    if (before?.type !== 'item') throw new Error('変更前がない');
    before.consumable = config;
    expect(() => parse(serialize(snapshot))).toThrow();
    expect(readBackup(new TextEncoder().encode(backupTextOf(snapshot, at))).kind).not.toBe('ok');
  });
});
