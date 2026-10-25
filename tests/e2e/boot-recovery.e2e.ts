import { expect, test, type Page } from '@playwright/test';
import { goTo, lot, record, recorded, row, startEmpty, storageBytes, usePractice, waitForApp } from './helpers.ts';

test.use({ trace: 'retain-on-failure' });
const restart = (page: Page) => page.getByRole('button', { name: '画面を再読み込みする', exact: true });
async function reloadWithButton(page: Page) {
  await Promise.all([page.waitForEvent('load'), restart(page).click()]);
}
async function failed(page: Page) {
  await expect(page.locator('#boot')).toContainText('画面を起動できませんでした');
  await expect(page.locator('#app')).toHaveJSProperty('inert', true);
  await expect(restart(page)).toBeVisible();
  await restart(page).focus();
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.querySelector('#app')?.contains(document.activeElement))).toBe(false);
}

for (const module of ['main', 'followupview']) test(`起動1.2/2.1/2.2: ${module === 'main' ? '入口' : '注入した依存'}の取得失敗から、保存を初期化せず明示再読込で復帰する`, async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('keep', 'P', 'S1', 'counted', '7'));
  const before = await storageBytes(page);
  const url = `**/dist/ui/${module}.js`;
  if (module !== 'main') {
    // 配布bundleには独立した起動依存URLがないので、import拒否を入口に注入する。
    await page.route('**/dist/ui/main.js', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: `import './followupview.js';\n${await response.text()}` });
    });
  }
  let attempts = 0;
  await page.route(url, route => { attempts++; return route.abort(); });
  await page.reload(); await failed(page);
  expect(attempts).toBe(1);
  expect(await storageBytes(page)).toEqual(before);
  await reloadWithButton(page); await failed(page);
  expect(attempts).toBe(2);
  expect(await storageBytes(page)).toEqual(before);
  await page.unroute(url);
  if (module !== 'main') await page.unroute('**/dist/ui/main.js');
  await reloadWithButton(page); await waitForApp(page);
  await goTo(page, 'stock');
  await expect(row(page, 'keep')).toContainText('7個');
  expect(await storageBytes(page)).toEqual(before);
});

test('起動1.1/3.1: 読込中は操作できず、初期化完了後にだけ通常操作へ進む', async ({ page }) => {
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/dist/ui/main.js', async route => { await gate; await route.continue(); });
  try {
    await page.goto('/', { waitUntil: 'commit' });
    await expect(page.locator('#boot')).toContainText('起動中');
    await expect(page.locator('#app')).toHaveJSProperty('inert', true);
    await expect(restart(page)).toBeHidden();
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.querySelector('#app')?.contains(document.activeElement))).toBe(false);
  } finally { release(); }
  await waitForApp(page);
  await expect(page.getByRole('form', { name: '操作の入力' })).toHaveCount(1);
  await usePractice(page);
  await recorded(page, 'register', lot('loaded', 'P', 'S1', 'counted', '1'));
  await expect(page.getByRole('status')).toHaveCount(1);
});

for (const [name, source] of [['同期初期化例外', 'throw new Error("架空の初期化失敗");'], ['構文エラー', 'export {']] as const) {
  test(`起動1.2/2.1: ${name}で操作を止め、既存mainの保存処理前ならbytesを保つ`, async ({ page }) => {
    await startEmpty(page);
    await recorded(page, 'register', lot('keep', 'P', 'S1', 'unknown', ''));
    const before = await storageBytes(page);
    await page.route('**/dist/ui/main.js', route => route.fulfill({ contentType: 'text/javascript', body: source }));
    await page.reload(); await failed(page);
    expect(await storageBytes(page)).toEqual(before);
    await page.unroute('**/dist/ui/main.js');
    await reloadWithButton(page); await waitForApp(page);
    await expect(row(page, 'keep')).toContainText('数が不明');
    expect(await storageBytes(page)).toEqual(before);
  });
}

test('起動2.1/3.1: 保存結果不明のまま読込失敗してもpendingを保持し、復帰後に同じ結果を照会できる', async ({ page }) => {
  await startEmpty(page); await page.goto('/?test'); await waitForApp(page);
  await page.evaluate(() => {
    if (!window.fuzzyStockTest) throw Error('試験用保存障害が必要');
    window.fuzzyStockTest.loseResponseAt(1);
  });
  await record(page, 'register', lot('pending-box', 'P', 'S1', 'counted', '8'));
  await expect(page.locator('#save')).toContainText('保存結果不明');
  const before = await storageBytes(page);
  expect(before['fuzzy-stock/pending']).toBeTruthy();
  await page.route('**/dist/ui/main.js', route => route.abort());
  await page.reload(); await failed(page);
  expect(await storageBytes(page)).toEqual(before);
  await page.unroute('**/dist/ui/main.js');
  await reloadWithButton(page); await waitForApp(page);
  await expect(page.locator('#save')).toContainText('保存結果不明');
  await page.getByRole('button', { name: '照会する', exact: true }).click();
  await page.getByRole('button', { name: '保存済みとして確定する', exact: true }).click();
  await expect(row(page, 'pending-box')).toContainText('8個');
  await goTo(page, 'issues');
  await expect(page.locator('#history li').filter({ hasText: '登録：pending-box' })).toHaveCount(1);
});

test('起動3.1: 破損した保存は起動成功後の既存復旧画面で扱い、起動失敗と混同しない', async ({ page }) => {
  await startEmpty(page);
  await page.evaluate(() => localStorage.setItem('fuzzy-stock/head', '架空の破損'));
  const before = await storageBytes(page);
  await page.reload(); await waitForApp(page);
  await expect(page.locator('#save')).toContainText('保存された記録を読み込めない');
  await page.getByRole('button', { name: '保存された記録を消して初期化する', exact: true }).click();
  await page.getByRole('button', { name: 'やめる', exact: true }).click();
  expect(await storageBytes(page)).toEqual(before);
});

test.describe('JavaScript無効', () => {
  test.use({ javaScriptEnabled: false });
  test('有効化が必要なことを示し、未初期化の操作を実行させない', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('alert')).toContainText('JavaScriptが無効');
    await expect(page.locator('#app')).toHaveAttribute('inert', '');
    await expect(page.locator('#boot')).toBeHidden();
  });
});
