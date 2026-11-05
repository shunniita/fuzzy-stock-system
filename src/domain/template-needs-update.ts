import { normalizeAssemblyRecipe } from './assembly-recipes.ts';
import { checkTime, deepFreeze, type Ledger, type Meta } from './ledger.ts';
import { own } from './masters.ts';
import { recipeVersion, validateReceiptTemplates } from './receipt-template.ts';
import { recordTemplateNeeds, type Supply } from './supply.ts';
import { calculateTemplateNeedUpdate, templateNeedExcludedIds, templateNeedRows } from './template-needs-calculation.ts';
import { relatedTemplateNeedCounts, templateNeedContextOf } from './template-needs-context.ts';
import type { TemplateNeedFollowDetail, TemplateNeedRecalculateDetail, TemplateNeedVersion } from './template-needs.ts';

type State = { ledger: Ledger; supply: Supply };

function updateContext(state: State, meta: Meta, project: string) {
  checkTime(meta.occurredAt, '発生'); checkTime(meta.recordedAt, '記録');
  if (state.supply.log.some(event => event.eventId === meta.eventId) || state.ledger.history.some(event => event.eventId === meta.eventId)) throw new Error(`操作ID ${meta.eventId} は使用済み`);
  const context = templateNeedContextOf(state.supply), plan = own(context.plans, project);
  if (!plan) throw new Error('生成した必要明細を持つ案件を選ぶ');
  const baseline = own(context.versions, plan.version);
  if (!baseline) throw new Error('案件の計算基準の版がない');
  return { context, plan, baseline, needs: new Map(Object.entries(state.supply.needs)), excluded: templateNeedExcludedIds(state.supply.log, project) };
}

function checkMaterialSize(event: Meta & (TemplateNeedRecalculateDetail | TemplateNeedFollowDetail)): void {
  if (new TextEncoder().encode(JSON.stringify(event)).byteLength > 1024 * 1024) throw new Error('必要明細のイベントが1MiBを超える。入力を分けて記録する');
}

export function buildTemplateNeedRecalculation(state: State, meta: Meta, project: string, count: number, selected: readonly string[], reason: string) {
  if (!reason.trim()) throw new Error('台数変更の理由を入力する');
  const { plan, baseline, needs, excluded } = updateContext(state, meta, project);
  if (count === plan.count) throw new Error('台数が変わっていない');
  const result = calculateTemplateNeedUpdate({ masters: state.ledger.masters, plan, baseline, needs, eventId: meta.eventId, selected, operation: { action: 'recalculate', count }, policy: 'preserve-exclusion', excluded });
  const event: Meta & TemplateNeedRecalculateDetail = { ...meta, kind: 'templateNeeds', action: 'recalculate', calculationPolicy: 'preserve-exclusion', reason, selected: [...selected], plansBefore: [plan], plansAfter: [result.plan], changes: result.changes };
  checkMaterialSize(event);
  return deepFreeze({ ...result, event, version: baseline, applicable: true, relatedCounts: relatedTemplateNeedCounts(state.supply, result.plan) });
}

export function recalculateTemplateNeeds(state: State, meta: Meta, project: string, count: number, selected: readonly string[], reason: string): State {
  const result = buildTemplateNeedRecalculation(state, meta, project, count, selected, reason);
  return { ledger: state.ledger, supply: recordTemplateNeeds(state.ledger, state.supply, meta, result.event) };
}

export function buildTemplateNeedFollow(state: State, meta: Meta, project: string, selected: readonly string[]) {
  const { context, plan, baseline, needs, excluded } = updateContext(state, meta, project);
  validateReceiptTemplates(state.ledger, state.supply);
  const current = own(state.supply.receiptTemplates, baseline.template.id);
  if (!current) throw new Error('生成元のセットは削除されている。最新版へ追従できない');
  const template = normalizeAssemblyRecipe(current, state.ledger.masters, { allowLegacySelfReference: true });
  if (template.product !== null && !own(state.ledger.masters.items, template.product)?.active) throw new Error('最新版の製品は利用停止中');
  for (const row of templateNeedRows(template, state.ledger.masters, plan.count)) if (!own(state.ledger.masters.items, row.item)?.active) throw new Error(`最新版の品目 ${row.item} は利用停止中`);
  const content = recipeVersion(template, state.ledger.masters), known = Object.values(context.versions).find(version => recipeVersion(version.template, state.ledger.masters) === content);
  const target: TemplateNeedVersion = known ?? { id: `${meta.eventId}-v1`, template };
  if (!known && own(context.versions, target.id)) throw new Error(`版ID ${target.id} は使用済み`);
  const result = calculateTemplateNeedUpdate({ masters: state.ledger.masters, plan, baseline, needs, eventId: meta.eventId, selected, operation: { action: 'follow', target }, policy: 'preserve-exclusion', excluded });
  if (target.id === plan.version && !result.rows.some(row => row.collision)) throw new Error('この版への追従は適用済み。現在の必要明細を確認する');
  const applicable = target.id !== plan.version || result.rows.some(row => row.collision && row.selected);
  const event: Meta & TemplateNeedFollowDetail = { ...meta, kind: 'templateNeeds', action: 'follow', calculationPolicy: 'preserve-exclusion', reason: 'セットの最新版に追従', targetVersion: target.id, versions: known ? [] : [target], selected: [...selected], plansBefore: [plan], plansAfter: [result.plan], changes: result.changes };
  checkMaterialSize(event);
  return deepFreeze({ ...result, event, version: target, applicable, relatedCounts: relatedTemplateNeedCounts(state.supply, result.plan) });
}

export function followTemplateNeeds(state: State, meta: Meta, project: string, selected: readonly string[]): State {
  const result = buildTemplateNeedFollow(state, meta, project, selected);
  if (!result.applicable) throw new Error('追従する案件独自の明細を選ぶ。未選択の差分は記録しない');
  return { ledger: state.ledger, supply: recordTemplateNeeds(state.ledger, state.supply, meta, result.event) };
}
