import { checkTime, deepFreeze, type Ledger, type Meta } from './ledger.ts';
import { own } from './masters.ts';
import { checkNeedFields, checkNeedQuantity, recordTemplateNeeds, type Need, type NeedQuantity, type Supply } from './supply.ts';
import type { TemplateNeedChange, TemplateNeedEdit, TemplateNeedEditDetail, TemplateNeedPlan, TemplateNeedPlanHeader } from './template-needs.ts';

type State = { ledger: Ledger; supply: Supply };

export function templateNeedPlanHeaderOf({ origins: _, ...header }: TemplateNeedPlan): TemplateNeedPlanHeader { return header; }

export function templateNeedPlanAfterEdit(plan: TemplateNeedPlan, kind: TemplateNeedEdit['kind'], { before, after }: TemplateNeedChange): TemplateNeedPlan {
  if (kind === 'add') return { ...plan, origins: [...plan.origins, { needId: after.id, item: after.item, unit: after.unit, origin: 'custom' }] };
  const quantityChanged = before !== null && (before.required.basis !== after.required.basis || before.required.value !== after.required.value);
  if (kind !== 'exclude' && !quantityChanged) return plan;
  return { ...plan, origins: plan.origins.map(origin => {
    if (origin.needId !== after.id) return origin;
    const { excluded: _, ...included } = origin;
    return kind === 'exclude' ? { ...included, excluded: true } : included;
  }) };
}

// 既存明細の現在の停止状態は編集条件にしない。追加だけは利用中の品目・単位を選ぶ。
export function buildTemplateNeedEdit(state: State, meta: Meta, project: string, edit: TemplateNeedEdit, reason: string): { event: Meta & TemplateNeedEditDetail; plan: TemplateNeedPlan; before: Need | null; after: Need } {
  if (!reason.trim()) throw new Error('必要明細の変更・追加・除外の理由を入力する');
  checkTime(meta.occurredAt, '発生'); checkTime(meta.recordedAt, '記録');
  if (state.supply.log.some(event => event.eventId === meta.eventId) || state.ledger.history.some(event => event.eventId === meta.eventId)) throw new Error(`操作ID ${meta.eventId} は使用済み`);
  const plan = own(state.supply.templateNeeds, project);
  if (!plan) throw new Error('生成した必要明細を持つ案件を選ぶ');
  let before: Need | null, after: Need;
  if (edit.kind === 'add') {
    const duplicate = plan.origins.find(origin => origin.item === edit.item && origin.unit === edit.unit);
    if (duplicate) throw new Error(`品目 ${edit.item}（${edit.unit}）は登録済み（${duplicate.needId}）。その必要明細を変更する`);
    if (plan.origins.length >= 1000) throw new Error('案件の必要明細は保持分も含め1,000件以下にする');
    const item = own(state.ledger.masters.items, edit.item);
    if (!item?.active || !item.units.includes(edit.unit)) throw new Error('追加する品目・単位は登録済みで利用中のものを選ぶ');
    const id = `${meta.eventId}-n1`;
    if (own(state.supply.needs, id)) throw new Error(`必要明細ID ${id} は使用済み`);
    before = null;
    after = { id, project: { kind: 'case', id: project }, item: edit.item, unit: edit.unit, required: checkNeedQuantity(state.ledger.masters, edit, edit.required), dueDate: edit.dueDate, source: '案件独自', revision: meta.eventId };
  } else {
    before = own(state.supply.needs, edit.needId) ?? null;
    if (!before || before.project.id !== project || !plan.origins.some(origin => origin.needId === edit.needId)) throw new Error('対象案件の必要明細を選ぶ');
    const required: NeedQuantity = edit.kind === 'exclude' ? { basis: 'label', value: 0 } : edit.required;
    after = { ...before, required: checkNeedQuantity(state.ledger.masters, before, required),
      dueDate: edit.kind === 'change' && edit.dueDate !== undefined ? edit.dueDate : before.dueDate,
      source: edit.kind === 'change' ? edit.source ?? before.source : before.source,
      revision: edit.kind === 'change' ? edit.revision ?? before.revision : before.revision };
    const exclusionChanged = edit.kind === 'exclude' && !plan.origins.find(origin => origin.needId === edit.needId)?.excluded;
    if (!exclusionChanged && before.required.basis === after.required.basis && before.required.value === after.required.value && before.dueDate === after.dueDate && before.source === after.source && before.revision === after.revision) throw new Error('必要明細の内容が変わっていない');
  }
  checkNeedFields(after);
  const nextPlan = templateNeedPlanAfterEdit(plan, edit.kind, { before, after });
  const event: Meta & TemplateNeedEditDetail = { ...meta, kind: 'templateNeeds', action: 'edit', planFormat: 'delta', editKind: edit.kind, reason, plansBefore: [templateNeedPlanHeaderOf(plan)], plansAfter: [templateNeedPlanHeaderOf(nextPlan)], changes: [{ before, after }] };
  if (new TextEncoder().encode(JSON.stringify(event)).byteLength > 1024 * 1024) throw new Error('必要明細のイベントが1MiBを超える。入力を分けて記録する');
  return deepFreeze({ event, plan: nextPlan, before, after });
}

export function editTemplateNeeds(state: State, meta: Meta, project: string, edit: TemplateNeedEdit, reason: string): State {
  const result = buildTemplateNeedEdit(state, meta, project, edit, reason);
  return { ledger: state.ledger, supply: recordTemplateNeeds(state.ledger, state.supply, meta, result.event) };
}
