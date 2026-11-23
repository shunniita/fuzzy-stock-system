import { describe, expect, test } from 'vitest';
import { adoptProvisional, changeMasters, handOver, merge, practiceLedger, recount, recordProvisional, register, use, voidRecord, type Ledger, type Meta } from '../../src/domain/ledger.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { initial, parse, serialize } from '../../src/ui/storage.ts';

const day = (t: string): string => `2026-10-09T${t}:00+09:00`;
const meta = (eventId: string, t: string): Meta => ({ eventId, occurredAt: day(t), recordedAt: day('14:00'), actor: '架空担当A' });
const lot = (id: string) => ({ id, item: 'S', unit: '箱', project: { kind: 'common' } as const, location: 'T' });
const saved = (l: Ledger): Ledger => parse(serialize(initial(l, emptySupply))).ledger;
function adopted(basis: 'counted' | 'label' | 'approximate' | 'unknown' = 'counted'): Ledger {
  const l = recordProvisional(practiceLedger, meta('p1', '08:00'), { direction: 'found', item: null, location: 'T', basis, value: basis === 'unknown' ? null : 10, note: '架空' });
  return adoptProvisional(l, meta('a1', '09:00'), 'p1', lot('found'));
}

describe('REC-02a/REC-03b: 仮記録から登録した統合元の取消と根拠の復元', () => {
  for (const order of ['before-merge', 'source-first', 'target-first'] as const) {
    for (const operation of ['use', 'handover'] as const) {
      for (const basis of ['approximate', 'label'] as const) {
        test(`${order}/${operation}/${basis}: 二段統合・保存後も誤記の根拠を残さず、取消を二重適用しない`, () => {
          let l = adopted();
          l = register(l, meta('r1', '09:10'), lot('mid'), 'counted', 4);
          l = register(l, meta('r2', '09:20'), lot('main'), 'counted', 5);
          l = operation === 'use'
            ? use(l, meta('s1', '10:00'), 'found', basis, 3, '架空の誤記')
            : handOver(l, meta('s1', '10:00'), 'found', basis, 3, '架空の相手');
          if (order === 'before-merge') l = voidRecord(l, meta('vs', '10:10'), 's1', '架空の訂正');
          l = use(l, meta('t1', '10:20'), 'main', basis, 2, '架空の誤記');
          l = merge(l, meta('m1', '10:30'), 'found', 'mid');
          l = merge(l, meta('m2', '11:00'), 'mid', 'main');
          l = saved(l);
          if (order === 'source-first') l = voidRecord(l, meta('vs', '12:00'), 's1', '架空の訂正');
          l = voidRecord(l, meta('vt', '12:10'), 't1', '架空の訂正');
          if (order === 'target-first') l = voidRecord(l, meta('vs', '12:20'), 's1', '架空の訂正');
          l = saved(l);
          expect(l.lots.main?.quantity).toMatchObject({ kind: 'known', numeric: { value: 19, approximate: false, unconfirmed: 'none' } });
          expect(l.history.filter(e => e.kind === 'void')).toHaveLength(2);
          expect(l.history.find(e => e.eventId === 'vs')).toMatchObject({ kind: 'void', targetEventId: 's1', applied: true });
          expect(l.history.find(e => e.eventId === 'vt')).toMatchObject({ kind: 'void', targetEventId: 't1', applied: true });
          expect(l.lots.found?.mergedInto).toBe('mid');
          expect(l.lots.mid?.mergedInto).toBe('main');
          expect(() => voidRecord(l, meta('again', '13:00'), 's1', '架空の重複')).toThrow();
        });
      }
    }
  }

  test.each(['counted', 'label', 'approximate', 'unknown'] as const)('%s: 採用時の根拠は勝手に確定せず、取消前の保存済み数量へ戻す', basis => {
    let l = adopted(basis);
    const original = l.lots.found?.quantity;
    l = use(l, meta('u1', '10:00'), 'found', 'approximate', 2, '架空の誤記');
    l = saved(l);
    l = voidRecord(l, meta('v1', '12:00'), 'u1', '架空の訂正');
    expect(l.lots.found?.quantity).toEqual(original);
    expect(l.history.at(-1)).toMatchObject({ kind: 'void', applied: true });
  });

  test('後の数え直しに含まれた誤使用は、取消で現在数へ二重加算しない', () => {
    let l = adopted();
    l = use(l, meta('u1', '10:00'), 'found', 'approximate', 2, '架空の誤記');
    l = recount(l, meta('rc', '11:00'), 'found', 7, { kind: 'unknown' });
    const confirmed = l.lots.found?.quantity;
    l = voidRecord(saved(l), meta('v1', '12:00'), 'u1', '架空の訂正');
    expect(l.lots.found?.quantity).toEqual(confirmed);
    expect(l.history.at(-1)).toMatchObject({ kind: 'void', applied: false });
  });

  test('小数: 正しい使用は保持し、統合元と先の誤使用だけを取消す', () => {
    let l = changeMasters(practiceLedger, meta('d1', '07:00'), { action: 'register', master: { type: 'item', code: 'D', name: '架空小数材料', source: null, units: ['kg'], unitSteps: { kg: 0.1 }, trial: true } });
    l = recordProvisional(l, meta('p1', '08:00'), { direction: 'found', item: 'D', location: 'T', basis: 'counted', value: 1, note: '架空' });
    l = adoptProvisional(l, meta('a1', '09:00'), 'p1', { ...lot('found'), item: 'D', unit: 'kg' });
    l = use(l, meta('valid', '09:10'), 'found', 'counted', 0.9, '架空の正しい使用');
    l = use(l, meta('s1', '09:20'), 'found', 'approximate', 0.1, '架空の誤記');
    l = register(l, meta('r1', '09:30'), { ...lot('main'), item: 'D', unit: 'kg' }, 'counted', 0.2);
    l = use(l, meta('t1', '10:00'), 'main', 'approximate', 0.1, '架空の誤記');
    l = merge(l, meta('m1', '11:00'), 'found', 'main');
    l = voidRecord(saved(l), meta('vs', '12:00'), 's1', '架空の訂正');
    l = voidRecord(saved(l), meta('vt', '12:10'), 't1', '架空の訂正');
    expect(saved(l).lots.main?.quantity).toMatchObject({ kind: 'known', numeric: { value: 0.3, approximate: false, unconfirmed: 'none' } });
    expect(l.history.find(e => e.eventId === 'valid')).toMatchObject({ kind: 'use', applied: true });
  });
});
