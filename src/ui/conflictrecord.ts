import { checkTime } from '../domain/ledger.ts';
import { deepFreeze } from '../domain/masters.ts';

export type ConflictOrigin = { kind: 'unsent' } | { kind: 'rejected'; opId: string; attemptedAt: string; reason: 'snapshotChanged' | 'identityCollision' };
type FieldLabel = { name: string; label: string };
export type ConflictField = FieldLabel & (
  { kind: 'text'; value: string } | { kind: 'checkbox'; checked: boolean } |
  { kind: 'select'; value: string; text: string } |
  { kind: 'file'; names: readonly string[]; readState: 'unread' | 'reading' | 'read' | 'failed' }
);
// scanのrawは採用証拠全体の参照文字列。実行可能なScanや確認tokenへ復元しない。
export type ConflictEvidence = { kind: 'needRaw' | 'scan'; raw: string };
export type ConflictDraft = {
  reviewId: string; origin: ConflictOrigin; opKey: string; opLabel: string; actor: string;
  occurredAt: string | null; baseRevision: number; baseLastWriter: string | null; detectedAt: string; detectedReason: string;
  fields: readonly ConflictField[]; readEvidence: readonly ConflictEvidence[]; targets: readonly string[]; unapplied: readonly string[];
};
export type ConflictReview = {
  eventId: string; reviewId: string; draft: ConflictDraft;
  resolution: { outcome: 'reenter' | 'dismiss'; reason: string; actor: string; at: string };
};

function invalid(expected: string): never { throw new Error(`競合記録: ${expected}`); }
function object(value: unknown, keys: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid('オブジェクトが必要');
  const names = keys.split(' ');
  if (Object.keys(value).length !== names.length || !names.every(key => Object.hasOwn(value, key))) return invalid('必須欄の欠落または未知の欄');
  return value as Record<string, unknown>;
}
function text(value: unknown): string { return typeof value === 'string' ? value : invalid('文字列が必要'); }
function nonempty(value: unknown): string {
  const result = text(value);
  return result.trim() ? result : invalid('空でない文字列が必要');
}
function choice<const T extends string>(value: unknown, choices: readonly T[]): T {
  const result = choices.find(candidate => candidate === value);
  return result ?? invalid(`値は${choices.join('/')}のいずれか`);
}
function array<T>(value: unknown, decode: (entry: unknown) => T): T[] {
  return Array.isArray(value) ? Array.from(value, decode) : invalid('配列が必要');
}
function nullableText(value: unknown): string | null { return value === null ? null : text(value); }
function time(value: unknown): string { const result = text(value); checkTime(result, '競合記録'); return result; }
function opId(value: unknown): string {
  const result = text(value);
  return /^op[1-9]\d*$/.test(result) && Number.isSafeInteger(Number(result.slice(2))) ? result : invalid('通常の操作IDが必要');
}
function origin(value: unknown): ConflictOrigin {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return invalid('入力の状態が必要');
  if (value.kind === 'unsent') { object(value, 'kind'); return { kind: 'unsent' }; }
  const o = object(value, 'kind opId attemptedAt reason');
  return { kind: choice(o['kind'], ['rejected']), opId: opId(o['opId']), attemptedAt: time(o['attemptedAt']),
    reason: choice(o['reason'], ['snapshotChanged', 'identityCollision']) };
}
function field(value: unknown): ConflictField {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return invalid('入力欄の種別が必要');
  const kind = choice(value.kind, ['text', 'checkbox', 'select', 'file']);
  const extras = { text: 'value', checkbox: 'checked', select: 'value text', file: 'names readState' };
  const o = object(value, `kind name label ${extras[kind]}`), label = { name: text(o['name']), label: text(o['label']) };
  switch (kind) {
    case 'text': return { kind, ...label, value: text(o['value']) };
    case 'checkbox': return { kind, ...label, checked: typeof o['checked'] === 'boolean' ? o['checked'] : invalid('真偽値が必要') };
    case 'select': return { kind, ...label, value: text(o['value']), text: text(o['text']) };
    case 'file': return { kind, ...label, names: array(o['names'], text), readState: choice(o['readState'], ['unread', 'reading', 'read', 'failed']) };
  }
}
function evidence(value: unknown): ConflictEvidence {
  const o = object(value, 'kind raw');
  return { kind: choice(o['kind'], ['needRaw', 'scan']), raw: text(o['raw']) };
}

export function parseConflictDraft(value: unknown): ConflictDraft {
  const o = object(value, 'reviewId origin opKey opLabel actor occurredAt baseRevision baseLastWriter detectedAt detectedReason fields readEvidence targets unapplied');
  const revision = o['baseRevision'];
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) return invalid('基準版は0以上の安全な整数が必要');
  return deepFreeze({ reviewId: nonempty(o['reviewId']), origin: origin(o['origin']), opKey: nonempty(o['opKey']), opLabel: nonempty(o['opLabel']),
    actor: text(o['actor']), occurredAt: nullableText(o['occurredAt']), baseRevision: revision, baseLastWriter: nullableText(o['baseLastWriter']),
    detectedAt: time(o['detectedAt']), detectedReason: nonempty(o['detectedReason']), fields: array(o['fields'], field),
    readEvidence: array(o['readEvidence'], evidence), targets: array(o['targets'], text), unapplied: array(o['unapplied'], text) });
}
export const reviewLimits = { one: 64 * 1024, total: 256 * 1024 } as const;
const bytesOf = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;
function requireBudget(value: unknown, limit: number, label: string): void {
  if (bytesOf(value) > limit) return invalid(`${label}上限を超える`);
}
// 確定前に、保存する照合記録の一件と第三列全体の使用量を、復号時の検査と同じ直列化で測る。candidateは正規の型順（eventId・reviewId・draft・resolution）で渡す。
export function reviewUsage(existing: readonly ConflictReview[], candidate: ConflictReview): { one: number; total: number; over: boolean } {
  const one = bytesOf(candidate), total = bytesOf([...existing, candidate]);
  return { one, total, over: one > reviewLimits.one || total > reviewLimits.total };
}
export function parseConflictReview(value: unknown): ConflictReview {
  const o = object(value, 'eventId reviewId draft resolution'), r = object(o['resolution'], 'outcome reason actor at');
  const draft = parseConflictDraft(o['draft']), reviewId = nonempty(o['reviewId']);
  if (draft.reviewId !== reviewId) return invalid('元入力の識別子と一致しない');
  const review: ConflictReview = { eventId: opId(o['eventId']), reviewId, draft,
    resolution: { outcome: choice(r['outcome'], ['reenter', 'dismiss']), reason: nonempty(r['reason']), actor: nonempty(r['actor']), at: time(r['at']) } };
  requireBudget(review, reviewLimits.one, '一件64KiB');
  return deepFreeze(review);
}
export function parseConflictReviews(value: unknown): readonly ConflictReview[] {
  const reviews = array(value, parseConflictReview), ids = new Set<string>(), events = new Set<string>();
  for (const review of reviews) {
    if (ids.has(review.reviewId) || events.has(review.eventId)) return invalid('元入力または操作IDの重複');
    ids.add(review.reviewId); events.add(review.eventId);
  }
  requireBudget(reviews, reviewLimits.total, '総量256KiB');
  return deepFreeze(reviews);
}
// 照合結果を保存する通常の保存単位（Pending）の固定欄。値は元入力・理由の全文を複製せず、識別子と結果だけにする。
export const reviewOpLabel = '更新競合の照合結果';
const fingerprintPattern = /^conflict-review-v1:sha256:[0-9a-f]{64}$/;
export const isReviewFingerprint = (text: string): boolean => fingerprintPattern.test(text);
// 呼出側が名乗るラベルだけでなく、全文digestのfingerprintという本来の性質でも照合結果の保存と判定する。ラベルを通常操作へ差し替えても全文照合を避けられない。
export const isReviewOperation = (op: { opLabel: string; fingerprint: string }): boolean => op.opLabel === reviewOpLabel || isReviewFingerprint(op.fingerprint);
export function reviewPendingValues(review: ConflictReview): { reviewId: string; outcome: string } {
  return { reviewId: review.reviewId, outcome: review.resolution.outcome };
}
// 検査済みの正規の型順でserializeした全文と固定opLabelのSHA-256。省略した表示値だけで同一性を決めない。計算できないときは例外にして送信しない。
export async function conflictReviewFingerprint(review: ConflictReview): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) throw new Error('SHA-256を計算できない（Web Cryptoを使えない）');
  const bytes = new TextEncoder().encode(JSON.stringify([reviewOpLabel, parseConflictReview(review)]));
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
  return `conflict-review-v1:sha256:${Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
export function appendConflictReview(existing: readonly ConflictReview[], review: ConflictReview): readonly ConflictReview[] {
  return parseConflictReviews([...existing, review]);
}
