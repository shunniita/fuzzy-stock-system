import { describe, expect, test } from 'vitest';
import {
  changeStage,
  correctOccurredAt,
  declareDiscrepancy,
  practiceLedger as practiceBase,
  handOver,
  hold,
  isUsable,
  merge,
  move,
  noStage,
  openIssues,
  openIssuesOf,
  productionOf,
  recordStop,
  recount,
  register,
  resolveIssue,
  resumeWork,
  split,
  start,
  stopExcessOf,
  totalOf,
  updateStop,
  use,
  voidRecord,
  type Ledger,
  type Meta,
  type Process,
  type Project,
  type Stage,
} from '../../src/domain/ledger.ts';
import { withProcesses } from './process-fixture.ts';
const practiceLedger = withProcesses(practiceBase, { id: 'R仮組', criterion: 'workEnd' });
import type { Quantity } from '../../src/domain/quantity.ts';

const a001: Project = { kind: 'case', id: 'A-001' };
const a002: Project = { kind: 'case', id: 'A-002' };
const assembly: Process = { id: 'R組立', criterion: 'inspection' };
const workEndOnly: Process = { id: 'R仮組', criterion: 'workEnd' };
const inspecting: Stage = { kind: 'inspecting', process: assembly };
const awaiting: Stage = { kind: 'awaitingHandover', process: assembly };

function meta(eventId: string, time: string): Meta {
  const at = `2026-09-29T${time}:00+09:00`;
  return { eventId, occurredAt: at, recordedAt: at, actor: '架空担当A' };
}

const part = (id: string, item: string, location: string, project: Project = a001) => ({ id, item, unit: '個', project, location });
const product = (id: string, location = 'T', project: Project = a001) => ({ id, item: 'R', unit: '台', project, location });

function valueOf(q: Quantity | undefined): number | null {
  return q?.kind === 'known' ? q.numeric.value : null;
}

function counts(l: Ledger, process = assembly.id, project: Project = a001, item = 'R', unit = '台') {
  const p = productionOf(l, process, item, unit, project);
  return {
    working: valueOf(p.working),
    inspecting: valueOf(p.inspecting),
    awaitingHandover: valueOf(p.awaitingHandover),
    completed: valueOf(p.completed),
    returned: valueOf(p.returned),
    handedOver: valueOf(p.handedOver),
  };
}

// 材料P・Qを30ずつ使用してから、R30台に作業を開始する（材料使用は登録済み）。
function started(process: Process = assembly): Ledger {
  let l = register(practiceLedger, meta('rp', '08:00'), part('P1', 'P', 'T'), 'counted', 100);
  l = register(l, meta('rq', '08:00'), part('Q1', 'Q', 'T'), 'counted', 100);
  l = use(l, meta('up', '09:15'), 'P1', 'counted', 30, 'R作業の開始');
  l = use(l, meta('uq', '09:15'), 'Q1', 'counted', 30, 'R作業の開始');
  return start(l, meta('st', '09:20'), product('R1'), process, 'counted', 30, ['up', 'uq']);
}

describe('AT-14 100台案件・用途の30台に作業の開始し、10台完了、5台引渡し', () => {
  function completed10(): Ledger {
    let l = changeStage(started(), meta('f1', '10:00'), 'R1', 'R2', 'counted', 10, inspecting);
    l = changeStage(l, meta('i1', '10:30'), 'R2', 'R3', 'counted', 10, awaiting);
    return l;
  }

  test('手元の次工程へ5台渡すと、工程内20・完成（渡す前）5・引渡済み5で、完了時に材料を再消費しない', () => {
    let l = completed10();
    l = changeStage(l, meta('h1', '11:00'), 'R3', 'R4', 'counted', 5, noStage);
    l = move(l, meta('m1', '11:00'), 'R4', 'N');
    expect(counts(l)).toEqual({ working: 20, inspecting: 0, awaitingHandover: 5, completed: 10, returned: 0, handedOver: 5 });
    expect([valueOf(l.lots.P1?.quantity), valueOf(l.lots.Q1?.quantity)]).toEqual([70, 70]);
    expect(l.history.filter((e) => e.kind === 'use').map((e) => e.eventId)).toEqual(['up', 'uq']);
    expect(l.history.find((e) => e.eventId === 'st')).toMatchObject({ kind: 'start', lotId: 'R1', materials: ['up', 'uq'] });
  });

  test('工程内の仕掛品は、移動で次工程Nへ直接移せない。次工程への引渡しで記録する。作業をしていない物は移せる', () => {
    let l = changeStage(started(), meta('f1', '10:00'), 'R1', 'R2', 'counted', 5, inspecting);
    expect(() => move(l, meta('m1', '10:10'), 'R1', 'N')).toThrow('次工程への引渡し');
    expect(() => move(l, meta('m2', '10:10'), 'R2', 'N')).toThrow('次工程への引渡し');
    expect(() => split(l, meta('s1', '10:10'), 'R1', 'R9', 'counted', 3)).not.toThrow();
    expect(move(l, meta('m3', '10:10'), 'R1', 'S1').lots.R1?.location).toBe('S1');
    l = changeStage(changeStage(l, meta('i1', '10:20'), 'R2', 'R3', 'counted', 5, awaiting), meta('h1', '10:30'), 'R3', 'R4', 'counted', 5, noStage);
    expect(move(l, meta('m4', '10:40'), 'R4', 'N').lots.R4?.location).toBe('N');
  });

  test('工程に載る保管単位は、次工程Nに置いて登録・作業の開始・位置の変更をできない', () => {
    expect(() => start(practiceLedger, meta('s1', '09:00'), product('R1', 'N'), assembly, 'counted', 5, [])).toThrow('次工程への引渡し');
    expect(() => register(practiceLedger, meta('r1', '09:00'), { ...product('R2', 'N'), stage: awaiting }, 'counted', 5)).toThrow('次工程への引渡し');
    const l = register(practiceLedger, meta('r2', '09:00'), product('R3', 'N'), 'counted', 5);
    expect(() => changeStage(l, meta('f1', '10:00'), 'R3', 'R4', 'counted', 2, { kind: 'working', process: assembly }, undefined, true)).toThrow('次工程への引渡し');
  });

  test('作業中・検査待ちの保管単位は外へ直接引き渡せず、完成（渡す前）にしてから渡す', () => {
    const l = started();
    expect(() => handOver(l, meta('x1', '10:00'), 'R1', 'counted', 5, '架空の後工程OUT')).toThrow('先に完成（渡す前）にする');
    const waiting = changeStage(changeStage(l, meta('f1', '10:00'), 'R1', 'R2', 'counted', 5, inspecting), meta('i1', '10:10'), 'R2', 'R3', 'counted', 5, awaiting);
    expect(counts(handOver(waiting, meta('x3', '10:20'), 'R3', 'counted', 5, '架空の後工程OUT'))).toMatchObject({ handedOver: 5 });
  });

  test('外へ5台渡しても引渡済み5に数え、在庫からは5台減る', () => {
    const l = handOver(completed10(), meta('h1', '11:00'), 'R3', 'counted', 5, '架空の後工程OUT');
    expect(counts(l)).toEqual({ working: 20, inspecting: 0, awaitingHandover: 5, completed: 10, returned: 0, handedOver: 5 });
    expect(valueOf(totalOf(l, 'R'))).toBe(25);
  });

  test('作業終了を完了基準にする工程では、作業終了で直接完成（渡す前）になり、検査待ちを持たない', () => {
    let l = changeStage(started(workEndOnly), meta('f1', '10:00'), 'R1', 'R2', 'counted', 10, { kind: 'awaitingHandover', process: workEndOnly });
    expect(counts(l, workEndOnly.id)).toMatchObject({ working: 20, awaitingHandover: 10, completed: 10 });
    expect(() => changeStage(l, meta('x', '10:10'), 'R1', 'R9', 'counted', 1, { kind: 'inspecting', process: workEndOnly })).toThrow('検査を完了基準にしていない');
  });

  test('工程完了累計は、完成（渡す前）を分けてもまとめても、次工程へ渡しても変わらない', () => {
    let l = split(completed10(), meta('s1', '10:40'), 'R3', 'R3b', 'counted', 4);
    expect(counts(l)).toMatchObject({ awaitingHandover: 10, completed: 10 });
    l = merge(l, meta('g1', '10:50'), 'R3b', 'R3');
    expect(counts(l)).toMatchObject({ awaitingHandover: 10, completed: 10 });
    l = changeStage(l, meta('h1', '11:00'), 'R3', 'R4', 'counted', 10, noStage);
    expect(counts(l)).toMatchObject({ awaitingHandover: 0, completed: 10, handedOver: 10 });
  });

  // 戻した分をどの完了と対にするかは個体を追わないと決まらないので、完了累計から引かず別に数える。
  test('完成（渡す前）を工程内へ戻す訂正は、完了累計を変えず、工程内へ戻した数として別に数える', () => {
    const l = changeStage(completed10(), meta('b1', '11:00'), 'R3', 'R5', 'counted', 3, { kind: 'working', process: assembly });
    expect(counts(l)).toMatchObject({ working: 23, awaitingHandover: 7, completed: 10, returned: 3 });
  });

  test('作業の状態の訂正は、完了基準どおりの次の位置への変更でも、完了累計・引渡済み累計に数えない', () => {
    let l = changeStage(started(), meta('f1', '10:00'), 'R1', 'R2', 'counted', 6, awaiting, undefined, true);
    expect(counts(l)).toMatchObject({ working: 24, awaitingHandover: 6, completed: 0, handedOver: 0 });
    l = changeStage(l, meta('h1', '10:30'), 'R2', 'R3', 'counted', 4, noStage, undefined, true);
    expect(counts(l)).toMatchObject({ awaitingHandover: 2, handedOver: 0 });
    expect(l.history.at(-1)).toMatchObject({ kind: 'stage', correction: true });
  });

  test('完了の記録がない完成（渡す前）を工程内へ戻しても、完了累計は負数にならない', () => {
    let l = register(practiceLedger, meta('r1', '09:00'), { ...product('D'), stage: awaiting }, 'counted', 10);
    l = changeStage(l, meta('b1', '10:00'), 'D', 'D2', 'counted', 3, { kind: 'working', process: assembly });
    expect(counts(l)).toMatchObject({ working: 3, awaitingHandover: 7, completed: 0, returned: 3 });
  });

  test('QTY-07: 同じ品目・工程でも単位ごとに数え、別の単位の数を足さない', () => {
    let l = start(practiceLedger, meta('s1', '09:00'), { ...product('Sh'), item: 'S', unit: '本' }, assembly, 'counted', 10, []);
    l = start(l, meta('s2', '09:30'), { ...product('Sb'), item: 'S', unit: '箱' }, assembly, 'counted', 2, []);
    l = changeStage(l, meta('f1', '10:00'), 'Sb', 'Sb2', 'counted', 1, inspecting);
    l = changeStage(l, meta('i1', '10:30'), 'Sb2', 'Sb3', 'counted', 1, awaiting);
    expect(counts(l, assembly.id, a001, 'S', '本')).toEqual({ working: 10, inspecting: 0, awaitingHandover: 0, completed: 0, returned: 0, handedOver: 0 });
    expect(counts(l, assembly.id, a001, 'S', '箱')).toEqual({ working: 1, inspecting: 0, awaitingHandover: 1, completed: 1, returned: 0, handedOver: 0 });
    const stop = { process: assembly.id, item: 'S', unit: '箱', project: a001, reason: '部品不足', shortage: null, affected: 1 };
    expect(recordStop(l, meta('x1', '11:00'), stop).stops.x1?.affected).toBe(1);
    expect(() => recordStop(l, meta('x2', '11:00'), { ...stop, affected: 2 })).toThrow('工程内数1の内数');
  });

  test('MFG-03c: 工程に載った物は使用可能な未使用数に入らず、使用として減らせない', () => {
    const l = completed10();
    expect(isUsable(l.lots.R1!)).toBe(false);
    expect(valueOf(totalOf(l, 'R', isUsable))).toBe(0);
    expect(valueOf(totalOf(l, 'R'))).toBe(30);
    expect(() => use(l, meta('x', '11:00'), 'R3', 'counted', 1, '誤り')).toThrow('製造中・完成（渡す前）');
  });

  test('MFG-03a・03b: 材料の使用記録がない、別の作業の開始に対応付け済み、重複した材料では作業の開始を記録しない', () => {
    const l = started();
    expect(() => start(l, meta('x1', '09:30'), product('R8'), assembly, 'counted', 1, ['nope'])).toThrow('材料の使用記録 nope がない');
    expect(() => start(l, meta('x2', '09:30'), product('R8'), assembly, 'counted', 1, ['up'])).toThrow('別の作業の開始に対応付け済み');
    const extra = use(l, meta('u3', '09:30'), 'P1', 'counted', 1, 'R作業の開始');
    expect(() => start(extra, meta('x3', '09:31'), product('R8'), assembly, 'counted', 1, ['u3', 'u3'])).toThrow('重ねて');
    expect(start(extra, meta('x4', '09:31'), product('R8'), assembly, 'counted', 1, ['u3']).lots.R8?.stage).toEqual({ kind: 'working', process: assembly });
  });

  // 負数の材料の使用は保留して確認が必要に残す（REC-05・AT-29）。作業の開始の事実は記録を止めず、材料の対応付けと確認が必要を残す。
  test('材料の使用が負数で保留されても作業の開始は記録し、他の材料の使用は適用する。保留した使用は確認が必要に残る', () => {
    let l = register(practiceLedger, meta('rp', '08:00'), part('P1', 'P', 'T'), 'counted', 100);
    l = register(l, meta('rq', '08:00'), part('Q1', 'Q', 'T'), 'counted', 20);
    l = use(l, meta('up', '09:15'), 'P1', 'counted', 30, 'R作業の開始');
    l = use(l, meta('uq', '09:15'), 'Q1', 'counted', 30, 'R作業の開始');
    l = start(l, meta('st', '09:20'), product('R1'), assembly, 'counted', 30, ['up', 'uq']);
    expect(l.history.find((e) => e.eventId === 'st')).toMatchObject({ kind: 'start', materials: ['up', 'uq'] });
    expect([valueOf(l.lots.P1?.quantity), valueOf(l.lots.Q1?.quantity)]).toEqual([70, 20]);
    expect(openIssuesOf(l, 'Q1').map((i) => [i.id, i.reason])).toEqual([['uq', 'negative']]);
  });

  test('位置が同じ・別の工程へ直接の変更と、位置の違う統合は拒否する', () => {
    const l = changeStage(started(), meta('f1', '10:00'), 'R1', 'R2', 'counted', 10, inspecting);
    expect(() => changeStage(l, meta('x1', '10:10'), 'R2', 'R9', 'counted', 1, inspecting)).toThrow('同じ');
    expect(() => changeStage(l, meta('x2', '10:10'), 'R2', 'R9', 'counted', 1, { kind: 'working', process: workEndOnly })).toThrow('先に作業なしにする');
    expect(() => merge(l, meta('x3', '10:10'), 'R2', 'R1')).toThrow('作業の状態が違う');
  });

  test('RUN-02: 過去の作業の開始を作らず、仕掛品・工程完了品をその位置で登録できる', () => {
    let l = register(practiceLedger, meta('r1', '09:00'), { ...product('W'), stage: { kind: 'working', process: assembly } }, 'approximate', 12);
    l = register(l, meta('r2', '09:00'), { ...product('D'), stage: awaiting }, 'unknown', null);
    expect(l.history.map((e) => e.kind)).toEqual(['register', 'register']);
    const p = productionOf(l, assembly.id, 'R', '台', a001);
    expect(p.working).toMatchObject({ kind: 'known', numeric: { value: 12, approximate: true } });
    expect(p.awaitingHandover.kind).toBe('unknown');
    expect(valueOf(p.completed)).toBe(0);
  });
});

describe('AT-15 配膳だけの品目10個を手元の次工程へ渡す', () => {
  test('同じ品目の移動として記録し、品目と部署数量は変わらず、製造・消費を作らない', () => {
    let l = register(practiceLedger, meta('r1', '09:00'), part('K', 'P', 'T'), 'counted', 10);
    l = register(l, meta('r2', '09:00'), part('K2', 'P', 'S1'), 'counted', 5);
    const before = valueOf(totalOf(l, 'P'));
    l = move(l, meta('m1', '10:00'), 'K', 'N');
    expect(valueOf(totalOf(l, 'P'))).toBe(before);
    expect(l.lots.K).toMatchObject({ item: 'P', location: 'N', stage: noStage });
    expect(valueOf(l.lots.K?.quantity)).toBe(10);
    expect(l.history.map((e) => e.kind)).toEqual(['register', 'register', 'move']);
  });
});

describe('AT-40 確認の完了を基準にする工程の内訳と中断した数', () => {
  function inspected(): Ledger {
    let l = changeStage(started(), meta('f1', '11:00'), 'R1', 'R2', 'counted', 20, inspecting);
    return changeStage(l, meta('i1', '11:05'), 'R2', 'R3', 'counted', 18, awaiting);
  }
  const stopOf = (affected: number | null) => ({
    process: assembly.id,
    item: 'R',
    unit: '台',
    project: a001,
    reason: '部品不足',
    shortage: { item: 'P', unit: '個', value: 3 },
    affected,
  });

  test('工程内30から作業終了20・確認の完了18で、工程内12（うち検査待ち2）、完成（渡す前）18', () => {
    expect(counts(inspected())).toEqual({ working: 10, inspecting: 2, awaitingHandover: 18, completed: 18, returned: 0, handedOver: 0 });
  });

  test('中断した数を不明で登録すると、不足部品数から推定せず不明のまま。対象の5台と確かめて更新すると前の値が履歴に残る', () => {
    let l = recordStop(inspected(), meta('stop1', '11:10'), stopOf(null));
    expect(l.stops.stop1).toMatchObject({ affected: null, shortage: { item: 'P', unit: '個', value: 3 }, resumedBy: null });
    l = updateStop(l, meta('su1', '11:30'), 'stop1', 5);
    expect(l.stops.stop1?.affected).toBe(5);
    expect(l.history.at(-1)).toMatchObject({ kind: 'stopUpdate', stopId: 'stop1', previous: null, affected: 5 });
    expect(counts(l)).toMatchObject({ working: 10, inspecting: 2 });
  });

  test('MFG-08a: 不足数は不足品目の単位を持ち、単位の違う品目でも取り違えない。単位がなければ記録しない', () => {
    const l = inspected();
    const shortage = { item: 'S', unit: '箱', value: 2 };
    expect(recordStop(l, meta('x1', '11:10'), { ...stopOf(null), shortage }).stops.x1?.shortage).toEqual(shortage);
    expect(() => recordStop(l, meta('x2', '11:10'), { ...stopOf(null), shortage: { ...shortage, unit: ' ' } })).toThrow('不足数の単位');
  });

  test('MFG-08b: 後の位置の変更で工程内数が減ったあとに入力した、それより前の日時の中断は、その時点の工程内数で見て受け付ける', () => {
    const l = changeStage(started(), meta('f1', '11:00'), 'R1', 'R2', 'counted', 28, awaiting);
    expect(counts(l)).toMatchObject({ working: 2 });
    expect(recordStop(l, meta('stop1', '10:30'), { ...stopOf(5), affected: 5 }).stops.stop1?.affected).toBe(5);
    expect(() => recordStop(l, meta('stop2', '12:00'), stopOf(5))).toThrow('内数');
    expect(() => recordStop(l, { ...meta('stop3', '12:00'), occurredAt: null }, stopOf(5))).toThrow('内数');
  });

  test('MFG-08b: 中断より後の操作が場所を変えるだけなら、工程内数は変わらないので、前の日時の中断も今の数で検査する', () => {
    const l = move(started(), meta('m1', '11:00'), 'R1', 'S1');
    expect(() => recordStop(l, meta('stop1', '10:00'), stopOf(31))).toThrow('内数');
    expect(recordStop(l, meta('stop2', '10:00'), stopOf(30)).stops.stop2?.affected).toBe(30);
  });

  test('MFG-08b: 中断より後の操作が工程内での分割・統合だけなら、合計は変わらないので、今の数で検査する', () => {
    let l = split(started(), meta('s1', '11:00'), 'R1', 'R9', 'counted', 10);
    expect(() => recordStop(l, meta('stop1', '10:00'), stopOf(31))).toThrow('内数');
    l = merge(l, meta('g1', '11:30'), 'R9', 'R1');
    expect(() => recordStop(l, meta('stop2', '10:00'), stopOf(31))).toThrow('内数');
    expect(recordStop(l, meta('stop3', '10:00'), stopOf(30)).stops.stop3?.affected).toBe(30);
  });

  test('MFG-08b: 作業の開始より前の日時の中断は、その時点の工程内数が0なので台数を入れられない', () => {
    const l = start(practiceLedger, meta('st', '11:00'), product('R1'), assembly, 'counted', 10, []);
    expect(() => recordStop(l, meta('stop1', '10:00'), stopOf(5))).toThrow('工程内数0の内数');
    expect(recordStop(l, meta('stop2', '10:00'), stopOf(0)).stops.stop2?.affected).toBe(0);
    expect(recordStop(l, meta('stop3', '10:00'), stopOf(null)).stops.stop3?.affected).toBeNull();
  });

  test('MFG-08b: 中断の時点の工程内数は、後の操作の増減を戻して求める', () => {
    let l = changeStage(started(), meta('f1', '11:00'), 'R1', 'R2', 'counted', 28, awaiting);
    expect(() => recordStop(l, meta('stop1', '10:30'), stopOf(31))).toThrow('工程内数30の内数');
    l = start(l, meta('st2', '12:00'), product('R5'), assembly, 'counted', 4, []);
    expect(() => recordStop(l, meta('stop2', '11:30'), stopOf(3))).toThrow('工程内数2の内数');
    expect(recordStop(l, meta('stop3', '12:30'), stopOf(6)).stops.stop3?.affected).toBe(6);
  });

  test('MFG-08b: 保留を「適用」で解消した位置の変更は、解消した日時ではなく元の操作の日時の工程内数の変化として戻す', () => {
    let l = start(practiceLedger, meta('st', '08:00'), product('R1'), assembly, 'counted', 10, []);
    l = recount(l, meta('c1', '10:00'), 'R1', 10, { kind: 'unknown' });
    // 数え直しより前の日時の位置の変更を後入力し、包含が不明なので親は減らさず保留する。
    l = changeStage(l, meta('f1', '09:00'), 'R1', 'R2', 'counted', 5, awaiting, 'unknown');
    expect(counts(l)).toMatchObject({ working: 10 });
    l = resolveIssue(l, meta('r1', '12:00'), 'f1', 'apply', 'notIncluded');
    expect(counts(l)).toMatchObject({ working: 5 });
    // 9時30分の工程内は、作業の開始の10台から9時の位置の変更の5台を引いた5台。解消の12時の変化として戻すと10台に見えて通ってしまう。
    expect(() => recordStop(l, meta('stop1', '09:30'), stopOf(8))).toThrow('工程内数5の内数');
    expect(recordStop(l, meta('stop2', '09:30'), stopOf(5)).stops.stop2?.affected).toBe(5);
    expect(recordStop(l, meta('stop3', '08:30'), stopOf(10)).stops.stop3?.affected).toBe(10);
  });

  test('MFG-08b: 日時の訂正で、中断や台数の更新が工程内数を超える時点に移る訂正は受け付けない', () => {
    const at = (time: string) => `2026-09-29T${time}:00+09:00`;
    let l = start(practiceLedger, meta('st', '10:00'), product('R1'), assembly, 'counted', 10, []);
    l = recordStop(l, meta('stop1', '11:00'), stopOf(5));
    expect(() => correctOccurredAt(l, meta('t1', '12:00'), 'stop1', at('09:00'))).toThrow('工程内数0の内数');
    expect(() => correctOccurredAt(l, meta('t2', '12:00'), 'st', at('11:30'))).toThrow('工程内数0の内数');
    expect(correctOccurredAt(l, meta('t3', '12:00'), 'stop1', at('10:30')).history.at(-1)).toMatchObject({ kind: 'correctTime' });
  });

  test('MFG-08b 回帰: 作業の開始と同時刻の中断は作業の開始後の工程内数で比べる', () => {
    const l = start(practiceLedger, meta('st', '09:00'), product('R1'), assembly, 'counted', 10, []);
    expect(recordStop(l, meta('stop1', '09:00'), stopOf(10)).stops.stop1?.affected).toBe(10);
    expect(() => recordStop(l, meta('stop2', '09:00'), stopOf(11))).toThrow('工程内数10の内数');
  });

  test('MFG-08b 回帰: 時刻帯表記が違っても同じ瞬間の位置変更は中断より前として数える', () => {
    const l = changeStage(started(), meta('f1', '11:00'), 'R1', 'R2', 'counted', 28, awaiting);
    const at = { ...meta('stop1', '11:00'), occurredAt: '2026-09-29T02:00:00Z' };
    expect(recordStop(l, at, stopOf(2)).stops.stop1?.affected).toBe(2);
    expect(() => recordStop(l, { ...at, eventId: 'stop2' }, stopOf(3))).toThrow('工程内数2の内数');
  });

  test('MFG-08b 回帰: 後の数え直しによる減少を戻して中断時点の内数を検査する', () => {
    const l = recount(started(), meta('c1', '11:00'), 'R1', 2, { kind: 'unknown' });
    expect(recordStop(l, meta('stop1', '10:00'), stopOf(30)).stops.stop1?.affected).toBe(30);
    expect(() => recordStop(l, meta('stop2', '10:00'), stopOf(31))).toThrow('工程内数30の内数');
  });

  test('MFG-08b 回帰: 台数更新も更新時点の工程内数で比べ、後の減少は警告に残す', () => {
    let l = recordStop(started(), meta('stop1', '09:30'), stopOf(null));
    l = changeStage(l, meta('f1', '11:00'), 'R1', 'R2', 'counted', 28, awaiting);
    const updated = updateStop(l, meta('u1', '10:00'), 'stop1', 30);
    expect(updated.history.at(-1)).toMatchObject({ kind: 'stopUpdate', previous: null, affected: 30 });
    expect(stopExcessOf(updated, updated.stops.stop1!)).toEqual({ affected: 30, total: 2 });
    expect(() => updateStop(l, meta('u2', '10:00'), 'stop1', 31)).toThrow('工程内数30の内数');
  });

  test('MFG-08b 回帰: 数が不明の工程内数を0として中断した数を拒否しない', () => {
    const l = start(practiceLedger, meta('st', '09:00'), product('R1'), assembly, 'unknown', null, []);
    const stopped = recordStop(l, meta('stop1', '10:00'), stopOf(10));
    expect(stopped.stops.stop1?.affected).toBe(10);
    expect(stopExcessOf(stopped, stopped.stops.stop1!)).toBeNull();
    expect(productionOf(stopped, assembly.id, 'R', '台', a001).working.kind).toBe('unknown');
  });

  test('MFG-08b 回帰: 増減の日時が不明なら過去の内数は断定せず現在の超過を警告する', () => {
    const l = start(practiceLedger, { ...meta('st', '09:00'), occurredAt: null }, product('R1'), assembly, 'counted', 10, []);
    const stopped = recordStop(l, meta('stop1', '08:00'), stopOf(11));
    expect(stopped.stops.stop1?.affected).toBe(11);
    expect(stopExcessOf(stopped, stopped.stops.stop1!)).toEqual({ affected: 11, total: 10 });
    expect(openIssues(stopped)).toEqual([]);
  });

  test('MFG-08b 回帰: 位置変更の訂正後の実際の日時で中断時点の内数を求める', () => {
    let l = changeStage(started(), meta('f1', '11:00'), 'R1', 'R2', 'counted', 28, awaiting);
    l = correctOccurredAt(l, meta('t1', '12:00'), 'f1', '2026-09-29T10:00:00+09:00');
    expect(recordStop(l, meta('stop1', '09:30'), stopOf(30)).stops.stop1?.affected).toBe(30);
    expect(() => recordStop(l, meta('stop2', '10:30'), stopOf(3))).toThrow('工程内数2の内数');
  });

  test('MFG-08b: 中断した数は工程内数の内数で、工程内12を超える台数は記録しない', () => {
    const l = inspected();
    expect(() => recordStop(l, meta('x1', '11:10'), stopOf(13))).toThrow('内数');
    expect(recordStop(l, meta('x2', '11:10'), stopOf(12)).stops.x2?.affected).toBe(12);
    const unknownDone = recordStop(l, meta('x3', '11:10'), stopOf(null));
    expect(() => updateStop(unknownDone, meta('x4', '11:20'), 'x3', 13)).toThrow('内数');
  });

  test('MFG-08c: 作業の再開は中断とは別の記録で、再開後は台数を更新しない', () => {
    let l = recordStop(inspected(), meta('stop1', '11:10'), stopOf(5));
    l = resumeWork(l, meta('re1', '13:00'), 'stop1');
    expect(l.stops.stop1?.resumedBy).toBe('re1');
    expect(() => updateStop(l, meta('x', '13:10'), 'stop1', 4)).toThrow('再開済み');
    expect(() => resumeWork(l, meta('x2', '13:10'), 'stop1')).toThrow('再開済み');
  });
});

describe('MFG-08b 工程内数が中断した数を下回ったら警告する', () => {
  // R10台に作業の開始し、影響5台の中断を記録する。
  function stopped(): Ledger {
    const l = start(practiceLedger, meta('st', '09:00'), product('R1'), assembly, 'counted', 10, []);
    return recordStop(l, meta('stop1', '09:30'), { process: assembly.id, item: 'R', unit: '台', project: a001, reason: '部品不足', shortage: null, affected: 5 });
  }

  test('位置の変更で工程内2台になっても変更は記録し、確認事項は作らず、中断した数が工程内数を超えていると示す。自動で再開しない', () => {
    const l = changeStage(stopped(), meta('c1', '10:00'), 'R1', 'R2', 'counted', 8, awaiting);
    expect(counts(l)).toMatchObject({ working: 2, awaitingHandover: 8 });
    expect(openIssues(l)).toEqual([]);
    expect(stopExcessOf(l, l.stops.stop1!)).toEqual({ affected: 5, total: 2 });
    expect(l.stops.stop1).toMatchObject({ affected: 5, resumedBy: null });
  });

  test('数え直しで工程内数が減っても同じく示す', () => {
    const l = recount(stopped(), meta('c1', '10:00'), 'R1', 3, { kind: 'unknown' });
    expect(stopExcessOf(l, l.stops.stop1!)).toEqual({ affected: 5, total: 3 });
  });

  test('台数を工程内数以下か不明へ更新するか、作業の再開を記録すると、超えていない', () => {
    const exceeded = changeStage(stopped(), meta('c1', '10:00'), 'R1', 'R2', 'counted', 8, awaiting);
    const updated = updateStop(exceeded, meta('u1', '10:20'), 'stop1', 2);
    expect(stopExcessOf(updated, updated.stops.stop1!)).toBeNull();
    const unknown = updateStop(exceeded, meta('u2', '10:20'), 'stop1', null);
    expect(stopExcessOf(unknown, unknown.stops.stop1!)).toBeNull();
    const resumed = resumeWork(exceeded, meta('re', '10:20'), 'stop1');
    expect(stopExcessOf(resumed, resumed.stops.stop1!)).toBeNull();
  });
});

describe('分割・位置の変更・作業の開始でできた保管単位への後の操作', () => {
  test('作業終了20と同じ時刻の確認の完了18は、作業終了で数えた20に含まれていたかを聞かず、工程内と完成（渡す前）を重ねない', () => {
    let l = changeStage(started(), meta('f1', '11:00'), 'R1', 'R2', 'counted', 20, inspecting);
    l = changeStage(l, meta('i1', '11:00'), 'R2', 'R3', 'counted', 18, awaiting);
    expect(counts(l)).toMatchObject({ working: 10, inspecting: 2, awaitingHandover: 18 });
    expect(valueOf(totalOf(l, 'R'))).toBe(30);
    expect(l.history.at(-1)).toMatchObject({ kind: 'stage', applied: true, inclusion: null });
  });

  test('作業の開始と同じ時刻・日時不明の位置の変更も聞かずに適用する', () => {
    let l = changeStage(started(), meta('f1', '09:20'), 'R1', 'R2', 'counted', 5, inspecting);
    l = changeStage(l, { ...meta('f2', '09:30'), occurredAt: null }, 'R1', 'R3', 'counted', 5, inspecting);
    expect(counts(l)).toMatchObject({ working: 20, inspecting: 10 });
  });

  test('保管単位ができる前の日時の操作は、この保管単位には記録しない', () => {
    const l = split(register(practiceLedger, meta('r1', '08:00'), part('X', 'P', 'S1'), 'counted', 100), meta('s1', '10:00'), 'X', 'Y', 'counted', 30);
    expect(() => use(l, meta('u1', '09:50'), 'Y', 'counted', 5, '作業')).toThrow('保管単位 Y ができる前の操作');
  });

  test('表示の数（ラベル・パッケージ）でできた保管単位（数えたなし）でも、できる前の日時の操作は記録しない', () => {
    const l = start(practiceLedger, meta('s1', '10:00'), product('R1'), assembly, 'label', 10, []);
    expect(() => changeStage(l, meta('f1', '09:00'), 'R1', 'R2', 'counted', 5, inspecting)).toThrow('保管単位 R1 ができる前の操作');
  });

  test('できる前の日時の移動・取り分けた理由・統合・数え直し・差異申告も、この保管単位には記録しない', () => {
    let l = split(register(practiceLedger, meta('r1', '08:00'), part('X', 'P', 'S1'), 'counted', 100), meta('s1', '10:00'), 'X', 'Y', 'label', 30);
    l = register(l, meta('r2', '08:10'), part('Z', 'P', 'S1'), 'counted', 20);
    const before = (id: string) => meta(id, '09:00');
    expect(() => move(l, before('m1'), 'Y', 'T')).toThrow('保管単位 Y ができる前の操作');
    expect(() => hold(l, before('h1'), 'Y', 'defective')).toThrow('保管単位 Y ができる前の操作');
    expect(() => merge(l, before('g1'), 'Y', 'Z')).toThrow('保管単位 Y ができる前の操作');
    expect(() => recount(l, before('c1'), 'Y', 30, { kind: 'unknown' })).toThrow('保管単位 Y ができる前の操作');
    expect(() => declareDiscrepancy(l, before('d1'), 'Y', '差がある')).toThrow('保管単位 Y ができる前の操作');
    expect(move(l, meta('m2', '10:00'), 'Y', 'T').lots.Y?.location).toBe('T');
  });

  test('日時の訂正で、できる前の操作になる場合は受け付けない。できたあとの日時への訂正は受け付ける', () => {
    let l = start(practiceLedger, meta('s1', '10:00'), product('R1'), assembly, 'counted', 10, []);
    l = move(l, meta('m1', '11:00'), 'R1', 'S1');
    const at = (time: string) => `2026-09-29T${time}:00+09:00`;
    expect(() => correctOccurredAt(l, meta('t1', '12:00'), 'm1', at('09:00'))).toThrow('のできる前の操作になる');
    expect(() => correctOccurredAt(l, meta('t2', '12:00'), 's1', at('12:00'))).toThrow('のできる前の操作になる');
    expect(correctOccurredAt(l, meta('t3', '12:00'), 'm1', at('10:30')).history.at(-1)).toMatchObject({ kind: 'correctTime', corrected: at('10:30') });
  });

  test('できたあとに数え直した保管単位でも、できる前の日時の操作は、回答を求める前に拒否する', () => {
    let l = split(register(practiceLedger, meta('r1', '08:00'), part('X', 'P', 'S1'), 'counted', 100), meta('s1', '10:00'), 'X', 'Y', 'counted', 30);
    l = recount(l, meta('c1', '11:00'), 'Y', 30, { kind: 'unknown' });
    expect(() => use(l, meta('u1', '09:00'), 'Y', 'counted', 5, '作業', 'notIncluded')).toThrow('保管単位 Y ができる前の操作');
  });

  test('工程内の数を超える位置の変更を保留したあと、数え直さずに閉じると、工程内と変更先が重なるので閉じさせない', () => {
    let l = changeStage(started(), meta('f1', '10:00'), 'R1', 'R2', 'counted', 40, inspecting);
    expect(l.issues.f1?.reason).toBe('negative');
    expect(() => resolveIssue(l, meta('x1', '10:10'), 'f1', 'close')).toThrow('数えてから閉じる');
    l = recount(l, meta('c1', '10:20'), 'R1', 0, { kind: 'stated', text: '30台とも検査待ちに移っていた' });
    expect(resolveIssue(l, meta('x2', '10:30'), 'f1', 'close').issues.f1?.resolution).toMatchObject({ outcome: 'close' });
  });

  test('負数の事項は、事項のもとの操作より前の日時の数え直しでは閉じられない。日時の訂正でも前後を逆にできない', () => {
    const at = (time: string) => `2026-09-29T${time}:00+09:00`;
    const base = use(register(practiceLedger, meta('r1', '08:00'), part('X', 'P', 'S1'), 'counted', 10), meta('u1', '11:00'), 'X', 'counted', 50, '多すぎ');
    expect(base.issues.u1?.reason).toBe('negative');
    const early = recount(base, meta('c1', '10:00'), 'X', 10, { kind: 'unknown' }, 'notIncluded');
    expect(() => resolveIssue(early, meta('x1', '12:00'), 'u1', 'close')).toThrow('数えてから閉じる');
    let l = recount(base, meta('c2', '11:30'), 'X', 10, { kind: 'unknown' });
    l = resolveIssue(l, meta('x2', '12:00'), 'u1', 'close');
    expect(l.history.at(-1)).toMatchObject({ kind: 'resolve', countedBy: 'c2' });
    expect(() => correctOccurredAt(l, meta('t1', '13:00'), 'c2', at('10:30'))).toThrow('より前になる');
  });

  test('できたあとに数え直した保管単位では、従来どおり包含を聞く', () => {
    let l = split(register(practiceLedger, meta('r1', '08:00'), part('X', 'P', 'S1'), 'counted', 100), meta('s1', '10:00'), 'X', 'Y', 'counted', 30);
    l = recount(l, meta('c1', '11:00'), 'Y', 30, { kind: 'unknown' });
    expect(() => use(l, meta('u1', '10:30'), 'Y', 'counted', 5, '作業')).toThrow('含まれていたか');
  });

  test('負数で保留した外への引渡しは、適用して解消するまで引渡済み累計に数えない。根拠なしに閉じただけでは数えない', () => {
    const waiting = () => {
      let l = changeStage(started(), meta('f1', '10:00'), 'R1', 'R2', 'counted', 5, inspecting);
      l = changeStage(l, meta('i1', '10:30'), 'R2', 'R3', 'counted', 5, awaiting);
      return handOver(l, meta('h1', '11:00'), 'R3', 'counted', 8, '架空の後工程OUT');
    };
    expect(counts(waiting())).toMatchObject({ awaitingHandover: 5, handedOver: 0 });
    const closed = resolveIssue(recount(waiting(), meta('c1', '11:30'), 'R3', 0, { kind: 'stated', text: '8台渡していた' }), meta('x1', '11:40'), 'h1', 'close');
    expect(counts(closed)).toMatchObject({ awaitingHandover: 0, handedOver: 0 });
    const counted10 = recount(waiting(), meta('c1', '11:30'), 'R3', 10, { kind: 'unknown' });
    const applied = resolveIssue(counted10, meta('x2', '11:40'), 'h1', 'apply', 'notIncluded');
    expect(counts(applied)).toMatchObject({ awaitingHandover: 2, handedOver: 8 });
  });

  test('取り消した使用と取消の対は、数え直しの日時訂正で開く確認事項の前提に含めない', () => {
    let l = use(register(practiceLedger, meta('r1', '08:00'), part('X', 'P', 'S1'), 'counted', 100), meta('u1', '10:00'), 'X', 'counted', 10, '誤り');
    l = voidRecord(l, meta('v1', '10:30'), 'u1', '誤り');
    l = recount(l, meta('c1', '11:00'), 'X', 100, { kind: 'unknown' });
    l = correctOccurredAt(l, meta('t1', '12:00'), 'c1', '2026-09-29T09:00:00+09:00');
    expect(l.issues['c1@time']).toBeUndefined();
  });
});

describe('REC-02a 取消は誤りの前の数量の根拠を取り戻す', () => {
  const counted100 = () => register(practiceLedger, meta('r1', '08:00'), part('X', 'P', 'S1'), 'counted', 100);
  const quantityOfX = (l: Ledger) => l.lots.X?.quantity;

  test('表示の数（ラベル・パッケージ）の使用を取り消すと、数えた100のまま返ってきた物、中身未確認部分ありに劣化しない', () => {
    let l = use(counted100(), meta('u1', '09:00'), 'X', 'label', 10, '誤り');
    expect(quantityOfX(l)).toMatchObject({ numeric: { value: 90, unconfirmed: 'partial' } });
    l = voidRecord(l, meta('v1', '09:30'), 'u1', '実際は使用していない');
    expect(quantityOfX(l)).toMatchObject({ kind: 'known', numeric: { value: 100, approximate: false, unconfirmed: 'none' }, computed: false });
    expect(l.history.at(-1)).toMatchObject({ kind: 'void', applied: true });
  });

  test('だいたいの使用の取消も、約の表示を残さない', () => {
    const l = voidRecord(use(counted100(), meta('u1', '09:00'), 'X', 'approximate', 10, '誤り'), meta('v1', '09:30'), 'u1', '誤り');
    expect(quantityOfX(l)).toMatchObject({ numeric: { value: 100, approximate: false, unconfirmed: 'none' } });
  });

  test('誤りの後に別の使用があっても、その使用だけを引き直して根拠を戻す', () => {
    let l = use(counted100(), meta('u1', '09:00'), 'X', 'label', 10, '誤り');
    l = use(l, meta('u2', '10:00'), 'X', 'counted', 5, '正しい使用');
    l = voidRecord(l, meta('v1', '10:30'), 'u1', '誤り');
    expect(quantityOfX(l)).toMatchObject({ numeric: { value: 95, approximate: false, unconfirmed: 'none' } });
  });

  test('後の使用がすでに取り消されていれば、その分は引き直さず、根拠を戻す', () => {
    let l = use(counted100(), meta('u1', '09:00'), 'X', 'label', 10, '誤り');
    l = use(l, meta('u2', '10:00'), 'X', 'counted', 5, '誤り');
    l = voidRecord(l, meta('v2', '10:30'), 'u2', '誤り');
    l = voidRecord(l, meta('v1', '11:00'), 'u1', '誤り');
    expect(quantityOfX(l)).toMatchObject({ numeric: { value: 100, approximate: false, unconfirmed: 'none' }, computed: false });
  });

  test('取り消し済みの使用は、それより前の日時の数え直しでも包含を聞かない。取消と対で打ち消し合う', () => {
    let l = use(counted100(), meta('u1', '10:00'), 'X', 'counted', 10, '誤り');
    l = voidRecord(l, meta('v1', '11:00'), 'u1', '誤り');
    l = recount(l, meta('c1', '09:00'), 'X', 100, { kind: 'unknown' });
    expect(valueOf(quantityOfX(l))).toBe(100);
    expect(l.history.at(-1)).toMatchObject({ kind: 'recount', applied: true, inclusion: null });
  });

  test('統合の元で取り消した使用も、統合先の数え直しで包含を聞かない。数量も正しく戻る', () => {
    let l = use(counted100(), meta('u1', '10:00'), 'X', 'counted', 10, '誤り');
    l = register(l, meta('r2', '08:10'), part('Y', 'P', 'S1'), 'counted', 20);
    l = merge(l, meta('g1', '09:00'), 'X', 'Y');
    l = voidRecord(l, meta('v1', '11:00'), 'u1', '誤り');
    expect(valueOf(l.lots.Y?.quantity)).toBe(120);
    l = recount(l, meta('c1', '09:30'), 'Y', 120, { kind: 'unknown' });
    expect(l.history.at(-1)).toMatchObject({ kind: 'recount', applied: true, inclusion: null });
  });

  test('誤りより前の使用が、誤りより後に取り消されていても、その分は引き直さず根拠を戻す', () => {
    let l = use(counted100(), meta('u1', '09:00'), 'X', 'counted', 5, '誤り');
    l = use(l, meta('u2', '10:00'), 'X', 'label', 10, '誤り');
    l = voidRecord(l, meta('v1', '10:30'), 'u1', '誤り');
    l = voidRecord(l, meta('v2', '11:00'), 'u2', '誤り');
    expect(quantityOfX(l)).toMatchObject({ numeric: { value: 100, approximate: false, unconfirmed: 'none' }, computed: false });
  });

  test('誤りを記録した保管単位がその後まとめ直されていても、統合先で取り消して数量を戻す', () => {
    let l = use(counted100(), meta('u1', '09:00'), 'X', 'counted', 10, '誤り');
    l = register(l, meta('r2', '09:10'), part('Y', 'P', 'S1'), 'counted', 20);
    l = merge(l, meta('g1', '09:20'), 'X', 'Y');
    expect(valueOf(l.lots.Y?.quantity)).toBe(110);
    l = voidRecord(l, meta('v1', '10:00'), 'u1', '実際は使用していない');
    expect(valueOf(l.lots.Y?.quantity)).toBe(120);
    expect(l.lots.X?.mergedInto).toBe('Y');
    expect(l.history.at(-1)).toMatchObject({ kind: 'void', lotId: 'X', applied: true });
    expect(l.history.at(-1)?.changes.map((c) => c.after.id)).toEqual(['Y']);
  });

  test('表示の数（ラベル・パッケージ）の使用の後にまとめ直されていても、取消で数えたの根拠を戻す', () => {
    let l = use(counted100(), meta('u1', '09:00'), 'X', 'label', 10, '誤り');
    l = register(l, meta('r2', '09:10'), part('Y', 'P', 'S1'), 'counted', 20);
    l = merge(l, meta('g1', '09:20'), 'X', 'Y');
    expect(l.lots.Y?.quantity).toMatchObject({ numeric: { value: 110, unconfirmed: 'partial' } });
    l = voidRecord(l, meta('v1', '10:00'), 'u1', '誤り');
    expect(l.lots.Y?.quantity).toMatchObject({ numeric: { value: 120, approximate: false, unconfirmed: 'none' } });
  });

  test('統合先にまとめた後、統合先の元の保管単位の誤りを取り消しても、根拠を戻す', () => {
    let l = register(counted100(), meta('r2', '08:10'), part('Z', 'P', 'S1'), 'counted', 20);
    l = use(l, meta('u1', '09:00'), 'X', 'approximate', 10, '誤り');
    l = merge(l, meta('g1', '09:20'), 'Z', 'X');
    l = voidRecord(l, meta('v1', '10:00'), 'u1', '誤り');
    expect(l.lots.X?.quantity).toMatchObject({ numeric: { value: 120, approximate: false, unconfirmed: 'none' } });
  });

  test('統合先をその後に数え直していれば、数量は戻さず記録だけ残す', () => {
    let l = use(counted100(), meta('u1', '09:00'), 'X', 'counted', 10, '誤り');
    l = register(l, meta('r2', '09:10'), part('Y', 'P', 'S1'), 'counted', 20);
    l = merge(l, meta('g1', '09:20'), 'X', 'Y');
    l = recount(l, meta('c1', '09:30'), 'Y', 110, { kind: 'unknown' });
    l = voidRecord(l, meta('v1', '10:00'), 'u1', '実際は使用していない');
    expect(valueOf(l.lots.Y?.quantity)).toBe(110);
    expect(l.history.at(-1)).toMatchObject({ kind: 'void', applied: false, changes: [] });
  });

  test('誤りの後に統合があるときは引き直せないので足し戻す。数量は正しい', () => {
    let l = use(counted100(), meta('u1', '09:00'), 'X', 'label', 10, '誤り');
    l = register(l, meta('r2', '09:10'), part('Z', 'P', 'S1'), 'counted', 20);
    l = merge(l, meta('g1', '09:20'), 'Z', 'X');
    l = voidRecord(l, meta('v1', '10:00'), 'u1', '誤り');
    expect(valueOf(quantityOfX(l))).toBe(120);
  });
});

describe('中断の日時（MFG-08c・NFR-08b）', () => {
  const stopAt = (time: string) =>
    recordStop(start(practiceLedger, meta('st', '09:00'), product('R1'), assembly, 'counted', 10, []), meta('stop1', time), {
      process: assembly.id,
      item: 'R',
      unit: '台',
      project: a001,
      reason: '部品不足',
      shortage: null,
      affected: null,
    });

  test('中断より前の日時の台数更新・作業の再開は記録しない', () => {
    const l = stopAt('11:00');
    expect(() => updateStop(l, meta('u1', '10:00'), 'stop1', 5)).toThrow('より前の日時の更新・再開');
    expect(() => resumeWork(l, meta('re1', '10:00'), 'stop1')).toThrow('より前の日時の更新・再開');
    expect(updateStop(l, meta('u2', '11:30'), 'stop1', 5).stops.stop1?.affected).toBe(5);
  });

  test('作業の中断済みの更新より前の日時の、別の更新・作業の再開も記録しない', () => {
    const l = updateStop(stopAt('09:00'), meta('u1', '11:00'), 'stop1', 5);
    expect(() => updateStop(l, meta('u2', '10:00'), 'stop1', 4)).toThrow('より前の日時の更新・再開');
    expect(() => resumeWork(l, meta('re1', '10:00'), 'stop1')).toThrow('より前の日時の更新・再開');
    expect(resumeWork(l, meta('re2', '11:00'), 'stop1').stops.stop1?.resumedBy).toBe('re2');
  });

  test('日時の訂正で、作業の再開が記録済みの更新より前になる訂正は受け付けない', () => {
    let l = updateStop(stopAt('09:00'), meta('u1', '11:00'), 'stop1', 5);
    l = resumeWork(l, meta('re1', '12:00'), 'stop1');
    expect(() => correctOccurredAt(l, meta('t1', '13:00'), 're1', '2026-09-29T10:30:00+09:00')).toThrow('より前になる');
  });

  test('日時の訂正でも、更新・再開が中断より前になる訂正は受け付けない', () => {
    const l = updateStop(stopAt('11:00'), meta('u1', '12:00'), 'stop1', 5);
    const at = (time: string) => `2026-09-29T${time}:00+09:00`;
    expect(() => correctOccurredAt(l, meta('t1', '13:00'), 'u1', at('10:00'))).toThrow('より前になる');
    expect(() => correctOccurredAt(l, meta('t2', '13:00'), 'stop1', at('12:30'))).toThrow('より前になる');
    expect(correctOccurredAt(l, meta('t3', '13:00'), 'u1', at('11:30')).history.at(-1)).toMatchObject({ kind: 'correctTime' });
  });
});

describe('操作どうしの前後（NFR-08b）', () => {
  const at = (time: string) => `2026-09-29T${time}:00+09:00`;
  const base = () => register(practiceLedger, meta('rp', '08:00'), part('P1', 'P', 'T'), 'counted', 100);

  test('作業の開始より後の日時の材料の使用は、その作業の開始に対応付けない。同時・前・日時不明は対応付ける', () => {
    const l = use(base(), meta('u1', '11:00'), 'P1', 'counted', 10, 'R作業の開始');
    expect(() => start(l, meta('st', '10:00'), product('R1'), assembly, 'counted', 10, ['u1'])).toThrow('作業の開始より後');
    expect(start(l, meta('st2', '11:00'), product('R2'), assembly, 'counted', 10, ['u1']).lots.R2).toBeDefined();
    expect(start(l, { ...meta('st3', '10:00'), occurredAt: null }, product('R3'), assembly, 'counted', 10, ['u1']).lots.R3).toBeDefined();
  });

  test('日時の訂正で、材料の使用が作業の開始より後になる訂正は受け付けない', () => {
    let l = use(base(), meta('u1', '09:00'), 'P1', 'counted', 10, 'R作業の開始');
    l = start(l, meta('st', '10:00'), product('R1'), assembly, 'counted', 10, ['u1']);
    expect(() => correctOccurredAt(l, meta('t1', '12:00'), 'u1', at('11:00'))).toThrow('作業の開始より後');
    expect(() => correctOccurredAt(l, meta('t2', '12:00'), 'st', at('08:30'))).toThrow('作業の開始より後');
  });

  test('取り消す操作より前の日時の取消は記録しない。日時の訂正でも前後が逆になる訂正は受け付けない', () => {
    let l = use(base(), meta('u1', '11:00'), 'P1', 'counted', 10, '誤り');
    expect(() => voidRecord(l, meta('v1', '10:30'), 'u1', '誤り')).toThrow('取り消す操作より前');
    l = voidRecord(l, meta('v2', '11:30'), 'u1', '誤り');
    expect(() => correctOccurredAt(l, meta('t1', '12:00'), 'v2', at('10:00'))).toThrow('取り消す操作より前');
    expect(() => correctOccurredAt(l, meta('t2', '12:00'), 'u1', at('11:45'))).toThrow('取り消す操作より前');
  });
});

describe('AT-48 SCN-01を通し、Pの追加使用10個の誤登録を記録誤りとして訂正する', () => {
  function scn01(): Ledger {
    let l = register(practiceLedger, meta('q0', '07:00'), part('Q1', 'Q', 'S1'), 'counted', 100);
    l = register(l, meta('p1', '08:00'), part('PA', 'P', 'S1'), 'label', 100);
    l = register(l, meta('p2', '08:10'), part('PB', 'P', 'S2', a002), 'label', 100);
    l = recount(l, meta('c1', '09:00'), 'PA', 100, { kind: 'stated', text: '受け取り後の全数確認' });
    l = split(l, meta('s1', '09:05'), 'PA', 'PT', 'counted', 30);
    l = move(l, meta('m1', '09:05'), 'PT', 'T');
    l = use(l, meta('up', '09:15'), 'PT', 'counted', 30, 'R作業の開始');
    l = use(l, meta('uq', '09:15'), 'Q1', 'counted', 30, 'R作業の開始');
    l = start(l, meta('st', '09:15'), product('R1'), assembly, 'counted', 30, ['up', 'uq']);
    l = changeStage(l, meta('f1', '11:00'), 'R1', 'R2', 'counted', 20, inspecting);
    l = changeStage(l, meta('i1', '11:01'), 'R2', 'R3', 'counted', 18, awaiting);
    l = changeStage(l, meta('h1', '11:20'), 'R3', 'R4', 'counted', 10, noStage);
    return move(l, meta('m2', '11:20'), 'R4', 'N');
  }
  const pA001 = (l: Ledger) => valueOf(totalOf(l, 'P', (lot) => lot.project.kind === 'case' && lot.project.id === 'A-001'));

  test('途中の表示は、P棚70・作業台0、Q70、R工程内12・完成（渡す前）8・次工程10、工程完了累計18', () => {
    const l = scn01();
    expect([valueOf(l.lots.PA?.quantity), valueOf(l.lots.PT?.quantity), valueOf(l.lots.Q1?.quantity)]).toEqual([70, 0, 70]);
    expect(counts(l)).toEqual({ working: 10, inspecting: 2, awaitingHandover: 8, completed: 18, returned: 0, handedOver: 10 });
    expect(l.lots.R4).toMatchObject({ location: 'N', stage: noStage });
    expect(valueOf(totalOf(l, 'R'))).toBe(30);
    expect(valueOf(l.lots.PB?.quantity)).toBe(100);
  });

  test('誤った使用10個を取り消すと、Pは70へ返ってきた物、Q・Rは不変。現物の戻しや再製造を作らず元記録を追える', () => {
    let l = use(scn01(), meta('ux', '17:00'), 'PA', 'counted', 10, 'R追加（誤り）');
    expect(pA001(l)).toBe(60);
    const r = counts(l);
    l = voidRecord(l, { ...meta('v1', '17:30'), actor: '架空担当B' }, 'ux', '実際は使用していない');
    expect(pA001(l)).toBe(70);
    expect(valueOf(l.lots.Q1?.quantity)).toBe(70);
    expect(counts(l)).toEqual(r);
    expect(l.history.at(-1)).toMatchObject({ kind: 'void', targetEventId: 'ux', lotId: 'PA', reason: '実際は使用していない', applied: true, actor: '架空担当B' });
    expect(l.history.at(-1)?.changes.map((c) => [valueOf(c.before?.quantity), valueOf(c.after.quantity)])).toEqual([[60, 70]]);
    expect(l.history.find((e) => e.eventId === 'ux')).toMatchObject({ kind: 'use', value: 10, actor: '架空担当A' });
    expect(l.history.filter((e) => e.kind === 'register' || e.kind === 'start' || e.kind === 'stage').length).toBe(7);
    expect(l.lots.PA?.quantity.terms.map((t) => t.observation.id)).not.toContain('ux');
  });

  test('正しく記録した作業の開始の材料の使用は取り消さず、製造との関連を保つ', () => {
    expect(() => voidRecord(scn01(), meta('v1', '17:30'), 'up', '誤り')).toThrow('作業の開始の材料に対応付けてある');
  });

  test('REC-02b: 誤りの後に数え直していれば、数量は戻さず記録だけ残す', () => {
    let l = use(scn01(), meta('ux', '17:00'), 'PA', 'counted', 10, '誤り');
    l = recount(l, meta('c2', '17:10'), 'PA', 70, { kind: 'unknown' });
    l = voidRecord(l, meta('v1', '17:30'), 'ux', '実際は使用していない');
    expect(pA001(l)).toBe(70);
    expect(l.history.at(-1)).toMatchObject({ kind: 'void', applied: false, changes: [] });
  });

  test('取消済み・数が不明・照合中の使用と、使用・引渡し以外の操作は取り消さない', () => {
    let l = use(scn01(), meta('ux', '17:00'), 'PA', 'counted', 10, '誤り');
    l = voidRecord(l, meta('v1', '17:30'), 'ux', '誤り');
    expect(() => voidRecord(l, meta('v2', '17:40'), 'ux', '誤り')).toThrow('取消済み');
    expect(() => voidRecord(l, meta('v3', '17:40'), 's1', '誤り')).toThrow('取り消せる使用・引渡しではない');
    expect(() => voidRecord(l, meta('v4', '17:40'), 'ux', ' ')).toThrow('理由');
    const unknownUse = use(l, meta('uu', '17:50'), 'PA', 'unknown', null, '誤り');
    expect(() => voidRecord(unknownUse, meta('v5', '18:00'), 'uu', '誤り')).toThrow('数が不明');
    const negative = use(l, meta('un', '17:50'), 'PA', 'counted', 500, '誤り');
    expect(() => voidRecord(negative, meta('v6', '18:00'), 'un', '誤り')).toThrow('確認事項');
    expect(() => start(l, meta('x', '18:00'), product('R9'), assembly, 'counted', 1, ['ux'])).toThrow('取消済み');
  });

  test('後の数え直しの日時訂正で開いた確認事項が未解決の保管単位の使用も、先に解消するまで取り消さない', () => {
    let l = use(register(practiceLedger, meta('r1', '08:00'), part('X', 'P', 'S1'), 'counted', 100), meta('u1', '10:00'), 'X', 'counted', 10, '誤り');
    l = recount(l, meta('c1', '11:00'), 'X', 90, { kind: 'unknown' });
    l = correctOccurredAt(l, meta('t1', '12:00'), 'c1', '2026-09-29T09:00:00+09:00');
    expect(l.issues['c1@time']?.resolution).toBeNull();
    expect(() => voidRecord(l, meta('v1', '13:00'), 'u1', '誤り')).toThrow('未解決の確認事項');
  });

  test('同じ保管単位の別の操作の日時訂正の事項は、その前提に含まれない使用の取消を止めない', () => {
    let l = register(practiceLedger, meta('r1', '09:00'), part('X', 'P', 'S1'), 'counted', 100);
    l = use(l, meta('ua', '10:00'), 'X', 'counted', 10, '誤り');
    l = use(l, meta('ub', '11:00'), 'X', 'counted', 5, '作業');
    l = correctOccurredAt(l, meta('t1', '12:00'), 'ub', '2026-09-29T08:00:00+09:00');
    expect(l.issues['ub@time']?.resolution).toBeNull();
    expect(valueOf(voidRecord(l, meta('v1', '13:00'), 'ua', '誤り').lots.X?.quantity)).toBe(95);
  });

  test('日時の訂正で開いた確認事項（操作ID@time）が未解決の使用も、先に解消するまで取り消さない', () => {
    let l = use(register(practiceLedger, meta('r1', '09:00'), part('X', 'P', 'S1'), 'counted', 100), meta('u1', '10:00'), 'X', 'counted', 10, '誤り');
    l = correctOccurredAt(l, meta('t1', '11:00'), 'u1', '2026-09-29T08:00:00+09:00');
    expect(l.issues['u1@time']?.resolution).toBeNull();
    expect(() => voidRecord(l, meta('v1', '12:00'), 'u1', '誤り')).toThrow('未解決の確認事項');
  });
});
