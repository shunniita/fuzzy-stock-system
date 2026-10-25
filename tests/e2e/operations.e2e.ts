import { expect, test } from '@playwright/test';
import { selectOperation, goTo, cell, lot, recorded, row, startEmpty, totals } from './helpers.ts';

test.beforeEach(async ({ page }) => startEmpty(page));

test('AT-06: ラベル100の箱から30を数えて取り出すと、取り出した30だけが数えたで、残りは記録上の数70・中身未確認', async ({ page }) => {
  await goTo(page, 'stock');
  await recorded(page, 'register', lot('X', 'P', 'S1', 'label', '100'));
  await recorded(page, 'split', { lot: 'X', childId: 'C', basis: 'counted', value: '30' });
  await expect(cell(page, 'C', '記録上の数と根拠')).toHaveText('30個・数えた');
  await expect(cell(page, 'X', '記録上の数と根拠')).toHaveText('記録上の数70個・中身未確認');
  await expect(cell(page, 'X', '最後に数えた数')).toHaveText('数えた記録なし');
});

test('AT-10: 部品10個・半製品3台・ネジ2箱を足さず、箱を本へ換算しない', async ({ page }) => {
  await goTo(page, 'stock');
  await recorded(page, 'register', lot('P1', 'P', 'S1', 'counted', '10'));
  await recorded(page, 'register', lot('R1', 'R', 'S1', 'counted', '3'));
  await recorded(page, 'register', lot('SB', 'S', 'S2', 'counted', '2', { unit: '箱', project: 'common' }));
  await recorded(page, 'register', lot('SL', 'S', 'S2', 'approximate', '500', { unit: '本', project: 'common' }));
  const list = totals(page).getByRole('listitem');
  await expect(list).toHaveText([
    /^品目P（個）：在庫 10個・数えた/,
    /^品目R（台）：在庫 3台・数えた/,
    /^品目S（箱）：在庫 2箱・数えた/,
    /^品目S（本）：在庫 約500本・だいたい/,
  ]);
  await expect(totals(page)).not.toContainText('15');
  await expect(totals(page)).not.toContainText('502');
});

test('AT-11: 棚100から作業台へ30移すと棚70・作業台30で部署計100、外へ10渡すと部署計90', async ({ page }) => {
  await goTo(page, 'stock');
  await recorded(page, 'register', lot('X', 'P', 'S1', 'counted', '100'), '10:00');
  await recorded(page, 'splitMove', { lot: 'X', childId: 'Y', basis: 'counted', value: '30', location: 'T' }, '11:00');
  await expect(cell(page, 'X', '場所')).toHaveText('S1');
  await expect(cell(page, 'X', '記録上の数と根拠')).toHaveText('記録上の数70個');
  await expect(cell(page, 'Y', '場所')).toHaveText('T');
  await expect(cell(page, 'Y', '記録上の数と根拠')).toHaveText('30個・数えた');
  await expect(totals(page)).toContainText('在庫 記録上の数100個');
  await recorded(page, 'handover', { lot: 'Y', basis: 'counted', value: '10', counterpart: '架空取引先OUT' }, '13:00');
  await expect(totals(page)).toContainText('在庫 記録上の数90個');
  await goTo(page, 'issues');
  await expect(page.locator('#history')).toContainText('外へ出す（譲渡・持ち出し）：Yから10個（数えた）、相手先または処置 架空取引先OUT');
});

test('AT-13: 100から30使用し未使用の2を不良にすると、在庫70・使用可能68・不良2。返却待ちを重ねても除外は2', async ({ page }) => {
  await goTo(page, 'stock');
  await recorded(page, 'register', lot('X', 'P', 'S1', 'counted', '100'), '10:00');
  await recorded(page, 'use', { lot: 'X', basis: 'counted', value: '30', usedFor: 'A-001 架空作業W1' }, '10:30');
  await recorded(page, 'split', { lot: 'X', childId: 'D', basis: 'counted', value: '2' }, '11:00');
  await recorded(page, 'hold', { lot: 'D', reason: 'defective' }, '11:00');
  await expect(totals(page)).toContainText('在庫 記録上の数70個／使用可能 記録上の数68個／取り分け 2個・数えた');
  await expect(cell(page, 'D', '取り分けた理由')).toHaveText('不良');
  await recorded(page, 'hold', { lot: 'D', reason: 'returnPending' }, '11:10');
  await expect(cell(page, 'D', '取り分けた理由')).toHaveText('不良・返却待ち');
  await expect(totals(page)).toContainText('在庫 記録上の数70個／使用可能 記録上の数68個／取り分け 2個・数えた');
});

test('AT-21: 記録上の数53を別の担当が実数52へ原因不明で訂正すると、前後・差異・確認時点・訂正者が残り、架空の使用を要求しない', async ({ page }) => {
  await goTo(page, 'stock');
  await recorded(page, 'register', lot('X', 'P', 'S1', 'counted', '60'), '09:00');
  await recorded(page, 'use', { lot: 'X', basis: 'counted', value: '7', usedFor: 'A-001 架空作業W1' }, '10:00');
  await page.locator('#actor').selectOption('架空担当B');
  await recorded(page, 'recount', { lot: 'X', value: '52', causeUnknown: true }, '15:00');
  await expect(cell(page, 'X', '記録上の数と根拠')).toHaveText('52個・数えた');
  await expect(cell(page, 'X', '最後に数えた数')).toHaveText('52個（2026-09-29 15:00（日本時間）、操作op3）');
  const history = page.locator('#history');
  await goTo(page, 'issues');
  await expect(history).toContainText('担当 架空担当B　数えて確認：X 52個を数えた（それまでの記録上の数53個との差異－1個）、原因不明');
  await expect(history).toContainText('担当 架空担当A　登録：X');
  await expect(history.getByRole('listitem')).toHaveCount(3);
});

test('AT-21・PR2-4: 原因不明のまま原因を書くと原因不明は外れ、書いた原因が履歴に残る。原因不明を選び直すと記述は消える', async ({ page }) => {
  await goTo(page, 'stock');
  await recorded(page, 'register', lot('X', 'P', 'S1', 'counted', '60'), '09:00');
  const form = page.getByRole('form', { name: '操作の入力' });
  await selectOperation(form.locator('[name=op]'), { label: '数えて確認・訂正（原因不明でもよい）' });
  await form.locator('[name=causeText]').fill('架空の記入漏れ');
  await expect(form.locator('[name=causeUnknown]')).not.toBeChecked();
  await form.locator('[name=causeUnknown]').check();
  await expect(form.locator('[name=causeText]')).toHaveValue('');
  await recorded(page, 'recount', { lot: 'X', value: '58', causeText: '架空の記入漏れ' }, '10:00');
  await goTo(page, 'issues');
  await expect(page.locator('#history')).toContainText('原因：架空の記入漏れ');
});

test('PR2-4: 実際の日時を不明にすると日時欄は空になり、日時を入れ直すと不明は外れる', async ({ page }) => {
  const form = page.getByRole('form', { name: '操作の入力' });
  await form.locator('[name=occurredUnknown]').check();
  await expect(form.locator('[name=occurredAt]')).toHaveValue('');
  await form.locator('[name=occurredAt]').fill('2026-09-29T10:00');
  await expect(form.locator('[name=occurredUnknown]')).not.toBeChecked();
});

test('AT-32: 約100から実数30を使用すると約70、全体を72と数えると新基準。別の場所のラベル50は中身未確認のまま', async ({ page }) => {
  await goTo(page, 'stock');
  await recorded(page, 'register', lot('X', 'P', 'S1', 'approximate', '100'));
  await recorded(page, 'register', lot('Y', 'P', 'S2', 'label', '50'));
  await recorded(page, 'use', { lot: 'X', basis: 'counted', value: '30', usedFor: 'A-001 架空作業W1' }, '13:00');
  await expect(cell(page, 'X', '記録上の数と根拠')).toHaveText('記録上の数約70個');
  await recorded(page, 'recount', { lot: 'X', value: '72', causeUnknown: true }, '14:00');
  await expect(cell(page, 'X', '記録上の数と根拠')).toHaveText('72個・数えた');
  await expect(cell(page, 'Y', '記録上の数と根拠')).toHaveText('50個・表示の数（ラベル・パッケージ）・中身未確認');
  await page.locator('#list').getByRole('button', { name: 'X', exact: true }).click();
  await expect(page.locator('#detail')).toContainText('数えて確認：X 72個を数えた（それまでの記録上の数約70個との差異＋約2個）');
  await expect(page.locator('#detail')).toContainText('登録：X（品目P「架空部品P」、案件・用途A-001、S1）約100個・だいたい');
});

test('AT-34: 100を70と30に分け、30を移して統合すると、旧親を重ねず関連が残る。数が不明の箱は丸ごと移り不明のまま', async ({ page }) => {
  await goTo(page, 'stock');
  await recorded(page, 'register', lot('X', 'P', 'S1', 'counted', '100'));
  await recorded(page, 'register', lot('W', 'P', 'T', 'counted', '20'));
  await recorded(page, 'splitMove', { lot: 'X', childId: 'C', basis: 'counted', value: '30', location: 'T' }, '13:00');
  await recorded(page, 'merge', { lot: 'C', target: 'W' }, '14:00');
  await expect(row(page, 'C')).toHaveCount(0);
  await expect(cell(page, 'W', '記録上の数と根拠')).toHaveText('記録上の数50個');
  await expect(totals(page)).toContainText('在庫 記録上の数120個');
  await page.locator('#list').getByRole('button', { name: 'W', exact: true }).click();
  const detail = page.locator('#detail');
  await expect(detail.getByRole('list').first()).toHaveText(/＋20個（数えた、操作op2）.*＋30個（数えた、操作op3）/s);
  await detail.getByRole('button', { name: 'C', exact: true }).click();
  await expect(detail).toContainText('分割元X');
  await expect(detail).toContainText('統合先W');

  await recorded(page, 'register', lot('B', 'P', 'S1', 'unknown', ''), '15:00');
  await recorded(page, 'move', { lot: 'B', location: 'S2' }, '15:10');
  await expect(cell(page, 'B', '場所')).toHaveText('S2');
  await expect(cell(page, 'B', '記録上の数と根拠')).toHaveText('数が不明');
});
