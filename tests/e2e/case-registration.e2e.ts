import { expect, test, type Locator, type Page } from '@playwright/test';
import { changeMasters, practiceLedger, register, start, type Meta } from '../../src/domain/ledger.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { saveReceiptTemplate } from '../../src/domain/receipt-template.ts';
import { generateTemplateNeeds } from '../../src/domain/template-needs.ts';
import { initial, serialize } from '../../src/ui/storage.ts';
import { decodePending } from '../../src/ui/storageparse.ts';
import { decodeDraft } from '../../src/ui/conflictdraft.ts';
import { goTo, record, recorded, selectOperation, startEmpty, waitForApp, waitForPersistence } from './helpers.ts';
import { draftOf, snapshotOf } from './conflict-helpers.ts';

const meta = (eventId: string): Meta => ({ eventId, actor: '架空担当A', recordedAt: '2026-10-30T09:00:00+09:00', occurredAt: '2026-10-30T09:00:00+09:00' });
const kit = { id: 'kit', name: '架空登録セット', product: 'R', productUnit: '台', basis: 'label', rows: [{ item: 'P', unit: '個', perSet: 2, location: 'S1' }, { item: 'Q', unit: '個', perSet: 1, location: 'S1' }] } as const;
const withKit = () => ({ ledger: practiceLedger, supply: saveReceiptTemplate(practiceLedger, emptySupply, meta('op1'), kit) });
const generatedFor = (caseCode: string, count: number) => generateTemplateNeeds(withKit(), meta('op2'), { templateId: 'kit', caseCode, count, dueDate: null });

const formOf = (page: Page) => page.getByRole('form', { name: '操作の入力' });
const status = (page: Page) => page.locator('#input > [role=status]');

async function open(page: Page, state: ReturnType<typeof withKit>): Promise<void> {
  await page.goto('/'); await waitForApp(page);
  await page.evaluate(raw => { localStorage.setItem('fuzzy-stock/slot-A', raw); localStorage.setItem('fuzzy-stock/head', 'A'); }, serialize(initial(state.ledger, state.supply)));
  await page.reload(); await waitForApp(page); await goTo(page, 'stock');
}
async function choose(page: Page, key: string): Promise<Locator> {
  await goTo(page, 'stock');
  await selectOperation(formOf(page).locator('[name=op]'), key);
  return formOf(page);
}
async function submit(page: Page): Promise<void> {
  await formOf(page).getByRole('button', { name: '記録する', exact: true }).click();
  await waitForPersistence(page);
}

test('1.1, 1.4, 1.7, 1.9, 3.1, 4.3 登録の流れで欠品ありの受け取りまで記録し、詳細の数量カードから品目へ移る', async ({ page }) => {
  await open(page, withKit());
  const form = await choose(page, 'masterCase');
  const order = ['code', 'name', 'sourceName', 'sourceRevision', 'caseSet', 'caseTotal', 'caseDue', 'caseReceipt'];
  expect(await form.evaluate((node: HTMLFormElement, names) => names.map(name => node.elements.namedItem(name) as Element).every((el, i, all) => i === 0 || (all[i - 1]!.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0), order)).toBe(true);
  for (const name of ['caseTotal', 'caseDue', 'caseReceipt']) await expect(form.locator(`[name=${name}]`)).toBeHidden();
  await expect(form.getByRole('button', { name: '必要明細をプレビュー', exact: true })).toBeHidden();
  await form.locator('[name=caseSet]').selectOption('kit');
  for (const name of ['caseTotal', 'caseDue', 'caseReceipt']) await expect(form.locator(`[name=${name}]`)).toBeVisible();
  await expect(form.locator('[name=sets]')).toBeHidden();
  await expect(form.locator('[name=vendor]')).toBeHidden();
  await form.locator('[name=caseReceipt]').selectOption('record');
  await expect(form.locator('[name=sets]')).toBeVisible();
  await expect(form.locator('[name=vendor]')).toBeVisible();

  await form.locator('[name=code]').fill('CASE-R');
  await form.locator('[name=caseTotal]').fill('2');
  await expect(form.locator('[name=sets]')).toHaveValue('2');
  const preview = form.getByRole('button', { name: '必要明細をプレビュー', exact: true });
  const confirmation = form.locator('[name=caseRegistrationConfirmed]');
  await preview.click();
  await confirmation.check();
  await form.locator('[name=caseTotal]').fill('3');
  await expect(confirmation).not.toBeChecked();
  await expect(confirmation).toBeDisabled();
  await expect(form.locator('[data-case-registration-preview]')).toBeEmpty();
  await preview.click();
  await expect(confirmation).toBeEnabled();
  await form.locator('[name=name]').fill('架空案件名');
  await expect(confirmation).toBeDisabled();
  await expect(form.locator('[data-case-registration-preview]')).toBeEmpty();
  const before = await snapshotOf(page);
  await submit(page);
  await expect(status(page)).toContainText('プレビューし直して');
  expect((await snapshotOf(page)).supply).toEqual(before.supply);

  await expect(form.locator('[name=sets]')).toHaveValue('3');
  await preview.click();
  const shown = form.locator('[data-case-registration-preview]');
  await expect(shown).toContainText('CASE-R');
  await expect(shown).toContainText('架空登録セット');
  await expect(shown.getByRole('table', { name: '生成する必要明細' })).toContainText('6個');
  await expect(shown.getByRole('table', { name: '生成する必要明細' })).toContainText('3個');
  await form.locator('[name=shortfall1]').fill('1');
  await expect(form.locator('[name=actual1]')).toHaveValue('2');
  await form.locator('[name=vendor]').fill('架空商社');
  await confirmation.check();
  await submit(page);
  await expect(status(page)).toContainText('記録した');

  const saved = await snapshotOf(page);
  const created = Object.values(saved.ledger.masters.cases).find(c => c.code === 'CASE-R')!;
  expect(saved.supply.templateNeeds[created.id]).toMatchObject({ count: 3 });
  expect(Object.values(saved.supply.needs).filter(n => n.project.id === created.id).map(n => [n.item, n.required.value])).toEqual([['P', 6], ['Q', 3]]);
  expect(Object.values(saved.supply.requests)).toMatchObject([{ item: 'Q', quantity: 1, vendor: '架空商社', project: { kind: 'case', id: created.id } }]);
  const opId = saved.ledger.history.find(e => e.kind === 'master' && e.masters.some(c => c.after.id === created.id))!.eventId;
  expect(saved.supply.log.filter(e => e.eventId === `${opId}-g` || e.eventId === `${opId}-t`).map(e => e.kind)).toEqual(['templateNeeds', 'templateReceipt']);

  await goTo(page, 'supply');
  await page.locator('[name=case-project]').selectOption(created.id);
  const card = page.locator('#case').getByRole('region', { name: '数量カード' });
  await expect(card.locator('[data-progress]')).toContainText('セット「架空登録セット」');
  await expect(card.locator('[data-progress]')).toContainText('総予定数3台・作業で使った台数 記録上の数0台・未使用の残り3台');
  await expect(card.locator('[data-progress]')).toContainText('計算基準の版');
  // 4.1：数量カードは品目の一覧より前に置く。
  expect(await page.locator('#case').evaluate(root => {
    const summary = root.querySelector('[aria-label="数量カード"]'), first = root.querySelector('article.group');
    return summary !== null && first !== null && (summary.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  })).toBe(true);
  await expect(card.getByRole('button', { name: '必要明細のある品目 2件', exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: '未着の依頼がある品目 1件', exact: true })).toBeVisible();
  const zero = card.getByRole('listitem').filter({ hasText: '不足を判定できない品目 0件' });
  await expect(zero).toBeVisible();
  await expect(zero.getByRole('button')).toHaveCount(0);
  // 0件の文字と押せるボタンが同じ高さ・同じ上端で並ぶ。
  const boxes = await card.getByRole('listitem').evaluateAll(items => items.map(i => { const r = i.getBoundingClientRect(); return { top: r.top, height: r.height }; }));
  expect(new Set(boxes.map(b => b.height)).size).toBe(1);
  expect(new Set(boxes.map(b => b.top)).size).toBeLessThanOrEqual(2);
  await page.mouse.move(0, 0);
  // この画面の無効なボタンは有効なボタンと同じ枠・文字色なので、0件の文字はその見た目から外れていればよい。
  // 文字の太さは比べない：ボタンを太字にしない配色では同じ太さになる。
  const look = (node: Element) => { const s = getComputedStyle(node); return { color: s.color, border: s.borderTopColor, cursor: s.cursor }; };
  const [plain, pressable] = [await zero.evaluate(look), await card.getByRole('button').first().evaluate(look)];
  expect(plain.cursor).not.toBe('pointer');
  expect(plain.color).not.toBe(pressable.color);
  expect(plain.border).not.toBe(pressable.border);
  await card.getByRole('button', { name: '未着の依頼がある品目 1件', exact: true }).click();
  await expect(page.locator('#case article[data-item="Q"] h4')).toBeFocused();
});

test('1.10 セットがない台帳では使わないだけを出し、「セットの登録・変更」へ切り替える', async ({ page }) => {
  await startEmpty(page);
  const form = await choose(page, 'masterCase');
  await expect(form.locator('[name=caseSet] option')).toHaveText(['使わない']);
  await form.getByRole('button', { name: 'セットの登録・変更', exact: true }).click();
  await expect(form.locator('[name=op]')).toHaveValue('templateSave');
});

test('1.3, 2.1, 2.5 品番・コードなしに印を付けると案内が消え、使わないで記録した入力の写しに隠れた欄は入らない', async ({ page }) => {
  await startEmpty(page);
  await page.goto('/?test'); await waitForApp(page);
  const form = await choose(page, 'masterCase');
  const notice = form.locator('[data-case-notice]');
  await form.locator('[name=code]').fill('A-001');
  await expect(notice).toContainText('品番・コード A-001');
  await expect(notice).toContainText('この品番・コードは登録済み。既存の案件を使う');
  await form.locator('[name=codeNone]').check();
  await expect(form.locator('[name=code]')).toHaveValue('');
  await expect(notice).toBeEmpty();

  await form.locator('[name=name]').fill('架空用途N');
  await page.evaluate(() => window.fuzzyStockTest!.loseResponseAt(1));
  await submit(page);
  await expect(page.locator('#save')).toContainText('保存結果不明');
  const pending = decodePending(JSON.parse(await page.evaluate(() => localStorage.getItem('fuzzy-stock/pending')) ?? 'null'));
  expect(pending.values).toMatchObject({ '使うセット': '使わない' });
  for (const hidden of ['総予定数', '必要日（省略可）', '最初の受け取り', '受け取った台数']) expect(Object.keys(pending.values)).not.toContain(hidden);
  expect(Object.keys(pending.values)).not.toContain('欠品の手配先（不足があるときだけ必須。欠品リストの発行元など）');
  expect(Object.values(pending.units[0]!.ledger.masters.cases).filter(c => c.name === '架空用途N')).toMatchObject([{ code: null }]);
});

test('2.4 生成用の案内に生成できない理由が出て、登録済みでない値で消える', async ({ page }) => {
  const generated = generatedFor('A-001', 2);
  await open(page, { ...generated, ledger: changeMasters(generated.ledger, meta('op3'), { action: 'deactivate', type: 'case', id: 'B-001', reason: '架空の終了' }) });
  const form = await choose(page, 'templateNeedGenerate');
  const notice = form.locator('[data-case-notice]');
  await form.locator('[name=needCase]').fill('A-001');
  await expect(notice).toContainText('総予定数 2台');
  await expect(notice).toContainText('案件ID A-001 は必要明細を持つ。既存の必要明細を確認・変更する');
  await form.locator('[name=needCase]').fill('B-001');
  await expect(notice).toContainText('利用停止');
  await expect(notice).toContainText('案件ID B-001 は利用停止中');
  await form.locator('[name=needCase]').fill('Z-999');
  await expect(notice).toBeEmpty();
});

// 「確認した」は全種類で共有するが、作業の開始の経路で出る確認は総予定数の超過だけなので、別の確認の印を流用して超過が通る重なりは起きない。
test('3.5 作業の開始の超過の確認は入力を変えると外れ、変えた後の超過台数を出し直す', async ({ page }) => {
  await open(page, generatedFor('A-001', 1));
  const start = { process: 'R組立', newId: 'R-work', item: 'R', unit: '台', project: 'A-001', location: 'T', basis: 'counted', value: '2' };
  const before = await snapshotOf(page);
  await expect(await record(page, 'start', start)).toContainText('確認が必要：');
  await expect(status(page)).toContainText('総予定数を1台超える');
  const confirmed = formOf(page).locator('[name=confirmed]');
  await confirmed.check();
  await formOf(page).locator('[name=value]').fill('3');
  await expect(confirmed).not.toBeChecked();
  await expect(confirmed).toBeHidden();
  await submit(page);
  await expect(status(page)).toContainText('総予定数を2台超える');
  expect((await snapshotOf(page)).ledger.history).toEqual(before.ledger.history);
  await confirmed.check();
  await submit(page);
  await expect(status(page)).toContainText('記録した');
  expect((await snapshotOf(page)).ledger.history.filter(e => e.kind === 'start')).toHaveLength(1);
});

test('3.5 セットで作業を開始で超えるとき、使用候補の確認と超過の確認は互いに外れず、超過の文も残る', async ({ page }) => {
  const generated = generatedFor('A-001', 1);
  let ledger = generated.ledger;
  for (const [id, item] of [['P-1', 'P'], ['Q-1', 'Q']] as const) ledger = register(ledger, meta(`r-${id}`), { id, item, unit: '個', project: { kind: 'case', id: 'A-001' }, location: 'S1' }, 'counted', 50);
  await open(page, { ...generated, ledger });
  const form = await choose(page, 'recipeStart');
  await form.locator('[name=process]').selectOption('R組立');
  await form.locator('[name=newId]').fill('R-work');
  await form.locator('[name=item]').selectOption('R');
  await form.locator('[name=project]').selectOption('A-001');
  await form.locator('[name=location]').selectOption('T');
  await form.locator('[name=basis]').selectOption('counted');
  await form.locator('[name=value]').fill('2');
  await form.locator('[name=recipe]').selectOption('kit');
  await form.getByRole('button', { name: '使用候補を出す', exact: true }).click();
  await form.locator('[name=e0u0lot]').selectOption('P-1');
  await form.locator('[name=e1u0lot]').selectOption('Q-1');
  const estimate = form.locator('[name=estimateConfirmed]'), progress = form.locator('[name=confirmed]');
  await estimate.check();
  await submit(page);
  await expect(status(page)).toContainText('総予定数を1台超える');
  await progress.check();
  await estimate.uncheck(); await estimate.check();
  await expect(progress).toBeChecked();
  await expect(status(page)).toContainText('総予定数を1台超える');
  await submit(page);
  await expect(status(page)).toContainText('記録した');
  expect((await snapshotOf(page)).ledger.history.filter(e => e.kind === 'start')).toHaveLength(1);
});

test('3.7 再計算で超えるとき、変更の確認と超過の確認は互いに外れず、両方で記録できる', async ({ page }) => {
  const generated = generatedFor('A-001', 3);
  await open(page, { ...generated, ledger: start(generated.ledger, meta('op3'), { id: 'R-work', item: 'R', unit: '台', project: { kind: 'case', id: 'A-001' }, location: 'T' }, { id: 'R組立', criterion: 'inspection' }, 'counted', 2, []) });
  const form = await choose(page, 'templateNeedEdit');
  await form.locator('[name=needProject]').selectOption('A-001');
  await form.locator('[name=needAction]').selectOption('recalculate');
  await form.locator('[name=needCount]').fill('1');
  await form.locator('[name=needReason]').fill('架空の計画変更');
  await form.getByRole('button', { name: '変更をプレビュー', exact: true }).click();
  const need = form.locator('[name=needConfirmed]'), progress = form.locator('[name=confirmed]');
  await need.check();
  await submit(page);
  await expect(status(page)).toContainText('総予定数を1台超える');
  await progress.check();
  await expect(need).toBeChecked();
  await need.uncheck(); await need.check();
  await expect(progress).toBeChecked();
  await submit(page);
  await expect(status(page)).toContainText('記録した');
  expect((await snapshotOf(page)).supply.templateNeeds['A-001']).toMatchObject({ count: 1 });
});

test('5.1, 5.3, 5.4, 5.6 登録情報の種類を件数つきで切り替え、対象の選択とキーボードでも移る', async ({ page }) => {
  await startEmpty(page);
  await goTo(page, 'masters');
  const masters = page.locator('#masters');
  const kinds = masters.getByRole('group', { name: '登録情報の種類' });
  const kind = (name: string) => kinds.getByRole('button', { name: new RegExp(`^${name}(（|$)`) });
  await expect(kind('品目')).toHaveAttribute('aria-current', 'true');
  await expect(masters.getByRole('table', { name: '品目の登録情報' })).toBeVisible();
  await expect(masters.getByRole('table', { name: '場所の登録情報' })).toBeHidden();
  await expect(masters.getByRole('button', { name: '品目を登録', exact: true })).toBeVisible();
  await expect(masters.getByRole('button', { name: '場所を登録', exact: true })).toBeHidden();
  await expect(masters.getByRole('button', { name: '次工程への置き場を指定', exact: true })).toBeHidden();

  const query = masters.getByLabel('名称・品番・コードで絞り込み', { exact: true });
  await query.fill('A-00');
  await expect(kinds.getByRole('button')).toHaveText(['品目（0件）', '場所（0件）', '案件・用途（2件）', '担当者（0件）', '工程（0件）']);
  await expect(masters.getByText('品目：該当なし', { exact: true })).toBeVisible();
  await expect(masters.getByText('場所：該当なし', { exact: true })).toBeHidden();
  await query.fill('');

  await kind('品目').focus();
  await page.keyboard.press('Tab');
  await expect(kind('場所')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(kind('場所')).toHaveAttribute('aria-current', 'true');
  await expect(masters.getByRole('table', { name: '場所の登録情報' })).toBeVisible();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Space');
  await expect(kind('案件・用途')).toHaveAttribute('aria-current', 'true');
  const look = (node: Element) => { const s = getComputedStyle(node); return { weight: Number(s.fontWeight), border: parseFloat(s.borderTopWidth) }; };
  const [current, other] = [await kind('案件・用途').evaluate(look), await kind('品目').evaluate(look)];
  expect(current.weight).toBeGreaterThan(other.weight);
  expect(current.border).toBeGreaterThan(other.border);

  await masters.locator('[name=master-history]').selectOption('process:R組立');
  await expect(kind('工程')).toHaveAttribute('aria-current', 'true');
  await expect(masters.getByRole('table', { name: '工程の登録情報' })).toBeVisible();
  await expect(masters.locator('[name=master-history]')).toHaveValue('process:R組立');
  // 5.2：工程では次工程への置き場の指定も一緒に出る。
  await expect(masters.getByRole('button', { name: '次工程への置き場を指定', exact: true })).toBeVisible();

  // 5.7：選んだ種類は保存しないので、読み込み直すと品目に戻る。
  await page.reload();
  await goTo(page, 'masters');
  await expect(kind('品目')).toHaveAttribute('aria-current', 'true');
});

test('単独生成の入力も競合で退避し、確認と署名を戻さず、プレビューし直してから一回だけ生成する', async ({ page, context }) => {
  await open(page, withKit());
  const form = await choose(page, 'templateNeedGenerate');
  const other = await context.newPage(); await other.goto('/'); await waitForApp(other);
  await form.locator('[name=needTemplate]').selectOption('kit');
  await form.locator('[name=needCase]').fill('A-001');
  await form.locator('[name=needCount]').fill('2');
  await form.getByRole('button', { name: '必要明細をプレビュー', exact: true }).click();
  await form.locator('[name=needConfirmed]').check();
  await recorded(other, 'masterRename', { target: 'item:P', name: '架空部品の別名', reason: '架空の更新' });
  await expect(page.locator('#conflict')).toContainText('未解消');
  const draft = decodeDraft((await draftOf(page))!).draft;
  expect(draft.fields).toContainEqual(expect.objectContaining({ name: 'needCase', value: 'A-001' }));
  expect(draft.fields).toContainEqual(expect.objectContaining({ name: 'needCount', value: '2' }));
  expect(draft.fields).toContainEqual(expect.objectContaining({ name: 'needConfirmed', checked: true }));
  expect(draft.fields.some((field: { name: string }) => field.name === 'needPreview')).toBe(false);

  await page.reload(); await waitForApp(page);
  expect((await snapshotOf(page)).supply.templateNeeds).toEqual({});
  await expect(page.locator('#conflict')).toContainText('A-001');
  await expect(page.locator('[name=needConfirmed]:checked')).toHaveCount(0);
  await expect(page.locator('[name=needPreview]')).toHaveCount(0);
  const panel = page.locator('#conflict');
  await panel.getByLabel('元入力を控えた').check(); await panel.getByLabel('最新記録から入力し直す').check();
  await panel.getByLabel('理由').fill('改名後の品目で生成し直す'); await panel.getByLabel('最新の記録を確認した').check();
  await panel.getByRole('button', { name: '「最新記録から入力し直す」で保存する' }).click();
  await expect(panel).toContainText('確定済み：最新記録から入力し直す');
  expect(await draftOf(page)).toBeNull();

  await choose(page, 'templateNeedGenerate');
  await expect(form.locator('[name=needPreview]')).toHaveValue('');
  await expect(form.locator('[name=needConfirmed]')).not.toBeChecked();
  await form.locator('[name=needTemplate]').selectOption('kit');
  for (const name of ['needCase', 'needCount']) {
    const field = draft.fields.find(field => field.name === name);
    if (field?.kind !== 'text') throw new Error(`退避した欄がない：${name}`);
    await form.locator(`[name=${name}]`).fill(field.value);
  }
  await submit(page);
  await expect(status(page)).toContainText('プレビュー');
  expect((await snapshotOf(page)).supply.templateNeeds).toEqual({});
  await form.getByRole('button', { name: '必要明細をプレビュー', exact: true }).click();
  await expect(form.getByRole('table', { name: '生成する必要明細' })).toContainText('4個');
  await form.locator('[name=needConfirmed]').check();
  await submit(page);
  await expect(status(page)).toContainText('記録した');
  const saved = await snapshotOf(page);
  expect(saved.supply.templateNeeds['A-001']).toMatchObject({ count: 2 });
  expect(saved.supply.log.filter(event => event.kind === 'templateNeeds' && event.action === 'generate')).toHaveLength(1);
  await page.reload(); await waitForApp(page); expect((await snapshotOf(page)).supply).toEqual(saved.supply);
});
