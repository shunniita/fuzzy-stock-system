import { archiveRows, bytesOf, canonical, hashText, unionArchive } from './shared-archive.ts';
import { backupTextOf, type RecoveryData } from './backup.ts';
import { coreValues, memoryStore, parseAuthority, type SharedAuthority, type SharedState } from './shared-authority.ts';
import * as core from './storage.ts';

type Receipt = { requestHash: string; generation: string; snapshotHash: string };
export function parseReceipt(raw: string): Receipt {
  if (bytesOf(raw) > 2048) throw new Error('処置記録が大きすぎる');
  const value: unknown = JSON.parse(raw);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('処置記録が不正');
  const o = Object.fromEntries(Object.entries(value));
  if (Object.keys(o).sort().join() !== 'generation,requestHash,snapshotHash' || typeof o['generation'] !== 'string' || !o['generation'].trim() || o['generation'].length > 80
    || typeof o['requestHash'] !== 'string' || !/^[0-9a-f]{64}$/.test(o['requestHash']) || typeof o['snapshotHash'] !== 'string' || !/^[0-9a-f]{64}$/.test(o['snapshotHash'])) throw new Error('処置記録の欄が不正');
  return { generation: o['generation'], requestHash: o['requestHash'], snapshotHash: o['snapshotHash'] };
}
export function requireReceipts(receipts: Record<string, string>): void {
  if (Object.keys(receipts).length > 4096 || bytesOf(JSON.stringify(receipts)) > 8 * 1024 * 1024) throw new Error('処置記録の保管上限に達した');
  for (const [key, value] of Object.entries(receipts)) { if (!key.trim() || key.length > 80) throw new Error('処置IDが不正'); parseReceipt(value); }
}
export async function validateRecovery(recovery: RecoveryData): Promise<void> {
  const rows = await archiveRows(recovery.archive);
  if (rows.some(row => row.kind === 'broken')) throw new Error('退避の原文・世代・検査値が不正なバックアップは復元できません');
  requireReceipts(recovery.receipts);
}
export function mergeRecovery(state: SharedState, recovery: RecoveryData): void {
  const receipts = { ...state.receipts };
  for (const [key, value] of Object.entries(recovery.receipts)) {
    if (receipts[key] !== undefined && canonical(parseReceipt(receipts[key])) !== canonical(parseReceipt(value))) throw new Error('同じ要求IDに異なる処置記録がある');
    receipts[key] = value;
  }
  requireReceipts(receipts);
  state.archive = unionArchive(state.archive, recovery.archive); state.receipts = receipts;
}
export async function sharedBackupText(authority: SharedAuthority, expected: core.Snapshot, at: string): Promise<string> {
  // inspectRawは単一readonly transaction。loadの復旧書込みは複製にだけ適用し、変化したら出力を断る。
  const raw = await authority.inspectRaw();
  if (raw.authority === undefined) return backupTextOf(expected, at);
  const state = parseAuthority(raw.authority);
  if (JSON.stringify(raw.legacy) !== JSON.stringify(state.legacy)) throw new Error('旧版の資料が変わっている。両方の原資料を控えてください');
  const store = memoryStore(state.core), loaded = core.load(store);
  if (loaded.kind !== 'ok' || loaded.pending !== null || !core.sameSnapshot(loaded.snapshot, expected) || JSON.stringify(coreValues(store)) !== JSON.stringify(state.core)) throw new Error('保存先が変わったか保存結果を確認中です。再読込してください');
  const recovery = { generation: state.generation, archive: state.archive, receipts: state.receipts };
  await validateRecovery(recovery);
  return backupTextOf(loaded.snapshot, at, recovery);
}
export async function replacementRequestHash(current: core.Snapshot | null, next: core.RecordContents, generation: string | null, recovery?: RecoveryData, unreadable = false): Promise<string> {
  const contents = core.serialize({ ...core.initial(next.ledger, next.supply), ...next });
  return hashText(canonical({ before: current === null ? null : core.serialize(current), contents, generation, recovery: recovery ?? null, unreadable }));
}

export async function inquireReplacement(authority: SharedAuthority, current: core.Snapshot | null, next: core.RecordContents,
  expectedGeneration: string | null | undefined, unreadable: boolean, recovery: RecoveryData | undefined, requestId: string): Promise<{ snapshot: core.Snapshot; generation: string } | null> {
  const raw = await authority.inspectRaw();
  if (raw.authority === undefined) return null;
  const before = parseAuthority(raw.authority), prior = before.receipts[requestId];
  if (prior === undefined) return null;
  const receipt = parseReceipt(prior), loaded = core.load(memoryStore(before.core));
  const requestHash = await replacementRequestHash(current, next, expectedGeneration ?? null, recovery, unreadable);
  if (receipt.requestHash !== requestHash) throw new Error('同じ要求IDの置換内容が異なる');
  if (loaded.kind !== 'ok' || loaded.pending !== null || receipt.generation !== before.generation || receipt.snapshotHash !== await hashText(core.serialize(loaded.snapshot))) throw new Error('この処置は保存済みです。その後の記録を再読込してください');
  return authority.transact(state => {
    if (state === null || state.generation !== before.generation || state.receipts[requestId] !== prior || JSON.stringify(state.core) !== JSON.stringify(before.core)) throw new Error('処置照会中に保存先が変わった');
    return { state, value: { snapshot: loaded.snapshot, generation: state.generation } };
  });
}

export async function replaceWithReceipt(authority: SharedAuthority, current: core.Snapshot | null, next: core.RecordContents,
  expectedGeneration: string | null | undefined, unreadable: boolean, recovery: RecoveryData | undefined, requestId: string): Promise<{ snapshot: core.Snapshot; generation: string | null }> {
  if (recovery !== undefined) await validateRecovery(recovery);
  const requestHash = await replacementRequestHash(current, next, expectedGeneration ?? null, recovery, unreadable);
  const raw = await authority.inspectRaw();
  const before = raw.authority === undefined ? null : parseAuthority(raw.authority);
  if (before === null) {
    if (recovery !== undefined) throw new Error('このバックアップを復元する前に、タブ終了後の入力回収を有効にしてください');
    return authority.transact((state, store) => {
      if (state !== null || expectedGeneration !== null) throw new Error('保存方式が変わった。再読込してください');
      const beforeLoad = core.load(store);
      if (current !== null && (beforeLoad.kind !== 'ok' || !core.sameSnapshot(beforeLoad.snapshot, current))) throw new Error('保存先の状態が変わっている');
      const snapshot = unreadable ? core.confirmedUnreadableReset(store, next) : core.replace(store, current, next);
      return { state, value: { snapshot, generation: null } };
    });
  }
  const prior = before.receipts[requestId];
  if (prior !== undefined) {
    const known = await inquireReplacement(authority, current, next, expectedGeneration, unreadable, recovery, requestId);
    if (known === null) throw new Error('保存済みの処置記録を確認できない');
    return known;
  }
  if (current !== null && expectedGeneration !== before.generation) throw new Error('台帳世代が変わった。再読込してください');
  const copy = memoryStore(before.core);
  const beforeLoad = core.load(copy);
  if (current !== null && (beforeLoad.kind !== 'ok' || !core.sameSnapshot(beforeLoad.snapshot, current))) throw new Error('置換の確認後に保存先が変わった');
  const preview = unreadable ? core.confirmedUnreadableReset(copy, next) : core.replace(copy, current, next);
  const previewText = core.serialize(preview), generation = crypto.randomUUID();
  const receipt = JSON.stringify({ requestHash, generation, snapshotHash: await hashText(previewText) });
  return authority.transact((state, store) => {
    if (state === null || state.generation !== before.generation || JSON.stringify(state.core) !== JSON.stringify(before.core)) throw new Error('置換中に保存先が変わった。再読込してください');
    if (state.receipts[requestId] !== undefined) throw new Error('同じ処置が保存された。結果を再照会してください');
    if (recovery !== undefined) mergeRecovery(state, recovery);
    if (state.receipts[requestId] !== undefined) throw new Error('取込資料に今回の要求IDが含まれている。元の資料を保持して中止した');
    const snapshot = unreadable ? core.confirmedUnreadableReset(store, next) : core.replace(store, current, next);
    if (core.serialize(snapshot) !== previewText) throw new Error('置換結果が確認した内容と一致しない');
    state.generation = generation; state.receipts[requestId] = receipt;
    requireReceipts(state.receipts);
    return { state, value: { snapshot, generation } };
  });
}
