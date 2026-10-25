import { legacyEventLabels } from '../fixtures/history-labels.ts';
import { describe, expect, test } from 'vitest';
import { practiceLedger, type Ledger, type Meta } from '../../src/domain/ledger.ts';
import { emptySupply, type Supply } from '../../src/domain/supply.ts';
import { type ItemMaster } from '../../src/domain/masters.ts';
import { checkReceiptTemplate, deleteReceiptTemplate, expandReceiptTemplate, receiveTemplate, saveReceiptTemplate, validateReceiptTemplates, type ReceiptTemplate } from '../../src/domain/receipt-template.ts';
import { assemblyItemIds, checkAssemblyRecipe, defaultAssemblyRoutes, expandAssemblyRecipe, normalizeAssemblyRecipe } from '../../src/domain/assembly-recipes.ts';

const meta = (eventId: string): Meta => ({ eventId, actor: '架空担当A', occurredAt: '2026-10-24T09:00:00+09:00', recordedAt: '2026-10-24T09:00:00+09:00' });
const item = (id: string): ItemMaster => ({ ...practiceLedger.masters.items['P']!, id, code: null, name: `架空${id}`, units: ['個', '台', '箱'], unitSteps: { 個: 1, 台: 1, 箱: 1 } });
const ledger: Ledger = { ...practiceLedger, masters: { ...practiceLedger.masters, items: { ...practiceLedger.masters.items,
  A: item('A'), B: { ...item('B'), unitSteps: { 個: 0.1, 台: 1, 箱: 1 } }, C: item('C'), X: item('X'), R: item('R'),
} } };
const row = (item: string, perSet = 1, location = 'S1') => ({ item, unit: '個', perSet, location });
const child = (): ReceiptTemplate => ({ id: 'child', name: '架空組立X', product: 'X', productUnit: '個', project: null, basis: 'counted', rows: [row('B', 3), row('C')] });
const parent = (assembly = child()): ReceiptTemplate => ({ id: 'parent', name: '架空製品R', product: 'R', productUnit: '台', project: null, basis: 'label', rows: [row('A', 2), { ...row('X'), assembly }] });
const savedChild = (value = child()): Supply => saveReceiptTemplate(ledger, emptySupply, meta('child-save'), value);
const save = (value: ReceiptTemplate, supply = savedChild()) => saveReceiptTemplate(ledger, supply, meta('parent-save'), value);

describe('組立構成 task1 要件1.1-1.7,3.1-3.4', () => {
  test('R10のpartsはA20/B30/C10、assembledはA20/X10を構成位置と場所付きで返す', () => {
    const template = parent(), before = JSON.stringify({ ledger, template });
    expect(expandAssemblyRecipe(ledger.masters, template, 10, ['assembled', 'parts'])).toEqual([
      { ...row('A', 2), parentIndex: 0, childIndex: null, planned: 20 },
      { ...row('B', 3), parentIndex: 1, childIndex: 0, planned: 30 },
      { ...row('C'), parentIndex: 1, childIndex: 1, planned: 10 },
    ]);
    expect(expandAssemblyRecipe(ledger.masters, template, 10, ['assembled', 'assembled']).map(r => [r.item, r.planned])).toEqual([['A', 20], ['X', 10]]);
    expect(defaultAssemblyRoutes(template)).toEqual(['assembled', 'assembled']);
    expect(expandAssemblyRecipe(ledger.masters, template, 10).map(r => r.planned)).toEqual([20, 10]);
    expect(JSON.stringify({ ledger, template })).toBe(before);
    expect(assemblyItemIds(template)).toEqual(['R', 'A', 'X', 'B', 'C']);
  });
  test('登録済みの選択した子の写しを固定し、元入力の変更・子改訂・子削除でも変わらない', () => {
    const source = child(), input = parent(source), supply = save(input);
    const pinned = supply.receiptTemplates['parent']!;
    expect(pinned.rows[1]!.assembly).toEqual(source);
    expect(pinned.rows[1]!.assembly).not.toBe(source);
    source.rows = [row('B', 4)];
    expect(pinned.rows[1]!.assembly!.rows[0]!.perSet).toBe(3);
    expect(Object.isFrozen(pinned.rows[1]!.assembly!.rows)).toBe(true);
    const revised = saveReceiptTemplate(ledger, supply, meta('child-edit'), source);
    const deleted = deleteReceiptTemplate(revised, ledger.masters, meta('child-delete'), 'child');
    expect(expandAssemblyRecipe(ledger.masters, deleted.receiptTemplates['parent']!, 10, ['assembled', 'parts']).map(r => r.planned)).toEqual([20, 30, 10]);
    const kept = saveReceiptTemplate(ledger, deleted, meta('parent-rename'), { ...pinned, name: '架空の改名' });
    expect(kept.receiptTemplates['parent']!.rows[1]!.assembly).toEqual(child());
    const refreshed = saveReceiptTemplate(ledger, revised, meta('parent-refresh'), parent(source));
    expect(refreshed.receiptTemplates['parent']!.rows[1]!.assembly!.rows[0]!.perSet).toBe(4);
  });
  test('選択後に元子が改訂・削除されても既知の保存版を新規親に取り込める', () => {
    const source = child();
    const revised = saveReceiptTemplate(ledger, savedChild(), meta('child-edit'), { ...source, rows: [row('B', 4)] });
    const deleted = deleteReceiptTemplate(revised, ledger.masters, meta('child-delete'), source.id);
    expect(save(parent(source), deleted).receiptTemplates['parent']!.rows[1]!.assembly).toEqual(source);
  });
  test('子の過去版が旧自己品目の平面でも、その後登録した有効な保存版を取り込める', () => {
    const legacy: ReceiptTemplate = { id: 'child', name: '架空旧版', product: 'X', project: null, basis: 'label', rows: [row('X')] };
    const supply: Supply = { ...emptySupply, receiptTemplates: { child: legacy }, log: [{ ...meta('legacy-save'), ...legacyEventLabels, kind: 'receiptTemplateSave', before: null, after: legacy }] };
    const revised = saveReceiptTemplate(ledger, supply, meta('child-revise'), child());
    const removed = deleteReceiptTemplate(revised, ledger.masters, meta('child-delete'), 'child');
    expect(save(parent(), removed).receiptTemplates['parent']!.rows[1]!.assembly).toEqual(child());
  });
  test('未登録の子や登録済み子の内容を捏造した取り込みを保存しない', () => {
    expect(() => save(parent(), emptySupply)).toThrow('登録');
    expect(() => save(parent({ ...child(), rows: [row('B', 4)] }))).toThrow('登録');
    expect(emptySupply.receiptTemplates).toEqual({});
  });
  test('同じ品目の別セットを推測で選ばず、指定したセットIDと版を使う', () => {
    const alternate = { ...child(), id: 'alternate', rows: [row('B', 4)] };
    const supply = saveReceiptTemplate(ledger, savedChild(), meta('alternate-save'), alternate);
    expect(save(parent(alternate), supply).receiptTemplates['parent']!.rows[1]!.assembly!.id).toBe('alternate');
    expect(() => save(parent({ ...alternate, id: 'not-selected' }), supply)).toThrow('登録');
  });
  test('子のキー順が違う再保存も変更なしとし、旧平面のJSON順を変えない', () => {
    const supply = save(parent());
    const assembly = child();
    const reordered: ReceiptTemplate = { rows: assembly.rows.map(r => ({ location: r.location, perSet: r.perSet, item: r.item, unit: r.unit })), basis: assembly.basis,
      project: assembly.project, productUnit: assembly.productUnit!, product: assembly.product, name: assembly.name, id: assembly.id };
    expect(() => saveReceiptTemplate(ledger, supply, meta('same'), parent(reordered))).toThrow('変更がない');
    const flat: ReceiptTemplate = { id: 'old', name: '架空旧平面', product: 'R', project: null, basis: 'label', rows: [row('A')] };
    expect(JSON.stringify(normalizeAssemblyRecipe(flat, ledger.masters))).toBe(JSON.stringify(flat));
  });
  test('同じ組立品・部品を別枝で使え、各位置と場所を統合しない', () => {
    const template = { ...parent(), rows: [row('B', 2, 'S2'), { ...row('X', 2), assembly: child() }, { ...row('X', 3), assembly: child() }] };
    expect(() => save(template)).not.toThrow();
    expect(expandAssemblyRecipe(ledger.masters, template, 10, ['assembled', 'parts', 'parts']).map(r => [r.item, r.parentIndex, r.childIndex, r.planned, r.location])).toEqual([
      ['B', 0, null, 20, 'S2'], ['B', 1, 0, 60, 'S1'], ['C', 1, 1, 20, 'S1'], ['B', 2, 0, 90, 'S1'], ['C', 2, 1, 30, 'S1'],
    ]);
    expect(assemblyItemIds(template)).toEqual(['R', 'B', 'X', 'C']);
  });
  test.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('組立品の親あたり数量%sは正の安全な整数だけ許す', perSet => {
    const template = parent();
    expect(() => checkAssemblyRecipe({ ...template, rows: [{ ...template.rows[1]!, perSet }] }, ledger.masters)).toThrow();
  });
  test('末端小数0.3×親2×製作3は正確に1.8、子の場所を使う', () => {
    const template = { ...parent(), rows: [{ ...row('X', 2, 'S2'), assembly: { ...child(), rows: [row('B', 0.3, 'T')] } }] };
    expect(expandAssemblyRecipe(ledger.masters, template, 3, ['parts'])).toEqual([{ ...row('B', 0.6, 'T'), parentIndex: 0, childIndex: 0, planned: 1.8 }]);
    expect(() => checkAssemblyRecipe({ ...template, rows: [{ ...row('X'), assembly: { ...child(), rows: [row('B', 0.01)] } }] }, ledger.masters)).toThrow();
  });
  test('整数・小数の中間積と最終積の上限超過は切り捨てず拒否', () => {
    for (const [part, perSet] of [['C', Number.MAX_SAFE_INTEGER], ['B', 562949953421311.9]] satisfies [string, number][]) {
      const template = { ...parent(), rows: [{ ...row('X', 2), assembly: { ...child(), rows: [row(part, perSet)] } }] };
      expect(() => expandAssemblyRecipe(ledger.masters, template, 1, ['parts'])).toThrow();
      expect(() => expandAssemblyRecipe(ledger.masters, { ...template, rows: [{ ...template.rows[0]!, perSet: 1 }] }, 2, ['parts'])).toThrow();
    }
  });
  test('自己材料・祖先材料・セットID循環・製品不一致・高さ3を拒否', () => {
    const invalid: ReceiptTemplate[] = [
      { ...parent(), rows: [row('R')] },
      parent({ ...child(), rows: [row('X')] }),
      parent({ ...child(), rows: [row('R')] }),
      parent({ ...child(), id: 'parent' }),
      parent({ ...child(), product: 'A' }),
      parent({ ...child(), rows: [{ ...row('B'), assembly: { ...child(), id: 'grandchild', product: 'B', rows: [row('C')] } }] }),
    ];
    for (const template of invalid) expect(() => checkAssemblyRecipe(template, ledger.masters)).toThrow();
  });
  test('循環した入力と非常に深い入力をコピーより前に有限の検査で拒否', () => {
    const cyclic = parent();
    cyclic.rows = [{ ...row('X'), assembly: cyclic }];
    expect(() => normalizeAssemblyRecipe(cyclic, ledger.masters)).toThrow();
    let deep = child();
    for (let depth = 0; depth < 10000; depth++) deep = { ...child(), rows: [{ ...row('X'), assembly: deep }] };
    expect(() => normalizeAssemblyRecipe(parent(deep), ledger.masters)).toThrow();
  });
  test('継承されたassembly欄もコピー前の高さ制限を迂回できない', () => {
    const part = row('B');
    Object.setPrototypeOf(part, { assembly: { ...child(), id: 'grandchild', product: 'B', rows: [row('C')] } });
    expect(() => normalizeAssemblyRecipe(parent({ ...child(), rows: [part] }), ledger.masters)).toThrow('高さ');
  });
  test('各セット1〜50行、全構成500行は通し501行を拒否', () => {
    const leaves = Array.from({ length: 50 }, () => row('B'));
    const assembly = { ...child(), rows: leaves };
    const roots = Array.from({ length: 10 }, () => ({ ...row('X'), assembly }));
    const boundary = { ...parent(), rows: [...roots.slice(0, 9), { ...row('X'), assembly: { ...assembly, rows: leaves.slice(0, 40) } }] };
    expect(() => checkAssemblyRecipe(boundary, ledger.masters)).not.toThrow();
    expect(expandAssemblyRecipe(ledger.masters, boundary, 1, Array.from({ length: 10 }, () => 'parts'))).toHaveLength(490);
    expect(() => checkAssemblyRecipe({ ...boundary, rows: [...boundary.rows, row('A')] }, ledger.masters)).toThrow('500');
    for (const rows of [[], [...leaves, row('B')]]) expect(() => checkAssemblyRecipe(parent({ ...child(), rows }), ledger.masters)).toThrow('50');
    expect(() => checkAssemblyRecipe({ ...parent(), rows: Array.from({ length: 51 }, () => row('A')) }, ledger.masters)).toThrow('50');
  });
  test('製品単位は非null製品の登録単位を要求し、組立親にも宣言を要求', () => {
    for (const template of [{ ...child(), product: null }, { ...child(), productUnit: '未登録' }, { ...child(), productUnit: '' }]) {
      expect(() => checkAssemblyRecipe(template, ledger.masters)).toThrow();
    }
    const { productUnit: _unit, ...undeclared } = parent();
    expect(() => checkAssemblyRecipe(undeclared, ledger.masters)).toThrow('単位');
  });
  test('子の宣言単位が親行と異なる箱/個を両経路で拒否、台/台は受理', () => {
    const mismatched = { ...parent(), rows: [{ ...row('X'), unit: '箱', assembly: child() }] };
    for (const route of ['assembled', 'parts'] satisfies ('assembled' | 'parts')[]) expect(() => expandAssemblyRecipe(ledger.masters, mismatched, 10, [route])).toThrow('単位');
    const matching = { ...parent(), rows: [{ ...row('X'), unit: '台', assembly: { ...child(), productUnit: '台' } }] };
    expect(expandAssemblyRecipe(ledger.masters, matching, 10, ['parts']).map(r => r.planned)).toEqual([30, 10]);
  });
  test('旧平面の単位欠落は補完せず展開可能、宣言のない旧子の利用は拒否', () => {
    const { productUnit: _unit, ...legacy } = child();
    expect(expandReceiptTemplate(ledger, legacy, 10)).toEqual([30, 10]);
    expect(normalizeAssemblyRecipe(legacy, ledger.masters)).not.toHaveProperty('productUnit');
    expect(() => checkAssemblyRecipe(parent(legacy), ledger.masters)).toThrow('単位');
  });
  test('旧自己品目行の読込・既存受け取りは維持、新規保存・単位宣言・子取込は拒否', () => {
    const legacy: ReceiptTemplate = { id: 'legacy', name: '架空旧自己品目', product: 'R', project: null, basis: 'label', rows: [row('R')] };
    expect(() => checkReceiptTemplate(legacy, ledger.masters)).not.toThrow();
    const supply: Supply = { ...emptySupply, receiptTemplates: { legacy }, log: [{ ...meta('legacy-save'), ...legacyEventLabels, kind: 'receiptTemplateSave', before: null, after: legacy }] };
    expect(() => validateReceiptTemplates(ledger, supply)).not.toThrow();
    const received = receiveTemplate({ ledger, supply }, meta('legacy-receive'), 'legacy', { kind: 'common' }, 2, [{ quantity: 2, shortfall: 0 }], null);
    expect(Object.values(received.ledger.lots)[0]!.item).toBe('R');
    expect(() => save(legacy)).toThrow();
    expect(() => checkReceiptTemplate({ ...legacy, productUnit: '個' }, ledger.masters)).toThrow();
    expect(() => checkAssemblyRecipe({ ...parent(), rows: [{ ...row('R'), assembly: legacy }] }, ledger.masters)).toThrow();
  });
  test('子の廃止品目・場所も構造の参照には保持、未登録の参照は拒否', () => {
    const masters = { ...ledger.masters, items: { ...ledger.masters.items, B: { ...ledger.masters.items['B']!, active: false } }, locations: { ...ledger.masters.locations, S1: { ...ledger.masters.locations['S1']!, active: false } } };
    expect(expandAssemblyRecipe(masters, parent(), 1).map(r => r.item)).toEqual(['A', 'X']);
    expect(() => checkAssemblyRecipe(parent({ ...child(), rows: [row('missing')] }), masters)).toThrow();
    expect(() => checkAssemblyRecipe(parent({ ...child(), rows: [row('B', 1, 'missing')] }), masters)).toThrow();
  });
  test('partsは構成必須、経路の不足・余分・不正を拒否', () => {
    for (const routes of [[], ['assembled'], ['assembled', 'assembled', 'assembled'], ['parts', 'assembled']] satisfies ('assembled' | 'parts')[][]) {
      expect(() => expandAssemblyRecipe(ledger.masters, parent(), 1, routes)).toThrow();
    }
    expect(() => expandAssemblyRecipe(ledger.masters, parent(), 1, JSON.parse('["assembled","invalid"]'))).toThrow();
  });
  test.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('展開の製作数%sを拒否', sets => {
    expect(() => expandAssemblyRecipe(ledger.masters, parent(), sets)).toThrow();
  });
});
