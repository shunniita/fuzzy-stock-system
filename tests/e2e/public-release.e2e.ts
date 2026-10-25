import { expect, test } from '@playwright/test';
import { verifyPublicFlow } from './public-flow.ts';
import { waitForApp } from './helpers.ts';

test('公開版: 空の台帳から水12本を登録し、使用・移動・数え直し・履歴・復元まで進む', async ({ page }) => {
  await page.goto('/');
  expect(await verifyPublicFlow(page)).toEqual({ registered: 12, used: 2, recounted: 9, history: 8 });
});

test('公開ガイド: キーボードで別タブを開き、320pxと文字200%で読む', async ({ page, context }) => {
  const external: string[] = [];
  context.on('request', request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== '127.0.0.1') external.push(request.url());
  });
  await page.goto('/'); await waitForApp(page);
  const helpPromise = context.waitForEvent('page');
  await page.getByRole('link', { name: '使い方', exact: true }).focus();
  await page.keyboard.press('Enter');
  const help = await helpPromise;
  await expect(help).toHaveURL(/\/help\.html$/);
  await expect(help.getByRole('heading', { level: 1 })).toHaveText('fuzzy-stock-system の使い方');
  await expect(help.locator('main')).toContainText('入力する数は2');
  await expect(help.locator('main')).toContainText('差の-1ではありません');
  await expect(help.locator('main')).toContainText('Excel出力は閲覧用で、復元には使えません');
  await help.setViewportSize({ width: 320, height: 740 });
  expect(await help.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await help.screenshot({ path: '.local-logs/public-docs/help-320.png', fullPage: true });
  await help.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  expect(await help.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await help.getByRole('link', { name: '数量の読み方', exact: true }).focus();
  await help.keyboard.press('Enter');
  await expect(help).toHaveURL(/#quantity$/);
  await expect(help.getByRole('heading', { name: '数量の読み方', exact: true })).toBeVisible();
  await help.screenshot({ path: '.local-logs/public-docs/help-320-text200.png', fullPage: true });
  expect(external).toEqual([]);
  await help.close();
  await expect(page.locator('#getting-started')).toBeVisible();
});
