import { describe, expect, test } from 'vitest';
import { practiceLedger, changeStage, noStage, recount, start, transferProject, type Ledger, type Meta } from '../../src/domain/ledger.ts';
import type { ItemMaster } from '../../src/domain/masters.ts';
import { saveReceiptTemplate, type ReceiptTemplate } from '../../src/domain/receipt-template.ts';
import { emptySupply, type Supply } from '../../src/domain/supply.ts';
import { startWithEstimate } from '../../src/domain/usage-estimate.ts';
import { generateTemplateNeeds, recalculateTemplateNeeds } from '../../src/domain/template-needs.ts';
import { progressOverflowsOf, templateNeedProgressOf } from '../../src/domain/template-needs-progress.ts';

const at = '2026-10-30T09:00:00+09:00';
const meta = (eventId: string): Meta => ({ eventId, actor: '架空担当A', occurredAt: at, recordedAt: at });
const item = (id: string): ItemMaster => ({ ...practiceLedger.masters.items['P']!, id, code: null, name: `架空${id}`, units: ['個', '台'], unitSteps: { 個: 1, 台: 1 } });
const masters = { ...practiceLedger.masters, items: { ...practiceLedger.masters.items, P: item('P'), R: item('R') } };
const template: ReceiptTemplate = { id: 'kit', name: '架空製品R', product: 'R', productUnit: '台', project: null, basis: 'label', rows: [{ item: 'P', unit: '個', perSet: 2, location: 'S1' }] };
const process = { id: 'R組立', criterion: 'inspection' } as const;
type State = { ledger: Ledger; supply: Supply };

const withSteps = (unitSteps: ItemMaster['unitSteps']) => ({ ...masters, items: { ...masters.items, R: { ...item('R'), unitSteps } } });

function generated(value: ReceiptTemplate = template, count = 10, mastersOf = masters): State {
  const ledger: Ledger = { ...practiceLedger, masters: mastersOf };
  const state = { ledger, supply: saveReceiptTemplate(ledger, emptySupply, meta('save'), value) };
  return generateTemplateNeeds(state, meta('gen'), { templateId: value.id, caseCode: 'C1', count, dueDate: null });
}

function started(state: State, id: string, value: number | null, extra: { caseId?: string; item?: string; unit?: string } = {}): State {
  const lot = { id, item: extra.item ?? 'R', unit: extra.unit ?? '台', project: { kind: 'case', id: extra.caseId ?? 'C1' } as const, location: 'S1' };
  return { ...state, ledger: start(state.ledger, meta(`start-${id}`), lot, process, value === null ? 'unknown' : 'counted', value, []) };
}

const usedValue = (state: State) => {
  const used = templateNeedProgressOf(state, 'C1')!.used;
  return used?.kind === 'known' ? used.numeric.value : used?.kind;
};

describe('総予定数・作業で使った台数・未使用の残り', () => {
  test('計画がない案件は null', () => {
    expect(templateNeedProgressOf(generated(), 'A-001')).toBeNull();
  });

  test('開始がなければ使った台数は0で、残りは総予定数', () => {
    const progress = templateNeedProgressOf(generated(), 'C1')!;
    expect(progress).toMatchObject({ caseId: 'C1', total: 10, unit: '台', remaining: 10 });
    expect(progress.version).toBe('gen-v1');
    expect(usedValue(generated())).toBe(0);
  });

  test('その案件・製品・単位の開始だけを足し、残りは総予定数から引く', () => {
    let state = generated();
    state = started(state, 'W1', 3);
    state = started(state, 'W2', 4);
    state = started(state, 'X1', 5, { caseId: 'A-001' });
    state = started(state, 'X2', 6, { item: 'P', unit: '個' });
    state = started(state, 'X3', 7, { unit: '個' });
    expect(templateNeedProgressOf(state, 'C1')).toMatchObject({ remaining: 3 });
    expect(usedValue(state)).toBe(7);
  });

  test('総予定数を超えた開始は残りが負になる', () => {
    expect(templateNeedProgressOf(started(generated(), 'W1', 12), 'C1')!.remaining).toBe(-2);
  });

  test('台数不明の開始があれば残りは null で、0として扱わない', () => {
    const state = started(started(generated(), 'W1', 3), 'W2', null);
    const progress = templateNeedProgressOf(state, 'C1')!;
    expect(progress.used?.kind).toBe('partlyUnknown');
    expect(progress.remaining).toBeNull();
  });

  test('製品がない構成は数えず、used・unit・remaining を null にする', () => {
    const base = generated();
    const log = base.supply.log.map(event => event.kind === 'templateNeeds' && event.action === 'generate'
      ? { ...event, versions: event.versions.map(version => ({ ...version, template: { ...version.template, product: null } })) } : event);
    const state = started({ ...base, supply: { ...base.supply, log } }, 'W1', 3);
    expect(templateNeedProgressOf(state, 'C1')).toMatchObject({ total: 10, unit: null, used: null, remaining: null });
  });

  test('単位未設定の古い構成は品目だけで照合する', () => {
    const { productUnit: _, ...old } = template;
    const state = started(started(generated(old), 'W1', 3), 'W2', 2, { unit: '個' });
    expect(templateNeedProgressOf(state, 'C1')).toMatchObject({ unit: null, remaining: 5 });
  });

  test('単位未設定の古い構成で、最小単位1の開始の後に最小単位0.1の開始があっても合算する', () => {
    const { productUnit: _, ...old } = template;
    const state = started(started(generated(old, 10, withSteps({ 台: 1, 個: 0.1 })), 'W1', 1), 'W2', 0.1, { unit: '個' });
    expect(templateNeedProgressOf(state, 'C1')).toMatchObject({ unit: null, remaining: 8.9 });
    expect(usedValue(state)).toBe(1.1);
  });

  test('単位未設定の古い構成で、小数の上限を超える整数の開始に最小単位0.1の単位の整数・不明の開始を足しても例外にしない', () => {
    const { productUnit: _, ...old } = template;
    const big = started(generated(old, 10, withSteps({ 台: 1, 個: 0.1 })), 'W1', 562949953421312);
    expect(templateNeedProgressOf(started(big, 'W2', 1, { unit: '個' }), 'C1')).toMatchObject({ remaining: 10 - 562949953421313 });
    expect(templateNeedProgressOf(started(big, 'W2', null, { unit: '個' }), 'C1')).toMatchObject({ remaining: null });
  });

  test('最小単位0.1の残りに浮動小数点の誤差を出さない', () => {
    const base = generated(template, 1, withSteps({ 台: 0.1, 個: 1 }));
    expect(templateNeedProgressOf(started(base, 'W1', 0.9), 'C1')!.remaining).toBe(0.1);
    expect(templateNeedProgressOf(started(base, 'W1', 1.1), 'C1')!.remaining).toBe(-0.1);
  });

  test('最小単位0.1の製品でも、小数の上限を超える総予定数から整数の台数を引ける', () => {
    const base = generated(template, 562949953421312, withSteps({ 台: 0.1, 個: 1 })), state = started(base, 'W1', 1);
    expect(templateNeedProgressOf(state, 'C1')!.remaining).toBe(562949953421311);
    expect(progressOverflowsOf(base, state)).toEqual([]);
  });

  test('最小単位0.1の製品で、小数の上限を超える総予定数から小数の台数を引き、残りが0.1の精度で表せれば出す', () => {
    const base = generated(template, 562949953421312, withSteps({ 台: 0.1, 個: 1 }));
    expect(templateNeedProgressOf(started(base, 'W1', 0.1), 'C1')!.remaining).toBe(562949953421311.9);
    expect(templateNeedProgressOf(started(started(base, 'W1', 1), 'W2', 0.1), 'C1')!.remaining).toBe(562949953421310.9);
  });

  test('開始後の数え直しは使った台数に影響しない', () => {
    const state = started(generated(), 'W1', 3);
    const recounted = { ...state, ledger: recount(state.ledger, meta('recount'), 'W1', 9, { kind: 'unknown' }, 'notIncluded') };
    expect(usedValue(recounted)).toBe(3);
  });

  test('状態を変えない', () => {
    const state = started(generated(), 'W1', 3), before = JSON.stringify(state);
    templateNeedProgressOf(state, 'C1');
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe('使った台数の根拠と記録の経路', () => {
  const usedOf = (state: State, caseId = 'C1') => templateNeedProgressOf(state, caseId)!.used!;

  test('開始がなければ計算値の0', () => {
    expect(usedOf(generated())).toMatchObject({ kind: 'known', computed: true, numeric: { value: 0 } });
  });

  test('ラベルだけの開始は中身未確認のまま、台数不明だけなら不明', () => {
    const labeled = generated();
    const lot = { id: 'L1', item: 'R', unit: '台', project: { kind: 'case', id: 'C1' } as const, location: 'S1' };
    const withLabel = { ...labeled, ledger: start(labeled.ledger, meta('start-L1'), lot, process, 'label', 3, []) };
    expect(usedOf(withLabel)).toMatchObject({ kind: 'known', numeric: { value: 3, unconfirmed: 'all' } });
    expect(usedOf(started(generated(), 'W1', null)).kind).toBe('unknown');
  });

  test('だいたいの開始はだいたいのまま残る', () => {
    const base = generated();
    const lot = { id: 'A1', item: 'R', unit: '台', project: { kind: 'case', id: 'C1' } as const, location: 'S1' };
    const state = { ...base, ledger: start(base.ledger, meta('start-A1'), lot, process, 'approximate', 3, []) };
    expect(usedOf(state)).toMatchObject({ numeric: { value: 3, approximate: true } });
  });

  test('セットありの開始と通常の開始を合算する', () => {
    const base = started(generated(), 'W1', 3);
    const lot = { id: 'W2', item: 'R', unit: '台', project: { kind: 'case', id: 'C1' } as const, location: 'S1' };
    const state = startWithEstimate(base, meta('est'), { lot, process, basis: 'counted', value: 4, templateId: 'kit', rows: [{ decision: 'exclude', uses: [] }], manual: [] });
    expect(usedValue(state)).toBe(7);
  });

  test('開始したまとまりを完成品にして別の案件へ振り替えても、開始の台数は変わらず移し先に足されない', () => {
    const base = started(generated(), 'W1', 5);
    const second = generateTemplateNeeds(base, meta('gen2'), { templateId: 'kit', caseCode: 'C2', count: 10, dueDate: null });
    const finished = changeStage(second.ledger, meta('finish'), 'W1', 'W1n', 'counted', 5, noStage, 'notIncluded');
    const moved = { ...second, ledger: transferProject(finished, meta('move'), 'W1n', 'W1c', { kind: 'case', id: 'C2' }, 'counted', 3, 'notIncluded') };
    expect(usedValue(moved)).toBe(5);
    expect(templateNeedProgressOf(moved, 'C2')).toMatchObject({ remaining: 10 });
  });
});

describe('記録の前後での総予定数の超過', () => {
  const overflows = (before: State, after: State) => progressOverflowsOf(before, after);

  test('開始で超えると超えた台数を返し、ちょうど・超えないは返さない', () => {
    const base = generated();
    expect(overflows(base, started(base, 'W1', 12))).toEqual([{ caseId: 'C1', over: 2 }]);
    expect(overflows(base, started(base, 'W1', 10))).toEqual([]);
    expect(overflows(base, started(base, 'W1', 9))).toEqual([]);
  });

  test('最小単位0.1の超過台数に浮動小数点の誤差を出さない', () => {
    const base = generated(template, 1, withSteps({ 台: 0.1, 個: 1 }));
    expect(overflows(base, started(base, 'W1', 1.1))).toEqual([{ caseId: 'C1', over: 0.1 }]);
  });

  test('台数不明の開始と、計画のない案件の開始は返さない', () => {
    const base = generated();
    expect(overflows(base, started(base, 'W1', null))).toEqual([]);
    expect(overflows(base, started(base, 'X1', 99, { caseId: 'A-001' }))).toEqual([]);
  });

  test('超過のまま関係ない開始は返さず、さらに使えば増えた分を含め返す', () => {
    const over = started(generated(), 'W1', 12);
    expect(overflows(over, started(over, 'X1', 5, { caseId: 'A-001' }))).toEqual([]);
    expect(overflows(over, started(over, 'W2', 1))).toEqual([{ caseId: 'C1', over: 3 }]);
  });

  test('再計算で総予定数が変わり、使った台数より下げると超過になる', () => {
    const used = started(generated(), 'W1', 6);
    const lowered = recalculateTemplateNeeds(used, meta('re'), 'C1', 4, [], '架空の台数変更');
    expect(templateNeedProgressOf(lowered, 'C1')).toMatchObject({ total: 4, remaining: -2 });
    expect(overflows(used, lowered)).toEqual([{ caseId: 'C1', over: 2 }]);
    expect(overflows(used, recalculateTemplateNeeds(used, meta('re2'), 'C1', 6, [], '架空の台数変更'))).toEqual([]);
  });

  test('再計算は必要明細を今の規則で作り直し、総予定数が新しい台数になる', () => {
    const before = generated();
    const after = recalculateTemplateNeeds(before, meta('re'), 'C1', 20, [], '架空の台数変更');
    expect(templateNeedProgressOf(after, 'C1')).toMatchObject({ total: 20, remaining: 20 });
    const needs = (s: State) => Object.values(s.supply.needs).filter(n => n.project.kind === 'case' && n.project.id === 'C1').map(n => n.required.value);
    expect(needs(before)).toEqual([20]);
    expect(needs(after)).toEqual([40]);
  });
});
