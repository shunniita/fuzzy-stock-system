import { chromium, expect, test, type Page } from '@playwright/test';
import { browserZoomProfile } from './browser-zoom-profile.mjs';
import { goTo, lot, openMasterKind, recorded, usePractice, waitForApp } from './helpers.ts';
import { snapshotOf } from './conflict-helpers.ts';

// 初めて開いたブラウザーと同じく、モードを選んだことがない状態から始める。
test.use({ storageState: { cookies: [], origins: [] } });

const form = (page: Page) => page.getByRole('form', { name: '操作の入力' });

async function start(page: Page): Promise<void> {
  await page.goto('/');
  await usePractice(page);
}

async function put(page: Page, item: string, value: string): Promise<void> {
  await goTo(page, 'stock');
  await page.locator('#list').getByRole('button', { name: '入れる', exact: true }).click();
  await form(page).locator('select[name=item]').selectOption(item);
  await form(page).locator('select[name=location]').selectOption('S1');
  await form(page).locator('[name=basis]').selectOption('counted');
  await form(page).locator('[name=value]').fill(value);
  await form(page).getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
}

test('簡単操作モード: 初めて開くと簡単操作モードで、二段選択とセット・不足・依頼・製造を出さない', async ({ page }) => {
  await start(page);
  await expect(page.locator('#app')).toHaveAttribute('data-mode', 'simple');
  for (const id of ['nav-sets', 'nav-supply']) await expect(page.locator(`#${id}`)).toBeHidden();
  for (const id of ['nav-stock', 'nav-issues', 'nav-masters', 'nav-management']) await expect(page.locator(`#${id}`)).toBeVisible();
  await expect(page.locator('#production')).toBeHidden();
  await expect(page.locator('#input .operation-picker')).toBeHidden();
  await expect(page.locator('#input [name=op]')).toBeHidden();
});

test('入れる: IDを自動で採番し、共通在庫に固定し、根拠は初期値なしで選ばせる', async ({ page }) => {
  await start(page);
  await page.locator('#list').getByRole('button', { name: '入れる', exact: true }).click();
  await expect(form(page).locator('[name=newId]')).toBeHidden();
  await expect(form(page).locator('[name=stage]')).toBeHidden();
  await expect(form(page).locator('[name=process]')).toBeHidden();
  await expect(form(page).locator('input[type=hidden][name=project]')).toHaveValue('common');
  await expect(form(page).locator('[name=basis]')).toHaveValue('');
  await expect(page.locator('#input')).toContainText('現物の登録');
  await put(page, 'P', '12');
  await put(page, 'P', '3');
  const lots = Object.values((await snapshotOf(page)).ledger.lots);
  expect(lots.map(lot => [lot.id, lot.project, lot.stage.kind])).toEqual([['L-0001', { kind: 'common' }, 'none'], ['L-0002', { kind: 'common' }, 'none']]);
});

test('在庫一覧: 品目の集計から保管単位に絞り込み、詳細から簡単操作モードの操作だけを出す', async ({ page }) => {
  await start(page);
  await put(page, 'P', '12');
  await put(page, 'Q', '5');
  const list = page.locator('#list');
  await expect(list.locator('th', { hasText: '案件・用途' })).toHaveCount(0);
  await expect(list.locator('th', { hasText: '作業の状態' })).toHaveCount(0);
  await list.getByRole('list', { name: '絞り込んだ範囲の集計' }).getByRole('button', { name: /^品目Q/ }).click();
  await expect(list.locator('tr[data-lot="L-0002"]')).toBeVisible();
  await expect(list.locator('tr[data-lot="L-0001"]')).toHaveCount(0);
  await list.locator('tr[data-lot="L-0002"]').getByRole('button', { name: 'L-0002', exact: true }).click();
  const keys = await page.locator('#detail [data-op]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-op')));
  expect(keys.sort()).toEqual(['hold', 'merge', 'move', 'recount', 'release', 'split', 'splitMove', 'use']);
  await page.locator('#detail').getByRole('button', { name: '使用', exact: true }).click();
  await expect(form(page).locator('input[type=hidden][name=lot]')).toHaveValue('L-0002');
  await expect(form(page).locator('[name=basis]')).toBeFocused();
});

test('モードの切替: 管理で高度な操作モードへ移ると二段選択とすべての行き先が戻り、記録と所属は変わらない', async ({ page }) => {
  await start(page);
  await put(page, 'P', '12');
  const before = await snapshotOf(page);
  await goTo(page, 'management');
  await page.getByLabel('操作モード').selectOption('advanced');
  await expect(page.locator('#app')).toHaveAttribute('data-mode', 'advanced');
  await expect(page.locator('#nav-supply')).toBeVisible();
  await goTo(page, 'stock');
  await expect(page.locator('#input [name=op]')).toBeVisible();
  await page.reload(); await waitForApp(page);
  await expect(page.locator('#app')).toHaveAttribute('data-mode', 'advanced');
  await goTo(page, 'management');
  await page.getByLabel('操作モード').selectOption('simple');
  await expect(page.locator('#nav-supply')).toBeHidden();
  const after = await snapshotOf(page);
  expect(after.ledger).toEqual(before.ledger);
  expect(after.supply).toEqual(before.supply);
});

test('登録情報: 簡単操作モードでは品目と場所の登録・名称・利用停止だけを出す', async ({ page }) => {
  await start(page);
  await goTo(page, 'masters');
  const masters = page.locator('#masters');
  await expect(masters.getByRole('button', { name: '品目を登録', exact: true })).toBeVisible();
  for (const name of ['案件・用途を登録', '担当者を登録', '工程を登録', '次工程への置き場を指定']) await expect(masters.getByRole('button', { name, exact: true, includeHidden: true })).toHaveCount(0);
  await masters.locator('tr[data-master="item:P"]').getByRole('button').first().click();
  const keys = await masters.getByRole('group', { name: 'この登録情報にできる操作' }).locator('[data-op]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-op')));
  expect(keys.sort()).toEqual(['masterConsumable', 'masterDeactivate', 'masterPerBox', 'masterRename']);
  await expect(masters.getByRole('button', { name: 'この品目のセット', exact: true })).toHaveCount(0);
  await openMasterKind(page, '場所');
  await expect(masters.getByRole('button', { name: '場所を登録', exact: true })).toBeVisible();
});

test('p2-simple-consumables: 簡単操作モードで補充基準を設定し、在庫と入力で補充確認を見る。高度な操作モードでは不足・依頼に戻る', async ({ page }) => {
  await page.goto('/'); await waitForApp(page);
  await expect(page.locator('#page-stock #consumables')).toBeHidden();
  await usePractice(page);
  await expect(page.locator('#page-stock #consumables')).toBeVisible();
  await put(page, 'P', '12');
  await goTo(page, 'masters');
  const masters = page.locator('#masters');
  await masters.locator('tr[data-master="item:P"]').getByRole('button').first().click();
  await masters.getByRole('group', { name: 'この登録情報にできる操作' }).getByText('その他の操作', { exact: true }).click();
  await masters.locator('[data-op=masterConsumable]').click();
  await form(page).locator('[name=consumableEnabled]').check();
  await form(page).locator('[name=pieceUnit]').selectOption('個');
  await form(page).locator('[name=replenishmentEnabled]').check();
  await form(page).locator('[name=threshold]').fill('20');
  await form(page).locator('[name=standardOrderValue]').fill('10');
  await form(page).locator('[name=standardOrderUnit]').selectOption('個');
  await form(page).locator('[name=reason]').fill('架空の買い置きの目安');
  await form(page).getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
  await goTo(page, 'stock');
  const consumables = page.locator('#page-stock #consumables');
  await expect(consumables).toBeVisible();
  expect(await page.evaluate(() => document.getElementById('list')!.nextElementSibling?.id)).toBe('consumables');
  await expect(consumables.locator('article[data-stock="P"] li.warn')).toContainText('補充基準20個を下回る');
  const before = await snapshotOf(page);
  await goTo(page, 'management');
  await page.getByLabel('操作モード').selectOption('advanced');
  await expect(page.locator('#page-supply #consumables')).toHaveCount(1);
  await expect(page.locator('#page-stock #consumables')).toHaveCount(0);
  const after = await snapshotOf(page);
  expect(after.ledger).toEqual(before.ledger);
  expect(after.supply).toEqual(before.supply);
});

test('p2-box-opening: 簡単操作モードで箱を開け、数えた本数で中身を持ち、1本使うと補充の区画に残りが出る', async ({ page }) => {
  await start(page);
  await page.locator('#list').getByRole('button', { name: '入れる', exact: true }).click();
  await form(page).locator('select[name=item]').selectOption('S');
  await form(page).locator('select[name=unit]').selectOption('箱');
  await form(page).locator('select[name=location]').selectOption('S1');
  await form(page).locator('[name=basis]').selectOption('label');
  await form(page).locator('[name=value]').fill('2');
  await form(page).getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
  await page.locator('#list tr[data-lot="L-0001"]').getByRole('button', { name: 'L-0001', exact: true }).click();
  const detail = page.locator('#detail');
  await detail.getByText('その他の操作', { exact: true }).click();
  await detail.locator('[data-op=openBox]').click();
  await expect(form(page).locator('[name=boxes]')).toHaveValue('1');
  await expect(form(page).locator('[name=childId]')).toHaveValue('L-0002');
  await form(page).getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('開けた中身を数えた数を入力する');
  await form(page).locator('[name=counted]').fill('1000');
  await form(page).getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
  const saved = (await snapshotOf(page)).ledger;
  expect(saved.lots['L-0001']?.quantity).toMatchObject({ numeric: { value: 1 } });
  expect(saved.lots['L-0002']).toMatchObject({ unit: '本', quantity: { numeric: { value: 1000, unconfirmed: 'none' } } });
  await page.locator('#list tr[data-lot="L-0002"]').getByRole('button', { name: 'L-0002', exact: true }).click();
  await expect(detail).toContainText('開封：L-0001から1箱を開けてL-0002へ1000本（数えた）');
  await detail.getByRole('button', { name: '使用', exact: true }).click();
  await form(page).locator('[name=basis]').selectOption('counted');
  await form(page).locator('[name=value]').fill('1');
  await form(page).locator('[name=usedFor]').fill('架空の作業');
  await form(page).getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
  await expect(page.locator('#page-stock #consumables article[data-stock="S"]')).toContainText('開封済み・バラの数量（本）：L-0002 記録上の数999本');
});

for (const width of [1366, 390]) test(`入れる: ${width}pxでキーボードだけで記録し、横にはみ出さない`, async ({ page }) => {
  await page.setViewportSize({ width, height: 768 });
  await start(page);
  await page.locator('#list').getByRole('button', { name: '入れる', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(form(page).locator('select[name=item]')).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('高度な操作モードの記録: 簡単操作モードでも案件・用途を詳細に示し、使っても所属を変えない', async ({ page }) => {
  await start(page);
  await goTo(page, 'management');
  await page.getByLabel('操作モード').selectOption('advanced');
  await goTo(page, 'stock');
  await recorded(page, 'register', lot('case-p', 'P', 'S1', 'counted', '10', { project: 'B-001' }), '08:00');
  await goTo(page, 'management');
  await page.getByLabel('操作モード').selectOption('simple');
  await goTo(page, 'stock');
  await page.locator('#list tr[data-lot="case-p"]').getByRole('button', { name: 'case-p', exact: true }).click();
  await expect(page.locator('#detail')).toContainText('B-001');
  await page.locator('#detail').getByRole('button', { name: '使用', exact: true }).click();
  await form(page).locator('[name=basis]').selectOption('counted');
  await form(page).locator('[name=value]').fill('2');
  await form(page).locator('[name=usedFor]').fill('架空の作業');
  await form(page).getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
  expect((await snapshotOf(page)).ledger.lots['case-p']?.project).toEqual({ kind: 'case', id: 'B-001' });
});

test('入れる: 実Edgeの200%ページ拡大でもキーボードで入力欄に届く', async () => {
  const profile = await browserZoomProfile('.local-logs/ui-simple', 2);
  const context = await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: true, viewport: null, locale: 'ja-JP', timezoneId: 'Asia/Tokyo', args: ['--window-size=1400,900'] });
  try {
    const page = context.pages()[0]!;
    await page.goto('http://127.0.0.1:4182/');
    await start(page);
    await page.locator('#list').getByRole('button', { name: '入れる', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(form(page).locator('select[name=item]')).toBeFocused();
    const measured = await page.evaluate(() => ({ dpr: devicePixelRatio, fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth }));
    expect(measured).toEqual({ dpr: 2, fits: true });
  } finally {
    await context.close();
  }
});

test('モードの切替: 前のモードの絞り込みを残さず、書きかけの入力があるときは切り替えない', async ({ page }) => {
  await start(page);
  await goTo(page, 'management');
  await page.getByLabel('操作モード').selectOption('advanced');
  await goTo(page, 'stock');
  await page.locator('[name=f-project]').selectOption('B-001');
  await goTo(page, 'management');
  await page.getByLabel('操作モード').selectOption('simple');
  await put(page, 'P', '4');
  await expect(page.locator('#list tr[data-lot="L-0001"]')).toBeVisible();
  await page.locator('#list').getByRole('button', { name: '入れる', exact: true }).click();
  await form(page).locator('[name=value]').fill('7');
  await goTo(page, 'management');
  await page.getByLabel('操作モード').selectOption('advanced');
  await expect(page.getByLabel('操作モード')).toHaveValue('simple');
  await expect(page.locator('#app')).toHaveAttribute('data-mode', 'simple');
  await expect(page.locator('#mode-choice')).toContainText('書きかけの入力があります');
  await goTo(page, 'stock');
  await expect(form(page).locator('[name=value]')).toHaveValue('7');
});

for (const mode of ['simple', 'advanced']) for (const op of ['split', 'splitMove']) {
  test('UX必須1・2: ' + mode + 'の' + op + 'はIDを採番し、無編集では確認せず、変更したIDでも記録できる', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-09-29T08:00:00+09:00'));
    await start(page);
    await put(page, 'P', '50');
    await page.clock.setFixedTime(new Date('2026-09-29T09:00:00+09:00'));
    if (mode === 'advanced') {
      await goTo(page, 'management');
      await page.getByLabel('操作モード').selectOption(mode);
    }
    await goTo(page, 'stock');
    await page.locator('#list tr[data-lot="L-0001"]').getByRole('button').click();
    const detail = page.locator('#detail');
    if (op === 'splitMove') await detail.getByText('その他の操作', { exact: true }).click();
    await detail.locator('[data-op=' + op + ']').click();
    const childId = form(page).getByLabel('分けた分の新しいID', { exact: true });
    await expect(childId).toBeVisible();
    await expect(childId).toHaveValue('L-0002');
    const dialogs: string[] = [];
    page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
    await detail.locator('[data-op=move]').click();
    await expect(form(page).locator('[name=op]')).toHaveValue('move');
    expect(dialogs).toEqual([]);
    await detail.locator('[data-op=' + op + ']').click();
    for (const id of ['L-0002', 'custom-child']) {
      await expect(childId).toHaveValue(id === 'L-0002' ? id : 'L-0003');
      if (id === 'custom-child') await childId.fill(id);
      await form(page).locator('[name=basis]').selectOption('counted');
      await form(page).locator('[name=value]').fill('5');
      if (op === 'splitMove') await form(page).locator('[name=location]').selectOption('S2');
      await form(page).getByRole('button', { name: '記録する', exact: true }).click();
      await expect(page.locator('#input > [role=status]')).toContainText('記録した');
      expect((await snapshotOf(page)).ledger.lots[id]).toMatchObject({ id, splitFrom: 'L-0001', location: op === 'splitMove' ? 'S2' : 'S1', quantity: { numeric: { value: 5 } } });
    }
    expect(dialogs).toEqual([]);
  });
}

for (const width of [1366, 390]) test('UX必須5: ' + width + 'pxの一覧に呼び名とコードを表示し、ページ幅を広げない', async ({ page }) => {
  await page.setViewportSize({ width, height: 768 });
  await start(page);
  await put(page, 'P', '50');
  const row = page.locator('#list tr[data-lot="L-0001"]');
  await expect(row.locator('td').nth(1)).toHaveText('架空部品P（P）');
  await expect(row.locator('td').nth(2)).toHaveText('棚S1（S1）');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
