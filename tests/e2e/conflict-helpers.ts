import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { decodeSnapshot } from '../../src/ui/storageparse.ts';
import { selectOperation, opLabels, recorded, set, startEmpty, waitForApp, lot } from './helpers.ts';

export const draftKey = 'fuzzy-stock/conflict-draft';
export const sharedKeys = (page: Page): Promise<Record<string, string>> => page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
export const snapshotOf = async (page: Page) => {
  const keys = await sharedKeys(page);
  return decodeSnapshot(JSON.parse(keys[`fuzzy-stock/slot-${keys['fuzzy-stock/head']}`]!));
};
export const draftOf = (page: Page): Promise<string | null> => page.evaluate(key => sessionStorage.getItem(key), draftKey);

// 数量だけを入力した使用の入力。送信はしない。
export async function typeUse(page: Page, value = ' 2.5'): Promise<void> {
  const form = page.getByRole('form', { name: '操作の入力' });
  await selectOperation(form.locator('[name=op]'), { label: opLabels.use });
  for (const [name, entered] of Object.entries({ lot: 'p', basis: 'counted', value, usedFor: '架空作業' })) await set(form.locator(`[name=${name}]`), entered);
}

// suppressNotice：別画面の更新の通知(storageイベント)を受け取らない画面。通知が届かないまま送信した場合の書込前拒否を試す。
export async function twoPages(page: Page, context: BrowserContext, suppressNotice = false): Promise<Page> {
  await startEmpty(page);
  await recorded(page, 'register', lot('p', 'P', 'S1', 'counted', '20'), '08:00');
  const other = await context.newPage();
  if (suppressNotice) await other.addInitScript(() => { const add = window.addEventListener.bind(window); window.addEventListener = ((type: string, ...rest: unknown[]) => type === 'storage' ? undefined : (add as (...a: unknown[]) => void)(type, ...rest)) as typeof window.addEventListener; });
  await other.goto('/');
  await waitForApp(other);
  return other;
}

// 退避した元入力を、試験用フックを使える画面で開き直す（同じタブなのでsessionStorageの退避は残る）。
export async function openWithHooks(other: Page): Promise<Locator> {
  await other.goto('/?test');
  await waitForApp(other);
  const panel = other.locator('#conflict');
  await expect(panel).toContainText('未解消');
  return panel;
}

export async function readyToSave(panel: Locator, reason: string): Promise<void> {
  await panel.getByLabel('元入力を控えた').check();
  await panel.getByLabel('この入力を取り下げる').check();
  await panel.getByLabel('理由').fill(reason);
  await panel.getByLabel('最新の記録を確認した').check();
}

export const withdrawButton = (panel: Locator) => panel.getByRole('button', { name: '記録せずにこのタブの退避を取り下げる' });

// 照合記録の一件64KiBを超える元入力（退避の512KiBには収まる）を作って競合させる。
export async function oversizedConflict(page: Page, context: BrowserContext): Promise<{ other: Page; panel: Locator }> {
  const other = await twoPages(page, context);
  await typeUse(other, ' 2.5');
  await other.getByRole('form', { name: '操作の入力' }).locator('[name=usedFor]').evaluate((node: HTMLInputElement) => { node.value = '架空作業'.repeat(6000); node.dispatchEvent(new Event('input', { bubbles: true })); });
  await recorded(page, 'move', { lot: 'p', location: 'T' }, '09:00');
  await expect(other.locator('#conflict')).toContainText('未解消');
  await other.reload();
  await waitForApp(other);
  return { other, panel: other.locator('#conflict') };
}

// 画面のstorageイベントの受け手を、試験から止められるようにする（次の読込から有効）。止めるときはblockStorage(page)を呼ぶ。
export async function gateStorageEvents(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const add = window.addEventListener.bind(window);
    window.addEventListener = ((type: string, listener: EventListener, ...rest: unknown[]) => add(type, type === 'storage'
      ? (event: Event) => { if (!(window as unknown as { blockStorage?: boolean }).blockStorage) listener(event); } : listener, ...(rest as []))) as typeof window.addEventListener;
  });
}
export const blockStorage = (page: Page): Promise<void> => page.evaluate(() => { (window as unknown as { blockStorage?: boolean }).blockStorage = true; });

// アプリの共有の保存先のkeyの使用量。UTF-8のbytesと、localStorageの割当で数えるUTF-16のコード単位×2を併記する。
export const appUsage = (page: Page): Promise<{ keys: number; utf8: number; utf16: number }> => page.evaluate(() => {
  const entries = Object.entries(localStorage).filter(([key]) => key.startsWith('fuzzy-stock/'));
  const encoder = new TextEncoder();
  return { keys: entries.length, utf8: entries.reduce((sum, [k, v]) => sum + encoder.encode(k).length + encoder.encode(v).length, 0), utf16: entries.reduce((sum, [k, v]) => sum + (k.length + v.length) * 2, 0) };
});

// 保存先の残りを、1文字の追加も書けない所まで試験用のkeyで埋める。埋めた文字数を返す。
export const fillQuota = (page: Page, key: string): Promise<number> => page.evaluate(name => {
  const write = (length: number): boolean => {
    try { localStorage.setItem(name, 'x'.repeat(length)); return true; }
    catch (error) { if (!(error instanceof DOMException) || error.name !== 'QuotaExceededError') throw error; return false; }
  };
  let low = 0, high = 1024;
  while (write(high)) { low = high; if (high >= 32 * 1024 * 1024) throw new Error('規定の試験用上限までに容量不足を再現できない'); high *= 2; }
  while (high - low > 1) { const middle = low + Math.floor((high - low) / 2); if (write(middle)) low = middle; else high = middle; }
  if (!write(low) || write(low + 1)) throw new Error('1文字の増加で容量不足になる状態を作れない');
  write(low);
  return low;
}, key);
