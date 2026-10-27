import { expect, test, type Page } from '@playwright/test';
import * as XLSX from 'xlsx';
import { decodeSnapshot } from '../../src/ui/storageparse.ts';
import { goTo, backupButton, bannerText, cell, downloadVia, exportButton, jsonFile, lot, pickFile, record, recorded, restoreButton, row, startEmpty, startSample, storageBytes, waitForApp } from './helpers.ts';

const backupName = /^fuzzy-stock-system_復元用バックアップ_\d{8}-\d{6}\.json$/;
const viewName = /^fuzzy-stock-system_閲覧用_復元不可_\d{8}-\d{6}\.xlsx$/;
const confirmation = (page: Page) => page.getByRole('region', { name: '復元の確認' });
const notice = (page: Page) => page.locator('#management-feedback .notice');

async function storedSnapshot(page: Page) {
  const bytes = await storageBytes(page);
  const slot = bytes[`fuzzy-stock/slot-${bytes['fuzzy-stock/head']}`];
  if (typeof slot !== 'string') throw new Error('保存された写しがない');
  return decodeSnapshot(JSON.parse(slot));
}

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

// 大きいSheetJS本体の転送を並べず、利用者と同じ配信から実際に読み込んで出力する。
test.describe.configure({ mode: 'serial' });

// 記録して保存（操作2件：登録と差異申告）→ バックアップを取る、までの共通の手順。
async function backedUp(page: Page) {
  await startEmpty(page);
  await recorded(page, 'register', lot('bk-1', 'P', 'S1', 'counted', '8'), '09:00');
  await recorded(page, 'declare', { lot: 'bk-1', note: '架空の差異' }, '10:00');
  const before = await storageBytes(page);
  const backup = await downloadVia(page, backupButton);
  expect(await storageBytes(page)).toEqual(before);
  return backup;
}

test('AT-28・1.1〜1.7・2.1〜2.4: バックアップを取って記録を足したあと復元すると、取った時点の記録・履歴・操作の索引・次の操作IDに戻る', async ({ page }) => {
  const backup = await backedUp(page);
  expect(backup.name).toMatch(backupName);
  const envelope: Record<string, unknown> = JSON.parse(text(backup.bytes));
  expect(Object.keys(envelope)).toEqual(['notice', 'format', 'version', 'createdAt', 'crc32', 'snapshot']);
  expect(String(envelope.notice)).toContain('復元用バックアップ');
  expect(String(envelope.notice)).toContain('fuzzy-stock-system');
  await goTo(page, 'management');
  await expect(notice(page)).toContainText('復元用バックアップを書き出した');
  await expect(notice(page)).toContainText('保管単位1件・履歴2件・未完了の依頼0件');
  await expect(notice(page)).toContainText('ファイルは各自で保管する');
  const original = decodeSnapshot(JSON.parse(String(envelope.snapshot)));

  await goTo(page, 'stock');
  await recorded(page, 'register', lot('bk-2', 'P', 'S1', 'counted', '3'), '11:00');
  await expect(row(page, 'bk-2')).toHaveCount(1);
  await pickFile(page, backup.path);
  await expect(confirmation(page)).toContainText('に作成したバックアップ（保管単位1件・履歴2件・未完了の依頼0件）で置き換わる');
  await confirmation(page).getByRole('button', { name: '復元する', exact: true }).click();

  await goTo(page, 'stock');
  await expect(row(page, 'bk-2')).toHaveCount(0);
  await expect(cell(page, 'bk-1', '記録上の数と根拠')).toHaveText('8個・数えた');
  await goTo(page, 'issues');
  await expect(page.locator('#issues')).toContainText('架空の差異');
  await expect(page.locator('#history').getByRole('listitem')).toHaveCount(2);
  const restored = await storedSnapshot(page);
  expect(restored.ledger).toEqual(original.ledger);
  expect(restored.supply).toEqual(original.supply);
  expect(restored.ops).toEqual(original.ops);
  expect(restored.saveChecks).toEqual(original.saveChecks);
  expect(restored.opFloor).toBe(original.opFloor);

  await page.reload();
  await expect(row(page, 'bk-1')).toHaveCount(1);
  await expect(row(page, 'bk-2')).toHaveCount(0);
  // バックアップの時点で使用済みの操作ID（op1・op2）を、復元後の新しい操作が使わない。
  await expect(await record(page, 'register', lot('bk-3', 'P', 'S1', 'counted', '1'), '12:00')).toContainText('記録した（操作op3）');
});

test('AT-28・2.5: 別のブラウザーの保存先（固定の架空データが入った新しい保存先）へも同じように復元できる', async ({ page, browser }) => {
  const backup = await backedUp(page);
  const original = decodeSnapshot(JSON.parse(String(JSON.parse(text(backup.bytes)).snapshot)));
  const other = await browser.newContext({ baseURL: 'http://127.0.0.1:4182/', timezoneId: 'Asia/Tokyo', locale: 'ja-JP' });
  const second = await other.newPage();
  await startSample(second);
  await expect(row(second, 'P-001')).toHaveCount(1);
  await pickFile(second, backup.path);
  await confirmation(second).getByRole('button', { name: '復元する', exact: true }).click();
  await goTo(second, 'stock');
  await expect(row(second, 'P-001')).toHaveCount(0);
  await goTo(second, 'stock');
  await expect(row(second, 'bk-1')).toHaveCount(1);
  const restored = await storedSnapshot(second);
  expect(restored.ledger).toEqual(original.ledger);
  expect(restored.ops).toEqual(original.ops);
  expect(restored.opFloor).toBe(original.opFloor);
  await other.close();
});

test('AT-28・1.3・2.7: 保存結果不明の操作が未解決の間は、バックアップも復元も理由を示して止める', async ({ page }) => {
  await page.goto('/?test');
  await goTo(page, 'management');
  await page.getByRole('button', { name: '練習用の台帳で初期化' }).click();
  await page.getByRole('button', { name: '初期化する', exact: true }).click();
  await page.evaluate(() => window.fuzzyStockTest?.loseResponseAt(1));
  await goTo(page, 'stock');
  await record(page, 'register', lot('unknown-1', 'P', 'S1', 'counted', '8'), '09:00');
  await expect(page.locator('#save')).toContainText('保存結果不明');
  let downloads = 0;
  let choosers = 0;
  page.on('download', () => { downloads++; });
  page.on('filechooser', () => { choosers++; });
  const before = await storageBytes(page);
  await goTo(page, 'management');
  await page.getByRole('button', { name: backupButton, exact: true }).click();
  await expect(notice(page)).toContainText('照会・再試行・取りやめで確かめてからバックアップしてください');
  await page.getByRole('button', { name: restoreButton, exact: true }).click();
  await expect(notice(page)).toContainText('照会・再試行・取りやめで確かめてから復元してください');
  expect(downloads).toBe(0);
  expect(choosers).toBe(0);
  expect(await storageBytes(page)).toEqual(before);
});

test('AT-28・2.6: 復元の確認を取り消すと、記録も画面も変わらない', async ({ page }) => {
  const backup = await backedUp(page);
  await goTo(page, 'stock');
  await recorded(page, 'register', lot('bk-2', 'P', 'S1', 'counted', '3'), '11:00');
  const before = await storageBytes(page);
  await pickFile(page, backup.path);
  await expect(confirmation(page)).toBeVisible();
  expect(await storageBytes(page)).toEqual(before);
  await confirmation(page).getByRole('button', { name: 'やめる', exact: true }).click();
  await expect(confirmation(page)).toHaveCount(0);
  expect(await storageBytes(page)).toEqual(before);
  await goTo(page, 'stock');
  await expect(row(page, 'bk-2')).toHaveCount(1);
});

test('AT-28・2.8・2.9・1.4: 読み込めない記録は、バックアップを作れず、確認のうえバックアップから復元でき、古い保存中の操作を消せなければ前のままで再試行できる', async ({ page }) => {
  const backup = await backedUp(page);
  await goTo(page, 'stock');
  await recorded(page, 'register', lot('bk-2', 'P', 'S1', 'counted', '3'), '11:00');
  await page.evaluate(() => {
    localStorage.setItem('fuzzy-stock/head', 'C');
    localStorage.setItem('fuzzy-stock/pending', '壊れた操作');
  });
  await page.reload();
  await expect(page.locator('#save')).toContainText('保存された記録を読み込めない');
  await expect(page.getByRole('button', { name: backupButton, exact: true })).toBeHidden();
  const corrupted = await storageBytes(page);
  await pickFile(page, backup.path, 'バックアップから復元する');
  await expect(confirmation(page)).toContainText('読み込めない記録は消え、');
  expect(await storageBytes(page)).toEqual(corrupted);

  // 古いpendingを消せない保存先。前の記録のままで、同じ確認から再試行できる。
  await page.evaluate(() => {
    const original = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (this: Storage, key: string) {
      if (key === 'fuzzy-stock/pending') throw new Error('保存中の操作を消せない');
      return original.call(this, key);
    };
    Reflect.set(window, 'originalRemoveItem', original);
  });
  await confirmation(page).getByRole('button', { name: '復元する', exact: true }).click();
  await expect(confirmation(page)).toContainText('復元できなかった：保存中の操作を消せない。記録は復元前のまま');
  const failed = await storageBytes(page);
  expect(failed['fuzzy-stock/head']).toBe('C');
  expect(failed['fuzzy-stock/pending']).toBe('壊れた操作');
  await page.evaluate(() => { Storage.prototype.removeItem = Reflect.get(window, 'originalRemoveItem'); });
  await confirmation(page).getByRole('button', { name: '復元する', exact: true }).click();

  await goTo(page, 'stock');
  await expect(page.locator('#list')).toBeVisible();
  await expect(row(page, 'bk-1')).toHaveCount(1);
  await expect(row(page, 'bk-2')).toHaveCount(0);
  const done = await storageBytes(page);
  expect(done['fuzzy-stock/pending']).toBeUndefined();
  expect(['A', 'B']).toContain(done['fuzzy-stock/head']);
});

test('AT-28・2.10: 確認を待つあいだに別の画面で保存されたら、復元せず再読込を求める', async ({ page, context }) => {
  const backup = await backedUp(page);
  const other = await context.newPage();
  await other.goto('/');
  await pickFile(page, backup.path);
  await expect(confirmation(page)).toBeVisible();
  await recorded(other, 'register', lot('other-1', 'P', 'S1', 'counted', '1'), '10:30');
  await expect(page.locator('#save')).toContainText('別の画面で記録が保存された');
  await expect(confirmation(page)).toHaveCount(0);
  const stored = await storedSnapshot(page);
  expect(Object.keys(stored.ledger.lots)).toContain('other-1');
  await other.close();
});

test('FH-F1A-14・2.1・2.6: 確認中に復元のファイルを選び直すと前の確認は消え、後から選んだバックアップだけで復元する。選び直しを取り消しても前の確認は戻らない', async ({ page }) => {
  const first = await backedUp(page);
  await goTo(page, 'stock');
  await recorded(page, 'register', lot('bk-2', 'P', 'S1', 'counted', '3'), '11:00');
  const second = await downloadVia(page, backupButton);
  await goTo(page, 'stock');
  await recorded(page, 'register', lot('bk-3', 'P', 'S1', 'counted', '1'), '12:00');
  const before = await storageBytes(page);

  await pickFile(page, first.path);
  await expect(confirmation(page)).toContainText('保管単位1件・履歴2件');
  // ファイル選択の画面が開いている間に、前のファイルの確認を押せてはいけない。
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: restoreButton, exact: true }).click()]);
  await expect(confirmation(page)).toHaveCount(0);
  await chooser.setFiles(second.path);
  await expect(confirmation(page)).toHaveCount(1);
  await expect(confirmation(page)).toContainText('保管単位2件・履歴3件');
  expect(await storageBytes(page)).toEqual(before);
  await confirmation(page).getByRole('button', { name: '復元する', exact: true }).click();
  await goTo(page, 'stock');
  await expect(row(page, 'bk-2')).toHaveCount(1);
  await expect(row(page, 'bk-3')).toHaveCount(0);

  const restored = await storageBytes(page);
  await pickFile(page, first.path);
  await expect(confirmation(page)).toBeVisible();
  await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: restoreButton, exact: true }).click()]);
  await page.locator('#backup-file').dispatchEvent('cancel');
  await expect(confirmation(page)).toHaveCount(0);
  expect(await storageBytes(page)).toEqual(restored);
  await goTo(page, 'stock');
  await expect(row(page, 'bk-2')).toHaveCount(1);
});

test('FH-F1A-15・2.10: 確認を押した時点で保存先の記録が変わっていたら、復元せず、押しても進まない確認欄を残さずに再読込を求める', async ({ page }) => {
  const backup = await backedUp(page);
  await pickFile(page, backup.path);
  await expect(confirmation(page)).toBeVisible();
  // 同じ画面の書き込みにはstorageイベントが来ないので、確認を押したときの読み直しだけが変化に気づく。
  await page.evaluate(() => {
    localStorage.setItem('fuzzy-stock/head', localStorage.getItem('fuzzy-stock/head') === 'A' ? 'B' : 'A');
  });
  const before = await storageBytes(page);
  await confirmation(page).getByRole('button', { name: '復元する', exact: true }).click();
  await expect(page.locator('#save')).toContainText('別の画面で記録が保存された');
  await expect(confirmation(page)).toHaveCount(0);
  expect(await storageBytes(page)).toEqual(before);
});

test('AT-44・3.1〜3.4・4.1・4.3・4.5・4.10・5.1〜5.4: 閲覧用の出力は復元に使えず、壊れたファイルも断り、画面の名前と説明が区別を示す', async ({ page }) => {
  await startSample(page);
  await goTo(page, 'management');
  await expect(page.locator('#about').getByRole('note')).toHaveText(bannerText);
  for (const name of [backupButton, restoreButton, exportButton]) await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  const before = await storageBytes(page);
  const view = await downloadVia(page, exportButton);
  expect(view.name).toMatch(viewName);
  expect([view.bytes[0], view.bytes[1]]).toEqual([0x50, 0x4b]);
  expect(await storageBytes(page)).toEqual(before);
  await expect(notice(page)).toContainText('閲覧用の出力を書き出した');

  const book = XLSX.read(view.bytes, { type: 'array' });
  expect(book.SheetNames).toEqual(['説明', '集計', '保管単位', '元の記録', '台帳の履歴', '供給の履歴', '依頼', '工程集計', '品目の設定', '工程の設定']);
  const rows = (name: string): string[][] => {
    const sheet = book.Sheets[name];
    if (!sheet) throw new Error(`シートがない：${name}`);
    return XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: true });
  };
  expect(rows('説明')[1]?.[1]).toMatch(/^閲覧用の出力（復元には使えない）/);
  expect(rows('品目の設定')[0]).toContain('共通消耗品・補充基準');
  expect(rows('品目の設定').find(r => r[0] === 'S')?.join(' ')).toContain('標準依頼数量1箱');
  const lots = rows('保管単位');
  expect(lots.find(r => r[0] === 'P-004')).toContain('不明');
  expect(lots.find(r => r[0] === '0012')?.[0]).toBe('0012');
  expect(rows('集計').some(r => r[0] === 'S' && r[1] === '本')).toBe(true);

  const refuse = async (file: string | ReturnType<typeof jsonFile>, expected: string) => {
    await pickFile(page, file);
    await expect(notice(page)).toContainText(expected);
    await expect(confirmation(page)).toHaveCount(0);
    expect(await storageBytes(page)).toEqual(before);
  };
  await refuse(view.path, '閲覧用の出力は復元に使えない');

  const backup = await downloadVia(page, backupButton);
  const backupText = text(backup.bytes);
  const envelope: Record<string, unknown> = JSON.parse(backupText);
  await refuse(jsonFile('cut.json', backupText.slice(0, Math.floor(backupText.length / 2))), '壊れている、または途中で切れている');
  await refuse(jsonFile('changed.json', JSON.stringify({ ...envelope, createdAt: '2026-01-01T00:00:00+09:00' })), '作成時から変わっている');
  await refuse(jsonFile('newer.json', JSON.stringify({ ...envelope, version: 3 })), '新しい版');
  await refuse(jsonFile('other.json', '{"a":1}'), 'このソフトの復元用バックアップではない');
  await expect(page.locator('#about').getByRole('note')).toHaveText(bannerText);
});

test('FH-F1A-09・4.5・4.13: 先頭が0のIDも、閲覧用の出力で文字列のまま残る（画面で登録したID）', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('000123', 'P', 'S1', 'counted', '5'), '09:00');
  await recorded(page, 'register', lot('=SUM(1,2)', 'P', 'S1', 'unknown', ''), '09:30');
  const view = await downloadVia(page, exportButton);
  const book = XLSX.read(view.bytes, { type: 'array' });
  const sheet = book.Sheets['保管単位'];
  if (!sheet) throw new Error('保管単位のシートがない');
  const ids = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: true }).map(r => r[0]);
  expect(ids).toContain('000123');
  expect(ids).toContain('=SUM(1,2)');
  const cellRef = Object.entries(sheet).find(([key, value]) => !key.startsWith('!') && Reflect.get(value as object, 'v') === '=SUM(1,2)');
  expect(Reflect.get(cellRef?.[1] as object, 't')).toBe('s');
  expect(Reflect.get(cellRef?.[1] as object, 'f')).toBeUndefined();
});

test('FH-F1A-10・4.1: 閲覧用の出力の部品の読み込みが一度失敗しても、やり直して書き出せる', async ({ page }) => {
  await page.goto('/');
  let failures = 0;
  await page.route('**/dist/ui/xlsx.js', route => (failures++ === 0 ? route.abort() : route.continue()));
  const view = await downloadVia(page, exportButton);
  expect(view.name).toMatch(viewName);
  expect(failures).toBe(1);
});

test('FH-F1A-12・4.1: SheetJS本体の読み込みが一度失敗しても、実配信から読み直して出力できる', async ({ page }) => {
  await page.goto('/');
  let requests = 0;
  await page.route('**/dist/vendor/xlsx.mjs*', route => (requests++ === 0 ? route.abort() : route.continue()));
  const view = await downloadVia(page, exportButton);
  expect(view.name).toMatch(viewName);
  expect(requests).toBeGreaterThan(1);
  expect(XLSX.read(view.bytes, { type: 'array' }).SheetNames).toContain('保管単位');
});

test('FH-F1A-13・4.1: 読み込みの再試行を使い切っても、通信が戻った後の再クリックで出力できる', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await page.route('**/dist/vendor/xlsx.mjs*', route => route.abort());
  await goTo(page, 'management');
  await page.getByRole('button', { name: exportButton, exact: true }).click();
  await expect(page.getByText(/閲覧用の出力を作れなかった/)).toBeVisible({ timeout: 40_000 });
  await page.unroute('**/dist/vendor/xlsx.mjs*');
  const view = await downloadVia(page, exportButton);
  expect(XLSX.read(view.bytes, { type: 'array' }).SheetNames).toContain('保管単位');
});

// 実GETは上の出力試験で使う。ここでは本体とライセンスの配信情報をHEADで確認する。
test('FH-F1A-11・4.1: 配信スクリプトが、同梱したSheetJSの本体とライセンスを正しい種類で配る', async ({ request }) => {
  const script = await request.head('/dist/vendor/xlsx.mjs');
  expect(script.status()).toBe(200);
  expect(script.headers()['content-type']).toContain('text/javascript');
  expect(Number(script.headers()['content-length'])).toBeGreaterThan(900_000);
  const license = await request.head('/dist/vendor/xlsx-LICENSE.txt');
  expect(license.status()).toBe(200);
  expect(Number(license.headers()['content-length'])).toBeGreaterThan(10_000);
});
