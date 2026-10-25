import { expect, test, type Page } from '@playwright/test';
import { waitForPersistence, selectOperation, goTo, backupButton, cell, downloadVia, jsonFile, lot, opLabels, pickFile, recorded, set, startEmpty, waitForApp } from './helpers.ts';
import { installLegacyFileDraft } from './legacy-compat.ts';
import { appUsage, blockStorage, draftKey, draftOf, fillQuota, gateStorageEvents, openWithHooks, readyToSave, sharedKeys, snapshotOf, twoPages, typeUse, withdrawButton } from './conflict-helpers.ts';

// 実Edgeで、二画面・障害・復元・表示の各経路を統合して確かめる（Task5.1〜5.3）。数量は架空。

async function conflictOn(page: Page, context: import('@playwright/test').BrowserContext, value = ' 2.5'): Promise<Page> {
  const other = await twoPages(page, context);
  await typeUse(other, value);
  await recorded(page, 'move', { lot: 'p', location: 'T' }, '09:00');
  await expect(other.locator('#conflict')).toContainText('未解消');
  return other;
}

test('5.1：同じ元入力を複製した二画面の照合は一件だけ確定し、後の画面は異なる結果で上書きせず、再読込後に確定済みを示す', async ({ page, context }) => {
  const other = await conflictOn(page, context);
  const raw = await draftOf(other);
  // 副画面の作成でsessionStorageが複製された場合に相当する画面。
  const copy = await context.newPage();
  await copy.addInitScript(([key, value]) => { if (sessionStorage.getItem('e2e-seeded') === null) { sessionStorage.setItem(key!, value!); sessionStorage.setItem('e2e-seeded', '1'); } }, [draftKey, raw!]);
  await gateStorageEvents(copy);
  await copy.goto('/');
  await waitForApp(copy);
  const copyPanel = copy.locator('#conflict');
  await expect(copyPanel).toContainText('未解消');
  await other.reload();
  await waitForApp(other);
  const panel = other.locator('#conflict');
  await readyToSave(copyPanel, '複製した画面の結果');
  await blockStorage(copy);
  await panel.getByLabel('元入力を控えた').check();
  await panel.getByLabel('最新記録から入力し直す').check();
  await panel.getByLabel('理由').fill('元の画面の結果');
  await panel.getByLabel('最新の記録を確認した').check();
  await panel.getByRole('button', { name: /で保存する/ }).click();
  await expect(panel).toContainText('確定済み：最新記録から入力し直す');
  const saved = await sharedKeys(other);
  await copyPanel.getByRole('button', { name: /で保存する/ }).click();
  await expect(copyPanel).toContainText('別の画面で記録が保存されました。再読込してから照合してください');
  expect(await sharedKeys(copy)).toEqual(saved);
  expect(await draftOf(copy)).toBe(raw);
  const reviews = (await snapshotOf(copy)).conflictReviews;
  expect(reviews).toHaveLength(1);
  expect(reviews[0]!.resolution).toMatchObject({ outcome: 'reenter', reason: '元の画面の結果' });
  await copy.reload();
  await waitForApp(copy);
  await expect(copyPanel).toContainText('確定済み：最新記録から入力し直す');
  await expect(copyPanel).toContainText('理由："元の画面の結果"');
  expect(await draftOf(copy)).toBeNull();
  expect(await sharedKeys(copy)).toEqual(saved);
  await copy.close(); await other.close();
});

test('5.1：外部の更新がない同じ写しで操作IDの内容だけが違う再送は、既存の拒否のままとし、元入力を退避しない', async ({ page }) => {
  await startEmpty(page);
  const form = page.getByRole('form', { name: '操作の入力' });
  await selectOperation(form.locator('[name=op]'), 'register');
  for (const [name, value] of Object.entries(lot('same-a', 'P', 'S1', 'counted', '8'))) await set(form.locator(`[name=${name}]`), value);
  await form.locator('[name=occurredAt]').fill('2026-09-29T12:00');
  const old = await form.elementHandle();
  if (old === null) throw new Error('入力欄を保持する');
  await form.getByRole('button', { name: '記録する' }).click();
  await expect(page.locator('#save')).toContainText('保存した');
  const saved = await sharedKeys(page);
  await old.evaluate(node => {
    const input = node.querySelector('[name=newId]');
    if (!(input instanceof HTMLInputElement)) throw new Error('新しいIDの入力欄が必要');
    input.value = 'same-changed';
    node.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await expect(page.locator('#input')).toContainText('違う内容で使用済み');
  await expect(page.locator('#conflict')).toBeHidden();
  expect(await draftOf(page)).toBeNull();
  expect(await sharedKeys(page)).toEqual(saved);
});

test('5.1：送信が保存できずに残った入力は、後の外部更新で退避するとき、前回の送信が保存されていないことを示し、送信前の入力と偽らない', async ({ page, context }) => {
  const other = await twoPages(page, context);
  await typeUse(other, '2');
  // 次の共有の保存先への書込だけを失敗させ、未保存と確定した送信（failed）にする。
  await other.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
      if (this === window.localStorage) { Storage.prototype.setItem = original; throw new DOMException('架空の書込障害', 'UnknownError'); }
      return original.call(this, key, value);
    };
  });
  const before = await sharedKeys(other);
  await other.getByRole('form', { name: '操作の入力' }).getByRole('button', { name: '記録する' }).click();
  await expect(other.locator('#input')).toContainText('保存できなかった');
  expect(await sharedKeys(other)).toEqual(before);
  await recorded(page, 'move', { lot: 'p', location: 'T' }, '09:00');
  const panel = other.locator('#conflict');
  await expect(panel).toContainText('未解消');
  await expect(panel).toContainText('未反映の範囲：前回の送信は保存されていない・数量へ未反映');
  await expect(panel).not.toContainText('送信前に外部の更新を検出した入力');
  await other.reload(); await waitForApp(other);
  await expect(panel).toContainText('前回の送信は保存されていない');
});

test('5.2：照合結果の応答を失っても照会で保存済みと確定でき、退避の削除に失敗しても二重に保存せず、再読込で削除を終える', async ({ page, context }) => {
  const other = await conflictOn(page, context);
  const panel = await openWithHooks(other);
  await readyToSave(panel, '応答喪失');
  await other.evaluate(() => window.fuzzyStockTest!.loseResponseAt(1));
  await panel.getByRole('button', { name: /で保存する/ }).click();
  const save = other.locator('#save');
  await save.getByRole('button', { name: '照会する', exact: true }).click();
  await expect(save).toContainText('1単位中1単位が保存済み');
  await other.evaluate(key => {
    const remove = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (name: string) { if (name === key) { Storage.prototype.removeItem = remove; throw new Error('架空の削除失敗'); } return remove.call(this, name); };
  }, draftKey);
  await save.getByRole('button', { name: '保存済みとして確定する', exact: true }).click();
  await expect(panel).toContainText('照合結果は保存済みですが、タブ内の退避を削除できませんでした：架空の削除失敗');
  await expect(panel).toContainText('確定済み：この入力を取り下げる');
  expect(await draftOf(other)).not.toBeNull();
  const saved = await sharedKeys(other);
  expect((await snapshotOf(other)).conflictReviews).toHaveLength(1);
  await other.reload();
  await waitForApp(other);
  await expect(panel).toContainText('確定済み：この入力を取り下げる');
  expect(await draftOf(other)).toBeNull();
  expect(await sharedKeys(other)).toEqual(saved);
  await other.close();
});

const draftFaults: [string, (page: Page) => Promise<void>, RegExp][] = [
  ['512KiBの超過', page => page.getByRole('form', { name: '操作の入力' }).locator('[name=usedFor]').evaluate((node: HTMLInputElement) => { node.value = 'x'.repeat(600 * 1024); node.dispatchEvent(new Event('input', { bubbles: true })); }), /512KiB/],
  ['書込後の読戻しの不一致', page => page.evaluate(key => {
    const read = Storage.prototype.getItem, write = Storage.prototype.setItem;
    let written = false;
    Storage.prototype.setItem = function (name: string, value: string) { if (name === key && this === sessionStorage) written = true; return write.call(this, name, value); };
    Storage.prototype.getItem = function (name: string) { return written && name === key && this === sessionStorage ? '別の値' : read.call(this, name); };
  }, draftKey), /退避の読戻しが一致しない/],
  ['退避先の取得の失敗', page => page.evaluate(() => { Object.defineProperty(window, 'sessionStorage', { get() { throw new Error('架空の退避先の取得失敗'); } }); }), /架空の退避先の取得失敗/],
];
for (const [name, inject, reason] of draftFaults) test(`5.2：退避の${name}では、入力をこの画面に残し、転記用に示してアプリ内の再読込を止める`, async ({ page, context }) => {
  const other = await twoPages(page, context);
  await typeUse(other, '4');
  await inject(other);
  const before = await sharedKeys(page);
  await recorded(page, 'move', { lot: 'p', location: 'T' }, '09:00');
  const panel = other.locator('#conflict');
  await expect(panel).toContainText('退避に失敗');
  await expect(panel).toContainText(reason);
  await expect(panel).toContainText(/数量（.*）："4"/);
  await expect(other.getByRole('form', { name: '操作の入力' }).locator('[name=value]')).toHaveValue('4');
  await expect(panel).toContainText('再読込すると入力が消えます');
  await expect(panel.getByRole('button', { name: '再読込する' })).toBeDisabled();
  expect(Object.keys(await sharedKeys(page)).sort()).toEqual(Object.keys(before).sort());
  await other.close();
});

test('5.2：照合結果の署名を計算できない、または計算中に別画面が記録したときは保存せず、元入力と保存済みの記録を守る', async ({ page, context }) => {
  const other = await conflictOn(page, context);
  await other.reload();
  await waitForApp(other);
  const panel = other.locator('#conflict');
  const raw = await draftOf(other);
  await other.evaluate(() => { const digest = crypto.subtle.digest.bind(crypto.subtle); crypto.subtle.digest = () => Promise.reject(new Error('架空の署名失敗')); (window as unknown as { restoreDigest: () => void }).restoreDigest = () => { crypto.subtle.digest = digest; }; });
  await readyToSave(panel, '署名');
  const before = await sharedKeys(other);
  await panel.getByRole('button', { name: /で保存する/ }).click();
  await expect(panel).toContainText('照合結果を保存できませんでした（元入力は残しています）：架空の署名失敗');
  expect(await sharedKeys(other)).toEqual(before);
  expect(await draftOf(other)).toBe(raw);
  // 計算中の外部更新：署名を遅らせ、その間に別画面が記録する。
  await other.evaluate(() => {
    (window as unknown as { restoreDigest: () => void }).restoreDigest();
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = async (...args: Parameters<typeof digest>) => { await new Promise(resolve => setTimeout(resolve, 6000)); return digest(...args); };
  });
  await panel.getByLabel('最新の記録を確認した').check();
  await panel.getByRole('button', { name: /で保存する/ }).click();
  await recorded(page, 'move', { lot: 'p', location: 'S1' }, '10:00');
  const after = await sharedKeys(page);
  // 計算を終えた後の再検査で止まったことを、その結果の文で確かめる（通知による保存中断の案内とは別の文）。
  await expect(panel).toContainText('照合結果を保存できませんでした（元入力は残しています）：計算中に記録または入力が変わったため、確認をやり直してください', { timeout: 15000 });
  expect(await sharedKeys(other)).toEqual(after);
  expect((await snapshotOf(other)).conflictReviews).toHaveLength(0);
  expect(await draftOf(other)).toBe(raw);
  await other.close();
});

test('5.2：他の画面の保存中・結果不明の操作が残るあいだは、通知が届かなくても照合結果を保存せず、その操作を変えない', async ({ page, context }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('p', 'P', 'S1', 'counted', '20'), '08:00');
  const other = await context.newPage();
  await gateStorageEvents(other);
  await other.goto('/');
  await waitForApp(other);
  await typeUse(other, ' 2.5');
  await page.goto('/?test');
  await waitForApp(page);
  await recorded(page, 'move', { lot: 'p', location: 'T' }, '09:00');
  await expect(other.locator('#conflict')).toContainText('未解消');
  await other.reload();
  await waitForApp(other);
  const panel = other.locator('#conflict');
  await readyToSave(panel, '他者の保存中');
  await blockStorage(other);
  await page.evaluate(() => window.fuzzyStockTest!.loseResponseAt(1));
  await recorded(page, 'move', { lot: 'p', location: 'S1' }, '10:00').catch(() => undefined);
  await expect(page.locator('#save')).toContainText('保存結果不明');
  const held = await sharedKeys(page);
  expect(held['fuzzy-stock/pending']).toBeDefined();
  await panel.getByRole('button', { name: /で保存する/ }).click();
  await expect(panel).toContainText('別の画面で記録が保存されました。再読込してから照合してください');
  expect(await sharedKeys(other)).toEqual(held);
  expect((await snapshotOf(other)).conflictReviews).toHaveLength(0);
  await other.close();
});

test('5.2：照合記録の一件64KiBちょうどまでは保存でき、1byte超えると書き込まずに止める（各段階の保存先の使用量を記録）', async ({ page, context }, info) => {
  const other = await conflictOn(page, context);
  await other.reload();
  await waitForApp(other);
  const panel = other.locator('#conflict');
  await readyToSave(panel, 'x');
  const size = Number((await panel.textContent())!.match(/この照合記録：(\d+) bytes/)![1]);
  // 理由は1文字1byteのxなので、長さで一件の大きさをちょうど合わせられる。
  await panel.getByLabel('理由').fill('x'.repeat(1 + 65536 - size + 1));
  await panel.getByLabel('最新の記録を確認した').check();
  await expect(panel).toContainText('この照合記録：65537 bytes／上限65536 bytes');
  await expect(panel.getByRole('button', { name: /で保存する/ })).toBeDisabled();
  const usage = [{ stage: '照合の保存前', ...await appUsage(other) }];
  await panel.getByLabel('理由').fill('x'.repeat(1 + 65536 - size));
  await panel.getByLabel('最新の記録を確認した').check();
  await expect(panel).toContainText('この照合記録：65536 bytes／上限65536 bytes');
  await panel.getByRole('button', { name: /で保存する/ }).click();
  await expect(panel).toContainText('確定済み：この入力を取り下げる');
  usage.push({ stage: '一件64KiBの照合を保存した後', ...await appUsage(other) });
  const stored = (await snapshotOf(other)).conflictReviews[0]!;
  expect(new TextEncoder().encode(JSON.stringify(stored)).length).toBe(65536);
  await info.attach('conflict-usage', { body: JSON.stringify(usage), contentType: 'application/json' });
  // 新しい写しに第三列の一件が加わるので、保存後の使用量は少なくとも一件分増える。
  expect(usage[1]!.utf8 - usage[0]!.utf8).toBeGreaterThan(65536);
  await other.close();
});

test('5.2：実Edgeの保存容量不足で照合結果を記録できないときは容量不足と示して記録なしで取り下げられ、二回目の競合でも同じ操作で戻る', async ({ page, context }, info) => {
  const other = await conflictOn(page, context);
  await other.reload();
  await waitForApp(other);
  const panel = other.locator('#conflict');
  const filler = 'fuzzy-stock-e2e/quota-padding';
  const usage: unknown[] = [];
  for (const round of [1, 2]) {
    await readyToSave(panel, `容量不足${round}`);
    const before = await sharedKeys(other);
    usage.push({ round, stage: '埋める前', app: await appUsage(other) });
    const filled = await fillQuota(other, filler);
    usage.push({ round, stage: '埋めた後', filledCharacters: filled, app: await appUsage(other) });
    await panel.getByRole('button', { name: /で保存する/ }).click();
    await expect(panel).toContainText('保存先の容量が不足して照合結果を保存できませんでした（容量の上限の超過ではありません。未保存です）');
    await expect(panel).toContainText('保存先の容量不足で失敗し、未保存と確認しました');
    const { [filler]: _, ...afterFail } = await sharedKeys(other);
    expect(afterFail).toEqual(before);
    await panel.getByLabel('共有の照合記録を残さずに取り下げることを確認した').check();
    await withdrawButton(panel).click();
    await expect(panel).toContainText('このタブの退避を記録せずに取り下げました');
    expect(await draftOf(other)).toBeNull();
    await other.evaluate(key => localStorage.removeItem(key), filler);
    expect(await sharedKeys(other)).toEqual(before);
    expect((await snapshotOf(other)).conflictReviews).toHaveLength(0);
    if (round === 1) {
      // 戻った通常入力から、二回目の競合を起こす。
      await typeUse(other, '3');
      // 埋め草の削除は別タブへ非同期に伝わる。伝わる前に書くと、その画面ではまだ容量不足になる（CIで観測）。
      await expect.poll(() => page.evaluate(key => localStorage.getItem(key), filler)).toBeNull();
      await recorded(page, 'move', { lot: 'p', location: 'S1' }, '10:00');
      await expect(panel).toContainText('未解消');
      await other.reload();
      await waitForApp(other);
    }
  }
  await info.attach('native-quota-usage', { body: JSON.stringify(usage), contentType: 'application/json' });
  await other.close();
});

test('5.3：バックアップを別の保存先へ復元すると、照合記録の元入力・結果・確認者・日時が全文で引き継がれる', async ({ page, context, browser }) => {
  const other = await conflictOn(page, context);
  await other.reload();
  await waitForApp(other);
  const panel = other.locator('#conflict');
  await readyToSave(panel, '別の保存先へ');
  await panel.getByRole('button', { name: /で保存する/ }).click();
  await expect(panel).toContainText('確定済み');
  const original = (await snapshotOf(other)).conflictReviews;
  const backup = await downloadVia(other, backupButton);
  const elsewhere = await browser.newContext();
  const fresh = await elsewhere.newPage();
  await startEmpty(fresh);
  expect((await snapshotOf(fresh)).conflictReviews).toHaveLength(0);
  await pickFile(fresh, backup.path);
  await fresh.getByRole('button', { name: '復元する', exact: true }).click();
  const restored = fresh.locator('#conflict');
  await expect(restored).toContainText('確定した照合記録（1件');
  expect((await snapshotOf(fresh)).conflictReviews).toEqual(original);
  await restored.locator('summary').click();
  await expect(restored).toContainText('理由："別の保存先へ"');
  await expect(restored).toContainText(`確認日時：${original[0]!.resolution.at}`);
  await expect(restored).toContainText(/数量（.*）：" 2\.5"/);
  await elsewhere.close(); await other.close();
});

test('5.3：HTMLに見える原文は実行せず文字として示し、forced-colorsでも状態と未反映範囲を文字で読める', async ({ page, context }) => {
  const attack = '<img src=x onerror="window.e2eInjected=1"><b>太字</b>';
  const other = await twoPages(page, context);
  await typeUse(other, ' 2.5');
  await other.getByRole('form', { name: '操作の入力' }).locator('[name=usedFor]').fill(attack);
  await recorded(page, 'move', { lot: 'p', location: 'T' }, '09:00');
  await other.emulateMedia({ forcedColors: 'active' });
  await other.reload();
  await waitForApp(other);
  const panel = other.locator('#conflict');
  await expect(panel).toContainText(JSON.stringify(attack));
  await expect(panel.locator('img, b')).toHaveCount(0);
  expect(await other.evaluate(() => (window as unknown as { e2eInjected?: number }).e2eInjected)).toBeUndefined();
  // 強制配色の下でも、状態・未反映範囲・保存できない理由が文字として表示されている。
  expect(await other.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
  for (const text of ['未解消：更新競合で保持した入力があります。', '未反映の範囲：未送信・数量へ未反映', '保存できない理由：元入力を控えたことを確認してください']) await expect(panel.getByText(text, { exact: true })).toBeVisible();
  await other.close();
});

test('5.3：照合結果の確定は全体の最終記録更新に含め、物品の最後に数えた数と最終記録更新は変えない', async ({ page, context }) => {
  const other = await conflictOn(page, context);
  await other.reload();
  await waitForApp(other);
  await goTo(other, 'stock');
  const counted = await cell(other, 'p', '最後に数えた数').textContent();
  await goTo(other, 'stock');
  const updated = await cell(other, 'p', '最終記録更新').textContent();
  const panel = other.locator('#conflict');
  await readyToSave(panel, '時刻');
  await panel.getByRole('button', { name: /で保存する/ }).click();
  await expect(panel).toContainText('確定済み');
  const at = (await snapshotOf(other)).conflictReviews[0]!.resolution.at;
  await expect(other.locator('#updated')).toHaveText(`最終記録更新：${at.slice(0, 16).replace('T', ' ')}（日本時間）`);
  await goTo(other, 'stock');
  expect(await cell(other, 'p', '最後に数えた数').textContent()).toBe(counted);
  await goTo(other, 'stock');
  expect(await cell(other, 'p', '最終記録更新').textContent()).toBe(updated);
  await other.close();
});

// 未解消の照合パネルで、理由を「base＋xの詰め物」にして指定の大きさ（一件または合計）へ合わせる。理由のxは1文字1byte。
async function sizeReason(panel: import('@playwright/test').Locator, base: string, measure: 'one' | 'total', target: number): Promise<void> {
  const pattern = measure === 'one' ? /この照合記録：(\d+) bytes/ : /照合記録の合計：(\d+) bytes/;
  await readyToSave(panel, base);
  const shown = Number((await panel.textContent())!.match(pattern)![1]);
  await panel.getByLabel('理由').fill(base + 'x'.repeat(target - shown));
  await panel.getByLabel('最新の記録を確認した').check();
  await expect(panel).toContainText(measure === 'one' ? `この照合記録：${target} bytes` : `照合記録の合計：${target} bytes`);
}

test('5.2：日本語・引用符・改行を含む64KiBの照合記録を三件確定した後、蓄積256KiBちょうどまでは保存でき1byte超えると止め、各書込段階の保存先の使用量を記録する', async ({ page, context }, info) => {
  test.setTimeout(120_000);
  const other = await twoPages(page, context);
  const panel = other.locator('#conflict');
  const base = '日本語の"引用"と\n改行を含む理由';
  const locations = ['T', 'S1', 'T', 'S1'];
  let stages: unknown[] = [];
  for (const [index, location] of locations.entries()) {
    // 前の照合の保存の通知で止まった別画面を読み直してから記録する。
    if (index > 0) { await page.reload(); await waitForApp(page); }
    await typeUse(other, ' 2.5');
    await recorded(page, 'move', { lot: 'p', location }, '09:00');
    await expect(panel).toContainText('未解消');
    await other.reload();
    await waitForApp(other);
    if (index < 3) await sizeReason(panel, base, 'one', 65536);
    else {
      await sizeReason(panel, base, 'total', 262145);
      await expect(panel.getByRole('button', { name: /で保存する/ })).toBeDisabled();
      await expect(panel).toContainText('照合記録の容量の上限を超えるため保存できません');
      await sizeReason(panel, base, 'total', 262144);
      // 保存中の印・写し・見出し・印の削除の各書込の直後に、アプリのkeyの使用量を記録する。
      await other.evaluate(() => {
        const encoder = new TextEncoder(), usage = () => Object.entries(localStorage).filter(([k]) => k.startsWith('fuzzy-stock/'))
          .reduce((u, [k, v]) => ({ utf8: u.utf8 + encoder.encode(k).length + encoder.encode(v).length, utf16: u.utf16 + (k.length + v.length) * 2 }), { utf8: 0, utf16: 0 });
        const log: unknown[] = [{ stage: '保存前', ...usage() }];
        (window as unknown as { stages: unknown[] }).stages = log;
        const set = Storage.prototype.setItem, remove = Storage.prototype.removeItem;
        Storage.prototype.setItem = function (key: string, value: string) { set.call(this, key, value); if (this === localStorage && key.startsWith('fuzzy-stock/')) log.push({ stage: `書込 ${key}`, ...usage() }); };
        Storage.prototype.removeItem = function (key: string) { remove.call(this, key); if (this === localStorage && key.startsWith('fuzzy-stock/')) log.push({ stage: `削除 ${key}`, ...usage() }); };
      });
    }
    await panel.getByRole('button', { name: /で保存する/ }).click();
    await waitForPersistence(other);
    await expect(panel).toContainText('確定済み：この入力を取り下げる');
    if (index === 3) stages = await other.evaluate(() => (window as unknown as { stages: unknown[] }).stages);
  }
  const reviews = (await snapshotOf(other)).conflictReviews;
  expect(reviews).toHaveLength(4);
  expect(reviews.slice(0, 3).map(review => new TextEncoder().encode(JSON.stringify(review)).length)).toEqual([65536, 65536, 65536]);
  expect(new TextEncoder().encode(JSON.stringify(reviews)).length).toBe(262144);
  expect(reviews[0]!.resolution.reason.startsWith(base)).toBe(true);
  expect(stages.map(stage => (stage as { stage: string }).stage)).toEqual(['保存前', '書込 fuzzy-stock/pending', expect.stringMatching(/^書込 fuzzy-stock\/slot-[AB]$/), '書込 fuzzy-stock/head', '削除 fuzzy-stock/pending']);
  await info.attach('accumulated-usage', { body: JSON.stringify(stages), contentType: 'application/json' });
  await other.close();
});

const needRaw = '{"架空":"必要明細","数量":" 001.30"}';
test('5.3：旧版の読取済み文書の競合退避を読み戻し、原文のまま照合記録へ残す', async ({ page, context }) => {
  const other = await twoPages(page, context);
  await installLegacyFileDraft(other, 'read', needRaw);
  const panel = other.locator('#conflict');
  await expect(panel).toContainText('未解消');
  await expect(panel).toContainText(`必要明細の原文：${JSON.stringify(needRaw)}`);
  await expect(panel).toContainText('"架空必要明細.json"（読取済み）');
  await other.reload();
  await waitForApp(other);
  await expect(panel).toContainText(`必要明細の原文：${JSON.stringify(needRaw)}`);
  await readyToSave(panel, '旧版の取込入力を取り下げ、原文を履歴に残す');
  await panel.getByRole('button', { name: /で保存する/ }).click();
  await expect(panel).toContainText('確定済み');
  expect(await draftOf(other)).toBeNull();
  const result = await snapshotOf(other);
  expect(result.conflictReviews[0]?.draft).toMatchObject({ opKey: 'needImport', opLabel: '必要明細の再取込（架空文書）', readEvidence: [{ kind: 'needRaw', raw: needRaw }] });
  expect(result.supply.needs).toEqual({});
  await other.close();
});

test('5.3：旧競合退避の読み終えていない文書は読取中と示し、読み取った原文があるとは扱わない', async ({ page, context }) => {
  const other = await twoPages(page, context);
  await installLegacyFileDraft(other, 'reading', needRaw);
  const panel = other.locator('#conflict');
  await expect(panel).toContainText('未解消');
  await expect(panel).toContainText('"架空必要明細.json"（読取中（読み終えていない））');
  await expect(panel).not.toContainText('必要明細の原文');
  const draft = JSON.parse((await draftOf(other))!) as { draft: { readEvidence: unknown[] } };
  expect(draft.draft.readEvidence).toEqual([]);
  await other.close();
});

test('4.5・5.2：最短の理由（一文字）でも一件の上限を1byte超える元入力は、理由の短縮を案内せず記録なしの取下げを示す', async ({ page, context }) => {
  const other = await conflictOn(page, context);
  const panel = other.locator('#conflict');
  await other.reload();
  await waitForApp(other);
  await readyToSave(panel, 'x');
  const shown = Number((await panel.textContent())!.match(/この照合記録：(\d+) bytes/)![1]);
  // 退避の使用先の欄だけを詰め物にして、理由が一文字のときの一件の大きさを65537 bytesにする（xは1文字1byte）。
  await other.evaluate(([key, grow]) => {
    const stored = JSON.parse(sessionStorage.getItem(key!)!);
    const field = stored.draft.fields.find((f: { name: string }) => f.name === 'usedFor');
    const before = new TextEncoder().encode(JSON.stringify(field.value)).length;
    field.value = 'x'.repeat(Number(grow) + before - 2);
    sessionStorage.setItem(key!, JSON.stringify(stored));
  }, [draftKey, String(65537 - shown)]);
  await other.reload();
  await waitForApp(other);
  await readyToSave(panel, 'x');
  await expect(panel).toContainText('この照合記録：65537 bytes／上限65536 bytes');
  await expect(panel.getByRole('button', { name: /で保存する/ })).toBeDisabled();
  await expect(panel).not.toContainText('理由を短くすれば上限内に収まり');
  await expect(panel).toContainText('照合記録が容量の上限を超えるため、通常の照合を確定できません');
  const before = await sharedKeys(other);
  await panel.getByLabel('共有の照合記録を残さずに取り下げることを確認した').check();
  await withdrawButton(panel).click();
  await expect(panel).toContainText('このタブの退避を記録せずに取り下げました');
  expect(await draftOf(other)).toBeNull();
  expect(await sharedKeys(other)).toEqual(before);
  await other.close();
});
