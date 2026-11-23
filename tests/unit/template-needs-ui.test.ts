import { expect, test } from 'vitest';
import { operationGroups } from '../../src/ui/operation-picker.ts';
import { changeMasters, practiceLedger, type Meta } from '../../src/domain/ledger.ts';
import { emptySupply, registerNeed } from '../../src/domain/supply.ts';
import { saveReceiptTemplate } from '../../src/domain/receipt-template.ts';
import { templateNeedsOps, templateNeedPreviewSignature } from '../../src/ui/template-needs-ui.ts';
import type { Values } from '../../src/ui/dom.ts';
import { templateNeedContextOf } from '../../src/domain/template-needs.ts';
import { templateNeedInfo } from '../../src/domain/template-needs.ts';
import { viewSheetsOf } from '../../src/ui/viewsheets.ts';
import { requireTemplateNeedCaptureCapacity } from '../../src/ui/template-needs-capacity.ts';
import { captureDraft, fieldsOf } from '../../src/ui/conflict-ui.ts';

const meta = (eventId: string): Meta => ({ eventId, actor: '架空担当', occurredAt: '2026-10-30T09:00:00+09:00', recordedAt: '2026-10-30T09:00:00+09:00' });
const input = { templateId: 'kit', caseCode: '000007', count: 10, dueDate: '2026-11-01' };
const stateOf = () => ({ ledger: practiceLedger, supply: saveReceiptTemplate(practiceLedger, emptySupply, meta('save'), { id: 'kit', name: '架空セット', product: 'R', basis: 'label', rows: [
  { item: 'P', unit: '個', perSet: 2, location: 'S1' }, { item: 'P', unit: '個', perSet: 3, location: 'S2' },
] }) });
const values = (entries: Record<string, string | boolean>): Values => ({ text: key => typeof entries[key] === 'string' ? entries[key] : '', checked: key => entries[key] === true });
const entries = (state: ReturnType<typeof stateOf>) => ({ needTemplate: 'kit', needCase: '000007', needCount: '10', needDue: '2026-11-01', needPreview: templateNeedPreviewSignature(state, input), needConfirmed: true });

test('既存の手入力案件IDが辞書の継承プロパティ名でも画面とExcelを表示できる', () => {
  const ledger = changeMasters(practiceLedger, meta('case'), { action: 'register', master: { type: 'case', code: 'toString', name: null, source: null } });
  const supply = registerNeed(emptySupply, ledger.masters, meta('need'), { project: { kind: 'case', id: 'toString' }, item: 'P', unit: '個', required: { basis: 'label', value: 2 }, dueDate: null, source: '架空資料', revision: '1' });
  expect(templateNeedInfo(ledger.masters, templateNeedContextOf(supply), supply.needs.need!)).toBeNull();
  expect(viewSheetsOf({ ledger, supply }, meta('need').recordedAt).find(sheet => sheet.name === '必要明細')?.rows[0]?.[0]).toBe('toString');
});

test('2.1 単独生成を「必要な数・依頼・発注」から選べる', () => {
  expect(operationGroups.find(group => group.id === 'requests')?.keys).toContain('templateNeedGenerate');
});

test('6.1 2つのセットでまとめて生成する操作を出さない', () => {
  const state = stateOf();
  expect(operationGroups.flatMap(group => group.keys)).not.toContain('templateNeedBatch');
  expect(templateNeedsOps({ ledger: () => state.ledger, supply: () => state.supply }, () => 'gen', () => {})).not.toHaveProperty('templateNeedBatch');
});

test('2.11 プレビュー署名は履歴件数に比例してフォームを膨らませない', () => {
  const state = stateOf();
  const long = { ...state, supply: { ...state.supply, log: Array.from({ length: 10000 }, () => state.supply.log[0]!) } };
  expect(templateNeedPreviewSignature(long, input).length).toBeLessThan(1024);
  expect(templateNeedPreviewSignature(long, input)).not.toBe(templateNeedPreviewSignature(state, input));
  expect(templateNeedPreviewSignature({ ledger: { ...state.ledger }, supply: { ...state.supply } }, input)).not.toBe(templateNeedPreviewSignature(state, input));
});

test('2.11 確認なし・入力変更・登録情報更新後のプレビューを拒否し入力を保つ', () => {
  const state = stateOf(), op = templateNeedsOps({ ledger: () => state.ledger, supply: () => state.supply }, () => 'gen', () => {}).templateNeedGenerate!;
  expect(() => op.run(state, meta('gen'), values({ ...entries(state), needConfirmed: false }), undefined)).toThrow('確認');
  expect(() => op.run(state, meta('gen'), values({ ...entries(state), needCount: '9' }), undefined)).toThrow('プレビュー');
  const ledger = changeMasters(state.ledger, meta('rename'), { action: 'rename', type: 'item', id: 'P', name: '架空の別名', reason: '呼び名を変更' });
  expect(() => op.run({ ...state, ledger }, meta('gen'), values(entries(state)), undefined)).toThrow('プレビュー');
  const raw = { ...entries(state), needCount: '0.10000000000000001' };
  expect(() => op.run(state, meta('gen'), values(raw), undefined)).toThrow();
  expect(raw.needCount).toBe('0.10000000000000001');
  expect(state.supply.needs).toEqual({});
});

test('2.1, 4.6, 8.1 確認した生成結果を必要明細一覧・履歴・Excelへ表示する', () => {
  const state = stateOf(), op = templateNeedsOps({ ledger: () => state.ledger, supply: () => state.supply }, () => 'gen', () => {}).templateNeedGenerate!;
  const result = op.run(state, meta('gen'), values(entries(state)), undefined).state;
  const need = Object.values(result.supply.needs)[0]!;
  expect(templateNeedInfo(result.ledger.masters, templateNeedContextOf(result.supply), need)).toMatchObject({ standard: 50, modified: false, rows: [1, 2] });
  const sheets = viewSheetsOf(result, meta('gen').recordedAt), sheet = sheets.find(sheet => sheet.name === '必要明細');
  expect(sheet?.rows[0]?.[0]).toBe('000007');
  expect(sheet?.rows[0]?.join(' ')).toContain('標準50個');
  expect(sheet?.rows[0]?.join(' ')).toContain('架空セット');
  expect(sheets.find(sheet => sheet.name === '供給の履歴')?.rows.at(-1)?.join(' ')).toContain('架空セット');
  expect(result.ledger.lots).toEqual(state.ledger.lots);
});

test('8.3 競合回収と照合の実形式が大きすぎれば確定前に理由を示す', () => {
  const made = captureDraft({ initial: [], fields: fieldsOf([{ type: 'text', name: 'needCase', label: '案件ID', value: '架空'.repeat(12000), checked: false, selectedText: '', fileNames: [], readState: 'unread' }]), initialActor: '', actor: '架空担当', initialOccurredAt: null, occurredAt: null, origin: { kind: 'unsent' }, opKey: 'templateNeedGenerate', opLabel: 'セットから必要明細を生成', baseRevision: 0, baseLastWriter: null, detectedAt: meta('gen').recordedAt, detectedReason: '外部更新', readEvidence: [], targets: [], unapplied: ['未送信'] }, () => 'fictional-review');
  if (made.kind !== 'captured') throw new Error('捕捉できない');
  expect(() => requireTemplateNeedCaptureCapacity(made.draft, 'legacy/unknown', 'gen')).toThrow('64KiB');
});
