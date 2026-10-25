import { describe, expect, test } from 'vitest';
import { practiceLedger, type Meta } from '../../src/domain/ledger.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { saveReceiptTemplate, deleteReceiptTemplate, expandReceiptTemplate, receiveTemplate, type ReceiptTemplate } from '../../src/domain/receipt-template.ts';

const meta = (eventId: string): Meta => ({ eventId, actor: '架空担当A', occurredAt: '2026-10-19T09:00:00+09:00', recordedAt: '2026-10-19T09:00:00+09:00' });
export const parts: ReceiptTemplate = { id: 'kit', name: '架空の部品セット', product: 'R', project: null, basis: 'label', rows: [
  { item: 'P', unit: '個', perSet: 2, location: 'S1' }, { item: 'Q', unit: '個', perSet: 1, location: 'S1' }, { item: 'S', unit: '本', perSet: 4, location: 'S2' },
] };
const caseA = { kind: 'case', id: 'A-001' } as const;
const recv = (s: Parameters<typeof receiveTemplate>[0], m: Meta, sets: number, quantities: number[]) => receiveTemplate(s, m, 'kit', caseA, sets, quantities.map(quantity => ({ quantity, shortfall: 0 })), null);
const saved = () => saveReceiptTemplate(practiceLedger, emptySupply, meta('op1'), parts);
describe('セット 要件1.1-2.3', () => {
  test('構成を保存し正確に10セットを20/10/40へ展開する', () => {
    const supply = saved();
    expect(supply).toHaveProperty('receiptTemplates.kit', parts);
    expect(expandReceiptTemplate(practiceLedger, parts, 10)).toEqual([20, 10, 40]);
    expect(supply.log.at(-1)).toMatchObject({ kind: 'receiptTemplateSave', before: null, after: parts });
  });
  test('変更・削除は旧新の構成を履歴に残す', () => {
    const revised = saveReceiptTemplate(practiceLedger, saved(), meta('op2'), { ...parts, name: '変更後' });
    expect(revised.log.at(-1)).toMatchObject({ before: parts, after: { name: '変更後' } });
    const removed = deleteReceiptTemplate(revised, practiceLedger.masters, meta('op3'), parts.id);
    expect(removed).toHaveProperty('receiptTemplates', {});
    expect(removed.log.at(-1)).toMatchObject({ kind: 'receiptTemplateDelete', before: { name: '変更後' } });
  });
  test('キーの順序だけ違う同じ構成の再保存は変更なしとして拒否する', () => {
    const reordered = { rows: parts.rows.map(r => ({ location: r.location, perSet: r.perSet, unit: r.unit, item: r.item })), basis: parts.basis, product: 'R', name: parts.name, id: parts.id };
    expect(() => saveReceiptTemplate(practiceLedger, saved(), meta('op2'), reordered)).toThrow('変更がない');
  });
  test('各部品の実受け取りと出典をまとめて返し、元の状態やテンプレートへ逆流しない', () => {
    const supply = saved(), state = { ledger: practiceLedger, supply };
    const result = recv(state, meta('op2'), 10, [19, 0, 40]);
    expect(Object.values(result.ledger.lots).map(l => l.quantity.kind === 'known' ? l.quantity.numeric.value : null)).toEqual([19, 40]);
    expect(Object.values(result.supply.receipts).map(r => [r.received, r.provisional])).toEqual([[19, true], [40, true]]);
    expect(result.supply.log.at(-1)).toMatchObject({ kind: 'templateReceipt', template: parts, sets: 10, rows: [{ quantity: 19 }, { lotId: null, quantity: 0 }, { quantity: 40 }] });
    expect(practiceLedger.lots).toEqual({});
    expect(supply.receipts).toEqual({});
    expect(expandReceiptTemplate(result.ledger, parts, 10)).toEqual([20, 10, 40]);
    expect(() => recv(result, meta('op2'), 10, [19, 0, 40])).toThrow();
    const again = recv(result, meta('op3'), 10, [20, 10, 40]);
    expect(Object.keys(again.supply.receipts)).toHaveLength(5);
  });
  test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN])('セット数%sは保存前に拒否', sets => {
    expect(() => expandReceiptTemplate(practiceLedger, parts, sets)).toThrow();
  });
  test.each([0, -1, 0.1, Infinity])('整数単位の不正構成量%sを拒否', perSet => {
    expect(() => saveReceiptTemplate(practiceLedger, emptySupply, meta('op1'), { ...parts, rows: [{ ...parts.rows[0]!, perSet }] })).toThrow();
  });
  test('未登録単位・廃止品目・無効な後続行は全件未適用', () => {
    expect(() => saveReceiptTemplate(practiceLedger, emptySupply, meta('op1'), { ...parts, rows: [{ ...parts.rows[0]!, unit: '箱' }] })).toThrow();
    const state = { ledger: practiceLedger, supply: saved() };
    expect(() => recv(state, meta('op2'), 10, [20, 10, -1])).toThrow();
    expect(state.ledger.lots).toEqual({});
    expect(state.supply.receipts).toEqual({});
    const stopped = { ...practiceLedger, masters: { ...practiceLedger.masters, items: { ...practiceLedger.masters.items, S: { ...practiceLedger.masters.items['S']!, active: false } } } };
    expect(() => recv({ ...state, ledger: stopped }, meta('op2'), 10, [20, 10, 40])).toThrow();
  });
  test('全行0・行数違い・乗算超過を拒否', () => {
    const state = { ledger: practiceLedger, supply: saved() };
    expect(() => recv(state, meta('op2'), 10, [0, 0, 0])).toThrow();
    expect(() => recv(state, meta('op2'), 10, [20])).toThrow();
    expect(() => expandReceiptTemplate(practiceLedger, parts, Number.MAX_SAFE_INTEGER)).toThrow();
  });
  test('50行まで保存し51行・空の構成・空の名前を拒否', () => {
    const rows = Array.from({ length: 50 }, () => ({ ...parts.rows[0]! }));
    expect(saveReceiptTemplate(practiceLedger, emptySupply, meta('op1'), { ...parts, rows }).receiptTemplates['kit']?.rows).toHaveLength(50);
    for (const invalid of [{ ...parts, rows: [...rows, rows[0]!] }, { ...parts, rows: [] }, { ...parts, name: ' ' }]) expect(() => saveReceiptTemplate(practiceLedger, emptySupply, meta('op1'), invalid)).toThrow();
  });
  test('案件・用途中断は受け取り時に、発生時点の記録の対象外は保存時にも受け取り時にも拒否する', () => {
    const stopped = { ...practiceLedger, masters: { ...practiceLedger.masters, cases: { ...practiceLedger.masters.cases, 'A-001': { ...practiceLedger.masters.cases['A-001']!, active: false } } } };
    expect(saveReceiptTemplate(stopped, emptySupply, meta('op1'), parts).receiptTemplates['kit']).toEqual(parts);
    expect(() => recv({ ledger: stopped, supply: saved() }, meta('op2'), 1, [2, 1, 4])).toThrow('案件・用途');
    const outside = { ...practiceLedger, masters: { ...practiceLedger.masters, locations: { ...practiceLedger.masters.locations, S1: { ...practiceLedger.masters.locations['S1']!, scope: [{ from: null, inScope: false }, { from: '2026-10-19T10:00:00+09:00', inScope: true }] } } } };
    expect(() => saveReceiptTemplate(outside, emptySupply, meta('op1'), parts)).toThrow();
    expect(() => recv({ ledger: outside, supply: saved() }, meta('op2'), 1, [2, 1, 4])).toThrow();
    expect(saveReceiptTemplate(outside, emptySupply, { ...meta('op1'), occurredAt: '2026-10-19T11:00:00+09:00' }, parts).receiptTemplates['kit']).toEqual(parts);
  });
  test('0.1精度の0.3を3セットで正確に0.9にする', () => {
    const ledger = { ...practiceLedger, masters: { ...practiceLedger.masters, items: { ...practiceLedger.masters.items, P: { ...practiceLedger.masters.items['P']!, unitSteps: { 個: 0.1 as const } } } } };
    const template = { ...parts, rows: [{ ...parts.rows[0]!, perSet: 0.3 }] };
    const supply = saveReceiptTemplate(ledger, emptySupply, meta('op1'), template);
    expect(expandReceiptTemplate(ledger, template, 3)).toEqual([0.9]);
    expect(Object.values(recv({ ledger, supply }, meta('op2'), 3, [0.8]).supply.receipts)[0]?.received).toBe(0.8);
  });
});
