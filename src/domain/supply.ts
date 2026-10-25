import type { Basis, Quantity } from './quantity.ts';
import type { NeedImportDetail } from './need-import.ts';
import type { ReceiptTemplate, TemplateReceipt } from './receipt-template.ts';
import type { UsageEstimate } from './usage-estimate.ts';
import { observe } from './quantity.ts';
import { inputStepOf, own, quantityStepOf, type Masters } from './masters.ts';
import { addScalar, subtractScalar, sumScalars, validateScalar, type Step } from './scalar.ts';
import { checkTime, createdAtOf, deepFreeze, occurredAtOf, register, voidOf, type HoldReason, type Ledger, type Lot, type Meta, type Project } from './ledger.ts';
import { captureItemLabels, type EventItemLabels } from './history-labels.ts';
import { supplyEventItemIds } from './history-targets.ts';

// 日付（必要日・依頼日・予定日）は日本時間の YYYY-MM-DD の文字列で持つ。発生・記録の日時は台帳と同じ時刻帯付き。
export type DateText = string;

export type CaseProject = Extract<Project, { kind: 'case' }>;

export type NeedQuantity = { basis: Basis; value: number | null };

// 必要明細。案件・用途・品目・単位の組で一つ（ID は登録した操作のID）。
export type Need = {
  id: string;
  project: CaseProject;
  item: string;
  unit: string;
  required: NeedQuantity;
  dueDate: DateText | null;
  source: string;
  revision: string;
};

// linked は「同じ群の自動の不足候補と同じ不足」と利用者が対応付けたもの。群に一件まで（NEED-03b）。
export type Declaration = { id: string; project: Project; item: string; unit: string; value: number | null; reason: string; linked: boolean };

export type Reply = { kind: 'none' } | { kind: 'estimated' | 'answered'; date: DateText };

export type Arrival = { id: string; receiptLotId: string; arrived: number; good: number };

export type Request = {
  id: string;
  project: Project;
  item: string;
  unit: string;
  quantity: number;
  vendor: string;
  requestedOn: DateText;
  orderConfirmedBy: string | null;
  reply: Reply;
  cancelled: { eventId: string; reason: string } | null;
  arrivals: Arrival[];
};

export function requestProgressOf(masters: Masters, request: Request): { arrived: number; good: number; outstanding: number | null } {
  const step = quantityStepOf(masters, request.item, request.unit);
  const arrived = sumScalars(request.arrivals.map((a) => a.arrived), step);
  const good = sumScalars(request.arrivals.map((a) => a.good), step);
  return { arrived, good, outstanding: request.cancelled === null ? Math.max(0, subtractScalar(request.quantity, arrived, step)) : null };
}

// TBD-05は未確定。区分は仮の四つで、本数へ換算しない（SUP-03）。
export const remainderLevels = ['plenty', 'half', 'few', 'nearEmpty'] as const;
export type RemainderLevel = (typeof remainderLevels)[number];

export type SupplyDetail =
  | { kind: 'receiptTemplateSave'; before: ReceiptTemplate | null; after: ReceiptTemplate }
  | { kind: 'receiptTemplateDelete'; before: ReceiptTemplate }
  | ({ kind: 'templateReceipt' } & TemplateReceipt)
  | ({ kind: 'usageEstimate' } & UsageEstimate)
  | NeedImportDetail
  | { kind: 'needRegister'; need: Need }
  | { kind: 'needRevise'; before: Need; after: Need }
  | { kind: 'shortageDeclare'; declaration: Declaration }
  | { kind: 'declarationLink'; declarationId: string; linked: boolean }
  | { kind: 'requestRecord'; request: Request }
  | { kind: 'orderConfirm'; requestId: string }
  | { kind: 'replyRecord'; requestId: string; before: Reply; after: Reply }
  | { kind: 'requestCancel'; requestId: string; reason: string }
  | { kind: 'receiptRecord'; lotId: string; received: number | null; provisional: boolean; label: string | null }
  | { kind: 'receiptRevise'; lotId: string; before: number | null; after: number; provisional: boolean; reason: string }
  | { kind: 'arrival'; requestId: string; arrival: Arrival }
  | { kind: 'arrivalRevise'; requestId: string; before: Arrival; after: Arrival }
  | { kind: 'remainder'; lotId: string; level: RemainderLevel }
  | { kind: 'returnAck'; handoverEventId: string };

export type SupplyEvent = Meta & SupplyDetail & { itemLabels: EventItemLabels };

// 台帳と同じく、現在値と履歴を一組で持つ。台帳の現在値・履歴・確認事項・中断には触れない（要件3の4、7の2、12の3）。
export type Supply = {
  receiptTemplates: Readonly<Record<string, ReceiptTemplate>>;
  needs: Readonly<Record<string, Need>>;
  declarations: Readonly<Record<string, Declaration>>;
  requests: Readonly<Record<string, Request>>;
  // 開封済みで数が不明のまとまりの残量区分。数えた・だいたいの数量があれば、そちらを使う。
  // quantityKey は、区分を記録した時点のまとまりの数量の記録。数量が変わったら古い区分を使わない（quantityKeyOf）。
  levels: Readonly<Record<string, { level: RemainderLevel; eventId: string; quantityKey: string }>>;
  // 実返却（台帳の handover の操作ID）→ 受領確認の操作ID。受領確認は手元を減らさない（RET-04）。
  acks: Readonly<Record<string, string>>;
  // 受け取りの現物ごとの実際に受け取った数（届いた数）。台帳の数え直しや使用から推定せず、利用者が明示して記録する。割り当ての上限になる。
  // provisional は仮の実際に受け取った数（表示の数（ラベル・パッケージ）・だいたいの受け取り、残りからの逆算）。仮の数を上限に割り当てでき、使い切るか数えて確定する（receiptStatusOf）。
  // 数が不明で受け入れた現物は received が null（未確認）。受け取りであることは残し、残りを数えて逆算するか、数えて確定してから割り当てする。
  receipts: Readonly<Record<string, { received: number | null; provisional: boolean; eventId: string; label: string | null }>>;
  log: readonly SupplyEvent[];
};

export const emptySupply: Supply = deepFreeze({ receiptTemplates: {}, needs: {}, declarations: {}, requests: {}, levels: {}, acks: {}, receipts: {}, log: [] });

export function recordReceiptTemplate(supply: Supply, masters: Masters, meta: Meta, after: ReceiptTemplate): Supply {
  const before = Object.hasOwn(supply.receiptTemplates, after.id) ? supply.receiptTemplates[after.id] ?? null : null;
  return commit(supply, masters, { kind: 'receiptTemplateSave', before, after }, meta, { receiptTemplates: { ...supply.receiptTemplates, [after.id]: after } });
}

export function removeReceiptTemplate(supply: Supply, masters: Masters, meta: Meta, before: ReceiptTemplate): Supply {
  const templates = Object.fromEntries(Object.entries(supply.receiptTemplates).filter(([id]) => id !== before.id));
  return commit(supply, masters, { kind: 'receiptTemplateDelete', before }, meta, { receiptTemplates: templates });
}

export function recordTemplateReceipt(ledger: Ledger, supply: Supply, meta: Meta, source: TemplateReceipt): Supply {
  return commit(supply, ledger.masters, { kind: 'templateReceipt', ...source }, meta, {}, ledger);
}

export function recordUsageEstimate(ledger: Ledger, supply: Supply, meta: Meta, estimate: UsageEstimate): Supply {
  return commit(supply, ledger.masters, { kind: 'usageEstimate', ...estimate }, meta, {}, ledger);
}

// 検査をすべて済ませてから新しい状態を作るので、失敗時は元の状態が無傷のまま残る。
function commit(supply: Supply, masters: Masters, detail: SupplyDetail, meta: Meta, next: Partial<Omit<Supply, 'log'>>, ledger: Ledger | null = null): Supply {
  if (supply.log.some((e) => e.eventId === meta.eventId)) throw new Error(`操作ID ${meta.eventId} は使用済み`);
  checkTime(meta.occurredAt, '発生');
  checkTime(meta.recordedAt, '記録');
  const state = { ...supply, ...next }, event = { ...meta, ...detail };
  const itemLabels = captureItemLabels(masters, supplyEventItemIds(event, { ledger, supply: state }));
  return deepFreeze({ ...state, log: [...supply.log, { ...event, itemLabels }] });
}

function required(text: string, label: string): void {
  if (text.trim() === '') throw new Error(`${label}を入力する`);
}

// 暦の正しさまで確かめる。Date.parseは2月30日を3月2日へ読み替えるので使わない。
export function checkDate(value: string, label: string): void {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const ok = m !== null && new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toISOString().slice(0, 10) === value;
  if (!ok) throw new Error(`${label}の日付「${value}」は実在する YYYY-MM-DD で入力する`);
}

export function sameProject(a: Project, b: Project): boolean {
  return a.kind === b.kind && (a.kind !== 'case' || (b.kind === 'case' && a.id === b.id));
}

// 数量の根拠と値の組が正しいかは、台帳と同じ規則（observe）で確かめる。
function checkNeedQuantity(masters: Masters, n: Pick<Need, 'item' | 'unit'>, q: NeedQuantity): NeedQuantity {
  observe('need', q.basis, q.value, inputStepOf(masters, n.item, n.unit, q.value));
  return { basis: q.basis, value: q.value };
}

function checkNeedFields(n: Pick<Need, 'item' | 'unit' | 'dueDate' | 'source' | 'revision'>): void {
  required(n.item, '品目');
  required(n.unit, '単位');
  required(n.source, '元の資料');
  required(n.revision, '改訂');
  if (n.dueDate !== null) checkDate(n.dueDate, '必要日');
}

export function registerNeed(supply: Supply, masters: Masters, meta: Meta, need: Omit<Need, 'id'>): Supply {
  checkNeedFields(need);
  const duplicate = Object.values(supply.needs).find((n) => n.project.id === need.project.id && n.item === need.item && n.unit === need.unit);
  if (duplicate) throw new Error(`案件・用途${need.project.id}・品目${need.item}（${need.unit}）の必要明細は登録済み（${duplicate.id}）。必要な数の変更は改訂で記録する`);
  const created: Need = { ...need, id: meta.eventId, project: { ...need.project }, required: checkNeedQuantity(masters, need, need.required) };
  return commit(supply, masters, { kind: 'needRegister', need: created }, meta, { needs: { ...supply.needs, [created.id]: created } });
}

export function reviseNeed(supply: Supply, masters: Masters, meta: Meta, needId: string, change: Pick<Need, 'required' | 'dueDate' | 'source' | 'revision'>): Supply {
  const before = supply.needs[needId];
  if (!before) throw new Error(`必要明細 ${needId} がない`);
  checkNeedFields({ item: before.item, unit: before.unit, ...change });
  const after: Need = { ...before, required: checkNeedQuantity(masters, before, change.required), dueDate: change.dueDate, source: change.source, revision: change.revision };
  const same = after.required.basis === before.required.basis && after.required.value === before.required.value && after.dueDate === before.dueDate && after.source === before.source && after.revision === before.revision;
  if (same) throw new Error('必要明細の内容が変わっていない');
  return commit(supply, masters, { kind: 'needRevise', before, after }, meta, { needs: { ...supply.needs, [needId]: after } });
}

export function declareShortage(supply: Supply, masters: Masters, meta: Meta, d: Omit<Declaration, 'id' | 'linked'>): Supply {
  required(d.item, '品目');
  required(d.unit, '単位');
  required(d.reason, '不足の理由');
  if (d.value !== null) observe(meta.eventId, 'counted', d.value, inputStepOf(masters, d.item, d.unit, d.value));
  const created: Declaration = { ...d, id: meta.eventId, project: { ...d.project }, linked: false };
  return commit(supply, masters, { kind: 'shortageDeclare', declaration: created }, meta, { declarations: { ...supply.declarations, [created.id]: created } });
}

// 同じ群（案件・用途・品目・単位）の必要明細を探す。必要明細は案件・用途の組だけが持つので、案件・用途が案件・用途の申告だけが対象になる。
function needOfGroup(supply: Supply, project: Project, item: string, unit: string): Need | undefined {
  return project.kind === 'case' ? Object.values(supply.needs).find((n) => n.project.id === project.id && n.item === item && n.unit === unit) : undefined;
}

// 対応付けた申告は群に一件まで。同じ不足を二度数えないため（NEED-03b）。別の足りない分の記録は対応付けずに残す。
export function linkDeclaration(supply: Supply, masters: Masters, meta: Meta, declarationId: string, linked: boolean): Supply {
  const declaration = supply.declarations[declarationId];
  if (!declaration) throw new Error(`申告 ${declarationId} がない`);
  if (declaration.linked === linked) throw new Error('対応付けの状態が変わっていない');
  if (linked) {
    if (!needOfGroup(supply, declaration.project, declaration.item, declaration.unit)) {
      throw new Error('対応付ける相手の必要明細がない（同じ案件・用途・品目・単位の必要明細を先に登録する）');
    }
    const other = Object.values(supply.declarations).find(
      (d) => d.linked && d.id !== declarationId && sameProject(d.project, declaration.project) && d.item === declaration.item && d.unit === declaration.unit,
    );
    if (other) throw new Error(`この群には対応付けた申告 ${other.id} がすでにある（群に一件まで。先に解除する）`);
  }
  return commit(supply, masters, { kind: 'declarationLink', declarationId, linked }, meta, {
    declarations: { ...supply.declarations, [declarationId]: { ...declaration, linked } },
  });
}

function checkReply(reply: Reply): Reply {
  if (reply.kind === 'none') return { kind: 'none' };
  checkDate(reply.date, '予定日');
  return { kind: reply.kind, date: reply.date };
}

function requestOf(supply: Supply, requestId: string): Request {
  const request = supply.requests[requestId];
  if (!request) throw new Error(`依頼 ${requestId} がない`);
  return request;
}

function openRequest(supply: Supply, requestId: string): Request {
  const request = requestOf(supply, requestId);
  if (request.cancelled !== null) throw new Error(`依頼 ${requestId} は取消済み`);
  return request;
}

// 依頼に続く記録（注文の確定・回答・取消・割り当て）は、依頼を記録した操作より前と言える日時では記録しない。
// どちらかの日時が分からないときは比べない（NFR-08b）。
export function notBeforeRequest(supply: Supply, requestId: string, occurredAt: string | null): void {
  const created = supply.log.find((e) => e.eventId === requestId)?.occurredAt ?? null;
  if (created !== null && occurredAt !== null && Date.parse(created) > Date.parse(occurredAt)) {
    throw new Error(`依頼 ${requestId} を記録した日時より前の日時の記録はできない`);
  }
}

// 依頼しただけでは、手元の数量・受け取り・注文の確定を作らない（NEED-04b）。
export function recordRequest(supply: Supply, masters: Masters, meta: Meta, r: Pick<Request, 'project' | 'item' | 'unit' | 'quantity' | 'vendor' | 'requestedOn' | 'reply'>): Supply {
  required(r.item, '品目');
  required(r.unit, '単位');
  required(r.vendor, '依頼先');
  const step = inputStepOf(masters, r.item, r.unit, r.quantity);
  checkCount(r.quantity, step, true, `依頼の数量は${countRange(step, true)}で入力する`);
  checkDate(r.requestedOn, '依頼日');
  const created: Request = {
    id: meta.eventId,
    project: { ...r.project },
    item: r.item,
    unit: r.unit,
    quantity: r.quantity,
    vendor: r.vendor,
    requestedOn: r.requestedOn,
    orderConfirmedBy: null,
    reply: checkReply(r.reply),
    cancelled: null,
    arrivals: [],
  };
  return commit(supply, masters, { kind: 'requestRecord', request: created }, meta, { requests: { ...supply.requests, [created.id]: created } });
}

// 依頼した事実と、発注を確認した事実は別の記録（NEED-04b）。
export function confirmOrder(supply: Supply, masters: Masters, meta: Meta, requestId: string): Supply {
  const request = openRequest(supply, requestId);
  if (request.orderConfirmedBy !== null) throw new Error(`依頼 ${requestId} は注文の確定済み（${request.orderConfirmedBy}）`);
  notBeforeRequest(supply, requestId, meta.occurredAt);
  return commit(supply, masters, { kind: 'orderConfirm', requestId }, meta, { requests: { ...supply.requests, [requestId]: { ...request, orderConfirmedBy: meta.eventId } } });
}

export function recordReply(supply: Supply, masters: Masters, meta: Meta, requestId: string, reply: Reply): Supply {
  const request = openRequest(supply, requestId);
  const after = checkReply(reply);
  if (after.kind === request.reply.kind && (after.kind === 'none' || (request.reply.kind !== 'none' && after.date === request.reply.date))) {
    throw new Error('回答の内容が変わっていない');
  }
  notBeforeRequest(supply, requestId, meta.occurredAt);
  return commit(supply, masters, { kind: 'replyRecord', requestId, before: request.reply, after }, meta, { requests: { ...supply.requests, [requestId]: { ...request, reply: after } } });
}

// 元の依頼は残し、取消済みとして未着から外す。届いた現物は台帳に残り、作業の再開も作らない（NEED-07b・MFG-08c）。
export function cancelRequest(supply: Supply, masters: Masters, meta: Meta, requestId: string, reason: string): Supply {
  const request = openRequest(supply, requestId);
  required(reason, '取り消す理由');
  notBeforeRequest(supply, requestId, meta.occurredAt);
  return commit(supply, masters, { kind: 'requestCancel', requestId, reason }, meta, {
    requests: { ...supply.requests, [requestId]: { ...request, cancelled: { eventId: meta.eventId, reason } } },
  });
}

// 受け取りの入口。受け取りの現物の登録（ledger.register）と実際に受け取った数の記録を一組で行う。
// 実際に受け取った数の記録を作るのはこの関数だけで、初期登録や既存の手元の現物は、依頼に届いた物としては扱わない。
// 台帳のregisterは受け取りと初期登録を同じ形で作るので、区別を台帳の記録に頼らない。
// 実際に受け取った数として確定するのは数えた数だけ。表示の数（ラベル・パッケージ）・だいたいの受け取りは、その数を仮の実際に受け取った数にする（仮のまま割り当てでき、確定した数と
// 区別して示す）。数が不明の受け取りは、仮の数もないので未確認（null）にする。
export function receiveLot(
  ledger: Ledger,
  supply: Supply,
  meta: Meta,
  lot: Pick<Lot, 'id' | 'item' | 'unit' | 'project' | 'location'>,
  basis: Basis,
  value: number | null,
  label: string | null = null,
): { ledger: Ledger; supply: Supply } {
  const masters = ledger.masters;
  if (meta.scan !== undefined && label !== null && label !== meta.scan.raw) throw new Error('読取原文と手入力ラベルが異なる。手入力ラベルを空にするか、原文と同じ値にしてから記録する');
  const registered = register(ledger, meta, lot, basis, value);
  label = meta.scan?.raw ?? label;
  const recorded: Meta = { ...meta, eventId: `${meta.eventId}-c` };
  const provisional = basis !== 'counted' && value !== null;
  const next = commit(supply, masters, { kind: 'receiptRecord', lotId: lot.id, received: value, provisional, label }, recorded, {
    receipts: { ...supply.receipts, [lot.id]: { received: value, provisional, eventId: recorded.eventId, label } },
  }, registered);
  return { ledger: registered, supply: next };
}

export function validateReceipts(supply: Supply): void {
  const expected = new Map<string, Supply['receipts'][string]>();
  for (const event of supply.log) {
    if (event.kind === 'receiptRecord') {
      if (expected.has(event.lotId)) throw new Error('現在の受け取り記録が履歴と一致しない（同じ保管単位の受け取りが重複）');
      expected.set(event.lotId, { received: event.received, provisional: event.provisional, eventId: event.eventId, label: event.label });
    } else if (event.kind === 'receiptRevise') {
      const before = expected.get(event.lotId);
      if (!before || before.received !== event.before) throw new Error('現在の受け取り記録が履歴と一致しない（実際に受け取った数の訂正前の値）');
      expected.set(event.lotId, { ...before, received: event.after, provisional: event.provisional, eventId: event.eventId });
    }
  }
  if (expected.size !== Object.keys(supply.receipts).length) throw new Error('現在の受け取り記録が履歴と一致しない（現在値の欠落または余分な受け取り）');
  for (const [lotId, receipt] of expected) {
    const current = own(supply.receipts, lotId);
    if (!current || current.received !== receipt.received || current.provisional !== receipt.provisional
      || current.eventId !== receipt.eventId || current.label !== receipt.label) throw new Error(`保管単位 ${lotId} の現在の受け取り記録が履歴と一致しない`);
  }
}

// いま有効な実際に受け取った数の訂正が、受け取りの日時の訂正で受け取りより前になっているか。そのときは、同じ値でも受け取りのあとの確認として記録し直せる。
export function isStaleRevision(ledger: Ledger, supply: Supply, lotId: string): boolean {
  const effective = supply.log.find((e) => e.eventId === supply.receipts[lotId]?.eventId);
  const receivedAt = createdAtOf(ledger, lotId);
  return effective?.kind === 'receiptRevise' && effective.occurredAt !== null && receivedAt !== null && Date.parse(effective.occurredAt) < Date.parse(receivedAt);
}

export type ReceiptStatus = 'confirmed' | 'provisional' | 'unconfirmed';

// 実際に受け取った数の確かさ。仮の数は、受け入れた物を使い切り（分割でできた分も含めて台帳が0で、まとめ直していない）、それらに未解決の
// 確認事項がなければ確定として扱う。表示の数（ラベル・パッケージ）より少なければ、使い切る前に使用が負になって確認事項が開くので、確定しない。
// 記録せず導出するので、使用を取り消せば仮に戻る。
export function receiptStatusOf(ledger: Ledger, supply: Supply, lotId: string): ReceiptStatus {
  const receipt = supply.receipts[lotId];
  if (!receipt || receipt.received === null) return 'unconfirmed';
  if (!receipt.provisional) return 'confirmed';
  const family = new Set([lotId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const l of Object.values(ledger.lots)) if (l.splitFrom !== null && family.has(l.splitFrom) && !family.has(l.id)) (family.add(l.id), (grew = true));
  }
  // 使わずに残りを0と数え直しただけでは、仮の数の物があった証拠にならない。数え直しのない、減らした記録だけで0になったときに限る。
  if (ledger.history.some((e) => e.kind === 'recount' && family.has(e.lotId) && !voidOf(ledger, e.eventId))) return 'provisional';
  const usedUp = [...family].every((id) => {
    const l = ledger.lots[id];
    return l !== undefined && l.mergedInto === null && l.quantity.kind === 'known' && l.quantity.numeric.value === 0;
  });
  const clean = !Object.values(ledger.issues).some((i) => i.resolution === null && i.lotId !== null && family.has(i.lotId));
  return usedUp && clean ? 'confirmed' : 'provisional';
}

// 数えずに受け入れた現物（数が不明・表示の数（ラベル・パッケージ）・だいたい）の残りを数えたとき、それまでに減らした数（使用・引渡し・分割）を足して、
// 届いた数を逆算する。表示の数（ラベル・パッケージ）の受け取りを使い切ったあとに残りが見つかった（ラベルより多く入っていた）ときも、これで余りを記録できる。
// 受け取りの記録から、減らした記録だけが続いているときに限る（減らした数に不明がある、受け取りのあとに数え直したなら null）。
// 数えた受け取りは届いた数を数えてあるので逆算しない。直すなら数えて訂正する。
// 後入力で減らした記録が増えうるので、逆算した数は仮の数として記録する。
export function receivedFromRemaining(ledger: Ledger, lotId: string, remaining: number): number | null {
  const lot = ledger.lots[lotId];
  const creation = ledger.history.find((e) => e.changes.some((c) => c.after.id === lotId && c.before === null));
  if (!lot || !creation) return null;
  const [first, ...rest] = lot.quantity.terms;
  if (first?.sign !== 1 || first.observation.id !== creation.eventId || first.observation.basis === 'counted') return null;
  const step = inputStepOf(ledger.masters, lot.item, lot.unit, remaining);
  const taken: number[] = [];
  for (const t of rest) {
    if (t.sign !== -1 || t.observation.value === null) return null;
    taken.push(t.observation.value);
  }
  return addScalar(validateScalar(remaining, step), sumScalars(taken, step), step);
}

export function receivedOf(supply: Supply, lotId: string): number | null {
  return supply.receipts[lotId]?.received ?? null;
}

// 受け取りの現物に割り当てした届いた数の合計。取消済みの依頼のものも含む（現物は一度しか届かない）。
// 割り当ては依頼と現物の品目・単位の一致を検査済みなので、依頼の精度で足せる。
export function allocatedToReceipt(supply: Supply, masters: Masters, lotId: string): number {
  let total = 0;
  for (const request of Object.values(supply.requests)) {
    const step = quantityStepOf(masters, request.item, request.unit);
    for (const a of request.arrivals) if (a.receiptLotId === lotId) total = addScalar(total, a.arrived, step);
  }
  return total;
}

// 届いた数の訂正（未確認からの確定も同じ操作）。台帳の数え直しは現在の残数の確認で、受け取りの訂正と区別できないので、明示の操作にする。
// 割り当て済みの届いた数の合計を下回る値も受け付ける（その状態は過剰割り当てとして示し、割り当ての訂正で直す）。
export function reviseReceipt(ledger: Ledger, supply: Supply, meta: Meta, lotId: string, received: number, reason: string, provisional = false): Supply {
  const masters = ledger.masters;
  const current = supply.receipts[lotId];
  if (!current) throw new Error(`保管単位 ${lotId} の実際に受け取った数の記録がない（受け取りとして登録した現物だけ）`);
  required(reason, '実際に受け取った数を訂正する理由');
  // 受け取りの日時は、台帳の登録の実際の日時（訂正後）。実際に受け取った数の記録に写した元の日時は、台帳の日時訂正で古くなる。
  const receivedAt = createdAtOf(ledger, lotId);
  if (receivedAt !== null && meta.occurredAt !== null && Date.parse(meta.occurredAt) < Date.parse(receivedAt)) {
    throw new Error(`保管単位 ${lotId} の受け取りより前の日時の実際に受け取った数の訂正は記録できない`);
  }
  const lot = ledger.lots[lotId];
  if (!lot) throw new Error(`保管単位 ${lotId} がない`);
  observe(meta.eventId, 'counted', received, inputStepOf(ledger.masters, lot.item, lot.unit, received));
  // 同じ数でも、仮から確定へ変わる（数えて確かめた）ときは記録する。
  if (current.received === received && current.provisional === provisional && !isStaleRevision(ledger, supply, lotId)) throw new Error('実際に受け取った数が変わっていない');
  return commit(supply, masters, { kind: 'receiptRevise', lotId, before: current.received, after: received, provisional, reason }, meta, {
    receipts: { ...supply.receipts, [lotId]: { ...current, received, provisional, eventId: meta.eventId } },
  }, ledger);
}

// 整数単位は既存の文言を保つ。小数単位の桁・上限の違反はscalarの文言で示す。
function checkCount(value: number, step: Step, positive: boolean, message: string): void {
  if (step === 1 ? !Number.isSafeInteger(value) : validateScalar(value, step) !== value) throw new Error(message);
  if (value < 0 || (positive && value === 0)) throw new Error(message);
}

const countRange = (step: Step, positive: boolean): string => (positive ? (step === 1 ? '1以上の整数' : '0より大きい値') : `0以上の${step === 1 ? '整数' : '値'}`);

function arrivalStepOf(masters: Masters, item: string, unit: string, a: Pick<Arrival, 'arrived' | 'good'>): Step {
  inputStepOf(masters, item, unit, a.good);
  return inputStepOf(masters, item, unit, a.arrived);
}

function checkArrivalCounts(arrived: number, good: number, positive: boolean, step: Step): void {
  checkCount(arrived, step, positive, `届いた数は${countRange(step, positive)}で入力する`);
  const goodMessage = `使える数は0以上で、届いた数以下の${step === 1 ? '整数' : '値'}で入力する`;
  checkCount(good, step, false, goodMessage);
  if (good > arrived) throw new Error(goodMessage);
}

// 届いた数の合計が実際に受け取った数を超える割り当ては拒否する。受け取りの現物（台帳）は、この関数が拒否しても残る（NEED-05b）。
export function allocateArrival(ledger: Ledger, supply: Supply, meta: Meta, requestId: string, a: Omit<Arrival, 'id'>): Supply {
  const masters = ledger.masters;
  const request = openRequest(supply, requestId);
  notBeforeRequest(supply, requestId, meta.occurredAt);
  // 閉じた（まとめ直し済みの）元のまとまりでも、品目・単位・案件・用途を検査できるようopen()は使わずに引く。
  const lot = ledger.lots[a.receiptLotId];
  if (!lot) throw new Error(`保管単位 ${a.receiptLotId} がない`);
  const receipt = supply.receipts[a.receiptLotId];
  if (!receipt) {
    throw new Error(`保管単位 ${a.receiptLotId} は実際に受け取った数の記録がなく、依頼に届いた物としては扱えない（受け取りとして登録した現物だけを割り当てする）`);
  }
  const received = receipt.received;
  if (received === null) throw new Error(`保管単位 ${a.receiptLotId} の実際に受け取った数は未確認（数が不明で受け取り）。残りを数えて逆算するか、数えて実際に受け取った数を確定してから割り当てする`);
  if (!sameProject(lot.project, request.project)) throw new Error('別の案件・用途の現物は割り当てしない（案件・用途の付け替えは別の操作）');
  if (lot.item !== request.item) throw new Error(`依頼の品目${request.item}と、現物の品目${lot.item}が違う`);
  if (lot.unit !== request.unit) throw new Error(`依頼の単位${request.unit}と、現物の単位${lot.unit}が違う`);
  // 受け取りの現物ができた日時より前と言える日時の割り当ては、起きえない前後なので記録しない（どちらかの日時が不明なら比べない）。
  const createdAt = createdAtOf(ledger, a.receiptLotId);
  if (createdAt !== null && meta.occurredAt !== null && Date.parse(createdAt) > Date.parse(meta.occurredAt)) {
    throw new Error(`受け取りの現物 ${a.receiptLotId} ができた日時より前の日時の割り当ては記録できない`);
  }
  const step = arrivalStepOf(ledger.masters, lot.item, lot.unit, a);
  checkArrivalCounts(a.arrived, a.good, true, step);
  const total = addScalar(allocatedToReceipt(supply, ledger.masters, a.receiptLotId), a.arrived, step);
  if (total > received) throw new Error(`割り当てした届いた数の合計${total}が、実際に受け取った数${received}を超える`);
  const arrival: Arrival = { id: meta.eventId, receiptLotId: a.receiptLotId, arrived: a.arrived, good: a.good };
  return commit(supply, masters, { kind: 'arrival', requestId, arrival }, meta, {
    requests: { ...supply.requests, [requestId]: { ...request, arrivals: [...request.arrivals, arrival] } },
  }, ledger);
}

// 割り当ての届いた数・使える数を直す。取消済みの依頼でも直せる（取消のあとに実際に受け取った数を下げて過剰になった割り当てを直せるように）。
// 届いた数を増やす訂正だけ、合計が実際に受け取った数以下であることを求める。減らす訂正と使える数だけの訂正は、合計がまだ上限を超えていても受け付ける。
export function reviseArrival(ledger: Ledger, supply: Supply, meta: Meta, requestId: string, arrivalId: string, change: Pick<Arrival, 'arrived' | 'good'>): Supply {
  const masters = ledger.masters;
  const request = requestOf(supply, requestId);
  const before = request.arrivals.find((a) => a.id === arrivalId);
  if (!before) throw new Error(`割り当て ${arrivalId} がない`);
  notBeforeRequest(supply, requestId, meta.occurredAt);
  const step = arrivalStepOf(masters, request.item, request.unit, change);
  checkArrivalCounts(change.arrived, change.good, false, step);
  if (change.arrived === before.arrived && change.good === before.good) throw new Error('割り当ての内容が変わっていない');
  const received = receivedOf(supply, before.receiptLotId);
  const total = addScalar(subtractScalar(allocatedToReceipt(supply, masters, before.receiptLotId), before.arrived, step), change.arrived, step);
  if (change.arrived > before.arrived && (received === null || total > received)) {
    throw new Error(`届いた数を増やすと、割り当てした合計${total}が実際に受け取った数${received ?? '（記録なし）'}を超える`);
  }
  const after: Arrival = { ...before, arrived: change.arrived, good: change.good };
  return commit(supply, masters, { kind: 'arrivalRevise', requestId, before, after }, meta, {
    requests: { ...supply.requests, [requestId]: { ...request, arrivals: request.arrivals.map((a) => (a.id === arrivalId ? after : a)) } },
  }, ledger);
}

// 数量の元記録の並び。数量が変わると（数え直し・使用・まとめ直しなど）変わるので、残量区分がいまの数量に対するものかを確かめる。
export function quantityKeyOf(q: Quantity): string {
  return q.terms.map((t) => `${t.sign}${t.observation.id}`).join(',');
}

// いまの数量を作った操作（登録・数え直し・使用など）のうち、最も遅い実際の日時。日時不明の操作は比べない。
function quantityChangedAt(ledger: Ledger, q: Quantity): number | null {
  let latest: number | null = null;
  for (const t of q.terms) {
    if (!ledger.history.some((e) => e.eventId === t.observation.id)) continue;
    const at = occurredAtOf(ledger, t.observation.id);
    if (at !== null && (latest === null || Date.parse(at) > latest)) latest = Date.parse(at);
  }
  return latest;
}

// いまの区分として使える残量区分。区分を記録した時点の数量のままで、かつ、いまの数量になった操作より前の観察でないもの。
// 使用のあとで、それより前に観察した区分を後入力したとき、または使用の日時をあとで観察より後へ訂正したとき、使用前の残量を
// いまの残量として示さない。どちらかの日時が分からないときは比べない。
export function currentLevelOf(ledger: Ledger, supply: Supply, lot: Lot): RemainderLevel | undefined {
  const entry = lot.quantity.kind === 'unknown' ? supply.levels[lot.id] : undefined;
  if (!entry || entry.quantityKey !== quantityKeyOf(lot.quantity)) return undefined;
  const observed = supply.log.find((e) => e.eventId === entry.eventId)?.occurredAt ?? null;
  const changed = quantityChangedAt(ledger, lot.quantity);
  return observed !== null && changed !== null && Date.parse(observed) < changed ? undefined : entry.level;
}

// 開封済みで数量が不明なまとまりの残量区分。数えた・だいたいの数量があるまとまりは、その数量を使うので記録しない。
// 区分を本数へ換算しない（SUP-03）。どの単位のまとまりが開封済みかは、換算の固定データを持つ側（packaging・画面）が絞る。
export function recordRemainder(ledger: Ledger, supply: Supply, meta: Meta, lotId: string, level: RemainderLevel): Supply {
  const masters = ledger.masters;
  if (!remainderLevels.includes(level)) throw new Error(`残量区分「${String(level)}」は定義にない区分`);
  const lot = ledger.lots[lotId];
  if (!lot) throw new Error(`保管単位 ${lotId} がない`);
  if (lot.quantity.kind !== 'unknown') throw new Error(`保管単位 ${lotId} には数量があるので、残量区分は記録しない（数が不明の保管単位だけ）`);
  const changed = quantityChangedAt(ledger, lot.quantity);
  if (changed !== null && meta.occurredAt !== null && Date.parse(meta.occurredAt) < changed) {
    throw new Error(`保管単位 ${lotId} のいまの数量になった操作より前の観察は、いまの残量区分として記録できない`);
  }
  // 同じ区分でも、古くなっていれば（数量が変わった・観察が数量の変化より前になった）、新しい観察として記録し直せる。
  if (currentLevelOf(ledger, supply, lot) === level) throw new Error('残量区分が変わっていない');
  return commit(supply, masters, { kind: 'remainder', lotId, level }, meta, { levels: { ...supply.levels, [lotId]: { level, eventId: meta.eventId, quantityKey: quantityKeyOf(lot.quantity) } } }, ledger);
}

// 返却は、返却待ちまたは不良の取り分けた理由が付いた物の引渡し。F0では引渡しに種別（返却・廃棄・他部署）を持たせないので、
// 引渡しの時点の取り分けた理由で見分ける。通常の引渡しに、返品の受付確認は付けない。
// 引渡しの時点の取り分けた理由は、記録した順ではなく実際の日時で決める。後の時刻の返却待ちを先に入力したあとで前の時刻の引渡しを
// 入力しても、その引渡しは返却ではなく、前の時刻の返却待ちを後から入力したときは返却になる。
// まとまりができた時点の取り分けた理由から始める。分割・位置の変更でできた子は、親の取り分けた理由を引き継ぐが、台帳が持つ引き継ぎは
// 記録した時点の親の状態なので、子ができた実際の日時の時点の親の状態を、同じ方法で（再帰的に）求め直す。そのあと、このまとまりへの
// 取り分けた理由の付与・解除を、基準の時刻より前（または同時刻）と言えるものだけ、実際の日時の順（同時刻・日時不明は記録した順）に適用する。
// どちらかの日時が分からないときは、記録した順で前のものを適用する。
// 数え直しに含まれていた引渡し・保留のままの引渡しは親の変更を持たないので、引渡しの記録そのものからは引けない。
// 記録の並べ方。日時の分かる記録どうしは実際の日時の順（同時刻は記録した順）に並べ替え、日時不明の記録は記録した順の位置に残す。
// 日時不明の記録を先頭へ寄せると、あとに記録した日時不明の記録が、前に記録した日時の分かる記録より前になる。
// 記録した順と日時の順が両立しないか。日時不明の記録より前に記録したものが、あとに記録したものより遅い日時なら、日時不明の記録を
// どこに置いても、どちらかの前後に反する。そのときは一つの並べ方を選ばず、決められないとして扱う。
export function orderContradicts(items: readonly { index: number; at: number | null }[]): boolean {
  const byRecord = [...items].sort((x, y) => x.index - y.index);
  return byRecord.some(
    (u, i) => u.at === null && byRecord.slice(0, i).some((a) => a.at !== null && byRecord.slice(i + 1).some((b) => b.at !== null && b.at < (a.at as number))),
  );
}

export function chronological<T extends { index: number; at: number | null }>(items: readonly T[]): T[] {
  const byRecord = [...items].sort((x, y) => x.index - y.index);
  const known = byRecord.filter((e) => e.at !== null).sort((x, y) => (x.at as number) - (y.at as number) || x.index - y.index);
  let k = 0;
  return byRecord.map((e) => (e.at === null ? e : (known[k++] as T)));
}

// 前後を決められないときは null（日時不明の記録をはさんで、日時の分かる記録の前後が記録した順と食い違う）。
function holdsAt(ledger: Ledger, lotId: string, when: string | null, atIndex: number): readonly HoldReason[] | null {
  const creationIndex = ledger.history.findIndex((e) => e.changes.some((c) => c.after.id === lotId && c.before === null));
  const parentId = ledger.lots[lotId]?.splitFrom ?? null;
  const creation = creationIndex < 0 ? undefined : ledger.history[creationIndex];
  const inherited = parentId !== null && creation ? holdsAt(ledger, parentId, occurredAtOf(ledger, creation.eventId), creationIndex) : (creation?.changes.find((c) => c.after.id === lotId)?.after.holds ?? []);
  if (inherited === null) return null;
  let holds: HoldReason[] = [...inherited];
  const eligible: { index: number; at: number | null; kind: 'hold' | 'release'; reason: HoldReason }[] = [];
  ledger.history.forEach((e, index) => {
    if (index === atIndex || (e.kind !== 'hold' && e.kind !== 'release') || !e.changes.some((c) => c.after.id === lotId)) return;
    const happened = occurredAtOf(ledger, e.eventId);
    // 実際の日時が引渡しより前なら前。同時刻なら記録した順（先に記録したものが前）。どちらかが不明なら記録した順。
    const before =
      happened !== null && when !== null
        ? Date.parse(happened) < Date.parse(when) || (Date.parse(happened) === Date.parse(when) && index < atIndex)
        : index < atIndex;
    if (before) eligible.push({ index, at: happened === null ? null : Date.parse(happened), kind: e.kind, reason: e.reason });
  });
  // 取り分けた理由ごとに、その理由の付与・解除だけを並べて、最後の記録で有無を決める。理由が違う記録は互いに影響しないので、
  // まとめて並べると、別の理由の記録の日時に引きずられて、付与のあとに記録した日時不明の解除が付与より前に動く。
  for (const reason of new Set(eligible.map((e) => e.reason))) {
    const events = eligible.filter((e) => e.reason === reason);
    if (orderContradicts(events)) return null;
    const last = chronological(events).at(-1);
    holds = last?.kind === 'hold' ? (holds.includes(reason) ? holds : [...holds, reason]) : holds.filter((h) => h !== reason);
  }
  return holds;
}

export type ReturnStatus = { ok: true } | { ok: false; reason: string };

// 受領確認を記録できる実返却か。実際に引き渡した物（親の数量に反映した、数え直しに含まれていた、保留を適用・閉じて解消した）で、
// 返却待ちまたは不良の物だけ。保留のまま未解決の引渡しは、実返却かどうか確かめられないので対象にしない。
export function returnStatusOf(ledger: Ledger, handoverEventId: string): ReturnStatus {
  const target = ledger.history.find((e) => e.eventId === handoverEventId);
  if (!target) return { ok: false, reason: `操作 ${handoverEventId} がない` };
  if (target.kind !== 'handover') return { ok: false, reason: `操作 ${handoverEventId} は実返却（引渡し）ではない` };
  if (voidOf(ledger, handoverEventId)) return { ok: false, reason: `引渡し ${handoverEventId} は記録誤りとして取消済み` };
  const resolution = ledger.issues[handoverEventId]?.resolution ?? null;
  // 「適用」で解消した引渡しは実際にあった。「閉じる」は適用せずに閉じる解消で、引渡しが実際にあったとは確かめていない
  // （製造の引渡済み累計も、適用で解消したものだけを数える。ADR-010）。
  const physical = target.applied || target.inclusion === 'included' || resolution?.outcome === 'apply';
  if (!physical) {
    return {
      ok: false,
      reason: resolution?.outcome === 'close' ? `引渡し ${handoverEventId} は、適用せずに閉じたので、実返却として確認できない` : `引渡し ${handoverEventId} は未反映（確認が必要）で、実返却として確認できない。先に解消する`,
    };
  }
  const holds = holdsAt(ledger, target.lotId, occurredAtOf(ledger, handoverEventId), ledger.history.findIndex((e) => e.eventId === handoverEventId));
  if (holds === null) {
    return { ok: false, reason: `引渡し ${handoverEventId} の時点の取り分けた理由は、日時不明の記録をはさんで日時の前後が食い違うので、返却か確かめられない。日時を訂正してから記録する` };
  }
  if (!holds.includes('returnPending') && !holds.includes('defective')) {
    return { ok: false, reason: `引渡し ${handoverEventId} は、返却待ちまたは不良の物の返却ではないので、受領確認は記録しない` };
  }
  return { ok: true };
}

export type StaleAck = { handoverEventId: string; ackEventId: string; reason: string };

// 日時訂正のあとで食い違った受領確認。台帳の日時訂正は供給を知らず、止められないので、受領確認を記録したあとで、
// 引渡しが受領確認より後になった、または返却と確認できなくなった（返却待ちの付与より前になった等）受領確認を導出して示す。
export function staleAcksOf(ledger: Ledger, supply: Supply): StaleAck[] {
  const stale: StaleAck[] = [];
  for (const [handoverEventId, ackEventId] of Object.entries(supply.acks)) {
    const status = returnStatusOf(ledger, handoverEventId);
    if (!status.ok) {
      stale.push({ handoverEventId, ackEventId, reason: `返却と確認できなくなった（${status.reason}）` });
      continue;
    }
    const handoverAt = occurredAtOf(ledger, handoverEventId);
    const ackAt = supply.log.find((e) => e.eventId === ackEventId)?.occurredAt ?? null;
    if (handoverAt !== null && ackAt !== null && Date.parse(ackAt) < Date.parse(handoverAt)) {
      stale.push({ handoverEventId, ackEventId, reason: '受領確認の日時が、引渡しより前になっている' });
    }
  }
  return stale;
}

// 実引渡しによる手元の減少と、相手の受領確認は別の記録。受領確認では手元を再び減らさない（RET-04）。
export function acknowledgeReturn(ledger: Ledger, supply: Supply, meta: Meta, handoverEventId: string): Supply {
  const masters = ledger.masters;
  const status = returnStatusOf(ledger, handoverEventId);
  if (!status.ok) throw new Error(status.reason);
  if (supply.acks[handoverEventId] !== undefined) throw new Error(`引渡し ${handoverEventId} は受領確認済み（${supply.acks[handoverEventId]}）`);
  const at = occurredAtOf(ledger, handoverEventId);
  if (at !== null && meta.occurredAt !== null && Date.parse(at) > Date.parse(meta.occurredAt)) {
    throw new Error(`引渡し ${handoverEventId} より前の日時の受領確認は記録できない`);
  }
  return commit(supply, masters, { kind: 'returnAck', handoverEventId }, meta, { acks: { ...supply.acks, [handoverEventId]: meta.eventId } }, ledger);
}
