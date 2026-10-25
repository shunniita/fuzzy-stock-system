import { fixedMasters } from '../../src/domain/masters.ts';
import { describe, expect, test } from 'vitest';
import { correctOccurredAt, practiceLedger, handOver, hold, recount, register, use, type Ledger, type Meta } from '../../src/domain/ledger.ts';
import { emptySupply, recordRequest, receivedOf, type Supply } from '../../src/domain/supply.ts';
import type { Values } from '../../src/ui/dom.ts';
import { recountWithReceiptChoice, supplyOps, type Ctx, type State, type UiOp } from '../../src/ui/supply-ui.ts';

const values = (entries: Record<string, string | boolean>): Values => ({
  text: (name) => (typeof entries[name] === 'string' ? (entries[name] as string) : ''),
  checked: (name) => entries[name] === true,
});

function meta(eventId: string, hour = 9): Meta {
  const at = `2026-09-29T${String(hour).padStart(2, '0')}:00:00+09:00`;
  return { eventId, occurredAt: at, recordedAt: at, actor: '架空担当A' };
}

const ask = (s: Supply, id: string, quantity: number): Supply =>
  recordRequest(s, fixedMasters, meta(id, 8), { project: { kind: 'case', id: 'B-001' }, item: 'P', unit: '個', quantity, vendor: '架空の仕入先X', requestedOn: '2026-09-29', reply: { kind: 'none' } });

// 返却待ちの現物を実際に外へ返却した台帳（既存の台帳操作）。
const handOverForTest = (ledger: Ledger, lotId: string): Ledger => handOver(ledger, meta('op7', 11), lotId, 'counted', 4, '架空の返却先');

const ctxOf = (state: { ledger: Ledger; supply: Supply }): Ctx => ({ ledger: () => state.ledger, supply: () => state.supply });

const receiveValues = (extra: Record<string, string | boolean> = {}) => ({ newId: 'R1', item: 'P', unit: '個', project: 'B-001', location: 'S1', basis: 'counted', value: '10', ...extra });

describe('受け取り（依頼への割り当てつき）の操作', () => {
  const state = (): State => ({ ledger: practiceLedger, supply: ask(ask(emptySupply, 'q1', 8), 'q2', 8) });
  const run = (s: State, v: Record<string, string | boolean>) => supplyOps(ctxOf(s))['receive']!.run(s, meta('op10', 9), values(v), undefined);

  test('5.1: 受け取りを登録して実際に受け取った数を記録し、行がなくてもよい', () => {
    const r = run(state(), receiveValues());
    expect(r.notice).toBeUndefined();
    expect(r.state.ledger.lots['R1']?.quantity).toMatchObject({ kind: 'known', numeric: { value: 10 } });
    expect(receivedOf(r.state.supply, 'R1')).toBe(10);
    expect(r.state.supply.log.map((e) => e.eventId)).toEqual(['q1', 'q2', 'op10-c']);
  });

  test('5.2: 依頼ごとの行（最大3行）で割り当てでき、割り当てのIDは基本ID-a行番号', () => {
    const r = run(state(), receiveValues({ r1request: 'q1', r1arrived: '6', r1good: '4', r2request: 'q2', r2arrived: '4', r2good: '4' }));
    expect(r.notice).toBeUndefined();
    expect(r.state.supply.requests['q1']?.arrivals).toEqual([{ id: 'op10-a1', receiptLotId: 'R1', arrived: 6, good: 4 }]);
    expect(r.state.supply.requests['q2']?.arrivals[0]).toMatchObject({ id: 'op10-a2', arrived: 4, good: 4 });
  });

  test('B3 2.4: 受け取りと割り当て2行を、受け取りと実際に受け取った数が一組の三つの確定の単位として返す', () => {
    const r = run(state(), receiveValues({ r1request: 'q1', r1arrived: '6', r1good: '4', r2request: 'q2', r2arrived: '4', r2good: '4' }));
    expect(r.units).toHaveLength(3);
    const [receipt, first, second] = r.units ?? [];
    expect(receipt?.ledger.history.map((e) => e.eventId)).toEqual(['op10']);
    expect(receipt?.supply.receipts['R1']).toMatchObject({ received: 10, eventId: 'op10-c' });
    expect(r.units?.map((unit) => unit.supply.log.map((e) => e.eventId))).toEqual([
      ['q1', 'q2', 'op10-c'],
      ['q1', 'q2', 'op10-c', 'op10-a1'],
      ['q1', 'q2', 'op10-c', 'op10-a1', 'op10-a2'],
    ]);
    expect(receipt?.supply.requests['q1']?.arrivals).toEqual([]);
    expect(first?.supply.requests['q2']?.arrivals).toEqual([]);
    expect(first?.ledger).toBe(receipt?.ledger);
    expect(second?.ledger).toBe(receipt?.ledger);
    expect(second).toEqual(r.state);
  });

  test('B3 2.4・FH-B04: 拒否した割り当て行と後続の行は確定の単位に含めない', () => {
    const r = run(state(), receiveValues({ r1request: 'q1', r1arrived: '8', r1good: '8', r2request: 'q2', r2arrived: '5', r2good: '5', r3request: 'q1', r3arrived: '1', r3good: '1' }));
    expect(r.units).toHaveLength(2);
    expect(r.units?.at(-1)).toEqual(r.state);
    expect(r.units?.flatMap((unit) => unit.supply.log.map((e) => e.eventId))).not.toContain('op10-a2');
    expect(r.units?.flatMap((unit) => unit.supply.log.map((e) => e.eventId))).not.toContain('op10-a3');
    const rejectedFirst = run(state(), receiveValues({ r1request: 'q1', r1arrived: '11', r1good: '11' }));
    expect(rejectedFirst.units).toEqual([rejectedFirst.state]);
  });

  test('B3 3.4・AT-23: 任意の架空ラベルを受け取りの記録へ渡し、同じラベルの別箱も受け入れる', () => {
    const r = run(state(), receiveValues({ label: '0001-架空箱' }));
    expect(r.units).toEqual([r.state]);
    expect(r.state.supply.receipts['R1']?.label).toBe('0001-架空箱');
    expect(r.state.supply.log.at(-1)).toMatchObject({ kind: 'receiptRecord', label: '0001-架空箱' });
    const second = supplyOps(ctxOf(r.state))['receive']!.run(r.state, meta('op20', 10), values(receiveValues({ newId: 'R2', label: '0001-架空箱' })), undefined);
    expect(Object.keys(second.state.supply.receipts)).toEqual(['R1', 'R2']);
    expect(second.state.supply.receipts['R2']?.label).toBe('0001-架空箱');
    const omitted = run(state(), receiveValues());
    expect(omitted.state.supply.receipts['R1']?.label).toBeNull();
  });

  test('5.3・FH-B04: 割り当てが実際に受け取った数を超えて拒否されても、受け取りは記録済みで、通った行までを残し、拒否した行以降は適用しない。注意に理由と行を示す', () => {
    const r = run(state(), receiveValues({ r1request: 'q1', r1arrived: '8', r1good: '8', r2request: 'q2', r2arrived: '5', r2good: '5', r3request: 'q1', r3arrived: '1', r3good: '1' }));
    expect(r.state.ledger.lots['R1']).toBeDefined();
    expect(receivedOf(r.state.supply, 'R1')).toBe(10);
    expect(r.state.supply.requests['q1']?.arrivals.map((a) => a.id)).toEqual(['op10-a1']);
    expect(r.state.supply.requests['q2']?.arrivals).toEqual([]);
    expect(r.notice).toContain('受け取りは記録した');
    expect(r.notice).toContain('2行目');
    expect(r.notice).toContain('実際に受け取った数');
    expect(r.notice).toContain('1行目まで');
    // 記録された最後の操作IDを示す。割り当てが一件も通らなければ、受け取りの実際に受け取った数の記録のID。
    expect(r.notice).toContain('最後に記録した操作はop10-a1');
    const none = run(state(), receiveValues({ r1request: 'q1', r1arrived: '11', r1good: '11' }));
    expect(none.notice).toContain('最後に記録した操作はop10-c');
  });

  test('入力の形の誤り（行の数の不足・依頼なしで数だけ入力）は、何も記録せずに例外にする。受け取りの登録の誤りも同じ', () => {
    const s = state();
    expect(() => run(s, receiveValues({ r1request: 'q1', r1arrived: '', r1good: '1' }))).toThrow('届いた数');
    expect(() => run(s, receiveValues({ r1request: 'q1', r1arrived: '1', r1good: '' }))).toThrow('使える数');
    expect(() => run(s, receiveValues({ r1request: '', r1arrived: '1' }))).toThrow('依頼を選ぶ');
    expect(() => run(s, receiveValues({ location: 'ZZ' }))).toThrow('場所');
    expect(s.ledger.history.length).toBe(0);
  });

  test('数が不明の受け取りは登録できるが実際に受け取った数は記録されず、割り当ての行は拒否の注意になる', () => {
    const r = run(state(), receiveValues({ basis: 'unknown', value: '', r1request: 'q1', r1arrived: '1', r1good: '1' }));
    expect(r.state.ledger.lots['R1']).toBeDefined();
    expect(receivedOf(r.state.supply, 'R1')).toBeNull();
    expect(r.notice).toContain('受け取りは記録した');
  });
});

describe('受け入れた現物への割り当て・実際に受け取った数の訂正・割り当ての訂正の操作', () => {
  const received = (): State => {
    const s0: State = { ledger: practiceLedger, supply: ask(emptySupply, 'q1', 100) };
    return supplyOps(ctxOf(s0))['receive']!.run(s0, meta('op10', 9), values(receiveValues({ value: '100' })), undefined).state;
  };
  const op = (s: State, name: string) => supplyOps(ctxOf(s))[name]!;

  test('受け入れた現物から選んで割り当てできる。上限を超える割り当ては例外（この操作は受け取りを作らないので、全体が未適用）', () => {
    const s = received();
    const r = op(s, 'allocate').run(s, meta('op12', 10), values({ receipt: 'R1', request: 'q1', arrived: '60', good: '60' }), undefined);
    expect(r.state.supply.requests['q1']?.arrivals[0]).toMatchObject({ id: 'op12', arrived: 60 });
    expect(() => op(s, 'allocate').run(s, meta('op12', 10), values({ receipt: 'R1', request: 'q1', arrived: '101', good: '101' }), undefined)).toThrow('実際に受け取った数');
  });

  test('実際に受け取った数を理由つきで訂正でき、割り当てを訂正できる（割り当ては依頼IDと割り当てIDの組で選ぶ）', () => {
    let s = received();
    s = op(s, 'allocate').run(s, meta('op12', 10), values({ receipt: 'R1', request: 'q1', arrived: '100', good: '100' }), undefined).state;
    s = op(s, 'receiptRevise').run(s, meta('op13', 11), values({ receipt: 'R1', received: '98', reason: '98個だった' }), undefined).state;
    expect(receivedOf(s.supply, 'R1')).toBe(98);
    s = op(s, 'arrivalRevise').run(s, meta('op14', 12), values({ arrival: 'q1/op12', arrived: '98', good: '98' }), undefined).state;
    expect(s.supply.requests['q1']?.arrivals[0]).toMatchObject({ arrived: 98, good: 98 });
  });
});

describe('数え直しでの実際に受け取った数の扱い（必須の選択）', () => {
  // 台帳の数え直しだけを行う、基の操作の代わり。
  const base: UiOp = {
    label: '数えて確認・訂正',
    fields: () => [],
    run: (s, m, v, inc) => ({ state: { ...s, ledger: recount(s.ledger, m, v.text('lot'), Number(v.text('value')), { kind: 'unknown' }, inc) } }),
  };

  const withReceipt = (): State => {
    const s0: State = { ledger: practiceLedger, supply: ask(emptySupply, 'q1', 100) };
    return supplyOps(ctxOf(s0))['receive']!.run(s0, meta('op10', 8), values(receiveValues({ basis: 'counted', value: '100' })), undefined).state;
  };
  const wrapped = (s: State) => recountWithReceiptChoice(base, ctxOf(s));

  test('受け取りの元の保管単位を数え直すとき、実際に受け取った数の扱いを選ぶまで記録しない', () => {
    const s = withReceipt();
    expect(() => wrapped(s).run(s, meta('op12', 9), values({ lot: 'R1', value: '98' }), undefined)).toThrow('実際に受け取った数の扱い');
    expect(s.ledger.history.length).toBe(1);
  });

  test('「訂正する」は数え直しと実際に受け取った数の訂正を、異なる操作ID（基本IDと基本ID-rc）で一回の入力に記録する。以後98を超える割り当ては拒否される', () => {
    const s = withReceipt();
    const r = wrapped(s).run(s, meta('op12', 9), values({ lot: 'R1', value: '98', receiptEffect: 'revise', causeUnknown: true }), undefined);
    expect(r.state.ledger.history.at(-1)).toMatchObject({ kind: 'recount', eventId: 'op12' });
    expect(r.state.supply.log.at(-1)).toMatchObject({ kind: 'receiptRevise', eventId: 'op12-rc', before: 100, after: 98, reason: '原因不明' });
    expect(receivedOf(r.state.supply, 'R1')).toBe(98);
  });

  test('「変えない」は数え直しだけを記録し、実際に受け取った数は100のまま。実際に受け取った数が数えた数と同じなら、訂正は記録しない', () => {
    const s = withReceipt();
    const keep = wrapped(s).run(s, meta('op12', 9), values({ lot: 'R1', value: '98', receiptEffect: 'keep' }), undefined);
    expect(receivedOf(keep.state.supply, 'R1')).toBe(100);
    expect(keep.state.supply.log.length).toBe(s.supply.log.length);
    const same = wrapped(s).run(s, meta('op12', 9), values({ lot: 'R1', value: '100', receiptEffect: 'revise' }), undefined);
    expect(same.state.supply.log.length).toBe(s.supply.log.length);
  });

  test('「訂正する」で同じ数を数えても、いまの実際に受け取った数の訂正が受け取りより前になっているときは、記録し直す', () => {
    const s = withReceipt(); // 8時に受け取り100
    const revised = wrapped(s).run(s, meta('op12', 9), values({ lot: 'R1', value: '98', receiptEffect: 'revise', causeUnknown: true }), undefined).state;
    // 受け取りの日時を、訂正（9時）より後の10時へ訂正する。
    const moved: State = { ...revised, ledger: correctOccurredAt(revised.ledger, meta('op14', 10), 'op10', '2026-09-29T10:00:00+09:00') };
    const r = wrapped(moved).run(moved, meta('op16', 11), values({ lot: 'R1', value: '98', receiptEffect: 'revise', causeText: '受け取りのあとに確かめた' }), undefined);
    expect(r.state.supply.receipts['R1']).toEqual({ received: 98, provisional: false, eventId: 'op16-rc', label: null });
  });

  test('数が不明の受け取りを数え直すとき「逆算する」を選ぶと、数えた残りにそれまでに減らした数を足して、仮の実際に受け取った数を記録する', () => {
    const s0: State = { ledger: practiceLedger, supply: emptySupply };
    let s = supplyOps(ctxOf(s0))['receive']!.run(s0, meta('op1', 8), values(receiveValues({ newId: 'U1', basis: 'unknown', value: '' })), undefined).state;
    s = { ...s, ledger: use(s.ledger, meta('op3', 9), 'U1', 'counted', 30, '架空作業') };
    const r = wrapped(s).run(s, meta('op5', 10), values({ lot: 'U1', value: '20', receiptEffect: 'derive', causeText: '残りを数えた' }), undefined);
    expect(r.state.supply.receipts['U1']).toEqual({ received: 50, provisional: true, eventId: 'op5-rc', label: null });
    // 減らした数に不明があれば逆算できないので、記録しない。
    const vague = { ...s, ledger: use(s.ledger, meta('op4', 9), 'U1', 'unknown', null, '架空作業') };
    expect(() => wrapped(vague).run(vague, meta('op5', 10), values({ lot: 'U1', value: '20', receiptEffect: 'derive', causeText: '残りを数えた' }), undefined)).toThrow('逆算');
  });

  test('表示の数（ラベル・パッケージ）の受け取りを使い切ったあとに残りが見つかったら、「逆算する」で残りを台帳に入れ、仮の実際に受け取った数を記録する', () => {
    const s0: State = { ledger: practiceLedger, supply: emptySupply };
    let s = supplyOps(ctxOf(s0))['receive']!.run(s0, meta('op1', 8), values(receiveValues({ newId: 'L1', basis: 'label', value: '100' })), undefined).state;
    s = { ...s, ledger: use(s.ledger, meta('op3', 9), 'L1', 'counted', 100, '架空作業') };
    const r = wrapped(s).run(s, meta('op5', 10), values({ lot: 'L1', value: '5', receiptEffect: 'derive', causeText: '使い切ったはずの箱に残っていた' }), undefined);
    expect(r.state.supply.receipts['L1']).toEqual({ received: 105, provisional: true, eventId: 'op5-rc', label: null });
    expect(r.state.ledger.lots['L1']?.quantity).toMatchObject({ kind: 'known', numeric: { value: 5, unconfirmed: 'none' } });
  });

  test('「訂正する」で数えた数が空欄・数でないときは、実際に受け取った数を0にせず拒否する（基の操作が空欄を検査しない場合も）', () => {
    const s = withReceipt();
    // 空欄を検査しない基の操作。数え直しは台帳に記録されるが、実際に受け取った数の訂正は拒否され、全体が未適用になる。
    const lenient: UiOp = { label: 'x', fields: () => [], run: (st) => ({ state: st }) };
    expect(() => recountWithReceiptChoice(lenient, ctxOf(s)).run(s, meta('op12', 9), values({ lot: 'R1', value: '', receiptEffect: 'revise', causeUnknown: true }), undefined)).toThrow('数えた数');
    expect(() => recountWithReceiptChoice(lenient, ctxOf(s)).run(s, meta('op12', 9), values({ lot: 'R1', value: 'abc', receiptEffect: 'revise', causeUnknown: true }), undefined)).toThrow('数えた数');
  });

  test('実際に受け取った数の記録のない現物（初期登録）には選択を求めず、そのまま数え直せる', () => {
    const init: State = { ledger: register(practiceLedger, meta('op1', 8), { id: 'INIT', item: 'P', unit: '個', project: { kind: 'case', id: 'B-001' }, location: 'S1' }, 'unknown', null), supply: emptySupply };
    const r = wrapped(init).run(init, meta('op2', 9), values({ lot: 'INIT', value: '50' }), undefined);
    expect(r.state.ledger.lots['INIT']?.quantity).toMatchObject({ kind: 'known', numeric: { value: 50 } });
    expect(r.state.supply).toBe(init.supply);
  });

  test('数が不明で受け入れた現物は、数え直しで実際に受け取った数の扱いを選ばせ、「訂正する」で未確認の実際に受け取った数を確定する', () => {
    const s0: State = { ledger: practiceLedger, supply: emptySupply };
    const init = supplyOps(ctxOf(s0))['receive']!.run(s0, meta('op1', 8), values(receiveValues({ newId: 'U1', basis: 'unknown', value: '' })), undefined).state;
    expect(init.supply.receipts['U1']).toEqual({ received: null, provisional: false, eventId: 'op1-c', label: null });
    expect(() => wrapped(init).run(init, meta('op2', 9), values({ lot: 'U1', value: '50' }), undefined)).toThrow('実際に受け取った数の扱い');
    const r = wrapped(init).run(init, meta('op2', 9), values({ lot: 'U1', value: '50', receiptEffect: 'revise', causeText: '数えて確定' }), undefined);
    expect(receivedOf(r.state.supply, 'U1')).toBe(50);
  });

  test('保留された数え直し（後入力で未反映）では、実際に受け取った数を訂正しないで、注意を出す', () => {
    const s = withReceipt();
    // 数え直しより前の日時に数え直しを後入力し、包含を「不明」と答えて保留する。
    const first = wrapped(s).run(s, meta('op12', 10), values({ lot: 'R1', value: '100', receiptEffect: 'keep' }), undefined).state;
    const r = wrapped(first).run(first, meta('op14', 9), values({ lot: 'R1', value: '98', receiptEffect: 'revise' }), 'unknown');
    expect(r.state.ledger.history.at(-1)).toMatchObject({ kind: 'recount', applied: false });
    expect(receivedOf(r.state.supply, 'R1')).toBe(100);
    expect(r.notice).toContain('保留');
  });
});

describe('余った分の振り分け・予備から案件・用途用への交換・受領確認・残量区分の操作', () => {
  const received106 = (): State => {
    const s0: State = { ledger: practiceLedger, supply: emptySupply };
    return supplyOps(ctxOf(s0))['receive']!.run(s0, meta('op1', 8), values(receiveValues({ value: '106' })), undefined).state;
  };
  const op = (s: State, name: string) => supplyOps(ctxOf(s))[name]!;
  const usable = (s: State) => {
    const q = Object.values(s.ledger.lots).filter((l) => l.mergedInto === null && l.holds.length === 0).reduce((n, l) => n + (l.quantity.kind === 'known' ? l.quantity.numeric.value : 0), 0);
    return q;
  };

  test('10.1: 受け取りの一部を予備・返却待ちに割り当てる。分けた分に取り分けた理由とメモが付き、在庫の総数は変わらない（案件・用途用100・予備2・返却待ち4）', () => {
    let s = received106();
    s = op(s, 'surplusAllocate').run(s, meta('op3', 9), values({ lot: 'R1', childId: 'R1-sp', basis: 'counted', value: '2', destination: 'spare', note: '破損への備え' }), undefined).state;
    s = op(s, 'surplusAllocate').run(s, meta('op5', 10), values({ lot: 'R1', childId: 'R1-ret', basis: 'counted', value: '4', destination: 'returnPending' }), undefined).state;
    expect(s.ledger.lots['R1-sp']?.holds).toEqual(['spare']);
    expect(s.ledger.lots['R1-ret']?.holds).toEqual(['returnPending']);
    expect(s.ledger.history.find((e) => e.eventId === 'op3-h')).toMatchObject({ kind: 'hold', reason: 'spare', note: '破損への備え' });
    expect(usable(s)).toBe(100);
    const total = Object.values(s.ledger.lots).filter((l) => l.mergedInto === null).reduce((n, l) => n + (l.quantity.kind === 'known' ? l.quantity.numeric.value : 0), 0);
    expect(total).toBe(106);
  });

  test('割当先は予備か返却待ちだけ。分けられない数（親を超える数）は、親を減らさず台帳の既存の保留の規則に従う（子は作られ、取り分けた理由も付く）', () => {
    const s = received106();
    expect(() => op(s, 'surplusAllocate').run(s, meta('op3'), values({ lot: 'R1', childId: 'X', basis: 'counted', value: '2', destination: 'defective' }), undefined)).toThrow('割当先');
  });

  test('10.4: 予備を案件・用途用へ移す交換は、理由が必須。全量ならそのまま外し、一部なら先に分けて外す。移した分は使用可能数に入る', () => {
    let s = received106();
    s = op(s, 'surplusAllocate').run(s, meta('op3', 9), values({ lot: 'R1', childId: 'R1-sp', basis: 'counted', value: '4', destination: 'spare' }), undefined).state;
    expect(() => op(s, 'spareSwap').run(s, meta('op5', 10), values({ lot: 'R1-sp', childId: 'R1-sw', value: '1', note: '' }), undefined)).toThrow('理由');
    const part = op(s, 'spareSwap').run(s, meta('op5', 10), values({ lot: 'R1-sp', childId: 'R1-sw', value: '1', note: '1個破損したので交換' }), undefined).state;
    expect(part.ledger.lots['R1-sw']?.holds).toEqual([]);
    expect(part.ledger.lots['R1-sp']?.holds).toEqual(['spare']);
    expect(part.ledger.history.find((e) => e.eventId === 'op5-r')).toMatchObject({ kind: 'release', reason: 'spare', note: '1個破損したので交換' });
    const whole = op(s, 'spareSwap').run(s, meta('op5', 10), values({ lot: 'R1-sp', childId: '', value: '', note: '全部交換する' }), undefined).state;
    expect(whole.ledger.lots['R1-sp']?.holds).toEqual([]);
    expect(usable(whole)).toBe(106);
  });

  test('10.4: 予備から案件・用途用への交換は、案件・用途に属する予備だけ。共通・所属不明の予備は、案件・用途用にならないので拒否する', () => {
    const common = register(practiceLedger, meta('op1', 8), { id: 'C1', item: 'P', unit: '個', project: { kind: 'common' }, location: 'S1' }, 'counted', 5);
    const s: State = { ledger: hold(common, meta('op2', 9), 'C1', 'spare', '共通の予備'), supply: emptySupply };
    expect(() => op(s, 'spareSwap').run(s, meta('op3', 10), values({ lot: 'C1', childId: '', value: '', note: '交換' }), undefined)).toThrow('案件・用途');
  });

  test('10.8: 実返却を選んで受領確認を記録できる。在庫は変わらず、確認済み・未反映・取消済みの引渡しは選べない', () => {
    let s = received106();
    s = op(s, 'surplusAllocate').run(s, meta('op3', 9), values({ lot: 'R1', childId: 'R1-ret', basis: 'counted', value: '4', destination: 'returnPending' }), undefined).state;
    s = { ...s, ledger: handOverForTest(s.ledger, 'R1-ret') };
    const handoverId = s.ledger.history.find((e) => e.kind === 'handover')!.eventId;
    const before = s.ledger;
    const acked = op(s, 'returnAck').run(s, meta('op9', 12), values({ handover: handoverId }), undefined).state;
    expect(acked.supply.acks[handoverId]).toBe('op9');
    expect(acked.ledger).toBe(before);
    expect(() => op(acked, 'returnAck').run(acked, meta('op10', 13), values({ handover: handoverId }), undefined)).toThrow('受領確認済み');
  });

  test('8.6: 数が不明の開封分に残量区分を記録できる', () => {
    const s0: State = { ledger: practiceLedger, supply: emptySupply };
    const s = supplyOps(ctxOf(s0))['receive']!.run(s0, meta('op1', 8), values(receiveValues({ newId: 'V1', item: 'V', unit: '本', project: 'common', basis: 'unknown', value: '' })), undefined).state;
    const r = op(s, 'remainder').run(s, meta('op2', 9), values({ lot: 'V1', level: 'few' }), undefined).state;
    expect(r.supply.levels['V1']).toMatchObject({ level: 'few', eventId: 'op2' });
  });
});
