import { parseExactJson } from '../domain/exact-json.ts';
import { parseConflictDraft, type ConflictDraft } from './conflictrecord.ts';
import type { StoreLike } from './storage.ts';

const key = 'fuzzy-stock/conflict-draft', format = 'fuzzy-stock-conflict-draft', limit = 512 * 1024;
// 保存先自体のgetter（sessionStorageなど）も、操作のtry内で取得する。
export type DraftStoreSource = StoreLike | (() => StoreLike);
export type DraftRead = { kind: 'empty' } | { kind: 'ready'; raw: string; draft: ConflictDraft } |
  { kind: 'unreadable'; raw: string | null; reason: string };
type Failure = { kind: 'failed'; raw: string | null; observedRaw: string | null; reason: string };
export type DraftWrite = { kind: 'retained'; raw: string; draft: ConflictDraft } | (Failure & { draft: ConflictDraft });
export type DraftClear = { kind: 'cleared' } | (Failure & { raw: string });

function storeOf(source: DraftStoreSource): StoreLike { return typeof source === 'function' ? source() : source; }
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : '退避先の操作に失敗した';
}
function requireBudget(raw: string): void {
  if (new TextEncoder().encode(raw).length > limit) throw new Error('退避の包み全体が512KiB上限を超える');
}
export function decodeDraft(raw: string): { draft: ConflictDraft; generation: string } {
  requireBudget(raw);
  const value = parseExactJson(raw);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('退避の包みが不正');
  const o = value as Record<string, unknown>;
  const names = o['version'] === 2 ? ['format', 'version', 'draft', 'generation'] : ['format', 'version', 'draft'];
  if (Object.keys(o).length !== names.length || !names.every(name => Object.hasOwn(o, name)) || o['format'] !== format || (o['version'] !== 1 && o['version'] !== 2)) {
    throw new Error('退避の版・形式・欄が不正');
  }
  const generation = o['version'] === 1 ? 'legacy/unknown' : o['generation'];
  if (typeof generation !== 'string' || !generation.trim() || generation.length > 80) throw new Error('退避の元世代が不正');
  return { draft: parseConflictDraft(o['draft']), generation };
}

export function readDraft(source: DraftStoreSource): DraftRead {
  let raw: string | null = null;
  try {
    raw = storeOf(source).getItem(key);
    return raw === null ? { kind: 'empty' } : { kind: 'ready', raw, draft: decodeDraft(raw).draft };
  } catch (error) { return { kind: 'unreadable', raw, reason: reasonOf(error) }; }
}

export function writeDraft(source: DraftStoreSource, draft: ConflictDraft, generation?: string): DraftWrite {
  let raw: string | null = null, observedRaw: string | null = null, retained = draft;
  try {
    retained = parseConflictDraft(draft);
    raw = JSON.stringify(generation === undefined ? { format, version: 1, draft: retained } : { format, version: 2, draft: retained, generation });
    decodeDraft(raw);
    requireBudget(raw);
    const store = storeOf(source), existing = readDraft(store);
    // observedRawは最後に読めた原文であり、障害後の保存状態を保証しない。
    observedRaw = existing.kind === 'empty' ? null : existing.raw;
    if (existing.kind === 'unreadable') throw new Error(existing.reason);
    if (existing.kind === 'ready') {
      if (JSON.stringify(existing.draft) !== JSON.stringify(retained)) throw new Error('未解消の退避を別の内容で置き換えられない');
      return { kind: 'retained', raw: existing.raw, draft: retained };
    }
    store.setItem(key, raw);
    observedRaw = store.getItem(key);
    if (observedRaw !== raw) throw new Error('退避の読戻しが一致しない');
    return { kind: 'retained', raw, draft: retained };
  } catch (error) { return { kind: 'failed', draft: retained, raw, observedRaw, reason: reasonOf(error) }; }
}

// 前提の検査を通った後、タブ内の同一rawだけを消し、nullの読戻しで確定する。
function removeSame(source: DraftStoreSource, expectedRaw: string, precheck: () => void): DraftClear {
  let observedRaw: string | null = null;
  try {
    precheck();
    const store = storeOf(source);
    observedRaw = store.getItem(key);
    if (observedRaw === null) return { kind: 'cleared' };
    if (observedRaw !== expectedRaw) throw new Error('確認した退避の原文が変わっている');
    store.removeItem(key);
    observedRaw = store.getItem(key);
    if (observedRaw !== null) throw new Error('退避の削除を読戻しで確認できない');
    return { kind: 'cleared' };
  } catch (error) { return { kind: 'failed', raw: expectedRaw, observedRaw, reason: reasonOf(error) }; }
}

// 確定した照合記録との全文一致は呼出側の責任。
export function clearDraft(source: DraftStoreSource, reviewId: string, expectedRaw: string): DraftClear {
  return removeSame(source, expectedRaw, () => { if (decodeDraft(expectedRaw).draft.reviewId !== reviewId) throw new Error('退避の識別子が一致しない'); });
}

function decodable(raw: string): boolean {
  try { decodeDraft(raw); return true; } catch { return false; }
}

// 読めない退避専用。有効な退避は照合の確定経路でしか消さないため、復号できる原文は拒否する。
export function discardUnreadableDraft(source: DraftStoreSource, expectedRaw: string): DraftClear {
  return removeSame(source, expectedRaw, () => { if (decodable(expectedRaw)) throw new Error('有効な退避は破損用の経路で取り下げられない'); });
}
