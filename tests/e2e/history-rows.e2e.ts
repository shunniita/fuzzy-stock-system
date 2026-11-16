import { expect, test, type Page } from '@playwright/test';
import { goTo, lot, opLabels, recorded, startEmpty } from './helpers.ts';
import { snapshotOf } from './conflict-helpers.ts';

const form = (page: Page) => page.getByRole('form', { name: '操作の入力' });
const actions = (page: Page) => page.locator('#history').getByRole('group', { name: 'この記録にできる操作' });

async function pickEvent(page: Page, id: string): Promise<void> {
  await goTo(page, 'issues');
  await page.locator('#history li').getByRole('button', { name: id, exact: true }).click();
  await expect(page.locator('#event-selected-h')).toBeFocused();
}

async function submit(page: Page): Promise<void> {
  await form(page).getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
}

test('履歴の行から取り消し: 使用を固定して取り消し、取り消した記録には日時の訂正だけを出す', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('X', 'P', 'S1', 'counted', '100'), '09:00');
  await recorded(page, 'use', { lot: 'X', basis: 'counted', value: '10', usedFor: '架空の誤使用' }, '10:00');
  await pickEvent(page, 'op2');
  await actions(page).getByRole('button', { name: opLabels.void, exact: true }).click();
  await expect(form(page).locator('[name=op]')).toHaveValue('void');
  await expect(form(page).locator('input[type=hidden][name=target]')).toHaveValue('op2');
  await expect(form(page).locator('select[name=target]')).toHaveCount(0);
  await form(page).locator('[name=reason]').fill('架空の誤記');
  await submit(page);
  expect((await snapshotOf(page)).ledger.history.at(-1)).toMatchObject({ kind: 'void', targetEventId: 'op2' });
  await expect(form(page).locator('select[name=target]')).toBeVisible();
  await expect(actions(page).getByRole('button', { name: opLabels.void, exact: true })).toHaveCount(0);
  await expect(actions(page).getByRole('button', { name: opLabels.correctTime, exact: true })).toBeVisible();
});

test('履歴の行から日時の訂正: 登録には取り消しを出さず、固定した記録の日時を直す', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('X', 'P', 'S1', 'counted', '100'), '09:00');
  await pickEvent(page, 'op1');
  await expect(actions(page).getByRole('button', { name: opLabels.void, exact: true })).toHaveCount(0);
  await actions(page).getByRole('button', { name: opLabels.correctTime, exact: true }).click();
  await expect(form(page).locator('input[type=hidden][name=target]')).toHaveValue('op1');
  await form(page).locator('[name=corrected]').fill('2026-10-01T08:30');
  await submit(page);
  expect((await snapshotOf(page)).ledger.history.at(-1)).toMatchObject({ kind: 'correctTime', targetEventId: 'op1' });
  await expect(page.locator('#history li').filter({ hasText: /^op1　/ })).toContainText('訂正前');
});
