import { InclusionRequired, start, use, type Inclusion, type Ledger, type Meta, type Process } from './ledger.ts';
import { own, quantityStepOf, type Masters } from './masters.ts';
import type { Basis } from './quantity.ts';
import { checkAssemblyRecipe } from './assembly-recipes.ts';
import { multiplyScalarByInteger, subtractScalar, sumScalars, validateScalar } from './scalar.ts';
import { recordUsageEstimate, type Supply } from './supply.ts';
import type { ReceiptTemplate } from './receipt-template.ts';

export type EstimateDecision = 'use' | 'exclude' | 'unresolved';
// uses はその明細で記録した使用の操作ID。confirmed はその数量の合計で、保存境界で使用記録と照合する。
export type EstimateRow = { calculated: number | null; confirmed: number | null; decision: EstimateDecision; uses: readonly string[] };
export type UsageEstimate = { startEventId: string; template: ReceiptTemplate; sets: number; rows: readonly EstimateRow[] };

export type Candidate = { item: string; unit: string; perSet: number; calculated: number | null; reason: string | null };
export type EstimateBasis = 'approximate' | 'counted';
export type EstimateUse = { lotId: string; basis: EstimateBasis; value: number; inclusion?: Inclusion };
export type EstimateInput = { decision: 'use' | 'exclude'; uses: readonly EstimateUse[] } | { decision: 'unresolved' };
export type ManualUse = { lotId: string; basis: Basis; value: number | null; inclusion?: Inclusion };
export type RecipeStart = {
  lot: Parameters<typeof start>[2]; process: Process; basis: Basis; value: number | null;
  // templateId が null なら推計せず、手入力の材料だけで作業を開始する（構成未登録、2.1）。
  templateId: string | null; rows: readonly EstimateInput[]; manual: readonly ManualUse[];
};

export const estimateUseLimit = 5;
export const manualUseLimit = 3;

// 包含の回答が要った使用の欄を画面へ伝える。kind と index は内訳（estimate）か手入力（manual）かとその位置。
export class EstimateInclusionRequired extends InclusionRequired {
  target: { kind: 'estimate'; row: number; use: number } | { kind: 'manual'; index: number };

  constructor(message: string, target: EstimateInclusionRequired['target']) {
    super(message);
    this.target = target;
  }
}

export const estimateUseEventId = (startEventId: string, n: number): string => `${startEventId}-u${n}`;
export const estimateEventId = (startEventId: string): string => `${startEventId}-e`;
// 作業の開始の材料の使用先。推計の使用は明細の番号を付ける。保存境界では、作業の開始のIDと工程から組み立てた文と完全一致で照らし、
// 手入力や旧版の作業の開始の使用先（番号なし）と取り違えない。
const estimateMarker = '・レシピ推計の明細';
const startUsedFor = (lotId: string, processId: string): string => `${lotId}の着手（工程${processId}）`;
const estimateNote = (usedFor: string, row: number): string => `${usedFor}${estimateMarker}${row + 1}`;
function usedForOf(begin: StartEvent): string {
  const stage = begin.changes.find((c) => c.before === null && c.after.id === begin.lotId)?.after.stage;
  return startUsedFor(begin.lotId, stage?.kind === 'working' ? stage.process.id : '');
}
function isEstimateNote(begin: StartEvent, usedFor: string): boolean {
  const head = `${usedForOf(begin)}${estimateMarker}`;
  return usedFor.startsWith(head) && /^[1-9][0-9]*$/.test(usedFor.slice(head.length));
}

// 台数は作業の開始の数量。数が不明・正の整数でない数からは算出しない（1.5）。製品単位は換算しない（1.6）。
export function estimateCandidates(masters: Masters, template: ReceiptTemplate, product: { item: string; unit: string }, sets: number | null): Candidate[] {
  if (template.product !== product.item) throw new Error('セットの製品が作業の開始の品目と異なる');
  if (template.productUnit === undefined) throw new Error('このセットは製品の単位を宣言していないので使用候補を出せない（セットの変更で製品の単位を選ぶ）');
  if (template.productUnit !== product.unit) throw new Error(`セットは製品1${template.productUnit}あたりの構成で、作業の開始の単位${product.unit}と異なる`);
  if (sets === null) throw new Error('作業の開始の数量が不明なので使用候補を出せない。台数を確かめて入力する');
  if (!Number.isSafeInteger(sets) || sets <= 0) throw new Error('台数（作業の開始の数量）は正の整数にする');
  checkAssemblyRecipe(template, masters, { allowLegacySelfReference: true });
  // 組立品の行もその品目そのものの候補にし、子構成へは展開しない（1.3）。
  return template.rows.map((row) => {
    const base = { item: row.item, unit: row.unit, perSet: row.perSet };
    // 品目・単位の登録は checkAssemblyRecipe が保証する。
    if (!own(masters.items, row.item)?.active) return { ...base, calculated: null, reason: '品目が利用停止中' };
    try {
      return { ...base, calculated: multiplyScalarByInteger(row.perSet, sets, quantityStepOf(masters, row.item, row.unit)), reason: null };
    } catch (error) {
      return { ...base, calculated: null, reason: `数量を算出できない（${error instanceof Error ? error.message : String(error)}）` };
    }
  });
}

type Lots = Ledger['lots'];
type Fail = (what: string) => never;
type HistoryEvent = Ledger['history'][number];
type UseEvent = Extract<HistoryEvent, { kind: 'use' }>;
type StartEvent = Extract<HistoryEvent, { kind: 'start' }>;
type EstimateEvent = Extract<Supply['log'][number], { kind: 'usageEstimate' }>;

function lotIn(lots: Lots, id: string) {
  const lot = own(lots, id);
  if (!lot) throw new Error(`保管単位 ${id} がない`);
  return lot;
}

// 同じ材料を推計と手入力の両方で減らさない（5.1）。使う明細と同じ品目・単位なら、その明細の位置を返す。
function overlappingRow(candidates: readonly Candidate[], decisions: readonly { decision: EstimateDecision }[], lot: { item: string; unit: string }): number {
  return decisions.findIndex((row, i) => row.decision === 'use' && candidates[i]!.item === lot.item && candidates[i]!.unit === lot.unit);
}

function checkEstimateInput(masters: Masters, lots: Lots, candidate: Candidate, row: EstimateInput, label: string): void {
  if (row.decision === 'unresolved') {
    if (candidate.calculated !== null) throw new Error(`${label}は算出できたので、使うか除外するかを選ぶ`);
    return;
  }
  if (row.decision === 'exclude') {
    if (row.uses.length > 0) throw new Error(`${label}は除外なので保管単位を選ばない`);
    return;
  }
  if (row.uses.length < 1 || row.uses.length > estimateUseLimit) throw new Error(`${label}の内訳は1〜${estimateUseLimit}件にする`);
  if (new Set(row.uses.map((u) => u.lotId)).size !== row.uses.length) throw new Error(`${label}の内訳で同じ保管単位を重ねて選ばない`);
  const step = quantityStepOf(masters, candidate.item, candidate.unit);
  for (const u of row.uses) {
    const lot = lotIn(lots, u.lotId);
    if (lot.item !== candidate.item || lot.unit !== candidate.unit) throw new Error(`${label}の保管単位 ${u.lotId} は品目・単位が候補と異なる`);
    if (u.basis !== 'approximate' && u.basis !== 'counted') throw new Error(`${label}の根拠はだいたいか数えたにする`);
    validateScalar(u.value, step);
    if (u.value <= 0) throw new Error(`${label}の使用数は正数にする`);
  }
}

function checkInputs(ledger: Ledger, candidates: readonly Candidate[], input: RecipeStart): void {
  if (input.rows.length !== candidates.length) throw new Error('使用候補を出し直す（セットの明細数と一致しない）');
  if (input.manual.length > manualUseLimit) throw new Error(`手入力の材料は${manualUseLimit}件までにする`);
  input.rows.forEach((row, i) => checkEstimateInput(ledger.masters, ledger.lots, candidates[i]!, row, `明細${i + 1}`));
  input.manual.forEach((m, k) => {
    const same = overlappingRow(candidates, input.rows, lotIn(ledger.lots, m.lotId));
    if (same >= 0) throw new Error(`手入力の材料${k + 1}は推計の明細${same + 1}と同じ品目・単位。どちらかの数量にするか、推計の内訳として入れる`);
  });
}

export function startWithEstimate(state: { ledger: Ledger; supply: Supply }, meta: Meta, input: RecipeStart): { ledger: Ledger; supply: Supply } {
  const template = input.templateId === null ? null : own(state.supply.receiptTemplates, input.templateId);
  if (template === undefined) throw new Error('セットを選ぶ');
  const candidates = template === null ? [] : estimateCandidates(state.ledger.masters, template, input.lot, input.basis === 'unknown' ? null : input.value);
  checkInputs(state.ledger, candidates, input);
  const usedFor = startUsedFor(input.lot.id, input.process.id);
  let ledger = state.ledger, n = 0;
  const materials: string[] = [];
  const record = (lotId: string, basis: Basis, value: number | null, note: string, inclusion: Inclusion | undefined, target: EstimateInclusionRequired['target']): string => {
    const eventId = estimateUseEventId(meta.eventId, ++n);
    try {
      ledger = use(ledger, { ...meta, eventId }, lotId, basis, value, note, inclusion);
    } catch (error) {
      if (error instanceof InclusionRequired) throw new EstimateInclusionRequired(error.message, target);
      throw error;
    }
    materials.push(eventId);
    return eventId;
  };
  const rows: EstimateRow[] = input.rows.map((row, i) => {
    const calculated = candidates[i]!.calculated;
    if (row.decision !== 'use') return { calculated, confirmed: null, decision: row.decision, uses: [] };
    const step = quantityStepOf(state.ledger.masters, candidates[i]!.item, candidates[i]!.unit);
    return { calculated, confirmed: sumScalars(row.uses.map((u) => u.value), step), decision: 'use',
      uses: row.uses.map((u, k) => record(u.lotId, u.basis, u.value, estimateNote(usedFor, i), u.inclusion, { kind: 'estimate', row: i, use: k })) };
  });
  input.manual.forEach((m, k) => record(m.lotId, m.basis, m.value, usedFor, m.inclusion, { kind: 'manual', index: k }));
  ledger = start(ledger, meta, input.lot, input.process, input.basis, input.value, materials);
  if (template === null) return { ledger, supply: state.supply };
  const supply = recordUsageEstimate(ledger, state.supply, { ...meta, eventId: estimateEventId(meta.eventId) }, { startEventId: meta.eventId, template, sets: input.value!, rows });
  return { ledger, supply };
}

// 推計の一つの使用を引き、品目・根拠と、減らした数量が保管単位の前後の差と一致するかを確かめる。
// 負数・後入力で保留した使用は、後で適用した確認事項を片付ける（resolve apply）の前後の差と照らす。
function recordedUse(ledger: Ledger, id: string, candidate: Candidate, note: string, fail: Fail): number {
  const u = ledger.history.find((x): x is UseEvent => x.eventId === id && x.kind === 'use');
  const lot = u === undefined ? undefined : own(ledger.lots, u.lotId);
  if (!u || u.usedFor !== note || (u.basis !== 'approximate' && u.basis !== 'counted') || u.value === null || !lot || lot.item !== candidate.item || lot.unit !== candidate.unit) return fail(`使用${id}`);
  const applied = u.applied ? u : ledger.history.find((x) => x.kind === 'resolve' && x.issueId === id && x.outcome === 'apply');
  const change = applied === u ? u.changes.find((c) => c.before?.id === u.lotId) : applied?.changes[0];
  const before = change?.before?.quantity, after = change?.after.quantity;
  if (before?.kind === 'known' && after?.kind === 'known' && subtractScalar(before.numeric.value, after.numeric.value, quantityStepOf(ledger.masters, candidate.item, candidate.unit)) !== u.value) fail(`使用${id}の数量`);
  return u.value;
}

function checkEstimateRow(ledger: Ledger, begin: StartEvent, candidate: Candidate, row: EstimateRow, index: number, sets: number, seen: Set<string>, fail: Fail): void {
  const step = quantityStepOf(ledger.masters, candidate.item, candidate.unit);
  if (row.calculated !== null && row.calculated !== multiplyScalarByInteger(candidate.perSet, sets, step)) fail('算出数量');
  if (row.decision === 'unresolved' && row.calculated !== null) fail('未確定');
  if (row.decision !== 'use' && row.uses.length > 0) fail('使用');
  if (row.decision === 'use' && (row.uses.length < 1 || row.uses.length > estimateUseLimit)) fail('内訳数');
  const values = row.uses.map((id) => {
    if (seen.has(id) || !begin.materials.includes(id)) fail(`使用${id}が作業の開始の材料にない`);
    seen.add(id);
    return recordedUse(ledger, id, candidate, estimateNote(usedForOf(begin), index), fail);
  });
  // 使用記録は作業の開始の材料なので取り消されず、数え直しでも変わらない。合計は記録時のまま一致する。
  if (row.confirmed !== (row.decision === 'use' ? sumScalars(values, step) : null)) fail('確定数量');
}

function checkEstimate(ledger: Ledger, e: EstimateEvent, fail: Fail): void {
  const begin = ledger.history.find((x): x is StartEvent => x.eventId === e.startEventId && x.kind === 'start');
  if (!begin) return fail('作業の開始がない');
  if (begin.actor !== e.actor || begin.occurredAt !== e.occurredAt || begin.recordedAt !== e.recordedAt) fail('担当者・日時');
  const created = begin.changes.find((c) => c.before === null && c.after.id === begin.lotId)?.after;
  if (!created || created.quantity.kind !== 'known' || created.quantity.numeric.value !== e.sets) return fail('台数');
  let candidates: Candidate[];
  try { candidates = estimateCandidates(ledger.masters, e.template, created, e.sets); } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
  if (e.rows.length !== candidates.length) fail('明細数');
  const seen = new Set<string>();
  e.rows.forEach((row, i) => checkEstimateRow(ledger, begin, candidates[i]!, row, i, e.sets, seen, (what) => fail(`明細${i + 1}の${what}`)));
  for (const id of begin.materials) {
    const u = seen.has(id) ? undefined : ledger.history.find((x) => x.eventId === id);
    const lot = u?.kind === 'use' ? own(ledger.lots, u.lotId) : undefined;
    if (u?.kind === 'use' && isEstimateNote(begin, u.usedFor)) fail(`推計の使用${id}が推計の明細にない`);
    if (lot && overlappingRow(candidates, e.rows, lot) >= 0) fail(`手入力の材料${id}が推計の明細と重なる`);
  }
}

// 保存境界で、推計の記録が作業の開始と使用記録に一致するかを確かめる（6.2）。
export function validateUsageEstimates(ledger: Ledger, supply: Supply): void {
  const starts = new Set<string>();
  // 推計の写しが記録時点のセットと一致するかを、セットの登録・変更・削除を履歴順にたどって確かめる。
  let templates: Record<string, string> = {};
  for (const e of supply.log) {
    if (e.kind === 'receiptTemplateSave') templates = { ...templates, [e.after.id]: JSON.stringify(e.after) };
    else if (e.kind === 'receiptTemplateDelete') templates = Object.fromEntries(Object.entries(templates).filter(([id]) => id !== e.before.id));
    if (e.kind !== 'usageEstimate') continue;
    const fail: Fail = (what) => { throw new Error(`セット推計 ${e.eventId} が作業の開始・使用の記録と一致しない（${what}）`); };
    if (e.eventId !== estimateEventId(e.startEventId)) fail('操作ID');
    if (own(templates, e.template.id) !== JSON.stringify(e.template)) fail('当時のセット');
    if (starts.has(e.startEventId)) fail('一つの作業の開始に推計が二つある');
    starts.add(e.startEventId);
    checkEstimate(ledger, e, fail);
  }
  // 推計の記録が欠けた作業の開始に、推計の使用だけが残っていないか。
  for (const begin of ledger.history) {
    if (begin.kind !== 'start' || starts.has(begin.eventId)) continue;
    const orphan = begin.materials.find((id) => ledger.history.some((x) => x.eventId === id && x.kind === 'use' && isEstimateNote(begin, x.usedFor)));
    if (orphan) throw new Error(`作業の開始 ${begin.eventId} の推計の使用${orphan}に、セット推計の記録がない`);
  }
}
