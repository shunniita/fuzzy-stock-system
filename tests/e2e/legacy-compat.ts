import { expect, type Page } from '@playwright/test';
import { applyNeedImport, previewNeedImport } from '../../src/domain/need-import.ts';
import { changeMasters, type Meta } from '../../src/domain/ledger.ts';
import { type ConflictDraft } from '../../src/ui/conflictrecord.ts';
import { decodeSnapshot } from '../../src/ui/storageparse.ts';
import { serialize, serializePending, type Pending, type Snapshot } from '../../src/ui/storage.ts';
import { waitForApp } from './helpers.ts';

export const legacyMeta = (eventId: string): Meta => ({ eventId, actor: '架空担当A', occurredAt: '2026-10-14T09:00:00+09:00', recordedAt: '2026-10-14T10:00:00+09:00' });
export async function savedSnapshot(page: Page): Promise<Snapshot> {
  await waitForApp(page);
  const raw = await page.evaluate(() => localStorage.getItem(`fuzzy-stock/slot-${localStorage.getItem('fuzzy-stock/head')}`));
  if (raw === null) throw Error('保存なし');
  return decodeSnapshot(JSON.parse(raw));
}

// 旧版が保存した写しとして、製品のcodecを通したデータを読み込ませる。
export async function installSnapshot(page: Page, snapshot: Snapshot, pending?: Pending): Promise<void> {
  const raw = serialize(snapshot);
  decodeSnapshot(JSON.parse(raw));
  await page.evaluate(({ raw, pending }) => {
    localStorage.setItem('fuzzy-stock/slot-A', raw);
    localStorage.setItem('fuzzy-stock/head', 'A');
    localStorage.removeItem('fuzzy-stock/slot-B');
    if (pending === null) localStorage.removeItem('fuzzy-stock/pending');
    else localStorage.setItem('fuzzy-stock/pending', pending);
  }, { raw, pending: pending === undefined ? null : serializePending(pending) });
  await page.reload();
  await waitForApp(page);
}

export function withLegacyImport(snapshot: Snapshot, raw: string, id: string): Snapshot {
  const supply = applyNeedImport(snapshot.supply, snapshot.ledger.masters, legacyMeta(id), raw, previewNeedImport(snapshot.supply, snapshot.ledger.masters, raw).token);
  return { ...snapshot, supply };
}

export function withLegacyTrial(snapshot: Snapshot, id: string, target = 'X', trial = true): Snapshot {
  const ledger = changeMasters(snapshot.ledger, legacyMeta(id), trial
    ? { action: 'trial', type: 'item', id: target, reason: '旧版の試行変更', trial: true, review: { quantities: '既存数量を確認', requests: '未完了依頼を確認', corrections: '訂正手順を確認', restore: '復元手順を確認\n元の確認文', initial: '不明は実数にしない' } }
    : { action: 'trial', type: 'item', id: target, reason: '旧版の試行変更', trial: false, review: null });
  return { ...snapshot, ledger };
}

export function legacyPending(before: Snapshot, after: Snapshot, opLabel: string): Pending {
  return { progress: 'saving', unknownSince: '2026-10-14T10:00:00+09:00', savingSince: '2026-10-14T10:00:00+09:00', baseRevision: before.revision,
    opId: `op${before.opFloor}`, opLabel, fingerprint: '旧版の入力原文', values: { '確認文': '復元手順を確認\n元の確認文' }, actor: '架空担当A', startedAt: '2026-10-14T10:00:00+09:00',
    units: [{ ledger: after.ledger, supply: after.supply, conflictReviews: after.conflictReviews, targets: [] }] };
}

export async function installLegacyFileDraft(page: Page, readState: 'read' | 'reading' | 'failed', raw: string, name = '架空必要明細.json'): Promise<void> {
  const snapshot = await savedSnapshot(page);
  const draft: ConflictDraft = { reviewId: `legacy-file-${readState}`, origin: { kind: 'unsent' }, opKey: 'needImport', opLabel: '必要明細の再取込（架空文書）', actor: '架空担当A',
    occurredAt: null, baseRevision: snapshot.revision, baseLastWriter: snapshot.lastWriter, detectedAt: '2026-10-14T10:00:00+09:00', detectedReason: '旧版の更新競合',
    fields: [{ kind: 'file', name: 'needFile', label: '架空文書を選ぶ', names: [name], readState }],
    readEvidence: readState === 'read' ? [{ kind: 'needRaw', raw }] : [], targets: [], unapplied: [] };
  await page.evaluate(draft => sessionStorage.setItem('fuzzy-stock/conflict-draft', JSON.stringify({ format: 'fuzzy-stock-conflict-draft', version: 1, draft })), draft);
  await page.reload(); await waitForApp(page);
  await expect(page.locator('#conflict')).toContainText('未解消');
}
