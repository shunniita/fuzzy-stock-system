import { expect, test } from 'vitest';
import { changeMasters, practiceLedger, type Meta } from '../../src/domain/ledger.ts';
import { emptySupply, receiveLot, recordRequest, registerNeed } from '../../src/domain/supply.ts';
import { saveReceiptTemplate, type ReceiptTemplate } from '../../src/domain/receipt-template.ts';
import { buildTemplateNeedBatchGeneration, checkTemplateNeedGroup, defaultTemplateNeedSplit, generateTemplateNeeds, generateTemplateNeedsBatch, proposeTemplateNeedSplit, templateNeedContextOf, type TemplateNeedBatchInput } from '../../src/domain/template-needs.ts';
import { shortageOf } from '../../src/domain/shortage.ts';
import { initial, parse, serialize, serializePending, type Pending } from '../../src/ui/storage.ts';
import { decodePending } from '../../src/ui/storageparse.ts';
import { backupTextOf, crc32, readBackup } from '../../src/ui/backup.ts';
import { supplyEventText } from '../../src/ui/supply-format.ts';
import { viewSheetsOf } from '../../src/ui/viewsheets.ts';

const meta = (eventId: string): Meta => ({ eventId, actor: '架空担当A', occurredAt: '2026-10-30T09:00:00+09:00', recordedAt: '2026-10-30T09:00:00+09:00' });
const saved = () => ({ ledger: practiceLedger, supply: saveReceiptTemplate(practiceLedger, emptySupply, meta('save'), { id: 'kit', name: '架空セット', product: 'R', basis: 'label', rows: [{ item: 'P', unit: '個', perSet: 2, location: 'S1' }] }) });
const same = (prefix = '000'): TemplateNeedBatchInput => ({ projects: [{ templateId: 'kit', caseCode: `${prefix}A`, count: 40 }, { templateId: 'kit', caseCode: `${prefix}I`, count: 40 }], dueDate: '2026-11-10', group: { assemblyIndex: 0, mode: 'same', split: null } });
const split = (prefix = '000'): TemplateNeedBatchInput => ({ projects: [{ templateId: 'kit', caseCode: `${prefix}A`, count: 90 }, ...[20, 20, 20, 20, 10].map((count, index) => ({ templateId: 'kit', caseCode: `${prefix}I${index}`, count }))], dueDate: null, group: { assemblyIndex: 0, mode: 'split', split: 20 } });
const batch = () => generateTemplateNeedsBatch(saved(), meta('gen'), split());
const wire = () => { const state = batch(); return JSON.parse(serialize(initial(state.ledger, state.supply))); };
const pending = (state: ReturnType<typeof saved>): Pending => ({ progress: 'saving', unknownSince: null, savingSince: meta('p').recordedAt, baseRevision: 0, opId: 'op1', opLabel: '架空まとめて生成', fingerprint: '架空入力', values: {}, actor: '架空担当A', startedAt: meta('p').recordedAt, units: [{ ledger: state.ledger, supply: state.supply, conflictReviews: [], targets: [] }] });
const pendingWire = (value: ReturnType<typeof wire>) => ({ format: 'fuzzy-stock-pending', version: 13, quantities: value.quantities, pending: pending(value) });
const bytes = (value: string) => new TextEncoder().encode(value);
const backup = (value: ReturnType<typeof wire>) => {
  const text = JSON.stringify(value), at = meta('p').recordedAt;
  return bytes(JSON.stringify({ notice: '架空試験', format: 'fuzzy-stock-backup', version: 1, createdAt: at, crc32: crc32(bytes(`${at}\n${text}`)).toString(16).padStart(8, '0'), snapshot: text }));
};

test('3.2,3.9 正当な同数40台の全案件を持つ一つの生成イベントを読める', () => {
  const first = generateTemplateNeeds(saved(), meta('gen'), { templateId: 'kit', caseCode: 'A-001', count: 40, dueDate: null });
  const second = generateTemplateNeeds(first, meta('gen2'), { templateId: 'kit', caseCode: 'A-002', count: 40, dueDate: null });
  const value = JSON.parse(serialize(initial(second.ledger, second.supply)));
  const event = value.supply.log[1], last = value.supply.log.pop();
  const need = { ...last.changes[0].after, id: 'gen-n2' };
  const plan = { ...last.plansAfter[0], generationId: 'gen', origins: [{ ...last.plansAfter[0].origins[0], needId: need.id }] };
  event.group = { assemblyIndex: 0, mode: 'same', split: null };
  event.plansBefore.push(null); event.plansAfter.push(plan); event.changes.push({ before: null, after: need });
  delete value.supply.needs['gen2-n1']; value.supply.needs[need.id] = need;
  value.supply.templateNeeds['A-002'] = plan;
  expect(Object.values(parse(JSON.stringify(value)).supply.needs).map(need => need.required.value)).toEqual([80, 80]);
});

test('3.1,3.2,3.9 同数40台を一操作で記録し、全計画の生成ID・版を共有する', () => {
  const state = saved(), before = JSON.stringify(state), result = buildTemplateNeedBatchGeneration(state, templateNeedContextOf(state.supply), meta('gen'), same());
  expect(result.projects.map(project => [project.plan.project, project.rows[0]?.required, project.newProject])).toEqual([['000A', 80, true], ['000I', 80, true]]);
  expect(result.event.plansAfter.every(plan => plan.generationId === 'gen' && plan.initialVersion === 'gen-v1')).toBe(true);
  expect(result.event.versions).toHaveLength(1);
  expect(result.needs.map(need => need.id)).toEqual(['gen-n1', 'gen-n2']);
  expect(result.ledger.history.map(event => event.eventId)).toEqual(['gen-c1', 'gen-c2']);
  const committed = generateTemplateNeedsBatch(state, meta('gen'), same());
  expect(committed.supply.log.map(event => event.kind)).toEqual(['receiptTemplateSave', 'templateNeeds']);
  expect(committed.supply.log.at(-1)).toMatchObject({ group: same().group, plansBefore: [null, null] });
  expect(Object.keys(committed.supply.needs)).toHaveLength(2);
  expect(JSON.stringify(state)).toBe(before);
});

test('3.3 分割90台を20/20/20/20/10で提案し、元の案件IDは作らない', () => {
  expect(proposeTemplateNeedSplit(90, 20)).toEqual([20, 20, 20, 20, 10]);
  expect(proposeTemplateNeedSplit(1, 20)).toEqual([1]);
  const state = batch();
  expect(Object.values(state.supply.needs).map(need => need.required.value)).toEqual([180, 40, 40, 40, 40, 20]);
  expect(Object.values(state.supply.templateNeeds).map(plan => plan.count)).toEqual([90, 20, 20, 20, 20, 10]);
  expect(Object.values(state.ledger.masters.cases).filter(project => project.code?.startsWith('000')).map(project => project.code)).toEqual(split().projects.map(project => project.caseCode));
});

test('3.3,3.4 既定分割は確定したsplitだけから取り、手修正台数と同数生成は変更しない', () => {
  const state = saved();
  expect(defaultTemplateNeedSplit(state.supply)).toBe(20);
  const manual: TemplateNeedBatchInput = { ...split(), projects: [{ templateId: 'kit', caseCode: '000A', count: 90 }, { templateId: 'kit', caseCode: '000I1', count: 25 }, { templateId: 'kit', caseCode: '000I2', count: 65 }], group: { assemblyIndex: 0, mode: 'split', split: 18 } };
  const committed = generateTemplateNeedsBatch(state, meta('gen'), manual);
  expect(defaultTemplateNeedSplit(committed.supply)).toBe(18);
  const afterSame = generateTemplateNeedsBatch(committed, meta('same'), same('001'));
  expect(defaultTemplateNeedSplit(afterSame.supply)).toBe(18);
  buildTemplateNeedBatchGeneration(afterSame, templateNeedContextOf(afterSame.supply), meta('preview'), { ...split('002'), group: { assemblyIndex: 0, mode: 'split', split: 5 } });
  expect(defaultTemplateNeedSplit(afterSame.supply)).toBe(18);
});

test.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('3.4 不正な台数/分割単位%sを全件拒否する', count => {
  const state = saved(), before = JSON.stringify(state), input = same();
  expect(() => generateTemplateNeedsBatch(state, meta('gen'), { ...input, projects: [input.projects[0]!, { ...input.projects[1]!, count }] })).toThrow();
  expect(() => generateTemplateNeedsBatch(state, meta('gen'), { ...split(), group: { assemblyIndex: 0, mode: 'split', split: count } })).toThrow();
  expect(() => proposeTemplateNeedSplit(90, count)).toThrow();
  expect(JSON.stringify(state)).toBe(before);
});

test('3.2,3.6 合計不一致と同数方式の分け先複数件を拒否し、差を正確に示す', () => {
  const input = split();
  expect(() => generateTemplateNeedsBatch(saved(), meta('gen'), { ...input, projects: input.projects.map((project, index) => index === 1 ? { ...project, count: 19 } : project) })).toThrow('差は-1台');
  expect(() => generateTemplateNeedsBatch(saved(), meta('gen'), { ...input, group: { assemblyIndex: 0, mode: 'same', split: null } })).toThrow('同数');
  expect(() => checkTemplateNeedGroup([Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 1], { assemblyIndex: 0, mode: 'split', split: 20 })).toThrow('差は1台');
});

test('3.7 ID重複・空・停止・既存0明細・最後の案件不正は案件登録も未適用', () => {
  const state = saved(), input = same(), before = JSON.stringify(state);
  for (const caseCode of ['000A', '', '  ']) expect(() => generateTemplateNeedsBatch(state, meta('gen'), { ...input, projects: [input.projects[0]!, { ...input.projects[1]!, caseCode }] })).toThrow();
  const ledger = changeMasters(state.ledger, meta('stop'), { action: 'deactivate', type: 'case', id: 'A-001', reason: '架空停止' });
  expect(() => generateTemplateNeedsBatch({ ...state, ledger }, meta('gen'), { ...input, projects: [input.projects[0]!, { ...input.projects[1]!, caseCode: 'A-001' }] })).toThrow('利用停止');
  const supply = registerNeed(state.supply, state.ledger.masters, meta('need'), { project: { kind: 'case', id: 'A-001' }, item: 'P', unit: '個', required: { basis: 'label', value: 0 }, dueDate: null, source: '架空資料', revision: '1' });
  expect(() => generateTemplateNeedsBatch({ ...state, supply }, meta('gen'), { ...input, projects: [input.projects[0]!, { ...input.projects[1]!, caseCode: 'A-001' }] })).toThrow('必要明細');
  expect(() => generateTemplateNeedsBatch(state, meta('gen'), { ...input, projects: [input.projects[0]!, { ...input.projects[1]!, templateId: 'missing' }] })).toThrow();
  expect(JSON.stringify(state)).toBe(before);
});

test('3.7 重複した案件ID原文を拒否理由に示す', () => {
  const input = same();
  expect(() => generateTemplateNeedsBatch(saved(), meta('gen'), { ...input, projects: input.projects.map(project => ({ ...project, caseCode: '000重複' })) })).toThrow('000重複');
});

test('3.10 現物・依頼・他案件を変えず、案件別に不足を分ける', () => {
  const base = saved(), received = receiveLot(base.ledger, base.supply, meta('receipt'), { id: 'lot', item: 'P', unit: '個', project: { kind: 'case', id: 'B-001' }, location: 'S1' }, 'label', 18);
  const supply = recordRequest(received.supply, received.ledger.masters, meta('request'), { project: { kind: 'case', id: 'B-001' }, item: 'P', unit: '個', quantity: 2, vendor: '架空手配先', requestedOn: '2026-10-30', reply: { kind: 'none' } });
  const state = { ...received, supply }, result = generateTemplateNeedsBatch(state, meta('gen'), same());
  expect(result.ledger.lots).toEqual(state.ledger.lots);
  expect(result.supply.requests).toEqual(state.supply.requests);
  expect(result.supply.receipts).toEqual(state.supply.receipts);
  for (const project of ['000A', '000I']) expect(shortageOf(result.ledger, result.supply, { project: { kind: 'case', id: project }, item: 'P', unit: '個' }).shortage).toBe(80);
});

test('元と分け先の別セットを各一回だけ導入し、保存後も全案件と原文コードを保つ', () => {
  const base = saved(), other = { id: 'inspection', name: '架空分け先セット', product: 'Q', basis: 'label', rows: [{ item: 'P', unit: '個', perSet: 3, location: 'S1' }] } satisfies Omit<ReceiptTemplate, 'project'>;
  const supply = saveReceiptTemplate(base.ledger, base.supply, meta('save-other'), other), input = split();
  const result = generateTemplateNeedsBatch({ ...base, supply }, meta('gen'), { ...input, projects: input.projects.map((project, index) => index === 0 ? project : { ...project, templateId: other.id }) });
  expect(result.supply.log.at(-1)).toMatchObject({ versions: [{ id: 'gen-v1' }, { id: 'gen-v2' }] });
  const snapshot = initial(result.ledger, result.supply);
  expect(parse(serialize(snapshot))).toEqual(snapshot);
  expect(decodePending(JSON.parse(serializePending(pending(result))))).toEqual(pending(result));
  expect(readBackup(bytes(backupTextOf(snapshot, meta('p').recordedAt)))).toMatchObject({ kind: 'ok', snapshot });
  const again = generateTemplateNeedsBatch(result, meta('gen2'), { ...same('001'), projects: same('001').projects.map((project, index) => index === 0 ? project : { ...project, templateId: other.id }) });
  expect(again.supply.log.at(-1)).toMatchObject({ versions: [], plansAfter: [{ version: 'gen-v1' }, { version: 'gen-v2' }] });
  expect(parse(serialize(initial(again.ledger, again.supply))).supply).toEqual(again.supply);
});

const corruptions: [string, (value: ReturnType<typeof wire>) => void][] = [
  ['合計', value => { value.supply.log[1].plansAfter[1].count = 19; }],
  ['方式', value => { value.supply.log[1].group.mode = 'same'; value.supply.log[1].group.split = null; }],
  ['分割0', value => { value.supply.log[1].group.split = 0; }],
  ['元の位置', value => { value.supply.log[1].group.assemblyIndex = 1; }],
  ['group欠落', value => { value.supply.log[1].group = null; }],
  ['計画欠落', value => { value.supply.log[1].plansAfter.pop(); }],
  ['案件重複', value => { value.supply.log[1].plansAfter[1].project = value.supply.log[1].plansAfter[0].project; }],
  ['生成ID', value => { value.supply.log[1].plansAfter[1].generationId = 'other'; }],
  ['版参照', value => { value.supply.log[1].plansAfter[1].version = 'future-v1'; }],
  ['明細ID', value => { value.supply.log[1].changes[1].after.id = 'gen-n1'; }],
  ['現在値', value => { value.supply.needs['gen-n2'].required.value = 41; }],
  ['保持明細1001', value => { value.supply.templateNeeds['000A'].origins = Array.from({ length: 1001 }, () => value.supply.templateNeeds['000A'].origins[0]); }],
];
test.each(corruptions)('保存改変%sをsnapshot・pending・backupで拒否する', (_name, corrupt) => {
  const value = wire(); corrupt(value);
  expect(() => parse(JSON.stringify(value))).toThrow();
  expect(() => decodePending(pendingWire(value))).toThrow();
  expect(readBackup(backup(value)).kind).toBe('unreadable');
});

test('一回20案件・1000明細を受け付け、21案件/1001明細は案件数境界で拒否する', () => {
  let ledger = practiceLedger;
  const rows: ReceiptTemplate['rows'][number][] = [];
  for (let index = 0; index < 50; index++) {
    const code = `Z${index}`;
    ledger = changeMasters(ledger, meta(`item${index}`), { action: 'register', master: { type: 'item', code, name: `架空${code}`, units: ['個'], unitSteps: { 個: 1 }, trial: true, source: null } });
    rows.push({ item: code, unit: '個', perSet: 1, location: 'S1' });
  }
  const supply = saveReceiptTemplate(ledger, emptySupply, meta('save'), { id: 'wide', name: '架空50行セット', product: 'R', basis: 'label', rows });
  const input: TemplateNeedBatchInput = { group: { assemblyIndex: 0, mode: 'split', split: 1 }, dueDate: null, projects: Array.from({ length: 20 }, (_, index) => ({ templateId: 'wide', caseCode: `000${index}`, count: index === 0 ? 19 : 1 })) };
  const result = generateTemplateNeedsBatch({ ledger, supply }, meta('gen'), input);
  expect(Object.keys(result.supply.needs)).toHaveLength(1000);
  expect(Object.keys(result.supply.templateNeeds)).toHaveLength(20);
  expect(result.supply.log.at(-1)).toMatchObject({ versions: [{ id: 'gen-v1' }] });
  expect(parse(serialize(initial(result.ledger, result.supply))).supply.needs).toEqual(result.supply.needs);
  const extra = { ...input, projects: [...input.projects.map((project, index) => index === 0 ? { ...project, count: 20 } : project), { templateId: 'wide', caseCode: '00020', count: 1 }] };
  expect(() => generateTemplateNeedsBatch({ ledger, supply }, meta('gen'), extra)).toThrow('20案件');
  // 20案件×最上位50行が最大。最後だけ1行の21案件でも1001明細なので、先に案件数境界で拒否する。
  const short = saveReceiptTemplate(ledger, supply, meta('short-save'), { id: 'short', name: '架空1行セット', product: 'R', basis: 'label', rows: [rows[0]!] });
  expect(() => generateTemplateNeedsBatch({ ledger, supply: short }, meta('gen'), { ...extra, projects: extra.projects.map((project, index) => index === 20 ? { ...project, templateId: 'short' } : project) })).toThrow('20案件');
  expect(() => proposeTemplateNeedSplit(Number.MAX_SAFE_INTEGER, 1)).toThrow('20案件');
});

test('最終itemLabels込みUTF-8 1MiBの直前・一致を許し、1byte超過は全件未適用', () => {
  const state = saved(), input = { ...same(), projects: [{ templateId: 'kit', caseCode: 'A-001', count: 40 }, { templateId: 'kit', caseCode: 'A-002', count: 40 }] };
  const baseline = generateTemplateNeedsBatch(state, meta('gen'), input).supply.log.at(-1)!;
  const length = 1024 * 1024 - bytes(JSON.stringify(baseline)).byteLength + bytes(meta('gen').actor).byteLength;
  const before = JSON.stringify(state);
  for (const padding of [length - 1, length]) {
    const result = generateTemplateNeedsBatch(state, { ...meta('gen'), actor: 'a'.repeat(padding) }, input);
    expect(bytes(JSON.stringify(result.supply.log.at(-1))).byteLength).toBe(1024 * 1024 + padding - length);
  }
  expect(() => generateTemplateNeedsBatch(state, { ...meta('gen'), actor: 'a'.repeat(length + 1) }, input)).toThrow('1MiB');
  expect(JSON.stringify(state)).toBe(before);
});

test('8.1 異なるセットの同じ品目も、履歴とExcelで案件ごとの数量へ明示的に結び付ける', () => {
  const state = saved();
  const supply = saveReceiptTemplate(state.ledger, state.supply, meta('op2'), { id: 'inspection', name: '架空検査セット', product: 'R', basis: 'label', rows: [{ item: 'P', unit: '個', perSet: 3, location: 'S1' }] });
  const result = generateTemplateNeedsBatch({ ...state, supply }, meta('op3'), { group: { assemblyIndex: 0, mode: 'same', split: null }, dueDate: '2026-11-01', projects: [{ templateId: 'kit', caseCode: '000001', count: 40 }, { templateId: 'inspection', caseCode: '000002', count: 40 }] });
  const event = result.supply.log.at(-1)!;
  const text = supplyEventText(result.ledger.masters, event), chunks = text.split('；');
  expect(chunks).toHaveLength(2);
  expect(chunks[0]).toMatch(/000001.*架空セット.*40台.*セット版op3-v1.*品目.*P.*80個/);
  expect(chunks[0]).not.toContain('120個');
  expect(chunks[1]).toMatch(/000002.*架空検査セット.*40台.*セット版op3-v2.*品目.*P.*120個/);
  expect(chunks[1]).not.toContain('80個');
  expect(text).toContain('同じ台数');
  expect(viewSheetsOf(result, meta('op3').recordedAt).find(sheet => sheet.name === '供給の履歴')?.rows.at(-1)?.[5]).toBe(text);
});
