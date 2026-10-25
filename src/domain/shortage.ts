import { createdAtOf, isUsable, openIssues, productionTallyOf, voidOf, type ProductionTally, type HoldReason, type Ledger, type Lot, type Project, type Stop } from './ledger.ts';
import { add, observe, quantityOf, subtract, type Quantity } from './quantity.ts';
import { quantityStepOf, type Masters } from './masters.ts';
import { addScalar, positivePartMinus, subtractScalar, sumScalars, sumScalarsFinal, type Step } from './scalar.ts';
import { allocatedToReceipt, checkDate, chronological, orderContradicts, isStaleRevision, receiptStatusOf, receivedOf, requestProgressOf, sameProject, type DateText, type Supply } from './supply.ts';

// 不足を求める単位。案件・用途・品目・単位ごとに独立に求める（別の案件・用途・共通・所属不明の現物や、違う単位を混ぜない）。
export type GroupKey = { project: Project; item: string; unit: string };

export type UndecidableReason =
  | 'noNeed' // 必要な数が未登録
  | 'needUnknown' // 必要な数が不明
  | 'usedUnknown' // 使用実績の数量が不明
  | 'onHandUnknown' // 在庫の数量が不明
  | 'openIssue'; // 数量に影響する未解決の確認事項

export type Judgement =
  | { kind: 'ledger' } // 帳簿上の不足。確かさの注記なし
  | { kind: 'confirm'; approximate: boolean; unconfirmed: boolean } // 数量確認が必要（だいたい）／中身未確認
  | { kind: 'undecidable'; reasons: UndecidableReason[] };

export type ExcludedPart = { reasons: HoldReason[]; quantity: Quantity };

export type ShortageView = {
  key: GroupKey;
  judgement: Judgement;
  // 判定不能のとき null。分かる部分は aux に残す（04章）。
  shortage: number | null;
  // 数量不足（残必要な数が手元の未使用総数に足りない分）。除外の分は excludedShortage（shortage − shortfall）で、excluded に内訳がある。
  shortfall: number | null;
  excludedShortage: number | null;
  excluded: ExcludedPart[];
  aux: { required: number | null; used: number | null; usable: number | null; onHand: number | null };
  // 予備（取り分けた理由が spare だけのまとまり）の合計。根拠（だいたい・中身未確認・不明）を持つので、確定した数として扱わない。
  spare: Quantity;
  // 予備で賄える数 ＝ min(不足, 予備の数値部分)。不足が null、または予備に数値部分がなければ null。
  spareCover: number | null;
};

function keyText(k: GroupKey): string {
  return `${k.project.kind === 'case' ? `case:${k.project.id}` : k.project.kind}\u0000${k.item}\u0000${k.unit}`;
}

const inGroup = (key: GroupKey) => (lot: Lot) => sameProject(lot.project, key.project) && lot.item === key.item && lot.unit === key.unit;

// 必要明細・申告・依頼のどれかがある群。受け取りのない必要品目も出す（NEED-01b）。
export function groupsOf(_ledger: Ledger, supply: Supply): GroupKey[] {
  const found = new Map<string, GroupKey>();
  const add1 = (project: Project, item: string, unit: string) => {
    const k: GroupKey = { project: { ...project }, item, unit };
    if (!found.has(keyText(k))) found.set(keyText(k), k);
  };
  for (const n of Object.values(supply.needs)) add1(n.project, n.item, n.unit);
  for (const d of Object.values(supply.declarations)) add1(d.project, d.item, d.unit);
  for (const r of Object.values(supply.requests)) add1(r.project, r.item, r.unit);
  return [...found.values()];
}

// 0を初期値にして足すと、ラベルだけの合計が「中身未確認」から「未確認部分あり」へ変わってしまうので、空のときだけ0にする。
function sum(quantities: Quantity[], step: Step): Quantity {
  if (quantities.length === 0) return { kind: 'known', numeric: { value: 0, approximate: false, unconfirmed: 'none' }, computed: true, terms: [] };
  return quantities.reduce((total, quantity) => add(total, quantity, step));
}

function numericValueOf(q: Quantity): number | null {
  return q.kind === 'known' ? q.numeric.value : q.kind === 'partlyUnknown' ? (q.numeric?.value ?? null) : null;
}

// 使用済みが必要な数を超えるなど、差が負になるときは不足なしとして0にする。根拠の印はそのまま残す。
function nonNegative(q: Quantity): Quantity {
  return q.kind === 'known' && q.numeric.value < 0 ? { ...q, numeric: { ...q.numeric, value: 0 } } : q;
}

// 使用実績は、未取消のすべての使用。applied は「その操作が親の数量を減らしたか」であって、使用が起きたかではない。
// 数えたに含まれていた後入力、保留後に適用・閉じた使用は applied が偽のままだが、実際には使用済みで、手元の数量は
// すでにその分が減っている。applied で絞ると、使用済みを再び要求して不足を過大にする（NEED-02b・AT-08）。
function usedQuantity(ledger: Ledger, key: GroupKey, step: Step): Quantity {
  const group = inGroup(key);
  const used: Quantity[] = [];
  for (const e of ledger.history) {
    if (e.kind !== 'use') continue;
    const lot = ledger.lots[e.lotId];
    if (!lot || !group(lot) || voidOf(ledger, e.eventId)) continue;
    used.push(quantityOf(observe(e.eventId, e.basis, e.value, step)));
  }
  return sum(used, step);
}

export function shortageOf(ledger: Ledger, supply: Supply, key: GroupKey): ShortageView {
  const lots = Object.values(ledger.lots).filter(inGroup(key));
  // まとめ直し済みの元は集計から外す（閉じたまとまりを重ねて数えない）。工程に載っている物は未使用の部品ではない。
  const unused = lots.filter((l) => l.mergedInto === null && l.stage.kind === 'none');
  const step = quantityStepOf(ledger.masters, key.item, key.unit);
  const onHand = sum(unused.map((l) => l.quantity), step);
  const usable = sum(unused.filter(isUsable).map((l) => l.quantity), step);
  const used = usedQuantity(ledger, key, step);
  const need = key.project.kind === 'case' ? Object.values(supply.needs).find((n) => n.project.id === (key.project as { id: string }).id && n.item === key.item && n.unit === key.unit) : undefined;
  const required = need ? quantityOf(observe(need.id, need.required.basis, need.required.value, step)) : null;

  const reasons: UndecidableReason[] = [];
  if (!need) reasons.push('noNeed');
  else if (required?.kind !== 'known') reasons.push('needUnknown');
  if (used.kind !== 'known') reasons.push('usedUnknown');
  if (onHand.kind !== 'known' || usable.kind !== 'known') reasons.push('onHandUnknown');
  const lotIds = new Set(lots.map((l) => l.id));
  if (openIssues(ledger).some((i) => i.lotId !== null && lotIds.has(i.lotId))) reasons.push('openIssue');

  // 除外の内訳。取り分けた理由の組ごとに、まとまりを一度だけ数える（OPS-06b）。
  const byReasons = new Map<string, { reasons: HoldReason[]; quantities: Quantity[] }>();
  for (const l of unused) {
    if (l.holds.length === 0) continue;
    const id = l.holds.join('|');
    const entry = byReasons.get(id) ?? { reasons: [...l.holds], quantities: [] };
    entry.quantities.push(l.quantity);
    byReasons.set(id, entry);
  }
  const excluded: ExcludedPart[] = [...byReasons.values()].map((e) => ({ reasons: e.reasons, quantity: sum(e.quantities, step) }));
  const spare = sum(unused.filter((l) => l.holds.length === 1 && l.holds[0] === 'spare').map((l) => l.quantity), step);

  const aux = {
    required: required ? numericValueOf(required) : null,
    used: numericValueOf(used),
    usable: numericValueOf(usable),
    onHand: numericValueOf(onHand),
  };

  if (reasons.length > 0 || required === null) {
    return { key, judgement: { kind: 'undecidable', reasons }, shortage: null, shortfall: null, excludedShortage: null, excluded, aux, spare, spareCover: null };
  }

  const remaining = nonNegative(subtract(required, used, step));
  const shortageQ = nonNegative(subtract(remaining, usable, step));
  const shortfallQ = nonNegative(subtract(remaining, onHand, step));
  const shortage = numericValueOf(shortageQ);
  const shortfall = numericValueOf(shortfallQ);
  const spareValue = numericValueOf(spare);
  const judgement: Judgement =
    shortageQ.kind === 'known' && (shortageQ.numeric.approximate || shortageQ.numeric.unconfirmed !== 'none')
      ? { kind: 'confirm', approximate: shortageQ.numeric.approximate, unconfirmed: shortageQ.numeric.unconfirmed !== 'none' }
      : { kind: 'ledger' };
  return {
    key,
    judgement,
    shortage,
    shortfall,
    excludedShortage: shortage === null || shortfall === null ? null : subtractScalar(shortage, shortfall, step),
    excluded,
    aux,
    spare,
    spareCover: shortage === null || spareValue === null ? null : Math.min(shortage, spareValue),
  };
}

export type RequestSummary = {
  // 手配対象数の元になる数。自動の不足（判定不能なら対応付けた申告の一件）＋対応付けていない申告。求められない項があれば null。
  effectiveShortage: number | null;
  ordered: number; // 取消でない依頼の数量の合計（依頼済み数）
  outstanding: number; // 取消でない依頼の未着の合計
  // 届いた届いた数と、不足の解消に充てた使える数の合計（取消済みの依頼のものも含む。現物は届いている）。
  arrived: number;
  goodApplied: number;
  // max(0, 実効の不足 − 未着)。実効の不足が不明、または過剰割り当てがあれば null（0にしない）。
  toOrder: number | null;
  // 群の未着の合計が実効の不足を超えるとき、未着が残っているすべての依頼のID。どの依頼が余分かは決められないので
  // 一つに絞らず、利用者が取消を判断する（自動で取り消さない）。保留（実効の不足が不明、または過剰割り当て）なら null。
  possiblyUnneeded: string[] | null;
  // 割り当ての日時が、受け取りの現物ができた日時より前になっているもの（受け取りの日時をあとで訂正したときに生じる。台帳の日時訂正は
  // 供給を知らず、止められない）。前後が逆の到着は、申告の解消や手配の判断に使えないので、手配対象数と不要の判定を保留する。
  predatedArrivals: { requestId: string; arrivalId: string; receiptLotId: string }[];
  // いま有効な実際に受け取った数の訂正の日時が、受け取りの現物ができた日時より前になっているもの（訂正のあとで受け取りの日時を訂正したときに生じる）。
  // 割り当ての上限が、受け取りより前の訂正に基づくので、手配対象数と不要の判定を保留する。受け取りのあとの日時で訂正し直すと消える。
  predatedRevisions: { receiptLotId: string; eventId: string }[];
  // 仮の実際に受け取った数（使い切る前・数える前）に割り当てしている受け取りの現物。数は出し、仮と添える（保留はしない）。
  provisionalReceipts: string[];
  // 不足が確定していない（だいたい・表示の数（ラベル・パッケージ）に基づく不足の判定）。不足0に見えても、手配対象数と不要の判定を保留する（AT-07）。
  tentative: boolean;
  // 割り当て済みの届いた数の合計が実際に受け取った数を超えている受け取りの現物。実際に受け取った数を下げる訂正で生じ、合計が実際に受け取った数以下になれば消える。
  overAllocated: { receiptLotId: string; received: number; allocated: number }[];
};

// 申告から求める不足は、申告より後に届いた良品で解消する。古い依頼で届いた良品が、あとから見つけた別の不足を減らさないよう、
// 良品を、その到着より前に申告された不足にだけ、古い申告から順に充てる。前後は記録した順ではなく実際の日時で決める
// （10時の申告を先に記録しても、あとから記録した9時の到着では解消しない）。どちらかの日時が分からないときは、記録した順で決める。
// 申告の値が不明（null）のものは、いくら届いても解消したと数えず、全体を不明にする。
// 到着の前後は、割り当ての操作ではなく受け取りの現物が届いた日時（台帳の登録の実際の日時。訂正後）で決め、同時刻・日時不明のときの
// 記録した順は、受け取りと一組で記録した実際に受け取った数の記録の位置で決める。古い受け取りをあとで割り当てしても、その間に申告した不足は解消しない。
// absorbed は、自動の不足を減らすのに使われた良品の数。同じ良品を申告の解消にも使わないよう、早く届いた良品から先に除く。
function settledDeclared(ledger: Ledger, supply: Supply, key: GroupKey, step: Step, declared: readonly { id: string; value: number | null }[], absorbed = 0): number | null {
  if (declared.some((d) => d.value === null)) return null;
  const when = (id: string) => {
    const index = supply.log.findIndex((e) => e.eventId === id);
    const at = supply.log[index]?.occurredAt ?? null;
    return { index, at: at === null ? null : Date.parse(at) };
  };
  const arrivedWhen = (x: { id: string; receiptLotId: string }) => {
    const index = supply.log.findIndex((e) => e.kind === 'receiptRecord' && e.lotId === x.receiptLotId);
    if (index < 0) return when(x.id);
    const at = createdAtOf(ledger, x.receiptLotId);
    return { index, at: at === null ? null : Date.parse(at) };
  };
  // 到着が申告より後か。両方の日時が分かれば日時で（同時刻は記録した順）、どちらかが不明なら記録した順で。
  const followed = (arrival: { index: number; at: number | null }, d: { index: number; at: number | null }) =>
    arrival.at !== null && d.at !== null ? arrival.at > d.at || (arrival.at === d.at && arrival.index > d.index) : arrival.index > d.index;
  const open = chronological(declared.map((d) => ({ remaining: d.value as number, ...when(d.id) })));
  const arrivals = chronological(
    Object.values(supply.requests)
      .filter((r) => sameProject(r.project, key.project) && r.item === key.item && r.unit === key.unit)
      .flatMap((r) => r.arrivals.map((x) => ({ good: x.good, ...arrivedWhen(x) }))),
  );
  // 日時不明をはさんで前後が両立しない並びでは、どの良品がどの申告より後かを決められないので、解消の数も不明にする。
  // 申告と到着は同じ供給の履歴に記録するので、合わせた並びで確かめる（それぞれの並びは両立しても、合わせると両立しないことがある）。
  if (orderContradicts([...open, ...arrivals])) return null;
  let toAuto = absorbed;
  for (const arrival of arrivals) {
    const used = Math.min(toAuto, arrival.good);
    toAuto = subtractScalar(toAuto, used, step);
    let pool = subtractScalar(arrival.good, used, step);
    for (const d of open) {
      if (pool === 0) break;
      if (!followed(arrival, d)) continue;
      const take = Math.min(d.remaining, pool);
      d.remaining = subtractScalar(d.remaining, take, step);
      pool = subtractScalar(pool, take, step);
    }
  }
  return sumScalars(open.map((d) => d.remaining), step);
}

// 実効の不足。求められない項があれば全体を不明にし、0として扱わない（手配対象数0・既存依頼が不要という誤表示を防ぐ）。
function effectiveShortageOf(ledger: Ledger, view: ShortageView, supply: Supply, key: GroupKey, step: Step): number | null {
  const declared = Object.values(supply.declarations).filter((d) => sameProject(d.project, key.project) && d.item === key.item && d.unit === key.unit);
  const hasNeed = key.project.kind === 'case' && Object.values(supply.needs).some((n) => n.project.id === (key.project as { id: string }).id && n.item === key.item && n.unit === key.unit);
  if (!hasNeed) return declared.length === 0 ? null : settledDeclared(ledger, supply, key, step, declared);
  const linked = declared.filter((d) => d.linked);
  const unlinked = declared.filter((d) => !d.linked);
  // 自動の不足が求まる間は、対応付けた申告は同じ不足なので数えない。判定不能のときだけ、その申告が代わりになる。
  // 自動の不足が求まる間も、対応付けていない独立した申告は、申告より後に届いた良品で解消する（解消されていない残りを足す）。
  // 届いた良品は、使用可能数（使えば使用済み）に入って自動の不足を減らす。届かなかったときの自動の不足は max(0, 残り＋良品)
  // （残り＝必要な数−使用済み−使用可能数）なので、その差が自動の不足に使われた良品の数で、申告の解消には残りだけを充てる。
  if (view.shortage !== null) {
    const goods = Object.values(supply.requests)
      .filter((r) => sameProject(r.project, key.project) && r.item === key.item && r.unit === key.unit)
      .flatMap((r) => r.arrivals.map((a) => a.good));
    const absorbed = positivePartMinus([view.aux.required ?? 0, ...goods], [view.aux.used ?? 0, view.aux.usable ?? 0], view.shortage, step);
    const others = settledDeclared(ledger, supply, key, step, unlinked, absorbed);
    return others === null ? null : addScalar(view.shortage, others, step);
  }
  return linked[0] ? settledDeclared(ledger, supply, key, step, [linked[0], ...unlinked]) : null;
}

export function requestSummaryOf(ledger: Ledger, supply: Supply, key: GroupKey): RequestSummary {
  const requests = Object.values(supply.requests).filter((r) => sameProject(r.project, key.project) && r.item === key.item && r.unit === key.unit);
  const open = requests.filter((r) => r.cancelled === null);
  const masters = ledger.masters;
  const step = quantityStepOf(masters, key.item, key.unit);
  const ordered = sumScalars(open.map((r) => r.quantity), step);
  const outstandingOf = (r: (typeof requests)[number]) => requestProgressOf(masters, r).outstanding ?? 0;
  const outstanding = sumScalars(open.map(outstandingOf), step);
  const arrived = sumScalars(requests.map((r) => requestProgressOf(masters, r).arrived), step);
  const goodApplied = sumScalars(requests.map((r) => requestProgressOf(masters, r).good), step);

  const receiptIds = new Set(requests.flatMap((r) => r.arrivals.map((a) => a.receiptLotId)));
  const overAllocated: RequestSummary['overAllocated'] = [];
  for (const id of receiptIds) {
    const received = receivedOf(supply, id);
    const allocated = allocatedToReceipt(supply, masters, id);
    if (received !== null && allocated > received) overAllocated.push({ receiptLotId: id, received, allocated });
  }

  const view = shortageOf(ledger, supply, key);
  const tentative = view.judgement.kind === 'confirm';
  const effectiveShortage = effectiveShortageOf(ledger, view, supply, key, step);
  const predatedArrivals: RequestSummary['predatedArrivals'] = [];
  for (const r of requests) {
    for (const a of r.arrivals) {
      if (a.arrived === 0) continue;
      const createdAt = createdAtOf(ledger, a.receiptLotId);
      const arrivedAt = supply.log.find((e) => e.eventId === a.id)?.occurredAt ?? null;
      if (createdAt !== null && arrivedAt !== null && Date.parse(arrivedAt) < Date.parse(createdAt)) predatedArrivals.push({ requestId: r.id, arrivalId: a.id, receiptLotId: a.receiptLotId });
    }
  }
  const predatedRevisions: RequestSummary['predatedRevisions'] = [];
  for (const id of receiptIds) {
    if (isStaleRevision(ledger, supply, id)) predatedRevisions.push({ receiptLotId: id, eventId: supply.receipts[id]!.eventId });
  }
  const provisionalReceipts = [...receiptIds].filter((id) => allocatedToReceipt(supply, masters, id) > 0 && receiptStatusOf(ledger, supply, id) === 'provisional');
  const held = effectiveShortage === null || overAllocated.length > 0 || tentative || predatedArrivals.length > 0 || predatedRevisions.length > 0;
  return {
    effectiveShortage,
    ordered,
    outstanding,
    arrived,
    goodApplied,
    predatedArrivals,
    predatedRevisions,
    provisionalReceipts,
    tentative,
    toOrder: held ? null : Math.max(0, subtractScalar(effectiveShortage, outstanding, step)),
    possiblyUnneeded: held ? null : outstanding > effectiveShortage ? open.filter((r) => outstandingOf(r) > 0).map((r) => r.id) : [],
    overAllocated,
  };
}

// 各値は範囲内でも、合計が上限を超える状態は、保存後の画面（手元の集計・不足・依頼・製造・Excel出力）の集計で失敗し、
// 再読込でも同じ状態に戻る。画面の集計を一つずつなめる検査は集計が増えると漏れるので、記録から決まる範囲で確かめる。
// 単純な和の範囲（品目・単位ごとの手元、群ごとの依頼数・届いた数・使える数、受け取りごとの届いた数、使用実績と工程の累計）は、
// 絶対値の和を上限以内にする。値が非負なら、この和は集計の和そのものになる。受け取りの実際に受け取った数は比べるだけで足さず、依頼数・届いた数・
// 使える数も互いに足さないので、別々の範囲にする。必要な数・申告と手元を組み合わせる不足は、絶対値の和では表示できる状態まで
// 拒否してしまうので、必要明細・申告・依頼のある群ごとに集計そのもの（requestSummaryOf）を求める。
// 保存前の検査と、保存された記録の復号の両方から呼ぶ。参照先のないまとまり・依頼は数えるだけで、たどらない。
export function requireQuantityTotals(ledger: Ledger, supply: Supply): void {
  const buckets = new Map<string, { item: string; unit: string; label: string; values: number[] }>();
  const put = (scope: string, label: string, item: string, unit: string, value: number | null) => {
    if (value === null || value === 0) return;
    const key = `${scope}\u0000${item}\u0000${unit}`;
    const bucket = buckets.get(key) ?? { item, unit, label, values: [] };
    bucket.values.push(Math.abs(value));
    buckets.set(key, bucket);
  };
  const scopeOf = (kind: string, project: Project) => `${kind}\u0000${projectText(project)}`;
  for (const lot of Object.values(ledger.lots)) {
    // 手元の一覧とExcelの集計は、案件・用途を問わず品目・単位ごとに足す。
    if (lot.mergedInto === null) put('lots', '在庫', lot.item, lot.unit, numericValueOf(lot.quantity));
  }
  const receipts = new Map<string, { item: string; unit: string }>();
  for (const r of Object.values(supply.requests)) {
    if (r.cancelled === null) put(scopeOf('ordered', r.project), '依頼数', r.item, r.unit, r.quantity);
    for (const a of r.arrivals) {
      put(scopeOf('arrived', r.project), '届いた数', r.item, r.unit, a.arrived);
      put(scopeOf('good', r.project), '使える数', r.item, r.unit, a.good);
      // 受け取りごとの割り当ての合計は品目・単位を見ずに足すので、違う品目・単位の到着が一つの受け取りに混ざった記録は合計できない。
      const lot = ledger.lots[a.receiptLotId];
      const seen = receipts.get(a.receiptLotId) ?? (lot ? { item: lot.item, unit: lot.unit } : { item: r.item, unit: r.unit });
      if (seen.item !== r.item || seen.unit !== r.unit) throw new Error(`受け取り${a.receiptLotId}の到着が、品目・単位の違う依頼${r.id}に割り当てされている`);
      receipts.set(a.receiptLotId, seen);
      put(`receipt\u0000${a.receiptLotId}`, `受け取り${a.receiptLotId}の届いた数`, r.item, r.unit, a.arrived);
    }
  }
  const voided = new Set(ledger.history.flatMap((e) => (e.kind === 'void' ? [e.targetEventId] : [])));
  for (const e of ledger.history) {
    if (e.kind === 'use' && !voided.has(e.eventId)) {
      const lot = ledger.lots[e.lotId];
      if (lot) put(scopeOf('used', lot.project), '使用実績', lot.item, lot.unit, e.value);
    }
    const tally = productionTallyOf(ledger, e, (id) => voided.has(id));
    if (tally) for (const kind of tally.kinds) put(scopeOf(`${kind}\u0000${tally.process}`, tally.lot.project), `工程${tally.process}の${tallyLabel[kind]}`, tally.lot.item, tally.lot.unit, tally.value);
  }
  const fail = (what: string, error: unknown) => new Error(`${what}の合計が上限を超える：${error instanceof Error ? error.message : String(error)}`);
  for (const { item, unit, label, values } of buckets.values()) {
    try {
      sumScalarsFinal(values, quantityStepOf(ledger.masters, item, unit));
    } catch (error) {
      throw fail(`品目${item}（${unit}）の${label}`, error);
    }
  }
  for (const key of groupsOf(ledger, supply)) {
    try {
      requestSummaryOf(ledger, supply, key);
    } catch (error) {
      throw fail(`${projectText(key.project)}・品目${key.item}（${key.unit}）の不足と依頼`, error);
    }
  }
}

const tallyLabel: Record<ProductionTally, string> = { completed: '工程完了累計', reworkStarted: 'やり直し・修理開始累計', returned: '工程内へ戻した数', handedOver: '引渡済み累計' };

function projectText(project: Project): string {
  return project.kind === 'case' ? `案件・用途${project.id}` : project.kind === 'common' ? '共通' : '所属不明';
}

export type DateStatus = { noReply: boolean; overdue: boolean; lateForNeed: boolean };

// 納期の三状態（NEED-06）。三つは独立に立つ。いずれも未着が残る依頼だけが対象で、全量到着した依頼・取消した依頼は立たない。
// 必要日は、依頼と同じ案件・用途・品目・単位の必要明細の必要日。必要明細や必要日がなければ「必要日に間に合わない」は判定しない。
// 日付は YYYY-MM-DD なので、文字列の順が日付の順と同じ。
export function dateStatusOf(supply: Supply, masters: Masters, requestId: string, asOf: DateText): DateStatus {
  checkDate(asOf, '判定日');
  const r = supply.requests[requestId];
  if (!r) throw new Error(`依頼 ${requestId} がない`);
  const outstanding = (requestProgressOf(masters, r).outstanding ?? 0) > 0;
  if (!outstanding) return { noReply: false, overdue: false, lateForNeed: false };
  const need = r.project.kind === 'case' ? Object.values(supply.needs).find((n) => n.project.id === (r.project as { id: string }).id && n.item === r.item && n.unit === r.unit) : undefined;
  const eta = r.reply.kind === 'none' ? null : r.reply.date;
  return {
    noReply: eta === null,
    overdue: eta !== null && eta < asOf,
    lateForNeed: eta !== null && need !== undefined && need.dueDate !== null && eta > need.dueDate,
  };
}

// 同じ案件・用途で、不足品目・単位が群と等しい、作業の再開前の中断。中断している工程の品目（stop.item）とは比べない。
// SCN-02のように半製品Rの作業が部品Pの不足で止まるとき、部品Pの群に出る。参照だけで、中断も不足も変えない（MFG-08c）。
// 作業の再開前で不足品目が記録された中断の群。必要明細・申告・依頼・現物がなくても、その不足で止まっている作業を示すため（ADR-020）。
export function stopGroupsOf(ledger: Ledger): GroupKey[] {
  return Object.values(ledger.stops).flatMap((s) => (s.resumedBy === null && s.shortage !== null ? [{ project: s.project, item: s.shortage.item, unit: s.shortage.unit }] : []));
}

export function stopsOf(ledger: Ledger, key: GroupKey): Stop[] {
  return Object.values(ledger.stops).filter(
    (s) => s.resumedBy === null && s.shortage !== null && s.shortage.item === key.item && s.shortage.unit === key.unit && sameProject(s.project, key.project),
  );
}
