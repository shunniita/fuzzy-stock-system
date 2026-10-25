import { fixedMasters } from '../../src/domain/masters.ts';
import { describe, expect, test } from 'vitest';
import { correctOccurredAt, practiceLedger, merge, recount, register, split, use, type Ledger, type Meta, type Project } from '../../src/domain/ledger.ts';
import {
  allocateArrival,
  cancelRequest,
  emptySupply,
  receiveLot,
  receivedFromRemaining,
  receivedOf,
  receiptStatusOf,
  recordRequest,
  reviseArrival,
  reviseReceipt,
  type Supply,
} from '../../src/domain/supply.ts';

const b001: Project & { kind: 'case' } = { kind: 'case', id: 'B-001' };

function meta(eventId: string, hour = 9): Meta {
  const at = `2026-10-02T${String(hour).padStart(2, '0')}:00:00+09:00`;
  return { eventId, occurredAt: at, recordedAt: at, actor: '架空担当A' };
}

const req = { project: b001, item: 'P', unit: '個', quantity: 100, vendor: '架空の仕入先X', requestedOn: '2026-10-02', reply: { kind: 'none' } } as const;
const lotOf = (id: string) => ({ id, item: 'P', unit: '個', project: b001, location: 'S1' });

// 依頼を n 件、8時に記録した状態。
function requested(n = 1): Supply {
  let s = emptySupply;
  for (let i = 1; i <= n; i++) s = recordRequest(s, fixedMasters, meta(`q${i}`, 8), req);
  return s;
}

const receive = (ledger: Ledger, supply: Supply, eventId: string, id: string, basis: 'counted' | 'label' | 'approximate' | 'unknown', value: number | null, hour = 9) =>
  receiveLot(ledger, supply, meta(eventId, hour), lotOf(id), basis, value);

const allocatedOf = (supply: Supply, requestId: string) => supply.requests[requestId]?.arrivals.reduce((n, a) => n + a.arrived, 0);

describe('要件5 受け取りと実際に受け取った数', () => {
  test('B3 3.4: 架空ラベルを受け取りの記録と現物ごとの実際に受け取った数に保持し、実際に受け取った数の訂正でも失わない', () => {
    const label = '000123-架空箱';
    const r = receiveLot(practiceLedger, emptySupply, meta('e1'), lotOf('R1'), 'counted', 10, label);
    expect(r.supply.receipts['R1']).toMatchObject({ label });
    expect(r.supply.log.at(-1)).toMatchObject({ kind: 'receiptRecord', lotId: 'R1', label });
    const revised = reviseReceipt(r.ledger, r.supply, meta('v1', 10), 'R1', 9, '数えて訂正');
    expect(revised.receipts['R1']).toMatchObject({ label, received: 9 });
    expect(r.supply.receipts['R1']).toMatchObject({ label, received: 10 });
  });

  test('B3 3.5 AT-23のラベル部分: 同じ架空ラベルの別箱を別の保管単位・別の操作IDとして受け入れる', () => {
    const label = '000123-架空箱';
    const first = receiveLot(practiceLedger, emptySupply, meta('e1'), lotOf('R1'), 'counted', 10, label);
    const second = receiveLot(first.ledger, first.supply, meta('e2', 10), lotOf('R2'), 'counted', 20, label);
    expect(Object.keys(second.supply.receipts)).toEqual(['R1', 'R2']);
    expect(second.supply.receipts['R1']).toMatchObject({ label, received: 10, eventId: 'e1-c' });
    expect(second.supply.receipts['R2']).toMatchObject({ label, received: 20, eventId: 'e2-c' });
    expect(second.ledger.history.map((e) => e.eventId)).toEqual(['e1', 'e2']);
    expect(second.supply.log.map((e) => e.eventId)).toEqual(['e1-c', 'e2-c']);
  });

  test('B3 3.4: 架空ラベルを省略した既存の受け取りはラベルなしとして記録する', () => {
    const r = receive(practiceLedger, emptySupply, 'e1', 'R1', 'counted', 10);
    expect(r.supply.receipts['R1']).toMatchObject({ label: null });
    expect(r.supply.log.at(-1)).toMatchObject({ kind: 'receiptRecord', label: null });
  });

  test('5.1: 受け取りは台帳の登録と実際に受け取った数の記録を一組で行う。実際に受け取った数の記録のIDは基本ID-c', () => {
    const r = receive(practiceLedger, emptySupply, 'e1', 'R1', 'counted', 106);
    expect(r.ledger.lots['R1']).toMatchObject({ item: 'P', location: 'S1', quantity: { kind: 'known', numeric: { value: 106 } } });
    expect(r.supply.receipts['R1']).toEqual({ received: 106, provisional: false, eventId: 'e1-c', label: null });
    expect(receivedOf(r.supply, 'R1')).toBe(106);
    expect(r.supply.log.at(-1)).toMatchObject({ kind: 'receiptRecord', eventId: 'e1-c', lotId: 'R1', received: 106 });
  });

  test('5.1: 表示の数（ラベル・パッケージ）・だいたいで受け入れた数は、仮の実際に受け取った数にする。仮の数を上限に割り当てでき、数えて確定できる', () => {
    for (const basis of ['label', 'approximate'] as const) {
      const r = receive(practiceLedger, requested(), 'e1', 'R1', basis, 106);
      expect(r.supply.receipts['R1']).toEqual({ received: 106, provisional: true, eventId: 'e1-c', label: null });
      expect(receiptStatusOf(r.ledger, r.supply, 'R1')).toBe('provisional');
      expect(() => allocateArrival(r.ledger, r.supply, meta('a1'), 'q1', { receiptLotId: 'R1', arrived: 107, good: 107 })).toThrow('実際に受け取った数');
      expect(allocateArrival(r.ledger, r.supply, meta('a1'), 'q1', { receiptLotId: 'R1', arrived: 106, good: 106 }).requests['q1']?.arrivals.length).toBe(1);
      // 数えて同じ数なら、同じ値でも確定として記録できる。
      const counted = reviseReceipt(r.ledger, r.supply, meta('v1', 10), 'R1', 106, '数えて確定');
      expect(counted.receipts['R1']).toEqual({ received: 106, provisional: false, eventId: 'v1', label: null });
      expect(receiptStatusOf(r.ledger, counted, 'R1')).toBe('confirmed');
    }
  });

  test('仮の実際に受け取った数は、受け入れた物を使い切り（分割した分も含めて台帳が0）、確認事項がなければ確定として扱う', () => {
    let { ledger, supply } = receive(practiceLedger, requested(), 'e1', 'R1', 'label', 100);
    ledger = split(ledger, meta('s1', 10), 'R1', 'R1-a', 'counted', 40);
    ledger = use(ledger, meta('u1', 11), 'R1', 'counted', 60, '架空作業');
    expect(receiptStatusOf(ledger, supply, 'R1')).toBe('provisional'); // 分けた40が残る
    ledger = use(ledger, meta('u2', 12), 'R1-a', 'counted', 40, '架空作業');
    expect(receiptStatusOf(ledger, supply, 'R1')).toBe('confirmed');
    // ラベルより少なかった（使用で負になり確認事項が開く）ときは、確定しない。
    const short = receive(practiceLedger, requested(), 'e1', 'R2', 'label', 100);
    const l2 = use(short.ledger, meta('u1', 11), 'R2', 'counted', 101, '架空作業');
    expect(receiptStatusOf(l2, short.supply, 'R2')).toBe('provisional');
    // 使わずに残りを0と数え直しただけでは、仮の数の物があった証拠にならないので確定しない。
    const zeroed = receive(practiceLedger, requested(), 'e1', 'R4', 'label', 100);
    expect(receiptStatusOf(recount(zeroed.ledger, meta('c1', 10), 'R4', 0, { kind: 'unknown' }), zeroed.supply, 'R4')).toBe('provisional');
    // 数が不明の受け取りは、仮の数もないので未確認のまま。
    const unknown = receive(practiceLedger, requested(), 'e1', 'R3', 'unknown', null);
    expect(receiptStatusOf(unknown.ledger, unknown.supply, 'R3')).toBe('unconfirmed');
  });

  test('数が不明の受け取りは、数えた残りに、それまでに使った・渡した・分けた数を足して実際に受け取った数を逆算できる（仮の数）。減らした数に不明があれば逆算しない', () => {
    let { ledger, supply } = receive(practiceLedger, requested(), 'e1', 'R1', 'unknown', null);
    ledger = use(ledger, meta('u1', 10), 'R1', 'counted', 30, '架空作業');
    ledger = split(ledger, meta('s1', 11), 'R1', 'R1-a', 'counted', 5);
    expect(receivedFromRemaining(ledger, 'R1', 65)).toBe(100);
    supply = reviseReceipt(ledger, supply, meta('v1', 12), 'R1', 100, '残りから逆算', true);
    expect(supply.receipts['R1']).toEqual({ received: 100, provisional: true, eventId: 'v1', label: null });
    const vague = use(ledger, meta('u2', 12), 'R1', 'unknown', null, '架空作業');
    expect(receivedFromRemaining(vague, 'R1', 60)).toBeNull();
    // 受け取りより後に数え直した保管単位は、受け取りの数から逆算できない。
    const recounted = recount(ledger, meta('c1', 12), 'R1', 65, { kind: 'unknown' });
    expect(receivedFromRemaining(recounted, 'R1', 60)).toBeNull();
  });

  test('表示の数（ラベル・パッケージ）・だいたいの受け取りも、使い切ったあとに見つかった残りから実際に受け取った数を逆算できる。数えた受け取りは逆算しない', () => {
    // ラベル100の箱に実際は105入っていて、数えて100使ったあとに5個残っていた。
    const label = receive(practiceLedger, requested(), 'e1', 'R1', 'label', 100);
    const usedUp = use(label.ledger, meta('u1', 10), 'R1', 'counted', 100, '架空作業');
    expect(receivedFromRemaining(usedUp, 'R1', 5)).toBe(105);
    const approximate = receive(practiceLedger, requested(), 'e1', 'R2', 'approximate', 100);
    expect(receivedFromRemaining(split(approximate.ledger, meta('s1', 10), 'R2', 'R2-a', 'counted', 40), 'R2', 62)).toBe(102);
    const counted = receive(practiceLedger, requested(), 'e1', 'R3', 'counted', 100);
    expect(receivedFromRemaining(use(counted.ledger, meta('u1', 10), 'R3', 'counted', 100, '架空作業'), 'R3', 5)).toBeNull();
  });

  test('実際に受け取った数の訂正は、受け取りより前と言える日時では記録しない（同時刻・日時不明は記録できる）', () => {
    const { ledger, supply } = receive(practiceLedger, requested(), 'e1', 'R1', 'counted', 10, 12);
    expect(() => reviseReceipt(ledger, supply, meta('v1', 10), 'R1', 9, '訂正')).toThrow('受け取り');
    expect(receivedOf(reviseReceipt(ledger, supply, meta('v1', 12), 'R1', 9, '訂正'), 'R1')).toBe(9);
    expect(receivedOf(reviseReceipt(ledger, supply, { ...meta('v1', 10), occurredAt: null }, 'R1', 9, '訂正'), 'R1')).toBe(9);
    // 受け取りの日時をあとで訂正したときは、訂正後の受け取りの日時と比べる。
    const later = correctOccurredAt(ledger, meta('t1', 13), 'e1', '2026-10-02T14:00:00+09:00');
    expect(() => reviseReceipt(later, supply, meta('v1', 13), 'R1', 9, '訂正')).toThrow('受け取り');
    const earlier = correctOccurredAt(ledger, meta('t1', 13), 'e1', '2026-10-02T09:00:00+09:00');
    expect(receivedOf(reviseReceipt(earlier, supply, meta('v1', 10), 'R1', 9, '訂正'), 'R1')).toBe(9);
  });

  test('5.1: 数が不明の受け取りは、受け取りとして記録し、実際に受け取った数は未確認にする。未確認の間は割り当てできず、実際に受け取った数を確定すると割り当てできる', () => {
    const r = receive(practiceLedger, requested(), 'e1', 'R1', 'unknown', null);
    expect(r.ledger.lots['R1']).toBeDefined();
    expect(r.supply.receipts['R1']).toEqual({ received: null, provisional: false, eventId: 'e1-c', label: null });
    expect(receivedOf(r.supply, 'R1')).toBeNull();
    expect(() => allocateArrival(r.ledger, r.supply, meta('a1'), 'q1', { receiptLotId: 'R1', arrived: 1, good: 1 })).toThrow('未確認');
    // あとで数えて、実際に受け取った数を確定する（理由は必須）。
    const ledger = recount(r.ledger, meta('c1', 10), 'R1', 5, { kind: 'unknown' });
    expect(() => reviseReceipt(r.ledger, r.supply, meta('v1', 10), 'R1', 5, '')).toThrow('理由');
    const supply = reviseReceipt(r.ledger, r.supply, meta('v1', 10), 'R1', 5, '数えて確定');
    expect(receivedOf(supply, 'R1')).toBe(5);
    expect(supply.log.at(-1)).toMatchObject({ kind: 'receiptRevise', lotId: 'R1', before: null, after: 5 });
    expect(allocateArrival(ledger, supply, meta('a1', 11), 'q1', { receiptLotId: 'R1', arrived: 5, good: 5 }).requests['q1']?.arrivals.length).toBe(1);
  });

  test('初期登録の現物（受け取りの入口を通らない）は、受け取りとして扱わず、実際に受け取った数も確定できない', () => {
    const ledger = register(practiceLedger, meta('r1', 8), lotOf('L1'), 'counted', 10);
    expect(() => allocateArrival(ledger, requested(), meta('a1'), 'q1', { receiptLotId: 'L1', arrived: 1, good: 1 })).toThrow('実際に受け取った数の記録がなく');
    expect(() => reviseReceipt(ledger, requested(), meta('v1'), 'L1', 10, '数えた')).toThrow('記録がない');
  });

  test('受け取りの登録が拒否されたら、台帳もSupplyも変わらない', () => {
    const r = receive(practiceLedger, emptySupply, 'e1', 'R1', 'counted', 10);
    expect(() => receive(r.ledger, r.supply, 'e2', 'R1', 'counted', 10)).toThrow('使用済み');
    expect(() => receiveLot(r.ledger, r.supply, meta('e3'), { ...lotOf('R2'), location: 'ZZ' }, 'counted', 5)).toThrow('場所');
    expect(r.supply.log.length).toBe(1);
  });

  test('実際に受け取った数の訂正は、理由が必須で、値が変わること。記録のない現物は訂正できない', () => {
    const { ledger, supply } = receive(practiceLedger, requested(), 'e1', 'R1', 'counted', 10);
    expect(() => reviseReceipt(ledger, supply, meta('v1'), 'R1', 9, ' ')).toThrow('理由');
    expect(() => reviseReceipt(ledger, supply, meta('v1'), 'R1', 10, '同じ')).toThrow('変わっていない');
    expect(() => reviseReceipt(ledger, supply, meta('v1'), 'zzz', 9, '訂正')).toThrow('実際に受け取った数');
    expect(() => reviseReceipt(ledger, supply, meta('v1'), 'R1', -1, '訂正')).toThrow();
  });

  test('SCN-02: ラベル100の受け取り（仮の実際に受け取った数100）を実数98に数え直しても、実際に受け取った数は自動では変わらない。訂正すると98を超える割り当ては拒否される', () => {
    let { ledger, supply } = receive(practiceLedger, requested(), 'e1', 'R1', 'label', 100);
    ledger = recount(ledger, meta('c1', 10), 'R1', 98, { kind: 'unknown' });
    expect(receivedOf(supply, 'R1')).toBe(100);
    supply = reviseReceipt(ledger, supply, meta('v1', 10), 'R1', 98, '原因不明');
    expect(supply.log.at(-1)).toMatchObject({ kind: 'receiptRevise', lotId: 'R1', before: 100, after: 98, provisional: false, reason: '原因不明' });
    expect(() => allocateArrival(ledger, supply, meta('a1', 11), 'q1', { receiptLotId: 'R1', arrived: 99, good: 99 })).toThrow('実際に受け取った数');
    expect(allocateArrival(ledger, supply, meta('a1', 11), 'q1', { receiptLotId: 'R1', arrived: 98, good: 98 }).requests['q1']?.arrivals.length).toBe(1);
  });

  test('実際に受け取った数は後入力があっても変わらない（8時に100受け取り、10時に残数70を確認、9時の使用30を後入力しても100）', () => {
    let { ledger, supply } = receive(practiceLedger, requested(), 'e1', 'R1', 'counted', 100, 8);
    ledger = recount(ledger, meta('c1', 10), 'R1', 70, { kind: 'unknown' });
    ledger = use(ledger, meta('u1', 9), 'R1', 'counted', 30, '架空作業', 'included');
    expect(receivedOf(supply, 'R1')).toBe(100);
    expect(allocateArrival(ledger, supply, meta('a1', 11), 'q1', { receiptLotId: 'R1', arrived: 100, good: 100 }).requests['q1']?.arrivals.length).toBe(1);
  });

  test('実際に受け取った数の記録は、受け取りのあとの分割・統合でも元の保管単位IDのまま。統合で閉じた元でも割り当てできる', () => {
    let { ledger, supply } = receive(practiceLedger, requested(), 'e1', 'R1', 'counted', 106);
    ledger = split(ledger, meta('s1', 10), 'R1', 'R1-ret', 'counted', 4);
    ledger = register(ledger, meta('z1', 7), lotOf('Z'), 'counted', 10);
    ledger = merge(ledger, meta('g1', 11), 'R1', 'Z');
    expect(ledger.lots['R1']?.mergedInto).toBe('Z');
    expect(Object.keys(supply.receipts)).toEqual(['R1']);
    expect(allocateArrival(ledger, supply, meta('a1', 12), 'q1', { receiptLotId: 'R1', arrived: 106, good: 100 }).requests['q1']?.arrivals[0]?.arrived).toBe(106);
  });
});

describe('要件5 依頼への割り当て', () => {
  test('5.2: 依頼ごとの届いた数と使える数を割り当てとして記録でき、IDは記録した操作のID。複数の依頼へ配分できる', () => {
    let { ledger, supply } = receive(practiceLedger, requested(2), 'e1', 'R1', 'counted', 10);
    supply = allocateArrival(ledger, supply, meta('a1', 10), 'q1', { receiptLotId: 'R1', arrived: 6, good: 4 });
    supply = allocateArrival(ledger, supply, meta('a2', 10), 'q2', { receiptLotId: 'R1', arrived: 4, good: 4 });
    expect(supply.requests['q1']?.arrivals).toEqual([{ id: 'a1', receiptLotId: 'R1', arrived: 6, good: 4 }]);
    expect(allocatedOf(supply, 'q2')).toBe(4);
    expect(supply.log.at(-1)).toMatchObject({ kind: 'arrival', requestId: 'q2' });
  });

  test('5.3: 届いた数の合計が実際に受け取った数を超える割り当ては拒否し、受け取り（台帳の現物）は残る。使える数は届いた数以下', () => {
    let { ledger, supply } = receive(practiceLedger, requested(2), 'e1', 'R1', 'counted', 10);
    supply = allocateArrival(ledger, supply, meta('a1', 10), 'q1', { receiptLotId: 'R1', arrived: 8, good: 8 });
    expect(() => allocateArrival(ledger, supply, meta('a2', 10), 'q2', { receiptLotId: 'R1', arrived: 3, good: 3 })).toThrow('実際に受け取った数');
    expect(ledger.lots['R1']).toBeDefined();
    expect(allocateArrival(ledger, supply, meta('a2', 10), 'q2', { receiptLotId: 'R1', arrived: 2, good: 1 }).requests['q2']?.arrivals.length).toBe(1);
    expect(() => allocateArrival(ledger, supply, meta('a3', 10), 'q2', { receiptLotId: 'R1', arrived: 1, good: 2 })).toThrow('使える数');
    expect(() => allocateArrival(ledger, supply, meta('a3', 10), 'q2', { receiptLotId: 'R1', arrived: 0, good: 0 })).toThrow('届いた数');
  });

  test('5.2: 受け取りで作っていない保管単位（初期登録・分割でできた子）、別案件・用途・別の品目・別の単位の現物、取消済みの依頼には割り当てしない', () => {
    let { ledger, supply } = receive(practiceLedger, requested(), 'e1', 'R1', 'counted', 10);
    ledger = register(ledger, meta('i1', 7), lotOf('INIT'), 'counted', 50);
    ledger = split(ledger, meta('s1', 10), 'R1', 'R1-child', 'counted', 2);
    const a = (lotId: string) => ({ receiptLotId: lotId, arrived: 1, good: 1 });
    expect(() => allocateArrival(ledger, supply, meta('a1', 11), 'q1', a('INIT'))).toThrow('実際に受け取った数');
    expect(() => allocateArrival(ledger, supply, meta('a1', 11), 'q1', a('R1-child'))).toThrow('実際に受け取った数');
    expect(() => allocateArrival(ledger, supply, meta('a1', 11), 'q1', a('zzz'))).toThrow('保管単位');
    const other = receiveLot(ledger, supply, meta('e2', 10), { ...lotOf('R2'), project: { kind: 'case', id: 'A-001' } }, 'counted', 5);
    expect(() => allocateArrival(other.ledger, other.supply, meta('a1', 11), 'q1', a('R2'))).toThrow('案件・用途');
    const diffUnit = receiveLot(ledger, supply, meta('e3', 10), { ...lotOf('R3'), unit: '箱' }, 'counted', 5);
    expect(() => allocateArrival(diffUnit.ledger, diffUnit.supply, meta('a1', 11), 'q1', a('R3'))).toThrow('単位');
    const diffItem = receiveLot(ledger, supply, meta('e4', 10), { ...lotOf('R4'), item: 'Q' }, 'counted', 5);
    expect(() => allocateArrival(diffItem.ledger, diffItem.supply, meta('a1', 11), 'q1', a('R4'))).toThrow('品目');
    const cancelled = cancelRequest(supply, fixedMasters, meta('c1', 9), 'q1', '不要');
    expect(() => allocateArrival(ledger, cancelled, meta('a1', 11), 'q1', a('R1'))).toThrow('取消済み');
    expect(() => allocateArrival(ledger, supply, meta('a1', 7), 'q1', a('R1'))).toThrow('より前');
  });
});

describe('要件5 割り当ての日時', () => {
  test('受け取りの現物ができた日時より前と言える日時の割り当ては記録しない。同時刻・日時不明は記録できる', () => {
    const { ledger, supply } = receive(practiceLedger, requested(), 'e1', 'R1', 'counted', 10, 12); // 12時に受け取り
    expect(() => allocateArrival(ledger, supply, meta('a1', 10), 'q1', { receiptLotId: 'R1', arrived: 5, good: 5 })).toThrow('受け取りの現物');
    expect(allocateArrival(ledger, supply, meta('a1', 12), 'q1', { receiptLotId: 'R1', arrived: 5, good: 5 }).requests['q1']?.arrivals.length).toBe(1);
    expect(allocateArrival(ledger, supply, { ...meta('a2', 10), occurredAt: null }, 'q1', { receiptLotId: 'R1', arrived: 5, good: 5 }).requests['q1']?.arrivals.length).toBe(1);
  });
});

describe('要件5 過剰割り当ての段階的な訂正', () => {
  test('受け取り100を40・40・20に配分し、実際に受け取った数を50に訂正する。届いた数を減らす訂正は受け付け、増やす訂正は上限で拒否し、上限以下になれば増やせる', () => {
    let { ledger, supply } = receive(practiceLedger, requested(3), 'e1', 'R1', 'counted', 100);
    supply = allocateArrival(ledger, supply, meta('a1', 10), 'q1', { receiptLotId: 'R1', arrived: 40, good: 40 });
    supply = allocateArrival(ledger, supply, meta('a2', 10), 'q2', { receiptLotId: 'R1', arrived: 40, good: 40 });
    supply = allocateArrival(ledger, supply, meta('a3', 10), 'q3', { receiptLotId: 'R1', arrived: 20, good: 20 });
    supply = reviseReceipt(ledger, supply, meta('v1', 11), 'R1', 50, '実際は50個だった');
    // 合計は100のまま、上限は50。増やす訂正は拒否される。
    expect(() => reviseArrival(ledger, supply, meta('r1', 12), 'q3', 'a3', { arrived: 25, good: 20 })).toThrow('実際に受け取った数');
    // 減らす訂正と、届いた数を変えない訂正（使える数だけ）は、合計がまだ上限を超えていても受け付ける。
    supply = reviseArrival(ledger, supply, meta('r2', 12), 'q1', 'a1', { arrived: 30, good: 30 });
    supply = reviseArrival(ledger, supply, meta('r3', 13), 'q2', 'a2', { arrived: 0, good: 0 });
    supply = reviseArrival(ledger, supply, meta('r4', 13), 'q3', 'a3', { arrived: 20, good: 10 });
    expect(supply.requests['q3']?.arrivals[0]).toEqual({ id: 'a3', receiptLotId: 'R1', arrived: 20, good: 10 });
    expect(supply.log.at(-1)).toMatchObject({ kind: 'arrivalRevise', requestId: 'q3', before: { arrived: 20, good: 20 }, after: { arrived: 20, good: 10 } });
    // 合計は 30＋0＋20 で上限ちょうど。これ以上増やす訂正は拒否する。
    expect(() => reviseArrival(ledger, supply, meta('r5', 14), 'q1', 'a1', { arrived: 31, good: 31 })).toThrow('実際に受け取った数');
    // 別の配分を減らして余裕ができれば、上限までは増やせる。
    supply = reviseArrival(ledger, supply, meta('r6', 14), 'q3', 'a3', { arrived: 10, good: 10 });
    supply = reviseArrival(ledger, supply, meta('r7', 14), 'q1', 'a1', { arrived: 40, good: 40 });
    expect(allocatedOf(supply, 'q1')).toBe(40);
    expect(() => reviseArrival(ledger, supply, meta('r8', 15), 'q1', 'a1', { arrived: 41, good: 41 })).toThrow('実際に受け取った数');
  });

  test('割り当ての訂正は、取消済みの依頼でもできる。使える数は届いた数以下で、変わらない訂正と存在しない割り当て・依頼は拒否する', () => {
    let { ledger, supply } = receive(practiceLedger, requested(), 'e1', 'R1', 'counted', 100);
    supply = allocateArrival(ledger, supply, meta('a1', 10), 'q1', { receiptLotId: 'R1', arrived: 100, good: 100 });
    supply = cancelRequest(supply, fixedMasters, meta('c1', 11), 'q1', '不要になった');
    supply = reviseReceipt(ledger, supply, meta('v1', 12), 'R1', 98, '98個だった');
    expect(reviseArrival(ledger, supply, meta('r1', 13), 'q1', 'a1', { arrived: 98, good: 98 }).requests['q1']?.arrivals[0]?.arrived).toBe(98);
    expect(() => reviseArrival(ledger, supply, meta('r1', 13), 'q1', 'a1', { arrived: 98, good: 99 })).toThrow('使える数');
    expect(() => reviseArrival(ledger, supply, meta('r1', 13), 'q1', 'a1', { arrived: 100, good: 100 })).toThrow('変わっていない');
    expect(() => reviseArrival(ledger, supply, meta('r1', 13), 'q1', 'zzz', { arrived: 1, good: 1 })).toThrow('割り当て');
    expect(() => reviseArrival(ledger, supply, meta('r1', 13), 'zzz', 'a1', { arrived: 1, good: 1 })).toThrow('依頼');
    expect(() => reviseArrival(ledger, supply, meta('r1', 7), 'q1', 'a1', { arrived: 98, good: 98 })).toThrow('より前');
  });
});
