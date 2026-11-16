import { expect, test, type Page } from '@playwright/test';
import { goTo, opLabels, recorded, startEmpty, waitForApp } from './helpers.ts';
import { draftOf, snapshotOf } from './conflict-helpers.ts';

const request = { project: 'B-001', item: 'P', unit: '個', quantity: '5', vendor: '架空の仕入先X', requestedOn: '2026-10-02', replyKind: 'none', replyDate: '' };
const form = (page: Page) => page.getByRole('form', { name: '操作の入力' });
const actions = (page: Page) => page.locator('#supply').getByRole('group', { name: 'この依頼にできる操作' });

async function pickRequest(page: Page, id: string): Promise<void> {
  await goTo(page, 'supply');
  await page.locator('#supply article[data-group="B-001/P/個"]').getByRole('button', { name: id, exact: true }).click();
  await expect(page.locator('#request-selected-h')).toBeFocused();
}

test('依頼の行から受け取り: 依頼・品目・単位・案件を引き継いで固定し、届いた数を割り当てる', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'requestRecord', request);
  await pickRequest(page, 'op1');
  await actions(page).getByRole('button', { name: opLabels.receive, exact: true }).click();
  const input = form(page);
  await expect(input.locator('[name=op]')).toHaveValue('receive');
  for (const [name, value] of [['r1request', 'op1'], ['item', 'P'], ['unit', '個'], ['project', 'B-001']] as const) {
    await expect(input.locator(`input[type=hidden][name=${name}]`)).toHaveValue(value);
    await expect(input.locator(`select[name=${name}]`)).toHaveCount(0);
  }
  await input.locator('[name=newId]').fill('R1');
  await input.locator('select[name=location]').selectOption('S1');
  await input.locator('[name=basis]').selectOption('counted');
  await input.locator('[name=value]').fill('5');
  await input.locator('[name=r1arrived]').fill('5');
  await input.locator('[name=r1good]').fill('5');
  await input.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
  const arrivals = (await snapshotOf(page)).supply.requests.op1?.arrivals ?? [];
  expect(arrivals.map(a => [a.receiptLotId, a.arrived, a.good])).toEqual([['R1', 5, 5]]);
});

test('依頼の行から注文の確定と取消: 状態で出す操作を変え、条件を外れた固定を解く', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'requestRecord', request);
  await pickRequest(page, 'op1');
  await actions(page).getByRole('button', { name: opLabels.orderConfirm, exact: true }).click();
  await expect(form(page).locator('input[type=hidden][name=request]')).toHaveValue('op1');
  await form(page).getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
  await expect(form(page).locator('select[name=request]')).toBeVisible();
  await expect(actions(page).getByRole('button', { name: opLabels.orderConfirm, exact: true })).toHaveCount(0);

  await actions(page).locator('summary', { hasText: 'その他の操作' }).click();
  await actions(page).getByRole('button', { name: opLabels.requestCancel, exact: true }).click();
  await form(page).locator('[name=reason]').fill('架空の取消');
  await form(page).getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
  await expect(form(page).locator('select[name=request]')).toBeVisible();
  await expect(actions(page)).toHaveCount(0);
});

test('固定した依頼の競合: 依頼と引き継いだ品目を退避し、再読込後も参照できる', async ({ page, context }) => {
  await startEmpty(page);
  await recorded(page, 'requestRecord', request);
  const other = await context.newPage(); await other.goto('/'); await waitForApp(other);
  await pickRequest(other, 'op1');
  await actions(other).getByRole('button', { name: opLabels.receive, exact: true }).click();
  await form(other).locator('[name=newId]').fill('conflict-r');
  await recorded(page, 'replyRecord', { request: 'op1', replyKind: 'estimated', replyDate: '2026-10-08' });
  await expect(other.locator('#conflict')).toContainText('未解消');
  const draft = await draftOf(other);
  for (const text of ['conflict-r', '固定した対象：op1：', '固定した対象：架空部品P（P）', '固定した対象：案件・用途B-001']) expect(draft).toContain(text);
  await other.reload(); await waitForApp(other);
  await expect(other.locator('#conflict')).toContainText('conflict-r');
});

test('依頼の行から返事: 選び直した依頼を固定して開く', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'requestRecord', request);
  await recorded(page, 'requestRecord', { ...request, quantity: '3' });
  await pickRequest(page, 'op1');
  await page.locator('#supply [name=selected-request]').selectOption('op2');
  await expect(page.locator('#supply [name=selected-request]')).toBeFocused();
  await actions(page).getByRole('button', { name: opLabels.replyRecord, exact: true }).click();
  await expect(form(page).locator('input[type=hidden][name=request]')).toHaveValue('op2');
  await form(page).locator('[name=replyKind]').selectOption('estimated');
  await form(page).locator('[name=replyDate]').fill('2026-10-08');
  await form(page).getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
  expect((await snapshotOf(page)).supply.requests.op2?.reply).toEqual({ kind: 'estimated', date: '2026-10-08' });
});
