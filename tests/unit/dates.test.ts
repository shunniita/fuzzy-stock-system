import { fixedMasters } from '../../src/domain/masters.ts';
import { describe, expect, test } from 'vitest';
import { practiceLedger, recordStop, resumeWork, type Meta, type Project } from '../../src/domain/ledger.ts';
import { allocateArrival, cancelRequest, emptySupply, receiveLot, recordReply, recordRequest, registerNeed, type Reply, type Supply } from '../../src/domain/supply.ts';
import { dateStatusOf, stopsOf, type GroupKey } from '../../src/domain/shortage.ts';

const b001: Project & { kind: 'case' } = { kind: 'case', id: 'B-001' };

function meta(eventId: string, hour = 9): Meta {
  const at = `2026-10-01T${String(hour).padStart(2, '0')}:00:00+09:00`;
  return { eventId, occurredAt: at, recordedAt: at, actor: '架空担当A' };
}

const withNeed = (dueDate: string | null): Supply =>
  registerNeed(emptySupply, fixedMasters, meta('n1', 7), { project: b001, item: 'P', unit: '個', required: { basis: 'counted', value: 100 }, dueDate, source: '架空', revision: '初版' });
const ask = (s: Supply, reply: Reply = { kind: 'none' }): Supply =>
  recordRequest(s, fixedMasters, meta('q1', 8), { project: b001, item: 'P', unit: '個', quantity: 5, vendor: '架空の仕入先X', requestedOn: '2026-10-01', reply });

describe('要件4 納期の三状態', () => {
  test('AT-41の限定部分: 判定日10月2日・必要日10月1日・到着予定10月3日は、必要日に間に合わないが到着予定超過ではない', () => {
    const s = ask(withNeed('2026-10-01'), { kind: 'estimated', date: '2026-10-03' });
    expect(dateStatusOf(s, fixedMasters, 'q1', '2026-10-02')).toEqual({ noReply: false, overdue: false, lateForNeed: true });
  });

  test('納期未回答は、予定日がない依頼。予定日があれば未回答ではない（推定でも回答でも）', () => {
    const s = ask(withNeed('2026-10-10'));
    expect(dateStatusOf(s, fixedMasters, 'q1', '2026-10-02')).toEqual({ noReply: true, overdue: false, lateForNeed: false });
    const est = recordReply(s, fixedMasters, meta('q2', 9), 'q1', { kind: 'estimated', date: '2026-10-05' });
    expect(dateStatusOf(est, fixedMasters, 'q1', '2026-10-02').noReply).toBe(false);
    const ans = recordReply(est, fixedMasters, meta('q3', 10), 'q1', { kind: 'answered', date: '2026-10-05' });
    expect(dateStatusOf(ans, fixedMasters, 'q1', '2026-10-02')).toEqual({ noReply: false, overdue: false, lateForNeed: false });
  });

  test('到着予定超過は、未着があり予定日が判定日より前。判定日と同じ日は超過ではない。三つの状態は独立に立つ', () => {
    const s = ask(withNeed('2026-09-30'), { kind: 'answered', date: '2026-10-01' });
    expect(dateStatusOf(s, fixedMasters, 'q1', '2026-10-02')).toEqual({ noReply: false, overdue: true, lateForNeed: true });
    expect(dateStatusOf(s, fixedMasters, 'q1', '2026-10-01').overdue).toBe(false);
  });

  test('必要明細がない・必要日がないときは、必要日に間に合わないを判定しない', () => {
    const noNeed = ask(emptySupply, { kind: 'answered', date: '2026-10-20' });
    expect(dateStatusOf(noNeed, fixedMasters, 'q1', '2026-10-02').lateForNeed).toBe(false);
    const noDue = ask(withNeed(null), { kind: 'answered', date: '2026-10-20' });
    expect(dateStatusOf(noDue, fixedMasters, 'q1', '2026-10-02').lateForNeed).toBe(false);
  });

  test('未着がなくなった依頼（全量到着）と取消した依頼は、どの状態も立たない', () => {
    let s = ask(withNeed('2026-10-01'));
    const cancelled = cancelRequest(s, fixedMasters, meta('c1', 9), 'q1', '不要');
    expect(dateStatusOf(cancelled, fixedMasters, 'q1', '2026-10-02')).toEqual({ noReply: false, overdue: false, lateForNeed: false });
    const r = receiveLot(practiceLedger, s, meta('e1', 9), { id: 'R1', item: 'P', unit: '個', project: b001, location: 'S1' }, 'counted', 5);
    s = allocateArrival(r.ledger, r.supply, meta('a1', 9), 'q1', { receiptLotId: 'R1', arrived: 5, good: 5 });
    expect(dateStatusOf(s, fixedMasters, 'q1', '2026-10-02')).toEqual({ noReply: false, overdue: false, lateForNeed: false });
  });

  test('判定日は実在する日付だけ。存在しない依頼は拒否する', () => {
    const s = ask(withNeed('2026-10-01'));
    expect(() => dateStatusOf(s, fixedMasters, 'q1', '2026-10-32')).toThrow('日付');
    expect(() => dateStatusOf(s, fixedMasters, 'zzz', '2026-10-02')).toThrow('依頼');
  });
});

describe('要件7 中断の参照', () => {
  const key: GroupKey = { project: b001, item: 'P', unit: '個' };
  const stop = (id: string, over: Record<string, unknown> = {}) =>
    ({ process: 'R組立', item: 'R', unit: '台', project: b001, reason: '部品不足', shortage: { item: 'P', unit: '個', value: 5 }, affected: null, ...over }) as Parameters<typeof recordStop>[2];

  test('半製品Rの作業が部品Pの不足で止まるとき、部品Pの群に中断が出る。中断の品目（R）ではなく不足品目で照合する', () => {
    const l = recordStop(practiceLedger, meta('stop1', 9), stop('stop1'));
    expect(stopsOf(l, key).map((s) => s.id)).toEqual(['stop1']);
    expect(stopsOf(l, { ...key, item: 'R', unit: '台' })).toEqual([]);
  });

  test('作業の再開済みの中断、不足品目のない中断、別の単位・別の案件・用途の中断は出さない', () => {
    let l = recordStop(practiceLedger, meta('stop1', 9), stop('stop1'));
    l = recordStop(l, meta('stop2', 9), stop('stop2', { shortage: null }));
    l = recordStop(l, meta('stop3', 9), stop('stop3', { shortage: { item: 'P', unit: '箱', value: 1 } }));
    l = recordStop(l, meta('stop4', 9), stop('stop4', { project: { kind: 'case', id: 'A-001' } }));
    expect(stopsOf(l, key).map((s) => s.id)).toEqual(['stop1']);
    l = resumeWork(l, meta('res1', 10), 'stop1');
    expect(stopsOf(l, key)).toEqual([]);
  });

  test('7.3: 中断の参照は中断も台帳も変えない（不足が0になっても中断は未再開のまま）', () => {
    const l = recordStop(practiceLedger, meta('stop1', 9), stop('stop1'));
    const before = l.stops['stop1'];
    stopsOf(l, key);
    expect(l.stops['stop1']).toBe(before);
    expect(l.stops['stop1']?.resumedBy).toBeNull();
  });
});
