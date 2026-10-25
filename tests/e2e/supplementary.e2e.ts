import { expect, test, type Page } from '@playwright/test';
import { goTo, cell, lot, record, recorded, row, startEmpty, startSample, totals, bannerText } from './helpers.ts';

const listIds = (page: import('@playwright/test').Page) => page.locator('#list tr[data-lot]');

test.use({ trace: 'retain-on-failure' });
const bootDiagnostics = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const messages: string[] = [];
  bootDiagnostics.set(page, messages);
  page.on('pageerror', error => messages.push(`pageerror: ${error.message}`));
  page.on('requestfailed', request => messages.push(`requestfailed: ${request.url()} ${request.failure()?.errorText}`));
  page.on('response', response => { if (response.status() >= 400) messages.push(`HTTP ${response.status()}: ${response.url()}`); });
});
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) await info.attach('boot-diagnostics', { body: JSON.stringify(bootDiagnostics.get(page) ?? []), contentType: 'application/json' });
});

test('FH-A01: 固定の架空データを品目・案件・用途・場所で絞り込み、根拠・記録上の数・確認・更新日時・履歴・確認が必要を文字でたどる', async ({ page }) => {
  await startSample(page);
  await expect(listIds(page)).toHaveCount(10);
  await page.locator('[name=f-item]').selectOption('P');
  await page.locator('[name=f-project]').selectOption('A-001');
  await expect(listIds(page)).toHaveCount(2);
  // 仕様書11章の品目詳細の表示例：案件・用途Aの在庫70、使用可能68、不良2。
  await expect(totals(page)).toHaveText('品目P（個）：在庫 記録上の数70個／使用可能 記録上の数68個／取り分け 2個・数えた（内訳 不良 2個・数えた）');
  await page.locator('[name=f-project]').selectOption('common');
  await page.locator('[name=f-item]').selectOption('');
  await expect(listIds(page)).toHaveText([/^P-003/, /^Q-002/, /^S-001/, /^S-002/]);
  await page.locator('[name=f-location]').selectOption('S2');
  await expect(listIds(page)).toHaveText([/^S-002/]);

  await page.locator('[name=f-project]').selectOption('');
  await page.locator('[name=f-location]').selectOption('');
  await page.locator('#list').getByRole('button', { name: 'P-001', exact: true }).click();
  const detail = page.locator('#detail');
  await expect(detail).toContainText('現在の記録上の数記録上の数68個');
  await expect(detail).toContainText('最後に数えた数100個（2026-09-29 10:00（日本時間）、操作s01）');
  await expect(detail).toContainText('最終記録更新2026-09-29 11:00（日本時間）');
  await expect(detail).toContainText('分けた先P-001-D');
  await expect(detail.getByRole('list').nth(1).getByRole('listitem')).toHaveCount(3);

  // 受け取りの入力に製造・依頼の欄を要求しない。操作の選択肢の文字（注文・購入予定の記録など）は入力欄ではないので、選択欄を除いた入力欄で確かめる。
  const form = page.getByRole('form', { name: '操作の入力' });
  const fields = (await form.locator('label:not(:has(select[name=op]))').allTextContents()).join(' ');
  expect(fields.length).toBeGreaterThan(0);
  expect(fields).not.toContain('製造');
  expect(fields).not.toContain('依頼');
});

test('FH-A01・UI-08a: 確認が必要は色を使わず文字で読める', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('X', 'P', 'S1', 'label', '10'), '09:00');
  await recorded(page, 'use', { lot: 'X', basis: 'counted', value: '15', usedFor: 'A-001 架空作業W1' }, '10:00');
  await page.emulateMedia({ forcedColors: 'active' });
  await expect(cell(page, 'X', '確認が必要')).toHaveText('確認が必要 1件');
  await expect(totals(page)).toContainText('確認が必要 1件：使用可能数として断定しない');
});

test('FH-A03: 一部を分けて移す途中で移動に失敗すると、分割も含めて何も適用しない', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('X', 'P', 'S1', 'counted', '100'), '09:00');
  // 同じ棚への移動は拒否されるので、分割のあとの移動で失敗する。
  await expect(await record(page, 'splitMove', { lot: 'X', childId: 'C', basis: 'counted', value: '30', location: 'S1' }, '10:00')).toContainText(
    '記録していない：移動元と移動先が同じ',
  );
  await expect(row(page, 'C')).toHaveCount(0);
  await expect(cell(page, 'X', '記録上の数と根拠')).toHaveText('100個・数えた');
  await goTo(page, 'issues');
  await expect(page.locator('#history').getByRole('listitem')).toHaveCount(1);
  // 入力は残っているので、移動先を直してそのまま記録できる。
  const form = page.getByRole('form', { name: '操作の入力' });
  await form.locator('[name=location]').selectOption('T');
  await form.getByRole('button', { name: '記録する' }).click();
  await goTo(page, 'stock');
  await expect(cell(page, 'C', '場所')).toHaveText('T');
});

test('FH-A04: 案件・用途・共通・所属不明を分け、不良と返却待ちの重複を二重に数えず、先頭ゼロと入力文字列をそのまま扱う', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('A', 'P', 'S1', 'counted', '10', { project: 'A-001' }), '09:00');
  await recorded(page, 'register', lot('B', 'P', 'S1', 'counted', '10', { project: 'A-002' }), '09:00');
  await recorded(page, 'register', lot('C', 'P', 'S1', 'counted', '10', { project: 'common' }), '09:00');
  await recorded(page, 'register', lot('0012', 'P', 'S1', 'counted', '2', { project: 'unassigned' }), '09:00');
  await expect(cell(page, 'A', '案件・用途')).toHaveText('案件・用途A-001');
  await expect(cell(page, 'B', '案件・用途')).toHaveText('案件・用途A-002');
  await expect(cell(page, 'C', '案件・用途')).toHaveText('共通在庫');
  await expect(cell(page, '0012', '案件・用途')).toHaveText('案件・用途が不明');
  await expect(cell(page, '0012', 'ID')).toHaveText('0012');

  await recorded(page, 'hold', { lot: '0012', reason: 'defective' }, '10:00');
  await recorded(page, 'hold', { lot: '0012', reason: 'returnPending' }, '10:01');
  await expect(totals(page)).toHaveText('品目P（個）：在庫 記録上の数32個／使用可能 記録上の数30個／取り分け 2個・数えた（内訳 不良 2個・数えた、返却待ち 2個・数えた）');

  const hostile = '<img src=x onerror="window.__fsInjected=1">';
  await recorded(page, 'register', lot(hostile, 'Q', 'S1', 'counted', '1'), '10:05');
  await recorded(page, 'declare', { lot: hostile, note: '<b>太字</b>; DROP TABLE lots; --' }, '10:06');
  await expect(page.locator('#list')).toContainText(hostile);
  await goTo(page, 'issues');
  await expect(page.locator('#issues')).toContainText('<b>太字</b>; DROP TABLE lots; --');
  await expect(page.locator('main img, main b')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __fsInjected?: number }).__fsInjected)).toBeUndefined();
});

test('FH-A05: 過去の受け取りを作らず初期数量を登録し、品目未特定の箱を別に示し、仮の記録を総数に足さず、記録者と訂正者を分ける', async ({ page }) => {
  await startSample(page);
  await goTo(page, 'issues');
  await expect(page.locator('#history')).not.toContainText('使用：P-002');
  await expect(page.locator('#issues tr[data-issue="s13"]')).toContainText('適用対象不明（仮の記録）');
  await expect(page.locator('#issues tr[data-issue="s13"]')).toContainText('品目不明の箱（架空の読取文字列 0012-AB）');

  await goTo(page, 'stock');
  await page.locator('[name=f-item]').selectOption('Q');
  const before = await totals(page).textContent();
  await recorded(page, 'provisional', { direction: 'found', item: 'Q', location: 'S1', basis: 'counted', value: '3', note: '案件不明の3個（架空）' }, '12:00');
  await expect(totals(page)).toHaveText(before ?? '');

  await page.locator('#actor').selectOption('架空担当B');
  await recorded(page, 'recount', { lot: 'Q-002', value: '4', causeUnknown: true }, '12:10');
  await page.locator('#list').getByRole('button', { name: 'Q-002', exact: true }).click();
  const detail = page.locator('#detail');
  await expect(detail).toContainText('担当 架空担当B　数えて確認：Q-002');
  await expect(detail).toContainText('担当 架空担当A　登録：Q-002');
});

test('FH-A06: 架空データの試作・この端末のブラウザーだけへの保存・バックアップはファイルで各自が保管することを常に表示し、再読込でも記録が残る', async ({ page }) => {
  await startSample(page);
  // 旧試験名を追跡用に残す。全文は管理、常時の注意は新UI試験で確認する。
  await goTo(page, 'management');
  await expect(page.locator('#about').getByRole('note')).toHaveText(bannerText);
  await goTo(page, 'stock');
  await recorded(page, 'declare', { lot: 'P-002', note: '架空の申告' }, '12:00');
  await page.reload();
  await goTo(page, 'issues');
  await expect(page.locator('#issues')).toContainText('架空の申告');
  await goTo(page, 'management');
  await expect(page.locator('#about').getByRole('note')).toHaveText(bannerText);
  await goTo(page, 'stock');
  await expect(listIds(page)).toHaveCount(10);
});
