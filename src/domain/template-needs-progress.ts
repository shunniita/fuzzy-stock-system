import type { Ledger, Lot } from './ledger.ts';
import { own } from './masters.ts';
import { sumQuantities, type Quantity } from './quantity.ts';
import type { ReceiptTemplate } from './receipt-template.ts';
import { subtractScalar, type Step } from './scalar.ts';
import type { Supply } from './supply.ts';
import { templateNeedContextOf } from './template-needs-context.ts';

export type TemplateNeedProgress = {
  caseId: string;
  version: string;
  total: number;
  unit: string | null;
  used: Quantity | null;
  remaining: number | null;
};

type ProgressState = { ledger: Ledger; supply: Supply };

export function templateNeedProgressOf(state: ProgressState, caseId: string): TemplateNeedProgress | null {
  return own(state.supply.templateNeeds, caseId) ? templateNeedProgressesOf(state, [caseId])[0]! : null;
}

// 案件ごとに履歴をなめると、読込で全案件を確かめるときに案件数×履歴の時間がかかるので、開始を一度だけ案件ごとに分ける。
export function templateNeedProgressesOf(state: ProgressState, caseIds: readonly string[] = Object.keys(state.supply.templateNeeds)): TemplateNeedProgress[] {
  const versions = templateNeedContextOf(state.supply).versions;
  const starts = new Map(caseIds.map(caseId => [caseId, [] as Lot[]]));
  // 開始時の数量を読むので、後の付け替え・数え直しは影響しない。
  for (const event of state.ledger.history) {
    const lot = event.kind === 'start' ? event.changes[0]?.after : undefined;
    if (lot?.project.kind === 'case') starts.get(lot.project.id)?.push(lot);
  }
  return caseIds.map(caseId => {
    const plan = own(state.supply.templateNeeds, caseId);
    if (!plan) throw new Error(`案件 ${caseId} の計画がない`);
    const template = own(versions, plan.version)?.template;
    if (!template) throw new Error(`案件 ${caseId} の計画の版 ${plan.version} の構成がない`);
    try { return progressOf(caseId, plan.version, plan.count, template, starts.get(caseId)!); }
    catch (error) { throw new Error(`案件${caseId}の作業で使った台数・未使用の残りが上限を超える：${error instanceof Error ? error.message : String(error)}`); }
  });
}

function progressOf(caseId: string, version: string, total: number, { product, productUnit }: ReceiptTemplate, starts: readonly Lot[]): TemplateNeedProgress {
  const base = { caseId, version, total };
  if (product === null) return { ...base, unit: null, used: null, remaining: null };
  // productUnit 未設定の古い構成は品目だけで照合する。
  const started = starts.filter(lot => lot.item === product && (productUnit === undefined || lot.unit === productUnit));
  const quantities = started.map(lot => lot.quantity);
  const used = sumQuantities(quantities, stepOf(quantities.map(valueOf)));
  return { ...base, unit: productUnit ?? null, used, remaining: used.kind === 'known' ? subtractScalar(total, used.numeric.value, stepOf([used.numeric.value]), 1) : null };
}

const valueOf = (quantity: Quantity): number => quantity.kind === 'unknown' ? 0 : quantity.numeric?.value ?? 0;

// 古い構成では最小単位の違う単位が混ざるので、単位でなく値で選び、整数だけなら小数の上限で計算しない（保存しない集計なので、小数品目の上限の例外とする）。
// 小数を含んで小数の上限を超える合計・残りは0.1の精度で表せないので例外になり、保存と復号の合計の検査（requireQuantityTotals）で止まる。
const stepOf = (values: readonly number[]): Step => values.every(Number.isInteger) ? 1 : 0.1;

export function progressOverflowsOf(before: ProgressState, after: ProgressState): { caseId: string; over: number }[] {
  const candidates = new Set<string>();
  for (const [caseId, plan] of Object.entries(after.supply.templateNeeds)) {
    const old = own(before.supply.templateNeeds, caseId);
    if (!old || old.count !== plan.count || old.version !== plan.version) candidates.add(caseId);
  }
  for (const event of after.ledger.history.slice(before.ledger.history.length)) {
    const project = event.kind === 'start' ? event.changes[0]?.after?.project : undefined;
    if (project?.kind === 'case' && own(after.supply.templateNeeds, project.id)) candidates.add(project.id);
  }
  return [...candidates].flatMap(caseId => {
    const remaining = templateNeedProgressOf(after, caseId)?.remaining;
    if (remaining == null || remaining >= 0) return [];
    const was = templateNeedProgressOf(before, caseId)?.remaining;
    return was == null || was >= 0 || remaining < was ? [{ caseId, over: -remaining }] : [];
  });
}
