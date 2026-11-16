import { own } from './masters.ts';
import type { Supply } from './supply.ts';
import type { TemplateNeedContext, TemplateNeedPlan } from './template-needs.ts';

export function templateNeedContextOf(supply: Supply): TemplateNeedContext {
  const versions = Object.fromEntries(supply.log.flatMap(event => event.kind === 'templateNeeds' && (event.action === 'generate' || event.action === 'follow') ? event.versions.map(version => [version.id, version]) : []));
  return { plans: supply.templateNeeds, versions };
}

export function relatedTemplateNeedCounts(supply: Supply, updated: TemplateNeedPlan): { generationId: string; mode: 'same' | 'split'; assembly: string; inspection: string; difference: string } | null {
  const event = supply.log.find(event => event.eventId === updated.generationId);
  if (!event || event.kind !== 'templateNeeds' || event.action !== 'generate' || event.group === null) return null;
  const counts = event.plansAfter.map(plan => {
    const current = plan.project === updated.project ? updated : own(supply.templateNeeds, plan.project);
    if (!current) throw new Error('まとめて生成した案件の現在の計画がない');
    return BigInt(current.count);
  });
  const assembly = counts[0]!, inspection = counts.slice(1).reduce((total, count) => total + count, 0n);
  return { generationId: updated.generationId, mode: event.group.mode, assembly: String(assembly), inspection: String(inspection), difference: String(inspection - assembly) };
}
