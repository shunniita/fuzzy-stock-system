import { normalizeAssemblyRecipe } from './assembly-recipes.ts';
import type { Ledger } from './ledger.ts';
import { own } from './masters.ts';
import { recipeVersion, type ReceiptTemplate } from './receipt-template.ts';
import { calculateTemplateNeedUpdate, templateNeedExcludedIds, templateNeedRows } from './template-needs-calculation.ts';
import { templateNeedPlanAfterEdit } from './template-needs-edit.ts';
import { checkNeedFields, checkNeedQuantity, type Need, type Supply, type SupplyEvent } from './supply.ts';
import type { TemplateNeedPlan, TemplateNeedPlanHeader, TemplateNeedVersion } from './template-needs.ts';
import { checkTemplateNeedGroup } from './template-needs-group.ts';

const needKey = (need: Need): string => JSON.stringify([need.id, need.project, need.item, need.unit, need.required, need.dueDate, need.source, need.revision]);
const planHeaderKey = (plan: TemplateNeedPlanHeader): string => JSON.stringify([plan.project, plan.generationId, plan.initialVersion, plan.version, plan.count]);
const planKey = (plan: TemplateNeedPlan): string => JSON.stringify([planHeaderKey(plan), plan.origins.map(origin => [origin.needId, origin.item, origin.unit, origin.origin, origin.excluded === true])]);
const fail = (): never => { throw new Error('生成した必要明細・計画・版と履歴が一致しない'); };

function expectedNeeds(template: ReceiptTemplate, ledger: Ledger, event: Extract<SupplyEvent, { kind: 'templateNeeds'; action: 'generate' }>, plan: TemplateNeedPlan, offset: number): Need[] {
  const dueDate = event.changes[0]?.after.dueDate ?? null;
  return templateNeedRows(template, ledger.masters, plan.count).map((row, index) => ({ id: `${event.eventId}-n${offset + index + 1}`, project: { kind: 'case', id: plan.project }, item: row.item, unit: row.unit,
    required: { basis: 'label', value: row.required }, dueDate, source: template.name, revision: plan.version }));
}

function introduceVersions(event: Extract<SupplyEvent, { kind: 'templateNeeds'; action: 'generate' | 'follow' }>, ledger: Ledger, templates: ReadonlyMap<string, ReceiptTemplate>, versions: Map<string, TemplateNeedVersion>, contents: Set<string>, referenced: readonly string[]): void {
  for (const [index, version] of event.versions.entries()) {
    const content = recipeVersion(version.template, ledger.masters);
    const current = templates.get(version.template.id);
    if (!referenced.includes(version.id) || version.id !== `${event.eventId}-v${index + 1}` || versions.has(version.id) || contents.has(content) || !current || content !== recipeVersion(current, ledger.masters)) fail();
    versions.set(version.id, version); contents.add(content);
  }
}

function generation(event: Extract<SupplyEvent, { kind: 'templateNeeds'; action: 'generate' }>, ledger: Ledger, templates: ReadonlyMap<string, ReceiptTemplate>, versions: Map<string, TemplateNeedVersion>, contents: Set<string>, needs: Map<string, Need>, plans: Map<string, TemplateNeedPlan>): void {
  if (event.plansBefore.length !== event.plansAfter.length || event.plansBefore.some(plan => plan !== null) || event.versions.length > event.plansAfter.length || event.changes.length > 1000) fail();
  checkTemplateNeedGroup(event.plansAfter.map(plan => plan.count), event.group);
  introduceVersions(event, ledger, templates, versions, contents, event.plansAfter.map(plan => plan.version));
  let offset = 0;
  for (const plan of event.plansAfter) {
    if (plan.initialVersion !== plan.version || plan.generationId !== event.eventId || plans.has(plan.project) || !own(ledger.masters.cases, plan.project)) fail();
    const version = versions.get(plan.version) ?? fail(), current = templates.get(version.template.id);
    if (!current || recipeVersion(version.template, ledger.masters) !== recipeVersion(current, ledger.masters)) fail();
    if ([...needs.values()].some(need => need.project.id === plan.project)) fail();
    const expected = expectedNeeds(version.template, ledger, event, plan, offset);
    if (plan.origins.length !== expected.length) fail();
    for (const [index, need] of expected.entries()) {
      const change = event.changes[offset + index] ?? fail(), origin = plan.origins[index]!;
      if (change.before !== null || needKey(change.after) !== needKey(need) || needs.has(need.id) || origin.needId !== need.id || origin.item !== need.item || origin.unit !== need.unit || origin.origin !== 'template' || origin.excluded !== undefined) fail();
      needs.set(need.id, change.after);
    }
    offset += expected.length;
    plans.set(plan.project, plan);
  }
  if (event.changes.length !== offset) fail();
}

function updating(event: Extract<SupplyEvent, { kind: 'templateNeeds'; action: 'recalculate' | 'follow' }>, ledger: Ledger, templates: ReadonlyMap<string, ReceiptTemplate>, versions: Map<string, TemplateNeedVersion>, contents: Set<string>, needs: Map<string, Need>, plans: Map<string, TemplateNeedPlan>, log: readonly SupplyEvent[]): void {
  if (event.plansBefore.length !== 1 || event.plansAfter.length !== 1) fail();
  const before = event.plansBefore[0], after = event.plansAfter[0], current = plans.get(before.project) ?? fail(), baseline = versions.get(current.version) ?? fail();
  if (planKey(before) !== planKey(current)) fail();
  let operation: { action: 'recalculate'; count: number } | { action: 'follow'; target: TemplateNeedVersion };
  if (event.action === 'follow') {
    if (event.reason !== 'セットの最新版に追従' || event.versions.length > 1) fail();
    introduceVersions(event, ledger, templates, versions, contents, [event.targetVersion]);
    const target = versions.get(event.targetVersion) ?? fail(), latest = templates.get(baseline.template.id);
    if (target.template.id !== baseline.template.id || !latest || recipeVersion(target.template, ledger.masters) !== recipeVersion(latest, ledger.masters)) fail();
    operation = { action: 'follow', target };
  } else {
    if (!event.reason.trim() || after.count === before.count) fail();
    operation = { action: 'recalculate', count: after.count };
  }
  if (event.calculationPolicy !== undefined && event.calculationPolicy !== 'preserve-basis' && event.calculationPolicy !== 'preserve-exclusion') fail();
  const excluded = event.calculationPolicy === 'preserve-exclusion' ? templateNeedExcludedIds(log, before.project, event.eventId) : new Set<string>();
  const expected = calculateTemplateNeedUpdate({ masters: ledger.masters, plan: before, baseline, needs, eventId: event.eventId, selected: event.selected, operation, policy: event.calculationPolicy ?? 'legacy-numeric', excluded });
  if (event.action === 'follow' && event.targetVersion === before.version && !expected.rows.some(row => row.collision && row.selected)) fail();
  if (planKey(after) !== planKey(expected.plan) || event.changes.length !== expected.changes.length) fail();
  for (const [index, change] of expected.changes.entries()) {
    const actual = event.changes[index] ?? fail();
    if ((change.before === null ? actual.before !== null : actual.before === null || needKey(actual.before) !== needKey(change.before)) || needKey(actual.after) !== needKey(change.after)) fail();
    needs.set(change.after.id, actual.after);
  }
  plans.set(after.project, after);
}

function editing(event: Extract<SupplyEvent, { kind: 'templateNeeds'; action: 'edit' }>, ledger: Ledger, needs: Map<string, Need>, plans: Map<string, TemplateNeedPlan>): void {
  if (!event.reason.trim() || event.plansBefore.length !== 1 || event.plansAfter.length !== 1 || event.changes.length !== 1) fail();
  const beforePlan = event.plansBefore[0], afterPlan = event.plansAfter[0], change = event.changes[0];
  const currentPlan = plans.get(beforePlan.project) ?? fail(), after = change.after;
  if (event.planFormat === 'delta' ? planHeaderKey(beforePlan) !== planHeaderKey(currentPlan) : planKey(event.plansBefore[0]) !== planKey(currentPlan)) fail();
  if (after.project.id !== beforePlan.project) fail();
  checkNeedFields(after); checkNeedQuantity(ledger.masters, after, after.required);
  let expectedPlan = currentPlan;
  if (event.editKind === 'add') {
    const item = own(ledger.masters.items, after.item);
    if (change.before !== null || needs.has(after.id) || after.id !== `${event.eventId}-n1` || after.source !== '案件独自' || after.revision !== event.eventId || !item?.units.includes(after.unit)) fail();
    if (currentPlan.origins.some(origin => origin.item === after.item && origin.unit === after.unit) || currentPlan.origins.length >= 1000) fail();
    expectedPlan = templateNeedPlanAfterEdit(currentPlan, event.editKind, change);
  } else {
    const before = change.before ?? fail(), current = needs.get(before.id) ?? fail();
    if (needKey(before) !== needKey(current) || before.project.id !== beforePlan.project || !currentPlan.origins.some(origin => origin.needId === before.id && origin.item === before.item && origin.unit === before.unit)) fail();
    const metadata = event.planFormat === 'delta' && event.editKind === 'change' ? { dueDate: after.dueDate, source: after.source, revision: after.revision } : {};
    const expected: Need = event.editKind === 'change' ? { ...before, ...metadata, required: after.required } : event.editKind === 'exclude' ? { ...before, required: { basis: 'label', value: 0 } } : fail();
    if (event.planFormat === 'delta' || event.editKind === 'change') expectedPlan = templateNeedPlanAfterEdit(currentPlan, event.editKind, change);
    if (needKey(after) !== needKey(expected) || (needKey(before) === needKey(after) && planKey(currentPlan) === planKey(expectedPlan))) fail();
  }
  if (event.planFormat === 'delta' ? planHeaderKey(afterPlan) !== planHeaderKey(expectedPlan) : planKey(event.plansAfter[0]) !== planKey(expectedPlan)) fail();
  needs.set(after.id, after); plans.set(expectedPlan.project, expectedPlan);
}

// この機能の計画・必要明細だけを追跡し、現物の履歴は再生しない。
export function validateTemplateNeeds(ledger: Ledger, supply: Supply): void {
  if (!supply.log.some(event => event.kind === 'templateNeeds')) {
    if (Object.keys(supply.templateNeeds).length > 0) fail();
    return;
  }
  const templates = new Map<string, ReceiptTemplate>(), versions = new Map<string, TemplateNeedVersion>(), contents = new Set<string>();
  const needs = new Map<string, Need>(), plans = new Map<string, TemplateNeedPlan>(), ids = new Set<string>();
  const remember = (need: Need): void => {
    if (plans.has(need.project.id)) fail();
    needs.set(need.id, need);
  };
  for (const event of supply.log) {
    if (!event.eventId.trim() || ids.has(event.eventId)) fail();
    ids.add(event.eventId);
    switch (event.kind) {
      case 'receiptTemplateSave': templates.set(event.after.id, normalizeAssemblyRecipe(event.after, ledger.masters, { allowLegacySelfReference: true })); break;
      case 'receiptTemplateDelete': templates.delete(event.before.id); break;
      case 'templateNeeds':
        if (event.itemLabels.kind !== 'recorded' || ledger.history.some(recorded => recorded.eventId === event.eventId) || new TextEncoder().encode(JSON.stringify(event)).byteLength > 1024 * 1024) fail();
        if (event.action === 'generate') generation(event, ledger, templates, versions, contents, needs, plans);
        else if (event.action === 'edit') editing(event, ledger, needs, plans);
        else updating(event, ledger, templates, versions, contents, needs, plans, supply.log);
        break;
      case 'needRegister': remember(event.need); break;
      case 'needRevise': remember(event.after); break;
      case 'needImport': if (event.decision.kind !== 'hold') remember(event.decision.after); break;
      case 'needImportResolve': if (event.resolution.kind === 'apply') remember(event.resolution.after); break;
      default: break;
    }
  }
  if (plans.size !== Object.keys(supply.templateNeeds).length) fail();
  for (const [project, plan] of Object.entries(supply.templateNeeds)) {
    const expected = plans.get(project);
    if (project !== plan.project || !expected || planKey(plan) !== planKey(expected)) fail();
  }
  const current = Object.entries(supply.needs).filter(([, need]) => plans.has(need.project.id));
  const expected = [...needs.values()].filter(need => plans.has(need.project.id));
  if (current.length !== expected.length) fail();
  for (const [key, need] of current) if (key !== need.id || !needs.has(key) || needKey(need) !== needKey(needs.get(key)!)) fail();
}
