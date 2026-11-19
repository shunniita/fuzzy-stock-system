import { chromium, expect, test, type Page } from '@playwright/test';
import { browserZoomProfile } from './browser-zoom-profile.mjs';
import { goTo, startEmpty, storageBytes, waitForApp, launchAdvanced } from './helpers.ts';
import { blockStorage, draftOf, gateStorageEvents, snapshotOf } from './conflict-helpers.ts';

const formOf = (page: Page) => page.getByRole('form', { name: '操作の入力' });
const detailOf = (page: Page) => page.locator('[data-set-detail]');
const receiveLabel = 'このセットの部品を受け取る';
type Part = { item: string; unit: string; quantity: string; child?: string };
const pqs: Part[] = [{ item: 'P', unit: '個', quantity: '2' }, { item: 'Q', unit: '個', quantity: '1' }, { item: 'S', unit: '本', quantity: '4' }];

async function createSet(page: Page, name = '架空PQSセット', product = 'R', unit = '台', parts = pqs): Promise<string> {
  await goTo(page, 'sets');
  const register = page.locator('#sets').getByRole('button', { name: 'セットを登録', exact: true });
  page.once('dialog', dialog => dialog.accept());
  await register.click();
  page.removeAllListeners('dialog');
  const form = formOf(page);
  await expect(form.locator('select[name=template]')).toHaveValue('');
  await form.locator('[name=templateName]').fill(name);
  await form.locator('[name=templateProduct]').selectOption(product);
  await form.locator('[name=templateProductUnit]').selectOption(unit);
  for (const [index, part] of parts.entries()) {
    if (index) await form.getByRole('button', { name: '明細を追加', exact: true }).click();
    await form.locator(`[name=t${index}item]`).selectOption(part.item);
    await form.locator(`[name=t${index}unit]`).selectOption(part.unit);
    await form.locator(`[name=t${index}perSet]`).fill(part.quantity);
    await form.locator(`[name=t${index}location]`).selectOption('S1');
    if (part.child) await form.locator(`[name=t${index}source]`).selectOption(part.child);
  }
  await save(page);
  const template = Object.values((await snapshotOf(page)).supply.receiptTemplates).find(template => template.name === name);
  if (!template) throw new Error('登録したセットがない');
  return template.id;
}

async function save(page: Page): Promise<void> {
  await formOf(page).getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
}

async function openSet(page: Page, id: string): Promise<void> {
  await goTo(page, 'sets');
  await page.locator(`[data-set="${id}"]`).click();
}

async function receive(page: Page, id: string): Promise<void> {
  await openSet(page, id);
  await detailOf(page).getByRole('button', { name: receiveLabel, exact: true }).click();
  await expect(formOf(page).locator('input[type=hidden][name=template]')).toHaveValue(id);
  await expect(formOf(page).locator('select[name=template]')).toHaveCount(0);
}

async function otherOperation(page: Page, key: 'templateSave' | 'templateDelete'): Promise<void> {
  const menu = detailOf(page).locator('.other-operations');
  if (!(await menu.evaluate(node => (node as HTMLDetailsElement).open))) await menu.locator('summary').click();
  await menu.locator(`button[data-op=${key}]`).click();
}

async function preview(page: Page): Promise<void> {
  const form = formOf(page);
  await form.locator('[name=project]').selectOption('A-001');
  await form.locator('[name=sets]').fill('10');
  await form.getByRole('button', { name: '予定数を展開', exact: true }).click();
}

test('セットの行き先: 未登録を数量0と区別する', async ({ page }) => {
  await startEmpty(page);
  await goTo(page, 'sets');
  await expect(page.locator('#sets')).toContainText('セットはまだありません');
  await expect(page.locator('#sets').getByRole('button', { name: 'セットを登録', exact: true })).toBeVisible();
});

test('セットから受け取り: 10台のP20/Q10/S40を保存前には適用せず、確認後に同じ所属と根拠で一括記録する', async ({ page }) => {
  await startEmpty(page);
  const id = await createSet(page);
  await openSet(page, id);
  const source = (await snapshotOf(page)).supply.log.findLast(event => event.kind === 'receiptTemplateSave');
  await expect(detailOf(page)).toContainText('表示の数');
  await expect(detailOf(page)).toContainText('1台あたり2個');
  await expect(detailOf(page)).toContainText(source!.eventId);
  await page.screenshot({ path: '.local-logs/ui-improvement/set-desktop-detail.png', fullPage: true });
  const before = await storageBytes(page);
  await receive(page, id); await preview(page);
  const form = formOf(page);
  for (const [index, value] of ['20', '10', '40'].entries()) await expect(form.locator(`[name=actual${index}]`)).toHaveValue(value);
  expect(await storageBytes(page)).toEqual(before);
  await page.screenshot({ path: '.local-logs/ui-improvement/set-desktop-receive.png', fullPage: true });
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('確認してください');
  expect(await storageBytes(page)).toEqual(before);
  await form.locator('[name=templateConfirmed]').check(); await save(page);
  const saved = await snapshotOf(page);
  expect(Object.values(saved.supply.receipts).map(receipt => [receipt.received, receipt.provisional])).toEqual([[20, true], [10, true], [40, true]]);
  expect(Object.values(saved.ledger.lots).map(lot => lot.project)).toEqual(Array(3).fill({ kind: 'case', id: 'A-001' }));
  expect(saved.supply.log.filter(event => event.kind === 'templateReceipt')).toHaveLength(1);
  await goTo(page, 'stock'); await expect(page.locator('#list')).toContainText('20');
  await goTo(page, 'supply'); await expect(page.locator('#supply')).toContainText('架空PQSセット');
});

test('セットの閲覧: 複数セットと品目リンクを絞り、同一対象と切替取消で確認済みDOM・日時・数量を保つ', async ({ page }) => {
  await startEmpty(page);
  const first = await createSet(page), second = await createSet(page, '架空の別セット');
  await receive(page, first); await preview(page);
  const form = formOf(page), original = await form.elementHandle();
  await form.locator('[name=occurredAt]').fill('2026-10-19T10:17');
  await form.locator('[name=templateConfirmed]').check();
  const before = await storageBytes(page);
  await detailOf(page).getByRole('button', { name: receiveLabel, exact: true }).click();
  await openSet(page, second);
  for (const destination of ['stock', 'supply', 'issues', 'management', 'masters'] as const) await goTo(page, destination);
  await page.locator('[name=master-history]').selectOption('item:R');
  await page.locator('#masters').getByRole('button', { name: 'この品目のセット', exact: true }).click();
  await expect(page.locator('[name=set-product]')).toHaveValue('R');
  await expect(page.locator('[data-set]')).toHaveCount(2);
  await page.locator('[name=set-product]').selectOption('P');
  await expect(page.locator('#sets')).toContainText('この製品のセットは未登録');
  await page.locator('[name=set-product]').selectOption('');
  await openSet(page, second);
  page.once('dialog', dialog => dialog.dismiss());
  await detailOf(page).getByRole('button', { name: receiveLabel, exact: true }).click();
  expect(await form.evaluate((node, old) => node === old, original)).toBe(true);
  await expect(form.locator('[name=templateConfirmed]')).toBeChecked();
  await expect(form.locator('[name=template]')).toHaveValue(first);
  await expect(form.locator('[name=occurredAt]')).toHaveValue('2026-10-19T10:17');
  await expect(form.locator('[name=actual0]')).toHaveValue('20');
  expect(await storageBytes(page)).toEqual(before);
  page.once('dialog', dialog => dialog.accept());
  await detailOf(page).getByRole('button', { name: receiveLabel, exact: true }).click();
  await expect(formOf(page).locator('[name=template]')).toHaveValue(second);
  await expect(formOf(page).locator('[name=actual0]')).toHaveCount(0);
  await original?.dispose();
});

test('セットの受け取り: 確認失効、不正数量の拒否と欠品依頼を既存規則で処理する', async ({ page }) => {
  await startEmpty(page); const id = await createSet(page);
  await receive(page, id); await preview(page);
  const form = formOf(page), confirm = form.locator('[name=templateConfirmed]'), before = await storageBytes(page);
  await confirm.check(); await form.locator('[name=actual0]').fill('-1');
  await expect(confirm).not.toBeChecked();
  await confirm.check(); await form.getByRole('button', { name: '記録する', exact: true }).click();
  expect(await storageBytes(page)).toEqual(before);
  await form.locator('[name=actual0]').fill('20'); await confirm.check();
  await form.locator('[name=sets]').fill('2');
  await expect(confirm).not.toBeChecked(); await expect(form.locator('[name=actual0]')).toHaveCount(0);
  await preview(page);
  await form.locator('[name=shortfall1]').fill('3');
  await expect(form.locator('[name=actual1]')).toHaveValue('7');
  await confirm.check(); await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('手配先');
  expect(await storageBytes(page)).toEqual(before);
  await form.locator('[name=vendor]').fill('架空商社'); await confirm.check(); await save(page);
  const saved = await snapshotOf(page);
  expect(Object.values(saved.supply.receipts).map(receipt => receipt.received)).toEqual([20, 7, 40]);
  expect(Object.values(saved.supply.requests)).toMatchObject([{ item: 'Q', quantity: 3, vendor: '架空商社', project: { kind: 'case', id: 'A-001' } }]);
});

test('固定セットの副操作: 必要明細プレビューと作業開始候補が同じ製品・単位・構成を使う', async ({ page }) => {
  await startEmpty(page); const id = await createSet(page);
  await openSet(page, id);
  await detailOf(page).getByRole('button', { name: 'セットから必要明細を生成', exact: true }).click();
  const form = formOf(page);
  await expect(form.locator('[name=needTemplate]')).toHaveValue(id);
  await expect(form.locator('[name=needTemplate]')).toHaveCount(1);
  await form.locator('[name=needCase]').fill('000009'); await form.locator('[name=needCount]').fill('10');
  await form.getByRole('button', { name: '必要明細をプレビュー', exact: true }).click();
  await expect(form.getByRole('table', { name: '生成する必要明細' })).toContainText('20個');
  await form.locator('[name=needConfirmed]').check(); await save(page);
  expect(Object.values((await snapshotOf(page)).supply.needs).map(need => need.required.value)).toEqual([20, 10, 40]);
  await detailOf(page).getByRole('button', { name: 'セットで作業を開始', exact: true }).click();
  await expect(formOf(page).locator('input[type=hidden][name=recipe]')).toHaveValue(id);
  await expect(formOf(page).locator('input[type=hidden][name=item]')).toHaveValue('R');
  await expect(formOf(page).locator('input[type=hidden][name=unit]')).toHaveValue('台');
  await expect(formOf(page).locator('select[name=item], select[name=unit]')).toHaveCount(0);
  await formOf(page).locator('[name=basis]').selectOption('counted');
  await formOf(page).locator('[name=value]').fill('10');
  await formOf(page).getByRole('button', { name: '使用候補を出す', exact: true }).click();
  await expect(formOf(page).locator('[data-estimate-row]')).toHaveCount(3);
  await expect(formOf(page).locator('[name=e0u0value]')).toHaveValue('20');
  await expect(formOf(page).locator('[name=e1u0value]')).toHaveValue('10');
  await expect(formOf(page).locator('[name=e2u0value]')).toHaveValue('40');
});

test('セットの変更・削除: 対象を固定して変更し、新規登録へ戻れ、過去の受け取りを保持する', async ({ page }) => {
  await startEmpty(page); const id = await createSet(page);
  await receive(page, id); await preview(page);
  await formOf(page).locator('[name=templateConfirmed]').check(); await save(page);
  await otherOperation(page, 'templateSave');
  await expect(formOf(page).locator('input[type=hidden][name=template]')).toHaveValue(id);
  await expect(formOf(page).locator('[name=t2perSet]')).toHaveValue('4');
  await formOf(page).locator('[name=templateName]').fill('架空の変更後'); await save(page);
  await expect(detailOf(page)).toContainText('架空の変更後');
  await page.locator('#sets').getByRole('button', { name: 'セットを登録', exact: true }).click();
  await expect(formOf(page).locator('select[name=template]')).toHaveValue('');
  await expect(formOf(page).locator('[name=templateName]')).toHaveValue('');
  await otherOperation(page, 'templateDelete');
  await expect(formOf(page).locator('input[type=hidden][name=template]')).toHaveValue(id);
  await save(page);
  await expect(page.locator('#sets')).toContainText('セットはまだありません');
  const saved = await snapshotOf(page);
  expect(saved.supply.receiptTemplates[id]).toBeUndefined();
  expect(Object.keys(saved.supply.receipts)).toHaveLength(3);
  expect(saved.supply.log.filter(event => event.kind === 'templateReceipt')).toMatchObject([{ template: { name: '架空PQSセット' } }]);
});

test('固定した子構成: 更新後も保存済みの写しを表示し、経路を変えて部品受け取りと確認失効を保つ', async ({ page }) => {
  await startEmpty(page);
  const child = await createSet(page, '架空の子', 'Q', '個', [{ item: 'P', unit: '個', quantity: '2' }]);
  const parent = await createSet(page, '架空の親', 'R', '台', [{ item: 'Q', unit: '個', quantity: '1', child }, { item: 'S', unit: '本', quantity: '4' }]);
  await openSet(page, child); await otherOperation(page, 'templateSave');
  await formOf(page).locator('[name=t0perSet]').fill('9'); await save(page);
  await openSet(page, parent);
  await detailOf(page).getByText('固定した子構成：', { exact: false }).click();
  await expect(detailOf(page).locator('[data-set-child]')).toContainText('あたり2個');
  await expect(detailOf(page).locator('[data-set-child]')).not.toContainText('あたり9個');
  await receive(page, parent);
  const form = formOf(page);
  await expect(form.locator('[name=route0]')).toHaveValue('assembled');
  await preview(page); await expect(form.locator('[name=actual0]')).toHaveValue('10');
  await form.locator('[name=templateConfirmed]').check(); await form.locator('[name=route0]').selectOption('parts');
  await expect(form.locator('[name=templateConfirmed]')).not.toBeChecked();
  await expect(form.locator('[name=actual0]')).toHaveCount(0);
  await form.getByRole('button', { name: '予定数を展開', exact: true }).click();
  await expect(form.locator('[name=actual0]')).toHaveValue('20');
  await expect(form.locator('[name=actual1]')).toHaveValue('40');
  await form.locator('[name=templateConfirmed]').check(); await save(page);
  expect(Object.values((await snapshotOf(page)).supply.receipts).map(receipt => receipt.received)).toEqual([20, 40]);
});

for (const operation of ['templateSave', 'templateDelete'] as const) test(`古い固定セット: 他画面の${operation}で保存を拒否し、対象と未送信数量を退避する`, async ({ page, context }) => {
  await startEmpty(page); const id = await createSet(page);
  const other = await context.newPage();
  await gateStorageEvents(other); await other.goto('/'); await waitForApp(other); await blockStorage(other);
  await receive(other, id); await preview(other);
  await formOf(other).locator('[name=templateConfirmed]').check();
  await openSet(page, id); await otherOperation(page, operation);
  if (operation === 'templateSave') await formOf(page).locator('[name=templateName]').fill('架空の新版');
  await save(page);
  const before = await storageBytes(page);
  await formOf(other).getByRole('button', { name: '記録する', exact: true }).click();
  await expect(other.locator('#conflict')).toContainText('未解消');
  const draft = await draftOf(other);
  expect(draft).toContain(id); expect(draft).toContain('固定した対象'); expect(draft).toContain('20');
  expect(await storageBytes(page)).toEqual(before);
  expect(Object.keys((await snapshotOf(page)).supply.receipts)).toHaveLength(0);
  await other.reload(); await waitForApp(other);
  await expect(other.locator('#conflict')).toContainText(id);
  await goTo(other, 'sets');
  if (operation === 'templateSave') {
    await other.locator(`[data-set="${id}"]`).click();
    await detailOf(other).getByRole('button', { name: receiveLabel, exact: true }).click();
    await expect(formOf(other)).toHaveCount(0);
  } else await expect(other.locator('#sets')).toContainText('セットはまだありません');
});

test('固定セットの保存結果不明: 新入口を止め、再試行は同じ受け取りを一度だけ記録する', async ({ page }) => {
  await startEmpty(page); const id = await createSet(page);
  await page.goto('/?test'); await waitForApp(page); await receive(page, id); await preview(page);
  await formOf(page).locator('[name=templateConfirmed]').check();
  await page.evaluate(() => window.fuzzyStockTest!.loseResponseAt(1));
  await formOf(page).getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#save')).toContainText('保存結果不明');
  await detailOf(page).getByRole('button', { name: 'セットから必要明細を生成', exact: true }).click();
  await expect(formOf(page)).toHaveCount(0);
  await expect(page.locator('#input [data-switch-blocked]')).toContainText('保存中の入力があるため');
  await page.getByRole('button', { name: '再試行する', exact: true }).click();
  await expect(page.locator('#save')).toContainText('保存済みだった');
  const saved = await snapshotOf(page);
  expect(Object.keys(saved.supply.receipts)).toHaveLength(3);
  expect(saved.supply.log.filter(event => event.kind === 'templateReceipt')).toHaveLength(1);
});

for (const width of [1366, 390]) test(`セットの入口: ${width}pxでキーボードから固定フォームへ到達する`, async ({ page }) => {
  await page.setViewportSize({ width, height: 768 }); await startEmpty(page); const id = await createSet(page);
  await page.locator('#nav-sets').focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#nav-sets')).toBeFocused();
  await page.locator(`[data-set="${id}"]`).focus(); await page.keyboard.press('Enter');
  await page.locator(`[data-set="${id}"]`).focus(); await page.keyboard.press('Tab');
  await expect(detailOf(page).getByRole('button', { name: receiveLabel, exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(formOf(page).locator('[name=op]')).toBeFocused();
  await expect(formOf(page).locator('[data-fixed-subject]')).toContainText('架空PQSセット');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: `.local-logs/ui-improvement/set-keyboard-${width}.png`, fullPage: true });
});

test('セットの入口: 実Edgeの200%ページ拡大でも一覧・詳細・固定対象へ到達する', async ({}, testInfo) => {
  const profile = await browserZoomProfile('.local-logs/ui-improvement', 2);
  const context = await launchAdvanced(profile, { channel: 'msedge', headless: true, viewport: null, locale: 'ja-JP', timezoneId: 'Asia/Tokyo', args: ['--window-size=1400,900'] });
  try {
    const page = context.pages()[0]!;
    await page.goto('http://127.0.0.1:4182/'); await startEmpty(page); const id = await createSet(page);
    await openSet(page, id); await detailOf(page).getByRole('button', { name: receiveLabel, exact: true }).click();
    await expect(formOf(page).locator('[data-fixed-subject]')).toContainText('架空PQSセット');
    const measured = await page.evaluate(() => ({ dpr: devicePixelRatio, cssZoom: getComputedStyle(document.body).zoom, fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth }));
    expect(measured).toEqual({ dpr: 2, cssZoom: '1', fits: true });
    await testInfo.attach('set-zoom200', { body: JSON.stringify(measured), contentType: 'application/json' });
    await page.screenshot({ path: '.local-logs/ui-improvement/set-zoom200.png', fullPage: true });
  } finally { await context.close(); }
});
