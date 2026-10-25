import { test, expect } from '@playwright/test';
import { backupButton, downloadVia, goTo, pickFile, record, recorded, row, waitForApp } from './helpers.ts';

test('P1-BLANK: 空の台帳から担当者・場所・品目・現物を登録し、再読込・バックアップ・復元で保つ', async ({ page }) => {
  await page.goto('/'); await waitForApp(page);
  const guide = page.locator('#getting-started');
  await expect(guide).toBeVisible();
  await expect(guide).toContainText('担当者（自分の名前）を登録する：未登録');
  await expect(page.locator('#actor')).toHaveValue('');
  await expect(page.locator('#masters')).not.toContainText('架空');

  // 担当者がいない間は、担当者の登録以外を記録しない。
  const refused = await record(page, 'masterLocation', { code: 'K1', name: '台所の棚', inScope: 'true' });
  await expect(refused).toContainText('最初に担当者（自分の名前）を登録する');

  await guide.getByRole('button', { name: '入力欄で開く' }).click();
  await expect(page.locator('#input [name=op]')).toBeFocused();
  await recorded(page, 'masterActor', { name: '山田' });
  await expect(page.locator('#actor')).toHaveValue('山田');
  await expect(guide).toContainText('担当者（自分の名前）を登録する：登録済み');

  await recorded(page, 'masterLocation', { code: 'K1', name: '台所の棚', inScope: 'true' });
  await recorded(page, 'masterItem', { code: 'W', name: '水2L', units: '本' });
  await expect(guide).toBeHidden();
  await recorded(page, 'register', { newId: 'w1', item: 'W', location: 'K1', project: 'common', basis: 'counted', value: '6' });
  await expect(row(page, 'w1')).toContainText('6本');

  await page.reload(); await waitForApp(page);
  await expect(row(page, 'w1')).toContainText('6本');
  await expect(page.locator('#actor')).toHaveValue('山田');

  const backup = await downloadVia(page, backupButton);
  await goTo(page, 'management');
  await page.getByRole('button', { name: '空の台帳で初期化' }).click();
  await page.getByRole('button', { name: '初期化する', exact: true }).click();
  await goTo(page, 'stock');
  await expect(row(page, 'w1')).toHaveCount(0);
  await expect(guide).toBeVisible();
  await pickFile(page, backup.path);
  await page.getByRole('region', { name: '復元の確認' }).getByRole('button', { name: '復元する', exact: true }).click();
  await page.getByRole('region', { name: '復元の確認' }).waitFor({ state: 'hidden' });
  await page.reload(); await waitForApp(page);
  await expect(row(page, 'w1')).toContainText('6本');
  await expect(guide).toBeHidden();
});

test('P1-PRACTICE: 練習用の台帳は架空の登録情報だけを持ち、在庫は空で始める', async ({ page }) => {
  await page.goto('/'); await waitForApp(page);
  await goTo(page, 'management');
  await page.getByRole('button', { name: '練習用の台帳で初期化' }).click();
  await page.getByRole('button', { name: '初期化する', exact: true }).click();
  await goTo(page, 'stock');
  await expect(page.locator('#getting-started')).toBeHidden();
  await expect(page.locator('#list tr[data-lot]')).toHaveCount(0);
  await expect(page.locator('#actor')).toHaveValue('架空担当A');
});
