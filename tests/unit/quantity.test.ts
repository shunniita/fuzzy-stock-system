import { describe, expect, test } from 'vitest';
import { add, observe, quantityOf, sameQuantity, subtract, type Basis, type Quantity } from '../../src/domain/quantity.ts';

const letterToBasis = { E: 'counted', L: 'label', A: 'approximate', U: 'unknown' } as const;
type Letter = keyof typeof letterToBasis;

// AT-31: 数値は100と30を基本とし、各ケースは独立に作る。
function q(id: string, letter: Letter, value: number): Quantity {
  const basis: Basis = letterToBasis[letter];
  return quantityOf(observe(id, basis, basis === 'unknown' ? null : value));
}

describe('FH-C01・QTY-02a/04a 保存前後の数量の同一性', () => {
  test.each([
    q('E', 'E', 100), q('L', 'L', 100), q('A', 'A', 100), q('U', 'U', 0),
    subtract(q('E', 'E', 100), q('U', 'U', 0)),
    add(q('E', 'E', 100), subtract(q('L', 'L', 30), q('U', 'U', 0))),
    add(q('U1', 'U', 0), q('U2', 'U', 0)),
  ])('根拠・不明部分・減算前の数量を持つ数量も復号後に同じと判定する (%#)', (quantity) => {
    const decoded = JSON.parse(JSON.stringify(quantity)) as Quantity;
    expect(sameQuantity(quantity, decoded)).toBe(true);
    expect(sameQuantity(decoded, quantity)).toBe(true);
    // JSONのキー順を同一性の条件にしない。
    const { terms, ...rest } = decoded;
    expect(sameQuantity(quantity, { terms, ...rest })).toBe(true);
  });

  test('同じ数値でも観測ID・根拠・計算値を区別する', () => {
    const counted = q('observed', 'E', 100);
    expect(sameQuantity(counted, q('other', 'E', 100))).toBe(false);
    expect(sameQuantity(counted, q('observed', 'L', 100))).toBe(false);
    expect(sameQuantity(counted, q('observed', 'A', 100))).toBe(false);
    if (counted.kind !== 'known') throw new Error('数えた数量を使う');
    expect(sameQuantity(counted, { ...counted, computed: true })).toBe(false);
  });

  test('不明な残数でも、減算前にラベルかだいたいかを失わない', () => {
    const unknown = q('U', 'U', 0);
    expect(sameQuantity(subtract(q('before', 'L', 100), unknown), subtract(q('before', 'A', 100), unknown))).toBe(false);
    expect(sameQuantity(unknown, subtract(q('E', 'E', 100), unknown))).toBe(false);
  });

  test('小計が同じでも、不明部分の減算前の根拠を失わない', () => {
    const before = subtract(q('before', 'L', 100), q('U', 'U', 0));
    const other = subtract(q('before', 'A', 100), q('U', 'U', 0));
    expect(sameQuantity(add(q('subtotal', 'E', 20), before), add(q('subtotal', 'E', 20), other))).toBe(false);
  });
});

const known = (value: number, approximate: boolean, unconfirmed: 'none' | 'partial' | 'all') => ({
  kind: 'known',
  numeric: { value, approximate, unconfirmed },
  computed: true,
});
const subtotalPlusUnknown = (
  numeric: { value: number; approximate: boolean; unconfirmed: 'none' | 'partial' | 'all' } | null,
  unknownCount: number,
) => ({
  kind: 'partlyUnknown',
  numeric,
  unknownParts: Array.from({ length: unknownCount }, () => expect.objectContaining({ kind: 'unknown' })),
});

// 04章「加算の組合せ規則」。左100・右30。U を含むときの小計は数値側だけ。
const additionTable = [
  ['E', 'E', '数値合計・計算値', known(130, false, 'none')],
  ['E', 'L', '数値合計・未確認部分あり', known(130, false, 'partial')],
  ['E', 'A', '約合計', known(130, true, 'none')],
  ['E', 'U', '小計＋不明、総数不明', subtotalPlusUnknown({ value: 100, approximate: false, unconfirmed: 'none' }, 1)],
  ['L', 'E', '数値合計・未確認部分あり', known(130, false, 'partial')],
  ['L', 'L', '数値合計・中身未確認', known(130, false, 'all')],
  ['L', 'A', '約合計＋未確認部分あり', known(130, true, 'partial')],
  ['L', 'U', '小計＋不明、総数不明', subtotalPlusUnknown({ value: 100, approximate: false, unconfirmed: 'all' }, 1)],
  ['A', 'E', '約合計', known(130, true, 'none')],
  ['A', 'L', '約合計＋未確認部分あり', known(130, true, 'partial')],
  ['A', 'A', '約合計', known(130, true, 'none')],
  ['A', 'U', '約小計＋不明、総数不明', subtotalPlusUnknown({ value: 100, approximate: true, unconfirmed: 'none' }, 1)],
  ['U', 'E', '小計＋不明、総数不明', subtotalPlusUnknown({ value: 30, approximate: false, unconfirmed: 'none' }, 1)],
  ['U', 'L', '小計＋不明、総数不明', subtotalPlusUnknown({ value: 30, approximate: false, unconfirmed: 'all' }, 1)],
  ['U', 'A', '約小計＋不明、総数不明', subtotalPlusUnknown({ value: 30, approximate: true, unconfirmed: 'none' }, 1)],
  ['U', 'U', '不明の対象を列挙、総数不明', subtotalPlusUnknown(null, 2)],
] as const;

// 残数不明は、引く前の数量そのものを参照に残す（04章 line 293）。
const remainderUnknown = (before: object) => ({ kind: 'unknown', before });
const observed = (value: number, approximate: boolean, unconfirmed: 'none' | 'partial' | 'all') => ({
  kind: 'known',
  numeric: { value, approximate, unconfirmed },
  computed: false,
});
const unknownObservation = { kind: 'unknown', before: null };

// 04章「減算の組合せ規則」。基準100・減少量30。
const subtractionTable = [
  ['E', 'E', '台帳差分・計算値', known(70, false, 'none')],
  ['E', 'L', '台帳差分・未確認部分あり', known(70, false, 'partial')],
  ['E', 'A', '約差分', known(70, true, 'none')],
  ['E', 'U', '残数不明', remainderUnknown(observed(100, false, 'none'))],
  ['L', 'E', '台帳差分・中身未確認', known(70, false, 'all')],
  ['L', 'L', '台帳差分・中身未確認', known(70, false, 'all')],
  ['L', 'A', '約差分＋未確認部分あり', known(70, true, 'partial')],
  ['L', 'U', '残数不明', remainderUnknown(observed(100, false, 'all'))],
  ['A', 'E', '約差分', known(70, true, 'none')],
  ['A', 'L', '約差分＋未確認部分あり', known(70, true, 'partial')],
  ['A', 'A', '約差分', known(70, true, 'none')],
  ['A', 'U', '残数不明', remainderUnknown(observed(100, true, 'none'))],
  ['U', 'E', '残数不明', remainderUnknown(unknownObservation)],
  ['U', 'L', '残数不明', remainderUnknown(unknownObservation)],
  ['U', 'A', '残数不明', remainderUnknown(unknownObservation)],
  ['U', 'U', '残数不明（0にしない）', remainderUnknown(unknownObservation)],
] as const;

describe('AT-31 減算16通り', () => {
  test.each(subtractionTable)('%s100－%s30 → %s', (base, decrease, _, expected) => {
    const result = subtract(q('base', base, 100), q('decrease', decrease, 30));
    expect(result).toMatchObject(expected);
    expect(result.terms.map((t) => [t.sign, t.observation.id, t.observation.basis])).toEqual([
      [1, 'base', letterToBasis[base]],
      [-1, 'decrease', letterToBasis[decrease]],
    ]);
  });
});

describe('AT-31 混在と連鎖', () => {
  test('L100＋A30＋U → 約小計130・未確認部分あり＋不明1、総数不明', () => {
    const result = add(add(q('l', 'L', 100), q('a', 'A', 30)), q('u', 'U', 0));
    expect(result).toMatchObject(subtotalPlusUnknown({ value: 130, approximate: true, unconfirmed: 'partial' }, 1));
    expect(result.terms.map((t) => t.observation.basis)).toEqual(['label', 'approximate', 'unknown']);
  });

  test('E100－L30 は記録上の数70・未確認部分ありで、根拠別の残数（E70とL0）を持たない', () => {
    expect(subtract(q('e', 'E', 100), q('l', 'L', 30))).toEqual({
      kind: 'known',
      numeric: { value: 70, approximate: false, unconfirmed: 'partial' },
      computed: true,
      terms: [
        { sign: 1, observation: { id: 'e', basis: 'counted', value: 100 } },
        { sign: -1, observation: { id: 'l', basis: 'label', value: 30 } },
      ],
    });
  });

  test('(E100＋L30)－A20 → 約110・未確認部分あり', () => {
    expect(subtract(add(q('e', 'E', 100), q('l', 'L', 30)), q('a', 'A', 20))).toMatchObject(
      known(110, true, 'partial'),
    );
  });

  test('(L100－E30)－E10 → 記録上の数60・中身未確認のまま', () => {
    expect(subtract(subtract(q('l', 'L', 100), q('e1', 'E', 30)), q('e2', 'E', 10))).toMatchObject(
      known(60, false, 'all'),
    );
  });

  test('残数不明に後から実数30を足すと、小計30＋不明（最後に分かっていた100を保持）', () => {
    const remainder = subtract(q('e', 'E', 100), q('u', 'U', 0));
    const result = add(remainder, q('e2', 'E', 30));
    expect(result).toMatchObject({
      kind: 'partlyUnknown',
      numeric: { value: 30, approximate: false, unconfirmed: 'none' },
      unknownParts: [remainderUnknown(observed(100, false, 'none'))],
    });
  });

  test('小計100＋不明から実数30を引くと残数不明で、引く前の小計100＋不明を参照に残す', () => {
    const base = add(q('e', 'E', 100), q('u', 'U', 0));
    expect(subtract(base, q('e2', 'E', 30))).toMatchObject(
      remainderUnknown(subtotalPlusUnknown({ value: 100, approximate: false, unconfirmed: 'none' }, 1)),
    );
  });

  test('参照に残る記録上の数は計算値のままで、数えたと区別できる', () => {
    const r = subtract(subtract(q('e1', 'E', 100), q('e2', 'E', 30)), q('u', 'U', 0));
    const result = subtract(add(r, q('e3', 'E', 20)), q('e4', 'E', 10));
    expect(result).toMatchObject(
      remainderUnknown({ kind: 'partlyUnknown', unknownParts: [remainderUnknown(known(70, false, 'none'))] }),
    );
  });

  test('E同士の計算結果は計算値で、新たな数えたにしない（単独の数えたとは区別する）', () => {
    expect(q('e', 'E', 100)).toMatchObject({ computed: false });
    expect(add(q('e1', 'E', 100), q('e2', 'E', 30))).toMatchObject({ computed: true });
    expect(subtract(q('e1', 'E', 100), q('e2', 'E', 30))).toMatchObject({ computed: true });
  });

  test('QTY-05b: 整数の精度を保てない大きさの計算結果は拒否する', () => {
    const max = q('big', 'E', Number.MAX_SAFE_INTEGER);
    expect(() => add(max, q('e', 'E', 2))).toThrow();
    const minusMax = subtract(q('zero', 'E', 0), max);
    expect(() => subtract(minusMax, q('e', 'E', 2))).toThrow();
  });

  test('負の差分は符号を保ち、0へ丸めない（保留・確認が必要はA3）', () => {
    expect(subtract(q('e1', 'E', 30), q('e2', 'E', 50))).toMatchObject(known(-20, false, 'none'));
  });
});

describe('15-A 受け取り試験の計算部分', () => {
  test('AT-01: 実数0・ラベル0・だいたい0と不明箱の集計は、不明箱を0個として合計しない', () => {
    const total = [q('l0', 'L', 0), q('a0', 'A', 0), q('u', 'U', 0)].reduce((total, quantity) => add(total, quantity, 1), q('e0', 'E', 0));
    expect(total).toMatchObject(subtotalPlusUnknown({ value: 0, approximate: true, unconfirmed: 'partial' }, 1));
  });

  test('AT-03: 確認100＋だいたい約30 → 約130、根拠別の内訳を残す', () => {
    const result = add(q('e', 'E', 100), q('a', 'A', 30));
    expect(result).toMatchObject(known(130, true, 'none'));
    expect(result.terms.map((t) => [t.observation.basis, t.observation.value])).toEqual([
      ['counted', 100],
      ['approximate', 30],
    ]);
  });

  test('AT-04: 確認100＋ラベル30 → 記録上の数130、うち30は中身未確認', () => {
    const result = add(q('e', 'E', 100), q('l', 'L', 30));
    expect(result).toMatchObject(known(130, false, 'partial'));
    expect(result.terms.filter((t) => t.observation.basis === 'label').map((t) => t.observation.value)).toEqual([30]);
  });

  test('AT-05: 確認100＋数が不明の箱1つ → 数値部分100と不明箱、総数100と断定しない', () => {
    const result = add(q('e', 'E', 100), q('box', 'U', 0));
    expect(result.kind).not.toBe('known');
    expect(result).toMatchObject(subtotalPlusUnknown({ value: 100, approximate: false, unconfirmed: 'none' }, 1));
  });
});

describe('AT-31 加算16通り', () => {
  test.each(additionTable)('%s100＋%s30 → %s', (left, right, _, expected) => {
    const result = add(q('left', left, 100), q('right', right, 30));
    expect(result).toMatchObject(expected);
    expect(result.terms.map((t) => [t.sign, t.observation.id, t.observation.basis])).toEqual([
      [1, 'left', letterToBasis[left]],
      [1, 'right', letterToBasis[right]],
    ]);
  });
});

describe('観測1件の数量', () => {
  test('AT-01: 数えた0・ラベル0・だいたい0は根拠付きの0、数が不明な場合は0ではない', () => {
    expect(quantityOf(observe('e0', 'counted', 0))).toEqual({
      kind: 'known',
      numeric: { value: 0, approximate: false, unconfirmed: 'none' },
      computed: false,
      terms: [{ sign: 1, observation: { id: 'e0', basis: 'counted', value: 0 } }],
    });
    expect(quantityOf(observe('l0', 'label', 0))).toMatchObject({
      kind: 'known',
      numeric: { value: 0, approximate: false, unconfirmed: 'all' },
    });
    expect(quantityOf(observe('a0', 'approximate', 0))).toMatchObject({
      kind: 'known',
      numeric: { value: 0, approximate: true, unconfirmed: 'none' },
    });
    expect(quantityOf(observe('u', 'unknown', null))).toEqual({
      kind: 'unknown',
      before: null,
      terms: [{ sign: 1, observation: { id: 'u', basis: 'unknown', value: null } }],
    });
  });

  test('C-R1: 数量を作った後に元の観測を書き換えても、数量の元記録は変わらない', () => {
    const source = { id: 'q1', basis: 'counted' as const, value: 100 };
    const quantity = quantityOf(source);
    source.value = 7;
    expect(quantity).toMatchObject({ numeric: { value: 100 } });
    expect(quantity.terms[0]?.observation.value).toBe(100);
  });

  test.each([
    ['小数', 'counted', 1.5],
    ['負数', 'label', -1],
    ['数値なのに値なし', 'approximate', null],
    ['不明なのに値あり', 'unknown', 0],
  ] as const)('入力検査: %sは拒否する', (_, basis, value) => {
    expect(() => observe('x', basis, value)).toThrow();
  });
});
