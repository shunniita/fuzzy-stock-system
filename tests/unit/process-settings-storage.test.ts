import { describe, expect, test } from 'vitest';
import { changeMasters, emptyLedger, legacyProcesses, merge, practiceLedger, recordStop, register, start, type Ledger, type Meta, type Process } from '../../src/domain/ledger.ts';
import { fixedMasters, nextProcessOf } from '../../src/domain/masters.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { initial, parse, serialize, type Snapshot } from '../../src/ui/storage.ts';
import { decodePending } from '../../src/ui/storageparse.ts';
import { backupTextOf, readBackup } from '../../src/ui/backup.ts';
import { legacyOperationCases } from '../fixtures/public-operation-v10/cases.ts';
import { conflictV5 } from '../fixtures/conflict-v5/cases.ts';
import { withProcesses } from './process-fixture.ts';
import { legacyPrecisionCases } from '../fixtures/precision-legacy/cases.ts';
import consumablesV10 from '../fixtures/consumables-v10/partial.json?raw';

const meta = (eventId: string): Meta => ({ eventId, occurredAt: '2026-10-27T09:00:00+09:00', recordedAt: '2026-10-27T09:00:00+09:00', actor: '架空担当A' });
const assembly: Process = { id: 'R組立', criterion: 'inspection' };
const product = (id: string) => ({ id, item: 'R', unit: '台', project: { kind: 'case' as const, id: 'A-001' }, location: 'T' });

// 版11のwriterと同じく、工程の設定と次工程の指定を持たない形に戻す。
function asV11(ledger: Ledger): string {
  return JSON.stringify({ ...JSON.parse(serialize(initial(ledger, emptySupply))), version: 11 },
    (key, value: unknown) => key === 'processes' || key === 'nextProcess' ? undefined : value);
}

// 固定fixtureの中の保存写しをすべて集める。どのfixtureも現行codecで再生成しない旧writerの原文。
function snapshotsIn(value: unknown): string[] {
  if (typeof value === 'string') {
    if (value.startsWith('{"format":"fuzzy-stock-f0"')) return [value];
    if (value.startsWith('{') || value.startsWith('[')) { try { return snapshotsIn(JSON.parse(value)); } catch { return []; } }
    return [];
  }
  if (typeof value !== 'object' || value === null) return [];
  return Object.values(value).flatMap(snapshotsIn);
}

describe('工程の設定 1.1: 空・練習用の台帳と保存版12', () => {
  test('空の台帳は工程も次工程の指定もなく、練習用だけがR組立とNを持つ', () => {
    expect(emptyLedger.masters.processes).toEqual({});
    expect(nextProcessOf(emptyLedger.masters)).toBeNull();
    expect(practiceLedger.masters.processes).toEqual({ R組立: { type: 'process', id: 'R組立', name: 'R組立', criterion: 'inspection', active: true } });
    expect(nextProcessOf(practiceLedger.masters)?.id).toBe('N');
    expect(fixedMasters.processes).toEqual({});
    expect(Object.values(practiceLedger.masters.locations).filter(l => l.nextProcess).map(l => l.id)).toEqual(['N']);
  });

  test.each([['空', emptyLedger], ['練習用', practiceLedger]] as const)('%sの台帳を版12で書いて同じ工程と指定に読み戻す', (_name, ledger) => {
    const text = serialize(initial(ledger, emptySupply));
    expect(JSON.parse(text)).toMatchObject({ version: 12, ledger: { masters: { processes: expect.any(Object) } } });
    expect(parse(text)?.ledger.masters).toEqual(ledger.masters);
  });

  test('版12で工程の設定か次工程の指定が欠ければ拒否し、版11に新しい欄があれば拒否する', () => {
    const current = JSON.parse(serialize(initial(practiceLedger, emptySupply)));
    const { processes: _, ...withoutProcesses } = current.ledger.masters;
    expect(() => parse(JSON.stringify({ ...current, ledger: { ...current.ledger, masters: withoutProcesses } }))).toThrow('processes');
    const { nextProcess: _n, ...withoutFlag } = current.ledger.masters.locations.N;
    expect(() => parse(JSON.stringify({ ...current, ledger: { ...current.ledger, masters: { ...current.ledger.masters, locations: { ...current.ledger.masters.locations, N: withoutFlag } } } }))).toThrow('nextProcess');
    expect(() => parse(JSON.stringify({ ...current, version: 11 }, (key, value: unknown) => key === 'nextProcess' ? undefined : value))).toThrow('旧版は工程の設定を持たない');
    expect(() => parse(JSON.stringify({ ...current, version: 11 }, (key, value: unknown) => key === 'processes' ? undefined : value))).toThrow('旧版は次工程の指定を持たない');
  });
});

describe('工程の設定 1.1: 旧版の補い（5.3・5.4・5.5）', () => {
  test('製造をしていない旧版の台帳は工程を補わず、場所Nだけを次工程とする', () => {
    const read = parse(asV11(practiceLedger))!;
    expect(read.ledger.masters.processes).toEqual({});
    expect(nextProcessOf(read.ledger.masters)?.id).toBe('N');
  });

  test('旧版の着手・自由入力の工程・停止に現れる工程を、現れた名前と完了基準のまま利用中で補う', () => {
    let l = start(practiceLedger, meta('s1'), product('R1'), assembly, 'counted', 3, []);
    l = register(withProcesses(l, { id: '架空の手入力工程', criterion: 'workEnd' }), meta('r1'), { ...product('R2'), stage: { kind: 'working', process: { id: '架空の手入力工程', criterion: 'workEnd' } } }, 'counted', 1);
    l = recordStop(l, meta('stop'), { process: 'R組立', item: 'R', unit: '台', project: { kind: 'case', id: 'A-001' }, reason: '架空', shortage: null, affected: null });
    const read = parse(asV11(l))!;
    expect(read.ledger.masters.processes).toEqual({
      R組立: { type: 'process', id: 'R組立', name: 'R組立', criterion: 'inspection', active: true },
      架空の手入力工程: { type: 'process', id: '架空の手入力工程', name: '架空の手入力工程', criterion: 'workEnd', active: true },
    });
    expect(read.ledger.lots).toEqual(l.lots);
    expect(read.ledger.history.map(e => e.eventId)).toEqual(l.history.map(e => e.eventId));
  });

  test('停止にだけ現れる工程はR組立だけを補い、同じ工程に別の完了基準を写した旧形の記録も読んで最初の完了基準を使う', () => {
    const stopped = recordStop(practiceLedger, meta('stop'), { process: 'R組立', item: 'R', unit: '台', project: { kind: 'common' }, reason: '架空', shortage: null, affected: null });
    expect(legacyProcesses(stopped)).toEqual({ R組立: { type: 'process', id: 'R組立', name: 'R組立', criterion: 'inspection', active: true } });
    expect(() => legacyProcesses({ ...stopped, stops: { x: { ...stopped.stops.stop!, id: 'x', process: '架空の不明工程' } } })).toThrow('完了基準が分からない');
    // 旧版の手入力は同じ工程IDに別の完了基準を写せたので、記録を直接書き換えて作る。
    let l = withProcesses(practiceLedger, { id: '架空工程', criterion: 'workEnd' }, { id: '架空工程B', criterion: 'inspection' });
    l = register(l, meta('a'), { ...product('A'), stage: { kind: 'working', process: { id: '架空工程', criterion: 'workEnd' } } }, 'counted', 1);
    l = register(l, meta('b'), { ...product('B'), stage: { kind: 'working', process: { id: '架空工程B', criterion: 'inspection' } } }, 'counted', 1);
    const read = parse(asV11(l).replaceAll('架空工程B', '架空工程'))!;
    expect(read.ledger.masters.processes['架空工程']?.criterion).toBe('workEnd');
    expect(read.ledger.lots.B?.stage).toEqual({ kind: 'working', process: { id: '架空工程', criterion: 'inspection' } });
    // 片方の完了基準で確認を飛ばさないよう、同じ工程IDでも完了基準の違う物は統合しない。
    for (const [source, target] of [['B', 'A'], ['A', 'B']] as const) expect(() => merge(read.ledger, meta(`m-${source}`), source, target)).toThrow('工程の完了基準が違う保管単位は統合できない');
  });

  test('停止の記録がある工程は、あとから別の完了基準の記録が増えても補う完了基準が変わらない', () => {
    const stopped = recordStop(practiceLedger, meta('stop'), { process: 'R組立', item: 'R', unit: '台', project: { kind: 'common' }, reason: '架空', shortage: null, affected: null });
    const before = legacyProcesses(stopped);
    const later = register(withProcesses(stopped, { id: 'X', criterion: 'workEnd' }), meta('rw'), { ...product('W'), stage: { kind: 'working', process: { id: 'X', criterion: 'workEnd' } } }, 'counted', 1);
    const mixed = { ...later, lots: { ...later.lots, W: { ...later.lots.W!, stage: { kind: 'working' as const, process: { id: 'R組立', criterion: 'workEnd' as const } } } } };
    expect(before['R組立']?.criterion).toBe('inspection');
    expect(legacyProcesses(mixed)['R組立']?.criterion).toBe('inspection');
  });

  test('旧版で場所Nを利用停止していても読込を失敗させず、指定の解除か再開で抜けられる', () => {
    // 版11までは場所Nを利用停止できた。現行の操作では止められないので、旧版の記録を直接書き換えて作る。
    const old = JSON.parse(asV11(practiceLedger)); old.ledger.masters.locations.N.active = false;
    const read = parse(JSON.stringify(old))!;
    expect(read.ledger.masters.locations.N).toMatchObject({ active: false, nextProcess: true });
    expect(nextProcessOf(changeMasters(read.ledger, meta('clear'), { action: 'nextProcess', id: null, reason: '解除' }).masters)).toBeNull();
    expect(changeMasters(read.ledger, meta('on'), { action: 'reactivate', type: 'location', id: 'N', reason: '再開' }).masters.locations.N?.active).toBe(true);
  });

  test('旧版で場所Nに製造中の物があっても読込を失敗させない', () => {
    // 現行の操作ではNに置けないので、旧版の記録を直接書き換えて作る。
    const old = JSON.parse(asV11(register(practiceLedger, meta('rn'), { ...product('Rn'), stage: { kind: 'working', process: assembly } }, 'counted', 1)));
    old.ledger.lots.Rn.location = 'N';
    old.ledger.history[0].changes[0].after.location = 'N';
    const read = parse(JSON.stringify(old));
    expect(read?.ledger.lots.Rn?.location).toBe('N');
    expect(read?.ledger.masters.processes['R組立']?.criterion).toBe('inspection');
  });

  test('旧writerの固定fixtureはすべて版12として読め、記録に現れた工程だけを補う', () => {
    const texts = [...snapshotsIn(legacyOperationCases), ...snapshotsIn(conflictV5), ...snapshotsIn(legacyPrecisionCases), ...snapshotsIn(JSON.parse(consumablesV10))];
    expect(texts.length).toBeGreaterThan(10);
    for (const text of texts) {
      const read = parse(text)!;
      expect(read.ledger.masters.processes).toEqual(legacyProcesses(read.ledger));
      expect(Object.values(read.ledger.masters.locations).filter(l => l.nextProcess).map(l => l.id)).toEqual(Object.hasOwn(read.ledger.masters.locations, 'N') ? ['N'] : []);
    }
  });
});

describe('工程の設定 1.3: 工程と指定の整合を読込の各入口で検査する（6.5）', () => {
  const current = () => JSON.parse(serialize(initial(start(practiceLedger, meta('s'), product('W'), assembly, 'counted', 2, []), emptySupply)));
  const damaged: [string, (s: ReturnType<typeof current>) => void, string][] = [
    ['工程の名前の重複', s => { s.ledger.masters.processes.X = { type: 'process', id: 'X', name: ' R組立 ', criterion: 'workEnd', active: true }; }, '名前「R組立」が重なっている'],
    ['完了基準の不正', s => { s.ledger.masters.processes.R組立.criterion = 'later'; }, 'criterion'],
    ['記録に使われた工程の欠落', s => { delete s.ledger.masters.processes.R組立; }, '工程 R組立 が登録されていない'],
    ['二か所の次工程', s => { s.ledger.masters.locations.T.nextProcess = true; }, '一か所まで'],
  ];
  test.each(damaged)('%sは通常読込・保存途中・バックアップ復元で拒否する', (_name, damage, reason) => {
    const s = current();
    damage(s);
    expect(() => parse(JSON.stringify(s))).toThrow(reason);
    expect(() => decodePending({ format: 'fuzzy-stock-pending', version: 12, quantities: s.quantities, pending: { progress: 'saving', unknownSince: null, savingSince: '2026-10-27T09:00:00+09:00', baseRevision: 0, opId: 'op1', opLabel: '架空', fingerprint: 'f', values: {}, actor: '架空担当A', startedAt: '2026-10-27T09:00:00+09:00', units: [{ ledger: s.ledger, supply: s.supply, conflictReviews: [], targets: [] }] } })).toThrow(reason);
    expect(readBackup(new TextEncoder().encode(backupTextOf(s as Snapshot, '2026-10-27T09:00:00+09:00')))).toMatchObject({ kind: 'unreadable', reason: expect.stringContaining(reason) });
  });
});
