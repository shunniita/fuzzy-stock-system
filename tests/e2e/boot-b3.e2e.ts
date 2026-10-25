import { expect, test, type Page } from '@playwright/test';
import { selectOperation, goTo, record, lot, row, set, bannerText, waitForApp } from './helpers.ts';

async function empty(page: Page): Promise<void> {
  await page.goto('/?test');
  await goTo(page, 'management');
  await page.getByRole('button', { name: '練習用の台帳で初期化' }).click();
  await page.getByRole('button', { name: '初期化する', exact: true }).click();
  await goTo(page, 'stock');
}

test('B3 5.1: ビルド画面の記録・再読込と各欄', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await empty(page);
  await goTo(page, 'management');
  await expect(page.locator('#about').getByRole('note')).toHaveText(bannerText);
  await goTo(page, 'stock');
  await record(page, 'register', lot('0007', 'P', 'S1', 'counted', '8'));
  await expect(page.locator('#save')).toContainText('保存した');
  await expect(row(page, '0007')).toContainText('8個');
  await expect(page.locator('#list th', { hasText: '試行対象' })).toHaveCount(0);
  await page.reload();
  await expect(row(page, '0007')).toContainText('8個');
  await goTo(page, 'issues');
  await expect(page.locator('#history')).toContainText('0007');
  await goTo(page, 'supply');
  await expect(page.locator('#case')).toContainText('案件・用途詳細');
  await expect(page.locator('#followup')).toContainText('未着・不足・対応一覧');
  await page.locator('#case select').selectOption('A-001');
  await page.locator('#case button[data-lot="0007"]').click();
  await expect(page.locator('#detail')).toContainText('現在の記録上の数');
  await page.screenshot({ path: testInfo.outputPath('overview.png'), fullPage: true });
  await goTo(page, 'supply');
  await page.locator('#case').screenshot({ path: testInfo.outputPath('case.png') });
  await page.locator('#followup').screenshot({ path: testInfo.outputPath('followup.png') });
  expect(errors).toEqual([]);
});

test('B3 5.1: 古いフォームの同じ内容は再送だけ、変更と初期化後は拒否', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await empty(page);
  const form = page.getByRole('form', { name: '操作の入力' });
  await selectOperation(form.locator('[name=op]'), 'register');
  for (const [name, value] of Object.entries(lot('old-box', 'P', 'S1', 'counted', '8'))) await set(form.locator(`[name=${name}]`), value);
  await form.locator('[name=occurredAt]').fill('2026-09-29T12:00');
  const old = await form.elementHandle();
  if (!old) throw new Error('フォームが必要');
  await form.getByRole('button', { name: '記録する' }).click();
  await expect(page.locator('#app')).toHaveJSProperty('inert', false);
  await page.locator('#actor').selectOption({ index: 1 });
  await selectOperation(page.locator('form [name=op]'), 'use');
  await old.evaluate(node => node.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await expect(page.locator('#save')).toContainText('保存済み。もう一度は記録しない');
  await old.evaluate(node => {
    const id = node.querySelector('[name=newId]');
    if (id instanceof HTMLInputElement) id.value = 'changed-box';
    node.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await expect(page.locator('#input')).toContainText('違う内容で使用済み');
  await goTo(page, 'stock');
  await expect(row(page, 'changed-box')).toHaveCount(0);
  await expect(page.getByRole('form', { name: '操作の入力' })).toHaveCount(1);
  await record(page, 'register', lot('fresh-box', 'P', 'S1', 'counted', '2'));
  await expect(row(page, 'fresh-box')).toContainText('2個');
  await goTo(page, 'management');
  await page.getByRole('button', { name: '練習用の台帳で初期化' }).click();
  await page.getByRole('button', { name: '初期化する', exact: true }).click();
  await goTo(page, 'stock');
  await old.evaluate(node => node.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await expect(page.locator('#input')).toContainText('初期化より前の入力');
  await goTo(page, 'stock');
  await expect(row(page, 'changed-box')).toHaveCount(0);
  await expect(page.getByRole('form', { name: '操作の入力' })).toHaveCount(1);
  await record(page, 'register', lot('after-reset', 'P', 'S1', 'counted', '3'));
  await expect(row(page, 'after-reset')).toContainText('3個');
  expect(errors).toEqual([]);
});

test('B3 5.1: 保存結果不明は日本語の入力と確認事項を保持して解消できる', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await empty(page);
  await page.evaluate(() => window.fuzzyStockTest?.loseResponseAt(1));
  await record(page, 'register', lot('unknown-box', 'P', 'S1', 'counted', '8'));
  await expect(page.locator('#save')).toContainText('保存結果不明');
  await expect(page.locator('#save')).toContainText('数量の根拠：数えた');
  await expect(page.locator('#save')).toContainText('新しい保管単位のID');
  await expect(page.locator('#save')).not.toContainText('最後に数えた数に含まれていたか');
  await goTo(page, 'issues');
  await expect(page.locator('#issues')).toContainText('保存結果不明');
  await expect(page.getByRole('form', { name: '操作の入力' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('save-unknown.png'), fullPage: true });
  await page.reload();
  await expect(page.locator('#save')).toContainText('unknown-box');
  await page.getByRole('button', { name: '照会する', exact: true }).click();
  await page.getByRole('button', { name: '保存済みとして確定する', exact: true }).click();
  await goTo(page, 'issues');
  await expect(page.locator('#issues')).toContainText('解消済み');
  await expect(page.locator('#issues')).toContainText('確認者');
  await goTo(page, 'stock');
  await expect(row(page, 'unknown-box')).toContainText('8個');
  expect(errors).toEqual([]);
});

test('B3 5.1: 初期化の容量エラーを表示し、同じ確認で再試行できる', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await empty(page);
  await record(page, 'register', lot('keep-box', 'P', 'S1', 'counted', '8'));
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    let failed = false;
    Storage.prototype.setItem = function(key, value) {
      if (!failed && key.startsWith('fuzzy-stock/slot-')) { failed = true; throw new Error('架空の保存容量不足'); }
      return original.call(this, key, value);
    };
  });
  await goTo(page, 'management');
  await page.getByRole('button', { name: '練習用の台帳で初期化' }).click();
  await page.getByRole('button', { name: '初期化する', exact: true }).click();
  await expect(page.getByRole('region', { name: '初期化の確認' })).toContainText('架空の保存容量不足');
  await goTo(page, 'stock');
  await expect(row(page, 'keep-box')).toContainText('8個');
  await goTo(page, 'management');
  await page.getByRole('button', { name: '初期化する', exact: true }).click();
  await goTo(page, 'stock');
  await expect(row(page, 'keep-box')).toHaveCount(0);
  await page.reload();
  await expect(row(page, 'keep-box')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('B3 5.1: 同じ操作の次の入力が保存に失敗したら前の成功表示を残さない', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await empty(page);
  await record(page, 'register', lot('saved-box', 'P', 'S1', 'counted', '8'));
  const form = page.getByRole('form', { name: '操作の入力' });
  for (const [name, value] of Object.entries(lot('failed-box', 'P', 'S1', 'counted', '2'))) await set(form.locator(`[name=${name}]`), value);
  await form.locator('[name=occurredAt]').fill('2026-09-29T13:00');
  await page.evaluate(() => window.fuzzyStockTest?.failMidwayAt(1));
  await form.getByRole('button', { name: '記録する' }).click();
  await expect(page.locator('#save')).toContainText('保存できなかった');
  await expect(page.getByRole('status')).toContainText('保存できなかった');
  await expect(page.getByRole('status')).not.toContainText('記録した');
  await expect(form.locator('[name=newId]')).toHaveValue('failed-box');
  await goTo(page, 'stock');
  await expect(row(page, 'failed-box')).toHaveCount(0);
  await form.getByRole('button', { name: '記録する' }).click();
  await expect(row(page, 'failed-box')).toContainText('2個');
  expect(errors).toEqual([]);
});

test('B3 5.1: 読み込み不能では上書きせず、取消も無変更、確認後に置換', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await waitForApp(page);
  await page.evaluate(() => localStorage.setItem('fuzzy-stock/head', '壊れた値'));
  await page.reload();
  await expect(page.locator('#save')).toContainText('保存された記録を読み込めない');
  await expect(page.locator('#list')).toBeHidden();
  await page.getByRole('button', { name: '保存された記録を消して初期化する', exact: true }).click();
  await page.getByRole('button', { name: 'やめる', exact: true }).click();
  expect(await page.evaluate(() => localStorage.getItem('fuzzy-stock/head'))).toBe('壊れた値');
  await page.getByRole('button', { name: '保存された記録を消して初期化する', exact: true }).click();
  await page.getByRole('button', { name: '初期化する', exact: true }).click();
  await expect(page.locator('#list')).toBeVisible();
  await page.reload();
  await expect(page.locator('#list')).toBeVisible();
  expect(errors).toEqual([]);
});

test('B3 5.1: 一部保存は日本語の入力と対象を保ち、残りを記録し直す', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await empty(page);
  const request = { project: 'A-001', item: 'P', quantity: '4', vendor: '架空仕入先', requestedOn: '2026-09-29', replyKind: 'none' };
  await record(page, 'requestRecord', request);
  await record(page, 'requestRecord', request);
  await page.evaluate(() => window.fuzzyStockTest?.failMidwayAt(3));
  await record(page, 'receive', lot('partial-box', 'P', 'S1', 'counted', '8', { label: '架空箱', r1request: 'op1', r1arrived: '4', r1good: '4', r2request: 'op2', r2arrived: '4', r2good: '4' }));
  await expect(page.locator('#save')).toContainText('一部だけ保存した');
  await expect(page.locator('#save')).toContainText('割り当て2の依頼：op2');
  await expect(page.locator('#save')).toContainText('ラベル文字列（任意）：架空箱');
  await expect(page.locator('#save')).toContainText('依頼op2');
  await goTo(page, 'issues');
  await expect(page.locator('#issues')).not.toContainText('保存結果不明');
  await expect(page.getByRole('form', { name: '操作の入力' })).toHaveCount(0);
  await page.getByRole('button', { name: '記録し直す', exact: true }).click();
  await expect(page.locator('#save')).toContainText('保存した');
  await goTo(page, 'stock');
  await expect(row(page, 'partial-box')).toContainText('8個');
  await page.reload();
  await expect(row(page, 'partial-box')).toContainText('8個');
  expect(errors).toEqual([]);
});

test('B3 5.1: 判定日を変えると対応一覧も更新する', async ({ page }) => {
  await empty(page);
  await record(page, 'requestRecord', { project: 'A-001', item: 'P', quantity: '4', vendor: '架空仕入先', requestedOn: '2026-09-29', replyKind: 'answered', replyDate: '2026-10-05' });
  await goTo(page, 'supply');
  await page.locator('[name=asOf]').fill('2026-10-04');
  await page.locator('[name=asOf]').dispatchEvent('change');
  await goTo(page, 'supply');
  await expect(page.locator('#followup')).not.toContainText('入荷遅れ');
  await page.locator('[name=asOf]').fill('2026-10-06');
  await page.locator('[name=asOf]').dispatchEvent('change');
  await expect(page.locator('#followup')).toContainText('入荷遅れ');
  await expect(page.locator('#followup')).toContainText('判定日2026-10-06');
});

test('B3 5.1: 別タブの保存後は記録と初期化を止めて再読込する', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await empty(page);
  const other = await context.newPage();
  other.on('pageerror', error => errors.push(error.message));
  await other.goto('/');
  await record(page, 'register', lot('writer-box', 'P', 'S1', 'counted', '8'));
  await expect(other.locator('#save')).toContainText('別の画面で記録が保存された');
  await expect(other.getByRole('form', { name: '操作の入力' })).toHaveCount(0);
  await goTo(other, 'management');
  await other.getByRole('button', { name: '練習用の台帳で初期化' }).click();
  await goTo(other, 'management');
  await expect(other.getByRole('button', { name: '初期化する', exact: true })).toHaveCount(0);
  await other.getByRole('button', { name: '再読込する', exact: true }).click();
  await goTo(other, 'stock');
  await expect(row(other, 'writer-box')).toContainText('8個');
  await other.close();
  expect(errors).toEqual([]);
});
