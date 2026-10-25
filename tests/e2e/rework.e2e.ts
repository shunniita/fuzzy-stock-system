import { expect, test, type Page } from '@playwright/test';
import { decodeSnapshot } from '../../src/ui/storageparse.ts';
import { selectOperation, goTo, backupButton, cell, downloadVia, lot, opLabels, pickFile, record, recorded, row, set, startEmpty, storageBytes, waitForApp } from './helpers.ts';

test.use({ trace: 'retain-on-failure' });
const formOf = (page: Page) => page.getByRole('form', { name: '操作の入力' });
async function snapshot(page: Page) {
  const text = await page.evaluate(() => localStorage.getItem(`fuzzy-stock/slot-${localStorage.getItem('fuzzy-stock/head')}`));
  if (text === null) throw Error('保存なし');
  return decodeSnapshot(JSON.parse(text));
}
async function completed(page: Page): Promise<void> {
  await startEmpty(page);
  await recorded(page, 'register', lot('parts', 'P', 'S1', 'counted', '100'), '08:00');
  await recorded(page, 'start', { newId: 'work', item: 'R', project: 'A-001', location: 'T', process: 'R組立', basis: 'counted', value: '20', m1lot: 'parts', m1basis: 'counted', m1value: '20' }, '09:00');
  await recorded(page, 'finish', { lot: 'work', childId: 'inspect', basis: 'counted', value: '20' }, '10:00');
  await recorded(page, 'inspect', { lot: 'inspect', childId: 'finished', basis: 'counted', value: '20' }, '11:00');
}
async function rework(page: Page): Promise<string> {
  await recorded(page, 'reworkBegin', { lot: 'finished', childId: 'repair', basis: 'counted', value: '2', reason: '架空の手直し' });
  const e = (await snapshot(page)).ledger.history.find(e => e.kind === 'rework');
  if (!e) throw Error('やり直し・修理なし');
  return e.eventId;
}

test('AT-16: 完了20から2をやり直し・修理しても現物20・元材料20、再完了累計22', async ({ page }) => {
  await completed(page); const reworkId = await rework(page);
  await goTo(page, 'stock');
  await expect(cell(page, 'finished', '記録上の数と根拠')).toContainText('18台');
  await expect(cell(page, 'repair', '記録上の数と根拠')).toContainText('2台');
  await recorded(page, 'reworkReplace', { reworkId, subjectLotId: 'repair', lot: 'parts', value: '2', reason: '架空交換' }, '12:30');
  await recorded(page, 'finish', { lot: 'repair', childId: 'repair-inspect', basis: 'counted', value: '2' }, '13:00');
  await recorded(page, 'inspect', { lot: 'repair-inspect', childId: 'repaired', basis: 'counted', value: '2' }, '14:00');
  await expect(cell(page, 'parts', '記録上の数と根拠')).toContainText('78個');
  await expect(page.getByRole('list', { name: '工程ごとの数' })).toContainText('工程完了累計 22台');
  await expect(page.getByRole('list', { name: '工程ごとの数' })).toContainText('やり直し・修理開始累計 2台（現在の現物数には足さない）');
  await expect(page.getByRole('list', { name: '工程ごとの数' })).toContainText('完成（渡す前） 記録上の数20台');
  await row(page, 'repaired').getByRole('button', { name: 'repaired', exact: true }).click();
  await expect(page.locator('#detail')).toContainText('作業の開始に使った材料の使用記録');
  await expect(page.locator('#detail')).toContainText('20個');
  await expect(page.locator('#detail')).toContainText('やり直し・修理と部品処置（元の作業の開始材料と別）');
  await expect(page.locator('#detail')).toContainText('架空交換');
  const before = await snapshot(page);
  const backup = await downloadVia(page, backupButton); await pickFile(page, backup.path);
  await page.getByRole('region', { name: '復元の確認' }).getByRole('button', { name: '復元する', exact: true }).click(); await page.getByRole('region', { name: '復元の確認' }).waitFor({ state: 'hidden' });
  await page.reload(); expect((await snapshot(page)).ledger).toEqual(before.ledger);
});

test('R2b/d: 利用停止中の案件・用途の回収と利用停止中の品目の新規廃棄を拒否し、明示再開後にだけ記録する', async ({ page }) => {
  await completed(page); const reworkId = await rework(page);
  await recorded(page, 'masterDeactivate', { target: 'case:A-001', reason: '架空の新規受付停止' }, '12:10');
  const before = await storageBytes(page);
  await expect(await record(page, 'reworkRecover', { reworkId, subjectLotId: 'repair', newId: 'recovered', item: 'P', location: 'S1', value: '1', reason: '実回収' }, '12:20')).toContainText('利用停止中');
  await expect(formOf(page)).toContainText('登録情報の利用再開を確認する');
  expect(await storageBytes(page)).toEqual(before);
  await recorded(page, 'masterReactivate', { target: 'case:A-001', reason: '架空の回収受付再開' }, '12:30');
  await recorded(page, 'reworkRecover', { reworkId, subjectLotId: 'repair', newId: 'recovered', item: 'P', location: 'S1', value: '1', reason: '実回収' }, '12:40');
  await recorded(page, 'masterDeactivate', { target: 'item:P', reason: '架空の部品新規受付停止' }, '13:00');
  await selectOperation(formOf(page).locator('[name=op]'), { label: opLabels.reworkDiscard });
  await expect(formOf(page)).toContainText('利用停止中の品目は新たに指定できない');
  expect(await formOf(page).locator('[name=item] option').evaluateAll(nodes => nodes.map(node => node.getAttribute('value')))).not.toContain('P');
  const stopped = await storageBytes(page);
  await formOf(page).locator('[name=item]').evaluate(node => node.append(new Option('利用停止中の品目P', 'P')));
  for (const [name, value] of Object.entries({ reworkId, subjectLotId: 'repair', item: 'P', unit: '個', value: '1', reason: '実廃棄' })) await set(formOf(page).locator(`[name=${name}]`), value);
  await formOf(page).locator('[name=occurredAt]').fill('2026-09-29T13:10');
  await formOf(page).getByRole('button', { name: '記録する' }).click();
  await expect(page.getByRole('status')).toContainText('利用停止中');
  expect(await storageBytes(page)).toEqual(stopped);
  await recorded(page, 'masterReactivate', { target: 'item:P', reason: '架空の廃棄記録の受付再開' }, '13:20');
  const lots = (await snapshot(page)).ledger.lots;
  await recorded(page, 'reworkDiscard', { reworkId, subjectLotId: 'repair', item: 'P', value: '1', reason: '実廃棄' }, '13:30');
  expect((await snapshot(page)).ledger.lots).toEqual(lots);
});

test('FH-C05: 過大なやり直し・修理と交換を拒否し保存・子・材料を変えない', async ({ page }) => {
  await completed(page); const before = await storageBytes(page);
  await expect(await record(page, 'reworkBegin', { lot: 'finished', childId: 'invalid', basis: 'counted', value: '21', reason: '架空試験' })).not.toContainText('記録した');
  expect(await storageBytes(page)).toEqual(before);
  const reworkId = await rework(page), after = await storageBytes(page);
  await expect(await record(page, 'reworkReplace', { reworkId, subjectLotId: 'repair', lot: 'parts', value: '81', reason: '架空試験' }, '13:00')).not.toContainText('記録した');
  expect(await storageBytes(page)).toEqual(after);
});

test('AT-16・AT-50の境界: やり直し・修理交換の材料使用を通常の取消から単独で戻さず、拒否後も保存と現物を保つ', async ({ page }) => {
  await completed(page); const reworkId = await rework(page);
  await recorded(page, 'reworkReplace', { reworkId, subjectLotId: 'repair', lot: 'parts', value: '2', reason: '架空交換' }, '12:30');
  const before = await snapshot(page), bytes = await storageBytes(page);
  const replacement = before.ledger.history.find(e => e.kind === 'reworkPart' && e.action === 'replace');
  if (replacement?.kind !== 'reworkPart' || replacement.action !== 'replace') throw new Error('交換の対応記録がない');
  await goTo(page, 'stock');
  await expect(cell(page, 'parts', '記録上の数と根拠')).toHaveText('記録上の数78個');
  await expect(await record(page, 'void', { target: replacement.useEventId, reason: '架空の単独取消試行' }, '13:00')).toContainText('やり直し・修理の材料に対応付けてあるので単独では取り消さない');
  expect(await snapshot(page)).toEqual(before);
  expect(await storageBytes(page)).toEqual(bytes);
  await expect(cell(page, 'parts', '記録上の数と根拠')).toHaveText('記録上の数78個');
  await expect(cell(page, 'repair', '記録上の数と根拠')).toHaveText('2台・数えた');
  await page.reload(); await waitForApp(page);
  await expect(cell(page, 'parts', '記録上の数と根拠')).toHaveText('記録上の数78個');
  await expect(cell(page, 'repair', '記録上の数と根拠')).toHaveText('2台・数えた');
  expect(await snapshot(page)).toEqual(before);
  expect(await storageBytes(page)).toEqual(bytes);
});

test('FH-C06/07: 廃棄は未使用品を減らさず、ラベルで実数を変えず回収を確認待ちにする', async ({ page }) => {
  await completed(page); const reworkId = await rework(page);
  await recorded(page, 'reworkDiscard', { reworkId, subjectLotId: 'repair', item: 'P', value: '1', reason: '架空破損' }, '13:00');
  await goTo(page, 'stock');
  await expect(cell(page, 'parts', '記録上の数と根拠')).toContainText('80個');
  const form = formOf(page), panel = page.getByRole('region', { name: 'コード入力補助' });
  await selectOperation(form.locator('[name=op]'), { label: opLabels.reworkRecover });
  for (const [name, value] of Object.entries({ reworkId, subjectLotId: 'repair', newId: 'recovered', item: 'P', location: 'S1', value: '1', reason: '架空回収', occurredAt: '2026-09-29T14:00' })) await set(form.locator(`[name=${name}]`), value);
  await panel.getByLabel('読取原文・品目ID').fill('LABA|A-001|P');
  await panel.getByRole('button', { name: '解釈', exact: true }).click();
  await panel.getByLabel('コードの入力先').selectOption('item');
  await panel.locator('[data-code-options]').getByRole('button', { name: /架空部品P/ }).click();
  await expect(form.locator('[name=value]')).toHaveValue('1');
  await form.getByRole('button', { name: '記録する' }).click();
  await expect(page.getByRole('status')).toContainText('この対象で続ける');
  await panel.getByRole('button', { name: 'この対象で続ける' }).click();
  await form.getByRole('button', { name: '記録する' }).click();
  await expect(page.getByRole('status')).toContainText('記録した');
  await goTo(page, 'stock');
  await expect(cell(page, 'recovered', '記録上の数と根拠')).toContainText('1個・数えた');
  await expect(cell(page, 'recovered', '取り分けた理由')).toContainText('使用可否確認待ち');
  await expect(cell(page, 'parts', '記録上の数と根拠')).toContainText('80個');
  expect((await snapshot(page)).ledger.history.at(-1)?.scan?.raw).toBe('LABA|A-001|P');
});

test('FH-C08: 回収保存の応答喪失後、再読込と再試行で回収を二重に作らない', async ({ page }) => {
  await completed(page); const reworkId = await rework(page);
  await page.goto('/?test');
  await waitForApp(page);
  await page.evaluate(() => window.fuzzyStockTest!.loseResponseAt(1));
  await record(page, 'reworkRecover', { reworkId, subjectLotId: 'repair', newId: 'recovered', item: 'P', location: 'S1', value: '2', reason: '架空回収' }, '13:00');
  await expect(page.locator('#save')).toContainText('保存結果不明');
  await page.reload();
  await page.getByRole('button', { name: '再試行する', exact: true }).click();
  await expect(page.locator('#save')).toContainText('保存済み');
  const l = (await snapshot(page)).ledger;
  expect(l.history.filter(e => e.kind === 'reworkPart' && e.action === 'recover')).toHaveLength(1);
  expect(l.lots['recovered']?.quantity).toMatchObject({ numeric: { value: 2 } });
  expect(l.lots['recovered']?.holds).toEqual(['usabilityCheck']);
});

// 選択肢にない枝は、画面を迂回した入力として選択肢を足して送り、domain の拒否と保存不変を確かめる。
async function rejected(page: Page, values: Record<string, string>, at: string | null, message: string): Promise<void> {
  const form = formOf(page), before = await storageBytes(page);
  await selectOperation(form.locator('[name=op]'), { label: opLabels.reworkDiscard });
  await form.locator('[name=subjectLotId]').evaluate((node, id) => { if (![...node.querySelectorAll('option')].some(o => o.value === id)) node.append(new Option(id, id)); }, values.subjectLotId!);
  for (const [name, value] of Object.entries({ item: 'P', value: '1', reason: '架空廃棄', ...values })) await set(form.locator(`[name=${name}]`), value);
  if (at === null) await form.locator('[name=occurredUnknown]').check();
  else await form.locator('[name=occurredAt]').fill(`2026-09-29T${at}`);
  await form.getByRole('button', { name: '記録する' }).click();
  await expect(page.getByRole('status')).toContainText(message);
  expect(await storageBytes(page)).toEqual(before);
}

test('ADR-039の3: 処置した枝を選び、部分完了の残り・後入力は記録し、再完了後・再やり直し・修理の枝・日時不明は拒否', async ({ page }) => {
  await completed(page); const reworkId = await rework(page);
  const discard = (subjectLotId: string, at: string) => recorded(page, 'reworkDiscard', { reworkId, subjectLotId, item: 'P', value: '1', reason: '架空廃棄' }, at);
  await selectOperation(formOf(page).locator('[name=op]'), { label: opLabels.reworkDiscard });
  const options = () => formOf(page).locator('[name=subjectLotId] option').evaluateAll(nodes => nodes.map(node => node.getAttribute('value')));
  expect(await options()).toContain('repair');
  expect(await options()).not.toContain('finished');
  await expect(formOf(page)).toContainText('再完了した物への新しい作業は、やり直し・修理開始から別のやり直し・修理として記録する');
  await recorded(page, 'split', { lot: 'repair', childId: 'piece', basis: 'counted', value: '1' }, '12:10');
  await recorded(page, 'merge', { lot: 'piece', target: 'repair' }, '12:20');
  await discard('repair', '12:30');
  await recorded(page, 'finish', { lot: 'repair', childId: 'r-insp', basis: 'counted', value: '1' }, '13:00');
  await discard('repair', '13:10');
  await recorded(page, 'inspect', { lot: 'r-insp', childId: 'redone', basis: 'counted', value: '1' }, '13:20');
  await rejected(page, { reworkId, subjectLotId: 'redone' }, '13:30', '別のやり直し・修理');
  await recorded(page, 'finish', { lot: 'repair', childId: 'r-insp2', basis: 'counted', value: '1' }, '14:00');
  await discard('repair', '13:50');
  await rejected(page, { reworkId, subjectLotId: 'repair' }, '14:30', '空になった後');
  await rejected(page, { reworkId, subjectLotId: 'r-insp2' }, null, '実際の日時');
  await recorded(page, 'reworkBegin', { lot: 'redone', childId: 'again', basis: 'counted', value: '1', reason: '架空の再手直し' }, '14:10');
  await rejected(page, { reworkId, subjectLotId: 'again' }, '14:20', '確かめられない');
  const parts = (await snapshot(page)).ledger.history.filter(e => e.kind === 'reworkPart');
  expect(parts.map(e => e.kind === 'reworkPart' ? [e.subjectLotId, e.occurredAt] : null)).toEqual([['repair', '2026-09-29T12:30:00+09:00'], ['repair', '2026-09-29T13:10:00+09:00'], ['repair', '2026-09-29T13:50:00+09:00']]);
  await goTo(page, 'stock');
  await row(page, 'repair').getByRole('button', { name: 'repair', exact: true }).click();
  await expect(page.locator('#detail')).toContainText('対象枝repair');
});
