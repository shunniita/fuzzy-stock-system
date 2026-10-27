import { test, expect } from '@playwright/test';
import { backupButton, downloadVia, goTo, pickFile, record, recorded, row, waitForApp, waitForPersistence } from './helpers.ts';
import { snapshotOf } from './conflict-helpers.ts';

for (const emptyName of ['', '   ']) {
  test(`P1-BLANK: 最初の担当者名${JSON.stringify(emptyName)}を訂正すると本人の名前で一度だけ保存する`, async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-10-26T09:00:00+09:00'));
    await page.goto('/'); await waitForApp(page);
    await expect(await record(page, 'masterActor', { name: emptyName })).toContainText('担当者の名前');
    expect((await snapshotOf(page)).ledger.history).toEqual([]);
    await page.clock.setFixedTime(new Date('2026-10-26T10:00:00+09:00'));
    const form = page.getByRole('form', { name: '操作の入力' });
    await form.locator('[name=name]').fill('練習担当');
    await form.getByRole('button', { name: '記録する', exact: true }).click();
    await waitForPersistence(page);
    await expect(page.locator('#actor')).toHaveValue('練習担当');
    const saved = await snapshotOf(page);
    expect(saved.ledger.history).toHaveLength(1);
    expect(saved.ledger.history[0]).toMatchObject({ actor: '練習担当', recordedAt: '2026-10-26T09:00:00+09:00' });
    await page.reload(); await waitForApp(page);
    expect((await snapshotOf(page)).ledger).toEqual(saved.ledger);
  });
}

for (const action of ['再試行する', '取りやめる']) {
  test(`P1-BLANK: 最初の担当者の登録が保存途中で閉じられても、「${action}」は登録した本人の名前で記録する`, async ({ page }) => {
    await page.goto('/'); await waitForApp(page);
    // pendingの書込直後の保存内容を取っておき、保存完了前に閉じた状態を再現する。
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key: string, value: string): void {
        original.call(this, key, value);
        if (key !== 'fuzzy-stock/pending') return;
        Storage.prototype.setItem = original;
        sessionStorage.setItem('closedAt', JSON.stringify(Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)]))));
      };
    });
    await recorded(page, 'masterActor', { name: '練習担当' });
    await page.evaluate(() => {
      const closed = JSON.parse(sessionStorage.getItem('closedAt') ?? 'null') as Record<string, string>;
      localStorage.clear();
      for (const [key, value] of Object.entries(closed)) localStorage.setItem(key, value);
    });
    await page.reload(); await waitForApp(page);
    await expect(page.locator('#actor')).toHaveValue('');
    await page.getByRole('button', { name: action, exact: true }).click();
    await waitForPersistence(page);
    const saved = await snapshotOf(page);
    expect(saved.saveChecks).toHaveLength(1);
    expect(saved.saveChecks[0]?.resolution).toMatchObject({ outcome: action === '再試行する' ? 'retried' : 'abandoned', actor: '練習担当' });
    expect(JSON.stringify(saved)).not.toMatch(/"actor":"\s*"/);
  });
}

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

test('P1-CONSUMABLES: 空台帳は設定入口を示し、未登録の固定品目を表示しない', async ({ page }) => {
  await page.goto('/'); await waitForApp(page);
  await goTo(page, 'supply');
  await expect(page.locator('#consumables')).toBeVisible();
  await expect(page.locator('#consumables article')).toHaveCount(0);
  await page.getByRole('button', { name: '共通消耗品を設定する' }).click();
  await expect(page.locator('#input [name=op]')).toHaveValue('masterItem');
});
