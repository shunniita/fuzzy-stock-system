import { expect, test, type Locator, type Page } from '@playwright/test';
import { changeMasters, practiceLedger, type Meta } from '../../src/domain/ledger.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { saveReceiptTemplate } from '../../src/domain/receipt-template.ts';
import { initial, serialize } from '../../src/ui/storage.ts';
import { goTo, selectOperation, waitForApp, waitForPersistence } from './helpers.ts';
import { snapshotOf } from './conflict-helpers.ts';

const meta = (eventId: string): Meta => ({ eventId, actor: '架空担当A', recordedAt: '2026-11-20T09:00:00+09:00', occurredAt: '2026-11-20T09:00:00+09:00' });
const kit = { id: 'kit', name: '架空登録セット', product: 'R', productUnit: '台', basis: 'label', rows: [{ item: 'P', unit: '個', perSet: 2, location: 'S1' }] } as const;
const formOf = (page: Page) => page.getByRole('form', { name: '操作の入力' });

// A-001（内部ID A-001）に呼び名を付け、品番・コード A-001 を B-001 へ対応変更し、さらに B-001 を B-009 に変えて A-001 を空ける。
async function openFreed(page: Page): Promise<Locator> {
  let ledger = changeMasters(practiceLedger, meta('m1'), { action: 'rename', type: 'case', id: 'A-001', name: '架空旧案件A', reason: '架空の名称付与' });
  ledger = changeMasters(ledger, meta('m2'), { action: 'code', type: 'case', id: 'B-001', code: 'A-001', reason: '架空の付け替え' }, true);
  ledger = changeMasters(ledger, meta('m3'), { action: 'code', type: 'case', id: 'B-001', code: 'B-009', reason: '架空の変更' });
  const supply = saveReceiptTemplate(ledger, emptySupply, meta('op1'), kit);
  await page.goto('/'); await waitForApp(page);
  await page.evaluate(raw => { localStorage.setItem('fuzzy-stock/slot-A', raw); localStorage.setItem('fuzzy-stock/head', 'A'); }, serialize(initial(ledger, supply)));
  await page.reload(); await waitForApp(page); await goTo(page, 'stock');
  await selectOperation(formOf(page).locator('[name=op]'), 'templateNeedGenerate');
  const form = formOf(page);
  await form.locator('[name=needTemplate]').selectOption('kit');
  await form.locator('[name=needCount]').fill('3');
  return form;
}

async function previewAndRecord(page: Page, form: Locator): Promise<void> {
  await form.getByRole('button', { name: '必要明細をプレビュー', exact: true }).click();
  await form.locator('[name=needConfirmed]').check();
  await form.getByRole('button', { name: '記録する', exact: true }).click();
  await waitForPersistence(page);
  await expect(page.locator('#input > [role=status]')).toContainText('記録した');
}

test('2.1・2.2 品番・コードのない案件・用途を「対象」の一覧から選んで生成する', async ({ page }) => {
  const form = await openFreed(page);
  await form.locator('[name=needCaseTarget]').selectOption({ label: '（仮）架空旧案件A' });
  await expect(form.locator('[name=needCase]')).toBeHidden();
  await previewAndRecord(page, form);
  const saved = await snapshotOf(page);
  expect(Object.keys(saved.supply.templateNeeds)).toEqual(['A-001']);
  expect(saved.ledger.masters.cases['A-001']?.code).toBeNull();
});

test('1.1・3.1 以前の品番・コードを入れると以前の持ち主を案内し、記録すると新しい案件・用途になる', async ({ page }) => {
  const form = await openFreed(page);
  await form.locator('[name=needCase]').fill('A-001');
  const notice = form.locator('[data-case-notice]');
  await expect(notice).toContainText('以前は（仮）架空旧案件A、B-009が使っていた');
  await expect(notice.getByRole('button', { name: 'この案件を開く' })).toHaveCount(0);
  await previewAndRecord(page, form);
  const saved = await snapshotOf(page);
  const [project] = Object.keys(saved.supply.templateNeeds);
  expect(project).not.toBe('A-001');
  expect(saved.ledger.masters.cases[project!]?.code).toBe('A-001');
});
