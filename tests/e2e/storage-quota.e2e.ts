import { expect, test, type Page } from '@playwright/test';
import { decodeSnapshot } from '../../src/ui/storageparse.ts';
import { selectOperation, goTo, lot, recorded, row, set, startEmpty } from './helpers.ts';

async function stored(page: Page) {
  const bytes = await page.evaluate(() => Object.fromEntries(
    Object.keys(localStorage).filter(key => key.startsWith('fuzzy-stock/')).sort()
      .map(key => [key, localStorage.getItem(key)]),
  ));
  const head = bytes['fuzzy-stock/head'];
  if (head !== 'A' && head !== 'B') throw new Error('保存先の見出しが必要');
  const text = bytes[`fuzzy-stock/slot-${head}`];
  if (typeof text !== 'string') throw new Error('保存済みの写しが必要');
  const value: unknown = JSON.parse(text);
  return { bytes, snapshot: decodeSnapshot(value) };
}

test('実Edgeの保存容量不足: 元の記録と入力を保ち、空きを作って同じ受け取りを一度だけ保存する', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await startEmpty(page);
  expect(await page.evaluate(() => typeof window.fuzzyStockTest)).toBe('undefined');
  await recorded(page, 'register', lot('quota-kept', 'P', 'S1', 'counted', '8'));
  const before = await stored(page);
  expect(before.bytes['fuzzy-stock/pending']).toBeUndefined();

  const form = page.getByRole('form', { name: '操作の入力' });
  await selectOperation(form.locator('[name=op]'), 'receive');
  for (const [name, value] of Object.entries(lot('quota-receipt', 'P', 'S1', 'counted', '2', { label: '00007|架空の容量確認' }))) {
    await set(form.locator(`[name=${name}]`), value);
  }
  await form.locator('[name=occurredAt]').fill('2026-09-29T13:00');
  const draft = await form.evaluate(node => {
    if (!(node instanceof HTMLFormElement)) throw new Error('入力フォームが必要');
    return Array.from(new FormData(node).entries());
  });
  const oldForm = await form.elementHandle();
  if (!oldForm) throw new Error('入力フォームが必要');

  const filler = 'fuzzy-stock-e2e/quota-padding';
  const quota = await page.evaluate(key => {
    const maximum = 32 * 1024 * 1024;
    let low = 0;
    let high = 1024;
    let refusals = 0;
    const write = (length: number): boolean => {
      try {
        localStorage.setItem(key, 'x'.repeat(length));
        return true;
      } catch (error) {
        if (!(error instanceof DOMException) || error.name !== 'QuotaExceededError') throw error;
        refusals += 1;
        return false;
      }
    };
    while (write(high)) {
      low = high;
      if (high >= maximum) throw new Error('規定の試験用上限までに容量不足を再現できない');
      high = Math.min(high * 2, maximum);
    }
    while (high - low > 1) {
      const middle = low + Math.floor((high - low) / 2);
      if (write(middle)) low = middle;
      else high = middle;
    }
    if (write(low + 1)) throw new Error('1文字の増加でも容量不足になる必要がある');
    return { characters: low, retainedCharacters: localStorage.getItem(key)?.length, refusals };
  }, filler);
  expect(quota.characters).toBeGreaterThan(0);
  expect(quota.retainedCharacters).toBe(quota.characters);
  expect(quota.refusals).toBeGreaterThan(0);
  await info.attach('native-quota', { body: JSON.stringify(quota), contentType: 'application/json' });

  await form.getByRole('button', { name: '記録する' }).click();
  await expect(page.locator('#save')).toContainText('保存できなかった');
  await expect(page.locator('#save')).not.toContainText('保存結果不明');
  await expect(page.getByRole('status')).not.toContainText('記録した');
  expect(await stored(page)).toEqual(before);
  await goTo(page, 'stock');
  await expect(row(page, 'quota-receipt')).toHaveCount(0);
  expect(await form.evaluate(node => {
    if (!(node instanceof HTMLFormElement)) throw new Error('入力フォームが必要');
    return Array.from(new FormData(node).entries());
  })).toEqual(draft);

  await page.evaluate(key => localStorage.removeItem(key), filler);
  expect(await stored(page)).toEqual(before);
  await form.getByRole('button', { name: '記録する' }).click();
  await expect(page.locator('#save')).toContainText('保存した');
  await goTo(page, 'stock');
  await expect(row(page, 'quota-kept')).toContainText('8個');
  await expect(row(page, 'quota-receipt')).toContainText('2個');
  const saved = await stored(page);
  expect(saved.bytes['fuzzy-stock/pending']).toBeUndefined();
  expect(saved.snapshot.supply.receipts['quota-receipt']).toMatchObject({ received: 2, label: '00007|架空の容量確認' });
  expect(saved.snapshot.supply.log.filter(event => event.kind === 'receiptRecord' && event.lotId === 'quota-receipt')).toHaveLength(1);
  expect(saved.snapshot.ledger.history.filter(event => event.kind === 'register' && event.changes.some(change => change.after.id === 'quota-receipt'))).toHaveLength(1);
  expect(Object.keys(saved.snapshot.ops).filter(id => !(id in before.snapshot.ops))).toHaveLength(1);

  await oldForm.evaluate(node => node.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await expect(page.locator('#save')).toContainText('保存済み。もう一度は記録しない');
  expect(await stored(page)).toEqual(saved);
  await page.reload();
  await expect(row(page, 'quota-receipt')).toContainText('2個');
  await expect(row(page, 'quota-kept')).toContainText('8個');
  expect(await stored(page)).toEqual(saved);
  expect(errors).toEqual([]);
});
