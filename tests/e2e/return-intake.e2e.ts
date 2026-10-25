import { expect, test, type Page } from '@playwright/test';
import { cell, goTo, lot, record, recorded, selectOperation, startEmpty, storageBytes, waitForApp } from './helpers.ts';
import { snapshotOf } from './conflict-helpers.ts';
import { decodePending } from '../../src/ui/storageparse.ts';

const formOf = (page: Page) => page.getByRole('form', { name: '操作の入力' });
const status = (page: Page) => page.locator('#input > [role=status]');

test('FH-RI: 戻り割当の保存結果不明でも選ばなかった欄を元入力へ残さない', async ({ page }) => {
  await startEmpty(page); await page.goto('/?test'); await waitForApp(page);
  await recorded(page, 'register', lot('existing', 'R', 'T', 'counted', '2'), '10:00');
  await recorded(page, 'returnRecord', { item: 'R', location: 'T', basis: 'label', value: '2', note: '架空の戻り' }, '12:00');
  const issue = await chooseAssignment(page);
  await page.evaluate(() => window.fuzzyStockTest!.loseResponseAt(1));
  await record(page, 'returnAssign', { issue, returnInclusion: 'included', lot: 'existing', reason: '現在数量に含まれる' }, '13:00');
  await expect(page.locator('#save')).toContainText('保存結果不明');
  const pending = decodePending(JSON.parse(await page.evaluate(() => localStorage.getItem('fuzzy-stock/pending')) ?? 'null'));
  expect(pending.values).toHaveProperty('数量に含まれる保管単位');
  for (const name of ['返ってきた物の新しい保管単位のID', '品目', '単位', '案件・用途', '返ってきた物を置く場所']) expect(pending.values).not.toHaveProperty(name);
});
async function chooseAssignment(page: Page) {
  const form = formOf(page);
  await selectOperation(form.locator('[name=op]'), 'returnAssign');
  const issue = await form.locator('[name=issue] option').nth(1).getAttribute('value');
  if (!issue) throw new Error('戻り仮の記録が必要');
  await form.locator('[name=issue]').selectOption(issue);
  return issue;
}

test('ADR039: 出庫済みの返ってきた物は18→仮の記録18→割当20、確認変更・取消相当と再読込', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('original', 'R', 'T', 'counted', '20'), '10:00');
  await recorded(page, 'handover', { lot: 'original', basis: 'counted', value: '2', counterpart: '外' }, '11:00');
  await recorded(page, 'returnRecord', { item: 'R', location: 'T', basis: 'counted', value: '2', returnOrigin: 'original／出庫2台', note: '<架空戻り>' });
  await expect(cell(page, 'original', '記録上の数と根拠')).toContainText('18台');
  const before = await storageBytes(page);
  const issue = await chooseAssignment(page);
  const form = formOf(page);
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(status(page)).toContainText('含まれているか');
  expect(await storageBytes(page)).toEqual(before);
  await record(page, 'returnAssign', { issue, returnInclusion: 'notIncluded', newId: 'returned', item: 'R', unit: '台', project: 'A-001', location: 'T', reason: '出庫で減った分の戻り' }, '13:00');
  await expect(status(page)).toContainText('確認が必要');
  await expect(status(page)).toContainText('含まれていない');
  expect(await storageBytes(page)).toEqual(before);
  await form.locator('[name=confirmed]').check();
  await form.locator('[name=reason]').fill('現在数量に含まれていないことを確認');
  await expect(form.locator('[name=confirmed]')).not.toBeChecked();
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await form.locator('[name=confirmed]').check();
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(status(page)).toContainText('記録した');
  await expect(cell(page, 'returned', '記録上の数と根拠')).toContainText('2台');
  await expect(cell(page, 'returned', '取り分けた理由')).toContainText('使用可否確認待ち');
  const saved = await snapshotOf(page);
  expect(saved.ledger.lots['original']?.quantity).toMatchObject({ numeric: { value: 18 } });
  expect(saved.ledger.lots['returned']?.stage).toEqual({ kind: 'none' });
  expect(saved.ledger.history.filter(e => e.kind === 'handover')).toHaveLength(1);
  expect(saved.ledger.history.filter(e => e.kind === 'adopt')).toHaveLength(1);
  await page.reload(); await waitForApp(page);
  expect((await snapshotOf(page)).ledger).toEqual(saved.ledger);
  await goTo(page, 'issues');
  await expect(page.locator('#issues')).toContainText('original／出庫2台');
  await expect(page.locator('#issues img')).toHaveCount(0);
});

test('ADR039: 元不明・数が不明の受付と、包含済みの割当は数量を足さない', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('existing', 'P', 'S1', 'label', '20'));
  await recorded(page, 'returnRecord', { basis: 'unknown', value: '', returnOrigin: '', note: '元不明の戻り' });
  let issue = await chooseAssignment(page);
  await recorded(page, 'returnAssign', { issue, returnInclusion: 'included', lot: 'existing', reason: '既に現在数量へ含まれる' }, '13:00');
  expect((await snapshotOf(page)).ledger.lots['existing']?.quantity).toMatchObject({ numeric: { value: 20 } });
  await recorded(page, 'returnRecord', { basis: 'unknown', value: '', note: '別の元不明戻り' });
  issue = await chooseAssignment(page);
  await record(page, 'returnAssign', { issue, returnInclusion: 'notIncluded', newId: 'unknown-return', item: 'P', unit: '個', project: 'A-001', location: 'S1', reason: '数量も元も不明' }, '14:00');
  await expect(status(page)).toContainText('確認が必要');
  await formOf(page).locator('[name=confirmed]').check();
  await formOf(page).getByRole('button', { name: '記録する', exact: true }).click();
  await expect(status(page)).toContainText('記録した');
  await expect(cell(page, 'unknown-return', '記録上の数と根拠')).toContainText('数が不明');
  await page.reload(); await waitForApp(page);
  expect((await snapshotOf(page)).ledger.lots['unknown-return']?.quantity.kind).toBe('unknown');
});
