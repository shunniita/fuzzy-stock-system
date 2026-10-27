import { describe, expect, test } from 'vitest';
import { changeMasters, changeStage, deepFreeze, emptyLedger, handOver, move, nextStage, practiceLedger, productionOf, register, start, type Ledger, type MasterRequest, type Meta, type Process } from '../../src/domain/ledger.ts';
import { nextProcessOf } from '../../src/domain/masters.ts';
import { withProcesses } from './process-fixture.ts';

const meta = (eventId: string, hour = 9): Meta => ({ eventId, occurredAt: `2026-10-27T${String(hour).padStart(2, '0')}:00:00+09:00`, recordedAt: '2026-10-27T18:00:00+09:00', actor: '架空担当A' });
const assembly: Process = { id: 'R組立', criterion: 'inspection' };
const finishing: Process = { id: '架空仕上げ', criterion: 'workEnd' };
const product = (id: string, location = 'T') => ({ id, item: 'R', unit: '台', project: { kind: 'case' as const, id: 'A-001' }, location });

function stopped(ledger: Ledger, id: string): Ledger {
  const process = ledger.masters.processes[id]!;
  return deepFreeze({ ...ledger, masters: { ...ledger.masters, processes: { ...ledger.masters.processes, [id]: { ...process, active: false } } } });
}

function withoutNextProcess(ledger: Ledger): Ledger {
  return deepFreeze({ ...ledger, masters: { ...ledger.masters, locations: Object.fromEntries(Object.entries(ledger.masters.locations).map(([id, l]) => [id, { ...l, nextProcess: false }])) } });
}

describe('工程の設定 1.2: 新しく工程に載せる記録は台帳の工程を要求する（4.1・4.3・4.4）', () => {
  test('未登録の工程・完了基準の違う工程では着手・登録・作業の位置の訂正を受け付けない', () => {
    const l = register(practiceLedger, meta('idle'), product('idle'), 'counted', 3);
    expect(() => start(l, meta('s'), product('W'), finishing, 'counted', 1, [])).toThrow('工程 架空仕上げ は登録されていない');
    expect(() => start(l, meta('s'), product('W'), { ...assembly, criterion: 'workEnd' }, 'counted', 1, [])).toThrow('完了基準が登録と異なる');
    expect(() => register(l, meta('r'), { ...product('W'), stage: { kind: 'working', process: finishing } }, 'counted', 1)).toThrow('登録されていない');
    expect(() => changeStage(l, meta('c'), 'idle', 'W', 'counted', 1, { kind: 'working', process: finishing }, undefined, true)).toThrow('登録されていない');
    expect(start(withProcesses(l, finishing), meta('s'), product('W'), finishing, 'counted', 1, []).lots.W?.stage).toEqual({ kind: 'working', process: finishing });
  });

  test('工程が一つもない空の台帳では固定の工程を補わない', () => {
    expect(emptyLedger.masters.processes).toEqual({});
    expect(() => start(emptyLedger, meta('s'), product('W'), assembly, 'counted', 1, [])).toThrow();
  });

  test('利用停止した工程では新しく着手しないが、進行中の物は完了基準どおりに作業終了・確認の完了・引渡し待ちへ進める', () => {
    let l = start(practiceLedger, meta('s', 9), product('W'), assembly, 'counted', 4, []);
    l = stopped(l, 'R組立');
    expect(() => start(l, meta('s2', 10), product('W2'), assembly, 'counted', 1, [])).toThrow('利用停止中');
    l = changeStage(l, meta('end', 11), 'W', 'W-i', 'counted', 4, nextStage(l.lots.W!.stage)!);
    expect(l.lots['W-i']?.stage).toEqual({ kind: 'inspecting', process: assembly });
    l = changeStage(l, meta('ok', 12), 'W-i', 'W-h', 'counted', 4, nextStage(l.lots['W-i']!.stage)!);
    expect(l.lots['W-h']?.stage).toEqual({ kind: 'awaitingHandover', process: assembly });
  });

  test('作業中の物の完了基準は、着手時の値から書き換えない', () => {
    const l = start(practiceLedger, meta('s'), product('W'), assembly, 'counted', 2, []);
    expect(() => changeStage(l, meta('c'), 'W', 'W2', 'counted', 1, { kind: 'awaitingHandover', process: { ...assembly, criterion: 'workEnd' } }, undefined, true)).toThrow('着手時のまま');
  });
});

describe('工程の設定 1.2: 次工程の場所は台帳の指定で判定する（3.2）', () => {
  test('指定された場所へは製造中の物を登録・移動・位置の変更で置かない', () => {
    expect(() => register(practiceLedger, meta('r'), { ...product('W', 'N'), stage: { kind: 'working', process: assembly } }, 'counted', 1)).toThrow('次工程N');
    const l = start(practiceLedger, meta('s'), product('W'), assembly, 'counted', 2, []);
    expect(() => move(l, meta('m', 10), 'W', 'N')).toThrow('次工程への引渡し');
    const idle = register(practiceLedger, meta('idle'), product('idle', 'N'), 'counted', 1);
    expect(() => changeStage(idle, meta('c'), 'idle', 'W', 'counted', 1, { kind: 'working', process: assembly }, undefined, true)).toThrow('次工程');
  });

  test('指定がなければ、どの場所にも配置の制約をかけない', () => {
    const l = withoutNextProcess(practiceLedger);
    expect(register(l, meta('r'), { ...product('W', 'N'), stage: { kind: 'working', process: assembly } }, 'counted', 1).lots.W?.location).toBe('N');
  });
});

const changed = (l: Ledger, eventId: string, request: MasterRequest, hour = 8) => changeMasters(l, meta(eventId, hour), request);

describe('工程の設定 2.1: 工程の登録・名前・完了基準・利用状況の変更（1.1〜2.5・6.1）', () => {
  test('工程を登録し、名前・完了基準・担当者・日時を履歴に残す。数量と保管単位は変えない', () => {
    const base = register(practiceLedger, meta('p'), product('idle'), 'counted', 3);
    const l = changed(base, 'reg', { action: 'register', master: { type: 'process', name: ' 塗装 ', criterion: 'workEnd' } });
    expect(l.masters.processes['塗装']).toEqual({ type: 'process', id: '塗装', name: '塗装', criterion: 'workEnd', active: true });
    expect(l.history.at(-1)).toMatchObject({ kind: 'master', action: 'register', actor: '架空担当A', changes: [], masters: [{ before: null, after: l.masters.processes['塗装'] }] });
    expect(l.lots).toEqual(base.lots);
  });

  test('空名・他の工程の現在の名前との重複・完了基準の未選択は拒否し、台帳を変えない', () => {
    const before = JSON.stringify(practiceLedger);
    expect(() => changed(practiceLedger, 'x', { action: 'register', master: { type: 'process', name: '  ', criterion: 'workEnd' } })).toThrow('工程の名前を入力する');
    expect(() => changed(practiceLedger, 'x', { action: 'register', master: { type: 'process', name: 'R組立 ', criterion: 'workEnd' } })).toThrow('同じ名前の工程「R組立」');
    expect(() => changed(practiceLedger, 'x', { action: 'register', master: { type: 'process', name: '塗装', criterion: '' as Process['criterion'] } })).toThrow('完了基準を選ぶ');
    expect(JSON.stringify(practiceLedger)).toBe(before);
  });

  test('名前を変えても識別は変えず、着手済みの物と工程内数は同じ工程にまとまる。空いた名前のIDは使わない', () => {
    let l = start(practiceLedger, meta('s', 9), product('W'), assembly, 'counted', 3, []);
    l = changed(l, 'rn', { action: 'rename', type: 'process', id: 'R組立', name: '組立ライン1', reason: '呼び方をそろえる' }, 10);
    expect(l.masters.processes['R組立']?.name).toBe('組立ライン1');
    expect(l.lots.W?.stage).toEqual({ kind: 'working', process: assembly });
    expect(productionOf(l, 'R組立', 'R', '台', { kind: 'case', id: 'A-001' }).working).toMatchObject({ numeric: { value: 3 } });
    l = start(l, meta('s2', 11), product('W2'), assembly, 'counted', 2, []);
    expect(productionOf(l, 'R組立', 'R', '台', { kind: 'case', id: 'A-001' }).working).toMatchObject({ numeric: { value: 5 } });
    expect(() => changed(l, 'rn2', { action: 'rename', type: 'process', id: 'R組立', name: '組立ライン1', reason: '同じ' })).toThrow('今と同じ名称');
    l = changed(l, 'again', { action: 'register', master: { type: 'process', name: 'R組立', criterion: 'workEnd' } }, 12);
    expect(l.masters.processes['process-again']).toMatchObject({ name: 'R組立', criterion: 'workEnd' });
    expect(() => changed(l, 'dup', { action: 'rename', type: 'process', id: 'process-again', name: ' 組立ライン1', reason: '重複' })).toThrow('同じ名前の工程');
  });

  test('記録に使われていない工程だけ完了基準を変えられる', () => {
    let l = changed(practiceLedger, 'reg', { action: 'register', master: { type: 'process', name: '塗装', criterion: 'workEnd' } });
    l = changed(l, 'cr', { action: 'criterion', id: '塗装', criterion: 'inspection', reason: '確認を入れる' });
    expect(l.masters.processes['塗装']?.criterion).toBe('inspection');
    expect(l.history.at(-1)).toMatchObject({ action: 'criterion', masters: [{ before: { criterion: 'workEnd' }, after: { criterion: 'inspection' } }] });
    expect(() => changed(l, 'same', { action: 'criterion', id: '塗装', criterion: 'inspection', reason: '同じ' })).toThrow('今と同じ完了基準');
    expect(() => changed(practiceLedger, 'used', { action: 'criterion', id: 'R組立', criterion: 'workEnd', reason: '使用前でも練習用は' })).not.toThrow();
    const used = start(practiceLedger, meta('s', 9), product('W'), assembly, 'counted', 1, []);
    expect(() => changed(used, 'used', { action: 'criterion', id: 'R組立', criterion: 'workEnd', reason: '変えたい' }, 10)).toThrow('記録に使われている');
  });

  test('利用停止で新しい着手から外れ、進行中の物は続けられ、再開で戻る', () => {
    let l = start(practiceLedger, meta('s', 8), product('W'), assembly, 'counted', 2, []);
    l = changed(l, 'off', { action: 'deactivate', type: 'process', id: 'R組立', reason: '休止' }, 9);
    expect(() => start(l, meta('s2', 10), product('W2'), assembly, 'counted', 1, [])).toThrow('利用停止中');
    l = changeStage(l, meta('end', 10), 'W', 'W-i', 'counted', 2, nextStage(l.lots.W!.stage)!);
    expect(l.lots['W-i']?.stage.kind).toBe('inspecting');
    l = changed(l, 'on', { action: 'reactivate', type: 'process', id: 'R組立', reason: '再開' }, 11);
    expect(start(l, meta('s3', 12), product('W3'), assembly, 'counted', 1, []).lots.W3?.stage.kind).toBe('working');
  });
});

describe('工程の設定 2.2: 次工程の場所の指定・付け替え・解除（3.1・3.3・3.4・3.6）', () => {
  test('付け替えは外す場所と付ける場所を一つの変更に残し、渡した物の所在は変えない', () => {
    let l = register(practiceLedger, meta('done', 7), product('handed', 'N'), 'counted', 1);
    l = changed(l, 'nx', { action: 'nextProcess', id: 'S2', reason: '次工程の棚を変える' });
    expect(nextProcessOf(l.masters)?.id).toBe('S2');
    expect(l.history.at(-1)).toMatchObject({ action: 'nextProcess', masters: [{ before: { id: 'N', nextProcess: true }, after: { id: 'N', nextProcess: false } }, { before: { id: 'S2', nextProcess: false }, after: { id: 'S2', nextProcess: true } }] });
    expect(l.lots.handed?.location).toBe('N');
    expect(Object.values(l.masters.locations).filter(x => x.nextProcess)).toHaveLength(1);
    l = changed(l, 'clear', { action: 'nextProcess', id: null, reason: '次工程を使わない' }, 9);
    expect(nextProcessOf(l.masters)).toBeNull();
    expect(() => changed(l, 'clear2', { action: 'nextProcess', id: null, reason: '再度' }, 10)).toThrow('指定していない');
  });

  test('全数を渡して数えた0だけが残る場所は次工程に指定でき、数が不明の記録が残る場所は拒否する', () => {
    let l = start(practiceLedger, meta('s', 7), product('W', 'S2'), assembly, 'counted', 2, []);
    l = changeStage(l, meta('end', 8), 'W', 'W-i', 'counted', 2, nextStage(l.lots.W!.stage)!);
    l = changeStage(l, meta('ok', 9), 'W-i', 'W-h', 'counted', 2, nextStage(l.lots['W-i']!.stage)!);
    l = handOver(l, meta('out', 10), 'W-h', 'counted', 2, '外');
    expect(Object.values(l.lots).filter(x => x.location === 'S2' && x.stage.kind !== 'none').length).toBeGreaterThan(0);
    expect(nextProcessOf(changed(l, 'nx', { action: 'nextProcess', id: 'S2', reason: '空いた棚' }, 11).masters)?.id).toBe('S2');
    const unknown = register(practiceLedger, meta('u', 7), { ...product('U', 'S2'), stage: { kind: 'working', process: assembly } }, 'unknown', null);
    expect(() => changed(unknown, 'nx', { action: 'nextProcess', id: 'S2', reason: '指定' })).toThrow('製造中・完成（渡す前）の物がある（U）');
  });

  test('製造中の物がある場所・利用停止中の場所への指定と、指定中の場所の利用停止を拒否する', () => {
    const staged = start(practiceLedger, meta('s', 7), product('W', 'S2'), assembly, 'counted', 1, []);
    expect(() => changed(staged, 'nx', { action: 'nextProcess', id: 'S2', reason: '指定' })).toThrow('製造中・完成（渡す前）の物がある（W）');
    const off = changed(practiceLedger, 'off', { action: 'deactivate', type: 'location', id: 'S2', reason: '使わない' }, 7);
    expect(() => changed(off, 'nx', { action: 'nextProcess', id: 'S2', reason: '指定' })).toThrow('利用停止中');
    expect(() => changed(practiceLedger, 'offN', { action: 'deactivate', type: 'location', id: 'N', reason: '使わない' })).toThrow('先に次工程の指定を解除する');
    expect(() => changed(practiceLedger, 'same', { action: 'nextProcess', id: 'N', reason: '同じ' })).toThrow('今と同じ次工程の場所');
  });
});
