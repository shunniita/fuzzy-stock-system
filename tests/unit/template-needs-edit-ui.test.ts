import { expect, test } from 'vitest';
import { practiceLedger, use, type Meta } from '../../src/domain/ledger.ts';
import { emptySupply, receiveLot } from '../../src/domain/supply.ts';
import { saveReceiptTemplate } from '../../src/domain/receipt-template.ts';
import { editTemplateNeeds, followTemplateNeeds, generateTemplateNeeds, templateNeedContextOf } from '../../src/domain/template-needs.ts';
import { templateNeedVersionText, currentTemplateVersionText, templateNeedSurplusViewOf } from '../../src/ui/template-needs-format.ts';
import { operationGroups } from '../../src/ui/operation-picker.ts';
import { prepareTemplateNeedChange, templateNeedChangeInput, type TemplateNeedChangeInput } from '../../src/ui/template-needs-edit-preview.ts';
import { templateNeedsOps, templateNeedPreviewSignature } from '../../src/ui/template-needs-ui.ts';
import type { Values } from '../../src/ui/dom.ts';
import { viewSheetsOf } from '../../src/ui/viewsheets.ts';
import { supplyEventText } from '../../src/ui/supply-format.ts';

const meta = (eventId: string, day = '28'): Meta => ({ eventId, actor: `架空担当${day}`, occurredAt: `2026-10-${day}T09:00:00+09:00`, recordedAt: `2026-10-${day}T09:00:00+09:00` });
const template = { id: 'kit', name: '架空セット', product: 'R', basis: 'label', rows: [{ item: 'P', unit: '個', perSet: 2, location: 'S1' }] } as const;
function generated() {
  const supply = saveReceiptTemplate(practiceLedger, emptySupply, meta('save'), template);
  return generateTemplateNeeds({ ledger: practiceLedger, supply }, meta('gen'), { templateId: 'kit', caseCode: '000007', count: 10, dueDate: null });
}

test('初回版の日時・担当者は同じ内容へ戻して再保存しても変わらない', () => {
  const state = generated(), version = templateNeedContextOf(state.supply).versions['gen-v1']!;
  const initial = templateNeedVersionText(state.supply, version);
  const revised = saveReceiptTemplate(state.ledger, state.supply, meta('revise', '29'), { ...template, rows: [{ ...template.rows[0], perSet: 3 }] });
  const reverted = saveReceiptTemplate(state.ledger, revised, meta('revert', '30'), template);
  expect(templateNeedVersionText(reverted, version)).toBe(initial);
  expect(initial).toContain('架空担当28');
  expect(currentTemplateVersionText(state.ledger.masters, reverted, 'kit')).toContain('架空担当30');
});

test('生成した必要明細の変更を必要な数から選べる', () => {
  expect(operationGroups.find(group => group.id === 'requests')?.keys).toContain('templateNeedEdit');
});

test('必要明細の2操作は確定時にも同じ保存前検査を指定する', () => {
  const state = generated(), preflight = () => {};
  const ops = templateNeedsOps({ ledger: () => state.ledger, supply: () => state.supply }, () => 'ui', preflight);
  for (const key of ['templateNeedGenerate', 'templateNeedEdit']) expect(ops[key]?.validateBeforeSave).toBe(preflight);
});

const values = (entries: Record<string, string | boolean>): Values => ({ text: key => typeof entries[key] === 'string' ? entries[key] : '', checked: key => entries[key] === true });
function runChange(state: ReturnType<typeof generated>, entries: Record<string, string | boolean>, confirmed = true) {
  const op = templateNeedsOps({ ledger: () => state.ledger, supply: () => state.supply }, () => 'ui', () => {}).templateNeedEdit!;
  const input = templateNeedChangeInput(state, values(entries));
  return op.run(state, meta('ui'), values({ ...entries, needPreview: templateNeedPreviewSignature(state, input), needConfirmed: confirmed }), undefined);
}

test.each(['change', 'exclude', 'add', 'recalculate', 'follow'])('変更操作 %s を型に分けて実際の記録へ渡す', action => {
  const base = generated();
  const state = action === 'follow' ? { ...base, supply: saveReceiptTemplate(base.ledger, base.supply, meta('revise', '29'), { ...template, name: '架空の新版' }) } : base;
  const entries = { needProject: '000007', needAction: action, need: 'gen-n1', item: 'Q', unit: '個', basis: 'counted', value: '3', needCount: '20', needReason: '架空の変更', needDue: '2026-11-01', needSource: state.supply.needs['gen-n1']!.source, needRevision: state.supply.needs['gen-n1']!.revision };
  const before = JSON.stringify(state);
  const result = runChange(state, entries);
  expect(result.units).toBeUndefined();
  expect(result.state.supply.log).toHaveLength(state.supply.log.length + 1);
  expect(result.state.supply.log.at(-1)).toMatchObject({ kind: 'templateNeeds', action: action === 'recalculate' || action === 'follow' ? action : 'edit' });
  expect(result.state.ledger).toEqual(state.ledger);
  expect(result.state.supply.requests).toEqual(state.supply.requests);
  expect(JSON.stringify(state)).toBe(before);
});

test('確認なしと入力・選択・同じ内容の別stateによる署名ずれを拒否し、原文を変えない', () => {
  const state = generated(), entries = { needProject: '000007', needAction: 'change', need: 'gen-n1', basis: 'counted', value: '3', needReason: '架空の変更' };
  expect(() => runChange(state, entries, false)).toThrow('確認');
  const input = templateNeedChangeInput(state, values(entries)), signature = templateNeedPreviewSignature(state, input);
  const op = templateNeedsOps({ ledger: () => state.ledger, supply: () => state.supply }, () => 'ui', () => {}).templateNeedEdit!;
  expect(() => op.run(state, meta('ui'), values({ ...entries, value: '4', needPreview: signature, needConfirmed: true }), undefined)).toThrow('プレビュー');
  expect(() => op.run({ ledger: { ...state.ledger }, supply: { ...state.supply } }, meta('ui'), values({ ...entries, needPreview: signature, needConfirmed: true }), undefined)).toThrow('プレビュー');
  expect(entries.value).toBe('3');
});

test('手修正行は初期OFFで現在値を保持し、選ぶと新標準を適用する', () => {
  const state = editTemplateNeeds(generated(), meta('manual'), '000007', { kind: 'change', needId: 'gen-n1', required: { basis: 'counted', value: 7 } }, '架空の手修正');
  const entries = { needProject: '000007', needAction: 'recalculate', needCount: '20', needReason: '架空の増産' };
  const off = prepareTemplateNeedChange(state, meta('ui'), templateNeedChangeInput(state, values(entries)));
  expect(off.rows[0]).toMatchObject({ oldStandard: 20, newStandard: 40, manual: true, selectable: true, selected: false, after: { required: { value: 7 } } });
  const on = runChange(state, { ...entries, needApply0: true });
  expect(on.state.supply.needs['gen-n1']?.required).toEqual({ basis: 'label', value: 40 });
  expect(on.state.supply.log.at(-1)).toMatchObject({ selected: ['gen-n1'] });
});

test('同版の未選択customでも差分を返し、選択後だけ記録できる', () => {
  let state = editTemplateNeeds(generated(), meta('custom'), '000007', { kind: 'add', item: 'Q', unit: '個', required: { basis: 'counted', value: 7 }, dueDate: null }, '架空の独自明細');
  state = { ...state, supply: saveReceiptTemplate(state.ledger, state.supply, meta('revise', '29'), { ...template, rows: [...template.rows, { item: 'Q', unit: '個', perSet: 3, location: 'S1' }] }) };
  state = followTemplateNeeds(state, meta('first'), '000007', []);
  const entries = { needProject: '000007', needAction: 'follow' };
  const input = templateNeedChangeInput(state, values(entries)), result = prepareTemplateNeedChange(state, meta('ui'), input);
  expect(result.applicable).toBe(false);
  expect(result.rows.find(row => row.key === 'custom-n1')).toMatchObject({ collision: true, selectable: true, selected: false, after: { required: { value: 7 } } });
  expect(result.state).toBe(state);
  expect(() => runChange(state, entries)).toThrow('選ぶ');
  expect(runChange(state, { ...entries, needApply1: true }).state.supply.templateNeeds['000007']?.origins[1]?.origin).toBe('template');
});

test('余剰は受け取り18から使用済み3を含めず、必要数0なら使用可能15になる', () => {
  const base = generated(), received = receiveLot(base.ledger, base.supply, meta('receipt'), { id: 'lot', item: 'P', unit: '個', project: { kind: 'case', id: '000007' }, location: 'S1' }, 'counted', 18);
  const state = { ...received, ledger: use(received.ledger, meta('use', '29'), 'lot', 'counted', 3, '架空の使用') }, need = state.supply.needs['gen-n1']!;
  expect(templateNeedSurplusViewOf(state, { ...need, required: { basis: 'counted', value: 0 } })).toEqual({ value: 15, caution: '' });
  expect(templateNeedSurplusViewOf(state, { ...need, required: { basis: 'label', value: 10 } })).toMatchObject({ value: 8 });
  expect(templateNeedSurplusViewOf(state, { ...need, required: { basis: 'unknown', value: null } })).toMatchObject({ value: null, caution: expect.stringContaining('不明') });
});

test('数量差なしの版更新でも画面とExcelでセット・初回版・基準版・台数・理由を追える', () => {
  const base = editTemplateNeeds(generated(), meta('manual'), '000007', { kind: 'change', needId: 'gen-n1', required: { basis: 'counted', value: 7 } }, '架空の手修正');
  const state = { ...base, supply: saveReceiptTemplate(base.ledger, base.supply, meta('revise', '29'), { ...template, name: '架空の名称改訂' }) };
  const input: TemplateNeedChangeInput = { project: '000007', action: 'follow', selected: [] };
  const result = prepareTemplateNeedChange(state, meta('follow', '30'), input).state, event = result.supply.log.at(-1)!;
  const text = supplyEventText(result.ledger.masters, event, undefined, templateNeedContextOf(result.supply).versions);
  for (const expected of ['000007', '架空の名称改訂', '初回版gen-v1', 'gen-v1 → follow-v1', '10台 → 10台', '必要数の変更なし', 'セットの最新版に追従']) expect(text).toContain(expected);
  const row = viewSheetsOf(result, meta('follow').recordedAt).find(sheet => sheet.name === '供給の履歴')?.rows.at(-1);
  expect(row?.[5]).toBe(text);
  expect(row?.[6]).toContain('gen-v1'); expect(row?.[7]).toContain('follow-v1');
  expect(row?.join(' ')).toContain('架空担当30');
});
