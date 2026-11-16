import { own, quantityStepOf, type Masters } from './masters.ts';
import { addScalar, multiplyScalarByInteger, subtractScalar } from './scalar.ts';
import type { Ledger } from './ledger.ts';
import { shortageOf } from './shortage.ts';
import type { ReceiptTemplate } from './receipt-template.ts';
import type { Need, Supply, SupplyEvent } from './supply.ts';
import type { TemplateNeedChange, TemplateNeedContext, TemplateNeedGenerationRow, TemplateNeedPlan, TemplateNeedVersion } from './template-needs.ts';

const itemKey = (item: string, unit: string): string => JSON.stringify([item, unit]);

// 版の最上位行だけを合算する。現在の利用停止は、この計算ではなく操作の入口で扱う。
export function templateNeedRows(template: ReceiptTemplate, masters: Masters, count: number): TemplateNeedGenerationRow[] {
  const groups = new Map<string, { item: string; unit: string; perSet: number; sourceRows: number[] }>();
  for (const [index, row] of template.rows.entries()) {
    const key = itemKey(row.item, row.unit), previous = groups.get(key);
    if (previous) { previous.perSet = addScalar(previous.perSet, row.perSet, quantityStepOf(masters, row.item, row.unit)); previous.sourceRows.push(index + 1); }
    else groups.set(key, { item: row.item, unit: row.unit, perSet: row.perSet, sourceRows: [index + 1] });
  }
  return [...groups.values()].map(row => ({ ...row, required: multiplyScalarByInteger(row.perSet, count, quantityStepOf(masters, row.item, row.unit)) }));
}

function templateNeedStandard(masters: Masters, plan: TemplateNeedPlan, version: TemplateNeedVersion, item: string, unit: string): number {
  return templateNeedRows(version.template, masters, plan.count).find(row => row.item === item && row.unit === unit)?.required ?? 0;
}

export type TemplateNeedCalculationPolicy = 'legacy-numeric' | 'preserve-basis' | 'preserve-exclusion';

export function templateNeedModified(need: Need, standard: number | null, policy: TemplateNeedCalculationPolicy): boolean {
  return standard !== null && (need.required.basis === 'unknown' || need.required.value !== standard || (policy !== 'legacy-numeric' && need.required.basis !== 'label'));
}

// 旧履歴は書き換えず、除外後の明示変更・標準選択・旧方式による復帰までをたどる。
export function templateNeedExcludedIds(log: readonly SupplyEvent[], project: string, beforeEventId?: string): ReadonlySet<string> {
  const excluded = new Set<string>();
  for (const event of log) {
    if (event.eventId === beforeEventId) break;
    if (event.kind !== 'templateNeeds') continue;
    if (event.action === 'recalculate' || event.action === 'follow') for (const id of event.selected) excluded.delete(id);
    for (const { before, after } of event.changes) {
      if (after.project.id !== project) continue;
      if (event.action === 'edit' && event.editKind === 'exclude') excluded.add(after.id);
      else if (event.action === 'edit' && event.editKind === 'change' && before !== null && (before.required.basis !== after.required.basis || before.required.value !== after.required.value)) excluded.delete(after.id);
      else if (after.required.basis !== 'label' || after.required.value !== 0) excluded.delete(after.id);
    }
  }
  return excluded;
}

export function templateNeedInfo(masters: Masters, context: TemplateNeedContext, need: Need) {
  const plan = own(context.plans, need.project.id);
  if (!plan) return null;
  const origin = plan.origins.find(row => row.needId === need.id), version = own(context.versions, plan.version);
  if (!origin || !version) throw new Error('必要明細の生成元を確認できない');
  const rows = version.template.rows.flatMap((row, index) => row.item === need.item && row.unit === need.unit ? [index + 1] : []);
  const standard = origin.origin === 'template' ? templateNeedStandard(masters, plan, version, need.item, need.unit) : null;
  return { origin: origin.origin, standard, modified: origin.excluded === true || templateNeedModified(need, standard, 'preserve-basis'), rows, plan, version };
}

// 使用可能数は使用済みを差し引いた現物。変更後の必要数だけを差し替える。
export function templateNeedSurplus(ledger: Ledger, supply: Supply, need: Need) {
  const view = shortageOf(ledger, { ...supply, needs: { ...supply.needs, [need.id]: need } }, need), { required, used, usable } = view.aux;
  const judgement = view.judgement;
  if (judgement.kind === 'undecidable' || required === null || used === null || usable === null) return { value: null, judgement };
  const step = quantityStepOf(ledger.masters, need.item, need.unit);
  return { value: Math.max(0, subtractScalar(usable, Math.max(0, subtractScalar(required, used, step)), step)), judgement };
}

export type TemplateNeedUpdateRow = {
  key: string; item: string; unit: string; before: Need | null; after: Need;
  oldStandard: number | null; newStandard: number | null;
  manual: boolean; selectable: boolean; selected: boolean; added: boolean; removed: boolean; collision: boolean;
  originBefore: 'template' | 'custom' | null; originAfter: 'template' | 'custom';
};
type Operation = { action: 'recalculate'; count: number } | { action: 'follow'; target: TemplateNeedVersion };
type CalculationInput = { masters: Masters; plan: TemplateNeedPlan; baseline: TemplateNeedVersion; needs: ReadonlyMap<string, Need>; eventId: string; selected: readonly string[]; operation: Operation; policy: TemplateNeedCalculationPolicy; excluded: ReadonlySet<string> };

export function calculateTemplateNeedUpdate(input: CalculationInput): { plan: TemplateNeedPlan; changes: TemplateNeedChange[]; rows: TemplateNeedUpdateRow[] } {
  const { masters, plan, baseline, needs, eventId, selected, operation } = input;
  const count = operation.action === 'recalculate' ? operation.count : plan.count, target = operation.action === 'follow' ? operation.target : baseline;
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error('台数は正の安全な整数にする');
  const oldRows = new Map(templateNeedRows(baseline.template, masters, plan.count).map(row => [itemKey(row.item, row.unit), row]));
  const newRows = new Map(templateNeedRows(target.template, masters, count).map(row => [itemKey(row.item, row.unit), row]));
  const selectedSet = new Set(selected), rows: TemplateNeedUpdateRow[] = [], origins = [...plan.origins];
  if (selectedSet.size !== selected.length) throw new Error('選択した明細が重複している');
  for (const origin of plan.origins) {
    const before = needs.get(origin.needId);
    if (!before || before.project.id !== plan.project || before.item !== origin.item || before.unit !== origin.unit) throw new Error('計画に対応する必要明細がない');
    const key = itemKey(origin.item, origin.unit), next = newRows.get(key), template = origin.origin === 'template';
    const oldStandard = template ? oldRows.get(key)?.required ?? 0 : null;
    const collision = !template && operation.action === 'follow' && next !== undefined;
    const excluded = input.policy === 'preserve-exclusion' && (origin.excluded === true || input.excluded.has(before.id));
    const manual = excluded || templateNeedModified(before, oldStandard, input.policy);
    const selectable = manual || collision, chosen = selectedSet.has(before.id);
    if (chosen && !selectable) throw new Error(`必要明細 ${before.id} は選択による適用の対象ではない`);
    const apply = template ? !manual || chosen : collision && chosen;
    const standard = next?.required ?? 0, newStandard = template || collision ? standard : null;
    const after: Need = apply ? { ...before, required: { basis: 'label', value: standard }, source: target.template.name, revision: target.id } : before;
    rows.push({ key: before.id, item: before.item, unit: before.unit, before, after, oldStandard, newStandard, manual, selectable, selected: chosen, added: false, removed: template && next === undefined, collision, originBefore: origin.origin, originAfter: collision && chosen ? 'template' : origin.origin });
    newRows.delete(key);
  }
  const dueDate = plan.origins.find(origin => origin.origin === 'template');
  let added = 0;
  for (const row of newRows.values()) {
    const id = `${eventId}-n${++added}`;
    if (needs.has(id)) throw new Error(`必要明細ID ${id} は使用済み`);
    const after: Need = { id, project: { kind: 'case', id: plan.project }, item: row.item, unit: row.unit, required: { basis: 'label', value: row.required }, dueDate: dueDate ? needs.get(dueDate.needId)?.dueDate ?? null : null, source: target.template.name, revision: target.id };
    rows.push({ key: `new:${itemKey(row.item, row.unit)}`, item: row.item, unit: row.unit, before: null, after, oldStandard: 0, newStandard: row.required, manual: false, selectable: false, selected: false, added: true, removed: false, collision: false, originBefore: null, originAfter: 'template' });
  }
  if (selected.some(key => !rows.some(row => row.key === key && row.selectable))) throw new Error('選択した必要明細が対象にない');
  if (rows.length > 1000) throw new Error('案件の必要明細は保持分も含め1,000件以下にする');
  for (const [index, row] of rows.entries()) {
    const excluded = input.policy === 'preserve-exclusion' && !row.selected && (plan.origins[index]?.excluded === true || input.excluded.has(row.after.id));
    origins[index] = { needId: row.after.id, item: row.item, unit: row.unit, origin: row.originAfter, ...(excluded ? { excluded: true as const } : {}) };
  }
  const changes = rows.filter(row => row.before === null || row.before.required.basis !== row.after.required.basis || row.before.required.value !== row.after.required.value || row.before.source !== row.after.source || row.before.revision !== row.after.revision).map(row => ({ before: row.before, after: row.after }));
  return { plan: { ...plan, count, version: target.id, origins }, changes, rows };
}
