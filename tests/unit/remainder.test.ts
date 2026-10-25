import { describe, expect, test } from 'vitest';
import { correctOccurredAt, practiceLedger, handOver, hold, recount, register, release, resolveIssue, split, totalOf, use, voidRecord, type Meta, type Project } from '../../src/domain/ledger.ts';
import { acknowledgeReturn, emptySupply, recordRemainder, remainderLevels, staleAcksOf } from '../../src/domain/supply.ts';
import { stockOf } from '../../src/domain/packaging.ts';

const common: Project = { kind: 'common' };

function meta(eventId: string, hour = 9): Meta {
  const at = `2026-10-02T${String(hour).padStart(2, '0')}:00:00+09:00`;
  return { eventId, occurredAt: at, recordedAt: at, actor: '架空担当A' };
}

const screws = (id: string, unit = '本') => ({ id, item: 'S', unit, project: common, location: 'S1' });

describe('要件8 残量区分の観察の日時', () => {
  test('いまの数量になった操作（使用など）より前に観察した残量区分は、記録しない', () => {
    let l = register(practiceLedger, meta('r1', 8), screws('V-1'), 'unknown', null);
    l = use(l, meta('u1', 10), 'V-1', 'unknown', null, '作業');
    expect(() => recordRemainder(l, emptySupply, meta('m1', 9), 'V-1', 'plenty')).toThrow('観察');
    expect(recordRemainder(l, emptySupply, meta('m1', 11), 'V-1', 'plenty').levels['V-1']?.level).toBe('plenty');
    // 観察の日時が不明なら比べない。
    expect(recordRemainder(l, emptySupply, { ...meta('m1', 9), occurredAt: null }, 'V-1', 'plenty').levels['V-1']?.level).toBe('plenty');
  });

  test('使用の日時をあとで観察より後へ訂正したら、その残量区分はいまの区分として使わない', () => {
    let l = register(practiceLedger, meta('r1', 8), screws('V-1'), 'unknown', null);
    l = use(l, meta('u1', 10), 'V-1', 'unknown', null, '作業');
    const s = recordRemainder(l, emptySupply, meta('m1', 11), 'V-1', 'plenty');
    expect(stockOf(l, s, 'S', '本').levelOnly).toEqual([{ lotId: 'V-1', level: 'plenty' }]);
    const corrected = correctOccurredAt(l, meta('t1', 13), 'u1', '2026-10-02T12:00:00+09:00');
    expect(stockOf(corrected, s, 'S', '本').levelOnly).toEqual([]);
  });
});

describe('要件8 残量区分', () => {
  test('8.6: 開封済みで数が不明の保管単位に残量区分を記録できる。数量へは換算されず、台帳の数量は不明のまま', () => {
    const ledger = register(practiceLedger, meta('r1', 8), screws('V-1'), 'unknown', null);
    const s = recordRemainder(ledger, emptySupply, meta('m1', 9), 'V-1', 'few');
    expect(s.levels['V-1']).toMatchObject({ level: 'few', eventId: 'm1' });
    expect(s.log.at(-1)).toMatchObject({ kind: 'remainder', lotId: 'V-1', level: 'few' });
    expect(ledger.lots['V-1']?.quantity.kind).toBe('unknown');
    expect(totalOf(ledger, 'S').kind).toBe('unknown');
  });

  test('区分は四つ（多い・半分程度・少ない・ほぼ空）。別の区分への更新はでき、同じ区分への更新は拒否する', () => {
    expect(remainderLevels).toEqual(['plenty', 'half', 'few', 'nearEmpty']);
    const ledger = register(practiceLedger, meta('r1', 8), screws('V-1'), 'unknown', null);
    let s = recordRemainder(ledger, emptySupply, meta('m1', 9), 'V-1', 'half');
    s = recordRemainder(ledger, s, meta('m2', 10), 'V-1', 'few');
    expect(s.levels['V-1']?.level).toBe('few');
    expect(() => recordRemainder(ledger, s, meta('m3', 11), 'V-1', 'few')).toThrow('変わっていない');
    expect(() => recordRemainder(ledger, s, meta('m3', 11), 'V-1', 'lots' as never)).toThrow('区分');
  });

  test('古くなった残量区分（数量が変わった）は、同じ区分でも記録し直せる。数量が変わっていなければ、同じ区分は拒否する', () => {
    let l = register(practiceLedger, meta('r1', 8), screws('V-1'), 'unknown', null);
    let s = recordRemainder(l, emptySupply, meta('m1', 9), 'V-1', 'few');
    expect(() => recordRemainder(l, s, meta('m2', 10), 'V-1', 'few')).toThrow('変わっていない');
    l = recount(l, meta('c1', 10), 'V-1', 100, { kind: 'unknown' });
    l = use(l, meta('u1', 11), 'V-1', 'unknown', null, '作業');
    s = recordRemainder(l, s, meta('m3', 12), 'V-1', 'few'); // 数量が変わったあとの、新しい観察
    expect(s.levels['V-1']?.eventId).toBe('m3');
  });

  test('数えた・だいたいの数量がある保管単位、存在しない保管単位には区分を記録しない（数値があるならそちらを使う）', () => {
    let ledger = register(practiceLedger, meta('r1', 8), screws('V-1'), 'counted', 200);
    ledger = register(ledger, meta('r2', 8), screws('V-2'), 'approximate', 200);
    expect(() => recordRemainder(ledger, emptySupply, meta('m1'), 'V-1', 'few')).toThrow('数が不明');
    expect(() => recordRemainder(ledger, emptySupply, meta('m1'), 'V-2', 'few')).toThrow('数が不明');
    expect(() => recordRemainder(ledger, emptySupply, meta('m1'), 'zzz', 'few')).toThrow('保管単位');
  });
});

describe('要件10 返品の受付確認', () => {
  const returned = () => {
    let l = register(practiceLedger, meta('r1', 8), screws('X', '個'), 'counted', 106);
    l = hold(l, meta('h1', 9), 'X', 'returnPending');
    l = handOver(l, meta('o1', 10), 'X', 'counted', 4, '架空の返却先');
    return l;
  };
  const total = (l: ReturnType<typeof returned>) => {
    const t = totalOf(l, 'S');
    return t.kind === 'known' ? t.numeric.value : null;
  };

  test('10.8: 実返却に対する受領確認を別の記録として残し、在庫は減らさない', () => {
    const ledger = returned();
    expect(total(ledger)).toBe(102);
    const s = acknowledgeReturn(ledger, emptySupply, meta('k1', 11), 'o1');
    expect(s.acks['o1']).toBe('k1');
    expect(s.log.at(-1)).toMatchObject({ kind: 'returnAck', handoverEventId: 'o1', eventId: 'k1' });
    expect(total(ledger)).toBe(102);
  });

  test('一つの実返却に受領確認は一度だけ。実返却でない操作・保留された引渡し・取消した引渡し・存在しない操作は対象にならない', () => {
    const ledger = returned();
    const s = acknowledgeReturn(ledger, emptySupply, meta('k1', 11), 'o1');
    expect(() => acknowledgeReturn(ledger, s, meta('k2', 12), 'o1')).toThrow('受領確認済み');
    expect(() => acknowledgeReturn(ledger, emptySupply, meta('k2', 12), 'h1')).toThrow('引渡し');
    expect(() => acknowledgeReturn(ledger, emptySupply, meta('k2', 12), 'zzz')).toThrow('操作');
    const pending = handOver(ledger, meta('o2', 11), 'X', 'counted', 500, '架空の返却先');
    expect(() => acknowledgeReturn(pending, emptySupply, meta('k2', 12), 'o2')).toThrow('未反映');
    const used = use(register(ledger, meta('y1', 8), screws('Y', '個'), 'counted', 5), meta('u1', 11), 'Y', 'counted', 1, '作業'); // 使用は引渡しではない
    expect(() => acknowledgeReturn(used, emptySupply, meta('k2', 12), 'u1')).toThrow('引渡し');
    const voided = voidRecord(ledger, meta('v1', 12), 'o1', '誤って記録した');
    expect(() => acknowledgeReturn(voided, emptySupply, meta('k2', 13), 'o1')).toThrow('取消');
  });

  test('受領確認は、返却待ちまたは不良の物の引渡し（返却）だけが対象。返却待ちでも不良でもない通常の引渡しには記録しない', () => {
    let l = register(practiceLedger, meta('r1', 8), screws('X', '個'), 'counted', 20);
    l = register(l, meta('r2', 8), screws('Y', '個'), 'counted', 5);
    l = hold(l, meta('h1', 9), 'Y', 'defective');
    l = handOver(l, meta('p1', 10), 'X', 'counted', 3, '架空の他部署');
    l = handOver(l, meta('p2', 10), 'Y', 'counted', 2, '架空の返却先');
    expect(() => acknowledgeReturn(l, emptySupply, meta('k1', 11), 'p1')).toThrow('返却');
    expect(acknowledgeReturn(l, emptySupply, meta('k2', 11), 'p2').acks['p2']).toBe('k2');
  });

  test('数え直しに含まれていた返却（applied=false）、保留を適用・閉じて解消した返却にも、受領確認を記録できる。未解決の間は記録できない', () => {
    // 返却待ち10の保管単位。10時の数え直し（6）の前の9時に4個を返却したことを後入力し、「含まれていた」と答える。
    let l = register(practiceLedger, meta('r1', 8), screws('X', '個'), 'counted', 10);
    l = hold(l, meta('h1', 8), 'X', 'returnPending');
    l = recount(l, meta('c1', 10), 'X', 6, { kind: 'unknown' });
    l = handOver(l, meta('p1', 9), 'X', 'counted', 4, '架空の返却先', 'included');
    expect(l.history.find((e) => e.eventId === 'p1')).toMatchObject({ kind: 'handover', applied: false, inclusion: 'included' });
    expect(acknowledgeReturn(l, emptySupply, meta('k1', 11), 'p1').acks['p1']).toBe('k1');

    // 包含が不明で保留した返却は、解消するまで記録できない。適用して解消すると記録できる。
    let m = register(practiceLedger, meta('r1', 8), screws('Y', '個'), 'counted', 10);
    m = hold(m, meta('h1', 8), 'Y', 'returnPending');
    m = recount(m, meta('c1', 10), 'Y', 10, { kind: 'unknown' });
    m = handOver(m, meta('p2', 9), 'Y', 'counted', 4, '架空の返却先', 'unknown');
    expect(() => acknowledgeReturn(m, emptySupply, meta('k2', 11), 'p2')).toThrow('未反映');
    const applied = resolveIssue(m, meta('x1', 12), 'p2', 'apply', 'notIncluded');
    expect(acknowledgeReturn(applied, emptySupply, meta('k2', 13), 'p2').acks['p2']).toBe('k2');
    // 返却でない通常の引渡しは、解消しても対象にならない。
    let n = register(practiceLedger, meta('r1', 8), screws('Z', '個'), 'counted', 10);
    n = recount(n, meta('c1', 10), 'Z', 10, { kind: 'unknown' });
    n = handOver(n, meta('p3', 9), 'Z', 'counted', 4, '架空の他部署', 'included');
    expect(() => acknowledgeReturn(n, emptySupply, meta('k3', 11), 'p3')).toThrow('返却');
  });

  test('返却かどうかは、記録した順ではなく、引渡しの実際の日時の時点の取り分けた理由で決める。後の時刻の返却待ちを先に入力しても、その前の引渡しは返却にならない。後から入力した前の時刻の返却待ちは、返却にする', () => {
    // 11時の返却待ちを先に記録し、10時の引渡しをあとから記録する。10時の時点では返却待ちではなかった。
    let l = register(practiceLedger, meta('r1', 8), screws('X', '個'), 'counted', 10);
    l = hold(l, meta('h1', 11), 'X', 'returnPending');
    l = handOver(l, meta('p1', 10), 'X', 'counted', 3, '架空の他部署', 'notIncluded');
    expect(() => acknowledgeReturn(l, emptySupply, meta('k1', 12), 'p1')).toThrow('返却');
    // 引渡しを先に記録し、9時の返却待ちをあとから記録する。10時の時点では返却待ちだった。
    let m = register(practiceLedger, meta('r1', 8), screws('Y', '個'), 'counted', 10);
    m = handOver(m, meta('p2', 10), 'Y', 'counted', 3, '架空の返却先');
    m = hold(m, meta('h2', 9), 'Y', 'returnPending');
    expect(acknowledgeReturn(m, emptySupply, meta('k2', 12), 'p2').acks['p2']).toBe('k2');
    // 返却待ちを外した後の引渡しは、返却ではない。
    let n = register(practiceLedger, meta('r1', 8), screws('Z', '個'), 'counted', 10);
    n = hold(n, meta('h3', 9), 'Z', 'returnPending');
    n = release(n, meta('h4', 10), 'Z', 'returnPending');
    n = handOver(n, meta('p3', 11), 'Z', 'counted', 3, '架空の他部署');
    expect(() => acknowledgeReturn(n, emptySupply, meta('k3', 12), 'p3')).toThrow('返却');
  });

  test('取り分けた理由の付与・解除は、記録した順ではなく実際の日時の順に適用して、引渡しの時点の状態を求める（13時の解除を先に、12時の付与を後から入力しても、14時の時点は解除後）', () => {
    let l = register(practiceLedger, meta('r1', 8), screws('X', '個'), 'counted', 10);
    l = hold(l, meta('h1', 9), 'X', 'returnPending');
    l = release(l, meta('h2', 13), 'X', 'returnPending');
    l = hold(l, meta('h3', 12), 'X', 'returnPending'); // 解除の記録のあとに入力した、解除より前の時刻の付与
    l = handOver(l, meta('p1', 14), 'X', 'counted', 3, '架空の他部署');
    // 時刻順は 9時付与・12時付与・13時解除。14時の時点は解除後で、返却ではない。
    expect(() => acknowledgeReturn(l, emptySupply, meta('k1', 15), 'p1')).toThrow('返却');
  });

  test('分割の子が引き継ぐ取り分けた理由も、子ができた実際の日時の時点の親の状態で決める。後の時刻の親の返却待ちを、前の時刻の分割の子は引き継がない', () => {
    // 親の11時の返却待ちを先に記録し、10時の分割をあとから記録する。10時の子は返却待ちではなく、10時30分の引渡しも返却ではない。
    let l = register(practiceLedger, meta('r1', 8), screws('X', '個'), 'counted', 10);
    l = hold(l, meta('h1', 11), 'X', 'returnPending');
    l = split(l, meta('s1', 10), 'X', 'C', 'counted', 4);
    expect(l.lots['C']?.holds).toEqual(['returnPending']); // 記録した時点では引き継いでいる
    l = handOver(l, meta('p1', 10), 'C', 'counted', 2, '架空の他部署');
    expect(() => acknowledgeReturn(l, emptySupply, meta('k1', 12), 'p1')).toThrow('返却');
    // 12時の分割の子は、11時の返却待ちを引き継ぐので、そのあとの引渡しは返却。
    let m = register(practiceLedger, meta('r1', 8), screws('Y', '個'), 'counted', 10);
    m = hold(m, meta('h1', 11), 'Y', 'returnPending');
    m = split(m, meta('s1', 12), 'Y', 'D', 'counted', 4);
    m = handOver(m, meta('p2', 13), 'D', 'counted', 2, '架空の返却先');
    expect(acknowledgeReturn(m, emptySupply, meta('k2', 14), 'p2').acks['p2']).toBe('k2');
  });

  test('保留した引渡しを、適用せずに「閉じる」で解消した場合は、実際に引き渡したと確かめていないので、受領確認は記録できない（適用して解消したものだけ）', () => {
    let l = register(practiceLedger, meta('r1', 8), screws('X', '個'), 'counted', 4);
    l = hold(l, meta('h1', 8), 'X', 'returnPending');
    l = handOver(l, meta('p1', 9), 'X', 'counted', 5, '架空の返却先'); // 4個しかないので負数で保留される
    expect(l.issues['p1']?.resolution).toBeNull();
    l = recount(l, meta('c1', 10), 'X', 4, { kind: 'unknown' });
    l = resolveIssue(l, meta('x1', 11), 'p1', 'close');
    expect(l.issues['p1']?.resolution?.outcome).toBe('close');
    expect(() => acknowledgeReturn(l, emptySupply, meta('k1', 12), 'p1')).toThrow('閉じた');
  });

  test('引渡しと同時刻の返却待ちの付与・解除は、記録した順で前後を決める。引渡しより先に記録した付与は返却にし、あとに記録した付与は返却にしない（解除も同じ）', () => {
    // 付与を先に記録（10時）、引渡しをあとに記録（10時）：返却。
    let a = register(practiceLedger, meta('r1', 8), screws('X', '個'), 'counted', 10);
    a = hold(a, meta('h1', 10), 'X', 'returnPending');
    a = handOver(a, meta('p1', 10), 'X', 'counted', 3, '架空の返却先');
    expect(acknowledgeReturn(a, emptySupply, meta('k1', 11), 'p1').acks['p1']).toBe('k1');
    // 引渡しを先に記録（10時）、付与をあとに記録（10時）：返却ではない。
    let b = register(practiceLedger, meta('r1', 8), screws('Y', '個'), 'counted', 10);
    b = handOver(b, meta('p2', 10), 'Y', 'counted', 3, '架空の他部署');
    b = hold(b, meta('h2', 10), 'Y', 'returnPending');
    expect(() => acknowledgeReturn(b, emptySupply, meta('k2', 11), 'p2')).toThrow('返却');
    // 付与（9時）を先に、引渡し（10時）を次に、同時刻（10時）の解除を最後に記録：解除は引渡しのあとなので、返却のまま。
    let c = register(practiceLedger, meta('r1', 8), screws('Z', '個'), 'counted', 10);
    c = hold(c, meta('h3', 9), 'Z', 'returnPending');
    c = handOver(c, meta('p3', 10), 'Z', 'counted', 3, '架空の返却先');
    c = release(c, meta('h4', 10), 'Z', 'returnPending');
    expect(acknowledgeReturn(c, emptySupply, meta('k3', 11), 'p3').acks['p3']).toBe('k3');
  });

  test('日時訂正のあとで食い違った受領確認を導出する。引渡しの日時を受領確認より後へ、または返却待ちより前へ訂正すると、食い違いとして示す', () => {
    const base = () => {
      let l = register(practiceLedger, meta('r1', 8), screws('X', '個'), 'counted', 10);
      l = hold(l, meta('h1', 9), 'X', 'returnPending');
      l = handOver(l, meta('p1', 10), 'X', 'counted', 3, '架空の返却先');
      return { ledger: l, supply: acknowledgeReturn(l, emptySupply, meta('k1', 11), 'p1') };
    };
    const { ledger, supply } = base();
    expect(staleAcksOf(ledger, supply)).toEqual([]);
    // 引渡しを12時（受領確認の11時より後）へ訂正。
    const later = correctOccurredAt(ledger, meta('t1', 13), 'p1', '2026-10-02T12:00:00+09:00');
    expect(staleAcksOf(later, supply)).toEqual([{ handoverEventId: 'p1', ackEventId: 'k1', reason: '受領確認の日時が、引渡しより前になっている' }]);
    // 引渡しを返却待ちの付与（9時）より前の8時30分へ訂正。返却と確認できなくなる。
    const earlier = correctOccurredAt(ledger, meta('t2', 13), 'p1', '2026-10-02T08:30:00+09:00');
    expect(staleAcksOf(earlier, supply)[0]?.reason).toContain('返却と確認できなくなった');
  });

  test('返却待ちを付与したあとに記録した日時不明の解除は、付与より後とみなす。解除したあとの通常の引渡しには、受領確認を付けない', () => {
    let l = register(practiceLedger, meta('r1', 8), screws('X', '個'), 'counted', 10);
    l = hold(l, meta('h1', 9), 'X', 'returnPending');
    l = release(l, { ...meta('h2', 9), occurredAt: null }, 'X', 'returnPending');
    l = handOver(l, meta('p1', 10), 'X', 'counted', 3, '架空の他部署');
    expect(() => acknowledgeReturn(l, emptySupply, meta('k1', 11), 'p1')).toThrow('返却');
  });

  test('別の取り分けた理由の記録が日時の順で前後しても、返却待ちの付与とそのあとに記録した日時不明の解除の前後は変わらない', () => {
    let l = register(practiceLedger, meta('r1', 8), screws('X', '個'), 'counted', 10);
    l = hold(l, meta('h1', 11), 'X', 'returnPending');
    l = release(l, { ...meta('h2', 11), occurredAt: null }, 'X', 'returnPending');
    l = hold(l, meta('h3', 10), 'X', 'usabilityCheck');
    l = handOver(l, meta('p1', 12), 'X', 'counted', 3, '架空の他部署');
    expect(() => acknowledgeReturn(l, emptySupply, meta('k1', 13), 'p1')).toThrow('返却');
  });

  test('日時不明の記録をはさんで、日時の分かる記録の前後が記録した順と食い違うときは、返却かどうかを決めず、受領確認を記録しない', () => {
    let l = register(practiceLedger, meta('r1', 8), screws('X', '個'), 'counted', 10);
    l = hold(l, meta('h1', 11), 'X', 'returnPending');
    l = release(l, { ...meta('h2', 11), occurredAt: null }, 'X', 'returnPending');
    l = hold(l, meta('h3', 10), 'X', 'returnPending');
    l = release(l, meta('h4', 9), 'X', 'returnPending');
    l = handOver(l, meta('p1', 12), 'X', 'counted', 3, '架空の他部署');
    expect(() => acknowledgeReturn(l, emptySupply, meta('k1', 13), 'p1')).toThrow('確かめられない');
  });

  test('日時不明の記録が混じっても、適用の順は全順序（日時不明の記録を先に、日時が分かる記録を実際の日時の順に）。9時付与・13時解除・日時不明の別の付与・12時付与（後から入力）でも、14時の時点は解除後', () => {
    let l = register(practiceLedger, meta('r1', 8), screws('X', '個'), 'counted', 10);
    l = hold(l, meta('h1', 9), 'X', 'returnPending');
    l = release(l, meta('h2', 13), 'X', 'returnPending');
    l = hold(l, { ...meta('h3', 9), occurredAt: null }, 'X', 'usabilityCheck');
    l = hold(l, meta('h4', 12), 'X', 'returnPending');
    l = handOver(l, meta('p1', 14), 'X', 'counted', 3, '架空の他部署', 'notIncluded');
    expect(() => acknowledgeReturn(l, emptySupply, meta('k1', 15), 'p1')).toThrow('返却');
  });

  test('受領確認は実返却より前と言える日時では記録しない。日時不明・同時刻は記録できる', () => {
    const ledger = returned();
    expect(() => acknowledgeReturn(ledger, emptySupply, meta('k1', 9), 'o1')).toThrow('より前');
    expect(acknowledgeReturn(ledger, emptySupply, meta('k1', 10), 'o1').acks['o1']).toBe('k1');
    expect(acknowledgeReturn(ledger, emptySupply, { ...meta('k2'), occurredAt: null }, 'o1').acks['o1']).toBe('k2');
  });
});
