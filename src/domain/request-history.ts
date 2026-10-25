import { own } from './masters.ts';
import { sameProject, type Arrival, type Reply, type Request, type Supply, type SupplyEvent } from './supply.ts';

function mismatch(id: string, reason: string): never {
  throw new Error(`依頼の履歴と現在値が一致しない（${id}: ${reason}）`);
}

function sameReply(a: Reply, b: Reply): boolean {
  return a.kind === b.kind && (a.kind === 'none' || (b.kind !== 'none' && a.date === b.date));
}

function sameArrival(a: Arrival, b: Arrival): boolean {
  return a.id === b.id && a.receiptLotId === b.receiptLotId && a.arrived === b.arrived && a.good === b.good;
}

function sameRequest(a: Request, b: Request): boolean {
  return a.id === b.id && sameProject(a.project, b.project) && a.item === b.item && a.unit === b.unit
    && a.quantity === b.quantity && a.vendor === b.vendor && a.requestedOn === b.requestedOn
    && a.orderConfirmedBy === b.orderConfirmedBy && sameReply(a.reply, b.reply)
    && (a.cancelled === null ? b.cancelled === null
      : b.cancelled !== null && a.cancelled.eventId === b.cancelled.eventId && a.cancelled.reason === b.cancelled.reason)
    && a.arrivals.length === b.arrivals.length && a.arrivals.every((arrival, i) => {
      const other = b.arrivals[i];
      return other !== undefined && sameArrival(arrival, other);
    });
}

function changedRequest(request: Request, event: Extract<SupplyEvent, { requestId: string }>): Request {
  if (event.kind !== 'arrivalRevise' && event.kind !== 'requestCancel' && request.cancelled !== null) {
    mismatch(request.id, '取消後の変更');
  }
  switch (event.kind) {
    case 'orderConfirm':
      if (request.orderConfirmedBy !== null) mismatch(request.id, '注文の確定が重複');
      return { ...request, orderConfirmedBy: event.eventId };
    case 'replyRecord':
      if (!sameReply(request.reply, event.before)) mismatch(request.id, '回答の訂正前の値が違う');
      if (sameReply(event.before, event.after)) mismatch(request.id, '回答が変わっていない');
      return { ...request, reply: event.after };
    case 'requestCancel':
      if (request.cancelled !== null) mismatch(request.id, '取消が重複');
      return { ...request, cancelled: { eventId: event.eventId, reason: event.reason } };
    case 'arrival':
      if (event.arrival.id !== event.eventId) mismatch(request.id, '到着IDが違う');
      if (request.arrivals.some((a) => a.id === event.arrival.id)) mismatch(request.id, '到着が重複');
      return { ...request, arrivals: [...request.arrivals, event.arrival] };
    case 'arrivalRevise': {
      const before = request.arrivals.find((a) => a.id === event.before.id);
      if (!before || !sameArrival(before, event.before)) mismatch(request.id, '到着の訂正前の値が違う');
      if (event.after.id !== before.id || event.after.receiptLotId !== before.receiptLotId) mismatch(request.id, '到着の識別が変わっている');
      if (event.after.arrived === before.arrived && event.after.good === before.good) mismatch(request.id, '到着が変わっていない');
      return { ...request, arrivals: request.arrivals.map((a) => a.id === before.id ? event.after : a) };
    }
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

export function validateRequests(supply: Supply): void {
  const expected = new Map<string, Request>();
  for (const event of supply.log) {
    if (event.kind === 'requestRecord') {
      const initial = event.request;
      if (initial.id !== event.eventId) mismatch(initial.id, '作成IDが違う');
      if (expected.has(initial.id)) mismatch(initial.id, '作成が重複');
      if (initial.orderConfirmedBy !== null || initial.cancelled !== null || initial.arrivals.length !== 0) {
        mismatch(initial.id, '作成時の初期状態が違う');
      }
      expected.set(initial.id, initial);
    } else if ('requestId' in event) {
      const before = expected.get(event.requestId);
      if (!before) mismatch(event.requestId, '作成前の変更');
      expected.set(event.requestId, changedRequest(before, event));
    }
  }
  for (const [id, request] of expected) {
    const current = own(supply.requests, id);
    if (!current) mismatch(id, '現在値がない');
    if (!sameRequest(request, current)) mismatch(id, '現在値の内容が違う');
  }
  for (const id of Object.keys(supply.requests)) {
    if (!expected.has(id)) mismatch(id, '作成記録がない');
  }
}
