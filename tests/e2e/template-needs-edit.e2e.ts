import { expect, test, type Page } from '@playwright/test';
import { practiceLedger, use, type Meta } from '../../src/domain/ledger.ts';
import { emptySupply, receiveLot } from '../../src/domain/supply.ts';
import { saveReceiptTemplate } from '../../src/domain/receipt-template.ts';
import { editTemplateNeeds, generateTemplateNeeds } from '../../src/domain/template-needs.ts';
import { initial, serialize } from '../../src/ui/storage.ts';
import { goTo, recorded, selectOperation, waitForApp, waitForPersistence } from './helpers.ts';
import { draftOf, snapshotOf } from './conflict-helpers.ts';
import { decodeDraft } from '../../src/ui/conflictdraft.ts';

const meta = (eventId: string, hour = '09'): Meta => ({ eventId, actor: '架空担当A', recordedAt: `2026-10-30T${hour}:00:00+09:00`, occurredAt: `2026-10-30T${hour}:00:00+09:00` });
const template = { id: 'kit', name: '架空変更セット', product: 'R', basis: 'label', rows: [{ item: 'P', unit: '個', perSet: 2, location: 'S1' }] } as const;
const generated = () => generateTemplateNeeds({ ledger: practiceLedger, supply: saveReceiptTemplate(practiceLedger, emptySupply, meta('op1'), template) }, meta('op2'), { templateId: 'kit', caseCode: '000007', count: 10, dueDate: null });
const formOf = (page: Page) => page.getByRole('form', { name: '操作の入力' });
async function open(page: Page, state: ReturnType<typeof generated>, action: string) {
  await page.goto('/'); await waitForApp(page);
  await page.evaluate(raw => { localStorage.setItem('fuzzy-stock/slot-A', raw); localStorage.setItem('fuzzy-stock/head', 'A'); }, serialize(initial(state.ledger, state.supply)));
  await page.reload(); await waitForApp(page); await goTo(page, 'stock');
  await choose(page, action);
}
async function choose(page: Page, action: string) {
  const form = formOf(page);
  await selectOperation(form.locator('[name=op]'), 'templateNeedEdit');
  await form.locator('[name=needProject]').selectOption('000007');
  await form.locator('[name=needAction]').selectOption(action);
}
async function commit(page: Page) {
  const form = formOf(page);
  await form.locator('[name=needConfirmed]').check();
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
  await waitForPersistence(page);
}

test('NEED-01a/06 生成した必要明細の必要日・元資料・改訂を変更し、再読込と履歴へ残す', async ({ page }) => {
  const state = generated();
  await open(page, state, 'change');
  const form = formOf(page);
  await form.locator('[name=need]').selectOption('op2-n1');
  await expect(form.locator('[name=value]')).toHaveValue('20');
  await expect(form.locator('[name=needSource]')).toHaveValue('架空変更セット');
  await expect(form.locator('[name=needRevision]')).toHaveValue('op2-v1');
  await form.locator('[name=needDue]').fill('2026-11-10');
  await form.locator('[name=needSource]').fill('架空の改訂資料');
  await form.locator('[name=needRevision]').fill('第2版');
  await form.locator('[name=needReason]').fill('架空の納期変更');
  await form.getByRole('button', { name: '変更をプレビュー' }).click();
  await expect(form.locator('[data-need-preview]')).toContainText('なし → 2026-11-10');
  await expect(form.locator('[data-need-preview]')).toContainText('架空変更セット → 架空の改訂資料');
  await expect(form.locator('[data-need-preview]')).not.toContainText('余った分の振り分け');
  await commit(page);
  const saved = await snapshotOf(page);
  expect(saved.supply.needs['op2-n1']).toMatchObject({ required: { basis: 'label', value: 20 }, dueDate: '2026-11-10', source: '架空の改訂資料', revision: '第2版' });
  expect(saved.supply.log.at(-1)).toMatchObject({ action: 'edit', planFormat: 'delta', reason: '架空の納期変更' });
  await page.reload(); await waitForApp(page);
  expect((await snapshotOf(page)).supply).toEqual(saved.supply);
});

test('4.1, 5.3, 7.7 手修正は初期OFF、選択で適用後と余剰が変わり再確認が必要', async ({ page }) => {
  let state = generated();
  state = receiveLot(state.ledger, state.supply, meta('op3'), { id: 'lot', item: 'P', unit: '個', project: { kind: 'case', id: '000007' }, location: 'S1' }, 'counted', 18);
  state = { ...state, ledger: use(state.ledger, meta('op4', '10'), 'lot', 'counted', 3, '架空の使用') };
  await open(page, state, 'change');
  const form = formOf(page);
  await form.locator('[name=need]').selectOption('op2-n1');
  await form.locator('[name=basis]').selectOption('counted'); await form.locator('[name=value]').fill('7');
  await form.locator('[name=needReason]').fill('架空の手修正');
  await form.getByRole('button', { name: '変更をプレビュー' }).click();
  await expect(form.getByRole('table', { name: '必要明細の差分' })).toContainText('7個');
  await commit(page);
  await choose(page, 'recalculate');
  await form.locator('[name=needCount]').fill('20'); await form.locator('[name=needReason]').fill('架空の増産');
  await form.getByRole('button', { name: '変更をプレビュー' }).click();
  const table = form.getByRole('table', { name: '必要明細の差分' });
  await expect(table.locator('tbody tr td').nth(1)).toHaveText('20個');
  await expect(table.locator('tbody tr td').nth(4)).toContainText('7個');
  await expect(table.locator('tbody tr td').nth(6)).toHaveText('11個');
  await expect(form.locator('[name=needApply0]')).not.toBeChecked();
  const scroll = form.getByRole('region', { name: '必要明細の差分（横スクロール）' });
  for (const width of [1280, 360]) {
    await page.setViewportSize({ width, height: 900 });
    const bounds = await scroll.evaluate(node => ({ width: node.clientWidth, content: node.scrollWidth, right: node.getBoundingClientRect().right, viewport: document.documentElement.clientWidth }));
    expect(bounds.content).toBeGreaterThan(bounds.width); expect(bounds.right).toBeLessThanOrEqual(bounds.viewport);
    await scroll.evaluate(node => { node.scrollLeft = node.scrollWidth; });
    await expect(form.getByRole('checkbox', { name: /P（個）に新標準値を適用/ })).toBeVisible();
    expect(await table.locator('tbody tr').evaluate(node => node.getBoundingClientRect().height)).toBeLessThan(220);
    await form.screenshot({ path: `.local-logs/template-needs/task43-diff-${width}.png` });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await form.locator('[name=needConfirmed]').check();
  await form.locator('[name=needApply0]').focus(); await page.keyboard.press('Space');
  await expect(form.locator('[name=needApply0]')).toBeFocused();
  await expect(form.locator('[name=needConfirmed]')).not.toBeChecked();
  await expect(table.locator('tbody tr td').nth(4)).toContainText('40個');
  await expect(table.locator('tbody tr td').nth(6)).toContainText('0個');
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('確認');
  await commit(page);
  const saved = await snapshotOf(page);
  expect(saved.supply.needs['op2-n1']?.required.value).toBe(40);
  expect(saved.ledger.lots).toEqual(state.ledger.lots);
  expect(saved.supply.receipts).toEqual(state.supply.receipts);
  expect(saved.supply.requests).toEqual(state.supply.requests);
  await page.reload(); await waitForApp(page); expect((await snapshotOf(page)).supply).toEqual(saved.supply);
});

test('根拠だけを概算20へ変えた明細は未選択の再計算・再読込でも保持し、明示選択した時だけ標準へ戻す', async ({ page }) => {
  await open(page, generated(), 'change');
  const form = formOf(page);
  await form.locator('[name=need]').selectOption('op2-n1');
  await form.locator('[name=basis]').selectOption('approximate'); await form.locator('[name=value]').fill('20');
  await form.locator('[name=needReason]').fill('架空の根拠訂正');
  await form.getByRole('button', { name: '変更をプレビュー' }).click(); await commit(page);
  await choose(page, 'recalculate');
  await form.locator('[name=needCount]').fill('20'); await form.locator('[name=needReason]').fill('架空の増産');
  await form.getByRole('button', { name: '変更をプレビュー' }).click();
  await expect(form.locator('[name=needApply0]')).not.toBeChecked();
  await expect(form.getByRole('table', { name: '必要明細の差分' }).locator('tbody tr td').nth(4)).toContainText('20個');
  await commit(page);
  expect((await snapshotOf(page)).supply.needs['op2-n1']?.required).toEqual({ basis: 'approximate', value: 20 });
  await page.reload(); await waitForApp(page);
  expect((await snapshotOf(page)).supply.needs['op2-n1']?.required).toEqual({ basis: 'approximate', value: 20 });
  await goTo(page, 'stock'); await choose(page, 'recalculate');
  await form.locator('[name=needCount]').fill('30'); await form.locator('[name=needReason]').fill('架空の追加増産');
  await form.getByRole('button', { name: '変更をプレビュー' }).click();
  await expect(form.locator('[name=needApply0]')).not.toBeChecked();
  await form.locator('[name=needApply0]').check();
  await expect(form.getByRole('table', { name: '必要明細の差分' }).locator('tbody tr td').nth(4)).toContainText('60個');
  await commit(page);
  expect((await snapshotOf(page)).supply.needs['op2-n1']?.required).toEqual({ basis: 'label', value: 60 });
});

test('4.3, 7.7 除外の余剰に使用済みを含めず、不明の必要数は判定できない', async ({ page }) => {
  let state = generated();
  state = receiveLot(state.ledger, state.supply, meta('op3'), { id: 'lot', item: 'P', unit: '個', project: { kind: 'case', id: '000007' }, location: 'S1' }, 'counted', 18);
  state = { ...state, ledger: use(state.ledger, meta('op4', '10'), 'lot', 'counted', 3, '架空の使用') };
  await open(page, state, 'exclude'); const form = formOf(page);
  await form.locator('[name=need]').selectOption('op2-n1'); await form.locator('[name=needReason]').fill('架空の除外');
  await form.getByRole('button', { name: '変更をプレビュー' }).click();
  await expect(form.getByRole('table', { name: '必要明細の差分' }).locator('tbody tr td').nth(6)).toContainText('15個');
  await expect(form.locator('[data-need-preview]')).toContainText('余った分の振り分け');
  await commit(page); expect((await snapshotOf(page)).supply.needs['op2-n1']?.required.value).toBe(0);
  await choose(page, 'change'); await form.locator('[name=need]').selectOption('op2-n1');
  await form.locator('[name=basis]').selectOption('unknown'); await form.locator('[name=value]').fill(''); await form.locator('[name=needReason]').fill('架空の未確認');
  await form.getByRole('button', { name: '変更をプレビュー' }).click();
  await expect(form.getByRole('table', { name: '必要明細の差分' })).toContainText('判定できない');
  await expect(form.locator('[data-need-preview]')).toContainText('必要な数が不明');
});

test('6.2, 6.5 同版custom衝突も選択画面を残し、明示選択後だけセット由来にする', async ({ page }) => {
  let state = editTemplateNeeds(generated(), meta('op3'), '000007', { kind: 'add', item: 'Q', unit: '個', required: { basis: 'counted', value: 7 }, dueDate: null }, '架空の独自明細');
  state = { ...state, supply: saveReceiptTemplate(state.ledger, state.supply, meta('op4'), { ...template, rows: [{ item: 'Q', unit: '個', perSet: 3, location: 'S1' }] }) };
  await open(page, state, 'follow'); const form = formOf(page);
  await form.getByRole('button', { name: '変更をプレビュー' }).click();
  await expect(form.getByRole('table', { name: '必要明細の差分' })).toContainText('新版にない明細');
  await expect(form.locator('[name=needApply1]')).not.toBeChecked();
  await commit(page);
  expect((await snapshotOf(page)).supply.needs['op2-n1']?.required.value).toBe(0);
  expect((await snapshotOf(page)).supply.needs['op3-n1']?.required.value).toBe(7);
  const beforeChoice = await snapshotOf(page);
  await choose(page, 'follow'); await form.getByRole('button', { name: '変更をプレビュー' }).click();
  await expect(form.locator('[name=needApply1]')).not.toBeChecked();
  await expect(form.locator('[name=needConfirmed]')).toBeDisabled();
  expect((await snapshotOf(page)).supply).toEqual(beforeChoice.supply);
  await form.locator('[name=needApply1]').check();
  await expect(form.locator('[name=needConfirmed]')).toBeEnabled();
  await expect(form.getByRole('table', { name: '必要明細の差分' })).toContainText('30個');
  await commit(page);
  const saved = await snapshotOf(page);
  expect(saved.supply.templateNeeds['000007']?.origins[1]?.origin).toBe('template');
  expect(saved.supply.needs['op3-n1']?.required.value).toBe(30);
  expect(saved.ledger).toEqual(state.ledger);
});

test('2.11, 8.2 動的な適用checkboxは競合参照用に残し、確認と署名を復元しない', async ({ page, context }) => {
  const state = editTemplateNeeds(generated(), meta('op3'), '000007', { kind: 'change', needId: 'op2-n1', required: { basis: 'counted', value: 7 } }, '架空の手修正');
  await open(page, state, 'recalculate'); const form = formOf(page);
  const other = await context.newPage(); await other.goto('/'); await waitForApp(other);
  await form.locator('[name=needCount]').fill('20'); await form.locator('[name=needReason]').fill('架空の増産');
  await form.getByRole('button', { name: '変更をプレビュー' }).click(); await form.locator('[name=needApply0]').check();
  await form.locator('[name=needConfirmed]').check();
  await recorded(other, 'masterRename', { target: 'item:P', name: '架空部品の別名', reason: '架空の更新' });
  await expect(page.locator('#conflict')).toContainText('未解消');
  const draft = decodeDraft((await draftOf(page))!).draft;
  expect(draft.fields).toContainEqual(expect.objectContaining({ name: 'needApply0', checked: true, label: expect.stringContaining('新標準値') }));
  expect(draft.fields.some((field: { name: string }) => field.name === 'needPreview')).toBe(false);
  expect(draft.fields).toContainEqual(expect.objectContaining({ name: 'needConfirmed', checked: true }));
  await page.reload(); await waitForApp(page);
  expect((await snapshotOf(page)).supply.needs['op2-n1']?.required.value).toBe(7);
  await expect(page.locator('#conflict')).toContainText('新標準値');
  await expect(page.locator('[name=needConfirmed]:checked')).toHaveCount(0);
  await expect(page.locator('[name=needPreview]')).toHaveCount(0);
  const panel = page.locator('#conflict');
  await panel.getByLabel('元入力を控えた').check(); await panel.getByLabel('最新記録から入力し直す').check();
  await panel.getByLabel('理由').fill('動的な適用欄と台数を確認して再入力'); await panel.getByLabel('最新の記録を確認した').check();
  await panel.getByRole('button', { name: '「最新記録から入力し直す」で保存する' }).click();
  await expect(panel).toContainText('確定済み：最新記録から入力し直す');
  expect(await draftOf(page)).toBeNull();
  await goTo(page, 'stock'); await choose(page, 'recalculate');
  await expect(form.locator('[name=needPreview]')).toHaveValue('');
  await expect(form.locator('[name=needConfirmed]')).not.toBeChecked();
  for (const name of ['needCount', 'needReason']) {
    const field = draft.fields.find(field => field.name === name);
    if (field?.kind !== 'text') throw new Error(`退避した欄がない：${name}`);
    await form.locator(`[name=${name}]`).fill(field.value);
  }
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('プレビュー');
  expect((await snapshotOf(page)).supply.needs['op2-n1']?.required.value).toBe(7);
  await form.getByRole('button', { name: '変更をプレビュー' }).click();
  await expect(form.locator('[name=needApply0]')).not.toBeChecked();
  await expect(form.locator('[name=needConfirmed]')).not.toBeChecked();
  await form.locator('[name=needApply0]').check(); await commit(page);
  const saved = await snapshotOf(page);
  expect(saved.supply.needs['op2-n1']?.required.value).toBe(40);
  expect(saved.supply.log.filter(event => event.kind === 'templateNeeds' && event.action === 'recalculate')).toHaveLength(1);
  await page.reload(); await waitForApp(page); expect((await snapshotOf(page)).supply).toEqual(saved.supply);
});

test('4.2, 4.4 案件独自明細の追加は理由と原文を保持し、変更後は再プレビューする', async ({ page }) => {
  const state = generated(); await open(page, state, 'add'); const form = formOf(page);
  await form.locator('[name=item]').selectOption('Q'); await form.locator('[name=unit]').selectOption('個');
  await form.locator('[name=basis]').selectOption('counted'); await form.locator('[name=value]').fill('3');
  await form.getByRole('button', { name: '変更をプレビュー' }).click();
  await expect(form.locator('[data-need-preview]')).toContainText('理由');
  await expect(form.locator('[name=value]')).toHaveValue('3');
  await form.locator('[name=needReason]').fill('架空の独自追加');
  await form.getByRole('button', { name: '変更をプレビュー' }).click();
  await expect(form.getByRole('table', { name: '必要明細の差分' })).toContainText('案件独自');
  await form.locator('[name=needConfirmed]').check(); await form.locator('[name=value]').fill('4');
  await expect(form.locator('[name=needConfirmed]')).not.toBeChecked();
  await expect(form.locator('[name=needConfirmed]')).toBeDisabled();
  await form.getByRole('button', { name: '変更をプレビュー' }).click(); await commit(page);
  const saved = await snapshotOf(page);
  expect(Object.values(saved.supply.needs).find(need => need.item === 'Q')?.required.value).toBe(4);
  expect(saved.ledger).toEqual(state.ledger);
});
