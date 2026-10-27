import { scanText } from './code-format.ts';
import {
  reworksOf,
  holdReasons,
  isUsable,
  nextStage,
  occurredAtOf,
  openIssuesOf,
  totalOf,
  voidOf,
  type HoldReason,
  type Inclusion,
  type IssueReason,
  type Ledger,
  type LedgerEvent,
  type Lot,
  type MasterChange,
  type MasterRequest,
  type Project,
  type Stage,
  type Stop,
} from '../domain/ledger.ts';
import { masterTypeDisplayLabel, own, refOf, unassignedCode, type ConsumableSetting, type Packaging, type Master, type Masters } from '../domain/masters.ts';
import type { Basis, Quantity, Term } from '../domain/quantity.ts';
import { createHistoryTargetCollector } from '../domain/history-targets.ts';
import { historyItems, type HistoryTargetCollector, type ItemFormatter } from './history-item-format.ts';

export const itemRef = (masters: Masters, id: string): string => refOf(masters.items, id);
export const locationRef = (masters: Masters, id: string): string => refOf(masters.locations, id);
export const caseRef = (masters: Masters, id: string): string => refOf(masters.cases, id);

// 保存済み対象キーの接頭辞だけを表示語へ直す。ID・入力原文・保存値は変えない。
export function targetLabel(target: string): string {
  const prefixes: readonly (readonly [string, string])[] = [
    ['まとまり', '保管単位'], ['元票「', '元の資料「'], ['照合事項', '確認事項'],
    ['停止', '作業の中断'], ['受入テンプレート', 'セット'], ['一括受入', 'まとめて受け取り'],
    ['レシピ推計', 'セットの推計'], ['案件', '案件・用途'],
  ];
  for (const [stored, shown] of prefixes) {
    if (target.startsWith(stored)) return `${shown}${target.slice(stored.length)}`;
  }
  return target;
}

// 品目の現在の名称。仮と利用停止も文字で示す（要件3.2・4.7）。
export function itemNameText(masters: Masters, id: string): string {
  const m = own(masters.items, id);
  if (!m) return id;
  return `${m.name}${m.code === null ? `（${unassignedCode}）` : ''}${m.active ? '' : '（利用停止）'}`;
}

export function trialText(masters: Masters, lot: Pick<Lot, 'item' | 'location'>): string {
  return own(masters.items, lot.item)?.trial && own(masters.locations, lot.location)?.trial ? '試行対象' : '対象外';
}

// 今は記録の対象外の場所への過去の配置は、その時点では記録の対象だったことを示す（要件7.6）。
function scopeNote(masters: Masters, location: string): string {
  const last = own(masters.locations, location)?.scope.at(-1);
  if (!last || last.from === null || last.inScope) return '';
  return `（記録の時点では記録の対象。場所${locationRef(masters, location)}は${jst(last.from)}から記録の対象外）`;
}

// 表示語はDESIGN_NOTES.mdの「数量の表示語」に合わせる。色がなくても文字だけで区別できるようにする（UI-08a）。

export const basisLabel: Record<Basis, string> = {
  counted: '数えた',
  label: '表示の数（ラベル・パッケージ）',
  approximate: 'だいたい',
  unknown: '数が不明',
};

export const holdLabel: Record<HoldReason, string> = {
  defective: '不良',
  usabilityCheck: '使用可否確認待ち',
  returnPending: '返却待ち',
  spare: '予備（交換用）',
};

export const issueLabel: Record<IssueReason, string> = {
  negative: '負数になるため未反映',
  lateEntry: '後入力の包含が未確認',
  declared: '数の食い違いのメモ',
  unassigned: '適用対象不明（仮の記録）',
  timeCorrected: '日時訂正で前後が変わった',
};

// 「確認待ち」は工程上の位置で、取り分けた理由の「使用可否確認待ち」とは別の情報（DESIGN_NOTES）。
export const stageLabel: Record<Stage['kind'], string> = {
  none: '作業なし',
  working: '作業中',
  inspecting: '確認待ち',
  awaitingHandover: '完成（渡す前）',
};

export function stageText(s: Stage): string {
  return s.kind === 'none' ? stageLabel.none : `工程${s.process.id}・${stageLabel[s.kind]}`;
}

// 位置の変更に業務上の名前を付ける。完了基準どおりの次の位置への変更だけが業務上の手順で、
// 検査を飛ばした変更、戻し、訂正の入力で記録した変更は、手順があったことにせず訂正として示す。
export function stageChangeLabel(from: Stage, to: Stage, correction = false): string {
  const next = nextStage(from);
  const normal = !correction && next !== null && next.kind === to.kind && (next.kind === 'none' || (to.kind !== 'none' && next.process.id === to.process.id));
  if (!normal) return '作業の状態の訂正';
  return from.kind === 'working' ? '作業終了' : from.kind === 'inspecting' ? '確認の完了' : '次の作業へ渡す';
}

export const inclusionLabel: Record<Inclusion, string> = {
  included: '確認に含まれていた',
  notIncluded: '確認に含まれていなかった',
  unknown: '含まれていたか不明',
};

export function projectText(masters: Masters, p: Project): string {
  return p.kind === 'case' ? `案件・用途${caseRef(masters, p.id)}` : p.kind === 'common' ? '共通在庫' : '案件・用途が不明';
}

// 入力の日時は時刻帯付きで保存し、表示は日本時間にそろえる（NFR-08a）。値なしは入力した日時で埋めない。
export function jst(iso: string | null): string {
  return iso === null ? '日時不明' : `${tokyoText(new Date(iso)).slice(0, 16)}（日本時間）`;
}

// 'YYYY-MM-DD HH:MM:SS' の日本時間。
export function tokyoText(date: Date): string {
  return date.toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

export function quantityText(q: Quantity, unit: string): string {
  switch (q.kind) {
    case 'known': {
      const n = `${q.numeric.approximate ? '約' : ''}${q.numeric.value}${unit}`;
      // 計算値は「記録上の数」と付け、数えた結果と読み違えないようにする（AT-02）。計算値でなければ観測は一つだけ。
      const head = q.computed ? [`記録上の数${n}`] : [n, basisLabel[q.terms[0]?.observation.basis ?? 'counted']];
      return [...head, ...unconfirmedTags(q.numeric.unconfirmed)].join('・');
    }
    case 'partlyUnknown': {
      const unknowns = `ほかに数が不明${q.unknownParts.length}件。全体数量は不明`;
      if (q.numeric === null) return `数値部分なし、${unknowns}`;
      const n = `数値部分の小計${q.numeric.approximate ? '約' : ''}${q.numeric.value}${unit}`;
      return [n, ...unconfirmedTags(q.numeric.unconfirmed)].join('・') + `、${unknowns}`;
    }
    case 'unknown':
      return q.before === null ? '数が不明' : `数が不明（残数不明。直前は${quantityText(q.before, unit)}）`;
  }
}

function unconfirmedTags(u: 'none' | 'partial' | 'all'): string[] {
  return u === 'all' ? ['中身未確認'] : u === 'partial' ? ['中身未確認部分あり'] : [];
}

// 差異は数量ではないので「台帳」を付けず符号を付ける。訂正前が不明なら差異も不明（REC-01b）。
export function differenceText(q: Quantity, unit: string): string {
  if (q.kind !== 'known') return '不明';
  const v = q.numeric.value;
  return `${v > 0 ? '＋' : v < 0 ? '－' : '±'}${q.numeric.approximate ? '約' : ''}${Math.abs(v)}${unit}`;
}

export function termText(t: Term, unit: string): string {
  const o = t.observation;
  const value = o.value === null ? '数が不明' : `${o.value}${unit}`;
  return `${t.sign === 1 ? '＋' : '－'}${value}（${basisLabel[o.basis]}、操作${o.id}）`;
}

export function lastCountText(ledger: Ledger, lot: Lot): string {
  if (lot.lastCount === null) return '数えた記録なし';
  return `${lot.lastCount.value}${lot.unit}（${jst(occurredAtOf(ledger, lot.lastCount.eventId))}、操作${lot.lastCount.eventId}）`;
}

// 数量を変えない操作（差異申告、照合の解消、日時訂正）も、そのまとまりの表示を変えるので関係する操作に含める。
// 日時訂正は、まとめ直し元での操作を訂正しても確認事項がまとめ直し先に付くので、まとめ直し元もたどって判定する。
export function eventsOf(ledger: Ledger, lotId: string): LedgerEvent[] {
  const touches = (e: LedgerEvent, ids: ReadonlySet<string>): boolean =>
    e.changes.some((c) => ids.has(c.after.id)) ||
    ('lotId' in e && ids.has(e.lotId)) ||
    (e.kind === 'reworkPart' && e.subjectLotId !== undefined && ids.has(e.subjectLotId)) ||
    (e.kind === 'resolve' && ids.has(ledger.issues[e.issueId]?.lotId ?? ''));
  const self = new Set([lotId]);
  const withSources = new Set([lotId, ...mergedSourcesOf(ledger, lotId)]);
  return ledger.history.filter(
    (e) =>
      touches(e, self) ||
      (e.kind === 'correctTime' && ledger.history.some((t) => t.eventId === e.targetEventId && touches(t, withSources))),
  );
}

function mergedSourcesOf(ledger: Ledger, lotId: string): string[] {
  return Object.values(ledger.lots)
    .filter((l) => l.mergedInto === lotId)
    .flatMap((l) => [l.id, ...mergedSourcesOf(ledger, l.id)]);
}

export function lastUpdatedOf(ledger: Ledger, lotId: string): string | null {
  return eventsOf(ledger, lotId).at(-1)?.recordedAt ?? null;
}

export const kindLabel: Record<LedgerEvent['kind'], string> = {
  rework: 'やり直し・修理開始（同じ現物）',
  reworkPart: 'やり直し・修理の部品処置',
  register: '登録',
  alternativeRecord: '別記録・元の資料からの後入力',
  master: '登録情報の変更',
  identify: '仮の記録の対応付け',
  adopt: '仮の記録からの登録',
  assignProject: '案件・用途の結び付け',
  use: '使用',
  handover: '外へ出す（譲渡・持ち出し）',
  split: '分割',
  transfer: '案件・用途の付け替え',
  move: '移動',
  merge: '統合',
  recount: '数えて確認',
  hold: '取り分ける',
  release: '取り分けを戻す',
  resolve: '確認事項を片付ける',
  correctTime: '実際の日時の訂正',
  declare: '数の食い違いのメモ',
  provisional: '仮の記録',
  start: '作業の開始',
  stage: '作業の状態の変更',
  void: '間違えた記録の取り消し',
  stop: '作業の中断',
  stopUpdate: '中断した数の更新',
  resume: '作業の再開',
};

// 工程完了累計・引渡済み累計は現在の手元数ではないので、「台帳」や根拠名を付けない。
// 数だけにせず中身未確認の印は残す。表示の数（ラベル・パッケージ）の完了を数えたと同じに見せない（QTY-04b）。
export function cumulativeText(q: Quantity, unit: string): string {
  if (q.kind !== 'known') return quantityText(q, unit);
  return [`${q.numeric.approximate ? '約' : ''}${q.numeric.value}${unit}`, ...unconfirmedTags(q.numeric.unconfirmed)].join('・');
}

export function affectedText(affected: number | null, unit: string): string {
  return affected === null ? '影響数不明' : `影響${affected}${unit}`;
}

// 影響台数は中断の単位、不足数は不足品目の記録した単位で読む（MFG-08b）。
export function stopText(masters: Masters, s: Stop, ref: ItemFormatter = id => itemRef(masters, id)): string {
  const shortage = s.shortage ? `、不足 品目${ref(s.shortage.item)} ${s.shortage.value === null ? `数が不明（${s.shortage.unit}）` : `${s.shortage.value}${s.shortage.unit}`}` : '';
  return `工程${s.process}・品目${ref(s.item)}（${s.unit}）・${projectText(masters, s.project)}、理由「${s.reason}」${shortage}、${affectedText(s.affected, s.unit)}`;
}

// 分割元とまとめ直しの元をたどり、作業の開始で作ったまとまりの材料の使用記録を返す（MFG-03a・06）。作業の開始に由来しなければnull。
export function materialsOf(ledger: Ledger, lot: Lot): LedgerEvent[] | null {
  const seen = new Set<string>();
  const found: LedgerEvent[] = [];
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const started = ledger.history.find((e) => e.kind === 'start' && e.lotId === id);
    if (started?.kind === 'start') found.push(...started.materials.flatMap((m) => ledger.history.filter((e) => e.eventId === m)));
    const parent = ledger.lots[id]?.splitFrom;
    if (parent) visit(parent);
    for (const merged of Object.values(ledger.lots)) if (merged.mergedInto === id) visit(merged.id);
  };
  visit(lot.id);
  return found.length > 0 || [...seen].some((id) => ledger.history.some((e) => e.kind === 'start' && e.lotId === id)) ? [...new Set(found)] : null;
}

function valueText(basis: Basis, value: number | null, unit: string): string {
  return value === null ? '数が不明' : `${value}${unit}（${basisLabel[basis]}）`;
}

export function eventText(ledger: Ledger, e: LedgerEvent, targets?: HistoryTargetCollector): string {
  const ids = e.itemLabels.kind === 'recorded' ? Object.keys(e.itemLabels.items)
    : (targets ?? createHistoryTargetCollector({ ledger, supply: null })).ledgerEventItemIds(e);
  const items = historyItems(e.itemLabels, ids);
  return items.complete(eventDetails(ledger, e, items.ref, targets)) + scanText(e.scan);
}

export function reworkHistoryOf(ledger: Ledger, lot: Lot): LedgerEvent[] {
  const reworks = reworksOf(ledger, lot.id);
  const ids = new Set(reworks.map(e => e.eventId));
  return ledger.history.filter(e => ids.has(e.eventId) || (e.kind === 'reworkPart' && ids.has(e.reworkId)));
}

export function reworkTextOf(ledger: Ledger, lot: Lot, targets?: HistoryTargetCollector): string {
  const events = reworkHistoryOf(ledger, lot);
  const shared = targets ?? createHistoryTargetCollector({ ledger, supply: null });
  return events.length ? `やり直し・修理（元の作業の開始材料と別）：${events.map(e => `${e.eventId} ${eventText(ledger, e, shared)}`).join('／')}` : 'なし';
}

function eventDetails(ledger: Ledger, e: LedgerEvent, ref: ItemFormatter, targets?: HistoryTargetCollector): string {
  const lotUnit = (lotId: string): string => ledger.lots[lotId]?.unit ?? '';
  const label = kindLabel[e.kind];
  const m = ledger.masters;
  switch (e.kind) {
    case 'rework':
      return `${label}：${e.lotId}から${e.childId}へ${valueText(e.basis, e.value, lotUnit(e.lotId))}、理由「${e.reason}」${e.returnSource === undefined ? '' : `／返ってきた物の新規割当の記録${e.returnSource.adoptEventId}／工程${e.returnSource.process.id}・${e.returnSource.process.criterion === 'workEnd' ? '作業終了' : '確認の完了'}基準／物理的なやり直し・修理を確認`}`;
    case 'reworkPart': {
      const detail = e.action === 'discard' ? `廃棄 品目${ref(e.item)} ${e.value}${e.unit}（組付け済み部品。未使用在庫の増減なし）` : (() => {
        const id = e.action === 'replace' ? e.useEventId : e.registerEventId;
        const referenced = ledger.history.find(r => r.eventId === id);
        return `${e.action === 'replace' ? '交換使用' : '回収'} 操作${id}：${referenced ? eventText(ledger, referenced, targets) : '参照先なし'}`;
      })();
      return `${label}：やり直し・修理${e.reworkId}、${e.subjectLotId === undefined ? '対象枝の記録なし（旧記録）' : `対象枝${e.subjectLotId}`}、${detail}、理由「${e.reason}」`;
    }
    case 'transfer':
      return `${label}：${e.lotId}から${e.childId}へ${valueText(e.basis, e.value, lotUnit(e.lotId))}、${projectText(m, e.from)} → ${projectText(m, e.to)}${e.inclusion === null ? '' : `・${inclusionLabel[e.inclusion]}`}（場所は変えていない）`;
    case 'register': {
      const lot = e.changes[0]?.after;
      return lot ? `${label}：${lot.id}（品目${ref(lot.item)}、${projectText(m, lot.project)}、${locationRef(m, lot.location)}）${quantityText(lot.quantity, lot.unit)}${scopeNote(m, lot.location)}` : label;
    }
    case 'use':
    case 'handover':
    case 'split':
    case 'stage': {
      const parent = ledger.lots[e.lotId];
      const head = e.kind === 'stage' && parent ? stageChangeLabel(parent.stage, e.to, e.correction) : label;
      const target =
        e.kind === 'use'
          ? `使用先 ${e.usedFor}`
          : e.kind === 'handover'
            ? `相手先または処置 ${e.counterpart}`
            : e.kind === 'split'
              ? `取り出し先 ${e.childId}`
              : `${e.childId}へ（${parent ? stageText(parent.stage) : ''} → ${stageText(e.to)}）`;
      const applied = e.applied ? '' : '・親から減らしていない（未適用）';
      const inclusion = e.inclusion === null ? '' : `・${inclusionLabel[e.inclusion]}`;
      const voidEvent = voidOf(ledger, e.eventId);
      const voided = voidEvent ? `・記録誤りとして取消済み（操作${voidEvent.eventId}）` : '';
      return `${head}：${e.lotId}から${valueText(e.basis, e.value, lotUnit(e.lotId))}、${target}${applied}${inclusion}${voided}`;
    }
    case 'start': {
      const lot = e.changes[0]?.after;
      const materials = e.materials.length ? `材料の使用記録 ${e.materials.join('・')}` : '材料の使用記録の対応付けなし';
      return lot ? `${label}：${lot.id}（品目${ref(lot.item)}、${projectText(m, lot.project)}、${locationRef(m, lot.location)}、${stageText(lot.stage)}）${quantityText(lot.quantity, lot.unit)}、${materials}${scopeNote(m, lot.location)}` : label;
    }
    case 'void': {
      const result = e.applied ? '数量を戻した' : '今の数量に反映されていないため数量は変えていない';
      return `${label}：操作${e.targetEventId}（${e.lotId}）を起きなかったものとして取消、理由「${e.reason}」、${result}`;
    }
    case 'stop':
      return `${label}：${e.stop.id} ${stopText(m, e.stop, ref)}`;
    case 'stopUpdate':
      return `${label}：中断${e.stopId}を${affectedText(e.previous, ledger.stops[e.stopId]?.unit ?? '')} → ${affectedText(e.affected, ledger.stops[e.stopId]?.unit ?? '')}`;
    case 'resume':
      return `${label}：中断${e.stopId}`;
    case 'move':
    case 'merge':
      return `${label}：${e.changes.map((c) => `${c.after.id}（${c.before ? locationRef(m, c.before.location) : ''}→${locationRef(m, c.after.location)}${c.after.mergedInto ? `、${c.after.mergedInto}へ` : ''}）${e.kind === 'move' ? scopeNote(m, c.after.location) : ''}`).join('、')}`;
    case 'recount': {
      const unit = lotUnit(e.lotId);
      const cause = e.cause.kind === 'unknown' ? '原因不明' : `原因：${e.cause.text}`;
      const applied = e.applied ? '' : '・数量に反映していない（確認事項あり）';
      const inclusion = e.inclusion === null ? '' : `・反映済みの操作は${inclusionLabel[e.inclusion]}`;
      const counted = `${e.value}${unit}を数えた（それまでの${quantityText(e.compared, unit)}との差異${differenceText(e.difference, unit)}）`;
      return `${label}：${e.lotId} ${counted}、${cause}${applied}${inclusion}`;
    }
    case 'hold':
    case 'release':
      return `${label}：${e.changes[0]?.after.id ?? ''}（${holdLabel[e.reason]}）${e.note === null ? '' : `、メモ「${e.note}」`}`;
    case 'resolve':
      return `${label}：確認事項${e.issueId}を${e.outcome === 'apply' ? '適用' : '閉じる'}${e.inclusion === null ? '' : `・${inclusionLabel[e.inclusion]}`}`;
    case 'correctTime':
      return `${label}：操作${e.targetEventId}を ${jst(e.previous)} → ${jst(e.corrected)}`;
    case 'declare':
      return `${label}：${e.lotId}「${e.note}」`;
    case 'alternativeRecord':
      return `${label}：元の資料「${e.source.source}」・動き「${e.source.entry}」、原票記入者「${e.source.originalActor}」、対応する操作${e.operationId}（記録済み。全処理の完了ではない）`;
    case 'provisional':
      return `${label}（台帳に足していない）：${e.direction === 'found' ? '見つかった' : 'なくなった'}、品目${e.item === null ? '不明' : ref(e.item)}、場所${e.location === null ? '不明' : locationRef(m, e.location)}、${valueText(e.basis, e.value, '')}「${e.note}」`;
    case 'master':
      return `${label}：${e.masters.map((c) => masterChangeText(e.action, c)).join('、')}${e.reason === null ? '' : `、理由「${e.reason}」`}${e.confirmed ? '、確認して記録' : ''}${e.action === 'trial' && e.review !== null ? `、追加前に人が確認した内容（実物一致・復元成功の自動保証ではない）：既存数量「${e.review.quantities}」／未完了依頼「${e.review.requests}」／訂正手順「${e.review.corrections}」／復元手順「${e.review.restore}」／開始数量「${e.review.initial}」` : ''}`;
    case 'identify':
      return `${label}：仮の記録${e.issueId}の物を${e.lotId}と同じ現物とした（数量は足していない）、理由「${e.reason}」`;
    case 'adopt': {
      const lot = e.changes[0]?.after;
      return lot ? `${label}：仮の記録${e.issueId}の物を別の現物と確認して${lot.id}（品目${ref(lot.item)}、${projectText(m, lot.project)}、${locationRef(m, lot.location)}）${quantityText(lot.quantity, lot.unit)}として登録${scopeNote(m, lot.location)}` : label;
    }
    case 'assignProject':
      return `${label}：${e.lotId}を${projectText(m, e.before)}から${projectText(m, e.after)}へ、理由「${e.reason}」`;
  }
}

function masterRefText(m: Master): string {
  if (m.type === 'actor') return `担当者「${m.id}」`;
  const name = m.name === null ? '' : `「${m.name}」`;
  return `${masterTypeDisplayLabel[m.type]}${m.code ?? unassignedCode}${name}`;
}

export function consumableSettingText(setting: ConsumableSetting | null): string {
  if (setting === null) return '対象外';
  const rule = setting.rule;
  return rule === null ? `対象（集計単位${setting.pieceUnit}、補充基準なし）`
    : `対象（補充基準${rule.threshold}${setting.pieceUnit}、標準依頼数量${rule.standardOrder.value}${rule.standardOrder.unit}）`;
}

export function packagingSettingText(packaging: Packaging | null): string {
  if (packaging === null) return '未設定';
  return `1${packaging.boxUnit}あたりの数：${packaging.perBox.map(entry => `${entry.from === null ? '最初から' : `${jst(entry.from)}から`}${entry.value === null ? '不明' : `${entry.value}${packaging.pieceUnit}`}`).join('、')}`;
}

// 登録情報の変更の前後を一つの文にする（要件10.2）。仮の既存IDは「既存IDなし（仮）」と書く（要件4.7）。
function masterChangeText(action: MasterRequest['action'], { before, after }: MasterChange): string {
  const ref = masterRefText(after);
  switch (action) {
    case 'trial': {
      const trial = (m: Master | null) => m !== null && (m.type === 'item' || m.type === 'location') && m.trial ? '試行対象' : '対象外';
      return `${ref}の試行対象 ${trial(before)} → ${trial(after)}`;
    }
    case 'register':
      return `${ref}を登録${after.type === 'location' ? `（記録の対象${after.scope[0]?.inScope ? '' : '外'}）` : ''}`;
    case 'rename':
      return `${masterTypeDisplayLabel[after.type]}${after.type === 'actor' ? after.id : after.code ?? unassignedCode}の名称「${before && before.type !== 'actor' ? before.name ?? 'なし' : ''}」→「${after.type !== 'actor' ? after.name ?? 'なし' : ''}」`;
    case 'deactivate':
      return `${ref}を利用停止`;
    case 'reactivate':
      return `${ref}の利用を再開`;
    case 'code': {
      const code = (m: Master | null) => (m === null || m.type === 'actor' ? '' : m.code ?? unassignedCode);
      return `${masterTypeDisplayLabel[after.type]}「${after.type === 'actor' ? after.id : after.name ?? code(after)}」の品番・コード ${code(before)} → ${code(after)}`;
    }
    case 'source': {
      const source = (m: Master | null) => (m === null || (m.type !== 'item' && m.type !== 'case') || m.source === null ? 'なし' : `「${m.source.name}」（版${m.source.revision}）`);
      return `${ref}の元の資料 ${source(before)} → ${source(after)}`;
    }
    case 'consumable': {
      const setting = (master: Master | null) => master?.type === 'item' ? consumableSettingText(master.consumable) : '対象外';
      return `${ref}の共通消耗品設定 ${setting(before)} → ${setting(after)}`;
    }
    case 'packaging':
    case 'perBox': {
      const latest = after.type === 'item' ? after.packaging?.perBox.at(-1) : undefined;
      const unit = after.type === 'item' ? after.packaging?.pieceUnit ?? '' : '';
      const box = after.type === 'item' ? after.packaging?.boxUnit ?? '' : '';
      return `${ref}の1${box}あたりの数を${jst(latest?.from ?? null)}から${latest?.value ?? ''}${unit}にする${action === 'packaging' ? '（それ以前の入り数は不明）' : ''}`;
    }
    case 'scope': {
      const latest = after.type === 'location' ? after.scope.at(-1) : undefined;
      return `${ref}を${jst(latest?.from ?? null)}から記録の対象${latest?.inScope ? '' : '外'}にする`;
    }
  }
}

export type Totals = {
  item: string;
  unit: string;
  onHand: Quantity;
  usable: Quantity;
  excluded: Quantity;
  breakdown: { reason: HoldReason; quantity: Quantity }[];
  staged: Quantity | null;
  issueCount: number;
};

// 絞り込んだ範囲の集計。単位の違う数量は合計しない（AT-10）ので、品目と単位の組ごとに行を分ける。
export function totalsOf(ledger: Ledger, lots: readonly Lot[]): Totals[] {
  const groups = new Map<string, { item: string; unit: string }>();
  for (const l of lots) groups.set(`${l.item}\0${l.unit}`, { item: l.item, unit: l.unit });
  const ids = new Set(lots.map((l) => l.id));
  return [...groups.values()].map(({ item, unit }) => {
    const inGroup = (l: Lot) => ids.has(l.id) && l.unit === unit;
    const issueCount = lots.filter((l) => l.item === item && l.unit === unit).flatMap((l) => openIssuesOf(ledger, l.id)).length;
    // 工程に載っている物は取り分けた理由があっても除外には数えず、工程に載っている物として一度だけ示す（MFG-03c）。
    const excludable = (l: Lot) => inGroup(l) && l.stage.kind === 'none';
    // 理由が重なるまとまりは内訳の各理由に現れるが、取り分けの合計では一度だけ数える（OPS-06b）。
    const breakdown = holdReasons
      .filter((r) => lots.some((l) => l.item === item && excludable(l) && l.holds.includes(r)))
      .map((reason) => ({ reason, quantity: totalOf(ledger, item, (l) => excludable(l) && l.holds.includes(reason)) }));
    // 工程に載っている物は手元にあるが、未使用の部品として使用可能にも除外にも数えない（MFG-03c）。
    const staged = lots.some((l) => l.item === item && inGroup(l) && l.stage.kind !== 'none')
      ? totalOf(ledger, item, (l) => inGroup(l) && l.stage.kind !== 'none')
      : null;
    return {
      item,
      unit,
      onHand: totalOf(ledger, item, inGroup),
      usable: totalOf(ledger, item, (l) => inGroup(l) && isUsable(l)),
      excluded: totalOf(ledger, item, (l) => excludable(l) && l.holds.length > 0),
      breakdown,
      staged,
      issueCount,
    };
  });
}

export function totalsText(masters: Masters, t: Totals): string {
  const held = t.breakdown.map((b) => `${holdLabel[b.reason]} ${quantityText(b.quantity, t.unit)}`);
  const breakdown = held.length ? `（内訳 ${held.join('、')}）` : '';
  const staged = t.staged === null ? '' : `／製造中・完成（渡す前） ${quantityText(t.staged, t.unit)}（内訳は製造の欄）`;
  const text = `品目${itemRef(masters, t.item)}（${t.unit}）：在庫 ${quantityText(t.onHand, t.unit)}／使用可能 ${quantityText(t.usable, t.unit)}／取り分け ${quantityText(t.excluded, t.unit)}${breakdown}${staged}`;
  // 確認事項があれば、直前の適用済みの数を示しても通常の使用可能数として断定しない（DESIGN_NOTES・QTY-12b）。
  return t.issueCount ? `${text}。確認が必要 ${t.issueCount}件：使用可能数として断定しない` : text;
}
