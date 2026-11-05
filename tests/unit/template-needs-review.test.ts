import { expect, test } from 'vitest';
import { changeMasters, practiceLedger, type Ledger, type Meta } from '../../src/domain/ledger.ts';
import { emptySupply, reviseNeed, type Need, type Supply } from '../../src/domain/supply.ts';
import { saveReceiptTemplate } from '../../src/domain/receipt-template.ts';
import { editTemplateNeeds, followTemplateNeeds, generateTemplateNeeds } from '../../src/domain/template-needs.ts';
import { commit, fingerprintOf, initial, parse, serialize, targetsOf } from '../../src/ui/storage.ts';
import { dateStatusOf } from '../../src/domain/shortage.ts';
import { captureItemLabels } from '../../src/domain/history-labels.ts';
import { supplyEventText } from '../../src/ui/supply-format.ts';

const meta = (eventId: string): Meta => ({ eventId, actor: '架空担当A', occurredAt: '2026-11-01T09:00:00+09:00', recordedAt: '2026-11-01T09:00:00+09:00' });
const template = { id: 'kit', name: '架空セット', product: 'R', basis: 'label', rows: [{ item: 'P', unit: '個', perSet: 2, location: 'S1' }, { item: 'Q', unit: '個', perSet: 1, location: 'S1' }] } as const;
const generated = () => generateTemplateNeeds({ ledger: practiceLedger, supply: saveReceiptTemplate(practiceLedger, emptySupply, meta('save'), template) }, meta('gen'), { templateId: 'kit', caseCode: '000909', count: 10, dueDate: '2026-11-20' });

test('NEED-01a/06 生成後も必要日・元資料・改訂だけを変更し保存後の納期判定へ反映できる', () => {
  const state = generated(), before = state.supply.needs['gen-n1']!;
  const edited = editTemplateNeeds(state, meta('edit'), '000909', { kind: 'change', needId: before.id, required: before.required, dueDate: '2026-11-10', source: '架空の変更資料', revision: '第2版' }, '架空の納期変更');
  const restored = parse(serialize(initial(edited.ledger, edited.supply)));
  expect(restored.supply.needs[before.id]).toEqual({ ...before, dueDate: '2026-11-10', source: '架空の変更資料', revision: '第2版' });
  const request = { id: 'request', project: before.project, item: before.item, unit: before.unit, quantity: 20, vendor: '架空取引先', requestedOn: '2026-11-01', orderConfirmedBy: null, reply: { kind: 'answered', date: '2026-11-15' }, cancelled: null, arrivals: [] } as const;
  expect(dateStatusOf({ ...restored.supply, requests: { request: { ...request, arrivals: [] } } }, restored.ledger.masters, 'request', '2026-11-01').lateForNeed).toBe(true);
  expect(state.supply.needs[before.id]).toBe(before);
  expect(supplyEventText(restored.ledger.masters, restored.supply.log.at(-1)!)).toContain('必要日2026-11-20 → 2026-11-10・元資料架空セット → 架空の変更資料・改訂gen-v1 → 第2版');
  expect(() => editTemplateNeeds(state, meta('bad'), '000909', { kind: 'change', needId: before.id, required: before.required, dueDate: '2026-02-30' }, '架空訂正')).toThrow('必要日');
});

test.each([' 0909', '0909 ', '\t0909', '0909\u3000'])('REV-03 登録情報の案件コード %s を登録・変更の入口で拒否する', code => {
  expect(() => changeMasters(practiceLedger, meta('register'), { action: 'register', master: { type: 'case', code, name: null, source: null } })).toThrow('前後の空白');
  expect(() => changeMasters(practiceLedger, meta('code'), { action: 'code', type: 'case', id: 'A-001', code, reason: '架空変更' })).toThrow('前後の空白');
});

test('REV-03 過去の空白付き案件と同じコードの生成は新しい案件へ分岐させない', () => {
  const state = generated();
  const ledger: Ledger = { ...state.ledger, masters: { ...state.ledger.masters, cases: { ...state.ledger.masters.cases, legacy: { ...state.ledger.masters.cases['000909']!, id: 'legacy', code: ' 0909' } } } };
  expect(() => generateTemplateNeeds({ ...state, ledger }, meta('duplicate'), { templateId: 'kit', caseCode: '0909', count: 1, dueDate: null })).toThrow('空白付き');
});

test('REV-01 除外した明細はセットからの削除・再追加後も未選択なら0を保持する', () => {
  const base = generated();
  const excluded = editTemplateNeeds(base, meta('exclude'), '000909', { kind: 'exclude', needId: 'gen-n1' }, '架空の除外');
  let state = { ...excluded, supply: saveReceiptTemplate(excluded.ledger, excluded.supply, meta('remove'), { ...template, rows: [template.rows[1]] }) };
  state = followTemplateNeeds(state, meta('follow-removed'), '000909', []);
  state = parse(serialize(initial(state.ledger, state.supply)));
  state = { ...state, supply: saveReceiptTemplate(state.ledger, state.supply, meta('restore'), template) };
  state = followTemplateNeeds(state, meta('follow-restored'), '000909', []);
  expect(state.supply.needs['gen-n1']?.required).toEqual({ basis: 'label', value: 0 });
  expect(parse(serialize(initial(state.ledger, state.supply))).supply.needs['gen-n1']?.required.value).toBe(0);
});

test('ADR-058 3,000必要明細を持つ台帳の1件変更を1秒以内で保存する', () => {
  const cases = Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`case${i}`, { ...practiceLedger.masters.cases['A-001']!, id: `case${i}`, code: `case${i}` }]));
  const ledger: Ledger = { ...practiceLedger, masters: { ...practiceLedger.masters, cases } };
  const needs: Need[] = Object.keys(cases).map(id => ({ id: `need-${id}`, project: { kind: 'case', id }, item: 'P', unit: '個', required: { basis: 'label', value: 1 }, dueDate: null, source: '架空資料', revision: '1' }));
  const supply: Supply = { ...emptySupply, needs: Object.fromEntries(needs.map(need => [need.id, need])), log: needs.map(need => ({ ...meta(need.id), kind: 'needRegister', need, itemLabels: captureItemLabels(ledger.masters, ['P']) })) };
  const current = initial(ledger, supply), raw = serialize(current);
  const data = new Map([['fuzzy-stock/head', 'A'], ['fuzzy-stock/slot-A', raw]]);
  const store = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  const next = { ledger, supply: reviseNeed(supply, ledger.masters, meta('op1'), needs[0]!.id, { required: { basis: 'label', value: 2 }, dueDate: null, source: '架空資料', revision: '2' }) };
  const start = performance.now();
  const saved = commit(store, current, { opId: 'op1', opLabel: '架空の性能確認', fingerprint: fingerprintOf('架空の性能確認', {}), values: {}, actor: '架空担当A', startedAt: meta('op1').recordedAt, savingSince: meta('op1').recordedAt }, [{ ...next, conflictReviews: [], targets: targetsOf(current, next) }]);
  const elapsed = performance.now() - start;
  expect(saved.kind).toBe('saved');
  if (saved.kind !== 'saved') throw new Error('架空台帳の保存に失敗');
  expect(Object.keys(saved.snapshot.supply.needs)).toHaveLength(3000);
  expect(saved.snapshot.supply.needs[needs[0]!.id]?.required.value).toBe(2);
  console.info(`3,000明細の1件変更・保存: ${elapsed.toFixed(1)}ms`);
  expect(elapsed).toBeLessThan(1000);
});
