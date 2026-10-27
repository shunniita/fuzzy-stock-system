import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { releaseFiles } from './package-release.mjs';
import { readBackup } from '../src/ui/backup.ts';
import { parse } from '../src/ui/storage.ts';
import { record, recorded, selectOperation } from '../tests/e2e/helpers.ts';
import { verifyPublicFlow } from '../tests/e2e/public-flow.ts';

if (process.argv.length !== 3) throw new Error('node scripts/verify-release.mjs <配布候補ZIP>');
const archive = resolve(process.argv[2]);
const temporaryRoot = resolve(tmpdir());
const temporary = mkdtempSync(join(temporaryRoot, 'fuzzy-stock-release-smoke-'));
const extracted = join(temporary, '日本語の展開先’引用符');
let server, browser, report;
const failures = [];
const external = [], errors = [];
const usable = page => page.waitForFunction(() => document.querySelector('#app')?.inert === false && document.querySelector('#actor')?.options.length > 0);
async function startServer(payload, port) {
  const portArgument = port === undefined ? '' : ` -Port ${port}`;
  server = spawn('powershell.exe', ['-NoProfile', '-Command', `$ErrorActionPreference = 'Stop'; & $env:FS_RELEASE_START -NoBrowser${portArgument}; exit $LASTEXITCODE`], { cwd: process.env.SystemRoot, windowsHide: true, env: { ...process.env, FS_RELEASE_START: join(payload, 'start-local.cmd') } });
  return new Promise((accept, reject) => {
    let output = '';
    const deadline = setTimeout(() => reject(new Error(`配布物の起動待ちが上限に達しました: ${output}`)), 30_000);
    server.stdout.on('data', bytes => {
      output += bytes.toString();
      const ready = output.match(/FS_SERVER_READY (http:\/\/127\.0\.0\.1:\d+)\//);
      if (ready) { clearTimeout(deadline); accept(ready[1]); }
    });
    server.stderr.on('data', bytes => { output += bytes.toString(); });
    server.on('error', error => { clearTimeout(deadline); reject(error); });
    server.on('exit', code => { clearTimeout(deadline); reject(new Error(`配布物の起動が終了しました(${code}): ${output}`)); });
  });
}
async function stopServer() {
  if (!server) return;
  const owned = server;
  if (!owned.pid || owned.exitCode !== null || owned.signalCode !== null) throw new Error('配布用の配信が予定より先に終了しました');
  let deadline;
  try {
    const closed = new Promise((accept, reject) => {
      owned.once('close', accept);
      deadline = setTimeout(() => reject(new Error('配布用の配信を終了できませんでした')), 5000);
    });
    execFileSync('taskkill.exe', ['/pid', String(owned.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    await closed;
    server = undefined;
  } finally { clearTimeout(deadline); }
}
async function openApp(origin) {
  browser = await chromium.launchPersistentContext(join(temporary, 'edge-profile'), { channel: 'msedge', headless: true, acceptDownloads: true, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  await browser.route('**/*', route => {
    const url = new URL(route.request().url());
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== origin) {
      external.push(url.href);
      return route.abort();
    }
    return route.continue();
  });
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await usable(page);
  return page;
}
try {
  mkdirSync(extracted);
  execFileSync('powershell.exe', ['-NoProfile', '-Command', "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:FS_RELEASE_ZIP, $env:FS_RELEASE_EXTRACTED)"], { cwd: process.env.SystemRoot, windowsHide: true, env: { ...process.env, FS_RELEASE_ZIP: archive, FS_RELEASE_EXTRACTED: extracted } });
  const directories = readdirSync(extracted, { withFileTypes: true });
  assert.equal(directories.length, 1);
  assert.ok(directories[0].isDirectory());
  const payload = join(extracted, directories[0].name);
  const manifest = JSON.parse(readFileSync(join(payload, 'release-manifest.json'), 'utf8'));
  assert.equal(manifest.format, 'fuzzy-stock-release-candidate');
  assert.match(manifest.revision, /^[a-f0-9]{40}$/);
  assert.equal(manifest.files.length, releaseFiles.length);
  assert.deepEqual(manifest.files.map(file => file.path).sort(), releaseFiles.map(({ path }) => path).sort());
  const files = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [relative(payload, join(directory, entry.name)).replaceAll('\\', '/')]);
  assert.deepEqual(files(payload).sort(), [...releaseFiles.map(({ path }) => path), 'release-manifest.json'].sort());
  for (const file of manifest.files) {
    const bytes = readFileSync(join(payload, file.path));
    assert.equal(bytes.length, file.bytes, file.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, file.path);
  }
  const origin = await startServer(payload, 0);
  const page = await openApp(origin);
  const publicProof = await verifyPublicFlow(page);
  const helpPromise = browser.waitForEvent('page');
  await page.getByRole('link', { name: '使い方', exact: true }).click();
  const help = await helpPromise;
  await help.waitForLoadState();
  assert.equal(new URL(help.url()).pathname, '/help.html');
  assert.match(await help.locator('h1').innerText(), /fuzzy-stock-system/);
  await help.close();
  await page.locator('#nav-management').click();
  await page.locator('#reset-practice').click();
  await page.getByRole('button', { name: '初期化する', exact: true }).click(); await page.locator('#nav-stock').click();
  const coreOf = async () => parse(await page.evaluate(() => localStorage.getItem('fuzzy-stock/slot-' + localStorage.getItem('fuzzy-stock/head'))));
  await recorded(page, 'returnRecord', { item: 'R', location: 'T', basis: 'counted', value: '2', returnOrigin: 'fictional-original', note: '架空の実ZIP通し確認' }, '12:00');
  const form = page.getByRole('form', { name: '操作の入力' }); await selectOperation(form.locator('[name=op]'), 'returnAssign');
  const issue = await form.locator('[name=issue] option').nth(1).getAttribute('value'); assert.ok(issue);
  await record(page, 'returnAssign', { issue, returnInclusion: 'notIncluded', newId: 'zip-return', item: 'R', unit: '台', project: 'A-001', location: 'T', reason: '架空の出庫戻りを確認' }, '13:00');
  await form.locator('[name=confirmed]').check(); await form.getByRole('button', { name: '記録する', exact: true }).click();
  assert.match(await page.locator('#input > [role=status]').innerText(), /記録した/); const beforeRework = await coreOf();
  assert.equal(beforeRework.ledger.lots['zip-return'].quantity.numeric.value, 2);
  await record(page, 'returnRework', { lot: 'zip-return', childId: 'zip-repair', process: '架空ZIP戻り工程', criterion: 'inspection', basis: 'counted', value: '2', reason: '架空の新しい物理作業' }, '14:00');
  assert.match(await page.locator('#input > [role=status]').innerText(), /物理的なやり直し・修理/); await form.locator('[name=confirmedPhysical]').check();
  await form.getByRole('button', { name: '記録する', exact: true }).click(); assert.match(await page.locator('#input > [role=status]').innerText(), /記録した/);
  const afterRework = await coreOf(); assert.deepEqual(afterRework.supply, beforeRework.supply);
  assert.deepEqual(afterRework.ledger.history.slice(0, -1), beforeRework.ledger.history); assert.equal(afterRework.ledger.history.length, beforeRework.ledger.history.length + 1);
  assert.equal(afterRework.ledger.lots['zip-return'].quantity.numeric.value, 0); assert.equal(afterRework.ledger.lots['zip-repair'].quantity.numeric.value, 2);
  assert.equal(afterRework.ledger.lots['zip-repair'].stage.kind, 'working'); assert.deepEqual(afterRework.ledger.lots['zip-repair'].holds, beforeRework.ledger.lots['zip-return'].holds);
  const created = afterRework.ledger.history.at(-1); assert.equal(created.kind, 'rework'); assert.equal(created.returnSource.confirmedPhysical, true);
  assert.deepEqual(created.returnSource.process, { id: '架空ZIP戻り工程', criterion: 'inspection' });
  const returnProof = { parentBefore: 2, parentAfter: 0, childAfter: 2, stage: 'working', supplyUnchanged: true, oldHistoryPrefixRetained: true, historyAdded: 1, holdsInherited: true, confirmedPhysical: true };

  await recorded(page, 'masterItem', { code: 'ZIP-D', name: '架空ZIP消耗品', units: '個、袋', 'unitStep-個': '0.1' });
  await recorded(page, 'masterPerBox', { target: 'item:ZIP-D', boxUnit: '袋', pieceUnit: '個', perBox: '10', reason: '架空ZIPの包装確認' }, '10:00');
  await recorded(page, 'masterConsumable', { target: 'item:ZIP-D', consumableEnabled: true, pieceUnit: '個', replenishmentEnabled: true, threshold: '20', standardOrderValue: '2', standardOrderUnit: '袋', reason: '架空ZIPの補充基準' });
  await recorded(page, 'register', { newId: 'ZIP-BAG', item: 'ZIP-D', unit: '袋', project: 'common', location: 'S1', basis: 'counted', value: '1' });
  await recorded(page, 'register', { newId: 'ZIP-LOOSE', item: 'ZIP-D', unit: '個', project: 'common', location: 'S1', basis: 'counted', value: '0.3' });
  await page.locator('#nav-supply').click();
  const consumableText = await page.locator('#consumables [data-stock="ZIP-D"]').innerText();
  assert.match(consumableText, /10.3個/);
  assert.match(consumableText, /標準依頼数量2袋/);
  assert.match(consumableText, /中身未確認/);
  const consumableProof = { item: 'ZIP-D', packaging: '袋', total: '10.3個', standardOrder: '2袋', basisPreserved: true };
  await page.locator('#nav-stock').click();
  const stock = await page.locator('#list').innerText();
  assert.ok(stock.includes('品目'), '在庫一覧が使える');
  const storage = await page.evaluate(() => JSON.stringify(Object.entries(localStorage).sort()));
  assert.notEqual(storage, '[]');
  await page.reload();
  await usable(page);
  assert.equal(await page.locator('#list').innerText(), stock, '再読込で在庫を保持する');
  assert.equal(await page.evaluate(() => JSON.stringify(Object.entries(localStorage).sort())), storage);
  await page.locator('#nav-management').click();
  const download = async (selector, name) => {
    const waiting = page.waitForEvent('download');
    await page.locator(selector).click();
    const file = await waiting;
    const target = join(temporary, name);
    await file.saveAs(target);
    assert.equal(await file.failure(), null);
    return readFileSync(target);
  };
  const backup = await download('#backup-save', 'backup.json');
  assert.equal(JSON.parse(backup.toString()).format, 'fuzzy-stock-backup');
  const excel = await download('#view-export', 'view.xlsx');
  assert.equal(excel.subarray(0, 2).toString(), 'PK');
  assert.ok(excel.length > 1000);
  assert.equal(await page.evaluate(() => JSON.stringify(Object.entries(localStorage).sort())), storage, '出力で保存記録を変えない');
  await page.locator('#reset-empty').click();
  await page.getByRole('button', { name: '初期化する', exact: true }).click();
  await page.locator('#nav-stock').click();
  assert.notEqual(await page.locator('#list').innerText(), stock, '復元前に架空データを消す');
  await page.locator('#nav-management').click();
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#backup-restore').click();
  await (await chooser).setFiles(join(temporary, 'backup.json'));
  const confirmation = page.getByRole('region', { name: '復元の確認' });
  await confirmation.getByRole('button', { name: '復元する', exact: true }).click();
  await confirmation.waitFor({ state: 'hidden' });
  const restored = await download('#backup-save', 'restored.json');
  const snapshotOf = bytes => {
    const decoded = readBackup(bytes);
    assert.equal(decoded.kind, 'ok', '出力した復元用バックアップの全検査が通る');
    return decoded.snapshot;
  };
  for (const part of ['ledger', 'supply']) assert.deepEqual(snapshotOf(restored)[part], snapshotOf(backup)[part], `復元後の${part}`);
  await page.locator('#nav-stock').click();
  assert.equal(await page.locator('#list').innerText(), stock, '配布物だけでバックアップから在庫を復元する');
  const restoredStorage = await page.evaluate(() => JSON.stringify(Object.entries(localStorage).sort()));
  await browser.close();
  browser = undefined;
  await stopServer();
  writeFileSync(join(payload, 'local-settings.txt'), `# fictional release verification\r\nport=${new URL(origin).port}\r\n`);
  assert.equal(await startServer(payload), origin, '設定ファイルを読み、同じ保存先のポートで配信を再開する');
  const reopened = await openApp(origin);
  assert.equal(await reopened.locator('#list').innerText(), stock, 'ブラウザーと配信を再起動しても在庫を保持する');
  assert.equal(await reopened.evaluate(() => JSON.stringify(Object.entries(localStorage).sort())), restoredStorage, '同じ専用プロファイルの保存記録を保持する');
  await reopened.locator('#nav-supply').click();
  assert.equal(await reopened.locator('#consumables [data-stock="ZIP-D"]').innerText(), consumableText, '消耗品の設定と数量を復元・再起動後も保持する');
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  report = { archive, revision: manifest.revision, files: manifest.files.length + 1, publicProof, returnProof, consumableProof, checks: ['all file hashes', 'Japanese extraction path', 'start-local.cmd', 'usable boot', 'empty ledger registration, use, move, recount, history and backup restore', 'bundled browser help', 'returned physical intake, assignment and rework with preserved history and supply', 'configured consumable with decimal quantity, backup restore and restart', 'save and reload', 'backup download and restore after reset', 'Excel lazy import and download', 'configured port from local-settings.txt without Port override', 'browser and server restart with same profile and origin', 'no external app requests', 'no page errors'], backupBytes: backup.length, excelBytes: excel.length };
} catch (error) { failures.push(error); }
finally {
  try { if (browser) await browser.close(); }
  catch (error) { failures.push(error); }
  try { await stopServer(); }
  catch (error) { failures.push(error); }
  try {
    if (server) throw new Error('配信の終了を確認できないため一時ファイルを保持しました');
    if (dirname(resolve(temporary)) !== temporaryRoot || !basename(temporary).startsWith('fuzzy-stock-release-smoke-')) throw new Error('検証用フォルダーの削除先が不正です');
    rmSync(temporary, { recursive: true, force: true });
  } catch (error) { failures.push(error); }
  if (failures.length) {
    console.log(JSON.stringify({ status: 'FAIL', archive, failures: failures.map(error => String(error?.stack ?? error)) }, null, 2));
    throw new AggregateError(failures, '配布物の検証または後片付けに失敗しました');
  }
}
console.log(JSON.stringify({ status: 'PASS', ...report, cleanup: 'complete' }, null, 2));
