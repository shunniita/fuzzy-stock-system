import { describe, expect, test, vi } from 'vitest';
import { move } from '../../src/domain/ledger.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { decodePending } from '../../src/ui/storageparse.ts';
import { conflictReviewFingerprint, parseConflictReview, reviewOpLabel, reviewPendingValues, type ConflictReview } from '../../src/ui/conflictrecord.ts';
import { seedLedger } from '../../src/ui/seed.ts';
import { abandon, attemptOf, commit, confirmSaved, faults, inquire, load, parse, replace, retry, serialize, serializePending, type CommitResult, type Pending, type Snapshot, type StoreLike, type UnitState } from '../../src/ui/storage.ts';

const at = '2026-10-17T02:00:00+09:00';
const later = '2026-10-17T02:05:00+09:00';
const review = (eventId = 'op5', reviewId = 'review-1', reason = '最新記録を確認した', value = ' 001.30\r\n'): ConflictReview => parseConflictReview({ eventId, reviewId,
  draft: { reviewId, origin: { kind: 'unsent' }, opKey: 'use', opLabel: '使用', actor: '架空担当B', occurredAt: null, baseRevision: 3, baseLastWriter: 'op3',
    detectedAt: at, detectedReason: '別画面の更新', fields: [{ kind: 'text', name: 'qty', label: '数量', value }], readEvidence: [], targets: [], unapplied: ['未送信・数量へ未反映'] },
  resolution: { outcome: 'reenter', reason, actor: '架空担当A', at } });

class Memory implements StoreLike {
  readonly data = new Map<string, string>();
  writes: string[] = [];
  failSetOf: string | null = null;
  failRemove = false;
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void {
    this.writes.push(`set:${key}`);
    if (key === this.failSetOf) throw new Error('保存容量不足');
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.writes.push(`remove:${key}`);
    if (this.failRemove) throw new Error('保存中の操作を消せない');
    this.data.delete(key);
  }
}
function seeded(reviews: readonly ConflictReview[] = []): { store: Memory; current: Snapshot } {
  const store = new Memory();
  const current = replace(store, null, { ledger: seedLedger(), supply: emptySupply, conflictReviews: reviews });
  store.writes = [];
  return { store, current };
}
async function reviewOp(current: Snapshot, next: ConflictReview): Promise<{ op: Omit<Pending, 'units' | 'progress' | 'unknownSince' | 'baseRevision'>; units: UnitState[] }> {
  return { op: { opId: next.eventId, opLabel: reviewOpLabel, fingerprint: await conflictReviewFingerprint(next), values: reviewPendingValues(next), actor: next.resolution.actor,
    startedAt: next.resolution.at, savingSince: next.resolution.at },
  units: [{ ledger: current.ledger, supply: current.supply, conflictReviews: [...current.conflictReviews, next], targets: [] }] };
}
const headOf = (store: Memory): Snapshot => parse(store.getItem(`fuzzy-stock/slot-${store.getItem('fuzzy-stock/head')}`)!);
function savedOf(result: CommitResult): Snapshot {
  if (result.kind !== 'saved') throw new Error(`保存できていない: ${result.kind}`);
  return result.snapshot;
}

describe('競合保持: 照合結果の全文digestとPendingの固定欄', () => {
  test('digestは版付きの小文字64桁で、全文の差を区別し、構造が同じなら同じ', async () => {
    const a = await conflictReviewFingerprint(review());
    expect(a).toMatch(/^conflict-review-v1:sha256:[0-9a-f]{64}$/);
    expect(await conflictReviewFingerprint(review())).toBe(a);
    for (const other of [review('op5', 'review-1', '別の理由'), review('op5', 'review-1', '最新記録を確認した', ' 001.3\r\n'), review('op6'), review('op5', 'review-2')]) {
      expect(await conflictReviewFingerprint(other)).not.toBe(a);
    }
  });

  test('Web Cryptoを使えないときは例外にし、固定欄は保存層で検査される', async () => {
    vi.stubGlobal('crypto', undefined);
    try { await expect(conflictReviewFingerprint(review())).rejects.toThrow('SHA-256'); }
    finally { vi.unstubAllGlobals(); }
  });
});

describe('競合保持: 照合結果の一回保存', () => {
  test('正常保存は第三列へ一件だけ追記し、台帳・供給・数量を動かさない', async () => {
    const { store, current } = seeded();
    const { op, units } = await reviewOp(current, review());
    const saved = savedOf(commit(store, current, op, units));
    expect(saved.conflictReviews).toEqual([review()]);
    expect(saved.ledger).toEqual(current.ledger); expect(saved.supply).toEqual(current.supply);
    expect(saved.revision).toBe(current.revision + 1);
    expect(saved.lastWriter).toBe('op5'); expect(saved.opFloor).toBeGreaterThan(5);
    expect(saved.ops['op5']).toEqual({ fingerprint: op.fingerprint, units: [['op5']] });
    expect(headOf(store)).toEqual(saved);
    expect(store.getItem('fuzzy-stock/pending')).toBeNull();
    expect(load(store)).toMatchObject({ kind: 'ok', pending: null });
  });

  test('同じ照合結果の再送は重複として返し、何も書かない', async () => {
    const { store, current } = seeded();
    const { op, units } = await reviewOp(current, review());
    const saved = savedOf(commit(store, current, op, units));
    store.writes = [];
    expect(commit(store, saved, op, units)).toMatchObject({ kind: 'duplicate' });
    expect(store.writes).toEqual([]);
  });

  test('fingerprintとIDが同じでも実記録が違えば成功にせず、無変更で拒否する', async () => {
    const { store, current } = seeded();
    const { op, units } = await reviewOp(current, review());
    const saved = savedOf(commit(store, current, op, units));
    const head = store.getItem('fuzzy-stock/head'), key = `fuzzy-stock/slot-${head}`;
    store.data.set(key, serialize({ ...saved, conflictReviews: [review('op5', 'review-1', '書き換えられた理由')] }));
    store.writes = [];
    expect(commit(store, headOf(store), op, units)).toMatchObject({ kind: 'mismatch', reason: expect.stringContaining('照合記録が入力と違う') });
    expect(store.writes).toEqual([]);
  });

  test('保存済みの索引があっても実記録が入力と違えば保存済みとせず、取りやめを含む確定を競合にする', async () => {
    const { store, current } = seeded();
    const { op, units } = await reviewOp(current, review());
    faults.loseResponseAt = 1;
    const unknown = commit(store, current, op, units);
    expect(unknown.kind).toBe('unknown');
    if (unknown.kind !== 'unknown') return;
    const saved = headOf(store);
    expect(inquire(store, unknown.pending)).toMatchObject({ savedUnits: 1, total: 1 });
    store.data.set(`fuzzy-stock/slot-${store.getItem('fuzzy-stock/head')}`, serialize({ ...saved, conflictReviews: [review('op5', 'review-1', '書き換えられた理由')] }));
    const tampered = headOf(store);
    expect(() => inquire(store, unknown.pending)).toThrow('保存済みの単位の記録が入力と違う');
    expect(load(store)).toMatchObject({ kind: 'ok', pending: { opId: 'op5' }, recovered: null });
    store.writes = [];
    for (const settle of [confirmSaved, abandon]) expect(settle(store, tampered, unknown.pending, '架空担当A', later)).toEqual({ kind: 'conflict' });
    expect(store.writes).toEqual([]);
  });

  test('確定後の応答喪失は照会で一件と分かり、保存済みを明示確定しても列は増えない', async () => {
    const { store, current } = seeded();
    const { op, units } = await reviewOp(current, review());
    faults.loseResponseAt = 1;
    const unknown = commit(store, current, op, units);
    expect(unknown.kind).toBe('unknown');
    if (unknown.kind !== 'unknown') return;
    expect(inquire(store, unknown.pending)).toMatchObject({ savedUnits: 1, total: 1 });
    const settled = confirmSaved(store, inquire(store, unknown.pending).snapshot, unknown.pending, '架空担当A', later);
    expect(settled).toMatchObject({ kind: 'settled', outcome: 'saved' });
    if (settled.kind !== 'settled') return;
    expect(settled.snapshot.conflictReviews).toEqual([review()]);
    expect(settled.snapshot.saveChecks).toHaveLength(1);
    expect(store.getItem('fuzzy-stock/pending')).toBeNull();
  });

  test('応答喪失後の再試行は書き直さず、保存済みとして解消する', async () => {
    const { store, current } = seeded();
    const { op, units } = await reviewOp(current, review());
    faults.loseResponseAt = 1;
    const unknown = commit(store, current, op, units);
    if (unknown.kind !== 'unknown') throw new Error('応答喪失になっていない');
    const result = retry(store, inquire(store, unknown.pending).snapshot, unknown.pending, '架空担当A', later);
    expect(result.kind).toBe('recovered');
    expect(headOf(store).conflictReviews).toEqual([review()]);
  });

  test('未保存のまま取りやめると第三列を増やさず、同じ内容の再送は記録済みの解消を返す', async () => {
    const { store, current } = seeded();
    const { op, units } = await reviewOp(current, review());
    faults.failMidwayAt = 1; store.failRemove = true;
    const unknown = commit(store, current, op, units);
    expect(unknown.kind).toBe('unknown');
    if (unknown.kind !== 'unknown') return;
    store.failRemove = false;
    expect(inquire(store, unknown.pending)).toMatchObject({ savedUnits: 0, total: 1 });
    const settled = abandon(store, inquire(store, unknown.pending).snapshot, unknown.pending, '架空担当A', later);
    expect(settled).toMatchObject({ kind: 'settled', outcome: 'abandoned' });
    if (settled.kind !== 'settled') return;
    expect(settled.snapshot.conflictReviews).toEqual([]);
    expect(settled.snapshot.ledger).toEqual(current.ledger);
    expect(commit(store, settled.snapshot, op, units)).toMatchObject({ kind: 'recovered' });
  });

  test('書込前の失敗では写しも第三列も変わらない', async () => {
    const { store, current } = seeded();
    const { op, units } = await reviewOp(current, review());
    store.failSetOf = 'fuzzy-stock/pending';
    expect(commit(store, current, op, units)).toMatchObject({ kind: 'failed' });
    expect(headOf(store)).toEqual(current);
  });

  test.each(['fuzzy-stock/pending', 'fuzzy-stock/slot-B'])('3.7: %s のnative容量不足は未保存の失敗に容量不足の印を付け、他の書込失敗には付けない', async key => {
    for (const [error, quota] of [[new DOMException('架空の容量不足', 'QuotaExceededError'), true], [new Error('架空の書込失敗'), false]] as const) {
      const { store, current } = seeded();
      const { op, units } = await reviewOp(current, review());
      const original = store.setItem.bind(store);
      store.setItem = (name, value) => { if (name === key) throw error; original(name, value); };
      const result = commit(store, current, op, units);
      expect(result).toEqual({ kind: 'failed', reason: error.message, ...(quota ? { quota: true } : {}) });
      expect(headOf(store)).toEqual(current);
      expect(store.getItem('fuzzy-stock/pending')).toBeNull();
    }
  });

  test('0単位保存の結果不明から再試行すると、照合記録を写しへ一件だけ書く', async () => {
    const { store, current } = seeded();
    const { op, units } = await reviewOp(current, review());
    const set = store.setItem.bind(store), get = store.getItem.bind(store);
    let failed = false;
    // 写しの書込に失敗し、見出しも読めないので、書けたかどうかを断定できない。
    store.setItem = (key, value) => { if (!failed && key.startsWith('fuzzy-stock/slot-')) { failed = true; throw new Error('架空の保存失敗'); } set(key, value); };
    store.getItem = key => { if (failed && key === 'fuzzy-stock/head') { store.getItem = get; throw new Error('架空の読込失敗'); } return get(key); };
    const unknown = commit(store, current, op, units);
    if (unknown.kind !== 'unknown') throw new Error(`結果不明になっていない: ${unknown.kind}`);
    expect(inquire(store, unknown.pending)).toMatchObject({ savedUnits: 0, total: 1 });
    const saved = savedOf(retry(store, current, unknown.pending, '架空担当A', later));
    expect(saved.conflictReviews).toEqual([review()]);
    expect(headOf(store).conflictReviews).toEqual([review()]);
    expect(saved.ledger).toEqual(current.ledger);
  });

  test('他者の保存中操作が残っていれば競合として何も書かない', async () => {
    const { store, current } = seeded();
    const { op, units } = await reviewOp(current, review());
    const other = await reviewOp(current, review('op6', 'review-2'));
    faults.loseResponseAt = 1;
    expect(commit(store, current, other.op, other.units).kind).toBe('unknown');
    store.writes = [];
    expect(commit(store, current, op, units)).toEqual({ kind: 'conflict' });
    expect(store.writes).toEqual([]);
  });

  test('同じ元入力識別子の別の操作は、列を変えず書込前に拒否する', async () => {
    const { store, current } = seeded([review()]);
    const { op, units } = await reviewOp(current, review('op6', 'review-1', '別の結果'));
    expect(commit(store, current, op, units)).toMatchObject({ kind: 'failed', reason: expect.stringContaining('重複') });
    expect(store.writes).toEqual([]);
  });

  test('蓄積の総量256KiBを超える追記は、pendingを作る前に無書込で拒否する', async () => {
    const big = (n: number) => review(`op${n}`, `review-${n}`, '理由', 'x'.repeat(60 * 1024));
    const { store, current } = seeded([big(2), big(3), big(4), big(5)]);
    const { op, units } = await reviewOp(current, big(6));
    expect(commit(store, current, op, units)).toMatchObject({ kind: 'failed', reason: expect.stringContaining('256KiB') });
    expect(store.writes).toEqual([]);
    expect(headOf(store).conflictReviews).toHaveLength(4);
  });

  test('照合結果のPending固定欄が記録と違えば書込前に拒否する', async () => {
    const { store, current } = seeded();
    const { op, units } = await reviewOp(current, review());
    const bad: Record<string, Partial<typeof op>> = {
      opId: { opId: 'op7' }, fingerprint: { fingerprint: 'conflict-review-v1:sha256:abc' }, values: { values: { reviewId: 'review-1', outcome: 'reenter', extra: 'x' } },
      outcome: { values: { reviewId: 'review-1', outcome: 'dismiss' } }, actor: { actor: '別の確認者' }, startedAt: { startedAt: later },
    };
    for (const [name, patch] of Object.entries(bad)) {
      expect(commit(store, current, { ...op, ...patch }, units), name).toMatchObject({ kind: 'failed' });
      expect(store.writes, name).toEqual([]);
    }
  });

  test('照合結果の保存が複数単位・台帳変更・追記なしのときは拒否し、通常の保存は追記できない', async () => {
    const { store, current } = seeded();
    const { op, units } = await reviewOp(current, review());
    const [unit] = units;
    expect(commit(store, current, op, [unit!, unit!])).toMatchObject({ kind: 'failed' });
    expect(commit(store, current, op, [{ ...unit!, conflictReviews: [] }])).toMatchObject({ kind: 'failed' });
    const moved = { ...unit!, ledger: move(current.ledger, { eventId: 'op5-m', occurredAt: at, recordedAt: at, actor: '架空担当A' }, 'P-001', 'T') };
    expect(commit(store, current, op, [moved])).toMatchObject({ kind: 'failed', reason: expect.stringContaining('他の記録を追加しない') });
    expect(commit(store, current, { ...op, opLabel: '架空の通常操作', fingerprint: '架空', values: {} }, units)).toMatchObject({ kind: 'failed' });
    expect(store.writes).toEqual([]);
  });
});

describe('競合保持: 解消済みでも実記録との全文一致を省かない', () => {
  const tamper = (store: Memory, reviews: readonly ConflictReview[]): Snapshot => {
    store.data.set(`fuzzy-stock/slot-${store.getItem('fuzzy-stock/head')}`, serialize({ ...headOf(store), conflictReviews: reviews }));
    return headOf(store);
  };
  // 保存の応答喪失→保存済みの明示確定でも応答を失い、SaveCheckとpendingが両方残った状態。
  async function doubleLost() {
    const { store, current } = seeded();
    const { op, units } = await reviewOp(current, review());
    faults.loseResponseAt = 1;
    const first = commit(store, current, op, units);
    if (first.kind !== 'unknown') throw new Error('応答喪失になっていない');
    faults.loseResponseAt = 1;
    const second = confirmSaved(store, inquire(store, first.pending).snapshot, first.pending, '架空担当A', later);
    if (second.kind !== 'unknown') throw new Error('二度目の応答喪失になっていない');
    expect(headOf(store).saveChecks).toHaveLength(1);
    expect(store.getItem('fuzzy-stock/pending')).not.toBeNull();
    return { store, op, units, pending: second.pending };
  }

  test.each([['変更', [review('op5', 'review-1', '書き換えられた理由')]], ['欠落', []]] as const)('SaveCheck成立後に保存先の照合記録が%sされていれば、復旧せずpendingを保持する', async (_, reviews) => {
    for (const path of ['load', 'confirmSaved', 'retry', 'abandon'] as const) {
      const { store, pending } = await doubleLost();
      const tampered = tamper(store, reviews);
      store.writes = [];
      if (path === 'load') {
        expect(load(store), path).toMatchObject({ kind: 'ok', pending: { opId: 'op5' }, recovered: null });
      } else {
        const settle = { confirmSaved, retry, abandon }[path];
        expect(settle(store, tampered, pending, '架空担当A', later), path).toEqual({ kind: 'conflict' });
      }
      expect(store.writes, path).toEqual([]);
      expect(store.getItem('fuzzy-stock/pending'), path).not.toBeNull();
    }
  });

  test('改変のない二重の応答喪失は従来どおり復旧してpendingを消す', async () => {
    const loaded = await doubleLost();
    expect(load(loaded.store)).toMatchObject({ kind: 'ok', pending: null, recovered: { opId: 'op5', resolution: { outcome: 'saved' } } });
    expect(loaded.store.getItem('fuzzy-stock/pending')).toBeNull();
    const again = await doubleLost();
    expect(confirmSaved(again.store, headOf(again.store), again.pending, '架空担当A', later)).toMatchObject({ kind: 'recovered' });
  });

  test('未保存のまま取りやめた解消記録は、保存先に照合記録がなくても復旧できる', async () => {
    const { store, current } = seeded();
    const { op, units } = await reviewOp(current, review());
    faults.failMidwayAt = 1; store.failRemove = true;
    const unknown = commit(store, current, op, units);
    if (unknown.kind !== 'unknown') throw new Error('結果不明になっていない');
    store.failRemove = false;
    faults.loseResponseAt = 1;
    const lost = abandon(store, inquire(store, unknown.pending).snapshot, unknown.pending, '架空担当A', later);
    expect(lost.kind).toBe('unknown');
    if (lost.kind !== 'unknown') return;
    // 取りやめの解消記録は、照合記録がなくても通常の復旧経路（確定・再試行・取りやめ）で復旧できる。
    for (const settle of [confirmSaved, retry, abandon]) {
      const copy = new Memory();
      for (const [key, value] of store.data) copy.data.set(key, value);
      expect(settle(copy, headOf(copy), lost.pending, '架空担当A', later), settle.name).toMatchObject({ kind: 'recovered' });
      expect(copy.getItem('fuzzy-stock/pending')).toBeNull();
    }
    expect(load(store)).toMatchObject({ kind: 'ok', pending: null, recovered: { resolution: { outcome: 'abandoned' } } });
    expect(headOf(store).conflictReviews).toEqual([]);
  });

  test('照合結果の索引が別の既存記録を指していても、保存済みと数えない', async () => {
    const { current } = seeded();
    const { op, units } = await reviewOp(current, review());
    const lastId = current.ledger.history.at(-1)!.eventId;
    const store = new Memory();
    replace(store, null, { ledger: seedLedger(), supply: emptySupply, ops: { op5: { fingerprint: op.fingerprint, units: [[lastId]] } } });
    const pending: Pending = { ...op, units, progress: 'saving', unknownSince: later, baseRevision: 0 };
    store.data.set('fuzzy-stock/pending', serializePending(pending));
    expect(() => inquire(store, pending)).toThrow('保存済みの操作索引が入力と違う');
    expect(load(store)).toMatchObject({ kind: 'ok', pending: { opId: 'op5' }, recovered: null });
  });

  test('保存済みの照合結果を通常ラベルに変えて再送しても、全文一致の検査を避けられない', async () => {
    const { store, current } = seeded();
    const { op, units } = await reviewOp(current, review());
    savedOf(commit(store, current, op, units));
    tamper(store, [review('op5', 'review-1', '書き換えられた理由')]);
    store.writes = [];
    expect(commit(store, headOf(store), { ...op, opLabel: '架空の通常操作' }, units)).toMatchObject({ kind: 'mismatch' });
    expect(store.writes).toEqual([]);
  });

  test('通常ラベルで照合結果のfingerprintを持つPendingは復号できない', async () => {
    const { current } = seeded();
    const { op, units } = await reviewOp(current, review());
    const pending: Pending = { ...op, units, progress: 'saving', unknownSince: null, baseRevision: 0 };
    expect(decodePending(JSON.parse(serializePending(pending)))).toMatchObject({ opId: 'op5' });
    expect(() => decodePending(JSON.parse(serializePending({ ...pending, opLabel: '架空の通常操作' })))).toThrow('固定の操作名');
  });

  // 保存済みの解消記録が残っていても、索引が失われて照合記録が変わった・消えた状態の再送を、保存済みとして返さない。
  async function resolved(outcome: 'saved' | 'retried') {
    const { store, current } = seeded();
    const { op, units } = await reviewOp(current, review());
    if (outcome === 'saved') {
      faults.loseResponseAt = 1;
      const unknown = commit(store, current, op, units);
      if (unknown.kind !== 'unknown') throw new Error('応答喪失になっていない');
      expect(confirmSaved(store, inquire(store, unknown.pending).snapshot, unknown.pending, '架空担当A', later).kind).toBe('settled');
    } else {
      faults.failMidwayAt = 1; store.failRemove = true;
      const unknown = commit(store, current, op, units);
      if (unknown.kind !== 'unknown') throw new Error('結果不明になっていない');
      store.failRemove = false;
      expect(retry(store, inquire(store, unknown.pending).snapshot, unknown.pending, '架空担当A', later).kind).toBe('saved');
    }
    expect(headOf(store).saveChecks[0]?.resolution.outcome).toBe(outcome);
    expect(store.getItem('fuzzy-stock/pending')).toBeNull();
    return { store, op, units };
  }
  const withoutIndex = (store: Memory, reviews: readonly ConflictReview[]): Snapshot => {
    const head = headOf(store);
    store.data.set(`fuzzy-stock/slot-${store.getItem('fuzzy-stock/head')}`, serialize({ ...head, conflictReviews: reviews,
      ops: Object.fromEntries(Object.entries(head.ops).filter(([id]) => id !== 'op5')) }));
    return headOf(store);
  };

  test.each([['saved', '変更'], ['saved', '欠落'], ['retried', '変更'], ['retried', '欠落']] as const)('%sの解消記録があり索引がない再送は、照合記録が%sされていれば保存済みとしない', async (outcome, how) => {
    const { store, op, units } = await resolved(outcome);
    const tampered = withoutIndex(store, how === '変更' ? [review('op5', 'review-1', '書き換えられた理由')] : []);
    store.writes = [];
    expect(commit(store, tampered, op, units)).toMatchObject({ kind: 'mismatch', reason: expect.stringContaining('照合記録が入力と違う') });
    expect(store.writes).toEqual([]);
  });

  test('索引がなくても照合記録が全文一致していれば、保存済みの解消として返す', async () => {
    const { store, op, units } = await resolved('saved');
    const head = withoutIndex(store, [review()]);
    expect(commit(store, head, op, units)).toMatchObject({ kind: 'recovered' });
  });

  test('全文不一致で拒否しても、障害注入の設定は消費しない', async () => {
    const { store, pending } = await doubleLost();
    const tampered = tamper(store, []);
    faults.loseResponseAt = 1; faults.failMidwayAt = 1;
    expect(confirmSaved(store, tampered, pending, '架空担当A', later)).toEqual({ kind: 'conflict' });
    expect(faults).toEqual({ loseResponseAt: 1, failMidwayAt: 1 });
    faults.loseResponseAt = null; faults.failMidwayAt = null;
  });

  // 未保存の取りやめと記録されていても、同じ操作IDの照合記録または索引が保存先にあれば未保存とは扱わない。
  async function abandonedLost() {
    const { store, current } = seeded();
    const { op, units } = await reviewOp(current, review());
    faults.failMidwayAt = 1; store.failRemove = true;
    const unknown = commit(store, current, op, units);
    if (unknown.kind !== 'unknown') throw new Error('結果不明になっていない');
    store.failRemove = false;
    faults.loseResponseAt = 1;
    const lost = abandon(store, inquire(store, unknown.pending).snapshot, unknown.pending, '架空担当A', later);
    if (lost.kind !== 'unknown') throw new Error('取りやめの応答喪失になっていない');
    return { store, op, units, pending: lost.pending };
  }
  const contradictions = [['内容が違う記録', false, [review('op5', 'review-1', '別の理由')]], ['全文一致する記録', false, [review()]], ['索引と全文一致する記録', true, [review()]]] as const;
  const inject = (store: Memory, withIndex: boolean, reviews: readonly ConflictReview[], opFingerprint: string): Snapshot => {
    const head = headOf(store);
    store.data.set(`fuzzy-stock/slot-${store.getItem('fuzzy-stock/head')}`, serialize({ ...head, conflictReviews: reviews,
      ops: withIndex ? { ...head.ops, op5: { fingerprint: opFingerprint, units: [['op5']] } } : head.ops }));
    return headOf(store);
  };

  test.each(contradictions)('未保存の取りやめの解消記録と、保存先の%s（索引:%s）が矛盾する間は、復旧せずpendingを保持する', async (_, withIndex, reviews) => {
    for (const path of ['load', 'confirmSaved', 'retry', 'abandon'] as const) {
      const { store, op, pending } = await abandonedLost();
      const head = inject(store, withIndex, reviews, op.fingerprint);
      store.writes = [];
      if (path === 'load') expect(load(store), path).toMatchObject({ kind: 'ok', pending: { opId: 'op5' }, recovered: null });
      else expect({ confirmSaved, retry, abandon }[path](store, head, pending, '架空担当A', later), path).toEqual({ kind: 'conflict' });
      expect(store.writes, path).toEqual([]);
      expect(store.getItem('fuzzy-stock/pending'), path).not.toBeNull();
    }
  });

  test.each(contradictions)('取りやめを解消済みの操作IDの再送も、保存先の%s（索引:%s）があれば復旧として返さない', async (_, withIndex, reviews) => {
    const { store, op, units, pending } = await abandonedLost();
    expect(abandon(store, headOf(store), pending, '架空担当A', later)).toMatchObject({ kind: 'recovered' });
    const head = inject(store, withIndex, reviews, op.fingerprint);
    store.writes = [];
    expect(commit(store, head, op, units)).toMatchObject({ kind: 'mismatch' });
    expect(store.writes).toEqual([]);
  });

  test('索引なしで同じ操作IDの照合記録が保存先にある未保存扱いは、取りやめとして記録しない', async () => {
    const { store, current } = seeded();
    const { op, units } = await reviewOp(current, review());
    faults.failMidwayAt = 1; store.failRemove = true;
    const unknown = commit(store, current, op, units);
    if (unknown.kind !== 'unknown') throw new Error('結果不明になっていない');
    store.failRemove = false;
    const head = inject(store, false, [review()], op.fingerprint);
    store.writes = [];
    expect(abandon(store, head, unknown.pending, '架空担当A', later)).toEqual({ kind: 'conflict' });
    expect(store.writes).toEqual([]);
    expect(headOf(store).saveChecks).toEqual([]);
  });

  test('同じ元入力識別子でも別の操作IDの記録が先にあるだけなら、未保存の取りやめは従来どおり復旧できる', async () => {
    const { store, pending } = await abandonedLost();
    const head = headOf(store);
    store.data.set(`fuzzy-stock/slot-${store.getItem('fuzzy-stock/head')}`, serialize({ ...head, conflictReviews: [review('op3', 'review-1')] }));
    expect(load(store)).toMatchObject({ kind: 'ok', pending: null, recovered: { opId: pending.opId, resolution: { outcome: 'abandoned' } } });
  });
});

describe('競合保持: 復旧経路の総当たり（解消記録・索引・照合記録の組合せ）', () => {
  const outcomes = [null, 'saved', 'retried', 'remainderAbandoned', 'abandoned'] as const;
  const indexes = ['none', 'own', 'elsewhere'] as const;
  const stored = ['none', 'match', 'diff', 'otherEvent'] as const;
  const paths = ['load', 'commit', 'confirmSaved', 'retry', 'abandon', 'inquire'] as const;
  // 解消記録が示す状態と、保存先の実際の状態が整合しているか。保存済みの解消は、索引が失われていても全文一致する記録があれば認める。
  const consistent = (outcome: 'saved' | 'retried' | 'remainderAbandoned' | 'abandoned', index: typeof indexes[number], record: typeof stored[number]): boolean =>
    outcome === 'abandoned' ? index === 'none' && (record === 'none' || record === 'otherEvent') : (index === 'own' || index === 'none') && record === 'match';

  async function build(outcome: typeof outcomes[number], index: typeof indexes[number], record: typeof stored[number]) {
    const { store, current } = seeded();
    const { op, units } = await reviewOp(current, review());
    const pending: Pending = { ...op, units, progress: 'saving', unknownSince: later, baseRevision: current.revision };
    const reviews = record === 'match' ? [review()] : record === 'diff' ? [review('op5', 'review-1', '別の理由')] : record === 'otherEvent' ? [review('op3', 'review-1')] : [];
    const check = outcome === null ? [] : [{ opId: 'op5', opLabel: op.opLabel, savedTargets: [], unsavedTargets: [], attempt: attemptOf(pending), openedAt: later,
      resolution: { outcome, actor: '架空担当A', at: later } }];
    const ops = index === 'none' ? {} : { op5: { fingerprint: op.fingerprint, units: [[index === 'own' ? 'op5' : current.ledger.history.at(-1)!.eventId]] } };
    const head = { ...current, ops, conflictReviews: reviews, saveChecks: check, opFloor: 6, lastWriter: index === 'none' ? current.lastWriter : 'op5', revision: current.revision + (index === 'none' ? 0 : 1) };
    store.data.set(`fuzzy-stock/slot-${store.getItem('fuzzy-stock/head')}`, serialize(head));
    store.data.set('fuzzy-stock/pending', serializePending(pending));
    return { store, op, units, pending, head: parse(serialize(head)) };
  }

  test('解消済み・復旧済みと返す経路は、保存先の実状態と整合するときだけである', async () => {
    let claims = 0, blocked = 0;
    for (const outcome of outcomes) for (const index of indexes) for (const record of stored) for (const path of paths) {
      const { store, op, units, pending, head } = await build(outcome, index, record);
      const label = `${outcome}/${index}/${record}/${path}`;
      let claimed: 'saved' | 'abandoned' | 'either' | null = null;
      if (path === 'inquire') {
        // 照会は、索引がなくても保存先に当該操作の照合記録があれば0件と答えず、保存済みと答えるのは復旧と同じ条件のときだけ。
        let saved: number | null = null;
        try { saved = inquire(store, pending).savedUnits; } catch { saved = null; }
        if (saved === 0) expect(record === 'match' || record === 'diff', label).toBe(false);
        if (saved !== null && saved > 0) {
          expect(outcome !== 'abandoned' && record === 'match' && (index === 'own' || (index === 'none' && outcome !== null)), label).toBe(true);
          claims++;
        } else blocked++;
        continue;
      }
      if (path === 'load') {
        const result = load(store);
        if (result.kind === 'ok' && result.pending === null) claimed = outcome === null ? 'saved' : outcome === 'abandoned' ? 'abandoned' : 'saved';
      } else if (path === 'commit') {
        store.data.delete('fuzzy-stock/pending');
        const result = commit(store, head, op, units);
        if (result.kind === 'recovered' || result.kind === 'duplicate') claimed = outcome === 'abandoned' ? 'abandoned' : 'saved';
      } else {
        const result = { confirmSaved, retry, abandon }[path](store, head, pending, '架空担当A', later);
        if (result.kind === 'recovered') claimed = outcome === 'abandoned' ? 'abandoned' : 'saved';
        else if (result.kind === 'settled') claimed = result.outcome === 'abandoned' ? 'abandoned' : result.outcome === 'saved' ? 'saved' : 'either';
        else if (result.kind === 'saved') claimed = 'saved';
      }
      if (claimed === null) { blocked++; continue; }
      claims++;
      // 解消記録なしの未保存の取りやめと、解消記録なしの再試行による新規保存は、保存先に当該操作の記録がない状態から始まる正規の経路。
      if (outcome === null) {
        const freshStart = index === 'none' && (record === 'none' || record === 'otherEvent');
        const fullySaved = index === 'own' && record === 'match';
        expect(freshStart || fullySaved, label).toBe(true);
      } else {
        expect(consistent(outcome, index, record), label).toBe(true);
      }
    }
    // 総当たりが空振りでないこと。
    expect(claims).toBeGreaterThan(10);
    expect(blocked).toBeGreaterThan(50);
  });

  test('索引だけが失われた状態の照会は、保存先に照合記録があるのに保存0件とは答えない', async () => {
    const dropIndex = (store: Memory, reviews: readonly ConflictReview[]) => {
      const head = headOf(store);
      store.data.set(`fuzzy-stock/slot-${store.getItem('fuzzy-stock/head')}`, serialize({ ...head, conflictReviews: reviews,
        ops: Object.fromEntries(Object.entries(head.ops).filter(([id]) => id !== 'op5')) }));
    };
    // 解消記録なし：未保存とは証明できないので、全文一致していても内容違いでも照会を失敗させる。
    for (const reviews of [[review()], [review('op5', 'review-1', '別の理由')]]) {
      const { store, op, units } = await (async () => {
        const seededStore = seeded();
        const built = await reviewOp(seededStore.current, review());
        faults.loseResponseAt = 1;
        const unknown = commit(seededStore.store, seededStore.current, built.op, built.units);
        if (unknown.kind !== 'unknown') throw new Error('応答喪失になっていない');
        return { store: seededStore.store, ...built, pending: unknown.pending };
      })();
      dropIndex(store, reviews);
      const pending: Pending = { ...op, units, progress: 'saving', unknownSince: later, baseRevision: 0 };
      expect(() => inquire(store, pending)).toThrow('索引がない');
    }
    // 整合する保存済みの解消記録があれば、復旧と同じく保存済みと答える。内容違いなら失敗する。
    const base = seeded();
    const built = await reviewOp(base.current, review());
    faults.loseResponseAt = 1;
    const first = commit(base.store, base.current, built.op, built.units);
    if (first.kind !== 'unknown') throw new Error('応答喪失になっていない');
    faults.loseResponseAt = 1;
    const second = confirmSaved(base.store, inquire(base.store, first.pending).snapshot, first.pending, '架空担当A', later);
    if (second.kind !== 'unknown') throw new Error('二度目の応答喪失になっていない');
    const lost = { store: base.store, pending: second.pending };
    dropIndex(lost.store, [review()]);
    expect(inquire(lost.store, lost.pending)).toMatchObject({ savedUnits: 1, total: 1 });
    dropIndex(lost.store, [review('op5', 'review-1', '別の理由')]);
    expect(() => inquire(lost.store, lost.pending)).toThrow('矛盾している');
  });
});
