import { describe, expect, test } from 'vitest';
import {
  changeStage, correctOccurredAt, practiceLedger as practiceBase, hold, InclusionRequired, merge, move,
  recount, register, release, split, use, voidRecord, type Ledger, type Meta,
} from '../../src/domain/ledger.ts';
import { withProcesses } from './process-fixture.ts';
const practiceLedger = withProcesses(practiceBase, { id: '架空組立', criterion: 'inspection' });
import { emptySupply } from '../../src/domain/supply.ts';
import { commit, fingerprintOf, initial, load, parse, replace, serialize } from '../../src/ui/storage.ts';

const lot = { id: 'X', item: 'P', unit: '個', project: { kind: 'case', id: 'A-001' } as const, location: 'S1' };
const process = { id: '架空組立', criterion: 'inspection' } as const;
const cause = { kind: 'unknown' } as const;
const meta = (eventId: string, hour: number): Meta => ({
  eventId, occurredAt: `2026-10-05T${String(hour).padStart(2, '0')}:00:00+09:00`,
  recordedAt: '2026-10-05T15:00:00+09:00', actor: '架空担当A',
});
const counted = () => register(practiceLedger, meta('op1', 8), lot, 'counted', 100);
const used = () => use(counted(), meta('op2', 9), 'X', 'counted', 10, '架空作業');

class MemoryStore {
  private data = new Map<string, string>();
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { this.data.set(key, value); }
  removeItem(key: string): void { this.data.delete(key); }
}

// commitの戻り値もdecodePendingを通る。reloadせず、そのまま次の操作へ渡す経路を含める。
function persisted(before: Ledger, after: Ledger, path: 'decode' | 'save' | 'load'): Ledger {
  if (path === 'decode') return parse(serialize(initial(after, emptySupply))).ledger;
  const store = new MemoryStore();
  const current = replace(store, null, { ledger: before, supply: emptySupply });
  const opId = after.history.at(-1)!.eventId;
  const values = { lot: 'X' };
  const opLabel = '架空操作';
  const saved = commit(store, current, {
    opId, opLabel, values, fingerprint: fingerprintOf(opLabel, values),
    actor: '架空担当A', startedAt: meta(opId, 10).recordedAt, savingSince: meta(opId, 10).recordedAt,
  }, [{ conflictReviews: [], ledger: after, supply: emptySupply, targets: ['X'] }]);
  expect(saved.kind).toBe('saved');
  if (saved.kind !== 'saved') throw new Error(`保存失敗: ${saved.kind}`);
  if (path === 'save') return saved.snapshot.ledger;
  const loaded = load(store);
  expect(loaded.kind).toBe('ok');
  if (loaded.kind !== 'ok') throw new Error(`読込失敗: ${loaded.kind}`);
  return loaded.snapshot.ledger;
}

describe.each(['decode', 'save', 'load'] as const)('FH-C01 保存前後の数量判定: %s', (path) => {
  test.each(['move', 'hold', 'release'] as const)('REC-03b: %sだけでは過去時点の数え直しに包含の回答を求めない', (kind) => {
    const before = kind === 'release' ? hold(counted(), meta('op2', 9), 'X', 'defective') : counted();
    const after = kind === 'move' ? move(before, meta('op3', 11), 'X', 'S2')
      : kind === 'hold' ? hold(before, meta('op3', 11), 'X', 'defective')
        : release(before, meta('op3', 11), 'X', 'defective');
    const expected = recount(after, meta('op4', 10), 'X', 100, cause);
    expect(recount(persisted(before, after, path), meta('op4', 10), 'X', 100, cause)).toEqual(expected);
  });

  test.each(['label', 'approximate'] as const)('REC-02b: %sの使用を取消すと、移動を保存しても元の数えたへ戻る', (basis) => {
    const before = use(counted(), meta('op2', 9), 'X', basis, 10, '架空の誤使用');
    const after = move(before, meta('op3', 10), 'X', 'S2');
    const restored = voidRecord(persisted(before, after, path), meta('op4', 11), 'op2', '架空の記録誤り');
    expect(restored).toEqual(voidRecord(after, meta('op4', 11), 'op2', '架空の記録誤り'));
    expect(restored.lots.X!.quantity).toMatchObject({ numeric: { value: 100, approximate: false, unconfirmed: 'none' }, computed: false });
  });

  test.each(['counted', 'label', 'approximate', 'unknown'] as const)('QTY-02a: %sの数量根拠は移動と保存で変えない', (basis) => {
    const before = register(practiceLedger, meta('op1', 8), lot, basis, basis === 'unknown' ? null : 100);
    const after = move(before, meta('op2', 11), 'X', 'S2');
    expect(persisted(before, after, path).lots.X!.quantity).toEqual(before.lots.X!.quantity);
    expect(recount(persisted(before, after, path), meta('op3', 10), 'X', 100, cause)).toEqual(recount(after, meta('op3', 10), 'X', 100, cause));
  });

  test.each(['use', 'split', 'stage', 'merge'] as const)('REC-03b・QTY-04a: 数値が同じでも%sの観測記録は包含判定に残す', (kind) => {
    let before = used();
    if (kind === 'merge') before = register(before, meta('op3', 8), { ...lot, id: 'Y' }, 'counted', 0);
    if (kind === 'stage') before = register(practiceLedger, meta('op1', 8), { ...lot, stage: { kind: 'working', process } }, 'counted', 100);
    const after = kind === 'use' ? use(before, meta('op4', 11), 'X', 'counted', 0, '架空作業')
      : kind === 'split' ? split(before, meta('op4', 11), 'X', 'Y', 'counted', 0)
        : kind === 'stage' ? changeStage(before, meta('op4', 11), 'X', 'Y', 'counted', 0, { kind: 'inspecting', process })
          : merge(before, meta('op4', 11), 'Y', 'X');
    const restored = persisted(before, after, path);
    expect(() => recount(restored, meta('op5', 10), 'X', 90, cause)).toThrow(InclusionRequired);
    expect(recount(restored, meta('op5', 10), 'X', 90, cause, 'included')).toEqual(recount(after, meta('op5', 10), 'X', 90, cause, 'included'));
    expect(restored.lots.X!.quantity.terms).toEqual(after.lots.X!.quantity.terms);
  });

  test('REC-03b: 数え直し後に移動日時を訂正しても数量の順序問題を作らない', () => {
    const moved = move(used(), meta('op3', 11), 'X', 'S2');
    const after = recount(moved, meta('op4', 12), 'X', 90, cause);
    const corrected = correctOccurredAt(persisted(moved, after, path), meta('op5', 14), 'op3', meta('op3', 13).occurredAt);
    expect(corrected).toEqual(correctOccurredAt(after, meta('op5', 14), 'op3', meta('op3', 13).occurredAt));
    expect(corrected.issues).toEqual({});
  });

  test('REC-03b: 使用日時が不明でも包含の回答を省かない', () => {
    const before = counted();
    const after = use(before, { ...meta('op2', 9), occurredAt: null }, 'X', 'counted', 10, '架空作業', 'notIncluded');
    expect(() => recount(persisted(before, after, path), meta('op3', 10), 'X', 90, cause)).toThrow(InclusionRequired);
  });

  test('REC-02b: 結合済みの元の使用を取消しても、移動を保存した結合先の根拠を保つ', () => {
    let before = use(counted(), meta('op2', 9), 'X', 'label', 10, '架空の誤使用');
    before = register(before, meta('op3', 8), { ...lot, id: 'Y' }, 'counted', 20);
    before = merge(before, meta('op4', 10), 'X', 'Y');
    const after = move(before, meta('op5', 11), 'Y', 'S2');
    const restored = voidRecord(persisted(before, after, path), meta('op6', 12), 'op2', '架空の記録誤り');
    expect(restored).toEqual(voidRecord(after, meta('op6', 12), 'op2', '架空の記録誤り'));
    expect(restored.lots.Y!.quantity).toMatchObject({ numeric: { value: 120, unconfirmed: 'none' } });
  });
});
