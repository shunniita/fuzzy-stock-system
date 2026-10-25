import { fixedMasters } from '../../src/domain/masters.ts';
import { describe, expect, test } from 'vitest';
import { practiceLedger, hold, recount, register, resolveIssue, split, use, voidRecord, type Ledger, type Meta, type Project } from '../../src/domain/ledger.ts';
import { declareShortage, emptySupply, registerNeed, type Supply } from '../../src/domain/supply.ts';
import { groupsOf, shortageOf, type GroupKey, type ShortageView } from '../../src/domain/shortage.ts';

const b001: Project & { kind: 'case' } = { kind: 'case', id: 'B-001' };
const a001: Project = { kind: 'case', id: 'A-001' };
const key: GroupKey = { project: b001, item: 'P', unit: '個' };

function meta(eventId: string, hour = 9): Meta {
  const at = `2026-10-02T${String(hour).padStart(2, '0')}:00:00+09:00`;
  return { eventId, occurredAt: at, recordedAt: at, actor: '架空担当A' };
}

const lotOf = (id: string, project: Project = b001, unit = '個', item = 'P') => ({ id, item, unit, project, location: 'S1' });

const needOf = (value: number | null = 100, basis: 'counted' | 'approximate' | 'label' | 'unknown' = 'counted'): Supply =>
  registerNeed(emptySupply, fixedMasters, meta('n1', 7), { project: b001, item: 'P', unit: '個', required: { basis, value }, dueDate: '2026-10-10', source: '架空の必要部品一覧', revision: '初版' });

const view = (ledger: Ledger, supply: Supply, k: GroupKey = key): ShortageView => shortageOf(ledger, supply, k);

describe('要件2 不足候補', () => {
  test('AT-09・2.1・2.3: 必要100を受け取りし、未使用のうち2個が不良。在庫100・使用可能98・不足2（不足4にしない）', () => {
    let l = register(practiceLedger, meta('r1', 8), lotOf('L1'), 'counted', 100);
    l = split(l, meta('s1', 9), 'L1', 'L1-bad', 'counted', 2);
    l = hold(l, meta('h1', 9), 'L1-bad', 'defective');
    const v = view(l, needOf());
    expect(v.judgement).toEqual({ kind: 'ledger' });
    expect(v.shortage).toBe(2);
    expect(v.aux).toEqual({ required: 100, used: 0, usable: 98, onHand: 100 });
    expect(v.shortfall).toBe(0);
    expect(v.excluded).toHaveLength(1);
    expect(v.excluded[0]).toMatchObject({ reasons: ['defective'] });
  });

  test('AT-08・2.2: 総必要100のうち30個が使用済み、未使用良品70。残り必要70と比べて不足0（30個を再要求しない）', () => {
    let l = register(practiceLedger, meta('r1', 8), lotOf('L1'), 'counted', 100);
    l = use(l, meta('u1', 9), 'L1', 'counted', 30, 'B-001 作業');
    const v = view(l, needOf());
    expect(v.shortage).toBe(0);
    expect(v.aux).toMatchObject({ required: 100, used: 30, usable: 70 });
  });

  test('AT-08・2.2: 数え直しに含まれていた後入力の使用（applied=false）も使用済みに数える。数えないと不足0が30になる', () => {
    let l = register(practiceLedger, meta('r1', 8), lotOf('L1'), 'counted', 100);
    l = recount(l, meta('c1', 10), 'L1', 70, { kind: 'unknown' });
    l = use(l, meta('u1', 9), 'L1', 'counted', 30, 'B-001 作業', 'included');
    expect(l.history.find((e) => e.eventId === 'u1')).toMatchObject({ kind: 'use', applied: false });
    const v = view(l, needOf());
    expect(v.aux).toMatchObject({ used: 30, usable: 70 });
    expect(v.shortage).toBe(0);
    expect(v.judgement).toEqual({ kind: 'ledger' });
  });

  test('2.2: 保留後に「適用」で解消した使用・「閉じる」で解消した使用も使用済みに数える。未解決の間は判定不能（openIssue）', () => {
    let l = register(practiceLedger, meta('r1', 8), lotOf('L1'), 'counted', 100);
    l = recount(l, meta('c1', 10), 'L1', 100, { kind: 'unknown' });
    l = use(l, meta('u1', 9), 'L1', 'counted', 30, 'B-001 作業', 'unknown');
    expect(view(l, needOf()).judgement).toEqual({ kind: 'undecidable', reasons: ['openIssue'] });
    const applied = resolveIssue(l, meta('x1', 12), 'u1', 'apply', 'notIncluded');
    expect(view(applied, needOf())).toMatchObject({ shortage: 0, judgement: { kind: 'ledger' }, aux: { used: 30, usable: 70 } });
    let closed = recount(l, meta('c2', 11), 'L1', 70, { kind: 'unknown' }, 'included');
    closed = resolveIssue(closed, meta('x2', 12), 'u1', 'close');
    expect(view(closed, needOf())).toMatchObject({ shortage: 0, judgement: { kind: 'ledger' }, aux: { used: 30, usable: 70 } });
  });

  test('2.2: 取り消した使用は起きなかったものとして数えない', () => {
    let l = register(practiceLedger, meta('r1', 8), lotOf('L1'), 'counted', 100);
    l = use(l, meta('u1', 9), 'L1', 'counted', 30, 'B-001 作業');
    l = voidRecord(l, meta('v1', 10), 'u1', '誤って記録した');
    const v = view(l, needOf());
    expect(v.aux).toMatchObject({ used: 0, usable: 100 });
    expect(v.shortage).toBe(0);
  });

  test('SCN-02: ラベル100を実数98に訂正して不足2（数量不足2）、3個の不良を隔離して不足5（数量不足2・不良3）', () => {
    let l = register(practiceLedger, meta('r1', 8), lotOf('L1'), 'label', 100);
    l = recount(l, meta('c1', 9), 'L1', 98, { kind: 'unknown' });
    let v = view(l, needOf());
    expect(v).toMatchObject({ shortage: 2, shortfall: 2, judgement: { kind: 'ledger' } });
    expect(v.excluded).toEqual([]);
    l = split(l, meta('s1', 10), 'L1', 'L1-bad', 'counted', 3);
    l = hold(l, meta('h1', 10), 'L1-bad', 'defective');
    v = view(l, needOf());
    expect(v).toMatchObject({ shortage: 5, shortfall: 2, aux: { usable: 95, onHand: 98 } });
    expect(v.excluded).toHaveLength(1);
    expect(v.excluded[0]).toMatchObject({ reasons: ['defective'] });
  });

  test('2.6: 別の案件・用途・共通・所属不明の現物は、ある案件・用途の使用可能数・使用実績に数えない', () => {
    let l = register(practiceLedger, meta('r1', 8), lotOf('L1'), 'counted', 50);
    l = register(l, meta('r2', 8), lotOf('L2', a001), 'counted', 100);
    l = register(l, meta('r3', 8), lotOf('L3', { kind: 'common' }), 'counted', 100);
    l = register(l, meta('r4', 8), lotOf('L4', { kind: 'unassigned' }), 'counted', 100);
    l = use(l, meta('u1', 9), 'L2', 'counted', 20, 'A-001 作業');
    const v = view(l, needOf());
    expect(v).toMatchObject({ shortage: 50, aux: { used: 0, usable: 50 } });
  });

  test('2.8: 単位の違う保管単位を足さない。群は品目・単位ごと', () => {
    let l = register(practiceLedger, meta('r1', 8), lotOf('L1'), 'counted', 50);
    l = register(l, meta('r2', 8), lotOf('L2', b001, '箱'), 'counted', 99);
    expect(view(l, needOf()).aux.onHand).toBe(50);
    expect(view(l, needOf(), { ...key, unit: '箱' }).aux.onHand).toBe(99);
  });

  test('2.3: 予備・返却待ち・使用可否確認待ちは使用可能数に数えない。重なる理由の保管単位は除外に一度だけ数える', () => {
    let l = register(practiceLedger, meta('r1', 8), lotOf('L1'), 'counted', 100);
    l = split(l, meta('s1', 9), 'L1', 'L1-spare', 'counted', 2);
    l = hold(l, meta('h1', 9), 'L1-spare', 'spare');
    l = split(l, meta('s2', 9), 'L1', 'L1-ret', 'counted', 4);
    l = hold(l, meta('h2', 9), 'L1-ret', 'returnPending');
    l = hold(l, meta('h3', 9), 'L1-ret', 'defective');
    const v = view(l, needOf());
    expect(v.aux).toMatchObject({ usable: 94, onHand: 100 });
    expect(v.shortage).toBe(6);
    const total = v.excluded.reduce((n, e) => n + (e.quantity.kind === 'known' ? e.quantity.numeric.value : 0), 0);
    expect(total).toBe(6);
    expect(v.excluded.some((e) => e.reasons.includes('returnPending') && e.reasons.includes('defective'))).toBe(true);
  });
});

describe('要件2 判定', () => {
  test('AT-07・2.4: 必要100に対して在庫が約100は、不足なしと断定せず「数量確認が必要」（だいたい上の差は補助）', () => {
    const l = register(practiceLedger, meta('r1', 8), lotOf('L1'), 'approximate', 100);
    const v = view(l, needOf());
    expect(v.judgement).toEqual({ kind: 'confirm', approximate: true, unconfirmed: false });
    expect(v.shortage).toBe(0);
  });

  test('2.4: 在庫がラベル100は、台帳上の不足が0でも「中身未確認」', () => {
    const l = register(practiceLedger, meta('r1', 8), lotOf('L1'), 'label', 100);
    expect(view(l, needOf()).judgement).toEqual({ kind: 'confirm', approximate: false, unconfirmed: true });
  });

  test('2.4: 必要な数がだいたいなら、その根拠も判定に引き継ぐ', () => {
    const l = register(practiceLedger, meta('r1', 8), lotOf('L1'), 'counted', 100);
    expect(view(l, needOf(100, 'approximate')).judgement).toEqual({ kind: 'confirm', approximate: true, unconfirmed: false });
  });

  test('2.4・1.5: 必要な数が不明なら判定不能（needUnknown）。値は出さず、分かる部分は補助に残す', () => {
    const l = register(practiceLedger, meta('r1', 8), lotOf('L1'), 'counted', 100);
    const v = view(l, needOf(null, 'unknown'));
    expect(v.judgement).toEqual({ kind: 'undecidable', reasons: ['needUnknown'] });
    expect(v.shortage).toBeNull();
    expect(v.shortfall).toBeNull();
    expect(v.aux).toMatchObject({ required: null, usable: 100, onHand: 100 });
  });

  test('2.4: 必要な数が未登録なら判定不能（noNeed）。2.5: 使用実績が不明、在庫が不明でも判定不能で、理由を列挙する', () => {
    const l0 = register(practiceLedger, meta('r1', 8), lotOf('L1'), 'counted', 100);
    expect(view(l0, emptySupply).judgement).toEqual({ kind: 'undecidable', reasons: ['noNeed'] });
    const l1 = use(l0, meta('u1', 9), 'L1', 'unknown', null, 'B-001 作業');
    expect(view(l1, needOf()).judgement).toEqual({ kind: 'undecidable', reasons: ['usedUnknown', 'onHandUnknown'] });
    const l2 = register(practiceLedger, meta('r2', 8), lotOf('L2'), 'unknown', null);
    expect(view(l2, needOf()).judgement).toEqual({ kind: 'undecidable', reasons: ['onHandUnknown'] });
  });

  test('2.4: 数量に影響する未解決の確認事項（負数で保留した使用など）があれば判定不能（openIssue）。無関係な案件・用途の事項は影響しない', () => {
    let l = register(practiceLedger, meta('r1', 8), lotOf('L1'), 'counted', 10);
    l = register(l, meta('r2', 8), lotOf('L2', a001), 'counted', 10);
    l = use(l, meta('u1', 9), 'L1', 'counted', 50, 'B-001 作業');
    expect(l.issues['u1']?.resolution).toBeNull();
    expect(view(l, needOf()).judgement).toEqual({ kind: 'undecidable', reasons: ['openIssue'] });
    const other = registerNeed(emptySupply, fixedMasters, meta('n2', 7), { project: a001 as Project & { kind: 'case' }, item: 'P', unit: '個', required: { basis: 'counted', value: 100 }, dueDate: null, source: '架空', revision: '初版' });
    expect(view(l, other, { project: a001, item: 'P', unit: '個' }).judgement).toEqual({ kind: 'ledger' });
  });

  test('12.4: ある案件・用途に不足・判定不能があっても、別の案件・用途の計算は独立している', () => {
    let l = register(practiceLedger, meta('r1', 8), lotOf('L1', a001), 'counted', 100);
    l = register(l, meta('r2', 8), lotOf('L2'), 'unknown', null);
    expect(view(l, needOf()).judgement.kind).toBe('undecidable');
    const s = registerNeed(needOf(), fixedMasters, meta('n2', 7), { project: a001 as Project & { kind: 'case' }, item: 'P', unit: '個', required: { basis: 'counted', value: 100 }, dueDate: null, source: '架空', revision: '初版' });
    expect(view(l, s, { project: a001, item: 'P', unit: '個' })).toMatchObject({ judgement: { kind: 'ledger' }, shortage: 0 });
  });

  test('2.1: 使用済みが必要な数を超えても、不足は0未満にならない', () => {
    let l = register(practiceLedger, meta('r1', 8), lotOf('L1'), 'counted', 200);
    l = use(l, meta('u1', 9), 'L1', 'counted', 150, 'B-001 作業');
    const v = view(l, needOf());
    expect(v.shortage).toBe(0);
    expect(v.shortfall).toBe(0);
  });
});

describe('要件10 予備', () => {
  test('10.3: 予備で賄える数は、予備の数値部分と不足の小さいほう。予備は使用可能に入らないので不足は減らない', () => {
    let l = register(practiceLedger, meta('r1', 8), lotOf('L1'), 'counted', 100);
    l = split(l, meta('s1', 9), 'L1', 'L1-bad', 'counted', 5);
    l = hold(l, meta('h1', 9), 'L1-bad', 'defective');
    l = split(l, meta('s2', 9), 'L1', 'L1-spare', 'counted', 2);
    l = hold(l, meta('h2', 9), 'L1-spare', 'spare');
    const v = view(l, needOf());
    expect(v.shortage).toBe(7);
    expect(v.spareCover).toBe(2);
    expect(v.spare).toMatchObject({ kind: 'known', numeric: { value: 2 } });
  });

  test('10.3: 予備がなければ0。予備が不足より多ければ不足まで。不足が判定不能、予備の数量が不明なら null', () => {
    const l0 = register(practiceLedger, meta('r1', 8), lotOf('L1'), 'counted', 98);
    expect(view(l0, needOf()).spareCover).toBe(0);
    let l = register(practiceLedger, meta('r1', 8), lotOf('L1'), 'counted', 98);
    l = register(l, meta('r2', 8), lotOf('L2'), 'counted', 10);
    l = hold(l, meta('h1', 9), 'L2', 'spare');
    expect(view(l, needOf()).spareCover).toBe(2);
    expect(view(l, needOf(null, 'unknown')).spareCover).toBeNull();
    let u = register(practiceLedger, meta('r1', 8), lotOf('L1'), 'counted', 98);
    u = register(u, meta('r2', 8), lotOf('L2'), 'unknown', null);
    u = hold(u, meta('h1', 9), 'L2', 'spare');
    expect(view(u, needOf()).spareCover).toBeNull();
  });

  test('12.3・10.3: 予備の数量は表示の数（ラベル・パッケージ）・だいたいの根拠を持ち、確定した数として扱わない', () => {
    let l = register(practiceLedger, meta('r1', 8), lotOf('L1'), 'counted', 95);
    l = register(l, meta('r2', 8), lotOf('L2'), 'label', 5);
    l = hold(l, meta('h1', 9), 'L2', 'spare');
    const v = view(l, needOf());
    expect(v.spareCover).toBe(5);
    expect(v.spare).toMatchObject({ kind: 'known', numeric: { value: 5, unconfirmed: 'all' } });
  });

  test('取り分けた理由が予備だけでないもの（不良でもある予備）は、予備で賄える数に入れない', () => {
    let l = register(practiceLedger, meta('r1', 8), lotOf('L1'), 'counted', 95);
    l = register(l, meta('r2', 8), lotOf('L2'), 'counted', 5);
    l = hold(l, meta('h1', 9), 'L2', 'spare');
    l = hold(l, meta('h2', 9), 'L2', 'defective');
    expect(view(l, needOf()).spareCover).toBe(0);
  });
});

describe('群', () => {
  test('1.3: 必要明細だけで受け取り・申告のない群、申告だけの群、依頼だけの群も一覧に出る。重複しない', () => {
    let s = needOf();
    s = declareShortage(s, fixedMasters, meta('d1', 8), { project: b001, item: 'P', unit: '個', value: 5, reason: '足りない' });
    s = declareShortage(s, fixedMasters, meta('d2', 8), { project: { kind: 'common' }, item: 'S', unit: '本', value: null, reason: '不足' });
    const keys = groupsOf(practiceLedger, s).map((k) => `${k.project.kind === 'case' ? k.project.id : k.project.kind}/${k.item}/${k.unit}`);
    expect(keys.sort()).toEqual(['B-001/P/個', 'common/S/本']);
  });

  test('1.3: 受け取り実績のない必要品目は、在庫0と区別できる（在庫は0個、判定は帳簿上の不足）', () => {
    const v = view(practiceLedger, needOf());
    expect(v).toMatchObject({ shortage: 100, shortfall: 100, aux: { onHand: 0, usable: 0 }, judgement: { kind: 'ledger' } });
  });
});
