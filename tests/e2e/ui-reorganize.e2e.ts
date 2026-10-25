import { chromium, expect, test, type Page } from '@playwright/test';
import { browserZoomProfile, saveBrowserCapture } from './browser-zoom-profile.mjs';
import { selectOperation, backupButton, bannerText, downloadVia, exportButton, goTo, jsonFile, lot, opLabels, pickFile, record, recorded, startEmpty, storageBytes, usePractice, waitForApp } from './helpers.ts';

test('UI構成基盤: 既存区画と操作を一つずつ配置し、共通入力と上部通知を保つ', async ({ page }) => {
  await page.goto('/');
  await waitForApp(page);
  const pages = {
    stock: ['getting-started', 'list', 'detail', 'production'],
    supply: ['supply', 'case', 'followup', 'consumables'],
    issues: ['issues', 'history'],
    masters: ['masters'],
  };
  for (const [destination, ids] of Object.entries(pages)) {
    await expect(page.locator(`#page-${destination} > section`)).toHaveCount(ids.length);
    for (const id of ids) {
      await expect(page.locator(`#${id}`)).toHaveCount(1);
      await expect(page.locator(`#page-${destination} > #${id}`)).toHaveCount(1);
    }
  }
  await expect(page.locator('#input')).toHaveCount(1);
  await expect(page.locator('#workspace > #input')).toHaveCount(1);
  await expect(page.locator('header #save')).toHaveCount(1);
  await expect(page.locator('header #conflict')).toHaveCount(1);
  await expect(page.locator('nav[aria-label="行き先"] > button')).toHaveCount(5);
  for (const id of ['reset-seed', 'reset-scn02', 'reset-empty', 'backup-save', 'backup-restore', 'view-export']) {
    await expect(page.locator(`#${id}`)).toHaveCount(1);
    await expect(page.locator(`#page-management #${id}`)).toHaveCount(1);
  }
  await expect(page.locator('#about')).toContainText(bannerText);
  await expect(page.locator('header #actor')).toBeVisible();
  await expect(page.locator('header #updated')).toBeVisible();
  await expect(page.locator('#input form')).toBeVisible();
});

async function navigationFixture(page: Page): Promise<void> {
  await page.route('**/dist/ui/main.js', route => route.fulfill({ contentType: 'text/javascript', body: `
    import { navigationOf } from './navigation.js';
    const root = document.getElementById('app');
    const field = document.createElement('input');
    field.id = 'retained-input';
    document.getElementById('input').append(field);
    navigationOf(root);
  ` }));
  await page.goto('/');
  await waitForApp(page);
}

test('保存通知: 種類を文字で添え、既存の保存文言を残す', async ({ page }) => {
  await page.goto('/');
  await waitForApp(page);
  await expect(page.locator('#save [data-tone="info"]')).toContainText('情報');
  await expect(page.locator('#save')).toContainText('記録を入力できます。');
  await usePractice(page);
  await record(page, 'register', lot('ui-notice', 'P', 'S1', 'counted', '1'));
  await expect(page.locator('#save [data-tone="success"]')).toContainText('成功');
  await expect(page.locator('#save')).toContainText('保存した（操作ID：');
});

test('ナビゲーション部品: 五行き先で同一入力を保持し、標準キーで選べる', async ({ page }) => {
  await navigationFixture(page);
  const field = page.locator('#retained-input');
  const original = await field.elementHandle();
  await field.fill('架空の未送信入力');
  for (const destination of ['stock', 'supply', 'issues', 'masters', 'management', 'stock']) {
    const button = page.locator(`#nav-${destination}`);
    await button.focus();
    await page.keyboard.press(destination === 'issues' ? 'Space' : 'Enter');
    await expect(button).toBeFocused();
    await expect(button).toHaveAttribute('aria-current', 'page');
    await expect(button).toHaveCSS('font-weight', '700');
    await expect(button).toHaveCSS('text-decoration-line', 'underline');
    await expect(page.locator('#destinations [aria-current]')).toHaveCount(1);
    for (const other of ['stock', 'supply', 'issues', 'masters', 'management']) {
      await expect(page.locator(`#page-${other}`)).toBeVisible({ visible: other === destination });
    }
    await expect(page.locator('#input')).toBeVisible({ visible: destination !== 'management' });
    await expect(field).toHaveValue('架空の未送信入力');
    expect(await field.evaluate((element, before) => element === before, original)).toBe(true);
  }
  await page.locator('#nav-management').focus();
  await page.keyboard.press('Tab');
  await expect(field).toBeFocused();
  await page.locator('#about-link').click();
  await expect(page.locator('#page-management')).toBeVisible();
  await expect(page.locator('#about-h')).toBeFocused();
  await page.reload();
  await waitForApp(page);
  await expect(page.locator('#nav-stock')).toHaveAttribute('aria-current', 'page');
});

test('ナビゲーション部品: 件数・読取不能・詳細参照を扱い保存へ書き込まない', async ({ page }) => {
  await page.route('**/dist/ui/main.js', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
  await page.goto('/');
  await waitForApp(page);
  const result = await page.evaluate(async () => {
    const moduleUrl = '/dist/ui/navigation.js';
    const { navigationOf }: typeof import('../../src/ui/navigation.ts') = await import(moduleUrl);
    const root = document.getElementById('app');
    if (!root) throw Error('fixture root missing');
    let writes = 0;
    for (const name of ['setItem', 'removeItem', 'clear'] as const) Storage.prototype[name] = () => { writes++; };
    const nav = navigationOf(root);
    const count = root.querySelector('#issue-count');
    nav.setIssueCount(3);
    const countBefore = count?.textContent;
    nav.select({ kind: 'destination', destination: 'supply' });
    nav.select({ kind: 'destination', destination: 'supply' });
    nav.select({ kind: 'detail' });
    const detail = { current: nav.current, focus: document.activeElement?.id };
    nav.setReadable(false);
    const unreadableCount = count?.textContent;
    const hiddenPages = Array.from(root.querySelectorAll('.destination')).filter(node => node instanceof HTMLElement && node.hidden).length;
    nav.select({ kind: 'about' });
    const about = { current: nav.current, focus: document.activeElement?.id };
    nav.setIssueCount(0);
    nav.setReadable(true);
    const zero = count?.textContent;
    let invalidRejected = 0;
    for (const value of [-1, 1.5, NaN, Infinity]) {
      try { nav.setIssueCount(value); } catch { invalidRejected++; }
    }
    return { writes, countBefore, detail, unreadableCount, hiddenPages, about, zero, invalidRejected };
  });
  expect(result).toEqual({ writes: 0, countBefore: '3件', detail: { current: 'stock', focus: 'detail-h' },
    unreadableCount: '件数を確認できない', hiddenPages: 5, about: { current: 'management', focus: 'about-h' }, zero: '0件', invalidRejected: 4 });
});

for (const corruption of ['missing', 'duplicate']) {
  test(`ナビゲーション部品: 必須DOMの${corruption}で起動を止める`, async ({ page }) => {
    await page.route('**/dist/ui/main.js', route => route.fulfill({ contentType: 'text/javascript', body: `
      import { navigationOf } from './navigation.js';
      const root = document.getElementById('app');
      const button = document.getElementById('nav-stock');
      ${corruption === 'missing' ? 'button.remove();' : 'button.after(button.cloneNode(true));'}
      navigationOf(root);
    ` }));
    await page.goto('/');
    await expect(page.locator('#boot')).toContainText('画面を起動できませんでした');
    await expect(page.locator('#app')).toHaveJSProperty('inert', true);
  });
}

async function emptyNavigable(page: Page): Promise<void> {
  await page.goto('/?test');
  await waitForApp(page);
  await page.locator('#nav-management').click();
  await page.getByRole('button', { name: '練習用の台帳で初期化', exact: true }).click();
  await page.getByRole('button', { name: '初期化する', exact: true }).click();
  await page.locator('#nav-stock').click();
}

test('画面統合: 行き先の往復と既存詳細参照で入力・選択・保存を保持する', async ({ page }) => {
  await emptyNavigable(page);
  await expect(await record(page, 'register', lot('nav-lot', 'P', 'S1', 'counted', '5'), '08:00')).toContainText('記録した');
  await expect(await record(page, 'use', { lot: 'nav-lot', basis: 'counted', value: '99', usedFor: '架空の未反映使用' }, '09:00')).toContainText('記録した');
  const form = page.getByRole('form', { name: '操作の入力' });
  await selectOperation(form.locator('[name=op]'), { label: opLabels.use });
  await form.locator('[name=value]').fill('2.5');
  await form.locator('[name=usedFor]').fill('架空の未送信作業');
  await form.locator('[name=occurredAt]').fill('2026-10-18T15:01');
  const original = await form.elementHandle();
  const before = await storageBytes(page);
  const sessionBefore = await page.evaluate(() => Object.fromEntries(Object.keys(sessionStorage).sort().map(key => [key, sessionStorage.getItem(key)])));
  await page.evaluate(() => {
    let count = 0;
    const set = Storage.prototype.setItem, remove = Storage.prototype.removeItem, clear = Storage.prototype.clear;
    Storage.prototype.setItem = function (key, value) { count++; return set.call(this, key, value); };
    Storage.prototype.removeItem = function (key) { count++; return remove.call(this, key); };
    Storage.prototype.clear = function () { count++; return clear.call(this); };
    Object.defineProperty(window, 'navigationWriteCount', { get: () => count });
  });
  for (const destination of ['supply', 'issues', 'masters', 'management', 'stock', 'stock']) {
    await page.locator(`#nav-${destination}`).click();
    await expect(page.locator(`#nav-${destination}`)).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('.destination:visible')).toHaveCount(1);
    await expect(page.locator('#input')).toBeVisible({ visible: destination !== 'management' });
    await expect(page.locator('#actor')).toBeVisible();
    await expect(page.locator('#updated')).toBeVisible();
  }
  await page.locator('#nav-supply').click();
  await page.locator('[name=case-project]').selectOption('A-001');
  await page.locator('#case button[data-lot="nav-lot"]').click();
  await expect(page.locator('#nav-stock')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#detail-h')).toBeFocused();
  await expect(page.locator('#detail')).toContainText('nav-lot');
  await page.locator('#nav-issues').click();
  await page.locator('#issues').getByRole('button', { name: 'nav-lot', exact: true }).click();
  await expect(page.locator('#detail-h')).toBeFocused();
  await expect(form.locator('[name=value]')).toHaveValue('2.5');
  await expect(form.locator('[name=usedFor]')).toHaveValue('架空の未送信作業');
  await expect(form.locator('[name=occurredAt]')).toHaveValue('2026-10-18T15:01');
  expect(await form.evaluate((node, old) => node === old, original)).toBe(true);
  expect(await storageBytes(page)).toEqual(before);
  expect(await page.evaluate(() => Object.fromEntries(Object.keys(sessionStorage).sort().map(key => [key, sessionStorage.getItem(key)])))).toEqual(sessionBefore);
  expect(await page.evaluate(() => Reflect.get(window, 'navigationWriteCount'))).toBe(0);
  await page.reload(); await waitForApp(page);
  await expect(page.locator('#nav-stock')).toHaveAttribute('aria-current', 'page');
});

test('画面統合: 台帳未解消と保存結果不明を数え、照会・解消後も行き先を保つ', async ({ page }) => {
  await emptyNavigable(page);
  await expect(page.locator('#issue-count')).toHaveText('0件');
  await expect(await record(page, 'register', lot('count-lot', 'P', 'S1', 'counted', '5'), '08:00')).toContainText('記録した');
  await page.locator('#nav-issues').click();
  await expect(await record(page, 'use', { lot: 'count-lot', basis: 'counted', value: '99', usedFor: '架空の未反映使用' }, '09:00')).toContainText('記録した');
  await expect(page.locator('#nav-issues')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#issue-count')).toHaveText('1件');
  const issue = await page.locator('#issues tr[data-issue]').getAttribute('data-issue');
  if (!issue) throw Error('確認事項が必要');
  await page.evaluate(() => { if (!window.fuzzyStockTest) throw Error('保存障害フックが必要'); window.fuzzyStockTest.loseResponseAt(1); });
  await record(page, 'use', { lot: 'count-lot', basis: 'counted', value: '1', usedFor: '架空の保存結果不明' }, '10:00');
  await expect(page.locator('#issue-count')).toHaveText('2件');
  await expect(page.locator('#issues tr[data-save-issue]')).toHaveCount(1);
  for (const destination of ['stock', 'supply', 'masters', 'management', 'issues']) {
    await page.locator(`#nav-${destination}`).click();
    await expect(page.locator('#save')).toContainText('保存結果不明');
    await expect(page.locator('#issue-count')).toHaveText('2件');
  }
  await page.getByRole('button', { name: '照会する', exact: true }).click();
  await page.getByRole('button', { name: '保存済みとして確定する', exact: true }).click();
  await expect(page.locator('#nav-issues')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#issue-count')).toHaveText('1件');
  await expect(await record(page, 'resolve', { issue, outcome: 'close' }, '11:00')).toContainText('数えてから閉じる');
  await expect(page.locator('#issue-count')).toHaveText('1件');
  await expect(await record(page, 'recount', { lot: 'count-lot', value: '4', causeUnknown: true }, '11:30')).toContainText('記録した');
  await expect(await record(page, 'resolve', { issue, outcome: 'close' }, '12:00')).toContainText('記録した');
  await expect(page.locator('#issue-count')).toHaveText('0件');
  await expect(page.locator('#issues')).toContainText('解消済み');
});

test('画面統合: 読取不能でも上部情報と回復を残し、古い台帳と件数を表示しない', async ({ page }) => {
  await emptyNavigable(page);
  await page.evaluate(() => localStorage.setItem('fuzzy-stock/head', '架空の破損'));
  await page.reload(); await waitForApp(page);
  const before = await storageBytes(page);
  for (const destination of ['stock', 'supply', 'issues', 'masters', 'management']) {
    await page.locator(`#nav-${destination}`).click();
    await expect(page.locator('#actor')).toBeVisible();
    await expect(page.locator('#actor')).toBeDisabled();
    await expect(page.locator('#actor-unavailable')).toBeVisible();
    await expect(page.locator('#updated')).toContainText('確認できません');
    await expect(page.locator('#issue-count')).toHaveText('件数を確認できない');
    await expect(page.locator('#save').getByRole('button', { name: '保存された記録を消して初期化する', exact: true })).toBeVisible();
    await expect(page.locator('#list')).toBeHidden();
    await expect(page.locator('#input')).toBeVisible({ visible: destination !== 'management' });
    await expect(page.getByRole('form', { name: '操作の入力' })).toHaveCount(0);
    if (destination === 'management') await expect(page.locator('#about')).toBeVisible();
    else await expect(page.locator('#unreadable-content')).toBeVisible();
  }
  expect(await storageBytes(page)).toEqual(before);
});

test('管理確認: 管理内で確認・取消・確定し、取消後は同じ表示元へフォーカスを戻す', async ({ page }) => {
  await page.goto('/'); await waitForApp(page);
  await page.locator('#nav-management').click();
  const before = await storageBytes(page);
  await page.locator('#reset-empty').click();
  const confirmation = page.locator('#management-feedback').getByRole('region', { name: '初期化の確認' });
  await expect(confirmation).toContainText('空の台帳で置き換わる');
  await expect(page.locator('#save').getByRole('region', { name: '初期化の確認' })).toHaveCount(0);
  expect(await storageBytes(page)).toEqual(before);
  await confirmation.getByRole('button', { name: 'やめる', exact: true }).click();
  await expect(page.locator('#management-feedback-h')).toBeFocused();
  expect(await storageBytes(page)).toEqual(before);
  await page.locator('#reset-empty').click();
  await confirmation.getByRole('button', { name: '初期化する', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(page.locator('#nav-management')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#management-feedback-h')).toBeFocused();
  expect(await storageBytes(page)).not.toEqual(before);
});

test('管理確認: 回復確認と管理拒否が別々の場所に残り、遅延出力も管理へ通知する', async ({ page }) => {
  await emptyNavigable(page);
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const requested = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/dist/ui/xlsx.js', async route => { started(); await released; await route.continue(); });
  await page.locator('#nav-management').click();
  await page.locator('#view-export').click(); await requested;
  await page.evaluate(() => localStorage.setItem('fuzzy-stock/head', '架空の破損'));
  await page.locator('#backup-save').click();
  const before = await storageBytes(page);
  await page.locator('#save').getByRole('button', { name: '保存された記録を消して初期化する', exact: true }).click();
  const recovery = page.locator('#save').getByRole('region', { name: '初期化の確認' });
  await page.locator('#backup-save').click();
  await expect(recovery).toBeVisible();
  await expect(page.locator('#management-feedback .notice')).toContainText('バックアップを作れない');
  await expect(page.locator('#management-feedback').getByRole('region', { name: '初期化の確認' })).toHaveCount(0);
  await page.locator('#nav-stock').click();
  const downloaded = page.waitForEvent('download');
  release(); await downloaded;
  await expect(recovery).toBeVisible();
  await expect(page.locator('#save .notice')).toHaveCount(0);
  await page.locator('#nav-management').click();
  await expect(page.locator('#management-feedback .notice')).toContainText('閲覧用の出力を書き出した');
  await expect(recovery).toBeVisible();
  expect(await storageBytes(page)).toEqual(before);
  await recovery.getByRole('button', { name: 'やめる', exact: true }).click();
  await expect(page.locator('#save-h')).toBeFocused();
});

test('管理確認: 復元ファイルの拒否は選び始めた表示元へ残す', async ({ page }) => {
  await emptyNavigable(page);
  for (const recovery of [false, true]) {
    if (recovery) {
      await page.evaluate(() => localStorage.setItem('fuzzy-stock/head', '架空の破損'));
      await page.reload(); await waitForApp(page);
    } else await page.locator('#nav-management').click();
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), recovery
      ? page.locator('#save').getByRole('button', { name: 'バックアップから復元する', exact: true }).click()
      : page.locator('#backup-restore').click()]);
    const before = await storageBytes(page);
    await chooser.setFiles(jsonFile('架空の壊れた記録.json', '{'));
    await expect(page.locator(`${recovery ? '#save' : '#management-feedback'} .notice`)).toContainText('復元に使えない');
    await expect(page.locator(`${recovery ? '#management-feedback' : '#save'} .notice`)).toHaveCount(0);
    expect(await storageBytes(page)).toEqual(before);
  }
});

test('表示統合: 平常時だけ一行にし、保存結果不明と確認を移動で作り直さない', async ({ page }) => {
  await page.goto('/?test'); await waitForApp(page);
  const save = page.locator('#save');
  await expect(save).toHaveClass('save-compact');
  const compact = await save.evaluate(node => ({ height: node.getBoundingClientRect().height, line: parseFloat(getComputedStyle(node).lineHeight) }));
  expect(compact.height).toBeLessThanOrEqual(compact.line + 2);
  await expect(page.locator('#save .save-tone')).toBeHidden();
  await expect(page.getByRole('heading', { name: '保存の状態', exact: true })).toHaveCount(1);
  await page.locator('#nav-management').click(); await page.locator('#reset-empty').click();
  await expect(save).not.toHaveClass('save-compact');
  await page.getByRole('region', { name: '初期化の確認' }).getByRole('button', { name: 'やめる' }).click();
  await expect(save).toHaveClass('save-compact');
  await usePractice(page);
  await record(page, 'register', lot('notice-format', 'P', 'S1', 'counted', '2'), '08:00');
  await expect(page.locator('#save [data-tone=success]')).toHaveCSS('border-top-style', 'solid');
  await page.evaluate(() => { if (!window.fuzzyStockTest) throw Error('障害フックが必要'); window.fuzzyStockTest.loseResponseAt(1); });
  await record(page, 'use', { lot: 'notice-format', basis: 'counted', value: '1', usedFor: '架空の試験' }, '09:00');
  const panel = page.locator('#save .save-notice');
  const original = await panel.elementHandle();
  await expect(panel).toHaveAttribute('aria-live', 'polite');
  await expect(panel).toHaveCSS('border-top-style', 'double');
  await expect(panel.locator('.save-tone')).toHaveText('エラー');
  for (const destination of ['supply', 'issues', 'masters', 'management', 'stock']) {
    await page.locator(`#nav-${destination}`).click();
    await expect(save).not.toHaveClass('save-compact');
    await expect(panel).toContainText('保存結果不明');
    expect(await panel.evaluate((node, previous) => node === previous, original)).toBe(true);
  }
});

test('表示統合: 長い原文と動的な表を保ち、狭幅ではページを横に溢れさせない', async ({ page }) => {
  await emptyNavigable(page);
  const id = '架空LONG'.repeat(24);
  await record(page, 'register', lot(id, 'P', 'S1', 'counted', '2'), '08:00');
  await record(page, 'declare', { lot: id, note: '架空の長い原文'.repeat(60) }, '09:00');
  await page.locator('#list [name=f-item]').selectOption('P');
  await expect(page.locator('#list .table-scroll > table')).toHaveCount(1);
  await expect(page.locator('.table-scroll .table-scroll')).toHaveCount(0);
  for (const width of [1400, 901, 900, 899, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const destination of ['stock', 'supply', 'issues', 'masters', 'management']) {
      await page.locator(`#nav-${destination}`).click();
      const measured = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
      expect(measured.scroll, `${width}px ${destination}`).toBeLessThanOrEqual(measured.width);
      if (destination === 'stock') await page.screenshot({ path: `.local-logs/ui-reorganize/task4.3-stock-${width}.png` });
      if (destination !== 'management') {
        const layout = await page.evaluate(current => {
          const body = document.getElementById(`page-${current}`)!.getBoundingClientRect();
          const input = document.getElementById('input')!.getBoundingClientRect();
          return { bodyX: body.x, bodyRight: body.right, bodyBottom: body.bottom, inputX: input.x, inputY: input.y };
        }, destination);
        if (width <= 900) { expect(layout.inputX).toBe(layout.bodyX); expect(layout.inputY).toBeGreaterThanOrEqual(layout.bodyBottom); }
        else expect(layout.inputX).toBeGreaterThan(layout.bodyRight);
      }
    }
    const note = await page.locator('.prototype-note p').evaluate(node => ({ height: node.getBoundingClientRect().height, line: parseFloat(getComputedStyle(node).lineHeight) }));
    expect(note.height).toBeLessThanOrEqual(note.line);
  }
  expect(await page.locator('#workspace table').evaluateAll(tables => tables.every(table => table.parentElement?.classList.contains('table-scroll')))).toBe(true);
  await page.locator('#nav-issues').click();
  await expect(page.locator('#issues')).toContainText('架空の長い原文'.repeat(60));
});

test('表示統合: 記録と管理の強調を分け、強制配色でも枠とフォーカスを残す', async ({ page }) => {
  await page.goto('/'); await waitForApp(page);
  const recordButton = page.locator('#input button[type=submit]');
  await expect(recordButton).toHaveCSS('background-color', 'rgb(36, 87, 197)');
  await expect(recordButton).toHaveCSS('color', 'rgb(255, 255, 255)');
  await page.locator('#nav-management').click();
  await expect(page.locator('#reset-empty')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await page.locator('#reset-empty').click();
  await expect(page.getByRole('button', { name: '初期化する', exact: true })).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await page.emulateMedia({ forcedColors: 'active' });
  await page.locator('#nav-stock').focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#nav-stock')).toHaveCSS('outline-style', 'solid');
  await expect(page.locator('#nav-stock')).toHaveCSS('outline-width', '3px');
  await expect(page.locator('#nav-stock')).toHaveCSS('text-decoration-line', 'underline');
  const colors = await recordButton.evaluate(node => ({ background: getComputedStyle(node).backgroundColor, foreground: getComputedStyle(node).color }));
  expect(colors.background).not.toBe(colors.foreground);
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ forcedColors: 'active', colorScheme });
    await recordButton.hover();
    const hovered = await recordButton.evaluate(node => ({ background: getComputedStyle(node).backgroundColor, foreground: getComputedStyle(node).color }));
    expect(contrastOf(hovered.foreground, hovered.background), `${colorScheme} forced-colors hover`).toBeGreaterThanOrEqual(4.5);
  }
  await expect(page.locator('#save .save-notice')).toHaveCSS('border-top-style', 'dashed');
  await page.screenshot({ path: '.local-logs/ui-reorganize/task4.3-forced-colors.png' });
});

test('表示統合: 回復初期化に成功した後も、一行の通知内にフォーカスが見える', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await emptyNavigable(page);
  await page.evaluate(() => localStorage.setItem('fuzzy-stock/head', '架空の破損'));
  await page.reload(); await waitForApp(page);
  await page.locator('#save').getByRole('button', { name: '保存された記録を消して初期化する', exact: true }).click();
  await page.locator('#save').getByRole('button', { name: '初期化する', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#save-h')).toBeFocused();
  await expect(page.locator('#save')).toHaveClass('save-compact');
  const focused = await page.locator('#save-h').evaluate(node => ({
    width: node.getBoundingClientRect().width, clip: getComputedStyle(node).clipPath,
    outline: getComputedStyle(node).outlineStyle,
  }));
  expect(focused.width).toBeGreaterThan(40);
  expect(focused.clip).toBe('none');
  expect(focused.outline).toBe('solid');
  const notice = await page.locator('#save').evaluate(node => ({ height: node.getBoundingClientRect().height, line: parseFloat(getComputedStyle(node).lineHeight) }));
  expect(notice.height).toBeLessThanOrEqual(notice.line + 2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await page.screenshot({ path: '.local-logs/ui-reorganize/task4.3-recovered-focus.png' });
});

test('共通手順: 管理操作をメニューから行い、記録は現在の行き先に留まる', async ({ page }) => {
  await startEmpty(page);
  await expect(page.locator('#nav-stock')).toHaveAttribute('aria-current', 'page');
  await expect(await record(page, 'register', lot('helper-lot', 'P', 'S1', 'counted', '8'), '08:00')).toContainText('記録した');
  const before = await storageBytes(page);
  const backup = await downloadVia(page, backupButton);
  await expect(page.locator('#nav-management')).toHaveAttribute('aria-current', 'page');
  expect(await storageBytes(page)).toEqual(before);
  await goTo(page, 'supply');
  await expect(await record(page, 'declare', { lot: 'helper-lot', note: '架空の差異' }, '09:00')).toContainText('記録した');
  await expect(page.locator('#nav-supply')).toHaveAttribute('aria-current', 'page');
  await pickFile(page, backup.path);
  await expect(page.locator('#nav-management')).toHaveAttribute('aria-current', 'page');
  await page.locator('#management-feedback').getByRole('button', { name: '復元する', exact: true }).click();
  await expect(page.locator('#nav-management')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#input')).toBeHidden();
  await expect(page.locator('#management-feedback .notice')).toBeVisible();
  await expect(page.locator('#management-feedback .notice')).toContainText('復元した（');
  await expect(page.locator('#management-feedback .notice')).toHaveAttribute('aria-live', 'polite');
  await expect(page.locator('#save .notice')).toHaveCount(0);
  await goTo(page, 'stock');
  await expect(page.locator('#list tr[data-lot="helper-lot"]')).toContainText('8個・数えた');
  const output = await downloadVia(page, exportButton);
  expect(output.name).toContain('閲覧用_復元不可');
  await expect(page.locator('#nav-management')).toHaveAttribute('aria-current', 'page');
  await page.evaluate(() => localStorage.setItem('fuzzy-stock/head', '架空の破損'));
  await page.reload(); await waitForApp(page);
  const unreadable = await storageBytes(page);
  await pickFile(page, jsonFile('架空.json', '{'), 'バックアップから復元する');
  await expect(page.locator('#save .notice')).toContainText('復元に使えない');
  await expect(page.locator('#nav-stock')).toHaveAttribute('aria-current', 'page');
  expect(await storageBytes(page)).toEqual(unreadable);
});

const destinations = ['stock', 'supply', 'issues', 'masters', 'management'] as const;

async function navigationState(page: Page) {
  return page.locator('#workspace').evaluate(root => ({
    controls: Array.from(root.querySelectorAll('input, select, textarea')).map(node => {
      if (!(node instanceof HTMLInputElement || node instanceof HTMLSelectElement || node instanceof HTMLTextAreaElement)) throw Error('入力要素が必要');
      return { name: node.name, value: node.value, checked: node instanceof HTMLInputElement && node.checked };
    }),
    selectedLot: root.querySelector('#list tr.selected')?.getAttribute('data-lot'),
    views: ['detail', 'case', 'masters'].map(id => root.querySelector(`#${id}`)?.textContent),
    candidates: root.querySelector('[data-code-options]')?.textContent,
    holds: root.querySelector('[data-code-holds]')?.textContent,
  }));
}

async function assertNavigationRetainsState(page: Page): Promise<void> {
  const before = await navigationState(page);
  const original = await page.locator('#input').evaluateHandle(root => Array.from(root.querySelectorAll('form, input, select, textarea')));
  const observer = await page.evaluateHandle(() => {
    const bytes = () => [localStorage, sessionStorage].map(storage => Object.fromEntries(Object.keys(storage).sort().map(key => [key, storage.getItem(key)])));
    const beforeBytes = bytes();
    let writes = 0;
    const set = Storage.prototype.setItem, remove = Storage.prototype.removeItem, clear = Storage.prototype.clear;
    Storage.prototype.setItem = function (key, value) { writes++; return set.call(this, key, value); };
    Storage.prototype.removeItem = function (key) { writes++; return remove.call(this, key); };
    Storage.prototype.clear = function () { writes++; return clear.call(this); };
    return {
      read: () => ({ writes, beforeBytes, afterBytes: bytes() }),
      restore: () => { Storage.prototype.setItem = set; Storage.prototype.removeItem = remove; Storage.prototype.clear = clear; },
    };
  });
  try {
    for (const destination of destinations) {
      await goTo(page, destination); await goTo(page, destination);
      expect(await navigationState(page)).toEqual(before);
      await expect(page.locator('#input')).toBeVisible({ visible: destination !== 'management' });
      expect(await page.locator('#input').evaluate((root, nodes) => {
        const current = Array.from(root.querySelectorAll('form, input, select, textarea'));
        return current.length === nodes.length && current.every((node, i) => node === nodes[i]);
      }, original)).toBe(true);
    }
    await page.locator('#about-link').click();
    await expect(page.locator('#about-h')).toBeFocused();
    expect(await navigationState(page)).toEqual(before);
    await goTo(page, 'stock');
    const result = await observer.evaluate(value => value.read());
    expect(result.writes).toBe(0);
    expect(result.afterBytes).toEqual(result.beforeBytes);
  } finally {
    await observer.evaluate(value => value.restore());
    await observer.dispose(); await original.dispose();
  }
}

test('受け取り6.1: 不明・コード候補・保持案件・用途場所・選択と各表示フィルターを往復して保持する', async ({ page }) => {
  await emptyNavigable(page);
  for (const id of ['retain-one', 'retain-two']) await recorded(page, 'register', lot(id, 'P', 'S1', 'counted', '5'), '08:00');
  await page.locator('#list [name=f-item]').selectOption('P');
  await page.locator('#list [name=f-project]').selectOption('A-001');
  await page.locator('#list [name=f-location]').selectOption('S1');
  await page.locator('#list tr[data-lot="retain-two"]').getByRole('button', { name: 'retain-two', exact: true }).click();
  await expect(page.locator('#list tr.selected')).toHaveAttribute('data-lot', 'retain-two');
  await goTo(page, 'supply');
  await page.locator('#case [name=case-project]').selectOption('B-001');
  await page.locator('[name=asOf]').fill('2026-10-18');
  await page.locator('[name=asOf]').dispatchEvent('change');
  await goTo(page, 'masters');
  await page.locator('[name=master-history]').selectOption('case:A-001');
  const form = page.locator('#input form');
  await selectOperation(form.locator('[name=op]'), { label: opLabels.receive });
  await form.locator('[name=project]').selectOption('B-001');
  await form.locator('[name=location]').selectOption('S2');
  const code = page.getByRole('region', { name: 'コード入力補助' });
  await code.getByRole('button', { name: '現在の案件・用途を保持', exact: true }).click();
  await code.getByRole('button', { name: '現在の場所を保持', exact: true }).click();
  await selectOperation(form.locator('[name=op]'), { label: opLabels.use });
  await code.getByLabel('読取原文・品目ID').fill('P~A-001~LABB');
  await code.getByRole('button', { name: '解釈', exact: true }).click();
  await code.getByLabel('コードの入力先').selectOption('lot');
  await expect(code.locator('[data-code-options] button')).toHaveCount(2);
  await code.getByLabel('名称・品番・コードで検索').fill('架空の検索途中');
  await form.locator('[name=basis]').selectOption('unknown');
  await form.locator('[name=occurredUnknown]').check();
  await expect(code.locator('[data-code-holds]')).toContainText('B-001');
  await expect(code.locator('[data-code-holds]')).toContainText('S2');
  await assertNavigationRetainsState(page);
});

test('受け取り6.1: 包含回答・数量日時と原因不明チェックを未送信のまま保持する', async ({ page }) => {
  await emptyNavigable(page);
  await recorded(page, 'register', lot('retain-answer', 'P', 'S1', 'counted', '8'), '09:00');
  await expect(await record(page, 'use', { lot: 'retain-answer', basis: 'counted', value: '3', usedFor: '架空の過去使用' }, '08:00')).toContainText('回答が必要');
  const form = page.locator('#input form');
  await form.locator('[name=inclusion]').selectOption('included');
  await assertNavigationRetainsState(page);
  await expect(form.locator('[name=inclusion]')).toHaveValue('included');
  await expect(form.locator('[name=value]')).toHaveValue('3');
  await expect(form.locator('[name=occurredAt]')).toHaveValue('2026-09-29T08:00');
  await selectOperation(form.locator('[name=op]'), { label: opLabels.recount });
  await form.locator('[name=lot]').selectOption('retain-answer');
  await form.locator('[name=value]').fill('7');
  await form.locator('[name=causeUnknown]').check();
  await assertNavigationRetainsState(page);
  await expect(form.locator('[name=causeUnknown]')).toBeChecked();
});

test('受け取り6.1: 衝突を確認したチェックを画面移動だけでは失効させない', async ({ page }) => {
  await emptyNavigable(page);
  await recorded(page, 'masterItem', { codeNone: true, name: '架空の仮品目', units: '個' }, '08:00');
  await record(page, 'masterCode', { target: '品目（仮）架空の仮品目「架空の仮品目」', code: 'Q', reason: '架空の正式ID判明' }, '09:00');
  const confirmed = page.locator('#input [name=confirmed]');
  await expect(confirmed).toBeVisible();
  await confirmed.check();
  await assertNavigationRetainsState(page);
  await expect(confirmed).toBeChecked();
});

for (const mode of ['partial', 'unknown-first', 'unknown-all'] as const) {
  test(`受け取り6.1: ${mode}の保存単位数と未解消件数を混同しない`, async ({ page }) => {
    await emptyNavigable(page);
    const request = { project: 'A-001', item: 'P', quantity: '4', vendor: '架空仕入先', requestedOn: '2026-09-29', replyKind: 'none' };
    await recorded(page, 'requestRecord', request);
    await recorded(page, 'requestRecord', request);
    await page.evaluate(value => {
      if (!window.fuzzyStockTest) throw Error('障害フックが必要');
      if (value === 'partial') window.fuzzyStockTest.failMidwayAt(3);
      else if (value === 'unknown-all') window.fuzzyStockTest.loseResponseAt(1);
      else {
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, text) {
          original.call(this, key, text);
          if (key === 'fuzzy-stock/head') {
            Storage.prototype.setItem = original;
            throw Error('架空の第一単位保存直後の応答喪失');
          }
        };
      }
    }, mode);
    await record(page, 'receive', lot('count-three', 'P', 'S1', 'counted', '8', {
      r1request: 'op1', r1arrived: '4', r1good: '4', r2request: 'op2', r2arrived: '4', r2good: '4',
    }));
    const count = mode === 'partial' ? 0 : 1;
    for (const destination of destinations) {
      await goTo(page, destination);
      await expect(page.locator('#issue-count')).toHaveText(`${count}件`);
    }
    await goTo(page, 'issues');
    await expect(page.locator('#issues tr[data-save-issue]').filter({ has: page.locator('td:nth-child(2)', { hasText: '確認が必要（未解決）' }) })).toHaveCount(count);
    await expect(page.locator('#issues tr[data-issue]')).toHaveCount(0);
    const beforeInquiry = await storageBytes(page);
    await page.locator('#save').getByRole('button', { name: '照会する', exact: true }).click();
    await expect(page.locator('#save')).toContainText(`3単位中${mode === 'partial' ? 2 : mode === 'unknown-first' ? 1 : 3}単位が保存済み`);
    expect(await storageBytes(page)).toEqual(beforeInquiry);
    await expect(page.locator('#issue-count')).toHaveText(`${count}件`);
    await page.locator('#save').getByRole('button', { name: mode === 'partial' ? '記録し直す' : '再試行する', exact: true }).click();
    await expect(page.locator('#issue-count')).toHaveText('0件');
    await expect(page.locator('#issues tr[data-save-issue]').filter({ has: page.locator('td:nth-child(2)', { hasText: '確認が必要（未解決）' }) })).toHaveCount(0);
  });
}

for (const reset of [
  { id: 'reset-empty', description: '空の台帳', lots: [] },
  { id: 'reset-seed', description: '固定の架空データ', lots: ['0012', 'P-001', 'P-001-D', 'P-002', 'P-003', 'P-004', 'Q-002', 'R-001', 'S-001', 'S-002'] },
  { id: 'reset-scn02', description: 'SCN-02の架空データ', lots: ['P-B01'] },
]) test(`受け取り6.2: ${reset.description}の確認・取消・明示確定を管理内で行う`, async ({ page }) => {
  await emptyNavigable(page);
  await recorded(page, 'register', lot('before-reset', 'P', 'S1', 'counted', '3'));
  await goTo(page, 'management');
  const before = await storageBytes(page);
  const confirmation = page.locator('#management-feedback [role=region][aria-label="初期化の確認"]');
  await page.locator(`#${reset.id}`).click();
  await expect(confirmation).toContainText(`${reset.description}で置き換わる`);
  expect(await storageBytes(page)).toEqual(before);
  await confirmation.getByRole('button', { name: 'やめる', exact: true }).click();
  expect(await storageBytes(page)).toEqual(before);
  await expect(page.locator('#management-feedback-h')).toBeFocused();
  await page.locator(`#${reset.id}`).click();
  await confirmation.getByRole('button', { name: '初期化する', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(page.locator('#nav-management')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#input')).toBeHidden();
  await expect(page.locator('#management-feedback .notice')).toBeVisible();
  await expect(page.locator('#management-feedback .notice')).toHaveText('初期化した');
  await expect(page.locator('#management-feedback .notice')).toHaveAttribute('aria-live', 'polite');
  await expect(page.locator('#save .notice')).toHaveCount(0);
  expect(await storageBytes(page)).not.toEqual(before);
  await goTo(page, 'stock');
  expect(await page.locator('#list tr[data-lot]').evaluateAll(rows => rows.map(row => row.getAttribute('data-lot')).sort())).toEqual(reset.lots);
});

for (const state of ['success', 'failed', 'partial', 'stale'] as const) {
  test(`受け取り6.2: ${state}の文言・操作・通知要素は全行き先で同じまま見える`, async ({ page, context }) => {
    await emptyNavigable(page);
    if (state === 'partial') {
      const request = { project: 'A-001', item: 'P', quantity: '4', vendor: '架空仕入先', requestedOn: '2026-09-29', replyKind: 'none' };
      await recorded(page, 'requestRecord', request); await recorded(page, 'requestRecord', request);
      await page.evaluate(() => window.fuzzyStockTest!.failMidwayAt(3));
      await record(page, 'receive', lot('global-partial', 'P', 'S1', 'counted', '8', { r1request: 'op1', r1arrived: '4', r1good: '4', r2request: 'op2', r2arrived: '4', r2good: '4' }));
    } else if (state === 'stale') {
      await page.locator('#input [name=newId]').fill('架空の退避する入力');
      const other = await context.newPage();
      await other.goto('/'); await waitForApp(other);
      await recorded(other, 'register', lot('external-write', 'P', 'S1', 'counted', '1'));
      await expect(page.locator('#save')).toContainText('別の画面で記録が保存された');
    } else {
      if (state === 'failed') await page.evaluate(() => window.fuzzyStockTest!.failMidwayAt(1));
      await record(page, 'register', lot('global-save', 'P', 'S1', 'counted', '1'));
    }
    const message = { success: '保存した', failed: '保存できなかった', partial: '一部だけ保存した', stale: '別の画面で記録が保存された' }[state];
    const tone = { success: 'success', failed: 'error', partial: 'warning', stale: 'warning' }[state];
    const panel = page.locator('#save .save-notice');
    await expect(panel).toContainText(message);
    await expect(panel).toHaveAttribute('data-tone', tone);
    const original = await panel.elementHandle();
    const text = await panel.innerText();
    const actions = await panel.getByRole('button').allTextContents();
    const before = await storageBytes(page);
    for (const destination of destinations) {
      await goTo(page, destination);
      await expect(panel).toBeVisible();
      await expect(panel).toHaveText(text, { useInnerText: true });
      expect(await panel.evaluate((node, old) => node === old, original)).toBe(true);
      for (const name of actions) await expect(panel.getByRole('button', { name, exact: true })).toBeVisible();
      if (state === 'stale') { await expect(page.locator('#conflict')).toBeVisible(); await expect(page.locator('#issue-count')).toHaveText('0件'); }
    }
    expect(await storageBytes(page)).toEqual(before);
    if (state === 'partial' || state === 'stale') {
      for (const id of ['reset-empty', 'reset-seed', 'reset-scn02', 'backup-save', 'backup-restore']) {
        await page.locator(`#${id}`).click();
        await expect(page.locator('#management-feedback')).toContainText(state === 'partial' ? /未完了|一部|残っている/ : /別の画面|更新競合/);
        await expect(page.locator('#management-feedback').getByRole('button', { name: /^(初期化する|復元する)$/ })).toHaveCount(0);
        expect(await storageBytes(page)).toEqual(before);
      }
    }
  });
}

for (const destination of destinations) test(`受け取り6.2: ${destination}に留まって保存結果不明を照会・再試行できる`, async ({ page }) => {
  await emptyNavigable(page);
  await page.evaluate(() => window.fuzzyStockTest!.loseResponseAt(1));
  await record(page, 'register', lot('unknown-action', 'P', 'S1', 'counted', '3'));
  await goTo(page, destination);
  const before = await storageBytes(page);
  await expect(page.locator('#save')).toContainText('保存結果不明');
  if (destination === 'management') {
    for (const id of ['reset-empty', 'reset-seed', 'reset-scn02', 'backup-save', 'backup-restore']) {
      await page.locator(`#${id}`).click();
      await expect(page.locator('#management-feedback')).toContainText(/未完了|保存結果不明|残っている/);
      expect(await storageBytes(page)).toEqual(before);
    }
  }
  await page.locator('#save').getByRole('button', { name: '照会する', exact: true }).click();
  expect(await storageBytes(page)).toEqual(before);
  await expect(page.locator(`#nav-${destination}`)).toHaveAttribute('aria-current', 'page');
  await page.locator('#save').getByRole('button', { name: '再試行する', exact: true }).click();
  await expect(page.locator('#save')).toContainText('保存済みだった');
  await expect(page.locator(`#nav-${destination}`)).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#issue-count')).toHaveText('0件');
});

async function delayRestore(page: Page): Promise<void> {
  await page.evaluate(() => {
    const read = File.prototype.arrayBuffer;
    const release = new Promise<void>(resolve => window.addEventListener('release-ui-restore', () => resolve(), { once: true }));
    File.prototype.arrayBuffer = async function () {
      const bytes = await read.call(this);
      if (this.name === 'delayed-ui.json') {
        document.documentElement.dataset.restoreWaiting = 'true';
        await release;
      }
      return bytes;
    };
  });
}

for (const recovery of [false, true]) for (const action of ['continue', 'cancel', 'reselect', 'external'] as const) {
  test(`受け取り6.2: ${recovery ? '上部回復' : '管理'}の読込中に移動して${action}しても確認の場所と寿命を保つ`, async ({ page, context }) => {
    await emptyNavigable(page);
    await recorded(page, 'register', lot('restore-first', 'P', 'S1', 'counted', '1'));
    const first = await downloadVia(page, backupButton);
    await goTo(page, 'stock');
    await recorded(page, 'register', lot('restore-second', 'P', 'S1', 'counted', '2'));
    const second = await downloadVia(page, backupButton);
    if (recovery) {
      await page.evaluate(() => localStorage.setItem('fuzzy-stock/head', '架空の破損'));
      await page.reload(); await waitForApp(page);
    }
    const button = recovery ? 'バックアップから復元する' : 'バックアップから復元';
    const origin = recovery ? '#save' : '#management-feedback';
    const opposite = recovery ? '#management-feedback' : '#save';
    const confirmation = page.locator(`${origin} [role=region][aria-label="復元の確認"]`);
    const allConfirmations = page.locator('#app [role=region][aria-label="復元の確認"]');
    await delayRestore(page);
    await pickFile(page, jsonFile('delayed-ui.json', new TextDecoder().decode(first.bytes)), button);
    await expect(page.locator('html')).toHaveAttribute('data-restore-waiting', 'true');
    await goTo(page, 'issues');
    if (action === 'cancel') {
      if (!recovery) await goTo(page, 'management');
      const chooser = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: button, exact: true }).click(); await chooser;
      await page.locator('#backup-file').dispatchEvent('cancel');
      await goTo(page, 'issues');
    } else if (action === 'reselect') {
      await pickFile(page, jsonFile('new-ui.json', new TextDecoder().decode(second.bytes)), button);
      await expect(confirmation).toContainText('保管単位2件');
      await goTo(page, 'issues');
    } else if (action === 'external') {
      const other = await context.newPage();
      await other.goto('/'); await waitForApp(other);
      if (recovery) {
        await other.locator('#save').getByRole('button', { name: '保存された記録を消して初期化する', exact: true }).click();
        await other.locator('#save').getByRole('button', { name: '初期化する', exact: true }).click();
      } else await recorded(other, 'register', lot('restore-external', 'P', 'S1', 'counted', '4'));
      await expect(page.locator('#save')).toContainText('別の画面で記録が保存された');
    }
    const beforeRelease = await storageBytes(page);
    await page.evaluate(async () => {
      window.dispatchEvent(new Event('release-ui-restore'));
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    });
    expect(await storageBytes(page)).toEqual(beforeRelease);
    await expect(page.locator(`${opposite} [role=region][aria-label="復元の確認"]`)).toHaveCount(0);
    if (action === 'cancel' || action === 'external') {
      await expect(allConfirmations).toHaveCount(0);
    } else {
      if (!recovery) { await expect(confirmation).toBeHidden(); await goTo(page, 'management'); }
      await expect(confirmation).toBeVisible();
      await expect(confirmation).toContainText(action === 'continue' ? '保管単位1件' : '保管単位2件');
      await confirmation.getByRole('button', { name: '復元する', exact: true }).click();
      await expect(allConfirmations).toHaveCount(0);
      await goTo(page, 'stock');
      await expect(page.locator('#list tr[data-lot="restore-first"]')).toBeVisible();
      await expect(page.locator('#list tr[data-lot="restore-second"]')).toHaveCount(action === 'continue' ? 0 : 1);
    }
  });
}

test('受け取り6.2: 置換結果不明の理由と再読込操作を全行き先で残す', async ({ page }) => {
  await emptyNavigable(page);
  await goTo(page, 'management'); await page.locator('#reset-seed').click();
  await page.evaluate(() => {
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      write.call(this, key, value);
      if (key === 'fuzzy-stock/head') {
        Storage.prototype.getItem = () => { throw Error('架空の読戻し失敗'); };
        throw Error('架空の置換応答喪失');
      }
    };
  });
  await page.locator('#management-feedback').getByRole('button', { name: '初期化する', exact: true }).click();
  for (const destination of destinations) {
    await goTo(page, destination);
    await expect(page.locator('#save .save-notice')).toHaveAttribute('data-tone', 'error');
    await expect(page.locator('#save')).toContainText('復元の途中で保存先の状態を確かめられなくなった');
    await expect(page.locator('#save')).toContainText('架空の置換応答喪失');
    await expect(page.locator('#save').getByRole('button', { name: '再読込する', exact: true })).toBeVisible();
    await expect(page.locator('#app [role=region][aria-label="初期化の確認"]')).toHaveCount(0);
  }
});

test('受け取り6.3: 各行き先の全操作へTabで届き、非表示領域には中断しない', async ({ page }) => {
  await page.goto('/'); await waitForApp(page);
  for (const destination of destinations) {
    await page.locator(`#nav-${destination}`).focus();
    await page.keyboard.press(destination === 'supply' ? 'Space' : 'Enter');
    await expect(page.locator(`#nav-${destination}`)).toHaveAttribute('aria-current', 'page');
    const traversal = await page.evaluateHandle(() => {
      const expected = Array.from(document.querySelectorAll('#app button, #app input, #app select, #app textarea, #app summary, #app [tabindex="0"]'))
        .filter(node => node instanceof HTMLElement && node.getClientRects().length > 0 && !node.closest('[hidden]') && !node.matches(':disabled'));
      const visited = new Set<Element>();
      return {
        size: expected.length,
        visit: () => {
          const focused = document.activeElement;
          if (focused && expected.includes(focused)) visited.add(focused);
          return { hidden: !!focused?.closest('[hidden]'), finished: expected.every(node => visited.has(node)) };
        },
        missing: () => expected.filter(node => !visited.has(node)).map(node => node.outerHTML),
      };
    });
    const limit = await traversal.evaluate(value => value.size * 6);
    let finished = false;
    for (let i = 0; i < limit && !finished; i++) {
      await page.keyboard.press('Tab');
      const state = await traversal.evaluate(value => value.visit());
      expect(state.hidden).toBe(false);
      finished = state.finished;
    }
    expect(await traversal.evaluate(value => value.missing())).toEqual([]);
    await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[hidden]'))).toBe(false);
    await traversal.dispose();
  }
  await page.locator('#about-link').focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#about-h')).toBeFocused();
  await expect(page.locator('#about').getByRole('note')).toHaveText(bannerText);
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#view-export')).toBeFocused();
});

function contrastOf(foreground: string, background: string): number {
  const luminance = (color: string) => {
    const channels = color.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(value => {
      const channel = Number(value) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    if (!channels || channels.length !== 3) throw Error(`RGB色が必要: ${color}`);
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  };
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test('受け取り6.3: 通常配色の文字と境界のコントラストを測り、通知のARIAを維持する', async ({ page }, testInfo) => {
  await emptyNavigable(page);
  const measurements: { destination: string; target: string; ratio: number }[] = [];
  for (const destination of destinations) {
    await goTo(page, destination);
    for (const target of ['body', '.prototype-note p', '#updated', '#destinations button[aria-current]', destination === 'management' ? '#reset-empty' : '#input button[type=submit]', ...(destination === 'management' ? [] : ['#operation-group-help', '#operation-group', '#input textarea'])]) {
      const colors = await page.locator(target).evaluate(node => {
        const style = getComputedStyle(node);
        let surface: Element | null = node;
        while (surface && getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)') surface = surface.parentElement;
        if (!surface) throw Error('不透明な背景が必要');
        return { color: style.color, background: getComputedStyle(surface).backgroundColor };
      });
      const ratio = contrastOf(colors.color, colors.background);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
      measurements.push({ destination, target, ratio });
    }
    const boundary = await page.locator(`#nav-${destination}`).evaluate(node => ({ border: getComputedStyle(node).borderTopColor, background: getComputedStyle(document.body).backgroundColor }));
    expect(contrastOf(boundary.border, boundary.background)).toBeGreaterThanOrEqual(3);
    for (const control of await page.locator('#actor, #operation-group, #input input:not([type=checkbox]):not([type=radio]), #input textarea, #input select').all()) {
      if (!await control.isVisible()) continue;
      const colors = await control.evaluate(node => {
        const style = getComputedStyle(node);
        return { border: style.borderTopColor, background: style.backgroundColor };
      });
      expect(contrastOf(colors.border, colors.background)).toBeGreaterThanOrEqual(3);
    }
    await expect(page.locator('#actor')).toBeVisible();
    await expect(page.locator('#updated')).toBeVisible();
  }
  await goTo(page, 'stock');
  await recorded(page, 'register', lot('aria-save', 'P', 'S1', 'counted', '1'));
  await expect(page.locator('#save .save-notice')).toHaveAttribute('aria-live', 'polite');
  await expect(page.locator('#save .save-notice')).toHaveAttribute('role', 'region');
  await expect(page.locator('#save .save-tone')).toHaveText('成功');
  await testInfo.attach('contrast-ratios', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
});

test('受け取り6.3: 1400pxの実Edgeウィンドウを200%ページ拡大して一列・全行き先を操作する', async ({}, testInfo) => {
  const evidence = [];
  const directory = '.local-logs/ui-reorganize';
  for (const factor of [1, 2] as const) {
    const profile = await browserZoomProfile(directory, factor);
    const context = await chromium.launchPersistentContext(profile, {
      channel: 'msedge', headless: true, viewport: null, locale: 'ja-JP', timezoneId: 'Asia/Tokyo', args: ['--window-size=1400,900'],
    });
    try {
      const page = context.pages()[0]!;
      await page.goto('http://127.0.0.1:4182/'); await waitForApp(page);
      const measured = await page.evaluate(() => ({
        outerWidth, innerWidth, dpr: devicePixelRatio, visualScale: visualViewport?.scale, cssZoom: getComputedStyle(document.body).zoom,
      }));
      expect(measured.outerWidth).toBe(1400);
      expect(measured.dpr).toBe(factor);
      expect(measured.visualScale).toBe(1);
      expect(measured.cssZoom).toBe('1');
      evidence.push({ factor, ...measured });
      if (factor === 2) {
        expect(measured.innerWidth).toBeLessThanOrEqual(900);
        for (const destination of destinations) {
          await goTo(page, destination);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
          await expect(page.locator('#actor')).toBeVisible();
          await expect(page.locator('#updated')).toBeVisible();
          if (destination !== 'management') {
            const boxes = await page.evaluate(current => ({
              content: document.getElementById(`page-${current}`)!.getBoundingClientRect().toJSON(),
              input: document.getElementById('input')!.getBoundingClientRect().toJSON(),
            }), destination);
            expect(boxes.input.x).toBe(boxes.content.x);
            expect(boxes.input.y).toBeGreaterThanOrEqual(boxes.content.bottom);
          }
          // 実page zoomに対するPlaywrightのclip二重補正を避け、ブラウザーの表示領域をそのまま撮る。
          const cdp = await context.newCDPSession(page);
          const capture: { data?: unknown } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
          if (typeof capture.data !== 'string') throw Error('ブラウザーの撮影データが必要');
          await saveBrowserCapture(`${directory}/task6.3-zoom200-${destination}.png`, capture.data);
          await cdp.detach();
        }
        await page.locator('#about-link').click();
        await expect(page.locator('#about-h')).toBeFocused();
        await expect(page.locator('#about').getByRole('note')).toHaveText(bannerText);
        await goTo(page, 'stock');
        await usePractice(page);
        await recorded(page, 'register', lot('zoom200', 'P', 'S1', 'counted', '1'));
        await expect(page.locator('#save')).toContainText('保存した');
      }
    } finally { await context.close(); }
  }
  expect(evidence[0]!.innerWidth / evidence[1]!.innerWidth).toBe(2);
  await testInfo.attach('real-browser-zoom', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
});
