import { expect, test, type Page } from '@playwright/test';
import { decodeSnapshot } from '../../src/ui/storageparse.ts';
import { waitForPersistence, selectOperation, goTo, backupButton, cell, downloadVia, lot, opLabels, pickFile, recorded, set, startEmpty, storageBytes } from './helpers.ts';

test.use({ trace: 'retain-on-failure' });
const formOf = (page: Page) => page.getByRole('form', { name: '操作の入力' });
const panelOf = (page: Page) => page.getByRole('region', { name: 'コード入力補助' });
async function selectOp(page: Page, op: keyof typeof opLabels): Promise<void> { await selectOperation(formOf(page).locator('[name=op]'), op); }
async function fill(page: Page, values: Record<string, string | boolean>): Promise<void> {
  for (const [name, value] of Object.entries(values)) await set(formOf(page).locator(`[name=${name}]`), value);
}
async function interpret(page: Page, raw: string): Promise<void> {
  await panelOf(page).getByLabel('読取原文・品目ID').fill(raw);
  await panelOf(page).getByRole('button', { name: '解釈', exact: true }).click();
}
async function apply(page: Page, target: string, name: RegExp): Promise<void> {
  await panelOf(page).getByLabel('コードの入力先').selectOption(target);
  await panelOf(page).locator('[data-code-options]').getByRole('button', { name }).click();
}
async function save(page: Page): Promise<void> {
  await panelOf(page).getByRole('button', { name: 'この対象で続ける' }).click();
  await formOf(page).getByRole('button', { name: '記録する' }).click();
  await waitForPersistence(page);
}
async function snapshot(page: Page) {
  const text = await page.evaluate(() => localStorage.getItem(`fuzzy-stock/slot-${localStorage.getItem('fuzzy-stock/head')}`));
  if (text === null) throw Error('保存なし');
  return decodeSnapshot(JSON.parse(text));
}

test('AT-30/46: Enterは解釈だけ、案件・用途相違を選び直し、ラベル数量は空欄から確認する', async ({ page }) => {
  await startEmpty(page);
  const before = await storageBytes(page);
  await fill(page, { project: 'A-001', location: 'S1', basis: 'counted', value: '999' });
  await panelOf(page).getByRole('button', { name: '現在の案件・用途を保持' }).click();
  await panelOf(page).getByLabel('読取原文・品目ID').fill('LABA|B-001|P');
  await panelOf(page).getByLabel('読取原文・品目ID').press('Enter');
  expect(await storageBytes(page)).toEqual(before);
  await expect(formOf(page).locator('[name=project]')).toHaveValue('A-001');
  await expect(panelOf(page)).toContainText('案件・用途が異なります');
  await apply(page, 'item', /架空部品P/);
  await expect(formOf(page).locator('[name=value]')).toHaveValue('');
  await expect(formOf(page).locator('[name=basis]')).toHaveValue('label');
  await expect(panelOf(page)).toContainText('中身未確認');
  await apply(page, 'project', /B-001/);
  await fill(page, { newId: 'scanned', value: '5' });
  await formOf(page).getByRole('button', { name: '記録する' }).click();
  await waitForPersistence(page);
  await expect(page.getByRole('status')).toContainText('この対象で続ける');
  await save(page);
  await expect(cell(page, 'scanned', '案件・用途')).toContainText('B-001');
  await expect(cell(page, 'scanned', '記録上の数と根拠')).toContainText('5個・表示の数（ラベル・パッケージ）');
  expect((await snapshot(page)).ledger.history[0]?.scan?.raw).toBe('LABA|B-001|P');
  await expect(panelOf(page).getByLabel('読取原文・品目ID')).toHaveValue('');
  await expect(formOf(page).locator('[name=project]')).toHaveValue('A-001');
});

test('FH-C02/03/04・AT-23: CRLF貼付と同じラベルの別箱、保持、バックアップ復元、次操作への非流用', async ({ page }) => {
  await startEmpty(page); await selectOp(page, 'receive');
  await fill(page, { project: 'A-001', location: 'S1' });
  await panelOf(page).getByRole('button', { name: '現在の案件・用途を保持' }).click();
  await panelOf(page).getByRole('button', { name: '現在の場所を保持' }).click();
  const raw = ' LABA|A-001|P\t\r\n';
  for (const id of ['box1', 'box2']) {
    await panelOf(page).getByLabel('読取原文・品目ID').evaluate((element, text) => {
      const data = new DataTransfer(); data.setData('text/plain', text);
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, raw);
    await panelOf(page).getByRole('button', { name: '解釈', exact: true }).click();
    await apply(page, 'item', /架空部品P/);
    await fill(page, { newId: id, value: '5' }); await save(page);
    await expect(page.getByRole('status')).toContainText('記録した');
  }
  const state = await snapshot(page);
  expect(state.ledger.history.map(e => e.scan?.raw)).toEqual([raw, raw]);
  expect(state.supply.receipts['box1']?.label).toBe(raw);
  expect(state.supply.receipts['box2']?.label).toBe(raw);
  await goTo(page, 'issues');
  await expect(page.locator('#history')).toContainText(JSON.stringify(raw));
  await goTo(page, 'stock');
  await recorded(page, 'move', { lot: 'box1', location: 'S2' });
  expect((await snapshot(page)).ledger.history.at(-1)?.scan).toBeUndefined();
  await expect(panelOf(page).locator('[data-code-holds]')).toContainText('S1');
  const backup = await downloadVia(page, backupButton);
  await pickFile(page, backup.path);
  await page.getByRole('region', { name: '復元の確認' }).getByRole('button', { name: '復元する', exact: true }).click();
  await goTo(page, 'stock');
  await expect(panelOf(page).locator('[data-code-holds]')).toContainText('保持中の案件・用途：未設定');
  expect((await snapshot(page)).ledger.history[0]?.scan?.raw).toBe(raw);
  await page.reload(); await selectOp(page, 'receive');
  await expect(formOf(page).locator('[name=project]')).toHaveValue('');
  await expect(formOf(page).locator('[name=location]')).toHaveValue('');
});

test('AT-46: 帳票は案内のみ、採用済みラベルを解除し現物記録を作らない', async ({ page }) => {
  await startEmpty(page);
  await interpret(page, 'LABA|A-001|P'); await apply(page, 'item', /架空部品P/);
  const before = await storageBytes(page);
  await interpret(page, 'DOC:SRC_01:R_00:LINE-007');
  await expect(panelOf(page)).toContainText('元の資料SRC_01・改訂R_00・明細LINE-007');
  await expect(panelOf(page)).toContainText('後続の範囲');
  await expect(panelOf(page).getByRole('button', { name: 'この対象で続ける' })).toBeHidden();
  await panelOf(page).getByLabel('名称・品番・コードで検索').fill('P');
  await panelOf(page).getByRole('button', { name: '検索', exact: true }).click();
  await expect(panelOf(page).locator('[data-code-options]').getByRole('button')).toHaveCount(0);
  expect(await storageBytes(page)).toEqual(before);
  await fill(page, { newId: 'manual', project: 'A-001', location: 'S1', basis: 'counted', value: '3' });
  await formOf(page).getByRole('button', { name: '記録する' }).click();
  await waitForPersistence(page);
  expect((await snapshot(page)).ledger.history.at(-1)?.scan).toBeUndefined();
});

test('AT-30/46: 読取不能から名称検索・既存欄・同じ欄へのID手入力、先頭ゼロと記号', async ({ page }) => {
  await startEmpty(page);
  await goTo(page, 'stock');
  for (const code of ['007', '7', 'P_Q-02']) await recorded(page, 'masterItem', { code, name: `架空品${code}`, units: '個' });
  await selectOp(page, 'register');
  await interpret(page, '<script>alert(1)</script>');
  await panelOf(page).getByLabel('コードの入力先').selectOption('item');
  await panelOf(page).getByLabel('名称・品番・コードで検索').fill('架空品007');
  await panelOf(page).getByRole('button', { name: '検索', exact: true }).click();
  await panelOf(page).locator('[data-code-options]').getByRole('button', { name: /架空品007/ }).click();
  await fill(page, { newId: 'failed-raw', project: 'A-001', location: 'S1', basis: 'counted', value: '2' });
  await save(page);
  expect((await snapshot(page)).ledger.history.at(-1)?.scan?.format).toBe('unreadable');
  await interpret(page, 'BAD?');
  await formOf(page).locator('[name=item]').selectOption({ label: '架空品7（7）' });
  await fill(page, { newId: 'selected', project: 'A-001', location: 'S1', basis: 'counted', value: '1' }); await save(page);
  expect((await snapshot(page)).ledger.history.at(-1)?.scan?.raw).toBe('BAD?');
  await interpret(page, 'LABA||007'); await interpret(page, 'P_Q-02');
  await apply(page, 'item', /架空品P_Q-02/);
  await fill(page, { newId: 'manual-id', project: 'A-001', location: 'S1', basis: 'counted', value: '0' }); await save(page);
  expect((await snapshot(page)).ledger.history.at(-1)?.scan?.raw).toBe('P_Q-02');
  await expect(cell(page, 'failed-raw', '品目')).toContainText('007');
  await expect(cell(page, 'selected', '品目')).toHaveText('7');
});

test('AT-46: 未登録・中断の候補を適用せず検索へ進み、二つの保管単位を自動確定しない', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('one', 'P', 'S1', 'counted', '5'));
  await recorded(page, 'register', lot('two', 'P', 'S1', 'counted', '5'));
  await recorded(page, 'masterDeactivate', { target: 'item:Q', reason: '架空の停止' });
  await selectOp(page, 'use');
  await interpret(page, 'LABA|A-001|MISSING');
  await expect(panelOf(page)).toContainText('未登録');
  await panelOf(page).getByLabel('コードの入力先').selectOption('lot');
  await expect(panelOf(page).locator('[data-code-options]').getByRole('button')).toHaveCount(0);
  await interpret(page, 'Q'); await expect(panelOf(page)).toContainText('利用停止中');
  await expect(panelOf(page).locator('[data-code-options]').getByRole('button')).toHaveCount(0);
  await interpret(page, 'P~A-001~LABB');
  await expect(panelOf(page).locator('[data-code-options]').getByRole('button')).toHaveCount(2);
  await expect(formOf(page).locator('[name=lot]')).toHaveValue('');
  await apply(page, 'lot', /^two/);
  await fill(page, { value: '1', usedFor: '架空作業' }); await save(page);
  await expect(cell(page, 'one', '記録上の数と根拠')).toContainText('5個');
  await expect(cell(page, 'two', '記録上の数と根拠')).toContainText('4個');
  expect((await snapshot(page)).ledger.history.at(-1)?.scan?.format).toBe('labelB');
});

test('AT-46: 材料のラベルはその行だけに作用し、数え直しは数えたを維持する', async ({ page }) => {
  await startEmpty(page); await recorded(page, 'register', lot('material', 'P', 'S1', 'counted', '20'));
  await selectOp(page, 'start');
  await fill(page, { value: '9', basis: 'counted', m1value: '3', m1basis: 'counted', m2value: '4', m2basis: 'counted' });
  await interpret(page, 'LABA|A-001|P'); await apply(page, 'm1lot', /^material/);
  await expect(formOf(page).locator('[name=m1value]')).toHaveValue('');
  await expect(formOf(page).locator('[name=m1basis]')).toHaveValue('label');
  await expect(formOf(page).locator('[name=value]')).toHaveValue('9');
  await expect(formOf(page).locator('[name=m2value]')).toHaveValue('4');
  await fill(page, { item: 'R' });
  await expect(formOf(page).locator('[name=value]')).toHaveValue('9');
  await expect(formOf(page).locator('[name=basis]')).toHaveValue('counted');
  await selectOp(page, 'recount'); await fill(page, { value: '19' });
  await interpret(page, 'LABA|A-001|P'); await apply(page, 'lot', /^material/);
  await expect(formOf(page).locator('[name=value]')).toHaveValue('19');
  await save(page);
  await expect(cell(page, 'material', '記録上の数と根拠')).toContainText('19個・数えた');
});

test('AT-46・要件6.3: 手入力ラベルと読取原文の競合を黙って捨てず、訂正後に保存する', async ({ page }) => {
  await startEmpty(page); await selectOp(page, 'receive');
  await interpret(page, 'LABA|A-001|P'); await apply(page, 'item', /架空部品P/);
  await fill(page, { newId: 'conflict-label', project: 'A-001', location: 'S1', value: '5', label: '手書きの別原文' });
  const before = await storageBytes(page);
  await save(page);
  await expect(page.getByRole('status')).toContainText('手入力ラベル');
  expect(await storageBytes(page)).toEqual(before);
  await fill(page, { label: '' }); await save(page);
  await expect(page.getByRole('status')).toContainText('記録した');
  expect((await snapshot(page)).supply.receipts['conflict-label']?.label).toBe('LABA|A-001|P');
});

test('AT-46: 予備の一部交換で入力した実数をラベル採用後も保つ', async ({ page }) => {
  await startEmpty(page); await recorded(page, 'register', lot('spare', 'P', 'S1', 'counted', '5'));
  await recorded(page, 'hold', { lot: 'spare', reason: 'spare' });
  await selectOp(page, 'spareSwap'); await fill(page, { value: '1', childId: 'swapped', note: '架空の破損交換' });
  await interpret(page, 'LABA|A-001|P'); await apply(page, 'lot', /^spare/);
  await expect(formOf(page).locator('[name=value]')).toHaveValue('1'); await save(page);
  await expect(cell(page, 'spare', '記録上の数と根拠')).toContainText('4個');
  await expect(cell(page, 'swapped', '記録上の数と根拠')).toContainText('1個・数えた');
});

test('FH-C02: 共通・所属不明の保持、解除、操作切替と初期化での寿命', async ({ page }) => {
  await startEmpty(page);
  for (const [project, shown] of [['common', '共通在庫'], ['unassigned', '案件・用途が不明']] as const) {
    await selectOp(page, 'register'); await fill(page, { project });
    await panelOf(page).getByRole('button', { name: '現在の案件・用途を保持' }).click();
    await selectOp(page, 'receive'); await expect(formOf(page).locator('[name=project]')).toHaveValue(project);
    await expect(panelOf(page).locator('[data-code-holds]')).toContainText(shown);
    await expect(panelOf(page).locator('[data-code-holds]')).toContainText('再読込・復元・初期化で保持は消えます');
  }
  await panelOf(page).getByRole('button', { name: '案件・用途の保持を解除' }).click();
  await selectOp(page, 'register'); await expect(formOf(page).locator('[name=project]')).toHaveValue('');
  await fill(page, { project: 'A-001', location: 'S1' });
  await panelOf(page).getByRole('button', { name: '現在の案件・用途を保持' }).click();
  await selectOp(page, 'transfer'); await expect(formOf(page).locator('[name=toProject]')).toHaveValue('');
  await goTo(page, 'management');
  await page.getByRole('button', { name: '練習用の台帳で初期化' }).click();
  await page.getByRole('button', { name: '初期化する', exact: true }).click();
  await goTo(page, 'stock');
  await selectOp(page, 'register'); await expect(formOf(page).locator('[name=project]')).toHaveValue('');
  await selectOp(page, 'masterRename'); await expect(panelOf(page)).toBeHidden();
});

test('AT-46: 仮の記録の登録はコード確認の後も通常の重複確認を要求する', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('existing', 'P', 'S1', 'counted', '5'));
  await recorded(page, 'provisional', { direction: 'found', item: 'P', location: 'S1', basis: 'counted', value: '2', note: '架空の別箱' });
  await selectOp(page, 'adopt'); await interpret(page, 'LABA|A-001|P'); await apply(page, 'item', /架空部品P/);
  await fill(page, { issue: 'op2', newId: 'new-box', project: 'A-001', location: 'S1' });
  const before = await storageBytes(page);
  await save(page);
  await expect(page.getByRole('status')).toContainText('確認が必要');
  expect(await storageBytes(page)).toEqual(before);
  await formOf(page).locator('[name=confirmed]').check(); await save(page);
  await expect(page.getByRole('status')).toContainText('記録した');
  await expect(cell(page, 'existing', '記録上の数と根拠')).toContainText('5個');
  await expect(cell(page, 'new-box', '記録上の数と根拠')).toContainText('2個・数えた');
  expect((await snapshot(page)).ledger.history.at(-1)?.scan?.raw).toBe('LABA|A-001|P');
});

test('FH-C04: 保存結果不明後の再読込・照会・再試行で証拠を保ち、二重受け取りしない', async ({ page }) => {
  await startEmpty(page); await page.goto('/?test'); await selectOp(page, 'receive');
  await interpret(page, 'P~A-001~LABB'); await apply(page, 'item', /架空部品P/);
  await fill(page, { newId: 'retry-box', project: 'A-001', location: 'S1', value: '5' });
  await page.evaluate(() => { if (!window.fuzzyStockTest) throw Error('試験フックなし'); window.fuzzyStockTest.loseResponseAt(1); });
  await save(page); await expect(page.locator('#save')).toContainText('保存結果不明');
  await expect(formOf(page)).toHaveCount(0);
  await page.reload(); await page.getByRole('button', { name: '照会する', exact: true }).click();
  await page.getByRole('button', { name: '再試行する', exact: true }).click();
  const state = await snapshot(page);
  expect(state.ledger.history).toHaveLength(1);
  expect(state.ledger.history[0]?.scan?.raw).toBe('P~A-001~LABB');
  expect(state.supply.receipts['retry-box']?.label).toBe('P~A-001~LABB');
  await expect(cell(page, 'retry-box', '記録上の数と根拠')).toContainText('5個');
});

test('AT-30・FH-C02: 案件・用途名・場所名で検索し、保持と最終対象にも名称と品番・コードを併記する', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'masterRename', { target: 'case:A-001', name: '架空の青案件・用途', reason: '表示試験' });
  await recorded(page, 'masterRename', { target: 'location:S1', name: '架空の青棚', reason: '表示試験' });
  await selectOp(page, 'register');
  await interpret(page, 'BAD?');
  await panelOf(page).getByLabel('コードの入力先').selectOption('project');
  await panelOf(page).getByLabel('名称・品番・コードで検索').fill('架空の青案件・用途');
  await panelOf(page).getByRole('button', { name: '検索', exact: true }).click();
  await panelOf(page).locator('[data-code-options]').getByRole('button', { name: /架空の青案件・用途.*A-001/ }).click();
  await panelOf(page).getByRole('button', { name: '現在の案件・用途を保持' }).click();
  await panelOf(page).getByLabel('コードの入力先').selectOption('location');
  await panelOf(page).getByLabel('名称・品番・コードで検索').fill('架空の青棚');
  await panelOf(page).getByRole('button', { name: '検索', exact: true }).click();
  await panelOf(page).locator('[data-code-options]').getByRole('button', { name: /架空の青棚.*S1/ }).click();
  await panelOf(page).getByRole('button', { name: '現在の場所を保持' }).click();
  for (const text of ['架空の青案件・用途', 'A-001', '架空の青棚', 'S1']) {
    await expect(panelOf(page).locator('[data-code-holds]')).toContainText(text);
    await expect(panelOf(page).locator('[data-code-final]')).toContainText(text);
  }
});
