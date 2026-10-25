import { positivePartMinus, sumScalars, sumScalarsFinal } from '../../src/domain/scalar.ts';
import { describe, expect, test } from 'vitest';
import { add, observe, quantityOf, subtract, type Basis, type Quantity } from '../../src/domain/quantity.ts';
import { adoptProvisional, beginRework, changeMasters, changeStage, practiceLedger, handOver, hold, merge, productionOf, recount, recordProvisional, recordReworkPart, recordStop, register, resolveIssue, split, start, stopExcessOf, totalOf, transferProject, updateStop, use, validateReworkLinks, voidRecord, type Ledger, type Lot, type Meta } from '../../src/domain/ledger.ts';
import { allocateArrival, allocatedToReceipt, cancelRequest, declareShortage, linkDeclaration, emptySupply, receiveLot, receivedFromRemaining, recordRequest, registerNeed, requestProgressOf, reviseArrival, reviseNeed, reviseReceipt, type Supply } from '../../src/domain/supply.ts';
import { dateStatusOf, requestSummaryOf, requireQuantityTotals, shortageOf } from '../../src/domain/shortage.ts';
import { applyNeedImport, openNeedImports, previewNeedImport, previewNeedImportResolution, resolveNeedImport, validateNeedImports } from '../../src/domain/need-import.ts';
import { inputStepOf, type Masters } from '../../src/domain/masters.ts';
import { caseDetailOf } from '../../src/ui/caseview.ts';
import { totalsOf } from '../../src/ui/format.ts';
import { commit, confirmedUnreadableReset, initial, parse, replace, retry, serialize, serializePending, type Pending, type StoreLike } from '../../src/ui/storage.ts';
import { fixedMasters } from '../../src/domain/masters.ts';
import { captureItemLabels } from '../../src/domain/history-labels.ts';

const meta = (id: string, minute = 10): Meta => ({ eventId: id, occurredAt: `2026-10-14T10:${String(minute).padStart(2, '0')}:00+09:00`, recordedAt: '2026-10-14T12:00:00+09:00', actor: '架空担当A' });
const project = { kind: 'case', id: 'A-001' } as const;
const process = { id: '架空工程', criterion: 'workEnd' } as const;
const lot = (id: string, unit = 'kg') => ({ id, item: 'D', unit, project, location: 'T' });
function base(): Ledger {
  return changeMasters(practiceLedger, meta('master', 0), { action: 'register', master: { type: 'item', code: 'D', name: '架空小数材料', source: null, units: ['kg', '個'], unitSteps: { kg: 0.1, 個: 1 }, trial: true } });
}
const quantity = (id: string, value: number | null, basis: Basis = 'counted'): Quantity => quantityOf(observe(id, basis, value, 0.1));
const numeric = (q: Quantity | undefined): number | null => q === undefined || q.kind === 'unknown' ? null : q.numeric?.value ?? null;
function unchanged(ledger: Ledger, attempt: () => unknown): void {
  const before = JSON.stringify(ledger); expect(() => attempt()).toThrow(); expect(JSON.stringify(ledger)).toBe(before);
}

describe('Task3: 精度付きQuantity演算と根拠', () => {
  test('0.1+0.2=0.3、1-0.9=0.1と元観測・符号を保つ', () => {
    const first = quantity('a', 0.1), second = quantity('b', 0.2);
    expect(numeric(add(first, second, 0.1))).toBe(0.3);
    const result = subtract(quantity('one', 1), quantity('nine', 0.9), 0.1);
    expect(numeric(result)).toBe(0.1); expect(result.terms).toEqual([{ sign: 1, observation: { id: 'one', basis: 'counted', value: 1 } }, { sign: -1, observation: { id: 'nine', basis: 'counted', value: 0.9 } }]);
    expect(numeric(subtract(first, second, 0.1))).toBe(-0.1);
  });
  test.each(['label', 'approximate', 'unknown'] as const)('根拠%sを小数でも0や実数へ変換しない', basis => {
    const source = quantity('basis', basis === 'unknown' ? null : 0.1, basis), counted = quantity('count', 0.2);
    const added = add(source, counted, 0.1), removed = subtract(counted, source, 0.1);
    expect(added.terms[0]?.observation.basis).toBe(basis);
    if (basis === 'unknown') { expect(added).toMatchObject({ kind: 'partlyUnknown', numeric: { value: 0.2 }, unknownParts: [{ kind: 'unknown' }] }); expect(removed).toMatchObject({ kind: 'unknown', before: counted }); }
    if (basis === 'label') expect(removed).toMatchObject({ numeric: { value: 0.1, unconfirmed: 'partial' } });
    if (basis === 'approximate') expect(removed).toMatchObject({ numeric: { value: 0.1, approximate: true } });
  });
  test('既定精度1と小数精度の上限・桁・非有限を別々に拒否する', () => {
    expect(() => observe('i', 'counted', 0.1)).toThrow();
    for (const value of [0.05, 0.1 + 0.2, NaN, Infinity, -0.1, 562949953421312]) expect(() => observe('d', 'counted', value, 0.1)).toThrow();
    const max = quantity('max', 562949953421311.9);
    expect(numeric(subtract(max, quantity('small', 0.1), 0.1))).toBe(562949953421311.8);
    expect(() => add(max, quantity('small', 0.1), 0.1)).toThrow();
    expect(() => add(quantity('d', 0.1), quantity('i', 1))).toThrow();
    expect(numeric(add(quantityOf(observe('max', 'counted', Number.MAX_SAFE_INTEGER)), quantityOf(observe('zero', 'counted', 0)), 1))).toBe(Number.MAX_SAFE_INTEGER);
  });
  test('不明を含む分岐でも数値部分の桁を検査し元参照を保持', () => {
    const known = quantity('d', 0.1), unknown = quantity('u', null, 'unknown');
    expect(() => add(known, unknown, 1)).toThrow(); expect(() => subtract(unknown, known, 1)).toThrow();
    expect(add(known, unknown, 0.1)).toMatchObject({ kind: 'partlyUnknown', numeric: { value: 0.1 } });
    expect(subtract(known, unknown, 0.1)).toMatchObject({ kind: 'unknown', before: known });
  });
});

describe('Task3: 台帳単位精度の伝播', () => {
  test('登録・使用・引渡し・取消と合計は正確で、三件以上のreduceに添字が混ざらない', () => {
    let l = register(base(), meta('r', 1), lot('x'), 'counted', 1);
    l = use(l, meta('u', 2), 'x', 'counted', 0.9, '架空使用'); expect(numeric(l.lots.x?.quantity)).toBe(0.1);
    l = voidRecord(l, meta('v', 3), 'u', '誤入力'); expect(numeric(l.lots.x?.quantity)).toBe(1);
    l = handOver(l, meta('out', 4), 'x', 'counted', 0.2, '架空相手'); expect(numeric(l.lots.x?.quantity)).toBe(0.8);
    l = register(l, meta('r2', 5), lot('y'), 'counted', 0.1); l = register(l, meta('r3', 6), lot('z'), 'counted', 0.2);
    expect(numeric(totalOf(l, 'D'))).toBe(1.1);
  });
  test('分割・統合・案件・用途振替で総数と単位を保つ', () => {
    let l = register(base(), meta('r', 1), lot('x'), 'label', 1);
    l = split(l, meta('s', 2), 'x', 'y', 'label', 0.3); expect(numeric(l.lots.x?.quantity)).toBe(0.7);
    l = merge(l, meta('m', 3), 'y', 'x'); expect(numeric(l.lots.x?.quantity)).toBe(1);
    l = transferProject(l, meta('t', 4), 'x', 'b', { kind: 'case', id: 'A-002' }, 'counted', 0.1);
    expect(numeric(l.lots.x?.quantity)).toBe(0.9); expect(numeric(totalOf(l, 'D'))).toBe(1);
  });
  test('数が不明と保留の適用は根拠を残し、負数を0へ丸めない', () => {
    let l = register(base(), meta('r', 1), lot('x'), 'counted', 0.1);
    l = use(l, meta('over', 2), 'x', 'counted', 0.2, '架空使用'); expect(numeric(l.lots.x?.quantity)).toBe(0.1); expect(l.issues.over).toBeDefined();
    l = recount(l, meta('count', 3), 'x', 0.3, { kind: 'unknown' }, 'notIncluded');
    l = resolveIssue(l, meta('resolve', 4), 'over', 'apply', 'notIncluded'); expect(numeric(l.lots.x?.quantity)).toBe(0.1);
    l = use(l, meta('unknown', 5), 'x', 'unknown', null, '使用量不明'); expect(l.lots.x?.quantity).toMatchObject({ kind: 'unknown', before: { numeric: { value: 0.1 } } });
  });
  test('取消再構築はだいたいの誤入力を除き、統合元も小数精度で戻す', () => {
    let l = register(base(), meta('r', 1), lot('x'), 'counted', 1);
    l = use(l, meta('bad', 2), 'x', 'approximate', 0.2, '誤入力');
    l = register(l, meta('r2', 3), lot('y'), 'counted', 0.1); l = merge(l, meta('merge', 4), 'x', 'y');
    l = use(l, meta('good', 5), 'y', 'counted', 0.3, '使用'); l = voidRecord(l, meta('void', 6), 'bad', '誤り');
    expect(l.lots.y?.quantity).toMatchObject({ numeric: { value: 0.8, approximate: false } });
  });
  test('中断の過去時点逆算・更新を正確に計算し、工程履歴を単位別に合計', () => {
    let l = start(base(), meta('start', 1), lot('w'), process, 'counted', 0.3, []);
    l = changeStage(l, meta('complete', 3), 'w', 'f', 'counted', 0.1, { kind: 'awaitingHandover', process });
    l = recordStop(l, meta('stop', 2), { process: process.id, item: 'D', unit: 'kg', project, reason: '架空停止', affected: 0.3, shortage: { item: 'D', unit: 'kg', value: 0.1 } });
    expect(stopExcessOf(l, l.stops.stop!)).toEqual({ affected: 0.3, total: 0.2 });
    l = updateStop(l, meta('update', 4), 'stop', 0.1);
    expect(productionOf(l, process.id, 'D', 'kg', project)).toMatchObject({ working: { numeric: { value: 0.2 } }, completed: { numeric: { value: 0.1 } } });
    unchanged(l, () => updateStop(l, meta('invalid', 5), 'stop', 0.05));
  });
  test('やり直し・修理元20→18+2と小数材料の交換・回収・廃棄を各材料精度で扱う', () => {
    let l = register(base(), meta('parts', 1), lot('parts'), 'counted', 1);
    l = start(l, meta('start', 2), { ...lot('w', '個') }, process, 'counted', 20, []);
    l = changeStage(l, meta('complete', 3), 'w', 'f', 'counted', 20, { kind: 'awaitingHandover', process });
    l = beginRework(l, meta('rw', 4), 'f', 'repair', 'counted', 2, '修理');
    l = recordReworkPart(l, meta('replace', 5), { action: 'replace', reworkId: 'rw', subjectLotId: 'repair', lotId: 'parts', value: 0.1, reason: '交換' });
    expect(numeric(l.lots.parts?.quantity)).toBe(0.9);
    l = recordReworkPart(l, meta('recover', 6), { action: 'recover', reworkId: 'rw', subjectLotId: 'repair', lotId: 'kept', item: 'D', unit: 'kg', location: 'T', value: 0.2, reason: '回収' });
    expect(l.lots.kept?.holds).toContain('usabilityCheck'); expect(numeric(l.lots.kept?.quantity)).toBe(0.2);
    l = recordReworkPart(l, meta('discard', 7), { action: 'discard', reworkId: 'rw', subjectLotId: 'repair', item: 'D', unit: 'kg', value: 0.1, reason: '廃棄' });
    expect(numeric(totalOf(l, 'D', x => x.unit === '個'))).toBe(20); expect(() => validateReworkLinks(l)).not.toThrow();
  });
  test('小数製品のやり直し・修理・再完了履歴・部署総数を保つ', () => {
    let l = start(base(), meta('start', 1), lot('w'), process, 'counted', 0.3, []);
    l = changeStage(l, meta('complete', 2), 'w', 'f', 'counted', 0.3, { kind: 'awaitingHandover', process });
    l = beginRework(l, meta('rw', 3), 'f', 'repair', 'counted', 0.1, 'やり直し・修理');
    l = changeStage(l, meta('done', 4), 'repair', 'done', 'counted', 0.1, { kind: 'awaitingHandover', process });
    expect(numeric(totalOf(l, 'D'))).toBe(0.3); expect(productionOf(l, process.id, 'D', 'kg', project)).toMatchObject({ completed: { numeric: { value: 0.4 } }, reworkStarted: { numeric: { value: 0.1 } } });
    expect(() => validateReworkLinks(l)).not.toThrow();
  });
  test('単位混在・整数単位の小数・上限・桁不正を履歴ごと無変更拒否', () => {
    let l = register(base(), meta('r', 1), lot('x'), 'counted', 562949953421311.9);
    l = register(l, meta('r2', 2), lot('y'), 'counted', 0.1);
    unchanged(l, () => merge(l, meta('overflow', 3), 'y', 'x'));
    for (const value of [0.05, 0.1 + 0.2, Infinity, NaN]) unchanged(l, () => use(l, meta('bad', 3), 'x', 'counted', value, '使用'));
    unchanged(l, () => register(l, meta('wrong-unit', 3), lot('integer', '個'), 'counted', 0.1));
    const mixed = register(l, meta('integer', 3), lot('integer', '個'), 'counted', 1);
    unchanged(mixed, () => totalOf(mixed, 'D')); unchanged(mixed, () => merge(mixed, meta('mix', 4), 'integer', 'x'));
    unchanged(mixed, () => recordProvisional(mixed, meta('p', 4), { direction: 'found', item: 'D', location: 'T', basis: 'counted', value: 0.1, note: '単位なし' }));
  });
  test('時点補正は最終和を検査し、既存の逐次演算契約を変えない', () => {
    const max = Number.MAX_SAFE_INTEGER;
    expect(sumScalarsFinal([max, max, -max], 1)).toBe(max);
    expect(() => sumScalars([max, max, -max], 1)).toThrow();
    expect(() => sumScalarsFinal([max, 1], 1)).toThrow();
    expect(() => sumScalarsFinal([0.05, -0.05], 0.1)).toThrow();
  });
  test('0で打ち切る差は仮の値の上限を問わず、入力と結果だけを検査する', () => {
    const max = Number.MAX_SAFE_INTEGER;
    expect(positivePartMinus([1, max], [0], 1, 1)).toBe(max);
    expect(positivePartMinus([0], [max, 1], 0, 1)).toBe(0);
    expect(positivePartMinus([0.2, 0.1], [0], 0.1, 0.1)).toBe(0.2);
    expect(() => positivePartMinus([max, max], [0], 0, 1)).toThrow();
    expect(() => positivePartMinus([0.05], [0], 0, 0.1)).toThrow();
  });
  for (const lateStart of [false, true]) test.each([['個', Number.MAX_SAFE_INTEGER], ['kg', 562949953421311.9]] as const)(`中断逆算%sは有効な上限を記録順で拒否しない・後入力=${lateStart}`, (unit, max) => {
    let l = start(base(), meta('first', 1), lot('w1', unit), process, 'counted', max, []);
    l = changeStage(l, meta('complete', 3), 'w1', 'f1', 'counted', max, { kind: 'awaitingHandover', process });
    l = start(l, meta('second', lateStart ? 2 : 4), lot('w2', unit), process, 'counted', max, []);
    const stopped = recordStop(l, meta('past', lateStart ? 1 : 2), { process: process.id, item: 'D', unit, project, reason: '過去の停止', affected: max, shortage: null });
    expect(stopped.stops.past?.affected).toBe(max);
  });
  test('精度不明の単位と整数指定の小数拒否を区別する', () => {
    const l = base(), before = JSON.stringify(l);
    expect(() => register(l, meta('unknown', 1), lot('x', '未設定'), 'counted', 0.1)).toThrow('設定が不明');
    expect(() => register(l, meta('integer', 1), lot('x', '個'), 'counted', 0.1)).toThrow('最小単位1');
    expect(JSON.stringify(l)).toBe(before);
    expect(() => recordStop(l, meta('unknown-stop', 1), { process: process.id, item: 'D', unit: '未設定', project, reason: '停止', affected: 0.1, shortage: null })).toThrow('設定が不明');
  });
  test('単位なし仮の記録は整数のまま、対応付け後の取消fallbackも対象精度で戻す', () => {
    let l = recordProvisional(base(), meta('found', 1), { direction: 'found', item: 'D', location: 'T', basis: 'counted', value: 1, note: '仮記録' });
    l = adoptProvisional(l, meta('adopt', 2), 'found', lot('x'));
    l = use(l, meta('use', 3), 'x', 'counted', 0.9, '使用'); expect(numeric(l.lots.x?.quantity)).toBe(0.1);
    l = voidRecord(l, meta('void', 4), 'use', '誤り'); expect(numeric(l.lots.x?.quantity)).toBe(1);
  });
  test('停止affectedと不足材料は別の単位精度で検査する', () => {
    const l = start(base(), meta('start', 1), lot('w', '個'), process, 'counted', 2, []);
    const s = { process: process.id, item: 'D', unit: '個', project, reason: '架空停止', affected: 1, shortage: { item: 'D', unit: 'kg', value: 0.1 } };
    expect(recordStop(l, meta('stop', 2), s).stops.stop?.shortage?.value).toBe(0.1);
    unchanged(l, () => recordStop(l, meta('bad', 2), { ...s, affected: 0.1 }));
    unchanged(l, () => recordStop(l, meta('bad2', 2), { ...s, shortage: { ...s.shortage, unit: '個' } }));
  });
  test('小数台帳を保存/復号し、精度外の候補は保存しない', () => {
    const before = initial(base(), emptySupply), l = register(before.ledger, meta('r', 1), lot('x'), 'counted', 0.1);
    expect(parse(serialize(initial(l, emptySupply)))).toEqual(initial(l, emptySupply));
    const data = new Map([['fuzzy-stock/head', 'A'], ['fuzzy-stock/slot-A', serialize(before)]]);
    const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } } satisfies StoreLike;
    const op = { opId: 'op1', opLabel: '小数候補', fingerprint: 'f', values: {}, actor: '架空担当A', startedAt: meta('r').recordedAt, savingSince: meta('r').recordedAt };
    const original = [...data];
    const tampered = structuredClone(l); tampered.lots.x!.quantity = quantity('bad', 0.1); tampered.lots.x!.unit = '個';
    expect(commit(store, before, op, [{ conflictReviews: [], ledger: tampered, supply: emptySupply, targets: ['x'] }]).kind).toBe('failed'); expect([...data]).toEqual(original);
    const saved = commit(store, before, op, [{ conflictReviews: [], ledger: l, supply: emptySupply, targets: ['x'] }]);
    expect(saved.kind).toBe('saved'); expect(parse(data.get(`fuzzy-stock/slot-${data.get('fuzzy-stock/head')}`)!).ledger.lots.x?.quantity).toEqual(l.lots.x?.quantity);
  });
});

describe('Task4: 供給と不足の小数精度', () => {
  const key = { project, item: 'D', unit: 'kg' };
  const need = (value: number | null, basis: Basis = 'counted', unit = 'kg', item = 'D') => ({ project, item, unit, required: { basis, value }, dueDate: null, source: '架空必要一覧', revision: '初版' });
  const request = (quantity: number, unit = 'kg', item = 'D') => ({ project, item, unit, quantity, vendor: '架空仕入先', requestedOn: '2026-10-14', reply: { kind: 'none' } as const });
  const rejects = (supply: Supply, attempt: () => unknown, message?: string): void => {
    const before = JSON.stringify(supply);
    if (message === undefined) expect(() => attempt()).toThrow(); else expect(() => attempt()).toThrow(message);
    expect(JSON.stringify(supply)).toBe(before);
  };
  function received(value: number, basis: Basis = 'counted') {
    const l = base();
    const s = recordRequest(registerNeed(emptySupply, l.masters, meta('n', 1), need(1)), l.masters, meta('q', 2), request(0.5));
    return receiveLot(l, s, meta('rc', 3), lot('x'), basis, value);
  }

  test('必要1と使用可能な在庫0.9から不足0.1を示し、整数閾値で充足扱いにしない', () => {
    const l = register(base(), meta('r', 1), lot('x'), 'counted', 0.9);
    const view = shortageOf(l, registerNeed(emptySupply, l.masters, meta('n', 2), need(1)), key);
    expect(view.judgement).toEqual({ kind: 'ledger' });
    expect(view.shortage).toBe(0.1); expect(view.shortfall).toBe(0.1);
    expect(view.aux).toEqual({ required: 1, used: 0, usable: 0.9, onHand: 0.9 });
    const used = use(register(base(), meta('r', 1), lot('x'), 'counted', 1), meta('u', 2), 'x', 'counted', 0.3, '架空使用');
    expect(shortageOf(used, registerNeed(emptySupply, used.masters, meta('n', 3), need(1.1)), key)).toMatchObject({ shortage: 0.1, aux: { used: 0.3, usable: 0.7 } });
  });

  test('依頼0.3に到着0.2を充当すると未着0.1、手配対象数も正確に求める', () => {
    const l = base();
    const s0 = recordRequest(registerNeed(emptySupply, l.masters, meta('n', 1), need(1)), l.masters, meta('q', 2), request(0.3));
    const got = receiveLot(l, s0, meta('rc', 3), lot('x'), 'counted', 0.2);
    const s = allocateArrival(got.ledger, got.supply, meta('a', 4), 'q', { receiptLotId: 'x', arrived: 0.2, good: 0.2 });
    expect(requestProgressOf(got.ledger.masters, s.requests.q!)).toEqual({ arrived: 0.2, good: 0.2, outstanding: 0.1 });
    expect(requestSummaryOf(got.ledger, s, key)).toMatchObject({ ordered: 0.3, outstanding: 0.1, arrived: 0.2, goodApplied: 0.2, effectiveShortage: 0.8, toOrder: 0.7, possiblyUnneeded: [] });
    expect(dateStatusOf(s, got.ledger.masters, 'q', '2026-10-14')).toEqual({ noReply: true, overdue: false, lateForNeed: false });
  });

  test('割り当ての合計は実際に受け取った数まで、良品は届いた数まで。訂正だけ0を許す', () => {
    const { ledger: l, supply: s0 } = received(0.3);
    let s = allocateArrival(l, s0, meta('a1', 4), 'q', { receiptLotId: 'x', arrived: 0.2, good: 0.1 });
    rejects(s, () => allocateArrival(l, s, meta('a2', 5), 'q', { receiptLotId: 'x', arrived: 0.2, good: 0.2 }), '実際に受け取った数0.3を超える');
    rejects(s, () => allocateArrival(l, s, meta('a2', 5), 'q', { receiptLotId: 'x', arrived: 0.1, good: 0.2 }), '届いた数以下');
    rejects(s, () => allocateArrival(l, s, meta('a2', 5), 'q', { receiptLotId: 'x', arrived: 0, good: 0 }), '0より大きい');
    rejects(s, () => allocateArrival(l, s, meta('a2', 5), 'q', { receiptLotId: 'x', arrived: 0.05, good: 0 }));
    s = allocateArrival(l, s, meta('a2', 5), 'q', { receiptLotId: 'x', arrived: 0.1, good: 0.1 });
    expect(allocatedToReceipt(s, l.masters, 'x')).toBe(0.3);
    s = reviseArrival(l, s, meta('ra', 6), 'q', 'a1', { arrived: 0, good: 0 });
    expect(allocatedToReceipt(s, l.masters, 'x')).toBe(0.1);
    rejects(s, () => reviseArrival(l, s, meta('rb', 7), 'q', 'a1', { arrived: 0.3, good: 0 }), '実際に受け取った数0.3を超える');
    s = reviseArrival(l, s, meta('rb', 7), 'q', 'a1', { arrived: 0.2, good: 0.2 });
    expect(requestProgressOf(l.masters, s.requests.q!)).toEqual({ arrived: 0.3, good: 0.3, outstanding: 0.2 });
  });

  test('必要な数・在庫が不明なら小数品目でも判定不能のまま', () => {
    const l = register(base(), meta('r', 1), lot('x'), 'counted', 0.9);
    expect(shortageOf(l, registerNeed(emptySupply, l.masters, meta('n', 2), need(null, 'unknown')), key)).toMatchObject({ judgement: { kind: 'undecidable', reasons: ['needUnknown'] }, shortage: null, aux: { usable: 0.9 } });
    const unknown = register(l, meta('r2', 3), lot('y'), 'unknown', null);
    expect(shortageOf(unknown, registerNeed(emptySupply, l.masters, meta('n', 4), need(1)), key)).toMatchObject({ judgement: { kind: 'undecidable', reasons: ['onHandUnknown'] }, shortage: null });
  });

  test('未知品目の整数は数量境界で扱えるが履歴追記は未登録を拒否し、小数の設定不明・精度外も無変更で拒否する', () => {
    const m = base().masters;
    expect(inputStepOf(m, 'ZZ', '箱', 2)).toBe(1);
    rejects(emptySupply, () => registerNeed(emptySupply, m, meta('n', 1), need(2, 'counted', '箱', 'ZZ')), '登録情報にない');
    rejects(emptySupply, () => recordRequest(emptySupply, m, meta('q', 1), request(2, '箱', 'ZZ')), '登録情報にない');
    rejects(emptySupply, () => registerNeed(emptySupply, m, meta('n', 1), need(0.1, 'counted', '箱', 'ZZ')), '設定が不明');
    rejects(emptySupply, () => recordRequest(emptySupply, m, meta('q', 1), request(0.1, '箱', 'ZZ')), '設定が不明');
    rejects(emptySupply, () => declareShortage(emptySupply, m, meta('d', 1), { project, item: 'ZZ', unit: '箱', value: 0.1, reason: '架空不足' }), '設定が不明');
    rejects(emptySupply, () => registerNeed(emptySupply, m, meta('n', 1), need(0.1, 'counted', '個')), '最小単位1');
    rejects(emptySupply, () => recordRequest(emptySupply, m, meta('q', 1), request(0.1, '個')), '1以上の整数');
    rejects(emptySupply, () => registerNeed(emptySupply, m, meta('n', 1), need(0.05)), '最小単位0.1');
    rejects(emptySupply, () => recordRequest(emptySupply, m, meta('q', 1), request(0)), '0より大きい');
    rejects(emptySupply, () => recordRequest(emptySupply, m, meta('q', 1), request(562949953421312)));
    expect(recordRequest(emptySupply, m, meta('q', 1), request(562949953421311.9)).requests.q?.quantity).toBe(562949953421311.9);
  });

  test('申告・必要の訂正・実受け取りの訂正と逆算も対象単位の精度で扱う', () => {
    const m = base().masters;
    expect(declareShortage(emptySupply, m, meta('d', 1), { project, item: 'D', unit: 'kg', value: 0.1, reason: '架空不足' }).declarations.d?.value).toBe(0.1);
    const s = registerNeed(emptySupply, m, meta('n', 1), need(1));
    const change = { required: { basis: 'counted' as const, value: 1.1 }, dueDate: null, source: '架空必要一覧', revision: '改訂2' };
    expect(reviseNeed(s, m, meta('rn', 2), 'n', change).needs.n?.required.value).toBe(1.1);
    rejects(s, () => reviseNeed(s, m, meta('rn', 2), 'n', { ...change, required: { basis: 'counted', value: 1.05 } }));
    const { ledger: l, supply: got } = received(0.3);
    expect(reviseReceipt(l, got, meta('rr', 4), 'x', 0.4, '数え直し').receipts.x?.received).toBe(0.4);
    rejects(got, () => reviseReceipt(l, got, meta('rr', 4), 'x', 0.45, '数え直し'));
    const label = received(1, 'label'), usedUp = use(label.ledger, meta('u', 4), 'x', 'counted', 0.3, '架空使用');
    expect(receivedFromRemaining(usedUp, 'x', 0.6)).toBe(0.9);
  });

  test('架空必要明細JSONは原文と解決後の品目・単位の精度を検査し、手入力と同じ値を持つ', () => {
    const m = base().masters;
    const raw = (change: Record<string, unknown> = {}) => JSON.stringify({ format: 'fuzzy-stock-need-row', version: 1, source: '架空部品表001', line: '001', revision: '初版', previousRevision: null, caseCode: 'A-001', itemCode: 'D', unit: 'kg', required: { basis: 'counted', value: 0.1 }, dueDate: null, ...change });
    const preview = previewNeedImport(emptySupply, m, raw());
    expect(preview.decision.kind).toBe('create');
    const imported = applyNeedImport(emptySupply, m, meta('imp', 1), raw(), preview.token);
    expect(imported.needs.imp?.required).toEqual({ basis: 'counted', value: 0.1 });
    expect(shortageOf(base(), imported, key).shortage).toBe(0.1);
    rejects(emptySupply, () => previewNeedImport(emptySupply, m, raw({ unit: '個' })), '最小単位1');
    rejects(emptySupply, () => previewNeedImport(emptySupply, m, raw({ required: { basis: 'counted', value: 0.05 } })), '最小単位0.1');
    rejects(emptySupply, () => previewNeedImport(emptySupply, m, raw({ itemCode: 'ZZ' })), '小数の必要な数は取り込まない');
    rejects(emptySupply, () => previewNeedImport(emptySupply, m, raw().replace('"value":0.1', '"value":0.10000000000000001')), '最小単位0.1');
    expect(previewNeedImport(emptySupply, m, raw({ itemCode: 'ZZ', required: { basis: 'counted', value: 1 } })).decision.kind).toBe('hold');
  });

  test.each([['個', Number.MAX_SAFE_INTEGER, 1], ['kg', 562949953421311.9, 0.1]] as const)('上限%sの使用済みと在庫があっても途中値で手配集計を拒否しない', (unit, max, rest) => {
    let l = register(base(), meta('r', 1), lot('x', unit), 'counted', max);
    l = use(l, meta('u', 2), 'x', 'counted', max, '架空使用');
    l = register(l, meta('r2', 3), lot('y', unit), 'counted', rest);
    const s = registerNeed(emptySupply, l.masters, meta('n', 4), need(0, 'counted', unit));
    const groupKey = { project, item: 'D', unit };
    expect(shortageOf(l, s, groupKey)).toMatchObject({ shortage: 0, aux: { required: 0, used: max, usable: rest } });
    expect(requestSummaryOf(l, s, groupKey)).toMatchObject({ effectiveShortage: 0, toOrder: 0, outstanding: 0, possiblyUnneeded: [] });
  });

  const arrivedThen = (unit: string, required: number, quantity: number, leave: (l: Ledger) => Ledger) => {
    const l = base(), groupKey = { project, item: 'D', unit };
    const s0 = recordRequest(registerNeed(emptySupply, l.masters, meta('n', 1), need(required, 'counted', unit)), l.masters, meta('q', 2), request(quantity, unit));
    const got = receiveLot(l, s0, meta('rc', 3), lot('x', unit), 'counted', quantity);
    const s = allocateArrival(got.ledger, got.supply, meta('a', 4), 'q', { receiptLotId: 'x', arrived: quantity, good: quantity });
    const after = leave(got.ledger);
    return { view: shortageOf(after, s, groupKey), summary: requestSummaryOf(after, s, groupKey) };
  };
  test.each([['個', Number.MAX_SAFE_INTEGER, 1], ['kg', 562949953421311.9, 0.1]] as const)('上限%sの良品が予備へ移っても仮の不足で集計を拒否しない', (unit, max, required) => {
    const { view, summary } = arrivedThen(unit, required, max, (l) => hold(l, meta('spare', 5), 'x', 'spare'));
    expect(view.shortage).toBe(required);
    expect(summary).toMatchObject({ effectiveShortage: required, outstanding: 0, toOrder: required });
  });
  test.each([['個', Number.MAX_SAFE_INTEGER, 1], ['kg', 562949953421311.9, 0.1]] as const)('必要な数が上限%sで届いた良品を引き渡しても集計を拒否しない', (unit, max, good) => {
    const { view, summary } = arrivedThen(unit, max, good, (l) => handOver(l, meta('out', 5), 'x', 'counted', good, '架空相手'));
    expect(view).toMatchObject({ shortage: max, aux: { required: max, used: 0, usable: 0 } });
    expect(summary).toMatchObject({ effectiveShortage: max, outstanding: 0, toOrder: max });
  });

  test('申告の解消と自動の不足に使った良品を小数で正確に分ける', () => {
    const l = base(), m = l.masters;
    const declared = declareShortage(emptySupply, m, meta('d', 1), { project, item: 'D', unit: 'kg', value: 0.3, reason: '架空不足' });
    const requested = recordRequest(declared, m, meta('q', 2), request(0.5));
    const got = receiveLot(l, requested, meta('rc', 3), lot('x'), 'counted', 0.2);
    const s = allocateArrival(got.ledger, got.supply, meta('a', 4), 'q', { receiptLotId: 'x', arrived: 0.2, good: 0.2 });
    expect(requestSummaryOf(got.ledger, s, key)).toMatchObject({ effectiveShortage: 0.1, outstanding: 0.3, toOrder: 0, possiblyUnneeded: ['q'] });
    const withNeed = registerNeed(s, m, meta('n', 5), need(1));
    expect(requestSummaryOf(got.ledger, withNeed, key)).toMatchObject({ effectiveShortage: 1.1, toOrder: 0.8 });
  });

  test('保留した小数の取込は照合と履歴検査で品目・単位の精度を再検査する', () => {
    const m = base().masters;
    const integerKg: Masters = { ...m, items: { ...m.items, D: { ...m.items.D!, unitSteps: { kg: 1, 個: 1 } } } };
    const manual = registerNeed(emptySupply, m, meta('manual', 1), need(1));
    const raw = JSON.stringify({ format: 'fuzzy-stock-need-row', version: 1, source: '架空部品表001', line: '001', revision: '初版', previousRevision: null, caseCode: 'A-001', itemCode: 'D', unit: 'kg', required: { basis: 'counted', value: 0.1 }, dueDate: null });
    const held = applyNeedImport(manual, m, meta('imp', 2), raw, previewNeedImport(manual, m, raw).token);
    expect(openNeedImports(held).map((e) => e.eventId)).toEqual(['imp']);
    rejects(held, () => previewNeedImportResolution(held, integerKg, 'imp', 'apply', 'manual'), '最小単位1');
    const preview = previewNeedImportResolution(held, m, 'imp', 'apply', 'manual');
    const resolved = resolveNeedImport(held, m, meta('res', 3), 'imp', 'apply', 'manual', '架空照合', preview.token);
    expect(resolved.needs.manual?.required.value).toBe(0.1);
    expect(() => validateNeedImports(resolved, m)).not.toThrow();
    expect(() => validateNeedImports(resolved, integerKg)).toThrow('最小単位1');
  });

  test('案件・用途詳細の依頼行は依頼の進捗と同じ未着0.1を示す', () => {
    const l = base();
    const s0 = recordRequest(emptySupply, l.masters, meta('q', 2), request(0.3));
    const got = receiveLot(l, s0, meta('rc', 3), lot('x'), 'counted', 0.2);
    const s = allocateArrival(got.ledger, got.supply, meta('a', 4), 'q', { receiptLotId: 'x', arrived: 0.2, good: 0.2 });
    const group = caseDetailOf(got.ledger, s, 'A-001').groups.find((g) => g.item === 'D' && g.unit === 'kg');
    expect(group?.outstanding).toContain('到着0.2kg・未着0.1kg');
  });
});

describe('Task4: 品目・単位の数量の合計が上限を超える書込の拒否', () => {
  const max = Number.MAX_SAFE_INTEGER;
  const over = '合計が上限を超える';
  const integerRequest = (quantity: number) => ({ project, item: 'P', unit: '個', quantity, vendor: '架空仕入先', requestedOn: '2026-10-14', reply: { kind: 'none' } as const });
  const decimalRequest = (quantity: number) => ({ project, item: 'D', unit: 'kg', quantity, vendor: '架空仕入先', requestedOn: '2026-10-14', reply: { kind: 'none' } as const });
  const pLot = (id: string, p: Lot['project'] = project) => ({ id, item: 'P', unit: '個', project: p, location: 'T' });
  const op = { opId: 'op1', opLabel: '架空操作', fingerprint: 'f', values: {}, actor: '架空担当A', startedAt: meta('x').recordedAt, savingSince: meta('x').recordedAt };
  function storeOf(before: ReturnType<typeof initial>) {
    const data = new Map([['fuzzy-stock/head', 'A'], ['fuzzy-stock/slot-A', serialize(before)]]);
    const writes: string[] = [];
    const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { writes.push(k); data.set(k, v); }, removeItem: (k: string) => { writes.push(k); data.delete(k); } } satisfies StoreLike;
    return { data, writes, store };
  }

  test('2.4: 整数の依頼MAX_SAFE_INTEGERと1の合計は拒否し、各値だけの範囲内は通す', () => {
    const first = recordRequest(emptySupply, fixedMasters, meta('q1', 1), integerRequest(max));
    expect(() => requireQuantityTotals(practiceLedger, first)).not.toThrow();
    const second = recordRequest(first, fixedMasters, meta('q2', 2), integerRequest(1));
    expect(() => requireQuantityTotals(practiceLedger, second)).toThrow('品目P（個）の依頼数の合計が上限を超える');
  });

  test('2.4: 小数の依頼562949953421311.9と0.1の合計は拒否する', () => {
    const l = base();
    const first = recordRequest(emptySupply, l.masters, meta('q1', 1), decimalRequest(562949953421311.9));
    expect(() => requireQuantityTotals(l, first)).not.toThrow();
    const second = recordRequest(first, l.masters, meta('q2', 2), decimalRequest(0.1));
    expect(() => requireQuantityTotals(l, second)).toThrow(over);
  });

  test.each([
    ['共通の在庫どうし', { kind: 'common' }, { kind: 'common' }],
    ['別の案件・用途どうし', { kind: 'case', id: 'A-001' }, { kind: 'case', id: 'A-002' }],
  ] as const)('2.4: %sでも、同じ品目・単位の在庫の合計が上限を超える登録は拒否する', (_, first, second) => {
    const one = register(practiceLedger, meta('r1', 1), pLot('a', first), 'counted', max);
    expect(() => requireQuantityTotals(one, emptySupply)).not.toThrow();
    const two = register(one, meta('r2', 2), pLot('b', second), 'counted', 1);
    expect(() => totalsOf(two, Object.values(two.lots))).toThrow();
    expect(() => requireQuantityTotals(two, emptySupply)).toThrow(over);
  });

  test('2.4: 同じ案件・用途の未使用MAXと工程内1の合計は拒否する', () => {
    const one = register(practiceLedger, meta('r1', 1), pLot('a'), 'counted', max);
    const two = start(one, meta('w1', 2), pLot('w'), process, 'counted', 1, []);
    expect(() => requireQuantityTotals(two, emptySupply)).toThrow(over);
  });

  test.each([['個', max, 1], ['kg', 562949953421311.9, 0.1]] as const)('2.4: 同じ案件・用途・工程の工程内%sの合計が上限を超える作業の開始は拒否する', (unit, limit, extra) => {
    const one = start(base(), meta('w1', 1), lot('w1', unit), process, 'counted', limit, []);
    expect(() => requireQuantityTotals(one, emptySupply)).not.toThrow();
    const two = start(one, meta('w2', 2), lot('w2', unit), process, 'counted', extra, []);
    expect(() => requireQuantityTotals(two, emptySupply)).toThrow(over);
  });

  test('2.4: MAXの受け取りをMAXの依頼へ割り当てしても、別々の数を合計しないので通す', () => {
    const asked = recordRequest(emptySupply, fixedMasters, meta('q1', 1), integerRequest(max));
    const got = receiveLot(practiceLedger, asked, meta('rc', 2), pLot('R1'), 'counted', max);
    const s = allocateArrival(got.ledger, got.supply, meta('a1', 3), 'q1', { receiptLotId: 'R1', arrived: max, good: max });
    expect(() => requireQuantityTotals(got.ledger, s)).not.toThrow();
  });

  test('2.4: 必要な数1の群に在庫MAXがあっても、不足の計算は上限を超えないので通す', () => {
    const l = register(practiceLedger, meta('r1', 1), pLot('a'), 'counted', max);
    const s = registerNeed(emptySupply, l.masters, meta('n', 2), { project, item: 'P', unit: '個', required: { basis: 'counted', value: 1 }, dueDate: null, source: '架空必要一覧', revision: '初版' });
    expect(() => requireQuantityTotals(l, s)).not.toThrow();
    expect(requestSummaryOf(l, s, { project, item: 'P', unit: '個' }).effectiveShortage).toBe(0);
  });

  test('2.4: MAXの物を工程で二度動かしても通し、工程完了累計が上限を超えると拒否する', () => {
    let l = start(practiceLedger, meta('w1', 1), pLot('w1'), process, 'counted', max, []);
    l = changeStage(l, meta('f1', 2), 'w1', 'c1', 'counted', max, { kind: 'awaitingHandover', process });
    l = handOver(l, meta('h1', 3), 'c1', 'counted', max, '架空の次工程');
    expect(() => requireQuantityTotals(l, emptySupply)).not.toThrow();
    l = start(l, meta('w2', 4), pLot('w2'), process, 'counted', 1, []);
    l = changeStage(l, meta('f2', 5), 'w2', 'c2', 'counted', 1, { kind: 'awaitingHandover', process });
    expect(() => productionOf(l, process.id, 'P', '個', project)).toThrow();
    expect(() => requireQuantityTotals(l, emptySupply)).toThrow(over);
  });

  test('2.4: 同じ群の使用実績の累計が上限を超える使用は拒否する', () => {
    let l = register(practiceLedger, meta('r1', 1), pLot('a'), 'counted', max);
    l = use(l, meta('u1', 2), 'a', 'counted', max, '架空の使用');
    l = register(l, meta('r2', 3), pLot('b'), 'counted', 1);
    expect(() => requireQuantityTotals(l, emptySupply)).not.toThrow();
    l = use(l, meta('u2', 4), 'b', 'counted', 1, '架空の使用');
    expect(() => requireQuantityTotals(l, emptySupply)).toThrow(over);
  });

  test('3.2: 工程内数は単位の精度で作業中と検査待ちを足す', () => {
    const inspected = { id: '架空検査工程', criterion: 'inspection' } as const;
    let l = start(base(), meta('w1', 1), lot('w1'), inspected, 'counted', 0.3, []);
    l = start(l, meta('w2', 2), lot('w2'), inspected, 'counted', 0.2, []);
    l = changeStage(l, meta('insp', 3), 'w2', 'i2', 'counted', 0.2, { kind: 'inspecting', process: inspected });
    expect(numeric(productionOf(l, inspected.id, 'D', 'kg', project).inProcess)).toBe(0.5);
  });

  test.each([
    ['依頼', () => {
      const first = recordRequest(emptySupply, fixedMasters, meta('q1', 1), integerRequest(max));
      return { before: initial(practiceLedger, first), after: { ledger: practiceLedger, supply: recordRequest(first, fixedMasters, meta('q2', 2), integerRequest(1)) } };
    }],
    ['別の案件・用途の登録', () => {
      const one = register(practiceLedger, meta('r1', 1), pLot('a', { kind: 'case', id: 'A-001' }), 'counted', max);
      return { before: initial(one, emptySupply), after: { ledger: register(one, meta('r2', 2), pLot('b', { kind: 'case', id: 'A-002' }), 'counted', 1), supply: emptySupply } };
    }],
    ['作業の開始', () => {
      const one = start(practiceLedger, meta('w1', 1), pLot('w1'), process, 'counted', max, []);
      return { before: initial(one, emptySupply), after: { ledger: start(one, meta('w2', 2), pLot('w2'), process, 'counted', 1, []), supply: emptySupply } };
    }],
  ] as const)('2.4: %sで合計が上限を超える単位は保存せず、保存先を変えない', (_, make) => {
    const { before, after } = make();
    const { data, writes, store } = storeOf(before);
    const snapshot = new Map(data);
    const saved = commit(store, before, op, [{ conflictReviews: [], ...after, targets: ['x'] }]);
    expect(saved).toMatchObject({ kind: 'failed', reason: expect.stringContaining(over) });
    expect(data).toEqual(snapshot); expect(writes).toEqual([]);
  });

  test('2.4・4.2: 保存前に残った上限超えのpendingは再試行でも保存せず、保存先を変えない', () => {
    const first = recordRequest(emptySupply, fixedMasters, meta('q1', 1), integerRequest(max));
    const before = initial(practiceLedger, first);
    const { data, writes, store } = storeOf(before);
    const second = recordRequest(first, fixedMasters, meta('q2', 2), integerRequest(1));
    const pending: Pending = { ...op, units: [{ conflictReviews: [], ledger: practiceLedger, supply: second, targets: ['依頼q2'] }], progress: 'saving', unknownSince: null, baseRevision: before.revision };
    data.set('fuzzy-stock/pending', serializePending(pending));
    const snapshot = new Map(data);
    expect(retry(store, before, pending, '架空担当A', meta('y').recordedAt)).toMatchObject({ kind: 'failed', reason: expect.stringContaining(over) });
    expect(data).toEqual(snapshot); expect(writes).toEqual([]);
  });

  test('2.4: 合計が上限を超える記録への置き換えは拒否し、保存先を変えない', () => {
    const current = initial(practiceLedger, emptySupply);
    const { data, writes, store } = storeOf(current);
    const snapshot = new Map(data);
    const two = register(register(practiceLedger, meta('r1', 1), pLot('a', { kind: 'common' }), 'counted', max), meta('r2', 2), pLot('b', { kind: 'common' }), 'counted', 1);
    expect(() => replace(store, current, { ledger: two, supply: emptySupply })).toThrow(over);
    expect(data).toEqual(snapshot); expect(writes).toEqual([]);
  });

  const pNeed = (value: number) => ({ project, item: 'P', unit: '個', required: { basis: 'counted' as const, value }, dueDate: null, source: '架空必要一覧', revision: '初版' });
  const declare = (s: Supply, id: string, value: number) => declareShortage(s, fixedMasters, meta(id, 3), { project, item: 'P', unit: '個', value, reason: '架空不足' });
  const pKey = { project, item: 'P', unit: '個' };
  const withArrivals = (arrivals: { arrived: number; good: number; receiptLotId: string }[]): Supply => {
    const s = recordRequest(emptySupply, fixedMasters, meta('q1', 1), integerRequest(max));
    return { ...s, requests: { q1: { ...s.requests['q1']!, arrivals: arrivals.map((a, i) => ({ id: `a${i}`, ...a })) } } };
  };

  test.each([
    ['必要MAX・在庫MAXに対応付けない申告1（実効の不足1）', () => {
      const l = register(practiceLedger, meta('r1', 1), pLot('a'), 'counted', max);
      return { l, s: declare(registerNeed(emptySupply, fixedMasters, meta('n', 2), pNeed(max)), 'd1', 1), shortage: 1 };
    }],
    ['必要1・対応付けた申告1のあと必要をMAXへ改訂', () => {
      const linked = linkDeclaration(declare(registerNeed(emptySupply, fixedMasters, meta('n', 2), pNeed(1)), 'd1', 1), fixedMasters, meta('lk', 4), 'd1', true);
      return { l: practiceLedger, s: reviseNeed(linked, fixedMasters, meta('rn', 5), 'n', { required: { basis: 'counted', value: max }, dueDate: null, source: '架空必要一覧', revision: '改訂' }), shortage: max };
    }],
    ['必要MAX・対応付けた申告1', () => ({ l: practiceLedger, s: linkDeclaration(declare(registerNeed(emptySupply, fixedMasters, meta('n', 2), pNeed(max)), 'd1', 1), fixedMasters, meta('lk', 4), 'd1', true), shortage: max })],
  ] as const)('2.4: 表示できる不足と申告は拒否しない：%s', (_, make) => {
    const { l, s, shortage } = make();
    expect(() => requireQuantityTotals(l, s)).not.toThrow();
    expect(requestSummaryOf(l, s, pKey).effectiveShortage).toBe(shortage);
  });

  test('2.4: 届いた良品で解消済みの申告MAXのあとに申告1を足しても、実効の不足1なので拒否しない', () => {
    const declared = declareShortage(emptySupply, fixedMasters, meta('d1', 1), { project, item: 'P', unit: '個', value: max, reason: '架空不足' });
    const asked = recordRequest(declared, fixedMasters, meta('q1', 2), integerRequest(max));
    const got = receiveLot(practiceLedger, asked, meta('rc', 3), pLot('R1'), 'counted', max);
    const settled = allocateArrival(got.ledger, got.supply, meta('a1', 4), 'q1', { receiptLotId: 'R1', arrived: max, good: max });
    const s = declareShortage(settled, fixedMasters, meta('d2', 5), { project, item: 'P', unit: '個', value: 1, reason: '架空不足' });
    expect(() => requireQuantityTotals(got.ledger, s)).not.toThrow();
    expect(requestSummaryOf(got.ledger, s, pKey).effectiveShortage).toBe(1);
  });

  test.each([
    ['必要MAXに対応付けない申告1（在庫なし）', () => declare(registerNeed(emptySupply, fixedMasters, meta('n', 2), pNeed(max)), 'd1', 1)],
    ['必要なしの申告MAXと1', () => declare(declare(emptySupply, 'd1', max), 'd2', 1)],
  ] as const)('2.4: 実効の不足が上限を超える状態は拒否する：%s', (_, make) => {
    const s = make();
    expect(() => requestSummaryOf(practiceLedger, s, pKey)).toThrow();
    expect(() => requireQuantityTotals(practiceLedger, s)).toThrow(over);
  });

  test('2.4: 一つの依頼へ二つの受け取りから届いた届いた数・使える数の合計が上限を超える状態は拒否する', () => {
    const s = withArrivals([{ receiptLotId: 'R1', arrived: max, good: max }, { receiptLotId: 'R2', arrived: 1, good: 1 }]);
    expect(() => requestProgressOf(fixedMasters, s.requests['q1']!)).toThrow();
    expect(() => requireQuantityTotals(practiceLedger, s)).toThrow(over);
  });

  test('2.4: 取り消した使用と取り消した依頼は累計・依頼数に数えない', () => {
    let l = register(practiceLedger, meta('r1', 1), pLot('a'), 'counted', max);
    l = use(l, meta('u1', 2), 'a', 'counted', max, '架空の使用');
    l = voidRecord(l, meta('v1', 3), 'u1', '架空の誤り');
    l = use(l, meta('u2', 4), 'a', 'counted', max, '架空の使用');
    expect(() => requireQuantityTotals(l, emptySupply)).not.toThrow();
    const cancelled = cancelRequest(recordRequest(emptySupply, fixedMasters, meta('q1', 1), integerRequest(max)), fixedMasters, meta('c1', 2), 'q1', '架空の取消');
    expect(() => requireQuantityTotals(practiceLedger, recordRequest(cancelled, fixedMasters, meta('q2', 3), integerRequest(1)))).not.toThrow();
  });

  test('2.4: 一つの受け取りの到着が品目の違う依頼から来ている復元候補は、置き換えずに拒否する', () => {
    const current = initial(practiceLedger, emptySupply);
    const { data, writes, store } = storeOf(current);
    const snapshot = new Map(data);
    const p = recordRequest(emptySupply, fixedMasters, meta('q1', 1), integerRequest(max));
    const q = recordRequest(p, fixedMasters, meta('q2', 2), { ...integerRequest(1), item: 'Q' });
    const receiveP = receiveLot(practiceLedger, q, meta('rp', 3), pLot('R9'), 'counted', max);
    const receiveQ = receiveLot(practiceLedger, q, meta('rq', 3), { ...pLot('R9'), item: 'Q' }, 'counted', 1);
    const arrivedP = allocateArrival(receiveP.ledger, receiveP.supply, meta('a1', 4), 'q1', { receiptLotId: 'R9', arrived: max, good: 0 });
    const arrivedQ = allocateArrival(receiveQ.ledger, receiveQ.supply, meta('a2', 4), 'q2', { receiptLotId: 'R9', arrived: 1, good: 0 });
    // 各依頼の正当な到着を、異品目が同じ受け取りを指す不正な候補へ組み合わせる。
    const mixed: Supply = { ...q, requests: {
      q1: arrivedP.requests['q1']!, q2: arrivedQ.requests['q2']!,
    }, log: [...q.log, ...arrivedP.log.filter(e => e.kind === 'arrival'), ...arrivedQ.log.filter(e => e.kind === 'arrival').map(e => ({ ...e, itemLabels: captureItemLabels(fixedMasters, ['P', 'Q']) }))] };
    expect(() => allocatedToReceipt(mixed, fixedMasters, 'R9')).toThrow();
    expect(() => replace(store, current, { ledger: receiveP.ledger, supply: mixed })).toThrow('受け取りR9');
    expect(data).toEqual(snapshot); expect(writes).toEqual([]);
  });

  test('2.4: 読み込めない記録の初期化でも、合計が上限を超える記録は書かない', () => {
    const data = new Map([['fuzzy-stock/head', 'A'], ['fuzzy-stock/slot-A', '壊れた値']]);
    const writes: string[] = [];
    const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { writes.push(k); data.set(k, v); }, removeItem: (k: string) => { writes.push(k); data.delete(k); } } satisfies StoreLike;
    const snapshot = new Map(data);
    const two = register(register(practiceLedger, meta('r1', 1), pLot('a'), 'counted', max), meta('r2', 2), pLot('b'), 'counted', 1);
    expect(() => confirmedUnreadableReset(store, { ledger: two, supply: emptySupply })).toThrow(over);
    expect(data).toEqual(snapshot); expect(writes).toEqual([]);
  });
});
