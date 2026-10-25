import { expect, test } from '@playwright/test';
import * as XLSX from 'xlsx';
import { selectOperation, goTo, backupButton, cell, downloadVia, exportButton, lot, opLabels, pickFile, record, recorded, row, startEmpty, storageBytes, totals } from './helpers.ts';

test('AT-12: 自動流用なし、案件・用途AからBへ10個を振替、部署50と共通30を保ちA不足10/B不足0、保存・復元・出力', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await startEmpty(page);
  for (const [project, value] of [['A-001', '20'], ['B-001', '10']] as const) {
    await recorded(page, 'needRegister', { project, item: 'P', unit: '個', basis: 'counted', value, dueDate: '', source: '架空の明細', revision: '1' }, '07:00');
  }
  await recorded(page, 'register', lot('source', 'P', 'S1', 'counted', '20'), '08:00');
  await recorded(page, 'register', lot('common', 'P', 'S1', 'counted', '30', { project: 'common' }), '08:00');
  const a = page.locator('#supply article[data-group="A-001/P/個"]');
  const b = page.locator('#supply article[data-group="B-001/P/個"]');
  await goTo(page, 'supply');
  await expect(a).toContainText('不足 0個');
  await expect(b).toContainText('不足 10個');
  await goTo(page, 'stock');
  await expect(totals(page)).toContainText('在庫 記録上の数50個');
  const form = page.getByRole('form', { name: '操作の入力' });
  await selectOperation(form.locator('[name=op]'), { label: opLabels.transfer });
  await expect(form.locator('[name=toProject]')).toHaveValue('');
  await expect(form.locator('[name=toProject] option[value=common]')).toHaveCount(0);
  await expect(form.locator('[name=toProject] option[value=unassigned]')).toHaveCount(0);
  await recorded(page, 'transfer', { lot: 'source', childId: 'dest', toProject: 'B-001', basis: 'counted', value: '10' }, '09:00');
  await expect(cell(page, 'source', '記録上の数と根拠')).toContainText('10個');
  await expect(cell(page, 'dest', '記録上の数と根拠')).toContainText('10個・数えた');
  await expect(cell(page, 'dest', '案件・用途')).toContainText('案件・用途B-001');
  await expect(cell(page, 'common', '案件・用途')).toContainText('共通在庫');
  await expect(totals(page)).toContainText('在庫 記録上の数50個');
  await goTo(page, 'supply');
  await expect(a).toContainText('不足 10個');
  await expect(b).toContainText('不足 0個');
  await goTo(page, 'issues');
  await expect(page.locator('#history')).toContainText('案件・用途A-001 → 案件・用途B-001');
  await page.reload();
  await expect(cell(page, 'dest', '案件・用途')).toContainText('案件・用途B-001');
  await goTo(page, 'supply');
  await expect(b).toContainText('不足 0個');
  const backup = await downloadVia(page, backupButton);
  const output = await downloadVia(page, exportButton);
  const book = XLSX.read(output.bytes, { type: 'array' });
  const rows = XLSX.utils.sheet_to_json<string[]>(book.Sheets['台帳の履歴']!, { header: 1, raw: true });
  expect(rows.some(r => r.join(' ').includes('案件・用途A-001 → 案件・用途B-001'))).toBe(true);
  await goTo(page, 'stock');
  await recorded(page, 'use', { lot: 'dest', basis: 'counted', value: '2', usedFor: 'B作業' }, '10:00');
  await expect(cell(page, 'dest', '記録上の数と根拠')).toContainText('8個');
  await pickFile(page, backup.path);
  await page.getByRole('region', { name: '復元の確認' }).getByRole('button', { name: '復元する', exact: true }).click();
  await goTo(page, 'stock');
  await expect(cell(page, 'dest', '記録上の数と根拠')).toContainText('10個・数えた');
  await expect(totals(page)).toContainText('在庫 記録上の数50個');
  expect(errors).toEqual([]);
});

test('FH-F1C-01: 過量・不明・同案件・用途・後入力の包含済みを拒否し保存内容を変えない', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('source', 'P', 'S1', 'counted', '20'), '08:00');
  const before = await storageBytes(page);
  for (const values of [
    { toProject: 'B-001', basis: 'counted', value: '21' },
    { toProject: 'B-001', basis: 'unknown', value: '' },
    { toProject: 'A-001', basis: 'counted', value: '10' },
  ]) {
    await expect(await record(page, 'transfer', { lot: 'source', childId: 'dest', ...values }, '09:00')).toContainText('記録していない');
    expect(await storageBytes(page)).toEqual(before);
    await goTo(page, 'stock');
    await expect(row(page, 'dest')).toHaveCount(0);
  }
  await recorded(page, 'recount', { lot: 'source', value: '20', causeUnknown: true }, '10:00');
  const counted = await storageBytes(page);
  await expect(await record(page, 'transfer', { lot: 'source', childId: 'dest', toProject: 'B-001', basis: 'counted', value: '10' }, '09:00')).toContainText('回答が必要');
  const form = page.getByRole('form', { name: '操作の入力' });
  await form.locator('[name=inclusion]').selectOption('included');
  await form.getByRole('button', { name: '記録する' }).click();
  await expect(page.getByRole('status')).toContainText('確認が必要');
  expect(await storageBytes(page)).toEqual(counted);
  await goTo(page, 'stock');
  await expect(row(page, 'dest')).toHaveCount(0);
});
