import { legacyEventLabels } from '../fixtures/history-labels.ts';
import { describe, expect, test } from 'vitest';
import { deepFreeze, practiceLedger, type Meta } from '../../src/domain/ledger.ts';
import { fixedMasters } from '../../src/domain/masters.ts';
import { validateRequests } from '../../src/domain/request-history.ts';
import {
  allocateArrival, cancelRequest, confirmOrder, emptySupply, receiveLot, recordReply, recordRequest,
  reviseArrival, reviseReceipt, type Arrival, type Reply, type Request, type Supply, type SupplyDetail, type SupplyEvent,
} from '../../src/domain/supply.ts';

function meta(eventId: string, hour = 9): Meta {
  return { eventId, occurredAt: `2026-10-02T${String(hour).padStart(2, '0')}:00:00+09:00`, recordedAt: '2026-10-02T18:00:00+09:00', actor: '架空担当A' };
}

function request(change: Partial<Request> = {}): Request {
  return { id: 'q1', project: { kind: 'case', id: 'B-001' }, item: 'P', unit: '個', quantity: 10, vendor: '架空手配先', requestedOn: '2026-10-02', orderConfirmedBy: null, reply: { kind: 'none' }, cancelled: null, arrivals: [], ...change };
}

function event(detail: SupplyDetail, eventId = 'e1'): SupplyEvent {
  return { ...meta(eventId), ...legacyEventLabels, ...detail };
}

function supply(current: Request = request(), changes: SupplyEvent[] = [], initial: Request = request()): Supply {
  return { ...emptySupply, requests: { [current.id]: current }, log: [event({ kind: 'requestRecord', request: initial }, initial.id), ...changes] };
}

const arrival: Arrival = { id: 'a1', receiptLotId: 'R1', arrived: 8, good: 7 };
const arrived = event({ kind: 'arrival', requestId: 'q1', arrival }, 'a1');

function rejects(input: Supply, reason: string): void {
  expect(() => validateRequests(input)).toThrow(`依頼の履歴と現在値が一致しない（q1: ${reason}）`);
}

describe('依頼照合 要件1.1–1.3: 作成と現在値', () => {
  test('空の供給と、初期回答を含む依頼を受け付ける', () => {
    expect(() => validateRequests(emptySupply)).not.toThrow();
    const replies: Reply[] = [{ kind: 'none' }, { kind: 'estimated', date: '2026-10-10' }, { kind: 'answered', date: '2026-10-11' }];
    for (const reply of replies) {
      const initial = request({ reply });
      expect(() => validateRequests(supply(initial, [], initial))).not.toThrow();
    }
  });

  test.each(['q1', 'op-s2', 'sc-q1', '__proto__', 'constructor', 'toString'])('依頼ID %s を安全な文字列として照合する', (id) => {
    const initial = request({ id });
    expect(() => validateRequests(supply(initial, [], initial))).not.toThrow();
  });

  test('作成履歴なし・現在値なし・同ID重複・作成ID違いを拒否する', () => {
    rejects({ ...supply(), log: [] }, '作成記録がない');
    rejects({ ...supply(), requests: {} }, '現在値がない');
    rejects(supply(request(), [event({ kind: 'requestRecord', request: request() }, 'q1')]), '作成が重複');
    rejects({ ...supply(), log: [event({ kind: 'requestRecord', request: request() }, 'other')] }, '作成IDが違う');
  });

  test.each<Partial<Request>>([
    { orderConfirmedBy: 'c1' }, { cancelled: { eventId: 'c1', reason: '架空取消' } }, { arrivals: [arrival] },
  ])('変更済みの初期状態を拒否する: %j', (change) => {
    const initial = request(change);
    rejects(supply(initial, [], initial), '作成時の初期状態が違う');
  });

  test.each<Partial<Request>>([
    { id: 'q2' }, { project: { kind: 'case', id: '002' } }, { project: { kind: 'common' } }, { item: 'Q' },
    { unit: '箱' }, { quantity: 11 }, { vendor: '別の架空先' }, { requestedOn: '2026-10-03' },
    { orderConfirmedBy: 'c1' }, { reply: { kind: 'answered', date: '2026-10-10' } },
    { cancelled: { eventId: 'c1', reason: '履歴なし取消' } }, { arrivals: [arrival] },
  ])('現在の業務項目の改変を拒否する: %j', (change) => {
    const current = request(change);
    rejects({ ...supply(), requests: { q1: current } }, '現在値の内容が違う');
  });

  test('辞書キーと依頼IDの食い違いを拒否する', () => {
    rejects({ ...supply(), requests: { other: request() } }, '現在値がない');
  });

  test('正常な依頼の隣に追加した作成履歴のない依頼を拒否する', () => {
    expect(() => validateRequests({ ...supply(), requests: { q1: request(), q2: request({ id: 'q2' }) } }))
      .toThrow('依頼の履歴と現在値が一致しない（q2: 作成記録がない）');
  });

  test('オブジェクトのキーの並びに意味を持たせない', () => {
    const initial = request({ reply: { kind: 'answered', date: '2026-10-10' }, arrivals: [] });
    const current = { ...initial, project: { id: 'B-001', kind: 'case' }, reply: { date: '2026-10-10', kind: 'answered' } } satisfies Request;
    expect(() => validateRequests(supply(current, [], initial))).not.toThrow();
  });
});

describe('依頼照合 要件2.1–2.4: 追記順の遷移', () => {
  test('実操作の回答・発注・取消を、実際の日時で並べ替えずに受け付ける', () => {
    let s = recordRequest(emptySupply, fixedMasters, meta('q1'), request({ reply: { kind: 'estimated', date: '2026-10-10' } }));
    s = recordReply(s, fixedMasters, meta('r1', 14), 'q1', { kind: 'answered', date: '2026-10-11' });
    s = confirmOrder(s, fixedMasters, meta('c1', 12), 'q1');
    s = recordReply(s, fixedMasters, meta('r2', 11), 'q1', { kind: 'none' });
    s = cancelRequest(s, fixedMasters, meta('x1', 10), 'q1', '架空の不要化');
    expect(() => validateRequests(s)).not.toThrow();
  });

  const changeEvents: SupplyEvent[] = [
    event({ kind: 'orderConfirm', requestId: 'q1' }),
    event({ kind: 'replyRecord', requestId: 'q1', before: { kind: 'none' }, after: { kind: 'answered', date: '2026-10-10' } }),
    event({ kind: 'requestCancel', requestId: 'q1', reason: '架空取消' }), arrived,
    event({ kind: 'arrivalRevise', requestId: 'q1', before: arrival, after: { ...arrival, good: 6 } }),
  ];

  test.each(changeEvents)('作成前の変更を拒否する: $kind', (change) => {
    rejects({ ...emptySupply, log: [change] }, '作成前の変更');
  });

  test('注文の確定と取消の重複を拒否する', () => {
    rejects(supply(request(), [event({ kind: 'orderConfirm', requestId: 'q1' }, 'c1'), event({ kind: 'orderConfirm', requestId: 'q1' }, 'c2')]), '注文の確定が重複');
    rejects(supply(request(), [event({ kind: 'requestCancel', requestId: 'q1', reason: '架空取消' }, 'x1'), event({ kind: 'requestCancel', requestId: 'q1', reason: '架空取消' }, 'x2')]), '取消が重複');
  });

  test.each(changeEvents.slice(0, 2).concat(arrived))('取消後の新たな変更を拒否する: $kind', (change) => {
    rejects(supply(request(), [event({ kind: 'requestCancel', requestId: 'q1', reason: '架空取消' }, 'x1'), change]), '取消後の変更');
  });

  test('回答before不一致と無操作を拒否する', () => {
    rejects(supply(request(), [event({ kind: 'replyRecord', requestId: 'q1', before: { kind: 'answered', date: '2026-10-10' }, after: { kind: 'none' } })]), '回答の訂正前の値が違う');
    rejects(supply(request(), [event({ kind: 'replyRecord', requestId: 'q1', before: { kind: 'none' }, after: { kind: 'none' } })]), '回答が変わっていない');
  });

  test('回答区分が同じ場合も日付を比較し、同日同区分の無操作を拒否する', () => {
    const initial = request({ reply: { kind: 'estimated', date: '2026-10-10' } });
    const before: Reply = { kind: 'estimated', date: '2026-10-11' };
    rejects(supply(request({ reply: before }), [], initial), '現在値の内容が違う');
    rejects(supply(initial, [event({ kind: 'replyRecord', requestId: 'q1', before, after: { kind: 'none' } })], initial), '回答の訂正前の値が違う');
    rejects(supply(initial, [event({ kind: 'replyRecord', requestId: 'q1', before: initial.reply, after: initial.reply })], initial), '回答が変わっていない');
    const changed = recordReply(supply(initial, [], initial), fixedMasters, meta('r1', 10), 'q1', before);
    expect(() => validateRequests(changed)).not.toThrow();
  });

  test.each([{ eventId: 'other', reason: '架空取消' }, { eventId: 'x1', reason: '改変理由' }])('現在の取消ID・理由改変を拒否する: %j', (cancelled) => {
    rejects(supply(request({ cancelled }), [event({ kind: 'requestCancel', requestId: 'q1', reason: '架空取消' }, 'x1')]), '現在値の内容が違う');
  });

  test('取消後・過剰割り当て中の減数、使える数だけ、0への実操作の訂正を受け付ける', () => {
    const initial = recordRequest(emptySupply, fixedMasters, meta('q1'), request());
    const received = receiveLot(practiceLedger, initial, meta('rec', 10), { id: 'R1', item: 'P', unit: '個', project: request().project, location: 'S1' }, 'counted', 12);
    let s = allocateArrival(received.ledger, received.supply, meta('a1', 11), 'q1', { receiptLotId: 'R1', arrived: 8, good: 7 });
    s = allocateArrival(received.ledger, s, meta('a2', 12), 'q1', { receiptLotId: 'R1', arrived: 4, good: 4 });
    s = cancelRequest(s, fixedMasters, meta('x1', 13), 'q1', '架空取消');
    s = reviseReceipt(received.ledger, s, meta('rec2', 14), 'R1', 2, '架空の再確認');
    s = reviseArrival(received.ledger, s, meta('v1', 15), 'q1', 'a1', { arrived: 7, good: 6 });
    expect(() => validateRequests(s)).not.toThrow();
    s = reviseArrival(received.ledger, s, meta('v2', 16), 'q1', 'a1', { arrived: 7, good: 5 });
    expect(() => validateRequests(s)).not.toThrow();
    s = reviseArrival(received.ledger, s, meta('v3', 17), 'q1', 'a1', { arrived: 0, good: 0 });
    expect(() => validateRequests(s)).not.toThrow();
  });

  test('到着IDと操作IDの不一致・到着の重複を拒否する', () => {
    rejects(supply(request(), [{ ...arrived, eventId: 'other' }]), '到着IDが違う');
    rejects(supply(request(), [arrived, arrived]), '到着が重複');
  });

  test.each<Partial<Arrival>>([{ id: 'missing' }, { receiptLotId: 'other' }, { arrived: 7 }, { good: 6 }])('到着訂正beforeの不一致を拒否する: %j', (change) => {
    rejects(supply(request(), [arrived, event({ kind: 'arrivalRevise', requestId: 'q1', before: { ...arrival, ...change }, after: { ...arrival, good: 5 } })]), '到着の訂正前の値が違う');
  });

  test.each<Partial<Arrival>>([{ id: 'other', good: 6 }, { receiptLotId: 'other', good: 6 }])('到着訂正の識別すり替えを拒否する: %j', (change) => {
    rejects(supply(request(), [arrived, event({ kind: 'arrivalRevise', requestId: 'q1', before: arrival, after: { ...arrival, ...change } })]), '到着の識別が変わっている');
  });

  test('到着訂正の無操作を拒否する', () => {
    rejects(supply(request(), [arrived, event({ kind: 'arrivalRevise', requestId: 'q1', before: arrival, after: { ...arrival } })]), '到着が変わっていない');
  });

  test('依頼は存在するが到着は存在しない訂正を拒否する', () => {
    rejects(supply(request(), [event({ kind: 'arrivalRevise', requestId: 'q1', before: arrival, after: { ...arrival, good: 6 } })]), '到着の訂正前の値が違う');
  });

  test.each<Partial<Arrival>>([{ id: 'other' }, { receiptLotId: 'other' }, { arrived: 7 }, { good: 6 }])('現在の到着の各項目改変を拒否する: %j', (change) => {
    rejects(supply(request({ arrivals: [{ ...arrival, ...change }] }), [arrived]), '現在値の内容が違う');
  });

  test('到着の順序を保持し、訂正を元の位置へ適用する', () => {
    const second = { ...arrival, id: 'a2', arrived: 2, good: 2 };
    const revised = { ...arrival, good: 6 };
    const changes = [arrived, event({ kind: 'arrival', requestId: 'q1', arrival: second }, 'a2'), event({ kind: 'arrivalRevise', requestId: 'q1', before: arrival, after: revised }, 'v1')];
    expect(() => validateRequests(supply(request({ arrivals: [revised, second] }), changes))).not.toThrow();
    rejects(supply(request({ arrivals: [second, revised] }), changes), '現在値の内容が違う');
  });

  test('無関係な記録を無視し、成功時も拒否時も入力を変更しない', () => {
    const valid = deepFreeze(supply(request({ arrivals: [arrival] }), [event({ kind: 'returnAck', handoverEventId: 'h1' }), arrived]));
    const before = structuredClone(valid);
    expect(() => validateRequests(valid)).not.toThrow();
    expect(valid).toEqual(before);
    const invalid = deepFreeze({ ...valid, requests: { q1: request() } });
    const invalidBefore = structuredClone(invalid);
    rejects(invalid, '現在値の内容が違う');
    expect(invalid).toEqual(invalidBefore);
  });
});
