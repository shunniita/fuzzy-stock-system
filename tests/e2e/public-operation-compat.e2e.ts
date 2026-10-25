import { expect, test, type Page } from '@playwright/test';
import { legacyOperationCases } from '../fixtures/public-operation-v10/cases.ts';
import { decodePending, decodeSnapshot } from '../../src/ui/storageparse.ts';
import { draftOf, readyToSave, snapshotOf } from './conflict-helpers.ts';
import { waitForApp, waitForPersistence } from './helpers.ts';

async function install(page: Page, entries: Readonly<Record<string, string>>, draft?: string): Promise<void> {
  await page.goto('/'); await waitForApp(page);
  await page.evaluate(({ entries, draft }) => {
    localStorage.clear(); sessionStorage.clear();
    for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
    if (draft !== undefined) sessionStorage.setItem('fuzzy-stock/conflict-draft', draft);
  }, { entries, draft });
  await page.reload(); await waitForApp(page);
}

for (const fixture of legacyOperationCases) {
  for (const [saved, action] of [[false, 'retry'], [true, 'retry'], [true, 'confirm']] as const) {
    test(`公開用語: 旧${fixture.name}の固定pending 保存済み=${saved} ${action}で一度だけ確定する`, async ({ page }) => {
      const entries = saved ? fixture.saved : fixture.unsaved;
      const pending = decodePending(JSON.parse(entries['fuzzy-stock/pending']));
      await install(page, entries);
      await expect(page.locator('#save')).toContainText(fixture.opLabel);
      await expect(page.locator('#save')).toContainText('元資料「0012」');
      expect(await page.evaluate(() => localStorage.getItem('fuzzy-stock/pending'))).toBe(entries['fuzzy-stock/pending']);
      await page.getByRole('button', { name: '照会する', exact: true }).click();
      await expect(page.locator('#save')).toContainText(`1単位中${saved ? 1 : 0}単位が保存済み`);
      await page.getByRole('button', { name: action === 'confirm' ? '保存済みとして確定する' : '再試行する', exact: true }).click();
      await waitForPersistence(page);
      await expect(page.locator('#save')).toContainText(saved ? '保存済み' : '保存した');
      const after = await snapshotOf(page);
      const expected = decodeSnapshot(JSON.parse(fixture.saved['fuzzy-stock/slot-B']));
      expect(after.ledger).toEqual(expected.ledger);
      expect(after.supply).toEqual(expected.supply);
      expect(after.ops['op1']?.fingerprint).toBe(pending.fingerprint);
      expect(after.ledger.history).toHaveLength(1);
      if (fixture.name === 'receive') expect(after.ledger.lots['PUBLIC-OLD']?.quantity).toMatchObject({ kind: 'known', numeric: { value: 12, approximate: false, unconfirmed: 'none' } });
      else expect(after.ledger.masters.items['PUBLIC-OLD']?.name).toBe('原文の品目');
      expect(await page.evaluate(() => localStorage.getItem('fuzzy-stock/pending'))).toBeNull();
      await page.reload(); await waitForApp(page);
      const reopened = await snapshotOf(page);
      expect(reopened.ledger).toEqual(after.ledger);
      expect(reopened.supply).toEqual(after.supply);
      expect(reopened.ops).toEqual(after.ops);
    });
  }

  test(`公開用語: 旧${fixture.name}の固定退避を原文のまま確認して取り下げる`, async ({ page }) => {
    await install(page, { 'fuzzy-stock/head': 'A', 'fuzzy-stock/slot-A': fixture.baseRaw }, fixture.draftRaw);
    const before = await snapshotOf(page);
    const panel = page.locator('#conflict');
    await expect(panel).toContainText(fixture.opLabel);
    await expect(panel).toContainText('保管・使用単位と元資料');
    await expect(panel).toContainText('元資料「0012」');
    expect(await draftOf(page)).toBe(fixture.draftRaw);
    await readyToSave(panel, '旧操作の入力を取り下げ、原文を残す');
    await panel.getByRole('button', { name: /で保存する/ }).click();
    await expect(panel).toContainText('確定済み');
    expect(await draftOf(page)).toBeNull();
    const after = await snapshotOf(page);
    expect(after.ledger).toEqual(before.ledger);
    expect(after.supply).toEqual(before.supply);
    expect(after.conflictReviews).toHaveLength(1);
    expect(after.conflictReviews[0]?.draft).toEqual(JSON.parse(fixture.draftRaw).draft);
    await page.reload(); await waitForApp(page);
    expect((await snapshotOf(page)).conflictReviews).toEqual(after.conflictReviews);
  });
}
