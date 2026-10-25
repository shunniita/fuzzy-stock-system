import { describe, expect, test } from 'vitest';
import { changeMasters, correctOccurredAt, practiceLedger, merge, perBoxOfLot, register, split, type Ledger, type Meta } from '../../src/domain/ledger.ts';
import { stockOf } from '../../src/domain/packaging.ts';
import { emptySupply } from '../../src/domain/supply.ts';

const day = (time: string): string => `2026-10-09T${time}:00+09:00`;
const meta = (eventId: string, occurred: string | null, recorded = occurred ?? '12:00'): Meta =>
  ({ eventId, occurredAt: occurred === null ? null : day(occurred), recordedAt: day(recorded), actor: '架空担当A' });
const boxes = (l: Ledger, id: string, count: number, occurred: string | null, recorded?: string): Ledger =>
  register(l, meta(id, occurred, recorded), { id, item: 'S', unit: '箱', project: { kind: 'common' }, location: 'S1' }, 'counted', count);
const pieces = (l: Ledger): number | undefined => {
  const q = stockOf(l, emptySupply, 'S', '本').pieces;
  return q?.kind === 'known' ? q.numeric.value : undefined;
};

// AT-35：1箱1000本の受け取りのあと、10時から1箱あたりの数を800本に変える。
function changed(): Ledger {
  const l = boxes(practiceLedger, 'S-old', 2, '09:00');
  return changeMasters(l, meta('pb', '10:00'), { action: 'perBox', id: 'S', value: 800, reason: '仕入先の包装変更' });
}

describe('F1-B 4.1・要件6 受け取りのときの1箱あたりの数で換算する', () => {
  test('6.2・6.3・AT-35: 変更前に受け入れた箱は1000本のまま、変更後に受け入れた箱は800本', () => {
    const l = boxes(changed(), 'S-new', 1, '11:00');
    expect(perBoxOfLot(l, l.lots['S-old']!)).toBe(1000);
    expect(perBoxOfLot(l, l.lots['S-new']!)).toBe(800);
    expect(pieces(l)).toBe(2 * 1000 + 800);
    expect(stockOf(l, emptySupply, 'S', '本').pieces?.terms.map((t) => t.observation.id)).toEqual(['S-old×1000', 'S-new×800']);
  });

  test('6.6: 変更前の箱を分けた子は、元の箱の受け取りのときの1箱あたりの数のまま', () => {
    const l = split(changed(), meta('sp', '11:00'), 'S-old', 'S-old-a', 'counted', 1);
    expect(perBoxOfLot(l, l.lots['S-old-a']!)).toBe(1000);
    expect(pieces(l)).toBe(2000);
  });

  test('6.4: 実際の日時が不明な受け取りは、記録した日時の1箱あたりの数で換算する', () => {
    let l = boxes(changed(), 'S-u1', 1, null, '09:30');
    l = boxes(l, 'S-u2', 1, null, '10:30');
    expect(perBoxOfLot(l, l.lots['S-u1']!)).toBe(1000);
    expect(perBoxOfLot(l, l.lots['S-u2']!)).toBe(800);
  });

  test('6.5: 受け取りの実際の日時を訂正すると、訂正後の日時の1箱あたりの数で換算する', () => {
    const l = boxes(changed(), 'S-new', 1, '11:00');
    const corrected = correctOccurredAt(l, meta('t1', '12:00'), 'S-new', day('09:30'));
    expect(perBoxOfLot(corrected, corrected.lots['S-new']!)).toBe(1000);
  });

  test('6.7: 1箱あたりの数の違う箱はまとめ直さない。同じ1箱あたりの数ならまとめ直せる', () => {
    let l = boxes(changed(), 'S-new', 1, '11:00');
    expect(() => merge(l, meta('mg', '12:00'), 'S-new', 'S-old')).toThrow('1箱あたりの数');
    l = split(l, meta('sp', '11:30'), 'S-old', 'S-old-a', 'counted', 1);
    l = merge(l, meta('mg2', '12:00'), 'S-old-a', 'S-old');
    expect(pieces(l)).toBe(2 * 1000 + 800);
  });

  test('統合に関わった箱の1箱あたりの数を変える実際の日時の訂正はしない。関わっていなければ訂正できる', () => {
    let l = split(changed(), meta('sp', '11:30'), 'S-old', 'S-old-a', 'counted', 1);
    l = merge(l, meta('mg', '11:45'), 'S-old-a', 'S-old');
    expect(() => correctOccurredAt(l, meta('t1', '12:00'), 'S-old', day('10:30'))).toThrow('統合');
    expect(correctOccurredAt(l, meta('t2', '12:00'), 'S-old', day('09:15')).history.at(-1)?.kind).toBe('correctTime');
  });

  test('作った記録が見つからない箱は、例外にせず換算しない箱にする', () => {
    const l = changed();
    const orphan = { ...l.lots['S-old']!, id: 'S-orphan' };
    const broken: Ledger = { ...l, lots: { ...l.lots, 'S-orphan': orphan } };
    expect(perBoxOfLot(broken, orphan)).toBeNull();
    expect(stockOf(broken, emptySupply, 'S', '本').unconverted.map((x) => x.id)).toEqual(['S-orphan']);
  });

  test('箱でない単位と、包装のない品目は1箱あたりの数を持たない', () => {
    const l = register(changed(), meta('r1', '11:00'), { id: 'S-open', item: 'S', unit: '本', project: { kind: 'common' }, location: 'S1' }, 'counted', 10);
    expect(perBoxOfLot(l, l.lots['S-open']!)).toBeNull();
    const p = register(l, meta('r2', '11:00'), { id: 'P-1', item: 'P', unit: '個', project: { kind: 'common' }, location: 'S1' }, 'counted', 1);
    expect(perBoxOfLot(p, p.lots['P-1']!)).toBeNull();
  });
});
