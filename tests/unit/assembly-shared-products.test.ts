import { expect, test } from 'vitest';
import { practiceLedger, type Ledger, type Meta } from '../../src/domain/ledger.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { deleteReceiptTemplate, receiveTemplate, saveReceiptTemplate, validateReceiptTemplates, type ReceiptTemplate } from '../../src/domain/receipt-template.ts';
import { expandAssemblyRecipe } from '../../src/domain/assembly-recipes.ts';
import { initial, parse, serialize } from '../../src/ui/storage.ts';

const at = '2026-10-24T09:00:00+09:00';
const meta = (eventId: string): Meta => ({ eventId, occurredAt: at, recordedAt: at, actor: '架空担当A' });
const ledger: Ledger = { ...practiceLedger, masters: { ...practiceLedger.masters, items: { ...practiceLedger.masters.items,
  X: { ...practiceLedger.masters.items.R!, id: 'X', code: null, name: '架空組立X' },
  Z: { ...practiceLedger.masters.items.R!, id: 'Z', code: null, name: '架空製品Z' },
} } };
const row = (item: string, unit: string, perSet: number, location: string) => ({ item, unit, perSet, location });

test('AR11: 別製品R/Zが同じX構成を使い、直下/子の同部品も場所と位置を分け、元子改訂・削除後も両親のpinを保つ', () => {
  const child: ReceiptTemplate = { id: 'child', name: '架空X構成', product: 'X', productUnit: '台', project: null, basis: 'counted', rows: [row('P', '個', 2, 'S1'), row('Q', '個', 3, 'T')] };
  const r: ReceiptTemplate = { id: 'r', name: '架空R構成', product: 'R', productUnit: '台', project: null, basis: 'label', rows: [row('P', '個', 2, 'S2'), { ...row('X', '台', 1, 'S1'), assembly: child }] };
  const z: ReceiptTemplate = { id: 'z', name: '架空Z構成', product: 'Z', productUnit: '台', project: null, basis: 'counted', rows: [{ ...row('X', '台', 2, 'S2'), assembly: child }, row('P', '個', 1, 'T')] };
  let supply = saveReceiptTemplate(ledger, emptySupply, meta('save-child'), child);
  supply = saveReceiptTemplate(ledger, supply, meta('save-r'), r);
  supply = saveReceiptTemplate(ledger, supply, meta('save-z'), z);
  const firstR = supply.receiptTemplates.r!, firstZ = supply.receiptTemplates.z!;
  expect(firstR.rows[1]!.assembly).not.toBe(firstZ.rows[0]!.assembly);
  supply = saveReceiptTemplate(ledger, supply, meta('revise-child'), { ...child, rows: [{ ...child.rows[0]!, perSet: 4 }, child.rows[1]!] });
  supply = deleteReceiptTemplate(supply, ledger.masters, meta('delete-child'), child.id);
  expect(supply.receiptTemplates.r).toEqual(firstR); expect(supply.receiptTemplates.z).toEqual(firstZ);
  const rRows = expandAssemblyRecipe(ledger.masters, firstR, 10, ['assembled', 'parts']);
  const zRows = expandAssemblyRecipe(ledger.masters, firstZ, 5, ['parts', 'assembled']);
  expect(rRows.map(part => [part.item, part.planned, part.location, part.parentIndex, part.childIndex])).toEqual([['P', 20, 'S2', 0, null], ['P', 20, 'S1', 1, 0], ['Q', 30, 'T', 1, 1]]);
  expect(zRows.map(part => [part.item, part.planned, part.location, part.parentIndex, part.childIndex])).toEqual([['P', 20, 'S1', 0, 0], ['Q', 30, 'T', 0, 1], ['P', 5, 'T', 1, null]]);
  const project = { kind: 'case', id: 'A-001' } as const;
  const first = receiveTemplate({ ledger, supply }, meta('receive-r'), r.id, project, 10, rRows.map(part => ({ quantity: part.planned, shortfall: 0 })), null, ['assembled', 'parts']);
  const last = receiveTemplate(first, meta('receive-z'), z.id, project, 5, zRows.map(part => ({ quantity: part.planned, shortfall: 0 })), null, ['parts', 'assembled']);
  expect(Object.values(last.ledger.lots).map(lot => [lot.item, lot.location])).toEqual([...rRows, ...zRows].map(part => [part.item, part.location]));
  expect(Object.values(last.supply.receipts).map(receipt => receipt.received)).toEqual([20, 20, 30, 20, 30, 5]);
  expect(last.ledger.history.every(event => event.kind !== 'use' && event.kind !== 'start')).toBe(true);
  for (const batch of last.supply.log.filter(event => event.kind === 'templateReceipt')) {
    expect(batch.template.rows.find(part => part.assembly)?.assembly).toEqual(child);
    expect(batch.rows.map(part => part.lotId)).toHaveLength(3);
  }
  validateReceiptTemplates(last.ledger, last.supply);
  const snapshot = initial(last.ledger, last.supply); expect(parse(serialize(snapshot))).toEqual(snapshot);
});
