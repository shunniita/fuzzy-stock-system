import { describe, expect, test } from 'vitest';
import { beginRework, changeStage, correctOccurredAt, practiceLedger as practiceBase, handOver, merge, recordReworkPart, recount, register, split, start, use, type Ledger, type Meta, type Process, type Project, type ReworkPartRequest } from '../../src/domain/ledger.ts';
import { withProcesses } from './process-fixture.ts';
const practiceLedger = withProcesses(practiceBase, { id: '架空組立', criterion: 'workEnd' });

const project = { kind: 'case', id: 'A-001' } satisfies Project;
const process = { id: '架空組立', criterion: 'workEnd' } satisfies Process;
const at = (hour: number, minute = 0) => `2026-10-21T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+09:00`;
const meta = (eventId: string, hour = 12, minute = 0): Meta => ({ eventId, occurredAt: at(hour, minute), recordedAt: at(22), actor: '架空担当A' });
const done = { kind: 'awaitingHandover', process } as const;
const working = { kind: 'working', process } as const;

function begun(): Ledger {
  let l = register(practiceLedger, meta('parts', 8), { id: 'parts', item: 'P', unit: '個', project, location: 'S1' }, 'counted', 100);
  l = use(l, meta('original-use', 9), 'parts', 'counted', 20, '初回組立');
  l = start(l, meta('start', 10), { id: 'working', item: 'R', unit: '台', project, location: 'T' }, process, 'counted', 20, ['original-use']);
  l = changeStage(l, meta('complete', 11), 'working', 'finished', 'counted', 20, done);
  return beginRework(l, meta('rework', 12), 'finished', 'repair', 'counted', 20, '架空のやり直し・修理');
}
const discard = (subjectLotId: string, reworkId = 'rework'): ReworkPartRequest => ({ action: 'discard', reworkId, subjectLotId, item: 'P', unit: '個', value: 1, reason: '取外し廃棄' });
const unchanged = (l: Ledger, run: () => unknown, message: RegExp) => {
  const before = JSON.stringify(l);
  expect(run).toThrow(message);
  expect(JSON.stringify(l)).toBe(before);
};

describe('要件1：新しい部品処置の対象枝', () => {
  test('1.1: 対象枝を記録し、未指定は拒否', () => {
    const l = begun();
    const next = recordReworkPart(l, meta('d', 13), discard('repair'));
    expect(next.history.at(-1)).toMatchObject({ kind: 'reworkPart', subjectLotId: 'repair' });
    unchanged(l, () => recordReworkPart(l, meta('d', 13), discard(' ')), /対象枝/);
  });

  test('1.2: 別のやり直し・修理の枝や無関係の単位は拒否', () => {
    let l = begun();
    l = changeStage(l, meta('half', 13), 'repair', 'half-done', 'counted', 10, done);
    l = beginRework(l, meta('other', 14), 'half-done', 'other', 'counted', 1, '別のやり直し・修理');
    unchanged(l, () => recordReworkPart(l, meta('d', 15), discard('other')), /確かめられない/);
    unchanged(l, () => recordReworkPart(l, meta('d', 15), discard('parts')), /作業中/);
    expect(recordReworkPart(l, meta('d', 15), discard('other', 'other')).history.at(-1)).toMatchObject({ subjectLotId: 'other' });
  });

  test('1.3: 再完了した枝・作業をしていない枝への新しい処置は拒否', () => {
    const l = changeStage(begun(), meta('re', 13), 'repair', 'redone', 'counted', 20, done);
    unchanged(l, () => recordReworkPart(l, meta('d', 14), discard('redone')), /別のやり直し・修理/);
  });

  test('1.4: やり直し・修理外の作業中を統合した枝は、統合より前と言えない処置を拒否し、子孫どうしの統合は許す', () => {
    let l = register(begun(), meta('new', 12, 30), { id: 'new', item: 'R', unit: '台', project, location: 'T', stage: working }, 'counted', 3);
    l = split(l, meta('split', 12, 40), 'repair', 'piece', 'counted', 5);
    l = merge(l, meta('mixed', 13), 'new', 'repair');
    unchanged(l, () => recordReworkPart(l, meta('d', 14), discard('repair')), /確かめられない/);
    expect(recordReworkPart(l, meta('d', 12, 50), discard('repair')).history.at(-1)).toMatchObject({ subjectLotId: 'repair' });
    expect(recordReworkPart(l, meta('d', 14), discard('piece')).history.at(-1)).toMatchObject({ subjectLotId: 'piece' });
    const pure = merge(split(begun(), meta('s', 13), 'repair', 'p2', 'counted', 5), meta('m', 14), 'p2', 'repair');
    expect(recordReworkPart(pure, meta('d', 15), discard('repair')).history.at(-1)).toMatchObject({ subjectLotId: 'repair' });
  });
});

describe('要件2：作業区間と処置の日時', () => {
  test('2.1: 対象枝ができる前の処置は拒否', () => {
    const l = split(begun(), meta('s', 14), 'repair', 'late', 'counted', 5);
    unchanged(l, () => recordReworkPart(l, meta('d', 13), discard('late')), /できる前/);
  });

  test('2.2・2.4: 13時全量再完了・14時引渡し後、15時に12時30分の処置を後入力でき、13時30分の処置は拒否', () => {
    let l = changeStage(begun(), meta('re', 13), 'repair', 'redone', 'counted', 20, done);
    l = handOver(l, meta('out', 14), 'redone', 'counted', 20, '架空の外');
    const late = (minute: number, hour: number): Meta => ({ ...meta('late', hour, minute), recordedAt: at(15) });
    const next = recordReworkPart(l, late(30, 12), { action: 'replace', reworkId: 'rework', subjectLotId: 'repair', lotId: 'parts', value: 2, reason: '後入力' });
    expect(next.lots.parts?.quantity).toMatchObject({ numeric: { value: 78 } });
    unchanged(l, () => recordReworkPart(l, late(30, 13), discard('repair')), /空になった後/);
  });

  test('2.5: 18台だけ再完了した後、残り2台の枝へは記録でき、18台の枝へは拒否', () => {
    const l = changeStage(begun(), meta('re', 13), 'repair', 'redone', 'counted', 18, done);
    expect(recordReworkPart(l, meta('d', 14), discard('repair')).history.at(-1)).toMatchObject({ subjectLotId: 'repair' });
    unchanged(l, () => recordReworkPart(l, meta('d', 14), discard('redone')), /別のやり直し・修理/);
  });

  test('2.3: 処置の実際の日時が不明なら拒否', () => {
    const l = begun();
    unchanged(l, () => recordReworkPart(l, { ...meta('d', 13), occurredAt: null }, discard('repair')), /実際の日時/);
  });

  test('2.3: 空にした操作の日時が不明なら、その後の処置も拒否', () => {
    const l = changeStage(begun(), { ...meta('re', 13), occurredAt: null }, 'repair', 'redone', 'counted', 20, done);
    unchanged(l, () => recordReworkPart(l, meta('d', 12, 30), discard('repair')), /日時/);
  });
});

describe('要件3：後からの変更で矛盾を作らない', () => {
  const treated = () => recordReworkPart(begun(), meta('d', 12, 30), discard('repair'));

  test('3.1: 処置より前に全量完了・統合した後入力は拒否し、後なら記録', () => {
    const l = treated();
    unchanged(l, () => changeStage(l, meta('re', 12, 15), 'repair', 'redone', 'counted', 20, done), /空/);
    expect(changeStage(l, meta('re', 13), 'repair', 'redone', 'counted', 20, done).lots.redone).toBeDefined();
    const target = register(l, meta('w2', 11), { id: 'w2', item: 'R', unit: '台', project, location: 'T', stage: working }, 'counted', 1);
    unchanged(target, () => merge(target, meta('m', 12, 15), 'repair', 'w2'), /空/);
  });

  test('3.1: 処置した枝を日時不明で全量完了する記録は拒否', () => {
    const l = treated();
    unchanged(l, () => changeStage(l, { ...meta('re', 13), occurredAt: null }, 'repair', 'redone', 'counted', 20, done), /日時/);
  });

  test('3.1: 処置より後のやり直し・修理外の統合は通し、前と言えないなら拒否', () => {
    const l = register(treated(), meta('new', 11), { id: 'new', item: 'R', unit: '台', project, location: 'T', stage: working }, 'counted', 3);
    expect(merge(l, meta('m', 13), 'new', 'repair').lots.new?.mergedInto).toBe('repair');
    unchanged(l, () => merge(l, meta('m', 12, 15), 'new', 'repair'), /確かめられない/);
  });

  test('1.4: やり直し・修理外を受け入れた子孫を、さらに統合した枝も混在として拒否', () => {
    let l = split(begun(), meta('s', 12, 10), 'repair', 'd2', 'counted', 5);
    l = register(l, meta('new', 11), { id: 'new', item: 'R', unit: '台', project, location: 'T', stage: working }, 'counted', 3);
    l = merge(l, meta('m1', 12, 20), 'new', 'd2');
    l = merge(l, meta('m2', 12, 30), 'd2', 'repair');
    unchanged(l, () => recordReworkPart(l, meta('d', 13), discard('repair')), /確かめられない/);
  });

  test('1.4: 同じやり直し・修理の枝を分けて戻す統合は、同時刻・分割日時不明・処置後の日時不明でも妨げない', () => {
    const same = merge(split(begun(), meta('s', 12, 10), 'repair', 'p1', 'counted', 5), meta('m', 12, 10), 'p1', 'repair');
    expect(recordReworkPart(same, meta('d', 13), discard('repair')).history.at(-1)).toMatchObject({ subjectLotId: 'repair' });
    const unknownSplit = merge(split(begun(), { ...meta('s'), occurredAt: null }, 'repair', 'p1', 'counted', 5), meta('m', 12, 20), 'p1', 'repair');
    expect(recordReworkPart(unknownSplit, meta('d', 13), discard('repair')).history.at(-1)).toMatchObject({ subjectLotId: 'repair' });
    const treated = recordReworkPart(split(begun(), meta('s', 12, 10), 'repair', 'p1', 'counted', 5), meta('d', 12, 30), discard('repair'));
    expect(merge(treated, { ...meta('m'), occurredAt: null }, 'p1', 'repair').lots.p1?.mergedInto).toBe('repair');
  });

  test('3.1: 統合元側の祖先へやり直し・修理外を統合する後入力も拒否し、保存後に読めない台帳を作らない', () => {
    let l = split(begun(), meta('s1', 12, 10), 'repair', 'p1', 'counted', 5);
    l = split(l, meta('s2', 12, 20), 'p1', 'q', 'counted', 2);
    l = merge(l, meta('m', 12, 30), 'q', 'repair');
    l = recordReworkPart(l, meta('d', 13), discard('repair'));
    l = register(l, meta('new', 11), { id: 'x', item: 'R', unit: '台', project, location: 'T', stage: working }, 'counted', 3);
    unchanged(l, () => merge(l, meta('mx', 12, 15), 'x', 'p1'), /確かめられない/);
  });

  test('1.4・3.1: やり直し・修理外の物を日時不明で統合した枝は、前後不明として処置も統合も拒否', () => {
    const l = register(begun(), meta('new', 11), { id: 'new', item: 'R', unit: '台', project, location: 'T', stage: working }, 'counted', 3);
    const mixed = merge(l, { ...meta('m'), occurredAt: null }, 'new', 'repair');
    unchanged(mixed, () => recordReworkPart(mixed, meta('d', 13), discard('repair')), /確かめられない/);
    const treated = recordReworkPart(l, meta('d', 12, 30), discard('repair'));
    unchanged(treated, () => merge(treated, { ...meta('m'), occurredAt: null }, 'new', 'repair'), /確かめられない/);
  });

  test('2.2: 0への数え直しで枝を空にした後の処置は拒否', () => {
    const l = recount(begun(), meta('c', 13), 'repair', 0, { kind: 'unknown' });
    unchanged(l, () => recordReworkPart(l, meta('d', 13, 30), discard('repair')), /空になった後/);
    expect(recordReworkPart(l, meta('d', 12, 30), discard('repair')).history.at(-1)).toMatchObject({ subjectLotId: 'repair' });
  });

  test('2.2: 推定の根拠で全量を移しても、空にした操作として扱う', () => {
    const l = changeStage(begun(), meta('re', 13), 'repair', 'redone', 'approximate', 20, done);
    unchanged(l, () => recordReworkPart(l, meta('d', 13, 30), discard('repair')), /空になった後/);
  });

  test('3.2: 処置や完了の日時訂正で区間を外れるなら拒否', () => {
    const l = changeStage(treated(), meta('re', 13), 'repair', 'redone', 'counted', 20, done);
    unchanged(l, () => correctOccurredAt(l, meta('fix', 14), 'd', at(13, 30)), /空/);
    unchanged(l, () => correctOccurredAt(l, meta('fix', 14), 're', at(12, 15)), /空/);
    unchanged(l, () => correctOccurredAt(l, meta('fix', 14), 'd', null), /実際の日時/);
    expect(correctOccurredAt(l, meta('fix', 14), 'd', at(12, 45)).history.at(-1)).toMatchObject({ kind: 'correctTime' });
  });

  test('3.2: 対象枝を作った分割や、やり直し・修理外の統合の日時訂正で矛盾するなら拒否', () => {
    let l = split(begun(), meta('s', 12, 10), 'repair', 'piece', 'counted', 5);
    l = recordReworkPart(l, meta('d', 12, 30), discard('piece'));
    unchanged(l, () => correctOccurredAt(l, meta('fix', 14), 's', at(12, 40)), /できる前/);
    let m = register(begun(), meta('new', 11), { id: 'new', item: 'R', unit: '台', project, location: 'T', stage: working }, 'counted', 3);
    m = recordReworkPart(merge(m, meta('m', 13), 'new', 'repair'), meta('d', 12, 30), discard('repair'));
    unchanged(m, () => correctOccurredAt(m, meta('fix', 14), 'm', at(12, 15)), /確かめられない/);
  });

  test('3.3: 対象枝のない旧記録には新しい照合を適用しない', () => {
    const l = treated();
    const legacy: Ledger = { ...l, history: l.history.map(e => {
      if (e.kind !== 'reworkPart') return e;
      const { subjectLotId: _, ...rest } = e;
      return { ...rest, occurredAt: at(13, 30) };
    }) };
    expect(changeStage(legacy, meta('re', 13), 'repair', 'redone', 'counted', 20, done).lots.redone).toBeDefined();
  });
});
