import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import * as XLSX from 'xlsx';
import { backupButton, downloadVia, exportButton, goTo, jsonFile, pickFile, recorded, selectOperation, waitForApp, waitForPersistence, launchAdvanced } from './helpers.ts';
import { snapshotOf } from './conflict-helpers.ts';
import { parse } from '../../src/ui/storage.ts';

const formOf = (page: Page) => page.getByRole('form', { name: '操作の入力' });
async function choose(page: Page, operation: string) {
  await goTo(page, 'stock');
  await selectOperation(formOf(page).locator('[name=op]'), operation);
  return formOf(page);
}
async function save(page: Page) {
  await formOf(page).getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
  await waitForPersistence(page);
}
async function registerMasters(page: Page) {
  await page.goto('/'); await waitForApp(page);
  const empty = await snapshotOf(page);
  expect(empty.ledger.masters.items).toEqual({});
  expect(empty.ledger.lots).toEqual({});
  expect(empty.supply.needs).toEqual({});
  await recorded(page, 'masterActor', { name: '架空担当' });
  await recorded(page, 'masterLocation', { code: 'S1', name: '架空棚', inScope: 'true' });
  for (const [code, name, units] of [['P', '架空組立部品', '個'], ['Q', '架空検査部品', '個'], ['R_ASSY', '架空機種_ASSY', '台'], ['R', '架空機種', '台']] as const) {
    await recorded(page, 'masterItem', { code, name, units });
  }
}
async function createSet(page: Page, product: string, item: string, perSet: string) {
  const form = await choose(page, 'templateSave');
  await form.locator('[name=templateName]').fill(`架空${product}セット`);
  await form.locator('[name=templateProduct]').selectOption(product);
  await form.locator('[name=templateProductUnit]').selectOption('台');
  await form.locator('[name=t0item]').selectOption(item);
  await form.locator('[name=t0unit]').selectOption('個');
  await form.locator('[name=t0perSet]').fill(perSet);
  await form.locator('[name=t0location]').selectOption('S1');
  await save(page);
  const set = Object.values((await snapshotOf(page)).supply.receiptTemplates).find(set => set.product === product);
  if (!set) throw new Error('登録したセットがない');
  return set.id;
}
async function previewChange(page: Page, project: string, action: string) {
  const form = await choose(page, 'templateNeedEdit');
  await form.locator('[name=needProject]').selectOption(project);
  await form.locator('[name=needAction]').selectOption(action);
  return form;
}
async function restore(page: Page, file: string | ReturnType<typeof jsonFile>) {
  await pickFile(page, file);
  const confirmation = page.getByRole('region', { name: '復元の確認' });
  await confirmation.getByRole('button', { name: '復元する', exact: true }).click();
  await expect(confirmation).toBeHidden();
  await waitForPersistence(page);
}

test('FT-01/03/04/06/12/13 空台帳で別セット・無関係IDを登録し、合計80は全件拒否、90台を分割生成する', async ({ page }) => {
  await registerMasters(page);
  let form = await choose(page, 'templateNeedGenerate');
  await expect(form).toContainText('セットの登録・変更');
  await form.locator('[name=needCase]').fill('00582103');
  await form.locator('[name=needCount]').fill('90');
  const noSet = await snapshotOf(page);
  await form.getByRole('button', { name: '必要明細をプレビュー' }).click();
  await expect(form.locator('[data-need-preview]')).toContainText('セット');
  await expect(form.locator('[name=needConfirmed]')).toBeDisabled(); await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('セットを選ぶ');
  expect(await snapshotOf(page)).toEqual(noSet);
  const assembly = await createSet(page, 'R_ASSY', 'P', '1');
  const inspection = await createSet(page, 'R', 'Q', '2');
  const before = await snapshotOf(page);
  expect(before.supply.receiptTemplates[inspection]?.rows.map(row => row.item)).toEqual(['Q']);
  form = await choose(page, 'templateNeedBatch');
  await form.locator('[name=needAssemblyTemplate]').selectOption(assembly);
  await form.locator('[name=needInspectionTemplate]').selectOption(inspection);
  await form.locator('[name=needAssemblyCase]').fill('00582103');
  await form.locator('[name=needAssemblyCount]').fill('90');
  await form.locator('[name=needMode]').selectOption('split');
  await form.getByRole('button', { name: '検査用の台数を提案', exact: true }).click();
  const projects = ['900007', '0042', '7310009', '0000876', '260019'];
  for (const [index, project] of projects.entries()) {
    await expect(form.locator(`[name=needInspectionCase${index}]`)).toHaveValue('');
    await expect(form.locator(`[name=needInspectionCount${index}]`)).toHaveValue(index === 4 ? '10' : '20');
    await form.locator(`[name=needInspectionCase${index}]`).fill(project);
  }
  await form.locator('[name=needInspectionCount3]').fill('10');
  await form.getByRole('button', { name: '全案件の必要明細をプレビュー', exact: true }).click();
  await expect(form.locator('[data-need-preview]')).toContainText('台数の差は-10台');
  await expect(form.locator('[data-need-preview]')).toContainText('合計を一致させる');
  await expect(form.locator('[name=needConfirmed]')).toBeDisabled(); await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('プレビュー');
  expect(await snapshotOf(page)).toEqual(before);
  await form.locator('[name=needInspectionCount3]').fill('20');
  await form.getByRole('button', { name: '全案件の必要明細をプレビュー', exact: true }).click();
  const tables = form.getByRole('table', { name: '生成する必要明細' });
  await expect(tables).toHaveCount(6);
  for (const [index, quantity] of ['40', '40', '40', '40', '20'].entries()) await expect(tables.nth(index + 1)).toContainText(`${quantity}個`);
  await form.locator('[name=needConfirmed]').check(); await save(page);
  const generated = await snapshotOf(page);
  expect(['00582103', ...projects].map(project => generated.supply.templateNeeds[project]?.count)).toEqual([90, 20, 20, 20, 20, 10]);
  expect(Object.values(generated.ledger.masters.cases).map(project => project.code).sort()).toEqual(['00582103', ...projects].sort());
  expect(projects.map(project => Object.values(generated.supply.needs).find(need => need.project.id === project)?.required.value)).toEqual([40, 40, 40, 40, 20]);
  expect(generated.supply.log.filter(event => event.kind === 'templateNeeds')).toHaveLength(1);
  expect(generated.ledger.lots).toEqual(before.ledger.lots);
  expect(generated.supply.requests).toEqual(before.supply.requests);
  form = await choose(page, 'templateSave');
  await form.locator('[name=template]').selectOption(assembly); await form.locator('[name=t0perSet]').fill('3'); await save(page);
  const revised = await snapshotOf(page);
  expect(revised.supply.receiptTemplates[inspection]).toEqual(generated.supply.receiptTemplates[inspection]);
  expect(revised.supply.needs).toEqual(generated.supply.needs);
  expect(revised.supply.templateNeeds).toEqual(generated.supply.templateNeeds);
});

test('FT-05/08/09/10/11/15/17 欠品受け取り後の案件変更・15台再計算・明示追従・Excel・復元・再起動', async ({ baseURL }, testInfo) => {
  if (!baseURL) throw new Error('ローカル配信URLがない');
  const profile = testInfo.outputPath('edge-profile'), options = { channel: 'msedge', baseURL, timezoneId: 'Asia/Tokyo', locale: 'ja-JP' };
  let context: BrowserContext | null = null;
  try {
    context = await launchAdvanced(profile, options);
    const page = await context.newPage();
    await registerMasters(page);
    const assembly = await createSet(page, 'R_ASSY', 'P', '1'), inspection = await createSet(page, 'R', 'Q', '1');
    let form = await choose(page, 'templateNeedBatch');
    await form.locator('[name=needAssemblyTemplate]').selectOption(assembly);
    await form.locator('[name=needInspectionTemplate]').selectOption(inspection);
    await form.locator('[name=needAssemblyCase]').fill('00582103'); await form.locator('[name=needAssemblyCount]').fill('20');
    await form.locator('[name=needInspectionCase0]').fill('901076');
    await form.getByRole('button', { name: '全案件の必要明細をプレビュー', exact: true }).click();
    await form.locator('[name=needConfirmed]').check(); await save(page);
    const generated = await snapshotOf(page), plan = generated.supply.templateNeeds['00582103'];
    if (!plan) throw new Error('生成した案件がない');
    const needId = plan.origins[0]!.needId;
    expect(generated.ledger.lots).toEqual({}); expect(generated.supply.receipts).toEqual({}); expect(generated.supply.requests).toEqual({});
    await goTo(page, 'supply');
    const group = page.locator('[data-group="00582103/P/個"]');
    await expect(group).toContainText('必要な数 20個'); await expect(group).toContainText('不足 20個');
    form = await choose(page, 'templateReceive');
    await form.locator('[name=template]').selectOption(assembly); await form.locator('[name=project]').selectOption('00582103');
    await form.locator('[name=sets]').fill('20'); await form.getByRole('button', { name: '予定数を展開' }).click();
    await form.locator('[name=shortfall0]').fill('2'); await expect(form.locator('[name=actual0]')).toHaveValue('18');
    await form.locator('[name=vendor]').fill('架空手配先'); await form.locator('[name=templateConfirmed]').check(); await save(page);
    const received = await snapshotOf(page);
    expect(received.supply.needs[needId]?.required).toEqual({ basis: 'label', value: 20 });
    expect(Object.values(received.supply.receipts).map(receipt => receipt.received)).toEqual([18]);
    expect(Object.values(received.supply.requests)).toMatchObject([{ quantity: 2, project: { kind: 'case', id: '00582103' }, item: 'P', vendor: '架空手配先' }]);
    await goTo(page, 'supply');
    await expect(group).toContainText('不足 2個'); await expect(group).toContainText('依頼の未着 2個');
    await expect(group).toContainText('不足の解消：未解消に見えるが確定していない（不足2個');
    await expect(group).not.toContainText('不足4個');
    const lotId = Object.keys(received.ledger.lots)[0]!;
    await goTo(page, 'stock'); await recorded(page, 'use', { lot: lotId, basis: 'label', value: '1', usedFor: '架空作業' }, null);
    const physical = await snapshotOf(page);
    form = await choose(page, 'templateSave');
    await form.locator('[name=template]').selectOption(assembly); await form.locator('[name=t0perSet]').fill('2'); await save(page);
    const revised = await snapshotOf(page);
    expect(revised.supply.needs).toEqual(physical.supply.needs); expect(revised.supply.templateNeeds).toEqual(physical.supply.templateNeeds);
    form = await previewChange(page, '00582103', 'change');
    await form.locator('[name=need]').selectOption(needId); await form.locator('[name=basis]').selectOption('counted');
    await form.locator('[name=value]').fill('7'); await form.locator('[name=needReason]').fill('架空案件だけの調整');
    await form.getByRole('button', { name: '変更をプレビュー' }).click(); await form.locator('[name=needConfirmed]').check(); await save(page);
    expect((await snapshotOf(page)).supply.receiptTemplates).toEqual(revised.supply.receiptTemplates);
    form = await previewChange(page, '00582103', 'recalculate');
    await form.locator('[name=needCount]').fill('15'); await form.locator('[name=needReason]').fill('架空の減産');
    await form.getByRole('button', { name: '変更をプレビュー' }).click();
    const difference = form.getByRole('table', { name: '必要明細の差分' });
    await expect(difference.locator('tbody td').nth(3)).toHaveText('15個');
    await expect(form.locator('[name=needApply0]')).not.toBeChecked();
    await expect(difference.locator('tbody td').nth(4)).toContainText('7個');
    await expect(difference.locator('tbody td').nth(6)).toContainText('11個');
    await form.locator('[name=needApply0]').check();
    await expect(difference.locator('tbody td').nth(6)).toContainText('3個');
    await form.locator('[name=needConfirmed]').check(); await save(page);
    const recalculated = await snapshotOf(page);
    expect(recalculated.supply.templateNeeds['00582103']).toMatchObject({ count: 15, version: plan.version, initialVersion: plan.initialVersion });
    expect(recalculated.supply.needs[needId]?.required.value).toBe(15);
    form = await previewChange(page, '00582103', 'follow');
    await form.getByRole('button', { name: '変更をプレビュー' }).click();
    await expect(difference.locator('tbody td').nth(3)).toHaveText('30個');
    await expect(difference.locator('tbody td').nth(4)).toContainText('30個');
    await form.locator('[name=needConfirmed]').check(); await save(page);
    const followed = await snapshotOf(page);
    expect(followed.supply.templateNeeds['00582103']).toMatchObject({ count: 15, initialVersion: plan.initialVersion, generationId: plan.generationId });
    expect(followed.supply.templateNeeds['00582103']?.version).not.toBe(plan.version);
    expect(followed.supply.needs[needId]?.required.value).toBe(30);
    expect(followed.supply.templateNeeds['901076']).toEqual(generated.supply.templateNeeds['901076']);
    expect(Object.values(followed.supply.needs).filter(need => need.project.id === '901076')).toEqual(Object.values(generated.supply.needs).filter(need => need.project.id === '901076'));
    expect(followed.ledger).toEqual(physical.ledger);
    expect(followed.supply.receipts).toEqual(physical.supply.receipts); expect(followed.supply.requests).toEqual(physical.supply.requests);
    expect(followed.supply.declarations).toEqual(physical.supply.declarations);
    form = await previewChange(page, '00582103', 'follow');
    await form.getByRole('button', { name: '変更をプレビュー' }).click(); await expect(form.locator('[data-need-preview]')).toContainText('適用済み');
    expect((await snapshotOf(page)).supply).toEqual(followed.supply);
    await goTo(page, 'supply');
    await expect(group).toContainText(`初回版${plan.initialVersion}`);
    await expect(group).toContainText(followed.supply.templateNeeds['00582103']!.version);
    const book = XLSX.read((await downloadVia(page, exportButton)).bytes, { type: 'array' });
    const sheet = book.Sheets['必要明細'];
    if (!sheet) throw new Error('必要明細シートがない');
    const codeCell = Object.values(sheet).find(cell => typeof cell === 'object' && cell !== null && 'v' in cell && cell.v === '00582103');
    expect(codeCell).toMatchObject({ t: 's', v: '00582103' });
    expect(XLSX.utils.sheet_to_csv(sheet)).toContain(plan.initialVersion);
    expect(XLSX.utils.sheet_to_csv(sheet)).toContain(followed.supply.templateNeeds['00582103']!.version);
    const backup = await downloadVia(page, backupButton);
    await goTo(page, 'stock'); await recorded(page, 'masterRename', { target: 'item:P', name: '架空の一時名', reason: '復元確認' });
    await restore(page, backup.path);
    expect((await snapshotOf(page)).supply).toEqual(followed.supply); expect((await snapshotOf(page)).ledger).toEqual(followed.ledger);
    await context.close(); context = null;
    context = await launchAdvanced(profile, options);
    const restarted = await context.newPage(); await restarted.goto('/'); await waitForApp(restarted);
    expect((await snapshotOf(restarted)).supply).toEqual(followed.supply); expect((await snapshotOf(restarted)).ledger).toEqual(followed.ledger);
    await goTo(restarted, 'stock');
    await recorded(restarted, 'register', { newId: '架空概算', item: 'Q', unit: '個', project: '901076', location: 'S1', basis: 'approximate', value: '20' }, null);
    await goTo(restarted, 'supply');
    const inspectionGroup = restarted.locator('[data-group="901076/Q/個"]');
    await expect(inspectionGroup).toContainText('数量確認が必要'); await expect(inspectionGroup).toContainText('不足0に見えるが確定していない');
    await expect(inspectionGroup).not.toContainText('解消（不足0）');
    await goTo(restarted, 'stock'); await recorded(restarted, 'register', { newId: '架空不明', item: 'Q', unit: '個', project: '901076', location: 'S1', basis: 'unknown' }, null);
    await goTo(restarted, 'supply'); await expect(inspectionGroup).toContainText('判定不能'); await expect(inspectionGroup).not.toContainText('解消（不足0）');
    expect((await snapshotOf(restarted)).supply.needs).toEqual(followed.supply.needs);
  } finally {
    await context?.close();
  }
});

test('FT-16 固定した版12 writerのバックアップを実画面で復元し、現物・必要数・不足・旧履歴を保つ', async ({ page }) => {
  const fixturePath = '../fixtures/template-needs-v12/saved.json';
  const { default: fixture }: { default: { writerRevision: string; snapshotVersion: number; snapshot: string; backup: string; sha256: string } } = await import(fixturePath, { with: { type: 'json' } });
  expect(fixture.writerRevision).toBe('f0043db707869a819085ab0ed0988278437b9251'); expect(fixture.snapshotVersion).toBe(12);
  const expected = parse(fixture.snapshot);
  await registerMasters(page);
  await restore(page, jsonFile('架空旧版バックアップ.json', fixture.backup));
  const restored = await snapshotOf(page);
  expect(restored.ledger).toEqual(expected.ledger); expect(restored.supply).toEqual(expected.supply);
  expect(restored.supply.templateNeeds).toEqual({});
  await goTo(page, 'stock'); await expect(page.locator('#list')).toContainText('架空現物'); await expect(page.locator('#list')).toContainText('18個');
  await goTo(page, 'supply');
  const group = page.locator('[data-group="A-001/P/個"]');
  await expect(group).toContainText('必要な数 20個'); await expect(group).toContainText('不足 2個');
  const history = page.locator('#supply ol[aria-label="供給の記録の履歴"]');
  await expect(history).toContainText('架空組立用'); await expect(history).toContainText('架空部品表');
  const shown = await history.innerText();
  await page.reload(); await waitForApp(page); await goTo(page, 'supply');
  expect(await history.innerText()).toBe(shown);
  expect((await snapshotOf(page)).ledger).toEqual(expected.ledger); expect((await snapshotOf(page)).supply).toEqual(expected.supply);
});
