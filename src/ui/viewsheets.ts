import { nextProcessOf } from '../domain/masters.ts';
import { occurredAtOf, openIssuesOf, processNameAt, productionGroupsOf, productionIssuesOf, productionOf, voidOf, type Ledger, type LedgerEvent, type Lot } from '../domain/ledger.ts';
import type { Quantity } from '../domain/quantity.ts';
import type { Arrival, Need, SupplyEvent } from '../domain/supply.ts';
import { requestProgressOf } from '../domain/supply.ts';
import { basisLabel, eventText, holdLabel, itemNameText, itemRef, jst, kindLabel, lastCountText, lastUpdatedOf, locationRef, projectText, quantityText, stageText, totalsOf } from './format.ts';
import type { Snapshot } from './storage.ts';
import { needQuantityText, replyText, supplyEventText, supplyOccurredText } from './supply-format.ts';
import type { Sheet } from './xlsx.ts';
import { cumulativeText, reworkTextOf } from './format.ts';
import { scanCells } from './code-format.ts';
import { createHistoryTargetCollector } from '../domain/history-targets.ts';
import { consumableSettingText, criterionText, packagingSettingText } from './format.ts';
import type { HistoryTargetCollector } from './history-item-format.ts';

type State = Pick<Snapshot, 'ledger' | 'supply'>;
type Column = { header: string; width: number; meaning: string };
type Spec = { name: string; purpose: string; columns: Column[]; rows: string[][] };

// 空のセルを作らない。値がないことは「なし」と書き、0や空欄と区別する（要件4.3）。
const orNone = (text: string | null | undefined): string => (text === null || text === undefined || text === '' ? 'なし' : text);

const column = (header: string, width: number, meaning: string): Column => ({ header, width, meaning });

const scanColumns = (): Column[] => [
  column('読取原文', 50, 'その操作で使った文字列。空白・タブ・改行を含む原文。入力なしは「なし」'),
  column('読取形式', 18, '解釈した形式。実機の読取を保証しない'),
  column('当時の読取解釈', 70, '当時の品番・コード・内部識別・名称・状態と照合文字列。最終対象は内容の列'),
];

const unconfirmedText = { none: 'なし', partial: '一部', all: '全部' } as const;

function stateOf(q: Quantity): string {
  return q.kind === 'known' ? '分かっている' : q.kind === 'partlyUnknown' ? '一部不明' : '不明';
}

// 数値は、数が不明なら「不明」、数値部分がない一部不明なら「なし」。0は数が0のときだけ書く。
function numberOf(q: Quantity): string {
  if (q.kind === 'unknown') return '不明';
  return q.numeric === null ? 'なし' : String(q.numeric.value);
}

function approximateOf(q: Quantity): string {
  if (q.kind === 'unknown') return 'なし';
  return q.numeric?.approximate ? 'だいたいの数を含む' : '含まない';
}

function basisOf(q: Quantity): string {
  if (q.kind === 'unknown') return basisLabel.unknown;
  const bases = [...new Set(q.terms.map(t => basisLabel[t.observation.basis]))];
  if (q.kind === 'known' && !q.computed) return bases[0] ?? basisLabel.counted;
  return `計算値（${bases.join('・')}）`;
}

function unconfirmedOf(q: Quantity): string {
  if (q.kind === 'unknown') return '対象外';
  return q.numeric === null ? 'なし' : unconfirmedText[q.numeric.unconfirmed];
}

// 品目の列は、記録が指す品目の現在の既存ID（ADR-024）。登録情報の変更の履歴は「台帳の履歴」のシートにある。
const refMeaning = '品目の現在の品番・コード。品番・コードのない仮の品目は「（仮）名称」、利用停止中の品目は「（利用停止）」を付ける';

function activeLots(state: State): Lot[] {
  return Object.values(state.ledger.lots).filter(lot => lot.mergedInto === null);
}

function totalsSpec(state: State): Spec {
  const rows = totalsOf(state.ledger, activeLots(state)).map(t => [
    itemRef(state.ledger.masters, t.item), t.unit, quantityText(t.onHand, t.unit), quantityText(t.usable, t.unit), quantityText(t.excluded, t.unit),
    t.breakdown.length === 0 ? 'なし' : t.breakdown.map(b => `${holdLabel[b.reason]} ${quantityText(b.quantity, t.unit)}`).join('、'),
    t.staged === null ? 'なし' : quantityText(t.staged, t.unit),
    String(t.issueCount),
    t.issueCount > 0 ? '確認事項があるので、使用可能数として断定しない' : 'なし',
  ]);
  return {
    name: '集計',
    purpose: '品目と単位ごとの在庫の合計。画面の在庫一覧の上の集計と同じ計算で、単位の違う数は足さない。ほかのシートの数は文字列なので、合計はこのシートを見る',
    columns: [
      column('品目', 8, refMeaning),
      column('単位', 6, '数量の単位。単位の違う数は別の行にして足さない'),
      column('在庫', 36, '統合済みを除く在庫の合計。数が不明が混ざれば「ほかに数が不明N件。全体数量は不明」と書き、不明を0として足さない'),
      column('使用可能', 36, '在庫のうち使用可能な数。取り分けた理由のあるものと製造中・完成（渡す前）のものを除く'),
      column('取り分け', 36, '取り分けた理由のある数。製造中・完成（渡す前）のものは含めない'),
      column('取り分けの内訳', 40, '取り分けた理由ごとの数。理由が重なる保管単位は各理由に現れるが、取り分けの合計では一度だけ数える'),
      column('製造中・完成（渡す前）', 24, '製造中・完成（渡す前）の数。使用可能にも除外にも数えない'),
      column('確認が必要な件数', 12, '未解決の確認事項の件数'),
      column('備考', 40, '確認事項があるとき、使用可能数として断定しないことを書く'),
    ],
    rows,
  };
}

function lotsSpec(state: State, targets: HistoryTargetCollector): Spec {
  const { ledger } = state;
  const rows = activeLots(state).map(lot => {
    const q = lot.quantity;
    return [
      lot.id, itemRef(ledger.masters, lot.item), itemNameText(ledger.masters, lot.item), lot.unit, locationRef(ledger.masters, lot.location), projectText(ledger.masters, lot.project),
      stateOf(q), numberOf(q), approximateOf(q), basisOf(q), unconfirmedOf(q), quantityText(q, lot.unit), String(q.terms.length),
      lastCountText(ledger, lot), orNone(lot.holds.map(r => holdLabel[r]).join('・')), stageText(lot.stage),
      String(openIssuesOf(ledger, lot.id).length), orNone(lot.splitFrom), jst(lastUpdatedOf(ledger, lot.id)),
      reworkTextOf(ledger, lot, targets),
    ];
  });
  return {
    name: '保管単位',
    purpose: '在庫の保管単位（統合済みを除く）一覧。一行が一つの保管単位。保管単位は、箱・束など、ひとまとまりとして記録する現物を指す。数量の単位（個・本・箱など）とは別',
    columns: [
      column('保管単位ID', 12, '保管単位のID。先頭が0でも文字列のまま'),
      column('品目', 8, refMeaning),
      column('品目名', 16, '品目の現在の呼び名。品番・コードのない仮の品目と、利用停止中の品目は、その印を付ける'),
      column('単位', 6, '数量の単位'),
      column('場所', 8, '現物がある場所の現在の品番・コード。利用停止中の場所は「（利用停止）」を付ける'),
      column('案件・用途', 14, '案件・用途。共通在庫・案件・用途が不明もここに出る'),
      column('数量の状態', 12, '分かっている／一部不明／不明'),
      column('数値', 10, '記録上の数の数値。数が不明な場合は「不明」、数値部分がない一部不明は「なし」。0は数が0のとき'),
      column('だいたい', 12, '数値にだいたいの数を含むか'),
      column('数量の根拠', 28, '数えた・表示の数（ラベル・パッケージ）・だいたい・数が不明。記録から計算した数は「計算値」と、元になった根拠を書く'),
      column('中身未確認', 10, '箱などの中身を数えていない程度。なし／一部／全部。数が不明な場合は対象外'),
      column('記録上の数の表示', 40, '画面の在庫一覧と同じ記録上の数の表示'),
      column('元の記録の件数', 12, '記録上の数の計算に使った元の記録の件数。内容は「元の記録」シート'),
      column('最後に数えた数', 36, '最後に実数を確認した数と日時・操作'),
      column('取り分けた理由', 16, '不良・使用可否確認待ち・返却待ち・予備。なければ「なし」'),
      column('作業の状態', 24, '作業なし、または工程と作業中・確認待ち・完成（渡す前）'),
      column('確認が必要な件数', 12, 'この保管単位の未解決の確認事項の件数'),
      column('分割元', 12, '分割で作った保管単位の元のID。なければ「なし」'),
      column('最終記録更新', 24, '最後に記録を更新した日時（日本時間）'),
      column('やり直し・修理と部品処置', 70, '元の作業の開始材料と別の、やり直し・修理元・交換使用・廃棄・回収の記録。系譜の対応であり部品数の比例配分ではない'),
    ],
    rows,
  };
}

function termsSpec(state: State): Spec {
  const rows = activeLots(state).flatMap(lot => lot.quantity.terms.map((t, index) => [
    lot.id, lot.unit, String(index + 1), t.sign === 1 ? '＋' : '－', t.observation.value === null ? '不明' : String(t.observation.value),
    basisLabel[t.observation.basis], t.observation.id,
  ]));
  return {
    name: '元の記録',
    purpose: '記録上の数の計算に使った元の記録（観測）。一行が一つの記録で、保管単位ごとに並ぶ',
    columns: [
      column('保管単位ID', 12, 'この記録を含む保管単位'),
      column('単位', 6, '数量の単位'),
      column('順番', 8, 'その保管単位の中での順番（1から）'),
      column('符号', 6, '記録上の数に足した（＋）か、引いた（－）か'),
      column('値', 10, '記録した数。数が不明な場合は「不明」'),
      column('根拠', 12, '数えた・表示の数（ラベル・パッケージ）・だいたい・数が不明'),
      column('操作ID', 12, 'この記録を作った操作のID'),
    ],
    rows,
  };
}

type Correction = { before: string; after: string; reason: string; applied: string };
const noCorrection: Correction = { before: 'なし', after: 'なし', reason: 'なし', applied: '対象外' };
const appliedText = (applied: boolean): string => (applied ? '反映した' : '反映しなかった（親から減らしていない）');

// 訂正の前後・理由・反映。数えて確認・間違えた記録の取り消し・実際の日時の訂正・工程上の位置の訂正が対象で、それ以外は「なし」。
function correctionOf(ledger: Ledger, e: LedgerEvent): Correction {
  const unitOf = (lotId: string): string => ledger.lots[lotId]?.unit ?? '';
  switch (e.kind) {
    case 'recount':
      return {
        before: quantityText(e.compared, unitOf(e.lotId)),
        after: `${e.value}${unitOf(e.lotId)}（数えた）`,
        reason: e.cause.kind === 'unknown' ? '原因不明' : orNone(e.cause.text),
        applied: e.applied ? '反映した' : '反映しなかった（確認事項あり）',
      };
    case 'void': {
      const lotText = (lot: Lot): string => `${lot.id}：${quantityText(lot.quantity, lot.unit)}（${basisOf(lot.quantity)}）`;
      const before = e.changes.flatMap(c => c.before === null ? [] : [lotText(c.before)]).join('、');
      const after = e.changes.map(c => lotText(c.after)).join('、');
      return {
        before: `操作${e.targetEventId}（保管単位${e.lotId}）${before === '' ? '' : `；${before}`}`,
        after: `起きなかったものとして取消${after === '' ? '（数量は変えていない）' : `；${after}`}`,
        reason: orNone(e.reason),
        applied: e.applied ? '反映した（数量を戻した）' : '反映しなかった（数量は変えていない）',
      };
    }
    case 'correctTime':
      return { before: jst(e.previous), after: jst(e.corrected), reason: 'なし', applied: '反映した' };
    case 'stage': {
      const parentBefore = e.changes.find(c => c.after.id === e.lotId)?.before;
      return e.correction
        ? { before: parentBefore ? stageText(parentBefore.stage, id => processNameAt(ledger, e.eventId, id)) : 'なし', after: stageText(e.to, id => processNameAt(ledger, e.eventId, id)), reason: 'なし', applied: appliedText(e.applied) }
        : { ...noCorrection, applied: appliedText(e.applied) };
    }
    case 'use':
    case 'handover':
    case 'split':
    case 'transfer':
      return { ...noCorrection, applied: appliedText(e.applied) };
    default:
      return noCorrection;
  }
}

function ledgerHistorySpec(state: State, targets: HistoryTargetCollector): Spec {
  const { ledger } = state;
  const rows = ledger.history.map(e => {
    const c = correctionOf(ledger, e);
    const at = occurredAtOf(ledger, e.eventId);
    return [
      e.eventId, kindLabel[e.kind], jst(at), at !== e.occurredAt ? jst(e.occurredAt) : 'なし', jst(e.recordedAt), e.actor, eventText(ledger, e, targets),
      c.before, c.after, c.reason, c.applied, orNone(voidOf(ledger, e.eventId)?.eventId),
      ...scanCells(e.scan),
    ];
  });
  return {
    name: '台帳の履歴',
    purpose: '台帳の操作の履歴。古い順で、一行が一つの操作。訂正を含む',
    columns: [
      column('操作ID', 10, '操作のID'),
      column('種類', 18, '操作の種類'),
      column('実際の日時', 24, '操作が起きた日時（日本時間）。実際の日時の訂正があれば訂正後'),
      column('訂正前の実際の日時', 24, '実際の日時を訂正したとき、訂正前の日時。訂正がなければ「なし」'),
      column('入力した日時', 24, '記録した日時（日本時間）'),
      column('担当', 12, '記録した担当者'),
      column('内容', 80, '画面の履歴と同じ操作の内容'),
      column('訂正の前', 28, '訂正する前の値。数えて確認は、それまでの記録上の数。間違えた記録の取り消しは、取り消した操作と、数量を変更した保管単位のID・数量・根拠。実際の日時の訂正は、訂正前の日時。作業の状態の訂正は、訂正前の位置。訂正でない操作は「なし」'),
      column('訂正の後', 28, '訂正した後の値。取消で数量を変えた場合は、その時点の対象保管単位ID・数量・根拠'),
      column('訂正の理由', 24, '数えて確認は原因（原因不明を含む）、間違えた記録の取り消しは理由。なければ「なし」'),
      column('反映', 28, '数量に反映したか。反映した／反映しなかった（親から減らしていない・確認事項あり・数量は変えていない）。数量に関わらない操作は「対象外」'),
      column('取消', 10, 'この操作を取り消した操作のID。なければ「なし」'),
      ...scanColumns(),
    ],
    rows,
  };
}

const supplyKindLabel: Record<SupplyEvent['kind'], string> = {
  receiptTemplateSave: 'セットの登録・変更',
  receiptTemplateDelete: 'セットの削除',
  templateReceipt: 'セットからまとめて受け取り（欠品の入力）',
  usageEstimate: 'セットで作業の開始（材料の使用の推計）',
  needImport: '必要明細の取込',
  needImportResolve: '必要明細取込の照合',
  needRegister: '必要な数の登録',
  needRevise: '必要な数の改訂',
  shortageDeclare: '足りない分の記録',
  declarationLink: '足りない分の記録の対応付け',
  requestRecord: '注文・購入予定の記録',
  orderConfirm: '注文の確定',
  replyRecord: '依頼の回答',
  requestCancel: '依頼の取消',
  receiptRecord: '受け取り',
  receiptRevise: '実際に受け取った数の訂正',
  arrival: '割り当て（到着）',
  arrivalRevise: '割り当ての訂正',
  remainder: '残量区分の記録',
  returnAck: '返品の受付確認',
};

const needText = (n: Need): string => `${needQuantityText(n.required, n.unit)}、必要日${n.dueDate ?? 'なし'}、出典${n.source}、${n.revision}`;
const arrivalText = (a: Arrival): string => `到着${a.arrived}・良品${a.good}（保管単位${a.receiptLotId}）`;

function supplyCorrectionOf(e: SupplyEvent): Omit<Correction, 'applied'> {
  switch (e.kind) {
    case 'needImport': return e.decision.kind === 'hold' ? { before: '未反映', after: '未反映', reason: e.decision.reasons.join('、') } : { before: e.decision.before ? needText(e.decision.before) : '明細なし', after: needText(e.decision.after), reason: '取込差分を確認' };
    case 'needImportResolve': return e.resolution.kind === 'dismiss' ? { before: '未反映', after: '適用せず解消', reason: e.reason } : { before: needText(e.resolution.before), after: needText(e.resolution.after), reason: e.reason };
    case 'needRevise': return { before: needText(e.before), after: needText(e.after), reason: 'なし' };
    case 'receiptRevise': return { before: e.before === null ? '未確認' : String(e.before), after: `${e.after}${e.provisional ? '（仮）' : ''}`, reason: orNone(e.reason) };
    case 'arrivalRevise': return { before: arrivalText(e.before), after: arrivalText(e.after), reason: 'なし' };
    case 'replyRecord': return { before: replyText(e.before), after: replyText(e.after), reason: 'なし' };
    default: return { before: 'なし', after: 'なし', reason: 'なし' };
  }
}

function supplyHistorySpec(state: State, targets: HistoryTargetCollector): Spec {
  const rows = state.supply.log.map(e => {
    const c = supplyCorrectionOf(e);
    return [e.eventId, supplyKindLabel[e.kind], supplyOccurredText(state.ledger, e), jst(e.recordedAt), e.actor, supplyEventText(state.ledger.masters, e, targets.supplyEventItemIds(e)), c.before, c.after, c.reason, ...scanCells(e.scan)];
  });
  return {
    name: '供給の履歴',
    purpose: '不足・依頼・受け取り・割り当ての操作の履歴。古い順で、一行が一つの操作。訂正を含む',
    columns: [
      column('操作ID', 10, '操作のID'),
      column('種類', 20, '操作の種類'),
      column('実際の日時', 28, '操作が起きた日時（日本時間）。受け取りは台帳の登録の実際の日時で、訂正があれば訂正前も書く'),
      column('入力した日時', 24, '記録した日時（日本時間）'),
      column('担当', 12, '記録した担当者'),
      column('内容', 80, '画面の履歴と同じ操作の内容'),
      column('訂正の前', 36, '訂正する前の値。必要な数の改訂・実際に受け取った数の訂正・割り当ての訂正・依頼の回答が対象で、それ以外は「なし」'),
      column('訂正の後', 36, '訂正した後の値'),
      column('訂正の理由', 24, '実際に受け取った数の訂正の理由。なければ「なし」'),
      ...scanColumns(),
    ],
    rows,
  };
}

function requestsSpec(state: State): Spec {
  const rows = Object.values(state.supply.requests).map(r => {
    const { arrived, good, outstanding } = requestProgressOf(state.ledger.masters, r);
    return [
      r.id, projectText(state.ledger.masters, r.project), itemRef(state.ledger.masters, r.item), r.unit, String(r.quantity), r.vendor, r.requestedOn,
      r.orderConfirmedBy === null ? '未確認' : `確認済み（${r.orderConfirmedBy}）`, replyText(r.reply), String(arrived), String(good),
      outstanding === null ? 'なし' : String(outstanding),
      r.cancelled === null ? 'なし' : `取消済み（理由：${orNone(r.cancelled.reason)}、操作${r.cancelled.eventId}）`,
    ];
  });
  return {
    name: '依頼',
    purpose: '補充の依頼の一覧。一行が一つの依頼',
    columns: [
      column('依頼ID', 10, '依頼のID'),
      column('案件・用途', 14, '依頼の案件・用途'),
      column('品目', 8, refMeaning),
      column('単位', 6, '数量の単位'),
      column('依頼数', 10, '依頼した数'),
      column('依頼先', 20, '依頼先'),
      column('依頼日', 12, '依頼日'),
      column('注文の確定', 18, '注文の確定の担当者。未確認なら「未確認」'),
      column('回答の状態', 28, '未回答／推定の予定日／相手が回答した予定日。推定と回答は別'),
      column('届いた数', 10, '届いた数の合計。取消した依頼でも、届いた現物は数える'),
      column('使える数', 10, '不足の解消に充てた良品の合計。届いた数とは別'),
      column('未着の数', 10, '依頼数から届いた数を引いた残り（0以上）。取消した依頼は「なし」'),
      column('取消', 40, '依頼を取り消したとき、理由と操作。なければ「なし」'),
    ],
    rows,
  };
}

function productionSpec(state: State): Spec {
  const rows = productionGroupsOf(state.ledger).map(group => {
    const p = productionOf(state.ledger, group.process, group.item, group.unit, group.project);
    const issues = productionIssuesOf(state.ledger, group).length;
    return [group.process, itemRef(state.ledger.masters, group.item), group.unit, projectText(state.ledger.masters, group.project),
      quantityText(p.working, group.unit), quantityText(p.inspecting, group.unit), quantityText(p.awaitingHandover, group.unit),
      cumulativeText(p.completed, group.unit), cumulativeText(p.reworkStarted, group.unit), cumulativeText(p.returned, group.unit), cumulativeText(p.handedOver, group.unit),
      issues ? `確認が必要 ${issues}件：確定した製造の数として断定しない` : 'なし'];
  });
  return {
    name: '工程集計',
    purpose: '工程・品目・単位・案件・用途別の現在数と履歴の累計。累計を現在の現物数へ足さない。やり直し・修理開始累計は同じ現物の再やり直し・修理でも増える',
    columns: [column('工程', 18, '工程の識別'), column('品目', 12, refMeaning), column('単位', 6, '数量の単位'), column('案件・用途', 18, '現在の案件・用途'),
      column('作業中', 30, '現在の作業中の数。やり直し・修理分も含む'), column('確認待ち', 30, '現在の確認待ちの数'), column('完成（渡す前）', 30, '現在の完成（渡す前）の数'),
      column('工程完了累計', 30, '完了の履歴。現在数には足さない'), column('やり直し・修理開始累計', 30, '物理的なやり直し・修理開始の履歴。再やり直し・修理でも増え、現在数には足さない'),
      column('訂正で工程内へ戻した数', 30, '作業の状態の訂正の履歴。物理的なやり直し・修理開始とは別で、完了累計から引かない'), column('引渡済み累計', 30, '引渡しの履歴。現在数には足さない'),
      column('確認が必要', 50, 'この工程群の未解決事項。該当する間は確定した製造の数として断定しない')],
    rows,
  };
}

const notation: [string, string][] = [
  ['不明', '数量が分からないこと。0ではない'],
  ['なし', 'その欄に当てはまる値がないこと。0とは違う'],
  ['0', '数が0であると数えた・記録したこと'],
  ['約', 'だいたいに由来する数（「だいたいの数を含む」）'],
  ['中身未確認', '箱などの中身を数えていないこと（一部・全部）'],
  ['計算値', '数えた数ではなく、記録から計算した台帳の数'],
  ['日時', '日本時間で書く。実際の日時が分からないときは「日時不明」'],
  ['反映しなかった', '操作を記録したが、数量には反映していないこと（負数になる使用など。確認事項が作られる）'],
  ['取消', '記録誤りとして取り消した操作。取り消しても元の記録は消さず、取消の操作を足す'],
  ['長い値', 'Excelの1セルの上限（32,767文字、特殊な文字列の保護で増える分も含む）を超えた値は、元のセルに先頭と案内を書き、全文を「長い値」シートの断片に持つ'],
];

function itemSettingsSpec(state: State): Spec {
  return {
    name: '品目の設定', purpose: '現在の品目の単位・包装・共通消耗品の設定。変更前後は台帳の履歴を参照する',
    columns: [column('品番・コード', 24, '現在の品番・コード。未付与の品目は仮と表示'), column('名称', 30, '現在の品目名と利用停止の状態'),
      column('単位と最小単位', 30, '登録後は変更しない管理単位と最小単位'), column('包装・入り数', 80, '適用時点ごとの入り数。不明は0ではなく換算できない'),
      column('共通消耗品・補充基準', 60, '現在の対象指定・集計単位・補充基準・標準依頼数量。自動では依頼を作らない')],
    rows: Object.values(state.ledger.masters.items).map(item => [itemRef(state.ledger.masters, item.id), itemNameText(state.ledger.masters, item.id),
      item.units.map(unit => `${unit}：${item.unitSteps[unit]}`).join('、'), packagingSettingText(item.packaging), consumableSettingText(item.consumable)]),
  };
}

function processSettingsSpec(state: State): Spec {
  const ms = state.ledger.masters;
  const next = nextProcessOf(ms);
  return {
    name: '工程の設定', purpose: '現在の工程と次工程の場所。保管単位・工程集計のシートは工程をIDで示すので、この表で現在の名前を引く。変更前後は台帳の履歴を参照する',
    columns: [column('種類', 14, '工程または次工程の場所'), column('ID', 24, '記録が指す変わらない識別。工程の名前を変えても変わらない'), column('名前', 30, '現在の名前'),
      column('完了基準', 36, '工程の完了基準。作業終了、または作業終了後の確認の完了'), column('利用状況', 14, '利用中または利用停止')],
    rows: [
      ...Object.values(ms.processes).map(p => ['工程', p.id, p.name, criterionText(p.criterion), p.active ? '利用中' : '利用停止']),
      ...(next === null ? [] : [['次工程の場所', next.id, next.name, '対象外', next.active ? '利用中' : '利用停止']]),
    ],
  };
}

function explanation(specs: Spec[], createdAt: string): Spec {
  const rows: string[][] = [
    ['この出力', '閲覧用の出力（復元には使えない）。記録を戻すときは、復元用バックアップ（.json）を使う。この出力は取り込めない'],
    ['作成日時', jst(createdAt)],
    ['データ', 'このブラウザーに保存された記録の写し'],
    ['数の扱い', 'すべての値は文字列。Excelで列を合計・並べ替えしても数としては計算されない。合計は「集計」シートを見る'],
    ...notation,
    ...specs.map(s => [`シート「${s.name}」`, s.purpose]),
    ...specs.flatMap(s => s.columns.map(c => [`${s.name}「${c.header}」`, c.meaning])),
  ];
  return { name: '説明', purpose: '', columns: [column('項目', 28, '説明する項目'), column('内容', 100, '説明の内容')], rows };
}

// 閲覧用の出力のシート。説明を最初に置き、各シートの各列の意味を説明のシートから引けるようにする（要件4.12・5.3）。
export function viewSheetsOf(state: State, createdAt: string): Sheet[] {
  const targets = createHistoryTargetCollector(state);
  const specs = [totalsSpec(state), lotsSpec(state, targets), termsSpec(state), ledgerHistorySpec(state, targets), supplyHistorySpec(state, targets), requestsSpec(state), productionSpec(state), itemSettingsSpec(state), processSettingsSpec(state)];
  return [explanation(specs, createdAt), ...specs].map(({ name, columns, rows }): Sheet => ({ name, columns: columns.map(({ header, width }) => ({ header, width })), rows }));
}
