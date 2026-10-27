import { beforeEach, describe, expect, test } from 'vitest';
import { move } from '../../src/domain/ledger.ts';
import type { Meta } from '../../src/domain/ledger.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { backupTextOf, crc32, readBackup } from '../../src/ui/backup.ts';
import { conflictReviewFingerprint, parseConflictReview, reviewOpLabel, reviewPendingValues, type ConflictReview } from '../../src/ui/conflictrecord.ts';
import { savePresentation } from '../../src/ui/saveui.ts';
import { seedLedger } from '../../src/ui/seed.ts';
import { commit, faults, fingerprintOf, initial, inquire, load, parse, replace, targetsOf, type Pending, type Snapshot, type StoreLike, type UnitState } from '../../src/ui/storage.ts';
import { conflictV5 } from '../fixtures/conflict-v5/cases.ts';

const at = '2026-10-17T03:00:00+09:00';
const later = '2026-10-17T03:05:00+09:00';
const meta = (eventId: string): Meta => ({ eventId, occurredAt: at, recordedAt: at, actor: '架空担当A' });
const review = (eventId = 'op5', reviewId = 'review-1'): ConflictReview => parseConflictReview({ eventId, reviewId,
  draft: { reviewId, origin: { kind: 'rejected', opId: 'op4', attemptedAt: at, reason: 'snapshotChanged' }, opKey: 'use', opLabel: '使用', actor: '架空担当B', occurredAt: '2026-10-17T02:50:00+09:00',
    baseRevision: 3, baseLastWriter: 'op3', detectedAt: at, detectedReason: '別画面の更新',
    fields: [{ kind: 'text', name: 'qty', label: '数量', value: ' 001.30\r\n' }, { kind: 'checkbox', name: 'ok', label: '確認', checked: false }],
    readEvidence: [{ kind: 'needRaw', raw: '架空文書\n不明' }], targets: ['まとまりP-001'], unapplied: ['数量へ未反映'] },
  resolution: { outcome: 'dismiss', reason: '最新記録を確認し、取り下げる', actor: '架空担当A', at: later } });

class Memory implements StoreLike {
  readonly data = new Map<string, string>();
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { this.data.set(key, value); }
  removeItem(key: string): void { this.data.delete(key); }
}
async function unknownReview() {
  const store = new Memory();
  const current = replace(store, null, { ledger: seedLedger(), supply: emptySupply });
  const next = review();
  const unit: UnitState = { ledger: current.ledger, supply: current.supply, conflictReviews: [next], targets: [] };
  unit.targets.push(...targetsOf(current, unit));
  const op = { opId: next.eventId, opLabel: reviewOpLabel, fingerprint: await conflictReviewFingerprint(next), values: reviewPendingValues(next), actor: next.resolution.actor,
    startedAt: next.resolution.at, savingSince: next.resolution.at };
  faults.loseResponseAt = 1;
  const result = commit(store, current, op, [unit]);
  if (result.kind !== 'unknown') throw new Error(`結果不明になっていない: ${result.kind}`);
  return { store, current, pending: result.pending };
}
beforeEach(() => { faults.loseResponseAt = null; faults.failMidwayAt = null; });

describe('競合保持: 保存中単位の識別子と対象の表示', () => {
  test('照合結果の保存単位は元入力の識別子を対象にし、通常の単位の対象は変えない', () => {
    const current = initial(seedLedger(), emptySupply);
    const unit = { ledger: current.ledger, supply: current.supply, conflictReviews: [review()] };
    expect(targetsOf(current, unit)).toEqual(['競合照合review-1']);
    expect(targetsOf(current, { ledger: current.ledger, supply: current.supply })).toEqual([]);
    const moved = { ledger: move(current.ledger, meta('op7'), 'P-001', 'T'), supply: current.supply };
    expect(targetsOf(current, moved)).toEqual(['まとまりP-001']);
    const withReview = initial(seedLedger(), emptySupply);
    expect(targetsOf({ ...withReview, conflictReviews: [review()] }, { ...unit, conflictReviews: [review()] })).toEqual([]);
  });

  test('照合結果の保存結果不明は、読み直した保存中の単位から固定した候補の全文（元入力・結果・理由・確認者・確認日時）を示す', async () => {
    const { store, pending } = await unknownReview();
    const loaded = load(store);
    if (loaded.kind !== 'ok' || loaded.pending === null) throw new Error('保存中の操作を読み直せない');
    const text = savePresentation({ kind: 'unknown', pending: loaded.pending, inquiry: null }).lines.join('\n');
    expect(text).toContain('保存結果を確認中の照合結果（固定した候補');
    expect(text).toContain('解消の結果：この入力を取り下げる');
    expect(text).toContain('理由："最新記録を確認し、取り下げる"');
    expect(text).toContain('確認者：架空担当A');
    expect(text).toContain(`確認日時：${later}`);
    expect(text).toContain('元の担当：架空担当B');
    expect(text).toContain('数量："' + ' 001.30\\r\\n' + '"');
    expect(text).toContain('必要明細の原文："架空文書\\n不明"');
    expect(pending.values).toEqual({ reviewId: 'review-1', outcome: 'dismiss' });
  });

  test('照合結果の保存結果不明は、元入力の競合と区別し、操作IDと対象と照会結果を示す', async () => {
    const { store, pending } = await unknownReview();
    const inquiry = inquire(store, pending);
    const text = savePresentation({ kind: 'unknown', pending, inquiry }).lines.join('\n');
    expect(text).toContain('保存結果不明（操作ID：op5）');
    expect(text).toContain('操作：更新競合の照合結果');
    expect(text).toContain('対象：競合照合review-1');
    expect(text).toContain('更新競合の元入力ではなく、照合結果の保存です');
    expect(text).toContain('数量は変わりません');
    expect(text).toContain('照会の結果：1単位中1単位が保存済み');
    expect(text).toContain('操作ID：op5');
    expect(text).not.toContain('別の画面で記録が保存された');
  });

  test('照会前の一部保存の表示は、索引がなくても単位の操作IDに照合記録を含める', async () => {
    const { current, pending } = await unknownReview();
    const text = savePresentation({ kind: 'partial', snapshot: current, pending, saved: 0, total: 1, reason: '架空の途中失敗', inquiry: null }).lines.join('\n');
    expect(text).toContain('単位1：未保存　操作ID：op5　対象：競合照合review-1');
  });

  test('通常操作の保存結果不明には照合結果の説明を足さない', () => {
    const base: Pending = { progress: 'saving', unknownSince: null, savingSince: at, baseRevision: 0, opId: 'op9', opLabel: '架空の移動', fingerprint: fingerprintOf('架空の移動', {}),
      values: {}, actor: '架空担当A', startedAt: at, units: [] };
    const text = savePresentation({ kind: 'unknown', pending: base, inquiry: null }).lines.join('\n');
    expect(text).toContain('保存結果不明（操作ID：op9）');
    expect(text).not.toContain('照合結果の保存です');
  });
});

describe('競合保持: バックアップと復元で照合記録を引き継ぐ', () => {
  function withReview() {
    const store = new Memory();
    const first = replace(store, null, { ledger: seedLedger(), supply: emptySupply, conflictReviews: [review()] });
    return { store, first };
  }
  const bytes = (text: string) => new TextEncoder().encode(text);

  test('外包みの版1を維持して内版7を書き、復元した照合記録は元入力・結果・確認者・日時を保つ', () => {
    const { first } = withReview();
    const text = backupTextOf(first, later);
    const envelope = JSON.parse(text) as { version: number; snapshot: string };
    expect(envelope.version).toBe(1);
    expect(JSON.parse(envelope.snapshot)).toMatchObject({ version: 12 });
    const read = readBackup(bytes(text));
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    const restoreStore = new Memory();
    const restored = replace(restoreStore, null, read.snapshot);
    expect(restored.conflictReviews).toEqual([review()]);
    const [saved] = load(restoreStore).kind === 'ok' ? (load(restoreStore) as { snapshot: Snapshot }).snapshot.conflictReviews : [];
    expect(saved?.draft.fields).toEqual(review().draft.fields);
    expect(saved?.draft.origin).toEqual({ kind: 'rejected', opId: 'op4', attemptedAt: at, reason: 'snapshotChanged' });
    expect(saved?.draft.actor).toBe('架空担当B');
    expect(saved?.resolution).toEqual({ outcome: 'dismiss', reason: '最新記録を確認し、取り下げる', actor: '架空担当A', at: later });
  });

  test('復元は操作履歴・保存結果の解消・採番下限も引き継ぎ、初期化は空列になる', () => {
    const { store, first } = withReview();
    const unit: UnitState = { ledger: move(first.ledger, meta('op7'), 'P-001', 'T'), supply: first.supply, conflictReviews: first.conflictReviews, targets: ['まとまりP-001'] };
    const op = { opId: 'op7', opLabel: '架空の移動', fingerprint: fingerprintOf('架空の移動', {}), values: {}, actor: '架空担当A', startedAt: at, savingSince: at };
    const saved = commit(store, first, op, [unit]);
    expect(saved.kind).toBe('saved');
    if (saved.kind !== 'saved') return;
    const read = readBackup(bytes(backupTextOf(saved.snapshot, later)));
    if (read.kind !== 'ok') throw new Error('読めない');
    const restored = replace(new Memory(), null, read.snapshot);
    expect(restored.ops).toEqual(saved.snapshot.ops);
    expect(restored.opFloor).toBe(saved.snapshot.opFloor);
    expect(restored.conflictReviews).toEqual([review()]);
    expect(restored.ledger.history.map(event => event.eventId)).toEqual(saved.snapshot.ledger.history.map(event => event.eventId));
    expect(replace(new Memory(), null, { ledger: seedLedger(), supply: emptySupply }).conflictReviews).toEqual([]);
  });

  test('検査値は照合記録を含む写し全体にかかり、書き換えは検査値の再計算がなければ復元に使えない', () => {
    const { first } = withReview();
    const envelope = JSON.parse(backupTextOf(first, later)) as Record<string, string>;
    const tampered = { ...envelope, snapshot: envelope['snapshot']!.replace('最新記録を確認し、取り下げる', '書き換えた理由') };
    expect(readBackup(bytes(JSON.stringify(tampered)))).toMatchObject({ kind: 'unreadable', reason: expect.stringContaining('検査値') });
    const recomputed = { ...tampered, crc32: crc32(bytes(`${later}\n${tampered['snapshot']}`)).toString(16).padStart(8, '0') };
    const read = readBackup(bytes(JSON.stringify(recomputed)));
    expect(read.kind).toBe('ok');
    if (read.kind === 'ok') expect(read.snapshot.conflictReviews[0]?.resolution.reason).toBe('書き換えた理由');
  });

  test('版6導入前の旧バックアップは読め、復元後も旧い保存結果の解消・採番下限・操作履歴を保ち照合記録は空になる', () => {
    const read = readBackup(bytes(conflictV5.backup));
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(read.snapshot.conflictReviews).toEqual([]);
    const old = parse(conflictV5.snapshot);
    const restored = replace(new Memory(), null, read.snapshot);
    expect(restored.saveChecks).toEqual(old.saveChecks);
    expect(restored.opFloor).toBe(old.opFloor);
    expect(restored.ops).toEqual(old.ops);
    expect(restored.conflictReviews).toEqual([]);
  });

  test('保存中の操作が残るときは、照合記録を含む復元でも既存のガードで拒否する', async () => {
    const { store, pending } = await unknownReview();
    const read = readBackup(bytes(backupTextOf(replace(new Memory(), null, { ledger: seedLedger(), supply: emptySupply, conflictReviews: [review('op8', 'review-2')] }), later)));
    if (read.kind !== 'ok') throw new Error('読めない');
    const before = [...store.data];
    expect(() => replace(store, parse(store.getItem(`fuzzy-stock/slot-${store.getItem('fuzzy-stock/head')}`)!), read.snapshot)).toThrow('保存中の操作');
    expect([...store.data]).toEqual(before);
    expect(pending.opId).toBe('op5');
  });
});
