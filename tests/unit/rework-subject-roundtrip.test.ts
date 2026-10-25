import { describe, expect, test } from 'vitest';
import { beginRework, changeStage, correctOccurredAt, practiceLedger, handOver, merge, recordReworkPart, recount, register, split, type Ledger, type Meta } from '../../src/domain/ledger.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { backupTextOf, readBackup } from '../../src/ui/backup.ts';
import { initial, parse, serialize, serializePending, type Pending } from '../../src/ui/storage.ts';
import { decodePending } from '../../src/ui/storageparse.ts';

const at = (hour: number, minute = 0) => `2026-10-21T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+09:00`;
const meta = (eventId: string, hour = 12, minute = 0): Meta => ({ eventId, occurredAt: at(hour, minute), recordedAt: at(22), actor: '架空担当A' });
const project = { kind: 'case', id: 'A-001' } as const;
const process = { id: '架空組立', criterion: 'workEnd' } as const;
const done = { kind: 'awaitingHandover', process } as const;
const working = { kind: 'working', process } as const;
function begun(): Ledger {
  const l = register(practiceLedger, meta('register', 11), { id: 'finished', item: 'R', unit: '台', project, location: 'T', stage: done }, 'counted', 20);
  return beginRework(l, meta('rework'), 'finished', 'repair', 'counted', 20, '架空やり直し・修理');
}
const treat = (l: Ledger, hour = 12, minute = 30) => recordReworkPart(l, meta('treat', hour, minute), { action: 'discard', reworkId: 'rework', subjectLotId: 'repair', item: 'P', unit: '個', value: 1, reason: '架空処置' });
function roundtrip(l: Ledger): void {
  const snapshot = initial(l, emptySupply);
  expect(parse(serialize(snapshot))).toEqual(snapshot);
  const backup = readBackup(new TextEncoder().encode(backupTextOf(snapshot, at(22))));
  expect(backup.kind).toBe('ok');
  if (backup.kind === 'ok') expect(backup.snapshot).toEqual(snapshot);
  const pending: Pending = { progress: 'saving', unknownSince: null, savingSince: at(22), baseRevision: 0, opId: 'op1', opLabel: '架空処置', fingerprint: 'fictional', values: {}, actor: '架空担当A', startedAt: at(22), units: [{ ledger: l, supply: emptySupply, conflictReviews: [], targets: ['まとまりrepair'] }] };
  expect(decodePending(JSON.parse(serializePending(pending)))).toEqual(pending);
}

describe('対象枝4.1: 受理した境界操作はsnapshot・backup・pendingを往復できる', () => {
  const cases: [string, () => Ledger][] = [
    ['通常処置', () => treat(begun())],
    ['同じ枝の分割と同時刻統合', () => treat(merge(split(begun(), meta('split', 12, 10), 'repair', 'piece', 'counted', 5), meta('merge', 12, 10), 'piece', 'repair'), 13)],
    ['分割日時不明の純粋な枝統合', () => treat(merge(split(begun(), { ...meta('split'), occurredAt: null }, 'repair', 'piece', 'counted', 5), meta('merge', 12, 20), 'piece', 'repair'), 13)],
    ['処置後の純粋な枝統合は日時不明でも受理', () => merge(treat(split(begun(), meta('split', 12, 10), 'repair', 'piece', 'counted', 5)), { ...meta('merge'), occurredAt: null }, 'piece', 'repair')],
    ['部分再完了の残りへの処置', () => treat(changeStage(begun(), meta('complete', 13), 'repair', 'redone', 'counted', 18, done), 14)],
    ['全量再完了と引渡し後の過去処置', () => treat(handOver(changeStage(begun(), meta('complete', 13), 'repair', 'redone', 'counted', 20, done), meta('handover', 14), 'redone', 'counted', 20, '架空の外'))],
    ['0への数え直し前の過去処置', () => treat(recount(begun(), meta('zero', 13), 'repair', 0, { kind: 'unknown' }))],
    ['処置後に外部の枝を統合', () => merge(register(treat(begun()), meta('external', 11), { id: 'external', item: 'R', unit: '台', project, location: 'T', stage: working }, 'counted', 3), meta('merge', 13), 'external', 'repair')],
    ['処置後の全量再完了', () => changeStage(treat(begun()), meta('complete', 13), 'repair', 'redone', 'counted', 20, done)],
    ['区間内の日時訂正', () => correctOccurredAt(changeStage(treat(begun()), meta('complete', 13), 'repair', 'redone', 'counted', 20, done), meta('correct', 14), 'treat', at(12, 45))],
  ];
  test.each(cases)('%s', (_name, make) => roundtrip(make()));

  test('対象枝4.2: 対象枝なし旧記録を補完せず三経路で保持する', () => {
    const l = treat(begun());
    const legacy: Ledger = { ...l, history: l.history.map(e => {
      if (e.kind !== 'reworkPart') return e;
      const { subjectLotId: _subject, ...old } = e;
      return old;
    }) };
    roundtrip(legacy);
    expect(legacy.history.some(e => e.kind === 'reworkPart' && 'subjectLotId' in e)).toBe(false);
  });

  test('要件3.1: 拒否された後入力は原台帳とその保存表現を変更しない', () => {
    const l = treat(begun());
    const before = serialize(initial(l, emptySupply));
    expect(() => changeStage(l, meta('invalid-complete', 12, 15), 'repair', 'redone', 'counted', 20, done)).toThrow(/空/);
    expect(serialize(initial(l, emptySupply))).toBe(before);
    roundtrip(l);
  });
});
