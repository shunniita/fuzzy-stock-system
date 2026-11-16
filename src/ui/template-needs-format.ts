import { recipeVersion } from '../domain/receipt-template.ts';
import { own, type Masters } from '../domain/masters.ts';
import type { Need, Supply } from '../domain/supply.ts';
import { templateNeedInfo, templateNeedSurplus as surplusOf, type TemplateNeedContext, type TemplateNeedVersion } from '../domain/template-needs.ts';
import { jst } from './format.ts';
import type { State } from './supply-ui.ts';
import { judgementText } from './supply-format.ts';

export function templateNeedVersionText(supply: Supply, version: TemplateNeedVersion): string {
  const introduced = supply.log.findIndex(event => event.kind === 'templateNeeds' && (event.action === 'generate' || event.action === 'follow') && event.versions.some(entry => entry.id === version.id));
  const saved = supply.log.slice(0, Math.max(0, introduced)).findLast(event => event.kind === 'receiptTemplateSave' && event.after.id === version.template.id);
  return `${version.id}（${saved ? `${jst(saved.recordedAt)}・${saved.actor}` : '保存の記録なし'}）`;
}

export function templateNeedSurplusViewOf(state: State, need: Need): { value: number | null; caution: string } {
  const { value, judgement } = surplusOf(state.ledger, state.supply, need);
  return { value, caution: value === null || judgement.kind === 'confirm' ? judgementText(judgement) : '' };
}

export function currentTemplateVersionText(masters: Masters, supply: Supply, id: string): string {
  const current = own(supply.receiptTemplates, id);
  if (!current) return '未登録';
  const content = recipeVersion(current, masters);
  const saved = [...supply.log].reverse().find(event => event.kind === 'receiptTemplateSave' && recipeVersion(event.after, masters) === content);
  return saved ? `${jst(saved.recordedAt)}・${saved.actor}` : '保存の記録なし';
}

export function templateNeedOriginText(masters: Masters, context: TemplateNeedContext, need: Need): string {
  const info = templateNeedInfo(masters, context, need);
  if (!info) return '手入力';
  if (info.origin === 'custom') return '案件独自の明細';
  return `セット由来・標準${info.standard}${need.unit}${info.modified ? '・手修正あり' : ''}・元行${info.rows.join('、') || 'なし'}`;
}
