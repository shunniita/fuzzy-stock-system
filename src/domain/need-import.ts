import { checkTime, deepFreeze, type Meta } from './ledger.ts';
import { parseExactJson } from './exact-json.ts';
import { inputStepOf, own, type ItemMaster, type Masters } from './masters.ts';
import { observe } from './quantity.ts';
import { checkDate, type Need, type NeedQuantity, type Supply } from './supply.ts';
import { captureItemLabels } from './history-labels.ts';
import { supplyEventItemIds } from './history-targets.ts';

export const needRowMaxBytes = 65536;
export type NeedRow = {
  format: 'fuzzy-stock-need-row'; version: 1;
  source: string | null; line: string | null; revision: string | null; previousRevision: string | null;
  caseCode: string | null; itemCode: string | null; unit: string; required: NeedQuantity; dueDate: string | null;
};
export type NeedImportInput = { raw: string; row: NeedRow };
type Held = { kind: 'hold'; reasons: string[]; candidates: string[] };
type Applied = { kind: 'create'; before: null; after: Need } | { kind: 'revise' | 'unchanged'; before: Need; after: Need };
type Decision = Held | { kind: 'create'; before: null; after: Omit<Need, 'id'> } | Exclude<Applied, { kind: 'create' }>;
export type NeedImportDetail =
  | { kind: 'needImport'; input: NeedImportInput; decision: Held | Applied }
  | { kind: 'needImportResolve'; importEventId: string; reason: string; resolution: { kind: 'dismiss' } | { kind: 'apply'; before: Need; after: Need } };
export type HeldNeedImport = Meta & { kind: 'needImport'; input: NeedImportInput; decision: Held };
export type NeedImportPreview = { input: NeedImportInput; decision: Decision; token: string };
type AppliedImport = { eventId: string; input: NeedImportInput; after: Need };

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw Error('架空文書は一明細のオブジェクトで指定する');
  return Object.fromEntries(Object.entries(value));
}

function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).sort().join() !== [...expected].sort().join()) throw Error('架空文書の属性が不足している、または未対応の属性がある');
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 512) throw Error(`${label}は512文字以内の文字列で指定する`);
  return value;
}

function optionalText(value: unknown, label: string): string | null {
  return value === null ? null : text(value, label);
}

export function readNeedRow(raw: string): NeedRow {
  if (new TextEncoder().encode(raw).length > needRowMaxBytes) throw Error('架空文書の上限は64KiB');
  const value: unknown = parseExactJson(raw.startsWith('\uFEFF') ? raw.slice(1) : raw);
  const o = object(value);
  keys(o, ['format', 'version', 'source', 'line', 'revision', 'previousRevision', 'caseCode', 'itemCode', 'unit', 'required', 'dueDate']);
  if (o.format !== 'fuzzy-stock-need-row' || o.version !== 1) throw Error('未対応の文書形式。架空の1明細文書を選ぶ');
  const q = object(o.required);
  keys(q, ['basis', 'value']);
  if (q.basis !== 'counted' && q.basis !== 'label' && q.basis !== 'approximate' && q.basis !== 'unknown') throw Error('数量の根拠が不正');
  if (q.value !== null && typeof q.value !== 'number') throw Error('必要な数は数値またはnullで指定する');
  // 品目・単位の解決前なので、ここでは表現できる最大の範囲だけを検査する。精度は解決後に検査する。
  observe('need-import', q.basis, q.value, q.value !== null && !Number.isInteger(q.value) ? 0.1 : 1);
  const dueDate = optionalText(o.dueDate, '必要日');
  if (dueDate !== null) checkDate(dueDate, '必要日');
  return {
    format: 'fuzzy-stock-need-row', version: 1,
    source: optionalText(o.source, '元の資料'), line: optionalText(o.line, '明細'), revision: optionalText(o.revision, '改訂'), previousRevision: optionalText(o.previousRevision, '改訂前'),
    caseCode: optionalText(o.caseCode, '案件・用途'), itemCode: optionalText(o.itemCode, '品目'), unit: text(o.unit, '単位'), required: { basis: q.basis, value: q.value }, dueDate,
  };
}

const present = (value: string | null): value is string => value !== null && value.trim() !== '';
const sameIdentity = (a: NeedRow, b: NeedRow): boolean => a.source === b.source && a.line === b.line;
const sameGroup = (a: Need, b: Omit<Need, 'id'>): boolean => a.project.id === b.project.id && a.item === b.item && a.unit === b.unit;
export const sameNeed = (a: Need, b: Need): boolean => a.id === b.id && sameGroup(a, b) && a.required.basis === b.required.basis && a.required.value === b.required.value && a.dueDate === b.dueDate && a.source === b.source && a.revision === b.revision;
const sameRow = (a: NeedRow, b: NeedRow): boolean => JSON.stringify(a) === JSON.stringify(b);

function appliedImports(supply: Supply): AppliedImport[] {
  const held = new Map<string, NeedImportInput>();
  const result: AppliedImport[] = [];
  for (const e of supply.log) {
    if (e.kind === 'needImport') {
      if (e.decision.kind === 'hold') held.set(e.eventId, e.input);
      else result.push({ eventId: e.eventId, input: e.input, after: e.decision.after });
    } else if (e.kind === 'needImportResolve' && e.resolution.kind === 'apply') {
      const input = held.get(e.importEventId);
      if (!input) throw Error('取込の元保留がない');
      result.push({ eventId: e.eventId, input, after: e.resolution.after });
    }
  }
  return result;
}

function latestNeedEvent(supply: Supply, id: string): string | null {
  return supply.log.findLast(e =>
    (e.kind === 'needRegister' && e.need.id === id) || (e.kind === 'needRevise' && e.after.id === id) ||
    (e.kind === 'needImport' && e.decision.kind !== 'hold' && e.decision.after.id === id) ||
    (e.kind === 'needImportResolve' && e.resolution.kind === 'apply' && e.resolution.after.id === id))?.eventId ?? null;
}

function context(supply: Supply, masters: Masters, row: NeedRow) {
  const project = present(row.caseCode) ? Object.values(masters.cases).find(m => m.code === row.caseCode) : undefined;
  const item = present(row.itemCode) ? Object.values(masters.items).find(m => m.code === row.itemCode) : undefined;
  const imports = appliedImports(supply);
  const bindings = imports.filter(e => sameIdentity(e.input.row, row));
  const last = bindings.at(-1);
  const groupNeeds = Object.values(supply.needs).filter(n => n.project.id === project?.id && n.item === item?.id && n.unit === row.unit);
  const ids = [...new Set([...groupNeeds.map(n => n.id), ...(last ? [last.after.id] : [])])];
  // 履歴は追記のみ。最後の関連操作を識別し、各確認へ過去の原文を複製しない。
  const relatedEvent = imports.findLast(e => ids.includes(e.after.id) || sameIdentity(e.input.row, row))?.eventId ?? null;
  const candidates = ids.map(id => ({ id, need: own(supply.needs, id), lastEvent: latestNeedEvent(supply, id) }));
  const token = JSON.stringify({ row, project, item, relatedEvent, candidates });
  return { project, item, imports, bindings, last, groupNeeds, candidates, token };
}

// 精度を特定できない文脈の小数は、保留にも残さず無変更で拒否する（入力を直して取り込み直す）。
function checkRowPrecision(masters: Masters, row: NeedRow, item: ItemMaster | undefined): void {
  const value = row.required.value;
  if (value === null) return;
  if (item === undefined || !item.units.includes(row.unit)) {
    if (!Number.isInteger(value)) throw Error('品目・単位を確認できないので、小数の必要な数は取り込まない。品目コードと単位を確認する');
    return;
  }
  observe('need-import', row.required.basis, value, inputStepOf(masters, item.id, row.unit, value));
}

function draftFor(row: NeedRow, c: ReturnType<typeof context>): Omit<Need, 'id'> | null {
  if (!present(row.source) || !present(row.line) || !present(row.revision) || !c.project?.active || !c.item?.active || !c.item.units.includes(row.unit)) return null;
  return { project: { kind: 'case', id: c.project.id }, item: c.item.id, unit: row.unit, required: row.required, dueDate: row.dueDate, source: row.source, revision: row.revision };
}

function decide(supply: Supply, row: NeedRow, c: ReturnType<typeof context>): Decision {
  const reasons: string[] = [];
  if (!present(row.source) || !present(row.line) || !present(row.revision)) reasons.push('元の資料・明細識別・改訂を確認できない');
  if (!c.project?.active) reasons.push('案件・用途が未登録または利用停止');
  if (!c.item?.active) reasons.push('品目が未登録または利用停止');
  if (c.item && !c.item.units.includes(row.unit)) reasons.push('品目の単位が一致しない');
  const hold = (): Held => ({ kind: 'hold', reasons, candidates: c.candidates.map(n => n.id) });
  const draft = draftFor(row, c);
  if (!draft) return hold();
  if (!c.last) {
    if (c.groupNeeds.length > 0) { reasons.push('同じ組の必要明細との対応が未確認'); return hold(); }
    return { kind: 'create', before: null, after: draft };
  }
  const before = own(supply.needs, c.last.after.id);
  if (!before || !sameGroup(before, draft)) { reasons.push('対応先の案件・用途・品目・単位が一致しない'); return hold(); }
  if (!sameNeed(before, c.last.after) || latestNeedEvent(supply, before.id) !== c.last.eventId) { reasons.push('取込後の手動変更との照合が必要'); return hold(); }
  const after: Need = { ...draft, id: before.id };
  if (row.revision === c.last.input.row.revision && sameRow(row, c.last.input.row)) return { kind: 'unchanged', before, after: before };
  if (c.bindings.some(e => e.input.row.revision === row.revision)) { reasons.push('同じ改訂の内容相違、または過去の改訂の再利用'); return hold(); }
  if (row.previousRevision !== before.revision) { reasons.push('改訂前の識別が現在の改訂と一致しない'); return hold(); }
  return { kind: 'revise', before, after };
}

export function previewNeedImport(supply: Supply, masters: Masters, raw: string): NeedImportPreview {
  const row = readNeedRow(raw), c = context(supply, masters, row);
  checkRowPrecision(masters, row, c.item);
  return { input: { raw, row }, decision: decide(supply, row, c), token: JSON.stringify([raw, c.token]) };
}

function recordImport(supply: Supply, masters: Masters, meta: Meta, detail: NeedImportDetail, after: Need | null): Supply {
  if (!meta.eventId.trim() || supply.log.some(e => e.eventId === meta.eventId)) throw Error('取込の操作IDが空、または使用済み');
  checkTime(meta.occurredAt, '発生'); checkTime(meta.recordedAt, '記録');
  const state = { ...supply, needs: after === null ? supply.needs : { ...supply.needs, [after.id]: after } }, event = { ...meta, ...detail };
  const itemLabels = captureItemLabels(masters, supplyEventItemIds(event, { ledger: null, supply: state }));
  return deepFreeze({ ...state, log: [...supply.log, { ...event, itemLabels }] });
}

export function applyNeedImport(supply: Supply, masters: Masters, meta: Meta, raw: string, token: string): Supply {
  const preview = previewNeedImport(supply, masters, raw);
  if (token !== preview.token) throw Error('確認後に取込内容または対象が変わった。差分を再確認する');
  const d = preview.decision;
  const decision: Held | Applied = d.kind === 'create' ? { kind: 'create', before: null, after: { ...d.after, id: meta.eventId } } : d;
  return recordImport(supply, masters, meta, { kind: 'needImport', input: preview.input, decision }, decision.kind === 'hold' || decision.kind === 'unchanged' ? null : decision.after);
}

export function openNeedImports(supply: Supply): HeldNeedImport[] {
  const resolved = new Set(supply.log.filter(e => e.kind === 'needImportResolve').map(e => e.importEventId));
  const result: HeldNeedImport[] = [];
  for (const e of supply.log) if (e.kind === 'needImport' && e.decision.kind === 'hold' && !resolved.has(e.eventId)) result.push({ ...e, decision: e.decision });
  return result;
}

export type NeedImportResolutionPreview = { held: HeldNeedImport; resolution: { kind: 'dismiss' } | { kind: 'apply'; before: Need; after: Need }; token: string };

export function previewNeedImportResolution(supply: Supply, masters: Masters, importEventId: string, action: 'apply' | 'dismiss', needId: string): NeedImportResolutionPreview {
  const held = openNeedImports(supply).find(e => e.eventId === importEventId);
  if (!held) throw Error('未解消の取込保留を選ぶ');
  if (action === 'dismiss') return { held, resolution: { kind: 'dismiss' }, token: JSON.stringify([held, 'dismiss']) };
  const c = context(supply, masters, held.input.row), draft = draftFor(held.input.row, c), before = own(supply.needs, needId);
  checkRowPrecision(masters, held.input.row, c.item);
  if (!draft) throw Error('識別情報と利用中の案件・用途・品目・単位を確認できない。文書を修正して再確認する');
  if (!before || !sameGroup(before, draft)) throw Error('同じ案件・用途・品目・単位の既存明細を選ぶ');
  if (c.imports.some(e => (sameIdentity(e.input.row, held.input.row) && e.after.id !== needId) || (e.after.id === needId && !sameIdentity(e.input.row, held.input.row)))) throw Error('確定済みの対応は変更できない');
  return { held, resolution: { kind: 'apply', before, after: { ...draft, id: needId } }, token: JSON.stringify([held, 'apply', needId, c.token]) };
}

export function resolveNeedImport(supply: Supply, masters: Masters, meta: Meta, importEventId: string, action: 'apply' | 'dismiss', needId: string, reason: string, token: string): Supply {
  if (!reason.trim()) throw Error('照合の理由を入力する');
  const preview = previewNeedImportResolution(supply, masters, importEventId, action, needId);
  if (preview.token !== token) throw Error('確認後に照合対象が変わった。前後の差分を再確認する');
  return recordImport(supply, masters, meta, { kind: 'needImportResolve', importEventId, reason, resolution: preview.resolution }, preview.resolution.kind === 'apply' ? preview.resolution.after : null);
}

function validateImportedValue(input: NeedImportInput, after: Need): void {
  const r = input.row;
  if (!present(r.source) || !present(r.line) || !present(r.revision) || !present(r.caseCode) || !present(r.itemCode) || !present(r.unit)) throw Error('適用した取込の識別情報が不完全');
  if (after.source !== r.source || after.revision !== r.revision || after.unit !== r.unit || after.required.basis !== r.required.basis || after.required.value !== r.required.value || after.dueDate !== r.dueDate) throw Error('取込原文と必要明細の適用値が一致しない');
}

// 取込に関わる必要明細だけを検査する。現物や依頼の履歴から数量を再計算しない。
export function validateNeedImports(supply: Supply, masters: Masters): void {
  if (!supply.log.some(e => e.kind === 'needImport' || e.kind === 'needImportResolve')) return;
  const needs = new Map<string, Need>(), latest = new Map<string, string>();
  const held = new Map<string, HeldNeedImport>(), resolved = new Set<string>(), touched = new Set<string>(), events = new Set<string>();
  const bindings = new Map<string, AppliedImport>(), owners = new Map<string, string>(), revisions = new Map<string, Set<string>>();
  const remember = (need: Need, eventId: string) => { needs.set(need.id, need); latest.set(need.id, eventId); };
  const accept = (input: NeedImportInput, before: Need | null, after: Need, eventId: string, action: 'create' | 'revise' | 'unchanged' | 'resolve') => {
    validateImportedValue(input, after);
    if (!own(masters.items, after.item) || !own(masters.cases, after.project.id)) throw Error('取込明細の内部参照に対応する登録情報がない');
    observe('need-import', after.required.basis, after.required.value, inputStepOf(masters, after.item, after.unit, after.required.value));
    const key = JSON.stringify([input.row.source, input.row.line]), bound = bindings.get(key), current = needs.get(after.id);
    const owner = owners.get(after.id);
    if ((bound && bound.after.id !== after.id) || (owner !== undefined && owner !== key)) throw Error('取込と必要明細の対応が一対一でない');
    if (before === null) {
      if (after.id !== eventId || current || [...needs.values()].some(n => sameGroup(n, after))) throw Error('取込による明細追加が重複している');
    } else if (!current || !sameNeed(before, current) || !sameGroup(before, after) || before.id !== after.id) throw Error('取込の改訂前と既存明細が一致しない');
    if (action === 'revise' || action === 'unchanged') {
      if (!bound || !current || latest.get(after.id) !== bound.eventId || !sameNeed(current, bound.after)) throw Error('取込後の変更を未照合で改訂している');
      if (action === 'unchanged' && (!sameRow(input.row, bound.input.row) || !sameNeed(current, after))) throw Error('取込済み判定の内容が異なる');
      if (action === 'revise' && (input.row.previousRevision !== current.revision || revisions.get(key)?.has(after.revision))) throw Error('取込の改訂順が不正');
    }
    bindings.set(key, { input, after, eventId }); owners.set(after.id, key);
    const seen = revisions.get(key) ?? new Set<string>(); seen.add(after.revision); revisions.set(key, seen);
    touched.add(after.id); remember(after, eventId);
  };
  for (const e of supply.log) {
    if (!e.eventId.trim() || events.has(e.eventId)) throw Error('取込履歴の操作IDが空、または重複');
    events.add(e.eventId);
    if (e.kind === 'needRegister') remember(e.need, e.eventId);
    else if (e.kind === 'needRevise') {
      const current = needs.get(e.before.id);
      if (touched.has(e.before.id) && (!current || !sameNeed(current, e.before) || e.before.id !== e.after.id || !sameGroup(e.before, e.after))) throw Error('取込後の手動改訂の対応が不正');
      remember(e.after, e.eventId);
    } else if (e.kind === 'needImport') {
      if (e.decision.kind === 'hold') {
        if (!e.decision.reasons.length || e.decision.reasons.some(r => !r.trim()) || e.decision.candidates.some(id => !needs.has(id))) throw Error('取込保留の理由または関連明細が不正');
        for (const id of e.decision.candidates) touched.add(id);
        held.set(e.eventId, { ...e, decision: e.decision });
      } else accept(e.input, e.decision.before, e.decision.after, e.eventId, e.decision.kind);
    } else if (e.kind === 'needImportResolve') {
      const original = held.get(e.importEventId);
      if (!original || resolved.has(e.importEventId) || !e.reason.trim()) throw Error('取込の保留参照・解消・理由が不正');
      resolved.add(e.importEventId);
      if (e.resolution.kind === 'apply') accept(original.input, e.resolution.before, e.resolution.after, e.eventId, 'resolve');
    }
  }
  for (const id of touched) {
    const current = own(supply.needs, id), expected = needs.get(id);
    if (!current || !expected || !sameNeed(current, expected)) throw Error('取込履歴と必要明細の現在値が一致しない');
    if (Object.entries(supply.needs).some(([key, n]) => n.id === id && key !== id)) throw Error('取込した必要明細の内部IDと辞書の識別が一致しない');
    if (Object.values(supply.needs).some(n => n.id !== id && sameGroup(n, current))) throw Error('取込した必要明細の組が重複している');
  }
}
