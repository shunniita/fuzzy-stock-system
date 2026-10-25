import { expect, test } from '@playwright/test';
import { cell, goTo, lot, record, recorded, startEmpty, storageBytes, waitForApp } from './helpers.ts';

// ADR-019の同一入力欄の再送契約。新しい入力欄の時刻はneed-import.e2e.tsで別に確認する。
test('REC-03a・UI-07: 同じ入力欄で検査拒否を直して再送しても、最初の担当者と入力した日時を保持する', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-14T09:00:00+09:00'));
  await startEmpty(page);
  await recorded(page, 'register', lot('existing', 'P', 'S1', 'counted', '8'));
  const before = await storageBytes(page);
  await expect(await record(page, 'register', lot('existing', 'P', 'S1', 'counted', '5'), '08:00')).toContainText('使用済み');
  expect(await storageBytes(page)).toEqual(before);
  await page.clock.setFixedTime(new Date('2026-10-14T10:00:00+09:00'));
  await page.locator('#actor').selectOption('架空担当B');
  const form = page.getByRole('form', { name: '操作の入力' });
  await form.locator('[name=newId]').fill('corrected');
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('記録した');
  await goTo(page, 'issues');
  const entry = page.locator('#history li').filter({ hasText: '登録：corrected' });
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText('発生 2026-09-29 08:00（日本時間）');
  await expect(entry).toContainText('記録 2026-10-14 09:00（日本時間）　担当 架空担当A');
  await expect(page.locator('#updated')).toHaveText('最終記録更新：2026-10-14 09:00（日本時間）');
});

test('REC-03a: 同じ入力欄で包含の回答を後から送っても最初の入力した日時を保持する', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-14T09:00:00+09:00'));
  await startEmpty(page);
  await recorded(page, 'register', lot('counted', 'P', 'S1', 'counted', '8'), '09:00');
  const before = await storageBytes(page);
  await expect(await record(page, 'use', { lot: 'counted', basis: 'counted', value: '3', usedFor: '架空AT45後入力' }, '08:00')).toContainText('回答が必要');
  expect(await storageBytes(page)).toEqual(before);
  await page.clock.setFixedTime(new Date('2026-10-14T10:00:00+09:00'));
  const form = page.getByRole('form', { name: '操作の入力' });
  await form.locator('[name=inclusion]').selectOption('included');
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('記録した');
  await expect(cell(page, 'counted', '記録上の数と根拠')).toHaveText('8個・数えた');
  await goTo(page, 'issues');
  await expect(page.locator('#history li').filter({ hasText: '架空AT45後入力' })).toContainText('記録 2026-10-14 09:00（日本時間）');
});

test('AT-23: 保存を試みた入力の再送では最初の担当者と入力した日時を保持する', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-14T09:00:00+09:00'));
  await startEmpty(page); await page.goto('/?test'); await waitForApp(page);
  await page.evaluate(() => window.fuzzyStockTest!.failMidwayAt(1));
  await record(page, 'register', lot('retry', 'P', 'S1', 'counted', '5'), '08:00');
  await expect(page.locator('#save')).toContainText('保存できなかった');
  await page.clock.setFixedTime(new Date('2026-10-14T10:00:00+09:00'));
  await page.locator('#actor').selectOption('架空担当B');
  await page.getByRole('form', { name: '操作の入力' }).getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('記録した');
  await goTo(page, 'issues');
  const entry = page.locator('#history li').filter({ hasText: '登録：retry' });
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText('記録 2026-10-14 09:00（日本時間）　担当 架空担当A');
  await goTo(page, 'stock');
  await expect(cell(page, 'retry', '記録上の数と根拠')).toHaveText('5個・数えた');
});
