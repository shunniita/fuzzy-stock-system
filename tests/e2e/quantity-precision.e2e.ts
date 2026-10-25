import { expect, test, type Page } from '@playwright/test';
import * as XLSX from 'xlsx';
import { selectOperation, goTo, cell, downloadVia, exportButton, opLabels, record, recorded, set, startEmpty, storageBytes } from './helpers.ts';

const form = (page: Page) => page.getByRole('form', { name: '操作の入力' });
const group = (page: Page) => page.locator('#supply article[data-group="A-001/D/kg"]');
const followup = (page: Page) => page.locator('#followup tr[data-item="D"]').filter({ hasText: '案件・用途A-001' });

async function fill(page: Page, op: keyof typeof opLabels, values: Record<string, string | boolean>): Promise<void> {
  await selectOperation(form(page).locator('[name=op]'), { label: opLabels[op] });
  for (const [name, value] of Object.entries(values)) await set(form(page).locator(`[name="${name}"]`), value);
}

test('1.1・2.1・3.1〜3.4: 0.1単位の品目を登録し、必要1・受け取り0.9で不足0.1、依頼0.3・到着0.2で未着0.1を示し、精度外の入力は何も記録しない', async ({ page }) => {
  await startEmpty(page);

  // 単位を削除・並べ替えても、選んだ最小単位は同じ名前の単位に残る。
  await fill(page, 'masterItem', { code: 'D', name: '架空小数材料D', units: 'kg、個', 'unitStep-kg': '0.1' });
  await set(form(page).locator('[name=units]'), '個');
  await expect(form(page).locator('[name="unitStep-kg"]')).toHaveCount(0);
  await set(form(page).locator('[name=units]'), '個、kg');
  await expect(form(page).getByLabel('kgの最小単位')).toHaveValue('0.1');
  await expect(form(page).getByLabel('個の最小単位')).toHaveValue('1');
  await form(page).getByRole('button', { name: '記録する' }).click();
  await expect(page.getByRole('status')).toContainText('記録した');
  await goTo(page, 'masters');
  await expect(page.getByRole('table', { name: '品目の登録情報' }).locator('tr', { hasText: '架空小数材料D' })).toContainText('個：1、kg：0.1');
  await goTo(page, 'stock');

  // 数量の欄は選んだ品目・単位の最小単位と上限を示す。
  await fill(page, 'needRegister', { project: 'A-001', item: 'D', unit: 'kg' });
  await expect(form(page).locator('#hint-value')).toHaveText('kgの最小単位0.1・上限562949953421311.9');
  await set(form(page).locator('[name=unit]'), '個');
  await expect(form(page).locator('#hint-value')).toHaveText('個の最小単位1（整数）・上限9007199254740991');
  await expect(form(page).getByLabel('数量（数が不明なら空欄。0は0と入力）')).toHaveAttribute('aria-describedby', 'hint-value');

  const need = { project: 'A-001', item: 'D', basis: 'counted', dueDate: '2026-10-10', source: '架空の必要部品一覧', revision: '初版' };
  await recorded(page, 'needRegister', { ...need, unit: 'kg', value: '1' }, '07:00');
  await recorded(page, 'receive', { newId: 'R1', item: 'D', unit: 'kg', project: 'A-001', location: 'S1', basis: 'counted', value: '0.9' }, '08:00');
  await expect(cell(page, 'R1', '記録上の数と根拠')).toContainText('0.9kg');
  await goTo(page, 'supply');
  await expect(group(page)).toContainText('不足 0.1kg');
  await expect(group(page)).toContainText('手配対象数 0.1kg');
  await expect(followup(page)).toContainText('未手配');

  // 精度外の値・丸められる原文・整数単位の小数は、台帳も供給も保存も変えずに拒否する。
  const before = await storageBytes(page);
  await goTo(page, 'stock');
  await expect(await record(page, 'use', { lot: 'R1', basis: 'counted', value: '0.05', usedFor: '架空作業' })).toContainText('記録していない：数量は最小単位0.1に合う値で入力する');
  await expect(await record(page, 'use', { lot: 'R1', basis: 'counted', value: '0.10000000000000001', usedFor: '架空作業' })).toContainText('記録していない');
  await expect(await record(page, 'needRegister', { ...need, unit: '個', value: '0.1' })).toContainText('記録していない：数量は最小単位1に合う整数で入力する');
  await expect(await record(page, 'use', { lot: 'R1', basis: 'counted', value: 'abc', usedFor: '架空作業' })).toContainText('記録していない：数量は十進数で入力する');
  await expect(await record(page, 'needRegister', { ...need, unit: '個', value: '9007199254740992' })).toContainText('記録していない：数量の絶対値は9007199254740991以下にする');
  await expect(await record(page, 'provisional', { direction: 'found', item: 'D', location: 'S1', basis: 'counted', value: '0.5', note: '架空の仮記録' })).toContainText('記録していない：数量は最小単位1に合う整数で入力する');
  await expect(await record(page, 'masterPerBox', { target: 'item:S', perBox: '0x10', reason: '箱の変更' })).toContainText('記録していない：1箱あたりの数は1以上の整数にする');
  expect(await storageBytes(page)).toEqual(before);
  await expect(cell(page, 'R1', '記録上の数と根拠')).toContainText('0.9kg');

  await recorded(page, 'requestRecord', { project: 'A-001', item: 'D', unit: 'kg', quantity: '0.3', vendor: '架空の仕入先X', requestedOn: '2026-09-29', replyKind: 'none', replyDate: '' }, '09:00');
  await goTo(page, 'supply');
  await expect(followup(page)).toContainText('依頼済み');
  await expect(followup(page)).not.toContainText('未手配');
  await goTo(page, 'stock');
  await recorded(page, 'receive', { newId: 'R2', item: 'D', unit: 'kg', project: 'A-001', location: 'S1', basis: 'counted', value: '0.2', r1request: 'op5', r1arrived: '0.2', r1good: '0.2' }, '10:00');
  await goTo(page, 'supply');
  await expect(group(page)).toContainText('依頼の未着 0.1kg');
  await expect(followup(page)).toContainText('依頼済み');
  await page.locator('[name=case-project]').selectOption('A-001');
  await expect(page.locator('#case article[data-item="D"][data-unit="kg"]')).toContainText('到着0.2kg・未着0.1kg');

  const book = XLSX.read((await downloadVia(page, exportButton)).bytes, { type: 'array' });
  const rows = (name: string) => XLSX.utils.sheet_to_json<string[]>(book.Sheets[name]!, { header: 1, raw: true });
  const request = rows('依頼').find((r) => r[0] === 'op5');
  expect(request?.slice(3, 5)).toEqual(['kg', '0.3']);
  expect(request?.slice(9, 12)).toEqual(['0.2', '0.2', '0.1']);
  expect(JSON.stringify(rows('保管単位').find((r) => r[0] === 'R1'))).toContain('0.9');

  // 割り当ての行が精度外でも、受け取りは記録してその行だけを断る（NEED-05b）。
  await goTo(page, 'stock');
  await expect(await record(page, 'receive', { newId: 'R3', item: 'D', unit: 'kg', project: 'A-001', location: 'S1', basis: 'counted', value: '0.1', r1request: 'op5', r1arrived: '0.05', r1good: '0' }, '11:00'))
    .toContainText('受け取りは記録した。割り当ては拒否した（1行目：数量は最小単位0.1に合う値で入力する）。0行目までを記録した');
  await expect(cell(page, 'R3', '記録上の数と根拠')).toContainText('0.1kg');
  await goTo(page, 'supply');
  await expect(group(page)).toContainText('依頼の未着 0.1kg');
});
