import { expect, test } from '@playwright/test';
import { goTo, openMasterKind, opLabels, recorded, startEmpty, waitForApp } from './helpers.ts';
import { draftOf, snapshotOf } from './conflict-helpers.ts';

test('登録情報の行から操作: 対象を固定して名称を変え、一覧と履歴を更新する', async ({ page }) => {
  await startEmpty(page);
  await goTo(page, 'masters');
  const masters = page.locator('#masters');
  await masters.locator('tr[data-master="item:P"]').getByRole('button').first().click();
  const actions = masters.getByRole('group', { name: 'この登録情報にできる操作' });
  await expect(actions.getByRole('button', { name: opLabels.masterReactivate, exact: true })).toHaveCount(0);
  await actions.getByRole('button', { name: opLabels.masterRename, exact: true }).click();
  const form = page.getByRole('form', { name: '操作の入力' });
  await expect(form.locator('[name=op]')).toHaveValue('masterRename');
  await expect(form.locator('input[type=hidden][name=target]')).toHaveValue('item:P');
  await expect(form.locator('select[name=target]')).toHaveCount(0);
  await form.locator('[name=name]').fill('架空部品P改');
  await form.locator('[name=reason]').fill('架空の改名');
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
  expect((await snapshotOf(page)).ledger.masters.items.P?.name).toBe('架空部品P改');
  await expect(masters.locator('tr[data-master="item:P"]')).toContainText('架空部品P改');
  await expect(masters.getByRole('table', { name: '登録情報の変更の履歴' })).toBeVisible();
});

test('登録情報の行から利用停止: 記録後は結果を示し、同じ行に再開だけを出す', async ({ page }) => {
  await startEmpty(page);
  await goTo(page, 'masters');
  const masters = page.locator('#masters');
  await openMasterKind(page, '場所');
  await masters.locator('tr[data-master="location:S2"]').getByRole('button').first().click();
  await expect(page.locator('#master-selected-h')).toBeFocused();
  await masters.locator('[name=master-history]').selectOption('location:S1');
  await expect(masters.locator('[name=master-history]')).toBeFocused();
  await masters.locator('[name=master-history]').selectOption('location:S2');
  await masters.getByRole('group', { name: 'この登録情報にできる操作' }).getByRole('button', { name: opLabels.masterDeactivate, exact: true }).click();
  const form = page.getByRole('form', { name: '操作の入力' });
  await form.locator('[name=reason]').fill('架空の棚撤去');
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
  await expect(form.locator('select[name=target]')).toBeVisible();
  await expect(masters.locator('tr[data-master="location:S2"]')).toContainText('利用停止');
  const actions = masters.getByRole('group', { name: 'この登録情報にできる操作' });
  await expect(actions.getByRole('button', { name: opLabels.masterDeactivate, exact: true })).toHaveCount(0);
  await expect(actions.getByRole('button', { name: opLabels.masterReactivate, exact: true })).toBeVisible();
});

test('登録情報の新規登録: 区分ごとの入口が対象なしで登録の操作を開く', async ({ page }) => {
  await startEmpty(page);
  await goTo(page, 'masters');
  for (const [kind, name, op] of [['場所', '場所を登録', 'masterLocation'], ['品目', '品目を登録', 'masterItem'], ['担当者', '担当者を登録', 'masterActor'], ['工程', '工程を登録', 'masterProcess']] as const) {
    await openMasterKind(page, kind);
    await page.locator('#masters').getByRole('button', { name, exact: true }).click();
    await expect(page.locator('#input [name=op]')).toHaveValue(op);
  }
  await openMasterKind(page, '場所');
  await page.locator('#masters').getByRole('button', { name: '場所を登録', exact: true }).click();
  await expect(page.locator('#input').getByLabel('コード', { exact: true })).toBeVisible();
  await expect(page.getByRole('table', { name: '場所の登録情報' }).getByRole('columnheader').first()).toHaveText('コード');
});

test('登録情報の絞り込み: 文字で行を絞り、該当がなければそう示し、描き直しても残る', async ({ page }) => {
  await startEmpty(page);
  await goTo(page, 'masters');
  const masters = page.locator('#masters');
  const query = masters.getByLabel('名称・品番・コードで絞り込み', { exact: true });
  await query.fill('ｓ１');
  await openMasterKind(page, '品目');
  await expect(masters.locator('tr[data-master="item:P"]')).toBeHidden();
  await expect(masters.getByRole('table', { name: '品目の登録情報' })).toBeHidden();
  await expect(masters).toContainText('品目：該当なし');
  await openMasterKind(page, '場所');
  await expect(masters.locator('tr[data-master="location:S1"]')).toBeVisible();
  await expect(masters.locator('tr[data-master="location:S2"]')).toBeHidden();
  await masters.locator('tr[data-master="location:S1"]').getByRole('button').first().click();
  await expect(masters.getByLabel('名称・品番・コードで絞り込み', { exact: true })).toHaveValue('ｓ１');
  await expect(masters.locator('tr[data-master="location:S2"]')).toBeHidden();
  await masters.getByLabel('名称・品番・コードで絞り込み', { exact: true }).fill('');
  await openMasterKind(page, '品目');
  await expect(masters.locator('tr[data-master="item:P"]')).toBeVisible();
});

test('入力欄の切り替え: 作業の種類と操作を一つの枠に収める', async ({ page }) => {
  await startEmpty(page);
  const picker = page.locator('#input .operation-picker');
  const choice = page.locator('#input form > .operation-choice');
  await expect(choice.locator('[name=op]')).toHaveCount(1);
  const background = (node: typeof picker) => node.evaluate(element => getComputedStyle(element).backgroundColor);
  expect(await background(choice)).toBe(await background(picker));
  const pickerBox = (await picker.boundingBox())!, choiceBox = (await choice.boundingBox())!;
  expect(Math.abs(choiceBox.y - (pickerBox.y + pickerBox.height))).toBeLessThan(1);
});

test('固定した登録情報の競合: 対象を退避し、再読込後も参照できる', async ({ page, context }) => {
  await startEmpty(page);
  const other = await context.newPage(); await other.goto('/'); await waitForApp(other);
  await goTo(other, 'masters');
  await other.locator('#masters tr[data-master="item:P"]').getByRole('button').first().click();
  await other.locator('#masters').getByRole('group', { name: 'この登録情報にできる操作' }).getByRole('button', { name: opLabels.masterRename, exact: true }).click();
  await other.getByRole('form', { name: '操作の入力' }).locator('[name=name]').fill('架空部品P競合');
  await recorded(page, 'masterRename', { target: 'item:Q', name: '架空部品Q改', reason: '架空の改名' });
  await expect(other.locator('#conflict')).toContainText('未解消');
  const draft = await draftOf(other);
  for (const text of ['架空部品P競合', '固定した対象：']) expect(draft).toContain(text);
  await other.reload(); await waitForApp(other);
  await expect(other.locator('#conflict')).toContainText('架空部品P競合');
});
