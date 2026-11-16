import { normalizeAssemblyRecipe } from './assembly-recipes.ts';
import { changeMasters, checkTime, deepFreeze, type Ledger, type Meta } from './ledger.ts';
import { own, type Masters } from './masters.ts';
import { recipeVersion, validateReceiptTemplates, type ReceiptTemplate } from './receipt-template.ts';
import { templateNeedRows } from './template-needs-calculation.ts';
import { templateNeedContextOf } from './template-needs-context.ts';
import { checkDate, recordTemplateNeeds, type Need, type NeedQuantity, type Supply } from './supply.ts';
import { checkTemplateNeedGroup, type TemplateNeedGroup } from './template-needs-group.ts';
export { checkTemplateNeedGroup, defaultTemplateNeedSplit, proposeTemplateNeedSplit, templateNeedProjectLimit, type TemplateNeedGroup } from './template-needs-group.ts';
export { buildTemplateNeedEdit, editTemplateNeeds } from './template-needs-edit.ts';
export { templateNeedInfo, templateNeedSurplus, type TemplateNeedUpdateRow } from './template-needs-calculation.ts';
export { templateNeedContextOf } from './template-needs-context.ts';
export { buildTemplateNeedRecalculation, buildTemplateNeedFollow, recalculateTemplateNeeds, followTemplateNeeds } from './template-needs-update.ts';

export type TemplateNeedPlan = {
  project: string;
  generationId: string;
  initialVersion: string;
  version: string;
  count: number;
  origins: readonly { needId: string; item: string; unit: string; origin: 'template' | 'custom'; excluded?: true }[];
};
export type TemplateNeedPlanHeader = Omit<TemplateNeedPlan, 'origins'>;
export type TemplateNeedVersion = { id: string; template: ReceiptTemplate };
export type TemplateNeedChange = { before: Need | null; after: Need };
export type TemplateNeedContext = {
  plans: Readonly<Record<string, TemplateNeedPlan>>;
  versions: Readonly<Record<string, TemplateNeedVersion>>;
};
export type TemplateNeedGenerationInput = { templateId: string; caseCode: string; count: number; dueDate: string | null };
export type TemplateNeedBatchInput = { projects: readonly Omit<TemplateNeedGenerationInput, 'dueDate'>[]; dueDate: string | null; group: TemplateNeedGroup };
export type TemplateNeedGenerationRow = { item: string; unit: string; perSet: number; required: number; sourceRows: readonly number[] };
export type TemplateNeedGenerationDetail = {
  kind: 'templateNeeds';
  action: 'generate';
  versions: readonly TemplateNeedVersion[];
  plansBefore: readonly null[];
  plansAfter: readonly TemplateNeedPlan[];
  changes: readonly TemplateNeedChange[];
  group: TemplateNeedGroup | null;
};
export type TemplateNeedEdit =
  | ({ kind: 'change'; needId: string; required: NeedQuantity } & Partial<Pick<Need, 'dueDate' | 'source' | 'revision'>>)
  | { kind: 'exclude'; needId: string }
  | { kind: 'add'; item: string; unit: string; required: NeedQuantity; dueDate: string | null };
export type TemplateNeedEditDetail = {
  kind: 'templateNeeds';
  action: 'edit';
  editKind: TemplateNeedEdit['kind'];
  reason: string;
  changes: readonly [TemplateNeedChange];
} & (
  | { planFormat?: never; plansBefore: readonly [TemplateNeedPlan]; plansAfter: readonly [TemplateNeedPlan] }
  | { planFormat: 'delta'; plansBefore: readonly [TemplateNeedPlanHeader]; plansAfter: readonly [TemplateNeedPlanHeader] }
);
export type TemplateNeedRecalculateDetail = {
  kind: 'templateNeeds'; action: 'recalculate'; reason: string; selected: readonly string[]; calculationPolicy?: 'preserve-basis' | 'preserve-exclusion';
  plansBefore: readonly [TemplateNeedPlan]; plansAfter: readonly [TemplateNeedPlan]; changes: readonly TemplateNeedChange[];
};
export type TemplateNeedFollowDetail = {
  kind: 'templateNeeds'; action: 'follow'; reason: 'セットの最新版に追従'; selected: readonly string[]; calculationPolicy?: 'preserve-basis' | 'preserve-exclusion';
  targetVersion: string; versions: readonly TemplateNeedVersion[];
  plansBefore: readonly [TemplateNeedPlan]; plansAfter: readonly [TemplateNeedPlan]; changes: readonly TemplateNeedChange[];
};
export type TemplateNeedDetail = TemplateNeedGenerationDetail | TemplateNeedEditDetail | TemplateNeedRecalculateDetail | TemplateNeedFollowDetail;
export type TemplateNeedGeneration = {
  ledger: Ledger;
  plan: TemplateNeedPlan;
  needs: readonly Need[];
  version: TemplateNeedVersion;
  event: Meta & TemplateNeedGenerationDetail;
  newProject: boolean;
  rows: readonly TemplateNeedGenerationRow[];
};
export type TemplateNeedBatchGeneration = {
  ledger: Ledger;
  projects: readonly Omit<TemplateNeedGeneration, 'ledger' | 'event'>[];
  needs: readonly Need[];
  event: Meta & TemplateNeedGenerationDetail;
};

export function generateTemplateNeeds(state: { ledger: Ledger; supply: Supply }, meta: Meta, input: TemplateNeedGenerationInput): { ledger: Ledger; supply: Supply } {
  const result = buildTemplateNeedGeneration(state, templateNeedContextOf(state.supply), meta, input);
  return { ledger: result.ledger, supply: recordTemplateNeeds(result.ledger, state.supply, meta, result.event) };
}

export function generateTemplateNeedsBatch(state: { ledger: Ledger; supply: Supply }, meta: Meta, input: TemplateNeedBatchInput): { ledger: Ledger; supply: Supply } {
  const result = buildTemplateNeedBatchGeneration(state, templateNeedContextOf(state.supply), meta, input);
  return { ledger: result.ledger, supply: recordTemplateNeeds(result.ledger, state.supply, meta, result.event) };
}

export function buildTemplateNeedBatchGeneration(state: { ledger: Ledger; supply: Supply }, context: TemplateNeedContext, meta: Meta, input: TemplateNeedBatchInput): TemplateNeedBatchGeneration {
  return buildGeneration(state, context, meta, input.projects, input.dueDate, input.group);
}

function generationRows(template: ReceiptTemplate, masters: Masters, count: number): TemplateNeedGenerationRow[] {
  const rows = templateNeedRows(template, masters, count);
  for (const row of rows) {
    const item = own(masters.items, row.item);
    if (!item?.active) throw new Error(`品目 ${row.item} は利用停止中。セットの登録・改訂を確認する`);
  }
  return rows;
}

function resolveGenerationProject(ledger: Ledger, supply: Supply, context: TemplateNeedContext, meta: Meta, caseCode: string, index: number): { ledger: Ledger; project: string; newProject: boolean } {
  const matches = Object.values(ledger.masters.cases).filter(project => project.code === caseCode || (project.code === null && project.id === caseCode));
  if (matches.length > 1) throw new Error(`案件ID ${caseCode} の対応が曖昧。登録情報を確認する`);
  const existing = matches[0];
  if (existing) {
    if (!existing.active) throw new Error(`案件ID ${caseCode} は利用停止中`);
    if (Object.values(supply.needs).some(need => need.project.id === existing.id)) throw new Error(`案件ID ${caseCode} は必要明細を持つ。既存の必要明細を確認・変更する`);
    if (own(context.plans, existing.id)) throw new Error(`案件ID ${caseCode} は生成済み。既存の必要明細を確認・変更する`);
    return { ledger, project: existing.id, newProject: false };
  }
  const next = changeMasters(ledger, { ...meta, eventId: `${meta.eventId}-c${index + 1}` }, { action: 'register', master: { type: 'case', code: caseCode, name: null, source: null } });
  const created = Object.values(next.masters.cases).find(project => project.code === caseCode);
  if (!created) throw new Error('案件・用途の登録結果がない');
  return { ledger: next, project: created.id, newProject: true };
}

// プレビューと確定は同じ組立て・検査を使う。確定時は最新状態で組み立て直す。
export function buildTemplateNeedGeneration(state: { ledger: Ledger; supply: Supply }, context: TemplateNeedContext, meta: Meta, input: TemplateNeedGenerationInput): TemplateNeedGeneration {
  const result = buildGeneration(state, context, meta, [input], input.dueDate, null);
  return deepFreeze({ ...result.projects[0]!, ledger: result.ledger, event: result.event });
}

function buildGeneration(state: { ledger: Ledger; supply: Supply }, context: TemplateNeedContext, meta: Meta, inputs: readonly Omit<TemplateNeedGenerationInput, 'dueDate'>[], dueDate: string | null, group: TemplateNeedGroup | null): TemplateNeedBatchGeneration {
  checkTemplateNeedGroup(inputs.map(input => input.count), group);
  if (inputs.some(input => !input.caseCode.trim())) throw new Error('案件IDを入力する');
  if (inputs.some(input => input.caseCode !== input.caseCode.trim())) throw new Error('案件IDの前後の空白を取り除いて確認する。以前の空白付き案件は既存の明細から変更する');
  if (inputs.some(input => Object.values(state.ledger.masters.cases).some(project => project.code !== null && project.code !== project.code.trim() && project.code.trim() === input.caseCode))) throw new Error('同じコードの空白付き案件がある。登録情報で案件コードを確認・変更してから生成する');
  const codes = inputs.map(input => input.caseCode), duplicates = [...new Set(codes.filter((code, index) => codes.indexOf(code) !== index))];
  if (duplicates.length > 0) throw new Error(`案件ID「${duplicates.join('」「')}」が重複している`);
  if (dueDate !== null) checkDate(dueDate, '必要日');
  checkTime(meta.occurredAt, '発生');
  checkTime(meta.recordedAt, '記録');
  if (state.supply.log.some(event => event.eventId === meta.eventId) || state.ledger.history.some(event => event.eventId === meta.eventId)) throw new Error(`操作ID ${meta.eventId} は使用済み`);
  validateReceiptTemplates(state.ledger, state.supply);
  const versionsByContent = new Map(Object.values(context.versions).map(version => [recipeVersion(version.template, state.ledger.masters), version]));
  const versions: TemplateNeedVersion[] = [], projects: Omit<TemplateNeedGeneration, 'ledger' | 'event'>[] = [], needs: Need[] = [], projectIds = new Map<string, string>();
  let ledger = state.ledger;
  for (const [index, input] of inputs.entries()) {
    const current = own(state.supply.receiptTemplates, input.templateId);
    if (!current) throw new Error('セットを選ぶ（なければ先に登録する）');
    const template = normalizeAssemblyRecipe(current, state.ledger.masters, { allowLegacySelfReference: true });
    if (template.product !== null && !own(state.ledger.masters.items, template.product)?.active) throw new Error('製品の品目は利用停止中。セットの登録・改訂を確認する');
    const rows = generationRows(template, state.ledger.masters, input.count), content = recipeVersion(template, state.ledger.masters), known = versionsByContent.get(content);
    const version: TemplateNeedVersion = { id: known?.id ?? `${meta.eventId}-v${versions.length + 1}`, template };
    if (!known) {
      if (own(context.versions, version.id)) throw new Error(`版ID ${version.id} は使用済み`);
      versions.push(version); versionsByContent.set(content, version);
    }
    const target = resolveGenerationProject(ledger, state.supply, context, meta, input.caseCode, index);
    const previous = projectIds.get(target.project);
    if (previous !== undefined) throw new Error(`案件ID「${previous}」「${input.caseCode}」は同じ案件に対応している`);
    projectIds.set(target.project, input.caseCode); ledger = target.ledger;
    const offset = needs.length;
    const generated: Need[] = rows.map((row, rowIndex) => ({ id: `${meta.eventId}-n${offset + rowIndex + 1}`, project: { kind: 'case', id: target.project }, item: row.item, unit: row.unit,
      required: { basis: 'label', value: row.required }, dueDate, source: template.name, revision: version.id }));
    if (generated.some(need => own(state.supply.needs, need.id))) throw new Error('生成する必要明細IDは使用済み');
    const plan: TemplateNeedPlan = { project: target.project, generationId: meta.eventId, initialVersion: version.id, version: version.id, count: input.count,
      origins: generated.map(need => ({ needId: need.id, item: need.item, unit: need.unit, origin: 'template' })) };
    projects.push({ plan, needs: generated, version, newProject: target.newProject, rows }); needs.push(...generated);
  }
  if (needs.length > 1000) throw new Error('一回の必要明細は合計1,000件以下にする');
  const event: Meta & TemplateNeedGenerationDetail = { ...meta, kind: 'templateNeeds', action: 'generate', versions, plansBefore: projects.map(() => null), plansAfter: projects.map(project => project.plan),
    changes: needs.map(after => ({ before: null, after })), group };
  if (new TextEncoder().encode(JSON.stringify(event)).byteLength > 1024 * 1024) throw new Error('生成イベントが1MiBを超える。セットや案件を分けて生成する');
  return deepFreeze({ ledger, projects, needs, event });
}
