import { expect, test, type Page } from '@playwright/test';
import { goTo, recorded, selectOperation, startEmpty, waitForApp, waitForPersistence } from './helpers.ts';
import { draftOf, snapshotOf } from './conflict-helpers.ts';
import { changeMasters, practiceLedger, type Meta } from '../../src/domain/ledger.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { saveReceiptTemplate } from '../../src/domain/receipt-template.ts';
import { initial, serialize } from '../../src/ui/storage.ts';
import { parseConflictReview } from '../../src/ui/conflictrecord.ts';
import { decodeDraft } from '../../src/ui/conflictdraft.ts';

const formOf = (page: Page) => page.getByRole('form', { name: '操作の入力' });

test('取り下げ後の欠番がある台帳でも次の操作IDでプレビューできる', async ({ page }) => {
  const meta = (eventId: string): Meta => ({ eventId, actor: '架空担当A', recordedAt: '2026-10-30T09:00:00+09:00', occurredAt: '2026-10-30T09:00:00+09:00' });
  const supply = saveReceiptTemplate(practiceLedger, emptySupply, meta('op1'), { id: 'kit', name: '架空セット', product: 'R', basis: 'label', rows: [{ item: 'P', unit: '個', perSet: 2, location: 'S1' }] });
  const ledger = changeMasters(practiceLedger, meta('op3'), { action: 'rename', type: 'item', id: 'P', name: '架空部品の改名', reason: '呼び名の訂正' });
  const raw = serialize({ ...initial(ledger, supply), opFloor: 4 });
  await page.goto('/'); await waitForApp(page);
  await page.evaluate(raw => { localStorage.setItem('fuzzy-stock/slot-A', raw); localStorage.setItem('fuzzy-stock/head', 'A'); }, raw);
  await page.reload(); await waitForApp(page);
  await goTo(page, 'stock');
  const form = formOf(page);
  await selectOperation(form.locator('[name=op]'), 'templateNeedGenerate');
  await form.locator('[name=needTemplate]').selectOption('kit');
  await form.locator('[name=needCase]').fill('000009');
  await form.locator('[name=needCount]').fill('10');
  await form.getByRole('button', { name: '必要明細をプレビュー' }).click();
  await expect(form.getByRole('table', { name: '生成する必要明細' })).toContainText('20個');
});

test('9.1 初回の空台帳から登録情報とセットを作り、単独案件を生成する', async ({ page }) => {
  await page.goto('/'); await waitForApp(page);
  expect(Object.keys((await snapshotOf(page)).ledger.masters.items)).toHaveLength(0);
  await recorded(page, 'masterActor', { name: '架空担当' });
  await recorded(page, 'masterLocation', { code: 'S1', name: '架空棚', inScope: 'true' });
  await recorded(page, 'masterItem', { code: 'P', name: '架空部品', units: '個' });
  await recorded(page, 'masterItem', { code: 'R', name: '架空製品', units: '台' });
  const id = await createSet(page), form = formOf(page);
  await selectOperation(form.locator('[name=op]'), 'templateNeedGenerate');
  await form.locator('[name=needTemplate]').selectOption(id);
  await form.locator('[name=needCase]').fill('000008');
  await form.locator('[name=needCount]').fill('10');
  await form.getByRole('button', { name: '必要明細をプレビュー' }).click();
  await expect(form.getByRole('table', { name: '生成する必要明細' })).toContainText('50個');
  await form.locator('[name=needConfirmed]').check();
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
  await waitForPersistence(page);
  const saved = await snapshotOf(page);
  expect(saved.ledger.masters.cases['000008']?.code).toBe('000008');
  expect(Object.values(saved.supply.needs).map(need => need.required.value)).toEqual([50]);
  expect(saved.ledger.lots).toEqual({});
  await page.reload(); await waitForApp(page);
  expect((await snapshotOf(page)).supply).toEqual(saved.supply);
});
async function createSet(page: Page): Promise<string> {
  const form = formOf(page);
  await selectOperation(form.locator('[name=op]'), 'templateSave');
  await form.locator('[name=templateName]').fill('架空必要数セット');
  await form.locator('[name=templateProduct]').selectOption('R');
  await form.locator('[name=templateProductUnit]').selectOption('台');
  for (const [index, quantity] of ['2', '3'].entries()) {
    if (index) await form.getByRole('button', { name: '明細を追加', exact: true }).click();
    await form.locator(`[name=t${index}item]`).selectOption('P');
    await form.locator(`[name=t${index}unit]`).selectOption('個');
    await form.locator(`[name=t${index}perSet]`).fill(quantity);
    await form.locator(`[name=t${index}location]`).selectOption('S1');
  }
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
  const template = Object.values((await snapshotOf(page)).supply.receiptTemplates)[0];
  if (!template) throw new Error('セットがない');
  return template.id;
}

for (const batch of [false, true]) test(`2.1, 2.11, 3.8 ${batch ? 'まとめ生成' : '単独生成'}は成功したプレビューだけを確認できる`, async ({ page }) => {
  await startEmpty(page);
  const id = await createSet(page), form = formOf(page);
  await selectOperation(form.locator('[name=op]'), batch ? 'templateNeedBatch' : 'templateNeedGenerate');
  const confirmed = form.locator('[name=needConfirmed]');
  await expect(confirmed).toBeDisabled();
  if (batch) {
    await form.locator('[name=needAssemblyTemplate]').selectOption(id);
    await form.locator('[name=needInspectionTemplate]').selectOption(id);
    await form.locator('[name=needAssemblyCase]').fill('000071');
    await form.locator('[name=needInspectionCase0]').fill('000072');
  } else {
    await form.locator('[name=needTemplate]').selectOption(id);
    await form.locator('[name=needCase]').fill('000071');
  }
  const count = form.locator(batch ? '[name=needAssemblyCount]' : '[name=needCount]');
  const preview = form.getByRole('button', { name: batch ? '全案件の必要明細をプレビュー' : '必要明細をプレビュー', exact: true });
  await count.fill('10'); await preview.click();
  await expect(confirmed).toBeEnabled(); await confirmed.check();
  await count.fill('11');
  await expect(confirmed).not.toBeChecked(); await expect(confirmed).toBeDisabled();
  await preview.click(); await expect(confirmed).toBeEnabled();
  await count.fill('0'); await preview.click();
  await expect(confirmed).toBeDisabled();
});

test('2.1 生成プレビューを狭い画面でもキーボードで横スクロールできる', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 840 });
  await startEmpty(page);
  const id = await createSet(page), form = formOf(page);
  await selectOperation(form.locator('[name=op]'), 'templateNeedGenerate');
  await form.locator('[name=needTemplate]').selectOption(id);
  await form.locator('[name=needCase]').fill('000073');
  await form.locator('[name=needCount]').fill('10');
  await form.getByRole('button', { name: '必要明細をプレビュー', exact: true }).click();
  const scroll = form.getByRole('region', { name: '生成する必要明細（横スクロール）', exact: true });
  await expect(scroll).toHaveAttribute('tabindex', '0');
  expect(await scroll.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  await scroll.focus(); await expect(scroll).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => scroll.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
});

test('案件IDの前後の空白は入力を残して生成を止める', async ({ page }) => {
  await startEmpty(page);
  const id = await createSet(page), form = formOf(page), before = await snapshotOf(page);
  await selectOperation(form.locator('[name=op]'), 'templateNeedGenerate');
  await form.locator('[name=needTemplate]').selectOption(id);
  await form.locator('[name=needCase]').fill('000007 '); await form.locator('[name=needCount]').fill('10');
  await form.getByRole('button', { name: '必要明細をプレビュー', exact: true }).click();
  await expect(form.locator('[data-need-preview]')).toContainText('前後の空白');
  await expect(form.locator('[name=needCase]')).toHaveValue('000007 ');
  await expect(form.locator('[name=needConfirmed]')).toBeDisabled();
  expect((await snapshotOf(page)).supply).toEqual(before.supply);
  expect((await snapshotOf(page)).ledger).toEqual(before.ledger);
});

test('分け先の行の削除は選んだ行だけを除き、他行の手入力台数とIDを保つ', async ({ page }) => {
  await startEmpty(page);
  const id = await createSet(page), form = formOf(page);
  await selectOperation(form.locator('[name=op]'), 'templateNeedBatch');
  await form.locator('[name=needAssemblyTemplate]').selectOption(id); await form.locator('[name=needInspectionTemplate]').selectOption(id);
  await form.locator('[name=needAssemblyCount]').fill('50'); await form.locator('[name=needMode]').selectOption('split');
  await form.getByRole('button', { name: '分け先の台数を提案', exact: true }).click();
  for (let index = 0; index < 3; index++) await form.locator(`[name=needInspectionCase${index}]`).fill(`00000${index + 1}`);
  await form.locator('[name=needInspectionCount2]').fill('17');
  await form.getByRole('button', { name: '分け先2の案件を削除', exact: true }).click();
  await expect(form.locator('[name=needRows]')).toHaveValue('2');
  await expect(form.locator('[name=needInspectionCase0]')).toHaveValue('000001');
  await expect(form.locator('[name=needInspectionCount0]')).toHaveValue('20');
  await expect(form.locator('[name=needInspectionCase1]')).toHaveValue('000003');
  await expect(form.locator('[name=needInspectionCount1]')).toHaveValue('17');
  await expect(form.locator('[name=needConfirmed]')).toBeDisabled();
  await form.locator('[name=needMode]').selectOption('same');
  await expect(form.getByRole('button', { name: '分け先1の案件を削除', exact: true })).toBeHidden();
  await form.locator('[name=needMode]').selectOption('split');
  await expect(form.locator('[name=needInspectionCase1]')).toHaveValue('000003');
  await expect(form.locator('[name=needInspectionCount1]')).toHaveValue('17');
});

test('FT-05, FT-07 単独案件のプレビュー・合算・保存・再読込と二重生成拒否', async ({ page }) => {
  await startEmpty(page);
  const id = await createSet(page), before = await snapshotOf(page), form = formOf(page);
  await selectOperation(form.locator('[name=op]'), 'templateNeedGenerate');
  await form.locator('[name=needTemplate]').selectOption(id);
  await form.locator('[name=needCase]').fill('000007');
  await form.locator('[name=needCount]').fill('10');
  await form.locator('[name=needDue]').fill('2026-11-01');
  await form.getByRole('button', { name: '必要明細をプレビュー' }).click();
  await expect(form.getByRole('table', { name: '生成する必要明細' })).toContainText('50個');
  await expect(form.locator('[data-need-preview]')).toContainText('新しく登録');
  await form.locator('[name=needConfirmed]').check();
  await form.locator('[name=needCount]').fill('9');
  await expect(form.locator('[name=needConfirmed]')).not.toBeChecked();
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('プレビュー');
  await expect(form.locator('[name=needCase]')).toHaveValue('000007');
  await form.locator('[name=needCount]').fill('10');
  await form.getByRole('button', { name: '必要明細をプレビュー' }).click();
  await form.locator('[name=needConfirmed]').check();
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
  await waitForPersistence(page);
  const saved = await snapshotOf(page);
  expect(saved.ledger.masters.cases['000007']?.code).toBe('000007');
  expect(Object.values(saved.supply.needs).map(need => need.required.value)).toEqual([50]);
  expect(saved.ledger.lots).toEqual(before.ledger.lots);
  expect(saved.supply.requests).toEqual(before.supply.requests);
  await page.reload(); await waitForApp(page);
  expect((await snapshotOf(page)).supply).toEqual(saved.supply);
  await goTo(page, 'stock');
  await selectOperation(formOf(page).locator('[name=op]'), 'templateNeedGenerate');
  await formOf(page).locator('[name=needTemplate]').selectOption(id);
  await formOf(page).locator('[name=needCase]').fill('000007');
  await formOf(page).locator('[name=needCount]').fill('10');
  await formOf(page).getByRole('button', { name: '必要明細をプレビュー' }).click();
  await expect(formOf(page).locator('[data-need-preview]')).toContainText('必要明細を持つ');
  expect(Object.keys((await snapshotOf(page)).supply.needs)).toHaveLength(1);
});

test('FT-02, 3.1 同数40台を全案件で確認し、一度に保存する', async ({ page }) => {
  await startEmpty(page);
  const id = await createSet(page), before = await snapshotOf(page), form = formOf(page);
  await selectOperation(form.locator('[name=op]'), 'templateNeedBatch');
  await form.locator('[name=needAssemblyTemplate]').selectOption(id);
  await form.locator('[name=needInspectionTemplate]').selectOption(id);
  await form.locator('[name=needAssemblyCase]').fill('000010');
  await form.locator('[name=needAssemblyCount]').fill('40');
  await expect(form.locator('[name=needInspectionCase0]')).toHaveValue('');
  await expect(form.locator('[name=needInspectionCount0]')).toHaveValue('40');
  await expect(form.locator('[name=needInspectionCount0]')).toHaveAttribute('readonly', '');
  await form.locator('[name=needInspectionCase0]').fill('000011');
  await form.getByRole('button', { name: '全案件の必要明細をプレビュー', exact: true }).click();
  await expect(form.getByRole('table', { name: '生成する必要明細' })).toHaveCount(2);
  await expect(form.locator('[data-need-preview]')).toContainText('200個');
  await form.locator('[name=needConfirmed]').check();
  await form.locator('[name=needInspectionTemplate]').selectOption('');
  await expect(form.locator('[name=needConfirmed]')).not.toBeChecked();
  await expect(form.locator('[data-need-preview]')).toBeEmpty();
  await form.locator('[name=needInspectionTemplate]').selectOption(id);
  await form.getByRole('button', { name: '全案件の必要明細をプレビュー', exact: true }).click();
  await form.locator('[name=needConfirmed]').check();
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
  await waitForPersistence(page);
  const saved = await snapshotOf(page);
  expect(Object.values(saved.supply.templateNeeds).map(plan => plan.count)).toEqual([40, 40]);
  expect(Object.values(saved.supply.needs).map(need => [need.project.id, need.required.value])).toEqual([['000010', 200], ['000011', 200]]);
  expect(saved.supply.log.filter(event => event.kind === 'templateNeeds')).toHaveLength(1);
  expect(saved.ledger.lots).toEqual(before.ledger.lots);
  expect(saved.supply.requests).toEqual(before.supply.requests);
  await page.reload(); await waitForApp(page);
  expect((await snapshotOf(page)).supply).toEqual(saved.supply);
});

test('3.3–3.5 分割90台は20/20/20/20/10を提案し、ID原文と手編集を保つ', async ({ page }) => {
  await startEmpty(page);
  const id = await createSet(page), form = formOf(page);
  await selectOperation(form.locator('[name=op]'), 'templateNeedBatch');
  await form.locator('[name=needAssemblyTemplate]').selectOption(id);
  await form.locator('[name=needInspectionTemplate]').selectOption(id);
  await form.locator('[name=needAssemblyCase]').fill('000020');
  await form.locator('[name=needAssemblyCount]').fill('90');
  await form.locator('[name=needMode]').selectOption('split');
  await expect(form.locator('[name=needSplit]')).toHaveValue('20');
  await form.getByRole('button', { name: '分け先の台数を提案', exact: true }).click();
  for (const [index, count] of ['20', '20', '20', '20', '10'].entries()) {
    await expect(form.locator(`[name=needInspectionCount${index}]`)).toHaveValue(count);
    await expect(form.locator(`[name=needInspectionCase${index}]`)).toHaveValue('');
    await form.locator(`[name=needInspectionCase${index}]`).fill(`00002${index + 1}`);
  }
  await form.locator('[name=needInspectionCount4]').fill('0');
  await form.getByRole('button', { name: '全案件の必要明細をプレビュー', exact: true }).click();
  await expect(form.locator('[data-need-preview]')).toContainText('正の安全な整数');
  await form.locator('[name=needInspectionCount4]').fill('1');
  await form.locator('[name=needInspectionCount3]').fill('19');
  await form.getByRole('button', { name: '全案件の必要明細をプレビュー', exact: true }).click();
  await expect(form.locator('[data-need-preview]')).toContainText('合計');
  await expect(form.locator('[name=needInspectionCount3]')).toHaveValue('19');
  await form.locator('[name=needMode]').selectOption('same');
  await expect(form.locator('[name=needInspectionCount0]')).toHaveValue('90');
  await expect(form.locator('[name=needInspectionCase0]')).toHaveValue('000021');
  await expect(form.getByRole('button', { name: '分け先の案件を追加', exact: true })).toBeHidden();
  await form.locator('[name=needMode]').selectOption('split');
  await expect(form.locator('[name=needInspectionCount3]')).toHaveValue('19');
  await expect(form.locator('[name=needInspectionCount4]')).toHaveValue('1');
  await expect(form.locator('[name=needInspectionCase4]')).toHaveValue('000025');
  await form.getByRole('button', { name: '分け先の台数を提案', exact: true }).click();
  for (let index = 0; index < 5; index++) await expect(form.locator(`[name=needInspectionCase${index}]`)).toHaveValue(`00002${index + 1}`);
  await form.getByRole('button', { name: '全案件の必要明細をプレビュー', exact: true }).click();
  await expect(form.getByRole('table', { name: '生成する必要明細' })).toHaveCount(6);
  await form.locator('[name=needConfirmed]').check();
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
  await waitForPersistence(page);
  const saved = await snapshotOf(page);
  expect(Object.values(saved.supply.templateNeeds).map(plan => plan.count)).toEqual([90, 20, 20, 20, 20, 10]);
  expect(Object.values(saved.ledger.masters.cases).filter(project => project.code?.startsWith('00002')).map(project => project.code)).toEqual(['000020', '000021', '000022', '000023', '000024', '000025']);
});

test('FT-14, 8.2 共有保存のnative中断・応答喪失・照会・再試行・競合でも全件性を保つ', async ({ page }) => {
  await startEmpty(page);
  await createSet(page);
  const observed = await page.evaluate(async () => {
    const storagePath = '/dist/ui/storage.js', authorityPath = '/dist/ui/shared-authority.js', needsPath = '/dist/domain/template-needs.js';
    const storage: typeof import('../../src/ui/storage.ts') = await import(storagePath);
    const { SharedAuthority }: typeof import('../../src/ui/shared-authority.ts') = await import(authorityPath);
    const { generateTemplateNeedsBatch }: typeof import('../../src/domain/template-needs.ts') = await import(needsPath);
    const loaded = storage.load(localStorage);
    if (loaded.kind !== 'ok') throw new Error('初期値なし');
    const authority = new SharedAuthority(localStorage, indexedDB, 'fictional-template-needs');
    await authority.enable(loaded.snapshot);
    const templateId = Object.keys(loaded.snapshot.supply.receiptTemplates)[0]!;
    const opId = storage.nextOpIdOf(loaded.snapshot), at = '2026-10-30T12:00:00+09:00';
    const input = { group: { assemblyIndex: 0, mode: 'same', split: null } as const, dueDate: null, projects: [{ templateId, caseCode: '000030', count: 40 }, { templateId, caseCode: '000031', count: 40 }] };
    const after = generateTemplateNeedsBatch(loaded.snapshot, { eventId: opId, actor: '架空担当A', occurredAt: at, recordedAt: at }, input);
    const opLabel = '2つのセットでまとめて生成', values = { input: JSON.stringify(input) };
    const op = { opId, opLabel, values, fingerprint: storage.fingerprintOf(opLabel, values), actor: '架空担当A', startedAt: at, savingSince: at };
    const units = [{ ...after, conflictReviews: [], targets: storage.targetsOf(loaded.snapshot, after) }];
    const before = await authority.read();
    let aborted = false;
    try { await authority.transact((state, core) => ({ state, value: storage.commit(core, loaded.snapshot, op, units) }), { abortAfterWrite: true }); } catch { aborted = true; }
    const afterAbort = await authority.read();
    storage.faults.loseResponseAt = 1;
    const lost = await authority.transact((state, core) => ({ state, value: storage.commit(core, loaded.snapshot, op, units) }));
    if (lost.kind !== 'unknown') throw new Error(`応答喪失なし ${lost.kind}`);
    const inquiry = await authority.transact((state, core) => ({ state, value: storage.inquire(core, lost.pending) }));
    const settled = await authority.transact((state, core) => ({ state, value: storage.retry(core, inquiry.snapshot, lost.pending, '架空担当A', at) }));
    const duplicate = await authority.transact((state, core) => ({ state, value: storage.commit(core, loaded.snapshot, op, units) }));
    const final = await authority.transact((state, core) => ({ state, value: storage.load(core) }));
    const conflict = await authority.transact((state, core) => ({ state, value: storage.commit(core, loaded.snapshot, { ...op, opId: 'op999' }, units) }));
    if (final.kind !== 'ok') throw new Error('再読込不可');
    return { aborted, abortUnchanged: JSON.stringify(before) === JSON.stringify(afterAbort), inquiry: [inquiry.savedUnits, inquiry.total], settle: settled.kind, duplicate: duplicate.kind, conflict: conflict.kind,
      counts: Object.values(final.snapshot.supply.templateNeeds).map(plan => plan.count), events: final.snapshot.supply.log.filter(event => event.kind === 'templateNeeds').length,
      cases: Object.values(final.snapshot.ledger.masters.cases).filter(project => project.code === '000030' || project.code === '000031').map(project => project.code) };
  });
  expect(observed).toEqual({ aborted: true, abortUnchanged: true, inquiry: [1, 1], settle: 'recovered', duplicate: 'recovered', conflict: 'conflict', counts: [40, 40], events: 1, cases: ['000030', '000031'] });
});

test('8.3 既存照合履歴の総量が上限近くても通常のまとめ生成を妨げない', async ({ page }) => {
  await startEmpty(page);
  const id = await createSet(page), current = await snapshotOf(page), at = '2026-10-30T12:00:00+09:00';
  const reviews = Array.from({ length: 4 }, (_, index) => {
    const reviewId = `fictional-${index}`, value = { eventId: `op${100 + index}`, reviewId, draft: { reviewId, origin: { kind: 'unsent' }, opKey: 'use', opLabel: '使用', actor: '架空担当A', occurredAt: null, baseRevision: 0, baseLastWriter: null, detectedAt: at, detectedReason: '外部更新', fields: [{ kind: 'text', name: 'reason', label: '理由', value: '' }], readEvidence: [], targets: [], unapplied: ['未送信'] }, resolution: { outcome: 'dismiss', reason: '取り下げ', actor: '架空担当A', at } };
    value.draft.fields[0]!.value = 'x'.repeat(65400 - new TextEncoder().encode(JSON.stringify(value)).length);
    return parseConflictReview(value);
  });
  const raw = serialize({ ...current, conflictReviews: reviews });
  await page.evaluate(raw => { localStorage.setItem('fuzzy-stock/slot-A', raw); localStorage.setItem('fuzzy-stock/head', 'A'); }, raw);
  await page.reload(); await waitForApp(page); await goTo(page, 'stock');
  const form = formOf(page);
  await selectOperation(form.locator('[name=op]'), 'templateNeedBatch');
  await form.locator('[name=needAssemblyTemplate]').selectOption(id);
  await form.locator('[name=needInspectionTemplate]').selectOption(id);
  await form.locator('[name=needAssemblyCase]').fill('000040');
  await form.locator('[name=needAssemblyCount]').fill('40');
  await form.locator('[name=needInspectionCase0]').fill('000041');
  await form.getByRole('button', { name: '全案件の必要明細をプレビュー', exact: true }).click();
  await expect(form.getByRole('table', { name: '生成する必要明細' })).toHaveCount(2);
  await form.locator('[name=needConfirmed]').check();
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
  await waitForPersistence(page);
  expect((await snapshotOf(page)).conflictReviews).toEqual(reviews);
});

test('2.11, 8.2 競合時は動的案件欄を参照用に残し、確認済み入力を復元・自動登録しない', async ({ page, context }) => {
  await startEmpty(page);
  const id = await createSet(page), form = formOf(page);
  const other = await context.newPage(); await other.goto('/'); await waitForApp(other);
  await selectOperation(form.locator('[name=op]'), 'templateNeedBatch');
  await form.locator('[name=needAssemblyTemplate]').selectOption(id);
  await form.locator('[name=needInspectionTemplate]').selectOption(id);
  await form.locator('[name=needAssemblyCase]').fill('000050');
  await form.locator('[name=needAssemblyCount]').fill('40');
  await form.locator('[name=needInspectionCase0]').fill('000051');
  await form.getByRole('button', { name: '全案件の必要明細をプレビュー', exact: true }).click();
  await form.locator('[name=needConfirmed]').check();
  await recorded(other, 'masterRename', { target: 'item:P', name: '架空部品改名', reason: '架空の更新' });
  await expect(page.locator('#conflict')).toContainText('未解消');
  const draft = decodeDraft((await draftOf(page))!).draft;
  expect(draft.fields).toContainEqual(expect.objectContaining({ name: 'needInspectionCase0', value: '000051' }));
  expect(draft.fields.some((field: { name: string }) => field.name === 'needPreview')).toBe(false);
  expect(Object.keys((await snapshotOf(page)).supply.templateNeeds)).toHaveLength(0);
  await page.reload(); await waitForApp(page);
  await expect(page.locator('#conflict')).toContainText('000051');
  expect(Object.keys((await snapshotOf(page)).supply.templateNeeds)).toHaveLength(0);
  const panel = page.locator('#conflict');
  await panel.getByLabel('元入力を控えた').check();
  await panel.getByLabel('最新記録から入力し直す').check();
  await panel.getByLabel('理由').fill('退避した動的案件IDを確認して再入力');
  await panel.getByLabel('最新の記録を確認した').check();
  await panel.getByRole('button', { name: '「最新記録から入力し直す」で保存する' }).click();
  await expect(panel).toContainText('確定済み：最新記録から入力し直す');
  expect(await draftOf(page)).toBeNull();
  await goTo(page, 'stock');
  await selectOperation(form.locator('[name=op]'), 'templateNeedBatch');
  await expect(form.locator('[name=needConfirmed]')).not.toBeChecked();
  await expect(form.locator('[name=needInspectionCase0]')).toHaveValue('');
  for (const name of ['needAssemblyTemplate', 'needInspectionTemplate', 'needAssemblyCase', 'needAssemblyCount', 'needInspectionCase0']) {
    const field = draft.fields.find(field => field.name === name);
    if (field?.kind !== 'text' && field?.kind !== 'select') throw new Error(`退避した欄がない：${name}`);
    if (field.kind === 'select') await form.locator(`[name=${name}]`).selectOption(field.value);
    else await form.locator(`[name=${name}]`).fill(field.value);
  }
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('プレビュー');
  expect(Object.keys((await snapshotOf(page)).supply.templateNeeds)).toHaveLength(0);
  await form.getByRole('button', { name: '全案件の必要明細をプレビュー', exact: true }).click();
  await form.locator('[name=needConfirmed]').check();
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
  await waitForPersistence(page);
  const saved = await snapshotOf(page);
  expect(Object.values(saved.supply.templateNeeds).map(plan => plan.count)).toEqual([40, 40]);
  expect(saved.supply.log.filter(event => event.kind === 'templateNeeds')).toHaveLength(1);
  await page.reload(); await waitForApp(page);
  expect((await snapshotOf(page)).supply).toEqual(saved.supply);
});
