import { describe, expect, test } from 'vitest';
import {
  practiceLedger,
  handOver,
  hold,
  isUsable,
  merge,
  move,
  occurredAtOf,
  recount,
  register,
  release,
  split,
  totalOf,
  use,
  type Ledger,
  type Cause,
  type Meta,
  type Project,
} from '../../src/domain/ledger.ts';
import { fixedMasters } from '../../src/domain/masters.ts';

const a001: Project = { kind: 'case', id: 'A-001' };
const work = 'A-001 架空作業W1';
const unknownCause: Cause = { kind: 'unknown' };

function meta(eventId: string, hour: number): Meta {
  const at = `2026-09-29T${String(hour).padStart(2, '0')}:00:00+09:00`;
  return { eventId, occurredAt: at, recordedAt: at, actor: '架空担当A' };
}

function lot(id: string, location: string, project: Project = a001) {
  return { id, item: 'P', unit: '個', project, location };
}

const terms = (ledger: Ledger, lotId: string) =>
  ledger.lots[lotId]?.quantity.terms.map((t) => [t.sign, t.observation.id, t.observation.basis, t.observation.value]);

describe('AT-02 使用後も最後に数えた数と記録上の数を区別する', () => {
  test('10時に100を数えて30使用すると、記録上の数70（計算値）で、最後に数えた数は10時の100のまま', () => {
    const l = use(register(practiceLedger, meta('r1', 10), lot('X', 'S1'), 'counted', 100), meta('u1', 11), 'X', 'counted', 30, work);
    expect(l.lots.X?.quantity).toMatchObject({ kind: 'known', numeric: { value: 70 }, computed: true });
    expect(l.lots.X?.lastCount).toEqual({ value: 100, eventId: 'r1' });
    expect(occurredAtOf(l, 'r1')).toBe('2026-09-29T10:00:00+09:00');
  });

  test('QTY-06・02b: ラベル・だいたい・数が不明の登録は数えたにしない', () => {
    let l = register(practiceLedger, meta('r1', 9), lot('L', 'S1'), 'label', 100);
    l = register(l, meta('r2', 9), lot('A', 'S1'), 'approximate', 100);
    l = register(l, meta('r3', 9), lot('U', 'S1'), 'unknown', null);
    expect([l.lots.L?.lastCount, l.lots.A?.lastCount, l.lots.U?.lastCount]).toEqual([null, null, null]);
    expect(l.lots.L?.quantity).toMatchObject({ numeric: { unconfirmed: 'all' } });
    expect(l.lots.A?.quantity).toMatchObject({ numeric: { approximate: true } });
  });

  test('数えて取り出した子だけが数えたを持ち、残り・移動・統合は最後に数えた数を変えない', () => {
    let l = register(practiceLedger, meta('r1', 9), lot('X', 'S1'), 'label', 100);
    l = register(l, meta('r2', 9), lot('Z', 'T'), 'counted', 20);
    l = split(l, meta('s1', 10), 'X', 'Y', 'counted', 30);
    expect(l.lots.X?.lastCount).toBeNull();
    expect(l.lots.Y?.lastCount).toEqual({ value: 30, eventId: 's1' });
    expect(occurredAtOf(l, 's1')).toBe('2026-09-29T10:00:00+09:00');
    l = merge(move(l, meta('m1', 11), 'Y', 'T'), meta('g1', 12), 'Y', 'Z');
    expect(l.lots.Z?.lastCount).toEqual({ value: 20, eventId: 'r2' });
    expect(occurredAtOf(l, 'r2')).toBe('2026-09-29T09:00:00+09:00');
    expect(l.lots.Z?.quantity).toMatchObject({ numeric: { value: 50 }, computed: true });
  });

  test('ラベル上の分割では子も数えたを持たない', () => {
    const l = split(register(practiceLedger, meta('r1', 9), lot('X', 'S1'), 'counted', 100), meta('s1', 10), 'X', 'Y', 'label', 30);
    expect(l.lots.Y?.lastCount).toBeNull();
    expect(l.lots.X?.lastCount).toMatchObject({ value: 100, eventId: 'r1' });
  });
});

describe('AT-06 ラベル100から30を数えて取り出す', () => {
  const labeled = () => register(practiceLedger, meta('r1', 9), lot('X', 'S1'), 'label', 100);
  const remainder70 = { kind: 'known', numeric: { value: 70, approximate: false, unconfirmed: 'all' }, computed: true };

  test('分けて取り出すと、取り出した30だけが数えたで、残りは記録上の数70・中身未確認', () => {
    const l = split(labeled(), meta('s1', 10), 'X', 'Y', 'counted', 30);
    expect(l.lots.Y?.quantity).toMatchObject({ numeric: { value: 30, unconfirmed: 'none' }, computed: false });
    expect(l.lots.X?.quantity).toMatchObject(remainder70);
    expect(l.lots.X?.lastCount).toBeNull();
  });

  test('使用として取り出しても、数えたは使用した30の記録だけで、残りは記録上の数70・中身未確認', () => {
    const l = use(labeled(), meta('u1', 10), 'X', 'counted', 30, work);
    expect(l.lots.X?.quantity).toMatchObject(remainder70);
    expect(l.lots.X?.lastCount).toBeNull();
    expect(terms(l, 'X')).toEqual([
      [1, 'r1', 'label', 100],
      [-1, 'u1', 'counted', 30],
    ]);
  });
});

describe('AT-11 手元の移動と外への引渡し', () => {
  test('FH-B05・RUN-04b: 試行対象外の場所Oも手元の管理場所として登録できる', () => {
    const l = register(practiceLedger, meta('rO', 9), { ...lot('X-O', 'O'), item: 'X' }, 'counted', 3);
    expect(l.lots['X-O']).toMatchObject({ item: 'X', location: 'O', quantity: { numeric: { value: 3 } } });
    expect(l.history).toHaveLength(1);
    expect(l.history[0]).toMatchObject({ eventId: 'rO', kind: 'register' });
    expect(() => register(l, meta('rOUT', 10), lot('X-OUT', 'OUT'), 'counted', 1)).toThrow();
    expect(l.lots['X-OUT']).toBeUndefined();
  });

  test('SCP-02a・RUN-04b: 画面の場所の一覧（固定登録情報）はすべて手元の管理場所として置け、OUTを含まない', () => {
    const locationIds = Object.keys(fixedMasters.locations);
    expect(locationIds).toContain('O');
    expect(locationIds).not.toContain('OUT');
    for (const id of locationIds) {
      expect(register(practiceLedger, meta(`r-${id}`, 9), { ...lot(`L-${id}`, id), item: 'X' }, 'counted', 1).lots[`L-${id}`]?.location).toBe(id);
    }
  });

  function scenario() {
    const l0 = register(practiceLedger, meta('r1', 9), lot('X', 'S1'), 'counted', 100);
    const moved = move(split(l0, meta('s1', 10), 'X', 'Y', 'counted', 30), meta('m1', 10), 'Y', 'T');
    const handed = handOver(moved, meta('h1', 11), 'Y', 'counted', 10, '架空取引先OUT');
    return { moved, handed };
  }

  test('棚100から作業台へ30移した直後は棚70・作業台30で、部署計100（OPS-05b: 移動では減らさない）', () => {
    const { moved } = scenario();
    expect([moved.lots.X?.location, moved.lots.Y?.location]).toEqual(['S1', 'T']);
    expect([moved.lots.X?.quantity, moved.lots.Y?.quantity]).toMatchObject([
      { numeric: { value: 70 } },
      { numeric: { value: 30 } },
    ]);
    expect(totalOf(moved, 'P')).toMatchObject({ kind: 'known', numeric: { value: 100 } });
  });

  test('外へ10渡すと部署計90になり、引渡しの数量・日時・相手先が履歴に残る', () => {
    const { handed } = scenario();
    expect(handed.lots.Y?.quantity).toMatchObject({ numeric: { value: 20 }, computed: true });
    expect(totalOf(handed, 'P')).toMatchObject({ kind: 'known', numeric: { value: 90 } });
    expect(handed.history.at(-1)).toMatchObject({
      eventId: 'h1',
      kind: 'handover',
      counterpart: '架空取引先OUT',
      occurredAt: '2026-09-29T11:00:00+09:00',
    });
    expect(terms(handed, 'Y')).toEqual([
      [1, 's1', 'counted', 30],
      [-1, 'h1', 'counted', 10],
    ]);
  });

  test('SCP-02a: 外は置き場所にできず、引渡しでだけ在庫から出る', () => {
    const { moved } = scenario();
    expect(() => move(moved, meta('m2', 12), 'Y', 'OUT')).toThrow();
    expect(() => register(moved, meta('r9', 12), lot('W', 'OUT'), 'counted', 1)).toThrow();
    expect(() => handOver(moved, meta('h2', 12), 'Y', 'counted', 10, '')).toThrow();
  });
});

describe('AT-13 使用と不良隔離', () => {
  function scenario() {
    let l = register(practiceLedger, meta('r1', 9), lot('X', 'S1'), 'counted', 100);
    l = use(l, meta('u1', 10), 'X', 'counted', 30, work);
    l = split(l, meta('s1', 11), 'X', 'D', 'counted', 2);
    return hold(l, meta('d1', 11), 'D', 'defective');
  }

  test('100から30使用し、未使用のうち2を不良隔離すると、未使用在庫70・使用可能68・不良2', () => {
    const l = scenario();
    expect(totalOf(l, 'P')).toMatchObject({ kind: 'known', numeric: { value: 70 } });
    expect(totalOf(l, 'P', isUsable)).toMatchObject({ kind: 'known', numeric: { value: 68 } });
    expect(totalOf(l, 'P', (x) => x.holds.includes('defective'))).toMatchObject({ numeric: { value: 2 } });
  });

  test('OPS-05a: 使用は使用先の作業と対応付けて履歴に残る', () => {
    expect(scenario().history.find((e) => e.eventId === 'u1')).toMatchObject({ kind: 'use', usedFor: work });
    expect(() => use(scenario(), meta('u2', 12), 'X', 'counted', 1, ' ')).toThrow();
  });

  test('MOD-03: 不良にしても案件・用途は変わらず、不良の現物は在庫総数に残る', () => {
    const l = scenario();
    expect(l.lots.D).toMatchObject({ project: a001, holds: ['defective'], location: 'S1' });
  });

  test('OPS-06b: 同じ不良2に返却待ちも付けても、除外数は2のまま（4にしない）', () => {
    const l = hold(scenario(), meta('d2', 12), 'D', 'returnPending');
    expect(l.lots.D?.holds).toEqual(['defective', 'returnPending']);
    expect(totalOf(l, 'P', (x) => !isUsable(x))).toMatchObject({ numeric: { value: 2 } });
    expect(totalOf(l, 'P')).toMatchObject({ numeric: { value: 70 } });
  });

  test('除外中の保管単位は使用できず、取り分けた理由の違う保管単位とは統合できない。同じ理由の重複付与も拒否', () => {
    const l = scenario();
    expect(() => use(l, meta('u2', 12), 'D', 'counted', 1, work)).toThrow();
    expect(() => merge(l, meta('g1', 12), 'D', 'X')).toThrow();
    expect(() => hold(l, meta('d2', 12), 'D', 'defective')).toThrow();
  });

  test('DAT-02: 全量を除外した使用可能数は、数が不明や値なしではなく計算上の0', () => {
    const l = hold(register(practiceLedger, meta('r1', 9), lot('X', 'S1'), 'counted', 100), meta('d1', 10), 'X', 'defective');
    expect(totalOf(l, 'P', isUsable)).toEqual({
      kind: 'known',
      numeric: { value: 0, approximate: false, unconfirmed: 'none' },
      computed: true,
      terms: [],
    });
  });

  test('ラベル1件だけの合計は中身未確認のまま（0を足して未確認部分ありにしない）', () => {
    const l = register(practiceLedger, meta('r1', 9), lot('X', 'S1'), 'label', 100);
    expect(totalOf(l, 'P')).toMatchObject({ numeric: { value: 100, unconfirmed: 'all' }, computed: false });
  });

  test('取り分けを戻すと、その理由だけが消えて履歴に残る。付いていない理由は外せない', () => {
    let l = hold(scenario(), meta('d2', 12), 'D', 'usabilityCheck');
    l = release(l, meta('e1', 13), 'D', 'usabilityCheck');
    expect(l.lots.D?.holds).toEqual(['defective']);
    expect(l.history.at(-1)).toMatchObject({ kind: 'release', reason: 'usabilityCheck' });
    expect(() => release(l, meta('e2', 13), 'D', 'returnPending')).toThrow();
  });

  test('使用可否の確認が済んで理由を外せば、使用できる', () => {
    let l = split(register(practiceLedger, meta('r1', 9), lot('X', 'S1'), 'counted', 10), meta('s1', 10), 'X', 'C', 'counted', 3);
    l = hold(l, meta('d1', 10), 'C', 'usabilityCheck');
    expect(() => use(l, meta('u1', 11), 'C', 'counted', 1, work)).toThrow();
    l = use(release(l, meta('e1', 11), 'C', 'usabilityCheck'), meta('u1', 12), 'C', 'counted', 1, work);
    expect(l.lots.C?.quantity).toMatchObject({ numeric: { value: 2 } });
    expect(totalOf(l, 'P', isUsable)).toMatchObject({ numeric: { value: 9 } });
  });

  test('除外中の保管単位を分けても、分けた子は同じ取り分けた理由を持つ', () => {
    const l = split(scenario(), meta('s2', 12), 'D', 'D2', 'counted', 1);
    expect(l.lots.D2?.holds).toEqual(['defective']);
    expect(totalOf(l, 'P', isUsable)).toMatchObject({ numeric: { value: 68 } });
  });
});

describe('AT-21 原因不明の訂正', () => {
  // 実数60を登録して7使用し、記録上の数53にする。
  function ledger53(): Ledger {
    const l = register(practiceLedger, meta('r1', 9), lot('X', 'S1'), 'counted', 60);
    return use(l, meta('u1', 10), 'X', 'counted', 7, work);
  }

  test('記録上の数53を数えた52に訂正すると52へ更新し、前後・差異・確認時点・担当者・原因不明が残る', () => {
    const before = ledger53();
    const corrector = { ...meta('c1', 15), actor: '架空担当B' };
    const after = recount(before, corrector, 'X', 52, unknownCause);

    expect(after.lots.X?.quantity).toMatchObject({ numeric: { value: 52 }, computed: false });
    expect(after.lots.X?.lastCount).toEqual({ value: 52, eventId: 'c1' });
    expect(occurredAtOf(after, 'c1')).toBe('2026-09-29T15:00:00+09:00');
    const event = after.history.at(-1);
    expect(event).toMatchObject({
      kind: 'recount',
      cause: { kind: 'unknown' },
      actor: '架空担当B',
      occurredAt: '2026-09-29T15:00:00+09:00',
      difference: { kind: 'known', numeric: { value: -1 }, computed: true },
    });
    expect(event?.changes[0]?.before?.quantity).toMatchObject({ numeric: { value: 53 }, computed: true });
    expect(event?.changes[0]?.after.quantity).toMatchObject({ numeric: { value: 52 } });
    expect(after.history.slice(0, 2).map((e) => e.actor)).toEqual(['架空担当A', '架空担当A']);
  });

  test('架空の使用を要求せず、訂正の操作1件だけを足す', () => {
    const before = ledger53();
    const after = recount(before, meta('c1', 15), 'X', 52, unknownCause);
    expect(after.history.map((e) => e.kind)).toEqual(['register', 'use', 'recount']);
  });

  test('REC-06: 原因の記述は残すが数量は変えない。空の記述は原因不明と区別できないので拒否', () => {
    const after = recount(ledger53(), meta('c1', 15), 'X', 52, { kind: 'stated', text: '床に1個落ちていた（架空）' });
    expect(after.history.at(-1)).toMatchObject({ cause: { kind: 'stated', text: '床に1個落ちていた（架空）' } });
    expect(after.lots.X?.quantity).toMatchObject({ numeric: { value: 52 } });
    expect(() => recount(ledger53(), meta('c1', 15), 'X', 52, { kind: 'stated', text: ' ' })).toThrow();
  });

  test('SCP-06: 訂正前が数が不明でも現在の確認値で訂正でき、差異は不明のまま（0にしない）', () => {
    const before = register(practiceLedger, meta('r1', 9), lot('B', 'S1'), 'unknown', null);
    const after = recount(before, meta('c1', 15), 'B', 40, unknownCause);
    expect(after.lots.B?.quantity).toMatchObject({ kind: 'known', numeric: { value: 40 } });
    expect(after.history.at(-1)).toMatchObject({ difference: { kind: 'unknown' } });
  });
});

describe('AT-32 使用後の数え直しは対象だけの新基準にする', () => {
  function setup(): Ledger {
    let l = register(practiceLedger, meta('r1', 9), lot('X', 'S1'), 'approximate', 100);
    l = register(l, meta('r2', 9), lot('W', 'S2'), 'label', 50);
    return use(l, meta('u1', 10), 'X', 'counted', 30, work);
  }

  test('約100から実数30を使用すると約70', () => {
    expect(setup().lots.X?.quantity).toMatchObject({
      kind: 'known',
      numeric: { value: 70, approximate: true, unconfirmed: 'none' },
      computed: true,
    });
  });

  test('対象全体を数えた72が数えたの新基準になり、旧だいたいは履歴に残る', () => {
    const before = setup();
    const after = recount(before, meta('c1', 11), 'X', 72, unknownCause);

    expect(after.lots.X?.quantity).toEqual({
      kind: 'known',
      numeric: { value: 72, approximate: false, unconfirmed: 'none' },
      computed: false,
      terms: [{ sign: 1, observation: { id: 'c1', basis: 'counted', value: 72 } }],
    });

    expect(before.lots.X?.lastCount).toBeNull();
    expect(after.lots.X?.lastCount).toEqual({ value: 72, eventId: 'c1' });
    expect(occurredAtOf(after, 'c1')).toBe('2026-09-29T11:00:00+09:00');

    const event = after.history.at(-1);
    expect(event).toMatchObject({ eventId: 'c1', kind: 'recount', occurredAt: '2026-09-29T11:00:00+09:00' });
    expect(event?.changes).toHaveLength(1);
    expect(event?.changes[0]?.before?.quantity).toEqual(before.lots.X?.quantity);
    expect(terms(before, 'X')).toEqual([
      [1, 'r1', 'approximate', 100],
      [-1, 'u1', 'counted', 30],
    ]);
    expect(after.history.slice(0, -1)).toEqual(before.history);
  });

  test('別の場所のラベル50は中身未確認のまま変わらない', () => {
    const before = setup();
    const after = recount(before, meta('c1', 11), 'X', 72, unknownCause);
    expect(after.lots.W).toEqual(before.lots.W);
    expect(after.lots.W?.quantity).toMatchObject({ numeric: { value: 50, unconfirmed: 'all' }, computed: false });
    expect(after.history.at(-1)?.changes.map((c) => c.after.id)).toEqual(['X']);
  });
});

describe('AT-34 分割・移動・統合', () => {
  // S1にラベル100（X）、作業台Tに実数20（Z）。Xから30を数えて取り出し、Tへ移してZへまとめる。
  function scenario() {
    const l0 = register(register(practiceLedger, meta('r1', 9), lot('X', 'S1'), 'label', 100), meta('r2', 9), lot('Z', 'T'), 'counted', 20);
    const l1 = split(l0, meta('s1', 10), 'X', 'Y', 'counted', 30);
    const l2 = move(l1, meta('m1', 11), 'Y', 'T');
    const l3 = merge(l2, meta('g1', 12), 'Y', 'Z');
    return { l0, l1, l2, l3 };
  }

  test('100を70と30へ分けると、数えた30だけが数えたになり、残り70は中身未確認のまま', () => {
    const { l1 } = scenario();
    expect(l1.lots.Y).toMatchObject({
      splitFrom: 'X',
      location: 'S1',
      quantity: { kind: 'known', numeric: { value: 30, approximate: false, unconfirmed: 'none' }, computed: false },
    });
    expect(l1.lots.X?.quantity).toMatchObject({ kind: 'known', numeric: { value: 70, unconfirmed: 'all' } });
    expect(terms(l1, 'X')).toEqual([
      [1, 'r1', 'label', 100],
      [-1, 's1', 'counted', 30],
    ]);
  });

  test('移動は場所だけを変え、数量と根拠は変えない', () => {
    const { l1, l2 } = scenario();
    expect(l2.lots.Y).toEqual({ ...l1.lots.Y, location: 'T' });
  });

  test('統合後も元の関連と根拠内訳が残り、旧親・まとめ元を重ねて計上しない', () => {
    const { l0, l3 } = scenario();
    expect(l3.lots.Y).toMatchObject({ splitFrom: 'X', mergedInto: 'Z' });
    expect(l3.lots.Z?.quantity).toMatchObject({ kind: 'known', numeric: { value: 50, unconfirmed: 'none' } });
    expect(terms(l3, 'Z')).toEqual([
      [1, 'r2', 'counted', 20],
      [1, 's1', 'counted', 30],
    ]);
    expect(totalOf(l0, 'P')).toMatchObject({ numeric: { value: 120 } });
    expect(totalOf(l3, 'P')).toMatchObject({ numeric: { value: 120 } });
    expect(l3.history.map((e) => [e.eventId, e.kind, e.changes.map((c) => c.after.id)])).toEqual([
      ['r1', 'register', ['X']],
      ['r2', 'register', ['Z']],
      ['s1', 'split', ['X', 'Y']],
      ['m1', 'move', ['Y']],
      ['g1', 'merge', ['Y', 'Z']],
    ]);
  });

  test('根拠混在: 実数60とラベル40をまとめた100から、ラベル上の30を数えずに分けても数えたにならない', () => {
    let l = register(practiceLedger, meta('r1', 9), lot('X', 'S1'), 'counted', 60);
    l = register(l, meta('r2', 9), lot('V', 'S1'), 'label', 40);
    l = merge(l, meta('g1', 10), 'V', 'X');
    expect(l.lots.X?.quantity).toMatchObject({ numeric: { value: 100, unconfirmed: 'partial' } });

    l = split(l, meta('s1', 11), 'X', 'Y', 'label', 30);
    expect(l.lots.Y?.quantity).toMatchObject({ numeric: { value: 30, unconfirmed: 'all' } });
    expect(l.lots.X?.quantity).toMatchObject({ numeric: { value: 70, unconfirmed: 'partial' } });
    expect(terms(l, 'X')).toEqual([
      [1, 'r1', 'counted', 60],
      [1, 'r2', 'label', 40],
      [-1, 's1', 'label', 30],
    ]);
    expect(totalOf(l, 'P')).toMatchObject({ numeric: { value: 100, unconfirmed: 'partial' } });
  });

  test('数が不明の箱は丸ごと移動し、所在だけが変わって不明のまま', () => {
    const before = register(practiceLedger, meta('r1', 9), lot('B', 'S1'), 'unknown', null);
    const after = move(before, meta('m1', 10), 'B', 'S2');
    expect(after.lots.B).toEqual({ ...before.lots.B, location: 'S2' });
    expect(after.lots.B?.quantity).toEqual({
      kind: 'unknown',
      before: null,
      terms: [{ sign: 1, observation: { id: 'r1', basis: 'unknown', value: null } }],
    });
  });
});

describe('C-R1 入力や現在値を書き換えても過去の記録は変わらない', () => {
  test('登録に渡した案件・用途オブジェクトを後から変えても、台帳と登録履歴の案件・用途は変わらない', () => {
    const project = { kind: 'case' as const, id: 'A-001' };
    const l = register(practiceLedger, meta('r1', 9), { ...lot('X', 'S1'), project }, 'counted', 100);
    project.id = 'A-002';
    expect(l.lots.X?.project).toEqual(a001);
    expect(l.history[0]?.changes[0]?.after.project).toEqual(a001);
  });

  test('返された現在値の元記録は書き換えられず、使用前の台帳と登録履歴も100のまま', () => {
    const before = register(practiceLedger, meta('r1', 9), lot('X', 'S1'), 'counted', 100);
    const after = use(before, meta('u1', 10), 'X', 'counted', 30, work);
    const observation = after.lots.X?.quantity.terms[0]?.observation as { value: number };
    expect(() => {
      observation.value = 9;
    }).toThrow(TypeError);
    expect(terms(before, 'X')).toEqual([[1, 'r1', 'counted', 100]]);
    expect(after.history[0]?.changes[0]?.after.quantity.terms[0]?.observation.value).toBe(100);
  });

  test('台帳・保管単位・履歴は入れ子まで書き換えられない', () => {
    const l = register(practiceLedger, meta('r1', 9), lot('X', 'S1'), 'counted', 100);
    expect(Object.isFrozen(practiceLedger.lots)).toBe(true);
    expect(Object.isFrozen(l.lots)).toBe(true);
    expect(Object.isFrozen(l.lots.X?.project)).toBe(true);
    expect(Object.isFrozen(l.lots.X?.quantity.terms)).toBe(true);
    expect(Object.isFrozen(l.history)).toBe(true);
  });
});

describe('台帳の拒否は元の台帳を変えない', () => {
  const base = register(
    register(practiceLedger, meta('r1', 9), lot('X', 'S1'), 'counted', 100),
    meta('r2', 9),
    lot('C', 'S1', { kind: 'common' }),
    'counted',
    10,
  );
  const snapshot = structuredClone(base);

  test.each([
    ['案件・用途A-001と共通在庫の統合', () => merge(base, meta('g1', 10), 'C', 'X')],
    ['場所が違う統合', () => merge(move(base, meta('m1', 10), 'C', 'T'), meta('g1', 10), 'C', 'X')],
    ['同じ保管単位同士の統合', () => merge(base, meta('g1', 10), 'X', 'X')],
    ['使用済みの操作ID', () => use(base, meta('r1', 10), 'X', 'counted', 1, work)],
    ['使用済みの保管単位ID', () => split(base, meta('s1', 10), 'X', 'C', 'counted', 1)],
    ['存在しない保管単位', () => use(base, meta('u1', 10), 'NONE', 'counted', 1, work)],
    ['同じ場所への移動', () => move(base, meta('m1', 10), 'X', 'S1')],
  ])('%sは拒否する', (_, operation) => {
    expect(operation).toThrow();
    expect(base).toEqual(snapshot);
  });

  test('品目違いは統合できない', () => {
    const l = register(base, meta('r3', 9), { ...lot('Q1', 'S1'), item: 'Q' }, 'counted', 5);
    expect(() => merge(l, meta('g1', 10), 'Q1', 'X')).toThrow();
  });

  test('統合済みの保管単位は操作できない', () => {
    const l = merge(register(base, meta('r3', 9), lot('X2', 'S1'), 'counted', 5), meta('g1', 10), 'X2', 'X');
    expect(() => use(l, meta('u1', 11), 'X2', 'counted', 1, work)).toThrow();
  });
});

describe('AT-10 異種単位を混ぜず、換算不明を換算しない', () => {
  // 部品P10個、半製品R3台、共通ネジSを2箱。ネジは本で管理するが、この箱の1箱あたりの数は分からない。
  function mixed(): Ledger {
    let l = register(practiceLedger, meta('r1', 9), lot('P1', 'S1'), 'counted', 10);
    l = register(l, meta('r2', 9), { ...lot('R1', 'S1'), item: 'R', unit: '台' }, 'counted', 3);
    l = register(l, meta('r3', 9), { ...lot('S-B', 'S2', { kind: 'common' }), item: 'S', unit: '箱' }, 'counted', 2);
    return register(l, meta('r4', 9), { ...lot('S-L', 'S2', { kind: 'common' }), item: 'S', unit: '本' }, 'approximate', 500);
  }

  test('品目ごとの集計に別の品目の数を足さない', () => {
    const l = mixed();
    expect([totalOf(l, 'P'), totalOf(l, 'R')]).toMatchObject([{ numeric: { value: 10 } }, { numeric: { value: 3 } }]);
  });

  test('同じ品目でも単位が違う保管単位は合計せず、単位を指定すれば別々に集計する。箱を本へ換算しない', () => {
    const l = mixed();
    expect(() => totalOf(l, 'S')).toThrow(/単位/);
    expect(totalOf(l, 'S', (x) => x.unit === '箱')).toMatchObject({ numeric: { value: 2, approximate: false } });
    expect(totalOf(l, 'S', (x) => x.unit === '本')).toMatchObject({ numeric: { value: 500, approximate: true } });
  });

  test('単位が違う保管単位は統合できない。分割の子は親の単位を引き継ぐ。単位は空にできない', () => {
    let l = move(mixed(), meta('m1', 10), 'S-B', 'S1');
    l = move(l, meta('m2', 10), 'S-L', 'S1');
    expect(() => merge(l, meta('g1', 11), 'S-B', 'S-L')).toThrow(/単位/);
    expect(split(l, meta('s1', 11), 'S-B', 'S-B2', 'counted', 1).lots['S-B2']?.unit).toBe('箱');
    expect(() => register(practiceLedger, meta('r1', 9), { ...lot('X', 'S1'), unit: ' ' }, 'counted', 1)).toThrow(/単位/);
  });
});

describe('保管単位のID（DAT-01、Gemini）', () => {
  test('登録と分割で、空または空白だけのIDは拒否する', () => {
    expect(() => register(practiceLedger, meta('r1', 9), lot(' ', 'S1'), 'counted', 1)).toThrow(/ID/);
    const l = register(practiceLedger, meta('r1', 9), lot('X', 'S1'), 'counted', 10);
    expect(() => split(l, meta('s1', 10), 'X', '', 'counted', 1)).toThrow(/ID/);
  });
});

describe('B2 予備（取り分けた理由 spare）', () => {
  const received = () => {
    let l = register(practiceLedger, meta('r1', 8), lot('R1', 'S1'), 'counted', 106);
    l = split(l, meta('s1', 9), 'R1', 'R1-spare', 'counted', 2);
    return hold(l, meta('h1', 9), 'R1-spare', 'spare');
  };

  test('OPS-06a・要件10.2: 予備は在庫の総数に入り、使用可能数には入らない', () => {
    const l = received();
    const q = (include?: (x: Parameters<typeof isUsable>[0]) => boolean) => {
      const t = totalOf(l, 'P', include);
      return t.kind === 'known' ? t.numeric.value : null;
    };
    expect(q()).toBe(106);
    expect(q(isUsable)).toBe(104);
    expect(isUsable(l.lots['R1-spare']!)).toBe(false);
  });

  test('要件10.5: 予備のまま使おうとすると、先に交換として案件・用途用へ移す案内つきで拒否され、台帳は変わらない', () => {
    const l = received();
    expect(() => use(l, meta('u1', 10), 'R1-spare', 'counted', 1, work)).toThrow('予備');
    expect(() => use(l, meta('u1', 10), 'R1-spare', 'counted', 1, work)).toThrow('案件・用途用へ移す');
    expect(l.history.length).toBe(received().history.length);
  });

  test('要件10.4: 予備を案件・用途用へ移すにはメモ（交換の理由）が要り、メモは履歴に残る。移したあとは使用可能数に入る', () => {
    const l = received();
    expect(() => release(l, meta('x1', 10), 'R1-spare', 'spare')).toThrow('理由');
    expect(() => release(l, meta('x1', 10), 'R1-spare', 'spare', '  ')).toThrow('理由');
    const moved = release(l, meta('x2', 10), 'R1-spare', 'spare', '作業中に1個破損したため交換');
    expect(moved.history.at(-1)).toMatchObject({ kind: 'release', reason: 'spare', note: '作業中に1個破損したため交換' });
    expect(isUsable(moved.lots['R1-spare']!)).toBe(true);
    const t = totalOf(moved, 'P', isUsable);
    expect(t.kind === 'known' && t.numeric.value).toBe(106);
  });

  test('一部だけを交換するときは、先に分けてから案件・用途用へ移し、総数は変わらない', () => {
    let l = received();
    l = split(l, meta('s2', 10), 'R1-spare', 'R1-swap', 'counted', 1);
    l = release(l, meta('x3', 10), 'R1-swap', 'spare', '紛失の交換');
    expect(isUsable(l.lots['R1-swap']!)).toBe(true);
    expect(isUsable(l.lots['R1-spare']!)).toBe(false);
    const t = totalOf(l, 'P');
    expect(t.kind === 'known' && t.numeric.value).toBe(106);
  });

  test('メモは任意の取り分けた理由の付与・解除にも持てる。メモなしの解除は従来どおりで、記録のメモはnullになる', () => {
    let l = register(practiceLedger, meta('r1', 8), lot('X', 'S1'), 'counted', 10);
    l = hold(l, meta('h1', 9), 'X', 'defective', '角が欠けている');
    expect(l.history.at(-1)).toMatchObject({ kind: 'hold', reason: 'defective', note: '角が欠けている' });
    l = hold(l, meta('h2', 9), 'X', 'usabilityCheck');
    expect(l.history.at(-1)).toMatchObject({ kind: 'hold', note: null });
    l = release(l, meta('r2', 10), 'X', 'usabilityCheck');
    expect(l.history.at(-1)).toMatchObject({ kind: 'release', note: null });
  });

  test('OPS-06b・要件10.10: 不良でもあり返却待ちでもある物は、除外数に一度だけ数える', () => {
    let l = register(practiceLedger, meta('r1', 8), lot('X', 'S1'), 'counted', 4);
    l = hold(l, meta('h1', 9), 'X', 'returnPending');
    l = hold(l, meta('h2', 9), 'X', 'defective');
    const held = totalOf(l, 'P', (x) => x.holds.length > 0);
    expect(held.kind === 'known' && held.numeric.value).toBe(4);
    const returning = totalOf(l, 'P', (x) => x.holds.includes('returnPending'));
    expect(returning.kind === 'known' && returning.numeric.value).toBe(4);
  });

  test('要件10.9: 返却予定を取り消しても、不良の理由は変わらず使用できない', () => {
    let l = register(practiceLedger, meta('r1', 8), lot('X', 'S1'), 'counted', 4);
    l = hold(l, meta('h1', 9), 'X', 'returnPending');
    l = hold(l, meta('h2', 9), 'X', 'defective');
    l = release(l, meta('r2', 10), 'X', 'returnPending');
    expect(l.lots['X']?.holds).toEqual(['defective']);
    expect(isUsable(l.lots['X']!)).toBe(false);
  });

  test('要件10.7・10.11: 不良の物を実際に返却すると、在庫は返却の一回だけ減る（隔離では減らさない）', () => {
    let l = register(practiceLedger, meta('r1', 8), lot('X', 'S1'), 'counted', 103);
    l = split(l, meta('s1', 9), 'X', 'X-bad', 'counted', 3);
    l = hold(l, meta('h1', 9), 'X-bad', 'defective');
    expect(totalOf(l, 'P').kind === 'known' && (totalOf(l, 'P') as { numeric: { value: number } }).numeric.value).toBe(103);
    l = handOver(l, meta('o1', 10), 'X-bad', 'counted', 3, '架空の返却先');
    const t = totalOf(l, 'P');
    expect(t.kind === 'known' && t.numeric.value).toBe(100);
  });
});
