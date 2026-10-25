import { expect, test, type Locator, type Page } from '@playwright/test';
import type { NeedRow } from '../../src/domain/need-import.ts';
import type { Snapshot } from '../../src/ui/storage.ts';
import { decodeSnapshot } from '../../src/ui/storageparse.ts';
import { previewNeedImport } from '../../src/domain/need-import.ts';
import { installSnapshot, savedSnapshot, withLegacyImport, withLegacyTrial } from './legacy-compat.ts';
import { selectOperation, goTo, cell, lot, opLabels, recorded, set, startEmpty, storageBytes, waitForApp } from './helpers.ts';

test.use({ trace: 'retain-on-failure' });

const form = (page: Page) => page.getByRole('form', { name: '操作の入力' });
const status = (page: Page) => page.getByRole('status');

async function snapshot(page: Page): Promise<Snapshot> {
  const text = await page.evaluate(() => localStorage.getItem(`fuzzy-stock/slot-${localStorage.getItem('fuzzy-stock/head')}`));
  if (!text) throw Error('保存なし');
  return decodeSnapshot(JSON.parse(text));
}

async function registerDecimalItem(page: Page): Promise<void> {
  await startEmpty(page);
  await selectOperation(form(page).locator('[name=op]'), { label: opLabels.masterItem });
  for (const [name, value] of Object.entries({ code: 'D', name: '架空小数材料D', units: 'kg', 'unitStep-kg': '0.1' })) await set(form(page).locator(`[name="${name}"]`), value);
  await form(page).getByRole('button', { name: '記録する' }).click();
  await expect(status(page)).toContainText('記録した');
}

const lotValue = (s: Snapshot, id: string) => {
  const quantity = s.ledger.lots[id]?.quantity;
  return quantity?.kind === 'known' ? quantity.numeric.value : quantity?.kind;
};
// 現在の登録情報と、登録・変更の履歴に残る品目Dの全ての版の精度。
const stepsOfD = (s: Snapshot) => [
  s.ledger.masters.items['D']?.unitSteps,
  ...s.ledger.history.flatMap(e => e.kind === 'master' ? e.masters.flatMap(pair => [pair.before, pair.after]) : [])
    .flatMap(m => m?.type === 'item' && m.id === 'D' ? [m.unitSteps] : []),
];

test('1.3: 名称・表示コード・試行対象・利用停止の変更と再読込のあとも、品目Dのkgは最小単位0.1のままで0.1の使用を受ける', async ({ page }) => {
  await registerDecimalItem(page);
  await goTo(page, 'stock');
  await recorded(page, 'register', { ...lot('D1', 'D', 'S1', 'counted', '1'), unit: 'kg' }, '08:00');
  const stillDecimal = async (name: string, changes: number, expected: number) => {
    await goTo(page, 'masters');
    await expect(page.getByRole('table', { name: '品目の登録情報' }).locator('tr', { hasText: name })).toContainText('kg：0.1');
    await goTo(page, 'stock');
    await recorded(page, 'use', { lot: 'D1', basis: 'counted', value: '0.1', usedFor: '架空作業' }, '12:00');
    const s = await snapshot(page);
    expect(lotValue(s, 'D1')).toBe(expected);
    const steps = stepsOfD(s);
    expect(steps).toHaveLength(changes * 2 + 2);
    for (const step of steps) expect(step).toEqual({ kg: 0.1 });
  };
  await stillDecimal('架空小数材料D', 0, 0.9);
  await goTo(page, 'stock');
  await recorded(page, 'masterRename', { target: 'item:D', name: '架空小数材料D改', reason: '架空の名称変更' }, '09:00');
  await stillDecimal('架空小数材料D改', 1, 0.8);
  await recorded(page, 'masterCode', { target: 'item:D', code: 'D7', reason: '架空の表示コード変更' }, '09:10');
  await expect(cell(page, 'D1', '品目')).toHaveText('D7');
  await stillDecimal('架空小数材料D改', 2, 0.7);
  await installSnapshot(page, withLegacyTrial(await savedSnapshot(page), 'legacy-decimal-trial', 'D', false));
  expect((await savedSnapshot(page)).ledger.masters.items['D']?.trial).toBe(false);
  await stillDecimal('架空小数材料D改', 3, 0.6);
  await recorded(page, 'masterDeactivate', { target: 'item:D', reason: '架空の廃番' }, '09:30');
  await expect(cell(page, 'D1', '品目')).toHaveText('D7（利用停止）');
  await stillDecimal('架空小数材料D改', 4, 0.5);
  await page.reload();
  await waitForApp(page);
  await stillDecimal('架空小数材料D改', 4, 0.4);
  await expect(cell(page, 'D1', '記録上の数と根拠')).toHaveText('記録上の数0.4kg');
});

// 画面の選択肢は登録済みの品目・単位だけなので、画面以外から来た値として選択肢を足して送る。
async function forceOption(select: Locator, value: string): Promise<void> {
  await select.evaluate((node, v) => { if (node instanceof HTMLSelectElement) node.append(new Option(v, v)); }, value);
  await select.selectOption(value);
}

async function requestFor(page: Page, item: string, unit: string, quantity: string): Promise<Locator> {
  const f = form(page);
  await selectOperation(f.locator('[name=op]'), { label: opLabels.requestRecord });
  await set(f.locator('[name=project]'), 'A-001');
  if (item === 'D') await f.locator('[name=item]').selectOption('D');
  else await forceOption(f.locator('[name=item]'), item);
  await forceOption(f.locator('[name=unit]'), unit);
  for (const [name, value] of Object.entries({ quantity, vendor: '架空の仕入先X', requestedOn: '2026-09-29', replyKind: 'none' })) await set(f.locator(`[name=${name}]`), value);
  await f.locator('[name=occurredAt]').fill('2026-09-29T09:00');
  await f.getByRole('button', { name: '記録する' }).click();
  return status(page);
}

test('1.4・履歴1.1: 精度不明の小数と未登録品目の依頼は無変更で拒否し、既知品目の整数の依頼を受ける', async ({ page }) => {
  await registerDecimalItem(page);
  const before = await storageBytes(page);
  await expect(await requestFor(page, 'ZZ9', 'kg', '0.5')).toContainText('記録していない：品目 ZZ9・単位 kg の最小単位の設定が不明なので小数を入力できない');
  expect(await storageBytes(page)).toEqual(before);
  await expect(await requestFor(page, 'D', '個', '0.5')).toContainText('記録していない：品目 D・単位 個 の最小単位の設定が不明なので小数を入力できない');
  expect(await storageBytes(page)).toEqual(before);
  await expect(await requestFor(page, 'ZZ9', 'kg', '2')).toContainText('記録していない：履歴の品目 ZZ9 が登録情報にない');
  expect(await storageBytes(page)).toEqual(before);
  expect((await snapshot(page)).supply.requests).toEqual({});
  await expect(await requestFor(page, 'D', 'kg', '2')).toContainText('記録した');
  const requests = Object.values((await snapshot(page)).supply.requests);
  expect(requests.map(r => [r.item, r.unit, r.quantity])).toEqual([['D', 'kg', 2]]);
});

const needRow: NeedRow = { format: 'fuzzy-stock-need-row', version: 1, source: '架空部品表D', line: '001', revision: '初版', previousRevision: null, caseCode: 'A-001', itemCode: 'D', unit: 'kg', required: { basis: 'counted', value: 0.3 }, dueDate: '2026-10-20' };
const rawOf = (change: Partial<NeedRow> = {}, value = 0.3) => JSON.stringify({ ...needRow, ...change, required: { basis: 'counted', value } });

test('3.2: 旧必要明細取込の0.3kgを再読込して不足へ表示し、精度外の旧原文は引き続き拒否する', async ({ page }) => {
  await registerDecimalItem(page);
  const legacy = withLegacyImport(await savedSnapshot(page), rawOf(), 'legacy-decimal-import');
  await installSnapshot(page, legacy);
  expect(Object.values((await savedSnapshot(page)).supply.needs).map(n => [n.item, n.unit, n.required])).toEqual([['D', 'kg', { basis: 'counted', value: 0.3 }]]);
  await goTo(page, 'supply');
  await expect(page.locator('#supply article[data-group="A-001/D/kg"]')).toContainText('不足 0.3kg');
  await page.reload(); await waitForApp(page); await goTo(page, 'supply');
  await expect(page.locator('#supply article[data-group="A-001/D/kg"]')).toContainText('不足 0.3kg');
  const before = await storageBytes(page);
  for (const [raw, reason] of [
    [rawOf({ line: '002' }, 0.05), '数量は最小単位0.1に合う値で入力する'],
    [rawOf({ line: '003', itemCode: 'ZZ9' }, 0.5), '品目・単位を確認できないので、小数の必要な数は取り込まない'],
    [rawOf({ line: '004', itemCode: 'P', unit: '個' }, 0.5), '数量は最小単位1に合う整数で入力する'],
  ] as const) {
    expect(() => previewNeedImport(legacy.supply, legacy.ledger.masters, raw)).toThrow(reason);
    expect(await storageBytes(page)).toEqual(before);
  }
});
