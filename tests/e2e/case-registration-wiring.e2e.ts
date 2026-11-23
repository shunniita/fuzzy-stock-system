import { expect, test, type Locator, type Page } from '@playwright/test';
import { goTo, record, recorded, selectOperation, startEmpty, waitForPersistence } from './helpers.ts';

const formOf = (page: Page) => page.getByRole('form', { name: '操作の入力' });
async function choose(page: Page, key: string): Promise<Locator> {
  await goTo(page, 'stock');
  await selectOperation(formOf(page).locator('[name=op]'), key);
  return formOf(page);
}
async function submit(page: Page): Promise<void> {
  await formOf(page).getByRole('button', { name: '記録する', exact: true }).click();
  await waitForPersistence(page);
}

test('案件の登録の流れ・登録済みの案内・総予定数の超過の確認が画面全体につながる', async ({ page }) => {
  await startEmpty(page);
  let form = await choose(page, 'templateSave');
  await form.getByLabel('セット名（120文字まで）').fill('架空製品Rの構成');
  await form.locator('[name=templateProduct]').selectOption('R');
  await form.locator('[name=templateProductUnit]').selectOption('台');
  await form.locator('[name=t0item]').selectOption('P');
  await form.locator('[name=t0unit]').selectOption('個');
  await form.locator('[name=t0perSet]').fill('1');
  await form.locator('[name=t0location]').selectOption('S1');
  await submit(page);
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');

  form = await choose(page, 'masterCase');
  await expect(form.getByLabel('使うセット')).toBeVisible();
  await form.locator('[name=code]').fill('CASE-1');
  await form.locator('[name=caseSet]').selectOption({ index: 1 });
  await form.locator('[name=caseTotal]').fill('1');
  await form.getByRole('button', { name: '必要明細をプレビュー', exact: true }).click();
  await form.locator('[name=caseRegistrationConfirmed]').check();
  await submit(page);
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');

  form = await choose(page, 'masterCase');
  await form.locator('[name=code]').fill('CASE-1');
  const notice = form.locator('[data-case-notice]');
  await expect(notice).toContainText('CASE-1');
  await notice.getByRole('button', { name: 'この案件を開く', exact: true }).click();
  await expect(page.locator('#case')).toBeVisible();
  await expect(page.locator('#case select')).toHaveValue('CASE-1');
  await expect(page.locator('#case-h')).toBeFocused();

  form = await choose(page, 'templateNeedGenerate');
  await form.locator('[name=needCase]').fill('CASE-1');
  await expect(form.locator('[data-case-notice]').getByRole('button', { name: 'この案件を開く', exact: true })).toBeVisible();

  await goTo(page, 'stock');
  const start = { process: 'R組立', newId: 'R-work', item: 'R', unit: '台', project: 'CASE-1', location: 'T', basis: 'counted', value: '2' };
  await expect(await record(page, 'start', start)).toContainText('総予定数を1台超える');
  await expect(formOf(page).getByText('確認した（上の内容を確かめたうえで記録する）')).toBeVisible();
  await formOf(page).locator('[name=confirmed]').check();
  await submit(page);
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
  await recorded(page, 'masterCase', { code: 'CASE-2', name: '架空用途' });
});
