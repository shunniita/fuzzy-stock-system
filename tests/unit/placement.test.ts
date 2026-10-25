import { describe, expect, test } from 'vitest';
import {
  changeMasters, correctOccurredAt, practiceLedger, handOver, move, recordProvisional, recordStop, recount, register, split, start, use, voidRecord,
  type Ledger, type Meta, type Project,
} from '../../src/domain/ledger.ts';
import { fixedMasters, type Masters } from '../../src/domain/masters.ts';

const day = (time: string): string => `2026-10-09T${time}:00+09:00`;
const meta = (eventId: string, occurred: string | null, recorded = occurred ?? '12:00'): Meta =>
  ({ eventId, occurredAt: occurred === null ? null : day(occurred), recordedAt: day(recorded), actor: '架空担当A' });
const common: Project = { kind: 'common' };
const lotAt = (id: string, location: string, item = 'Q', project: Project = common) => ({ id, item, unit: '個', project, location });

// P・案件・用途A-001・作業台Tを利用停止にし、対象外の棚Oを10時から記録の対象外にした台帳。利用停止の前に作ったPの保管単位を持つ。
function prepared(): Ledger {
  const before = register(practiceLedger, meta('r0', '08:00'), lotAt('P-old', 'S1', 'P'), 'counted', 10);
  const masters: Masters = {
    ...fixedMasters,
    items: { ...fixedMasters.items, P: { ...fixedMasters.items.P!, active: false } },
    cases: { ...fixedMasters.cases, 'A-001': { ...fixedMasters.cases['A-001']!, active: false } },
    locations: {
      ...fixedMasters.locations,
      T: { ...fixedMasters.locations.T!, active: false },
      O: { ...fixedMasters.locations.O!, scope: [{ from: null, inScope: true }, { from: day('10:00'), inScope: false }] },
    },
  };
  return { ...before, masters };
}

describe('F1-B 2.1・3.4 新しい記録に利用停止の登録情報を使わない', () => {
  test('利用停止の品目・案件・用途・場所では登録しない', () => {
    const l = prepared();
    expect(() => register(l, meta('r1', '09:00'), lotAt('P-new', 'S1', 'P'), 'counted', 1)).toThrow('利用停止');
    expect(() => register(l, meta('r2', '09:00'), lotAt('Q-1', 'S1', 'Q', { kind: 'case', id: 'A-001' }), 'counted', 1)).toThrow('利用停止');
    expect(() => register(l, meta('r3', '09:00'), lotAt('Q-2', 'T'), 'counted', 1)).toThrow('利用停止');
    expect(() => start(l, meta('st', '09:00'), { ...lotAt('W', 'S1', 'P'), unit: '個' }, { id: 'R組立', criterion: 'inspection' }, 'counted', 1, [])).toThrow('利用停止');
  });

  test('登録されていない品目・案件・用途では登録しない（場所は今と同じく手元の管理場所ではない）', () => {
    const l = prepared();
    expect(() => register(l, meta('r1', '09:00'), lotAt('Z-1', 'S1', 'Z'), 'counted', 1)).toThrow('登録されていない');
    expect(() => register(l, meta('r2', '09:00'), lotAt('Q-1', 'S1', 'Q', { kind: 'case', id: '007' }), 'counted', 1)).toThrow('登録されていない');
    expect(() => register(l, meta('r3', '09:00'), lotAt('Q-2', 'ZZ'), 'counted', 1)).toThrow('手元の管理場所ではない');
    expect(() => register(l, meta('r4', '09:00'), lotAt('Q-3', 'OUT'), 'counted', 1)).toThrow('手元の管理場所ではない');
  });

  test('利用停止の場所へは移さず、仮の記録の場所にもしない。利用停止の品目の仮の記録もしない', () => {
    const l = register(prepared(), meta('r1', '09:00'), lotAt('Q-1', 'S1'), 'counted', 5);
    expect(() => move(l, meta('m1', '09:30'), 'Q-1', 'T')).toThrow('利用停止');
    const content = { direction: 'found' as const, item: null, location: 'T', basis: 'counted' as const, value: 1, note: '架空の箱' };
    expect(() => recordProvisional(l, meta('p1', '09:30'), content)).toThrow('利用停止');
    expect(() => recordProvisional(l, meta('p2', '09:30'), { ...content, location: 'S1', item: 'P' })).toThrow('利用停止');
    expect(recordProvisional(l, meta('p3', '09:30'), { ...content, location: 'S1', item: 'Q' }).issues['p3']).toBeDefined();
  });

  test('作業の中断も新しい記録なので、中断した品目・不足品目・案件・用途に利用停止の登録情報を使わない', () => {
    const l = prepared();
    const stop = { process: '架空工程', item: 'R', unit: '台', project: { kind: 'case', id: 'A-002' } as Project, reason: '部品不足', shortage: { item: 'Q', unit: '個', value: 1 }, affected: null };
    expect(() => recordStop(l, meta('s1', '09:00'), { ...stop, item: 'P', unit: '個' })).toThrow('利用停止');
    expect(() => recordStop(l, meta('s2', '09:00'), { ...stop, shortage: { item: 'P', unit: '個', value: 1 } })).toThrow('利用停止');
    expect(() => recordStop(l, meta('s3', '09:00'), { ...stop, project: { kind: 'case', id: 'A-001' } })).toThrow('利用停止');
    expect(recordStop(l, meta('s4', '09:00'), stop).stops['s4']?.item).toBe('R');
  });

  test('3.3: 利用停止の前からある品目Pの保管単位は、分割・使用・数え直し・移動・取消・日時の訂正ができる', () => {
    let l = prepared();
    l = split(l, meta('s1', '09:00'), 'P-old', 'P-child', 'counted', 2);
    l = use(l, meta('u1', '09:10'), 'P-old', 'counted', 1, '架空作業');
    l = recount(l, meta('c1', '09:20'), 'P-old', 7, { kind: 'unknown' });
    l = move(l, meta('m1', '09:30'), 'P-child', 'S2');
    l = voidRecord(l, meta('v1', '09:40'), 'u1', '記録誤り');
    l = correctOccurredAt(l, meta('t1', '09:50'), 'm1', day('09:35'));
    expect(l.lots['P-child']).toMatchObject({ item: 'P', location: 'S2' });
    expect(l.history.map((e) => e.eventId)).toEqual(['r0', 's1', 'u1', 'c1', 'm1', 'v1', 't1']);
  });
});

describe('F1-B 2.1・7.3・7.4 その時点の記録の対象で判断する', () => {
  test('実際の日時が記録の対象外になった後なら、Oへの登録・移動・仮の記録をしない。前の日時でも、物が残る登録・移動は断る（仮の記録は物ではないので記録できる）', () => {
    const l = prepared();
    expect(() => register(l, meta('r1', '10:30'), lotAt('X-1', 'O', 'X'), 'counted', 1)).toThrow('記録の対象外');
    expect(() => register(l, meta('r2', '09:00'), lotAt('X-2', 'O', 'X'), 'counted', 1)).toThrow('記録の対象外になったあとも物が残る');
    const onShelf = register(l, meta('r3', '08:30'), lotAt('X-3', 'S1', 'X'), 'counted', 1);
    expect(() => move(onShelf, meta('m1', '10:00'), 'X-3', 'O')).toThrow('記録の対象外');
    expect(() => move(onShelf, meta('m2', '09:59'), 'X-3', 'O')).toThrow('記録の対象外になったあとも物が残る');
    const content = { direction: 'found' as const, item: null, location: 'O', basis: 'unknown' as const, value: null, note: '架空の箱' };
    expect(() => recordProvisional(l, meta('p1', '11:00'), content)).toThrow('記録の対象外');
    expect(recordProvisional(l, meta('p2', '09:00'), content).issues['p2']).toBeDefined();
  });

  test('実際の日時が不明なら、記録する時点の記録の対象で判断する', () => {
    const l = prepared();
    expect(() => register(l, meta('r1', null, '10:30'), lotAt('X-1', 'O', 'X'), 'counted', 1)).toThrow('記録の対象外');
    const content = { direction: 'found' as const, item: null, location: 'O', basis: 'unknown' as const, value: null, note: '架空の箱' };
    expect(() => recordProvisional(l, meta('p1', null, '10:30'), content)).toThrow('記録の対象外');
    expect(recordProvisional(l, meta('p2', null, '09:30'), content).issues['p2']).toBeDefined();
  });

  test('配置の記録の実際の日時を、場所が記録の対象外の時点へ訂正しない。移動の訂正で外した後まで物を置いたことにもしない', () => {
    // 外す前に置いて移した物。Oを10時に外すのは、このあと。
    let l: Ledger = register(practiceLedger, meta('r1', '08:00'), lotAt('X-1', 'O', 'X'), 'counted', 1);
    l = move(l, meta('m1', '09:00'), 'X-1', 'S1');
    l = changeMasters(l, meta('sc', '10:00'), { action: 'scope', id: 'O', inScope: false, reason: '他部署へ移管' });
    expect(() => correctOccurredAt(l, meta('t1', '12:00'), 'r1', day('10:30'))).toThrow('記録の対象外');
    expect(() => correctOccurredAt(l, meta('t2', '12:00'), 'm1', day('10:30'))).toThrow('物が置かれていた');
    expect(correctOccurredAt(l, meta('t3', '12:00'), 'm1', day('09:30')).history.at(-1)).toMatchObject({ kind: 'correctTime', targetEventId: 'm1' });
  });

  test('7.7: 外への引渡しは今と同じく記録できる', () => {
    const l = register(prepared(), meta('r1', '09:00'), lotAt('Q-1', 'S1'), 'counted', 5);
    expect(handOver(l, meta('h1', '11:00'), 'Q-1', 'counted', 2, '架空取引先OUT').lots['Q-1']?.quantity).toMatchObject({ numeric: { value: 3 } });
  });
});
