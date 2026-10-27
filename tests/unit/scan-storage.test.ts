import { afterEach, describe, expect, it } from 'vitest';
import { readCode } from '../../src/domain/code.ts';
import { practiceLedger } from '../../src/domain/ledger.ts';
import { fixedMasters } from '../../src/domain/masters.ts';
import { emptySupply, receiveLot } from '../../src/domain/supply.ts';
import { backupTextOf, readBackup } from '../../src/ui/backup.ts';
import { decodePending } from '../../src/ui/storageparse.ts';
import { commit, faults, initial, inquire, load, parse, replace, retry, serialize, type StoreLike } from '../../src/ui/storage.ts';

const at = '2026-10-13T09:00:00+09:00';
const raw = ' \tLABA|A-001|P\t\r\n';
const scan = readCode(raw, fixedMasters);
const meta = { eventId: 'op1', occurredAt: at, recordedAt: at, actor: '架空担当A', scan };
const received = () => receiveLot(practiceLedger, emptySupply, meta, { id: 'box', item: 'P', unit: '個', project: { kind: 'case', id: 'A-001' }, location: 'S1' }, 'label', 5);
const snapshot = () => { const state = received(); return initial(state.ledger, state.supply); };
const storeOf = () => {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } } satisfies StoreLike & { data: Map<string, string> };
};

afterEach(() => { faults.loseResponseAt = null; faults.failMidwayAt = null; });

describe('FH-C04 読取証拠の保存', () => {
  it('現行版12に書き、台帳/供給/バックアップを原文のまま往復する', () => {
    const original = snapshot();
    expect(original.version).toBe(12);
    const decoded = parse(serialize(original));
    expect(decoded.ledger.history[0]?.scan).toEqual(scan);
    expect(decoded.supply.log[0]?.scan).toEqual(scan);
    const backup = readBackup(new TextEncoder().encode(backupTextOf(original, at)));
    expect(backup.kind).toBe('ok');
    if (backup.kind === 'ok') expect(backup.snapshot).toEqual(decoded);
  });
  it.each([1, 2, 3])('scanなし版%dを読み数量・履歴を変えない', version => {
    const old = { ...initial(practiceLedger, emptySupply), version };
    const decoded = parse(JSON.stringify(old, (key, value: unknown) => (key === 'consumable' || key === 'processes' || key === 'nextProcess') || key === 'unitSteps' || key === 'conflictReviews' || key === 'receiptTemplates' ? undefined : value));
    expect(decoded.version).toBe(12);
    expect(decoded.ledger).toEqual({ ...practiceLedger, masters: fixedMasters });
    expect(decoded.supply).toEqual(emptySupply);
  });
  it.each([null, {}, { ...scan, raw: 'different' }, { ...scan, format: 'future' }, { ...scan, extra: 'must not disappear' }])('不正な証拠%jを捨てて成功にしない', invalid => {
    const original = snapshot();
    const bad = { ...original, ledger: { ...original.ledger, history: original.ledger.history.map(e => ({ ...e, scan: invalid })) } };
    const text = JSON.stringify(bad);
    expect(() => parse(text)).toThrow(/scan/);
    const store = storeOf(); store.data.set('fuzzy-stock/head', 'A'); store.data.set('fuzzy-stock/slot-A', text);
    const before = [...store.data];
    expect(load(store).kind).toBe('unreadable');
    expect([...store.data]).toEqual(before);
  });
  it.each([1, 2])('保存不明（保存済み%d単位）の照会・再試行でも証拠と数量を変えない', saved => {
    const store = storeOf(); const current = replace(store, null, { ledger: practiceLedger, supply: emptySupply });
    const write = store.setItem;
    let heads = 0;
    store.setItem = (key, value) => {
      write(key, value);
      if (key === 'fuzzy-stock/head' && ++heads === saved) throw new Error('見出し書込後の応答喪失');
    };
    const first = received();
    const second = receiveLot(first.ledger, first.supply, { ...meta, eventId: 'op1-b' }, { id: 'box2', item: 'P', unit: '個', project: { kind: 'case', id: 'A-001' }, location: 'S1' }, 'label', 5);
    const result = commit(store, current, { opId: 'op1', opLabel: '受入', fingerprint: JSON.stringify(scan), values: { 原文: raw }, actor: meta.actor, startedAt: at, savingSince: at }, [{ conflictReviews: [], ...first, targets: ['保管単位box'] }, { conflictReviews: [], ...second, targets: ['保管単位box2'] }]);
    expect(result.kind).toBe('unknown');
    if (result.kind !== 'unknown') throw Error('不明保存が必要');
    store.setItem = write;
    const wire: unknown = JSON.parse(store.getItem('fuzzy-stock/pending') ?? 'null');
    expect(wire).toMatchObject({ format: 'fuzzy-stock-pending', version: 12 });
    expect(wire).not.toHaveProperty('progress');
    const restored = decodePending(wire);
    expect(restored.units[0]?.ledger.history[0]?.scan).toEqual(scan);
    expect(decodePending({ format: 'fuzzy-stock-pending', version: 12, pending: result.pending })).toEqual(restored);
    const checked = inquire(store, restored);
    expect(checked.savedUnits).toBe(saved);
    faults.loseResponseAt = null;
    expect(retry(store, checked.snapshot, restored, meta.actor, at).kind).toBe(saved === 1 ? 'saved' : 'recovered');
    const loaded = load(store);
    expect(loaded.kind).toBe('ok');
    if (loaded.kind === 'ok') {
      expect(loaded.snapshot.ledger.history).toHaveLength(2);
      expect(loaded.snapshot.ledger.history[0]?.scan).toEqual(scan);
      expect(loaded.snapshot.supply.receipts.box?.received).toBe(5);
      expect(loaded.snapshot.supply.receipts.box2?.received).toBe(5);
    }
  });
});
