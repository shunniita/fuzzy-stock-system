import { parseExactJson } from '../domain/exact-json.ts';
import type { Snapshot } from './storage.ts';
import { parse, serialize } from './storage.ts';
import { requestProgressOf } from '../domain/supply.ts';
import { requireArchiveBudget } from './shared-archive.ts';

export type RecoveryData = { generation: string; archive: Record<string, string>; receipts: Record<string, string> };
export function parseRecovery(raw: string): RecoveryData {
  const value = parseExactJson(raw);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('回収資料の包みが不正');
  const o = Object.fromEntries(Object.entries(value));
  if (Object.keys(o).sort().join() !== 'archive,generation,receipts' || typeof o['generation'] !== 'string' || !o['generation'].trim() || o['generation'].length > 80) throw new Error('回収資料の世代・欄が不正');
  const strings = (value: unknown): Record<string, string> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('回収資料の一覧が不正');
    const result: Record<string, string> = Object.create(null);
    for (const [key, raw] of Object.entries(value)) { if (typeof raw !== 'string') throw new Error('回収資料の原文が不正'); result[key] = raw; }
    return result;
  };
  const archive = strings(o['archive']), receipts = strings(o['receipts']);
  requireArchiveBudget(archive);
  return { generation: o['generation'], archive, receipts };
}

export type RecordCounts = { lots: number; records: number; openRequests: number };
export type BackupRead =
  | { kind: 'ok'; snapshot: Snapshot; createdAt: string; counts: RecordCounts; recovery?: RecoveryData }
  | { kind: 'viewOutput' }
  | { kind: 'newer' }
  | { kind: 'unreadable'; reason: string };

export const maxBackupBytes = 64 * 1024 * 1024;
const format = 'fuzzy-stock-backup';
const envelopeVersion = 2;
const notice = 'fuzzy-stock-system 復元用バックアップ。閲覧用ではない。表計算ソフトなどで開いて保存し直すと復元に使えなくなる。';
const createdPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\+09:00$/;

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const hex8 = (n: number): string => n.toString(16).padStart(8, '0');
// 検査値は作成日時と写しの文字列に対して取る。包みの空白の整形や先頭のBOMは記録を変えないので、検査の対象にしない。
const checksumOf = (createdAt: string, snapshotText: string): string => hex8(crc32(new TextEncoder().encode(`${createdAt}\n${snapshotText}`)));

// 手元一覧と同じ数え方。依頼の未完了は、取消でなく、依頼数から届いた数の和を引いて残る依頼（dateStatusOfと同じ定義）。
export function recordCountsOf(state: Pick<Snapshot, 'ledger' | 'supply'>): RecordCounts {
  return {
    lots: Object.values(state.ledger.lots).filter(lot => lot.mergedInto === null).length,
    records: state.ledger.history.length + state.supply.log.length,
    openRequests: Object.values(state.supply.requests).filter(r => (requestProgressOf(state.ledger.masters, r).outstanding ?? 0) > 0).length,
  };
}

function stamp(createdAt: string): string {
  const m = createdPattern.exec(createdAt);
  if (m === null) throw new Error(`作成日時が日本時間の形ではない：${createdAt}`);
  return `${m[1]}${m[2]}${m[3]}-${m[4]}${m[5]}${m[6]}`;
}

export const backupFileName = (createdAt: string): string => `fuzzy-stock-system_復元用バックアップ_${stamp(createdAt)}.json`;
export const viewFileName = (createdAt: string): string => `fuzzy-stock-system_閲覧用_復元不可_${stamp(createdAt)}.xlsx`;

export function backupTextOf(snapshot: Snapshot, createdAt: string, recovery?: RecoveryData): string {
  stamp(createdAt);
  const text = serialize(snapshot);
  const extra = recovery === undefined ? undefined : JSON.stringify(recovery);
  if (extra !== undefined) parseRecovery(extra);
  const output = JSON.stringify({ notice, format, version: extra === undefined ? 1 : 2, createdAt, crc32: checksumOf(createdAt, text + (extra === undefined ? '' : `\n${extra}`)), snapshot: text, ...(extra === undefined ? {} : { recovery: extra }) });
  if (new TextEncoder().encode(output).length > maxBackupBytes) throw new Error('バックアップ全体が64MiBを超える');
  return output;
}

const notBackup: BackupRead = { kind: 'unreadable', reason: 'このソフトの復元用バックアップではない（形式や欄が違う）' };
const envelopeKeys = ['createdAt', 'crc32', 'format', 'notice', 'snapshot', 'version'].sort().join();

// 判定は、大きさ→閲覧用の出力→壊れた→このソフトのものでない→新しい版→作成時から変わった→記録の検査、の順に行い、例外は投げない。
export function readBackup(bytes: Uint8Array): BackupRead {
  if (bytes.length > maxBackupBytes) return { kind: 'unreadable', reason: 'ファイルが大きすぎる（64MiBを超える）' };
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return { kind: 'viewOutput' };
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return { kind: 'unreadable', reason: 'UTF-8の文字として読めない（このファイルはバックアップではない、または壊れている）' }; }
  let value: unknown;
  try { value = parseExactJson(text); }
  catch { return { kind: 'unreadable', reason: '壊れている、または途中で切れている（JSONとして読めない）' }; }
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Reflect.get(value, 'format') !== format) return notBackup;
  const version: unknown = Reflect.get(value, 'version');
  // 新しい版は欄が増えているかもしれないので、欄の検査より前に版で判断する。
  if (typeof version === 'number' && Number.isInteger(version) && version > envelopeVersion) return { kind: 'newer' };
  const { createdAt, crc32: checksum, snapshot: snapshotText, notice: noticeText }: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  const recoveryText: unknown = Reflect.get(value, 'recovery');
  const expectedKeys = version === 2 ? ['createdAt', 'crc32', 'format', 'notice', 'recovery', 'snapshot', 'version'].sort().join() : envelopeKeys;
  if ((version !== 1 && version !== 2) || Object.keys(value).sort().join() !== expectedKeys || (version === 2 && typeof recoveryText !== 'string') || typeof noticeText !== 'string'
    || typeof createdAt !== 'string' || !createdPattern.test(createdAt) || typeof checksum !== 'string' || !/^[0-9a-f]{8}$/.test(checksum)
    || typeof snapshotText !== 'string') return notBackup;
  if (checksumOf(createdAt, snapshotText + (version === 2 ? `\n${String(recoveryText)}` : '')) !== checksum) {
    return { kind: 'unreadable', reason: '作成時から変わっている（検査値が合わない）。表計算ソフトなどで開いて保存し直したファイルは、復元に使えない' };
  }
  let inner: unknown;
  try { inner = parseExactJson(snapshotText); }
  catch { return { kind: 'unreadable', reason: '記録の検査を通らない（記録がJSONとして読めない）' }; }
  const innerVersion: unknown = typeof inner === 'object' && inner !== null ? Reflect.get(inner, 'version') : undefined;
  if (typeof innerVersion === 'number' && Number.isInteger(innerVersion) && innerVersion > 11) return { kind: 'newer' };
  try {
    const snapshot = parse(snapshotText);
    return { kind: 'ok', snapshot, createdAt, counts: recordCountsOf(snapshot), ...(typeof recoveryText === 'string' ? { recovery: parseRecovery(recoveryText) } : {}) };
  } catch (error) {
    return { kind: 'unreadable', reason: `記録の検査を通らない：${error instanceof Error ? error.message : String(error)}` };
  }
}
