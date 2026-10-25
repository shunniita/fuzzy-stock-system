import { expect, test } from '@playwright/test';
import { goTo, exportButton, startEmpty, storageBytes } from './helpers.ts';

const exportPaths = ['/dist/ui/viewsheets.js', '/dist/ui/xlsx.js', '/dist/vendor/xlsx.mjs'];

test('ADR-036・4.1: 出力時に読む部品を独立した三つのURLにまとめる', async ({ page }) => {
  await startEmpty(page);
  const before = await storageBytes(page);
  const paths: string[] = [];
  page.on('request', request => { if (request.resourceType() === 'script') paths.push(new URL(request.url()).pathname); });
  await goTo(page, 'management');
  await page.getByRole('button', { name: exportButton, exact: true }).click();
  await expect(page.locator('#management-feedback .notice')).toContainText('閲覧用の出力を書き出した');
  expect(paths.sort()).toEqual(exportPaths);
  expect(await storageBytes(page)).toEqual(before);
});

test('FH-F1A-10/12・4.1: 出力時の各部品が最初の一回だけ取得に失敗しても再試行で書き出せる', async ({ page }) => {
  test.setTimeout(60_000);
  await startEmpty(page);
  const before = await storageBytes(page);
  const requests = new Map<string, number>();
  await page.route(/\/dist\//, route => {
    const path = new URL(route.request().url()).pathname;
    const count = (requests.get(path) ?? 0) + 1;
    requests.set(path, count);
    return count === 1 ? route.abort() : route.continue();
  });
  await goTo(page, 'management');
  await page.getByRole('button', { name: exportButton, exact: true }).click();
  await expect(page.locator('#management-feedback .notice')).toContainText(/閲覧用の出力を(書き出した|作れなかった)/, { timeout: 40_000 });
  await expect(page.locator('#management-feedback .notice')).toContainText('閲覧用の出力を書き出した');
  expect([...requests.keys()].sort()).toEqual(exportPaths);
  for (const count of requests.values()) expect(count).toBeGreaterThan(1);
  expect(await storageBytes(page)).toEqual(before);
});

test('FH-F1A-13・4.1: 出力部品の全再試行が失敗しても通信回復後の再クリックで書き出せる', async ({ page }) => {
  test.setTimeout(60_000);
  await startEmpty(page);
  const before = await storageBytes(page);
  await page.route(/\/dist\//, route => route.abort());
  await goTo(page, 'management');
  await page.getByRole('button', { name: exportButton, exact: true }).click();
  await expect(page.locator('#management-feedback .notice')).toContainText('閲覧用の出力を作れなかった', { timeout: 40_000 });
  expect(await storageBytes(page)).toEqual(before);
  await page.unroute(/\/dist\//);
  await page.getByRole('button', { name: exportButton, exact: true }).click();
  await expect(page.locator('#management-feedback .notice')).toContainText('閲覧用の出力を書き出した', { timeout: 40_000 });
  expect(await storageBytes(page)).toEqual(before);
});
