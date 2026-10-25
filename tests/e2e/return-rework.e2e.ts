import { expect, test, type Locator, type Page } from '@playwright/test';
import { backupButton, cell, downloadVia, goTo, lot, pickFile, record, recorded, selectOperation, startEmpty, storageBytes, waitForApp } from './helpers.ts';
import { snapshotOf } from './conflict-helpers.ts';

const formOf = (page: Page) => page.getByRole('form', { name: '操作の入力' });
const status = (page: Page) => page.locator('#input > [role=status]');

async function tabTo(page: Page, control: Locator): Promise<void> {
  for (let i = 0; i < 80; i++) {
    if (await control.evaluate(node => node === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw Error(`Tabで入力先に届かない: ${await control.evaluate(node => node.outerHTML)}`);
}
async function keyboardChoose(page: Page, control: Locator, value: string): Promise<void> {
  const values = await control.locator('option').evaluateAll(nodes => nodes.map(node => node.getAttribute('value')));
  const index = values.indexOf(value);
  expect(index).toBeGreaterThanOrEqual(0);
  await tabTo(page, control);
  await page.keyboard.press('Alt+ArrowDown');
  await page.keyboard.press('Home');
  for (let i = 0; i < index; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(control).toHaveValue(value);
}
async function keyboardText(page: Page, control: Locator, value: string): Promise<void> {
  await tabTo(page, control);
  await page.keyboard.press('Control+A');
  await page.keyboard.type(value);
}
async function intake(page: Page) {
  await recorded(page, 'returnRecord', { item: 'R', location: 'T', basis: 'counted', value: '2', returnOrigin: 'finished', note: '架空の戻り' }, '12:00');
  await selectOperation(formOf(page).locator('[name=op]'), 'returnAssign');
  const issue = await formOf(page).locator('[name=issue] option').nth(1).getAttribute('value');
  if (!issue) throw Error('仮の記録なし');
  await record(page, 'returnAssign', { issue, returnInclusion: 'notIncluded', newId: 'returned', item: 'R', unit: '台', project: 'A-001', location: 'T', reason: '出庫分の戻りを確認' }, '13:00');
  await expect(status(page)).toContainText('確認が必要');
  await formOf(page).locator('[name=confirmed]').check();
  await formOf(page).getByRole('button', { name: '記録する', exact: true }).click();
  await expect(status(page)).toContainText('記録した');
}
async function begin(page: Page, childId: string, process: string, criterion: string, value = '2') {
  await record(page, 'returnRework', { lot: 'returned', childId, process, criterion, basis: 'counted', value, reason: '新しい物理作業' }, '14:00');
  await expect(status(page)).toContainText('物理的なやり直し・修理');
  await formOf(page).locator('[name=confirmedPhysical]').check();
  await formOf(page).getByRole('button', { name: '記録する', exact: true }).click();
  await expect(status(page)).toContainText('記録した');
}

test('MFG-02/FH-RRS-01: 既存工程の完了基準を返ってきた物のやり直し・修理で変えず、作業終了後は確認待ちにする', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'start', { newId: 'normal', item: 'R', project: 'A-001', location: 'T', process: 'R組立', basis: 'label', value: '3' }, '10:00');
  await intake(page);
  const before = await storageBytes(page);
  await record(page, 'returnRework', { lot: 'returned', childId: 'repair', process: ' R組立 ', criterion: 'workEnd', basis: 'counted', value: '2', reason: '架空の物理作業' }, '14:00');
  await formOf(page).locator('[name=confirmedPhysical]').check();
  await formOf(page).getByRole('button', { name: '記録する', exact: true }).click();
  await expect(status(page)).toContainText('完了基準');
  expect(await storageBytes(page)).toEqual(before);
  await begin(page, 'repair', ' R組立 ', 'inspection');
  await recorded(page, 'finish', { lot: 'repair', childId: 'inspection', basis: 'counted', value: '2' }, '15:00');
  const after = await snapshotOf(page);
  expect(after.ledger.lots['normal']?.stage).toMatchObject({ kind: 'working', process: { id: 'R組立', criterion: 'inspection' } });
  expect(after.ledger.lots['inspection']?.stage).toMatchObject({ kind: 'inspecting', process: { id: 'R組立', criterion: 'inspection' } });
  expect(Object.values(after.ledger.lots).filter(l => l.stage.kind === 'awaitingHandover')).toHaveLength(0);
});

test('MFG-06/FH-RRS-01: 次工程Nの返ってきた物は保存せず移動を案内し、移動後に開始できる', async ({ page }) => {
  await startEmpty(page); await intake(page);
  await recorded(page, 'move', { lot: 'returned', location: 'N' }, '13:30');
  const before = await storageBytes(page);
  await record(page, 'returnRework', { lot: 'returned', childId: 'repair', process: 'R組立', criterion: 'inspection', basis: 'counted', value: '2', reason: '架空の物理作業' }, '14:00');
  await formOf(page).locator('[name=confirmedPhysical]').check();
  await formOf(page).getByRole('button', { name: '記録する', exact: true }).click();
  await expect(status(page)).toContainText('次工程N');
  await expect(status(page)).toContainText('移動してから');
  expect(await storageBytes(page)).toEqual(before);
  await recorded(page, 'move', { lot: 'returned', location: 'T' }, '14:30');
  await record(page, 'returnRework', { lot: 'returned', childId: 'repair', process: 'R組立', criterion: 'inspection', basis: 'counted', value: '2', reason: '架空の物理作業' }, '15:00');
  await formOf(page).locator('[name=confirmedPhysical]').check();
  await formOf(page).getByRole('button', { name: '記録する', exact: true }).click();
  await expect(status(page)).toContainText('記録した');
  expect((await snapshotOf(page)).ledger.lots['repair']).toMatchObject({ location: 'T', stage: { kind: 'working' } });
});

test('ADR-041/FH-RRS-05: 返ってきた物のやり直し・修理をTabとキーボードだけで選択・確認・保存する', async ({ page }) => {
  await startEmpty(page); await intake(page);
  const before = await snapshotOf(page);
  const form = formOf(page);
  // 受付済みのfixtureから先は、クリック・focus・selectOption・fillを使わない。
  await keyboardChoose(page, page.getByLabel('作業の種類', { exact: true }), 'rework');
  await keyboardChoose(page, form.locator('[name=op]'), 'returnRework');
  await keyboardChoose(page, form.locator('[name=lot]'), 'returned');
  await keyboardText(page, form.locator('[name=process]'), 'キーボード工程');
  await keyboardChoose(page, form.locator('[name=criterion]'), 'inspection');
  await keyboardText(page, form.locator('[name=childId]'), 'repair-keyboard');
  await keyboardChoose(page, form.locator('[name=basis]'), 'counted');
  await keyboardText(page, form.locator('[name=value]'), '2');
  await keyboardText(page, form.locator('[name=reason]'), '架空のキーボード手直し');
  await tabTo(page, form.locator('[name=confirmedPhysical]'));
  await page.keyboard.press('Space');
  await expect(form.locator('[name=confirmedPhysical]')).toBeChecked();
  await tabTo(page, form.getByRole('button', { name: '記録する', exact: true }));
  await page.keyboard.press('Enter');
  await expect(status(page)).toContainText('記録した');
  await expect(cell(page, 'repair-keyboard', '記録上の数と根拠')).toHaveText('2台・数えた');
  await expect(cell(page, 'repair-keyboard', '作業の状態')).toContainText('作業中');
  await expect(cell(page, 'repair-keyboard', '取り分けた理由')).toContainText('使用可否確認待ち');
  const after = await snapshotOf(page);
  expect(after.supply).toEqual(before.supply);
  expect(after.ledger.history.slice(0, before.ledger.history.length)).toEqual(before.ledger.history);
  expect(after.ledger.history).toHaveLength(before.ledger.history.length + 1);
  const created = after.ledger.history.at(-1);
  if (created?.kind !== 'rework') throw Error('やり直し・修理開始ではない');
  expect(created.returnSource?.confirmedPhysical).toBe(true);
  expect(created.returnSource?.process).toEqual({ id: 'キーボード工程', criterion: 'inspection' });
  expect(created).toMatchObject({ lotId: 'returned', childId: 'repair-keyboard', reason: '架空のキーボード手直し', basis: 'counted', value: 2 });
  await page.reload(); await waitForApp(page);
  expect((await snapshotOf(page)).ledger).toEqual(after.ledger);
});

test('FH-RRS-02/03/04: 出庫後の戻り2台を検査再完了し、20台・元材料・取り分けた理由を保つ', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('parts', 'P', 'S1', 'counted', '100'), '08:00');
  await recorded(page, 'start', { newId: 'work', item: 'R', project: 'A-001', location: 'T', process: 'R組立', basis: 'counted', value: '20', m1lot: 'parts', m1basis: 'counted', m1value: '20' }, '09:00');
  await recorded(page, 'finish', { lot: 'work', childId: 'inspection', basis: 'counted', value: '20' }, '10:00');
  await recorded(page, 'inspect', { lot: 'inspection', childId: 'finished', basis: 'counted', value: '20' }, '11:00');
  await recorded(page, 'handover', { lot: 'finished', basis: 'counted', value: '2', counterpart: '外' }, '11:30');
  await intake(page);
  const before = await snapshotOf(page), oldUses = before.ledger.history.filter(e => e.kind === 'use');
  await begin(page, 'repair', '戻り工程', 'inspection');
  await expect(cell(page, 'finished', '記録上の数と根拠')).toContainText('18台');
  await expect(cell(page, 'repair', '作業の状態')).toContainText('作業中');
  await expect(cell(page, 'repair', '取り分けた理由')).toContainText('使用可否確認待ち');
  await recorded(page, 'finish', { lot: 'repair', childId: 'repair-inspect', basis: 'counted', value: '2' }, '15:00');
  await expect(cell(page, 'repair-inspect', '作業の状態')).toContainText('確認待ち');
  await recorded(page, 'inspect', { lot: 'repair-inspect', childId: 'ready', basis: 'counted', value: '2' }, '16:00');
  await expect(cell(page, 'ready', '記録上の数と根拠')).toContainText('2台');
  await expect(cell(page, 'parts', '記録上の数と根拠')).toContainText('80個');
  const after = await snapshotOf(page);
  expect(after.ledger.history.filter(e => e.kind === 'use')).toEqual(oldUses);
  expect(after.ledger.lots['ready']?.holds).toContain('usabilityCheck');
  const groups = page.getByRole('list', { name: '工程ごとの数' });
  await expect(groups).toContainText('工程戻り工程');
  await expect(groups).toContainText('やり直し・修理開始累計 2台');
  await page.locator('#list tr[data-lot=ready]').getByRole('button', { name: 'ready', exact: true }).click();
  await expect(page.locator('#detail')).toContainText('新規割当の記録');
  await expect(page.locator('#detail')).toContainText('物理的なやり直し・修理を確認');
  const backup = await downloadVia(page, backupButton); await pickFile(page, backup.path);
  await page.getByRole('region', { name: '復元の確認' }).getByRole('button', { name: '復元する', exact: true }).click(); await page.getByRole('region', { name: '復元の確認' }).waitFor({ state: 'hidden' });
  await page.reload(); await waitForApp(page);
  expect((await snapshotOf(page)).ledger).toEqual(after.ledger);
});

test('FH-RRS-01/03: 未確認・確認失効・過量・取消は保存せず、二工程の部分開始を分離する', async ({ page }) => {
  await startEmpty(page); await intake(page);
  const before = await storageBytes(page);
  await record(page, 'returnRework', { lot: 'returned', childId: 'repair', process: '作業終了工程', criterion: 'workEnd', basis: 'counted', value: '1', reason: '物理作業' }, '14:00');
  await expect(status(page)).toContainText('物理的なやり直し・修理');
  expect(await storageBytes(page)).toEqual(before);
  await formOf(page).locator('[name=confirmedPhysical]').check();
  await formOf(page).locator('[name=reason]').fill('変更した理由');
  await expect(formOf(page).locator('[name=confirmedPhysical]')).not.toBeChecked();
  await selectOperation(formOf(page).locator('[name=op]'), 'returnRecord');
  expect(await storageBytes(page)).toEqual(before);
  await record(page, 'returnRework', { lot: 'returned', childId: 'bad', process: '作業終了工程', criterion: 'workEnd', basis: 'counted', value: '3', reason: '過量' }, '14:00');
  await formOf(page).locator('[name=confirmedPhysical]').check();
  await formOf(page).getByRole('button', { name: '記録する', exact: true }).click();
  await expect(status(page)).toContainText('負になる');
  expect(await storageBytes(page)).toEqual(before);
  await begin(page, 'repair', '作業終了工程', 'workEnd', '1');
  await begin(page, 'second', '別検査工程', 'inspection', '1');
  await recorded(page, 'finish', { lot: 'repair', childId: 'ready', basis: 'counted', value: '1' }, '15:00');
  await expect(cell(page, 'ready', '作業の状態')).toContainText('完成（渡す前）');
  await goTo(page, 'stock');
  const groups = page.getByRole('list', { name: '工程ごとの数' });
  for (const name of ['作業終了工程', '別検査工程']) await expect(groups.getByRole('listitem').filter({ hasText: `工程${name}` })).toContainText('やり直し・修理開始累計 1台');
  await page.reload(); await waitForApp(page);
  const after = await snapshotOf(page);
  expect(after.ledger.lots['returned']?.quantity).toMatchObject({ numeric: { value: 0 } });
  expect(after.ledger.lots['bad']).toBeUndefined();
});
