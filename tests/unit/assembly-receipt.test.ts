import { describe, expect, test } from 'vitest';
import { practiceLedger, type Ledger, type Meta } from '../../src/domain/ledger.ts';
import { allocateArrival, cancelRequest, emptySupply, receiveLot, recordReceiptTemplate, requestProgressOf, reviseArrival, reviseReceipt, validateReceipts, type Supply, type SupplyEvent } from '../../src/domain/supply.ts';
import type { ItemMaster } from '../../src/domain/masters.ts';
import { deleteReceiptTemplate, expandReceiptTemplate, receiveTemplate, saveReceiptTemplate, validateReceiptTemplates, type ReceiptInput, type ReceiptRoute, type ReceiptTemplate } from '../../src/domain/receipt-template.ts';
import { normalizeAssemblyRecipe } from '../../src/domain/assembly-recipes.ts';
import { validateRequests } from '../../src/domain/request-history.ts';
import { observe } from '../../src/domain/quantity.ts';

const at = '2026-10-24T09:00:00+09:00';
const meta = (eventId: string, occurredAt: string | null = at): Meta => ({ eventId, actor: '架空担当A', occurredAt, recordedAt: occurredAt ?? at });
const item = (id: string): ItemMaster => ({ ...practiceLedger.masters.items['P']!, id, code: null, name: `架空${id}`, units: ['個', '台'], unitSteps: { 個: 1, 台: 1 } });
const ledger: Ledger = { ...practiceLedger, masters: { ...practiceLedger.masters, items: { ...practiceLedger.masters.items,
  A: item('A'), B: { ...item('B'), unitSteps: { 個: 0.1, 台: 1 } }, C: item('C'), X: item('X'), R: item('R'),
} } };
const project = { kind: 'case', id: 'A-001' } satisfies Parameters<typeof receiveTemplate>[3];
const row = (item: string, perSet = 1, location = 'T') => ({ item, unit: '個', perSet, location });
const child = (): ReceiptTemplate => ({ id: 'child', name: '架空組立X', product: 'X', productUnit: '個', project: null, basis: 'counted', rows: [row('B', 3), row('C')] });
const parent = (assembly = child()): ReceiptTemplate => ({ id: 'parent', name: '架空製品R', product: 'R', productUnit: '台', project: null, basis: 'label', rows: [row('A', 2, 'S1'), { ...row('X', 1, 'S2'), assembly }] });
type State = { ledger: Ledger; supply: Supply };
const saved = (template = parent()): State => {
  const source = template.rows.find(r => r.assembly !== undefined)?.assembly ?? child();
  const supply = saveReceiptTemplate(ledger, emptySupply, meta('child-save'), source);
  return { ledger, supply: saveReceiptTemplate(ledger, supply, meta('parent-save'), template) };
};
const inputs = (quantities: number[], shortfalls: number[] = []): ReceiptInput[] => quantities.map((quantity, i) => ({ quantity, shortfall: shortfalls[i] ?? 0 }));
const receive = (state = saved(), values = inputs([20, 30, 10]), routes: readonly ReceiptRoute[] | undefined = ['assembled', 'parts'], vendor: string | null = null): State =>
  receiveTemplate(state, meta('receive'), 'parent', project, 10, values, vendor, routes);
const check = (state: State) => {
  validateReceiptTemplates(state.ledger, state.supply);
  validateRequests(state.supply);
  validateReceipts(state.supply);
};
type ReceiptEvent = Extract<SupplyEvent, { kind: 'templateReceipt' }>;
const receipt = (state: State): ReceiptEvent => {
  const event = state.supply.log.find(e => e.kind === 'templateReceipt');
  if (!event || event.kind !== 'templateReceipt') throw new Error('受け取り記録がない');
  return event;
};
const changeReceipt = (state: State, change: (event: ReceiptEvent) => ReceiptEvent): State => ({ ...state,
  supply: { ...state.supply, log: state.supply.log.map(event => event.kind === 'templateReceipt' ? change(event) : event) },
});
const rewriteParent = (state: State, change: (template: ReceiptTemplate) => ReceiptTemplate): State => ({ ...state, supply: {
  ...state.supply, receiptTemplates: { ...state.supply.receiptTemplates, parent: change(state.supply.receiptTemplates['parent']!) },
  log: state.supply.log.map(event => event.kind === 'receiptTemplateSave' && event.after.id === 'parent'
    ? { ...event, before: event.before === null ? null : change(event.before), after: change(event.after) }
    : event.kind === 'templateReceipt' ? { ...event, template: change(event.template) } : event),
} });

describe('組立受け取り task2 要件3.1-3.4,4.1-4.4,5.1-5.3 domain', () => {
  test('自作はA20/B30/C10だけ受け入れ、位置順のID・子の場所・親の根拠を使う', () => {
    const state = saved(), before = JSON.stringify(state);
    const result = receive(state);
    expect(Object.values(result.ledger.lots).map(l => [l.id, l.item, l.location, l.project, l.stage])).toEqual([
      ['receive-lot1', 'A', 'S1', project, { kind: 'none' }],
      ['receive-lot2', 'B', 'T', project, { kind: 'none' }],
      ['receive-lot3', 'C', 'T', project, { kind: 'none' }],
    ]);
    expect(Object.values(result.supply.receipts).map(r => [r.received, r.provisional])).toEqual([[20, true], [30, true], [10, true]]);
    expect(result.ledger.history.map(e => [e.eventId, e.kind])).toEqual([['receive-r1', 'register'], ['receive-r2', 'register'], ['receive-r3', 'register']]);
    expect(receipt(result)).toMatchObject({ template: state.supply.receiptTemplates['parent'], routes: ['assembled', 'parts'], sets: 10, project });
    expect(expandReceiptTemplate(ledger, parent(), 10, ['assembled', 'parts'])).toEqual([20, 30, 10]);
    expect(JSON.stringify(state)).toBe(before);
    check(result);
  });
  test('組立済みはA20/X10だけ受け入れ、参照子へ在庫・不足依頼を作らない', () => {
    const result = receive(saved(), inputs([20, 7], [0, 3]), ['assembled', 'assembled'], '架空商社');
    expect(Object.values(result.ledger.lots).map(l => [l.item, l.location])).toEqual([['A', 'S1'], ['X', 'S2']]);
    expect(Object.values(result.supply.requests).map(r => [r.id, r.item, r.quantity])).toEqual([['receive-s2', 'X', 3]]);
    expect(receipt(result).template.rows[1]!.assembly).toEqual(child());
    expect(expandReceiptTemplate(ledger, parent(), 10, ['assembled', 'assembled'])).toEqual([20, 10]);
    check(result);
  });
  test('経路省略の新規受け取りは組立済みを記録し、渡された経路配列はコピーする', () => {
    const state = saved();
    const result = receiveTemplate(state, meta('receive'), 'parent', project, 10, inputs([20, 10]), null);
    expect(receipt(result).routes).toEqual(['assembled', 'assembled']);
    const routes: ReceiptRoute[] = ['assembled', 'parts'];
    const other = receive(state, inputs([20, 30, 10]), routes);
    expect(receipt(other).routes).not.toBe(routes);
    expect(Object.isFrozen(routes)).toBe(false);
    routes[1] = 'assembled';
    expect(receipt(other).routes).toEqual(['assembled', 'parts']);
    check(result);
    check(other);
  });
  test('同じ部品を直下と子の別場所へそれぞれ受け入れ、行を統合しない', () => {
    const template = { ...parent(), rows: [row('B', 2, 'S1'), parent().rows[1]!] };
    const result = receive(saved(template));
    expect(Object.values(result.ledger.lots).map(l => [l.item, l.location])).toEqual([['B', 'S1'], ['B', 'T'], ['C', 'T']]);
    check(result);
  });
  test('全量欠品でも実受け取り0と不足依頼だけをまとめて記録できる', () => {
    const result = receive(saved(), inputs([0, 0, 0], [20, 30, 10]), ['assembled', 'parts'], '架空商社');
    expect(result.ledger.lots).toEqual({});
    expect(result.supply.receipts).toEqual({});
    expect(Object.values(result.supply.requests).map(r => [r.item, r.quantity])).toEqual([['A', 20], ['B', 30], ['C', 10]]);
    expect(receipt(result).rows.every(r => r.lotId === null && r.quantity === 0)).toBe(true);
    check(result);
  });
  test('欠品は既存の後日割り当て・到着訂正・取消と併存し、生成時の記録を維持する', () => {
    const initial = receive(saved(), inputs([20, 27, 10], [0, 3, 0]), ['assembled', 'parts'], '架空商社');
    const later = receiveLot(initial.ledger, initial.supply, meta('later', '2026-10-25T09:00:00+09:00'), { id: 'late-B', item: 'B', unit: '個', location: 'T', project }, 'counted', 3);
    const allocated = allocateArrival(later.ledger, later.supply, meta('allocation', '2026-10-25T10:00:00+09:00'), 'receive-s2', { receiptLotId: 'late-B', arrived: 3, good: 3 });
    expect(requestProgressOf(later.ledger.masters, allocated.requests['receive-s2']!).outstanding).toBe(0);
    check({ ...later, supply: allocated });
    const revised = reviseArrival(later.ledger, allocated, meta('arrival-edit', '2026-10-25T11:00:00+09:00'), 'receive-s2', 'allocation', { arrived: 2, good: 2 });
    const cancelled = cancelRequest(revised, ledger.masters, meta('cancel', '2026-10-25T12:00:00+09:00'), 'receive-s2', '架空の取消理由');
    const corrected = reviseReceipt(later.ledger, cancelled, meta('receipt-edit', '2026-10-25T13:00:00+09:00'), 'receive-lot2', 26, '架空の訂正理由');
    check({ ...later, supply: corrected });
    const corrupt = { ...corrected, requests: { ...corrected.requests, 'receive-s2': { ...corrected.requests['receive-s2']!, cancelled: null } } };
    expect(() => validateRequests(corrupt)).toThrow();
  });
  test('受け取り対象の末端小数と展開後の不足上限を正確に検査', () => {
    const assembly = { ...child(), rows: [row('B', 0.3)] };
    const template = { ...parent(assembly), rows: [{ ...row('X', 2, 'S2'), assembly }] };
    const state = saved(template);
    const result = receiveTemplate(state, meta('receive'), 'parent', project, 3, inputs([1.5], [0.3]), '架空商社', ['parts']);
    expect(receipt(result).rows).toEqual([{ lotId: 'receive-lot1', quantity: 1.5, shortfall: 0.3 }]);
    expect(result.supply.requests['receive-s1']!.quantity).toBe(0.3);
    expect(() => receiveTemplate(state, meta('receive'), 'parent', project, 3, inputs([0], [1.9]), '架空商社', ['parts'])).toThrow('予定数1.8');
    check(result);
  });
  test('子改訂・削除後も保存済みの親を受け入れ、過去の受け取りを照合できる', () => {
    const state = saved();
    const revised = saveReceiptTemplate(ledger, state.supply, meta('child-edit'), { ...child(), rows: [row('B', 4)] });
    const deleted = deleteReceiptTemplate(revised, ledger.masters, meta('child-delete'), 'child');
    const result = receive({ ledger, supply: deleted });
    expect(Object.values(result.supply.receipts).map(r => r.received)).toEqual([20, 30, 10]);
    const renamed = saveReceiptTemplate(result.ledger, result.supply, meta('parent-edit'), { ...parent(), name: '架空の改名' });
    check({ ...result, supply: renamed });
    const removed = deleteReceiptTemplate(renamed, ledger.masters, meta('parent-delete'), 'parent');
    check({ ...result, supply: removed });
    expect(receipt(result).template.name).toBe('架空製品R');
  });
  test('構成の既知版は実際の日時の並替えではなく保存履歴の追記順で判定する', () => {
    const state = receive();
    const supply = { ...state.supply, log: state.supply.log.map(event => event.eventId === 'child-save'
      ? { ...event, occurredAt: '2026-10-25T09:00:00+09:00' } : event) };
    check({ ...state, supply });
  });
  test.each(['item', 'location', 'scope'] as const)('参照だけの子%sの利用停止・範囲外は組立済みの受け取りを妨げない', mode => {
    const state = saved();
    const masters = { ...ledger.masters,
      items: mode === 'item' ? { ...ledger.masters.items, B: { ...ledger.masters.items['B']!, active: false } } : ledger.masters.items,
      locations: mode === 'location' ? { ...ledger.masters.locations, T: { ...ledger.masters.locations['T']!, active: false } }
        : mode === 'scope' ? { ...ledger.masters.locations, T: { ...ledger.masters.locations['T']!, scope: [{ from: null, inScope: false }] } } : ledger.masters.locations,
    };
    const stopped = { ...state, ledger: { ...ledger, masters } };
    expect(() => receive(stopped, inputs([20, 10]), ['assembled', 'assembled'])).not.toThrow();
    expect(() => receive(stopped)).toThrow();
    check(receive(stopped, inputs([20, 10]), ['assembled', 'assembled']));
  });
  test.each(['item', 'location', 'scope'] as const)('参照だけの親組立品%sの利用停止・範囲外はpartsの受け取りを妨げない', mode => {
    const state = saved();
    const masters = { ...ledger.masters,
      items: mode === 'item' ? { ...ledger.masters.items, X: { ...ledger.masters.items['X']!, active: false } } : ledger.masters.items,
      locations: mode === 'location' ? { ...ledger.masters.locations, S2: { ...ledger.masters.locations['S2']!, active: false } }
        : mode === 'scope' ? { ...ledger.masters.locations, S2: { ...ledger.masters.locations['S2']!, scope: [{ from: null, inScope: false }] } } : ledger.masters.locations,
    };
    const stopped = { ...state, ledger: { ...ledger, masters } };
    expect(() => receive(stopped)).not.toThrow();
    expect(() => receive(stopped, inputs([20, 10]), ['assembled', 'assembled'])).toThrow();
    check(receive(stopped));
  });
  test('親製品と今回案件・用途の利用停止は従来どおり拒否し、子の旧案件・用途は持ち込まない', () => {
    const state = saved();
    for (const masters of [
      { ...ledger.masters, items: { ...ledger.masters.items, R: { ...ledger.masters.items['R']!, active: false } } },
      { ...ledger.masters, cases: { ...ledger.masters.cases, 'A-001': { ...ledger.masters.cases['A-001']!, active: false } } },
    ]) expect(() => receive({ ...state, ledger: { ...ledger, masters } })).toThrow();
    const masters = { ...ledger.masters, cases: { ...ledger.masters.cases, 'A-002': { ...ledger.masters.cases['A-002']!, active: false } } };
    const source = { ...child(), project: { kind: 'case', id: 'A-002' } } satisfies ReceiptTemplate;
    const historical = recordReceiptTemplate(emptySupply, ledger.masters, meta('child-save'), source);
    const supply = saveReceiptTemplate(ledger, historical, meta('parent-save'), parent(source));
    check(receive({ ledger: { ...ledger, masters }, supply }));
  });
  test.each([
    ['all-zero', inputs([0, 0, 0]), ['assembled', 'parts'], null],
    ['missing-input', inputs([20, 30]), ['assembled', 'parts'], null],
    ['extra-input', inputs([20, 30, 10, 1]), ['assembled', 'parts'], null],
    ['negative', inputs([20, -1, 10]), ['assembled', 'parts'], null],
    ['decimal-step', inputs([20, 30, 0.5]), ['assembled', 'parts'], null],
    ['shortfall-overflow', inputs([20, 0, 10], [0, 30.1, 0]), ['assembled', 'parts'], '架空商社'],
    ['missing-vendor', inputs([20, 27, 10], [0, 3, 0]), ['assembled', 'parts'], null],
    ['unexpected-vendor', inputs([20, 30, 10]), ['assembled', 'parts'], '架空商社'],
    ['missing-route', inputs([20, 30, 10]), ['assembled'], null],
    ['plain-parts', inputs([20, 30, 10]), ['parts', 'parts'], null],
  ] satisfies [string, ReceiptInput[], ReceiptRoute[], string | null][])('%sは何も適用せず拒否', (_name, values, routes, vendor) => {
    const state = saved(), before = JSON.stringify(state);
    expect(() => receive(state, values, routes, vendor)).toThrow();
    expect(JSON.stringify(state)).toBe(before);
  });
  test('後続の生成操作ID衝突でも、先行行の受け取りと依頼を元状態へ反映しない', () => {
    const state = saved();
    const occupied = receiveLot(state.ledger, state.supply, meta('receive-r3'), { id: 'occupied', item: 'C', unit: '個', location: 'T', project }, 'counted', 1);
    const before = JSON.stringify(occupied);
    expect(() => receive(occupied, inputs([20, 27, 10], [0, 3, 0]), ['assembled', 'parts'], '架空商社')).toThrow();
    expect(JSON.stringify(occupied)).toBe(before);
    expect(occupied.supply.requests).toEqual({});
  });
  test('積の上限超過は保存構成を省略せず、受け取りの前に拒否', () => {
    const assembly = { ...child(), rows: [row('C', Number.MAX_SAFE_INTEGER)] };
    const state = saved(parent(assembly)), before = JSON.stringify(state);
    expect(() => receive(state)).toThrow();
    expect(JSON.stringify(state)).toBe(before);
  });
  test.each(['missing', 'invalid', 'array-like', 'wrong-length', 'other-route'] as const)('記録済み組立受け取りの経路%sを拒否', mode => {
    const state = receive();
    const corrupt = changeReceipt(state, event => {
      if (mode === 'missing') { const { routes: _routes, ...rest } = event; return rest; }
      if (mode === 'invalid') return { ...event, routes: JSON.parse('["assembled","invalid"]') };
      if (mode === 'array-like') return { ...event, routes: JSON.parse('{"0":"assembled","1":"parts","length":2}') };
      return { ...event, routes: mode === 'wrong-length' ? ['assembled'] : ['assembled', 'assembled'] };
    });
    expect(() => check(corrupt)).toThrow();
  });
  test('同じ件数の経路変更でも派生品目と場所の不一致を検出する', () => {
    const assembly = { ...child(), rows: [row('B', 1)] };
    const state = receive(saved(parent(assembly)), inputs([20, 10]));
    expect(() => check(changeReceipt(state, event => ({ ...event, routes: ['assembled', 'assembled'] })))).toThrow();
  });
  test.each(['template-only', 'unknown-child-copy', 'future-source', 'source-after-parent'] as const)('構成出典の改変%sを追記順で拒否', mode => {
    const state = receive();
    const revised = { ...child(), rows: [row('B', 4), row('C')] };
    const change = (template: ReceiptTemplate): ReceiptTemplate => ({ ...template, rows: template.rows.map(r => r.assembly === undefined ? r : { ...r, assembly: revised }) });
    let corrupt = mode === 'template-only' ? changeReceipt(state, event => ({ ...event, template: change(event.template) })) : rewriteParent(state, change);
    if (mode === 'future-source') corrupt = { ...corrupt, supply: saveReceiptTemplate(ledger, corrupt.supply, meta('future-child-save'), revised) };
    if (mode === 'source-after-parent') corrupt = { ...state, supply: { ...state.supply, log: [...state.supply.log.filter(e => e.eventId !== 'child-save'), state.supply.log.find(e => e.eventId === 'child-save')!] } };
    expect(() => check(corrupt)).toThrow();
  });
  test.each(['receipt-meta', 'registration-meta', 'registration-place', 'registration-basis', 'shortfall-request', 'zero-row'] as const)('派生記録の改変%sを拒否', mode => {
    const state = receive(saved(), inputs([20, 27, 10], [0, 3, 0]), ['assembled', 'parts'], '架空商社');
    let corrupt: State = state;
    if (mode === 'receipt-meta') corrupt = { ...state, supply: { ...state.supply, log: state.supply.log.map(e => e.eventId === 'receive-r2-c' ? { ...e, actor: '架空担当B' } : e) } };
    if (mode === 'registration-meta') corrupt = { ...state, ledger: { ...state.ledger, history: state.ledger.history.map(e => e.eventId === 'receive-r2' ? { ...e, occurredAt: null } : e) } };
    if (mode === 'registration-place' || mode === 'registration-basis') corrupt = { ...state, ledger: { ...state.ledger,
      history: state.ledger.history.map(e => e.eventId !== 'receive-r2' ? e : { ...e, changes: e.changes.map(change => ({ ...change, after: {
        ...change.after, location: mode === 'registration-place' ? 'S2' : change.after.location,
        quantity: mode !== 'registration-basis' || change.after.quantity.kind !== 'known' ? change.after.quantity : { ...change.after.quantity,
          terms: change.after.quantity.terms.map(term => ({ ...term, observation: observe(term.observation.id, 'counted', term.observation.value) })) },
      } })) }),
    } };
    if (mode === 'shortfall-request') corrupt = { ...state, supply: { ...state.supply, log: state.supply.log.map(e => e.kind === 'requestRecord' && e.eventId === 'receive-s2' ? { ...e, request: { ...e.request, item: 'X' } } : e) } };
    if (mode === 'zero-row') corrupt = changeReceipt(state, e => ({ ...e, rows: e.rows.map((r, i) => i === 1 ? { ...r, lotId: null, quantity: 0 } : r) }));
    expect(() => check(corrupt)).toThrow();
  });
  test('旧平面受け取りはroutesなしの形と出典照合を維持する', () => {
    const legacy: ReceiptTemplate = { id: 'legacy', name: '架空旧平面', product: 'R', project: null, basis: 'label', rows: [row('A', 2, 'S1')] };
    const supply = saveReceiptTemplate(ledger, emptySupply, meta('save-legacy'), legacy);
    const result = receiveTemplate({ ledger, supply }, meta('legacy-receive'), 'legacy', project, 10, inputs([20]), null);
    expect(receipt(result)).not.toHaveProperty('routes');
    check(result);
  });
  test('prototype由来の製品単位も検査し、未登録単位をコピーへ通さない', () => {
    const { productUnit: _unit, ...template } = parent();
    Object.setPrototypeOf(template, { productUnit: '未登録' });
    expect(() => normalizeAssemblyRecipe(template, ledger.masters)).toThrow('単位');
  });
});
