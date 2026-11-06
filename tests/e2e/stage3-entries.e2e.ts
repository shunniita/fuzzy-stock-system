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

test('確認事項の行から: 対応付けと新規登録は選んだ仮の記録を固定し、その仮の記録だけを片付ける', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', { newId: 'X', item: 'P', unit: '個', project: 'B-001', location: 'S1', basis: 'counted', value: '5' }, '09:00');
  await recorded(page, 'provisional', { direction: 'found', item: 'P', location: 'S1', basis: 'counted', value: '3', note: '架空の棚の奥' }, '09:10');
  await recorded(page, 'provisional', { direction: 'found', item: 'P', location: 'T', basis: 'counted', value: '2', note: '架空の作業台の下' }, '09:20');
  const actions = page.locator('#issues').getByRole('group', { name: 'この確認事項にできる操作' });
  const open = async (issue: string, op: 'identify' | 'adopt') => {
    await goTo(page, 'issues');
    await page.locator(`#issues tr[data-issue="${issue}"]`).getByRole('button', { name: issue, exact: true }).click();
    await actions.getByRole('button', { name: opLabels[op], exact: true }).click();
    await expect(form(page).locator('input[type=hidden][name=issue]')).toHaveValue(issue);
  };
  // 後の仮の記録（op3）を選び、先の仮の記録（op2）が選ばれないことを確かめる。
  await open('op3', 'adopt');
  await form(page).locator('[name=newId]').fill('Y');
  // 品目と場所は仮の記録に書いた値で始まる。
  await expect(form(page).locator('[name=item]')).toHaveValue('P');
  await expect(form(page).locator('[name=location]')).toHaveValue('T');
  await form(page).locator('[name=project]').selectOption('B-001');
  await form(page).getByRole('button', { name: '記録する', exact: true }).click();
  const confirmed = form(page).locator('[name=confirmed]');
  if (await confirmed.isVisible()) { await confirmed.check(); await form(page).getByRole('button', { name: '記録する', exact: true }).click(); }
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
  let saved = await snapshotOf(page);
  expect(saved.ledger.issues['op3']?.resolution).not.toBeNull();
  expect(saved.ledger.issues['op2']?.resolution).toBeNull();
  expect(saved.ledger.lots['Y']?.location).toBe('T');
  await open('op2', 'identify');
  await form(page).locator('[name=lot]').selectOption('X');
  await form(page).locator('[name=reason]').fill('架空の同じ箱');
  await submit(page);
  saved = await snapshotOf(page);
  expect(saved.ledger.issues['op2']?.resolution).not.toBeNull();
  expect(saved.ledger.history.filter(e => e.kind === 'identify').map(e => e.kind === 'identify' && e.issueId)).toEqual(['op2']);
});

test('保管単位の詳細から: 残り具合と予備の交換は、選んだ保管単位を固定して記録する', async ({ page }) => {
  await startEmpty(page);
  const unknown = { item: 'P', unit: '個', project: 'B-001', location: 'S1', basis: 'unknown', value: '' };
  await recorded(page, 'register', { ...unknown, newId: 'OPEN1' }, '08:00');
  await recorded(page, 'register', { ...unknown, newId: 'OPEN2' }, '08:00');
  for (const id of ['R1', 'R2']) {
    await recorded(page, 'receive', { newId: id, item: 'P', unit: '個', project: 'B-001', location: 'S1', basis: 'counted', value: '10' }, '08:10');
    await recorded(page, 'surplusAllocate', { lot: id, childId: `${id}-sp`, basis: 'counted', value: '2', destination: 'spare', note: '架空の備え' }, '08:20');
  }
  const openFromDetail = async (lot: string, op: 'remainder' | 'spareSwap') => {
    await goTo(page, 'stock');
    await page.locator(`#list tr[data-lot="${lot}"]`).getByRole('button', { name: lot, exact: true }).click();
    const other = page.locator('#detail .other-operations');
    await other.locator('summary').click();
    await other.locator(`button[data-op=${op}]`).click();
    await expect(form(page).locator('input[type=hidden][name=lot]')).toHaveValue(lot);
  };
  // 候補の先頭（OPEN1・R1-sp）でない方を選び、固定が効いていることを確かめる。
  await openFromDetail('OPEN2', 'remainder');
  await form(page).locator('[name=level]').selectOption('few');
  await submit(page);
  expect(Object.keys((await snapshotOf(page)).supply.levels)).toEqual(['OPEN2']);
  await openFromDetail('R2-sp', 'spareSwap');
  await form(page).locator('[name=value]').fill('1');
  await form(page).locator('[name=childId]').fill('R2-sw');
  await form(page).locator('[name=note]').fill('架空の破損');
  await submit(page);
  const lots = (await snapshotOf(page)).ledger.lots;
  expect(Object.keys(lots).filter(id => id.endsWith('-sw'))).toEqual(['R2-sw']);
});

test('所属が不明な保管単位の詳細から: 結び付けを対象固定で開き、所属がある物には出さない', async ({ page }) => {
  await startEmpty(page);
  const lot = { item: 'R', unit: '台', location: 'S1', basis: 'counted', value: '1' };
  await recorded(page, 'register', { ...lot, newId: 'U-1', project: 'unassigned' }, '08:00');
  await recorded(page, 'register', { ...lot, newId: 'U-2', project: 'unassigned' }, '08:00');
  await recorded(page, 'register', { ...lot, newId: 'K', project: 'B-001' }, '08:00');
  const detailOps = async (id: string) => {
    await goTo(page, 'stock');
    await page.locator(`#list tr[data-lot="${id}"]`).getByRole('button', { name: id, exact: true }).click();
    return page.locator('#detail .other-operations');
  };
  await expect((await detailOps('K')).locator('summary')).toBeVisible();
  await expect(page.locator('#detail [data-op=assignProject]')).toHaveCount(0);
  const other = await detailOps('U-2');
  await other.locator('summary').click();
  await other.locator('button[data-op=assignProject]').click();
  await expect(form(page).locator('input[type=hidden][name=lot]')).toHaveValue('U-2');
  await form(page).locator('[name=project]').selectOption('A-002');
  await form(page).locator('[name=reason]').fill('架空の指示書で判明');
  await submit(page);
  // 結び付けた物はもう対象にならないが、記録できたことは消さずに理由と並べる。
  await expect(page.locator('#input [role=status]')).toContainText('対象 U-2 は現在この操作を記録できません');
  const lots = (await snapshotOf(page)).ledger.lots;
  expect([lots['U-1']?.project, lots['U-2']?.project]).toEqual([{ kind: 'unassigned' }, { kind: 'case', id: 'A-002' }]);
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
