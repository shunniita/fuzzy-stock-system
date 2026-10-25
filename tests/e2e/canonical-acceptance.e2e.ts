import { expect, test, type Page } from '@playwright/test';
import { snapshotOf } from './conflict-helpers.ts';
import { waitForPersistence, backupButton, cell, downloadVia, goTo, lot, pickFile, record, recorded, row, startEmpty, storageBytes, totals, waitForApp } from './helpers.ts';

async function receiptRelations(page: Page): Promise<void> {
  await goTo(page, 'stock');
  await expect(cell(page, 'received', '記録上の数と根拠')).toHaveText('10個・数えた');
  await row(page, 'received').getByRole('button', { name: 'received', exact: true }).click();
  const detail = page.getByRole('region', { name: 'この保管単位の証拠', exact: true });
  await expect(detail.getByRole('article', { name: '依頼op1' })).toContainText('到着8個・良品8個');
  await expect(detail.getByRole('article', { name: '依頼op2' })).toHaveCount(0);
  await goTo(page, 'supply');
  await expect(page.locator('#supply')).toContainText('実際に受け取った数の記録：保管単位received、届いた数10');
  await expect(page.locator('#supply')).toContainText('割り当て：依頼op1へ、保管単位receivedから到着8・良品8');
  await expect(page.locator('#supply')).not.toContainText('割り当て：依頼op2へ');
}

test('AT-41指定条件: 受け取り10の別依頼8＋3は第二行だけ拒否し、受け取りと第一割り当てを再読込・復元後も保つ', async ({ page }) => {
  await startEmpty(page);
  const request = { project: 'A-001', item: 'P', unit: '個', quantity: '10', vendor: '架空第一依頼先', requestedOn: '2026-09-29', replyKind: 'none' };
  await recorded(page, 'requestRecord', request, '07:00');
  await recorded(page, 'requestRecord', { ...request, vendor: '架空第二依頼先' }, '07:10');
  const before = await snapshotOf(page);
  const status = await record(page, 'receive', {
    ...lot('received', 'P', 'S1', 'counted', '10'), unit: '個',
    r1request: 'op1', r1arrived: '8', r1good: '8', r2request: 'op2', r2arrived: '3', r2good: '3',
  }, '08:00');
  await expect(status).toContainText('受け取りは記録した。割り当ては拒否した（2行目：');
  await expect(status).toContainText('実際に受け取った数10を超える');
  await expect(status).toContainText('1行目までを記録した');
  const accepted = await snapshotOf(page), bytes = await storageBytes(page);
  expect(accepted.supply.receipts['received']).toMatchObject({ received: 10, provisional: false });
  expect(accepted.supply.requests['op1']?.arrivals).toEqual([
    expect.objectContaining({ receiptLotId: 'received', arrived: 8, good: 8 }),
  ]);
  expect(accepted.supply.requests['op2']).toEqual(before.supply.requests['op2']);
  expect(accepted.supply.requests['op2']?.arrivals).toEqual([]);
  expect(accepted.supply.log.slice(0, before.supply.log.length)).toEqual(before.supply.log);
  expect(accepted.supply.log.slice(before.supply.log.length)).toMatchObject([
    { kind: 'receiptRecord', lotId: 'received', received: 10 },
    { kind: 'arrival', requestId: 'op1', arrival: { receiptLotId: 'received', arrived: 8, good: 8 } },
  ]);
  expect(accepted.ledger.history.slice(0, before.ledger.history.length)).toEqual(before.ledger.history);
  expect(accepted.ledger.history.slice(before.ledger.history.length)).toMatchObject([
    { kind: 'register', changes: [{ before: null, after: { id: 'received', quantity: { numeric: { value: 10 } } } }] },
  ]);
  await receiptRelations(page);
  expect(await storageBytes(page)).toEqual(bytes);

  // 第二依頼だけへ再送しても、依頼をまたいだ合計8＋3の上限は変わらない。
  await expect(await record(page, 'allocate', { receipt: 'received', request: 'op2', arrived: '3', good: '3' }, '09:00')).toContainText('実際に受け取った数10を超える');
  expect(await snapshotOf(page)).toEqual(accepted);
  expect(await storageBytes(page)).toEqual(bytes);
  await page.reload(); await waitForApp(page);
  await receiptRelations(page);
  expect(await snapshotOf(page)).toEqual(accepted);
  expect(await storageBytes(page)).toEqual(bytes);

  const backup = await downloadVia(page, backupButton);
  expect(await storageBytes(page)).toEqual(bytes);
  await goTo(page, 'stock');
  await recorded(page, 'move', { lot: 'received', location: 'T' }, '10:00');
  expect((await snapshotOf(page)).ledger.lots['received']?.location).toBe('T');
  await pickFile(page, backup.path);
  await page.getByRole('region', { name: '復元の確認' }).getByRole('button', { name: '復元する', exact: true }).click();
  await waitForPersistence(page);
  const restored = await snapshotOf(page), restoredBytes = await storageBytes(page);
  expect(restored.ledger).toEqual(accepted.ledger);
  expect(restored.supply).toEqual(accepted.supply);
  await page.reload(); await waitForApp(page);
  await receiptRelations(page);
  expect(await snapshotOf(page)).toEqual(restored);
  expect(await storageBytes(page)).toEqual(restoredBytes);
});

test('AT-50指定条件: 返却待ち4のうち不良2は除外4で、予定取消後も不良2だけを使用不可に保つ', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('pending', 'P', 'S1', 'counted', '4'), '08:00');
  await recorded(page, 'hold', { lot: 'pending', reason: 'returnPending' }, '09:00');
  await recorded(page, 'split', { lot: 'pending', childId: 'bad', basis: 'counted', value: '2' }, '09:10');
  await recorded(page, 'hold', { lot: 'bad', reason: 'defective' }, '09:20');
  const overlap = await snapshotOf(page), overlapBytes = await storageBytes(page);
  await expect(totals(page)).toHaveText('品目P（個）：在庫 記録上の数4個／使用可能 記録上の数0個／取り分け 記録上の数4個（内訳 不良 2個・数えた、返却待ち 記録上の数4個）');
  await expect(cell(page, 'pending', '取り分けた理由')).toHaveText('返却待ち');
  await expect(cell(page, 'bad', '取り分けた理由')).toHaveText('不良・返却待ち');
  expect(overlap.ledger.lots['pending']?.quantity).toMatchObject({ numeric: { value: 2 } });
  expect(overlap.ledger.lots['bad']?.quantity).toMatchObject({ numeric: { value: 2 } });
  await page.reload(); await waitForApp(page);
  await expect(totals(page)).toContainText('／取り分け 記録上の数4個（');
  expect(await snapshotOf(page)).toEqual(overlap);
  expect(await storageBytes(page)).toEqual(overlapBytes);

  await recorded(page, 'release', { lot: 'pending', reason: 'returnPending' }, '10:00');
  await recorded(page, 'release', { lot: 'bad', reason: 'returnPending' }, '10:10');
  const released = await snapshotOf(page), releasedBytes = await storageBytes(page);
  const pending = overlap.ledger.lots['pending'], bad = overlap.ledger.lots['bad'];
  if (!pending || !bad) throw new Error('返却待ちの二つのまとまりが必要');
  expect(released.ledger).toEqual({
    ...overlap.ledger,
    lots: { ...overlap.ledger.lots, pending: { ...pending, holds: [] }, bad: { ...bad, holds: ['defective'] } },
    history: released.ledger.history,
  });
  expect(released.ledger.history.slice(0, overlap.ledger.history.length)).toEqual(overlap.ledger.history);
  expect(released.ledger.history.slice(overlap.ledger.history.length)).toMatchObject([
    { kind: 'release', reason: 'returnPending', changes: [{ before: pending, after: { ...pending, holds: [] } }] },
    { kind: 'release', reason: 'returnPending', changes: [{ before: bad, after: { ...bad, holds: ['defective'] } }] },
  ]);
  expect(released.supply).toEqual(overlap.supply);
  expect(released.saveChecks).toEqual(overlap.saveChecks);
  expect(released.conflictReviews).toEqual(overlap.conflictReviews);
  await expect(totals(page)).toHaveText('品目P（個）：在庫 記録上の数4個／使用可能 記録上の数2個／取り分け 2個・数えた（内訳 不良 2個・数えた）');
  await expect(cell(page, 'pending', '取り分けた理由')).toHaveText('なし');
  await expect(cell(page, 'bad', '取り分けた理由')).toHaveText('不良');
  await page.reload(); await waitForApp(page);
  await expect(totals(page)).toHaveText('品目P（個）：在庫 記録上の数4個／使用可能 記録上の数2個／取り分け 2個・数えた（内訳 不良 2個・数えた）');
  await expect(cell(page, 'bad', '取り分けた理由')).toHaveText('不良');
  expect(await snapshotOf(page)).toEqual(released);
  expect(await storageBytes(page)).toEqual(releasedBytes);
});
