import { SharedAuthority, parseAuthority, type SharedState } from './shared-authority.ts';
import { addEntry, archiveRows, canonical, hashText, identityKey, openEntry, parseEntry, type ArchiveEntry, type ArchiveRow } from './shared-archive.ts';
import { decodeDraft } from './conflictdraft.ts';
import { load, sameSnapshot, type Snapshot, type StoreLike } from './storage.ts';
import type { ConflictReview } from './conflictrecord.ts';

export async function recoveryRows(authority: SharedAuthority): Promise<ArchiveRow[]> {
  const { state } = await authority.read();
  return state === null ? [] : archiveRows(state.archive);
}
export async function captureShared(authority: SharedAuthority, raw: string): Promise<ArchiveEntry> {
  const entry = await openEntry(raw);
  const seen = await authority.read();
  const reviewed = seen.state?.generation === entry.generation && seen.loaded.kind === 'ok'
    ? seen.loaded.snapshot.conflictReviews.find(review => canonical(review.draft) === canonical(decodeDraft(raw).draft)) : undefined;
  const terminal = reviewed === undefined ? null : await terminalFor(entry, reviewed);
  return authority.transact((state, core) => {
    if (state === null) throw new Error('タブ終了後の入力回収は有効になっていません');
    const existing = state.archive[identityKey(entry)];
    if (existing !== undefined && parseEntry(existing).kind === 'terminal') return { state, value: addEntry(state.archive, entry) };
    const current = load(core);
    if (current.kind !== 'ok' || current.pending !== null) throw new Error('保存先を読めないか、保存結果を確認中のため共有退避に保存できません');
    const complete = reviewed !== undefined && terminal !== null && state.generation === entry.generation && current.kind === 'ok'
      && current.snapshot.conflictReviews.some(review => canonical(review) === canonical(reviewed));
    return { state, value: addEntry(state.archive, complete ? terminal : entry) };
  });
}
async function terminalFor(entry: ArchiveEntry, review: ConflictReview): Promise<ArchiveEntry & { kind: 'terminal' }> {
  return { kind: 'terminal', generation: entry.generation, reviewId: entry.reviewId, hash: entry.hash, disposition: 'review', actor: review.resolution.actor, at: review.resolution.at, proof: await hashText(canonical(review)) };
}
export type Completion = { encoded: string; terminal: ArchiveEntry & { kind: 'terminal' }; review: ConflictReview };
// digest計算はtransactionの外。実行時には検査済みの原文と同じことを再検査する。
export async function prepareCompletion(authority: SharedAuthority, review: ConflictReview | undefined): Promise<Completion[]> {
  if (review === undefined) return [];
  const raw = await authority.inspectRaw();
  if (raw.authority === undefined) return [];
  const state = parseAuthority(raw.authority), rows = await archiveRows(state.archive);
  const result: Completion[] = [];
  for (const row of rows) {
    if (row.kind !== 'valid' || row.entry.kind !== 'open' || row.entry.generation !== state.generation || canonical(row.draft) !== canonical(review.draft)) continue;
    result.push({ encoded: row.encoded, terminal: await terminalFor(row.entry, review), review });
  }
  return result;
}
export function completeReviews(state: SharedState | null, core: StoreLike, completions: Completion[]): void {
  if (state === null || completions.length === 0) return;
  const current = load(core);
  if (current.kind !== 'ok' || current.pending !== null) return;
  for (const completion of completions) {
    if (state.generation !== completion.terminal.generation || !current.snapshot.conflictReviews.some(review => canonical(review) === canonical(completion.review))) continue;
    const key = identityKey(completion.terminal);
    const existing = state.archive[key];
    if (existing !== completion.encoded && existing !== JSON.stringify(completion.terminal)) throw new Error('照合中に共有退避が変わった。元入力を残して確認をやり直してください');
    addEntry(state.archive, completion.terminal);
  }
}
export async function withdrawShared(authority: SharedAuthority, expected: Snapshot, row: ArchiveRow, acknowledged: boolean, actor: string, at: string, generation: string): Promise<void> {
  if (!acknowledged) throw new Error('原文の控えを確認してください');
  if (row.kind !== 'valid' || row.entry.kind !== 'open') throw new Error('有効な未解消の退避を選んでください');
  const terminal: ArchiveEntry = { kind: 'terminal', generation: row.entry.generation, reviewId: row.entry.reviewId, hash: row.entry.hash,
    disposition: 'withdraw', actor, at, proof: await hashText(canonical({ key: row.key, acknowledged: true, disposition: 'withdraw', actor, at })) };
  await authority.transact((state, core) => {
    if (state === null || state.generation !== generation) throw new Error('台帳世代が変わった。確認をやり直してください');
    const current = load(core);
    if (current.kind !== 'ok' || current.pending !== null || !sameSnapshot(current.snapshot, expected)) throw new Error('台帳が変わった。確認をやり直してください');
    const stored = state.archive[row.key];
    if (stored !== row.encoded && stored !== JSON.stringify(terminal)) throw new Error('共有退避の処置が変わった。確認をやり直してください');
    addEntry(state.archive, terminal);
    return { state, value: undefined };
  });
}
