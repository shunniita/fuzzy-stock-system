import { expect, test, type Page } from '@playwright/test';
import { practiceLedger, type Meta } from '../../src/domain/ledger.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { saveReceiptTemplate } from '../../src/domain/receipt-template.ts';
import { generateTemplateNeeds } from '../../src/domain/template-needs.ts';
import { initial, serialize } from '../../src/ui/storage.ts';
import { goTo, opLabels, recorded, startEmpty, waitForApp } from './helpers.ts';
import { snapshotOf } from './conflict-helpers.ts';

const form = (page: Page) => page.getByRole('form', { name: '操作の入力' });
const caseActions = (page: Page) => page.locator('#case').getByRole('group', { name: 'この案件・用途にできる操作' });

async function openCase(page: Page, id: string): Promise<void> {
  await goTo(page, 'supply');
  await page.locator('[name=case-project]').selectOption(id);
}

async function submit(page: Page): Promise<void> {
  await form(page).getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
}

test('案件詳細から必要な数の登録: 案件を固定して開き、記録した品目に改訂の入口を出す', async ({ page }) => {
  await startEmpty(page);
  await openCase(page, 'B-001');
  for (const op of ['templateReceive', 'receive', 'needRegister'] as const) {
    await expect(caseActions(page).getByRole('button', { name: opLabels[op], exact: true })).toBeVisible();
  }
  await expect(caseActions(page).getByRole('button', { name: opLabels.requestRecord, exact: true })).toBeHidden();
  await caseActions(page).getByRole('button', { name: opLabels.needRegister, exact: true }).click();
  await expect(form(page).locator('[name=op]')).toHaveValue('needRegister');
  await expect(form(page).locator('input[type=hidden][name=project]')).toHaveValue('B-001');
  await expect(form(page).locator('select[name=project]')).toHaveCount(0);
  await form(page).locator('select[name=item]').selectOption('P');
  await form(page).locator('[name=basis]').selectOption('counted');
  await form(page).locator('[name=value]').fill('100');
  await form(page).locator('[name=source]').fill('架空の必要部品一覧');
  await form(page).locator('[name=revision]').fill('初版');
  await submit(page);
  expect(Object.values((await snapshotOf(page)).supply.needs).map(n => [n.project, n.item])).toEqual([[{ kind: 'case', id: 'B-001' }, 'P']]);

  const group = page.locator('#case article[data-item="P"]');
  await group.getByRole('button', { name: opLabels.needRevise, exact: true }).click();
  await expect(form(page).locator('[name=op]')).toHaveValue('needRevise');
  await expect(form(page).locator('input[type=hidden][name=need]')).toHaveValue('op1');
  await form(page).locator('[name=basis]').selectOption('counted');
  await form(page).locator('[name=value]').fill('80');
  await form(page).locator('[name=source]').fill('架空の必要部品一覧');
  await form(page).locator('[name=revision]').fill('改訂2');
  await submit(page);
  expect((await snapshotOf(page)).supply.needs.op1?.revision).toBe('改訂2');
});

test('案件詳細の注文の記録: 案件を固定し、品目は選ばせる', async ({ page }) => {
  await startEmpty(page);
  await openCase(page, 'B-001');
  await caseActions(page).locator('summary', { hasText: 'その他の操作' }).click();
  await caseActions(page).getByRole('button', { name: opLabels.requestRecord, exact: true }).click();
  await expect(form(page).locator('input[type=hidden][name=project]')).toHaveValue('B-001');
  await expect(form(page).locator('select[name=item]')).toBeVisible();
  await form(page).locator('select[name=item]').selectOption('P');
  await form(page).locator('[name=quantity]').fill('5');
  await form(page).locator('[name=vendor]').fill('架空の仕入先X');
  await form(page).locator('[name=requestedOn]').fill('2026-10-02');
  await form(page).locator('[name=replyKind]').selectOption('none');
  await submit(page);
  expect((await snapshotOf(page)).supply.requests.op1?.project).toEqual({ kind: 'case', id: 'B-001' });
});

const meta = (eventId: string): Meta => ({ eventId, actor: '架空担当A', recordedAt: '2026-10-30T09:00:00+09:00', occurredAt: '2026-10-30T09:00:00+09:00' });
const kit = { id: 'kit', name: '架空変更セット', product: 'R', basis: 'label', rows: [{ item: 'P', unit: '個', perSet: 2, location: 'S1' }] } as const;

test('案件詳細から受け取りと生成した必要明細の変更: セット一式と一つの品目を別の入口で開き、案件を固定する', async ({ page }) => {
  const state = generateTemplateNeeds({ ledger: practiceLedger, supply: saveReceiptTemplate(practiceLedger, emptySupply, meta('op1'), kit) }, meta('op2'), { templateId: 'kit', caseCode: '000007', count: 10, dueDate: null });
  await page.goto('/'); await waitForApp(page);
  await page.evaluate(raw => { localStorage.setItem('fuzzy-stock/slot-A', raw); localStorage.setItem('fuzzy-stock/head', 'A'); }, serialize(initial(state.ledger, state.supply)));
  await page.reload(); await waitForApp(page);
  await openCase(page, '000007');
  await caseActions(page).getByRole('button', { name: opLabels.templateReceive, exact: true }).click();
  await expect(form(page).locator('[name=op]')).toHaveValue('templateReceive');
  await expect(form(page).locator('input[type=hidden][name=project]')).toHaveValue('000007');
  await expect(form(page).locator('select[name=template]')).toBeVisible();
  await caseActions(page).getByRole('button', { name: opLabels.receive, exact: true }).click();
  await expect(form(page).locator('[name=op]')).toHaveValue('receive');
  await expect(form(page).locator('input[type=hidden][name=project]')).toHaveValue('000007');
  await caseActions(page).locator('summary', { hasText: 'その他の操作' }).click();
  await caseActions(page).getByRole('button', { name: opLabels.templateNeedEdit, exact: true }).click();
  await expect(form(page).locator('input[type=hidden][name=needProject]')).toHaveValue('000007');
  await form(page).locator('[name=needAction]').selectOption('change');
  await expect(form(page).locator('[name=need] option')).toHaveCount(2);
});

test('案件詳細: セットから生成していない案件には生成した必要明細の変更を出さない', async ({ page }) => {
  await startEmpty(page);
  await openCase(page, 'B-001');
  await expect(caseActions(page).getByRole('button', { name: opLabels.templateNeedEdit, exact: true })).toHaveCount(0);
});

test('不足・依頼の記録: 対象なしの受け取り・注文・申告を開き、固定していた対象を外す', async ({ page }) => {
  await startEmpty(page);
  await openCase(page, 'B-001');
  await caseActions(page).getByRole('button', { name: opLabels.receive, exact: true }).click();
  await expect(form(page).locator('input[type=hidden][name=project]')).toHaveCount(1);
  const group = page.locator('#supply').getByRole('group', { name: '不足・依頼の記録' });
  await group.getByRole('button', { name: opLabels.receive, exact: true }).click();
  await expect(form(page).locator('select[name=project]')).toBeVisible();
  for (const op of ['requestRecord', 'declareShortage'] as const) {
    await group.getByRole('button', { name: opLabels[op], exact: true }).click();
    await expect(form(page).locator('[name=op]')).toHaveValue(op);
  }
});

test('工程の完了基準: 登録情報の工程から固定して開き、記録に使った工程には出さない', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'masterProcess', { name: '架空塗装', criterion: 'workEnd' }, '09:00');
  await goTo(page, 'masters');
  const masters = page.locator('#masters');
  await masters.locator('[name=master-history]').selectOption({ label: '工程「架空塗装」' });
  const actions = masters.getByRole('group', { name: 'この登録情報にできる操作' });
  await actions.locator('summary', { hasText: 'その他の操作' }).click();
  await actions.getByRole('button', { name: opLabels.masterProcessCriterion, exact: true }).click();
  await expect(form(page).locator('input[type=hidden][name=target]')).toHaveValue(/^process:/);
  await form(page).locator('[name=criterion]').selectOption('inspection');
  await form(page).locator('[name=reason]').fill('架空の確認追加');
  await submit(page);
  const processes = Object.values((await snapshotOf(page)).ledger.masters.processes);
  expect(processes.find(p => p.name === '架空塗装')?.criterion).toBe('inspection');
});
