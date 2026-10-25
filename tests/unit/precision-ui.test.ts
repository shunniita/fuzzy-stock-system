import { describe, expect, test } from 'vitest';
import { changeMasters, practiceLedger, hold, recordStop, recount, register, type Ledger, type Meta } from '../../src/domain/ledger.ts';
import { emptySupply, receiveLot, recordRequest, registerNeed, type Supply } from '../../src/domain/supply.ts';
import { scalarLimitText } from '../../src/domain/scalar.ts';
import type { Values } from '../../src/ui/dom.ts';
import { amount, hintText, quantityStepFor, quantityTargetOf, quantityValue } from '../../src/ui/fields.ts';
import { followupRowsOf } from '../../src/ui/followupview.ts';
import { masterOps } from '../../src/ui/master-ui.ts';
import { recountWithReceiptChoice, supplyOps, type Ctx, type State, type UiOp } from '../../src/ui/supply-ui.ts';
import { shortageOf } from '../../src/domain/shortage.ts';
import { caseDetailOf } from '../../src/ui/caseview.ts';
import { shortageLinesText } from '../../src/ui/supply-format.ts';

const meta = (id: string, minute = 10): Meta => ({ eventId: id, occurredAt: `2026-10-14T10:${String(minute).padStart(2, '0')}:00+09:00`, recordedAt: '2026-10-14T12:00:00+09:00', actor: '架空担当A' });
const project = { kind: 'case', id: 'A-001' } as const;
const values = (entries: Record<string, string>, checked: readonly string[] = []): Values => ({ text: (name) => entries[name] ?? '', checked: (name) => checked.includes(name) });
const ctxOf = (state: State): Ctx => ({ ledger: () => state.ledger, supply: () => state.supply });
function decimalItem(): Ledger {
  return changeMasters(practiceLedger, meta('master', 0), { action: 'register', master: { type: 'item', code: 'D', name: '架空小数材料', source: null, units: ['kg', '個'], unitSteps: { kg: 0.1, 個: 1 }, trial: true } });
}

describe('Task6 1.1・1.3: 品目登録で単位ごとの最小単位を指定する', () => {
  const run = (entries: Record<string, string>) => {
    const state: State = { ledger: practiceLedger, supply: emptySupply };
    return masterOps(ctxOf(state))['masterItem']!.run(state, meta('m1'), values({ code: 'D', name: '架空小数材料', trial: 'true', ...entries }), undefined).state.ledger.masters.items['D'];
  };

  test('選んだ最小単位を単位名に結び付けて登録し、選ばない単位は1にする', () => {
    expect(run({ units: 'kg、個', 'unitStep-kg': '0.1' })?.unitSteps).toEqual({ kg: 0.1, 個: 1 });
    expect(run({ units: '個、kg', 'unitStep-kg': '0.1', 'unitStep-個': '1' })?.unitSteps).toEqual({ 個: 1, kg: 0.1 });
    expect(run({ units: 'kg' })?.unitSteps).toEqual({ kg: 1 });
  });
});

describe('Task6 2.1・2.4: 数量の原文をNumberへ変える前に検査する', () => {
  test('最小単位に合う十進数・指数表記を受け、空欄は0にしない', () => {
    expect(amount(values({ basis: 'counted', value: '0.9' }))).toEqual({ basis: 'counted', value: 0.9 });
    expect(amount(values({ basis: 'counted', value: ' 1e-1 ' }))).toEqual({ basis: 'counted', value: 0.1 });
    expect(amount(values({ basis: 'unknown', value: '' }))).toEqual({ basis: 'unknown', value: null });
    expect(quantityValue('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
    expect(quantityValue('562949953421311.9')).toBe(562949953421311.9);
    expect(quantityValue('-1')).toBe(-1);
  });

  test.each(['0.10000000000000001', '0.05', 'abc', '0x10', '1e400', '9007199254740993', '562949953421312.1', '1'.repeat(129)])('%sは丸めずに拒否する', (raw) => {
    expect(() => amount(values({ basis: 'counted', value: raw }))).toThrow();
  });

  test('上限の案内は最小単位ごとの値を示す', () => {
    expect(scalarLimitText(1)).toBe('9007199254740991');
    expect(scalarLimitText(0.1)).toBe('562949953421311.9');
  });
});

describe('Task6 3.2: 供給の数量欄も原文を検査し、整数閾値で小数を拒否しない', () => {
  function received(): State {
    const ledger = decimalItem();
    const supply = recordRequest(emptySupply, ledger.masters, meta('q1', 1), { project, item: 'D', unit: 'kg', quantity: 1, vendor: '架空仕入先', requestedOn: '2026-10-14', reply: { kind: 'none' } });
    return receiveLot(ledger, supply, meta('rcv', 2), { id: 'R1', item: 'D', unit: 'kg', project, location: 'T' }, 'counted', 1);
  }

  test('割り当ての届いた数・使える数の0.1は受け、丸められる原文は無変更で拒否する', () => {
    const state = received();
    const allocate = supplyOps(ctxOf(state))['allocate']!;
    const done = allocate.run(state, meta('a1', 3), values({ receipt: 'R1', request: 'q1', arrived: '0.9', good: '0.9' }), undefined).state.supply;
    expect(done.requests['q1']?.arrivals.map((a) => [a.arrived, a.good])).toEqual([[0.9, 0.9]]);
    const before = JSON.stringify(state);
    expect(() => allocate.run(state, meta('a2', 3), values({ receipt: 'R1', request: 'q1', arrived: '0.90000000000000001', good: '0' }), undefined)).toThrow();
    expect(JSON.stringify(state)).toBe(before);
  });

  test('受け入れた現物を0.9と数え直して実際に受け取った数も0.9に訂正する', () => {
    const state = received();
    const base: UiOp = { label: '数え直し', fields: () => [], run: (s, m, v, inc) => ({ state: { ...s, ledger: recount(s.ledger, m, v.text('lot'), quantityValue(v.text('value')), { kind: 'unknown' }, inc) } }) };
    const op = recountWithReceiptChoice(base, ctxOf(state));
    const next = op.run(state, meta('c1', 4), values({ lot: 'R1', value: '0.9', receiptEffect: 'revise' }, ['causeUnknown']), undefined).state;
    expect(next.ledger.lots['R1']?.quantity).toMatchObject({ numeric: { value: 0.9 } });
    expect(next.supply.receipts['R1']?.received).toBe(0.9);
  });
});

describe('Task6 3.3: 正の0.1の未手配・未着をフォローに残す', () => {
  function needOne(): { ledger: Ledger; supply: Supply } {
    const ledger = register(decimalItem(), meta('r1', 1), { id: 'H1', item: 'D', unit: 'kg', project, location: 'T' }, 'counted', 0.9);
    const supply = registerNeed(emptySupply, ledger.masters, meta('n1', 2), { project, item: 'D', unit: 'kg', required: { basis: 'counted', value: 1 }, dueDate: '2026-10-20', source: '架空部品一覧', revision: '初版' });
    return { ledger, supply };
  }
  const flagsOf = (ledger: Ledger, supply: Supply) => followupRowsOf(ledger, supply, '2026-10-14').find((r) => r.key.item === 'D' && r.key.unit === 'kg')?.flags;

  test('必要1・在庫0.9なら未手配、0.1を依頼したら依頼済みとして残す', () => {
    const { ledger, supply } = needOne();
    expect(flagsOf(ledger, supply)).toContain('未手配');
    const requested = recordRequest(supply, ledger.masters, meta('q1', 3), { project, item: 'D', unit: 'kg', quantity: 0.1, vendor: '架空仕入先', requestedOn: '2026-10-14', reply: { kind: 'none' } });
    const flags = flagsOf(ledger, requested);
    expect(flags).toContain('依頼済み');
    expect(flags).not.toContain('未手配');
  });
});

describe('Task6 3.4: 不足の内訳は対象単位の精度で差を求める', () => {
  test('必要1・使用可能0.7・不良0.2なら、数量不足0.1・除外による不足0.2を一覧と案件・用途詳細で示す', () => {
    let ledger = register(decimalItem(), meta('r1', 1), { id: 'H1', item: 'D', unit: 'kg', project, location: 'T' }, 'counted', 0.7);
    ledger = register(ledger, meta('r2', 2), { id: 'H2', item: 'D', unit: 'kg', project, location: 'T' }, 'counted', 0.2);
    ledger = hold(ledger, meta('h', 3), 'H2', 'defective');
    const supply = registerNeed(emptySupply, ledger.masters, meta('n1', 4), { project, item: 'D', unit: 'kg', required: { basis: 'counted', value: 1 }, dueDate: '2026-10-20', source: '架空部品一覧', revision: '初版' });
    const view = shortageOf(ledger, supply, { project, item: 'D', unit: 'kg' });
    expect(view.excludedShortage).toBe(0.2);
    const line = '内訳：数量不足 0.1kg・除外による不足 0.2kg';
    expect(shortageLinesText(view, 'kg').join('\n')).toContain(line);
    expect(caseDetailOf(ledger, supply, 'A-001').groups.find((g) => g.item === 'D' && g.unit === 'kg')?.shortage).toContain(line);
  });
});

describe('Task6 Error Handling: どの最小単位・上限に合わないかを示す', () => {
  test('対象の最小単位が分かれば、その最小単位と上限の文言で拒否する', () => {
    expect(() => quantityValue('9007199254740992', 1)).toThrow('数量の絶対値は9007199254740991以下にする');
    expect(() => quantityValue('1.25', 1)).toThrow('数量は最小単位1に合う整数で入力する');
    expect(() => quantityValue('0.05', 1)).toThrow('数量は最小単位1に合う整数で入力する');
    expect(() => quantityValue('1.25', 0.1)).toThrow('数量は最小単位0.1に合う値で入力する');
    expect(() => quantityValue('562949953421312', 0.1)).toThrow('数量の絶対値は562949953421311.9以下にする');
    expect(quantityValue('9007199254740991', 1)).toBe(Number.MAX_SAFE_INTEGER);
  });

  test('対象が分からなければ、整数の形は整数の上限で示し、0.1より細かい値は特定の最小単位を言い切らない', () => {
    expect(() => quantityValue('9007199254740992')).toThrow('数量の絶対値は9007199254740991以下にする');
    for (const raw of ['1.25', '0.05']) expect(() => quantityValue(raw)).toThrow('数量は品目・単位の最小単位（1または0.1）に合う値で入力する');
  });

  test('単位のない仮の記録の小数は、最小単位1の文言で拒否する', () => {
    const v: Values = { ...values({ basis: 'counted', value: '0.5' }), step: () => 1 };
    expect(() => amount(v)).toThrow('数量は最小単位1に合う整数で入力する');
  });
});

describe('Task6 UI: 数量の欄が指す品目・単位と案内', () => {
  function fixture(): { ledger: Ledger; supply: Supply } {
    let ledger = register(decimalItem(), meta('r1', 1), { id: 'H1', item: 'D', unit: 'kg', project, location: 'T' }, 'counted', 1);
    ledger = register(ledger, meta('r2', 1), { id: 'I1', item: 'D', unit: '個', project, location: 'T' }, 'counted', 1);
    ledger = recordStop(ledger, meta('s1', 2), { process: 'R組立', item: 'D', unit: 'kg', project, reason: '材料待ち', shortage: null, affected: null });
    let supply = recordRequest(emptySupply, ledger.masters, meta('q1', 3), { project, item: 'D', unit: 'kg', quantity: 0.3, vendor: '架空仕入先', requestedOn: '2026-10-14', reply: { kind: 'none' } });
    supply = registerNeed(supply, ledger.masters, meta('n1', 4), { project, item: 'D', unit: '個', required: { basis: 'counted', value: 1 }, dueDate: '2026-10-20', source: '架空部品一覧', revision: '初版' });
    return { ledger, supply };
  }
  const resolve = (fields: Record<string, string>, name: string) => {
    const { ledger, supply } = fixture();
    const target = quantityTargetOf((n) => (Object.hasOwn(fields, n) ? fields[n]! : null), ledger, supply, name);
    return { target, step: quantityStepFor(ledger.masters, target ?? null), hint: target === undefined ? undefined : hintText(ledger.masters, target) };
  };
  const kg = 'kgの最小単位0.1・上限562949953421311.9';
  const piece = '個の最小単位1（整数）・上限9007199254740991';

  test.each([
    ['保管単位', { lot: 'H1' }, 'value', kg],
    ['整数単位の保管単位', { lot: 'I1' }, 'value', piece],
    ['受け取りの現物', { receipt: 'H1' }, 'received', kg],
    ['依頼（受け取りより優先）', { receipt: 'I1', request: 'q1' }, 'arrived', kg],
    ['割り当て', { arrival: 'q1/a1' }, 'good', kg],
    ['必要明細', { need: 'n1' }, 'value', piece],
    ['中断', { stop: 's1' }, 'affected', kg],
    ['材料行', { m2lot: 'H1', item: 'D', unit: '個' }, 'm2value', kg],
    ['受け取りの割り当て行', { r1request: 'q1', item: 'D', unit: '個' }, 'r1good', kg],
    ['中断の不足品目', { shortageItem: 'D', shortageUnit: 'kg', item: 'D', unit: '個' }, 'shortageValue', kg],
    ['品目と単位', { item: 'D', unit: '個' }, 'quantity', piece],
  ] as const)('%sの精度を案内する', (_, fields, name, hint) => {
    expect(resolve(fields, name).hint).toBe(hint);
  });

  test('単位のない仮の記録は整数、未選択は選ぶよう促し、数量でない欄は案内しない', () => {
    expect(resolve({ item: 'D' }, 'value')).toEqual({ target: 'unitless', step: 1, hint: '最小単位1（単位を持たない仮の記録は整数だけ）・上限9007199254740991' });
    for (const fields of [{ lot: '' }, { item: 'D', unit: '' }, { request: '' }, {}]) {
      expect(resolve(fields, 'value')).toMatchObject({ target: null, step: undefined, hint: '最小単位と上限は、対象（品目と単位、または保管単位・依頼）を選ぶと示す' });
    }
    expect(resolve({ lot: 'H1' }, 'perBox').target).toBeUndefined();
    expect(resolve({ item: '未登録', unit: 'kg' }, 'value').step).toBeUndefined();
  });
});

describe('Task6 2.4: 数量でない整数の欄は整数の制限を保つ', () => {
  const run = (raw: string) => {
    const state: State = { ledger: decimalItem(), supply: emptySupply };
    return masterOps(ctxOf(state))['masterPerBox']!.run(state, meta('p1'), values({ target: 'item:S', perBox: raw, reason: '箱の変更' }), undefined).state.ledger.masters.items['S']?.packaging?.perBox.at(-1)?.value;
  };

  test.each(['0x10', '0b11', '1e1', '12.0', '+12', '-1', 'abc', '', '１２'])('1箱あたりの数%sは十進数字の表記でないので拒否する', (raw) => {
    expect(() => run(raw)).toThrow('1箱あたりの数は1以上の整数にする');
  });

  test.each([
    [' 12 ', 12], ['　12　', 12], ['0012', 12], ['1', 1], ['9007199254740991', Number.MAX_SAFE_INTEGER],
  ])('1箱あたりの数%sの表記を読み、正の安全な整数の値域を維持する', (raw, value) => {
    expect(run(raw)).toBe(value);
  });

  test.each(['0', '9007199254740992'])('十進数字でも1箱あたりの数%sは値域外なので拒否する', raw => {
    expect(() => run(raw)).toThrow('1箱あたりの数は1以上の整数にする');
  });
});

describe('Task6 3.2: 受け取りの割り当て行の精度外は、その行だけ断って受け取りを記録する（NEED-05b）', () => {
  function requested(unit: 'kg' | '個'): State {
    const ledger = decimalItem();
    let supply = emptySupply;
    for (const id of ['q1', 'q2', 'q3']) supply = recordRequest(supply, ledger.masters, meta(id, 1), { project, item: 'D', unit, quantity: 1, vendor: '架空仕入先', requestedOn: '2026-10-14', reply: { kind: 'none' } });
    return { ledger, supply };
  }
  function receive(state: State, unit: 'kg' | '個', rows: Record<string, string>) {
    const entries = { newId: 'R1', item: 'D', unit, project: 'A-001', location: 'T', basis: 'counted', value: '1', ...rows };
    const v: Values = { ...values(entries), step: () => (unit === 'kg' ? 0.1 : 1) };
    return supplyOps(ctxOf(state))['receive']!.run(state, meta('rcv', 2), v, undefined);
  }

  test.each([['個', '0.5'], ['個', 'abc'], ['kg', '0.05']] as const)('%sの依頼への割り当て%sは、前の行と受け取りを保存して通知する', (unit, bad) => {
    const result = receive(requested(unit), unit, { r1request: 'q1', r1arrived: '1', r1good: '0', r2request: 'q2', r2arrived: bad, r2good: '0', r3request: 'q3', r3arrived: '0', r3good: '0' });
    expect(result.state.ledger.lots['R1']).toBeDefined();
    expect(result.state.supply.receipts['R1']?.received).toBe(1);
    expect(result.state.supply.requests['q2']?.arrivals).toEqual([]);
    expect(result.state.supply.requests['q3']?.arrivals).toEqual([]);
    expect(result.notice).toMatch(/^受け取りは記録した。割り当ては拒否した（2行目：.+）。1行目までを記録した。最後に記録した操作はrcv-a1$/);
    expect(result.units).toHaveLength(2);
  });

  test('一行目が読めなければ、受け取りだけを記録する', () => {
    const result = receive(requested('個'), '個', { r1request: 'q1', r1arrived: 'abc', r1good: '0' });
    expect(result.state.supply.receipts['R1']?.received).toBe(1);
    expect(result.notice).toContain('（1行目：数量は十進数で入力する）。0行目までを記録した。最後に記録した操作はrcv-c');
  });
});
