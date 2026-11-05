import { chromium, expect, test, type Page } from '@playwright/test';
import { browserZoomProfile } from './browser-zoom-profile.mjs';
import { goTo, lot, opLabels, record, recorded, startEmpty, storageBytes, waitForApp, launchAdvanced } from './helpers.ts';
import { draftOf, snapshotOf } from './conflict-helpers.ts';

async function openLot(page: Page, id: string): Promise<void> {
  await goTo(page, 'stock');
  await page.locator(`#list tr[data-lot="${id}"]`).getByRole('button', { name: id, exact: true }).click();
}

test('保管単位から使用: 対象を固定し、選び直さず同じ所属の在庫と履歴を更新する', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('action-p', 'P', 'S1', 'counted', '20'), '08:00');
  await openLot(page, 'action-p');
  await page.locator('#detail').getByRole('button', { name: opLabels.use, exact: true }).click();
  const form = page.getByRole('form', { name: '操作の入力' });
  await expect(form.locator('input[type=hidden][name=lot]')).toHaveValue('action-p');
  await expect(form.locator('select[name=lot]')).toHaveCount(0);
  await expect(form).toContainText('action-p');
  await expect(form).toContainText('案件');
  await form.locator('[name=basis]').selectOption('counted');
  await form.locator('[name=value]').fill('3');
  await form.locator('[name=usedFor]').fill('架空の使用');
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
  const saved = await snapshotOf(page);
  expect(saved.ledger.lots['action-p']?.quantity).toMatchObject({ kind: 'known', numeric: { value: 17 } });
  expect(saved.ledger.lots['action-p']?.project).toEqual({ kind: 'case', id: 'A-001' });
  expect(saved.ledger.history.at(-1)).toMatchObject({ kind: 'use', lotId: 'action-p' });
  await expect(page.locator('#detail')).toContainText('17');
});

test('操作切替: 取消・同じ対象・閲覧移動で固定対象と日時・コード原文を保持し、承認した別対象だけへ切り替える', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('keep-p', 'P', 'S1', 'counted', '20'), '08:00');
  await recorded(page, 'register', lot('keep-q', 'Q', 'S1', 'counted', '10'), '08:00');
  await openLot(page, 'keep-p');
  await page.locator('#detail').getByRole('button', { name: opLabels.move, exact: true }).click();
  const form = page.getByRole('form', { name: '操作の入力' }), original = await form.elementHandle();
  await form.locator('[name=location]').selectOption('T');
  await form.locator('[name=occurredAt]').fill('2026-09-29T10:17');
  const raw = page.locator('#input .code-input textarea');
  await raw.fill('架空の読取原文 001');
  const before = await storageBytes(page);
  await page.locator('#detail').getByRole('button', { name: opLabels.move, exact: true }).click();
  for (const destination of ['supply', 'issues', 'masters', 'management', 'stock'] as const) await goTo(page, destination);
  await openLot(page, 'keep-q');
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('#detail').getByRole('button', { name: opLabels.move, exact: true }).click();
  expect(await form.evaluate((node, old) => node === old, original)).toBe(true);
  await expect(form.locator('[name=lot]')).toHaveValue('keep-p');
  await expect(form.locator('[name=location]')).toHaveValue('T');
  await expect(form.locator('[name=occurredAt]')).toHaveValue('2026-09-29T10:17');
  await expect(raw).toHaveValue('架空の読取原文 001');
  expect(await storageBytes(page)).toEqual(before);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#detail').getByRole('button', { name: opLabels.move, exact: true }).click();
  await expect(form.locator('[name=lot]')).toHaveValue('keep-q');
  await expect(form.locator('[name=location]')).toHaveValue('');
  await original?.dispose();
});

test('操作切替: 二段選択の取消では確認チェックを失効させず、包含回答も保持する', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'masterItem', { codeNone: true, name: '架空の仮品目', units: '個' }, '08:00');
  await record(page, 'masterCode', { target: '品目（仮）架空の仮品目「架空の仮品目」', code: 'Q', reason: '架空の正式ID判明' }, '09:00');
  const form = page.getByRole('form', { name: '操作の入力' });
  await form.locator('[name=confirmed]').check();
  await page.getByLabel('作業の種類', { exact: true }).selectOption('stock');
  page.once('dialog', dialog => dialog.dismiss());
  await form.locator('[name=op]').selectOption('move');
  await expect(form.locator('[name=op]')).toHaveValue('masterCode');
  await expect(form.locator('[name=confirmed]')).toBeChecked();
  await expect(form.locator('[name=reason]')).toHaveValue('架空の正式ID判明');
  await recorded(page, 'register', lot('answer-p', 'P', 'S1', 'counted', '10'), '08:00');
  await recorded(page, 'recount', { lot: 'answer-p', value: '10', causeUnknown: true }, '10:00');
  await openLot(page, 'answer-p');
  await page.locator('#detail').getByRole('button', { name: opLabels.use, exact: true }).click();
  await form.locator('[name=basis]').selectOption('counted');
  await form.locator('[name=value]').fill('3');
  await form.locator('[name=usedFor]').fill('架空の過去使用');
  await form.locator('[name=occurredAt]').fill('2026-09-29T09:00');
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('回答が必要');
  await form.locator('[name=inclusion]').selectOption('included');
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('#detail').getByRole('button', { name: opLabels.move, exact: true }).click();
  await expect(form.locator('[name=inclusion]')).toHaveValue('included');
  await expect(form.locator('[name=value]')).toHaveValue('3');
});

test('対象候補: 16操作を状態で絞り、統合元だけを固定して統合後は別対象を選ばない', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('source', 'P', 'S1', 'counted', '4'), '08:00');
  await recorded(page, 'register', lot('target', 'P', 'S1', 'counted', '6'), '08:00');
  await recorded(page, 'register', lot('common', 'P', 'S1', 'unknown', '', { project: 'common' }), '08:00');
  await recorded(page, 'register', lot('working', 'R', 'T', 'counted', '4', { stage: 'working', process: 'R組立' }), '08:00');
  await recorded(page, 'register', lot('inspection', 'R', 'T', 'counted', '4', { stage: 'inspecting', process: 'R組立' }), '08:00');
  await recorded(page, 'register', lot('completed', 'R', 'T', 'counted', '4', { stage: 'awaitingHandover', process: 'R組立' }), '08:00');
  await recorded(page, 'hold', { lot: 'inspection', reason: 'defective' }, '09:00');
  await openLot(page, 'working');
  const other = page.locator('#detail .other-operations');
  await expect(other.locator('button[data-op=finish]')).toHaveCount(1);
  await expect(other.locator('button[data-op=inspect], button[data-op=toNext], button[data-op=reworkBegin]')).toHaveCount(0);
  const base = ['declare', 'handover', 'hold', 'merge', 'release', 'splitMove', 'stageFix', 'transfer'];
  for (const [id, extra] of [['source', ['surplusAllocate']], ['working', ['finish']], ['inspection', ['inspect']], ['completed', ['toNext', 'reworkBegin']]] as const) {
    await openLot(page, id);
    const keys = await other.locator('button[data-op]').evaluateAll(buttons => buttons.map(button => button.getAttribute('data-op')));
    expect(keys.sort()).toEqual([...base, ...extra].sort());
    for (const key of ['use', 'move', 'split', 'recount'] as const) await expect(page.locator('#detail').getByRole('button', { name: opLabels[key], exact: true })).toBeVisible();
  }
  await openLot(page, 'common');
  await expect(other.locator('button[data-op=transfer]')).toHaveCount(0);
  await page.locator('#detail').getByRole('button', { name: opLabels.use, exact: true }).click();
  const form = page.getByRole('form', { name: '操作の入力' });
  await form.locator('[name=basis]').selectOption('counted'); await form.locator('[name=value]').fill('1');
  await form.locator('[name=usedFor]').fill('架空の使用');
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
  expect((await snapshotOf(page)).ledger.lots['common']?.quantity.kind).toBe('unknown');
  await openLot(page, 'source');
  await other.locator('summary').click();
  await other.locator('button[data-op=merge]').click();
  await expect(form.locator('[name=lot]')).toHaveValue('source');
  await form.locator('[name=target]').selectOption('target');
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#detail [aria-label="この保管単位にできる操作"]')).toHaveCount(0);
  await expect(page.locator('#input')).toContainText('対象 source は現在この操作を記録できません');
  await expect(form).toHaveCount(0);
  const saved = await snapshotOf(page);
  expect(saved.ledger.lots['source']?.mergedInto).toBe('target');
  expect(saved.ledger.lots['target']?.quantity).toMatchObject({ kind: 'known', numeric: { value: 10 } });
});

test('受け取り由来の数え直し: 固定時にも受け取った数の扱いを求める', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'receive', lot('received-p', 'P', 'S1', 'label', '10', { label: '架空の受け取り' }), '08:00');
  await openLot(page, 'received-p');
  await page.locator('#detail').getByRole('button', { name: opLabels.recount, exact: true }).click();
  const form = page.getByRole('form', { name: '操作の入力' });
  await expect(form.locator('[name=receiptEffect]')).toBeVisible();
  await form.locator('[name=value]').fill('8');
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('実際に受け取った数の扱い');
  await form.locator('[name=receiptEffect]').selectOption('keep');
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
  const saved = await snapshotOf(page);
  expect(saved.ledger.lots['received-p']?.quantity).toMatchObject({ kind: 'known', numeric: { value: 8 } });
  expect(saved.supply.receipts['received-p']?.received).toBe(10);
});

test('固定対象の競合: hiddenを退避し、再読込後も参照でき、新入口を開かない', async ({ page, context }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('conflict-p', 'P', 'S1', 'counted', '20'), '08:00');
  const other = await context.newPage(); await other.goto('/'); await waitForApp(other);
  await openLot(other, 'conflict-p');
  await other.locator('#detail').getByRole('button', { name: opLabels.use, exact: true }).click();
  const form = other.getByRole('form', { name: '操作の入力' });
  await form.locator('[name=basis]').selectOption('counted'); await form.locator('[name=value]').fill('3');
  await recorded(page, 'move', { lot: 'conflict-p', location: 'T' }, '10:00');
  await expect(other.locator('#conflict')).toContainText('未解消');
  expect(await draftOf(other)).toContain('conflict-p');
  expect(await draftOf(other)).toContain('固定した対象');
  await other.reload(); await waitForApp(other);
  await expect(other.locator('#conflict')).toContainText('conflict-p');
  await openLot(other, 'conflict-p');
  await other.locator('#detail').getByRole('button', { name: opLabels.use, exact: true }).click();
  await expect(other.getByRole('form', { name: '操作の入力' })).toHaveCount(0);
});

test('固定対象の結果不明: 新入口を止め、再試行は同じ使用を一度だけ記録する', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('retry-p', 'P', 'S1', 'counted', '20'), '08:00');
  await page.goto('/?test'); await waitForApp(page); await openLot(page, 'retry-p');
  await page.locator('#detail').getByRole('button', { name: opLabels.use, exact: true }).click();
  const form = page.getByRole('form', { name: '操作の入力' });
  await form.locator('[name=basis]').selectOption('counted'); await form.locator('[name=value]').fill('3');
  await form.locator('[name=usedFor]').fill('架空の再試行');
  await page.evaluate(() => window.fuzzyStockTest!.loseResponseAt(1));
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.locator('#save')).toContainText('保存結果不明');
  await page.locator('#detail').getByRole('button', { name: opLabels.move, exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(page.locator('#input [data-switch-blocked]')).toContainText('保存中の入力があるため');
  await expect(page.locator('#input [data-switch-blocked]')).toBeFocused();
  await page.getByRole('button', { name: '再試行する', exact: true }).click();
  await expect(page.locator('#save')).toContainText('保存済みだった');
  const saved = await snapshotOf(page);
  expect(saved.ledger.history.filter(event => event.kind === 'use' && event.lotId === 'retry-p')).toHaveLength(1);
  expect(saved.ledger.lots['retry-p']?.quantity).toMatchObject({ kind: 'known', numeric: { value: 17 } });
});

for (const width of [1366, 390]) test(`対象の入口: ${width}pxでキーボードから固定フォームへ到達する`, async ({ page }) => {
  await page.setViewportSize({ width, height: 768 });
  await startEmpty(page);
  await recorded(page, 'register', lot('keyboard-p', 'P', 'S1', 'counted', '20'), '08:00');
  await openLot(page, 'keyboard-p');
  const action = page.locator('#detail').getByRole('button', { name: opLabels.use, exact: true });
  await expect(page.locator('#detail-h')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(action).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#input [name=op]')).toBeFocused();
  await expect(page.locator('#input [data-fixed-subject]')).toContainText('keyboard-p');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('その他の操作: 矢印キーで候補を見ても操作を切り替えず、選んだときだけ固定する', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('arrow-p', 'P', 'S1', 'counted', '20'), '08:00');
  await openLot(page, 'arrow-p');
  const op = page.locator('#input [name=op]'), before = await op.inputValue();
  const menu = page.locator('#detail .other-operations');
  await menu.locator('summary').focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await expect(op).toHaveValue(before);
  await expect(page.locator('#input [data-fixed-subject]')).toHaveCount(0);
  await page.keyboard.press('Tab');
  await expect(menu.locator('button[data-op]').first()).toBeFocused();
  const key = await menu.locator('button[data-op]').first().getAttribute('data-op');
  await page.keyboard.press('Enter');
  await expect(op).toHaveValue(key!);
  await expect(page.locator('#input [data-fixed-subject]')).toContainText('arrow-p');
});

test('対象の入口: 実Edgeの200%ページ拡大でも固定対象に到達する', async ({}, testInfo) => {
  const profile = await browserZoomProfile('.local-logs/ui-improvement', 2);
  const context = await launchAdvanced(profile, { channel: 'msedge', headless: true, viewport: null, locale: 'ja-JP', timezoneId: 'Asia/Tokyo', args: ['--window-size=1400,900'] });
  try {
    const page = context.pages()[0]!;
    await page.goto('http://127.0.0.1:4182/');
    await startEmpty(page);
    await recorded(page, 'register', lot('zoom-p', 'P', 'S1', 'counted', '20'), '08:00');
    await openLot(page, 'zoom-p');
    await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
    await expect(page.locator('#input [data-fixed-subject]')).toContainText('zoom-p');
    const measured = await page.evaluate(() => ({ dpr: devicePixelRatio, innerWidth, cssZoom: getComputedStyle(document.body).zoom, fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth }));
    expect(measured.dpr).toBe(2); expect(measured.cssZoom).toBe('1'); expect(measured.fits).toBe(true);
    await testInfo.attach('lot-actions-zoom200', { body: JSON.stringify(measured), contentType: 'application/json' });
  } finally { await context.close(); }
});
