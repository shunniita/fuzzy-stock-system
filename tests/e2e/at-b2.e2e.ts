import { expect, test, type Page } from '@playwright/test';
import { selectOperation, goTo, recorded, startEmpty } from './helpers.ts';

// F0-B B2の全体実施AT（AT-07・08・09・17・18・20）を画面から確かめる。AT-42はsupply.e2e.tsとscn02.e2e.tsにある。
const group = (page: Page, id: string) => page.locator(`#supply article[data-group="${id}"]`);
const stock = (page: Page, item: string) => page.locator(`#consumables article[data-stock="${item}"]`);

const need100 = { project: 'B-001', item: 'P', unit: '個', basis: 'counted', value: '100', dueDate: '', source: '架空の必要部品一覧', revision: '初版' };
const lot = (id: string, basis: string, value: string) => ({ newId: id, item: 'P', location: 'S1', project: 'B-001', basis, value });

test('AT-07: 必要な数100に対して在庫が約100は、不足なしと断定せず、数量確認が必要と示す', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'needRegister', need100, '07:00');
  await recorded(page, 'register', lot('L1', 'approximate', '100'), '08:00');
  const g = group(page, 'B-001/P/個');
  await goTo(page, 'supply');
  await expect(g).toContainText('不足 0個（数量確認が必要（だいたいの数を含む））');
  await expect(g.locator('li.warn').filter({ hasText: '数量確認が必要' })).toBeVisible();
  // 不足の解消も、不足なしと断定せず、確定していないと書く。
  await expect(g).toContainText('不足の解消：不足0に見えるが確定していない（数量確認が必要（だいたいの数を含む））');
  await expect(g).not.toContainText('不足の解消：解消');
});

test('AT-08: 総必要100のうち30個が正常に組付け済み、未使用良品70。残り必要70と比べて不足0（30個を再要求しない）', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'needRegister', need100, '07:00');
  await recorded(page, 'register', lot('L1', 'counted', '100'), '08:00');
  await recorded(page, 'use', { lot: 'L1', basis: 'counted', value: '30', usedFor: 'B-001 組付け' }, '09:00');
  const g = group(page, 'B-001/P/個');
  await goTo(page, 'supply');
  await expect(g).toContainText('必要な数 100個／使用済み 30個／在庫（未使用の総数） 70個／使用可能 70個');
  await expect(g).toContainText('不足 0個（帳簿上の不足）');
  await expect(g).toContainText('不足の解消：解消（不足0）');
});

test('AT-08: 数え直しに含まれていた後入力の使用も使用済みに数える。数えないと不足0が30になる', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'needRegister', need100, '07:00');
  await recorded(page, 'register', lot('L1', 'counted', '100'), '08:00');
  await recorded(page, 'recount', { lot: 'L1', value: '70' }, '10:00');
  // 10時の数え直しの前の9時の使用を後入力する。数え直しに含まれていた、と答える。
  const form = page.getByRole('form', { name: '操作の入力' });
  await selectOperation(form.locator('[name=op]'), { label: '使用' });
  await form.locator('[name=lot]').selectOption('L1');
  await form.locator('[name=basis]').selectOption('counted');
  await form.locator('[name=value]').fill('30');
  await form.locator('[name=usedFor]').fill('B-001 組付け');
  await form.locator('[name=occurredAt]').fill('2026-09-29T09:00');
  await form.getByRole('button', { name: '記録する' }).click();
  await expect(page.getByRole('status')).toContainText('回答が必要');
  await form.locator('[name=inclusion]').selectOption('included');
  await form.getByRole('button', { name: '記録する' }).click();
  await expect(page.getByRole('status')).toContainText('記録した');
  const g = group(page, 'B-001/P/個');
  await goTo(page, 'supply');
  await expect(g).toContainText('必要な数 100個／使用済み 30個／在庫（未使用の総数） 70個／使用可能 70個');
  await expect(g).toContainText('不足 0個（帳簿上の不足）');
});

test('AT-09: 必要100を受け取り後、未使用のうち2個が不良。在庫100・良品98・不良2・不足2（不足4にしない）', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'needRegister', need100, '07:00');
  await recorded(page, 'register', lot('L1', 'counted', '100'), '08:00');
  await recorded(page, 'split', { lot: 'L1', childId: 'L1-bad', basis: 'counted', value: '2' }, '09:00');
  await recorded(page, 'hold', { lot: 'L1-bad', reason: 'defective' }, '09:00');
  const g = group(page, 'B-001/P/個');
  await goTo(page, 'supply');
  await expect(g).toContainText('在庫（未使用の総数） 100個／使用可能 98個');
  await expect(g).toContainText('不足 2個（帳簿上の不足）');
  await expect(g).not.toContainText('不足 4個');
  await expect(g).toContainText('除外による不足 2個（除外中：不良 2個');
});

test('AT-17・AT-18: 不足5に5個依頼して良品3個を受け取ると不足2・未着2（作業の再開は自動で記録しない）。5個届いて2個が不良なら到着5・不足解消3・残り不足2', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'needRegister', need100, '07:00');
  await recorded(page, 'register', lot('L1', 'counted', '95'), '08:00');
  await recorded(page, 'stop', { process: 'R組立', item: 'R', project: 'B-001', reason: '部品Pの不足', shortageItem: 'P', shortageValue: '5', affectedUnknown: true }, '08:30');
  await recorded(page, 'requestRecord', { project: 'B-001', item: 'P', unit: '個', quantity: '5', vendor: '架空の仕入先X', requestedOn: '2026-09-29', replyKind: 'none', replyDate: '' }, '09:00');
  const g = group(page, 'B-001/P/個');
  await goTo(page, 'supply');
  await expect(g).toContainText('不足 5個');
  // 良品3個を受け取る。残り不足2・依頼の未着2。依頼や受け取りで作業の再開は自動で記録されない。
  await recorded(page, 'receive', { newId: 'R3', item: 'P', unit: '個', project: 'B-001', location: 'S1', basis: 'counted', value: '3', r1request: 'op4', r1arrived: '3', r1good: '3' }, '10:00');
  await expect(g).toContainText('不足 2個');
  await expect(g).toContainText('依頼の未着 2個');
  await expect(g).toContainText('作業の再開：未再開の中断が1件（再開は別の記録）');
  // 残りの2個が届くが、うち2個が不良。届いた数と不足解消の数は別で、到着しただけでは全解決にならない。
  await recorded(page, 'receive', { newId: 'R2', item: 'P', unit: '個', project: 'B-001', location: 'S1', basis: 'counted', value: '2', r1request: 'op4', r1arrived: '2', r1good: '0' }, '11:00');
  await recorded(page, 'hold', { lot: 'R2', reason: 'defective' }, '11:10');
  await expect(g).toContainText('到着 5個（不足の解消に充てた良品 3個）');
  await expect(g).toContainText('不足 2個');
  await expect(g).toContainText('依頼の未着 0個');
  await expect(g).toContainText('手配対象数 2個');
  await expect(g).toContainText('作業の再開：未再開の中断が1件（再開は別の記録）');
});

test('AT-20: ネジ未開封2箱と、残量が少ない開封箱を記録し、補充は依頼済み。未開封はラベル根拠、開封分は残量区分で、根拠のない本数を作らず、既存の依頼を示す', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', { newId: 'S-BOX', item: 'S', unit: '箱', project: 'common', location: 'S1', basis: 'counted', value: '2' }, '08:00');
  await recorded(page, 'register', { newId: 'S-OPEN', item: 'S', unit: '本', project: 'common', location: 'S1', basis: 'unknown', value: '' }, '08:05');
  await recorded(page, 'remainder', { lot: 'S-OPEN', level: 'few' }, '08:10');
  await recorded(page, 'requestRecord', { project: 'common', item: 'S', unit: '箱', quantity: '1', vendor: '架空の仕入先X', requestedOn: '2026-09-29', replyKind: 'none', replyDate: '' }, '09:00');
  const s = stock(page, 'S');
  await goTo(page, 'supply');
  await expect(s).toContainText('未開封の箱：S-BOX 2箱・数えた');
  await expect(s).toContainText('箱は1箱あたり1000本の表示で換算（現物を数えた値ではない）');
  await expect(s).toContainText('残量区分のみ（数量へは換算しない）：S-OPEN 少ない');
  await expect(s).toContainText('数量合計（本） 2000本・表示の数（ラベル・パッケージ）・中身未確認');
  await expect(s).toContainText('既存の依頼 op4：1箱');
});

test('ネジの欄は共通在庫だけ。案件・用途に属する同じ品目の保管単位と依頼を、共通の合計・補充確認・既存の依頼に混ぜない', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', { newId: 'S-COM', item: 'S', unit: '本', project: 'common', location: 'S1', basis: 'counted', value: '1000' }, '08:00');
  await recorded(page, 'register', { newId: 'S-CASE', item: 'S', unit: '本', project: 'B-001', location: 'S1', basis: 'counted', value: '5000' }, '08:05');
  await recorded(page, 'requestRecord', { project: 'B-001', item: 'S', unit: '箱', quantity: '3', vendor: '架空の仕入先Y', requestedOn: '2026-09-29', replyKind: 'none', replyDate: '' }, '09:00');
  const s = stock(page, 'S');
  await goTo(page, 'supply');
  await expect(s).toContainText('数量合計（本） 1000本・数えた');
  await expect(s).not.toContainText('6000本');
  await expect(s).toContainText('補充確認：数量の数値部分が補充基準3000本を下回る');
  await expect(s).toContainText('既存の依頼はない');
  await expect(s).not.toContainText('架空の仕入先Y');
});
