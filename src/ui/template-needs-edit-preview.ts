import type { Meta } from '../domain/ledger.ts';
import { own } from '../domain/masters.ts';
import { buildTemplateNeedEdit, buildTemplateNeedFollow, buildTemplateNeedRecalculation, templateNeedInfo, templateNeedContextOf, type TemplateNeedEdit } from '../domain/template-needs.ts';
import { recordTemplateNeeds } from '../domain/supply.ts';
import type { TemplateNeedUpdateRow } from '../domain/template-needs-calculation.ts';
import type { Values } from './dom.ts';
import { amount, quantityValue } from './fields.ts';
import type { State } from './supply-ui.ts';

export type TemplateNeedChangeInput = { project: string } & (
  { action: 'edit'; edit: TemplateNeedEdit; reason: string } |
  { action: 'recalculate'; count: number; selected: string[]; reason: string } |
  { action: 'follow'; selected: string[] }
);

export function templateNeedChangeInput(state: State, v: Values): TemplateNeedChangeInput {
  const project = v.text('needProject'), action = v.text('needAction');
  const selected = (own(state.supply.templateNeeds, project)?.origins ?? []).flatMap((origin, index) => v.checked(`needApply${index}`) ? [origin.needId] : []);
  if (action === 'follow') return { project, action, selected };
  const reason = v.text('needReason');
  if (action === 'recalculate') return { project, action, count: quantityValue(v.text('needCount'), 1), selected, reason };
  if (action === 'change') return { project, action: 'edit', edit: { kind: 'change', needId: v.text('need'), required: amount(v), dueDate: v.text('needDue') || null, source: v.text('needSource'), revision: v.text('needRevision') }, reason };
  if (action === 'exclude') return { project, action: 'edit', edit: { kind: 'exclude', needId: v.text('need') }, reason };
  if (action === 'add') return { project, action: 'edit', edit: { kind: 'add', item: v.text('item'), unit: v.text('unit'), required: amount(v), dueDate: v.text('needDue') || null }, reason };
  throw new Error('必要明細の変更方法を選ぶ');
}

export function prepareTemplateNeedChange(state: State, meta: Meta, input: TemplateNeedChangeInput) {
  const context = templateNeedContextOf(state.supply);
  if (input.action !== 'edit') {
    const result = input.action === 'recalculate'
      ? buildTemplateNeedRecalculation(state, meta, input.project, input.count, input.selected, input.reason)
      : buildTemplateNeedFollow(state, meta, input.project, input.selected);
    const after = !result.applicable ? state : { ledger: state.ledger, supply: recordTemplateNeeds(state.ledger, state.supply, meta, result.event) };
    return { ...result, state: after };
  }
  const result = buildTemplateNeedEdit(state, meta, input.project, input.edit, input.reason);
  const after = { ledger: state.ledger, supply: recordTemplateNeeds(state.ledger, state.supply, meta, result.event) };
  const beforeInfo = result.before === null ? null : templateNeedInfo(state.ledger.masters, context, result.before);
  const afterInfo = templateNeedInfo(after.ledger.masters, templateNeedContextOf(after.supply), result.after)!;
  const row: TemplateNeedUpdateRow = { key: result.after.id, item: result.after.item, unit: result.after.unit, before: result.before, after: result.after,
    oldStandard: beforeInfo?.standard ?? null, newStandard: afterInfo.standard, manual: beforeInfo?.modified ?? false,
    selectable: false, selected: false, added: result.before === null, removed: false, collision: false,
    originBefore: beforeInfo?.origin ?? null, originAfter: afterInfo.origin };
  return { state: after, plan: result.plan, version: afterInfo.version, rows: [row], applicable: true, relatedCounts: null };
}
