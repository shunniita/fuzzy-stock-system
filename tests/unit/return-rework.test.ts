import { describe, expect, test } from 'vitest';
import { adoptProvisional, beginReturnedRework, beginRework, changeStage, correctOccurredAt, declareDiscrepancy, practiceLedger, handOver, hold, InclusionRequired, merge, productionOf, recount, recordProvisional, recordReworkPart, register, reworksOf, split, totalOf, type Ledger, type Meta, type Process } from '../../src/domain/ledger.ts';
import { assignReturnedProvisional } from '../../src/domain/return-intake.ts';
import type { Basis } from '../../src/domain/quantity.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { requireQuantityTotals } from '../../src/domain/shortage.ts';

export const meta = (eventId: string, hour = 14): Meta => ({ eventId, occurredAt: `2026-10-21T${hour}:00:00+09:00`, recordedAt: '2026-10-22T00:00:00+09:00', actor: '架空担当A' });
export const project = { kind: 'case', id: 'A-001' } as const;
export const process = { id: '戻り検査', criterion: 'inspection' } satisfies Process;
export const product = { id: 'returned', item: 'R', unit: '台', project, location: 'T' };
export function returned(basis: Basis = 'label', value: number | null = 2, originalProcess: Process = process): Ledger {
  let l = register(practiceLedger, meta('original', 10), { ...product, id: 'original', stage: { kind: 'awaitingHandover', process: originalProcess } }, 'label', 20);
  l = handOver(l, meta('ship', 11), 'original', 'label', 2, '外');
  l = recordProvisional(l, meta('found', 12), { direction: 'found', item: 'R', location: 'T', basis, value, note: '文字列から元を推定しない' });
  return assignReturnedProvisional(l, meta('assign', 13), { kind: 'notIncluded', issueId: 'found', lot: product, reason: '現在数量に含まれない戻り', confirmed: true });
}
export const request = () => ({ lotId: 'returned', adoptEventId: 'assign', childId: 'repair', process, basis: 'label' as const, value: 2, reason: '戻りの物理的な手直し', confirmedPhysical: true });
export const begun = () => beginReturnedRework(returned(), meta('repair-start'), request());

describe('FH-RRS-01/02 返ってきた物からのやり直し・修理開始', () => {
  test('20→18→20→18+作業中2を保ち、元履歴とholdsを保持する', () => {
    const l = returned(), before = JSON.stringify(l), next = beginReturnedRework(l, meta('repair-start'), request());
    expect(totalOf(l, 'R')).toMatchObject({ numeric: { value: 20 } });
    expect(totalOf(next, 'R')).toMatchObject({ numeric: { value: 20 } });
    expect(next.lots['returned']?.quantity).toMatchObject({ numeric: { value: 0 } });
    expect(next.lots['repair']).toMatchObject({ ...product, id: 'repair', stage: { kind: 'working', process }, splitFrom: 'returned', holds: ['usabilityCheck'], quantity: { numeric: { value: 2 } } });
    expect(next.history.slice(0, l.history.length)).toEqual(l.history);
    expect(next.history.at(-1)).toMatchObject({ kind: 'rework', returnSource: { adoptEventId: 'assign', process, confirmedPhysical: true } });
    expect(JSON.stringify(l)).toBe(before);
  });
  test.each(['workEnd', 'inspection'] as const)('再完了%sで同じ現物を増やさず旧材料を消費しない', criterion => {
    const p = { ...process, criterion };
    let l = beginReturnedRework(returned('label', 2, p), meta('repair-start'), { ...request(), process: p });
    l = changeStage(l, meta('finish', 15), 'repair', 'done', 'label', 2, { kind: criterion === 'inspection' ? 'inspecting' : 'awaitingHandover', process: p });
    if (criterion === 'inspection') l = changeStage(l, meta('inspect', 16), 'done', 'ready', 'label', 2, { kind: 'awaitingHandover', process: p });
    expect(totalOf(l, 'R')).toMatchObject({ numeric: { value: 20 } });
    expect(productionOf(l, process.id, 'R', '台', project)).toMatchObject({ completed: { numeric: { value: 2 } }, reworkStarted: { numeric: { value: 2 } } });
    expect(l.history.filter(e => e.kind === 'use' || e.kind === 'start')).toHaveLength(0);
    expect(Object.values(l.lots).filter(lot => lot.id !== 'original').every(lot => lot.holds.includes('usabilityCheck'))).toBe(true);
  });
  test.each([
    { confirmedPhysical: false }, { adoptEventId: 'missing' }, { adoptEventId: 'ship' }, { lotId: 'original' },
    { childId: 'returned' }, { childId: '' }, { reason: '' }, { value: 0 }, { value: -1 }, { value: 3 },
    { value: null, basis: 'unknown' as const }, { process: { id: '', criterion: 'inspection' as const } },
  ])('不適切な入力%jは何も変更しない', change => {
    const l = returned(), before = JSON.stringify(l);
    expect(() => beginReturnedRework(l, meta('repair-start'), { ...request(), ...change })).toThrow();
    expect(JSON.stringify(l)).toBe(before);
  });
  test('未解決・数が不明・所属不明・記録の対象外・通常登録を受け付けない', () => {
    const unknown = returned('unknown', null), issue = declareDiscrepancy(returned(), meta('issue'), 'returned', '数量を確認');
    const ordinary = register(practiceLedger, meta('register'), product, 'label', 2);
    for (const l of [unknown, issue, ordinary]) expect(() => beginReturnedRework(l, meta('repair-start'), request())).toThrow();
    for (const change of [{ project: { kind: 'unassigned' as const } }, { location: 'OUT' }]) {
      const l = returned(), changed: Ledger = { ...l, lots: { ...l.lots, returned: { ...l.lots['returned']!, ...change } } };
      expect(() => beginReturnedRework(changed, meta('repair-start'), request())).toThrow();
    }
  });
  test('直接found→adoptなら備考やID接尾辞に依存せず今回確認できる', () => {
    let l = recordProvisional(practiceLedger, meta('plain-found', 12), { direction: 'found', item: 'R', location: 'T', basis: 'label', value: 2, note: '一般の仮記録' });
    l = adoptProvisional(l, meta('plain', 13), 'plain-found', product, true);
    expect(beginReturnedRework(l, meta('repair-start'), { ...request(), adoptEventId: 'plain' }).lots['repair']?.holds).toEqual([]);
  });
  test('分割した子と開始前に別現物を混ぜた親は受け付けない', () => {
    let l = split(returned(), meta('split'), 'returned', 'split-child', 'label', 1);
    expect(() => beginReturnedRework(l, meta('repair-start'), { ...request(), lotId: 'split-child', value: 1 })).toThrow();
    l = register(returned(), meta('other'), { ...product, id: 'other' }, 'label', 1);
    l = hold(l, meta('other-hold'), 'other', 'usabilityCheck');
    l = merge(l, meta('mix'), 'other', 'returned');
    expect(() => beginReturnedRework(l, meta('repair-start'), request())).toThrow(/統合/);
  });
  test('包含済み・不明を拒否し、割当より前の開始と逆転する日時訂正を拒否する', () => {
    const l = recount(returned(), meta('count', 15), 'returned', 2, { kind: 'unknown' });
    expect(() => beginReturnedRework(l, meta('repair-start'), request())).toThrow(InclusionRequired);
    for (const answer of ['included', 'unknown'] as const) expect(() => beginReturnedRework(l, meta('repair-start'), request(), answer)).toThrow();
    expect(beginReturnedRework(l, meta('repair-start'), request(), 'notIncluded').lots['repair']).toBeDefined();
    expect(() => beginReturnedRework(returned(), meta('too-early', 11), request())).toThrow();
    expect(() => correctOccurredAt(begun(), meta('time'), 'assign', meta('future', 16).occurredAt)).toThrow();
    expect(() => correctOccurredAt(begun(), meta('time'), 'repair-start', meta('past', 11).occurredAt)).toThrow();
  });
  test('部分完了の残りへ部品処置でき、再完了した枝は別やり直し・修理へ導く', () => {
    let l = changeStage(begun(), meta('finish', 15), 'repair', 'done', 'label', 1, { kind: 'inspecting', process });
    l = changeStage(l, meta('inspect', 16), 'done', 'ready', 'label', 1, { kind: 'awaitingHandover', process });
    const part = { action: 'discard', reworkId: 'repair-start', subjectLotId: 'repair', item: 'P', unit: '個', value: 1, reason: '実処置' } as const;
    expect(recordReworkPart(l, meta('part', 17), part).history.at(-1)?.kind).toBe('reworkPart');
    expect(() => recordReworkPart(l, meta('part', 17), { ...part, subjectLotId: 'ready' })).toThrow();
    l = beginRework(l, meta('again', 17), 'ready', 'again', 'label', 1, '別のやり直し・修理');
    expect(reworksOf(l, 'again').map(e => e.eventId)).toContain('again');
    expect(productionOf(l, process.id, 'R', '台', project).reworkStarted).toMatchObject({ numeric: { value: 3 } });
  });
});

describe('FH-RRS-03 工程別の開始累計と上限', () => {
  test('異なる二工程を分離し、通常工程と位置訂正の累計を混ぜない', () => {
    let l = beginReturnedRework(returned('label', 2), meta('first'), { ...request(), value: 1 });
    l = beginReturnedRework(l, meta('second'), { ...request(), childId: 'second', process: { id: '別工程', criterion: 'workEnd' }, value: 1 });
    for (const name of [process.id, '別工程']) expect(productionOf(l, name, 'R', '台', project).reworkStarted).toMatchObject({ numeric: { value: 1 } });
    expect(productionOf(l, '存在しない工程', 'R', '台', project).reworkStarted).toMatchObject({ numeric: { value: 0 } });
    expect(requireQuantityTotals(l, emptySupply)).toBeUndefined();
  });
});
