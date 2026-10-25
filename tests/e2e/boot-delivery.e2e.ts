import { expect, test } from '@playwright/test';
import { goTo, waitForApp } from './helpers.ts';

test('ADR-036・起動3.1: 初回起動のJS取得を一つにまとめ、出力依存は後で読む', async ({ page, request }) => {
  const scripts: string[] = [], failed: string[] = [];
  page.on('request', request => { if (request.resourceType() === 'script') scripts.push(new URL(request.url()).pathname); });
  page.on('requestfailed', request => failed.push(request.url()));
  await page.goto('/');
  await waitForApp(page);
  expect(failed).toEqual([]);
  expect(scripts).toEqual(['/dist/ui/main.js']);
  await goTo(page, 'management');
  await expect(page.getByRole('button', { name: '閲覧用に出力（Excel・復元には使えない）', exact: true })).toBeEnabled();
  const license = await request.get('/dist/vendor/xlsx-LICENSE.txt');
  expect(license.status()).toBe(200);
  expect(await license.text()).toContain('Apache License');
});
