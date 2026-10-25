import { expect, test } from '@playwright/test';
import { type NeedRow } from '../../src/domain/need-import.ts';
import { backupButton, downloadVia, goTo, pickFile, selectOperation, startEmpty, waitForPersistence } from './helpers.ts';
import { installSnapshot, legacyPending, savedSnapshot, withLegacyImport } from './legacy-compat.ts';

const row: NeedRow = { format: 'fuzzy-stock-need-row', version: 1, source: '=架空部品表001', line: '007', revision: '初版', previousRevision: null, caseCode: 'A-001', itemCode: 'P', unit: '個', required: { basis: 'counted', value: 100 }, dueDate: '2026-10-20' };
const rawOf = (change: Partial<NeedRow> = {}) => ` \r\n${JSON.stringify({ ...row, ...change })}\r\n`;

test('旧再取込: 改訂・重複・長い原文の保存記録を再読込し、現物・使用を変えず保持する', async ({ page }) => {
  await startEmpty(page);
  const before = await savedSnapshot(page);
  let legacy = withLegacyImport(before, rawOf(), 'legacy1');
  const id = Object.keys(legacy.supply.needs)[0]!;
  legacy = withLegacyImport(legacy, rawOf({ revision: '改訂2', previousRevision: '初版', required: { basis: 'counted', value: 80 } }), 'legacy2');
  const raw = ' '.repeat(12000) + rawOf({ revision: '改訂2', previousRevision: '初版', required: { basis: 'counted', value: 80 } });
  for (let n = 0; n < 24; n++) legacy = withLegacyImport(legacy, raw, `repeat${n}`);
  await installSnapshot(page, legacy);
  expect((await savedSnapshot(page)).supply).toEqual(legacy.supply);
  expect(legacy.supply.needs[id]?.required.value).toBe(80);
  expect(legacy.ledger).toEqual(before.ledger);
  expect(Object.keys(legacy.supply.needs)).toHaveLength(1);
  for (const event of legacy.supply.log.slice(2)) expect(event).toMatchObject({ input: { raw } });
  await goTo(page, 'supply');
  await expect(page.locator('#supply')).toContainText('必要明細取込');
  await page.reload();
  expect((await savedSnapshot(page)).supply).toEqual(legacy.supply);
});

test('旧再取込の保留: 原文と理由を表示し、理由付き適用・見送りを保存して復元できる', async ({ page }) => {
  await startEmpty(page);
  let legacy = withLegacyImport(await savedSnapshot(page), rawOf(), 'legacy1');
  const id = Object.keys(legacy.supply.needs)[0]!;
  legacy = withLegacyImport(legacy, rawOf({ required: { basis: 'counted', value: 80 } }), 'held');
  legacy = withLegacyImport(legacy, rawOf({ line: null }), 'unidentified');
  await installSnapshot(page, legacy);
  const form = page.getByRole('form', { name: '操作の入力' });
  for (const [held, action, reason] of [['held', 'apply', '旧版の原文と照合して80を採用'], ['unidentified', 'dismiss', '識別不足のため見送り']] as const) {
    await selectOperation(form.locator('[name=op]'), 'needImportResolve');
    await form.locator('[name=needHeld]').selectOption(held);
    await expect(form.getByLabel('保留した文書と理由')).toContainText('読取原文');
    await form.locator('[name=needAction]').selectOption(action);
    if (action === 'apply') await form.locator('[name=needTarget]').selectOption(id);
    await form.locator('[name=needReason]').fill(reason);
    await form.getByRole('button', { name: '差分を確認', exact: true }).click();
    await form.locator('[name=needConfirmed]').check();
    await form.locator('[name=occurredAt]').fill('2026-10-14T11:00');
    await form.getByRole('button', { name: '記録する', exact: true }).click();
    await waitForPersistence(page);
    await expect(page.getByRole('status')).toContainText('記録した');
  }
  const completed = await savedSnapshot(page);
  expect(completed.supply.needs[id]?.required.value).toBe(80);
  expect(completed.supply.log[0]).toMatchObject({ input: { raw: rawOf() } });
  expect(completed.ledger).toEqual(legacy.ledger);
  const backup = await downloadVia(page, backupButton);
  await pickFile(page, backup.path);
  const confirm = page.getByRole('region', { name: '復元の確認' });
  await confirm.getByRole('button', { name: '復元する', exact: true }).click();
  await expect(confirm).toBeHidden(); await page.reload();
  expect((await savedSnapshot(page)).supply).toEqual(completed.supply);
});

test('旧再取込pending: 操作名の原文を示し、未保存の明細と証拠を再試行で一回だけ確定する', async ({ page }) => {
  await startEmpty(page);
  const before = await savedSnapshot(page);
  const after = withLegacyImport(before, rawOf(), `op${before.opFloor}`);
  await installSnapshot(page, before, legacyPending(before, after, '必要明細の再取込（架空文書）'));
  await expect(page.locator('#save')).toContainText('必要明細の再取込（架空文書）');
  await page.getByRole('button', { name: '照会する', exact: true }).click();
  await expect(page.locator('#save')).toContainText('1単位中0単位が保存済み');
  await page.getByRole('button', { name: '再試行する', exact: true }).click();
  await expect(page.locator('#save')).toContainText('保存した');
  await page.reload();
  const result = await savedSnapshot(page);
  expect(Object.keys(result.supply.needs)).toHaveLength(1);
  expect(result.supply.log).toHaveLength(1);
  expect(result.supply.log[0]).toMatchObject({ input: { raw: rawOf() } });
  expect(result.ledger).toEqual(before.ledger);
});
