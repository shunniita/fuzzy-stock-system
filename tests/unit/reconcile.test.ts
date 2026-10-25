import { describe, expect, test } from 'vitest';
import {
  correctOccurredAt,
  declareDiscrepancy,
  practiceLedger,
  handOver,
  InclusionRequired,
  hold,
  merge,
  move,
  occurredAtOf,
  openIssues,
  openIssuesOf,
  recordProvisional,
  recount,
  register,
  resolveIssue,
  split,
  totalOf,
  use,
  type Ledger,
  type Meta,
  type Project,
} from '../../src/domain/ledger.ts';

const a001: Project = { kind: 'case', id: 'A-001' };
const a002: Project = { kind: 'case', id: 'A-002' };
const work = 'A-001 架空作業W1';

function meta(eventId: string, hour: number, minute = 0, actor = '架空担当A'): Meta {
  const at = `2026-09-29T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+09:00`;
  return { eventId, occurredAt: at, recordedAt: at, actor };
}

function lot(id: string, location: string, project: Project = a001) {
  return { id, item: 'P', unit: '個', project, location };
}

describe('AT-22 後入力が先の数えたに含まれていたかを照合する', () => {
  // 9時に実数52。後から8時50分の使用5を入力する。
  const counted52 = () => register(practiceLedger, meta('r1', 9), lot('X', 'S1'), 'counted', 52);
  const late = meta('u1', 8, 50);

  test('確認に含まれていたかを答えずには登録できない（時刻順だけで決めない）', () => {
    expect(() => use(counted52(), late, 'X', 'counted', 5, work)).toThrow(InclusionRequired);
    const unknownTime = { ...late, occurredAt: null };
    expect(() => use(counted52(), unknownTime, 'X', 'counted', 5, work)).toThrow(/数えた/);
  });

  test('反映済みなら47に減らさず、過去の使用は記録として残る', () => {
    const l = use(counted52(), late, 'X', 'counted', 5, work, 'included');
    expect(l.lots.X?.quantity).toMatchObject({ numeric: { value: 52 }, computed: false });
    expect(l.history.at(-1)).toMatchObject({
      eventId: 'u1',
      kind: 'use',
      applied: false,
      inclusion: 'included',
      value: 5,
      occurredAt: '2026-09-29T08:50:00+09:00',
    });
    expect(openIssuesOf(l, 'X')).toEqual([]);
  });

  test('含まれていなかったなら適用して47にする', () => {
    const l = use(counted52(), late, 'X', 'counted', 5, work, 'notIncluded');
    expect(l.lots.X?.quantity).toMatchObject({ numeric: { value: 47 } });
    expect(l.history.at(-1)).toMatchObject({ applied: true, inclusion: 'notIncluded' });
  });

  test('分からなければ保留して確認事項を開き、確認後に閉じるか適用する', () => {
    const pending = use(counted52(), late, 'X', 'counted', 5, work, 'unknown');
    expect(pending.lots.X?.quantity).toMatchObject({ numeric: { value: 52 } });
    expect(openIssuesOf(pending, 'X')).toEqual([{ id: 'u1', lotId: 'X', reason: 'lateEntry', resolution: null }]);

    const reflected = resolveIssue(pending, meta('v1', 10), 'u1', 'close');
    expect(reflected.lots.X?.quantity).toMatchObject({ numeric: { value: 52 } });
    const applied = resolveIssue(pending, meta('v1', 10), 'u1', 'apply', 'notIncluded');
    expect(applied.lots.X?.quantity).toMatchObject({ numeric: { value: 47 } });
  });

  test('明らかに確認より後の操作には回答を求めず、答えても記録しない。時刻帯の違う表記も比べられる', () => {
    const utc = register(practiceLedger, { ...meta('r1', 9), occurredAt: '2026-09-29T00:00:00Z' }, lot('X', 'S1'), 'counted', 52);
    expect(() => use(utc, late, 'X', 'counted', 5, work)).toThrow(/数えた/);
    const after = use(utc, meta('u2', 9, 10), 'X', 'counted', 5, work, 'included');
    expect(after.lots.X?.quantity).toMatchObject({ numeric: { value: 47 } });
    expect(after.history.at(-1)).toMatchObject({ applied: true, inclusion: null });
  });

  test('数えたのない保管単位には回答を求めない', () => {
    const l = register(practiceLedger, meta('r1', 9), lot('X', 'S1'), 'label', 52);
    expect(use(l, late, 'X', 'counted', 5, work).lots.X?.quantity).toMatchObject({ numeric: { value: 47 } });
  });

  test('引渡しも同じく回答を求める', () => {
    expect(() => handOver(counted52(), late, 'X', 'counted', 5, '架空取引先OUT')).toThrow(/数えた/);
    const l = handOver(counted52(), late, 'X', 'counted', 5, '架空取引先OUT', 'included');
    expect(l.lots.X?.quantity).toMatchObject({ numeric: { value: 52 } });
  });

  test('確認より後と言えない分割も回答を求め、取り出した子はどの回答でも作る（親から減らすかだけが変わる）', () => {
    expect(() => split(counted52(), late, 'X', 'Y', 'counted', 5)).toThrow(/数えた/);
    const included = split(counted52(), late, 'X', 'Y', 'counted', 5, 'included');
    expect([included.lots.X?.quantity, included.lots.Y?.quantity]).toMatchObject([
      { numeric: { value: 52 } },
      { numeric: { value: 5 } },
    ]);
    const notIncluded = split(counted52(), late, 'X', 'Y', 'counted', 5, 'notIncluded');
    expect(notIncluded.lots.X?.quantity).toMatchObject({ numeric: { value: 47 } });
    const unknown = split(counted52(), { ...late, occurredAt: null }, 'X', 'Y', 'counted', 5, 'unknown');
    expect(unknown.lots.Y?.quantity).toMatchObject({ numeric: { value: 5 } });
    expect(openIssuesOf(unknown, 'X')).toMatchObject([{ id: 'u1', reason: 'lateEntry' }]);
  });

  test('包含の回答にかかわらず、根拠と数値の矛盾は拒否する', () => {
    expect(() => use(counted52(), late, 'X', 'counted', null, work, 'included')).toThrow();
    expect(() => use(counted52(), late, 'X', 'counted', null, work, 'unknown')).toThrow();
    expect(() => use(counted52(), late, 'X', 'counted', -1, work, 'included')).toThrow();
  });
});

describe('FH-A02 確認事項を個別に作り、該当するものだけを解消する', () => {
  function fourIssues(): Ledger {
    let l = register(practiceLedger, meta('r1', 9), lot('N1', 'S1'), 'counted', 10);
    l = register(l, meta('r2', 9), lot('L1', 'S1'), 'counted', 52);
    l = register(l, meta('r3', 9), lot('D1', 'S2'), 'counted', 30);
    l = use(l, meta('u1', 10), 'N1', 'counted', 15, work);
    l = use(l, meta('u2', 8, 50), 'L1', 'counted', 5, work, 'unknown');
    l = declareDiscrepancy(l, meta('d1', 10), 'D1', '棚に30より多く見える（架空）');
    return recordProvisional(l, meta('p1', 10), {
      direction: 'found',
      item: null,
      location: 'T',
      basis: 'unknown',
      value: null,
      note: '品目不明の箱（架空の読取文字列 0012-AB）',
    });
  }

  test('負数・後入力の包含不明・差異申告・適用対象不明をそれぞれ別の確認事項として作る', () => {
    const l = fourIssues();
    expect(openIssues(l).map((i) => [i.id, i.lotId, i.reason])).toEqual([
      ['u1', 'N1', 'negative'],
      ['u2', 'L1', 'lateEntry'],
      ['d1', 'D1', 'declared'],
      ['p1', null, 'unassigned'],
    ]);
    expect(l.history.find((e) => e.eventId === 'p1')).toMatchObject({
      kind: 'provisional',
      item: null,
      location: 'T',
      note: '品目不明の箱（架空の読取文字列 0012-AB）',
    });
  });

  test('CHK-02: ラベル・だいたい・既知品目の数が不明・古い数えただけでは確認事項を作らない', () => {
    let l = register(practiceLedger, meta('r1', 9), lot('L', 'S1'), 'label', 100);
    l = register(l, meta('r2', 9), lot('A', 'S1'), 'approximate', 100);
    l = register(l, meta('r3', 9), lot('U', 'S1'), 'unknown', null);
    l = register(l, { ...meta('r4', 9), occurredAt: '2025-01-01T09:00:00+09:00' }, lot('E', 'S1'), 'counted', 100);
    l = use(l, meta('u1', 10), 'U', 'counted', 5, work);
    expect(openIssues(l)).toEqual([]);
  });

  test('REC-04b: 仮の記録は適用済みの在庫総数に足さない', () => {
    const l = recordProvisional(register(practiceLedger, meta('r1', 9), lot('X', 'S1'), 'counted', 10), meta('p1', 10), {
      direction: 'found',
      item: 'P',
      location: 'S1',
      basis: 'counted',
      value: 3,
      note: '案件不明の3個（架空）',
    });
    expect(totalOf(l, 'P')).toMatchObject({ kind: 'known', numeric: { value: 10 } });
  });

  test('差異申告を数え直しで解消しても、他の確認事項は閉じない（CHK-04）', () => {
    let l = recount(fourIssues(), meta('c1', 11), 'D1', 33, { kind: 'unknown' });
    l = resolveIssue(l, meta('v1', 11, 5), 'd1', 'close');
    expect(openIssues(l).map((i) => i.id)).toEqual(['u1', 'u2', 'p1']);
    expect(l.issues.d1?.resolution).toMatchObject({ outcome: 'close', eventId: 'v1' });
  });

  test('差異申告・仮の記録には適用する保留操作がないので、適用では解消できない', () => {
    const l = fourIssues();
    expect(() => resolveIssue(l, meta('v1', 11), 'd1', 'apply')).toThrow(/保留操作/);
    expect(() => resolveIssue(l, meta('v1', 11), 'p1', 'apply')).toThrow(/保留操作/);
    expect(openIssues(resolveIssue(l, meta('v1', 11), 'p1', 'close')).map((i) => i.id)).toEqual(['u1', 'u2', 'd1']);
  });

  test('申告の内容と仮の記録の備考は空にできない。仮の記録の場所は手元に限る', () => {
    const l = register(practiceLedger, meta('r1', 9), lot('X', 'S1'), 'counted', 10);
    expect(() => declareDiscrepancy(l, meta('d1', 10), 'X', ' ')).toThrow();
    const content = { direction: 'removed', item: null, location: null, basis: 'counted', value: 5, note: ' ' } as const;
    expect(() => recordProvisional(l, meta('p1', 10), content)).toThrow();
    expect(() => recordProvisional(l, meta('p1', 10), { ...content, note: '使用先不明の5個（架空）', location: 'OUT' })).toThrow();
    expect(recordProvisional(l, meta('p1', 10), { ...content, note: '使用先不明の5個（架空）' }).lots).toEqual(l.lots);
  });
});

describe('AT-51 日時不明・入力した日時・確認日時の区別と実際の日時の訂正', () => {
  test('実際の日時不明は登録時刻で埋めず、入力した日時と区別して残す', () => {
    const unknownTime = { ...meta('r1', 9), occurredAt: null };
    const l = register(practiceLedger, unknownTime, lot('X', 'S1'), 'counted', 52);
    expect(l.history[0]).toMatchObject({ occurredAt: null, recordedAt: '2026-09-29T09:00:00+09:00' });
    expect(l.lots.X?.lastCount).toEqual({ value: 52, eventId: 'r1' });
    expect(occurredAtOf(l, 'r1')).toBeNull();
  });

  test('実際の日時と入力した日時が違う登録は、両方を別に残す。ラベルの登録日時は数えた日時にならない', () => {
    const later = { ...meta('r1', 8, 30), recordedAt: '2026-09-29T11:00:00+09:00' };
    let l = register(practiceLedger, later, lot('X', 'S1'), 'counted', 52);
    l = register(l, meta('r2', 11), lot('L', 'S1'), 'label', 30);
    expect(l.history[0]).toMatchObject({ occurredAt: '2026-09-29T08:30:00+09:00', recordedAt: '2026-09-29T11:00:00+09:00' });
    expect(occurredAtOf(l, l.lots.X?.lastCount?.eventId ?? '')).toBe('2026-09-29T08:30:00+09:00');
    expect(l.lots.L?.lastCount).toBeNull();
  });

  test('時刻帯のない日時や読めない日時は受け付けない', () => {
    expect(() => register(practiceLedger, { ...meta('r1', 9), occurredAt: '2026-09-29T09:00:00' }, lot('X', 'S1'), 'counted', 1)).toThrow(/日時/);
    expect(() => register(practiceLedger, { ...meta('r1', 9), recordedAt: '9時ごろ' }, lot('X', 'S1'), 'counted', 1)).toThrow(/日時/);
  });

  test('実際の日時を後から訂正すると、元の記録を残して訂正履歴を足し、最後に数えた数の日時も直る', () => {
    const unknownTime = { ...meta('r1', 9), occurredAt: null };
    const before = register(practiceLedger, unknownTime, lot('X', 'S1'), 'counted', 52);
    const after = correctOccurredAt(before, meta('t1', 12, 0, '架空担当B'), 'r1', '2026-09-29T09:00:00+09:00');

    expect(after.history[0]).toEqual(before.history[0]);
    expect(after.history.at(-1)).toMatchObject({
      kind: 'correctTime',
      targetEventId: 'r1',
      previous: null,
      corrected: '2026-09-29T09:00:00+09:00',
      actor: '架空担当B',
    });
    expect(occurredAtOf(after, 'r1')).toBe('2026-09-29T09:00:00+09:00');
    expect(after.lots.X?.lastCount).toEqual({ value: 52, eventId: 'r1' });
    expect(occurredAtOf(after, 'r1')).toBe('2026-09-29T09:00:00+09:00');
    expect(after.lots.X?.quantity).toEqual(before.lots.X?.quantity);
  });

  test('訂正で時刻順が変わっても、すでに答えた包含や適用結果を決め直さない', () => {
    let l = register(practiceLedger, meta('r1', 9), lot('X', 'S1'), 'counted', 52);
    l = use(l, meta('u1', 8, 50), 'X', 'counted', 5, work, 'included');
    l = correctOccurredAt(l, meta('t1', 12), 'u1', '2026-09-29T09:30:00+09:00');
    expect(l.lots.X?.quantity).toMatchObject({ numeric: { value: 52 } });
    expect(l.history.find((e) => e.eventId === 'u1')).toMatchObject({ applied: false, inclusion: 'included' });
    expect(occurredAtOf(l, 'u1')).toBe('2026-09-29T09:30:00+09:00');
  });

  test('何度でも訂正でき、最新の訂正が有効になる。存在しない操作や訂正そのものは訂正できない', () => {
    let l = register(practiceLedger, meta('r1', 9), lot('X', 'S1'), 'counted', 52);
    l = correctOccurredAt(l, meta('t1', 12), 'r1', null);
    l = correctOccurredAt(l, meta('t2', 13), 'r1', '2026-09-29T08:00:00+09:00');
    expect(occurredAtOf(l, 'r1')).toBe('2026-09-29T08:00:00+09:00');
    expect(l.history.at(-1)).toMatchObject({ previous: null, corrected: '2026-09-29T08:00:00+09:00' });
    expect(() => correctOccurredAt(l, meta('t3', 13), 'NONE', null)).toThrow();
    expect(() => correctOccurredAt(l, meta('t3', 13), 't1', null)).toThrow();
  });
});

describe('AT-29 負数になる操作は保留し、確認が必要として残す', () => {
  // 台帳はラベル10だが、現物は15以上あると申告された状況。
  function setup(): Ledger {
    let l = register(practiceLedger, meta('r1', 9), lot('X', 'S1'), 'label', 10);
    l = register(l, meta('r2', 9), lot('Y', 'S2', a002), 'counted', 50);
    return use(l, meta('u1', 10), 'X', 'counted', 15, work);
  }

  test('台帳を負数にせず、0へ丸めず、架空受け取りも作らない。操作は未適用として履歴に残る', () => {
    const l = setup();
    expect(l.lots.X?.quantity).toMatchObject({ numeric: { value: 10 } });
    expect(l.lots.X?.quantity.terms.map((t) => t.observation.id)).toEqual(['r1']);
    expect(l.history.map((e) => e.kind)).toEqual(['register', 'register', 'use']);
    expect(l.history.at(-1)).toMatchObject({ eventId: 'u1', applied: false, lotId: 'X', value: 15, changes: [] });
  });

  test('確認事項は対象・理由・未反映の操作を持ち、対象の保管単位にだけ付く', () => {
    const l = setup();
    expect(openIssuesOf(l, 'X')).toEqual([{ id: 'u1', lotId: 'X', reason: 'negative', resolution: null }]);
    expect(openIssuesOf(l, 'Y')).toEqual([]);
  });

  test('REC-07a: 照合中でも他案件・用途の保管単位は通常どおり使える', () => {
    const l = use(setup(), meta('u2', 11), 'Y', 'counted', 20, 'A-002 架空作業W2');
    expect(l.lots.Y?.quantity).toMatchObject({ numeric: { value: 30 } });
    expect(openIssuesOf(l, 'Y')).toEqual([]);
  });

  test('まだ負数のままなら適用による解消を拒否し、台帳を変えない', () => {
    const l = setup();
    expect(() => resolveIssue(l, meta('v1', 11), 'u1', 'apply')).toThrow(/負数/);
    expect(openIssuesOf(l, 'X')).toHaveLength(1);
  });

  test('数え直してから保留の操作を適用すると解消し、確認者・日時・結果が残る（CHK-03・04）', () => {
    let l = register(setup(), meta('r3', 9), lot('Z', 'S1'), 'counted', 5);
    l = use(l, meta('u3', 10), 'Z', 'counted', 9, work);
    l = recount(l, meta('c1', 12), 'X', 20, { kind: 'unknown' });
    expect(openIssuesOf(l, 'X')).toHaveLength(1);

    l = resolveIssue(l, meta('v1', 12, 5, '架空担当B'), 'u1', 'apply', 'notIncluded');
    expect(l.lots.X?.quantity).toMatchObject({ kind: 'known', numeric: { value: 5 }, computed: true });
    expect(l.lots.X?.quantity.terms.map((t) => [t.sign, t.observation.id])).toEqual([
      [1, 'c1'],
      [-1, 'u1'],
    ]);
    expect(openIssuesOf(l, 'X')).toEqual([]);
    expect(l.issues.u1?.resolution).toEqual({ eventId: 'v1', outcome: 'apply', actor: '架空担当B' });
    expect(occurredAtOf(l, 'v1')).toBe('2026-09-29T12:05:00+09:00');
    expect(openIssuesOf(l, 'Z')).toMatchObject([{ id: 'u3', reason: 'negative' }]);
  });

  test('数え直しに保留の使用が含まれていたなら、適用せずに閉じる', () => {
    let l = recount(setup(), meta('c1', 12), 'X', 0, { kind: 'unknown' });
    l = resolveIssue(l, meta('v1', 12, 5), 'u1', 'close');
    expect(l.lots.X?.quantity).toMatchObject({ numeric: { value: 0 }, computed: false });
    expect(l.issues.u1?.resolution).toMatchObject({ outcome: 'close' });
    expect(() => resolveIssue(l, meta('v2', 13), 'u1', 'close')).toThrow();
  });

  test('引渡しと分割も同じく保留する。分割の子は現物なので記録時に作り、親から減らすことだけを保留する', () => {
    let l = handOver(setup(), meta('h1', 11), 'Y', 'counted', 60, '架空取引先OUT');
    l = split(l, meta('s1', 11), 'Y', 'Y2', 'counted', 70);
    expect(l.lots.Y?.quantity).toMatchObject({ numeric: { value: 50 } });
    expect(l.lots.Y2).toMatchObject({ splitFrom: 'Y', quantity: { numeric: { value: 70 } } });
    expect(openIssuesOf(l, 'Y').map((i) => i.id)).toEqual(['h1', 's1']);

    l = recount(l, meta('c1', 12), 'Y', 80, { kind: 'unknown' });
    l = resolveIssue(l, meta('v1', 12, 5), 's1', 'apply', 'notIncluded');
    expect(l.lots.Y?.quantity).toMatchObject({ numeric: { value: 10 } });
    expect(l.lots.Y2).toMatchObject({ quantity: { numeric: { value: 70 } } });
    expect(openIssuesOf(l, 'Y').map((i) => i.id)).toEqual(['h1']);
  });

  test('確認事項も凍結され、書き換えられない', () => {
    const l = setup();
    expect(Object.isFrozen(l.issues)).toBe(true);
    expect(Object.isFrozen(l.issues.u1)).toBe(true);
    expect(Object.isFrozen(practiceLedger.issues)).toBe(true);
  });
});

describe('A3レビュー（Codex）の再現手順', () => {
  // ラベル10の親Xから、実際には15をCへ取り出した。分割は親が負になるため保留。
  function pendingSplit(): Ledger {
    const l = register(practiceLedger, meta('r1', 9), lot('X', 'S1'), 'label', 10);
    return split(l, meta('s1', 10), 'X', 'C', 'counted', 15);
  }

  test('A3-1: 保留した分割のあと親の残りを20と数えたなら、閉じる解消で親20＋子15＝35になる', () => {
    let l = recount(pendingSplit(), meta('c1', 11), 'X', 20, { kind: 'unknown' });
    l = resolveIssue(l, meta('v1', 12), 's1', 'close');
    expect([l.lots.X?.quantity, l.lots.C?.quantity]).toMatchObject([
      { numeric: { value: 20 } },
      { numeric: { value: 15 } },
    ]);
    expect(totalOf(l, 'P')).toMatchObject({ numeric: { value: 35 } });
  });

  test('A3-2: 確認事項が開いている保管単位は、統合の元にも先にもできない', () => {
    let l = register(practiceLedger, meta('r1', 9), lot('X', 'S1'), 'counted', 10);
    l = register(l, meta('r2', 9), lot('Y', 'S1'), 'counted', 20);
    l = use(l, meta('u1', 10), 'X', 'counted', 15, work);
    expect(() => merge(l, meta('g1', 11), 'X', 'Y')).toThrow(/確認事項/);
    expect(() => merge(l, meta('g1', 11), 'Y', 'X')).toThrow(/確認事項/);
    const resolved = resolveIssue(recount(l, meta('c1', 11), 'X', 0, { kind: 'unknown' }), meta('v1', 11), 'u1', 'close');
    expect(merge(resolved, meta('g1', 12), 'X', 'Y').lots.Y?.quantity).toMatchObject({ numeric: { value: 20 } });
  });

  test('A3-3: 包含を確かめていない減算の日時を確認より前へ訂正すると、確認事項を開く。数量は自動で戻さない', () => {
    let l = register(practiceLedger, meta('r1', 9), lot('X', 'S1'), 'counted', 52);
    l = use(l, meta('u1', 10), 'X', 'counted', 5, work);
    l = correctOccurredAt(l, meta('t1', 12), 'u1', '2026-09-29T08:50:00+09:00');
    expect(l.lots.X?.quantity).toMatchObject({ numeric: { value: 47 } });
    expect(openIssuesOf(l, 'X')).toEqual([{ id: 'u1@time', lotId: 'X', reason: 'timeCorrected', resolution: null }]);
    expect(() => resolveIssue(l, meta('v1', 13), 'u1@time', 'apply')).toThrow(/保留操作/);

    l = resolveIssue(recount(l, meta('c1', 13), 'X', 52, { kind: 'unknown' }), meta('v1', 13), 'u1@time', 'close');
    expect(openIssuesOf(l, 'X')).toEqual([]);
  });

  test('A3-3: 数えたの日時を後ろへ訂正して、その後の減算が確認より前になった場合も確認事項を開く', () => {
    let l = register(practiceLedger, meta('r1', 9), lot('X', 'S1'), 'counted', 52);
    l = use(l, meta('u1', 10), 'X', 'counted', 5, work);
    l = correctOccurredAt(l, meta('t1', 12), 'r1', '2026-09-29T11:00:00+09:00');
    expect(openIssuesOf(l, 'X').map((i) => [i.id, i.reason])).toEqual([['u1@time', 'timeCorrected']]);
  });

  test('A3-3: 訂正しても確認より後のままなら確認事項を開かない', () => {
    let l = register(practiceLedger, meta('r1', 9), lot('X', 'S1'), 'counted', 52);
    l = use(l, meta('u1', 10), 'X', 'counted', 5, work);
    l = correctOccurredAt(l, meta('t1', 12), 'u1', '2026-09-29T10:30:00+09:00');
    expect(openIssuesOf(l, 'X')).toEqual([]);
  });

  test('A3-4: 分割の子は分割時の場所・取り分けた理由のまま。その後の親の移動・不良指定は子に及ばない', () => {
    let l = recount(pendingSplit(), meta('c1', 11), 'X', 20, { kind: 'unknown' });
    l = hold(move(l, meta('m1', 11, 30), 'X', 'S2'), meta('d1', 11, 40), 'X', 'defective');
    l = resolveIssue(l, meta('v1', 12), 's1', 'apply', 'notIncluded');
    expect(l.lots.C).toMatchObject({ location: 'S1', holds: [] });
    expect(l.lots.X).toMatchObject({ location: 'S2', holds: ['defective'], quantity: { numeric: { value: 5 } } });
  });
});

describe('PR #1 Codex botの指摘', () => {
  test('PR1-1: 減算のあと統合した保管単位の日時訂正は、確認事項を統合先の有効な保管単位に付ける', () => {
    let l = register(practiceLedger, meta('r1', 9), lot('X', 'S1'), 'counted', 52);
    l = register(l, meta('r2', 9), lot('Y', 'S1'), 'counted', 10);
    l = use(l, meta('u1', 10), 'X', 'counted', 5, work);
    l = merge(l, meta('g1', 11), 'X', 'Y');
    l = correctOccurredAt(l, meta('t1', 12), 'u1', '2026-09-29T08:50:00+09:00');
    expect(openIssuesOf(l, 'Y')).toEqual([{ id: 'u1@time', lotId: 'Y', reason: 'timeCorrected', resolution: null }]);
    expect(openIssuesOf(l, 'X')).toEqual([]);
    l = resolveIssue(recount(l, meta('c1', 13), 'Y', 57, { kind: 'unknown' }), meta('v1', 13), 'u1@time', 'close');
    expect(openIssues(l)).toEqual([]);
  });

  test.each([
    ['存在しない日付（2月30日）', '2026-02-30T10:00:00Z'],
    ['日付の形をしていない', '1Z'],
    ['24時', '2026-09-29T24:00:00+09:00'],
    ['60分', '2026-09-29T09:60:00+09:00'],
    ['範囲外の時刻帯', '2026-09-29T09:00:00+25:00'],
    ['日付だけ', '2026-09-29'],
  ])('PR1-2: %sの日時は受け付けない', (_, value) => {
    expect(() => register(practiceLedger, { ...meta('r1', 9), occurredAt: value }, lot('X', 'S1'), 'counted', 1)).toThrow(/日時/);
  });

  test.each([
    ['秒なし', '2026-09-29T09:00+09:00'],
    ['ミリ秒付き', '2026-09-29T09:00:00.123+09:00'],
    ['うるう日', '2028-02-29T09:00:00Z'],
  ])('PR1-2: %sの正しい日時は受け付ける', (_, value) => {
    expect(register(practiceLedger, { ...meta('r1', 9), occurredAt: value }, lot('X', 'S1'), 'counted', 1).history).toHaveLength(1);
  });
});

describe('多角レビューの指摘', () => {
  // 9時に実数52、10時に使用5（47）。使用の日時を確認より前へ訂正して、日時訂正の確認事項を開く。
  function timeCorrected(): Ledger {
    let l = register(practiceLedger, meta('r1', 9), lot('X', 'S1'), 'counted', 52);
    l = use(l, meta('u1', 10), 'X', 'counted', 5, work);
    return correctOccurredAt(l, meta('t1', 12), 'u1', '2026-09-29T08:50:00+09:00');
  }

  test('R-3: 同じ操作の日時を何度訂正しても、日時訂正の確認事項は一つだけ。解消後の再訂正でも開き直さない', () => {
    let l = correctOccurredAt(timeCorrected(), meta('t2', 12, 10), 'u1', '2026-09-29T08:40:00+09:00');
    expect(openIssuesOf(l, 'X').map((i) => i.id)).toEqual(['u1@time']);
    l = resolveIssue(recount(l, meta('c1', 13), 'X', 52, { kind: 'unknown' }), meta('v1', 13), 'u1@time', 'close');
    l = correctOccurredAt(l, meta('t3', 14), 'u1', '2026-09-29T08:30:00+09:00');
    expect(openIssues(l)).toEqual([]);
  });

  test('R-4: 既存の確認事項と同じIDの事項は作れず、解消済みの記録を上書きしない', () => {
    const resolved = resolveIssue(timeCorrected(), meta('v1', 13), 'u1@time', 'close');
    expect(() => use(resolved, meta('u1@time', 14), 'X', 'counted', 100, work)).toThrow(/確認事項/);
    expect(() => declareDiscrepancy(timeCorrected(), meta('u1@time', 14), 'X', '多い（架空）')).toThrow(/確認事項/);
    expect(resolved.issues['u1@time']?.resolution).toMatchObject({ outcome: 'close' });
  });

  test('R-5: 解消や数えたの日時は写しで持たず、訂正後の日時を操作IDから引く', () => {
    let l = resolveIssue(timeCorrected(), meta('v1', 13), 'u1@time', 'close');
    l = correctOccurredAt(l, meta('t2', 14), 'v1', '2026-09-29T13:30:00+09:00');
    l = correctOccurredAt(l, meta('t3', 14, 5), 'r1', '2026-09-29T08:00:00+09:00');
    expect(l.issues['u1@time']?.resolution).toEqual({ eventId: 'v1', outcome: 'close', actor: '架空担当A' });
    expect(l.lots.X?.lastCount).toEqual({ value: 52, eventId: 'r1' });
    expect(occurredAtOf(l, 'v1')).toBe('2026-09-29T13:30:00+09:00');
    expect(occurredAtOf(l, 'r1')).toBe('2026-09-29T08:00:00+09:00');
    // 確認を8時へ訂正したので、8時30分の使用は確認より後であり、包含の回答を求めない。
    expect(use(l, meta('u2', 8, 30), 'X', 'counted', 1, work).lots.X?.quantity).toMatchObject({ numeric: { value: 46 } });
  });

  // ラベル10から10時に15使用（負数で保留）。12時に数え直すと20。
  function recountedAfterPending(): Ledger {
    let l = register(practiceLedger, meta('r1', 9), lot('X', 'S1'), 'label', 10);
    l = use(l, meta('u1', 10), 'X', 'counted', 15, work);
    return recount(l, meta('c1', 12), 'X', 20, { kind: 'unknown' });
  }

  test('R-2: 保留した操作が後の数え直しより前なら、適用は包含の回答を求め、含まれていなかったときだけ親から減らす', () => {
    const l = recountedAfterPending();
    expect(() => resolveIssue(l, meta('v1', 13), 'u1', 'apply')).toThrow(/数えた/);
    expect(() => resolveIssue(l, meta('v1', 13), 'u1', 'apply', 'included')).toThrow(/閉じる/);
    expect(() => resolveIssue(l, meta('v1', 13), 'u1', 'apply', 'unknown')).toThrow(/適用できない/);
    expect(openIssuesOf(l, 'X')).toHaveLength(1);

    const applied = resolveIssue(l, meta('v1', 13), 'u1', 'apply', 'notIncluded');
    expect(applied.lots.X?.quantity).toMatchObject({ numeric: { value: 5 } });
    expect(applied.history.at(-1)).toMatchObject({ kind: 'resolve', outcome: 'apply', inclusion: 'notIncluded' });
    expect(resolveIssue(l, meta('v1', 13), 'u1', 'close').lots.X?.quantity).toMatchObject({ numeric: { value: 20 } });
  });

  test('R-2: 保留の解消で適用した減算も、日時訂正で確認より後と言えなくなれば確認事項を開く', () => {
    let l = register(practiceLedger, meta('r1', 9), lot('X', 'S1'), 'label', 10);
    l = use(l, meta('u1', 11), 'X', 'counted', 15, work);
    l = recount(l, meta('c1', 10), 'X', 20, { kind: 'unknown' });
    l = resolveIssue(l, meta('v1', 12), 'u1', 'apply');
    expect(l.lots.X?.quantity).toMatchObject({ numeric: { value: 5 } });

    l = correctOccurredAt(l, meta('t1', 13), 'u1', '2026-09-29T09:30:00+09:00');
    expect(openIssuesOf(l, 'X')).toEqual([{ id: 'u1@time', lotId: 'X', reason: 'timeCorrected', resolution: null }]);
  });

  // 9時に実数52、11時に使用5で47。12時に「10時に数えたら52だった」と入力する。
  function usedAfterLateCount(): Ledger {
    const l = register(practiceLedger, meta('r1', 9), lot('X', 'S1'), 'counted', 52);
    return use(l, meta('u1', 11), 'X', 'counted', 5, work);
  }
  const lateCount = { ...meta('c1', 10), recordedAt: '2026-09-29T12:00:00+09:00' };

  test('R-1: 今の数量に反映済みの操作より後と言えない数え直しは、包含の回答を求める', () => {
    expect(() => recount(usedAfterLateCount(), lateCount, 'X', 52, { kind: 'unknown' })).toThrow(InclusionRequired);
    const included = recount(usedAfterLateCount(), lateCount, 'X', 52, { kind: 'unknown' }, 'included');
    expect(included.lots.X).toMatchObject({ quantity: { numeric: { value: 52 } }, lastCount: { eventId: 'c1' } });
    expect(included.history.at(-1)).toMatchObject({ kind: 'recount', applied: true, inclusion: 'included' });
  });

  test.each(['notIncluded', 'unknown'] as const)('R-1: 回答が%sなら、使用を消さず47のまま、数え直しを記録して確認事項を開く', (answer) => {
    const l = recount(usedAfterLateCount(), lateCount, 'X', 52, { kind: 'unknown' }, answer);
    expect(l.lots.X).toMatchObject({ quantity: { numeric: { value: 47 } }, lastCount: { eventId: 'r1' } });
    expect(l.history.at(-1)).toMatchObject({ eventId: 'c1', kind: 'recount', applied: false, inclusion: answer, changes: [], value: 52 });
    // PR2-2: 未反映でも、数えた値と、差異を求めた相手の数量を記録に残す。
    expect(l.history.at(-1)).toMatchObject({ compared: { kind: 'known', numeric: { value: 47 } } });
    expect(openIssuesOf(l, 'X')).toEqual([{ id: 'c1', lotId: 'X', reason: 'lateEntry', resolution: null }]);
    expect(() => resolveIssue(l, meta('v1', 13), 'c1', 'apply')).toThrow(/保留操作/);
  });

  test('R-1: 新しい数えたがある保管単位へ、それより前の数え直しを入力しても黙って置き換えない', () => {
    let l = register(practiceLedger, meta('r1', 9), lot('X', 'S1'), 'counted', 52);
    l = recount(l, meta('c1', 13), 'X', 50, { kind: 'unknown' });
    expect(() => recount(l, meta('c2', 10), 'X', 52, { kind: 'unknown' })).toThrow(/含まれていたか/);
    expect(recount(l, meta('c2', 14), 'X', 49, { kind: 'unknown' }).lots.X?.quantity).toMatchObject({ numeric: { value: 49 } });
  });

  test('R-1: 数量を変えない操作や、最後に数えた数に含まれた操作では回答を求めない', () => {
    const moved = move(register(practiceLedger, meta('r1', 9), lot('X', 'S1'), 'counted', 52), meta('m1', 11), 'X', 'S2');
    expect(recount(moved, meta('c1', 10), 'X', 52, { kind: 'unknown' }).lots.X?.lastCount).toEqual({ value: 52, eventId: 'c1' });

    let l = use(register(practiceLedger, meta('r1', 9), lot('X', 'S1'), 'counted', 52), meta('u1', 13), 'X', 'counted', 5, work);
    l = recount(l, meta('c1', 12), 'X', 47, { kind: 'unknown' }, 'included');
    expect(recount(l, meta('c2', 12, 30), 'X', 46, { kind: 'unknown' }).lots.X?.quantity).toMatchObject({ numeric: { value: 46 } });
  });

  test('R-1（Codex）: 一部の操作にだけ答えた数え直しも、時刻順で決めた残りの操作の日時訂正で確認事項を開く', () => {
    let l = register(practiceLedger, meta('r1', 9), lot('X', 'S1'), 'counted', 100);
    l = use(l, meta('u1', 10), 'X', 'counted', 10, work);
    l = use(l, meta('u2', 13), 'X', 'counted', 5, work);
    l = recount(l, meta('c1', 12), 'X', 85, { kind: 'unknown' }, 'included');
    // 答えたu2は、日時を訂正しても答えを決め直さない。
    expect(openIssues(correctOccurredAt(l, meta('t1', 14), 'u2', '2026-09-29T14:00:00+09:00'))).toEqual([]);
    l = correctOccurredAt(l, meta('t1', 14), 'u1', '2026-09-29T12:30:00+09:00');
    expect(openIssuesOf(l, 'X')).toEqual([{ id: 'c1@time', lotId: 'X', reason: 'timeCorrected', resolution: null }]);
    expect(l.lots.X?.quantity).toMatchObject({ numeric: { value: 85 } });
  });

  test('R-1: 保留の解消で適用した減算は、元の操作の日時で数え直しと比べる', () => {
    let l = register(practiceLedger, meta('r1', 9), lot('X', 'S1'), 'label', 10);
    l = use(l, meta('u1', 9, 30), 'X', 'counted', 15, work);
    l = recount(l, meta('c1', 9, 15), 'X', 20, { kind: 'unknown' });
    l = resolveIssue(l, meta('v1', 12), 'u1', 'apply');
    // 解消は12時だが、使用は9時30分なので10時の数え直しより前。回答を求めない。
    l = recount(l, meta('c2', 10), 'X', 5, { kind: 'unknown' });
    expect(l.lots.X?.lastCount).toEqual({ value: 5, eventId: 'c2' });
  });

  test('R-1: 回答なしで置き換えた数え直しも、日時訂正で反映済みの操作より後と言えなくなれば確認事項を開く', () => {
    let l = recount(usedAfterLateCount(), meta('c1', 12), 'X', 47, { kind: 'unknown' });
    l = correctOccurredAt(l, meta('t1', 13), 'u1', '2026-09-29T12:30:00+09:00');
    expect(openIssuesOf(l, 'X')).toEqual([{ id: 'c1@time', lotId: 'X', reason: 'timeCorrected', resolution: null }]);
    expect(l.lots.X?.quantity).toMatchObject({ numeric: { value: 47 } });
  });
});
