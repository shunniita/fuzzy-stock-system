import type { Need } from '../domain/supply.ts';
import type { ReceiptTemplate } from '../domain/receipt-template.ts';
import type { TemplateNeedChange, TemplateNeedDetail, TemplateNeedPlan, TemplateNeedPlanHeader, TemplateNeedVersion } from '../domain/template-needs.ts';
import type { TemplateNeedGroup } from '../domain/template-needs-group.ts';

type Decoder<T> = (value: unknown, path: string) => T;
function invalid(path: string): never { throw new Error(`${path}: 生成した必要明細の構造が不正`); }
function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid(path);
  return Object.fromEntries(Object.entries(value));
}
function keys(value: Record<string, unknown>, expected: readonly string[], path: string): void {
  if (Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) invalid(path);
}
function text(value: unknown, path: string): string { return typeof value === 'string' && value.trim() ? value : invalid(path); }
function entries<T>(value: unknown, path: string, decode: Decoder<T>, max: number): T[] {
  if (!Array.isArray(value) || value.length > max) return invalid(path);
  const items: unknown[] = value;
  return items.map((item, index) => decode(item, `${path}[${index}]`));
}
function single<T>(value: unknown, path: string, decode: Decoder<T>): [T] {
  const [first] = entries(value, path, decode, 1);
  return first === undefined ? invalid(path) : [first];
}

const planHeaderKeys = ['project', 'generationId', 'initialVersion', 'version', 'count'];
function planHeader(o: Record<string, unknown>, path: string): TemplateNeedPlanHeader {
  if (typeof o.count !== 'number' || !Number.isSafeInteger(o.count) || o.count <= 0) return invalid(`${path}.count`);
  return { project: text(o.project, `${path}.project`), generationId: text(o.generationId, `${path}.generationId`), initialVersion: text(o.initialVersion, `${path}.initialVersion`), version: text(o.version, `${path}.version`), count: o.count };
}
function parsePlanHeader(value: unknown, path: string): TemplateNeedPlanHeader {
  const o = object(value, path); keys(o, planHeaderKeys, path);
  return planHeader(o, path);
}
export function parseTemplateNeedPlan(value: unknown, path: string): TemplateNeedPlan {
  const o = object(value, path);
  keys(o, [...planHeaderKeys, 'origins'], path);
  return { ...planHeader(o, path),
    origins: entries(o.origins, `${path}.origins`, (value, path) => {
      const origin = object(value, path);
      const hasExclusion = Object.hasOwn(origin, 'excluded');
      keys(origin, ['needId', 'item', 'unit', 'origin', ...(hasExclusion ? ['excluded'] : [])], path);
      if (origin.origin !== 'template' && origin.origin !== 'custom') return invalid(`${path}.origin`);
      if (hasExclusion && origin.excluded !== true) return invalid(`${path}.excluded`);
      return { needId: text(origin.needId, `${path}.needId`), item: text(origin.item, `${path}.item`), unit: text(origin.unit, `${path}.unit`), origin: origin.origin, ...(hasExclusion ? { excluded: true as const } : {}) };
    }, 1000) };
}

export function parseTemplateNeed(value: unknown, path: string, decode: Decoder<Need>): Need {
  const o = object(value, path);
  keys(o, ['id', 'project', 'item', 'unit', 'required', 'dueDate', 'source', 'revision'], path);
  keys(object(o.project, `${path}.project`), ['kind', 'id'], `${path}.project`);
  keys(object(o.required, `${path}.required`), ['basis', 'value'], `${path}.required`);
  return decode(value, path);
}

function generationGroup(value: unknown, path: string): TemplateNeedGroup | null {
  if (value === null) return null;
  const o = object(value, path); keys(o, ['assemblyIndex', 'mode', 'split'], path);
  if (o.assemblyIndex !== 0) return invalid(path);
  if (o.mode === 'same' && o.split === null) return { assemblyIndex: 0, mode: 'same', split: null };
  if (o.mode === 'split' && typeof o.split === 'number' && Number.isSafeInteger(o.split) && o.split > 0) return { assemblyIndex: 0, mode: 'split', split: o.split };
  return invalid(path);
}

// Needとセットの既存decoderを共用し、新しい計画・イベントのkey検査だけをここで所有する。
export function parseTemplateNeedDetail(value: unknown, path: string, metaKeys: readonly string[], decodeNeed: Decoder<Need>, decodeTemplate: Decoder<ReceiptTemplate>): TemplateNeedDetail {
  const o = object(value, path);
  const change: Decoder<TemplateNeedChange> = (value, path) => {
    const o = object(value, path); keys(o, ['before', 'after'], path);
    return { before: o.before === null ? null : parseTemplateNeed(o.before, `${path}.before`, decodeNeed), after: parseTemplateNeed(o.after, `${path}.after`, decodeNeed) };
  };
  const version: Decoder<TemplateNeedVersion> = (value, path) => {
    const o = object(value, path); keys(o, ['id', 'template'], path);
    return { id: text(o.id, `${path}.id`), template: decodeTemplate(o.template, `${path}.template`) };
  };
  if (o.action === 'edit') {
    const hasFormat = Object.hasOwn(o, 'planFormat');
    keys(o, [...metaKeys, 'action', 'editKind', 'reason', 'plansBefore', 'plansAfter', 'changes', ...(hasFormat ? ['planFormat'] : [])], path);
    if (o.editKind !== 'change' && o.editKind !== 'add' && o.editKind !== 'exclude') return invalid(`${path}.editKind`);
    if (hasFormat) {
      if (o.planFormat !== 'delta') return invalid(`${path}.planFormat`);
      return { kind: 'templateNeeds', action: 'edit', planFormat: 'delta', editKind: o.editKind, reason: text(o.reason, `${path}.reason`),
        plansBefore: single(o.plansBefore, `${path}.plansBefore`, parsePlanHeader), plansAfter: single(o.plansAfter, `${path}.plansAfter`, parsePlanHeader), changes: single(o.changes, `${path}.changes`, change) };
    }
    return { kind: 'templateNeeds', action: 'edit', editKind: o.editKind, reason: text(o.reason, `${path}.reason`),
      plansBefore: single(o.plansBefore, `${path}.plansBefore`, parseTemplateNeedPlan), plansAfter: single(o.plansAfter, `${path}.plansAfter`, parseTemplateNeedPlan), changes: single(o.changes, `${path}.changes`, change) };
  }
  if (o.action === 'recalculate' || o.action === 'follow') {
    const hasPolicy = Object.hasOwn(o, 'calculationPolicy');
    keys(o, [...metaKeys, 'action', 'reason', 'selected', 'plansBefore', 'plansAfter', 'changes', ...(o.action === 'follow' ? ['targetVersion', 'versions'] : []), ...(hasPolicy ? ['calculationPolicy'] : [])], path);
    if (hasPolicy && o.calculationPolicy !== 'preserve-basis' && o.calculationPolicy !== 'preserve-exclusion') return invalid(`${path}.calculationPolicy`);
    const policy: { calculationPolicy?: 'preserve-basis' | 'preserve-exclusion' } = o.calculationPolicy === 'preserve-basis' || o.calculationPolicy === 'preserve-exclusion' ? { calculationPolicy: o.calculationPolicy } : {};
    const common = { ...policy, selected: entries(o.selected, `${path}.selected`, text, 1000), plansBefore: single(o.plansBefore, `${path}.plansBefore`, parseTemplateNeedPlan), plansAfter: single(o.plansAfter, `${path}.plansAfter`, parseTemplateNeedPlan), changes: entries(o.changes, `${path}.changes`, change, 1000) };
    if (o.action === 'recalculate') return { kind: 'templateNeeds', action: 'recalculate', reason: text(o.reason, `${path}.reason`), ...common };
    if (o.reason !== 'セットの最新版に追従') return invalid(`${path}.reason`);
    return { kind: 'templateNeeds', action: 'follow', reason: o.reason, targetVersion: text(o.targetVersion, `${path}.targetVersion`), versions: entries(o.versions, `${path}.versions`, version, 1), ...common };
  }
  keys(o, [...metaKeys, 'action', 'versions', 'plansBefore', 'plansAfter', 'changes', 'group'], path);
  if (o.action !== 'generate') return invalid(path);
  return { kind: 'templateNeeds', action: 'generate', group: generationGroup(o.group, `${path}.group`),
    versions: entries(o.versions, `${path}.versions`, version, 20),
    plansBefore: entries(o.plansBefore, `${path}.plansBefore`, (value, path) => value === null ? null : invalid(path), 20),
    plansAfter: entries(o.plansAfter, `${path}.plansAfter`, parseTemplateNeedPlan, 20),
    changes: entries(o.changes, `${path}.changes`, change, 1000) };
}
