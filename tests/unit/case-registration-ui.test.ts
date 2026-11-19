import { describe, expect, test } from 'vitest';
import { practiceLedger, type Meta } from '../../src/domain/ledger.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { saveReceiptTemplate, type ReceiptTemplate } from '../../src/domain/receipt-template.ts';
import { masterOps } from '../../src/ui/master-ui.ts';
import { applyCaseRegistration, caseRegistrationOp, caseRegistrationPlanOf, caseRegistrationPreviewSignature, caseRegistrationShown, caseSetChoices, type CaseRegistrationPlan } from '../../src/ui/case-registration-ui.ts';
import type { Values } from '../../src/ui/dom.ts';
import type { State, UiOp } from '../../src/ui/supply-ui.ts';

// 欄の名前：caseSet（''＝使わない）、caseTotal、caseDue（''＝必要日なし）、caseReceipt（''＝今回は記録しない、'record'）、
// 受け取りは今のセットからの受け取りと同じ sets・actual{i}・shortfall{i}・route{i}・vendor。
const at = '2026-11-18T09:00:00+09:00';
const meta = (eventId: string): Meta => ({ eventId, actor: '架空担当A', occurredAt: at, recordedAt: at });
const kit: ReceiptTemplate = { id: 'kit', name: '架空標準部品表', product: 'R', project: null, basis: 'counted', rows: [
  { item: 'P', unit: '個', perSet: 2, location: 'S1' },
  { item: 'Q', unit: '個', perSet: 1, location: 'S1' },
] };
const initial = (): State => ({ ledger: practiceLedger, supply: saveReceiptTemplate(practiceLedger, emptySupply, meta('save'), kit) });
const values = (entries: Record<string, string | boolean>): Values => ({ text: key => typeof entries[key] === 'string' ? entries[key] : '', checked: key => entries[key] === true });
const baseOf = (state: State) => masterOps({ ledger: () => state.ledger, supply: () => state.supply }).masterCase!;
const withSet = (extra: Record<string, string | boolean> = {}) => values({ code: '000007', name: '架空案件', caseSet: 'kit', caseTotal: '10', caseDue: '2026-12-01', ...extra });
const apply = (state: State, v: Values, id = 'op9') => applyCaseRegistration(state, meta(id), v, baseOf(state), caseRegistrationPlanOf(v, state.supply));
const eventIds = (state: State) => [...state.ledger.history.map(e => e.eventId), ...state.supply.log.map(e => e.eventId)];

describe('案件の登録の流れ：まとめて適用（要件1.3・1.7・1.8・1.11・1.12・2.3）', () => {
  test('1.3: 使わないなら今の案件・用途の登録と同じ台帳になり、品番・コードなしの仮の登録も基本IDで記録する', () => {
    const state = initial(), v = values({ code: '', codeNone: true, name: '案件・用途ID未定の試作', caseSet: '', caseTotal: 'x', caseReceipt: 'record' });
    expect(caseRegistrationPlanOf(v, state.supply)).toBeNull();
    const next = apply(state, v);
    expect(next).toEqual(baseOf(state).run(state, meta('op9'), v, undefined).state);
    expect(next.ledger.masters.cases['case-op9']).toMatchObject({ code: null, name: '案件・用途ID未定の試作' });
    expect(next.ledger.history.at(-1)).toMatchObject({ eventId: 'op9', kind: 'master', action: 'register' });
    expect(next.supply).toBe(state.supply);
  });

  test('1.7: セットあり・受け取りなしなら、登録の後に総予定数分の必要明細を -g の記録で作る', () => {
    const state = initial(), v = withSet();
    expect(caseRegistrationPlanOf(v, state.supply)).toEqual({ templateId: 'kit', total: 10, dueDate: '2026-12-01', receipt: null });
    const next = apply(state, v);
    const project = next.ledger.masters.cases['000007']!;
    expect(project).toMatchObject({ code: '000007', name: '架空案件', active: true });
    expect(next.ledger.history.at(-1)).toMatchObject({ eventId: 'op9', kind: 'master', action: 'register' });
    expect(next.supply.templateNeeds[project.id]).toMatchObject({ generationId: 'op9-g', count: 10 });
    expect(Object.values(next.supply.needs).filter(n => n.project.kind === 'case' && n.project.id === project.id).map(n => [n.item, n.required.value, n.dueDate]))
      .toEqual([['P', 20, '2026-12-01'], ['Q', 10, '2026-12-01']]);
    expect(next.supply.log.at(-1)).toMatchObject({ eventId: 'op9-g', kind: 'templateNeeds', action: 'generate' });
    expect(next.supply.log.some(e => e.kind === 'templateReceipt')).toBe(false);
  });

  test('必要日を空にすると必要日なしで生成する', () => {
    const state = initial(), v = withSet({ caseDue: '' });
    expect(caseRegistrationPlanOf(v, state.supply)?.dueDate).toBeNull();
    expect(Object.values(apply(state, v).supply.needs).every(n => n.dueDate === null)).toBe(true);
  });

  test('1.7: 最初の受け取りを記録すると受け取った分を保管単位にし、欠品は手配先への依頼にする。記録IDは重ならない', () => {
    const state = initial(), v = withSet({ caseReceipt: 'record', sets: '3', actual0: '6', shortfall0: '0', actual1: '1', shortfall1: '2', vendor: '架空商事' });
    expect(caseRegistrationPlanOf(v, state.supply)).toEqual({ templateId: 'kit', total: 10, dueDate: '2026-12-01', receipt: { sets: 3, routes: ['assembled', 'assembled'] } });
    const next = apply(state, v);
    const project = { kind: 'case', id: next.ledger.masters.cases['000007']!.id };
    expect(Object.values(next.ledger.lots).filter(l => l.id.startsWith('op9-t-')).map(l => [l.item, l.location, l.project])).toEqual([['P', 'S1', project], ['Q', 'S1', project]]);
    expect(Object.values(next.supply.requests).map(r => [r.id, r.item, r.quantity, r.vendor, r.project])).toEqual([['op9-t-s2', 'Q', 2, '架空商事', project]]);
    expect(next.supply.log.at(-1)).toMatchObject({ eventId: 'op9-t', kind: 'templateReceipt', sets: 3, vendor: '架空商事' });
    expect(next.supply.templateNeeds[project.id]).toMatchObject({ generationId: 'op9-g', count: 10 });
    const ids = eventIds(next);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter(id => id.startsWith('op9'))).toEqual(expect.arrayContaining(['op9', 'op9-g', 'op9-t', 'op9-t-r1', 'op9-t-r2', 'op9-t-s2']));
  });

  test.each([
    ['欠品に手配先がない', { shortfall1: '2', actual1: '1', vendor: '' }, '手配先'],
    ['受け取った数が数でない', { actual0: 'abc' }, ''],
  ])('1.8: 受け取りの段階で止まる（%s）と、登録・生成も適用せず入力前の状態のまま', (_, extra, message) => {
    const state = initial(), before = JSON.stringify(state);
    const v = withSet({ caseReceipt: 'record', sets: '3', actual0: '6', shortfall0: '0', actual1: '3', shortfall1: '0', ...extra });
    expect(() => apply(state, v)).toThrow(message);
    expect(JSON.stringify(state)).toBe(before);
    expect(state.ledger.masters.cases['000007']).toBeUndefined();
  });

  test.each([
    ['品番・コードなし', { codeNone: true, code: '' }, '品番・コード'],
    ['品番・コードが空', { code: '' }, '品番・コード'],
    ['総予定数が0', { caseTotal: '0' }, '総予定数'],
    ['総予定数が小数', { caseTotal: '1.5' }, '総予定数'],
    ['総予定数が空', { caseTotal: '' }, '総予定数'],
    ['総予定数が負', { caseTotal: '-1' }, '総予定数'],
  ])('1.11: セットを使うとき%sなら止める', (_, extra, message) => {
    expect(() => caseRegistrationPlanOf(withSet(extra), initial().supply)).toThrow(message);
  });

  test('1.12: 品番・コードの前後に空白があれば、今と同じく空白を取り除くよう止める', () => {
    const state = initial(), before = JSON.stringify(state);
    expect(() => apply(state, withSet({ code: ' 000007' }))).toThrow('前後の空白を取り除いて確認する');
    expect(JSON.stringify(state)).toBe(before);
  });

  test('2.3: 登録済みの品番・コードなら、今の登録と同じ文言で止め、生成もしない', () => {
    const registered = baseOf(initial()).run(initial(), meta('op1'), values({ code: '000007', name: '既存' }), undefined).state, before = JSON.stringify(registered);
    expect(() => apply(registered, withSet())).toThrow(/品番・コード 000007 は.*使っている/);
    expect(JSON.stringify(registered)).toBe(before);
  });
});

describe('案件の登録の流れ：欄・プレビュー（要件1.1・1.2・1.4・1.5・1.9・1.10）', () => {
  const ctxOf = (state: State) => ({ ledger: () => state.ledger, supply: () => state.supply });
  const opOf = (state: State, base: UiOp = baseOf(state)) => caseRegistrationOp(base, ctxOf(state), () => 'preview', () => undefined);
  const plan: CaseRegistrationPlan = { templateId: 'kit', total: 10, dueDate: '2026-12-01', receipt: { sets: 3, routes: ['assembled', 'assembled'] } };
  // 署名は既定の入力から作り、extra で後から変えた欄は署名に反映しない（プレビュー後の変更を表す）。
  const signed = (state: State, extra: Record<string, string | boolean> = {}) => {
    const entries = { code: '000007', name: '架空案件', caseSet: 'kit', caseTotal: '10', caseDue: '2026-12-01', caseReceipt: 'record', sets: '3',
      actual0: '6', shortfall0: '0', actual1: '3', shortfall1: '0', caseRegistrationConfirmed: true };
    return values({ ...entries, caseRegistrationPreview: caseRegistrationPreviewSignature(state, values(entries), caseRegistrationPlanOf(values(entries), state.supply)!), ...extra });
  };

  test('1.10: セットがなければ使うセットは「使わない」だけ、あれば先頭が「使わない」で続けてセットを並べる', () => {
    expect(caseSetChoices({ ledger: practiceLedger, supply: emptySupply })).toEqual([['', '使わない']]);
    const choices = caseSetChoices(initial());
    expect(choices[0]).toEqual(['', '使わない']);
    expect(choices.slice(1).map(([id]) => id)).toEqual(['kit']);
  });

  test.each([
    ['', '', { plan: false, receipt: false }],
    ['', 'record', { plan: false, receipt: false }],
    ['kit', '', { plan: true, receipt: false }],
    ['kit', 'record', { plan: true, receipt: true }],
  ])('1.2・1.5: 使うセット「%s」・受け取り「%s」なら欄を出し入れする', (set, receipt, shown) => {
    expect(caseRegistrationShown(set, receipt)).toEqual(shown);
  });

  test.each([
    ['総予定数', { total: 11 }],
    ['セット', { templateId: 'other' }],
    ['必要日', { dueDate: null }],
    ['受け取りの選択', { receipt: null }],
    ['受け取った台数', { receipt: { sets: 4, routes: ['assembled', 'assembled'] } }],
    ['受け取り経路', { receipt: { sets: 3, routes: ['parts', 'assembled'] } }],
  ] as [string, Partial<CaseRegistrationPlan>][])('1.9: %sが変わると署名が変わる', (_, change) => {
    const state = initial();
    expect(caseRegistrationPreviewSignature(state, values({ code: '000007' }), { ...plan, ...change })).not.toBe(caseRegistrationPreviewSignature(state, values({ code: '000007' }), plan));
  });

  test('1.9: 品番・コードや台帳が変わると署名が変わり、行ごとの受け取った数・足りない数・手配先では変わらない', () => {
    const state = initial(), signature = caseRegistrationPreviewSignature(state, values({ code: '000007' }), plan);
    expect(caseRegistrationPreviewSignature(state, values({ code: '000008' }), plan)).not.toBe(signature);
    expect(caseRegistrationPreviewSignature({ ...state, supply: saveReceiptTemplate(state.ledger, state.supply, meta('save2'), { ...kit, id: 'kit2' }) }, values({ code: '000007' }), plan)).not.toBe(signature);
    const rows = (extra: Record<string, string>) => caseRegistrationPlanOf(withSet({ caseReceipt: 'record', sets: '3', ...extra }), state.supply)!;
    expect(caseRegistrationPreviewSignature(state, values({ code: '000007' }), rows({ actual0: '6', shortfall1: '0' })))
      .toBe(caseRegistrationPreviewSignature(state, values({ code: '000007' }), rows({ actual0: '1', shortfall0: '5', shortfall1: '1', vendor: '架空商事' })));
  });

  test('1.9: 署名がない・古いと記録せず、プレビューのし直しを求め、状態を変えない', () => {
    const state = initial(), before = JSON.stringify(state), op = opOf(state);
    for (const preview of ['', caseRegistrationPreviewSignature(state, values({ code: '000007' }), { ...plan, total: 9 })]) {
      expect(() => op.run(state, meta('op9'), signed(state, { caseRegistrationPreview: preview }), undefined)).toThrow('現在の入力と記録から必要明細をプレビューし直してください');
    }
    const changed = { ...state, supply: saveReceiptTemplate(state.ledger, state.supply, meta('save2'), { ...kit, id: 'kit2' }) };
    expect(() => op.run(changed, meta('op9'), signed(state), undefined)).toThrow('プレビューし直して');
    expect(() => op.run(state, meta('op9'), signed(state, { caseTotal: '11' }), undefined)).toThrow('プレビューし直して');
    expect(JSON.stringify(state)).toBe(before);
  });

  test.each([
    ['呼び名を変える', { name: '架空案件B' }],
    ['元の資料を変える', { sourceName: '架空の指示書', sourceRevision: 'A' }],
    ['実際の日時を変える', { occurredAt: '2026-11-17T10:00' }],
    ['実際の日時を不明にする', { occurredUnknown: true }],
  ])('1.9: プレビューの後に%sと、古いプレビューのままでは記録しない', (_, extra) => {
    const state = initial(), before = JSON.stringify(state);
    expect(() => opOf(state).run(state, meta('op9'), signed(state, extra), undefined)).toThrow('プレビューし直して');
    expect(JSON.stringify(state)).toBe(before);
  });

  // プレビューも同じ理由で止まるので、し直しを求めても通らない。
  test.each([
    ['前後に空白付き', ' 000007', () => initial(), /前後の空白を取り除いて確認する/],
    ['登録済み', '000007', () => baseOf(initial()).run(initial(), meta('op1'), values({ code: '000007', name: '既存' }), undefined).state, /品番・コード 000007 は.*使っている/],
  ] as const)('1.12・2.3: 品番・コードが%sなら、記録でもプレビューのし直しより先にその理由で止める', (_, code, stateOf, message) => {
    const state = stateOf();
    expect(() => opOf(state).run(state, meta('op9'), signed(state, { code, caseRegistrationPreview: '' }), undefined)).toThrow(message);
  });

  test('確認の印がなければ記録しない', () => {
    const state = initial();
    expect(() => opOf(state).run(state, meta('op9'), signed(state, { caseRegistrationConfirmed: false }), undefined)).toThrow('確認してください');
  });

  test('1.4: プレビューと同じ入力で確認すれば、登録・生成・受け取りをまとめて適用する', () => {
    const state = initial(), v = signed(state);
    const result = opOf(state).run(state, meta('op9'), v, undefined);
    expect(result).toEqual({ state: apply(state, v) });
    expect(result.state.supply.log.at(-1)).toMatchObject({ eventId: 'op9-t', kind: 'templateReceipt' });
  });

  test('1.3: 使わないなら署名・確認なしで、今の登録の戻り値（notice・units）をそのまま返す', () => {
    const state = initial(), returned = { state, notice: 'x', units: [state] };
    const base: UiOp = { label: '案件・用途の登録', fields: () => [], run: () => returned };
    const op = opOf(state, base);
    expect(op.label).toBe('案件・用途の登録');
    expect(op.run(state, meta('op9'), values({ code: '000007', caseSet: '', caseReceipt: 'record' }), undefined)).toBe(returned);
  });
});
