import { expect, test } from '@playwright/test';
import { decodeSnapshot } from '../../src/ui/storageparse.ts';
import { goTo, answer, cell, lot, record, recorded, startEmpty } from './helpers.ts';

test.use({ trace: 'retain-on-failure' });

test.beforeEach(async ({ page }) => startEmpty(page));

for (const reload of [false, true]) {
  const route = reload ? '再読込後' : '保存の戻り値';

  test(`FH-C01・REC-03b ${route}: 移動後の過去時点の数え直しには包含の回答を求めない`, async ({ page }) => {
    await recorded(page, 'register', lot('X', 'P', 'S1', 'counted', '100'), '09:00');
    await recorded(page, 'move', { lot: 'X', location: 'S2' }, '11:00');
    if (reload) await page.reload();
    await recorded(page, 'recount', { lot: 'X', value: '100', causeUnknown: true }, '10:00');
    await expect(cell(page, 'X', '記録上の数と根拠')).toHaveText('100個・数えた');
    await expect(cell(page, 'X', '場所')).toHaveText('S2');
    await expect(cell(page, 'X', '確認が必要')).toHaveText('なし');
    await goTo(page, 'issues');
    await expect(page.locator('#history').getByRole('listitem')).toHaveCount(3);
    await page.reload();
    await expect(cell(page, 'X', '記録上の数と根拠')).toHaveText('100個・数えた');
  });

  for (const [basis, name] of [['label', 'ラベル'], ['approximate', 'だいたい']] as const) {
    test(`FH-C01・REC-02b ${route}: ${name}の誤使用を取消すと移動先でも元の数えたへ戻る`, async ({ page }) => {
      await recorded(page, 'register', lot('X', 'P', 'S1', 'counted', '100'), '09:00');
      await recorded(page, 'use', { lot: 'X', basis, value: '10', usedFor: '架空の誤使用' }, '10:00');
      await recorded(page, 'move', { lot: 'X', location: 'S2' }, '11:00');
      if (reload) await page.reload();
      await recorded(page, 'void', { target: 'op2', reason: '架空の記録誤り' }, '12:00');
      await expect(cell(page, 'X', '記録上の数と根拠')).toHaveText('100個・数えた');
      await expect(cell(page, 'X', '場所')).toHaveText('S2');
      await goTo(page, 'issues');
      await expect(page.locator('#history')).toContainText('記録誤りとして取消済み');
      await expect(page.locator('#history').getByRole('listitem')).toHaveCount(4);
      await page.reload();
      await expect(cell(page, 'X', '記録上の数と根拠')).toHaveText('100個・数えた');
    });
  }

  test(`FH-C01・ADR-009補足 ${route}: 数値を変えない0個の使用でも元の観測について包含を尋ねる`, async ({ page }) => {
    await recorded(page, 'register', lot('X', 'P', 'S1', 'counted', '100'), '09:00');
    await recorded(page, 'use', { lot: 'X', basis: 'counted', value: '0', usedFor: '架空作業' }, '11:00');
    if (reload) await page.reload();
    await expect(await record(page, 'recount', { lot: 'X', value: '100', causeUnknown: true }, '10:00')).toContainText('回答が必要');
    await goTo(page, 'issues');
    await expect(page.locator('#history').getByRole('listitem')).toHaveCount(2);
    await answer(page, 'included');
    await goTo(page, 'stock');
    await expect(cell(page, 'X', '記録上の数と根拠')).toHaveText('100個・数えた');
    await goTo(page, 'issues');
    await expect(page.locator('#history').getByRole('listitem')).toHaveCount(3);
  });
}

test('F1-0 要件3: 版1の写しを読み込んで表示し、次の保存から今の版（9）で書く', async ({ page }) => {
  await recorded(page, 'register', lot('X', 'P', 'S1', 'unknown', ''), '09:00');
  await recorded(page, 'use', { lot: 'X', basis: 'counted', value: '3', usedFor: '架空作業' }, '10:00');
  const slotOf = () => page.evaluate(() => localStorage.getItem(`fuzzy-stock/slot-${localStorage.getItem('fuzzy-stock/head')}`) ?? '');
  await goTo(page, 'stock');
  const shown = await cell(page, 'X', '記録上の数と根拠').textContent() ?? '';
  const current = await slotOf();
  expect(JSON.parse(current)).toMatchObject({ version: 10, conflictReviews: [], quantities: expect.any(Object) });
  const v1 = JSON.stringify({ ...decodeSnapshot(JSON.parse(current)), version: 1 }, (key, value: unknown) => key === 'unitSteps' || key === 'conflictReviews' || key === 'receiptTemplates' || key === 'itemLabels' ? undefined : value);
  await page.evaluate(text => localStorage.setItem(`fuzzy-stock/slot-${localStorage.getItem('fuzzy-stock/head')}`, text), v1);
  await page.reload();
  await expect(cell(page, 'X', '記録上の数と根拠')).toHaveText(shown);
  await goTo(page, 'issues');
  await expect(page.locator('#history').getByRole('listitem')).toHaveCount(2);
  expect(await slotOf()).toBe(v1);
  expect(decodeSnapshot(JSON.parse(v1)).ledger.history.map(event => event.itemLabels)).toEqual([{ kind: 'legacy-unavailable' }, { kind: 'legacy-unavailable' }]);
  await recorded(page, 'move', { lot: 'X', location: 'S2' }, '11:00');
  await goTo(page, 'stock');
  await expect(cell(page, 'X', '場所')).toHaveText('S2');
  const migrated = JSON.parse(await slotOf());
  expect(migrated).toMatchObject({ version: 10, conflictReviews: [], quantities: expect.any(Object) });
  const history = decodeSnapshot(migrated).ledger.history;
  expect(history).toHaveLength(3);
  expect(history.slice(0, 2).map(event => event.itemLabels)).toEqual([{ kind: 'legacy-unavailable' }, { kind: 'legacy-unavailable' }]);
  expect(history[2]).toHaveProperty('itemLabels', { kind: 'recorded', items: { P: { name: '架空部品P', code: 'P' } } });
});
