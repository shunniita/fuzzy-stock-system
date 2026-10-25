import { parseExactJson } from '../domain/exact-json.ts';
import { decodeDraft } from './conflictdraft.ts';
import type { ConflictDraft } from './conflictrecord.ts';
import { checkTime } from '../domain/ledger.ts';

export type Identity = { generation: string; reviewId: string; hash: string };
export type ArchiveEntry = Identity & ({ kind: 'open'; raw: string } | { kind: 'terminal'; disposition: 'review' | 'withdraw'; actor: string; at: string; proof: string });
export type ArchiveRow = { key: string; encoded: string } & (
  { kind: 'valid'; entry: ArchiveEntry; draft: ConflictDraft | null } | { kind: 'broken'; reason: string });
export const archiveLimits = { count: 64, bytes: 8 * 1024 * 1024, terminal: 8 * 1024 } as const;
export const bytesOf = (text: string): number => new TextEncoder().encode(text).length;
export const identityKey = (identity: Identity): string => JSON.stringify([identity.generation, identity.reviewId, identity.hash]);

// JSONのキー順だけを正規化する。空白・配列順・文字列の表記は保持する。
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}
export async function hashText(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function openEntry(raw: string): Promise<ArchiveEntry & { kind: 'open' }> {
  const { draft, generation } = decodeDraft(raw);
  const hash = await hashText(canonical(parseExactJson(raw)));
  const entry = { kind: 'open' as const, generation, reviewId: draft.reviewId, hash, raw };
  if (bytesOf(identityKey(entry)) > 4096) throw new Error('元入力の識別子が大きすぎる');
  return entry;
}
function text(o: Record<string, unknown>, key: string): string {
  const value = o[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`共有退避の${key}が不正`);
  return value;
}
export function parseEntry(encoded: string): ArchiveEntry {
  const value = parseExactJson(encoded);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('共有退避の包みが不正');
  const o = Object.fromEntries(Object.entries(value));
  const names = o['kind'] === 'open' ? ['kind', 'generation', 'reviewId', 'hash', 'raw'] : ['kind', 'generation', 'reviewId', 'hash', 'disposition', 'actor', 'at', 'proof'];
  if (Object.keys(o).length !== names.length || !names.every(name => Object.hasOwn(o, name))) throw new Error('共有退避の欄が不正');
  const id = { generation: text(o, 'generation'), reviewId: text(o, 'reviewId'), hash: text(o, 'hash') };
  if (id.generation.length > 80 || !/^[0-9a-f]{64}$/.test(id.hash) || bytesOf(identityKey(id)) > 4096) throw new Error('共有退避の識別子が不正');
  if (o['kind'] === 'open') {
    const raw = text(o, 'raw'), decoded = decodeDraft(raw);
    if (decoded.generation !== id.generation || decoded.draft.reviewId !== id.reviewId) throw new Error('元入力の世代・識別子が一致しない');
    return { kind: 'open', ...id, raw };
  }
  const disposition = o['disposition'];
  if (o['kind'] !== 'terminal' || (disposition !== 'review' && disposition !== 'withdraw') || bytesOf(encoded) > archiveLimits.terminal) throw new Error('共有退避の終端が不正');
  const proof = text(o, 'proof');
  const actor = text(o, 'actor'), at = text(o, 'at');
  checkTime(at, '取下げ日時');
  if (!/^[0-9a-f]{64}$/.test(proof)) throw new Error('処置の検査値が不正');
  return { kind: 'terminal', ...id, disposition, actor, at, proof };
}
export async function archiveRow(key: string, encoded: string): Promise<ArchiveRow> {
  try {
    const entry = parseEntry(encoded);
    if (identityKey(entry) !== key) throw new Error('共有退避のキーが一致しない');
    if (entry.kind === 'open' && (await openEntry(entry.raw)).hash !== entry.hash) throw new Error('元入力の検査値が一致しない');
    return { kind: 'valid', key, encoded, entry, draft: entry.kind === 'open' ? decodeDraft(entry.raw).draft : null };
  } catch (error) { return { kind: 'broken', key, encoded, reason: error instanceof Error ? error.message : String(error) }; }
}
export async function archiveRows(archive: Record<string, string>): Promise<ArchiveRow[]> {
  return Promise.all(Object.entries(archive).map(([key, encoded]) => archiveRow(key, encoded)));
}
export function requireArchiveBudget(archive: Record<string, string>): void {
  const entries = Object.entries(archive);
  const logical = entries.reduce((sum, [key, raw]) => sum + Math.max(archiveLimits.terminal, bytesOf(JSON.stringify([key, raw]))), 2);
  if (entries.length > archiveLimits.count || logical > archiveLimits.bytes || bytesOf(JSON.stringify(archive)) > archiveLimits.bytes) throw new Error('共有退避の保管上限に達した。元入力を控えてください');
}
export function addEntry(archive: Record<string, string>, entry: ArchiveEntry): ArchiveEntry {
  parseEntry(JSON.stringify(entry));
  const key = identityKey(entry), prior = archive[key];
  if (prior !== undefined) {
    const stored = parseEntry(prior);
    if (identityKey(stored) !== key) throw new Error('既存の退避が壊れている');
    if (stored.kind === 'terminal') {
      if (entry.kind === 'terminal' && canonical(stored) !== canonical(entry)) throw new Error('同じ元入力に異なる処置がある');
      return stored;
    }
    if (entry.kind === 'open') {
      if (canonical(parseExactJson(stored.raw)) !== canonical(parseExactJson(entry.raw))) throw new Error('同じ検査値の元入力が一致しない');
      return stored;
    }
  }
  const next = { ...archive, [key]: JSON.stringify(entry) };
  requireArchiveBudget(next);
  archive[key] = next[key]!;
  return entry;
}
export function unionArchive(current: Record<string, string>, imported: Record<string, string>): Record<string, string> {
  const next = { ...current };
  for (const [key, raw] of Object.entries(imported)) {
    const entry = parseEntry(raw);
    if (identityKey(entry) !== key) throw new Error('取込退避のキーが不正');
    addEntry(next, entry);
  }
  requireArchiveBudget(next);
  return next;
}
