import { hold, release, split, voidOf, type Inclusion, type Ledger, type Lot, type Meta, type Project } from '../domain/ledger.ts';
import {
  acknowledgeReturn,
  allocateArrival,
  allocatedToReceipt,
  cancelRequest,
  confirmOrder,
  declareShortage,
  linkDeclaration,
  receiveLot,
  recordRemainder,
  returnStatusOf,
  staleAcksOf,
  isStaleRevision,
  receiptStatusOf,
  receivedFromRemaining,
  recordReply,
  recordRequest,
  registerNeed,
  remainderLevels,
  requestProgressOf,
  sameProject,
  type RemainderLevel,
  reviseArrival,
  reviseNeed,
  reviseReceipt,
  type CaseProject,
  type Reply,
  type Request,
  type Supply,
} from '../domain/supply.ts';
import { checkField, choiceField, h, section, selectField, textField, type Values } from './dom.ts';
import { amount, amountFields, countOrUnknown, quantityValue, codeTarget, itemFields, placeOptions, projectField, projectOf } from './fields.ts';
import { caseRef, itemNameText, itemRef, jst, locationRef, projectText, quantityText, tokyoText } from './format.ts';
import type { Masters } from '../domain/masters.ts';
import { own, requireActive } from '../domain/masters.ts';
import { consumablesOf, replenishmentOf, stockOf } from '../domain/packaging.ts';
import { dateStatusOf, groupsOf, requestSummaryOf, shortageOf, stopsOf, type GroupKey } from '../domain/shortage.ts';
import { consumableLinesText, needQuantityText, receivedText, requestDateText, remainderText, replyText, requestStateText, shortageLinesText, stateTriadText, stopLineText, supplyEventText, supplyOccurredText } from './supply-format.ts';
import { createHistoryTargetCollector } from '../domain/history-targets.ts';

// 画面の状態。台帳と供給を、一回の入力のどちらも更新できるよう一組で持つ。どれかで例外になれば、どちらも代入しない（DAT-04）。
export type State = { ledger: Ledger; supply: Supply };

// notice は成功した記録に添える注意の文。受け取りは記録したが割り当ては拒否した、という部分成功を伝える。
export type UiOp = {
  label: string;
  fields: () => HTMLElement[];
  run: (s: State, m: Meta, v: Values, inclusion: Inclusion | undefined) => { state: State; notice?: string; units?: State[] };
};

// 画面の部品が、現在の状態を引くための口。入力欄は描画のたびに作り直すので、値でなく取り出す関数を渡す。
export type Ctx = { ledger: () => Ledger; supply: () => Supply; asOfChanged?: () => void; openConsumableSettings?: () => void };

// 一回の入力に付ける基本ID。供給だけを変える入力では台帳の件数が増えないので、両方の履歴の件数の和から付ける。
// 入力は一件以上の記録を作るので、件数の和は入力ごとに必ず増え、基本IDは重ならない。
export function baseEventId(ledger: Ledger, supply: Supply): string {
  return `op${ledger.history.length + supply.log.length + 1}`;
}

// 一回の入力が複数の記録を作るときの、二つ目以降の記録のID（B1の -m・-u1 と同じ流儀）。台帳と供給の記録で同じIDを使わない。
export function suffixed(base: string, suffix: string): string {
  return `${base}-${suffix}`;
}

// 新しい必要明細の案件・用途は、利用中の案件・用途だけを出す（要件3.1）。値は内部の識別、表示は現在の既存ID。
const caseField = (masters: Masters, label = '案件・用途') =>
  codeTarget(choiceField('project', label, Object.values(masters.cases).filter((c) => c.active).map((c) => [c.id, caseRef(masters, c.id)])), 'project', { hold: 'project' });
const caseOf = (v: Values): CaseProject => ({ kind: 'case', id: v.text('project') });
const dateField = (name: string, label: string) => textField(name, label, 'date');

// 空欄を黙って日付なしにしない。日付なしは、必要日のように「なし」を選べる欄でだけ許す。
const dateOrNull = (v: Values, name: string): string | null => {
  const raw = v.text(name).trim();
  return raw === '' ? null : raw;
};

function dateRequired(v: Values, name: string, label: string): string {
  const raw = v.text(name).trim();
  if (raw === '') throw new Error(`${label}を入力する`);
  return raw;
}

// 不足数の空欄を黙って不明にも0にもしない。不明はチェックで選ぶ。

const replyOptions = [
  ['none', '未回答'],
  ['estimated', '推定の予定日'],
  ['answered', '相手が回答した予定日'],
] as const;

const replyFields = (): HTMLElement[] => [choiceField('replyKind', '回答', replyOptions), dateField('replyDate', '予定日（回答があるとき）')];

function replyOf(v: Values): Reply {
  const kind = v.text('replyKind') as Reply['kind'];
  const date = v.text('replyDate').trim();
  if (kind === 'none') {
    if (date !== '') throw new Error('未回答のときは予定日を入れない（予定日があるなら、推定か回答を選ぶ）');
    return { kind: 'none' };
  }
  if (date === '') throw new Error('予定日を入力する');
  return { kind, date };
}

const requestLabel = (m: Masters, r: Request): string =>
  `${r.id}：${projectText(m, r.project)}・品目${itemRef(m, r.item)}・${r.quantity}${r.unit}（${r.vendor}、${replyText(r.reply)}${r.orderConfirmedBy ? '、注文の確定済み' : ''}）`;

const requestField = (ctx: Ctx, where: (r: Request) => boolean = () => true) =>
  choiceField(
    'request',
    '依頼',
    Object.values(ctx.supply().requests)
      .filter((r) => r.cancelled === null && where(r))
      .map((r) => [r.id, requestLabel(ctx.ledger().masters, r)]),
  );

const projectOfValue = (v: Values): Project => projectOf(v);

export function supplyOps(ctx: Ctx): Record<string, UiOp> {
  const withSupply = (s: State, supply: Supply) => ({ state: { ...s, supply } });
  return {
    needRegister: {
      label: '必要な数の登録（案件・用途ごとの必要品目・必要な数）',
      fields: () => [caseField(ctx.ledger().masters), ...itemFields(ctx.ledger().masters), ...amountFields(), dateField('dueDate', '必要日（なければ空欄）'), textField('source', '元の資料'), textField('revision', '改訂（初版など）')],
      run: (s, m, v) => {
        // 供給の台帳は登録情報を持たないので、利用停止の品目・案件・用途を新しい記録に使わないことは、ここで確かめる（要件3.4）。
        requireActive(s.ledger.masters, { item: v.text('item'), project: caseOf(v) });
        return withSupply(s, registerNeed(s.supply, s.ledger.masters, m, { project: caseOf(v), item: v.text('item'), unit: v.text('unit'), required: amount(v), dueDate: dateOrNull(v, 'dueDate'), source: v.text('source'), revision: v.text('revision') }));
      },
    },
    needRevise: {
      label: '必要な数の改訂（改訂前後を履歴に残す）',
      fields: () => [
        choiceField(
          'need',
          '必要明細',
          Object.values(ctx.supply().needs).map((n) => [n.id, `${n.id}：${projectText(ctx.ledger().masters, n.project)}・品目${itemRef(ctx.ledger().masters, n.item)}・必要な数${needQuantityText(n.required, n.unit)}・${n.revision}`]),
        ),
        ...amountFields(),
        dateField('dueDate', '必要日（なければ空欄）'),
        textField('source', '元の資料'),
        textField('revision', '改訂（改訂2など）'),
      ],
      run: (s, m, v) =>
        withSupply(s, reviseNeed(s.supply, s.ledger.masters, m, v.text('need'), { required: amount(v), dueDate: dateOrNull(v, 'dueDate'), source: v.text('source'), revision: v.text('revision') })),
    },
    declareShortage: {
      label: '足りない分の記録（手動。確認事項は作らない）',
      fields: () => [projectField(ctx.ledger().masters), ...itemFields(ctx.ledger().masters), textField('value', '不足数', 'number'), checkField('valueUnknown', '不足数は不明'), textField('reason', '理由')],
      run: (s, m, v) => {
        requireActive(s.ledger.masters, { item: v.text('item'), project: projectOfValue(v) });
        return withSupply(s, declareShortage(s.supply, s.ledger.masters, m, { project: projectOfValue(v), item: v.text('item'), unit: v.text('unit'), value: countOrUnknown(v, 'value', '不足数'), reason: v.text('reason') }));
      },
    },
    linkDeclaration: {
      label: '足りない分の記録の対応付け（自動の不足候補と同じ不足）',
      fields: () => [
        choiceField(
          'declaration',
          '申告',
          Object.values(ctx.supply().declarations).map((d) => [d.id, `${d.id}：${projectText(ctx.ledger().masters, d.project)}・品目${itemRef(ctx.ledger().masters, d.item)}・${d.value === null ? '数が不明' : `${d.value}${d.unit}`}${d.linked ? '（対応付け済み）' : ''}`]),
        ),
        choiceField('link', '操作', [
          ['yes', '自動の不足候補に対応付ける（群に一件まで）'],
          ['no', '対応付けを解除する'],
        ]),
      ],
      run: (s, m, v) => withSupply(s, linkDeclaration(s.supply, s.ledger.masters, m, v.text('declaration'), v.text('link') === 'yes')),
    },
    requestRecord: {
      label: '注文・購入予定の記録（依頼しただけでは在庫に数えない）',
      fields: () => [projectField(ctx.ledger().masters), ...itemFields(ctx.ledger().masters, 'quantity'), textField('quantity', '依頼数量', 'number'), textField('vendor', '依頼先'), dateField('requestedOn', '依頼日'), ...replyFields()],
      run: (s, m, v) => {
        const raw = v.text('quantity').trim();
        if (raw === '') throw new Error('依頼数量を入力する');
        requireActive(s.ledger.masters, { item: v.text('item'), project: projectOfValue(v) });
        return withSupply(
          s,
          recordRequest(s.supply, s.ledger.masters, m, { project: projectOfValue(v), item: v.text('item'), unit: v.text('unit'), quantity: quantityValue(raw, v.step?.('quantity')), vendor: v.text('vendor'), requestedOn: dateRequired(v, 'requestedOn', '依頼日'), reply: replyOf(v) }),
        );
      },
    },
    orderConfirm: {
      label: '注文の確定（依頼とは別の記録）',
      fields: () => [requestField(ctx, (r) => r.orderConfirmedBy === null)],
      run: (s, m, v) => withSupply(s, confirmOrder(s.supply, s.ledger.masters, m, v.text('request'))),
    },
    replyRecord: {
      label: '返事・届く予定日の更新',
      fields: () => [requestField(ctx), ...replyFields()],
      run: (s, m, v) => withSupply(s, recordReply(s.supply, s.ledger.masters, m, v.text('request'), replyOf(v))),
    },
    requestCancel: {
      label: '依頼の取消（元の依頼は残る）',
      fields: () => [requestField(ctx), textField('reason', '取り消す理由')],
      run: (s, m, v) => withSupply(s, cancelRequest(s.supply, s.ledger.masters, m, v.text('request'), v.text('reason'))),
    },
    receive: {
      label: '受け取り（届いた数を記録。依頼への割り当てつき）',
      fields: () => [
        textField('newId', '新しい保管単位のID（文字列のまま保存）'),
        ...itemFields(ctx.ledger().masters),
        projectField(ctx.ledger().masters),
        codeTarget(choiceField('location', '場所', placeOptions(ctx.ledger().masters)), 'location', { hold: 'location' }),
        ...amountFields(),
        textField('label', 'ラベル文字列（任意）'),
        ...allocationRows.flatMap((i) => [
          selectField(`r${i}request`, `割り当て${i}の依頼`, [['', 'なし'], ...openRequestOptions(ctx)]),
          textField(`r${i}arrived`, `割り当て${i}の届いた数`, 'number'),
          textField(`r${i}good`, `割り当て${i}の不足の解消に充てた使える数`, 'number'),
        ]),
      ],
      run: (s, m, v) => {
        const { basis, value } = amount(v);
        const rows = allocationRowsOf(v);
        // 受け取りの登録（と実際に受け取った数の記録）を先に確定する。割り当ての拒否では受け取りを戻さない（NEED-05b）。
        const received = receiveLot(s.ledger, s.supply, m, { id: v.text('newId'), item: v.text('item'), unit: v.text('unit'), project: projectOf(v), location: v.text('location') }, basis, value, v.text('label') || null);
        const units: State[] = [received];
        let supply = received.supply;
        let notice: string | undefined;
        let recorded = 0;
        // 記録された最後の操作ID。受け取りは実際に受け取った数の記録（基本ID-c）まで一組。
        let lastId = suffixed(m.eventId, 'c');
        for (const row of rows) {
          try {
            // 行の数の読取もこの中で行い、読めない行は受け取りとそれまでの行を残してその行から断る（NEED-05b）。
            const arrived = quantityValue(row.arrived, v.step?.(`r${row.index}arrived`));
            const good = quantityValue(row.good, v.step?.(`r${row.index}good`));
            supply = allocateArrival(received.ledger, supply, { ...m, eventId: suffixed(m.eventId, `a${row.index}`) }, row.requestId, { receiptLotId: v.text('newId'), arrived, good });
            units.push({ ledger: received.ledger, supply });
            recorded += 1;
            lastId = suffixed(m.eventId, `a${row.index}`);
          } catch (e) {
            const reason = e instanceof Error ? e.message : String(e);
            notice = `受け取りは記録した。割り当ては拒否した（${row.index}行目：${reason}）。${recorded}行目までを記録した。最後に記録した操作は${lastId}`;
            break;
          }
        }
        return { state: { ledger: received.ledger, supply }, units, ...(notice ? { notice } : {}) };
      },
    },
    allocate: {
      label: '受け取った現物への割り当て（拒否のあとの再割り当てなど）',
      fields: () => [receiptField(ctx), requestField(ctx), textField('arrived', '届いた数', 'number'), textField('good', '不足の解消に充てた使える数', 'number')],
      run: (s, m, v) => {
        const arrived = v.text('arrived').trim();
        const good = v.text('good').trim();
        if (arrived === '') throw new Error('届いた数を入力する');
        if (good === '') throw new Error('使える数を入力する（0もある）');
        return withSupply(s, allocateArrival(s.ledger, s.supply, m, v.text('request'), { receiptLotId: v.text('receipt'), arrived: quantityValue(arrived, v.step?.('arrived')), good: quantityValue(good, v.step?.('good')) }));
      },
    },
    receiptRevise: {
      label: '実際に受け取った数の訂正（届いた数の訂正。理由が必要）',
      fields: () => [receiptField(ctx), textField('received', '訂正後の実際に受け取った数', 'number'), textField('reason', '訂正する理由')],
      run: (s, m, v) => {
        const raw = v.text('received').trim();
        if (raw === '') throw new Error('訂正後の実際に受け取った数を入力する');
        return withSupply(s, reviseReceipt(s.ledger, s.supply, m, v.text('receipt'), quantityValue(raw, v.step?.('received')), v.text('reason')));
      },
    },
    surplusAllocate: {
      label: '余った分の振り分け（受け取りの一部を予備・返却待ちにする）',
      fields: () => [
        codeTarget(lotChoice(ctx, 'lot', '対象の保管単位（受け入れた現物など）', (l) => l.stage.kind === 'none'), 'lot', { quantity: 'value', basis: 'basis' }),
        textField('childId', '分けた分の新しいID'),
        ...amountFields(),
        choiceField('destination', '割当先', [
          ['spare', '予備（交換用）'],
          ['returnPending', '返却待ち'],
        ]),
        textField('note', 'メモ（任意）'),
      ],
      // 分けた分の根拠は利用者が指定する。分割と取り分けた理由の付与を一回の入力で記録し、どちらかで失敗したら全部を未適用にする。
      run: (s, m, v, inclusion) => {
        const destination = v.text('destination');
        if (destination !== 'spare' && destination !== 'returnPending') throw new Error(`割当先「${destination}」は予備か返却待ちから選ぶ`);
        const { basis, value } = amount(v);
        const childId = v.text('childId');
        const divided = split(s.ledger, m, v.text('lot'), childId, basis, value, inclusion);
        const note = v.text('note').trim();
        return { state: { ...s, ledger: hold(divided, { ...m, eventId: suffixed(m.eventId, 'h') }, childId, destination, note === '' ? undefined : note) } };
      },
    },
    spareSwap: {
      label: '予備から案件・用途向けへ（交換。理由が必要）',
      fields: () => [
        lotChoice(ctx, 'lot', '予備の保管単位（案件・用途に属するもの）', (l) => l.holds.includes('spare') && l.project.kind === 'case'),
        textField('value', '交換する数（全部なら空欄）', 'number'),
        textField('childId', '分けた分の新しいID（一部だけ交換するとき）'),
        textField('note', '交換の理由（破損・紛失・不具合など）'),
      ],
      // 一部だけ交換するときは、先に分けて、分けた分の予備を外す。数えて分けるので根拠は数えた。
      run: (s, m, v, inclusion) => {
        // 分割・解除は案件・用途を変えないので、共通・所属不明の予備を外しても案件・用途用にはならない（案件・用途への割当は案件・用途間の融通で、未実装）。
        if (s.ledger.lots[v.text('lot')]?.project.kind !== 'case') throw new Error('予備から案件・用途用への交換は、案件・用途に属する予備だけ');
        const note = v.text('note');
        const raw = v.text('value').trim();
        if (raw === '') return { state: { ...s, ledger: release(s.ledger, m, v.text('lot'), 'spare', note) } };
        const childId = v.text('childId');
        if (childId.trim() === '') throw new Error('一部だけ交換するときは、分けた分の新しいIDを入力する');
        const divided = split(s.ledger, m, v.text('lot'), childId, 'counted', quantityValue(raw, v.step?.('value')), inclusion);
        return { state: { ...s, ledger: release(divided, { ...m, eventId: suffixed(m.eventId, 'r') }, childId, 'spare', note) } };
      },
    },
    returnAck: {
      label: '返品の受付確認（実返却とは別の記録。在庫は減らさない）',
      fields: () => [
        choiceField(
          'handover',
          '実返却（外への引渡し）',
          ctx
            .ledger()
            .history.filter((e) => e.kind === 'handover' && returnStatusOf(ctx.ledger(), e.eventId).ok && ctx.supply().acks[e.eventId] === undefined)
            .map((e) => [e.eventId, `${e.eventId}：保管単位${e.kind === 'handover' ? e.lotId : ''}から${e.kind === 'handover' ? (e.value ?? '数が不明') : ''}を${e.kind === 'handover' ? e.counterpart : ''}へ`]),
        ),
      ],
      run: (s, m, v) => withSupply(s, acknowledgeReturn(s.ledger, s.supply, m, v.text('handover'))),
    },
    remainder: {
      label: '開けた物の残り具合（数が不明な開封分。数量へは換算しない）',
      fields: () => [
        lotChoice(ctx, 'lot', '開封済みの保管単位（数が不明）', (l) => {
          const item = own(ctx.ledger().masters.items, l.item);
          const pieceUnit = item?.consumable?.pieceUnit ?? item?.packaging?.pieceUnit;
          return l.quantity.kind === 'unknown' && (pieceUnit === undefined || l.unit === pieceUnit);
        }),
        choiceField('level', '残量区分', remainderLevels.map((r): [string, string] => [r, remainderText[r]])),
      ],
      run: (s, m, v) => withSupply(s, recordRemainder(s.ledger, s.supply, m, v.text('lot'), v.text('level') as RemainderLevel)),
    },
    arrivalRevise: {
      label: '割り当ての訂正（届いた数・使える数。取消済みの依頼の割り当ても）',
      fields: () => [
        choiceField(
          'arrival',
          '割り当て',
          Object.values(ctx.supply().requests).flatMap((r) => r.arrivals.map((a): [string, string] => [`${r.id}/${a.id}`, `${r.id}への割り当て${a.id}：到着${a.arrived}・良品${a.good}（保管単位${a.receiptLotId}${r.cancelled ? '、依頼は取消済み' : ''}）`])),
        ),
        textField('arrived', '訂正後の届いた数', 'number'),
        textField('good', '訂正後の使える数', 'number'),
      ],
      run: (s, m, v) => {
        const [requestId, arrivalId] = v.text('arrival').split('/') as [string, string];
        const arrived = v.text('arrived').trim();
        const good = v.text('good').trim();
        if (arrived === '' || good === '') throw new Error('訂正後の届いた数と使える数を入力する');
        return withSupply(s, reviseArrival(s.ledger, s.supply, m, requestId, arrivalId, { arrived: quantityValue(arrived, v.step?.('arrived')), good: quantityValue(good, v.step?.('good')) }));
      },
    },
  };
}

const allocationRows = [1, 2, 3] as const;

const lotChoice = (ctx: Ctx, name: string, label: string, where: (lot: Lot) => boolean) =>
  codeTarget(choiceField(
    name,
    label,
    Object.values(ctx.ledger().lots)
      .filter((l) => l.mergedInto === null && where(l))
      .map((l): [string, string] => [l.id, `${l.id}（品目${itemRef(ctx.ledger().masters, l.item)}・${locationRef(ctx.ledger().masters, l.location)}・${projectText(ctx.ledger().masters, l.project)}・${quantityText(l.quantity, l.unit)}）`]),
  ), 'lot');

const openRequestOptions = (ctx: Ctx): [string, string][] =>
  Object.values(ctx.supply().requests)
    .filter((r) => r.cancelled === null)
    .map((r) => [r.id, requestLabel(ctx.ledger().masters, r)]);

// 使わない行は全部を空にする。依頼を選ばずに数だけ入れた行を、黙って捨てない。
function allocationRowsOf(v: Values): { index: number; requestId: string; arrived: string; good: string }[] {
  const rows: { index: number; requestId: string; arrived: string; good: string }[] = [];
  for (const i of allocationRows) {
    const requestId = v.text(`r${i}request`);
    const arrived = v.text(`r${i}arrived`).trim();
    const good = v.text(`r${i}good`).trim();
    if (requestId === '') {
      if (arrived !== '' || good !== '') throw new Error(`割り当て${i}の依頼を選ぶ（使わない行は届いた数と使える数も空にする）`);
      continue;
    }
    if (arrived === '') throw new Error(`割り当て${i}の届いた数を入力する`);
    if (good === '') throw new Error(`割り当て${i}の使える数を入力する（0もある）`);
    rows.push({ index: i, requestId, arrived, good });
  }
  return rows;
}

// 受け入れた現物（実際に受け取った数の記録のあるまとまり）。分割・まとめ直しのあとも、元のIDで選ぶ。
function receiptStateText(ledger: Ledger, lotId: string): string {
  const lot = ledger.lots[lotId];
  if (!lot) return '台帳にない';
  if (lot.mergedInto !== null) return `統合済み（${lot.mergedInto}へ）`;
  return Object.values(ledger.lots).some((l) => l.splitFrom === lotId) ? '一部を分割済み' : 'そのまま';
}

const receiptField = (ctx: Ctx) =>
  codeTarget(choiceField(
    'receipt',
    '受け入れた現物',
    Object.entries(ctx.supply().receipts).map(([lotId, r]): [string, string] => {
      const lot = ctx.ledger().lots[lotId];
      const now = lot ? quantityText(lot.quantity, lot.unit) : '不明';
      return [lotId, `${lotId}：実際に受け取った数${receivedText(r.received, receiptStatusOf(ctx.ledger(), ctx.supply(), lotId), r.label)}、割り当て済み${allocatedToReceipt(ctx.supply(), ctx.ledger().masters, lotId)}（台帳の現在数 ${now}、${receiptStateText(ctx.ledger(), lotId)}）`];
    }),
  ), 'lot');

// 受け入れた現物（元のまとまりそのもので、まとめ直し済みでない）か。数え直しで実際に受け取った数の扱いを選ばせる対象。
function isReceiptLot(ctx: Ctx, lotId: string): boolean {
  return ctx.supply().receipts[lotId] !== undefined && ctx.ledger().lots[lotId]?.mergedInto === null;
}

// 受け入れた現物を数え直すとき、実際に受け取った数の扱いを必須で選ばせる。台帳の数え直しは現在の残数の確認で、
// 届いた数の訂正と区別できないので、直し忘れを防ぐために記録のたびに選ぶ。分割の子・まとめ直しの先・初期登録には出さない。
export function recountWithReceiptChoice(base: UiOp, ctx: Ctx): UiOp {
  return {
    label: base.label,
    fields: () => {
      const fields = base.fields();
      const choice = selectField('receiptEffect', '実際に受け取った数の扱い（この現物は受け取りとして記録されている）', [
        ['', '選ぶ'],
        ['revise', '実際に受け取った数も、数えた数に訂正する（確定）'],
        ['derive', '実際に受け取った数を、数えた残りから逆算する（それまでに使った・渡した・分けた数を足す。仮の数）'],
        ['keep', '実際に受け取った数は変えない（現在の残数の確認）'],
      ]);
      choice.hidden = true;
      fields[0]?.querySelector('select[name=lot]')?.addEventListener('change', (e) => {
        choice.hidden = !isReceiptLot(ctx, (e.target as HTMLSelectElement).value);
      });
      return [...fields, choice];
    },
    run: (s, m, v, inclusion) => {
      const lotId = v.text('lot');
      const targeted = s.supply.receipts[lotId] !== undefined && s.ledger.lots[lotId]?.mergedInto === null;
      const effect = v.text('receiptEffect');
      if (targeted && effect === '') throw new Error('実際に受け取った数の扱いを選ぶ（受け取りとして記録されている現物の数え直し）');
      // 逆算は、数え直しで台帳の数量が置き換わる前の、減らした記録から求める。
      const derived = targeted && effect === 'derive' && v.text('value').trim() !== '' ? receivedFromRemaining(s.ledger, lotId, quantityValue(v.text('value').trim(), v.step?.('value'))) : null;
      if (targeted && effect === 'derive' && (v.text('value').trim() === '' || derived === null)) {
        throw new Error('実際に受け取った数を逆算できない（数えた残りがない、受け取りのあとに減らした数に不明がある、または受け取りのあとに数え直し済み）。数えて訂正するか、変えないを選ぶ');
      }
      const result = base.run(s, m, v, inclusion);
      if (!targeted || (effect !== 'revise' && effect !== 'derive')) return result;
      const last = result.state.ledger.history.at(-1);
      if (last?.kind === 'recount' && !last.applied) {
        return { ...result, notice: '数え直しは保留（確認が必要）なので、実際に受け取った数は訂正していない。解消してから実際に受け取った数を訂正する' };
      }
      // 空欄を黙って0にしない。実際に受け取った数を0にすると、過剰割り当てと手配の判断を誤らせる。
      const rawCount = v.text('value').trim();
      let counted: number;
      try {
        counted = quantityValue(rawCount, v.step?.('value'));
      } catch (e) {
        throw new Error(`実際に受け取った数を訂正するには、数えた数を入力する（${e instanceof Error ? e.message : String(e)}）`);
      }
      const provisional = effect === 'derive';
      const received = provisional ? (derived as number) : counted;
      const current = result.state.supply.receipts[lotId];
      if (current?.received === received && current.provisional === provisional && !isStaleRevision(result.state.ledger, result.state.supply, lotId)) return result;
      const reason = v.checked('causeUnknown') ? '原因不明' : v.text('causeText');
      const supply = reviseReceipt(result.state.ledger, result.state.supply, { ...m, eventId: suffixed(m.eventId, 'rc') }, lotId, received, reason, provisional);
      return { ...result, state: { ...result.state, supply } };
    },
  };
}

// 判定日。納期の三状態の判定に使う。既定は当日（日本時間）で、利用者が選び直せる。
const todayJst = (): string => tokyoText(new Date()).slice(0, 10);
let asOf = todayJst();
export const supplyAsOf = (): string => asOf;

// 色に頼らず文字で読めるよう、注意が要る行には文頭の語を付け、同じ語で絞れる（UI-08a）。
const attention = /^(不足 判定不能|過剰割り当て|不要の可能性|不足 .*（(数量確認|中身未確認))/;

function groupText(m: Masters, key: GroupKey): string {
  return `${projectText(m, key.project)}・品目${itemRef(m, key.item)}（${key.unit}）`;
}

// 不足・依頼の欄。案件・用途・品目・単位ごとに、必要な数・手元・不足・手配対象数・依頼の未着・納期・中断を別々の文で示す。
export function renderSupply(ctx: Ctx): void {
  const root = section('supply');
  const ledger = ctx.ledger();
  const supply = ctx.supply();
  const targets = createHistoryTargetCollector({ ledger, supply });

  const asOfInput = h('input', { type: 'date', name: 'asOf', value: asOf });
  asOfInput.addEventListener('change', () => {
    asOf = asOfInput.value === '' ? todayJst() : asOfInput.value;
    renderSupply(ctx);
    ctx.asOfChanged?.();
  });
  root.append(h('label', {}, '判定日（日本時間。納期の判定に使う）', asOfInput));

  const groups = groupsOf(ledger, supply);
  if (groups.length === 0) root.append(h('p', {}, '必要な数・足りない分の記録・注文・購入予定の記録はまだない（入力の操作から記録する）'));
  for (const key of groups) {
    const view = shortageOf(ledger, supply, key);
    const summary = requestSummaryOf(ledger, supply, key);
    const stops = stopsOf(ledger, key);
    const need = key.project.kind === 'case' ? Object.values(supply.needs).find((n) => n.project.id === (key.project as { id: string }).id && n.item === key.item && n.unit === key.unit) : undefined;
    const lines: string[] = [
      need ? `必要明細 ${need.id}：必要な数 ${needQuantityText(need.required, need.unit)}、${need.dueDate ? `必要日 ${need.dueDate}` : '必要日なし'}、元の資料「${need.source}」・${need.revision}` : '必要明細は未登録（必要な数が分からないので、不足は判定不能）',
      ...shortageLinesText(view, key.unit),
      ...requestStateText(summary, key.unit),
      ...stateTriadText(view, summary, stops),
    ];
    for (const d of Object.values(supply.declarations).filter((x) => sameProject(x.project, key.project) && x.item === key.item && x.unit === key.unit)) {
      lines.push(`足りない分の記録 ${d.id}：${d.value === null ? '数が不明' : `${d.value}${d.unit}`}（${d.reason}）、${d.linked ? '自動の不足候補に対応付け済み' : '対応付けなし（別の不足として数える）'}`);
    }
    for (const r of Object.values(supply.requests).filter((x) => sameProject(x.project, key.project) && x.item === key.item && x.unit === key.unit)) {
      const { arrived, outstanding } = requestProgressOf(ledger.masters, r);
      lines.push(
        r.cancelled
          ? `依頼 ${r.id}：取消済み（理由「${r.cancelled.reason}」）。${r.quantity}${r.unit}・${r.vendor}`
          : `依頼 ${r.id}：${r.quantity}${r.unit}・${r.vendor}・依頼日${r.requestedOn}・${replyText(r.reply)}・${r.orderConfirmedBy ? '注文の確定済み' : '注文の確定なし'}・到着${arrived}${r.unit}・未着${outstanding}${r.unit}・納期：${requestDateText(r, summary, dateStatusOf(supply, ledger.masters, r.id, asOf))}`,
      );
    }
    for (const s of stops) lines.push(stopLineText(ledger.masters, s));
    root.append(
      h(
        'article',
        { class: 'group', 'data-group': `${key.project.kind === 'case' ? key.project.id : key.project.kind}/${key.item}/${key.unit}` },
        h('h3', {}, groupText(ledger.masters, key)),
        h('ul', { 'aria-label': `${groupText(ledger.masters, key)}の状況` }, ...lines.map((text) => h('li', attention.test(text) ? { class: 'warn' } : {}, text))),
      ),
    );
  }

  const stale = staleAcksOf(ledger, supply);
  if (stale.length > 0) {
    root.append(
      h('h3', {}, '食い違いのある受領確認'),
      h(
        'ul',
        { 'aria-label': '食い違いのある受領確認' },
        ...stale.map((s) => h('li', { class: 'warn', 'data-ack': s.ackEventId }, `食い違い：受領確認${s.ackEventId}（引渡し${s.handoverEventId}）：${s.reason}。引渡しの日時を元に戻して確かめる`)),
      ),
    );
  }

  const receipts = Object.entries(supply.receipts);
  if (receipts.length > 0) {
    root.append(
      h('h3', {}, '受け入れた現物（実際に受け取った数の記録）'),
      h(
        'ul',
        { 'aria-label': '実際に受け取った数の記録' },
        ...receipts.map(([lotId, r]) => {
          const lot = ledger.lots[lotId];
          return h('li', { 'data-receipt': lotId }, `保管単位${lotId}：実際に受け取った数${receivedText(r.received, receiptStatusOf(ledger, supply, lotId), r.label)}・割り当て済み${allocatedToReceipt(supply, ledger.masters, lotId)}（台帳の現在数 ${lot ? quantityText(lot.quantity, lot.unit) : '不明'}、${receiptStateText(ledger, lotId)}）`);
        }),
      ),
    );
  }

  if (supply.log.length > 0) {
    const list = h('ol', { 'aria-label': '供給の記録の履歴' });
    for (const e of supply.log) {
      // 実際の日時と入力した日時は別。実際の日時が不明なら、入力した日時で埋めず「日時不明」と示す（NFR-08a）。
      list.append(h('li', { 'data-event': e.eventId }, `発生 ${supplyOccurredText(ledger, e)}・記録 ${jst(e.recordedAt)}・${e.actor}・操作${e.eventId}：${supplyEventText(ledger.masters, e, targets.supplyEventItemIds(e))}`));
    }
    root.append(h('h3', {}, '供給の記録の履歴'), list);
  }
}

// ネジなどの欄。未開封の箱と開封済みを分け、本数への換算（ラベル根拠）、残量区分、補充確認、既存の依頼を並べる。
export function renderConsumables(ctx: Ctx): void {
  const root = section('consumables');
  const ledger = ctx.ledger();
  const supply = ctx.supply();
  const configured = consumablesOf(ledger.masters);
  if (configured.length === 0) {
    const open = h('button', { type: 'button' }, '共通消耗品を設定する');
    open.addEventListener('click', () => ctx.openConsumableSettings?.());
    root.append(h('p', {}, '共通消耗品は未設定です。'), open);
  }
  for (const cfg of configured) {
    // 共通在庫だけ。案件・用途に属する同じ品目のまとまり・依頼を、共通の合計や補充確認に混ぜない（MOD-02）。
    const common = (l: Lot) => l.project.kind === 'common';
    const stock = stockOf(ledger, supply, cfg.item, cfg.pieceUnit, common);
    const lots = Object.values(ledger.lots).filter((l) => l.item === cfg.item && l.mergedInto === null && common(l));
    const requests = Object.values(supply.requests).filter((r) => r.item === cfg.item && r.project.kind === 'common');
    const lines = consumableLinesText(ledger, cfg, lots, stock, cfg.rule ? replenishmentOf(stock, cfg.rule) : { kind: 'none' }, requests);
    const name = itemNameText(ledger.masters, cfg.item);
    const ref = itemRef(ledger.masters, cfg.item);
    root.append(
      h(
        'article',
        { class: 'group', 'data-stock': cfg.item },
        h('h3', {}, `品目${ref}（${name}）`),
        h('ul', { 'aria-label': `品目${ref}の包装・バラ数量・補充確認` }, ...lines.map((text) => h('li', text.startsWith('補充確認：') ? { class: 'warn' } : {}, text))),
      ),
    );
  }
}
