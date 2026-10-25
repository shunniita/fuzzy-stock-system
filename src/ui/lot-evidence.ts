import { occurredAtOf, type Ledger, type LedgerEvent } from '../domain/ledger.ts';
import { receiptStatusOf, requestProgressOf, type Arrival, type ReceiptStatus, type Request, type Supply, type SupplyEvent } from '../domain/supply.ts';
import { h } from './dom.ts';
import { eventsOf, eventText, itemRef, jst, projectText } from './format.ts';
import { replyText, supplyEventText, supplyOccurredText } from './supply-format.ts';
import { createHistoryTargetCollector } from '../domain/history-targets.ts';
import type { HistoryTargetCollector } from './history-item-format.ts';

export type SourceEvidence = {
  record: Extract<LedgerEvent, { kind: 'alternativeRecord' }>;
  operation: LedgerEvent;
  materialUses: readonly Extract<LedgerEvent, { kind: 'use' }>[];
};

export type RequestEvidence = {
  request: Request;
  arrivals: readonly Arrival[];
  history: readonly SupplyEvent[];
};

export type LotEvidence = {
  sources: readonly SourceEvidence[];
  scans: readonly LedgerEvent[];
  receipt: (Supply['receipts'][string] & { status: ReceiptStatus }) | null;
  receiptHistory: readonly SupplyEvent[];
  requests: readonly RequestEvidence[];
};

function sourcesOf(ledger: Ledger, lotId: string): SourceEvidence[] {
  const events = new Map(ledger.history.map(e => [e.eventId, e]));
  const sources: SourceEvidence[] = [];
  for (const record of ledger.history) {
    if (record.kind !== 'alternativeRecord') continue;
    const operation = events.get(record.operationId);
    if (!operation) continue;
    const materialUses: SourceEvidence['materialUses'][number][] = [];
    if (operation.kind === 'start') {
      for (const id of operation.materials) {
        const event = events.get(id);
        if (event?.kind === 'use' && event.lotId === lotId) materialUses.push(event);
      }
    }
    const direct = operation.kind === 'use' || operation.kind === 'start'
      ? operation.lotId === lotId
      : operation.changes.some(change => change.after.id === lotId);
    if (direct || materialUses.length > 0) sources.push({ record, operation, materialUses });
  }
  return sources;
}

function requestsOf(supply: Supply, lotId: string): RequestEvidence[] {
  const related = new Set<string>();
  const histories = new Map<string, SupplyEvent[]>();
  for (const event of supply.log) {
    const requestId = event.kind === 'requestRecord' ? event.request.id : 'requestId' in event ? event.requestId : null;
    if (requestId === null) continue;
    if (event.kind === 'arrival' || event.kind === 'arrivalRevise') {
      const touches = event.kind === 'arrival'
        ? event.arrival.receiptLotId === lotId
        : event.before.receiptLotId === lotId || event.after.receiptLotId === lotId;
      if (!touches) continue;
      related.add(requestId);
    }
    const history = histories.get(requestId) ?? [];
    history.push(event);
    histories.set(requestId, history);
  }
  const requests: RequestEvidence[] = [];
  for (const request of Object.values(supply.requests)) {
    const arrivals = request.arrivals.filter(a => a.receiptLotId === lotId);
    if (arrivals.length > 0 || related.has(request.id)) requests.push({ request, arrivals, history: histories.get(request.id) ?? [] });
  }
  return requests;
}

export function lotEvidenceOf(ledger: Ledger, supply: Supply, lotId: string): LotEvidence | null {
  if (!ledger.lots[lotId]) return null;
  const receipt = supply.receipts[lotId];
  return {
    sources: sourcesOf(ledger, lotId),
    scans: eventsOf(ledger, lotId).filter(e => e.scan !== undefined),
    receipt: receipt ? { ...receipt, status: receiptStatusOf(ledger, supply, lotId) } : null,
    receiptHistory: supply.log.filter(e => (e.kind === 'receiptRecord' || e.kind === 'receiptRevise') && e.lotId === lotId),
    requests: requestsOf(supply, lotId),
  };
}

function operationText(ledger: Ledger, event: LedgerEvent, targets: HistoryTargetCollector): string {
  const occurred = occurredAtOf(ledger, event.eventId);
  const correction = occurred !== event.occurredAt ? `（訂正前 ${jst(event.occurredAt)}）` : '';
  return `${event.eventId}　発生 ${jst(occurred)}${correction}　記録 ${jst(event.recordedAt)}　入力担当 ${event.actor}　${eventText(ledger, event, targets)}`;
}

function supplyHistory(ledger: Ledger, events: readonly SupplyEvent[], targets: HistoryTargetCollector): HTMLElement {
  return h('ol', {}, ...events.map(event => h('li', {}, `${event.eventId}　発生 ${supplyOccurredText(ledger, event)}　記録 ${jst(event.recordedAt)}　担当 ${event.actor}　${supplyEventText(ledger.masters, event, targets.supplyEventItemIds(event))}`)));
}

function sourcePanel(ledger: Ledger, source: SourceEvidence, targets: HistoryTargetCollector): HTMLElement {
  return h('article', { 'data-source': source.record.eventId },
    h('p', {}, operationText(ledger, source.record, targets)),
    h('p', {}, `${source.operation.kind === 'start' ? '対応する作業の開始全体' : '対応操作'}：${operationText(ledger, source.operation, targets)}`),
    source.materialUses.length > 0 && h('ul', { 'aria-label': 'この材料の使用' }, ...source.materialUses.map(event => h('li', {}, operationText(ledger, event, targets)))),
  );
}

function requestPanel(ledger: Ledger, evidence: RequestEvidence, targets: HistoryTargetCollector): HTMLElement {
  const { request, arrivals } = evidence;
  const { arrived, good } = requestProgressOf(ledger.masters, { ...request, arrivals: [...arrivals] });
  return h('article', { 'aria-label': `依頼${request.id}` },
    h('h5', {}, `依頼${request.id}`),
    h('p', {}, `${projectText(ledger.masters, request.project)}・品目${itemRef(ledger.masters, request.item)}・単位${request.unit}。依頼数量${request.quantity}${request.unit}、依頼先「${request.vendor}」、依頼日${request.requestedOn}。${replyText(request.reply)}。${request.orderConfirmedBy === null ? '注文の確定なし' : '注文の確定済み'}`),
    request.cancelled !== null && h('p', {}, `依頼は取消済み：${request.cancelled.reason}。実受け取りの取消ではない。`),
    h('p', {}, `この実受け取りから：到着${arrived}${request.unit}・良品${good}${request.unit}${arrivals.length === 0 ? '（過去の対応だけが残っている）' : ''}`),
    supplyHistory(ledger, evidence.history, targets),
  );
}

const receiptStatusText: Record<ReceiptStatus, string> = { confirmed: '確定', provisional: '仮の実際に受け取った数', unconfirmed: '未確認' };

export function lotEvidencePanel(ledger: Ledger, supply: Supply, lotId: string): HTMLElement {
  const targets = createHistoryTargetCollector({ ledger, supply });
  const panel = h('section', { class: 'lot-evidence', 'aria-label': 'この保管単位の証拠' }, h('h3', {}, '元の資料と関連依頼'));
  const evidence = lotEvidenceOf(ledger, supply, lotId), lot = ledger.lots[lotId];
  if (evidence === null || !lot) return h('p', {}, '対象の保管単位が選ばれていない');
  panel.append(
    h('section', { 'aria-label': '元の資料' }, h('h4', {}, '元の資料'),
      ...(evidence.sources.length > 0 ? evidence.sources.map(source => sourcePanel(ledger, source, targets)) : [h('p', {}, 'この保管単位に直接対応する元の資料の記録はない')]),
    ),
    h('section', { 'aria-label': '読取証拠' }, h('h4', {}, '読取証拠'),
      evidence.scans.length > 0 ? h('ol', {}, ...evidence.scans.map(event => h('li', {},
        h('p', {}, operationText(ledger, event, targets)),
        event.scan !== undefined && h('p', {}, `読取原文：${event.scan.raw}`),
      ))) : h('p', {}, 'この保管単位に直接対応する読取記録はない'),
    ),
  );
  const receipt = evidence.receipt;
  panel.append(h('section', { 'aria-label': 'この保管単位の実受け取り' }, h('h4', {}, 'この保管単位の実受け取り'),
    receipt === null ? h('p', {}, 'この保管単位自体の実受け取りの記録はない。分割元・統合元がある場合は、その詳細を選んで確認する。') : h('p', {}, `届いた数${receipt.received === null ? '数が不明' : `${receipt.received}${lot.unit}`}（${receiptStatusText[receipt.status]}）。現在の記録上の数とは別の記録。`),
    receipt?.label != null && h('p', {}, `ラベル原文：${receipt.label}`),
    supplyHistory(ledger, evidence.receiptHistory, targets),
  ));
  panel.append(h('section', { 'aria-label': '直接対応する依頼' }, h('h4', {}, '直接対応する依頼'),
    ...(evidence.requests.length > 0 ? evidence.requests.map(request => requestPanel(ledger, request, targets)) : [h('p', {}, '現在参照している記録に、この実受け取りへの割り当てはない')]),
  ));
  return panel;
}
