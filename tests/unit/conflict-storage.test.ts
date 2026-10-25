import { describe, expect, test } from 'vitest';
import { move } from '../../src/domain/ledger.ts';
import type { Meta } from '../../src/domain/ledger.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { backupTextOf, readBackup } from '../../src/ui/backup.ts';
import { parseConflictReview, type ConflictReview } from '../../src/ui/conflictrecord.ts';
import { seedLedger } from '../../src/ui/seed.ts';
import { commit, confirmSaved, faults, fingerprintOf, initial, load, parse, replace, retry, serialize, serializePending, targetsOf, type Snapshot, type StoreLike, type UnitState } from '../../src/ui/storage.ts';
import { decodePending } from '../../src/ui/storageparse.ts';
import { conflictV5 } from '../fixtures/conflict-v5/cases.ts';

const at = '2026-10-17T01:00:00+09:00';
const meta = (eventId: string): Meta => ({ eventId, occurredAt: at, recordedAt: at, actor: '架空担当A' });
const review = (eventId = 'op5', reviewId = 'review-1'): ConflictReview => parseConflictReview({ eventId, reviewId,
  draft: { reviewId, origin: { kind: 'unsent' }, opKey: 'use', opLabel: '使用', actor: '架空担当B', occurredAt: null, baseRevision: 3, baseLastWriter: 'op3',
    detectedAt: at, detectedReason: '別画面の更新', fields: [{ kind: 'text', name: 'qty', label: '数量', value: ' 001.30\r\n' }], readEvidence: [], targets: [], unapplied: ['未送信・数量へ未反映'] },
  resolution: { outcome: 'reenter', reason: '最新記録を確認した', actor: '架空担当A', at } });

class Memory implements StoreLike {
  readonly data = new Map<string, string>();
  writes: string[] = [];
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { this.writes.push(`set:${key}`); this.data.set(key, value); }
  removeItem(key: string): void { this.writes.push(`remove:${key}`); this.data.delete(key); }
}
function seeded(reviews: readonly ConflictReview[] = []): { store: Memory; current: Snapshot } {
  const store = new Memory();
  const current = replace(store, null, { ledger: seedLedger(), supply: emptySupply, conflictReviews: reviews });
  store.writes = [];
  return { store, current };
}
const operation = (opId = 'op20') => ({ opId, opLabel: '架空の移動', values: { to: 'T' }, fingerprint: fingerprintOf('架空の移動', { to: 'T' }), actor: '架空担当A', startedAt: at, savingSince: at });
function movedUnits(current: Snapshot, count = 1): UnitState[] {
  const units: UnitState[] = [];
  let before: { ledger: Snapshot['ledger']; supply: Snapshot['supply'] } = current;
  for (let i = 1; i <= count; i++) {
    const state = { ledger: move(before.ledger, meta(`op20-m${i}`), 'P-001', i % 2 === 1 ? 'T' : 'S1'), supply: before.supply };
    units.push({ ...state, conflictReviews: current.conflictReviews, targets: targetsOf(before, state) });
    before = state;
  }
  return units;
}
const json = (snapshot: Snapshot): Record<string, unknown> => JSON.parse(serialize(snapshot)) as Record<string, unknown>;

describe('競合保持: 版6の第三記録列', () => {
  test('初期化・置換は現行版と空列で書き、置換と再読込は列を引き継ぐ', () => {
    const empty = initial(seedLedger(), emptySupply);
    expect(empty.version).toBe(10); expect(empty.conflictReviews).toEqual([]);
    expect(json(empty)).toMatchObject({ version: 10, conflictReviews: [] });
    const { store, current } = seeded([review()]);
    expect(current.conflictReviews).toEqual([review()]);
    const loaded = load(store);
    expect(loaded).toMatchObject({ kind: 'ok', pending: null });
    if (loaded.kind === 'ok') { expect(loaded.snapshot.conflictReviews).toEqual([review()]); expect(Object.isFrozen(loaded.snapshot.conflictReviews)).toBe(true); }
    const next = replace(store, current, { ledger: current.ledger, supply: current.supply });
    expect(next.conflictReviews).toEqual([]);
  });

  test('現行版は列の欠落・型不正・重複・他列とのID衝突・未知の欄を拒否する', () => {
    const base = json(seeded([review()]).current);
    const bad = (conflictReviews: unknown) => JSON.stringify({ ...base, conflictReviews });
    const first = review();
    expect(() => parse(JSON.stringify({ ...base, conflictReviews: undefined }))).toThrow('conflictReviews');
    for (const value of [null, {}, 'x', [null], [{ ...first, extra: 1 }]]) expect(() => parse(bad(value))).toThrow('conflictReviews');
    expect(() => parse(bad([first, first]))).toThrow('重複');
    expect(() => parse(bad([first, review('op5', 'review-2')]))).toThrow('重複');
    const store = new Memory();
    const used = replace(store, null, { ledger: move(seedLedger(), meta('op7'), 'P-001', 'T'), supply: emptySupply });
    expect(() => parse(JSON.stringify({ ...json(used), conflictReviews: [review('op7', 'review-3')] }))).toThrow('台帳または供給の記録と重複');
    expect(parse(bad([first, review('op6', 'review-2')])).conflictReviews).toHaveLength(2);
  });

  test.each([1, 2, 3, 4, 5])('版%dの書式に新欄が紛れ込むと黙って落とさず拒否する', version => {
    // 版4以前は精度属性を、版1は数量の表を持たない。新欄だけが拒否の理由になるよう、他の旧書式の差は取り除く。
    const { current } = seeded([review()]);
    const text = JSON.stringify({ ...(version === 1 ? current : json(current)), version }, (key, value: unknown) => key === 'itemLabels' || key === 'receiptTemplates' || (key === 'unitSteps' && version < 5) ? undefined : value);
    expect(() => parse(text)).toThrow('旧版は照合記録の列を持たない');
  });

  test('固定した版5資料は空列へ補完して読み、保存先を書かない', () => {
    const snapshot = parse(conflictV5.snapshot);
    expect(snapshot.version).toBe(10); expect(snapshot.conflictReviews).toEqual([]); expect(Object.isFrozen(snapshot.conflictReviews)).toBe(true);
    for (const c of conflictV5.cases) {
      const store = new Memory();
      for (const [key, value] of Object.entries(c.data)) store.data.set(key, value);
      const loaded = load(store);
      expect(loaded).toMatchObject({ kind: 'ok' });
      if (loaded.kind === 'ok') { expect(loaded.snapshot.conflictReviews).toEqual([]); for (const unit of loaded.pending?.units ?? []) expect(unit.conflictReviews).toEqual([]); }
      expect(store.writes).toEqual([]);
    }
  });

  test('pendingは現行版の単位に列を必須とし、版4・5と包みなしは空へ補完し新欄を拒否する', () => {
    const { store, current } = seeded([review()]);
    faults.loseResponseAt = 1;
    const unknown = commit(store, current, operation(), movedUnits(current));
    expect(unknown.kind).toBe('unknown');
    const envelope = JSON.parse(store.getItem('fuzzy-stock/pending')!) as { format: string; version: number; quantities?: unknown; pending: { units: Record<string, unknown>[] } };
    expect(envelope.version).toBe(10);
    expect(decodePending(envelope).units[0]?.conflictReviews).toEqual([review()]);
    // 版4以前の書式は精度属性を持たない。
    const legacy = (value: unknown, version: number | null): unknown =>
      JSON.parse(JSON.stringify(value, (key, v: unknown) => key === 'itemLabels' || key === 'receiptTemplates' || (key === 'unitSteps' && (version === null || version < 5)) ? undefined : v));
    const without = (version: number | null): unknown => {
      const units = envelope.pending.units.map(({ conflictReviews: _drop, ...rest }) => rest);
      return legacy(version === null ? { ...envelope.pending, units, quantities: envelope.quantities } : { ...envelope, version, pending: { ...envelope.pending, units } }, version);
    };
    const withNew = (version: number | null): unknown => legacy(version === null ? { ...envelope.pending, quantities: envelope.quantities } : { ...envelope, version }, version);
    expect(() => decodePending(without(6))).toThrow('conflictReviews');
    for (const version of [4, 5, null]) expect(decodePending(without(version)).units[0]?.conflictReviews).toEqual([]);
    for (const version of [4, 5, null]) expect(() => decodePending(withNew(version))).toThrow('旧版は照合記録の列を持たない');
  });

  test('通常の業務保存は既存の照合記録を同じ内容のまま引き継ぐ', () => {
    const { store, current } = seeded([review()]);
    const result = commit(store, current, operation(), movedUnits(current));
    expect(result.kind).toBe('saved');
    if (result.kind !== 'saved') return;
    expect(result.snapshot.conflictReviews).toEqual([review()]);
    expect(result.snapshot.version).toBe(10);
    const head = store.getItem('fuzzy-stock/head'), written = parse(store.getItem(`fuzzy-stock/slot-${head}`)!);
    expect(written.conflictReviews).toEqual([review()]);
    expect(store.getItem('fuzzy-stock/pending')).toBeNull();
  });

  test('一部だけ保存した複数単位の再試行でも、全単位で既存の照合記録が残る', () => {
    const { store, current } = seeded([review()]);
    faults.failMidwayAt = 2;
    const partial = commit(store, current, operation(), movedUnits(current, 3));
    expect(partial.kind).toBe('partial');
    if (partial.kind !== 'partial') return;
    expect(partial.snapshot.conflictReviews).toEqual([review()]);
    const done = retry(store, partial.snapshot, partial.pending, '架空担当A', at);
    expect(done.kind).toBe('saved');
    if (done.kind === 'saved') expect(done.snapshot.conflictReviews).toEqual([review()]);
  });

  test('単位が既存の列を落とす・変える・追記するときは何も書かず拒否する', () => {
    const { store, current } = seeded([review()]);
    const [unit] = movedUnits(current);
    for (const conflictReviews of [[], [review('op6', 'review-2')], [review(), review('op6', 'review-2')]]) {
      store.writes = [];
      expect(commit(store, current, operation(), [{ ...unit!, conflictReviews }])).toMatchObject({ kind: 'failed' });
      expect(store.writes).toEqual([]);
    }
  });

  test('保存済みに見える単位でも、最後の単位の照合記録が写しと違えば確定せず競合にする', () => {
    const { store, current } = seeded([review()]);
    faults.loseResponseAt = 1;
    const unknown = commit(store, current, operation(), movedUnits(current));
    expect(unknown.kind).toBe('unknown');
    if (unknown.kind !== 'unknown') return;
    const head = parse(store.getItem(`fuzzy-stock/slot-${store.getItem('fuzzy-stock/head')}`)!);
    const stale = { ...unknown.pending, units: unknown.pending.units.map(unit => ({ ...unit, conflictReviews: [] })) };
    store.data.set('fuzzy-stock/pending', serializePending(stale));
    store.writes = [];
    expect(confirmSaved(store, head, decodePending(JSON.parse(serializePending(stale))), '架空担当A', at)).toEqual({ kind: 'conflict' });
    expect(store.writes).toEqual([]);
  });

  test('復元用バックアップは照合記録を含めて往復し、復元で引き継ぐ', () => {
    const { store, current } = seeded([review()]);
    const text = backupTextOf(current, at);
    const read = readBackup(new TextEncoder().encode(text));
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(read.snapshot.conflictReviews).toEqual([review()]);
    expect(replace(store, current, read.snapshot).conflictReviews).toEqual([review()]);
  });
});
