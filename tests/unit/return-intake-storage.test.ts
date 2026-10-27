import { describe, expect, test } from 'vitest';
import { assignReturnedProvisional } from '../../src/domain/return-intake.ts';
import { practiceLedger, handOver, recordProvisional, register, type Meta } from '../../src/domain/ledger.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { backupTextOf, readBackup } from '../../src/ui/backup.ts';
import { eventText } from '../../src/ui/format.ts';
import { decodePending } from '../../src/ui/storageparse.ts';
import { commit, initial, inquire, load, parse, replace, retry, serialize, targetsOf, type StoreLike } from '../../src/ui/storage.ts';

const at = '2026-10-21T12:00:00+09:00';
const meta = (eventId: string): Meta => ({ eventId, actor: '架空担当A', occurredAt: at, recordedAt: at });
const lot = { id: 'returned', item: 'R', unit: '台', project: { kind: 'case', id: 'A-001' } as const, location: 'T' };
function original() {
  const registered = register(practiceLedger, meta('reg'), { ...lot, id: 'original' }, 'label', 20);
  const shipped = handOver(registered, meta('ship'), 'original', 'label', 2, '外');
  return recordProvisional(shipped, meta('return'), { direction: 'found', item: null, location: null, basis: 'label', value: 2, note: '戻り品／元の現物の手掛かり：original／備考：<架空>' });
}
const assigned = () => assignReturnedProvisional(original(), meta('assign'), { kind: 'notIncluded', issueId: 'return', lot, reason: '現在数量に未包含', confirmed: true });
const storeOf = () => {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } } satisfies StoreLike & { data: Map<string, string> };
};

describe('戻り割当の版7保存と再試行', () => {
  test('4.1: 数量・確認待ち・仮の記録証拠と解消がsnapshot/backupを往復する', () => {
    const snapshot = initial(assigned(), emptySupply);
    expect(snapshot.version).toBe(12);
    expect(parse(serialize(snapshot))).toEqual(snapshot);
    const backup = readBackup(new TextEncoder().encode(backupTextOf(snapshot, at)));
    expect(backup.kind).toBe('ok');
    if (backup.kind !== 'ok') throw new Error('復元成功が必要');
    expect(backup.snapshot).toEqual(snapshot);
    const origin = snapshot.ledger.history.find(e => e.eventId === 'return');
    if (!origin) throw new Error('元の仮の記録が必要');
    expect(eventText(snapshot.ledger, origin)).toContain('original');
    expect(snapshot.ledger.lots['returned']?.holds).toEqual(['usabilityCheck']);
  });
  test('4.2: 一括割当の保存後に応答喪失しても照会・再試行で二重に増えない', () => {
    const store = storeOf();
    const current = replace(store, null, { ledger: original(), supply: emptySupply });
    const state = { ledger: assigned(), supply: emptySupply };
    const write = store.setItem;
    store.setItem = (key, value) => { write(key, value); if (key === 'fuzzy-stock/head') throw new Error('保存後の応答喪失'); };
    const result = commit(store, current, { opId: 'op1', opLabel: '戻り割当', fingerprint: 'fictional', values: { 包含: '含まれていない' }, actor: '架空担当A', startedAt: at, savingSince: at }, [{ ...state, conflictReviews: [], targets: targetsOf(current, state) }]);
    expect(result.kind, JSON.stringify(result)).toBe('unknown');
    store.setItem = write;
    const pending = decodePending(JSON.parse(store.getItem('fuzzy-stock/pending') ?? 'null'));
    const checked = inquire(store, pending);
    expect(checked.savedUnits).toBe(1);
    expect(retry(store, checked.snapshot, pending, '架空担当A', at).kind).toBe('recovered');
    const loaded = load(store);
    expect(loaded.kind).toBe('ok');
    if (loaded.kind !== 'ok') throw new Error('読込成功が必要');
    expect(loaded.snapshot.ledger).toEqual(state.ledger);
    expect(loaded.snapshot.ledger.history.filter(e => e.kind === 'adopt')).toHaveLength(1);
    expect(loaded.snapshot.ledger.lots['returned']?.holds).toEqual(['usabilityCheck']);
  });
});
