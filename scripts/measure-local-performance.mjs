import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { cpus, platform, release, totalmem } from 'node:os';
import { chromium, expect } from '@playwright/test';
import { practiceLedger, register } from '../src/domain/ledger.ts';
import { emptySupply } from '../src/domain/supply.ts';
import { load, parse, replace } from '../src/ui/storage.ts';

const capacity = process.argv[2] === '--capacity';
if (process.argv.length > 3 || (process.argv[2] && !capacity)) throw Error('使い方: npm run performance:measure [-- --capacity]');
const root = fileURLToPath(new URL('../', import.meta.url));
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const report = {
  revision: git(['rev-parse', 'HEAD']), checkedAt: new Date().toISOString(),
  inputModified: git(['status', '--porcelain', '--', 'src', 'web', 'scripts', 'package.json', 'package-lock.json']) !== '',
  node: process.version, browser: '', host: { platform: platform(), release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem() },
  mode: capacity ? 'native capacity probe, fictional P lots, one isolated context per scale; timings are not performance evidence' : 'headless Edge, fictional counted P lots in A-001/S1, three isolated contexts per scale; diagnostic baseline, no VT-05 threshold',
  runtimeFiles: Object.fromEntries(['web/dist/ui/main.js', 'web/index.html', 'web/style.css'].map(path => [path, createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')])),
  samples: [], errors: [], external: [],
};
const resultPath = resolve(root, `.local-logs/performance/${capacity ? 'capacity-realistic' : 'load-baseline'}-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.json`);
mkdirSync(resolve(root, '.local-logs/performance'), { recursive: true });
const save = () => writeFileSync(resultPath, `${JSON.stringify(report, null, 2)}\n`);
let server, browser;
function startServer() {
  server = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve(root, 'web/_local-server.ps1'), '-NoBrowser', '-Port', '0'], { cwd: root, windowsHide: true });
  return new Promise((accept, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(Error(`測定用サーバーの起動待ちが上限に達しました: ${output}`)), 30_000);
    server.stdout.on('data', bytes => {
      output += bytes.toString();
      const ready = output.match(/FS_SERVER_READY (http:\/\/127\.0\.0\.1:\d+)\//);
      if (ready) { clearTimeout(timer); accept(ready[1]); }
    });
    server.stderr.on('data', bytes => { output += bytes.toString(); });
    server.on('exit', code => { clearTimeout(timer); reject(Error(`測定用サーバーが終了しました(${code}): ${output}`)); });
    server.on('error', error => { clearTimeout(timer); reject(error); });
  });
}
function dataFor(count) {
  const start = performance.now();
  let ledger = practiceLedger;
  const at = '2026-09-29T08:00:00+09:00';
  for (let i = 0; i < count; i++) ledger = register(ledger, { eventId: `baseline-${i}`, actor: '架空担当A', occurredAt: at, recordedAt: at }, { id: `BASE-${i.toString().padStart(4, '0')}`, item: 'P', unit: '個', project: { kind: 'case', id: 'A-001' }, location: 'S1' }, 'counted', 10);
  const generatedMs = performance.now() - start;
  const values = new Map();
  const store = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const replaceStart = performance.now();
  replace(store, null, { ledger, supply: emptySupply });
  const replaceMs = performance.now() - replaceStart;
  const loadStart = performance.now();
  assert.equal(load(store).kind, 'ok');
  return { count, generatedMs, replaceMs, nodeLoadMs: performance.now() - loadStart, entries: [...values], storageUtf16Bytes: [...values].reduce((sum, [key, value]) => sum + 2 * (key.length + value.length), 0) };
}
async function paint(page) { await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))); }
async function stopOwnedServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  await new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(Error('測定専用サーバーの終了を確認できません')), 5000);
    server.once('exit', () => { clearTimeout(timer); accept(); });
    server.once('error', error => { clearTimeout(timer); reject(error); });
    // -NoBrowserで直接起動したPowerShellだけを、Nodeの所有handleで終了する。
    server.kill();
  });
}
async function filterTo(page, item) {
  return page.evaluate(async item => {
    const control = document.querySelector('[name=f-item]');
    const start = performance.now();
    control.value = item;
    control.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
    return performance.now() - start;
  }, item);
}
try {
  const origin = await startServer();
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  report.browser = browser.version();
  for (const count of capacity ? [1500, 2000, 2500] : [10, 100, 500, 1000]) {
    const { entries, ...data } = dataFor(count);
    for (let sample = 1; sample <= (capacity ? 1 : 3); sample++) {
      const context = await browser.newContext({ timezoneId: 'Asia/Tokyo', locale: 'ja-JP' });
      try {
        await context.route('**/*', route => {
          const url = new URL(route.request().url());
          if (url.origin !== origin) { report.external.push(url.href); return route.abort(); }
          if (url.pathname === '/__baseline_seed') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Fictional baseline seed</title>' });
          return route.continue();
        });
        const page = await context.newPage();
        page.on('pageerror', error => report.errors.push(error.message));
        if (capacity) await page.addInitScript(() => {
          window.__baselineStorageErrors = [];
          const original = Storage.prototype.setItem;
          Storage.prototype.setItem = function(key, value) {
            try { return Reflect.apply(original, this, [key, value]); }
            catch (error) {
              window.__baselineStorageErrors.push({ key: String(key), name: error?.name, domException: error instanceof DOMException });
              throw error;
            }
          };
        });
        await page.goto(`${origin}/__baseline_seed`);
        await page.evaluate(entries => { for (const [key, value] of entries) localStorage.setItem(key, value); }, entries);
        const bootStart = performance.now();
        await page.goto(origin);
        await page.waitForFunction(() => document.querySelector('#app')?.inert === false && document.querySelector('#actor')?.options.length > 0);
        await paint(page);
        const bootMs = performance.now() - bootStart;
        assert.equal(await page.locator('tr[data-lot]').count(), count);
        const filterMs = await filterTo(page, 'Q');
        assert.equal(await page.locator('tr[data-lot]').count(), 0);
        const filterToFullMs = await filterTo(page, 'P');
        assert.equal(await page.locator('tr[data-lot]').count(), count);
        const form = page.getByRole('form', { name: '操作の入力' });
        await page.getByLabel('作業の種類', { exact: true }).selectOption('stock');
        await form.locator('[name=op]').selectOption('register');
        for (const [name, value] of Object.entries({ newId: 'BASE-NEW', item: 'P', location: 'S1', project: 'A-001', basis: 'counted', value: '1' })) {
          const control = form.locator(`[name=${name}]`);
          if (await control.evaluate(node => node.tagName === 'SELECT')) await control.selectOption(value);
          else await control.fill(value);
        }
        await form.locator('[name=occurredAt]').fill('2026-09-29T12:00');
        if (capacity) await page.evaluate(() => { window.__baselineStorageErrors.length = 0; });
        const registerStart = performance.now();
        await form.getByRole('button', { name: '記録する', exact: true }).click();
        if (!capacity) await expect(page.getByRole('status')).toContainText('記録した');
        await paint(page);
        const registerMs = performance.now() - registerStart;
        const status = await page.getByRole('status').textContent();
        const storageFailures = capacity ? await page.evaluate(() => window.__baselineStorageErrors) : [];
        const savedOperation = status.includes('記録した');
        assert.equal(await page.locator('tr[data-lot]').count(), count + (savedOperation ? 1 : 0));
        const savedRaw = await page.evaluate(() => localStorage.getItem(`fuzzy-stock/slot-${localStorage.getItem('fuzzy-stock/head')}`));
        const saved = parse(savedRaw);
        assert.equal(Object.keys(saved.ledger.lots).length, count + (savedOperation ? 1 : 0));
        assert.equal(saved.ledger.history.length, count + (savedOperation ? 1 : 0));
        if (savedOperation) {
          assert.equal(saved.ledger.lots['BASE-NEW'].quantity.kind, 'known');
          assert.equal(saved.ledger.lots['BASE-NEW'].quantity.numeric.value, 1);
          await expect(page.locator('tr[data-lot="BASE-NEW"] td').nth(4)).toHaveText('1個・実数確認');
        } else {
          assert.ok(capacity);
          assert.ok(storageFailures.some(error => error.domException && error.name === 'QuotaExceededError' && error.key.startsWith('fuzzy-stock/')), 'native setItemのQuotaExceededError以外を容量境界として成功にしない');
          assert.equal(savedRaw, entries.find(([key]) => key === 'fuzzy-stock/slot-A')[1], '失敗で元の保存bytesを変えない');
          assert.equal(await form.locator('[name=newId]').inputValue(), 'BASE-NEW');
          assert.equal(await form.locator('[name=value]').inputValue(), '1');
        }
        const row = { ...data, sample, bootMs, filterToEmptyMs: filterMs, filterToFullMs, registerMs, savedOperation, status, storageFailures };
        report.samples.push(row); save(); console.log(JSON.stringify(row));
      } finally { await context.close(); }
    }
  }
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.external, []);
  report.status = 'CHECKS_PASSED'; save();
} catch (error) { report.status = 'FAIL'; report.failure = String(error.stack ?? error); save(); throw error; }
finally {
  const cleanupErrors = [];
  try { if (browser) await browser.close(); }
  catch (error) { cleanupErrors.push(String(error.stack ?? error)); }
  try { await stopOwnedServer(); }
  catch (error) { cleanupErrors.push(String(error.stack ?? error)); }
  if (cleanupErrors.length) {
    report.cleanupErrors = cleanupErrors;
    report.status = 'FAIL';
    process.exitCode = 1;
    console.error(cleanupErrors.join('\n'));
  } else if (report.status === 'CHECKS_PASSED') {
    report.status = 'PASS';
  }
  report.cleanup = { status: cleanupErrors.length ? 'FAIL' : 'PASS' };
  save();
  console.log(`測定資料: ${resultPath}`);
}
