import { expect, test, type Page } from '@playwright/test';
import { practiceLedger, type Meta } from '../../src/domain/ledger.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { saveReceiptTemplate } from '../../src/domain/receipt-template.ts';
import { generateTemplateNeeds } from '../../src/domain/template-needs.ts';
import { initial, serialize, type Snapshot } from '../../src/ui/storage.ts';
import { goTo, opLabels, recorded, startEmpty, waitForApp } from './helpers.ts';
import { snapshotOf } from './conflict-helpers.ts';

const form = (page: Page) => page.getByRole('form', { name: '操作の入力' });
const caseActions = (page: Page) => page.locator('#case').getByRole('group', { name: 'この案件・用途にできる操作' });
const meta = (eventId: string): Meta => ({ eventId, actor: '架空担当A', recordedAt: '2026-10-30T09:00:00+09:00', occurredAt: '2026-10-30T09:00:00+09:00' });
const kit = { id: 'kit', name: '架空変更セット', product: 'R', basis: 'label', rows: [{ item: 'P', unit: '個', perSet: 2, location: 'S1' }] } as const;

async function load(page: Page, snapshot: Snapshot): Promise<void> {
  await page.goto('/'); await waitForApp(page);
  await page.evaluate(raw => { localStorage.setItem('fuzzy-stock/slot-A', raw); localStorage.setItem('fuzzy-stock/head', 'A'); }, serialize(snapshot));
  await page.reload(); await waitForApp(page);
}

async function submit(page: Page): Promise<void> {
  await form(page).getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
}

test('案件固定のセット受け取り: セットに残る旧い案件で上書きせず、固定した案件で展開して記録する', async ({ page }) => {
  const saved = saveReceiptTemplate(practiceLedger, emptySupply, meta('op1'), kit);
  // 版7のセットは案件を持ち、選ぶと受け取りの案件の初期値になる。
  const template = { ...saved.receiptTemplates['kit']!, project: { kind: 'case' as const, id: 'A-001' } };
  const legacy = { ...saved, receiptTemplates: { kit: template }, log: saved.log.map(e => e.kind === 'receiptTemplateSave' ? { ...e, after: template } : e) };
  await load(page, initial(practiceLedger, legacy));
  await goTo(page, 'supply');
  await page.locator('[name=case-project]').selectOption('B-001');
  await caseActions(page).getByRole('button', { name: opLabels.templateReceive, exact: true }).click();
  await form(page).locator('select[name=template]').selectOption('kit');
  await form(page).getByRole('button', { name: '予定数を展開', exact: true }).click();
  await expect(form(page).locator('[name=actual0]')).toHaveValue('2');
  await form(page).locator('[name=templateConfirmed]').check();
  await submit(page);
  expect(Object.values((await snapshotOf(page)).ledger.lots).map(lot => lot.project)).toEqual([{ kind: 'case', id: 'B-001' }]);
});

test('生成済みの案件: 必要な数の登録と改訂の入口を出さず、生成した必要明細の変更だけを出す', async ({ page }) => {
  const state = generateTemplateNeeds({ ledger: practiceLedger, supply: saveReceiptTemplate(practiceLedger, emptySupply, meta('op1'), kit) }, meta('op2'), { templateId: 'kit', caseCode: '000007', count: 10, dueDate: null });
  await load(page, initial(state.ledger, state.supply));
  await goTo(page, 'supply');
  await page.locator('[name=case-project]').selectOption('000007');
  // 出る入口を先に待ち、描画前に「出ない」を確かめて通ってしまわないようにする。
  await expect(caseActions(page).locator('[data-op=templateNeedEdit]')).toHaveCount(1);
  await expect(caseActions(page).locator('[data-op=needRegister]')).toHaveCount(0);
  await expect(page.locator('#case [data-op=needRevise]')).toHaveCount(0);
});

test('利用停止した品目の依頼: 固定できない受け取りの入口を出さず、ほかの操作は残す', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'requestRecord', { project: 'B-001', item: 'P', unit: '個', quantity: '5', vendor: '架空の仕入先X', requestedOn: '2026-10-02', replyKind: 'none', replyDate: '' });
  await recorded(page, 'masterDeactivate', { target: 'item:P', reason: '架空の廃番' });
  await goTo(page, 'supply');
  await page.locator('#supply article[data-group="B-001/P/個"]').getByRole('button', { name: 'op1', exact: true }).click();
  const actions = page.locator('#supply').getByRole('group', { name: 'この依頼にできる操作' });
  await expect(actions.locator('[data-op=receive]')).toHaveCount(0);
  await expect(actions.locator('[data-op=replyRecord]')).toHaveCount(1);
});

test('確認事項の行から: 仮の記録を選び、片付ける・対応付け・新規登録を対象固定で開く', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'provisional', { direction: 'found', item: '', location: 'T', basis: 'unknown', note: '架空の元不明の箱' }, '10:00');
  await goTo(page, 'issues');
  await page.locator('#issues tr[data-issue="op1"]').getByRole('button', { name: 'op1', exact: true }).click();
  await expect(page.locator('#issue-selected-h')).toBeFocused();
  const actions = page.locator('#issues').getByRole('group', { name: 'この確認事項にできる操作' });
  for (const op of ['resolve', 'identify', 'adopt'] as const) await expect(actions.locator(`[data-op=${op}]`)).toHaveCount(1);
  await actions.getByRole('button', { name: opLabels.resolve, exact: true }).click();
  await expect(form(page).locator('input[type=hidden][name=issue]')).toHaveValue('op1');
  await form(page).locator('[name=outcome]').selectOption('close');
  await submit(page);
  expect((await snapshotOf(page)).ledger.issues['op1']?.resolution).not.toBeNull();
  await expect(form(page).locator('select[name=issue]')).toBeVisible();
  await expect(page.locator('#issues').getByText('この確認事項にできる操作はない')).toBeVisible();
});

test('受け取った現物の詳細から: 実際に受け取った数の訂正と余った分の振り分けを対象固定で開く', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'receive', { newId: 'R1', item: 'P', unit: '個', project: 'B-001', location: 'S1', basis: 'counted', value: '10' });
  await goTo(page, 'stock');
  await page.locator('#list tr[data-lot="R1"]').getByRole('button', { name: 'R1', exact: true }).click();
  const other = page.locator('#detail .other-operations');
  await other.locator('summary').click();
  await other.locator('button[data-op=receiptRevise]').click();
  await expect(form(page).locator('input[type=hidden][name=receipt]')).toHaveValue('R1');
  await form(page).locator('[name=received]').fill('12');
  await form(page).locator('[name=reason]').fill('架空の数え間違い');
  await submit(page);
  expect((await snapshotOf(page)).supply.receipts['R1']?.received).toBe(12);
  await expect(page.locator('#detail .other-operations button[data-op=surplusAllocate]')).toHaveCount(1);
});

test('選んだ記録から返品の受付確認: 実返却を固定して開き、確認後はその入口を出さない', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', { newId: 'X', item: 'P', unit: '個', project: 'B-001', location: 'S1', basis: 'counted', value: '10' }, '09:00');
  // 返却待ちか不良の物を外へ出したときだけ、返品の受付確認を記録できる。
  await recorded(page, 'hold', { lot: 'X', reason: 'defective' }, '09:30');
  await recorded(page, 'handover', { lot: 'X', basis: 'counted', value: '4', counterpart: '架空の返却先' }, '10:00');
  await goTo(page, 'issues');
  await page.locator('#history li').getByRole('button', { name: 'op3', exact: true }).click();
  const actions = page.locator('#history').getByRole('group', { name: 'この記録にできる操作' });
  await actions.getByRole('button', { name: opLabels.returnAck, exact: true }).click();
  await expect(form(page).locator('input[type=hidden][name=handover]')).toHaveValue('op3');
  await submit(page);
  expect((await snapshotOf(page)).supply.acks['op3']).toBeDefined();
  await expect(actions.locator('[data-op=returnAck]')).toHaveCount(0);
});
