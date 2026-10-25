import * as core from './storage.ts';
import { SharedAuthority, type SharedState } from './shared-authority.ts';
import { completeReviews, prepareCompletion } from './shared-recovery.ts';
import { isReviewOperation, type ConflictReview } from './conflictrecord.ts';
import { replaceWithReceipt, inquireReplacement as inquireReplacementIn } from './shared-backup.ts';
import type { RecoveryData } from './backup.ts';

const snapshots = new WeakMap<core.Snapshot, string | null>();
const pendings = new WeakMap<core.Pending, string | null>();
export const repository = (): SharedAuthority => new SharedAuthority(core.browserStore, window.indexedDB);
export const generationOf = (snapshot: core.Snapshot): string | null => snapshots.get(snapshot) ?? null;
function bind<T>(value: T, generation: string | null): T {
  if (typeof value === 'object' && value !== null) {
    if ('snapshot' in value && typeof value.snapshot === 'object' && value.snapshot !== null) snapshots.set(value.snapshot as core.Snapshot, generation);
    if ('pending' in value && typeof value.pending === 'object' && value.pending !== null) pendings.set(value.pending as core.Pending, generation);
  }
  return value;
}
class GenerationChanged extends Error {}
function requireGeneration(state: SharedState | null, known: string | null | undefined): void {
  if (known === undefined || known !== (state?.generation ?? null)) throw new GenerationChanged('保存方式または台帳世代が変わった。再読込して確認してください');
}
async function run<T>(action: (store: core.StoreLike) => T, expected: readonly (core.Snapshot | core.Pending)[] = [], review?: ConflictReview): Promise<T> {
  const generations = expected.map(value => 'ledger' in value ? snapshots.get(value) : pendings.get(value));
  const completions = await prepareCompletion(repository(), review);
  return repository().transact((state, store) => {
    for (const generation of generations) requireGeneration(state, generation);
    const value = bind(action(store), state?.generation ?? null);
    completeReviews(state, store, completions);
    return { state, value };
  });
}
export async function load(_store: core.StoreLike): Promise<core.LoadResult> {
  try { return await run(store => core.load(store)); }
  catch (error) { return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) }; }
}
export async function commit(_store: core.StoreLike, current: core.Snapshot, op: Parameters<typeof core.commit>[2], units: core.UnitState[]): Promise<core.CommitResult> {
  try { return await run(store => core.commit(store, current, op, units), [current], isReviewOperation(op) ? units[0]?.conflictReviews.at(-1) : undefined); }
  catch (error) {
    // 通知が届く前の初期化・復元も外部更新なので、競合として元入力を退避させる。
    if (error instanceof GenerationChanged) return { kind: 'conflict' };
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error), ...(error instanceof DOMException && error.name === 'QuotaExceededError' ? { quota: true as const } : {}) }; }
}
export const inquire = (_store: core.StoreLike, pending: core.Pending) => run(store => core.inquire(store, pending), [pending]);
const pendingReview = (pending: core.Pending) => isReviewOperation(pending) ? pending.units[0]?.conflictReviews.at(-1) : undefined;
export const retry = (_store: core.StoreLike, current: core.Snapshot, pending: core.Pending, actor: string, at: string) => run(store => core.retry(store, current, pending, actor, at), [current, pending], pendingReview(pending));
export const abandon = (_store: core.StoreLike, current: core.Snapshot, pending: core.Pending, actor: string, at: string) => run(store => core.abandon(store, current, pending, actor, at), [current, pending], pendingReview(pending));
export const confirmSaved = (_store: core.StoreLike, current: core.Snapshot, pending: core.Pending, actor: string, at: string) => run(store => core.confirmSaved(store, current, pending, actor, at), [current, pending], pendingReview(pending));
export async function replace(_store: core.StoreLike, current: core.Snapshot | null, next: core.RecordContents, recovery?: RecoveryData, requestId: string = crypto.randomUUID()): Promise<core.Snapshot> {
  const result = await replaceWithReceipt(repository(), current, next, current === null ? null : snapshots.get(current), false, recovery, requestId);
  snapshots.set(result.snapshot, result.generation);
  return result.snapshot;
}
export async function confirmedUnreadableReset(_store: core.StoreLike, next: core.RecordContents, recovery?: RecoveryData, requestId: string = crypto.randomUUID()): Promise<core.Snapshot> {
  const result = await replaceWithReceipt(repository(), null, next, null, true, recovery, requestId);
  snapshots.set(result.snapshot, result.generation);
  return result.snapshot;
}
export async function inquireReplacement(_store: core.StoreLike, current: core.Snapshot | null, next: core.RecordContents, recovery: RecoveryData | undefined, requestId: string, unreadable: boolean): Promise<core.Snapshot | null> {
  const result = await inquireReplacementIn(repository(), current, next, current === null ? null : snapshots.get(current), unreadable, recovery, requestId);
  if (result === null) return null;
  snapshots.set(result.snapshot, result.generation);
  return result.snapshot;
}
