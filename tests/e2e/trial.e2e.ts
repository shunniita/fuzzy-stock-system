import { expect, test } from '@playwright/test';
import * as XLSX from 'xlsx';
import { backupButton, downloadVia, exportButton, goTo, lot, pickFile, recorded, startEmpty } from './helpers.ts';
import { installSnapshot, legacyPending, savedSnapshot, withLegacyTrial } from './legacy-compat.ts';
import { type ConflictDraft } from '../../src/ui/conflictrecord.ts';
import { draftOf, readyToSave } from './conflict-helpers.ts';

test('旧試行対象: 対象外の保存値・五確認の当時履歴を読込み、出力とバックアップ復元で保持する', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('X-2', 'X', 'S1', 'label', '2'));
  const before = await savedSnapshot(page);
  const legacy = withLegacyTrial(before, 'legacy-trial');
  await installSnapshot(page, legacy);
  expect(await savedSnapshot(page)).toEqual(legacy);
  expect(legacy.ledger.masters.locations['O']?.trial).toBe(false);
  await goTo(page, 'masters');
  await page.locator('[name=master-history]').selectOption('item:X');
  await expect(page.locator('#masters')).toContainText('対象外 → 試行対象');
  await goTo(page, 'issues');
  for (const text of ['既存数量を確認', '未完了依頼を確認', '訂正手順を確認', '復元手順を確認', '不明は実数にしない']) await expect(page.locator('#history')).toContainText(text);
  const book = XLSX.read((await downloadVia(page, exportButton)).bytes, { type: 'array' });
  const rows = XLSX.utils.sheet_to_json<string[]>(book.Sheets['台帳の履歴']!, { header: 1, raw: true });
  expect(JSON.stringify(rows)).toContain('元の確認文');
  const backup = await downloadVia(page, backupButton);
  await installSnapshot(page, before);
  await pickFile(page, backup.path);
  const confirm = page.getByRole('region', { name: '復元の確認' });
  await confirm.getByRole('button', { name: '復元する', exact: true }).click();
  await expect(confirm).toBeHidden(); await page.reload();
  const restored = await savedSnapshot(page);
  expect(restored.ledger).toEqual(legacy.ledger); expect(restored.supply).toEqual(legacy.supply);
});

for (const [saved, action] of [[false, 'retry'], [true, 'retry'], [true, 'confirm']] as const) test(`旧試行変更pending: 保存済み=${saved}を照会・${action}・再読込して一回だけ変更する`, async ({ page }) => {
  await startEmpty(page);
  const before = await savedSnapshot(page), id = `op${before.opFloor}`;
  const after = withLegacyTrial(before, id);
  const pending = legacyPending(before, after, 'マスタ：試行対象の変更');
  const state = saved ? { ...after, revision: before.revision + 1, lastWriter: id, opFloor: before.opFloor + 1, ops: { ...before.ops, [id]: { fingerprint: pending.fingerprint, units: [[id]] } } } : before;
  await installSnapshot(page, state, pending);
  await expect(page.locator('#save')).toContainText('試行対象の変更');
  await expect(page.locator('#save')).toContainText('元の確認文');
  await page.getByRole('button', { name: '照会する', exact: true }).click();
  await expect(page.locator('#save')).toContainText(`1単位中${saved ? 1 : 0}単位が保存済み`);
  await page.getByRole('button', { name: action === 'confirm' ? '保存済みとして確定する' : '再試行する', exact: true }).click();
  await expect(page.locator('#save')).toContainText(saved ? '保存済み' : '保存した');
  await page.reload();
  const result = await savedSnapshot(page);
  expect(result.ledger.masters.items['X']?.trial).toBe(true);
  expect(result.ledger.history).toHaveLength(1);
  expect(result.ledger.history[0]).toMatchObject({ review: { initial: '不明は実数にしない' } });
});

test('旧試行変更の競合退避: 操作名と五確認の原文を表示し、数量を変えず理由付き照合を確定する', async ({ page }) => {
  await startEmpty(page);
  const before = await savedSnapshot(page);
  const draft: ConflictDraft = { reviewId: 'legacy-trial-draft', origin: { kind: 'unsent' }, opKey: 'masterTrial', opLabel: 'マスタ：試行対象の変更', actor: '架空担当A',
    occurredAt: null, baseRevision: before.revision, baseLastWriter: before.lastWriter, detectedAt: '2026-10-14T10:00:00+09:00', detectedReason: '旧版の更新競合',
    fields: ['既存数量の確認', '未完了依頼の確認', '訂正手順の確認', '復元手順の確認', '追加範囲の開始数量の確認'].map((label, n) => ({ kind: 'text', name: `legacy${n}`, label, value: `原文${n}\n確認済み` })),
    readEvidence: [], targets: ['品目X'], unapplied: [] };
  await page.evaluate(draft => sessionStorage.setItem('fuzzy-stock/conflict-draft', JSON.stringify({ format: 'fuzzy-stock-conflict-draft', version: 1, draft })), draft);
  await page.reload();
  const panel = page.locator('#conflict');
  await expect(panel).toContainText(draft.opLabel);
  for (const field of draft.fields) await expect(panel).toContainText(field.label);
  await readyToSave(panel, '旧版の操作は取り下げ、原文を履歴に残す');
  await panel.getByRole('button', { name: /で保存する/ }).click();
  await expect(panel).toContainText('確定済み');
  expect(await draftOf(page)).toBeNull();
  const after = await savedSnapshot(page);
  expect(after.ledger).toEqual(before.ledger); expect(after.supply).toEqual(before.supply);
  expect(after.conflictReviews).toHaveLength(1);
  expect(after.conflictReviews[0]?.draft).toEqual(draft);
});
