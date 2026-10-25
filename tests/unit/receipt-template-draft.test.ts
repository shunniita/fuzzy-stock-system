import { describe, expect, test } from 'vitest';
import { practiceLedger, type Meta } from '../../src/domain/ledger.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { saveReceiptTemplate, type ReceiptTemplate } from '../../src/domain/receipt-template.ts';
import { readPinnedRecipe, receiptPreviewSignature } from '../../src/ui/receipt-template-draft.ts';
import { receiptTemplateOps } from '../../src/ui/receipt-template-ui.ts';
import type { Values } from '../../src/ui/dom.ts';
import type { State } from '../../src/ui/supply-ui.ts';

const meta: Meta = { eventId: 'parent', actor: '架空担当A', occurredAt: null, recordedAt: '2026-10-24T09:00:00+09:00' };
const child: ReceiptTemplate = { id: 'child', name: '架空Qの構成', product: 'Q', productUnit: '個', project: null, basis: 'label', rows: [{ item: 'S', unit: '本', perSet: 3, location: 'S1' }] };
const parent: ReceiptTemplate = { id: 'parent', name: '架空Rの構成', product: 'R', productUnit: '台', project: null, basis: 'label', rows: [{ item: 'Q', unit: '個', perSet: 1, location: 'S1', assembly: child }] };
const state: State = { ledger: practiceLedger, supply: saveReceiptTemplate(practiceLedger, emptySupply, { ...meta, eventId: 'child-save' }, child) };
const fields = (): Record<string, string> => ({ template: '', templateName: parent.name, templateProduct: 'R', templateProductUnit: '台', templateBasis: 'label', templateRows: '1', t0item: 'Q', t0unit: '個', t0location: 'S1', t0perSet: '1', t0assembly: JSON.stringify(child) });
const values = (input: Record<string, string>, checked = true): Values => ({ text: name => input[name] ?? '', checked: () => checked });
const ops = receiptTemplateOps({ ledger: () => state.ledger, supply: () => state.supply });
function save(input: Record<string, string>) { return ops['templateSave']!.run(state, meta, values(input), undefined).state; }

describe('組立UIの固定コピー境界', () => {
  test('保存と同じcanonical順・独立した値で復号し、入力を変えない', () => {
    const raw = JSON.stringify(child), result = readPinnedRecipe(raw, state.ledger.masters);
    expect(JSON.stringify(result)).toBe(raw); expect(result).not.toBe(child);
    expect(save(fields()).supply.receiptTemplates['parent']).toEqual(parent);
    expect(JSON.stringify(child)).toBe(raw); expect(state.supply.receiptTemplates['parent']).toBeUndefined();
  });
  test.each([
    ['未知欄', { ...child, extra: true }, '欄が不正'],
    ['未知単位', { ...child, productUnit: '架空単位' }, '単位'],
    ['50行超過', { ...child, rows: Array.from({ length: 51 }, () => child.rows[0]) }, '明細は'],
    ['高さ超過', { ...child, rows: [{ ...child.rows[0], assembly: parent }] }, '高さ'],
  ])('%sの隠しコピーを通さない', (_, input, reason) => {
    expect(() => readPinnedRecipe(JSON.stringify(input), state.ledger.masters)).toThrow(reason);
  });
  test('数値原文の丸めを復号前に拒む', () => {
    expect(() => readPinnedRecipe(JSON.stringify(child).replace('"perSet":3', '"perSet":3.0000000000000001'), state.ledger.masters)).toThrow();
  });
  test('深さ内でも全構成500行を超える隠しコピーは復号しない', () => {
    const wideChild = { ...child, rows: Array.from({ length: 50 }, () => child.rows[0]) };
    const wideParent = { ...parent, rows: Array.from({ length: 10 }, () => ({ ...parent.rows[0], assembly: wideChild })) };
    expect(() => readPinnedRecipe(JSON.stringify(wideParent), state.ledger.masters)).toThrow('全構成は500行');
  });
  test('構造が正当でも未登録の子内容をsave境界で拒み、状態を変えない', () => {
    const input = fields(); input['t0assembly'] = JSON.stringify({ ...child, rows: [{ ...child.rows[0], perSet: 9 }] });
    const before = JSON.stringify(state); expect(() => save(input)).toThrow('登録済み'); expect(JSON.stringify(state)).toBe(before);
  });
  test('新UIは旧平面の編集にも製品単位の明示を要求する', () => {
    const input = fields(); input['templateProductUnit'] = ''; input['t0assembly'] = '';
    expect(() => save(input)).toThrow('単位を選ぶ');
  });
  test('リンクした行の小数を整数へ丸めず拒む', () => {
    const input = fields(); input['t0perSet'] = '1.1'; expect(() => save(input)).toThrow();
  });
  test('完全な親子・案件・用途・数量・経路を確認signatureへ結び付ける', () => {
    const project = { kind: 'common' } as const, signature = receiptPreviewSignature(parent, project, 10, ['parts']);
    for (const changed of [
      receiptPreviewSignature({ ...parent, rows: [{ ...parent.rows[0]!, assembly: { ...child, name: '改訂' } }] }, project, 10, ['parts']),
      receiptPreviewSignature(parent, { kind: 'unassigned' }, 10, ['parts']),
      receiptPreviewSignature(parent, project, 9, ['parts']),
      receiptPreviewSignature(parent, project, 10, ['assembled']),
    ]) expect(changed).not.toBe(signature);
  });
  test('イベントを発火しない経路改変も再展開を要求し、旧数量を受け付けない', () => {
    const saved = save(fields()), input = { template: 'parent', sets: '10', project: 'common', route0: 'parts', actual0: '10', shortfall0: '0', templateRevision: receiptPreviewSignature(parent, { kind: 'common' }, 10, ['assembled']) };
    const before = JSON.stringify(saved);
    expect(() => ops['templateReceive']!.run(saved, { ...meta, eventId: 'receive' }, values(input), undefined)).toThrow('展開');
    expect(JSON.stringify(saved)).toBe(before);
  });
  test('宣言単位のない旧平面セットの受け取り入力は従来どおり使える', () => {
    const legacy: ReceiptTemplate = { id: 'legacy', name: '架空旧平面', product: 'R', project: null, basis: 'label', rows: [{ item: 'R', unit: '台', perSet: 1, location: 'S1' }] };
    const oldState = { ledger: state.ledger, supply: { ...emptySupply, receiptTemplates: { legacy } } };
    const input = { template: legacy.id, project: 'common', sets: '2', actual0: '2', shortfall0: '0', templateRevision: receiptPreviewSignature(legacy, { kind: 'common' }, 2, ['assembled']) };
    const received = ops['templateReceive']!.run(oldState, { ...meta, eventId: 'receive-legacy' }, values(input), undefined).state;
    expect(Object.values(received.supply.receipts).map(row => row.received)).toEqual([2]);
    expect(Object.values(received.ledger.lots).map(lot => lot.item)).toEqual(['R']);
  });
});
