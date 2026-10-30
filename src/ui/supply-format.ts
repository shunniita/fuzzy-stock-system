import { scanText } from './code-format.ts';
import { creationsOf, occurredAtOf, perBoxOfLot, type Ledger, type Lot, type Stop } from '../domain/ledger.ts';
import type { Notice, StockOfItem, StockItem } from '../domain/packaging.ts';
import type { Basis, Quantity } from '../domain/quantity.ts';
import { requestProgressOf, type ReceiptStatus, type Reply, type Request, type SupplyEvent, type NeedQuantity, type Need } from '../domain/supply.ts';
import type { DateStatus, Judgement, RequestSummary, ShortageView, UndecidableReason } from '../domain/shortage.ts';
import { basisLabel, holdLabel, itemRef, jst, locationRef, projectText, quantityText, stopText } from './format.ts';
import type { ReceiptTemplate } from '../domain/receipt-template.ts';
import { own, quantityStepOf, type Masters } from '../domain/masters.ts';
import { subtractScalar } from '../domain/scalar.ts';
import { expandAssemblyRecipe } from '../domain/assembly-recipes.ts';
import { historyItems, type ItemFormatter } from './history-item-format.ts';

// 表示語はDESIGN_NOTES.mdと同じ流儀。色がなくても文字だけで区別できるようにする（UI-08a）。

export function replyText(r: Reply): string {
  return r.kind === 'none' ? '未回答' : r.kind === 'estimated' ? `推定の予定日${r.date}` : `相手が回答した予定日${r.date}`;
}

// 必要な数は数量の根拠を併記する。数が不明な場合は0と書かない。
export function needQuantityText(q: NeedQuantity, unit: string): string {
  const basis = basisLabel[q.basis as Basis];
  return q.value === null ? `数が不明（${basis}）` : `${q.value}${unit}（${basis}）`;
}

const valueText = (value: number | null, unit: string): string => (value === null ? '数が不明' : `${value}${unit}`);
const receiptLabelText = (label: string | null): string => (label === null ? '' : `・ラベル「${label}」`);

// 供給の履歴の一行。何が起きたかを、対象と数と根拠が分かる形で示す。
export function supplyEventText(m: Masters, e: SupplyEvent, itemIds?: readonly string[]): string {
  // recordedは保存時に対象集合を検査済み。旧記録の間接対象は呼出側の実contextから渡す。
  const ids = itemIds ?? (e.itemLabels.kind === 'recorded' ? Object.keys(e.itemLabels.items) : null);
  if (ids === null) throw new Error(`旧供給履歴 ${e.eventId} の対象品目を実際の記録から渡す`);
  const items = historyItems(e.itemLabels, ids);
  return items.complete(supplyEventDetails(m, e, items.ref)) + scanText(e.scan);
}

export function importedNeedText(m: Masters, n: Omit<Need, 'id'>, ref: ItemFormatter = id => itemRef(m, id)): string {
  return `${projectText(m, n.project)}・品目${ref(n.item)}・必要な数${needQuantityText(n.required, n.unit)}、必要日${n.dueDate ?? 'なし'}、元の資料「${n.source}」・改訂「${n.revision}」`;
}

export function receiptTemplateText(m: Masters, template: ReceiptTemplate, ref: ItemFormatter = id => itemRef(m, id)): string {
  const owner = template.product === null ? '製品未設定' : `製品${ref(template.product)}${template.productUnit === undefined ? '' : `（製品単位${template.productUnit}）`}`;
  const legacy = template.project === null ? '' : `／旧案件・用途${projectText(m, template.project)}`;
  return `「${template.name}」（${template.id}）／${owner}${legacy}／${basisLabel[template.basis]}／` + template.rows.map((row, i) =>
    `明細${i + 1}：${ref(row.item)} ${row.perSet}${row.unit}/${template.productUnit ?? '個'}・${locationRef(m, row.location)}${row.assembly === undefined ? '' : `（取り込み構成：${receiptTemplateText(m, row.assembly, ref)}）`}`).join('、');
}

function templateReceiptText(m: Masters, e: Extract<SupplyEvent, { kind: 'templateReceipt' }>, ref: ItemFormatter): string {
  const parts = expandAssemblyRecipe(m, e.template, e.sets, e.routes);
  const rows = e.rows.map((row, i) => {
    const part = parts[i]!;
    // 版7から移した記録は不足を入力していないのに不足0になるため、手配先のない受け取りでは不足を書かない。
    return `明細${part.parentIndex + 1}${part.childIndex === null ? '' : `・子明細${part.childIndex + 1}`} 予定${part.planned}${part.unit}・${e.vendor === null ? '' : `不足${row.shortfall}${part.unit}・`}受け取り${row.quantity}${part.unit}（${row.lotId === null ? '未受け取り' : `保管単位${row.lotId}`}）`;
  });
  const routes = e.routes === undefined ? '' : `／${e.routes.map((route, i) => `明細${i + 1}：${route === 'parts' ? '自作分の部品' : '組立済み'}`).join('、')}`;
  return `まとめて受け取り ${e.eventId}：${receiptTemplateText(m, e.template, ref)}／${projectText(m, e.project)}／製作個数${e.sets}${e.template.productUnit ?? ''}${routes}／${rows.join('、')}${e.vendor === null ? '' : `／欠品の手配先「${e.vendor}」へ不足分を依頼`}`;
}

// 確定数量は使用記録の合計で、数えた根拠がなければだいたい。差は確定−算出。
function usageEstimateText(m: Masters, e: Extract<SupplyEvent, { kind: 'usageEstimate' }>, ref: ItemFormatter): string {
  const unit = e.template.productUnit ?? '';
  const rows = e.rows.map((row, i) => {
    const part = e.template.rows[i]!, head = `明細${i + 1} ${ref(part.item)} ${part.perSet}${part.unit}/${unit}`;
    const calculated = row.calculated === null ? '算出不可' : `算出${row.calculated}${part.unit}`;
    if (row.decision === 'exclude') return `${head}・${calculated}・除外`;
    if (row.decision === 'unresolved') return `${head}・${calculated}・未確定（使用を記録していない）`;
    const delta = row.calculated === null || row.confirmed === null ? null : subtractScalar(row.confirmed, row.calculated, quantityStepOf(m, part.item, part.unit));
    const diff = delta === null ? '' : `（差${delta >= 0 ? '+' : ''}${delta}${part.unit}）`;
    return `${head}・${calculated}→確定${row.confirmed}${part.unit}${diff}・使用${row.uses.join('・')}`;
  });
  return `セット推計 ${e.eventId}：作業の開始${e.startEventId}・セット「${e.template.name}」（${e.template.id}）・製品${e.template.product === null ? '未設定' : ref(e.template.product)}・台数${e.sets}${unit}から算出した候補／${rows.join('、')}`;
}

function supplyEventDetails(m: Masters, e: SupplyEvent, ref: ItemFormatter): string {
  switch (e.kind) {
    case 'receiptTemplateSave': return `セットの${e.before === null ? '登録' : '変更'}：${e.before === null ? '' : `${receiptTemplateText(m, e.before, ref)} → `}${receiptTemplateText(m, e.after, ref)}`;
    case 'receiptTemplateDelete': return `セットの削除：${receiptTemplateText(m, e.before, ref)}（過去の受け取りは保持）`;
    case 'templateReceipt': return templateReceiptText(m, e, ref);
    case 'usageEstimate': return usageEstimateText(m, e, ref);
    case 'needImport': {
      const r = e.input.row, d = e.decision;
      const result = d.kind === 'hold' ? `確認が必要（必要な数へ未反映）：${d.reasons.join('、')}。関連明細${d.candidates.join('、') || 'なし'}` : `${d.kind === 'create' ? '追加' : d.kind === 'revise' ? '改訂' : '取込済み（現在値は変更なし）'}：${d.before ? importedNeedText(m, d.before, ref) : '明細なし'} → ${importedNeedText(m, d.after, ref)}（内部明細${d.after.id}）`;
      return `必要明細取込：元の資料「${r.source ?? '不明'}」・明細「${r.line ?? '不明'}」・改訂「${r.revision ?? '不明'}」（改訂前${r.previousRevision ?? 'なし'}）。${result}。読取原文：${e.input.raw}`;
    }
    case 'needImportResolve':
      return `必要明細取込${e.importEventId}の照合：${e.resolution.kind === 'dismiss' ? '適用せず解消' : `${importedNeedText(m, e.resolution.before, ref)} → ${importedNeedText(m, e.resolution.after, ref)}（内部明細${e.resolution.after.id}）`}。理由「${e.reason}」`;
    case 'needRegister': {
      const n = e.need;
      return `必要明細の登録：${projectText(m, n.project)}・品目${ref(n.item)}・必要な数${needQuantityText(n.required, n.unit)}、${n.dueDate ? `必要日${n.dueDate}` : '必要日なし'}、元の資料「${n.source}」・${n.revision}`;
    }
    case 'needRevise':
      return `必要明細の改訂：${projectText(m, e.after.project)}・品目${ref(e.after.item)}・必要な数${needQuantityText(e.before.required, e.before.unit)}→${needQuantityText(e.after.required, e.after.unit)}、必要日${e.before.dueDate ?? 'なし'}→${e.after.dueDate ?? 'なし'}、元の資料${e.before.source === e.after.source ? `「${e.after.source}」` : `「${e.before.source}」→「${e.after.source}」`}、${e.before.revision}→${e.after.revision}`;
    case 'shortageDeclare': {
      const d = e.declaration;
      return `足りない分の記録：${projectText(m, d.project)}・品目${ref(d.item)}・${valueText(d.value, d.unit)}、理由「${d.reason}」`;
    }
    case 'declarationLink':
      return `足りない分の記録${e.declarationId}を${e.linked ? '自動の不足候補に対応付け' : '対応付け解除'}`;
    case 'requestRecord': {
      const r = e.request;
      return `注文・購入予定の記録：${projectText(m, r.project)}・品目${ref(r.item)}・${r.quantity}${r.unit}、依頼先「${r.vendor}」、依頼日${r.requestedOn}、${replyText(r.reply)}（依頼しただけで、在庫には数えない）`;
    }
    case 'orderConfirm':
      return `注文の確定：依頼${e.requestId}（依頼とは別の記録）`;
    case 'replyRecord':
      return `回答の更新：依頼${e.requestId}、${replyText(e.before)}→${replyText(e.after)}`;
    case 'requestCancel':
      return `依頼の取消：依頼${e.requestId}、理由「${e.reason}」（元の依頼は残る）`;
    case 'receiptRecord':
      return `実際に受け取った数の記録：保管単位${e.lotId}、届いた数${e.received === null ? ' 未確認（数が不明で受け取り。残りを数えて逆算するか、数えて確定する）' : e.provisional ? `${e.received}（仮：表示の数（ラベル・パッケージ）・だいたい。使い切るか数えて確定）` : e.received}${receiptLabelText(e.label)}`;
    case 'receiptRevise':
      return `実際に受け取った数の訂正：保管単位${e.lotId}、${e.before ?? '未確認'}→${e.after}${e.provisional ? '（仮：残りから逆算）' : ''}、理由「${e.reason}」`;
    case 'arrival':
      return `割り当て：依頼${e.requestId}へ、保管単位${e.arrival.receiptLotId}から到着${e.arrival.arrived}・良品${e.arrival.good}（届いた数と、不足の解消に充てた使える数は別）`;
    case 'arrivalRevise':
      return `割り当ての訂正：依頼${e.requestId}、到着${e.before.arrived}→${e.after.arrived}・良品${e.before.good}→${e.after.good}`;
    case 'remainder':
      return `残量区分：保管単位${e.lotId}、${remainderText[e.level]}（数量へは換算しない）`;
    case 'returnAck':
      return `返品の受付確認：引渡し${e.handoverEventId}（在庫は減らさない）`;
  }
}

export const remainderText = { plenty: '多い', half: '半分程度', few: '少ない', nearEmpty: 'ほぼ空' } as const;

const undecidableText: Record<UndecidableReason, string> = {
  noNeed: '必要な数が未登録',
  needUnknown: '必要な数が不明',
  usedUnknown: '使用実績の数量が不明',
  onHandUnknown: '在庫の数量が不明',
  openIssue: '数量に影響する未解決の確認事項がある',
};

// 判定は色に頼らず文字で示す（UI-08a）。数量の根拠（だいたい・表示の数（ラベル・パッケージ））を引き継ぐ（04章 不足表示に引き継ぐ規則）。
export function judgementText(j: Judgement): string {
  switch (j.kind) {
    case 'ledger':
      return '帳簿上の不足';
    case 'confirm':
      return [j.approximate ? '数量確認が必要（だいたいの数を含む）' : null, j.unconfirmed ? '中身未確認（表示の数（ラベル・パッケージ）を含む）' : null].filter((t) => t !== null).join('・');
    case 'undecidable':
      return `判定不能：${j.reasons.map((r) => undecidableText[r]).join('・')}`;
  }
}

const countText = (n: number | null, unit: string, none = '不明'): string => (n === null ? none : `${n}${unit}`);

// 不足の欄の行。必要な数・使用済み・手元・使用可能は別々の数で、不足の内訳（数量不足と除外）と予備を添える。
export function shortageLinesText(view: ShortageView, unit: string): string[] {
  const { aux } = view;
  const lines = [
    [`必要な数 ${countText(aux.required, unit)}`, `使用済み ${countText(aux.used, unit)}`, `在庫（未使用の総数） ${countText(aux.onHand, unit)}`, `使用可能 ${countText(aux.usable, unit)}`].join('／'),
  ];
  if (view.shortage === null) {
    lines.push(`不足 ${judgementText(view.judgement)}`, '分かる部分は上の数値（補助）。不足の判定には使わない');
  } else {
    lines.push(`不足 ${view.shortage}${unit}（${judgementText(view.judgement)}）`);
    if (view.shortage > 0 && view.shortfall !== null && view.excludedShortage !== null) {
      const excluded = view.excluded.map((e) => `${e.reasons.map((r) => holdLabel[r]).join('・')} ${quantityText(e.quantity, unit)}`).join('、');
      lines.push(`内訳：数量不足 ${view.shortfall}${unit}・除外による不足 ${view.excludedShortage}${unit}${excluded === '' ? '' : `（除外中：${excluded}）`}`);
    }
  }
  if (view.spare.terms.length > 0) {
    // 予備の数値部分だけで求めるので、予備がだいたい・表示の数（ラベル・パッケージ）・不明を含むなら、賄える数も確定した数として示さない。
    const s = view.spare;
    const exact = s.kind === 'known' && !s.numeric.approximate && s.numeric.unconfirmed === 'none';
    const cover = view.spareCover === null || exact ? countText(view.spareCover, unit) : `${countText(view.spareCover, unit)}（予備が数えた数ではないので、確定していない）`;
    lines.push(`予備 ${quantityText(view.spare, unit)}／予備で賄える数 ${cover}（予備は使用可能に数えない。使うには交換として案件・用途用へ移す）`);
  }
  return lines;
}

// 手配対象数は、実効の不足が不明・過剰割り当てのとき0にせず保留と理由を書く（NEED-03a・NEED-04a）。
export function requestStateText(s: RequestSummary, unit: string): string[] {
  const toOrder = s.overAllocated.length > 0 ? '保留（過剰割り当てのため）' : s.predatedArrivals.length > 0 ? '保留（割り当ての日時が受け取りより前のため）' : s.predatedRevisions.length > 0 ? '保留（実際に受け取った数の訂正の日時が受け取りより前のため）' : s.tentative ? '保留（不足が確定していないため。数量確認が必要・中身未確認）' : s.toOrder === null ? '保留（不足が不明のため。0ではない）' : `${s.toOrder}${unit}`;
  const provisional = s.provisionalReceipts.length > 0 ? '（仮の割当を含む）' : '';
  const lines = [
    `手配対象数 ${toOrder}${s.toOrder === null ? '' : provisional}／依頼済み ${s.ordered}${unit}／依頼の未着 ${s.outstanding}${unit}`,
    `到着 ${s.arrived}${unit}（不足の解消に充てた良品 ${s.goodApplied}${unit}）。届いた数と使える数は別`,
  ];
  if (s.provisionalReceipts.length > 0) lines.push(`仮の割当：保管単位${s.provisionalReceipts.join('・')}（実際に受け取った数が仮の数。受け入れた物を使い切って確認事項がなければ確定し、数えて確定することもできる）`);
  for (const o of s.overAllocated) lines.push(`過剰割り当て：保管単位${o.receiptLotId} 実際に受け取った数${o.received}に対して割り当て${o.allocated}。割り当ての訂正で直す`);
  for (const p of s.predatedArrivals) lines.push(`割り当ての日時が受け取りより前：依頼${p.requestId}の割り当て${p.arrivalId}（保管単位${p.receiptLotId}）。受け取りの日時を元に戻すか、割り当ての届いた数を0に訂正する`);
  for (const p of s.predatedRevisions) lines.push(`実際に受け取った数の訂正の日時が受け取りより前：保管単位${p.receiptLotId}の訂正${p.eventId}。受け取りの日時を元に戻すか、受け取りのあとの日時で実際に受け取った数を訂正し直す`);
  if (s.possiblyUnneeded === null) {
    if (s.outstanding > 0) lines.push('不要の可能性の判定は保留（不足が不明・確定していない、過剰割り当て、または割り当ての日時の食い違いのため）');
  } else if (s.possiblyUnneeded.length > 0) {
    lines.push(`不要の可能性がある依頼：${s.possiblyUnneeded.join('・')}（未着の合計が不足を超えている。取り消すかは人が判断し、自動では取り消さない）`);
  }
  return lines;
}

// 供給の記録の実際の日時。実際に受け取った数の記録は受け取りの登録と一組なので、台帳の登録の実際の日時（訂正後）を示し、訂正前を添える。
// 供給の記録には日時の訂正がないので、写した元の日時のままだと、受け取りより前の記録に見える。
export function supplyOccurredText(ledger: Ledger, e: SupplyEvent): string {
  if (e.kind !== 'receiptRecord') return jst(e.occurredAt);
  const creation = ledger.history.find((x) => x.changes.some((c) => c.after.id === e.lotId && c.before === null));
  const at = creation ? occurredAtOf(ledger, creation.eventId) : e.occurredAt;
  return at === e.occurredAt ? jst(at) : `${jst(at)}（訂正前 ${jst(e.occurredAt)}）`;
}

// 依頼の行の納期。全量到着に見えても、その割り当てが過剰割り当て・日時の食い違いで確かでない間は、遅れの判定をしない。
export function requestHasConflict(r: Request, s: RequestSummary): boolean {
  const receipts = new Set(r.arrivals.map((a) => a.receiptLotId));
  return (
    s.overAllocated.some((o) => receipts.has(o.receiptLotId)) ||
    s.predatedArrivals.some((p) => p.requestId === r.id) ||
    s.predatedRevisions.some((p) => receipts.has(p.receiptLotId))
  );
}

export function requestDateText(r: Request, s: RequestSummary, d: DateStatus): string {
  if (requestHasConflict(r, s)) return '確認待ち（この依頼の割り当てに、過剰割り当てまたは日時の食い違いがあるため）';
  const receipts = new Set(r.arrivals.map((a) => a.receiptLotId));
  return s.provisionalReceipts.some((id) => receipts.has(id)) ? `${dateStatusText(d)}（仮の割当を含む）` : dateStatusText(d);
}

// 受け入れた現物の一覧での実際に受け取った数。仮の数は、確定した数と区別して示す。
export function receivedText(received: number | null, status: ReceiptStatus, label: string | null = null): string {
  const count = received === null ? '未確認（残りを数えて逆算するか、数えて確定する）' : status === 'provisional' ? `${received}（仮）` : String(received);
  return count + receiptLabelText(label);
}

export function stopLineText(m: Masters, stop: Stop): string {
  return `中断 ${stop.id}：${stopText(m, stop)}（作業の再開は別の記録）`;
}

export function dateStatusText(d: DateStatus): string {
  const parts = [d.noReply ? '納期未回答' : null, d.overdue ? '到着予定超過' : null, d.lateForNeed ? '必要日に間に合わない' : null].filter((t) => t !== null);
  return parts.length === 0 ? '遅れの指摘なし' : parts.join('・');
}

// 不足の解消・依頼の未着の解消・作業の再開は、互いから導かず別々に示す（NEED-08・MFG-08c）。
// 不足の解消は、手配対象数と同じ実効の不足（独立した申告を含む）で決める。自動の不足だけで決めると、残った申告を解消と示す。
export function stateTriadText(view: ShortageView, s: RequestSummary, openStops: readonly unknown[]): string[] {
  const unit = view.key.unit;
  // 過剰割り当て・日時の食い違いがある間は、割り当てした良品で決まる実効の不足を信用できないので、解消とも未解消とも断定しない。
  const inconsistent = s.overAllocated.length > 0 || s.predatedArrivals.length > 0 || s.predatedRevisions.length > 0;
  const pending = '確認待ち（過剰割り当て、または割り当て・実際に受け取った数の訂正の日時の食い違いがあるため）';
  const provisional = s.provisionalReceipts.length > 0 ? '（仮の割当を含む）' : '';
  return [
    `不足の解消：${inconsistent ? pending : s.effectiveShortage === null ? '判定不能' : s.effectiveShortage === 0 ? (s.tentative ? `不足0に見えるが確定していない（${judgementText(view.judgement)}）` : `解消（不足0）${provisional}`) : s.tentative ? `未解消に見えるが確定していない（不足${s.effectiveShortage}${unit}。${judgementText(view.judgement)}）` : `未解消（不足${s.effectiveShortage}${unit}）${provisional}`}`,
    `依頼の未着の解消：${inconsistent ? pending : `${s.outstanding === 0 ? '未着なし' : `未着${s.outstanding}${unit}`}${provisional}`}`,
    `作業の再開：${openStops.length === 0 ? '未再開の中断なし' : `未再開の中断が${openStops.length}件（再開は別の記録）`}`,
  ];
}

// ネジなど、箱と本数で持つ共通品目の欄。未開封の箱・開封済みの本数・残量区分を分け、本数の合計と補充確認を示す。
// 補充確認は確定した判定ではなく、依頼を自動で作らない（SUP-05）。既存の依頼を併せて示す（SUP-04b）。
// 1箱あたりの数を変えたあとは箱ごとに1箱あたりの数が違い得るので、箱ごとの1箱あたりの数と、適用時点ごとの1箱あたりの数を示す（MST-05、要件6.8）。
export function consumableLinesText(ledger: Ledger, cfg: StockItem, lots: readonly Lot[], stock: StockOfItem, notice: Notice, requests: readonly Request[]): string[] {
  const { pieceUnit } = cfg;
  const packaging = own(ledger.masters.items, cfg.item)?.packaging ?? null;
  const boxUnit = packaging?.boxUnit ?? '包装';
  const countLabel = packaging === null ? '入り数' : `1${boxUnit}あたりの数`;
  const changed = packaging !== null && packaging.perBox.length > 1;
  const lines: string[] = [];
  if (packaging) {
    const created = creationsOf(ledger);
    const perBoxText = (l: Lot): string => {
      if (!changed) return '';
      const perBox = perBoxOfLot(ledger, l, created);
      return perBox === null ? `（${countLabel}が分からない）` : `（${countLabel}${perBox}${pieceUnit}）`;
    };
    const boxes = lots.filter((l) => l.unit === packaging.boxUnit);
    lines.push(`未開封の${boxUnit}：${boxes.length === 0 ? 'なし' : boxes.map((l) => `${l.id} ${quantityText(l.quantity, l.unit)}${perBoxText(l)}`).join('、')}`);
  }
  const loose = lots.filter((l) => l.unit === pieceUnit && !stock.levelOnly.some((x) => x.lotId === l.id));
  lines.push(`開封済み・バラの数量（${pieceUnit}）：${loose.length === 0 ? 'なし' : loose.map((l) => `${l.id} ${quantityText(l.quantity, l.unit)}`).join('、')}`);
  const pieces = stock.pieces ? quantityText(stock.pieces, pieceUnit) : '数値なし';
  const [first, ...later] = packaging?.perBox ?? [];
  const conversion = !packaging || !first ? ''
    : later.length === 0 ? `。${boxUnit}は1${boxUnit}あたり${first.value}${pieceUnit}の表示で換算（現物を数えた値ではない）`
    : `。${boxUnit}は受け取りのときの1${boxUnit}あたりの表示で換算（${first.value === null ? '設定前の入り数は不明' : `1${boxUnit}あたり${first.value}${pieceUnit}`}、${later.map((p) => `${jst(p.from)}以後の受け取りは${p.value}${pieceUnit}`).join('、')}。現物を数えた値ではない）`;
  // 残量区分だけの分も個数には含まれないため、分かる分の数を全体の合計と表示しない。
  const subtotal = (stock.unconverted.length > 0 || stock.levelOnly.length > 0) && stock.pieces !== null && numericPart(stock.pieces) !== null;
  lines.push(`${subtotal ? '数量の数値部分の小計' : '数量合計'}（${pieceUnit}） ${pieces}${conversion}`);
  const precisionIds = new Set([...stock.precisionLimited, ...stock.stepMismatched].map((l) => l.id));
  const unconverted = stock.unconverted.filter((l) => !precisionIds.has(l.id));
  if (unconverted.length > 0) lines.push(`合算していない分（${countLabel}が分からない包装・だいたいや数が不明の${boxUnit}）：${unconverted.map((l) => `${l.id} ${quantityText(l.quantity, l.unit)}`).join('、')}`);
  if (stock.precisionLimited.length > 0) lines.push(`合算していない分（${quantityStepOf(ledger.masters, cfg.item, pieceUnit) === 1 ? '整数' : '数量'}の精度を保てる上限を超える）：${stock.precisionLimited.map((l) => `${l.id} ${quantityText(l.quantity, l.unit)}`).join('、')}`);
  if (stock.stepMismatched.length > 0) lines.push(`合算していない分（集計単位の最小単位に合わない）：${stock.stepMismatched.map(l => `${l.id} ${quantityText(l.quantity, l.unit)}`).join('、')}`);
  if (stock.levelOnly.length > 0) lines.push(`残量区分のみ（数量へは換算しない）：${stock.levelOnly.map((x) => `${x.lotId} ${remainderText[x.level]}`).join('、')}`);

  if (cfg.rule) {
    const rule = cfg.rule;
    if (notice.kind === 'none') {
      lines.push(`補充基準${rule.threshold}${rule.pieceUnit}。補充確認は出ていない（基準以上、または比べられる数値も区分もない）。標準依頼数量${rule.standardOrder.value}${rule.standardOrder.unit}`);
    } else {
      const basis = [
        notice.approximate ? '約（だいたい）を含む' : null,
        notice.unconfirmed ? '中身未確認（表示の数（ラベル・パッケージ））を含む' : null,
        notice.hasUnknown ? '不明の部分・合算していない分がある' : null,
        notice.levelOnly ? '残量区分のみの開封分がある' : null,
        notice.openIssue ? '未解決の確認事項がある（保留した操作の前の数量を、通常の在庫として断定しない）' : null,
      ].filter((t) => t !== null);
      // 補充確認が出た理由ごとに見出しを分ける。基準以上の本数を「下回る」とは書かない。
      const n = stock.pieces ? numericPart(stock.pieces) : null;
      const head =
        stock.precisionLimited.length > 0
          ? `精度の上限で合算していない分があるので、補充の要否を断定できない`
          : stock.stepMismatched.length > 0
          ? '集計単位の最小単位に合わず合算していない分があるので、補充の要否を断定できない'
          : n !== null
          ? n < rule.threshold
            ? `数量の数値部分が補充基準${rule.threshold}${rule.pieceUnit}を下回る`
            : notice.openIssue
              ? `数量の数値部分は補充基準${rule.threshold}${rule.pieceUnit}以上に見えるが、未解決の確認事項があるので、補充の要否を断定できない`
              : `数量の数値部分は補充基準${rule.threshold}${rule.pieceUnit}以上に見えるが、だいたい・中身未確認を含むので、補充の要否を断定できない`
          : notice.levelOnly
            ? '数値部分がなく残量区分だけなので、数量では比べない'
            : notice.openIssue
              ? '数量の数値部分がなく、未解決の確認事項があるので、補充の要否を断定できない'
              : '数量の数値部分がなく、合算していない分・不明の部分だけなので、補充の要否を断定できない';
      lines.push(`補充確認：${head}（標準依頼数量${rule.standardOrder.value}${rule.standardOrder.unit}）。根拠：${basis.length === 0 ? '数えた数' : basis.join('・')}。確定した判定ではない。依頼は自動では作らない`);
    }
  }

  const open = requests.filter((r) => r.cancelled === null);
  if (open.length === 0) lines.push('既存の依頼はない');
  for (const r of open) {
    const { arrived, outstanding } = requestProgressOf(ledger.masters, r);
    lines.push(`既存の依頼 ${r.id}：${r.quantity}${r.unit}・${r.vendor}・${replyText(r.reply)}・${r.orderConfirmedBy ? '注文の確定済み' : '注文の確定なし'}・到着${arrived}${r.unit}・未着${outstanding}${r.unit}`);
  }
  return lines;
}

function numericPart(q: Quantity): number | null {
  return q.kind === 'known' ? q.numeric.value : q.kind === 'partlyUnknown' ? (q.numeric?.value ?? null) : null;
}
