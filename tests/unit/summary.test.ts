import { fixedMasters } from '../../src/domain/masters.ts';
import { describe, expect, test } from 'vitest';
import { correctOccurredAt, practiceLedger, hold, register, split, type Ledger, type Meta, type Project } from '../../src/domain/ledger.ts';
import {
  allocateArrival,
  cancelRequest,
  declareShortage,
  emptySupply,
  linkDeclaration,
  receiveLot,
  recordRequest,
  registerNeed,
  reviseArrival,
  reviseReceipt,
  type Supply,
} from '../../src/domain/supply.ts';
import { requestSummaryOf, shortageOf, type GroupKey } from '../../src/domain/shortage.ts';

const b001: Project & { kind: 'case' } = { kind: 'case', id: 'B-001' };
const a001: Project & { kind: 'case' } = { kind: 'case', id: 'A-001' };
const key: GroupKey = { project: b001, item: 'P', unit: '個' };

function meta(eventId: string, hour = 9): Meta {
  const at = `2026-10-02T${String(hour).padStart(2, '0')}:00:00+09:00`;
  return { eventId, occurredAt: at, recordedAt: at, actor: '架空担当A' };
}

const lotOf = (id: string, project: Project = b001) => ({ id, item: 'P', unit: '個', project, location: 'S1' });
const need = (value: number | null = 100, basis: 'counted' | 'unknown' = 'counted', project: Project & { kind: 'case' } = b001): Supply =>
  registerNeed(emptySupply, fixedMasters, meta(`n-${project.id}`, 7), { project, item: 'P', unit: '個', required: { basis, value }, dueDate: '2026-10-10', source: '架空', revision: '初版' });
const ask = (s: Supply, id: string, quantity: number, project: Project = b001): Supply =>
  recordRequest(s, fixedMasters, meta(id, 8), { project, item: 'P', unit: '個', quantity, vendor: '架空の仕入先X', requestedOn: '2026-10-02', reply: { kind: 'none' } });

// 必要100に対して在庫95の案件・用途B-001。不足5。
const shortBy5 = (): { ledger: Ledger; supply: Supply } => ({ ledger: register(practiceLedger, meta('r1', 8), lotOf('L1'), 'counted', 95), supply: need() });

const summary = (ledger: Ledger, supply: Supply, k: GroupKey = key) => requestSummaryOf(ledger, supply, k);

describe('要件4 依頼の四つの数', () => {
  test('4.4: 不足5で依頼する前は手配対象数5。依頼5を記録すると依頼済み5・未着5・手配対象数0（依頼しただけでは在庫は増えない）', () => {
    let { ledger, supply } = shortBy5();
    expect(summary(ledger, supply)).toMatchObject({ effectiveShortage: 5, ordered: 0, outstanding: 0, toOrder: 5, possiblyUnneeded: [] });
    supply = ask(supply, 'q1', 5);
    expect(summary(ledger, supply)).toMatchObject({ effectiveShortage: 5, ordered: 5, outstanding: 5, toOrder: 0, possiblyUnneeded: [] });
    expect(shortageOf(ledger, supply, key).shortage).toBe(5);
  });

  test('AT-17・5.5: 不足5・依頼5で良品3個を受け取ると、不足2・依頼の未着2・手配対象数0。依頼済みは5のまま', () => {
    let { ledger, supply } = shortBy5();
    supply = ask(supply, 'q1', 5);
    const r = receiveLot(ledger, supply, meta('e1', 10), lotOf('R3'), 'counted', 3);
    ledger = r.ledger;
    supply = allocateArrival(ledger, r.supply, meta('a1', 10), 'q1', { receiptLotId: 'R3', arrived: 3, good: 3 });
    expect(shortageOf(ledger, supply, key).shortage).toBe(2);
    expect(summary(ledger, supply)).toMatchObject({ effectiveShortage: 2, ordered: 5, outstanding: 2, toOrder: 0, arrived: 3, goodApplied: 3 });
  });

  test('AT-18・5.4: 不足5の補充として5個届くが2個が不良。到着5・不足解消3・残り不足2（到着しただけでは全解決としない）', () => {
    let { ledger, supply } = shortBy5();
    supply = ask(supply, 'q1', 5);
    const r = receiveLot(ledger, supply, meta('e1', 9), lotOf('R5'), 'counted', 5);
    ledger = split(r.ledger, meta('s1', 10), 'R5', 'R5-bad', 'counted', 2);
    ledger = hold(ledger, meta('h1', 10), 'R5-bad', 'defective');
    supply = allocateArrival(ledger, r.supply, meta('a1', 10), 'q1', { receiptLotId: 'R5', arrived: 5, good: 3 });
    expect(shortageOf(ledger, supply, key).shortage).toBe(2);
    expect(summary(ledger, supply)).toMatchObject({ effectiveShortage: 2, outstanding: 0, toOrder: 2, arrived: 5, goodApplied: 3 });
  });

  test('取消した依頼は依頼済み・未着に数えないが、届いた届いた数は数える（現物は届いている）', () => {
    let { ledger, supply } = shortBy5();
    supply = ask(supply, 'q1', 5);
    supply = ask(supply, 'q2', 3);
    const r = receiveLot(ledger, supply, meta('e1', 10), lotOf('R2'), 'counted', 2);
    supply = allocateArrival(r.ledger, r.supply, meta('a1', 10), 'q2', { receiptLotId: 'R2', arrived: 2, good: 2 });
    supply = cancelRequest(supply, fixedMasters, meta('c1', 11), 'q2', '不要');
    expect(summary(r.ledger, supply)).toMatchObject({ ordered: 5, outstanding: 5, arrived: 2 });
  });

  test('12.4: 別の群（案件・用途）の依頼・申告は数えない', () => {
    let { ledger, supply } = shortBy5();
    supply = ask(supply, 'q1', 5);
    supply = ask(supply, 'q2', 9, a001);
    expect(summary(ledger, supply)).toMatchObject({ ordered: 5, outstanding: 5 });
  });
});

describe('要件3・4 実効の不足', () => {
  test('3.2: 自動の不足が求まる間は、対応付けた申告は数えない（同じ不足5を10にしない）。対応付けていない申告は別の不足として足す', () => {
    let { ledger, supply } = shortBy5();
    supply = declareShortage(supply, fixedMasters, meta('d1', 8), { project: b001, item: 'P', unit: '個', value: 5, reason: '現場の申告' });
    supply = declareShortage(supply, fixedMasters, meta('d2', 8), { project: b001, item: 'P', unit: '個', value: 3, reason: '別の不足' });
    supply = linkDeclaration(supply, fixedMasters, meta('l1', 8), 'd1', true);
    expect(summary(ledger, supply).effectiveShortage).toBe(8);
  });

  test('3.2: 自動の不足が判定不能のときは、対応付けた申告（群に一件）が代わりになる。二重に数えない', () => {
    const ledger = register(practiceLedger, meta('r1', 8), lotOf('L1'), 'unknown', null);
    let supply = need();
    supply = declareShortage(supply, fixedMasters, meta('d1', 8), { project: b001, item: 'P', unit: '個', value: 5, reason: '現場の申告' });
    supply = declareShortage(supply, fixedMasters, meta('d2', 8), { project: b001, item: 'P', unit: '個', value: 5, reason: '同じ不足の二件目' });
    supply = linkDeclaration(supply, fixedMasters, meta('l1', 8), 'd1', true);
    expect(shortageOf(ledger, supply, key).judgement.kind).toBe('undecidable');
    // d1（対応付け）の5と、d2（対応付けていない別の不足）の5。二件目を対応付けられない（群に一件）ので、10は別の不足として扱われる。
    expect(summary(ledger, supply).effectiveShortage).toBe(10);
    expect(() => linkDeclaration(supply, fixedMasters, meta('l2', 8), 'd2', true)).toThrow('一件');
  });

  test('判定不能で、対応付けた申告がなければ実効の不足は不明のまま。手配対象数は0でなく保留（null）、不要の可能性も保留（null）', () => {
    let supply = need(null, 'unknown');
    supply = ask(supply, 'q1', 5);
    const ledger = register(practiceLedger, meta('r1', 8), lotOf('L1'), 'counted', 100);
    expect(shortageOf(ledger, supply, key).judgement.kind).toBe('undecidable');
    expect(summary(ledger, supply)).toMatchObject({ effectiveShortage: null, ordered: 5, outstanding: 5, toOrder: null, possiblyUnneeded: null });
  });

  test('判定不能で、対応付けていない申告だけがあっても、自動の項が不明なので全体は不明のまま', () => {
    let supply = need(null, 'unknown');
    supply = declareShortage(supply, fixedMasters, meta('d1', 8), { project: b001, item: 'P', unit: '個', value: 3, reason: '別の不足' });
    expect(summary(practiceLedger, supply).effectiveShortage).toBeNull();
  });

  test('必要な数が未登録の群は、自動の項はなく、申告の値の和。申告がなければ不明（依頼だけの群）。申告に不明があれば不明', () => {
    let supply = declareShortage(emptySupply, fixedMasters, meta('d1', 8), { project: b001, item: 'P', unit: '個', value: 5, reason: '足りない' });
    supply = declareShortage(supply, fixedMasters, meta('d2', 8), { project: b001, item: 'P', unit: '個', value: 2, reason: '別の不足' });
    expect(summary(practiceLedger, supply).effectiveShortage).toBe(7);
    expect(summary(practiceLedger, supply)).toMatchObject({ toOrder: 7 });
    expect(summary(practiceLedger, ask(emptySupply, 'q1', 4))).toMatchObject({ effectiveShortage: null, toOrder: null, outstanding: 4 });
    supply = declareShortage(supply, fixedMasters, meta('d3', 8), { project: b001, item: 'P', unit: '個', value: null, reason: '数は不明' });
    expect(summary(practiceLedger, supply).effectiveShortage).toBeNull();
  });
});

describe('手動の不足申告と、申告より後に届いた良品', () => {
  const decl = (s: Supply, id: string, value: number | null, hour: number): Supply =>
    declareShortage(s, fixedMasters, meta(id, hour), { project: b001, item: 'P', unit: '個', value, reason: '現場の申告' });
  const deliver = (s: Supply, ledger: Ledger, lot: string, good: number, hour: number): { ledger: Ledger; supply: Supply } => {
    const r = receiveLot(ledger, s, meta(`e-${lot}`, hour), lotOf(lot), 'counted', good);
    return { ledger: r.ledger, supply: allocateArrival(r.ledger, r.supply, meta(`a-${lot}`, hour), 'q1', { receiptLotId: lot, arrived: good, good }) };
  };

  test('古い依頼で届いた良品は、あとから見つけた別の足りない分の記録を減らさない。申告より後に届いた良品だけが、その申告を減らす', () => {
    let supply = ask(emptySupply, 'q1', 5);
    supply = decl(supply, 'd1', 5, 8);
    let r = deliver(supply, practiceLedger, 'R1', 5, 9); // d1（5）が解消
    expect(summary(r.ledger, r.supply).effectiveShortage).toBe(0);
    supply = decl(r.supply, 'd2', 3, 10); // 10時に見つけた別の不足。9時に届いた5個は関係しない
    expect(summary(r.ledger, supply).effectiveShortage).toBe(3);
    r = deliver(supply, r.ledger, 'R2', 2, 11);
    expect(summary(r.ledger, r.supply).effectiveShortage).toBe(1);
  });

  test('日時不明の到着は、記録した順の位置に置く。11時の到着、12時の申告、そのあとに記録した日時不明の到着では、11時の到着が自動の不足を埋め、日時不明の到着が申告を解消する', () => {
    let { ledger, supply } = shortBy5(); // 自動の不足5
    supply = ask(supply, 'q1', 10);
    let r = receiveLot(ledger, supply, meta('e1', 11), lotOf('R1'), 'counted', 5);
    supply = allocateArrival(r.ledger, r.supply, meta('a1', 11), 'q1', { receiptLotId: 'R1', arrived: 5, good: 5 });
    supply = declareShortage(supply, fixedMasters, meta('d1', 12), { project: b001, item: 'P', unit: '個', value: 5, reason: '別の不足' });
    const unknown = { ...meta('e2', 13), occurredAt: null };
    r = receiveLot(r.ledger, supply, unknown, lotOf('R2'), 'counted', 5);
    supply = allocateArrival(r.ledger, r.supply, { ...unknown, eventId: 'a2' }, 'q1', { receiptLotId: 'R2', arrived: 5, good: 5 });
    expect(summary(r.ledger, supply)).toMatchObject({ effectiveShortage: 0, toOrder: 0 });
  });

  test('日時不明の到着をはさんで、日時の分かる到着の前後が記録した順と食い違うときは、申告の解消を決めず、実効の不足を不明にする', () => {
    let supply = ask(emptySupply, 'q1', 3);
    const arrive = (l: Ledger, s: Supply, lot: string, m: Meta) => {
      const r = receiveLot(l, s, m, lotOf(lot), 'counted', 1);
      return { ledger: r.ledger, supply: allocateArrival(r.ledger, r.supply, { ...m, eventId: `a-${lot}` }, 'q1', { receiptLotId: lot, arrived: 1, good: 1 }) };
    };
    let r = arrive(practiceLedger, supply, 'R1', meta('e1', 11));
    supply = decl(r.supply, 'd1', 1, 9);
    r = arrive(r.ledger, supply, 'R2', { ...meta('e2', 12), occurredAt: null });
    r = arrive(r.ledger, r.supply, 'R3', meta('e3', 10));
    expect(summary(r.ledger, r.supply)).toMatchObject({ effectiveShortage: null, toOrder: null });
  });

  test('申告と到着を合わせた並びで前後が両立しない（11時の申告、日時不明の到着、10時の申告の順に記録）ときも、実効の不足を不明にする', () => {
    let supply = ask(emptySupply, 'q1', 3);
    supply = decl(supply, 'd1', 1, 11);
    const unknown = { ...meta('e1', 12), occurredAt: null };
    const r = receiveLot(practiceLedger, supply, unknown, lotOf('R1'), 'counted', 1);
    supply = allocateArrival(r.ledger, r.supply, { ...unknown, eventId: 'a1' }, 'q1', { receiptLotId: 'R1', arrived: 1, good: 1 });
    supply = decl(supply, 'd2', 1, 10);
    expect(summary(r.ledger, supply)).toMatchObject({ effectiveShortage: null, toOrder: null });
  });

  test('申告より前に受け入れた現物を、申告のあとで割り当てしても、その申告は解消しない（到着の前後は、割り当ての操作ではなく受け取りの日時で決める）', () => {
    let supply = ask(emptySupply, 'q1', 5);
    const r = receiveLot(practiceLedger, supply, meta('e1', 9), lotOf('R1'), 'counted', 5); // 9時に受け取り
    supply = decl(r.supply, 'd1', 5, 10); // 10時に別の不足を申告
    supply = allocateArrival(r.ledger, supply, meta('a1', 11), 'q1', { receiptLotId: 'R1', arrived: 5, good: 5 }); // 11時に割り当て
    expect(summary(r.ledger, supply).effectiveShortage).toBe(5);
  });

  test('申告のない依頼で良品5が届いたあとに、別の不足3を申告しても、実効の不足は3（届いた良品で隠さない）', () => {
    const supply = ask(emptySupply, 'q1', 5);
    const r = deliver(supply, practiceLedger, 'R1', 5, 9);
    expect(summary(r.ledger, decl(r.supply, 'd1', 3, 10)).effectiveShortage).toBe(3);
  });

  test('良品は、古い申告から順に充てる。一回の到着で複数の申告にまたがってもよく、申告の合計を超える分は無視する', () => {
    let supply = ask(emptySupply, 'q1', 20);
    supply = decl(supply, 'd1', 5, 8);
    let r = deliver(supply, practiceLedger, 'R1', 3, 9); // d1 残2
    supply = decl(r.supply, 'd2', 4, 10);
    r = deliver(supply, r.ledger, 'R2', 4, 11); // d1 残2→0、d2 残4→2
    expect(summary(r.ledger, r.supply).effectiveShortage).toBe(2);
    r = deliver(r.supply, r.ledger, 'R3', 9, 12); // 余りは無視。0未満にならない
    expect(summary(r.ledger, r.supply).effectiveShortage).toBe(0);
  });

  test('申告と到着の前後は、記録した順ではなく実際の日時で決める。10時の申告を先に記録しても、あとから記録した9時の到着では解消しない。9時の到着を先に記録し、8時の申告をあとから記録したときは、到着が申告より後なので解消する', () => {
    // 10時の申告を先に記録、9時の到着をあとから記録（後入力）。到着は申告より前に起きたので、この申告を解消しない。
    let supply = ask(emptySupply, 'q1', 5);
    supply = decl(supply, 'd1', 5, 10);
    let r = deliver(supply, practiceLedger, 'R1', 5, 9);
    expect(summary(r.ledger, r.supply).effectiveShortage).toBe(5);
    // 9時の到着を先に記録し、8時の申告をあとから記録（後入力）。到着は申告より後に起きたので、解消する。
    supply = ask(emptySupply, 'q1', 5);
    r = deliver(supply, practiceLedger, 'R1', 5, 9);
    expect(summary(r.ledger, decl(r.supply, 'd1', 5, 8)).effectiveShortage).toBe(0);
  });

  test('同時刻の申告と到着は、記録した順で前後を決める。到着を先に記録した同時刻の申告は解消しない。申告を先に記録した同時刻の到着は解消する', () => {
    let supply = ask(emptySupply, 'q1', 5);
    const r = deliver(supply, practiceLedger, 'R1', 5, 10); // 10時の到着を先に記録
    expect(summary(r.ledger, decl(r.supply, 'd1', 5, 10)).effectiveShortage).toBe(5); // 同じ10時の申告をあとに記録
    supply = decl(ask(emptySupply, 'q1', 5), 'd1', 5, 10); // 10時の申告を先に記録
    const r2 = deliver(supply, practiceLedger, 'R1', 5, 10); // 同じ10時の到着をあとに記録
    expect(summary(r2.ledger, r2.supply).effectiveShortage).toBe(0);
  });

  test('日時が分からない申告・到着は、記録した順で前後を決める（日時が分かる記録とは、日時の分かる側を前後の根拠にできないので記録した順）', () => {
    let supply = ask(emptySupply, 'q1', 5);
    supply = declareShortage(supply, fixedMasters, { ...meta('d1', 10), occurredAt: null }, { project: b001, item: 'P', unit: '個', value: 5, reason: '現場の申告' });
    const r = receiveLot(practiceLedger, supply, meta('e-R1', 9), lotOf('R1'), 'counted', 5);
    const after = allocateArrival(r.ledger, r.supply, meta('a-R1', 9), 'q1', { receiptLotId: 'R1', arrived: 5, good: 5 });
    expect(summary(r.ledger, after).effectiveShortage).toBe(0); // 申告のあとに記録された到着
    const first = receiveLot(practiceLedger, ask(emptySupply, 'q1', 5), meta('e-R1', 9), lotOf('R1'), 'counted', 5);
    const early = allocateArrival(first.ledger, first.supply, meta('a-R1', 9), 'q1', { receiptLotId: 'R1', arrived: 5, good: 5 });
    const late = declareShortage(early, fixedMasters, { ...meta('d1', 10), occurredAt: null }, { project: b001, item: 'P', unit: '個', value: 5, reason: '現場の申告' });
    expect(summary(first.ledger, late).effectiveShortage).toBe(5); // 到着のあとに記録された申告
  });

  test('申告の値が不明（数が不明）のものは、良品が届いても解消したと数えず、実効の不足は不明のまま', () => {
    let supply = ask(emptySupply, 'q1', 5);
    supply = decl(supply, 'd1', null, 8);
    const r = deliver(supply, practiceLedger, 'R1', 5, 9);
    expect(summary(r.ledger, r.supply).effectiveShortage).toBeNull();
  });
});

describe('割り当ての日時と受け取りの日時', () => {
  test('受け取りの日時をあとで訂正して、割り当てより後になったときは、割り当ての日時が受け取りより前になっていると示し、手配対象数と不要の判定を保留する。受け取りの日時を戻す・割り当てを0にすると解消する', () => {
    let { ledger, supply } = shortBy5();
    supply = ask(supply, 'q1', 5);
    const r = receiveLot(ledger, supply, meta('e1', 9), lotOf('R1'), 'counted', 5); // 9時に受け取り
    supply = allocateArrival(r.ledger, r.supply, meta('a1', 10), 'q1', { receiptLotId: 'R1', arrived: 5, good: 5 }); // 10時に割り当て
    expect(summary(r.ledger, supply).predatedArrivals).toEqual([]);
    const corrected = correctOccurredAt(r.ledger, meta('t1', 12), 'e1', '2026-10-02T11:00:00+09:00'); // 受け取りの日時を11時に訂正
    const s = summary(corrected, supply);
    expect(s.predatedArrivals).toEqual([{ requestId: 'q1', arrivalId: 'a1', receiptLotId: 'R1' }]);
    expect(s).toMatchObject({ toOrder: null, possiblyUnneeded: null });
    // 割り当てを0にすれば、前後の食い違いはなくなる。
    expect(summary(corrected, reviseArrival(corrected, supply, meta('r1', 13), 'q1', 'a1', { arrived: 0, good: 0 })).predatedArrivals).toEqual([]);
    // 受け取りの日時を、割り当てより前に戻せば、解消する。
    const back = correctOccurredAt(corrected, meta('t2', 13), 'e1', '2026-10-02T09:30:00+09:00');
    expect(summary(back, supply).predatedArrivals).toEqual([]);
  });
});

describe('実際に受け取った数の訂正の日時と受け取りの日時', () => {
  test('実際に受け取った数を訂正したあとで受け取りの日時を訂正より後へ直すと、訂正の日時が受け取りより前と示し、手配対象数と不要の判定を保留する。受け取りのあとの日時で訂正し直すと解消する', () => {
    let { ledger, supply } = shortBy5();
    supply = ask(supply, 'q1', 5);
    const r = receiveLot(ledger, supply, meta('e1', 9), lotOf('R1'), 'counted', 10);
    supply = allocateArrival(r.ledger, r.supply, meta('a1', 9), 'q1', { receiptLotId: 'R1', arrived: 5, good: 5 });
    supply = reviseReceipt(r.ledger, supply, meta('v1', 10), 'R1', 8, '8個だった');
    expect(summary(r.ledger, supply).predatedRevisions).toEqual([]);
    const moved = correctOccurredAt(r.ledger, meta('t1', 12), 'e1', '2026-10-02T11:00:00+09:00');
    expect(summary(moved, supply).predatedRevisions).toEqual([{ receiptLotId: 'R1', eventId: 'v1' }]);
    expect(summary(moved, supply)).toMatchObject({ toOrder: null, possiblyUnneeded: null });
    const again = reviseReceipt(moved, supply, meta('v2', 12), 'R1', 9, '数え直して9個');
    expect(summary(moved, again).predatedRevisions).toEqual([]);
    // 値が正しいままなら、同じ値で記録し直して解消できる。食い違いがなければ、同じ値は従来どおり拒否する。
    const same = reviseReceipt(moved, supply, meta('v2', 12), 'R1', 8, '受け取りのあとに確認し直した');
    expect(summary(moved, same).predatedRevisions).toEqual([]);
    expect(() => reviseReceipt(moved, same, meta('v3', 13), 'R1', 8, '同じ')).toThrow('変わっていない');
  });
});

describe('確定していない不足', () => {
  test('AT-07: 在庫が約100（必要100）で不足0に見えても、確定していないので、手配対象数と不要の可能性の判定は保留する（依頼の取消を促さない）', () => {
    const ledger = register(practiceLedger, meta('r1', 8), lotOf('L1'), 'approximate', 100);
    const supply = ask(need(), 'q1', 5);
    expect(shortageOf(ledger, supply, key)).toMatchObject({ shortage: 0, judgement: { kind: 'confirm', approximate: true } });
    expect(summary(ledger, supply)).toMatchObject({ tentative: true, effectiveShortage: 0, outstanding: 5, toOrder: null, possiblyUnneeded: null });
    const label = register(practiceLedger, meta('r1', 8), lotOf('L1'), 'label', 100);
    expect(summary(label, supply)).toMatchObject({ tentative: true, toOrder: null, possiblyUnneeded: null });
  });

  test('数えたで確定した不足は、これまでどおり手配対象数と不要の可能性を出す', () => {
    const ledger = register(practiceLedger, meta('r1', 8), lotOf('L1'), 'counted', 100);
    expect(summary(ledger, ask(need(), 'q1', 5))).toMatchObject({ tentative: false, toOrder: 0, possiblyUnneeded: ['q1'] });
  });
});

describe('手動の不足申告と良品の到着', () => {
  const declared = (value: number | null = 5): Supply => declareShortage(emptySupply, fixedMasters, meta('d1', 8), { project: b001, item: 'P', unit: '個', value, reason: '現場の申告' });

  test('必要な数が未登録の群で、申告5・依頼5に良品5が届くと、実効の不足は0・手配対象数0（重ねて依頼を促さない）。良品3なら2', () => {
    let supply = ask(declared(), 'q1', 5);
    const r = receiveLot(practiceLedger, supply, meta('e1', 10), lotOf('R5'), 'counted', 5);
    const all = allocateArrival(r.ledger, r.supply, meta('a1', 10), 'q1', { receiptLotId: 'R5', arrived: 5, good: 5 });
    expect(summary(r.ledger, all)).toMatchObject({ effectiveShortage: 0, outstanding: 0, toOrder: 0, goodApplied: 5 });
    supply = ask(declared(), 'q1', 5);
    const r3 = receiveLot(practiceLedger, supply, meta('e1', 10), lotOf('R5'), 'counted', 5);
    const part = allocateArrival(r3.ledger, r3.supply, meta('a1', 10), 'q1', { receiptLotId: 'R5', arrived: 5, good: 3 });
    expect(summary(r3.ledger, part)).toMatchObject({ effectiveShortage: 2, outstanding: 0, toOrder: 2 });
  });

  test('自動の不足が求まる間も、対応付けていない独立した申告は、申告より後に届いた良品で解消する。必要100・在庫100で、独立した申告5のあとに良品5が届けば、実効の不足は0・手配対象数0', () => {
    const decl = (s: Supply, id: string, value: number | null, hour: number): Supply => declareShortage(s, fixedMasters, meta(id, hour), { project: b001, item: 'P', unit: '個', value, reason: '現場の申告' });
    const deliver = (s: Supply, l: Ledger, lot: string, good: number, hour: number): { ledger: Ledger; supply: Supply } => {
      const r = receiveLot(l, s, meta(`e-${lot}`, hour), lotOf(lot), 'counted', good);
      return { ledger: r.ledger, supply: allocateArrival(r.ledger, r.supply, meta(`a-${lot}`, hour), 'q1', { receiptLotId: lot, arrived: good, good }) };
    };
    let supply = need();
    supply = ask(supply, 'q1', 5);
    const ledger = register(practiceLedger, meta('r1', 7), lotOf('L1'), 'counted', 100);
    supply = decl(supply, 'd1', 5, 8); // 独立した足りない分の記録（自動の不足は0）
    const r = deliver(supply, ledger, 'R1', 5, 9);
    expect(shortageOf(r.ledger, r.supply, key).shortage).toBe(0);
    expect(summary(r.ledger, r.supply)).toMatchObject({ effectiveShortage: 0, toOrder: 0 });
    // 申告のあとに届いた良品がなければ、申告のまま。
    expect(summary(ledger, decl(need(), 'd1', 5, 8)).effectiveShortage).toBe(5);
  });

  test('同じ良品を、自動の不足と申告の両方の解消に使わない。自動の不足5＋独立した申告4に良品3が届くと、自動の不足が2に減るだけで、合計6', () => {
    let { ledger, supply } = shortBy5();
    supply = declareShortage(supply, fixedMasters, meta('d1', 8), { project: b001, item: 'P', unit: '個', value: 4, reason: '別の不足' });
    supply = ask(supply, 'q1', 5);
    const r = receiveLot(ledger, supply, meta('e1', 10), lotOf('R3'), 'counted', 3);
    supply = allocateArrival(r.ledger, r.supply, meta('a1', 10), 'q1', { receiptLotId: 'R3', arrived: 3, good: 3 });
    // 良品3は自動の不足を5→2に減らすのに使われ、申告4の解消には残らない。合計6。
    expect(shortageOf(r.ledger, supply, key).shortage).toBe(2);
    expect(summary(r.ledger, supply).effectiveShortage).toBe(6);
    // 良品7なら、自動の不足5を埋めた残り2が申告を解消し、合計2。
    const r7 = receiveLot(ledger, ask(declareShortage(need(), fixedMasters, meta('d1', 8), { project: b001, item: 'P', unit: '個', value: 4, reason: '別の不足' }), 'q1', 7), meta('e1', 10), lotOf('R7'), 'counted', 7);
    const s7 = allocateArrival(r7.ledger, r7.supply, meta('a1', 10), 'q1', { receiptLotId: 'R7', arrived: 7, good: 7 });
    expect(shortageOf(r7.ledger, s7, key).shortage).toBe(0);
    expect(summary(r7.ledger, s7).effectiveShortage).toBe(2);
  });

  test('自動の不足が判定不能で、対応付けた申告があるときは、申告の値から良品の到着を引く。引いても0未満にならない', () => {
    const ledger = register(practiceLedger, meta('r1', 8), lotOf('L1'), 'unknown', null);
    let supply = declareShortage(need(), fixedMasters, meta('d1', 8), { project: b001, item: 'P', unit: '個', value: 5, reason: '現場の申告' });
    supply = linkDeclaration(supply, fixedMasters, meta('l1', 8), 'd1', true);
    supply = ask(supply, 'q1', 8);
    const r = receiveLot(ledger, supply, meta('e1', 10), lotOf('R8'), 'counted', 8);
    supply = allocateArrival(r.ledger, r.supply, meta('a1', 10), 'q1', { receiptLotId: 'R8', arrived: 8, good: 8 });
    expect(shortageOf(r.ledger, supply, key).judgement.kind).toBe('undecidable');
    expect(summary(r.ledger, supply)).toMatchObject({ effectiveShortage: 0, toOrder: 0 });
  });
});

describe('要件6 不要の可能性がある依頼', () => {
  test('6.2: 群の未着の合計が実効の不足を超えるとき、未着のある依頼をすべて示す。自動では取り消さない', () => {
    let { ledger, supply } = shortBy5();
    supply = ask(supply, 'q1', 5);
    const r = receiveLot(ledger, supply, meta('e1', 10), lotOf('R3'), 'counted', 3);
    supply = allocateArrival(r.ledger, r.supply, meta('a1', 10), 'q1', { receiptLotId: 'R3', arrived: 3, good: 3 });
    supply = ask(supply, 'q2', 2);
    // 不足は2、未着は q1 の2 と q2 の2 で合計4 > 2。どの依頼が余分かは決められないので、両方を示す。
    expect(summary(r.ledger, supply)).toMatchObject({ effectiveShortage: 2, outstanding: 4, toOrder: 0, possiblyUnneeded: ['q1', 'q2'] });
    expect(supply.requests['q1']?.cancelled).toBeNull();
    // 利用者が一つを取り消せば、合計が不足以下になり、示さなくなる。
    supply = cancelRequest(supply, fixedMasters, meta('c1', 11), 'q2', '不要だった');
    expect(summary(r.ledger, supply).possiblyUnneeded).toEqual([]);
  });

  test('6.3: 見つけた現物の受け取りや数え直しで不足が解消しても、依頼は自動で取り消さず、不要の可能性として示す', () => {
    let { ledger, supply } = shortBy5();
    supply = ask(supply, 'q1', 5);
    const r = receiveLot(ledger, supply, meta('e1', 10), lotOf('F1'), 'counted', 5);
    expect(shortageOf(r.ledger, r.supply, key).shortage).toBe(0);
    expect(summary(r.ledger, r.supply)).toMatchObject({ effectiveShortage: 0, outstanding: 5, toOrder: 0, possiblyUnneeded: ['q1'] });
    expect(r.supply.requests['q1']?.cancelled).toBeNull();
  });
});

describe('要件5 過剰割り当て', () => {
  test('受け取り100を98へ訂正したあと、割り当て100は過剰割り当てとして示し、手配対象数と不要の判定を保留する。割り当てを訂正すると解消する', () => {
    let { ledger, supply } = shortBy5();
    supply = ask(supply, 'q1', 100);
    const r = receiveLot(ledger, supply, meta('e1', 10), lotOf('R1'), 'counted', 100);
    supply = allocateArrival(r.ledger, r.supply, meta('a1', 10), 'q1', { receiptLotId: 'R1', arrived: 100, good: 100 });
    supply = reviseReceipt(r.ledger, supply, meta('v1', 11), 'R1', 98, '98個だった');
    const s = summary(r.ledger, supply);
    expect(s.overAllocated).toEqual([{ receiptLotId: 'R1', received: 98, allocated: 100 }]);
    expect(s).toMatchObject({ toOrder: null, possiblyUnneeded: null });
    supply = reviseArrival(r.ledger, supply, meta('r1', 12), 'q1', 'a1', { arrived: 98, good: 98 });
    const fixed = summary(r.ledger, supply);
    expect(fixed.overAllocated).toEqual([]);
    expect(fixed.toOrder).not.toBeNull();
    expect(fixed.possiblyUnneeded).not.toBeNull();
  });

  test('取消済みの依頼の割り当ても、過剰割り当ての合計に含める', () => {
    let { ledger, supply } = shortBy5();
    supply = ask(supply, 'q1', 100);
    const r = receiveLot(ledger, supply, meta('e1', 10), lotOf('R1'), 'counted', 100);
    supply = allocateArrival(r.ledger, r.supply, meta('a1', 10), 'q1', { receiptLotId: 'R1', arrived: 100, good: 100 });
    supply = cancelRequest(supply, fixedMasters, meta('c1', 11), 'q1', '不要');
    supply = reviseReceipt(r.ledger, supply, meta('v1', 12), 'R1', 50, '50個だった');
    expect(summary(r.ledger, supply).overAllocated).toEqual([{ receiptLotId: 'R1', received: 50, allocated: 100 }]);
  });
});
