import { describe, expect, test } from 'vitest';
import { beginReturnedRework, beginRework, changeStage, correctOccurredAt, practiceLedger, merge, move, recordProvisional, recordReworkPart, register, type Ledger, type Meta, type Process } from '../../src/domain/ledger.ts';
import { assignReturnedProvisional } from '../../src/domain/return-intake.ts';
import { emptySupply, receiveLot, reviseReceipt, type Supply } from '../../src/domain/supply.ts';
import { backupTextOf, readBackup } from '../../src/ui/backup.ts';
import { initial, parse, serialize, type Snapshot } from '../../src/ui/storage.ts';
import { decodePending } from '../../src/ui/storageparse.ts';

const at = '2026-10-22T00:00:00+09:00';
const meta = (eventId: string, hour = 14): Meta => ({ eventId, occurredAt: `2026-10-21T${hour}:00:00+09:00`, recordedAt: at, actor: '架空担当A' });
const process = { id: 'R組立', criterion: 'inspection' } satisfies Process;
const product = { id: 'returned', item: 'R', unit: '台', project: { kind: 'case', id: 'A-001' } as const, location: 'T' };
const request = { lotId: 'returned', adoptEventId: 'assign', childId: 'repair', process, basis: 'label', value: 2, reason: '戻りの物理作業', confirmedPhysical: true } as const;
function found(location = 'T'): Ledger {
  return recordProvisional(practiceLedger, meta('found', 12), { direction: 'found', item: 'R', location, basis: 'label', value: 2, note: '架空の戻り' });
}
function returned(location = 'T'): Ledger {
  return assignReturnedProvisional(found(location), meta('assign', 13), { kind: 'notIncluded', issueId: 'found', lot: { ...product, location }, reason: '現在数量に未包含', confirmed: true });
}
const pendingOf = (snapshot: Snapshot) => ({ format: 'fuzzy-stock-pending', version: 11, pending: {
  progress: 'saving', unknownSince: null, savingSince: at, baseRevision: 0, opId: 'op1', opLabel: '架空操作', fingerprint: 'f', values: {}, actor: '架空担当A', startedAt: at,
  units: [{ ledger: snapshot.ledger, supply: snapshot.supply, targets: [], conflictReviews: [] }],
} });

describe('MFG-02/FH-RRS-01: 工程IDと完了基準', () => {
  test('固定の架空工程の完了基準を初回の戻り開始でも変えられない', () => {
    const before = returned();
    expect(() => beginReturnedRework(before, meta('repair'), { ...request, process: { ...process, criterion: 'workEnd' } })).toThrow(/完了基準/);
    expect(before.lots['repair']).toBeUndefined();
  });
  test('既に記録した任意工程の完了基準を別の戻り開始で変えられない', () => {
    const custom = { id: '架空修理', criterion: 'inspection' } satisfies Process;
    const before = register(returned(), meta('normal', 10), { ...product, id: 'normal', stage: { kind: 'working', process: custom } }, 'label', 3);
    expect(() => beginReturnedRework(before, meta('repair'), { ...request, process: { ...custom, criterion: 'workEnd' } })).toThrow(/完了基準/);
  });
  test('工程IDの前後の空白で別の工程を作らず確認の完了を保つ', () => {
    const next = beginReturnedRework(returned(), meta('repair'), { ...request, process: { ...process, id: ' R組立 ' } });
    expect(next.lots['repair']?.stage).toEqual({ kind: 'working', process });
    expect(next.history.at(-1)).toMatchObject({ returnSource: { process } });
  });
  test('同じ工程IDでも完了基準の異なる既存の物はどちら向きにも統合しない', () => {
    let l = register(practiceLedger, meta('inspection', 10), { ...product, id: 'inspection', stage: { kind: 'working', process } }, 'label', 3);
    l = register(l, meta('work-end', 11), { ...product, id: 'work-end', stage: { kind: 'working', process: { ...process, criterion: 'workEnd' } } }, 'label', 2);
    const before = serialize(initial(l, emptySupply));
    expect(() => merge(l, meta('merge'), 'inspection', 'work-end')).toThrow(/完了基準/);
    expect(() => merge(l, meta('merge'), 'work-end', 'inspection')).toThrow(/完了基準/);
    expect(serialize(initial(l, emptySupply))).toBe(before);
  });
  test('MFG-06: 次工程Nの返ってきた物は移動してからやり直し・修理を始める', () => {
    const before = returned('N');
    expect(() => beginReturnedRework(before, meta('repair'), request)).toThrow(/次工程N.*移動/);
    expect(before.lots['repair']).toBeUndefined();
    const moved = move(before, meta('move'), 'returned', 'T');
    const next = beginReturnedRework(moved, meta('repair', 15), request);
    expect(next.lots['repair']).toMatchObject({ location: 'T', stage: { kind: 'working', process }, quantity: { numeric: { value: 2 } } });
    expect(parse(serialize(initial(next, emptySupply))).ledger).toEqual(next);
  });
});

test.each(['included', 'notIncluded'] as const)('FH-RI: 仮の記録より前の割当%sを履歴も数量も変えず拒否する', kind => {
  const before = register(found(), meta('existing', 10), { ...product, id: 'existing' }, 'label', 2);
  const common = { issueId: 'found', reason: '架空の照合', confirmed: true };
  const assignment = kind === 'included' ? { ...common, kind, lotId: 'existing' } : { ...common, kind, lot: product };
  expect(() => assignReturnedProvisional(before, meta('assign', 11), assignment)).toThrow(/仮の記録.*前/);
  expect(before.issues['found']?.resolution).toBeNull();
  expect(before.lots['returned']).toBeUndefined();
});

describe('REC-02a/DAT-04: 全受け取りの現在値と履歴', () => {
  const received = () => receiveLot(practiceLedger, emptySupply, meta('receive', 10), { ...product, id: 'receipt' }, 'label', 10, '000架空ラベル');
  for (const boundary of ['snapshot', 'pending', 'backup'] as const) {
    test.each(['quantity', 'eventId', 'label', 'provisional', 'missing', 'extra', 'revision-before', 'duplicate'] as const)(`${boundary}: 通常受け取りの%s改変を拒否する`, damage => {
      const state = received(), receipt = state.supply.receipts['receipt']!;
      let supply: Supply = state.supply;
      if (damage === 'missing') supply = { ...supply, receipts: {} };
      else if (damage === 'extra') supply = { ...supply, receipts: { ...supply.receipts, other: receipt } };
      else if (damage === 'revision-before') {
        const revised = reviseReceipt(state.ledger, supply, meta('revise', 12), 'receipt', 11, '架空の数量訂正');
        supply = { ...revised, log: revised.log.map(e => e.kind === 'receiptRevise' ? { ...e, before: 9 } : e) };
      } else if (damage === 'duplicate') supply = { ...supply, log: [...supply.log, { ...supply.log[0]!, eventId: 'duplicate' }] };
      else supply = { ...supply, receipts: { receipt: { ...receipt,
        ...(damage === 'quantity' ? { received: 11 } : damage === 'eventId' ? { eventId: 'forged' } : damage === 'label' ? { label: '別ラベル' } : { provisional: false }),
      } } };
      const snapshot = initial(state.ledger, supply);
      if (boundary === 'snapshot') expect(() => parse(serialize(snapshot))).toThrow(/受け取り/);
      else if (boundary === 'pending') expect(() => decodePending(pendingOf(snapshot))).toThrow(/受け取り/);
      else expect(readBackup(new TextEncoder().encode(backupTextOf(snapshot, at))).kind).toBe('unreadable');
    });
  }
  test('受け取り後の数量訂正・実際の日時訂正・数が不明を全保存境界で保持する', () => {
    const state = received();
    let supply = reviseReceipt(state.ledger, state.supply, meta('revise1', 12), 'receipt', 10, '実数の確認');
    supply = reviseReceipt(state.ledger, supply, meta('revise2', 13), 'receipt', 11, '実数の訂正');
    let ledger = correctOccurredAt(state.ledger, meta('time'), 'receive', null);
    ({ ledger, supply } = receiveLot(ledger, supply, meta('unknown'), { ...product, id: 'unknown' }, 'unknown', null));
    const snapshot = initial(ledger, supply);
    expect(parse(serialize(snapshot))).toEqual(snapshot);
    expect(decodePending(pendingOf(snapshot)).units[0]?.supply).toEqual(supply);
    expect(readBackup(new TextEncoder().encode(backupTextOf(snapshot, at)))).toMatchObject({ kind: 'ok', snapshot });
  });
});

test('FH-RS: 日時不明の閉鎖と位置訂正の拒否では実際の操作に合う案内を出す', () => {
  let l = register(practiceLedger, meta('done', 10), { ...product, id: 'done', stage: { kind: 'awaitingHandover', process } }, 'counted', 2);
  l = beginRework(l, meta('rework', 11), 'done', 'repair', 'counted', 2, '架空のやり直し・修理');
  const part = { action: 'discard', reworkId: 'rework', subjectLotId: 'repair', item: 'P', unit: '個', value: 1, reason: '架空の処置' } as const;
  const treated = recordReworkPart(l, meta('part', 12), part);
  expect(() => changeStage(treated, { ...meta('finish'), occurredAt: null }, 'repair', 'finished', 'counted', 2, { kind: 'inspecting', process })).toThrow(/日時が不明.*確認.*訂正/);
  l = changeStage(l, meta('finish', 12), 'repair', 'finished', 'counted', 2, { kind: 'awaitingHandover', process });
  l = changeStage(l, meta('fix', 13), 'finished', 'fixed', 'counted', 2, { kind: 'working', process }, undefined, true);
  expect(() => recordReworkPart(l, meta('part'), { ...part, subjectLotId: 'fixed' })).toThrow(/工程.*履歴.*確認/);
});
