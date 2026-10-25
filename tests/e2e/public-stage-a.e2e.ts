import { expect, test } from '@playwright/test';
import { allOperationLabels, goTo, recorded, selectOperation, startEmpty } from './helpers.ts';
import { decodeSnapshot } from '../../src/ui/storageparse.ts';

test('公開版A: 製品名と保存先を表示し、試行変更と新規再取込の入口を出さない', async ({ page }) => {
  await startEmpty(page);
  await expect(page.locator('h1')).toHaveText('fuzzy-stock-system');
  await expect(page.getByRole('button', { name: 'このソフトについて', exact: true })).toBeVisible();
  const labels = await allOperationLabels(page);
  expect(labels.some(label => label.includes('試行対象の変更'))).toBe(false);
  expect(labels.some(label => label.includes('必要明細の再取込'))).toBe(false);
  expect(labels).toContain('必要明細取込の照合（保留の適用・見送り）');
  await expect(page.locator('#list th', { hasText: '試行対象' })).toHaveCount(0);
  for (const op of ['masterItem', 'masterLocation']) {
    await selectOperation(page.locator('[name=op]'), op);
    await expect(page.locator('[name=trial]')).toHaveCount(0);
  }
  await recorded(page, 'masterItem', { code: 'PUBLIC', name: '公開版の品目', units: '個' });
  await recorded(page, 'masterLocation', { code: 'PUBLIC', name: '公開版の場所', inScope: 'true' });
  await page.reload();
  await goTo(page, 'masters');
  const wire = await page.evaluate(() => localStorage.getItem(`fuzzy-stock/slot-${localStorage.getItem('fuzzy-stock/head')}`));
  expect(wire).not.toBeNull();
  await expect(page.locator('#masters th', { hasText: '試行対象' })).toHaveCount(0);
  const data = decodeSnapshot(JSON.parse(wire!));
  expect(Object.values(data.ledger.masters.items).find(item => item.code === 'PUBLIC')).toMatchObject({ trial: true });
  expect(Object.values(data.ledger.masters.locations).find(item => item.code === 'PUBLIC')).toMatchObject({ trial: true });
});
