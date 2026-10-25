import { expect, test } from '@playwright/test';
import { goTo, lot, record, recorded, startEmpty, storageBytes, waitForApp } from './helpers.ts';

test('MST-05・F1-B 6.10: 1箱あたりの数の表記を拒否しても原文と保存を保ち、十進整数の換算は再読込後も保つ', async ({ page }) => {
  await startEmpty(page);
  const before = await storageBytes(page);
  await goTo(page, 'issues');
  const history = await page.locator('#history').innerText();
  for (const raw of ['1e1', '12.0']) {
    await goTo(page, 'stock');
    await expect(await record(page, 'masterPerBox', { target: 'item:S', perBox: raw, reason: '架空の包装変更' }, '10:00'))
      .toContainText('記録していない：1箱あたりの数は1以上の整数にする');
    await expect(page.getByRole('form', { name: '操作の入力' }).locator('[name=perBox]')).toHaveValue(raw);
    expect(await storageBytes(page)).toEqual(before);
    await goTo(page, 'issues');
    expect(await page.locator('#history').innerText()).toBe(history);
  }

  await goTo(page, 'stock');
  await recorded(page, 'masterPerBox', { target: 'item:S', perBox: '0012', reason: '架空の包装変更' }, '10:00');
  const saved = await storageBytes(page);
  expect(saved).not.toEqual(before);
  await page.reload();
  await waitForApp(page);
  expect(await storageBytes(page)).toEqual(saved);
  await recorded(page, 'register', lot('S-new', 'S', 'S1', 'counted', '1', { unit: '箱', project: 'common' }), '11:00');
  const screws = page.locator('#consumables article[data-stock="S"]');
  await goTo(page, 'supply');
  await expect(screws).toContainText('未開封の箱：S-new 1箱');
  await expect(screws).toContainText('数量合計（本） 12本');
});
