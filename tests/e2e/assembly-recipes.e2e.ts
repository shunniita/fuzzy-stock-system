import { expect, test, type Page } from '@playwright/test';
import { waitForPersistence, goTo, recorded, selectOperation, startEmpty, storageBytes, waitForApp } from './helpers.ts';
import { draftOf, snapshotOf } from './conflict-helpers.ts';

const formOf = (page: Page) => page.getByRole('form', { name: '操作の入力' });
async function choose(page: Page, op: string) {
  await goTo(page, 'stock');
  await selectOperation(formOf(page).locator('[name=op]'), op);
  return formOf(page);
}
async function submit(page: Page) {
  await formOf(page).getByRole('button', { name: '記録する', exact: true }).click();
  await waitForPersistence(page);
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
}
async function row(page: Page, i: number, item: string, unit: string, quantity: string) {
  const form = formOf(page);
  if (i > 0) await form.getByRole('button', { name: '明細を追加', exact: true }).click();
  await form.locator(`[name=t${i}item]`).selectOption(item);
  await form.locator(`[name=t${i}unit]`).selectOption(unit);
  await form.locator(`[name=t${i}perSet]`).fill(quantity);
  await form.locator(`[name=t${i}location]`).selectOption('S1');
}
async function setup(page: Page) {
  await startEmpty(page);
  await recorded(page, 'masterItem', { codeNone: true, name: '架空組立X', units: '台' }, '08:00');
  const x = Object.values((await snapshotOf(page)).ledger.masters.items).find(i => i.name === '架空組立X')!.id;
  let form = await choose(page, 'templateSave');
  await form.locator('[name=templateName]').fill('架空Xの構成');
  await form.locator('[name=templateProduct]').selectOption(x);
  await expect(form.locator('[name=templateProductUnit]')).toHaveValue('');
  await form.locator('[name=templateProductUnit]').selectOption('台');
  await row(page, 0, 'Q', '個', '3'); await row(page, 1, 'S', '本', '1'); await submit(page);
  const child = Object.values((await snapshotOf(page)).supply.receiptTemplates).find(t => t.name === '架空Xの構成')!;
  form = await choose(page, 'templateSave');
  await form.locator('[name=templateName]').fill('架空親の構成');
  await form.locator('[name=templateProduct]').selectOption('R');
  await form.locator('[name=templateProductUnit]').selectOption('台');
  await row(page, 0, 'P', '個', '2'); await row(page, 1, x, '台', '1');
  await expect(form.locator('[data-template-row]').nth(1)).toContainText('台の最小単位1');
  await form.locator('[name=t1source]').selectOption(child.id);
  await expect(form.locator('[data-template-row]').nth(1)).toContainText('組立品の数量は正の整数');
  await form.locator('[name=t1source]').selectOption('');
  await expect(form.locator('[data-template-row]').nth(1)).not.toContainText('組立品の数量は正の整数');
  await expect(form.getByRole('button', { name: '明細2の現在の構成を取り込む', exact: true })).toBeHidden();
  await form.locator('[name=t1source]').selectOption(child.id);
  const pinned = await form.locator('[name=t1assembly]').inputValue();
  await submit(page);
  const parent = Object.values((await snapshotOf(page)).supply.receiptTemplates).find(t => t.name === '架空親の構成')!;
  expect(parent.rows[1]?.assembly).toEqual(child);
  return { x, child, parent, pinned };
}
async function receive(page: Page, parent: string) {
  const form = await choose(page, 'templateReceive');
  await form.locator('[name=template]').selectOption(parent);
  await form.locator('[name=project]').selectOption('A-001');
  await form.locator('[name=sets]').fill('10');
  return form;
}

test('組立UI: コード未登録の子を固定し、完成品と自作分の実対象だけを受け入れる', async ({ page }) => {
  const { parent, x } = await setup(page);
  let form = await receive(page, parent.id);
  await expect(form.locator('[name=route1]')).toHaveValue('assembled');
  const bytes = await storageBytes(page);
  const details = form.locator('[data-assembly-reference]').first();
  await details.locator('summary').focus(); await page.keyboard.press('Enter');
  await expect(details).toHaveAttribute('open', '');
  expect(await storageBytes(page)).toEqual(bytes);
  await form.getByRole('button', { name: '予定数を展開' }).click();
  await expect(form.locator('[name^=actual]')).toHaveCount(2);
  await expect(form.locator('[name=actual1]')).toHaveValue('10');
  await form.locator('[name=templateConfirmed]').check();
  await form.locator('[name=route1]').selectOption('parts');
  await expect(form.locator('[name^=actual]')).toHaveCount(0);
  await expect(form.locator('[name=templateConfirmed]')).not.toBeChecked();
  await form.getByRole('button', { name: '予定数を展開' }).click();
  await expect(form.locator('[name^=actual]')).toHaveCount(3);
  await expect(form.getByLabel('明細2-1の今回受け取った数', { exact: true })).toHaveValue('30');
  await expect(form.getByLabel('明細2-2の不足数（欠品リスト）', { exact: true })).toHaveValue('0');
  for (const [i, value] of ['20', '30', '10'].entries()) await expect(form.locator(`[name=actual${i}]`)).toHaveValue(value);
  await form.locator('[name=templateConfirmed]').check(); await submit(page);
  let snapshot = await snapshotOf(page);
  expect(Object.entries(snapshot.supply.receipts).map(([id, r]) => [snapshot.ledger.lots[id]!.item, r.received])).toEqual([['P', 20], ['Q', 30], ['S', 10]]);
  form = await receive(page, parent.id); await form.getByRole('button', { name: '予定数を展開' }).click();
  await form.locator('[name=templateConfirmed]').check(); await submit(page);
  snapshot = await snapshotOf(page);
  expect(Object.entries(snapshot.supply.receipts).slice(-2).map(([id, r]) => [snapshot.ledger.lots[id]!.item, r.received])).toEqual([['P', 20], [x, 10]]);
});

test('組立UI: 子の改訂は明示取込みのみ、削除後も固定構成を保持して受け入れる', async ({ page }) => {
  const { child, parent } = await setup(page);
  let form = await choose(page, 'templateSave'); await form.locator('[name=template]').selectOption(child.id);
  await form.locator('[name=t0perSet]').fill('7'); await submit(page);
  form = await choose(page, 'templateSave'); await form.locator('[name=template]').selectOption(parent.id);
  expect(JSON.parse(await form.locator('[name=t1assembly]').inputValue())).toEqual(child);
  await form.getByRole('button', { name: '明細2の現在の構成を取り込む', exact: true }).click();
  await expect(form.locator('[data-template-row]').nth(1)).toContainText('組立品の数量は正の整数');
  expect(JSON.parse(await form.locator('[name=t1assembly]').inputValue()).rows[0].perSet).toBe(7);
  await form.locator('[name=templateName]').fill('架空親・子削除後');
  await submit(page);
  form = await choose(page, 'templateDelete'); await form.locator('[name=template]').selectOption(child.id); await submit(page);
  form = await choose(page, 'templateSave'); await form.locator('[name=template]').selectOption(parent.id);
  await expect(form.getByRole('button', { name: '明細2の現在の構成を取り込む', exact: true })).toBeDisabled();
  expect(JSON.parse(await form.locator('[name=t1assembly]').inputValue()).rows[0].perSet).toBe(7);
  await form.locator('[name=templateName]').fill('架空親・子削除後も保持');
  await submit(page);
  form = await receive(page, parent.id); await form.locator('[name=route1]').selectOption('parts');
  await form.getByRole('button', { name: '予定数を展開' }).click(); await expect(form.locator('[name=actual1]')).toHaveValue('70');
});

test('組立UI: 320pxのキーボード・行再番号・画面移動でも元の固定構成を保つ', async ({ page }) => {
  const { parent, pinned } = await setup(page);
  await page.setViewportSize({ width: 320, height: 740 });
  const form = await choose(page, 'templateSave'); await form.locator('[name=template]').selectOption(parent.id);
  await form.getByRole('button', { name: '明細1を削除', exact: true }).click();
  await expect(form.locator('[name=t0assembly]')).toHaveValue(pinned);
  const add = form.getByRole('button', { name: '明細を追加', exact: true }); await add.focus(); await page.keyboard.press('Enter');
  await expect(form.locator('[name=t1item]')).toBeFocused();
  await expect(form.locator('[name=t0assembly]')).toHaveValue(pinned);
  const details = form.locator('[data-assembly-reference]').first(); await details.locator('summary').focus(); await page.keyboard.press('Space');
  await expect(details).toHaveAttribute('open', '');
  await goTo(page, 'supply'); await goTo(page, 'stock'); await expect(form.locator('[name=t0assembly]')).toHaveValue(pinned);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.local-logs/assembly-20261024/assembly-ui-320px.png', fullPage: true });
});

test('組立UI: 外部で子が改訂されても競合退避と再読込は元の固定コピーを証拠として残す', async ({ page, context }) => {
  const { child, parent, pinned } = await setup(page);
  const other = await context.newPage(); await other.goto('/'); await waitForApp(other);
  const form = await choose(other, 'templateSave'); await form.locator('[name=template]').selectOption(parent.id);
  await form.locator('[name=templateName]').fill('未保存の架空親');
  const edit = await choose(page, 'templateSave'); await edit.locator('[name=template]').selectOption(child.id);
  await edit.locator('[name=t0perSet]').fill('7'); await submit(page);
  await expect(other.locator('#conflict')).toContainText('未解消');
  const original = await draftOf(other);
  expect(original).toContain(JSON.stringify(pinned).slice(1, -1));
  await other.reload(); await waitForApp(other);
  expect(await draftOf(other)).toEqual(original);
  expect((await snapshotOf(other)).supply.receiptTemplates[parent.id]!.rows[1]!.assembly).toEqual(child);
  await expect(other.locator('#conflict')).toContainText('固定した子構成');
});

test('組立UI: 子部品の欠品は実対象への依頼になり、後日の現物割り当てで二重計上しない', async ({ page }) => {
  const { parent } = await setup(page);
  const form = await receive(page, parent.id); await form.locator('[name=route1]').selectOption('parts');
  await form.getByRole('button', { name: '予定数を展開' }).click();
  await form.locator('[name=shortfall1]').fill('3'); await expect(form.locator('[name=actual1]')).toHaveValue('27');
  await form.locator('[name=templateConfirmed]').check();
  const before = await storageBytes(page); await form.getByRole('button', { name: '記録する', exact: true }).click();
  await waitForPersistence(page);
  await expect(page.locator('#input > [role=status]')).toContainText('手配先'); expect(await storageBytes(page)).toEqual(before);
  await form.locator('[name=vendor]').fill('架空商社'); await form.locator('[name=templateConfirmed]').check(); await submit(page);
  const snapshot = await snapshotOf(page), request = Object.values(snapshot.supply.requests)[0]!;
  expect(request).toMatchObject({ item: 'Q', quantity: 3, unit: '個', project: { kind: 'case', id: 'A-001' } });
  expect(Object.values(snapshot.supply.receipts).map(r => r.received)).toEqual([20, 27, 10]);
  await recorded(page, 'receive', { newId: 'later', item: 'Q', unit: '個', project: 'A-001', location: 'S1', basis: 'counted', value: '3', r1request: request.id, r1arrived: '3', r1good: '3' }, null);
  const arrived = await snapshotOf(page);
  expect(arrived.supply.requests[request.id]!.arrivals).toMatchObject([{ receiptLotId: 'later', arrived: 3, good: 3 }]);
  expect(Object.values(arrived.supply.receipts).map(r => r.received)).toEqual([20, 27, 10, 3]);
});

test('組立UI: 経路・案件・用途・製作数量は展開と確認を失効させ、参照開閉では失効しない', async ({ page }) => {
  const { parent } = await setup(page), form = await receive(page, parent.id);
  await form.getByRole('button', { name: '予定数を展開' }).click(); await form.locator('[name=templateConfirmed]').check();
  const signature = await form.locator('[name=templateRevision]').inputValue();
  await form.locator('[data-assembly-reference] summary').click();
  await expect(form.locator('[name=templateRevision]')).toHaveValue(signature); await expect(form.locator('[name=templateConfirmed]')).toBeChecked();
  for (const [name, value] of [['project', 'common'], ['sets', '5'], ['route1', 'parts']] as const) {
    if (name === 'sets') await form.locator(`[name=${name}]`).fill(value); else await form.locator(`[name=${name}]`).selectOption(value);
    await expect(form.locator('[name=actual0]')).toHaveCount(0); await expect(form.locator('[name=templateConfirmed]')).not.toBeChecked();
    await form.getByRole('button', { name: '予定数を展開' }).click(); await form.locator('[name=templateConfirmed]').check();
  }
  await expect(form.locator('[name=actual1]')).toHaveValue('15');
});
