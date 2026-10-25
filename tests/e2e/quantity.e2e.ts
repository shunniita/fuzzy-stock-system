import { expect, test } from '@playwright/test';
import { goTo, cell, lot, record, recorded, startEmpty, totals } from './helpers.ts';

test.beforeEach(async ({ page }) => startEmpty(page));

test('AT-01: 数えた0・ラベル0・だいたい約0と数が不明の箱を区別し、不明を0として合計しない', async ({ page }) => {
  await goTo(page, 'stock');
  await recorded(page, 'register', lot('Z1', 'Q', 'N', 'counted', '0'));
  await recorded(page, 'register', lot('Z2', 'Q', 'N', 'label', '0'));
  await recorded(page, 'register', lot('Z3', 'Q', 'N', 'approximate', '0'));
  await recorded(page, 'register', lot('Z4', 'Q', 'N', 'unknown', ''));
  await expect(cell(page, 'Z1', '記録上の数と根拠')).toHaveText('0個・数えた');
  await expect(cell(page, 'Z2', '記録上の数と根拠')).toHaveText('0個・表示の数（ラベル・パッケージ）・中身未確認');
  await expect(cell(page, 'Z3', '記録上の数と根拠')).toHaveText('約0個・だいたい');
  await expect(cell(page, 'Z4', '記録上の数と根拠')).toHaveText('数が不明');
  await expect(totals(page)).toContainText('在庫 数値部分の小計約0個・中身未確認部分あり、ほかに数が不明1件。全体数量は不明');
});

test('AT-01: 数量の空欄は0にせず、数が不明以外では記録しない', async ({ page }) => {
  await goTo(page, 'stock');
  await expect(await record(page, 'register', lot('Z1', 'Q', 'N', 'counted', ''))).toContainText('記録していない');
  await expect(page.locator('#list tr[data-lot]')).toHaveCount(0);
});

test('PR2-3: 品目・案件・用途・根拠などを選ばずに記録すると、先頭の選択肢で埋めずに記録しない（MOD-02）', async ({ page }) => {
  await goTo(page, 'stock');
  await expect(await record(page, 'register', { newId: 'Z1', value: '5' })).toContainText('記録していない：品目を選ぶ');
  await expect(await record(page, 'register', { newId: 'Z1', item: 'P', value: '5' })).toContainText('記録していない：案件・用途を選ぶ');
  await expect(await record(page, 'register', { newId: 'Z1', item: 'P', project: 'A-001', location: 'S1', value: '5' })).toContainText(
    '記録していない：数量の根拠を選ぶ',
  );
  await expect(await record(page, 'register', { newId: 'Z1', item: 'S', project: 'common', location: 'S1', basis: 'counted', value: '5' })).toContainText(
    '記録していない：単位を選ぶ',
  );
  await expect(page.locator('#list tr[data-lot]')).toHaveCount(0);
});

test('PR2-5: 数量を入れたまま根拠を数が不明にすると、数を捨てずに記録しない', async ({ page }) => {
  await goTo(page, 'stock');
  await expect(await record(page, 'register', lot('Z1', 'P', 'S1', 'unknown', '5'))).toContainText('記録していない：「数が不明」には数値を持たせない');
  await expect(page.locator('#list tr[data-lot]')).toHaveCount(0);
});

test('AT-02: 10時に100を数え30使用すると、記録上の数70と10時の数えた100を並べ、70を数えたと表示しない', async ({ page }) => {
  await goTo(page, 'stock');
  await recorded(page, 'register', lot('X', 'P', 'S1', 'counted', '100'), '10:00');
  await recorded(page, 'use', { lot: 'X', basis: 'counted', value: '30', usedFor: 'A-001 架空作業W1' }, '10:30');
  await expect(cell(page, 'X', '記録上の数と根拠')).toHaveText('記録上の数70個');
  await expect(cell(page, 'X', '最後に数えた数')).toHaveText('100個（2026-09-29 10:00（日本時間）、操作op1）');
  await page.locator('#list').getByRole('button', { name: 'X', exact: true }).click();
  const detail = page.locator('#detail');
  await expect(detail).toContainText('現在の記録上の数は計算値で、この数を数えたわけではない。');
  await expect(detail).not.toContainText('70個・数えた');
  await expect(detail.getByRole('list').first()).toContainText('＋100個（数えた、操作op1）');
});

test('AT-03・04・05: 確認100にだいたい30・ラベル30・数が不明の箱を足した集計を、根拠と不明を隠さず表示する', async ({ page }) => {
  await goTo(page, 'stock');
  await recorded(page, 'register', lot('E1', 'P', 'S1', 'counted', '100'));
  await recorded(page, 'register', lot('A1', 'Q', 'S1', 'counted', '100'));
  await recorded(page, 'register', lot('A2', 'Q', 'S1', 'approximate', '30'));
  await recorded(page, 'register', lot('L1', 'R', 'S1', 'counted', '100'));
  await recorded(page, 'register', lot('L2', 'R', 'S1', 'label', '30'));
  await recorded(page, 'register', lot('U1', 'P', 'S1', 'unknown', ''));
  await expect(totals(page)).toContainText('品目Q（個）：在庫 記録上の数約130個');
  await expect(totals(page)).toContainText('品目R（台）：在庫 記録上の数130台・中身未確認部分あり');
  // AT-04の「うち30は中身未確認」は、同じ一覧の保管単位行で読める。
  await expect(cell(page, 'L2', '記録上の数と根拠')).toHaveText('30台・表示の数（ラベル・パッケージ）・中身未確認');
  await expect(cell(page, 'L1', '記録上の数と根拠')).toHaveText('100台・数えた');
  await expect(totals(page)).toContainText('品目P（個）：在庫 数値部分の小計100個、ほかに数が不明1件。全体数量は不明');
});
