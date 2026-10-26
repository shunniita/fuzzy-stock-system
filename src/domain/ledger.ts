import { checkedConsumable, codeOwner, deepFreeze, practiceMasters, inScopeAt, inputStepOf, masterTypeDisplayLabel, own, perBoxAt, quantityStepOf, refOf, reservedCaseIds, unassignedCode, type ConsumableSetting, type LocationMaster, type Master, type Masters, type Source } from './masters.ts';
import { initialPackaging, checkTrialReview, effectiveFrom, masterOf, masterRef, registered, type NewMaster, type TrialReview } from './master-edit.ts';
import { add, observe, quantityOf, sameQuantity, subtract, type Basis, type Observation, type Quantity } from './quantity.ts';
import { sumScalarsFinal, validateScalar, type Step } from './scalar.ts';
import type { Scan } from './code.ts';
import { checkAlternativeSource, type AlternativeOperation, type AlternativeRecord, type AlternativeSource } from './alternative-record.ts';
import { captureItemLabels, type EventItemLabels } from './history-labels.ts';
import { ledgerEventItemIds, type ForwardOperationTargets } from './history-targets.ts';

// 手元の次工程の場所。工程に載った物は、ここへは移動でなく次工程への引渡しで渡す（MFG-06）。
export const nextProcessLocation = 'N';

// 未入力の案件・用途を共通在庫へ変換しないよう、共通と所属不明を別の値にする（MOD-02）。
export type Project = { kind: 'case'; id: string } | { kind: 'common' } | { kind: 'unassigned' };

// 使用対象から外す理由（OPS-06a）。usabilityCheckは使用可否の確認待ちで、数量未確認とは別の情報。
// spareは作業中の破損・紛失・不具合の交換用に取り置く予備（RET-01）。手元の総数には入るが、使うには交換として案件・用途用へ移す。
export const holdReasons = ['defective', 'usabilityCheck', 'returnPending', 'spare'] as const;
export type HoldReason = (typeof holdReasons)[number];

// 工程の完了基準（MFG-02、TBD-04）。inspectionなら作業終了のあと検査待ちを経て完成（渡す前）になる。
export type Process = { id: string; criterion: 'workEnd' | 'inspection' };

// TBD-04が確定するまではSCN-01・AT-40の架空工程を使う。
export const processes: readonly Process[] = [{ id: 'R組立', criterion: 'inspection' }];

// 工程上の位置（SCP-05）。所在・案件・用途・取り分けた理由とは別の属性で、許可された遷移の順に縛らない。
// none は工程に載っていない物（未使用の部品、次工程へ渡した物）。工程に載った物は未使用の部品として数えない（MFG-03c）。
export type Stage = { kind: 'none' } | { kind: 'working' | 'inspecting' | 'awaitingHandover'; process: Process };

export const noStage: Stage = Object.freeze({ kind: 'none' });

export type Lot = {
  id: string;
  item: string;
  // 同じ品目でも包装単位で数えたまとまりがあり、1箱あたりの数が分からなければ換算しない（QTY-07・SUP-01）。
  unit: string;
  project: Project;
  location: string;
  quantity: Quantity;
  // 使用・移動・まとめ直しでは変えない。まとめ直し後は、まとめる前のこのまとまりを数えた記録のまま（QTY-03）。
  lastCount: LastCount | null;
  splitFrom: string | null;
  // まとめ直し先。閉じたまとまりも元記録として残し、集計からだけ外す。
  mergedInto: string | null;
  // 理由が重なっても現物は一つのまとまりなので、除外数では一度だけ数える（OPS-06b）。
  holds: HoldReason[];
  stage: Stage;
};

// 日時は写しで持たず、訂正を反映したoccurredAtOfで引く。
export type LastCount = { value: number; eventId: string };

// 操作で生じる観測のIDはeventIdと同じにし、数量のtermsから入力した日時・担当者・対象へたどる。
export type Meta = { eventId: string; occurredAt: string | null; recordedAt: string; actor: string; scan?: Scan };

// 原因不明も正常な選択肢として確定できる（REC-01c）。記述は数量を変えない（REC-06）。
export type Cause = { kind: 'unknown' } | { kind: 'stated'; text: string };

// 手元から減らす操作。保留した操作を後から同じ引数で適用できるよう、引数をそのまま履歴に持つ。
export type Decrease = { lotId: string; basis: Basis; value: number | null } & (
  | { kind: 'use'; usedFor: string }
  | { kind: 'handover'; counterpart: string }
  | { kind: 'split'; childId: string }
  | { kind: 'transfer'; childId: string; from: Project; to: Project }
  | { kind: 'rework'; childId: string; reason: string; returnSource?: { adoptEventId: string; process: Process; confirmedPhysical: true } }
  // 一部の数量の工程上の位置を変える。分割と同じく、変えた分を子として分ける（MFG-01a）。
  // correction は訂正の入力で記録した変更。完了基準どおりの次の位置でも、完了・引渡しの実績には数えない。
  | { kind: 'stage'; childId: string; to: Stage; correction: boolean }
);

// 中断は工程内数の内訳で、影響台数を不足部品数から推定しない（MFG-08a・08b）。台数不明はnull。
export type Stop = {
  id: string;
  process: string;
  item: string;
  // 影響台数を比べる工程内数の単位。同じ品目でも単位の違う数とは比べない（QTY-07）。
  unit: string;
  project: Project;
  reason: string;
  // 不足数の単位は不足品目の管理単位が複数あり得るので、推定せず記録する（QTY-07）。
  shortage: { item: string; unit: string; value: number | null } | null;
  affected: number | null;
  // 材料の到着とは別に、作業の再開を記録した操作（MFG-08c）。
  resumedBy: string | null;
};

export type Outcome = 'apply' | 'close';

// 最後に数えた数より後と言えない操作が、その確認に含まれていたか（REC-03b）。利用者が答える。
export type Inclusion = 'included' | 'notIncluded' | 'unknown';

// 画面が回答欄を出して同じ入力を再送できるよう、回答の不足を他の入力誤りと区別する。
export class InclusionRequired extends Error {}

// 適用先のまとまりを特定できない増減・現物（REC-04a・07b）。適用済みの台帳には足さない。
export type ProvisionalContent = {
  direction: 'found' | 'removed';
  item: string | null;
  location: string | null;
  basis: Basis;
  value: number | null;
  note: string;
};

export type EventDetail =
  | AlternativeRecord
  | { kind: 'register' | 'move' | 'merge' }
  // 登録情報の変更（ADR-024）。mastersは変えた登録情報の前後で、既存IDの付替えでは相手と自分の二組。confirmedは衝突・食い違いを確認した記録。
  | { kind: 'master'; action: Exclude<MasterRequest['action'], 'trial'>; reason: string | null; confirmed: boolean; masters: MasterChange[] }
  | { kind: 'master'; action: 'trial'; reason: string; confirmed: false; masters: MasterChange[]; review: TrialReview | null }
  // 見つかった物の仮の記録を、既存のまとまりと同じ現物として対応付けた（数量は足さない）。仮の記録の確認事項を閉じる（MST-07）。
  | { kind: 'identify'; issueId: string; lotId: string; reason: string }
  // 見つかった物の仮の記録を、別の現物と確認して新しいまとまりにした。実際の日時は仮の記録の実際の日時（MST-07）。
  | { kind: 'adopt'; issueId: string; lotId: string }
  // 案件・用途が不明なまとまりを、案件・用途または共通在庫へ結び付けた。数量と根拠は変えない（MST-07、MOD-02）。
  | { kind: 'assignProject'; lotId: string; before: Project; after: Project; reason: string }
  // answeredFor は包含の回答が対象にした操作。それ以外の反映済みの操作は時刻順で前と判断した。
  // 未適用なら changes が空なので、対象・数えた値・差異を求めた相手の数量をここに残す（CHK-03の未反映内容）。
  | {
      kind: 'recount';
      lotId: string;
      value: number;
      compared: Quantity;
      cause: Cause;
      difference: Quantity;
      applied: boolean;
      inclusion: Inclusion | null;
      answeredFor: string[];
    }
  // note は付与・解除の理由の記述。予備を案件・用途用へ移す（交換）ときは必須。
  | { kind: 'hold' | 'release'; reason: HoldReason; note: string | null }
  // countedBy は負数・差異申告を閉じる根拠にした数え直し。日時の訂正でも、事項のもとの操作より前にならないよう守る。
  | { kind: 'resolve'; issueId: string; outcome: Outcome; inclusion: Inclusion | null; countedBy: string | null }
  | { kind: 'correctTime'; targetEventId: string; previous: string | null; corrected: string | null }
  | { kind: 'declare'; lotId: string; note: string }
  | ({ kind: 'provisional' } & ProvisionalContent)
  // materials は作業の開始に使った材料の使用記録。完了や位置の変更では材料を再び消費しない（MFG-03a・03b）。
  | { kind: 'start'; lotId: string; materials: string[] }
  // subjectLotId は処置を実際に行った枝。これより前の記録にはなく、推測で補わない（ADR-039の3）。
  | ({ kind: 'reworkPart'; reworkId: string; subjectLotId?: string; reason: string } & (
      | { action: 'replace'; useEventId: string }
      | { action: 'recover'; registerEventId: string }
      | { action: 'discard'; item: string; unit: string; value: number }
    ))
  // 間違えた記録の取り消し（REC-02a）。applied は数量を戻したか。数え直しが誤りの後の数量を置き換えていれば戻さない。
  | { kind: 'void'; targetEventId: string; lotId: string; reason: string; applied: boolean }
  | { kind: 'stop'; stop: Stop }
  | { kind: 'stopUpdate'; stopId: string; previous: number | null; affected: number | null }
  | { kind: 'resume'; stopId: string }
  // applied は親から減らしたか。分割の子は applied にかかわらず作られている。
  | (Decrease & { applied: boolean; inclusion: Inclusion | null });

export type LedgerEvent = Meta & EventDetail & { changes: { before: Lot | null; after: Lot }[]; itemLabels: EventItemLabels };

export type IssueReason = 'negative' | 'lateEntry' | 'declared' | 'unassigned' | 'timeCorrected';

export type Resolution = { eventId: string; outcome: Outcome; actor: string };

// 確認事項のIDは、事項を開いた操作のIDと同じにする。未反映の内容はその操作の履歴にある（CHK-03）。
export type Issue = { id: string; lotId: string | null; reason: IssueReason; resolution: Resolution | null };

// 登録情報は「自部署用の参照台帳」（v0.2の02章）として台帳に持ち、変更は履歴の記録にする（ADR-024）。
export type Ledger = {
  lots: Readonly<Record<string, Lot>>;
  history: readonly LedgerEvent[];
  issues: Readonly<Record<string, Issue>>;
  stops: Readonly<Record<string, Stop>>;
  masters: Masters;
};

export { deepFreeze };

// 利用者の台帳は登録情報も空から始める。架空の登録情報は練習用と試験で明示して使う。
export const emptyLedger: Ledger = deepFreeze({ lots: {}, history: [], issues: {}, stops: {}, masters: { items: {}, locations: {}, cases: {}, actors: {} } });
export const practiceLedger: Ledger = deepFreeze({ lots: {}, history: [], issues: {}, stops: {}, masters: practiceMasters });

const timestamp = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

// 時刻帯のない日時は端末の設定で意味が変わるため、時刻帯付きだけを受け付ける（NFR-08a）。
// Date.parseは2月30日を3月2日へ読み替えるなど寛容なので、形式と暦の正しさを自前で確かめる。
export function checkTime(value: string | null, label: string): void {
  if (value === null) return;
  const [, y, mo, d, h, mi, sec = '0', oh = '0', om = '0'] = timestamp.exec(value) ?? [];
  const valid =
    y !== undefined &&
    new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d))).toISOString().slice(0, 10) === `${y}-${mo}-${d}` &&
    Number(h) < 24 &&
    Number(mi) < 60 &&
    Number(sec) < 60 &&
    Number(oh) <= 14 &&
    Number(om) < 60;
  if (!valid) throw new Error(`${label}の日時「${value}」は時刻帯付きの正しい日時で入力する`);
}

// 検査をすべて済ませてから新しい台帳を作るので、失敗時は元の台帳が無傷のまま残る（DAT-04）。
function commit(ledger: Ledger, detail: EventDetail, meta: Meta, lots: Lot[], issues: Issue[] = [], stops: Stop[] = [], masters: Masters = ledger.masters, forward?: ForwardOperationTargets): Ledger {
  if (ledger.history.some((e) => e.eventId === meta.eventId)) throw new Error(`操作ID ${meta.eventId} は使用済み`);
  checkTime(meta.occurredAt, '発生');
  checkTime(meta.recordedAt, '記録');
  // 登録のない名前は通す（担当者の登録を持たない呼び出しがある）。利用停止中の担当者は、新しい記録の担当者にしない（MST-03）。
  const actor = own(ledger.masters.actors, meta.actor);
  if (actor && !actor.active) throw new Error(`担当者 ${meta.actor} は利用停止中`);
  // 既存の事項に許す変更は、未解決から解消への一度だけ。それ以外の同じIDは作成でも上書きでも拒否する（CHK-03）。
  for (const issue of issues) {
    const existing = ledger.issues[issue.id];
    if (existing && !(existing.resolution === null && issue.resolution !== null)) {
      throw new Error(`確認事項ID ${issue.id} は使用済み`);
    }
  }
  const next = { ...ledger.lots };
  for (const lot of lots) next[lot.id] = lot;
  const nextIssues = { ...ledger.issues };
  for (const issue of issues) nextIssues[issue.id] = issue;
  const nextStops = { ...ledger.stops };
  for (const stop of stops) nextStops[stop.id] = stop;
  const changes = lots.map((after) => ({ before: ledger.lots[after.id] ?? null, after }));
  const event = { ...meta, ...detail, changes };
  const itemLabels = captureItemLabels(masters, ledgerEventItemIds(event, { ledger: { ...ledger, lots: next, issues: nextIssues, stops: nextStops }, supply: null }, forward));
  const result = deepFreeze({
    lots: next,
    history: [...ledger.history, { ...event, itemLabels }],
    issues: nextIssues,
    stops: nextStops,
    masters,
  });
  keepScopeOut(ledger, result);
  if (touchesReworkSubject(result, detail.kind, lots)) checkReworkSubjects(result);
  return result;
}

// 対応する物理操作と同じ保存単位に含めるための途中状態。証拠だけでは保存検査を通らない。
export function beginAlternativeRecord(ledger: Ledger, meta: Meta, operation: AlternativeOperation, source: AlternativeSource, targetItemIds: readonly string[]): Ledger {
  checkAlternativeSource(source);
  const existing = ledger.history.find(e => e.kind === 'alternativeRecord' && e.source.source === source.source && e.source.entry === source.entry);
  if (existing?.kind === 'alternativeRecord') throw new Error(`この元の資料は記録済み（対応する操作 ${existing.operationId}）。未処理分は既存の照合・再割り当て・保存中操作を確認する`);
  if (ledger.history.some(e => e.eventId === meta.eventId)) throw new Error(`操作ID ${meta.eventId} は使用済み`);
  return commit(ledger, { kind: 'alternativeRecord', operation, operationId: meta.eventId, source: { ...source } }, { ...meta, eventId: `${meta.eventId}-alternative` }, [], [], [], ledger.masters, { operationId: meta.eventId, itemIds: targetItemIds });
}

function open(ledger: Ledger, id: string): Lot {
  const lot = ledger.lots[id];
  if (!lot) throw new Error(`保管単位 ${id} がない`);
  if (lot.mergedInto !== null) throw new Error(`保管単位 ${id} は ${lot.mergedInto} へ統合済み`);
  return lot;
}

function countOf(eventId: string, basis: Basis, value: number | null): LastCount | null {
  return basis === 'counted' && value !== null ? { value, eventId } : null;
}

// 新しい置き場所は、実際の日時（不明なら入力した日時）の時点で記録の対象の、利用中の場所だけ（SCP-02a・02b、MST-03）。
// 外OUTは置き場所ではなく、引渡しの相手先として履歴にだけ残る。
function placeable(ledger: Ledger, location: string, meta: Pick<Meta, 'occurredAt' | 'recordedAt'>): void {
  const place = own(ledger.masters.locations, location);
  if (!place) throw new Error(`場所 ${location} は手元の管理場所ではない`);
  if (!place.active) throw new Error(`場所 ${place.code} は利用停止中`);
  inScope(place, meta.occurredAt ?? meta.recordedAt);
}

function inScope(place: LocationMaster, at: string): void {
  if (!inScopeAt(place, at)) throw new Error(`場所 ${place.code} は ${at} の時点で記録の対象外`);
}

// 新しい記録の品目・案件・用途は、登録済みで利用中のものだけ（MST-03）。既存のまとまりへの操作と訂正は止めない。
function usableItem(ledger: Ledger, item: string): void {
  const master = own(ledger.masters.items, item);
  if (!master) throw new Error(`品目 ${item} は登録されていない`);
  if (!master.active) throw new Error(`品目 ${master.code ?? master.name} は利用停止中`);
}

function usableProject(ledger: Ledger, project: Project): void {
  if (project.kind !== 'case') return;
  const master = own(ledger.masters.cases, project.id);
  if (!master) throw new Error(`案件・用途 ${project.id} は登録されていない`);
  if (!master.active) throw new Error(`案件・用途 ${master.code ?? master.name ?? project.id} は利用停止中`);
}

// 位置を保ったまま次工程Nに置くと、現物は次工程にあるのに完成（渡す前）や作業中のままで、引渡済みにも数えられない。
// 次工程へは次工程への引渡しで渡す（MFG-06）。
function notStagedAtNextProcess(lotId: string, stage: Stage, location: string, guidance = '次工程への引渡しで記録する'): void {
  if (stage.kind !== 'none' && location === nextProcessLocation) {
    throw new Error(`保管単位 ${lotId} は製造中・完成（渡す前）になるので、次工程${nextProcessLocation}には置けない。${guidance}`);
  }
}

function unused(ledger: Ledger, id: string): void {
  if (ledger.lots[id]) throw new Error(`保管単位ID ${id} は使用済み`);
}

type NewLot = Pick<Lot, 'id' | 'item' | 'unit' | 'project' | 'location'>;


function observeFor(ledger: Ledger, ref: Pick<Lot, 'item' | 'unit'>, id: string, basis: Basis, value: number | null): Observation {
  return observe(id, basis, value, inputStepOf(ledger.masters, ref.item, ref.unit, value));
}

function newLot(ledger: Ledger, meta: Meta, lot: NewLot, stage: Stage, basis: Basis, value: number | null): Lot {
  required(lot.id, '保管単位のID');
  unused(ledger, lot.id);
  placeable(ledger, lot.location, meta);
  usableItem(ledger, lot.item);
  usableProject(ledger, lot.project);
  notStagedAtNextProcess(lot.id, stage, lot.location);
  required(lot.unit, '単位');
  const quantity = quantityOf(observeFor(ledger, lot, meta.eventId, basis, value));
  const lastCount = countOf(meta.eventId, basis, value);
  return { ...lot, project: { ...lot.project }, quantity, lastCount, splitFrom: null, mergedInto: null, holds: [], stage: copyStage(stage) };
}

function copyStage(stage: Stage): Stage {
  return stage.kind === 'none' ? noStage : { kind: stage.kind, process: { ...stage.process } };
}

// 開始時点の仕掛品・工程完了品も、過去の作業の開始を作らずその位置で登録できる（RUN-02）。
export function register(ledger: Ledger, meta: Meta, lot: NewLot & { stage?: Stage }, basis: Basis, value: number | null): Ledger {
  const { stage = noStage, ...rest } = lot;
  return commit(ledger, { kind: 'register' }, meta, [newLot(ledger, meta, rest, stage, basis, value)]);
}

// 作業を開始した数量を作業中の新しいまとまりにする。材料は別に記録した使用を対応付けるだけで、ここでは減らさない。
// 材料の使用と作業の開始を一つの入力で記録するときは、画面が順に適用して最後に一度だけ台帳へ代入する（DAT-04）。
export function start(ledger: Ledger, meta: Meta, lot: NewLot, process: Process, basis: Basis, value: number | null, materials: string[]): Ledger {
  required(process.id, '工程');
  for (const id of materials) {
    const e = ledger.history.find((x) => x.eventId === id);
    if (e?.kind !== 'use') throw new Error(`材料の使用記録 ${id} がない`);
    if (isVoided(ledger, id)) throw new Error(`材料の使用記録 ${id} は記録誤りとして取消済み`);
    if (startOfMaterial(ledger, id)) throw new Error(`材料の使用記録 ${id} は別の作業の開始に対応付け済み`);
    if (isAfter(occurredAtOf(ledger, id), meta.occurredAt)) throw new Error(`材料の使用記録 ${id} は作業の開始より後の日時なので、この作業の開始には対応付けない`);
  }
  if (new Set(materials).size !== materials.length) throw new Error('同じ材料の使用記録を重ねて対応付けない');
  const created = newLot(ledger, meta, lot, { kind: 'working', process }, basis, value);
  return commit(ledger, { kind: 'start', lotId: lot.id, materials: [...materials] }, meta, [created]);
}

export function startOfMaterial(ledger: Ledger, useEventId: string): LedgerEvent | undefined {
  return ledger.history.find((e) => (e.kind === 'start' && e.materials.includes(useEventId)) || (e.kind === 'reworkPart' && e.action === 'replace' && e.useEventId === useEventId));
}

function isVoided(ledger: Ledger, eventId: string): boolean {
  return ledger.history.some((e) => e.kind === 'void' && e.targetEventId === eventId);
}

// 空のメモは記述なしとして扱う。
function noteOf(note: string | undefined): string | null {
  return note === undefined || note.trim() === '' ? null : note;
}

function required(text: string, label: string): void {
  if (text.trim() === '') throw new Error(`${label}を入力する`);
}

// 親から減らした結果。負になるならnull。数が不明を含む計算は負と判定できないので、そのまま適用する。
function decreased(ledger: Ledger, lot: Lot, taken: Quantity): Lot | null {
  const quantity = subtract(lot.quantity, taken, quantityStepOf(ledger.masters, lot.item, lot.unit));
  return quantity.kind === 'known' && quantity.numeric.value < 0 ? null : { ...lot, quantity };
}

function isDecreaseEvent(e: LedgerEvent): e is LedgerEvent & Decrease & { applied: boolean; inclusion: Inclusion | null } {
  return e.kind === 'use' || e.kind === 'handover' || e.kind === 'split' || e.kind === 'stage' || e.kind === 'transfer' || e.kind === 'rework';
}

// 工程内の物は、外へ直接渡すと位置の変更を飛ばして現物が消える。完成（渡す前）にしてから渡す（MFG-01a）。
function handoverBlocked(lot: Lot): string | null {
  return lot.stage.kind === 'working' || lot.stage.kind === 'inspecting' ? '工程内にある。外へ渡すなら先に完成（渡す前）にする' : null;
}

function unusableReason(lot: Lot): string | null {
  if (lot.holds.includes('spare')) return '予備なので、使うなら先に交換として案件・用途用へ移す（予備を外す操作に、交換の理由を書く）';
  if (lot.holds.length > 0) return `取り分け中（${lot.holds.join('・')}）`;
  if (lot.stage.kind !== 'none') return '製造中・完成（渡す前）（完了・引渡しは作業の状態の変更で記録する）';
  return null;
}

function isAfter(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && Date.parse(a) > Date.parse(b);
}

// 分割・位置の変更・作業の開始でできたまとまりに、できる前と言える日時の操作は、数えた記録の有無や後の数え直しにかかわらず記録しない。
// 元のまとまりに記録させる。できた操作を返す（登録でできたまとまりはundefined）。
function notBeforeCreation(ledger: Ledger, lot: Lot, occurredAt: string | null): LedgerEvent | undefined {
  const recovered = recoveredRegisters(ledger);
  const creation = creationOf(ledger, lot.id);
  if (!creation || createdLotId(creation, recovered) !== lot.id) return undefined;
  if (creation && isAfter(occurredAtOf(ledger, creation.eventId), occurredAt)) {
    throw new Error(`保管単位 ${lot.id} ができる前の操作は、この保管単位には記録しない。元の保管単位に記録する`);
  }
  return creation;
}

// 最後に数えた数より後と言えない操作（前・同時・日時不明）は、時刻順だけで包含を決めず回答を求める（NFR-08b）。
// 後と言えるなら回答は記録しない。
// 分割・位置の変更・作業の開始でできたまとまりは、その時の数えた記録が最後の確認なら、それより前の操作はあり得ない。
// 同じ時刻の次の段階（作業終了20の直後の確認の完了18など）で回答を求めると、「20の中にいた」と読んで
// 「含まれていた」と答えやすく、親を減らさずに子を作って現物を二重に数える。登録は既にある物を数えるので除く。
function inclusionOf(ledger: Ledger, lot: Lot, occurredAt: string | null, answer: Inclusion | undefined): Inclusion | null {
  const creation = notBeforeCreation(ledger, lot, occurredAt);
  if (lot.lastCount === null || creation?.eventId === lot.lastCount.eventId) return null;
  if (isAfter(occurredAt, occurredAtOf(ledger, lot.lastCount.eventId))) return null;
  if (answer === undefined) throw new InclusionRequired('最後に数えた数に含まれていたかを指定する');
  return answer;
}

// 負数になる操作は台帳を変えずに未適用で残し、確認事項を開く（REC-05・ADR-006）。0への丸めや架空の受け取りはしない。
// 保留・包含の対象は親から減らすことだけ。分割の子は現物として確かにあるので、どの場合も記録時に作る。
function decrease(ledger: Ledger, meta: Meta, d: Decrease, answer?: Inclusion): Ledger {
  const lot = open(ledger, d.lotId);
  const taken = quantityOf(observeFor(ledger, lot, meta.eventId, d.basis, d.value));
  const unusable = d.kind === 'use' ? unusableReason(lot) : d.kind === 'handover' ? handoverBlocked(lot) : null;
  if (unusable) throw new Error(`保管単位 ${d.lotId} は${unusable}`);
  if (d.kind === 'split' || d.kind === 'stage') {
    required(d.childId, '分けた分のID');
    unused(ledger, d.childId);
  }
  if (d.kind === 'stage') {
    checkStageChange(lot.stage, d.to);
    notStagedAtNextProcess(d.childId, d.to, lot.location);
  }
  const children: Lot[] =
    d.kind === 'split' || d.kind === 'stage'
      ? [
          {
            ...lot,
            id: d.childId,
            quantity: taken,
            lastCount: countOf(meta.eventId, d.basis, d.value),
            splitFrom: lot.id,
            mergedInto: null,
            stage: d.kind === 'stage' ? copyStage(d.to) : lot.stage,
          },
        ]
      : [];
  const inclusion = inclusionOf(ledger, lot, meta.occurredAt, answer);
  if ((d.kind === 'split' || d.kind === 'stage') && reworksOf(ledger, lot.id).length > 0) confirmedDecrease(ledger, lot, taken, inclusion);
  const record = (appliedToParent: boolean, lots: Lot[], reason?: IssueReason): Ledger =>
    commit(
      ledger,
      { ...d, applied: appliedToParent, inclusion },
      meta,
      lots,
      reason ? [{ id: meta.eventId, lotId: d.lotId, reason, resolution: null }] : [],
    );
  if (inclusion === 'included') return record(false, children);
  if (inclusion === 'unknown') return record(false, children, 'lateEntry');
  const parent = decreased(ledger, lot, taken);
  return parent === null ? record(false, children, 'negative') : record(true, [parent, ...children]);
}

export function use(
  ledger: Ledger,
  meta: Meta,
  lotId: string,
  basis: Basis,
  value: number | null,
  usedFor: string,
  inclusion?: Inclusion,
): Ledger {
  required(usedFor, '使用先の案件・用途・作業');
  return decrease(ledger, meta, { kind: 'use', lotId, basis, value, usedFor }, inclusion);
}

// 実際に渡した数量だけを減らす。予定の登録では呼ばない（OPS-07）。
export function handOver(
  ledger: Ledger,
  meta: Meta,
  lotId: string,
  basis: Basis,
  value: number | null,
  counterpart: string,
  inclusion?: Inclusion,
): Ledger {
  required(counterpart, '引渡しの相手先または処置');
  return decrease(ledger, meta, { kind: 'handover', lotId, basis, value, counterpart }, inclusion);
}

// 取り出し分の根拠は利用者が指定する。数えて取り出したときだけ子が数えたになる（QTY-10a・10b）。
export function split(
  ledger: Ledger,
  meta: Meta,
  lotId: string,
  childId: string,
  basis: Basis,
  value: number | null,
  inclusion?: Inclusion,
): Ledger {
  return decrease(ledger, meta, { kind: 'split', lotId, basis, value, childId }, inclusion);
}

// 所属を書き換えると過去の使用も先案件・用途へ移ってしまうため、融通した分を子として記録する。
// 分割の保留と違い、親を減らせない間は子を作らない（OPS-04a、部署合計不変）。
export function transferProject(ledger: Ledger, meta: Meta, lotId: string, childId: string, to: Project, basis: Basis, value: number | null, answer?: Inclusion): Ledger {
  const lot = open(ledger, lotId);
  if (lot.project.kind !== 'case' || to.kind !== 'case' || sameProject(lot.project, to)) throw new Error('振替は異なる案件・用途の間で記録する。共通在庫・所属不明は対象にしない');
  usableProject(ledger, to);
  required(childId, '振替した分の新しいID');
  unused(ledger, childId);
  const unusable = unusableReason(lot);
  if (unusable) throw new Error(`保管単位 ${lotId} は${unusable}`);
  if (openIssuesOf(ledger, lotId).length > 0) throw new Error('元の保管単位に未解決の確認事項がある。先に数量を確認する');
  const taken = quantityOf(observeFor(ledger, lot, meta.eventId, basis, value));
  if (lot.quantity.kind !== 'known' || taken.kind !== 'known' || taken.numeric.value <= 0) throw new Error('振替には元の数量と正の振替数量が必要。不明なら先に数量を確認する');
  const inclusion = inclusionOf(ledger, lot, meta.occurredAt, answer);
  if (inclusion === 'included' || inclusion === 'unknown') throw new Error('振替を親から減らせるか確認が必要。元の数量・所属を確認してから記録する');
  const parent = decreased(ledger, lot, taken);
  if (parent === null) throw new Error('振替すると元の残数が負になる。先に数量を確認する');
  const from = { ...lot.project };
  const destination = { ...to };
  const child: Lot = { ...lot, id: childId, project: destination, quantity: taken, lastCount: countOf(meta.eventId, basis, value), splitFrom: lot.id, mergedInto: null };
  return commit(ledger, { kind: 'transfer', lotId, childId, from, to: destination, basis, value, applied: true, inclusion }, meta, [parent, child]);
}

// 作業終了・確認の完了・次工程への引渡しと、位置の誤りの訂正を同じ操作で記録する。
// どの位置からどの位置へも変えられ、決まった順に通ることを記録の条件にしない（SCP-05）。
export function changeStage(
  ledger: Ledger,
  meta: Meta,
  lotId: string,
  childId: string,
  basis: Basis,
  value: number | null,
  to: Stage,
  inclusion?: Inclusion,
  correction = false,
): Ledger {
  return decrease(ledger, meta, { kind: 'stage', lotId, basis, value, childId, to, correction }, inclusion);
}

// 工程の違う位置へ移すと、どちらの工程の完了累計にも数えられないので、作業なしを経由させる。
function checkStageChange(from: Stage, to: Stage): void {
  if (to.kind === 'inspecting' && to.process.criterion !== 'inspection') throw new Error(`工程 ${to.process.id} は検査を完了基準にしていない`);
  if (sameStage(from, to)) throw new Error('変更前と変更後の作業の状態が同じ');
  if (from.kind !== 'none' && to.kind !== 'none' && from.process.id !== to.process.id) {
    throw new Error('別の工程の位置へは直接変えない。先に作業なしにする');
  }
}

// 完了基準に従った次の位置。検査を基準にする工程だけが検査待ちを持つ（MFG-02）。作業なしからの作業の開始はstartで記録する。
export function nextStage(stage: Stage): Stage | null {
  switch (stage.kind) {
    case 'none':
      return null;
    case 'working':
      return { kind: stage.process.criterion === 'inspection' ? 'inspecting' : 'awaitingHandover', process: stage.process };
    case 'inspecting':
      return { kind: 'awaitingHandover', process: stage.process };
    case 'awaitingHandover':
      return noStage;
  }
}

// 数が不明の箱も丸ごと移すだけで、U−Uの計算をしない。
export function move(ledger: Ledger, meta: Meta, lotId: string, location: string): Ledger {
  const lot = open(ledger, lotId);
  notBeforeCreation(ledger, lot, meta.occurredAt);
  if (lot.location === location) throw new Error('移動元と移動先が同じ');
  placeable(ledger, location, meta);
  notStagedAtNextProcess(lotId, lot.stage, location);
  return commit(ledger, { kind: 'move' }, meta, [{ ...lot, location }]);
}

function sameProject(a: Project, b: Project): boolean {
  return a.kind === b.kind && (a.kind !== 'case' || (b.kind === 'case' && a.id === b.id));
}

// 場所違いは黙って移動させず、先にmoveを求める。
export function merge(ledger: Ledger, meta: Meta, sourceId: string, targetId: string): Ledger {
  if (sourceId === targetId) throw new Error('同じ保管単位は統合できない');
  const source = open(ledger, sourceId);
  const target = open(ledger, targetId);
  notBeforeCreation(ledger, source, meta.occurredAt);
  notBeforeCreation(ledger, target, meta.occurredAt);
  if (source.item !== target.item) throw new Error('品目が違う保管単位は統合できない');
  if (source.unit !== target.unit) throw new Error('単位が違う保管単位は統合できない');
  if (!sameProject(source.project, target.project)) throw new Error('案件・用途が違う保管単位は統合できない');
  if (source.location !== target.location) throw new Error('場所が違う保管単位は統合できない');
  if (source.holds.join() !== target.holds.join()) throw new Error('取り分けた理由が違う保管単位は統合できない');
  if (!sameStage(source.stage, target.stage)) throw new Error('作業の状態が違う保管単位は統合できない');
  if (source.stage.kind !== 'none' && target.stage.kind !== 'none' && source.stage.process.criterion !== target.stage.process.criterion) throw new Error('工程の完了基準が違う保管単位は統合できない');
  // まとめ直すと、確認事項の対象と未反映の操作の関係が崩れる。先に解消する。
  for (const lot of [source, target]) {
    if (openIssuesOf(ledger, lot.id).length > 0) throw new Error(`保管単位 ${lot.id} には未解決の確認事項がある`);
  }
  // まとめ直した先の箱は一つの1箱あたりの数で換算するので、受け取りのときの1箱あたりの数が違う箱を混ぜない（要件6.7）。
  const created = creationsOf(ledger);
  if (perBoxOfLot(ledger, source, created) !== perBoxOfLot(ledger, target, created)) throw new Error('受け取りのときの1箱あたりの数が違う箱は統合できない');
  return commit(ledger, { kind: 'merge' }, meta, [
    { ...source, mergedInto: targetId },
    { ...target, quantity: add(target.quantity, source.quantity, quantityStepOf(ledger.masters, target.item, target.unit)) },
  ]);
}

// まとまり全体に理由を付ける。一部だけなら先にsplitで分ける。
export function hold(ledger: Ledger, meta: Meta, lotId: string, reason: HoldReason, note?: string): Ledger {
  const lot = open(ledger, lotId);
  notBeforeCreation(ledger, lot, meta.occurredAt);
  if (lot.holds.includes(reason)) throw new Error(`保管単位 ${lotId} には既に ${reason} が付いている`);
  const holds = holdReasons.filter((r) => r === reason || lot.holds.includes(r));
  return commit(ledger, { kind: 'hold', reason, note: noteOf(note) }, meta, [{ ...lot, holds }]);
}

// 使用可否の確認が済んだ等で理由を外す。除外中の使用は、外してから記録する。
export function release(ledger: Ledger, meta: Meta, lotId: string, reason: HoldReason, note?: string): Ledger {
  const lot = open(ledger, lotId);
  notBeforeCreation(ledger, lot, meta.occurredAt);
  if (!lot.holds.includes(reason)) throw new Error(`保管単位 ${lotId} には ${reason} が付いていない`);
  if (reason === 'spare') required(note ?? '', '予備を案件・用途用へ移す交換の理由');
  return commit(ledger, { kind: 'release', reason, note: noteOf(note) }, meta, [{ ...lot, holds: lot.holds.filter((h) => h !== reason) }]);
}

function sameStage(a: Stage, b: Stage): boolean {
  return a.kind === b.kind && (a.kind === 'none' || (b.kind !== 'none' && a.process.id === b.process.id));
}

// 使用可能な未使用の物。取り分けた理由がなく、工程に載っていない（MFG-03c）。
export function isUsable(lot: Lot): boolean {
  return unusableReason(lot) === null;
}

// 数量を変えた操作の実際の日時を引くID。保留の解消による適用は元の操作の日時に起きたものとして扱い、
// 間違えた記録の取り消しは、取り消した操作の日時に遡って数量を戻したものとして扱う。
function opIdOf(e: LedgerEvent): string {
  return e.kind === 'resolve' ? e.issueId : e.kind === 'void' ? e.targetEventId : e.eventId;
}

// 今の数量に反映されている操作。最後に数えた数（なければ最初）から後で、このまとまりの数量を変えたもの。
// 保存の復号で参照が変わるため、数値・根拠・元の観測の内容で数量の変化を判定する。
// 取り消された操作は、取消と対で打ち消し合っていて起きなかったものとして扱う。記録は履歴に残る。
// 順序の判定（数え直しの包含）や数量の引き直しでは、この対を除いて見る。
// まとめ直しの元で取り消した操作は、まとめ直し先の履歴に取消だけがあるので、対は履歴全体で探す。
function withoutCancelled(ledger: Ledger, chain: readonly LedgerEvent[]): LedgerEvent[] {
  const cancelled = new Set(ledger.history.filter((e) => e.kind === 'void').map(opIdOf));
  return chain.filter((e) => !cancelled.has(opIdOf(e)));
}

function reflectedIn(history: readonly LedgerEvent[], lot: Lot): LedgerEvent[] {
  const start = lot.lastCount ? history.findIndex((e) => e.eventId === lot.lastCount?.eventId) : 0;
  return history.slice(start).filter((e) => e.changes.some((c) => c.after.id === lot.id
    && (c.before === null || !sameQuantity(c.before.quantity, c.after.quantity))));
}

// まとまり全体を数えた結果を新しい基準にする。旧数量はこの操作の履歴のbeforeに残る（QTY-11a）。
// 差異は減算規則で求めるので、訂正前が不明なら差異も不明になる。
// 今の数量に反映済みの操作より後と言えない数え直しは、置き換えると後の操作を消しうるので回答を求める（REC-03b・NFR-08b）。
// 含まれていなかった・不明なら、正しい数を自動では求めず、記録だけ残して確認事項を開く。
export function recount(ledger: Ledger, meta: Meta, lotId: string, value: number, cause: Cause, answer?: Inclusion): Ledger {
  const lot = open(ledger, lotId);
  notBeforeCreation(ledger, lot, meta.occurredAt);
  if (cause.kind === 'stated') required(cause.text, '原因の記述');
  const quantity = quantityOf(observeFor(ledger, lot, meta.eventId, 'counted', value));
  const difference = subtract(quantity, lot.quantity, quantityStepOf(ledger.masters, lot.item, lot.unit));
  const unordered = withoutCancelled(ledger, reflectedIn(ledger.history, lot)).filter((e) => !isAfter(meta.occurredAt, occurredAtOf(ledger, opIdOf(e))));
  if (unordered.length > 0 && answer === undefined) {
    throw new InclusionRequired(`反映済みの操作（${unordered.map(opIdOf).join('・')}）がこの数え直しに含まれていたかを指定する`);
  }
  const inclusion = unordered.length > 0 ? (answer ?? null) : null;
  const detail = { kind: 'recount', lotId, value, compared: lot.quantity, cause: { ...cause }, difference, inclusion, answeredFor: unordered.map(opIdOf) } as const;
  if (inclusion === null || inclusion === 'included') {
    return commit(ledger, { ...detail, applied: true }, meta, [{ ...lot, quantity, lastCount: countOf(meta.eventId, 'counted', value) }]);
  }
  return commit(ledger, { ...detail, applied: false }, meta, [], [{ id: meta.eventId, lotId, reason: 'lateEntry', resolution: null }]);
}

// 閉じたまとまりを除くので、分割前の親やまとめ直し前の元を重ねて数えない。
// 該当するまとまりがなければ計算上の0。値なしにすると画面で数が不明と取り違える（DAT-02）。
export function totalOf(ledger: Ledger, item: string, include: (lot: Lot) => boolean = () => true): Quantity {
  const lots = Object.values(ledger.lots).filter((lot) => lot.item === item && lot.mergedInto === null && include(lot));
  if (new Set(lots.map((lot) => lot.unit)).size > 1) throw new Error(`品目 ${item} の単位が違う保管単位は合計しない。単位を指定する`);
  return sum(lots.map((lot) => lot.quantity), quantityStepOf(ledger.masters, item, lots[0]?.unit ?? ''));
}

// 0を初期値にして足すと、ラベルだけの合計が「中身未確認」から「未確認部分あり」へ変わってしまう。
function sum(quantities: Quantity[], step: Step): Quantity {
  if (quantities.length === 0) {
    return { kind: 'known', numeric: { value: 0, approximate: false, unconfirmed: 'none' }, computed: true, terms: [] };
  }
  return quantities.reduce((total, quantity) => add(total, quantity, step));
}

// apply は保留した操作を元の操作IDと実際の日時のまま親へ適用し、close は親から減らさずに閉じる。対象の事項だけを閉じる（CHK-04）。
// 保留後に数え直していれば、その確認に保留の操作が含まれていたかを減算と同じ判定で確かめ、二重に減らさない（REC-03b）。
export function resolveIssue(ledger: Ledger, meta: Meta, issueId: string, outcome: Outcome, answer?: Inclusion): Ledger {
  const issue = ledger.issues[issueId];
  if (!issue) throw new Error(`確認事項 ${issueId} がない`);
  if (issue.resolution !== null) throw new Error(`確認事項 ${issueId} は解消済み`);
  let lots: Lot[] = [];
  let inclusion: Inclusion | null = null;
  // 負数と差異申告は、閉じても数量の食い違いは残る。事項が開いたあとに対象を数えてからでないと閉じさせない（09章の解消を確認する方法）。
  // 記録した順だけでなく、数え直しの日時が事項のもとの操作より前でないことも求める（前の日時の数え直しは、その後の状態を確かめていない）。
  let countedBy: string | null = null;
  if (outcome === 'close' && (issue.reason === 'negative' || issue.reason === 'declared') && issue.lotId !== null) {
    const lot = ledger.lots[issue.lotId];
    const opened = ledger.history.findIndex((e) => e.eventId === issueId);
    const counted = lot?.lastCount ? ledger.history.findIndex((e) => e.eventId === lot.lastCount?.eventId) : -1;
    const countId = lot?.lastCount?.eventId;
    if (counted <= opened || !countId || isAfter(occurredAtOf(ledger, issueId), occurredAtOf(ledger, countId))) {
      throw new Error(`確認事項 ${issueId} は、保管単位 ${issue.lotId} を事項のもとの操作より後に数えてから閉じる`);
    }
    countedBy = countId;
  }
  if (outcome === 'apply') {
    const origin = ledger.history.find((e) => e.eventId === issueId);
    if (!origin || !isDecreaseEvent(origin)) {
      throw new Error(`確認事項 ${issueId} には適用する保留操作がない`);
    }
    const lot = open(ledger, origin.lotId);
    const unusable = origin.kind === 'use' ? unusableReason(lot) : origin.kind === 'handover' ? handoverBlocked(lot) : null;
    if (unusable) throw new Error(`保管単位 ${lot.id} は${unusable}`);
    inclusion = inclusionOf(ledger, lot, occurredAtOf(ledger, origin.eventId), answer);
    if (inclusion === 'included') throw new Error('確認に含まれていたなら、適用せずに閉じる');
    if (inclusion === 'unknown') throw new Error('確認に含まれていたか分かるまで適用できない');
    const parent = decreased(ledger, lot, quantityOf(observeFor(ledger, lot, origin.eventId, origin.basis, origin.value)));
    if (parent === null) throw new Error('適用すると負数になるため、まだ解消できない');
    lots = [parent];
  }
  const resolution: Resolution = { eventId: meta.eventId, outcome, actor: meta.actor };
  return commit(ledger, { kind: 'resolve', issueId, outcome, inclusion, countedBy }, meta, lots, [{ ...issue, resolution }]);
}

// 確認事項を開いた操作。日時訂正の事項は「操作ID@time」なので、訂正で前後が変わった元の操作を指す。
export function originOf(ledger: Ledger, issueId: string): LedgerEvent | undefined {
  const eventId = issueId.endsWith('@time') ? issueId.slice(0, -'@time'.length) : issueId;
  return ledger.history.find((e) => e.eventId === eventId);
}

export function openIssues(ledger: Ledger): Issue[] {
  return Object.values(ledger.issues).filter((i) => i.resolution === null);
}

export function openIssuesOf(ledger: Ledger, lotId: string): Issue[] {
  return openIssues(ledger).filter((i) => i.lotId === lotId);
}

// 利用者が現物と台帳の差を申告する。数量は変えず、数え直しと解消で閉じる（09章）。
export function declareDiscrepancy(ledger: Ledger, meta: Meta, lotId: string, note: string): Ledger {
  notBeforeCreation(ledger, open(ledger, lotId), meta.occurredAt);
  required(note, '申告の内容');
  const issue: Issue = { id: meta.eventId, lotId, reason: 'declared', resolution: null };
  return commit(ledger, { kind: 'declare', lotId, note }, meta, [], [issue]);
}

export function recordProvisional(ledger: Ledger, meta: Meta, content: ProvisionalContent): Ledger {
  required(content.note, '仮の記録の備考');
  if (content.location !== null) placeable(ledger, content.location, meta);
  if (content.item !== null) usableItem(ledger, content.item);
  observe(meta.eventId, content.basis, content.value, 1);
  const issue: Issue = { id: meta.eventId, lotId: null, reason: 'unassigned', resolution: null };
  return commit(ledger, { kind: 'provisional', ...content }, meta, [], [issue]);
}

// まとめ直し済みなら、その数量を今持っているまとめ直し先をたどる。
function activeLotId(ledger: Ledger, lotId: string): string {
  const next = ledger.lots[lotId]?.mergedInto;
  return next ? activeLotId(ledger, next) : lotId;
}

// 日時訂正の事項（操作ID@time）が前後を比べた操作のID。減算・解消は直前の数えたと自分、数え直しは反映済みの操作と自分。
function timePremiseOf(ledger: Ledger, issueId: string): string[] {
  const origin = originOf(ledger, issueId);
  if (!origin) return [];
  const opId = issueId.slice(0, -'@time'.length);
  const index = ledger.history.indexOf(origin);
  const lot = origin.changes[0]?.before;
  if (origin.kind === 'recount' && lot) {
    return [opId, ...withoutCancelled(ledger, reflectedIn(ledger.history.slice(0, index), lot)).map(opIdOf).filter((x) => !origin.answeredFor.includes(x))];
  }
  return [opId, ...(lot?.lastCount ? [lot.lastCount.eventId] : [])];
}

// 訂正後の実際の日時。元の操作の記録は書き換えず、最新の訂正を有効にする。
export function occurredAtOf(ledger: Ledger, eventId: string): string | null {
  const target = ledger.history.find((e) => e.eventId === eventId);
  if (!target) throw new Error(`操作 ${eventId} がない`);
  const correction = ledger.history.findLast((e) => e.kind === 'correctTime' && e.targetEventId === eventId);
  return correction?.kind === 'correctTime' ? correction.corrected : target.occurredAt;
}

// 訂正しても、すでに答えた包含や適用結果は決め直さない（NFR-08b）。
export function correctOccurredAt(ledger: Ledger, meta: Meta, targetEventId: string, corrected: string | null): Ledger {
  const previous = occurredAtOf(ledger, targetEventId);
  const alternative = ledger.history.find(e => e.eventId === targetEventId && e.kind === 'alternativeRecord');
  if (alternative?.kind === 'alternativeRecord') throw new Error(`元の資料の識別証拠の日時は訂正しない。対応する操作 ${alternative.operationId} の日時を訂正する`);
  if (ledger.history.some((e) => e.eventId === targetEventId && e.kind === 'correctTime')) {
    throw new Error('日時の訂正そのものは訂正できない。元の操作をもう一度訂正する');
  }
  // 適用時点を後から動かすと、過去の換算と配置の判断が変わる（ADR-024）。
  if (ledger.history.some((e) => e.eventId === targetEventId && e.kind === 'master')) {
    throw new Error('登録情報の変更の時点は訂正しない。新しい変更を記録して直す');
  }
  // 登録に使った仮の記録の日時は、登録の記録にすでに写してある。仮の記録のほうを動かしても換算に効かないので、登録の記録を訂正させる。
  const adopted = ledger.history.find((e) => e.kind === 'adopt' && e.issueId === targetEventId);
  if (adopted) throw new Error(`この仮の記録は新しい保管単位として登録済み。登録の記録（${adopted.eventId}）の日時を訂正する`);
  checkTime(corrected, '訂正後の発生');
  const at = (eventId: string): string | null => (eventId === targetEventId ? corrected : occurredAtOf(ledger, eventId));
  checkAfterCreation(ledger, targetEventId, at);
  checkReworkTimes(ledger, at);
  checkReturnedReworkTimes(ledger, at);
  placedAt(ledger, targetEventId, corrected);
  // 包含を確かめずに時刻順で適用した操作の前提（[前, 後]の組）が、訂正で崩れたら照合へ回す。数量は自動で戻さない。
  // 減算（直接、または保留の解消で）は直前の数えたより後、数え直しはそのとき反映済みの操作より後、を前提にした。
  const issues = ledger.history.flatMap((e, i): Issue[] => {
    const byTime =
      (isDecreaseEvent(e) && e.applied) || (e.kind === 'resolve' && e.outcome === 'apply') || (e.kind === 'recount' && e.applied);
    // 数え直しの回答は一部の操作についてだけなので、残りの操作との前後はなお時刻順の前提として検査する。
    if (!byTime || (e.kind !== 'recount' && e.inclusion !== null)) return [];
    const opId = opIdOf(e);
    // 同じ操作の事項は一つだけにし、解消済みなら利用者の判断を尊重して開き直さない。取り消した操作には前提が残っていない。
    if (ledger.issues[`${opId}@time`] || isVoided(ledger, opId)) return [];
    // 対象のまとまりは、どの適用でも最初の変更。
    const lot = e.changes[0]?.before;
    if (!lot) return [];
    const pairs: [string, string][] =
      e.kind === 'recount'
        ? withoutCancelled(ledger, reflectedIn(ledger.history.slice(0, i), lot))
            .map(opIdOf)
            .filter((x) => !e.answeredFor.includes(x))
            .map((x) => [x, opId])
        : lot.lastCount
          ? [[lot.lastCount.eventId, opId]]
          : [];
    const broken = pairs.some(([a, b]) => (a === targetEventId || b === targetEventId) && !isAfter(at(b), at(a)));
    return broken ? [{ id: `${opId}@time`, lotId: activeLotId(ledger, lot.id), reason: 'timeCorrected', resolution: null }] : [];
  });
  const next = commit(ledger, { kind: 'correctTime', targetEventId, previous, corrected }, meta, [], issues);
  checkMergedPerBox(ledger, next, '訂正すると');
  // 訂正で中断や台数の更新の時点が動くと、その時点の工程内数も変わる。訂正前は内数だった台数が超える訂正は受け付けない。
  const before = stopViolations(ledger);
  const added = [...stopViolations(next)].filter(([id]) => !before.has(id));
  if (added.length > 0) {
    const [id, message] = added[0]!;
    throw new Error(`訂正後の日時では、操作${id}の${message}`);
  }
  return next;
}

// まとめ直した先の数量は、まとめた時点で同じだった1箱あたりの数で換算している。片方だけ1箱あたりの数が変わる訂正と1箱あたりの数の変更は受け付けない（ADR-024）。
function checkMergedPerBox(before: Ledger, after: Ledger, cause: string): void {
  const createdBefore = creationsOf(before);
  const createdAfter = creationsOf(after);
  const mergeTargets = new Set(Object.values(before.lots).flatMap((l) => (l.mergedInto === null ? [] : [l.mergedInto])));
  for (const lot of Object.values(before.lots)) {
    const merged = lot.mergedInto !== null || mergeTargets.has(lot.id);
    if (merged && perBoxOfLot(before, lot, createdBefore) !== perBoxOfLot(after, lot, createdAfter)) {
      throw new Error(`${cause}、統合に関わった箱 ${lot.id} の受け取りのときの1箱あたりの数が変わる`);
    }
  }
}

// 記録が置き場所を決めた場所。まとまりの置き場所を決めない記録は null。
function placedLocation(e: LedgerEvent): string | null {
  return e.kind === 'provisional' ? e.location
    : e.kind === 'register' || e.kind === 'start' || e.kind === 'move' || e.kind === 'adopt' ? e.changes[0]?.after.location ?? null
    : null;
}

// 置き場所を決めた記録の日時を、その場所が記録の対象外だった時点へ動かさない（要件7.4）。不明への訂正は、その記録の入力した日時で判断する。
// 利用停止は訂正を止めない（要件3.3）。
function placedAt(ledger: Ledger, targetEventId: string, corrected: string | null): void {
  const target = ledger.history.find((e) => e.eventId === targetEventId);
  if (!target) return;
  const location = placedLocation(target);
  const place = location === null ? undefined : own(ledger.masters.locations, location);
  if (place) inScope(place, corrected ?? fallbackTime(ledger, target));
}

// 日時の訂正で、できたまとまりへの操作がまとまりのできる前になる（訂正する操作か、できた操作のどちらかが対象）場合は受け付けない。
// 訂正前から食い違っていた記録は、この訂正と関係なければ止めない。
function checkAfterCreation(ledger: Ledger, targetEventId: string, at: (eventId: string) => string | null): void {
  // 材料の使用は作業の開始より後にならず、取消は取り消す操作より前にならない。
  const pairs: [string, string, string][] = ledger.history.flatMap((e): [string, string, string][] =>
    e.kind === 'start'
      ? e.materials.map((m): [string, string, string] => [m, e.eventId, `材料の使用${m}が作業の開始より後になる`])
      : e.kind === 'void'
        ? [[e.targetEventId, e.eventId, `取消${e.eventId}が取り消す操作より前になる`]]
        : e.kind === 'resolve' && e.countedBy !== null
          ? [[e.issueId, e.countedBy, `確認事項${e.issueId}を閉じる根拠にした数え直し${e.countedBy}が、事項のもとの操作より前になる`]]
          : [],
  );
  for (const [first, second, message] of pairs) {
    if ((first === targetEventId || second === targetEventId) && isAfter(at(first), at(second))) throw new Error(`訂正後の日時では、${message}`);
  }
  for (const stopEvent of ledger.history) {
    if (stopEvent.kind !== 'stop') continue;
    const events = lifecycleOf(ledger, stopEvent.stop.id);
    // 記録順に、後の操作が前の操作より前になる訂正は受け付けない（訂正前から逆だった組は、この訂正と無関係なら止めない）。
    for (const [i, a] of events.entries()) {
      for (const b of events.slice(i + 1)) {
        if (a.eventId !== targetEventId && b.eventId !== targetEventId) continue;
        if (isAfter(at(a.eventId), at(b.eventId))) {
          throw new Error(`訂正後の日時では、操作${b.eventId}が操作${a.eventId}より前になる。中断 ${stopEvent.stop.id} の記録を訂正する`);
        }
      }
    }
  }
  const recovered = recoveredRegisters(ledger);
  for (const creation of ledger.history) {
    const lotId = createdLotId(creation, recovered);
    if (lotId === null) continue;
    for (const e of ledger.history) {
      if (e === creation || e.kind === 'correctTime') continue;
      const touches = e.changes.some((c) => c.after.id === lotId) || ('lotId' in e && e.lotId === lotId);
      if (!touches || (e.eventId !== targetEventId && creation.eventId !== targetEventId)) continue;
      if (isAfter(at(creation.eventId), at(e.eventId))) {
        throw new Error(`訂正後の日時では、操作${e.eventId}が保管単位 ${lotId} のできる前の操作になる。元の保管単位の操作として記録し直す`);
      }
    }
  }
}

// 誤って記録した使用・引渡しを、起きなかったものとして取り消す（REC-02a）。元の記録は残し、この操作が指す。
// 現物の戻しや受け取りは作らない。数量を戻すのは誤りが今の数量に反映されているときだけで、
// 誤りの後の数え直しが数量を置き換えていれば、同じ差異を二度直さないよう記録だけ残す（REC-02b）。
export function voidRecord(ledger: Ledger, meta: Meta, targetEventId: string, reason: string): Ledger {
  required(reason, '取り消す理由');
  const target = ledger.history.find((e) => e.eventId === targetEventId);
  if (target?.kind !== 'use' && target?.kind !== 'handover') throw new Error(`操作 ${targetEventId} は取り消せる使用・引渡しではない`);
  if (isVoided(ledger, targetEventId)) throw new Error(`操作 ${targetEventId} は取消済み`);
  // 正しく記録した材料の使用と製造の関連を崩さない。
  const materialOwner = startOfMaterial(ledger, targetEventId);
  if (materialOwner) throw new Error(`操作 ${targetEventId} は${materialOwner.kind === 'reworkPart' ? 'やり直し・修理' : '作業の開始'}の材料に対応付けてあるので単独では取り消さない`);
  // 日時の訂正で開いた事項（操作ID@time）のうち、順序の前提がこの操作を含むもの（この操作自身の事項と、
  // この操作を反映済みとして前後を比べた数え直しの事項）は、取り消した操作について照合を求め続けないよう、先に解消させる。
  const timeIssueOpen = openIssues(ledger).some((i) => i.reason === 'timeCorrected' && timePremiseOf(ledger, i.id).includes(targetEventId));
  if (ledger.issues[targetEventId]?.resolution === null || timeIssueOpen) {
    throw new Error(`操作 ${targetEventId} には未解決の確認事項がある。先に解消する`);
  }
  // 数が不明の減算は残数を不明にしており、足し戻しても元の数量にならない。
  if (target.value === null) throw new Error('数が不明の使用・引渡しは取り消さず、数え直しで直す');
  if (isAfter(occurredAtOf(ledger, targetEventId), meta.occurredAt)) throw new Error(`取消の日時が、取り消す操作より前になっている`);
  const source = ledger.lots[target.lotId];
  if (!source) throw new Error(`保管単位 ${target.lotId} がない`);
  const chain = reflectedIn(ledger.history, source);
  const at = chain.findIndex((e) => e.kind !== 'recount' && opIdOf(e) === targetEventId);
  const lot = at >= 0 ? carriedTo(ledger, source) : null;
  const detail = { kind: 'void', targetEventId, lotId: source.id, reason, applied: lot !== null } as const;
  if (lot === null) return commit(ledger, detail, meta, []);
  // 足し戻すと、表示の数（ラベル・パッケージ）やだいたいの誤りを取り消しても中身未確認・約が残り、根拠が劣化する。
  // 最後に数えた数（なければ登録）の数量から、誤りを除いて引き直して戻す。引き直せない操作が間にあれば足し戻す。
  const restored = rebuiltWithout(ledger, lot, targetEventId) ?? add(lot.quantity, quantityOf(observeFor(ledger, lot, meta.eventId, target.basis, target.value)), quantityStepOf(ledger.masters, lot.item, lot.unit));
  return commit(ledger, detail, meta, [{ ...lot, quantity: restored }]);
}

// 最後に数えた数（なければ登録）の数量から、指定の操作と取り消し済みの操作（誤りの前後どちらも、取消と対で打ち消し合う）を
// 除いて、減算とまとめ直しの加算だけを引き直した数量。まとめ直しの元も同じ規則で引き直す。引き直せなければundefined。
function rebuiltWithout(ledger: Ledger, lot: Lot, excludedOpId: string): Quantity | undefined {
  const chain = reflectedIn(ledger.history, lot);
  const first = chain[0];
  const creates = first && ['register', 'recount', 'split', 'stage', 'transfer', 'rework', 'start'].includes(first.kind);
  const base = creates ? first.changes.find((c) => c.after.id === lot.id)?.after.quantity : undefined;
  if (base === undefined) return undefined;
  let quantity: Quantity = base;
  for (const e of withoutCancelled(ledger, chain.slice(1)).filter((x) => opIdOf(x) !== excludedOpId)) {
    if (isDecreaseEvent(e) && e.applied && e.lotId === lot.id) {
      quantity = subtract(quantity, quantityOf(observeFor(ledger, lot, e.eventId, e.basis, e.value)), quantityStepOf(ledger.masters, lot.item, lot.unit));
    } else if (e.kind === 'merge') {
      const from = e.changes.find((c) => c.after.mergedInto === lot.id)?.after;
      const merged = from && (rebuiltWithout(ledger, from, excludedOpId) ?? from.quantity);
      if (!merged) return undefined;
      quantity = add(quantity, merged, quantityStepOf(ledger.masters, lot.item, lot.unit));
    } else {
      return undefined;
    }
  }
  return quantity;
}

// まとめ直し済みなら、その数量を今持っているまとまり。まとめ直し先を後に数え直していれば、
// 数量は数え直しの値に置き換わっていて誤りを含まないので、持ち越されていないとしてnull。
function carriedTo(ledger: Ledger, lot: Lot): Lot | null {
  if (lot.mergedInto === null) return lot;
  const next = ledger.lots[lot.mergedInto];
  const merge = ledger.history.find((e) => e.kind === 'merge' && e.changes.some((c) => c.after.id === lot.id && c.after.mergedInto === next?.id));
  if (!next || !merge || !reflectedIn(ledger.history, next).includes(merge)) return null;
  return carriedTo(ledger, next);
}

export function voidOf(ledger: Ledger, eventId: string): LedgerEvent | undefined {
  return ledger.history.find((e) => e.kind === 'void' && e.targetEventId === eventId);
}

const inProcess = (s: Stage, process: string): boolean => (s.kind === 'working' || s.kind === 'inspecting') && s.process.id === process;

type StopScope = Pick<Stop, 'process' | 'item' | 'unit' | 'project'>;

// 工程内数（作業中＋検査待ち）。中断台数はこの内数（MFG-08b）。
function inProcessTotal(ledger: Ledger, s: StopScope): Quantity {
  return totalOf(ledger, s.item, (l) => l.unit === s.unit && inProcess(l.stage, s.process) && sameProject(l.project, s.project));
}

// 影響台数が分かっている工程内数を超えていれば、その値。どちらかが不明なら比べられないので食い違いとしない。
function excessOf(ledger: Ledger, stop: StopScope & Pick<Stop, 'affected'>): { affected: number; total: number } | null {
  if (stop.affected === null) return null;
  const total = inProcessTotal(ledger, stop);
  return total.kind === 'known' && stop.affected > total.numeric.value ? { affected: stop.affected, total: total.numeric.value } : null;
}

// 中断の時点の工程内数。今の工程内数から、その時点より後に起きた操作の工程内の増減を戻して求める。
// 日時不明の中断は今の数。増減を戻せない（数が不明を含む、日時不明の操作がある）ときはnull。
// 同じ時刻の操作は中断より前に起きたものとして数える（作業の開始と同時の中断は、作業を開始した物の中断）。
function inProcessTotalAt(ledger: Ledger, stop: StopScope, occurredAt: string | null): number | null {
  const current = inProcessTotal(ledger, stop);
  if (current.kind !== 'known') return null;
  if (occurredAt === null) return current.numeric.value;
  const inGroup = (l: Lot | null): l is Lot =>
    l !== null && l.mergedInto === null && l.item === stop.item && l.unit === stop.unit && sameProject(l.project, stop.project) && inProcess(l.stage, stop.process);
  const totalIn = (lots: (Lot | null)[]): Quantity => sum(lots.filter(inGroup).map((l) => l.quantity), quantityStepOf(ledger.masters, stop.item, stop.unit));
  const terms = [current.numeric.value];
  for (const e of ledger.history) {
    if (e.kind === 'correctTime') continue;
    const before = totalIn(e.changes.map((c) => c.before));
    const after = totalIn(e.changes.map((c) => c.after));
    if (before.kind !== 'known' || after.kind !== 'known') return null;
    if (after.numeric.value === before.numeric.value) continue;
    // 保留の「適用」は元の操作の日時の変化なので、解消した日時ではなくopIdOfで引く。
    const at = occurredAtOf(ledger, opIdOf(e));
    if (at === null) return null;
    if (isAfter(at, occurredAt)) terms.push(before.numeric.value, -after.numeric.value);
  }
  return sumScalarsFinal(terms, quantityStepOf(ledger.masters, stop.item, stop.unit));
}

// 中断と台数の更新のうち、その時点の工程内数を超える台数を記録したもの（操作ID→説明）。
function stopViolations(ledger: Ledger): Map<string, string> {
  const found = new Map<string, string>();
  for (const e of ledger.history) {
    const stopId = e.kind === 'stop' ? e.stop.id : e.kind === 'stopUpdate' ? e.stopId : null;
    const affected = e.kind === 'stop' ? e.stop.affected : e.kind === 'stopUpdate' ? e.affected : null;
    const stop = stopId === null ? undefined : ledger.stops[stopId];
    if (!stop || affected === null) continue;
    const total = inProcessTotalAt(ledger, stop, occurredAtOf(ledger, e.eventId));
    if (total !== null && affected > total) found.set(e.eventId, `影響数${affected}が工程内数${total}の内数でなくなる`);
  }
  return found;
}

// 影響台数の検査。中断の時点の工程内数で比べるので、入力の順で可否が変わらない（後の操作で工程内数が減ったあとに、前の日時の中断を入れても判断できる）。
// その時点の数が求められないときは拒否せず、今の数を超えていれば製造の欄の警告で示す。
function checkAffected(ledger: Ledger, stop: StopScope, affected: number | null, occurredAt: string | null): void {
  if (affected === null) return;
  validateScalar(affected, inputStepOf(ledger.masters, stop.item, stop.unit, affected));
  const total = inProcessTotalAt(ledger, stop, occurredAt);
  if (total !== null && affected > total) throw new Error(`影響数${affected}は工程内数${total}の内数にする`);
}

// 中断の登録・更新のあとで位置の変更や数え直しが工程内数を減らすと、中断台数が内数でなくなる（MFG-08b）。
// 事実の記録は止めず、自動で再開もしない。物の数の食い違いではなく作業の中断が古いだけなので、
// 確認が必要（CHK-01の検出条件）にはせず、画面がこの値で警告する。
export function stopExcessOf(ledger: Ledger, stop: Stop): { affected: number; total: number } | null {
  return stop.resumedBy === null ? excessOf(ledger, stop) : null;
}

export function recordStop(ledger: Ledger, meta: Meta, s: Omit<Stop, 'id' | 'resumedBy'>): Ledger {
  required(s.process, '工程');
  required(s.item, '中断した品目');
  required(s.unit, '工程内数の単位');
  required(s.reason, '中断した理由');
  if (s.shortage) {
    required(s.shortage.item, '不足品目');
    required(s.shortage.unit, '不足数の単位');
    if (s.shortage.value !== null) observeFor(ledger, s.shortage, meta.eventId, 'counted', s.shortage.value);
  }
  usableItem(ledger, s.item);
  usableProject(ledger, s.project);
  if (s.shortage) usableItem(ledger, s.shortage.item);
  checkAffected(ledger, s, s.affected, meta.occurredAt);
  const stop: Stop = { ...s, project: { ...s.project }, shortage: s.shortage && { ...s.shortage }, id: meta.eventId, resumedBy: null };
  return commit(ledger, { kind: 'stop', stop }, meta, [], [], [stop]);
}

function openStop(ledger: Ledger, stopId: string): Stop {
  const stop = ledger.stops[stopId];
  if (!stop) throw new Error(`中断 ${stopId} がない`);
  if (stop.resumedBy !== null) throw new Error(`中断 ${stopId} は作業の再開済み`);
  return stop;
}

// 作業の中断、台数の更新、作業の再開を、記録した順に並べたもの。
function lifecycleOf(ledger: Ledger, stopId: string): LedgerEvent[] {
  return ledger.history.filter((e) => (e.kind === 'stop' && e.stop.id === stopId) || ((e.kind === 'stopUpdate' || e.kind === 'resume') && e.stopId === stopId));
}

// 作業の中断済みの操作（中断、これまでの更新）より前と言える日時の更新・再開は記録しない。
function notBeforeStop(ledger: Ledger, stopId: string, occurredAt: string | null): void {
  const later = lifecycleOf(ledger, stopId).find((e) => isAfter(occurredAtOf(ledger, e.eventId), occurredAt));
  if (later) throw new Error(`中断 ${stopId} の記録済みの操作${later.eventId}より前の日時の更新・再開は記録しない`);
}

// 台数不明で記録した中断を、確かめた台数へ更新する。前の値は履歴に残る。
export function updateStop(ledger: Ledger, meta: Meta, stopId: string, affected: number | null): Ledger {
  const stop = openStop(ledger, stopId);
  notBeforeStop(ledger, stopId, meta.occurredAt);
  if (stop.affected === affected) throw new Error('影響数が変わっていない');
  checkAffected(ledger, stop, affected, meta.occurredAt);
  return commit(ledger, { kind: 'stopUpdate', stopId, previous: stop.affected, affected }, meta, [], [], [{ ...stop, affected }]);
}

// 材料の受け取りとは別に記録する。受け取りで自動的に再開しない（MFG-08c）。
export function resumeWork(ledger: Ledger, meta: Meta, stopId: string): Ledger {
  const stop = openStop(ledger, stopId);
  notBeforeStop(ledger, stopId, meta.occurredAt);
  return commit(ledger, { kind: 'resume', stopId }, meta, [], [], [{ ...stop, resumedBy: meta.eventId }]);
}

export type ProductionGroup = { process: string; item: string; unit: string; project: Project };

export function productionGroupsOf(ledger: Ledger): ProductionGroup[] {
  const groups = new Map<string, ProductionGroup>();
  for (const lot of Object.values(ledger.lots)) {
    if (lot.stage.kind === 'none') continue;
    const group = { process: lot.stage.process.id, item: lot.item, unit: lot.unit, project: lot.project };
    const key = JSON.stringify([group.process, group.item, group.unit, group.project.kind, group.project.kind === 'case' ? group.project.id : null]);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function productionIssuesOf(ledger: Ledger, group: ProductionGroup): Issue[] {
  const lots = new Set(Object.values(ledger.lots).filter(lot => lot.stage.kind !== 'none' && lot.stage.process.id === group.process
    && lot.item === group.item && lot.unit === group.unit && sameProject(lot.project, group.project)).map(lot => lot.id));
  return openIssues(ledger).filter(issue => {
    const origin = originOf(ledger, issue.id);
    return (issue.lotId !== null && lots.has(issue.lotId)) || (origin?.kind === 'stage' && lots.has(origin.childId));
  });
}

export type Production = {
  working: Quantity;
  inspecting: Quantity;
  // 工程内数（作業中＋確認待ち）。品目・単位の精度で足すので、画面で足し直さない。
  inProcess: Quantity;
  awaitingHandover: Quantity;
  // 工程完了累計と引渡済み累計は履歴から求める。現在の手元へ足す数ではない（15-B「Bの確認観点」）。
  completed: Quantity;
  // 同じ現物への再度のやり直し・修理でも増える履歴の累計。現在の工程内数には加算しない。
  reworkStarted: Quantity;
  // 完成（渡す前）から工程内へ戻した数（訂正の入力による。現物の動きではない）。どの完了と対になるかは個体を追わないと決まらないので、完了累計から引かず別に示す。
  returned: Quantity;
  handedOver: Quantity;
};

// 工程と品目・単位・案件・用途ごとの製造の数（MFG-01b）。単位の違う数は足さない（QTY-07）。
// 完了累計は工程内から完成（渡す前）へ移した数で、完了の記録は増えても引かない（06章「作業回数や完了履歴は増えても」）。
// 完成（渡す前）を分けてもまとめても変わらない。開始時点から完成（渡す前）だった物は、過去の完了を作らないので数えない。
// 引渡済みは完成（渡す前）から作業なしへ移した数（手元の次工程）と、完成（渡す前）から外へ渡した数の合計。取り消した引渡しは除く。
export type ProductionTally = 'completed' | 'reworkStarted' | 'returned' | 'handedOver';

// 工程の累計に数える操作の分類。productionOfと保存前の上限検査が同じ分類を使う。取消の判定は呼び出し側が渡す
// （検査は全履歴を一度だけなめるので、操作ごとに履歴をなめ直さない）。
export function productionTallyOf(ledger: Ledger, e: LedgerEvent, voided: (eventId: string) => boolean):
  { lot: Lot; process: string; basis: Basis; value: number | null; kinds: ProductionTally[] } | null {
  if (!isDecreaseEvent(e) || voided(e.eventId)) return null;
  // まとまりの品目・案件・用途・工程上の位置はその場では変わらない（位置を変えるのは分けた子）ので、今のまとまりで判定できる。
  const from = ledger.lots[e.lotId];
  if (!from) return null;
  const process = e.kind === 'rework' && e.returnSource !== undefined ? e.returnSource.process.id : from.stage.kind === 'none' ? null : from.stage.process.id;
  if (process === null) return null;
  const kinds: ProductionTally[] = [];
  if (e.kind === 'rework') kinds.push('reworkStarted');
  // 負数・後入力で保留した引渡しは、適用して解消するまで数えない。根拠なしに「閉じる」だけでは、引渡しが実際にあったか分からない。
  // 確認に含まれていたと答えた引渡しは、数量に反映済みなので数える。
  if (e.kind === 'handover' && from.stage.kind === 'awaitingHandover' && (e.applied || e.inclusion === 'included' || ledger.issues[e.eventId]?.resolution?.outcome === 'apply')) {
    kinds.push('handedOver');
  }
  if (e.kind === 'stage') {
    if (from.stage.kind === 'awaitingHandover' && inProcess(e.to, process)) kinds.push('returned');
    // 訂正は現物の動きを伴わないので、完了・引渡しの実績に数えない。
    if (!e.correction) {
      if (inProcess(from.stage, process) && e.to.kind === 'awaitingHandover') kinds.push('completed');
      if (from.stage.kind === 'awaitingHandover' && e.to.kind === 'none') kinds.push('handedOver');
    }
  }
  return { lot: from, process, basis: e.basis, value: e.value, kinds };
}

export function productionOf(ledger: Ledger, process: string, item: string, unit: string, project: Project): Production {
  const target = (l: Lot) => l.item === item && l.unit === unit && sameProject(l.project, project);
  const at = (kind: Stage['kind']) => totalOf(ledger, item, (l) => target(l) && l.stage.kind === kind && l.stage.kind !== 'none' && l.stage.process.id === process);
  const tallies: Record<ProductionTally, Quantity[]> = { completed: [], reworkStarted: [], returned: [], handedOver: [] };
  for (const e of ledger.history) {
    const tally = productionTallyOf(ledger, e, (id) => isVoided(ledger, id));
    if (!tally || !target(tally.lot) || tally.process !== process) continue;
    const taken = quantityOf(observeFor(ledger, tally.lot, e.eventId, tally.basis, tally.value));
    for (const kind of tally.kinds) tallies[kind].push(taken);
  }
  const working = at('working');
  const inspecting = at('inspecting');
  return {
    working,
    inspecting,
    inProcess: add(working, inspecting, quantityStepOf(ledger.masters, item, unit)),
    awaitingHandover: at('awaitingHandover'),
    completed: sum(tallies.completed, quantityStepOf(ledger.masters, item, unit)),
    reworkStarted: sum(tallies.reworkStarted, quantityStepOf(ledger.masters, item, unit)),
    returned: sum(tallies.returned, quantityStepOf(ledger.masters, item, unit)),
    handedOver: sum(tallies.handedOver, quantityStepOf(ledger.masters, item, unit)),
  };
}

// まとまりを作った記録の時点（実際の日時の訂正を反映。不明なら入力した日時）。箱ごとにoccurredAtOfで履歴をなめ直すと、箱の数×履歴の長さになる。
export function creationsOf(ledger: Ledger): Map<string, string> {
  const corrected = new Map<string, string | null>();
  for (const e of ledger.history) if (e.kind === 'correctTime') corrected.set(e.targetEventId, e.corrected);
  const recorded = new Map(ledger.history.map((e) => [e.eventId, e.recordedAt]));
  const created = new Map<string, string>();
  for (const e of ledger.history) {
    // 実際の日時の不明な仮の記録から登録したまとまりは、仮の記録を記録した時点で作られたものとする。
    const fallback = e.kind === 'adopt' ? recorded.get(e.issueId) ?? e.recordedAt : e.recordedAt;
    for (const c of e.changes) if (c.before === null && !created.has(c.after.id)) created.set(c.after.id, (corrected.has(e.eventId) ? corrected.get(e.eventId) : e.occurredAt) ?? fallback);
  }
  return created;
}

// 箱の1箱あたりの数は、元の箱を作った記録の実際の日時（訂正を反映。不明なら入力した日時）の1箱あたりの数（要件6.2〜6.6、ADR-024）。
// 作った記録が見つからない箱は、換算しない箱にする（例外にすると手元の表示ごと止まる）。
export function perBoxOfLot(ledger: Ledger, lot: Lot, created: ReadonlyMap<string, string> = creationsOf(ledger)): number | null {
  const packaging = own(ledger.masters.items, lot.item)?.packaging;
  if (!packaging || lot.unit !== packaging.boxUnit) return null;
  let root = lot;
  for (const seen = new Set<string>(); root.splitFrom !== null; ) {
    if (seen.has(root.id)) return null;
    seen.add(root.id);
    const parent = ledger.lots[root.splitFrom];
    if (!parent) return null;
    root = parent;
  }
  const at = created.get(root.id);
  return at === undefined ? null : perBoxAt(packaging, at);
}

// 確認が要る変更（既存IDの付替え・元の資料の更新・仮の記録の新しいまとまり・案件・用途の結び付け）。
// 画面は内容を示して確認の欄を出し、同じ入力を確認つきで再送させる。確認の前は何も記録しない。
export class ConfirmationRequired extends Error {
  readonly kind: 'code' | 'source' | 'adopt' | 'identify' | 'assignProject';
  readonly lots: readonly string[];
  readonly master: Master | null;

  constructor(kind: ConfirmationRequired['kind'], message: string, lots: readonly string[] = [], master: Master | null = null) {
    super(message);
    this.kind = kind;
    this.lots = lots;
    this.master = master;
  }
}

export type { NewMaster, TrialReview } from './master-edit.ts';

type TrialRequest = { action: 'trial'; type: 'item' | 'location'; id: string; reason: string } &
  ({ trial: true; review: TrialReview } | { trial: false; review: null });

export type MasterRequest =
  | TrialRequest
  | { action: 'register'; master: NewMaster }
  | { action: 'rename'; type: 'item' | 'location' | 'case'; id: string; name: string; reason: string }
  | { action: 'deactivate' | 'reactivate'; type: Master['type']; id: string; reason: string }
  | { action: 'code'; type: 'item' | 'location' | 'case'; id: string; code: string; reason: string }
  | { action: 'source'; type: 'item' | 'case'; code: string; source: Source }
  | { action: 'perBox'; id: string; value: number; reason: string }
  | { action: 'packaging'; id: string; boxUnit: string; pieceUnit: string; value: number; reason: string }
  | { action: 'consumable'; id: string; setting: ConsumableSetting | null; reason: string }
  | { action: 'scope'; id: string; inScope: boolean; reason: string };

export type MasterChange = { before: Master | null; after: Master };

function knownZero(q: Quantity): boolean {
  return q.kind === 'known' && q.numeric.value === 0 && !q.numeric.approximate && q.numeric.unconfirmed === 'none';
}

function lotsOfMaster(ledger: Ledger, m: Master): string[] {
  return Object.values(ledger.lots)
    .filter((l) => l.mergedInto === null && (m.type === 'item' ? l.item === m.id : m.type === 'case' ? l.project.kind === 'case' && l.project.id === m.id : m.type === 'location' && l.location === m.id))
    .map((l) => l.id);
}

type MasterPlan = { changes: MasterChange[]; confirmed: boolean };
type Request<A extends MasterRequest['action']> = Extract<MasterRequest, { action: A }>;

const planOne = (before: Master | null, after: Master): MasterPlan => ({ changes: [{ before, after }], confirmed: false });

function planTrial(ledger: Ledger, request: TrialRequest): MasterPlan {
  const m = masterOf(ledger.masters, request.type, request.id);
  if (m.type !== 'item' && m.type !== 'location') throw new Error('試行対象を変更できるのは品目と場所');
  required(request.reason, '理由');
  if (m.trial === request.trial) throw new Error('今と同じ試行対象');
  if (request.trial) checkTrialReview(request.review);
  else if (request.review !== null) throw new Error('対象外への変更には追加時の確認内容を持たせない');
  return planOne(m, { ...m, trial: request.trial });
}

function planRename(ledger: Ledger, request: Request<'rename'>): MasterPlan {
  const m = masterOf(ledger.masters, request.type, request.id);
  required(request.name, '新しい名称');
  required(request.reason, '理由');
  if (m.type === 'actor') throw new Error('担当者の名前は変えない');
  if (m.name === request.name) throw new Error('今と同じ名称');
  return planOne(m, { ...m, name: request.name });
}

function planActive(ledger: Ledger, meta: Meta, request: Request<'deactivate' | 'reactivate'>): MasterPlan {
  const m = masterOf(ledger.masters, request.type, request.id);
  required(request.reason, '理由');
  const active = request.action === 'reactivate';
  if (m.active === active) throw new Error(active ? `${masterRef(m)}はすでに利用中` : `${masterRef(m)}はすでに利用停止中`);
  // 利用停止中の担当者は記録できないので、操作中の自分を止めると、画面が記録を受け付けなくなり、抜けるには初期化か復元しかない。
  if (m.type === 'actor' && !active && m.id === meta.actor) throw new Error('操作している担当者は利用停止できない。別の担当者に切り替えてから止める');
  return planOne(m, { ...m, active });
}

function planCode(ledger: Ledger, request: Request<'code'>, confirmed: boolean): MasterPlan {
  const m = masterOf(ledger.masters, request.type, request.id);
  required(request.code, '品番・コード');
  required(request.reason, '理由');
  if (m.type === 'actor') throw new Error('担当者には品番・コードがない');
  if (m.code === request.code) throw new Error('今と同じ品番・コード');
  const owner = codeOwner(ledger.masters, request.type, request.code);
  if (!owner) return planOne(m, { ...m, code: request.code });
  if (owner.type !== 'item' && owner.type !== 'case') throw new Error(`品番・コード ${request.code} は${masterRef(owner)}が使っている。場所には仮を設けないので、先にその場所の品番・コードを変える`);
  if (m.type === 'location') throw new Error('場所の品番・コードは付け替えない');
  // 仮になる案件・用途は、既存IDの代わりに名称で見分ける。登録でも、どちらもない案件・用途は作らない。
  if (owner.type === 'case' && owner.name === null) throw new Error(`${masterRef(owner)}は呼び名がなく、品番・コードを外すと見分けがつかなくなる。先に名称を付ける`);
  const lots = lotsOfMaster(ledger, owner);
  if (!confirmed) {
    throw new ConfirmationRequired('code',
      `品番・コード ${request.code} は${masterRef(owner)}が使っている。対応変更すると、その${masterTypeDisplayLabel[owner.type]}は${unassignedCode}になり、${masterRef(m)}が品番・コード ${request.code} を持つ。記録は合算も移動もしない（${masterTypeDisplayLabel[owner.type]}を指す現存する保管単位：${lots.join('・') || 'なし'}）`,
      lots, owner);
  }
  return { changes: [{ before: owner, after: { ...owner, code: null } }, { before: m, after: { ...m, code: request.code } }], confirmed: true };
}

function planSource(ledger: Ledger, request: Request<'source'>, confirmed: boolean): MasterPlan {
  required(request.code, '品番・コード');
  required(request.source.name, '元の資料の名称');
  required(request.source.revision, '元の資料の版');
  const m = codeOwner(ledger.masters, request.type, request.code);
  if (!m || (m.type !== 'item' && m.type !== 'case')) throw new Error(`品番・コード ${request.code} は未登録の${masterTypeDisplayLabel[request.type]}。元の資料の更新では登録情報を作らない。先に登録する`);
  if (m.source?.name === request.source.name && m.source.revision === request.source.revision) throw new Error('元の資料の名称と版に変更がない');
  if (!confirmed) {
    const before = m.source === null ? 'なし' : `「${m.source.name}」（版${m.source.revision}）`;
    const local = m.name !== null && m.name !== request.source.name ? `。呼び名「${m.name}」と食い違う（呼び名は変えない）` : '。呼び名は変えない';
    throw new ConfirmationRequired('source', `${masterRef(m)}の元の資料：${before} → 「${request.source.name}」（版${request.source.revision}）${local}`, [], m);
  }
  return { changes: [{ before: m, after: { ...m, source: { name: request.source.name, revision: request.source.revision } } }], confirmed: true };
}

function planPerBox(ledger: Ledger, meta: Meta, request: Request<'perBox'>): MasterPlan {
  const m = masterOf(ledger.masters, 'item', request.id);
  if (m.type !== 'item' || m.packaging === null) throw new Error(`${masterRef(m)}は包装（1箱あたりの数）を持たない`);
  if (!Number.isSafeInteger(request.value) || request.value < 1) throw new Error('1箱あたりの数は1以上の整数にする');
  required(request.reason, '理由');
  const from = effectiveFrom(meta, m.packaging.perBox);
  if (m.packaging.perBox[m.packaging.perBox.length - 1]?.value === request.value) throw new Error('今と同じ1箱あたりの数');
  return planOne(m, { ...m, packaging: { ...m.packaging, perBox: [...m.packaging.perBox, { from, value: request.value }] } });
}

function planItemSetting(ledger: Ledger, meta: Meta, request: Request<'packaging'> | Request<'consumable'>): MasterPlan {
  const item = masterOf(ledger.masters, 'item', request.id);
  if (item.type !== 'item') throw new Error('品目を選ぶ');
  required(request.reason, '理由');
  if (request.action === 'packaging') {
    return planOne(item, { ...item, packaging: initialPackaging(item, meta, request.boxUnit, request.pieceUnit, request.value) });
  }
  const consumable = checkedConsumable(item, request.setting);
  if (JSON.stringify(consumable) === JSON.stringify(item.consumable)) throw new Error('共通消耗品の設定に変更がない');
  return planOne(item, { ...item, consumable });
}

// 実際の日時の訂正を反映した、記録ごとの時点（ミリ秒）。不明なら入力した日時（仮の記録から登録したまとまりは仮の記録の入力した日時）。
function eventTimes(ledger: Ledger): Map<string, number> {
  const corrected = new Map<string, string | null>();
  for (const e of ledger.history) if (e.kind === 'correctTime') corrected.set(e.targetEventId, e.corrected);
  return new Map(ledger.history.map((e) => [e.eventId, Date.parse((corrected.has(e.eventId) ? corrected.get(e.eventId) : e.occurredAt) ?? fallbackTime(ledger, e))]));
}

type Period = { from: number; until: number };
type ScopeProblem = { remaining: string[]; placed: string[]; held: (Period & { lotId: string; eventId: string })[] };

type Residence = Period & { lotId: string; place: string; eventId: string };

type ResidenceChange = { at: number; lotId: string; eventId: string; version: number } &
  ({ kind: 'place'; place: string } | { kind: 'quantity'; occupied: boolean });

// 物がない根拠にする0は、元の観測がすべて起きてから使う。減算を後へ訂正したとき、後続の0を先に使わない。
// 数量の根拠待ちを空の証拠にはせず、結合などによる物の継承はその時点で追う。保存した数量は再計算しない。
function residenceChanges(ledger: Ledger, times: ReadonlyMap<string, number>): ResidenceChange[] {
  const changes: ResidenceChange[] = [];
  ledger.history.forEach((e, version) => {
    const at = times.get(e.eventId)!;
    for (const c of e.changes) {
      const base = { lotId: c.after.id, eventId: e.eventId, version };
      if (c.before === null || c.before.location !== c.after.location) changes.push({ ...base, at, kind: 'place', place: c.after.location });
      if (c.before !== null && c.before.mergedInto === c.after.mergedInto && sameQuantity(c.before.quantity, c.after.quantity)) continue;
      const zero = knownZero(c.after.quantity);
      const readyAt = zero && c.after.mergedInto === null
        ? c.after.quantity.terms.reduce((latest, t) => Math.max(latest, times.get(t.observation.id) ?? at), at) : at;
      changes.push({ ...base, at: readyAt, kind: 'quantity', occupied: c.after.mergedInto === null && !zero });
    }
  });
  return changes.sort((a, b) => a.at - b.at || a.version - b.version);
}

// 数量を再計算せず、場所と物の有無の変更だけから滞在期間を引く。数が不明・だいたい0は、物がない証拠にはしない。
// 遅れて入力した数量の記録に写っている現在の場所を、過去の移動として扱わない。
function residencesOf(ledger: Ledger, times: ReadonlyMap<string, number>): Residence[] {
  const states = new Map<string, { place: string | undefined; occupied: boolean; version: number; from: number; eventId: string }>();
  const residences: Residence[] = [];
  for (const c of residenceChanges(ledger, times)) {
    const previous = states.get(c.lotId);
    // 後続の数え直しなどが独立した数量の根拠を作ったなら、古い数量の写しで物を復活させない。
    if (c.kind === 'quantity' && previous !== undefined && c.version < previous.version) continue;
    const place = c.kind === 'place' ? c.place : previous?.place;
    const occupied = c.kind === 'quantity' ? c.occupied : previous?.occupied ?? false;
    const version = c.kind === 'quantity' ? c.version : previous?.version ?? -1;
    const unchanged = previous?.place === place && previous?.occupied === occupied;
    if (!unchanged && previous?.occupied && previous.place !== undefined) {
      residences.push({ lotId: c.lotId, place: previous.place, from: previous.from, until: c.at, eventId: c.eventId });
    }
    states.set(c.lotId, { place, occupied, version, from: unchanged ? previous.from : c.at, eventId: unchanged ? previous.eventId : c.eventId });
  }
  for (const [lotId, state] of states) {
    if (state.occupied && state.place !== undefined) residences.push({ lotId, place: state.place, from: state.from, until: Infinity, eventId: state.eventId });
  }
  return residences;
}

// 記録の対象外の期間（from以後、untilより前。untilがnullなら今まで）と食い違う記録を引く（要件7.2・7.4、ADR-024）。
function scopeProblem(ledger: Ledger, place: LocationMaster, from: string, until: string | null, times: ReadonlyMap<string, number>, residences: readonly Residence[]): ScopeProblem {
  const start = Date.parse(from);
  const end = until === null ? Infinity : Date.parse(until);
  const at = (e: LedgerEvent) => times.get(e.eventId)!;
  return {
    // 外へ出た物を手元として数え続けたり、記録なしに手元から外したりしない。
    remaining: until !== null ? [] : Object.values(ledger.lots).filter((l) => l.location === place.id && l.mergedInto === null && !knownZero(l.quantity)).map((l) => l.id),
    // 記録の対象外になった時点より後に置いた記録が、記録の対象外への置き場所になり、7.4を後から破る。
    placed: ledger.history.filter((e) => placedLocation(e) === place.id && at(e) >= start && at(e) < end).map((e) => e.eventId),
    // 再開後に出発しても、対象外だった期間との重なりは残る。再開後に着いた物・0から増えた物はその期間に含めない。
    held: residences.filter((r) => r.place === place.id && r.from < end && r.until > start && r.from < r.until)
      .map((r) => ({ lotId: r.lotId, eventId: r.eventId, from: Math.max(r.from, start), until: Math.min(r.until, end) })),
  };
}

// 記録の対象の外へ変えてよいか。適用時点を過去にすると、その時点以後の置き場所や手元の物の記録と食い違うので、記録を引いて確かめる。
function checkScopeOut(ledger: Ledger, place: LocationMaster, from: string): void {
  const times = eventTimes(ledger);
  const { remaining, placed, held } = scopeProblem(ledger, place, from, null, times, residencesOf(ledger, times));
  if (remaining.length > 0) throw new Error(`場所 ${place.code} に保管単位が残っている（${remaining.join('・')}）。先に移動か外への引渡しを記録する`);
  if (placed.length > 0) throw new Error(`場所 ${place.code} には適用時点（${from}）以後に置いた記録がある（${placed.join('・')}）。適用時点を、その記録より後にする`);
  if (held.length > 0) throw new Error(`場所 ${place.code} には適用時点（${from}）より後まで置いていた物の記録がある（${held.map((r) => r.eventId).join('・')}）。適用時点を、その記録より後にする`);
}

// 記録の対象外の場所と食い違う記録の一覧（キー→説明）。
type ScopeConflict = { message: string; periods: Period[] };

function scopeConflicts(ledger: Ledger): Map<string, ScopeConflict> {
  const found = new Map<string, ScopeConflict>();
  const places = Object.values(ledger.masters.locations).filter((l) => l.scope.some((s) => !s.inScope && s.from !== null));
  if (places.length === 0) return found;
  const times = eventTimes(ledger);
  const residences = residencesOf(ledger, times);
  for (const place of places) {
    place.scope.forEach((entry, i) => {
      if (entry.inScope || entry.from === null) return;
      const { remaining, placed, held } = scopeProblem(ledger, place, entry.from, place.scope[i + 1]?.from ?? null, times, residences);
      for (const id of remaining) found.set(JSON.stringify([place.id, entry.from, 'remaining', id]), { message: `場所 ${place.code} に、記録の対象外になったあとも物が残る（保管単位${id}）`, periods: [] });
      for (const id of placed) found.set(JSON.stringify([place.id, entry.from, 'placed', id]), { message: `場所 ${place.code} が記録の対象外になった適用時点（${entry.from}）以後に、物が置かれたことになる（操作${id}）`, periods: [] });
      for (const r of held) {
        const key = JSON.stringify([place.id, entry.from, 'held', r.lotId]);
        const periods = found.get(key)?.periods ?? [];
        periods.push({ from: r.from, until: r.until });
        found.set(key, { message: `場所 ${place.code} に、記録の対象外になった適用時点（${entry.from}）より後まで物が置かれていたことになる（操作${r.eventId}）`, periods });
      }
    });
  }
  return found;
}

// 新しい記録（日時の訂正・取消・過去の日時での登録を含む）で、記録の対象外の場所に物が残る・置かれる前提を新しく作らない（ADR-024）。
// 受け付ける前から食い違っていた記録は、この記録と関係なければ止めない。
function keepScopeOut(before: Ledger, after: Ledger): void {
  const now = scopeConflicts(after);
  if (now.size === 0) return;
  const known = scopeConflicts(before);
  const added = [...now].find(([key, conflict]) => {
    const previous = known.get(key);
    return previous === undefined || conflict.periods.some((p) => !coveredPeriod(p, previous.periods));
  });
  if (added) throw new Error(`${added[1].message}。先に別の場所へ移す・外へ引き渡す記録を入れるか、日時を見直す（外れた場所には、あとから物を残す記録を入れられない）`);
}

// 既存の対象外期間の滞在を解消・短縮する記録は通す。操作IDが変わっても、重なりが新しく増えた部分だけを断る。
function coveredPeriod(period: Period, previous: readonly Period[]): boolean {
  let until = period.from;
  for (const p of [...previous].sort((a, b) => a.from - b.from)) {
    if (p.from > until) break;
    until = Math.max(until, p.until);
    if (until >= period.until) return true;
  }
  return false;
}

function planScope(ledger: Ledger, meta: Meta, request: Request<'scope'>): MasterPlan {
  const m = masterOf(ledger.masters, 'location', request.id);
  if (m.type !== 'location') throw new Error(`場所 ${request.id} は登録されていない`);
  required(request.reason, '理由');
  const from = effectiveFrom(meta, m.scope);
  if (m.scope[m.scope.length - 1]?.inScope === request.inScope) throw new Error(`今と同じ記録の対象（${request.inScope ? '内' : '外'}）`);
  if (!request.inScope) checkScopeOut(ledger, m, from);
  return planOne(m, { ...m, scope: [...m.scope, { from, inScope: request.inScope }] });
}

function masterPlan(ledger: Ledger, meta: Meta, request: MasterRequest, confirmed: boolean): MasterPlan {
  switch (request.action) {
    case 'trial': return planTrial(ledger, request);
    case 'register': return planOne(null, registered(ledger.masters, meta.eventId, request.master));
    case 'rename': return planRename(ledger, request);
    case 'deactivate':
    case 'reactivate': return planActive(ledger, meta, request);
    case 'code': return planCode(ledger, request, confirmed);
    case 'source': return planSource(ledger, request, confirmed);
    case 'perBox': return planPerBox(ledger, meta, request);
    case 'packaging': case 'consumable': return planItemSetting(ledger, meta, request);
    case 'scope': return planScope(ledger, meta, request);
  }
}

// 識別は利用者が入力した文字列なので、「__proto__」のような名前でも辞書の自前の欄として持つよう、計算したキーで作り直す。
function withMasters(masters: Masters, changes: readonly MasterChange[]): Masters {
  let { items, locations, cases, actors } = masters;
  for (const { after } of changes) {
    switch (after.type) {
      case 'item': items = { ...items, [after.id]: after }; break;
      case 'location': locations = { ...locations, [after.id]: after }; break;
      case 'case': cases = { ...cases, [after.id]: after }; break;
      case 'actor': actors = { ...actors, [after.id]: after }; break;
    }
  }
  return { items, locations, cases, actors };
}

const issueRecordedAt = (ledger: Ledger, issueId: string): string | undefined => ledger.history.find((e) => e.eventId === issueId)?.recordedAt;

// 実際の日時が不明のときに時点の代わりにする入力した日時。仮の記録から登録したまとまりは、仮の記録を記録した時点（仮の決定）。
function fallbackTime(ledger: Ledger, e: LedgerEvent): string {
  return (e.kind === 'adopt' ? issueRecordedAt(ledger, e.issueId) : undefined) ?? e.recordedAt;
}

// 仮の記録の品目が分かっているのに違う品目へ対応付けるときは、品目の取り違いかどうかを確認する（仮の決定）。仮の記録の品目は直せないので断らない。品目の分からない仮の記録は確認しない。
function foundItemWarning(ledger: Ledger, origin: ProvisionalContent, item: string): string | null {
  if (origin.item === null || origin.item === item) return null;
  return `仮の記録の品目（${refOf(ledger.masters.items, origin.item)}）と違う品目（${refOf(ledger.masters.items, item)}）に対応付ける`;
}

// 対応付けの対象になる、見つかった物の未解消の仮の記録。減った物は適用先の分からない減少で、今と同じく閉じるだけにする（要件8.8）。
function openFound(ledger: Ledger, issueId: string): { issue: Issue; origin: LedgerEvent & ProvisionalContent } {
  const issue = ledger.issues[issueId];
  const origin = ledger.history.find((e) => e.eventId === issueId);
  if (!issue || issue.reason !== 'unassigned' || origin?.kind !== 'provisional') throw new Error(`確認事項 ${issueId} は仮の記録の確認事項ではない`);
  if (issue.resolution !== null) throw new Error(`確認事項 ${issueId} は解消済み`);
  if (origin.direction !== 'found') throw new Error('減った物の仮の記録は対応付けない。確認事項として閉じる');
  return { issue, origin };
}

// 仮の記録の数量はそのまとまりに含まれているとみなし、足さない（要件8.1、二重計上しない）。
export function identifyProvisional(ledger: Ledger, meta: Meta, issueId: string, lotId: string, reason: string, confirmed = false): Ledger {
  const { issue, origin } = openFound(ledger, issueId);
  required(reason, '理由');
  const warning = foundItemWarning(ledger, origin, open(ledger, lotId).item);
  if (warning !== null && !confirmed) throw new ConfirmationRequired('identify', `${warning}。取り違いでなければ、確認して対応付ける`, [lotId]);
  const resolution: Resolution = { eventId: meta.eventId, outcome: 'close', actor: meta.actor };
  return commit(ledger, { kind: 'identify', issueId, lotId, reason }, meta, [], [{ ...issue, resolution }]);
}

// 同じ品目の現存するまとまりがあれば、同じ現物を二重に登録しないよう、別の現物と確認してから登録する（要件8.2・8.3）。
export function adoptProvisional(ledger: Ledger, meta: Meta, issueId: string, lot: NewLot, confirmed = false): Ledger {
  const { issue, origin } = openFound(ledger, issueId);
  const at: Meta = { ...meta, occurredAt: occurredAtOf(ledger, issueId) };
  // 実際の日時が不明な仮の記録の物は、仮の記録を記録した時点には手元にあった。登録を記録した時点で記録の対象を判断しない（仮の決定）。
  const placedAt = at.occurredAt === null ? { ...at, recordedAt: issueRecordedAt(ledger, issueId) ?? meta.recordedAt } : at;
  const created = newLot(ledger, placedAt, lot, noStage, origin.basis, origin.value);
  const candidates = Object.values(ledger.lots).filter((l) => l.item === lot.item && l.mergedInto === null);
  const warning = foundItemWarning(ledger, origin, lot.item);
  if ((candidates.length > 0 || warning !== null) && !confirmed) {
    const same = candidates.length === 0 ? '' : `品目${refOf(ledger.masters.items, lot.item)}の現存する保管単位がある（${candidates.map((l) => `${l.id}：場所${refOf(ledger.masters.locations, l.location)}`).join('、')}）。仮の記録の物がこれらと別の現物なら、確認して登録する。同じ現物なら、既存の保管単位へ対応付ける`;
    throw new ConfirmationRequired('adopt', [warning === null ? '' : `${warning}。取り違いでなければ、確認して登録する`, same].filter((t) => t !== '').join('。'), candidates.map((l) => l.id));
  }
  const resolution: Resolution = { eventId: meta.eventId, outcome: 'apply', actor: meta.actor };
  return commit(ledger, { kind: 'adopt', issueId, lotId: lot.id }, at, [created], [{ ...issue, resolution }]);
}

// 結び付け先で同じ品目の現存するまとまりがあれば、同じ現物を二重に数えていないか確認してから結び付ける（要件8.4・8.5）。
export function assignProject(ledger: Ledger, meta: Meta, lotId: string, project: Project, reason: string, confirmed = false): Ledger {
  const lot = open(ledger, lotId);
  if (lot.project.kind !== 'unassigned') throw new Error(`保管単位 ${lotId} の案件・用途は不明でない`);
  if (project.kind === 'unassigned') throw new Error('結び付け先は案件・用途か共通在庫にする');
  usableProject(ledger, project);
  required(reason, '理由');
  notBeforeCreation(ledger, lot, meta.occurredAt);
  const candidates = Object.values(ledger.lots).filter((l) => l.id !== lotId && l.item === lot.item && l.mergedInto === null && sameProject(l.project, project));
  if (candidates.length > 0 && !confirmed) {
    throw new ConfirmationRequired('assignProject', `結び付け先に品目${refOf(ledger.masters.items, lot.item)}の現存する保管単位がある（${candidates.map((l) => `${l.id}：場所${refOf(ledger.masters.locations, l.location)}`).join('、')}）。${lotId}がこれらと別の現物なら、確認して結び付ける`, candidates.map((l) => l.id));
  }
  return commit(ledger, { kind: 'assignProject', lotId, before: lot.project, after: { ...project }, reason }, meta, [{ ...lot, project: { ...project } }]);
}

// 登録情報の変更の入口（要件1〜7）。変えた登録情報の前後を履歴に残し、まとまり・依頼・中断は書き換えない。
export function changeMasters(ledger: Ledger, meta: Meta, request: MasterRequest, confirmed = false): Ledger {
  const plan = masterPlan(ledger, meta, request, confirmed);
  const reason = 'reason' in request ? request.reason : null;
  const detail: EventDetail = request.action === 'trial'
    ? { kind: 'master', action: 'trial', reason: request.reason, confirmed: false, masters: plan.changes, review: request.review === null ? null : { ...request.review } }
    : { kind: 'master', action: request.action, reason, confirmed: plan.confirmed, masters: plan.changes };
  const next = commit(ledger, detail, meta, [], [], [], withMasters(ledger.masters, plan.changes));
  if (request.action === 'perBox' || request.action === 'packaging') checkMergedPerBox(ledger, next, request.action === 'perBox' ? '1箱あたりの数を変えると' : '入り数を設定すると');
  return next;
}

export type ReworkPartRequest = { reworkId: string; subjectLotId: string; reason: string } & (
  | { action: 'replace'; lotId: string; value: number }
  | { action: 'recover'; lotId: string; item: string; unit: string; location: string; value: number }
  | { action: 'discard'; item: string; unit: string; value: number }
);
type ReworkEvent = LedgerEvent & Extract<Decrease, { kind: 'rework' }>;

export type ReturnedReworkRequest = {
  lotId: string; adoptEventId: string; childId: string; process: Process;
  basis: Basis; value: number | null; reason: string; confirmedPhysical: boolean;
};

function checkReturnedSource(ledger: Ledger, lot: Lot, adoptEventId: string, limit = ledger.history.length): void {
  const prior = ledger.history.slice(0, limit);
  const adopted = prior.find(e => e.eventId === adoptEventId);
  const created = prior.find(e => e.changes.some(c => c.after.id === lot.id && c.before === null));
  if (adopted?.kind !== 'adopt' || adopted.lotId !== lot.id || created !== adopted || lot.splitFrom !== null
    || adopted.changes.length !== 1 || adopted.changes[0]?.after.stage.kind !== 'none') throw new Error('元の現物を直接作った新規割当の記録を選ぶ');
  const origin = prior.find(e => e.eventId === adopted.issueId);
  const issue = own(ledger.issues, adopted.issueId);
  if (origin?.kind !== 'provisional' || origin.direction !== 'found' || prior.indexOf(origin) >= prior.indexOf(adopted)
    || issue?.reason !== 'unassigned' || issue.resolution?.eventId !== adoptEventId || issue.resolution.outcome !== 'apply') throw new Error('見つかった物の仮の記録と新規割当の対応が不正');
  if (prior.some(e => e.kind === 'merge' && e.changes.some(c => c.after.id !== lot.id && c.after.mergedInto === lot.id))) throw new Error('別の現物を統合した元からの返ってきた物のやり直し・修理は、対象を確かめられない');
}

export function beginReturnedRework(ledger: Ledger, meta: Meta, request: ReturnedReworkRequest, answer?: Inclusion): Ledger {
  const lot = open(ledger, request.lotId);
  if (lot.stage.kind !== 'none') throw new Error('返ってきた物のやり直し・修理元は作業をしていない現物を選ぶ');
  if (!request.confirmedPhysical) throw new Error('返ってきた物の新しい物理的なやり直し・修理であることを確認する');
  checkReturnedSource(ledger, lot, request.adoptEventId);
  checkReturnedReworkTime(occurredAtOf(ledger, request.adoptEventId), meta.occurredAt);
  const process = { ...request.process, id: request.process.id.trim() };
  required(process.id, 'やり直し・修理の工程');
  if (request.process.criterion !== 'workEnd' && request.process.criterion !== 'inspection') throw new Error('工程の完了基準を選ぶ');
  const existing = [...processes, ...Object.values(ledger.lots).flatMap(l => l.stage.kind === 'none' ? [] : [l.stage.process])];
  if (existing.some(p => p.id.trim() === process.id && p.criterion !== process.criterion)) throw new Error(`工程 ${process.id} の完了基準が既存の工程と異なる。既存の完了基準を選ぶ`);
  if (lot.project.kind === 'unassigned') throw new Error('やり直し・修理の元の案件・用途を確認する');
  const place = own(ledger.masters.locations, lot.location);
  if (!place) throw new Error(`場所 ${lot.location} は手元の管理場所ではない`);
  inScope(place, meta.occurredAt ?? meta.recordedAt);
  required(request.childId, 'やり直し・修理分の新しいID');
  required(request.reason, 'やり直し・修理の理由');
  unused(ledger, request.childId);
  const taken = quantityOf(observeFor(ledger, lot, meta.eventId, request.basis, request.value));
  const inclusion = inclusionOf(ledger, lot, meta.occurredAt, answer);
  const parent = confirmedDecrease(ledger, lot, taken, inclusion);
  const child: Lot = { ...lot, id: request.childId, quantity: taken, lastCount: countOf(meta.eventId, request.basis, request.value), splitFrom: lot.id, mergedInto: null, stage: { kind: 'working', process } };
  notStagedAtNextProcess(child.id, child.stage, lot.location, '返ってきた物をやり直し・修理する手元の場所へ移動してから開始する');
  return commit(ledger, { kind: 'rework', lotId: lot.id, childId: child.id, reason: request.reason, basis: request.basis, value: request.value, applied: true, inclusion,
    returnSource: { adoptEventId: request.adoptEventId, process, confirmedPhysical: true } }, meta, [parent, child]);
}

function confirmedDecrease(ledger: Ledger, lot: Lot, taken: Quantity, inclusion: Inclusion | null): Lot {
  if (openIssuesOf(ledger, lot.id).length > 0) throw new Error('元の保管単位に未解決の確認事項がある。先に数量を確認する');
  if (lot.quantity.kind !== 'known' || taken.kind !== 'known' || taken.numeric.value <= 0) throw new Error('元の数量と正の移す数量が必要。不明なら先に数量を確認する');
  if (inclusion === 'included' || inclusion === 'unknown') throw new Error('親から減らせるか確認が必要。数量と対応を確認してから記録する');
  const parent = decreased(ledger, lot, taken);
  if (!parent) throw new Error('元の残数が負になる。先に数量を確認する');
  return parent;
}

export function beginRework(ledger: Ledger, meta: Meta, lotId: string, childId: string, basis: Basis, value: number | null, reason: string, answer?: Inclusion): Ledger {
  const lot = open(ledger, lotId);
  if (lot.stage.kind !== 'awaitingHandover') throw new Error('やり直し・修理開始は手元の完成（渡す前）の現物を選ぶ');
  if (lot.project.kind === 'unassigned') throw new Error('やり直し・修理の元の案件・用途を確認する');
  const place = own(ledger.masters.locations, lot.location);
  if (!place) throw new Error(`場所 ${lot.location} は手元の管理場所ではない`);
  inScope(place, meta.occurredAt ?? meta.recordedAt);
  required(childId, 'やり直し・修理分の新しいID');
  required(reason, 'やり直し・修理の理由');
  unused(ledger, childId);
  const taken = quantityOf(observeFor(ledger, lot, meta.eventId, basis, value));
  const inclusion = inclusionOf(ledger, lot, meta.occurredAt, answer);
  const parent = confirmedDecrease(ledger, lot, taken, inclusion);
  const child: Lot = { ...lot, id: childId, quantity: taken, lastCount: countOf(meta.eventId, basis, value), splitFrom: lot.id, mergedInto: null, stage: { kind: 'working', process: { ...lot.stage.process } } };
  return commit(ledger, { kind: 'rework', lotId, childId, reason, basis, value, applied: true, inclusion }, meta, [parent, child]);
}

export function reworksOf(ledger: Ledger, lotId: string): ReworkEvent[] {
  const events = ledger.history.filter((e): e is ReworkEvent => e.kind === 'rework');
  if (events.length === 0) return [];
  const seen = ancestorsOf(ledger, [lotId]);
  return events.filter(e => seen.has(e.childId));
}

function ancestorsOf(ledger: Ledger, lotIds: string[]): Set<string> {
  const mergedFrom = new Map<string, string[]>();
  for (const lot of Object.values(ledger.lots)) {
    if (lot.mergedInto === null) continue;
    const sources = mergedFrom.get(lot.mergedInto) ?? [];
    sources.push(lot.id);
    mergedFrom.set(lot.mergedInto, sources);
  }
  const seen = new Set<string>(), pending = [...lotIds];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const parent = ledger.lots[id]?.splitFrom;
    if (parent) pending.push(parent);
    for (const source of mergedFrom.get(id) ?? []) pending.push(source);
  }
  return seen;
}

function recoveredRegisters(ledger: Ledger): ReadonlySet<string> {
  return new Set(ledger.history.flatMap(e => e.kind === 'reworkPart' && e.action === 'recover' ? [e.registerEventId] : []));
}

function createdLotId(e: LedgerEvent, recovered: ReadonlySet<string>): string | null {
  if (e.kind === 'split' || e.kind === 'stage' || e.kind === 'transfer' || e.kind === 'rework') return e.childId;
  if (e.kind === 'start') return e.lotId;
  if (e.kind === 'register' && recovered.has(e.eventId)) return e.changes[0]?.after.id ?? null;
  return null;
}

function reworkEvent(ledger: Ledger, eventId: string): ReworkEvent {
  const e = ledger.history.find(e => e.eventId === eventId);
  if (e?.kind !== 'rework') throw new Error(`やり直し・修理開始の記録 ${eventId} がない`);
  return e;
}

function positiveCount(ledger: Ledger, ref: Pick<Lot, 'item' | 'unit'>, eventId: string, value: number): void {
  observeFor(ledger, ref, eventId, 'counted', value);
  if (value <= 0) throw new Error('実際に処置した正の実数を入力する');
}

export function recordReworkPart(ledger: Ledger, meta: Meta, request: ReworkPartRequest, answer?: Inclusion): Ledger {
  const rework = reworkEvent(ledger, request.reworkId);
  const source = ledger.lots[rework.childId];
  if (!source) throw new Error('やり直し・修理の元の現物がない');
  required(request.subjectLotId, '処置した対象枝');
  required(request.reason, '部品処置の理由');
  if (isAfter(occurredAtOf(ledger, rework.eventId), meta.occurredAt)) throw new Error('部品処置をやり直し・修理開始より前には記録しない');
  const detail = { kind: 'reworkPart', reworkId: request.reworkId, subjectLotId: request.subjectLotId, reason: request.reason } as const;
  switch (request.action) {
    case 'replace': {
      const lot = open(ledger, request.lotId);
      if (lot.project.kind !== 'common' && !sameProject(lot.project, source.project)) throw new Error('交換部品はやり直し・修理と同じ案件・用途または共通在庫から選ぶ');
      positiveCount(ledger, lot, meta.eventId, request.value);
      const useEventId = `${meta.eventId}-use`;
      const taken = quantityOf(observeFor(ledger, lot, useEventId, 'counted', request.value));
      confirmedDecrease(ledger, lot, taken, inclusionOf(ledger, lot, meta.occurredAt, answer));
      const next = use(ledger, { ...meta, eventId: useEventId }, lot.id, 'counted', request.value, `手直し ${request.reworkId}：${request.reason}`, answer);
      return commit(next, { ...detail, action: 'replace', useEventId }, meta, []);
    }
    case 'recover': {
      positiveCount(ledger, request, meta.eventId, request.value);
      const registerEventId = `${meta.eventId}-recover`;
      const next = register(ledger, { ...meta, eventId: registerEventId }, { id: request.lotId, item: request.item, unit: request.unit, project: source.project, location: request.location }, 'counted', request.value);
      const held = hold(next, { ...meta, eventId: `${meta.eventId}-hold` }, request.lotId, 'usabilityCheck', request.reason);
      return commit(held, { ...detail, action: 'recover', registerEventId }, meta, []);
    }
    case 'discard':
      positiveCount(ledger, request, meta.eventId, request.value);
      usableItem(ledger, request.item);
      required(request.unit, '単位');
      return commit(ledger, { ...detail, action: 'discard', item: request.item, unit: request.unit, value: request.value }, meta, []);
  }
}

// 中間の日時が不明でも、両端の既知日時の逆転を見逃さない（ADR-027）。
function checkReworkTimes(ledger: Ledger, at: (id: string) => string | null): void {
  for (const e of ledger.history) {
    if (e.kind !== 'reworkPart') continue;
    const ids = [e.reworkId, ...(e.action === 'replace' ? [e.useEventId] : e.action === 'recover' ? [e.registerEventId] : []), e.eventId];
    for (const [i, before] of ids.entries()) {
      for (const after of ids.slice(i + 1)) {
        if (isAfter(at(before), at(after))) throw new Error('やり直し・修理開始・部品処置・対応記録の前後が逆になる');
      }
    }
  }
}

export function createdAtOf(ledger: Ledger, lotId: string): string | null {
  const e = creationOf(ledger, lotId);
  return e ? occurredAtOf(ledger, e.eventId) : null;
}

function creationOf(ledger: Ledger, lotId: string): LedgerEvent | undefined {
  return ledger.history.find(e => e.changes.some(c => c.before === null && c.after.id === lotId));
}

// 枝の現物が、cutoff の時点で全部 rootId のやり直し・修理から作業中・確認検査待ちのまま来たと言えるか。
// 完了を経た枝は再やり直し・修理の元なので含めない。cutoff より後と言える統合だけを無視し、日時不明の統合は帰属を確かめる。
// 分けた枝を元へ戻す統合では、たどる経路が確認中の枝へ戻る。外からの流入ではないので、ほかの統合の確認に任せる。
function attributable(ledger: Ledger, lotId: string, rootId: string, cutoff: string | null, visiting: Set<string>): boolean {
  if (visiting.has(lotId)) return true;
  visiting.add(lotId);
  const splitAncestors = new Set<string>();
  for (let id: string | null = lotId; id !== null;) {
    if (splitAncestors.has(id)) return false;
    splitAncestors.add(id);
    const lot: Lot | undefined = ledger.lots[id];
    if (!lot || (lot.stage.kind !== 'working' && lot.stage.kind !== 'inspecting')) return false;
    for (const e of ledger.history) {
      const source = e.kind === 'merge' ? e.changes.find(c => c.after.mergedInto === id)?.after : undefined;
      if (!source) continue;
      const mergedAt = occurredAtOf(ledger, e.eventId);
      if (!isAfter(mergedAt, cutoff) && !attributable(ledger, source.id, rootId, mergedAt, visiting)) return false;
    }
    if (id === rootId) return true;
    cutoff = createdAtOf(ledger, id);
    id = lot.splitFrom;
  }
  return false;
}

// 再完了した物への新しい作業を旧やり直し・修理へ足さない一方、部分完了の残りへの作業と過去の処置の後入力は通す（ADR-039の3）。
// 保管単位の作業の状態はできた時から変わらないので、現在の記録と各操作の日時だけで照合できる。
function checkReworkSubjects(ledger: Ledger): void {
  for (const part of ledger.history) {
    if (part.kind !== 'reworkPart' || part.subjectLotId === undefined) continue;
    const subject = ledger.lots[part.subjectLotId];
    if (subject?.stage.kind !== 'working' && subject?.stage.kind !== 'inspecting') {
      throw new Error(`対象枝 ${part.subjectLotId} は作業中・確認検査待ちでない。再完了した物への新しい作業は別のやり直し・修理として開始する`);
    }
    const t = occurredAtOf(ledger, part.eventId);
    if (t === null) throw new Error('対象枝への部品処置は実際の日時が必要。不明なままでは処置した枝を確かめられない');
    if (isAfter(createdAtOf(ledger, subject.id), t)) throw new Error(`対象枝 ${subject.id} ができる前の処置は記録しない。そのときの枝を選ぶ`);
    if (!attributable(ledger, subject.id, reworkEvent(ledger, part.reworkId).childId, t, new Set())) {
      throw new Error(`対象枝 ${subject.id} の現物がやり直し・修理 ${part.reworkId} から来たと確かめられない。処置した時点の工程と分割・統合の履歴を確認し、実際に処置したやり直し・修理と対象枝を選ぶ`);
    }
    const ends = emptiedAtOf(ledger, subject.id);
    if (ends.includes(null)) throw new Error(`対象枝 ${subject.id} を空にした操作の日時が不明。先に日時を確認・訂正する`);
    if (ends.some(end => isAfter(t, end))) throw new Error(`対象枝 ${subject.id} が空になった後の処置。再完了した物への新しい作業は別のやり直し・修理として開始する`);
  }
}

// 照合は処置数×履歴に比例するので、attributable が辿る単位（対象枝から分割元・統合元を遡った全部）を変える記録と、
// 日時・取消・処置の記録のときだけ行う。
function touchesReworkSubject(ledger: Ledger, kind: EventDetail['kind'], lots: readonly Lot[]): boolean {
  if (kind === 'reworkPart' || kind === 'correctTime' || kind === 'void') return true;
  const pending = ledger.history.flatMap(e => e.kind === 'reworkPart' && e.subjectLotId !== undefined ? [e.subjectLotId] : []);
  if (pending.length === 0) return false;
  const traced = ancestorsOf(ledger, pending);
  return lots.some(lot => traced.has(lot.id));
}

// 推定・未確認の根拠でも0と記録したなら空とする。数が不明の減算では空と決めない。
function emptiedAtOf(ledger: Ledger, lotId: string): (string | null)[] {
  return ledger.history.flatMap(e => {
    const after = e.changes.find(c => c.before !== null && c.after.id === lotId)?.after;
    const emptied = after && (after.mergedInto !== null || (after.quantity.kind === 'known' && after.quantity.numeric.value === 0));
    return emptied && !isVoided(ledger, e.eventId) ? [occurredAtOf(ledger, e.eventId)] : [];
  });
}

function sameReworkIdentity(a: Lot, b: Lot): boolean {
  return a.id === b.id && a.item === b.item && a.unit === b.unit && sameProject(a.project, b.project)
    && sameStage(a.stage, b.stage)
    && a.splitFrom === b.splitFrom;
}

function sameLotRecord(a: Lot, b: Lot): boolean {
  return sameReworkIdentity(a, b) && a.location === b.location && a.mergedInto === b.mergedInto
    && a.holds.length === b.holds.length && a.holds.every((h, i) => h === b.holds[i])
    && sameQuantity(a.quantity, b.quantity)
    && (a.lastCount === null || b.lastCount === null ? a.lastCount === b.lastCount : a.lastCount.eventId === b.lastCount.eventId && a.lastCount.value === b.lastCount.value);
}

function validateReworkChange(ledger: Ledger, e: ReworkEvent): void {
  const parent = e.changes.find(c => c.after.id === e.lotId), child = e.changes.find(c => c.after.id === e.childId);
  const currentParent = ledger.lots[e.lotId], currentChild = ledger.lots[e.childId];
  if (e.changes.length !== 2 || !parent?.before || !child || child.before !== null || !currentParent || !currentChild) throw new Error('やり直し・修理の元現物と子の対応が不正');
  const before = parent.before, taken = quantityOf(observeFor(ledger, parent.before, e.eventId, e.basis, e.value));
  const after = decreased(ledger, before, taken);
  let process: Process;
  if (e.returnSource !== undefined) {
    if (before.stage.kind !== 'none') throw new Error('返ってきた物のやり直し・修理元の工程が不正');
    checkReturnedSource(ledger, before, e.returnSource.adoptEventId, ledger.history.indexOf(e));
    process = e.returnSource.process;
    required(process.id, 'やり直し・修理の工程');
    if (child.after.stage.kind !== 'working' || child.after.stage.process.criterion !== process.criterion) throw new Error('やり直し・修理子の完了基準が不正');
    // 所属判明前の現物は開始できず、開始後の所属・品目・工程の変更は常に新しい子を作る。
    if (!sameReworkIdentity(currentParent, before) || !sameReworkIdentity(currentChild, child.after)
      || currentChild.stage.kind !== 'working' || currentChild.stage.process.criterion !== process.criterion) throw new Error('返ってきた物のやり直し・修理の現在の元現物・子と生成時の識別・工程が一致しない');
  } else {
    if (before.stage.kind !== 'awaitingHandover') throw new Error('やり直し・修理元は完成（渡す前）でない');
    process = before.stage.process;
  }
  if (before.quantity.kind !== 'known' || before.project.kind === 'unassigned' || before.mergedInto !== null || !after || !sameLotRecord(parent.after, after)) throw new Error('やり直し・修理元の減算が不正');
  const expected: Lot = { ...before, id: e.childId, quantity: taken, lastCount: countOf(e.eventId, e.basis, e.value), splitFrom: before.id, mergedInto: null, stage: { kind: 'working', process } };
  if (!sameLotRecord(child.after, expected)) throw new Error('やり直し・修理子の数量・属性が不正');
}

function checkReturnedReworkTime(adoptedAt: string | null, startedAt: string | null): void {
  if (isAfter(adoptedAt, startedAt)) throw new Error('新規割当の現物ができる前にやり直し・修理を開始しない');
}

function checkReturnedReworkTimes(ledger: Ledger, at: (id: string) => string | null): void {
  for (const e of ledger.history) {
    if (e.kind === 'rework' && e.returnSource !== undefined) checkReturnedReworkTime(at(e.returnSource.adoptEventId), at(e.eventId));
  }
}

export function validateReworkLinks(ledger: Ledger): void {
  const events = new Map(ledger.history.map(e => [e.eventId, e]));
  const used = new Set<string>();
  for (const e of ledger.history) {
    if (e.kind === 'rework') validateReworkChange(ledger, e);
    if (e.kind !== 'reworkPart') continue;
    const rework = reworkEvent(ledger, e.reworkId);
    const source = rework.changes.find(c => c.after.id === rework.childId)?.after;
    if (!source) throw new Error('やり直し・修理の元の現物がない');
    if (e.action === 'discard') continue;
    const id = e.action === 'replace' ? e.useEventId : e.registerEventId;
    const record = events.get(id);
    if (used.has(id)) throw new Error('部品記録を複数のやり直し・修理へ対応付けている');
    used.add(id);
    if (e.action === 'replace') {
      if (record?.kind !== 'use' || !record.applied || record.basis !== 'counted' || record.value === null || record.value <= 0 || isVoided(ledger, id) || ledger.history.some(s => s.kind === 'start' && s.materials.includes(id))) throw new Error('やり直し・修理の交換使用の参照が不正');
      const part = record.changes.find(c => c.after.id === record.lotId)?.before;
      if (!part || !ledger.lots[part.id] || (part.project.kind !== 'common' && !sameProject(part.project, source.project))) throw new Error('交換使用とやり直し・修理の案件・用途対応が不正');
    } else {
      const lot = record?.changes[0]?.after;
      if (record?.kind !== 'register' || !lot || !ledger.lots[lot.id] || !sameProject(lot.project, source.project) || record.changes[0]?.before !== null || !ledger.history.some(h => h.kind === 'hold' && h.reason === 'usabilityCheck' && h.changes.some(c => c.after.id === lot.id))) throw new Error('やり直し・修理の回収記録と確認待ちの参照が不正');
    }
  }
  checkReworkTimes(ledger, id => occurredAtOf(ledger, id));
  checkReturnedReworkTimes(ledger, id => occurredAtOf(ledger, id));
  checkReworkSubjects(ledger);
}
