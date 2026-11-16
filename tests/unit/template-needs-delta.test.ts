import { expect, test } from 'vitest';
import { changeMasters, practiceLedger, type Meta } from '../../src/domain/ledger.ts';
import { emptySupply, recordTemplateNeeds } from '../../src/domain/supply.ts';
import { saveReceiptTemplate, type ReceiptTemplate } from '../../src/domain/receipt-template.ts';
import { buildTemplateNeedFollow, editTemplateNeeds, followTemplateNeeds, generateTemplateNeeds, recalculateTemplateNeeds } from '../../src/domain/template-needs.ts';
import { initial, parse, serialize } from '../../src/ui/storage.ts';
import { decodePending } from '../../src/ui/storageparse.ts';
import { crc32, readBackup } from '../../src/ui/backup.ts';

const meta = (eventId: string): Meta => ({ eventId, actor: '架空担当A', occurredAt: '2026-11-01T09:00:00+09:00', recordedAt: '2026-11-01T09:00:00+09:00' });
const template: ReceiptTemplate = { id: 'kit', name: '架空セット', product: 'R', project: null, basis: 'label', rows: [{ item: 'P', unit: '個', perSet: 2, location: 'S1' }, { item: 'Q', unit: '個', perSet: 1, location: 'S1' }] };
const generated = () => generateTemplateNeeds({ ledger: practiceLedger, supply: saveReceiptTemplate(practiceLedger, emptySupply, meta('save'), template) }, meta('gen'), { templateId: 'kit', caseCode: '000909', count: 10, dueDate: null });
const excluded = () => editTemplateNeeds(generated(), meta('exclude'), '000909', { kind: 'exclude', needId: 'gen-n1' }, '架空の除外');
const wire = () => { const state = excluded(); return JSON.parse(serialize(initial(state.ledger, state.supply))); };
const bytes = (value: string) => new TextEncoder().encode(value);
function pending(value: ReturnType<typeof wire>) {
  return { format: 'fuzzy-stock-pending', version: 13, quantities: value.quantities, pending: { progress: 'saving', unknownSince: null, savingSince: meta('exclude').recordedAt, baseRevision: 0, opId: 'exclude', opLabel: '必要明細の変更', fingerprint: '架空入力', values: {}, actor: '架空担当A', startedAt: meta('exclude').recordedAt, units: [{ ledger: value.ledger, supply: value.supply, conflictReviews: [], targets: [] }] } };
}
function backup(value: ReturnType<typeof wire>) {
  const text = JSON.stringify(value), createdAt = meta('exclude').recordedAt;
  return bytes(JSON.stringify({ notice: '架空試験', format: 'fuzzy-stock-backup', version: 1, createdAt, crc32: crc32(bytes(`${createdAt}\n${text}`)).toString(16).padStart(8, '0'), snapshot: text }));
}

test('編集は計画のヘッダーと一明細差分だけを記録し通常・pending・backupで復元する', () => {
  const state = excluded(), event = state.supply.log.at(-1)!;
  expect(event).toMatchObject({ action: 'edit', planFormat: 'delta' });
  if (event.kind !== 'templateNeeds') throw new Error('イベント種別');
  expect(event.plansBefore[0]).not.toHaveProperty('origins');
  expect(event.plansAfter[0]).not.toHaveProperty('origins');
  expect(state.supply.templateNeeds['000909']?.origins[0]).toMatchObject({ excluded: true });
  expect(parse(serialize(initial(state.ledger, state.supply))).supply).toEqual(state.supply);
  expect(() => decodePending(pending(wire()))).not.toThrow();
  expect(readBackup(backup(wire())).kind).toBe('ok');
});

test.each([
  ['未知形式', (value: ReturnType<typeof wire>) => { value.supply.log.at(-1).planFormat = 'future'; }],
  ['印欠落', (value: ReturnType<typeof wire>) => { delete value.supply.log.at(-1).planFormat; }],
  ['旧計画混在', (value: ReturnType<typeof wire>) => { value.supply.log.at(-1).plansBefore[0].origins = []; }],
  ['生成ID改変', (value: ReturnType<typeof wire>) => { value.supply.log.at(-1).plansAfter[0].generationId = 'other'; }],
  ['初回版改変', (value: ReturnType<typeof wire>) => { value.supply.log.at(-1).plansBefore[0].initialVersion = 'other'; }],
  ['除外状態欠落', (value: ReturnType<typeof wire>) => { delete value.supply.templateNeeds['000909'].origins[0].excluded; }],
  ['除外状態の偽値', (value: ReturnType<typeof wire>) => { value.supply.templateNeeds['000909'].origins[0].excluded = false; }],
  ['別明細を除外', (value: ReturnType<typeof wire>) => { value.supply.templateNeeds['000909'].origins[1].excluded = true; }],
] as const)('差分編集の%sを通常・pending・backupで拒否する', (_name, corrupt) => {
  const value = wire(); corrupt(value);
  expect(() => parse(JSON.stringify(value))).toThrow();
  expect(() => decodePending(pending(value))).toThrow();
  expect(readBackup(backup(value)).kind).toBe('unreadable');
});

test('標準が0の時点の除外も記録し、メタデータ変更と未選択の再計算で保持する', () => {
  const base = generated();
  let state = { ...base, supply: saveReceiptTemplate(base.ledger, base.supply, meta('remove'), { ...template, rows: [template.rows[1]!] }) };
  state = followTemplateNeeds(state, meta('follow-remove'), '000909', []);
  expect(state.supply.needs['gen-n1']?.required.value).toBe(0);
  state = editTemplateNeeds(state, meta('exclude-zero'), '000909', { kind: 'exclude', needId: 'gen-n1' }, '架空の除外');
  const before = state.supply.needs['gen-n1']!;
  state = editTemplateNeeds(state, meta('metadata'), '000909', { kind: 'change', needId: before.id, required: before.required, dueDate: '2026-12-01' }, '架空の必要日訂正');
  state = recalculateTemplateNeeds(state, meta('count'), '000909', 20, [], '架空の台数変更');
  expect(state.supply.templateNeeds['000909']?.origins[0]).toMatchObject({ excluded: true });
  state = { ...state, supply: saveReceiptTemplate(state.ledger, state.supply, meta('restore'), template) };
  state = followTemplateNeeds(state, meta('follow-restore'), '000909', []);
  expect(state.supply.needs['gen-n1']?.required.value).toBe(0);
  state = recalculateTemplateNeeds(state, meta('select'), '000909', 30, ['gen-n1'], '架空の標準適用');
  expect(state.supply.needs['gen-n1']?.required.value).toBe(60);
  expect(state.supply.templateNeeds['000909']?.origins[0]).not.toHaveProperty('excluded');
  expect(parse(serialize(initial(state.ledger, state.supply))).supply).toEqual(state.supply);
});

test('必要数を明示変更すると除外を解除し、同じ明細の再除外は拒否する', () => {
  const state = excluded();
  expect(() => editTemplateNeeds(state, meta('again'), '000909', { kind: 'exclude', needId: 'gen-n1' }, '架空の重複')).toThrow('変わっていない');
  const changed = editTemplateNeeds(state, meta('change'), '000909', { kind: 'change', needId: 'gen-n1', required: { basis: 'label', value: 20 } }, '架空の復帰');
  expect(changed.supply.templateNeeds['000909']?.origins[0]).not.toHaveProperty('excluded');
});

test('標準0の明示適用でも除外を解除し、後で行が戻れば自動計算する', () => {
  const base = excluded();
  let state = { ...base, supply: saveReceiptTemplate(base.ledger, base.supply, meta('remove'), { ...template, rows: [template.rows[1]!] }) };
  state = followTemplateNeeds(state, meta('follow-remove'), '000909', []);
  state = recalculateTemplateNeeds(state, meta('select-zero'), '000909', 20, ['gen-n1'], '架空の標準適用');
  expect(state.supply.needs['gen-n1']?.required.value).toBe(0);
  expect(state.supply.templateNeeds['000909']?.origins[0]).not.toHaveProperty('excluded');
  state = { ...state, supply: saveReceiptTemplate(state.ledger, state.supply, meta('restore'), template) };
  state = followTemplateNeeds(state, meta('follow-restore'), '000909', []);
  expect(state.supply.needs['gen-n1']?.required.value).toBe(40);
  expect(parse(serialize(initial(state.ledger, state.supply))).supply).toEqual(state.supply);
});

test('旧全計画形式の除外履歴を変更せず読み、新更新で除外意図を引き継ぐ', () => {
  const value = wire(), event = value.supply.log.at(-1), plan = structuredClone(value.supply.templateNeeds['000909']);
  delete plan.origins[0].excluded;
  delete event.planFormat; event.plansBefore = [plan]; event.plansAfter = [plan]; value.supply.templateNeeds['000909'] = plan;
  const legacy = parse(JSON.stringify(value));
  expect(JSON.parse(serialize(legacy))).toEqual(value);
  let state = { ledger: legacy.ledger, supply: saveReceiptTemplate(legacy.ledger, legacy.supply, meta('remove'), { ...template, rows: [template.rows[1]!] }) };
  state = followTemplateNeeds(state, meta('follow-remove'), '000909', []);
  const oldRemoval = JSON.parse(serialize(initial(state.ledger, state.supply)));
  oldRemoval.supply.log.at(-1).calculationPolicy = 'preserve-basis';
  delete oldRemoval.supply.log.at(-1).plansAfter[0].origins[0].excluded;
  delete oldRemoval.supply.templateNeeds['000909'].origins[0].excluded;
  state = parse(JSON.stringify(oldRemoval));
  expect(JSON.parse(serialize(initial(state.ledger, state.supply))).supply).toEqual(oldRemoval.supply);
  state = { ...state, supply: saveReceiptTemplate(state.ledger, state.supply, meta('restore'), template) };
  const protectedPreview = buildTemplateNeedFollow(state, meta('legacy-restore'), '000909', []);
  const restoredPlan = { ...protectedPreview.plan, origins: protectedPreview.plan.origins.map(({ excluded: _, ...origin }) => origin) };
  const before = state.supply.needs['gen-n1']!;
  const legacyRestored = { ledger: state.ledger, supply: recordTemplateNeeds(state.ledger, state.supply, meta('legacy-restore'), { ...protectedPreview.event, calculationPolicy: 'preserve-basis', plansAfter: [restoredPlan], changes: [{ before, after: { ...before, required: { basis: 'label', value: 20 }, source: template.name, revision: 'gen-v1' } }, ...protectedPreview.event.changes] }) };
  const newCount = recalculateTemplateNeeds(legacyRestored, meta('after-legacy'), '000909', 20, [], '架空の台数変更');
  expect(newCount.supply.needs['gen-n1']?.required.value).toBe(40);
  expect(newCount.supply.templateNeeds['000909']?.origins[0]).not.toHaveProperty('excluded');
  expect(parse(serialize(initial(newCount.ledger, newCount.supply))).supply).toEqual(newCount.supply);
  state = followTemplateNeeds(state, meta('follow-restore'), '000909', []);
  expect(state.supply.needs['gen-n1']?.required.value).toBe(0);
  expect(state.supply.templateNeeds['000909']?.origins[0]).toMatchObject({ excluded: true });
  expect(parse(serialize(initial(state.ledger, state.supply))).supply).toEqual(state.supply);
});

test('実writerで保持明細1000件を作っても一明細編集は全由来を複製しない', () => {
  let ledger = practiceLedger;
  for (let index = 0; index < 1000; index++) ledger = changeMasters(ledger, meta(`item-${index}`), { action: 'register', master: { type: 'item', code: `Z${index}`, name: `架空品目${index}`, units: ['個'], unitSteps: { 個: 1 }, trial: false, source: null } });
  const recipe = (offset: number): ReceiptTemplate => ({ ...template, rows: Array.from({ length: 50 }, (_, index) => ({ item: `Z${offset + index}`, unit: '個', perSet: 1, location: 'S1' })) });
  let state = generateTemplateNeeds({ ledger, supply: saveReceiptTemplate(ledger, emptySupply, meta('large-save'), recipe(0)) }, meta('large-gen'), { templateId: 'kit', caseCode: 'large', count: 1, dueDate: null });
  for (let offset = 50; offset < 1000; offset += 50) {
    state = { ...state, supply: saveReceiptTemplate(state.ledger, state.supply, meta(`save-${offset}`), recipe(offset)) };
    state = followTemplateNeeds(state, meta(`follow-${offset}`), 'large', []);
  }
  const plan = state.supply.templateNeeds.large!;
  expect(plan.origins).toHaveLength(1000);
  const edited = editTemplateNeeds(state, meta('large-edit'), 'large', { kind: 'change', needId: 'large-gen-n1', required: { basis: 'label', value: 3 } }, '架空の訂正');
  const event = edited.supply.log.at(-1)!, size = bytes(JSON.stringify(event)).length;
  const fullSize = bytes(JSON.stringify({ ...event, plansBefore: [plan], plansAfter: [plan] })).length;
  console.info(`保持1000明細の編集イベント: ${size}B、全計画形式相当: ${fullSize}B`);
  expect(size).toBeLessThan(fullSize / 10);
  expect(parse(serialize(initial(edited.ledger, edited.supply))).supply).toEqual(edited.supply);
}, 30000);
