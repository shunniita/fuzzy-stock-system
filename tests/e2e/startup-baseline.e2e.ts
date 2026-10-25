import { expect, test, type Page } from '@playwright/test';
import { isUsable, totalOf } from '../../src/domain/ledger.ts';
import { decodeSnapshot } from '../../src/ui/storageparse.ts';
import { selectOperation, goTo, backupButton, cell, downloadVia, lot, opLabels, pickFile, record, recorded, row, startEmpty, storageBytes } from './helpers.ts';

test.use({ trace: 'retain-on-failure' });
const formOf = (page: Page) => page.getByRole('form', { name: '操作の入力' });
const issueRow = (page: Page, id: string) => page.locator(`#issues tr[data-issue="${id}"]`);
async function snapshot(page: Page) {
  const text = await page.evaluate(() => localStorage.getItem(`fuzzy-stock/slot-${localStorage.getItem('fuzzy-stock/head')}`));
  if (!text) throw Error('保存した写しが必要');
  return decodeSnapshot(JSON.parse(text));
}
async function unknownBox(page: Page, note: string, location = '', at: string | null = '08:30') {
  await recorded(page, 'provisional', { direction: 'found', item: '', location, basis: 'unknown', value: '', note }, at);
  const event = (await snapshot(page)).ledger.history.at(-1);
  if (event?.kind !== 'provisional') throw Error('仮の記録が必要');
  return event;
}

test('AT-26: 過去履歴なしの仕掛品と未特定箱で開始し、既知数量に箱を加えず再読込する', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('work', 'R', 'T', 'counted', '4', { stage: 'working', process: 'R組立' }), '08:00');
  await recorded(page, 'register', lot('unused', 'P', 'S1', 'counted', '7'), '08:00');
  const before = await snapshot(page);
  expect(before.ledger.lots.work).toMatchObject({ item: 'R', unit: '台', location: 'T', project: { kind: 'case', id: 'A-001' }, stage: { kind: 'working', process: { id: 'R組立', criterion: 'inspection' } }, quantity: { terms: [{ observation: { basis: 'counted', value: 4 } }] } });
  const box = await unknownBox(page, '架空の品目不明箱 0012-AB', 'T');
  const after = await snapshot(page);
  expect(after.ledger.lots).toEqual(before.ledger.lots);
  expect(after.ledger.history.map(event => event.kind)).toEqual(['register', 'register', 'provisional']);
  expect(after.supply.receipts).toEqual({});
  expect(totalOf(after.ledger, 'P', isUsable)).toMatchObject({ kind: 'known', numeric: { value: 7 } });
  expect(totalOf(after.ledger, 'R', isUsable)).toMatchObject({ kind: 'known', numeric: { value: 0 } });
  expect(box).toMatchObject({ item: null, location: 'T', basis: 'unknown', value: null, actor: '架空担当A', occurredAt: '2026-09-29T08:30:00+09:00' });
  expect(after.ledger.issues[box.eventId]).toMatchObject({ lotId: null, reason: 'unassigned', resolution: null });
  await goTo(page, 'issues');
  await expect(issueRow(page, box.eventId)).toContainText('架空の品目不明箱 0012-AB');
  await expect(issueRow(page, box.eventId)).toContainText('適用対象不明（仮の記録）');
  await goTo(page, 'stock');
  await expect(row(page, 'work')).toContainText('作業中');
  await page.reload();
  await expect(row(page, 'work')).toContainText('4台');
  await goTo(page, 'issues');
  await expect(issueRow(page, box.eventId)).toContainText('数が不明');
  expect((await snapshot(page)).ledger).toEqual(after.ledger);
});

test('AT-49: 各初期状態から一部特定・別品目受け取り・他案件・用途継続・復元まで、既知と未特定と対象外を分ける', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('unused', 'P', 'S1', 'counted', '7'), '08:00');
  await recorded(page, 'register', lot('work', 'R', 'T', 'counted', '4', { stage: 'working', process: 'R組立' }), '08:00');
  await recorded(page, 'register', lot('done', 'R', 'T', 'unknown', '', { stage: 'awaitingHandover', process: 'R組立' }), '08:00');
  await recorded(page, 'register', lot('defective', 'P', 'S2', 'counted', '1'), '08:00');
  await recorded(page, 'hold', { lot: 'defective', reason: 'defective' }, '08:10');
  await recorded(page, 'register', lot('return', 'P', 'S2', 'label', '2'), '08:00');
  await recorded(page, 'hold', { lot: 'return', reason: 'returnPending' }, '08:10');
  await recorded(page, 'register', lot('approximate', 'P', 'S1', 'approximate', '3'), '08:00');
  await recorded(page, 'register', lot('outside-item', 'X', 'S1', 'counted', '1'), '08:00');
  await recorded(page, 'register', lot('outside-place', 'P', 'O', 'counted', '1'), '08:00');
  await recorded(page, 'requestRecord', { project: 'A-001', item: 'Q', quantity: '6', vendor: '架空の開始時点未着', requestedOn: '2026-09-28', replyKind: 'none' }, '08:00');
  const initial = await snapshot(page);
  for (const [id, item, location, stage, basis, value] of [
    ['unused', 'P', 'S1', 'none', 'counted', 7], ['work', 'R', 'T', 'working', 'counted', 4],
    ['done', 'R', 'T', 'awaitingHandover', 'unknown', null], ['defective', 'P', 'S2', 'none', 'counted', 1],
    ['return', 'P', 'S2', 'none', 'label', 2], ['approximate', 'P', 'S1', 'none', 'approximate', 3],
  ] as const) {
    const position = stage === 'none' ? { kind: 'none' } : { kind: stage, process: { id: 'R組立', criterion: 'inspection' } };
    const expected = { id, item, unit: item === 'R' ? '台' : '個', location, project: { kind: 'case', id: 'A-001' }, stage: position,
      quantity: { terms: [{ sign: 1, observation: { basis, value } }] } };
    expect(initial.ledger.lots[id]).toMatchObject(expected);
    const registration = initial.ledger.history.find(event => event.kind === 'register' && event.changes[0]?.after.id === id);
    expect(registration).toMatchObject({ actor: '架空担当A', occurredAt: '2026-09-29T08:00:00+09:00', changes: [{ before: null, after: expected }] });
  }
  expect(initial.ledger.history.every(event => event.kind === 'register' || event.kind === 'hold')).toBe(true);
  expect(initial.supply.receipts).toEqual({});
  expect(Object.values(initial.ledger.lots).some(value => value.item === 'Q')).toBe(false);
  await goTo(page, 'stock');
  await expect(row(page, 'work')).toContainText('作業中');
  await expect(row(page, 'done')).toContainText('完成（渡す前）');
  await expect(row(page, 'done')).toContainText('数が不明');
  await expect(row(page, 'defective')).toContainText('不良');
  await expect(row(page, 'return')).toContainText('返却待ち');
  await expect(row(page, 'return')).toContainText('2個・表示の数（ラベル・パッケージ）・中身未確認');
  await expect(row(page, 'approximate')).toContainText('約3個');
  await expect(row(page, 'outside-item')).toBeVisible();
  await expect(row(page, 'outside-place')).toBeVisible();
  await expect(row(page, 'unused')).toBeVisible();
  await goTo(page, 'supply');
  await page.locator('[name=case-project]').selectOption('A-001');
  await expect(page.locator('#case article[data-item="Q"]')).toContainText('未着6個');

  const same = await unknownBox(page, '架空箱A：同じ箱か照合する', 'S1');
  const separate = await unknownBox(page, '架空箱B：中身はまだ数えていない', 'S2', null);
  const unresolved = await unknownBox(page, '架空箱C：品目と場所が不明');
  const boxes = await snapshot(page);
  expect(boxes.ledger.lots).toEqual(initial.ledger.lots);
  expect(totalOf(boxes.ledger, 'P', isUsable)).toEqual(totalOf(initial.ledger, 'P', isUsable));
  expect(unresolved).toMatchObject({ item: null, location: null, basis: 'unknown', value: null });
  await goTo(page, 'issues');
  for (const box of [same, separate, unresolved]) await expect(issueRow(page, box.eventId)).toContainText('適用対象不明（仮の記録）');
  await recorded(page, 'identify', { issue: same.eventId, lot: 'unused', reason: '架空の現物表示で同じ箱と確認' }, '09:00');
  const identified = await snapshot(page);
  expect(identified.ledger.lots).toEqual(initial.ledger.lots);
  expect(identified.ledger.history.at(-1)).toMatchObject({ kind: 'identify', issueId: same.eventId, lotId: 'unused', reason: '架空の現物表示で同じ箱と確認' });
  expect(identified.ledger.issues[same.eventId]?.resolution).toMatchObject({ outcome: 'close', actor: '架空担当A' });

  const beforeAdopt = await storageBytes(page);
  await expect(await record(page, 'adopt', { issue: separate.eventId, newId: 'new-unknown', item: 'P', project: 'A-001', location: 'S2' }, '09:10')).toContainText('確認が必要');
  await expect(page.getByRole('status')).toContainText('unused');
  expect(await storageBytes(page)).toEqual(beforeAdopt);
  await formOf(page).locator('[name=confirmed]').check();
  await formOf(page).getByRole('button', { name: '記録する' }).click();
  await expect(page.getByRole('status')).toContainText('記録した');
  const adopted = await snapshot(page);
  expect(adopted.ledger.lots['new-unknown']).toMatchObject({ item: 'P', location: 'S2', project: { kind: 'case', id: 'A-001' }, quantity: { kind: 'unknown' } });
  expect(adopted.ledger.history.at(-1)).toMatchObject({ kind: 'adopt', issueId: separate.eventId, lotId: 'new-unknown', occurredAt: null });
  expect(adopted.ledger.issues[separate.eventId]?.resolution).toMatchObject({ outcome: 'apply', actor: '架空担当A' });
  expect(adopted.ledger.issues[unresolved.eventId]?.resolution).toBeNull();
  await selectOperation(formOf(page).locator('[name=op]'), { label: opLabels.adopt });
  expect(await formOf(page).locator('[name=issue] option').evaluateAll(nodes => nodes.map(node => node.getAttribute('value')))).not.toContain(separate.eventId);
  expect(adopted.ledger.history.filter(event => event.kind === 'adopt' && event.issueId === separate.eventId)).toHaveLength(1);
  await goTo(page, 'stock');
  await expect(row(page, 'new-unknown')).toContainText('数が不明');
  await goTo(page, 'issues');
  await expect(issueRow(page, unresolved.eventId)).toContainText('確認が必要（未解決）');

  await recorded(page, 'register', lot('other-case', 'P', 'S1', 'counted', '5', { project: 'A-002' }), '10:00');
  await recorded(page, 'use', { lot: 'other-case', basis: 'counted', value: '2', usedFor: '架空の別案件作業' }, '10:10');
  await goTo(page, 'stock');
  await expect(row(page, 'other-case')).toContainText('3個');
  const beforeReceive = await snapshot(page);
  for (const [id, value] of Object.entries(adopted.ledger.lots)) expect(beforeReceive.ledger.lots[id]).toEqual(value);
  expect(beforeReceive.ledger.lots['other-case']).toMatchObject({ project: { kind: 'case', id: 'A-002' }, quantity: { kind: 'known', numeric: { value: 3 } } });
  expect(beforeReceive.ledger.history.at(-1)).toMatchObject({ kind: 'use', lotId: 'other-case', value: 2, usedFor: '架空の別案件作業', applied: true });
  await goTo(page, 'stock');
  await expect(cell(page, 'other-case', '案件・用途')).toContainText('A-002');
  await recorded(page, 'receive', lot('unexpected', 'P', 'S2', 'counted', '2'), '10:20');
  const received = await snapshot(page);
  expect(received.supply.requests).toEqual(initial.supply.requests);
  expect(received.supply.receipts['unexpected']).toMatchObject({ received: 2, provisional: false });
  expect(received.ledger.lots['unexpected']).toMatchObject({ item: 'P', quantity: { kind: 'known', numeric: { value: 2 } } });
  expect(Object.values(received.ledger.lots).some(value => value.item === 'Q')).toBe(false);
  expect(received.ledger.lots.unused).toEqual(beforeReceive.ledger.lots.unused);
  await recorded(page, 'provisional', { direction: 'found', item: '', location: '', basis: 'unknown', value: '', note: '架空の自由記述：予定Qの箱に別の品目Pが混在した' }, '10:30');
  const completed = await snapshot(page);
  expect(completed.ledger.lots).toEqual(received.ledger.lots);
  expect(completed.supply).toEqual(received.supply);
  expect(completed.ledger.issues[unresolved.eventId]?.resolution).toBeNull();
  for (const original of [same, separate, unresolved]) expect(completed.ledger.history.find(event => event.eventId === original.eventId)).toEqual(original);

  await page.reload();
  await expect(row(page, 'new-unknown')).toContainText('数が不明');
  expect((await snapshot(page)).ledger).toEqual(completed.ledger);
  const backup = await downloadVia(page, backupButton);
  await goTo(page, 'stock');
  await recorded(page, 'register', lot('after-backup', 'Q', 'S1', 'counted', '99'), '11:00');
  await pickFile(page, backup.path);
  await page.getByRole('region', { name: '復元の確認' }).getByRole('button', { name: '復元する', exact: true }).click(); await page.getByRole('region', { name: '復元の確認' }).waitFor({ state: 'hidden' });
  await page.reload();
  await expect(row(page, 'other-case')).toContainText('3個');
  const restored = await snapshot(page);
  expect(restored.ledger).toEqual(completed.ledger);
  expect(restored.supply).toEqual(completed.supply);
  await expect(row(page, 'after-backup')).toHaveCount(0);
  await goTo(page, 'issues');
  await expect(issueRow(page, unresolved.eventId)).toContainText('架空箱C');
  await goTo(page, 'stock');
  await expect(row(page, 'outside-item')).toBeVisible();
  await expect(row(page, 'outside-place')).toBeVisible();
});
