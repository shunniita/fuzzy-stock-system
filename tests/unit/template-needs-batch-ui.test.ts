import { afterEach, expect, test } from 'vitest';
import { practiceLedger, type Meta } from '../../src/domain/ledger.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { saveReceiptTemplate } from '../../src/domain/receipt-template.ts';
import { generateTemplateNeedsBatch } from '../../src/domain/template-needs.ts';
import { templateNeedBatchInput } from '../../src/ui/template-needs-batch-ui.ts';
import { templateNeedsOps, templateNeedPreviewSignature } from '../../src/ui/template-needs-ui.ts';
import { requireTemplateNeedCaptureCapacity } from '../../src/ui/template-needs-capacity.ts';
import { captureDraft, fieldsOf } from '../../src/ui/conflict-ui.ts';
import { commit, confirmSaved, faults, fingerprintOf, inquire, load, replace, retry, targetsOf } from '../../src/ui/storage.ts';
import type { Values } from '../../src/ui/dom.ts';
import { supplyEventText } from '../../src/ui/supply-format.ts';
import { viewSheetsOf } from '../../src/ui/viewsheets.ts';

const meta = (eventId: string): Meta => ({ eventId, actor: '架空担当', occurredAt: '2026-10-30T09:00:00+09:00', recordedAt: '2026-10-30T09:00:00+09:00' });
const stateOf = () => ({ ledger: practiceLedger, supply: saveReceiptTemplate(practiceLedger, emptySupply, meta('op1'), { id: 'kit', name: '架空セット', product: 'R', basis: 'label', rows: [{ item: 'P', unit: '個', perSet: 2, location: 'S1' }] }) });
const values = (entries: Record<string, string | boolean>): Values => ({ text: key => typeof entries[key] === 'string' ? entries[key] : '', checked: key => entries[key] === true });
const raw = { needAssemblyTemplate: 'kit', needInspectionTemplate: 'kit', needAssemblyCase: '000001', needAssemblyCount: '40', needMode: 'same', needSplit: '20', needRows: '1', needInspectionCase0: '000002', needInspectionCount0: '40', needDue: '2026-11-01' };
const opOf = (state: ReturnType<typeof stateOf>) => templateNeedsOps({ ledger: () => state.ledger, supply: () => state.supply }, () => 'op2', () => {}).templateNeedBatch!;
function generated() {
  const state = stateOf(), entries = { ...raw, needPreview: templateNeedPreviewSignature(state, templateNeedBatchInput(values(raw))), needConfirmed: true };
  const result = opOf(state).run(state, meta('op2'), values(entries), undefined);
  expect(result.units).toBeUndefined();
  return { state, after: result.state, entries };
}

test('3.1, 3.9 UI操作は全案件を一つの保存単位にし、原文IDと履歴の関連を保つ', () => {
  const { state, after } = generated();
  expect(Object.values(after.ledger.masters.cases).filter(project => project.code?.startsWith('00000')).map(project => project.code)).toEqual(['000001', '000002']);
  expect(Object.values(after.supply.needs).map(need => need.required.value)).toEqual([80, 80]);
  expect(after.supply.log.at(-1)).toMatchObject({ eventId: 'op2', group: { mode: 'same', split: null } });
  expect(after.ledger.lots).toEqual(state.ledger.lots);
  expect(after.supply.requests).toEqual(state.supply.requests);
});

test('8.1 異なるセットの同じ品目も、履歴とExcelで案件ごとの数量へ明示的に結び付ける', () => {
  const state = stateOf();
  const supply = saveReceiptTemplate(state.ledger, state.supply, meta('op2'), { id: 'inspection', name: '架空分け先セット', product: 'R', basis: 'label', rows: [{ item: 'P', unit: '個', perSet: 3, location: 'S1' }] });
  const result = generateTemplateNeedsBatch({ ...state, supply }, meta('op3'), { group: { assemblyIndex: 0, mode: 'same', split: null }, dueDate: '2026-11-01', projects: [{ templateId: 'kit', caseCode: '000001', count: 40 }, { templateId: 'inspection', caseCode: '000002', count: 40 }] });
  const event = result.supply.log.at(-1)!;
  const text = supplyEventText(result.ledger.masters, event), chunks = text.split('；');
  expect(chunks).toHaveLength(2);
  expect(chunks[0]).toMatch(/000001.*架空セット.*40台.*セット版op3-v1.*品目.*P.*80個/);
  expect(chunks[0]).not.toContain('120個');
  expect(chunks[1]).toMatch(/000002.*架空分け先セット.*40台.*セット版op3-v2.*品目.*P.*120個/);
  expect(chunks[1]).not.toContain('80個');
  expect(text).toContain('同じ台数');
  expect(viewSheetsOf(result, meta('op3').recordedAt).find(sheet => sheet.name === '供給の履歴')?.rows.at(-1)?.[5]).toBe(text);
});

test('2.11, 3.5 入力変更・同内容の別写し・未確認を拒否し、手入力した台数を黙って再提案しない', () => {
  const { state, entries } = generated(), op = opOf(state);
  expect(() => op.run(state, meta('op2'), values({ ...entries, needConfirmed: false }), undefined)).toThrow('確認');
  expect(() => op.run(state, meta('op2'), values({ ...entries, needInspectionTemplate: '' }), undefined)).toThrow('プレビュー');
  expect(() => op.run({ ledger: { ...state.ledger }, supply: { ...state.supply } }, meta('op2'), values(entries), undefined)).toThrow('プレビュー');
  const edited = { ...raw, needMode: 'split', needAssemblyCount: '90', needInspectionCount0: '80' };
  const input = templateNeedBatchInput(values(edited));
  expect(input.projects.map(project => project.count)).toEqual([90, 80]);
  expect(() => op.run(state, meta('op2'), values({ ...edited, needPreview: templateNeedPreviewSignature(state, input), needConfirmed: true }), undefined)).toThrow('合計');
  expect(edited.needInspectionCount0).toBe('80');
});

class MemoryStore {
  data = new Map<string, string>();
  failSlot = false;
  failRemove = false;
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { if (this.failSlot && key.includes('slot-')) throw new Error('架空の容量不足'); this.data.set(key, value); }
  removeItem(key: string): void { if (this.failRemove) throw new Error('応答不明'); this.data.delete(key); }
}
afterEach(() => { faults.failMidwayAt = null; faults.loseResponseAt = null; });
const loaded = (store: MemoryStore) => { const value = load(store); if (value.kind !== 'ok') throw new Error('読めない'); return value; };
function saving() {
  const { state, after, entries } = generated(), store = new MemoryStore(), current = replace(store, null, state);
  const opLabel = '2つのセットでまとめて生成';
  const op = { opId: 'op2', opLabel, values: entries, fingerprint: fingerprintOf(opLabel, entries), actor: meta('op2').actor, startedAt: meta('op2').recordedAt, savingSince: meta('op2').recordedAt };
  const units = [{ ...after, conflictReviews: [], targets: targetsOf(state, after) }];
  return { state, after, store, current, op, units };
}
test('8.2 localStorage書込失敗は全案件を未保存に保ち、再送で全件だけを保存する', () => {
  const { state, after, store, current, op, units } = saving();
  store.failSlot = true;
  expect(commit(store, current, op, units).kind).toBe('failed');
  const failed = loaded(store);
  expect(failed.snapshot.ledger).toEqual(state.ledger); expect(failed.snapshot.supply).toEqual(state.supply);
  expect(failed.pending).toBeNull();
  store.failSlot = false;
  expect(commit(store, failed.snapshot, op, units).kind).toBe('saved');
  expect(loaded(store).snapshot.supply).toEqual(after.supply);
});
test('8.2 未保存の応答不明は照会後の再試行で一単位だけ適用する', () => {
  const { after, store, current, op, units } = saving(); store.failSlot = true; store.failRemove = true;
  const result = commit(store, current, op, units);
  if (result.kind !== 'unknown') throw new Error(`応答不明でない: ${result.kind}`);
  expect(inquire(store, result.pending).savedUnits).toBe(0);
  store.failSlot = false; store.failRemove = false;
  expect(retry(store, current, result.pending, meta('op2').actor, meta('op2').recordedAt).kind).toBe('saved');
  expect(loaded(store).snapshot.supply).toEqual(after.supply);
});
test('8.2 応答喪失後は照会・保存済み確定で全件を保持し、再適用しない', () => {
  const { after, store, current, op, units } = saving(); faults.loseResponseAt = 1;
  const result = commit(store, current, op, units);
  expect(result.kind).toBe('unknown');
  if (result.kind !== 'unknown') throw new Error('応答不明でない');
  expect(inquire(store, result.pending)).toMatchObject({ savedUnits: 1, total: 1 });
  expect(confirmSaved(store, loaded(store).snapshot, result.pending, meta('op2').actor, meta('op2').recordedAt).kind).toBe('settled');
  expect(loaded(store).snapshot.supply).toEqual(after.supply);
  expect(Object.keys(loaded(store).snapshot.supply.templateNeeds)).toHaveLength(2);
});
test('8.2 古い写しからの送信は競合となり、案件を一部も登録しない', () => {
  const { state, store, current, op, units } = saving(); replace(store, current, state);
  expect(commit(store, current, op, units).kind).toBe('conflict');
  expect(loaded(store).snapshot.supply).toEqual(state.supply);
});

test('8.3 競合回収と照合の実形式が大きすぎれば確定前に理由を示す', () => {
  const made = captureDraft({ initial: [], fields: fieldsOf([{ type: 'text', name: 'needAssemblyCase', label: '元の案件ID', value: '架空'.repeat(12000), checked: false, selectedText: '', fileNames: [], readState: 'unread' }]), initialActor: '', actor: '架空担当', initialOccurredAt: null, occurredAt: null, origin: { kind: 'unsent' }, opKey: 'templateNeedBatch', opLabel: '2つのセットでまとめて生成', baseRevision: 0, baseLastWriter: null, detectedAt: meta('op2').recordedAt, detectedReason: '外部更新', readEvidence: [], targets: [], unapplied: ['未送信'] }, () => 'fictional-review');
  if (made.kind !== 'captured') throw new Error('捕捉できない');
  expect(() => requireTemplateNeedCaptureCapacity(made.draft, 'legacy/unknown', 'op2')).toThrow('64KiB');
});
