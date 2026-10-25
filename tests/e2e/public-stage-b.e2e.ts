import { expect, test } from '@playwright/test';
import { allOperationLabels, cell, goTo, lot, opLabels, recorded, row, startEmpty } from './helpers.ts';

test('公開版B: 表示用語をそろえ、操作名を次の移行まで保持する', async ({ page }) => {
  await startEmpty(page);
  await expect(page.locator('#nav-masters')).toHaveText('登録情報');
  await expect(page.locator('#nav-issues')).toContainText('確認・履歴');
  await expect(page.locator('[name=project]').locator('..')).toContainText('案件・用途');
  await expect(page.locator('[name=basis] option')).toHaveText(['選ぶ', '数えた', '表示の数（ラベル・パッケージ）', 'だいたい', '数が不明']);
  expect(await allOperationLabels(page)).toEqual(expect.arrayContaining(Object.values(opLabels)));
  await goTo(page, 'masters');
  await expect(page.locator('#masters')).toContainText('品番・コード');
  await expect(page.locator('#masters')).toContainText('案件・用途');
});

test('公開版B: 記録上の数・数えた数・不明と0を区別し、入力した名前を保持する', async ({ page }) => {
  await startEmpty(page);
  const id = '案件所属不明・受入・手直し';
  await recorded(page, 'register', lot(id, 'P', 'S1', 'counted', '10'));
  await recorded(page, 'use', { lot: id, basis: 'counted', value: '3', usedFor: '戻り値・元に戻ります・受入' }, '12:01');
  await expect(cell(page, id, '記録上の数と根拠')).toContainText('記録上の数7個');
  await expect(row(page, id)).toContainText(id);
  await recorded(page, 'register', lot('unknown', 'Q', 'S1', 'unknown', ''));
  await recorded(page, 'register', lot('zero', 'Q', 'S1', 'counted', '0'));
  await expect(cell(page, 'unknown', '記録上の数と根拠')).toContainText('数が不明');
  await expect(cell(page, 'zero', '記録上の数と根拠')).toHaveText('0個・数えた');
  await page.reload();
  await expect(row(page, id)).toContainText(id);
  await goTo(page, 'issues');
  await expect(page.locator('#history')).toContainText('戻り値・元に戻ります・受入');
});
