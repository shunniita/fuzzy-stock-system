import { expect, test } from '@playwright/test';
import { goTo, lot, opLabels, record, recorded, selectOperation, startEmpty, storageBytes } from './helpers.ts';
import { draftOf, twoPages, typeUse } from './conflict-helpers.ts';

test('作業別操作: 全操作へ種類から到達でき、一つの候補列に詰め込まない', async ({ page }) => {
  await startEmpty(page);
  const group = page.getByLabel('作業の種類', { exact: true });
  await expect(group).toBeVisible();
  const groups = await group.locator('option').evaluateAll(nodes => nodes.map(node => ({ value: node.getAttribute('value')!, label: node.textContent! })));
  expect(groups.map(g => g.label)).toEqual(['現物の登録・使用・移動', '製造・工程', '工程の登録・設定', 'やり直し・修理', '必要な数・依頼・発注', '受け取り・割り当て・返却', '数え直し・訂正・照合', '仮の記録・所属の整理', '登録情報の登録・変更']);
  const found: string[] = [];
  const categoryOf = new Map<string, string>();
  for (const { value } of groups) {
    await group.selectOption(value);
    const options = page.locator('[name=op] optgroup[data-operation-group] option');
    const keys = await options.evaluateAll(nodes => nodes.map(node => node.getAttribute('value')!));
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.length).toBeLessThanOrEqual(12);
    found.push(...keys);
    for (const key of keys) categoryOf.set(key, value);
    await expect(page.locator('[name=op]')).toHaveValue('register');
  }
  expect(found.sort()).toEqual(Object.keys(opLabels).sort());
  for (const [key, label] of Object.entries(opLabels)) {
    const category = categoryOf.get(key);
    expect(category).toBeDefined();
    if (category === undefined) throw new Error(`分類がない操作: ${key}`);
    await group.selectOption(category);
    await expect(page.locator(`[name=op] option[value="${key}"]`)).toHaveText(label);
    await page.locator('[name=op]').focus();
    await page.locator('[name=op]').selectOption(key);
    await expect(page.locator('[name=op]')).toHaveValue(key);
    await expect(page.locator('[name=op]')).toBeFocused();
  }
});

test('作業別操作: 種類の閲覧と同じ操作の再選択でフォーム・保存・確認を変えない', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'masterItem', { codeNone: true, name: '架空の仮品目', units: '個' }, '08:00');
  await record(page, 'masterCode', { target: '品目（仮）架空の仮品目「架空の仮品目」', code: 'Q', reason: '架空の正式ID判明' }, '09:00');
  const form = page.getByRole('form', { name: '操作の入力' });
  const identity = await form.elementHandle();
  const confirmed = form.locator('[name=confirmed]');
  await confirmed.check();
  const before = await storageBytes(page);
  const fields = await form.locator('input, select, textarea').evaluateAll(nodes => nodes.map(node => node instanceof HTMLInputElement ? [node.name, node.value, node.checked] : node instanceof HTMLSelectElement || node instanceof HTMLTextAreaElement ? [node.name, node.value] : []));
  await page.getByLabel('作業の種類', { exact: true }).selectOption('stock');
  await expect(page.locator('[name=op] optgroup[label="入力中の操作"]')).toContainText(opLabels.masterCode);
  await page.locator('[name=op]').selectOption('masterCode');
  for (const destination of ['supply', 'issues', 'masters', 'management', 'stock'] as const) await goTo(page, destination);
  expect(await form.evaluate((node, original) => node === original, identity)).toBe(true);
  await expect(confirmed).toBeChecked();
  expect(await form.locator('input, select, textarea').evaluateAll(nodes => nodes.map(node => node instanceof HTMLInputElement ? [node.name, node.value, node.checked] : node instanceof HTMLSelectElement || node instanceof HTMLTextAreaElement ? [node.name, node.value] : []))).toEqual(fields);
  expect(await storageBytes(page)).toEqual(before);
  await identity?.dispose();
});

test('作業別操作: 狭幅でキー選択し、分類を保存入力へ混ぜず記録できる', async ({ page }) => {
  await startEmpty(page);
  await page.setViewportSize({ width: 320, height: 800 });
  const group = page.getByLabel('作業の種類', { exact: true });
  await group.focus();
  await group.press('End');
  await group.press('Tab');
  await expect(page.locator('[name=op]')).toBeFocused();
  const operation = page.locator('[name=op]');
  await operation.press('Home');
  for (const key of ['masterItem', 'masterLocation', 'masterCase', 'masterActor']) {
    await operation.press('ArrowDown');
    await expect(operation).toHaveValue(key);
    await expect(operation).toBeFocused();
  }
  await page.locator('[name=name]').fill('架空の追加担当');
  await page.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('記録した');
  await goTo(page, 'masters');
  await expect(page.locator('#masters')).toContainText('架空の追加担当');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(JSON.stringify(await storageBytes(page))).not.toContain('operation-group');
  await page.locator('#input').screenshot({ path: '.local-logs/ui-reorganize/picker-320.png' });
});

for (const edited of [false, true]) {
  test(`作業別操作: 分類の閲覧を競合元入力へ混ぜない edited=${edited}`, async ({ page, context }) => {
    const other = await twoPages(page, context);
    if (edited) await typeUse(other);
    await other.getByLabel('作業の種類', { exact: true }).selectOption('masters');
    await recorded(page, 'move', { lot: 'p', location: 'T' }, '09:00');
    await expect(other.locator('#save')).toContainText(/別の画面|更新/);
    if (edited) {
      await expect(other.locator('#conflict')).toContainText('未解消');
      const draft = await draftOf(other);
      expect(draft).not.toBeNull();
      expect(draft).toContain(' 2.5');
      expect(draft).not.toContain('operation-group');
      expect(draft).not.toContain('作業の種類');
    } else {
      await expect(other.locator('#conflict')).toBeHidden();
      expect(await draftOf(other)).toBeNull();
    }
    await expect(other.getByLabel('作業の種類', { exact: true })).toHaveCount(0);
    await other.close();
  });
}

test('作業別操作: 分類を巡回してもコード候補・保持値・両保存領域に作用しない', async ({ page }) => {
  await startEmpty(page);
  for (const id of ['picker-one', 'picker-two']) await recorded(page, 'register', lot(id, 'P', 'S1', 'counted', '5'), '08:00');
  const form = page.locator('#input form');
  await selectOperation(form.locator('[name=op]'), 'receive');
  await form.locator('[name=project]').selectOption('B-001');
  await form.locator('[name=location]').selectOption('S2');
  const code = page.getByRole('region', { name: 'コード入力補助' });
  await code.getByRole('button', { name: '現在の案件・用途を保持', exact: true }).click();
  await code.getByRole('button', { name: '現在の場所を保持', exact: true }).click();
  await selectOperation(form.locator('[name=op]'), 'use');
  await code.getByLabel('読取原文・品目ID').fill('P~A-001~LABB');
  await code.getByRole('button', { name: '解釈', exact: true }).click();
  await code.getByLabel('コードの入力先').selectOption('lot');
  await expect(code.locator('[data-code-options] button')).toHaveCount(2);
  await code.getByLabel('名称・品番・コードで検索').fill('架空の検索途中');
  await form.locator('[name=basis]').selectOption('unknown');
  await form.locator('[name=occurredUnknown]').check();
  await expect(code.locator('[data-code-holds]')).toContainText('B-001');
  await expect(code.locator('[data-code-holds]')).toContainText('S2');
  const original = await page.locator('#input').evaluateHandle(root => Array.from(root.querySelectorAll('form, input, select, textarea')));
  const state = () => page.locator('#input').evaluate(root => ({
    fields: Array.from(root.querySelectorAll('input, select, textarea')).filter(node => node.id !== 'operation-group').map(node => node instanceof HTMLInputElement ? [node.name, node.value, node.checked] : node instanceof HTMLSelectElement || node instanceof HTMLTextAreaElement ? [node.name, node.value] : []),
    candidates: root.querySelector('[data-code-options]')?.textContent,
    holds: root.querySelector('[data-code-holds]')?.textContent,
  }));
  const before = await state();
  const observer = await page.evaluateHandle(() => {
    const bytes = () => [localStorage, sessionStorage].map(storage => Object.fromEntries(Object.keys(storage).sort().map(key => [key, storage.getItem(key)])));
    const beforeBytes = bytes();
    let writes = 0;
    const set = Storage.prototype.setItem, remove = Storage.prototype.removeItem, clear = Storage.prototype.clear;
    Storage.prototype.setItem = function (key, value) { writes++; return set.call(this, key, value); };
    Storage.prototype.removeItem = function (key) { writes++; return remove.call(this, key); };
    Storage.prototype.clear = function () { writes++; return clear.call(this); };
    return { read: () => ({ writes, beforeBytes, afterBytes: bytes() }), restore: () => { Storage.prototype.setItem = set; Storage.prototype.removeItem = remove; Storage.prototype.clear = clear; } };
  });
  try {
    const group = page.getByLabel('作業の種類', { exact: true });
    const keys = await group.locator('option').evaluateAll(nodes => nodes.map(node => node.getAttribute('value')!));
    for (const key of keys) {
      await group.selectOption(key);
      expect(await state()).toEqual(before);
      expect(await page.locator('#input').evaluate((root, nodes) => {
        const current = Array.from(root.querySelectorAll('form, input, select, textarea'));
        return current.length === nodes.length && current.every((node, i) => node === nodes[i]);
      }, original)).toBe(true);
    }
    const result = await observer.evaluate(value => value.read());
    expect(result.writes).toBe(0);
    expect(result.afterBytes).toEqual(result.beforeBytes);
  } finally {
    await observer.evaluate(value => value.restore());
    await observer.dispose(); await original.dispose();
  }
});
