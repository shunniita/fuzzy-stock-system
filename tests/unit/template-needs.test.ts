import { describe, expect, test } from 'vitest';
import { practiceLedger, type Ledger, type Meta } from '../../src/domain/ledger.ts';
import { emptySupply, receiveLot, recordRequest, registerNeed } from '../../src/domain/supply.ts';
import { deleteReceiptTemplate, saveReceiptTemplate, type ReceiptTemplate } from '../../src/domain/receipt-template.ts';
import { buildTemplateNeedGeneration, type TemplateNeedContext, type TemplateNeedGenerationInput } from '../../src/domain/template-needs.ts';

const meta = (eventId: string): Meta => ({ eventId, actor: '架空担当A', occurredAt: '2026-10-30T09:00:00+09:00', recordedAt: '2026-10-30T09:00:00+09:00' });
const template: ReceiptTemplate = { id: 'kit', name: '架空標準部品表', product: 'R', project: null, basis: 'counted', rows: [
  { item: 'P', unit: '個', perSet: 2, location: 'S1' },
  { item: 'P', unit: '個', perSet: 3, location: 'S2' },
  { item: 'Q', unit: '個', perSet: 1, location: 'S1' },
] };
const input: TemplateNeedGenerationInput = { templateId: 'kit', caseCode: '000007', count: 10, dueDate: '2026-11-10' };
const context: TemplateNeedContext = { plans: {}, versions: {} };
const stateOf = (ledger = practiceLedger, value = template) => ({ ledger, supply: saveReceiptTemplate(ledger, emptySupply, meta('save'), value) });
const build = (state = stateOf(), value = input, current = context) => buildTemplateNeedGeneration(state, current, meta('gen'), value);

describe('セットから単独案件の必要明細を作る core（要件1・2・7）', () => {
  test.each(['000007 ', ' 000007', '\t000007', '000007\u3000'])('前後に空白のある新規案件ID %sは原文を残して拒否する', caseCode => {
    const state = stateOf(), before = JSON.stringify(state), value = { ...input, caseCode };
    expect(() => build(state, value)).toThrow('前後の空白');
    expect(value.caseCode).toBe(caseCode);
    expect(JSON.stringify(state)).toBe(before);
  });
  test('同品目単位を合算しラベル値・必要日・初回版・基準版・台数・元行を返す', () => {
    const state = stateOf(), before = JSON.stringify(state), result = build(state);
    expect(result.rows).toEqual([
      { item: 'P', unit: '個', perSet: 5, required: 50, sourceRows: [1, 2] },
      { item: 'Q', unit: '個', perSet: 1, required: 10, sourceRows: [3] },
    ]);
    expect(result.needs).toEqual([
      { id: 'gen-n1', project: { kind: 'case', id: '000007' }, item: 'P', unit: '個', required: { basis: 'label', value: 50 }, dueDate: input.dueDate, source: template.name, revision: 'gen-v1' },
      { id: 'gen-n2', project: { kind: 'case', id: '000007' }, item: 'Q', unit: '個', required: { basis: 'label', value: 10 }, dueDate: input.dueDate, source: template.name, revision: 'gen-v1' },
    ]);
    expect(result.plan).toEqual({ project: '000007', generationId: 'gen', initialVersion: 'gen-v1', version: 'gen-v1', count: 10, origins: [
      { needId: 'gen-n1', item: 'P', unit: '個', origin: 'template' }, { needId: 'gen-n2', item: 'Q', unit: '個', origin: 'template' },
    ] });
    expect(result.version).toEqual({ id: 'gen-v1', template });
    expect(result.event).toMatchObject({ ...meta('gen'), kind: 'templateNeeds', action: 'generate', versions: [result.version], plansBefore: [null], plansAfter: [result.plan], changes: result.needs.map(after => ({ before: null, after })), group: null });
    expect(JSON.stringify(state)).toBe(before);
    expect(result.ledger.masters.cases['000007']).toMatchObject({ code: '000007', active: true });
    expect(result.newProject).toBe(true);
    expect(result.ledger.history.at(-1)).toMatchObject({ eventId: 'gen-c1', kind: 'master', action: 'register' });
    expect(Object.isFrozen(result)).toBe(true);
  });

  test('0.1の厳密合算×台数と、同品目の異なる単位を分ける', () => {
    const ledger: Ledger = { ...practiceLedger, masters: { ...practiceLedger.masters, items: { ...practiceLedger.masters.items,
      S: { ...practiceLedger.masters.items['S']!, unitSteps: { 本: 0.1, 箱: 1 } },
    } } };
    const rows = [{ item: 'S', unit: '本', perSet: 0.1, location: 'S1' }, { item: 'S', unit: '本', perSet: 0.2, location: 'S2' }, { item: 'S', unit: '箱', perSet: 1, location: 'S2' }];
    const result = build(stateOf(ledger, { ...template, rows }), { ...input, count: 3, dueDate: null });
    expect(result.rows.map(row => [row.perSet, row.required])).toEqual([[0.3, 0.9], [1, 3]]);
    expect(result.needs.every(need => need.dueDate === null)).toBe(true);
  });

  test('最上位50行は合算でき、子構成を展開せず場所と子の利用停止を計算へ使わない', () => {
    const child: ReceiptTemplate = { ...template, id: 'child', product: 'Q', productUnit: '個', rows: [template.rows[0]!] };
    const parent: ReceiptTemplate = { ...template, productUnit: '台', rows: Array.from({ length: 50 }, () => ({ item: 'Q', unit: '個', perSet: 1, location: 'S1', assembly: child })) };
    const childSupply = saveReceiptTemplate(practiceLedger, emptySupply, meta('child-save'), child);
    const supply = saveReceiptTemplate(practiceLedger, childSupply, meta('save'), parent);
    const ledger: Ledger = { ...practiceLedger, masters: { ...practiceLedger.masters,
      items: { ...practiceLedger.masters.items, P: { ...practiceLedger.masters.items['P']!, active: false } },
      locations: { ...practiceLedger.masters.locations, S1: { ...practiceLedger.masters.locations['S1']!, active: false } },
    } };
    expect(build({ ledger, supply }).rows).toEqual([{ item: 'Q', unit: '個', perSet: 50, required: 500, sourceRows: Array.from({ length: 50 }, (_, i) => i + 1) }]);
  });

  test('コード原文を保ち、コードと内部IDを区別して登録済み案件を参照する', () => {
    const existing = { ...practiceLedger.masters.cases['A-001']!, id: 'internal', code: '000007' };
    const ledger: Ledger = { ...practiceLedger, masters: { ...practiceLedger.masters, cases: { internal: existing } } };
    const state = stateOf(ledger), result = build(state, { ...input, caseCode: existing.code });
    expect(result.plan.project).toBe('internal');
    expect(result.newProject).toBe(false);
    expect(result.ledger).toBe(ledger);
    expect(build(state, { ...input, caseCode: 'internal' }).ledger.masters.cases['case-gen-c1']?.code).toBe('internal');
    expect(() => build(state, { ...input, caseCode: ' 000008 ' })).toThrow('前後の空白');
  });

  test('コードなしの旧案件は内部IDで解決し、異なる案件への曖昧な一致を拒否する', () => {
    const legacy = { ...practiceLedger.masters.cases['A-001']!, code: null };
    const ledger: Ledger = { ...practiceLedger, masters: { ...practiceLedger.masters, cases: { 'A-001': legacy } } };
    expect(build(stateOf(ledger), { ...input, caseCode: 'A-001' }).plan.project).toBe('A-001');
    const ambiguous: Ledger = { ...ledger, masters: { ...ledger.masters, cases: { ...ledger.masters.cases, other: { ...legacy, id: 'other', code: 'A-001' } } } };
    expect(() => build(stateOf(ambiguous), { ...input, caseCode: 'A-001' })).toThrow('曖昧');
  });

  test('同内容の正規化版は再利用し、元セットの改訂と削除で生成結果が変わらない', () => {
    const state = stateOf(), first = build(state);
    const current: TemplateNeedContext = { plans: { [first.plan.project]: first.plan }, versions: { [first.version.id]: first.version } };
    const next = buildTemplateNeedGeneration({ ...state, ledger: first.ledger }, current, meta('gen2'), { ...input, caseCode: 'A-002' });
    expect(next.plan.initialVersion).toBe(first.version.id);
    expect(next.event.versions).toEqual([]);
    const revised = saveReceiptTemplate(state.ledger, state.supply, meta('revise'), { ...template, name: '架空改訂後', rows: [template.rows[0]!] });
    deleteReceiptTemplate(revised, state.ledger.masters, meta('delete'), template.id);
    expect(first.version.template).toEqual(template);
    expect(first.needs[0]?.required.value).toBe(50);
  });

  test('現物・受け取り・依頼・既存必要明細を変えずに生成する', () => {
    const initial = stateOf();
    const received = receiveLot(initial.ledger, initial.supply, meta('receipt'), { id: 'lot', project: { kind: 'case', id: 'A-002' }, item: 'P', unit: '個', location: 'S1' }, 'label', 18);
    const supply = recordRequest(received.supply, received.ledger.masters, meta('request'), { project: { kind: 'case', id: 'A-002' }, item: 'P', unit: '個', quantity: 2, vendor: '架空手配先', requestedOn: '2026-10-30', reply: { kind: 'none' } });
    const existing = registerNeed(supply, received.ledger.masters, meta('need'), { project: { kind: 'case', id: 'A-002' }, item: 'P', unit: '個', required: { basis: 'label', value: 20 }, dueDate: null, source: '架空部品表', revision: '1' });
    const state = { ledger: received.ledger, supply: existing }, before = JSON.stringify(state), result = build(state);
    expect(result.ledger.lots).toEqual(state.ledger.lots);
    expect(result.ledger.issues).toEqual(state.ledger.issues);
    expect(result.ledger.stops).toEqual(state.ledger.stops);
    expect(JSON.stringify(state)).toBe(before);
    expect(result.needs.every(need => need.project.id === '000007')).toBe(true);
  });

  test.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('台数%sを拒否する', count => {
    expect(() => build(stateOf(), { ...input, count })).toThrow('台数');
  });
  test.each(['', '  '])('空の案件ID %sを拒否する', caseCode => {
    expect(() => build(stateOf(), { ...input, caseCode })).toThrow('案件ID');
  });
  test('利用停止案件・必要数0を含む既存明細・既存計画・使用済み操作IDを拒否する', () => {
    const state = stateOf(), project = { kind: 'case', id: 'A-001' } satisfies { kind: 'case'; id: string };
    const existing = registerNeed(state.supply, state.ledger.masters, meta('need'), { project, item: 'P', unit: '個', required: { basis: 'label', value: 0 }, dueDate: null, source: '架空資料', revision: '1' });
    expect(() => build({ ...state, supply: existing }, { ...input, caseCode: project.id })).toThrow('必要明細');
    const stopped: Ledger = { ...state.ledger, masters: { ...state.ledger.masters, cases: { ...state.ledger.masters.cases, 'A-001': { ...state.ledger.masters.cases['A-001']!, active: false } } } };
    expect(() => build({ ...state, ledger: stopped }, { ...input, caseCode: project.id })).toThrow('利用停止');
    const result = build(state);
    expect(() => build({ ...state, ledger: result.ledger }, input, { plans: { [result.plan.project]: result.plan }, versions: {} })).toThrow('生成済み');
    expect(() => buildTemplateNeedGeneration(state, context, meta('save'), input)).toThrow('使用済み');
  });
  test('セット未登録・削除済み・履歴なしの現在セット・空/51行の構成を拒否する', () => {
    const state = stateOf();
    expect(() => build(state, { ...input, templateId: 'missing' })).toThrow();
    expect(() => build({ ...state, supply: deleteReceiptTemplate(state.supply, state.ledger.masters, meta('delete'), template.id) })).toThrow();
    expect(() => build({ ...state, supply: { ...emptySupply, receiptTemplates: { kit: template } } })).toThrow('履歴');
    for (const rows of [[], Array.from({ length: 51 }, () => template.rows[0]!)]) {
      expect(() => build({ ...state, supply: { ...state.supply, receiptTemplates: { kit: { ...template, rows } } } })).toThrow();
    }
  });
  test('停止品目・未登録単位・乗算/合算超過・必要日不正は丸めず全件拒否する', () => {
    const state = stateOf(), before = JSON.stringify(state);
    const stopped: Ledger = { ...state.ledger, masters: { ...state.ledger.masters, items: { ...state.ledger.masters.items, Q: { ...state.ledger.masters.items['Q']!, active: false } } } };
    expect(() => build({ ...state, ledger: stopped })).toThrow('利用停止');
    const noUnit: Ledger = { ...state.ledger, masters: { ...state.ledger.masters, items: { ...state.ledger.masters.items, P: { ...state.ledger.masters.items['P']!, units: [] } } } };
    expect(() => build({ ...state, ledger: noUnit })).toThrow();
    expect(() => build(state, { ...input, count: Number.MAX_SAFE_INTEGER })).toThrow();
    const overflow = { ...template, rows: [{ ...template.rows[0]!, perSet: Number.MAX_SAFE_INTEGER }, template.rows[0]!] };
    expect(() => build(stateOf(practiceLedger, overflow), { ...input, count: 1 })).toThrow();
    expect(() => build(state, { ...input, dueDate: '2026-02-30' })).toThrow('必要日');
    expect(JSON.stringify(state)).toBe(before);
  });
  test('UTF-8で1MiBを超える生成イベント素材を拒否する', () => {
    const long = '架'.repeat(400000);
    expect(() => build(stateOf(), { ...input, caseCode: long })).toThrow('1MiB');
  });
  test('生成イベント素材はUTF-8でちょうど1MiBまで受け付ける', () => {
    const state = stateOf(), value = { ...input, caseCode: 'A-001' }, initial = build(state, value);
    const bytes = new TextEncoder().encode(JSON.stringify(initial.event)).byteLength;
    const actor = 'a'.repeat(1024 * 1024 - bytes + new TextEncoder().encode(meta('gen').actor).byteLength);
    const accepted = buildTemplateNeedGeneration(state, context, { ...meta('gen'), actor }, value);
    expect(new TextEncoder().encode(JSON.stringify(accepted.event)).byteLength).toBe(1024 * 1024);
    expect(() => buildTemplateNeedGeneration(state, context, { ...meta('gen'), actor: `${actor}a` }, value)).toThrow('1MiB');
  });
});
