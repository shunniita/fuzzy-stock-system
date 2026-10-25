import { fixedMasters } from '../../src/domain/masters.ts';
import { describe, expect, test } from 'vitest';
import {
  changeStage, practiceLedger, handOver, hold, merge, move, noStage, recount, recordStop,
  register, resumeWork, split, start, use, voidRecord, type Ledger, type Meta, type Process, type Project,
} from '../../src/domain/ledger.ts';
import {
  allocateArrival, cancelRequest, declareShortage, emptySupply, receiveLot, recordRequest,
  registerNeed, type Supply,
} from '../../src/domain/supply.ts';
import { caseDetailOf, caseDetailText, type CaseDetail } from '../../src/ui/caseview.ts';
import { seedLedger, seedScn02 } from '../../src/ui/seed.ts';

const a001 = { kind: 'case', id: 'A-001' } satisfies Project;
const b001 = { kind: 'case', id: 'B-001' } satisfies Project;
const process: Process = { id: 'R組立', criterion: 'inspection' };
function meta(eventId: string, time = '12:00'): Meta {
  const at = `2026-09-29T${time}:00+09:00`;
  return { eventId, occurredAt: at, recordedAt: at, actor: '架空担当A' };
}
const lotOf = (id: string, item = 'P', unit = '個', project: Project = a001, location = 'S1') => ({ id, item, unit, project, location });
function groupOf(detail: CaseDetail, item = 'P', unit = '個'): CaseDetail['groups'][number] {
  const group = detail.groups.find((g) => g.item === item && g.unit === unit);
  if (!group) throw new Error(`品目${item}（${unit}）の群がない`);
  return group;
}
function scn01(): Ledger {
  let l = register(practiceLedger, meta('q0', '07:00'), lotOf('Q1', 'Q'), 'counted', 100);
  l = register(l, meta('p1', '08:00'), lotOf('PA'), 'label', 100);
  l = register(l, meta('p2', '08:10'), lotOf('PB', 'P', '個', { kind: 'case', id: 'A-002' }, 'S2'), 'label', 100);
  l = recount(l, meta('c1', '09:00'), 'PA', 100, { kind: 'stated', text: '全数確認' });
  l = split(l, meta('s1', '09:05'), 'PA', 'PT', 'counted', 30);
  l = move(l, meta('m1', '09:05'), 'PT', 'T');
  l = use(l, meta('up', '09:15'), 'PT', 'counted', 30, 'R作業の開始');
  l = use(l, meta('uq', '09:15'), 'Q1', 'counted', 30, 'R作業の開始');
  l = start(l, meta('st', '09:15'), lotOf('R1', 'R', '台', a001, 'T'), process, 'counted', 30, ['up', 'uq']);
  l = changeStage(l, meta('f1', '11:00'), 'R1', 'R2', 'counted', 20, { kind: 'inspecting', process });
  l = changeStage(l, meta('i1', '11:01'), 'R2', 'R3', 'counted', 18, { kind: 'awaitingHandover', process });
  l = changeStage(l, meta('h1', '11:20'), 'R3', 'R4', 'counted', 10, noStage);
  return move(l, meta('m2', '11:20'), 'R4', 'N');
}
function scn02(): { ledger: Ledger; supply: Supply } {
  let { ledger, supply } = seedScn02();
  ledger = recount(ledger, meta('count', '09:00'), 'P-B01', 98, { kind: 'unknown' });
  ledger = split(ledger, meta('bad-split', '09:10'), 'P-B01', 'P-bad', 'counted', 3);
  ledger = hold(ledger, meta('bad-hold', '09:10'), 'P-bad', 'defective');
  ledger = recordStop(ledger, meta('stop', '09:20'), {
    process: process.id, item: 'R', unit: '台', project: b001, reason: '部品不足',
    shortage: { item: 'P', unit: '個', value: 5 }, affected: null,
  });
  supply = recordRequest(supply, fixedMasters, meta('request', '09:30'), {
    project: b001, item: 'P', unit: '個', quantity: 5, vendor: '架空仕入先', requestedOn: '2026-09-29', reply: { kind: 'none' },
  });
  return { ledger, supply };
}
function stopOnly(project: Project = a001, unit = '個', shortage = true): Ledger {
  return recordStop(practiceLedger, meta('stop'), {
    process: process.id, item: 'R', unit: '台', project, reason: '材料待ち',
    shortage: shortage ? { item: 'P', unit, value: 1 } : null, affected: null,
  });
}

describe('B3 6.1〜6.4・9.1 案件・用途詳細（FH-B03の文言部分）', () => {
  test('記録がない案件・用途は群を作らず、空の状態を表示する', () => {
    const detail = caseDetailOf(practiceLedger, emptySupply, 'A-001');
    expect(detail).toEqual({ project: 'A-001', title: '案件・用途A-001', groups: [] });
    expect(caseDetailText(detail)).toContain('案件・用途A-001');
    expect(caseDetailText(detail)).toContain('記録はまだない');
  });

  test('固定の架空初期データから、別案件・用途・共通・所属不明の現物を案件・用途の数へ含めない', () => {
    const detail = caseDetailOf(seedLedger(), emptySupply, 'A-001');
    expect(detail.groups.map((g) => [g.item, g.unit])).toEqual([['P', '個'], ['Q', '個'], ['R', '台']]);
    const text = caseDetailText(detail);
    for (const id of ['P-001', 'P-001-D', '0012', 'R-001']) expect(text).toContain(id);
    for (const id of ['P-002', 'P-003', 'P-004', 'Q-002', 'S-001', 'S-002']) expect(text).not.toContain(id);
    expect(text).toContain('不良');
  });

  test('SCN-01の現在位置と数量を、元の保管単位ID・所在・工程・単位つきで分ける', () => {
    const detail = caseDetailOf(scn01(), emptySupply, 'A-001');
    expect(groupOf(detail).unused.join('\n')).toContain('保管単位PA・所在S1・記録上の数70個');
    expect(groupOf(detail, 'Q').unused.join('\n')).toContain('保管単位Q1・所在S1・記録上の数70個');
    const r = groupOf(detail, 'R', '台');
    expect(r.working).toHaveLength(2);
    expect(r.working.join('\n')).toContain('保管単位R1・所在T・記録上の数10台');
    expect(r.working.join('\n')).toContain('工程R組立・作業中');
    expect(r.working.join('\n')).toContain('保管単位R2・所在T・記録上の数2台');
    expect(r.working.join('\n')).toContain('確認待ち');
    expect(r.completed).toHaveLength(1);
    expect(r.completed[0]).toContain('保管単位R3・所在T・記録上の数8台');
    expect(r.completed[0]).toContain('完成（渡す前）');
    expect(r.unused).toHaveLength(1);
    expect(r.unused[0]).toContain('保管単位R4・所在N・10台・数えた');
    expect(caseDetailText(detail)).not.toContain('保管単位PB');
  });

  test('SCN-01の誤使用訂正後もP70・Q70・工程内と完成（渡す前）を保ち、表示で履歴を作らない', () => {
    const ledger = voidRecord(use(scn01(), meta('wrong', '17:00'), 'PA', 'counted', 10, '誤登録'), meta('undo', '17:30'), 'wrong', '実際は使用なし');
    const before = JSON.stringify(ledger);
    const detail = caseDetailOf(ledger, emptySupply, 'A-001');
    expect(groupOf(detail).unused.join('\n')).toContain('70個');
    expect(groupOf(detail, 'Q').unused.join('\n')).toContain('70個');
    expect(groupOf(detail, 'R', '台').completed.join('\n')).toContain('8台');
    caseDetailText(detail);
    expect(JSON.stringify(ledger)).toBe(before);
  });

  test('SCN-02のラベル100の初期状態を、数えたや不足なしと断定しない', () => {
    const { ledger, supply } = seedScn02();
    const p = groupOf(caseDetailOf(ledger, supply, 'B-001'));
    expect(p.need).toContain('100個（数えた）');
    expect(p.need).toContain('必要日 2026-10-10');
    expect(p.need).toContain('sc-n1');
    expect(p.unused.join('\n')).toContain('100個・表示の数（ラベル・パッケージ）・中身未確認');
    expect(p.shortage).toContain('中身未確認（表示の数（ラベル・パッケージ）を含む）');
    expect(p.outstanding).toContain('保留（不足が確定していないため');
    expect(p.stops).toEqual([]);
    expect(caseDetailText(caseDetailOf(ledger, supply, 'B-001'))).not.toContain('sc-q1');
  });

  test('SCN-02の不良隔離・追加依頼で、不足5・依頼5・未着5・中断を別に示す', () => {
    const { ledger, supply } = scn02();
    const p = groupOf(caseDetailOf(ledger, supply, 'B-001'));
    expect(p.unused).toHaveLength(2);
    expect(p.unused.join('\n')).toContain('95個');
    expect(p.unused.join('\n')).toContain('3個・数えた');
    expect(p.unused.join('\n')).toContain('取り分けた理由：不良');
    expect(p.shortage).toContain('不足 5個（帳簿上の不足）');
    expect(p.shortage).toContain('数量不足 2個・除外による不足 3個');
    expect(p.outstanding).toContain('依頼済み 5個／依頼の未着 5個');
    expect(p.outstanding).toContain('依頼 request');
    expect(p.outstanding).toContain('注文の確定なし');
    expect(p.stops.join('\n')).toContain('中断 stop');
    expect(p.stops.join('\n')).toContain('影響数不明');
    const text = caseDetailText(caseDetailOf(ledger, supply, 'B-001'));
    for (const label of ['必要な数：', '未着・依頼：', '未使用の部品：', '仕掛品：', '工程完了品：', '不足と判定：', 'その不足で止まっている作業：']) expect(text).toContain(label);
  });

  test('SCN-02の分納3個で、不足2・未着2へ変わっても中断は自動再開しない', () => {
    const initial = scn02();
    const received = receiveLot(initial.ledger, initial.supply, meta('receipt', '10:00'), lotOf('P-extra', 'P', '個', b001, 'T'), 'counted', 3);
    const supply = allocateArrival(received.ledger, received.supply, meta('arrival', '10:00'), 'request', { receiptLotId: 'P-extra', arrived: 3, good: 3 });
    const p = groupOf(caseDetailOf(received.ledger, supply, 'B-001'));
    expect(p.shortage).toContain('不足 2個');
    expect(p.outstanding).toContain('依頼の未着 2個');
    expect(p.outstanding).toContain('到着 3個（不足の解消に充てた良品 3個）');
    expect(p.unused.join('\n')).toContain('保管単位P-extra・所在T・3個');
    expect(p.stops.join('\n')).toContain('中断 stop');
  });

  test('SCN-02の全量到着と実返却で不足0でも、別記録の作業の再開まで中断を残す', () => {
    const initial = scn02();
    const received = receiveLot(initial.ledger, initial.supply, meta('receipt', '10:00'), lotOf('P-extra', 'P', '個', b001), 'counted', 5);
    const supply = allocateArrival(received.ledger, received.supply, meta('arrival', '10:00'), 'request', { receiptLotId: 'P-extra', arrived: 5, good: 5 });
    const ledger = handOver(received.ledger, meta('return', '10:30'), 'P-bad', 'counted', 3, '架空仕入先へ実返却');
    const p = groupOf(caseDetailOf(ledger, supply, 'B-001'));
    expect(p.shortage).toContain('不足 0個（帳簿上の不足）');
    expect(p.outstanding).toContain('依頼の未着 0個');
    expect(p.stops).toHaveLength(1);
    expect(groupOf(caseDetailOf(resumeWork(ledger, meta('resume', '11:00'), 'stop'), supply, 'B-001')).stops).toEqual([]);
  });

  test('必要明細だけの品目も、受け取りなし・必要な数と必要日つきで表示する', () => {
    const supply = registerNeed(emptySupply, fixedMasters, meta('need'), { project: a001, item: 'Q', unit: '個', required: { basis: 'counted', value: 100 }, dueDate: null, source: '架空部品一覧', revision: '初版' });
    const q = groupOf(caseDetailOf(practiceLedger, supply, 'A-001'), 'Q');
    expect(q.need).toContain('100個（数えた）');
    expect(q.need).toContain('必要日なし');
    expect(q.unused).toEqual([]);
    expect(q.shortage).toContain('不足 100個');
    expect(q.outstanding).toContain('依頼済み 0個／依頼の未着 0個');
    expect(q.stops).toEqual([]);
  });

  test('依頼だけの品目も群にし、必要な数は未登録・不足は判定不能のままにする', () => {
    const supply = recordRequest(emptySupply, fixedMasters, meta('request'), { project: a001, item: 'P', unit: '個', quantity: 4, vendor: '架空仕入先', requestedOn: '2026-09-29', reply: { kind: 'answered', date: '2026-10-01' } });
    const p = groupOf(caseDetailOf(practiceLedger, supply, 'A-001'));
    expect(p.need).toContain('未登録');
    expect(p.shortage).toContain('判定不能：必要な数が未登録');
    expect(p.outstanding).toContain('依頼済み 4個／依頼の未着 4個');
    expect(p.outstanding).toContain('依頼 request');
    expect(p.outstanding).toContain('相手が回答した予定日2026-10-01');
    expect(p.stops).toEqual([]);
  });

  test('申告だけの品目を群にし、申告IDと数量を不足の判定・中断と分ける', () => {
    const supply = declareShortage(emptySupply, fixedMasters, meta('declaration'), { project: a001, item: 'P', unit: '個', value: 7, reason: '架空の追加部品不足' });
    const p = groupOf(caseDetailOf(practiceLedger, supply, 'A-001'));
    expect(p.need).toContain('未登録');
    expect(p.shortage).toContain('判定不能');
    expect(p.shortage).toContain('足りない分の記録 declaration：7個');
    expect(p.outstanding).toContain('依頼済み 0個／依頼の未着 0個');
    expect(p.stops).toEqual([]);
  });

  test('他案件・用途・共通・所属不明の供給群を選択案件・用途へ混ぜない', () => {
    let supply = emptySupply;
    for (const [id, project] of [['other', { kind: 'case', id: 'A-002' }], ['common', { kind: 'common' }], ['unassigned', { kind: 'unassigned' }]] satisfies [string, Project][]) {
      supply = declareShortage(supply, fixedMasters, meta(id), { project, item: 'Q', unit: '個', value: 9, reason: '別所属' });
    }
    expect(caseDetailOf(practiceLedger, supply, 'A-001').groups).toEqual([]);
  });

  test('数が不明の現物は0へ変えず、必要な数が分かっても不足の判定不能を残す', () => {
    const ledger = register(practiceLedger, meta('unknown'), lotOf('P-unknown'), 'unknown', null);
    const supply = registerNeed(emptySupply, fixedMasters, meta('need'), { project: a001, item: 'P', unit: '個', required: { basis: 'counted', value: 10 }, dueDate: null, source: '架空', revision: '初版' });
    const p = groupOf(caseDetailOf(ledger, supply, 'A-001'));
    expect(p.unused[0]).toContain('数が不明');
    expect(p.unused[0]).not.toContain('0個');
    expect(p.shortage).toContain('判定不能：在庫の数量が不明');
    expect(p.shortage).not.toContain('不足 0個');
    expect(p.outstanding).toContain('0ではない');
  });

  test('実数0・だいたい約0・ラベル0を区別し、同じ品目の箱と本を別群にする', () => {
    let ledger = register(practiceLedger, meta('counted'), lotOf('S-counted', 'S', '本'), 'counted', 0);
    ledger = register(ledger, meta('approx'), lotOf('S-approx', 'S', '本'), 'approximate', 0);
    ledger = register(ledger, meta('label'), lotOf('S-label', 'S', '箱'), 'label', 0);
    const detail = caseDetailOf(ledger, emptySupply, 'A-001');
    expect(detail.groups.map((g) => [g.item, g.unit])).toEqual([['S', '本'], ['S', '箱']]);
    expect(groupOf(detail, 'S', '本').unused.join('\n')).toContain('0本・数えた');
    expect(groupOf(detail, 'S', '本').unused.join('\n')).toContain('約0本・だいたい');
    expect(groupOf(detail, 'S', '箱').unused.join('\n')).toContain('0箱・表示の数（ラベル・パッケージ）・中身未確認');
    expect(groupOf(detail, 'S', '箱').unused.join('\n')).not.toContain('S-counted');
  });

  test.each([
    { basis: 'approximate', value: 12, text: '12個（だいたい）' },
    { basis: 'label', value: 12, text: '12個（表示の数（ラベル・パッケージ））' },
    { basis: 'unknown', value: null, text: '数が不明（数が不明）' },
  ] satisfies { basis: 'approximate' | 'label' | 'unknown'; value: number | null; text: string }[])('必要な数の根拠も保持する：$basis', ({ basis, value, text }) => {
    const supply = registerNeed(emptySupply, fixedMasters, meta('need'), { project: a001, item: 'P', unit: '個', required: { basis, value }, dueDate: null, source: '架空', revision: '初版' });
    expect(groupOf(caseDetailOf(practiceLedger, supply, 'A-001')).need).toContain(text);
  });

  test('取り分けた理由は作業の状態と独立に残し、工程内の物を未使用へ二重計上しない', () => {
    let ledger = register(practiceLedger, meta('working'), { ...lotOf('R-working', 'R', '台'), stage: { kind: 'working', process } }, 'unknown', null);
    ledger = hold(ledger, meta('hold'), 'R-working', 'usabilityCheck');
    ledger = register(ledger, meta('completed'), { ...lotOf('R-completed', 'R', '台'), stage: { kind: 'awaitingHandover', process } }, 'label', 2);
    const r = groupOf(caseDetailOf(ledger, emptySupply, 'A-001'), 'R', '台');
    expect(r.unused).toEqual([]);
    expect(r.working).toHaveLength(1);
    expect(r.working[0]).toContain('数が不明');
    expect(r.working[0]).toContain('使用可否確認待ち');
    expect(r.completed).toHaveLength(1);
    expect(r.completed[0]).toContain('2台・表示の数（ラベル・パッケージ）・中身未確認');
    expect(ledger.history.map((e) => e.kind)).toEqual(['register', 'hold', 'register']);
  });

  test('統合済みの元を表示せず、供給・現物が重なる群を一つに保つ', () => {
    let ledger = register(practiceLedger, meta('source'), lotOf('P-source'), 'counted', 2);
    ledger = register(ledger, meta('target'), lotOf('P-target'), 'counted', 3);
    ledger = merge(ledger, meta('merge'), 'P-source', 'P-target');
    const supply = registerNeed(emptySupply, fixedMasters, meta('need'), { project: a001, item: 'P', unit: '個', required: { basis: 'counted', value: 5 }, dueDate: null, source: '架空', revision: '初版' });
    const detail = caseDetailOf(ledger, supply, 'A-001');
    expect(detail.groups).toHaveLength(1);
    expect(groupOf(detail).unused).toHaveLength(1);
    expect(groupOf(detail).unused[0]).toContain('P-target');
    expect(groupOf(detail).unused[0]).toContain('記録上の数5個');
    expect(caseDetailText(detail)).not.toContain('P-source');
  });

  test('現物も供給もなく中断だけある群を不足品目Pで作り、中断の1個を必要・依頼・影響へ転記しない', () => {
    const ledger = stopOnly();
    const detail = caseDetailOf(ledger, emptySupply, 'A-001');
    expect(detail.groups.map((g) => [g.item, g.unit])).toEqual([['P', '個']]);
    const p = groupOf(detail);
    expect(p.need).toContain('未登録');
    expect(p.shortage).toContain('判定不能：必要な数が未登録');
    expect(p.outstanding).toContain('依頼済み 0個／依頼の未着 0個');
    expect(p.unused).toEqual([]);
    expect(p.working).toEqual([]);
    expect(p.completed).toEqual([]);
    expect(p.stops).toHaveLength(1);
    expect(p.stops[0]).toContain('中断 stop');
    expect(p.stops[0]).toContain('品目R（台）');
    expect(p.stops[0]).toContain('不足 品目P 1個');
    expect(p.stops[0]).toContain('影響数不明');
  });

  test('再開済みの中断だけだった群は消える', () => {
    const ledger = resumeWork(stopOnly(), meta('resume', '12:30'), 'stop');
    expect(caseDetailOf(ledger, emptySupply, 'A-001').groups).toEqual([]);
  });

  test.each([
    { project: { kind: 'case', id: 'A-002' }, shortage: true },
    { project: { kind: 'common' }, shortage: true },
    { project: { kind: 'unassigned' }, shortage: true },
    { project: a001, shortage: false },
  ] satisfies { project: Project; shortage: boolean }[])('別所属・不足品目なしの中断は選択案件・用途の群を作らない：$project.kind/$shortage', ({ project, shortage }) => {
    expect(caseDetailOf(stopOnly(project, '個', shortage), emptySupply, 'A-001').groups).toEqual([]);
  });

  test('中断の不足単位が箱ならPの箱の群だけに置き、現物の個数の群へ混ぜない', () => {
    const ledger = register(stopOnly(a001, '箱'), meta('lot'), lotOf('P-pieces'), 'counted', 3);
    const detail = caseDetailOf(ledger, emptySupply, 'A-001');
    expect(detail.groups).toHaveLength(2);
    expect(groupOf(detail, 'P', '個').stops).toEqual([]);
    expect(groupOf(detail, 'P', '箱').stops.join('\n')).toContain('不足 品目P 1箱');
    expect(groupOf(detail, 'P', '箱').unused).toEqual([]);
  });

  test('取消した依頼のIDと理由を残し、依頼済み・未着を取消前の数へ戻さない', () => {
    const supply = cancelRequest(recordRequest(emptySupply, fixedMasters, meta('request'), { project: a001, item: 'P', unit: '個', quantity: 5, vendor: '架空仕入先', requestedOn: '2026-09-29', reply: { kind: 'none' } }), fixedMasters, meta('cancel', '12:30'), 'request', '架空の取消理由');
    const p = groupOf(caseDetailOf(practiceLedger, supply, 'A-001'));
    expect(p.outstanding).toContain('依頼済み 0個／依頼の未着 0個');
    expect(p.outstanding).toContain('依頼 request：取消済み（理由「架空の取消理由」）');
    expect(p.stops).toEqual([]);
  });
});
