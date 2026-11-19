import { describe, expect, test } from 'vitest';
import { practiceLedger, register, start, type Ledger, type Meta } from '../../src/domain/ledger.ts';
import type { ItemMaster } from '../../src/domain/masters.ts';
import { saveReceiptTemplate, type ReceiptTemplate } from '../../src/domain/receipt-template.ts';
import { emptySupply, recordRequest, type Supply } from '../../src/domain/supply.ts';
import { generateTemplateNeeds } from '../../src/domain/template-needs.ts';
import { templateNeedProgressOf } from '../../src/domain/template-needs-progress.ts';
import { caseDetailOf, caseSummaryOf, progressText } from '../../src/ui/caseview.ts';

const at = '2026-10-30T09:00:00+09:00';
const meta = (eventId: string): Meta => ({ eventId, actor: '架空担当A', occurredAt: at, recordedAt: at });
const item = (id: string): ItemMaster => ({ ...practiceLedger.masters.items['P']!, id, code: null, name: `架空${id}`, units: ['個', '台'], unitSteps: { 個: 1, 台: 1 } });
const masters = { ...practiceLedger.masters, items: { ...practiceLedger.masters.items, P: item('P'), R: item('R') } };
const template: ReceiptTemplate = { id: 'kit', name: '架空製品R', product: 'R', productUnit: '台', project: null, basis: 'label', rows: [{ item: 'P', unit: '個', perSet: 2, location: 'S1' }] };
const process = { id: 'R組立', criterion: 'inspection' } as const;
type State = { ledger: Ledger; supply: Supply };

function generated(value: ReceiptTemplate = template, count = 10): State {
  const ledger: Ledger = { ...practiceLedger, masters };
  const state = { ledger, supply: saveReceiptTemplate(ledger, emptySupply, meta('save'), value) };
  return generateTemplateNeeds(state, meta('gen'), { templateId: value.id, caseCode: 'C1', count, dueDate: null });
}

function started(state: State, id: string, value: number | null): State {
  const lot = { id, item: 'R', unit: '台', project: { kind: 'case', id: 'C1' } as const, location: 'S1' };
  return { ...state, ledger: start(state.ledger, meta(`start-${id}`), lot, process, value === null ? 'unknown' : 'counted', value, []) };
}

const summaryOf = (state: State) => caseSummaryOf(caseDetailOf(state.ledger, state.supply, 'C1'), templateNeedProgressOf(state, 'C1'));
const textOf = (state: State) => progressText(templateNeedProgressOf(state, 'C1'), state.supply);

describe('caseSummaryOf', () => {
  test('必要明細のない品目は判定不能に数え、不足なしにしない', () => {
    const summary = summaryOf(started(generated(), 'W1', 3));
    expect(summary).toMatchObject({ needed: 1, undecidable: 1 });
    const groups = caseDetailOf(started(generated(), 'W1', 3).ledger, started(generated(), 'W1', 3).supply, 'C1').groups;
    expect(groups.find(g => g.item === 'R')!.status).toEqual({ needed: false, short: false, undecidable: true, outstanding: false });
  });

  test('同じ品目でも単位が違えば別の組として数える', () => {
    const state = generated();
    const ledger = register(state.ledger, meta('p1'), { id: 'PX', item: 'P', unit: '台', project: { kind: 'case', id: 'C1' }, location: 'S1' }, 'label', 5);
    const groups = caseDetailOf(ledger, state.supply, 'C1').groups.filter(g => g.item === 'P');
    expect(groups.map(g => g.unit).sort()).toEqual(['個', '台']);
    expect(caseSummaryOf(caseDetailOf(ledger, state.supply, 'C1'), null)).toMatchObject({ needed: 1, undecidable: 1 });
  });

  test('総予定数ぶんの作業を始めて残りが0でも、不足と未着の件数は残る', () => {
    const base = started(generated(), 'W1', 10);
    const supply = recordRequest(base.supply, masters, meta('req'), { project: { kind: 'case', id: 'C1' }, item: 'P', unit: '個', quantity: 20, vendor: '架空仕入先', requestedOn: '2026-10-30', reply: { kind: 'none' } });
    const summary = summaryOf({ ledger: base.ledger, supply });
    expect(summary.progress?.remaining).toBe(0);
    expect(summary).toMatchObject({ needed: 1, short: 1, outstanding: 1 });
  });
});

describe('progressText', () => {
  test('総予定数・使った台数・残りをセット名と版とともに出す', () => {
    const text = textOf(started(generated(), 'W1', 3));
    expect(text).toContain('架空製品R');
    expect(text).toContain('gen-v1');
    expect(text).toContain('総予定数10台');
    expect(text).toContain('未使用の残り7台');
  });

  test('超過は「超過N台」', () => {
    expect(textOf(started(generated(), 'W1', 12))).toContain('超過2台');
  });

  test('台数不明の開始があると残りは不明', () => {
    const text = textOf(started(started(generated(), 'W0', 2), 'W1', null));
    expect(text).toContain('作業で使った台数 不明・未使用の残り不明');
    expect(text).not.toContain('小計');
  });

  test('製品のないセットは数えられない', () => {
    const base = generated();
    const log = base.supply.log.map(event => event.kind === 'templateNeeds' && event.action === 'generate'
      ? { ...event, versions: event.versions.map(version => ({ ...version, template: { ...version.template, product: null } })) } : event);
    expect(textOf({ ...base, supply: { ...base.supply, log } })).toContain('セットに製品がないため数えられない');
  });

  test('単位未設定の古いセットでも使った台数を台で出す', () => {
    const { productUnit: _, ...old } = template;
    expect(textOf(started(generated(old), 'W1', 3))).toContain('使った台数 3台');
  });

  test('製品の単位が台以外なら、総予定数・使った台数・残り・超過をその単位でそろえる', () => {
    const pieces = { ...template, productUnit: '個' };
    const lot = { id: 'W1', item: 'R', unit: '個', project: { kind: 'case', id: 'C1' } as const, location: 'S1' };
    const startedOf = (value: number) => { const base = generated(pieces); return { ...base, ledger: start(base.ledger, meta('s1'), lot, process, 'counted', value, []) }; };
    expect(textOf(startedOf(3))).toMatch(/総予定数10個.*作業で使った台数 3個.*未使用の残り7個$/);
    expect(textOf(startedOf(12))).toContain('未使用の残り超過2個');
  });

  test('計画がなければ必要明細なし', () => {
    expect(progressText(null, emptySupply)).toBe('セットからの必要明細なし');
  });

  test('だいたいの開始は約を保つ', () => {
    const state = generated();
    const lot = { id: 'W1', item: 'R', unit: '台', project: { kind: 'case', id: 'C1' } as const, location: 'S1' };
    const ledger = start(state.ledger, meta('s1'), lot, process, 'approximate', 3, []);
    expect(textOf({ ...state, ledger })).toMatch(/約3台/);
  });
});
