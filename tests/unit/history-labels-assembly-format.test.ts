import { describe, expect, test } from 'vitest';
import { practiceLedger, type Ledger, type Meta } from '../../src/domain/ledger.ts';
import { deleteReceiptTemplate, receiveTemplate, saveReceiptTemplate, type ReceiptTemplate, type ReceiptRoute } from '../../src/domain/receipt-template.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { receiptTemplateText, supplyEventText } from '../../src/ui/supply-format.ts';
import { viewSheetsOf } from '../../src/ui/viewsheets.ts';

const at = '2026-10-24T09:00:00+09:00';
const meta = (eventId: string): Meta => ({ eventId, occurredAt: at, recordedAt: at, actor: '架空担当A' });
const ledger: Ledger = { ...practiceLedger, masters: { ...practiceLedger.masters, items: { ...practiceLedger.masters.items,
  X: { ...practiceLedger.masters.items.R!, id: 'X', code: 'X', name: '架空組立X' },
} } };
const row = (item: string, unit: string, perSet: number) => ({ item, unit, perSet, location: 'S1' });
const child: ReceiptTemplate = { id: 'child', name: '架空旧子構成', product: 'X', productUnit: '台', project: null, basis: 'counted', rows: [row('P', '個', 2), row('Q', '個', 3)] };
const parent: ReceiptTemplate = { id: 'parent', name: '架空製品Rの構成', product: 'R', productUnit: '台', project: null, basis: 'label', rows: [row('P', '個', 2), { ...row('X', '台', 1), assembly: child }] };
function received(route: ReceiptRoute) {
  let supply = saveReceiptTemplate(ledger, emptySupply, meta('child-save'), child);
  supply = saveReceiptTemplate(ledger, supply, meta('parent-save'), parent);
  return receiveTemplate({ ledger, supply }, meta('receive'), parent.id, { kind: 'case', id: 'A-001' }, 10,
    (route === 'parts' ? [20, 20, 30] : [20, 10]).map(quantity => ({ quantity, shortfall: 0 })), null, ['assembled', route]);
}

describe('履歴表示 task4 組立の固定構成と実際の受け取り行', () => {
  test.each(['assembled', 'parts'] as const)('%sの経路・製品単位・参照子を保持してExcelと同じ本文を示す', route => {
    const state = received(route), source = state.supply.log.find(e => e.kind === 'templateReceipt')!;
    const text = supplyEventText(state.ledger.masters, source);
    expect(text).toContain('架空旧子構成');
    expect(text).toContain('架空部品Q');
    expect(text).toContain('製作個数10台');
    if (route === 'parts') {
      expect(text).toContain('自作分の部品');
      expect(text).toMatch(/明細2・子明細1[^／]*予定20個[^／]*受け取り20個/);
      expect(text).toMatch(/明細2・子明細2[^／]*予定30個[^／]*受け取り30個/);
      expect(text).not.toContain('予定10台');
    } else {
      expect(text).toContain('組立済み');
      expect(text).toMatch(/明細2[^／]*予定10台[^／]*受け取り10台/);
      expect(text).not.toContain('子明細1 予定');
    }
    const history = viewSheetsOf(state, at).find(s => s.name === '供給の履歴')!;
    expect(history.rows.find(r => r[0] === source.eventId)?.[5]).toBe(text);
  });
  test('元子の変更削除と品目の改名中断後も、参照専用子の当時表示と固定構成を使う', () => {
    const state = received('assembled');
    let supply = saveReceiptTemplate(state.ledger, state.supply, meta('change-child'), { ...child, name: '架空新子構成', rows: [row('P', '個', 4)] });
    supply = deleteReceiptTemplate(supply, state.ledger.masters, meta('delete-child'), child.id);
    const changed: Ledger = { ...state.ledger, masters: { ...state.ledger.masters, items: Object.fromEntries(Object.entries(state.ledger.masters.items).map(([id, item]) => [id, { ...item, name: `変更後${id}`, active: false }])) } };
    const source = supply.log.find(e => e.kind === 'templateReceipt')!;
    const text = supplyEventText(changed.masters, source);
    expect(text).toContain('架空旧子構成'); expect(text).toContain('架空部品Q');
    expect(text).not.toContain('架空新子構成'); expect(text).not.toContain('変更後'); expect(text).not.toContain('利用停止');
    expect(text).toContain('組立済み');
  });
  test('共有セット表示の現在表示は現行登録情報を使う', () => {
    const changed = { ...ledger.masters, items: { ...ledger.masters.items, P: { ...ledger.masters.items.P!, code: 'NOW-P', name: '架空の現在名称' } } };
    expect(receiptTemplateText(changed, parent)).toContain('NOW-P');
  });
});
