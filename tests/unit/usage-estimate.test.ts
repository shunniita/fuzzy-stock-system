import { describe, expect, test } from 'vitest';
import { correctOccurredAt, practiceLedger, merge, recount, register, resolveIssue, type Ledger, type Meta } from '../../src/domain/ledger.ts';
import { emptySupply, type Supply, type SupplyEvent } from '../../src/domain/supply.ts';
import type { ItemMaster } from '../../src/domain/masters.ts';
import { saveReceiptTemplate, type ReceiptTemplate } from '../../src/domain/receipt-template.ts';
import { EstimateInclusionRequired, estimateCandidates, startWithEstimate, validateUsageEstimates, type EstimateInput, type RecipeStart } from '../../src/domain/usage-estimate.ts';
import { initial, parse, serialize } from '../../src/ui/storage.ts';
import { decodeSnapshot } from '../../src/ui/storageparse.ts';
import { backupTextOf, readBackup } from '../../src/ui/backup.ts';
import { supplyEventText } from '../../src/ui/supply-format.ts';
import { createHistoryTargetCollector } from '../../src/domain/history-targets.ts';

const at = '2026-10-25T09:00:00+09:00';
const before = '2026-10-25T08:00:00+09:00';
const meta = (eventId: string, time = at): Meta => ({ eventId, actor: '架空担当A', occurredAt: time, recordedAt: time });
const item = (id: string, active = true): ItemMaster => ({ ...practiceLedger.masters.items['P']!, id, code: null, name: `架空${id}`, units: ['個', '台'], unitSteps: { 個: 1, 台: 1 }, active });
const project = { kind: 'common' } as const;
const masters = { ...practiceLedger.masters, items: { ...practiceLedger.masters.items, A: item('A'), B: { ...item('B'), unitSteps: { 個: 0.1, 台: 1 } as const }, C: item('C'), R: item('R') } };
const recipe: ReceiptTemplate = { id: 'r1', name: '架空製品R', product: 'R', productUnit: '台', project: null, basis: 'label',
  rows: [{ item: 'A', unit: '個', perSet: 4, location: 'S1' }, { item: 'C', unit: '個', perSet: 1, location: 'S1' }] };
type State = { ledger: Ledger; supply: Supply };

function prepared(template: ReceiptTemplate = recipe): State {
  let ledger: Ledger = { ...practiceLedger, masters };
  for (const [id, it, value] of [['A-1', 'A', 200], ['A-2', 'A', 10], ['C-1', 'C', 50], ['B-1', 'B', 100]] as const) {
    ledger = register(ledger, meta(`reg-${id}`, before), { id, item: it, unit: '個', project, location: 'S1' }, 'counted', value);
  }
  return { ledger, supply: saveReceiptTemplate(ledger, emptySupply, meta('save', before), template) };
}

const use = (lotId: string, value: number, basis: 'approximate' | 'counted' = 'approximate') => ({ lotId, basis, value });
const input = (rows: EstimateInput[], extra: Partial<RecipeStart> = {}): RecipeStart => ({
  lot: { id: 'W1', item: 'R', unit: '台', project, location: 'S1' }, process: { id: 'R組立', criterion: 'inspection' }, basis: 'counted', value: 20,
  templateId: 'r1', rows, manual: [], ...extra,
});
const estimateOf = (state: State) => {
  const e = state.supply.log.find((x) => x.kind === 'usageEstimate');
  if (e?.kind !== 'usageEstimate') throw new Error('推計がない');
  return e;
};
const quantityOf = (state: State, id: string) => {
  const q = state.ledger.lots[id]!.quantity;
  return q.kind === 'known' ? q.numeric.value : null;
};

describe('使用候補の算出', () => {
  test('1台4本×20台は80本、組立品の行は展開しない', () => {
    expect(estimateCandidates(masters, recipe, { item: 'R', unit: '台' }, 20).map((c) => c.calculated)).toEqual([80, 20]);
    const assembly: ReceiptTemplate = { ...recipe, rows: [{ item: 'C', unit: '個', perSet: 2, location: 'S1', assembly: { id: 'c', name: '子', product: 'C', productUnit: '個', project: null, basis: 'label', rows: [{ item: 'A', unit: '個', perSet: 3, location: 'S1' }] } }] };
    expect(estimateCandidates(masters, assembly, { item: 'R', unit: '台' }, 5)).toMatchObject([{ item: 'C', calculated: 10 }]);
  });
  test.each([
    ['製品単位の未宣言', { ...recipe, productUnit: undefined }, '台', 20, '宣言していない'],
    ['製品単位の不一致', recipe, '個', 20, '異なる'],
    ['台数不明', recipe, '台', null, '不明'],
    ['小数の台数', recipe, '台', 2.5, '正の整数'],
  ] as const)('%sでは候補を出さない', (_name, template, unit, sets, reason) => {
    const { productUnit, ...rest } = template;
    const t: ReceiptTemplate = productUnit === undefined ? rest : template;
    expect(() => estimateCandidates(masters, t, { item: 'R', unit }, sets)).toThrow(reason);
  });
  test('利用停止の品目は0で埋めず未確定にする', () => {
    const stopped = { ...masters, items: { ...masters.items, C: item('C', false) } };
    expect(estimateCandidates(stopped, recipe, { item: 'R', unit: '台' }, 20)[1]).toMatchObject({ calculated: null, reason: '品目が利用停止中' });
  });
});

describe('推計の記録', () => {
  test('手修正82はだいたい82として使用し、算出80と確定82を別に残す。除外は記録だけ残す', () => {
    const result = startWithEstimate(prepared(), meta('op1'), input([{ decision: 'use', uses: [use('A-1', 82)] }, { decision: 'exclude', uses: [] }]));
    expect(quantityOf(result, 'A-1')).toBe(118);
    expect(quantityOf(result, 'C-1')).toBe(50);
    expect(estimateOf(result)).toMatchObject({ eventId: 'op1-e', startEventId: 'op1', sets: 20, rows: [{ calculated: 80, confirmed: 82, decision: 'use', uses: ['op1-u1'] }, { calculated: 20, confirmed: null, decision: 'exclude', uses: [] }] });
    const used = result.ledger.history.find((e) => e.eventId === 'op1-u1');
    expect(used).toMatchObject({ kind: 'use', basis: 'approximate', value: 82, usedFor: 'W1の着手（工程R組立）・レシピ推計の明細1' });
    expect(result.ledger.history.find((e) => e.eventId === 'op1')).toMatchObject({ kind: 'start', materials: ['op1-u1'] });
    expect(() => validateUsageEstimates(result.ledger, result.supply)).not.toThrow();
    const text = supplyEventText(result.ledger.masters, estimateOf(result), createHistoryTargetCollector(result).supplyEventItemIds(estimateOf(result)));
    expect(text).toContain('算出80個→確定82個（差+2個）');
    expect(text).toContain('除外');
  });
  test('一つの明細を二つの保管単位に分け、確定は合計。数えた根拠は使用記録に残る', () => {
    const result = startWithEstimate(prepared(), meta('op1'), input([{ decision: 'use', uses: [use('A-1', 70, 'counted'), use('A-2', 10)] }, { decision: 'use', uses: [use('C-1', 20)] }]));
    expect(estimateOf(result).rows.map((r) => [r.confirmed, r.uses])).toEqual([[80, ['op1-u1', 'op1-u2']], [20, ['op1-u3']]]);
    expect(result.ledger.history.find((e) => e.eventId === 'op1-u1')).toMatchObject({ basis: 'counted' });
    // 使用を数えても最後に数えた数は変えない（4.7）。
    expect(result.ledger.lots['A-1']!.lastCount).toEqual(prepared().ledger.lots['A-1']!.lastCount);
  });
  test('20台作業の開始でも5台分だけを確定でき、未使用分は減らさない', () => {
    const result = startWithEstimate(prepared(), meta('op1'), input([{ decision: 'use', uses: [use('A-1', 20)] }, { decision: 'use', uses: [use('C-1', 5)] }]));
    expect([quantityOf(result, 'A-1'), quantityOf(result, 'C-1')]).toEqual([180, 45]);
  });
  test('負数になる使用は確認が必要として残し、作業の開始と推計も記録する', () => {
    const result = startWithEstimate(prepared(), meta('op1'), input([{ decision: 'use', uses: [use('A-2', 80)] }, { decision: 'exclude', uses: [] }]));
    expect(Object.values(result.ledger.issues).some((i) => i.reason === 'negative' && i.resolution === null)).toBe(true);
    expect(result.ledger.history.some((e) => e.eventId === 'op1' && e.kind === 'start')).toBe(true);
    expect(() => validateUsageEstimates(result.ledger, result.supply)).not.toThrow();
  });
  test('手入力の材料はセットにない品目なら推計とは別に記録し、同じ品目・単位なら拒否する', () => {
    const rows: EstimateInput[] = [{ decision: 'use', uses: [use('A-1', 80)] }, { decision: 'exclude', uses: [] }];
    const ok = startWithEstimate(prepared(), meta('op1'), input(rows, { manual: [{ lotId: 'B-1', basis: 'counted', value: 1.5 }] }));
    expect(ok.ledger.history.find((e) => e.eventId === 'op1-u2')).toMatchObject({ kind: 'use', usedFor: 'W1の着手（工程R組立）' });
    expect(estimateOf(ok).rows[0]!.uses).toEqual(['op1-u1']);
    expect(() => startWithEstimate(prepared(), meta('op1'), input(rows, { manual: [{ lotId: 'A-2', basis: 'counted', value: 2 }] }))).toThrow('推計の明細1と同じ品目・単位');
    // 除外した明細と同じ品目の手入力は、手入力を選んだものとして受ける。
    expect(() => startWithEstimate(prepared(), meta('op1'), input([{ decision: 'exclude', uses: [] }, { decision: 'exclude', uses: [] }], { manual: [{ lotId: 'A-2', basis: 'counted', value: 2 }] }))).not.toThrow();
  });
  test('包含の回答が要る使用は、どの内訳かを付けて断り、回答すれば記録する', () => {
    const rows = (inclusion?: 'included'): EstimateInput[] => [{ decision: 'use', uses: [{ ...use('A-1', 80), ...(inclusion ? { inclusion } : {}) }] }, { decision: 'exclude', uses: [] }];
    let caught: unknown;
    try { startWithEstimate(prepared(), meta('op1', before), input(rows())); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(EstimateInclusionRequired);
    expect((caught as EstimateInclusionRequired).target).toEqual({ kind: 'estimate', row: 0, use: 0 });
    expect(() => startWithEstimate(prepared(), meta('op1', before), input(rows('included')))).not.toThrow();
  });
  test('入力の不備は何も反映しない', () => {
    const state = prepared();
    for (const rows of [
      [{ decision: 'use', uses: [] }, { decision: 'exclude', uses: [] }],
      [{ decision: 'use', uses: [use('C-1', 80)] }, { decision: 'exclude', uses: [] }],
      [{ decision: 'use', uses: [use('A-1', 0)] }, { decision: 'exclude', uses: [] }],
      [{ decision: 'unresolved' }, { decision: 'exclude', uses: [] }],
      [{ decision: 'exclude', uses: [] }],
      [{ decision: 'use', uses: [use('A-1', 40), use('A-1', 40)] }, { decision: 'exclude', uses: [] }],
    ] as EstimateInput[][]) expect(() => startWithEstimate(state, meta('op1'), input(rows))).toThrow();
    expect(state.ledger.history.length).toBe(4);
  });
  test('算出できない明細は未確定のまま作業の開始でき、使用を記録しない', () => {
    const state = prepared();
    const stopped = { ...state, ledger: { ...state.ledger, masters: { ...state.ledger.masters, items: { ...state.ledger.masters.items, C: item('C', false) } } } };
    const result = startWithEstimate(stopped, meta('op1'), input([{ decision: 'use', uses: [use('A-1', 80)] }, { decision: 'unresolved' }]));
    expect(estimateOf(result).rows[1]).toEqual({ calculated: null, confirmed: null, decision: 'unresolved', uses: [] });
  });
  test('セットなしは手入力の材料だけで作業の開始し、推計を記録しない', () => {
    const result = startWithEstimate(prepared(), meta('op1'), input([], { templateId: null, manual: [{ lotId: 'A-1', basis: 'counted', value: 3 }] }));
    expect(result.supply.log.some((e) => e.kind === 'usageEstimate')).toBe(false);
    expect(quantityOf(result, 'A-1')).toBe(197);
  });
  test('後でセットを変えても記録済みの推計と台帳は変わらない', () => {
    const result = startWithEstimate(prepared(), meta('op1'), input([{ decision: 'use', uses: [use('A-1', 80)] }, { decision: 'exclude', uses: [] }]));
    const edited = { ...result, supply: saveReceiptTemplate(result.ledger, result.supply, meta('edit'), { ...recipe, rows: [{ ...recipe.rows[0]!, perSet: 5 }] }) };
    expect(estimateOf(edited).template).toEqual(recipe);
    expect(quantityOf(edited, 'A-1')).toBe(120);
    expect(() => validateUsageEstimates(edited.ledger, edited.supply)).not.toThrow();
  });
});

describe('保存と照合', () => {
  const recorded = () => startWithEstimate(prepared(), meta('op1'), input([{ decision: 'use', uses: [use('A-1', 82)] }, { decision: 'exclude', uses: [] }]));
  const withEstimate = (state: State, change: (e: Extract<SupplyEvent, { kind: 'usageEstimate' }>) => SupplyEvent): State =>
    ({ ...state, supply: { ...state.supply, log: state.supply.log.map((e) => (e.kind === 'usageEstimate' ? change(e) : e)) } });

  test('版10で往復し、バックアップからも復元できる', () => {
    const snapshot = initial(recorded().ledger, recorded().supply);
    expect(parse(serialize(snapshot))).toEqual(snapshot);
    expect(readBackup(new TextEncoder().encode(backupTextOf(snapshot, at)))).toMatchObject({ kind: 'ok', snapshot });
  });
  test('版9の保存データにセット推計があれば拒否する', () => {
    const wire = JSON.parse(serialize(initial(recorded().ledger, recorded().supply)), (key, value: unknown) => (key === 'consumable' || key === 'processes' || key === 'nextProcess') ? undefined : value);
    expect(() => decodeSnapshot({ ...wire, version: 9 })).toThrow('旧版はセット推計を持たない');
  });
  test.each([
    ['算出数量', (e: Extract<SupplyEvent, { kind: 'usageEstimate' }>) => ({ ...e, rows: [{ ...e.rows[0]!, calculated: 81 }, e.rows[1]!] }), '算出数量'],
    ['確定数量', (e: Extract<SupplyEvent, { kind: 'usageEstimate' }>) => ({ ...e, rows: [{ ...e.rows[0]!, confirmed: 80 }, e.rows[1]!] }), '確定数量'],
    ['写しの1個あたり', (e: Extract<SupplyEvent, { kind: 'usageEstimate' }>) => ({ ...e, template: { ...e.template, rows: [{ ...e.template.rows[0]!, perSet: 5 }, e.template.rows[1]!] }, rows: [{ ...e.rows[0]!, calculated: 100 }, { ...e.rows[1]!, calculated: 20 }] }), '当時のセット'],
    ['作業の開始の欠落', (e: Extract<SupplyEvent, { kind: 'usageEstimate' }>) => ({ ...e, startEventId: 'nope', eventId: 'nope-e' }), '作業の開始がない'],
    ['使った明細を除外へ書換え', (e: Extract<SupplyEvent, { kind: 'usageEstimate' }>) => ({ ...e, rows: [{ ...e.rows[0]!, confirmed: null, decision: 'exclude' as const, uses: [] }, e.rows[1]!] }), '推計の明細にない'],
    ['除外への使用', (e: Extract<SupplyEvent, { kind: 'usageEstimate' }>) => ({ ...e, rows: [e.rows[0]!, { ...e.rows[1]!, uses: ['op1-u1'] }] }), '明細2の使用'],
  ] as const)('%sの食い違いを拒否する', (_name, change, reason) => {
    const state = withEstimate(recorded(), change);
    expect(() => validateUsageEstimates(state.ledger, state.supply)).toThrow(reason);
  });
  test('推計の後の数え直し・保留の適用・日時訂正・統合を経ても読み込める。後で適用した使用の書換えは拒否する', () => {
    const later = (t: string) => meta(t, '2026-10-25T10:00:00+09:00');
    let state = startWithEstimate(prepared(), meta('op1'), input([{ decision: 'use', uses: [use('A-2', 80)] }, { decision: 'use', uses: [use('C-1', 20)] }]));
    let ledger = recount(state.ledger, later('rc'), 'A-2', 200, { kind: 'unknown' }, 'notIncluded');
    ledger = resolveIssue(ledger, later('rs'), 'op1-u1', 'apply', 'notIncluded');
    ledger = correctOccurredAt(ledger, later('ct'), 'op1', '2026-10-25T09:30:00+09:00');
    ledger = merge(ledger, later('mg'), 'A-2', 'A-1');
    state = { ...state, ledger };
    expect(() => validateUsageEstimates(state.ledger, state.supply)).not.toThrow();
    const snapshot = initial(state.ledger, state.supply);
    expect(parse(serialize(snapshot))).toEqual(snapshot);
    const history = state.ledger.history.map((x) => (x.eventId === 'op1-u1' && x.kind === 'use' ? { ...x, value: 90 } : x));
    const tampered = withEstimate({ ...state, ledger: { ...state.ledger, history } }, (x) => ({ ...x, rows: [{ ...x.rows[0]!, confirmed: 90 }, x.rows[1]!] }));
    expect(() => validateUsageEstimates(tampered.ledger, tampered.supply)).toThrow('の数量');
  });
  test('使用先に推計の印の文字列を含む手入力・旧版の作業の開始は、推計の使用と取り違えない', () => {
    const odd = 'X・セット推計の明細1';
    const plain = startWithEstimate(prepared(), meta('op1'), input([], { templateId: null, lot: { id: odd, item: 'R', unit: '台', project, location: 'S1' }, manual: [{ lotId: 'A-1', basis: 'counted', value: 1 }] }));
    expect(() => validateUsageEstimates(plain.ledger, plain.supply)).not.toThrow();
    const mixed = startWithEstimate(prepared(), meta('op1'), input([{ decision: 'use', uses: [use('A-1', 80)] }, { decision: 'exclude', uses: [] }], { lot: { id: odd, item: 'R', unit: '台', project, location: 'S1' }, manual: [{ lotId: 'B-1', basis: 'counted', value: 1 }] }));
    expect(() => validateUsageEstimates(mixed.ledger, mixed.supply)).not.toThrow();
  });
  test('推計の重複と、使用記録の数量の書換えを拒否する', () => {
    const state = recorded(), e = estimateOf(state);
    expect(() => validateUsageEstimates(state.ledger, { ...state.supply, log: state.supply.log.filter((x) => x.kind !== 'usageEstimate') })).toThrow('セット推計の記録がない');
    expect(() => validateUsageEstimates(state.ledger, { ...state.supply, log: [...state.supply.log, e] })).toThrow('二つ');
    const history = state.ledger.history.map((x) => (x.eventId === 'op1-u1' && x.kind === 'use' ? { ...x, value: 80 } : x));
    const tampered = withEstimate({ ...state, ledger: { ...state.ledger, history } }, (x) => ({ ...x, rows: [{ ...x.rows[0]!, confirmed: 80 }, x.rows[1]!] }));
    expect(() => validateUsageEstimates(tampered.ledger, tampered.supply)).toThrow('の数量');
  });
});
