import { expect, test, type Page } from '@playwright/test';
import * as XLSX from 'xlsx';
import { backupButton, downloadVia, exportButton, goTo, pickFile, record, recorded, selectOperation, waitForApp, waitForPersistence } from './helpers.ts';
import { snapshotOf } from './conflict-helpers.ts';

async function blankStart(page: Page): Promise<void> {
  await page.goto('/'); await waitForApp(page);
  await recorded(page, 'masterActor', { name: '架空担当' });
  await recorded(page, 'masterLocation', { code: 'T', name: '架空作業台', inScope: 'true' });
  await recorded(page, 'masterLocation', { code: 'NX', name: '架空次工程棚', inScope: 'true' });
  await recorded(page, 'masterItem', { code: 'R', name: '架空製品', units: '台' });
}

const product = { item: 'R', project: 'common', location: 'T', basis: 'counted' };

test('工程の設定4.2・7.1: 空の台帳では工程と次工程の案内を出し、記録を受け付けない', async ({ page }) => {
  await blankStart(page);
  const form = page.getByRole('form', { name: '操作の入力' });
  await selectOperation(form.locator('[name=op]'), 'start');
  await expect(form).toContainText('利用中の工程がありません。作業の種類「工程の登録・設定」で工程を登録してください。');
  await expect(form.locator('[name=process] option')).toHaveCount(1);
  await selectOperation(form.locator('[name=op]'), 'toNext');
  await expect(form).toContainText('次工程の場所が指定されていません。');
  await expect(form.locator('[name=location]')).toHaveCount(0);
  const before = await snapshotOf(page);
  await expect(await record(page, 'start', { newId: 'W1', ...product, value: '1' })).not.toContainText('記録した');
  expect((await snapshotOf(page)).ledger).toEqual(before.ledger);
});

test('工程の設定4.2: 次工程の場所が記録の時点で対象外なら、引渡しを台帳の理由で拒否する', async ({ page }) => {
  await blankStart(page);
  await recorded(page, 'masterProcess', { name: '塗装', criterion: 'workEnd' }, '08:00');
  await recorded(page, 'masterNextProcess', { location: 'NX', reason: '次工程の棚' }, '08:00');
  await recorded(page, 'start', { process: '塗装', newId: 'P1', ...product, value: '2' }, '09:00');
  await recorded(page, 'finish', { lot: 'P1', childId: 'P2', basis: 'counted', value: '2' }, '10:00');
  await recorded(page, 'masterScope', { target: 'location:NX', inScope: 'false', reason: '移管' }, '11:00');
  const before = await snapshotOf(page);
  await expect(await record(page, 'toNext', { lot: 'P2', childId: 'P3', basis: 'counted', value: '1' }, '12:00')).toContainText('の時点で記録の対象外');
  expect((await snapshotOf(page)).ledger).toEqual(before.ledger);
});

test('工程の設定4.2・6.2: 工程の設定の保存結果不明から再読込・照会・再試行して変更履歴を一度だけ残す', async ({ page }) => {
  await blankStart(page);
  await page.goto('/?test'); await waitForApp(page);
  await page.evaluate(() => window.fuzzyStockTest!.loseResponseAt(1));
  await record(page, 'masterProcess', { name: '塗装', criterion: 'workEnd' }, '08:00');
  await expect(page.locator('#save')).toContainText('保存結果不明');
  await page.reload(); await waitForApp(page);
  await page.getByRole('button', { name: '照会する', exact: true }).click();
  await page.getByRole('button', { name: '再試行する', exact: true }).click();
  await waitForPersistence(page);
  const saved = await snapshotOf(page);
  expect(saved.ledger.history.filter(e => e.kind === 'master' && e.masters.some(m => m.after.type === 'process'))).toHaveLength(1);
  expect(saved.ledger.masters.processes['塗装']).toMatchObject({ name: '塗装', criterion: 'workEnd', active: true });
  expect(await page.evaluate(() => localStorage.getItem('fuzzy-stock/pending'))).toBeNull();
  const form = page.getByRole('form', { name: '操作の入力' });
  await selectOperation(form.locator('[name=op]'), 'start');
  await expect(form.locator('[name=process]')).toContainText('工程塗装');
});

test('工程の設定7.1・7.3: 完了基準の違う2工程の通し操作、名前の変更、Excel・JSON復元', async ({ page }) => {
  await blankStart(page);
  await recorded(page, 'masterProcess', { name: '組立', criterion: 'inspection' }, '08:00');
  await recorded(page, 'masterProcess', { name: '塗装', criterion: 'workEnd' }, '08:00');
  await recorded(page, 'masterNextProcess', { location: 'NX', reason: '次工程の棚' }, '08:00');
  await recorded(page, 'start', { process: '組立', newId: 'A1', ...product, value: '10' }, '09:00');
  await recorded(page, 'start', { process: '塗装', newId: 'P1', ...product, value: '4' }, '09:00');
  await recorded(page, 'finish', { lot: 'A1', childId: 'A2', basis: 'counted', value: '6' }, '10:00');
  await recorded(page, 'inspect', { lot: 'A2', childId: 'A3', basis: 'counted', value: '6' }, '10:30');
  await recorded(page, 'finish', { lot: 'P1', childId: 'P2', basis: 'counted', value: '4' }, '10:30');
  await recorded(page, 'toNext', { lot: 'A3', childId: 'A4', basis: 'counted', value: '5', location: 'NX' }, '11:00');
  let s = await snapshotOf(page);
  expect(s.ledger.lots['A2']?.stage).toMatchObject({ kind: 'inspecting', process: { id: '組立' } });
  expect(s.ledger.lots['P2']?.stage).toMatchObject({ kind: 'awaitingHandover', process: { id: '塗装', criterion: 'workEnd' } });
  expect(s.ledger.lots['A4']).toMatchObject({ location: 'NX', stage: { kind: 'none' } });
  // 記録に使われた工程は、完了基準の変更の候補に出さない。
  await selectOperation(page.getByRole('form', { name: '操作の入力' }).locator('[name=op]'), 'masterProcessCriterion');
  await expect(page.getByRole('form', { name: '操作の入力' }).locator('[name=target] option')).toHaveText(['選ぶ']);

  await recorded(page, 'masterRename', { target: 'process:組立', name: '組立ライン1', reason: '呼び方' }, '12:00');
  await expect(page.locator('#list tr[data-lot="A1"]')).toContainText('工程組立ライン1・作業中');
  await goTo(page, 'issues');
  await expect(page.locator('#history')).toContainText('工程組立・作業中');
  await goTo(page, 'stock');

  const book = XLSX.read((await downloadVia(page, exportButton)).bytes, { type: 'array' });
  expect(book.SheetNames).toContain('工程の設定');
  const rows = XLSX.utils.sheet_to_json(book.Sheets['工程の設定']!, { header: 1 });
  expect(JSON.stringify(rows)).toContain('組立ライン1');
  expect(JSON.stringify(rows)).toContain('架空次工程棚');

  s = await snapshotOf(page);
  const backup = await downloadVia(page, backupButton);
  await goTo(page, 'stock');
  await recorded(page, 'masterDeactivate', { target: 'process:塗装', reason: '休止' }, '13:00');
  await page.reload(); await waitForApp(page);
  expect((await snapshotOf(page)).ledger.masters.processes['塗装']?.active).toBe(false);
  await pickFile(page, backup.path);
  await page.getByRole('region', { name: '復元の確認' }).getByRole('button', { name: '復元する', exact: true }).click();
  await page.getByRole('region', { name: '復元の確認' }).waitFor({ state: 'hidden' });
  await page.reload(); await waitForApp(page);
  expect((await snapshotOf(page)).ledger).toEqual(s.ledger);
});
