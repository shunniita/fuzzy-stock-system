import { describe, expect, test } from 'vitest';
import { assignReturnedProvisional } from '../../src/domain/return-intake.ts';
import { changeMasters, ConfirmationRequired, practiceLedger, handOver, isUsable, recordProvisional, register, totalOf, type Ledger, type Meta } from '../../src/domain/ledger.ts';

const meta = (eventId: string, hour = 12): Meta => ({ eventId, actor: '架空担当A', occurredAt: `2026-10-21T${hour}:00:00+09:00`, recordedAt: '2026-10-21T20:00:00+09:00' });
const lot = { id: 'returned', item: 'R', unit: '台', project: { kind: 'case', id: 'A-001' } as const, location: 'T' };
function base(basis: 'counted' | 'unknown' = 'counted'): Ledger {
  let l = register(practiceLedger, meta('original', 10), { ...lot, id: 'original' }, 'counted', 20);
  l = handOver(l, meta('ship', 11), 'original', 'counted', 2, '外');
  return recordProvisional(l, meta('return'), { direction: 'found', item: 'R', location: 'T', basis, value: basis === 'unknown' ? null : 2, note: '部署外からの戻り。元の現物original' });
}
const assign = (l: Ledger, confirmed = true, eventId = 'assign') => assignReturnedProvisional(l, meta(eventId, 13), { kind: 'notIncluded', issueId: 'return', lot, reason: '現在数量には未包含', confirmed });

describe('返ってきた物品の受付と割当', () => {
  test('3.1〜3.3: 20→出庫18→仮の記録18→割当20、出庫履歴は保持し確認待ち', () => {
    const before = base();
    expect(totalOf(before, 'R')).toMatchObject({ numeric: { value: 18 } });
    const after = assign(before);
    expect(totalOf(after, 'R')).toMatchObject({ numeric: { value: 20 } });
    expect(after.lots['returned']).toMatchObject({ holds: ['usabilityCheck'], stage: { kind: 'none' }, quantity: { numeric: { value: 2 } } });
    expect(isUsable(after.lots['returned']!)).toBe(false);
    expect(after.history.find(e => e.eventId === 'ship')).toEqual(before.history.find(e => e.eventId === 'ship'));
    expect(after.history.filter(e => e.kind === 'start' || e.kind === 'void')).toHaveLength(0);
    expect(after.issues['return']?.resolution?.outcome).toBe('apply');
    expect(totalOf(before, 'R')).toMatchObject({ numeric: { value: 18 } });
  });
  test('2.2: 包含済みは数量・根拠を変えない', () => {
    const before = base();
    const after = assignReturnedProvisional(before, meta('identify', 13), { kind: 'included', issueId: 'return', lotId: 'original', reason: '数え直しに含まれる', confirmed: false });
    expect(after.lots).toEqual(before.lots);
    expect(after.issues['return']?.resolution?.outcome).toBe('close');
  });
  test('1.2: 数が不明を0にせず割り当てる', () => {
    const after = assign(base('unknown'));
    expect(after.lots['returned']?.quantity.kind).toBe('unknown');
    expect(after.lots['returned']?.holds).toEqual(['usabilityCheck']);
  });
  test('2.4: 品目が異なる割当は明示確認前に適用しない', () => {
    const before = base();
    expect(() => assignReturnedProvisional(before, meta('different', 13), { kind: 'notIncluded', issueId: 'return', lot: { ...lot, item: 'P', unit: '個' }, reason: '品目照合', confirmed: false })).toThrow(ConfirmationRequired);
    expect(before.issues['return']?.resolution).toBeNull();
  });
  test('2.5: 同じ仮の記録を再割当しない', () => {
    const after = assign(base());
    const bytes = JSON.stringify(after);
    expect(() => assign(after, true, 'again')).toThrow(/解消済み/);
    expect(JSON.stringify(after)).toBe(bytes);
  });
  test('2.4: 品目照合は内部IDではなく現在の品番・コードで表示する', () => {
    let before = changeMasters(base(), meta('rename-r', 13), { action: 'code', type: 'item', id: 'R', code: '現在R', reason: '架空のコード変更' });
    before = changeMasters(before, meta('rename-p', 13), { action: 'code', type: 'item', id: 'P', code: '現在P', reason: '架空のコード変更' });
    expect(() => assignReturnedProvisional(before, meta('different', 13), { kind: 'notIncluded', issueId: 'return', lot: { ...lot, item: 'P', unit: '個' }, reason: '品目を照合', confirmed: false })).toThrow(/現在R.*現在P/);
  });
  test('2.5: 後段holdのID衝突でも元の台帳は変わらない', () => {
    const before = recordProvisional(base(), meta('assign-return-hold'), { direction: 'found', item: null, location: null, basis: 'unknown', value: null, note: '別の仮記録' });
    const bytes = JSON.stringify(before);
    expect(() => assign(before)).toThrow();
    expect(JSON.stringify(before)).toBe(bytes);
    expect(before.lots['returned']).toBeUndefined();
    expect(before.issues['return']?.resolution).toBeNull();
  });
  test('2.5: 理由なし・ID衝突・場所不明を拒否する', () => {
    const before = base();
    for (const change of [{ lot: { ...lot, id: 'original' } }, { lot: { ...lot, location: '' } }, { reason: '' }]) {
      expect(() => assignReturnedProvisional(before, meta('assign', 13), { kind: 'notIncluded', issueId: 'return', lot, reason: '未包含', confirmed: true, ...change })).toThrow();
    }
    expect(before.issues['return']?.resolution).toBeNull();
  });
});
