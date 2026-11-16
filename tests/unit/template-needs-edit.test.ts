import { expect, test } from 'vitest';
import { changeMasters, practiceLedger, type Meta } from '../../src/domain/ledger.ts';
import { declareShortage, emptySupply, receiveLot, recordRequest, registerNeed, type NeedQuantity } from '../../src/domain/supply.ts';
import { deleteReceiptTemplate, saveReceiptTemplate } from '../../src/domain/receipt-template.ts';
import { buildTemplateNeedEdit, defaultTemplateNeedSplit, editTemplateNeeds, generateTemplateNeeds, generateTemplateNeedsBatch, templateNeedContextOf, type TemplateNeedEdit } from '../../src/domain/template-needs.ts';
import { initial, parse, serialize, serializePending, targetsOf, type Pending } from '../../src/ui/storage.ts';
import { decodePending } from '../../src/ui/storageparse.ts';
import { backupTextOf, crc32, readBackup } from '../../src/ui/backup.ts';
import { supplyEventItemIds } from '../../src/domain/history-targets.ts';
import { templateNeedInfo } from '../../src/domain/template-needs.ts';
import { viewSheetsOf } from '../../src/ui/viewsheets.ts';
import { supplyEventText } from '../../src/ui/supply-format.ts';
import type { NeedRow } from '../../src/domain/need-import.ts';

const meta = (eventId: string): Meta => ({ eventId, actor: '架空担当A', occurredAt: '2026-10-30T09:00:00+09:00', recordedAt: '2026-10-30T09:00:00+09:00' });
const generated = () => generateTemplateNeeds({ ledger: practiceLedger, supply: saveReceiptTemplate(practiceLedger, emptySupply, meta('op1'), { id: 'kit', name: '架空標準セット', product: 'R', basis: 'label', rows: [{ item: 'P', unit: '個', perSet: 2, location: 'S1' }] }) }, meta('op2'), { templateId: 'kit', caseCode: '000007', count: 10, dueDate: '2026-11-10' });
const change: TemplateNeedEdit = { kind: 'change', needId: 'op2-n1', required: { basis: 'label', value: 19 } };
const custom: TemplateNeedEdit = { kind: 'add', item: 'Q', unit: '個', required: { basis: 'counted', value: 3 }, dueDate: '2026-11-12' };
const reason = '架空の必要数訂正';
const edited = () => editTemplateNeeds(generated(), meta('op3'), '000007', change, reason);

test('4.1 理由と変更前後を持つ正当な案件編集履歴を通常読込で受け付ける', () => {
  const state = generated(), before = state.supply.needs['op2-n1']!, plan = state.supply.templateNeeds['000007']!;
  const after = { ...before, required: { basis: 'label', value: 19 } };
  const wire = JSON.parse(serialize(initial(state.ledger, state.supply)));
  wire.supply.needs[before.id] = after;
  wire.supply.log.push({ ...meta('op3'), kind: 'templateNeeds', action: 'edit', editKind: 'change', reason: '架空の必要数訂正', plansBefore: [plan], plansAfter: [plan], changes: [{ before, after }], itemLabels: state.supply.log.at(-1)!.itemLabels });
  expect(() => parse(JSON.stringify(wire))).not.toThrow();
  expect(parse(JSON.stringify(wire)).supply.needs[before.id]?.required.value).toBe(19);
});

test('4.1, 4.5, 7.3, 7.5 数量だけを変更し、標準・版・他案件・現物・依頼・申告を保持する', () => {
  let state = generated();
  state = generateTemplateNeeds(state, meta('other-case'), { templateId: 'kit', caseCode: '000008', count: 5, dueDate: null });
  state = receiveLot(state.ledger, state.supply, meta('receipt'), { id: '架空現物', item: 'P', unit: '個', project: { kind: 'case', id: '000007' }, location: 'S1' }, 'label', 12);
  state = { ...state, supply: recordRequest(state.supply, state.ledger.masters, meta('request'), { project: { kind: 'case', id: '000007' }, item: 'P', unit: '個', quantity: 8, vendor: '架空依頼先', requestedOn: '2026-10-30', reply: { kind: 'none' } }) };
  state = { ...state, supply: declareShortage(state.supply, state.ledger.masters, meta('declaration'), { project: { kind: 'case', id: '000007' }, item: 'P', unit: '個', value: 8, reason: '架空確認' }) };
  const before = JSON.stringify(state), preview = buildTemplateNeedEdit(state, meta('op3'), '000007', change, reason);
  expect(JSON.stringify(state)).toBe(before);
  const result = editTemplateNeeds(state, meta('op3'), '000007', change, reason);
  expect(result.ledger).toBe(state.ledger);
  expect(result.supply.templateNeeds).toEqual(state.supply.templateNeeds);
  expect(result.supply.needs['op2-n1']).toEqual({ ...state.supply.needs['op2-n1'], required: { basis: 'label', value: 19 } });
  expect(result.supply.needs['other-case-n1']).toEqual(state.supply.needs['other-case-n1']);
  for (const key of ['receiptTemplates', 'receipts', 'requests', 'declarations', 'levels', 'acks'] as const) expect(result.supply[key]).toBe(state.supply[key]);
  expect(result.supply.log.slice(0, -1)).toEqual(state.supply.log);
  expect(result.supply.log.at(-1)).toMatchObject(preview.event);
  expect(templateNeedInfo(result.ledger.masters, templateNeedContextOf(result.supply), result.supply.needs['op2-n1']!)).toMatchObject({ standard: 20, modified: true, origin: 'template' });
  expect(targetsOf(state, result)).toEqual(['必要明細op2-n1']);
});

test.each(['', ' ', '\r\n\t'])('4.4 全変更種別は空理由%sを拒否し入力状態を変更しない', reason => {
  const state = generated(), before = JSON.stringify(state);
  for (const edit of [change, custom, { kind: 'exclude', needId: 'op2-n1' } satisfies TemplateNeedEdit]) expect(() => editTemplateNeeds(state, meta('op3'), '000007', edit, reason)).toThrow('理由');
  expect(JSON.stringify(state)).toBe(before);
});

test('4.2, 4.6 独自明細の追加・不明への変更・除外は由来を保持する', () => {
  const state = generated(), added = editTemplateNeeds(state, meta('op3'), '000007', custom, '案件独自の架空明細');
  expect(added.supply.needs['op3-n1']).toMatchObject({ item: 'Q', required: { basis: 'counted', value: 3 }, source: '案件独自', revision: 'op3', dueDate: '2026-11-12' });
  expect(added.supply.templateNeeds['000007']).toEqual({ ...state.supply.templateNeeds['000007'], origins: [...state.supply.templateNeeds['000007']!.origins, { needId: 'op3-n1', item: 'Q', unit: '個', origin: 'custom' }] });
  const unknown = editTemplateNeeds(added, meta('op4'), '000007', { kind: 'change', needId: 'op3-n1', required: { basis: 'unknown', value: null } }, '架空の数量未確認');
  const excluded = editTemplateNeeds(unknown, meta('op5'), '000007', { kind: 'exclude', needId: 'op3-n1' }, '架空の除外');
  expect(excluded.supply.needs['op3-n1']).toEqual({ ...unknown.supply.needs['op3-n1'], required: { basis: 'label', value: 0 } });
  expect(excluded.supply.log.at(-1)).toMatchObject({ action: 'edit', editKind: 'exclude', reason: '架空の除外', changes: [{ before: unknown.supply.needs['op3-n1'], after: excluded.supply.needs['op3-n1'] }] });
  expect(templateNeedInfo(excluded.ledger.masters, templateNeedContextOf(excluded.supply), excluded.supply.needs['op3-n1']!)).toMatchObject({ origin: 'custom', standard: null });
  expect(excluded.supply.templateNeeds).toEqual({ ...added.supply.templateNeeds, '000007': { ...added.supply.templateNeeds['000007'], origins: added.supply.templateNeeds['000007']!.origins.map(origin => origin.needId === 'op3-n1' ? { ...origin, excluded: true } : origin) } });
});

test('4.2, 4.3 セット由来も独自明細も除外後の0を含め同一品目・単位の再追加を拒否する', () => {
  let state = editTemplateNeeds(generated(), meta('op3'), '000007', { kind: 'exclude', needId: 'op2-n1' }, '架空の除外');
  expect(Object.keys(state.supply.needs)).toHaveLength(1);
  expect(() => editTemplateNeeds(state, meta('op4'), '000007', { ...custom, item: 'P' }, reason)).toThrow(/op2-n1.*変更/);
  state = editTemplateNeeds(state, meta('op4'), '000007', custom, reason);
  state = editTemplateNeeds(state, meta('op5'), '000007', { kind: 'exclude', needId: 'op4-n1' }, reason);
  expect(() => editTemplateNeeds(state, meta('op6'), '000007', custom, reason)).toThrow(/op4-n1.*変更/);
  expect(() => editTemplateNeeds(state, meta('op6'), '000007', { kind: 'exclude', needId: 'op4-n1' }, reason)).toThrow('変わっていない');
});

test('4.1 保存元削除・案件と品目の停止後も既存明細を変更でき、停止品目の新規追加は拒否する', () => {
  let state = editTemplateNeeds(generated(), meta('op3'), '000007', custom, reason);
  const ledger = ['P', 'Q'].reduce((ledger, id) => changeMasters(ledger, meta(`stop-${id}`), { action: 'deactivate', type: 'item', id, reason: '架空停止' }), state.ledger);
  state = { ledger: changeMasters(ledger, meta('stop-case'), { action: 'deactivate', type: 'case', id: '000007', reason: '架空停止' }), supply: deleteReceiptTemplate(state.supply, ledger.masters, meta('delete'), 'kit') };
  state = editTemplateNeeds(state, meta('op4'), '000007', change, reason);
  state = editTemplateNeeds(state, meta('op5'), '000007', { kind: 'change', needId: 'op3-n1', required: { basis: 'unknown', value: null } }, reason);
  expect(parse(serialize(initial(state.ledger, state.supply))).supply).toEqual(state.supply);
  expect(state.supply.receiptTemplates).toEqual({});
  const other = generated(), inactive = changeMasters(other.ledger, meta('stop-new'), { action: 'deactivate', type: 'item', id: 'Q', reason: '架空停止' });
  expect(() => editTemplateNeeds({ ...other, ledger: inactive }, meta('op3'), '000007', custom, reason)).toThrow('利用中');
  expect(() => editTemplateNeeds(other, meta('op3'), '000007', { ...custom, item: 'toString' }, reason)).toThrow('登録済み');
  expect(() => editTemplateNeeds(other, meta('op3'), '000007', { ...custom, unit: '箱' }, reason)).toThrow('単位');
});

const invalidQuantities: NeedQuantity[] = [{ basis: 'unknown', value: 0 }, { basis: 'label', value: null }, { basis: 'label', value: -1 }, { basis: 'counted', value: 0.1 }, { basis: 'approximate', value: NaN }, { basis: 'counted', value: Infinity }];
test.each(invalidQuantities)('4.1, 4.2 既存と追加の数量根拠・値を既存observe規則で拒否する %j', required => {
  const state = generated(), before = JSON.stringify(state);
  expect(() => editTemplateNeeds(state, meta('op3'), '000007', { ...change, required }, reason)).toThrow();
  expect(() => editTemplateNeeds(state, meta('op3'), '000007', { ...custom, required }, reason)).toThrow();
  expect(JSON.stringify(state)).toBe(before);
});

test('4.1, 4.2 小数は品目の最小単位どおり保持し、丸めて受け付けない', () => {
  const base = generated(), ledger = changeMasters(base.ledger, meta('decimal-item'), { action: 'register', master: { type: 'item', code: 'D', name: '架空小数品目', units: ['kg'], unitSteps: { kg: 0.1 }, trial: true, source: null } });
  const state = editTemplateNeeds({ ...base, ledger }, meta('op3'), '000007', { ...custom, item: 'D', unit: 'kg', required: { basis: 'approximate', value: 0.3 } }, reason);
  expect(state.supply.needs['op3-n1']?.required.value).toBe(0.3);
  expect(() => editTemplateNeeds(state, meta('op4'), '000007', { kind: 'change', needId: 'op3-n1', required: { basis: 'label', value: 0.31 } }, reason)).toThrow();
  const next = editTemplateNeeds(state, meta('op4'), '000007', { kind: 'change', needId: 'op3-n1', required: { basis: 'label', value: 0.2 } }, reason);
  expect(parse(serialize(initial(next.ledger, next.supply))).supply.needs['op3-n1']?.required.value).toBe(0.2);
});

test.each(['op1', 'op2', 'op2-c1'])('4.1 台帳と供給の両方の重複操作ID %s を拒否する', id => {
  const state = generated();
  expect(() => editTemplateNeeds(state, meta(id), '000007', change, reason)).toThrow('使用済み');
});
test('4.2 他案件の旧登録で使われた派生明細IDとは衝突させない', () => {
  const state = generated(), supply = registerNeed(state.supply, state.ledger.masters, meta('op3-n1'), { project: { kind: 'case', id: 'A-001' }, item: 'Q', unit: '個', required: { basis: 'label', value: 1 }, dueDate: null, source: '架空の旧資料', revision: '1' });
  const before = JSON.stringify(supply);
  expect(() => editTemplateNeeds({ ...state, supply }, meta('op3'), '000007', custom, reason)).toThrow('必要明細ID op3-n1 は使用済み');
  expect(JSON.stringify(supply)).toBe(before);
});
test('4.1 対象外案件・継承名の明細・変更なし・不正な追加必要日を拒否する', () => {
  const state = generated();
  expect(() => editTemplateNeeds(state, meta('op3'), 'toString', change, reason)).toThrow('案件');
  expect(() => editTemplateNeeds(state, meta('op3'), '000007', { ...change, needId: 'toString' }, reason)).toThrow('必要明細');
  expect(() => editTemplateNeeds(state, meta('op3'), '000007', { ...change, required: { basis: 'label', value: 20 } }, reason)).toThrow('変わっていない');
  expect(() => editTemplateNeeds(state, meta('op3'), '000007', { ...custom, dueDate: '2026-02-30' }, reason)).toThrow('必要日');
});

test('生成以外の編集では最後の分割単位を更新せず、導入版を増やさない', () => {
  const base = generated(), batch = generateTemplateNeedsBatch(base, meta('batch'), { group: { assemblyIndex: 0, mode: 'split', split: 17 }, dueDate: null, projects: [{ templateId: 'kit', caseCode: '000A', count: 40 }, { templateId: 'kit', caseCode: '000I', count: 40 }] });
  const next = editTemplateNeeds(batch, meta('op3'), '000007', change, reason);
  expect(defaultTemplateNeedSplit(next.supply)).toBe(17);
  expect(templateNeedContextOf(next.supply).versions).toEqual(templateNeedContextOf(batch.supply).versions);
});

const pendingOf = (state: ReturnType<typeof generated>): Pending => ({ progress: 'saving', unknownSince: null, savingSince: meta('op3').recordedAt, baseRevision: 0, opId: 'op3', opLabel: '生成した必要明細の変更', fingerprint: '架空入力', values: {}, actor: meta('op3').actor, startedAt: meta('op3').recordedAt, units: [{ ...state, conflictReviews: [], targets: ['必要明細op2-n1'] }] });
test('4.1, 4.6, 8.5 変更・追加・除外を通常/pending/backupで復号し、履歴ラベルとExcelの変更前後を残す', () => {
  let state = edited();
  state = editTemplateNeeds(state, meta('op4'), '000007', custom, reason);
  state = editTemplateNeeds(state, meta('op5'), '000007', { kind: 'exclude', needId: 'op2-n1' }, '架空の除外理由');
  const snapshot = initial(state.ledger, state.supply);
  expect(parse(serialize(snapshot))).toEqual(snapshot);
  expect(decodePending(JSON.parse(serializePending(pendingOf(state))))).toEqual(pendingOf(state));
  expect(readBackup(new TextEncoder().encode(backupTextOf(snapshot, meta('op5').recordedAt)))).toMatchObject({ kind: 'ok', snapshot });
  const event = state.supply.log.at(-1)!;
  expect(supplyEventItemIds(event, state)).toEqual(['P', 'R']);
  expect(event.itemLabels).toMatchObject({ kind: 'recorded', items: { P: { name: '架空部品P' }, R: { name: '架空半製品R' } } });
  const text = supplyEventText(state.ledger.masters, event);
  expect(text).toMatch(/除外.*19個.*0個.*架空の除外理由/);
  const sheets = viewSheetsOf(state, meta('op5').recordedAt), row = sheets.find(sheet => sheet.name === '供給の履歴')?.rows.at(-1);
  expect(row?.[1]).toBe('生成した必要明細の変更'); expect(row?.[5]).toBe(text);
  expect(row?.[6]).toContain('19個'); expect(row?.[7]).toContain('0個'); expect(row?.[8]).toBe('架空の除外理由');
  const needs = sheets.find(sheet => sheet.name === '必要明細')?.rows;
  expect(needs?.[0]?.join(' ')).toContain('手修正あり'); expect(needs?.[1]?.join(' ')).toContain('案件独自');
});

test('8.5 生成明細を参照する正当な取込保留は、その後の案件編集とともに読める', () => {
  const state = generated(), need = state.supply.needs['op2-n1']!;
  const row: NeedRow = { format: 'fuzzy-stock-need-row', version: 1, source: need.source, line: '001', revision: need.revision, previousRevision: null, caseCode: '000007', itemCode: 'P', unit: need.unit, required: need.required, dueDate: need.dueDate };
  // 既存の読込互換契約で許す保留履歴。新しい旧取込入口の拒否は変更しない。
  const wire = JSON.parse(serialize(initial(state.ledger, state.supply)));
  wire.supply.log.push({ ...meta('held'), kind: 'needImport', itemLabels: { kind: 'legacy-unavailable' }, input: { row, raw: JSON.stringify(row) }, decision: { kind: 'hold', reasons: ['架空の照合待ち'], candidates: [need.id] } });
  const accepted = parse(JSON.stringify(wire));
  const next = editTemplateNeeds(accepted, meta('op3'), '000007', change, reason);
  expect(parse(serialize(initial(next.ledger, next.supply))).supply).toEqual(next.supply);
});

test('4.2 新規独自明細も数量不明を許し、理由の原文を保持する', () => {
  const state = editTemplateNeeds(generated(), meta('op3'), '000007', { ...custom, required: { basis: 'unknown', value: null } }, '  架空の未確認理由  ');
  expect(state.supply.needs['op3-n1']?.required).toEqual({ basis: 'unknown', value: null });
  expect(state.supply.log.at(-1)).toMatchObject({ reason: '  架空の未確認理由  ' });
  expect(parse(serialize(initial(state.ledger, state.supply))).supply).toEqual(state.supply);
});

const legacyWire = (state = edited()) => {
  const value = JSON.parse(serialize(initial(state.ledger, state.supply))), event = value.supply.log.at(-1);
  delete event.planFormat;
  event.plansBefore = [value.supply.log[1].plansAfter[0]];
  event.plansAfter = [value.supply.templateNeeds['000007']];
  return value;
};
const wire = () => legacyWire();
const pendingWire = (value: ReturnType<typeof wire>) => ({ format: 'fuzzy-stock-pending', version: 13, quantities: value.quantities, pending: { ...pendingOf(value), units: [{ ledger: value.ledger, supply: value.supply, conflictReviews: [], targets: [] }] } });
const bytes = (text: string) => new TextEncoder().encode(text);
const backupWire = (value: ReturnType<typeof wire>) => {
  const text = JSON.stringify(value), at = meta('op3').recordedAt;
  return bytes(JSON.stringify({ notice: '架空試験', format: 'fuzzy-stock-backup', version: 1, createdAt: at, crc32: crc32(bytes(`${at}\n${text}`)).toString(16).padStart(8, '0'), snapshot: text }));
};
const corruptions: [string, (value: ReturnType<typeof wire>) => void][] = [
  ['空理由', value => { value.supply.log[2].reason = ' \n'; }],
  ['変更種別', value => { value.supply.log[2].editKind = 'exclude'; }],
  ['未対応action', value => { value.supply.log[2].action = 'follow'; }],
  ['生成専用group', value => { value.supply.log[2].group = null; }],
  ['生成専用versions', value => { value.supply.log[2].versions = []; }],
  ['変更前明細欠落', value => { value.supply.log[2].changes[0].before = null; }],
  ['変更前値', value => { value.supply.log[2].changes[0].before.required.value = 18; }],
  ['変更前計画', value => { value.supply.log[2].plansBefore[0].count = 9; }],
  ['変更後計画欠落', value => { value.supply.log[2].plansAfter = []; }],
  ['変更後計画余分', value => { value.supply.log[2].plansAfter.push(value.supply.log[2].plansAfter[0]); }],
  ['差分余分', value => { value.supply.log[2].changes.push(value.supply.log[2].changes[0]); }],
  ['台数変更', value => { value.supply.log[2].plansAfter[0].count = 11; value.supply.templateNeeds['000007'].count = 11; }],
  ['基準版変更', value => { value.supply.log[2].plansAfter[0].version = 'future'; value.supply.templateNeeds['000007'].version = 'future'; }],
  ['初回版変更', value => { value.supply.log[2].plansAfter[0].initialVersion = 'future'; }],
  ['生成ID変更', value => { value.supply.log[2].plansAfter[0].generationId = 'other'; }],
  ['由来変更', value => { value.supply.log[2].plansAfter[0].origins[0].origin = 'custom'; value.supply.templateNeeds['000007'].origins[0].origin = 'custom'; }],
  ['案件変更', value => { value.supply.log[2].changes[0].after.project.id = 'A-001'; value.supply.needs['op2-n1'].project.id = 'A-001'; }],
  ['案件kind変更', value => { value.supply.log[2].changes[0].after.project = { kind: 'common' }; }],
  ['品目変更', value => { value.supply.log[2].changes[0].after.item = 'Q'; value.supply.needs['op2-n1'].item = 'Q'; }],
  ['単位変更', value => { value.supply.log[2].changes[0].after.unit = '箱'; }],
  ['必要日変更', value => { value.supply.log[2].changes[0].after.dueDate = null; value.supply.needs['op2-n1'].dueDate = null; }],
  ['source変更', value => { value.supply.log[2].changes[0].after.source = '別資料'; }],
  ['revision変更', value => { value.supply.log[2].changes[0].after.revision = '別改訂'; }],
  ['明細ID変更', value => { value.supply.log[2].changes[0].after.id = 'other'; }],
  ['不明に数値', value => { value.supply.log[2].changes[0].after.required = { basis: 'unknown', value: 19 }; }],
  ['負数', value => { value.supply.log[2].changes[0].after.required.value = -1; }],
  ['数量precision', value => { value.supply.log[2].changes[0].after.required.value = 0.1; }],
  ['現在値改変', value => { value.supply.needs['op2-n1'].required.value = 18; }],
  ['現在明細欠落', value => { delete value.supply.needs['op2-n1']; }],
  ['現在明細key', value => { value.supply.needs.other = value.supply.needs['op2-n1']; delete value.supply.needs['op2-n1']; }],
  ['イベント重複', value => { value.supply.log.push(value.supply.log[2]); }],
  ['台帳IDと衝突', value => { value.supply.log[2].eventId = 'op2-c1'; }],
];
test.each(corruptions)('8.5 編集%sの改変を通常・pending・backupで拒否する', (_label, corrupt) => {
  const value = wire(), original = JSON.stringify(value); corrupt(value);
  const raw = JSON.stringify(value);
  expect(() => parse(raw)).toThrow();
  expect(() => decodePending(pendingWire(value))).toThrow();
  expect(readBackup(backupWire(value)).kind).toBe('unreadable');
  expect(JSON.stringify(value)).toBe(raw);
  expect(original).not.toBe(raw);
});

test.each(['ID', 'source', 'revision', 'origin', 'before', '重複', '未登録品目', '未登録単位'])('8.5 独自追加%sの改変を通常・pending・backupで拒否する', key => {
  const state = editTemplateNeeds(generated(), meta('op3'), '000007', custom, reason), value = legacyWire(state);
  const event = value.supply.log[2], after = event.changes[0].after;
  if (key === 'ID') after.id = 'other';
  if (key === 'source') after.source = '別資料';
  if (key === 'revision') after.revision = 'other';
  if (key === 'origin') event.plansAfter[0].origins[1].origin = 'template';
  if (key === 'before') event.changes[0].before = value.supply.needs['op2-n1'];
  if (key === '重複') { after.item = 'P'; event.plansAfter[0].origins[1].item = 'P'; }
  if (key === '未登録品目') after.item = 'toString';
  if (key === '未登録単位') after.unit = '箱';
  expect(() => parse(JSON.stringify(value))).toThrow(); expect(() => decodePending(pendingWire(value))).toThrow(); expect(readBackup(backupWire(value)).kind).toBe('unreadable');
});

test('8.5 最終itemLabels込みイベント1MiBを超える編集は状態を変えず拒否する', () => {
  const state = generated(), event = edited().supply.log.at(-1)!;
  const length = 1024 * 1024 - bytes(JSON.stringify(event)).length + bytes(reason).length;
  const result = editTemplateNeeds(state, meta('op3'), '000007', change, 'x'.repeat(length));
  expect(bytes(JSON.stringify(result.supply.log.at(-1))).length).toBe(1024 * 1024);
  const before = JSON.stringify(state);
  expect(() => buildTemplateNeedEdit(state, meta('op3'), '000007', change, 'x'.repeat(length + 1))).not.toThrow();
  expect(() => editTemplateNeeds(state, meta('op3'), '000007', change, 'x'.repeat(length + 1))).toThrow('1MiB');
  expect(JSON.stringify(state)).toBe(before);
});
