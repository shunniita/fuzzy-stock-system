import type { EventDetail, Ledger, LedgerEvent, Meta } from './ledger.ts';
import type { Supply, SupplyDetail } from './supply.ts';
import { own } from './masters.ts';
import { assemblyItemIds } from './assembly-recipes.ts';

export type LedgerTargetEvent = Meta & EventDetail & { changes: LedgerEvent['changes'] };
export type SupplyTargetEvent = Meta & SupplyDetail;
export type HistoryTargetContext = {
  readonly ledger: Readonly<Pick<Ledger, 'lots' | 'issues' | 'stops'> & { history: readonly LedgerTargetEvent[] }> | null;
  readonly supply: Readonly<Pick<Supply, 'needs' | 'declarations' | 'requests'> & { log: readonly SupplyTargetEvent[] }> | null;
};
export type ForwardOperationTargets = { readonly operationId: string; readonly itemIds: readonly string[] };

type EventJob = { kind: 'ledger'; event: LedgerTargetEvent; forward: ForwardOperationTargets | undefined }
  | { kind: 'supply'; event: SupplyTargetEvent };
type Frame = { job: EventJob; items: Set<string>; pending: Work[] };
type Work = { kind: 'visit'; job: EventJob; output: Set<string> }
  | { kind: 'finish'; frame: Frame; key: string; output: Set<string> };

function required<T>(value: T | undefined | null, kind: string, id: string): T {
  if (value === undefined || value === null) throw new Error(`履歴品目の参照先がない（${kind}: ${id}）`);
  return value;
}

function indexEvents<T extends Meta>(events: readonly T[], kind: string): Map<string, T> {
  const index = new Map(events.map(event => [event.eventId, event]));
  if (index.size !== events.length) throw new Error(`履歴品目の参照IDが重複している（${kind}）`);
  return index;
}

// 一つの不変snapshotにだけ使う。索引と計算済み集合はcollectorが所有し、業務stateへ書き込まない。
export function createHistoryTargetCollector(context: HistoryTargetContext) {
  let ledgerIndex: Map<string, LedgerTargetEvent> | undefined;
  let supplyIndex: Map<string, SupplyTargetEvent> | undefined;
  const cached = new WeakMap<LedgerTargetEvent | SupplyTargetEvent, readonly string[]>();

  function findLedger(id: string): LedgerTargetEvent | undefined {
    if (context.ledger === null) return undefined;
    ledgerIndex ??= indexEvents(context.ledger.history, '台帳');
    return ledgerIndex.get(id);
  }

  function addLedger(frame: Frame, id: string, expected?: LedgerTargetEvent['kind']): void {
    const event = required(findLedger(id), '台帳操作', id);
    if (expected !== undefined && event.kind !== expected) throw new Error(`履歴品目の参照先 ${id} は ${expected} の記録ではない`);
    frame.pending.push({ kind: 'visit', job: { kind: 'ledger', event, forward: undefined }, output: frame.items });
  }

  function addSupply(frame: Frame, id: string, expected: SupplyTargetEvent['kind']): void {
    const supply = required(context.supply, '供給context', id);
    supplyIndex ??= indexEvents(supply.log, '供給');
    const event = required(supplyIndex.get(id), '供給操作', id);
    if (event.kind !== expected) throw new Error(`履歴品目の参照先 ${id} は ${expected} の記録ではない`);
    frame.pending.push({ kind: 'visit', job: { kind: 'supply', event }, output: frame.items });
  }

  function addLot(frame: Frame, id: string): void {
    const changes = frame.job.kind === 'ledger' ? frame.job.event.changes : [];
    const change = changes.find(change => change.after.id === id || change.before?.id === id);
    const embedded = change?.after.id === id ? change.after : change?.before;
    const lot = required(embedded ?? (context.ledger === null ? undefined : own(context.ledger.lots, id)), '保管単位', id);
    frame.items.add(lot.item);
  }

  function addIssue(frame: Frame, id: string): void {
    const issue = required(context.ledger === null ? undefined : own(context.ledger.issues, id), '確認事項', id);
    if (issue.lotId !== null) addLot(frame, issue.lotId);
    // ledger.originOfと同じ既存の日時訂正事項の識別規則。
    addLedger(frame, id.endsWith('@time') ? id.slice(0, -'@time'.length) : id);
  }

  function addStop(frame: Frame, id: string): void {
    const stop = required(context.ledger === null ? undefined : own(context.ledger.stops, id), '中断', id);
    frame.items.add(stop.item);
    if (stop.shortage !== null) frame.items.add(stop.shortage.item);
  }

  function addRequest(frame: Frame, id: string): void {
    const request = required(context.supply === null ? undefined : own(context.supply.requests, id), '依頼', id);
    frame.items.add(request.item);
  }

  function visitLedger(frame: Frame, event: LedgerTargetEvent, forward: ForwardOperationTargets | undefined): void {
    if (event.kind === 'master') return;
    for (const change of event.changes) {
      if (change.before !== null) frame.items.add(change.before.item);
      frame.items.add(change.after.item);
    }
    switch (event.kind) {
      case 'register': case 'move': case 'merge': case 'hold': case 'release': return;
      case 'use': case 'handover': case 'declare': case 'assignProject':
        addLot(frame, event.lotId); return;
      case 'split': case 'transfer': case 'stage':
        addLot(frame, event.lotId); addLot(frame, event.childId); return;
      case 'rework':
        addLot(frame, event.lotId); addLot(frame, event.childId);
        if (event.returnSource !== undefined) addLedger(frame, event.returnSource.adoptEventId, 'adopt');
        return;
      case 'recount':
        addLot(frame, event.lotId);
        for (const id of event.answeredFor) addLedger(frame, id);
        return;
      case 'identify': case 'adopt':
        addLot(frame, event.lotId); addIssue(frame, event.issueId); return;
      case 'resolve':
        addIssue(frame, event.issueId);
        if (event.countedBy !== null) addLedger(frame, event.countedBy);
        return;
      case 'correctTime': addLedger(frame, event.targetEventId); return;
      case 'void': addLot(frame, event.lotId); addLedger(frame, event.targetEventId); return;
      case 'provisional':
        if (event.item !== null) frame.items.add(event.item);
        return;
      case 'stop':
        frame.items.add(event.stop.item);
        if (event.stop.shortage !== null) frame.items.add(event.stop.shortage.item);
        return;
      case 'stopUpdate': case 'resume': addStop(frame, event.stopId); return;
      case 'start':
        addLot(frame, event.lotId);
        for (const id of event.materials) addLedger(frame, id, 'use');
        return;
      case 'reworkPart':
        addLedger(frame, event.reworkId, 'rework');
        if (event.subjectLotId !== undefined) addLot(frame, event.subjectLotId);
        switch (event.action) {
          case 'replace': addLedger(frame, event.useEventId, 'use'); return;
          case 'recover': addLedger(frame, event.registerEventId, 'register'); return;
          case 'discard': frame.items.add(event.item); return;
          default: { const exhaustive: never = event; throw new Error(`履歴品目の部品処置が未対応（${String(exhaustive)}）`); }
        }
      case 'alternativeRecord': {
        if (forward !== undefined && forward.operationId !== event.operationId) throw new Error('前置きする元の資料と対象操作IDが一致しない');
        if (findLedger(event.operationId) !== undefined) {
          addLedger(frame, event.operationId, event.operation === 'receive' ? 'register' : event.operation);
        } else if (forward !== undefined && forward.itemIds.length > 0) {
          for (const id of forward.itemIds) frame.items.add(id);
        } else throw new Error(`履歴品目の元の資料に対応する操作がない（${event.operationId}）`);
        return;
      }
      default: { const exhaustive: never = event; throw new Error(`履歴品目の台帳種別が未対応（${String(exhaustive)}）`); }
    }
  }

  function visitSupply(frame: Frame, event: SupplyTargetEvent): void {
    switch (event.kind) {
      case 'receiptTemplateSave':
        if (event.before !== null) for (const id of assemblyItemIds(event.before)) frame.items.add(id);
        for (const id of assemblyItemIds(event.after)) frame.items.add(id);
        return;
      case 'receiptTemplateDelete':
        for (const id of assemblyItemIds(event.before)) frame.items.add(id);
        return;
      case 'usageEstimate':
        for (const id of assemblyItemIds(event.template)) frame.items.add(id);
        return;
      case 'templateReceipt':
        for (const id of assemblyItemIds(event.template)) frame.items.add(id);
        for (const row of event.rows) if (row.lotId !== null) addLot(frame, row.lotId);
        return;
      case 'needRegister': frame.items.add(event.need.item); return;
      case 'needRevise': frame.items.add(event.before.item); frame.items.add(event.after.item); return;
      case 'shortageDeclare': frame.items.add(event.declaration.item); return;
      case 'declarationLink': {
        const declaration = required(context.supply === null ? undefined : own(context.supply.declarations, event.declarationId), '不足申告', event.declarationId);
        frame.items.add(declaration.item); return;
      }
      case 'requestRecord': frame.items.add(event.request.item); return;
      case 'orderConfirm': case 'replyRecord': case 'requestCancel': addRequest(frame, event.requestId); return;
      case 'receiptRecord': case 'receiptRevise': case 'remainder': addLot(frame, event.lotId); return;
      case 'arrival': addRequest(frame, event.requestId); addLot(frame, event.arrival.receiptLotId); return;
      case 'arrivalRevise': addRequest(frame, event.requestId); addLot(frame, event.before.receiptLotId); addLot(frame, event.after.receiptLotId); return;
      case 'returnAck': addLedger(frame, event.handoverEventId, 'handover'); return;
      case 'needImport':
        switch (event.decision.kind) {
          case 'hold':
            for (const id of event.decision.candidates) {
              const need = required(context.supply === null ? undefined : own(context.supply.needs, id), '必要明細', id);
              frame.items.add(need.item);
            }
            return;
          case 'create': frame.items.add(event.decision.after.item); return;
          case 'revise': case 'unchanged': frame.items.add(event.decision.before.item); frame.items.add(event.decision.after.item); return;
          default: { const exhaustive: never = event.decision; throw new Error(`履歴品目の取込結果が未対応（${String(exhaustive)}）`); }
        }
      case 'needImportResolve':
        addSupply(frame, event.importEventId, 'needImport');
        switch (event.resolution.kind) {
          case 'dismiss': return;
          case 'apply': frame.items.add(event.resolution.before.item); frame.items.add(event.resolution.after.item); return;
          default: { const exhaustive: never = event.resolution; throw new Error(`履歴品目の取込照合が未対応（${String(exhaustive)}）`); }
        }
      default: { const exhaustive: never = event; throw new Error(`履歴品目の供給種別が未対応（${String(exhaustive)}）`); }
    }
  }

  function collect(initial: EventJob): string[] {
    const items = new Set<string>(), active = new Set<string>();
    const pending: Work[] = [{ kind: 'visit', job: initial, output: items }];
    while (pending.length > 0) {
      const work = pending.pop()!;
      if (work.kind === 'finish') {
        const result = [...work.frame.items].sort();
        if (work.frame.job.kind !== 'ledger' || work.frame.job.forward === undefined) cached.set(work.frame.job.event, result);
        for (const id of result) work.output.add(id);
        active.delete(work.key);
        continue;
      }
      const prior = work.job.kind === 'ledger' && work.job.forward !== undefined ? undefined : cached.get(work.job.event);
      if (prior !== undefined) {
        for (const id of prior) work.output.add(id);
        continue;
      }
      const key = JSON.stringify([work.job.kind, work.job.event.eventId]);
      if (active.has(key)) throw new Error(`履歴品目の参照が循環している（${work.job.event.eventId}）`);
      active.add(key);
      const frame: Frame = { job: work.job, items: new Set(), pending };
      pending.push({ kind: 'finish', frame, key, output: work.output });
      if (work.job.kind === 'ledger') visitLedger(frame, work.job.event, work.job.forward);
      else visitSupply(frame, work.job.event);
    }
    return [...items].sort();
  }

  return {
    ledgerEventItemIds: (event: LedgerTargetEvent, forward?: ForwardOperationTargets) => collect({ kind: 'ledger', event, forward }),
    supplyEventItemIds: (event: SupplyTargetEvent) => collect({ kind: 'supply', event }),
  };
}

export function ledgerEventItemIds(event: LedgerTargetEvent, context: HistoryTargetContext, forward?: ForwardOperationTargets): string[] {
  return createHistoryTargetCollector(context).ledgerEventItemIds(event, forward);
}

export function supplyEventItemIds(event: SupplyTargetEvent, context: HistoryTargetContext): string[] {
  return createHistoryTargetCollector(context).supplyEventItemIds(event);
}
