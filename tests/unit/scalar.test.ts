import { afterEach, describe, expect, test, vi } from 'vitest';
import { addScalar, multiplyScalarByInteger, parseScalar, parseSignedScalar, subtractScalar, sumScalars, validateScalar, validateSignedScalar } from '../../src/domain/scalar.ts';
import { parseExactJson } from '../../src/domain/exact-json.ts';

afterEach(() => { vi.restoreAllMocks(); });

describe('数量精度Task1・2.1/2.2/2.4: 原文と正確な数量', () => {
  test.each(['0.1', '.1', '+.10', '1e-1', '  0000.1000  ', '10e-2'])('最小単位0.1の同じ値を丸めずに受理する: %s', raw => {
    expect(parseScalar(raw, 0.1)).toBe(0.1);
  });

  test.each(['1', '1.0', '10e-1', '+1.', '0001'])('数学的に整数の入力は既存の単位1でも受理する: %s', raw => {
    expect(parseScalar(raw, 1)).toBe(1);
  });

  test.each(['0.05', '0.10000000000000001', '0.99999999999999999', '1e-999', '-1e-999', '1e999999999999999999999999999', '0x10', 'Infinity', 'NaN', '', '.', '1e', '1_000', '1'.repeat(129)])('値を丸めるか不正な原文を拒否する: %s', raw => {
    expect(() => parseScalar(raw, 0.1)).toThrow();
  });

  test('個数は小数を拒否し、小数の入力も負数を拒否する', () => {
    expect(() => parseScalar('0.1', 1)).toThrow();
    expect(() => parseScalar('-0.1', 0.1)).toThrow();
    expect(() => validateScalar(-0.1, 0.1)).toThrow();
    expect(parseScalar('-0', 1)).toBe(0);
    expect(parseScalar('0e999999999999999999999', 0.1)).toBe(0);
  });

  test('十分の一の演算と繰り返す加減算で微小残数を作らない', () => {
    expect(addScalar(0.1, 0.2, 0.1)).toBe(0.3);
    expect(subtractScalar(1, 0.9, 0.1)).toBe(0.1);
    expect(sumScalars([0.1, 0.2, 0.3, 0.4], 0.1)).toBe(1);
    expect(subtractScalar(sumScalars(Array.from({ length: 100 }, () => 0.1), 0.1), 10, 0.1)).toBe(0);
    expect(sumScalars([], 0.1)).toBe(0);
  });

  test('符号付きの計算残数と相殺を保持する', () => {
    expect(parseSignedScalar('-0.1', 0.1)).toBe(-0.1);
    expect(validateSignedScalar(-0.1, 0.1)).toBe(-0.1);
    expect(subtractScalar(0.2, 0.3, 0.1)).toBe(-0.1);
    expect(addScalar(-0.2, 0.1, 0.1)).toBe(-0.1);
    expect(sumScalars([-0.1, 0.2, -0.1], 0.1)).toBe(0);
  });

  test('整数の既存最大値を十分の一計算のために狭めない', () => {
    const max = Number.MAX_SAFE_INTEGER;
    expect(parseScalar(String(max), 1)).toBe(max);
    expect(addScalar(max - 1, 1, 1)).toBe(max);
    expect(subtractScalar(max, max - 1, 1)).toBe(1);
    expect(validateSignedScalar(-max, 1)).toBe(-max);
    expect(() => addScalar(max, 1, 1)).toThrow();
    expect(() => subtractScalar(-max, 1, 1)).toThrow();
    expect(() => parseScalar('9007199254740992', 1)).toThrow();
  });

  test('小数上限は整数になった結果にも適用する', () => {
    const max = 562949953421311.9;
    expect(parseScalar('562949953421311.9', 0.1)).toBe(max);
    expect(addScalar(562949953421311.8, 0.1, 0.1)).toBe(max);
    expect(subtractScalar(max, 562949953421311.8, 0.1)).toBe(0.1);
    expect(() => addScalar(max, 0.1, 0.1)).toThrow();
    expect(() => validateScalar(562949953421312, 0.1)).toThrow();
    expect(() => validateSignedScalar(-562949953421312, 0.1)).toThrow();
  });

  test('数値APIから渡された計算誤差と非有限値を受け入れない', () => {
    for (const value of [0.1 + 0.2, 0.05, Infinity, NaN]) {
      expect(() => validateScalar(value, 0.1)).toThrow();
      expect(() => addScalar(value, 0, 0.1)).toThrow();
    }
  });

  test('包装で使う整数倍も上限を保持する', () => {
    expect(multiplyScalarByInteger(0.1, 3, 0.1)).toBe(0.3);
    expect(multiplyScalarByInteger(1000, 3, 1)).toBe(3000);
    expect(multiplyScalarByInteger(Number.MAX_SAFE_INTEGER, 1, 1)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => multiplyScalarByInteger(Number.MAX_SAFE_INTEGER, 2, 1)).toThrow();
    expect(() => multiplyScalarByInteger(1, 0.1, 0.1)).toThrow();
    expect(() => multiplyScalarByInteger(1, -1, 1)).toThrow();
  });

  test.each([
    [281474976710655.9, 562949953421311.8, 281474976710656],
    [-281474976710655.9, -562949953421311.8, -281474976710656],
  ])('小数の整数倍は正負の上限直前を保ち、整数になった超過も拒否する: %s', (value, expected, overflow) => {
    expect(multiplyScalarByInteger(value, 2, 0.1)).toBe(expected);
    expect(() => multiplyScalarByInteger(overflow, 2, 0.1)).toThrow('数量の絶対値は562949953421311.9以下にする');
  });
});

describe('数量精度Task1・4.3: JSON原文と符号付き数量', () => {
  test('数量、負の残数、減算の符号、整数最大、原文文字列を保持する', () => {
    expect(parseExactJson('{"value":0.1,"difference":-0.1,"sign":-1,"max":9007199254740991,"step":0.1,"raw":"0.10000000000000001"}')).toEqual({ value: 0.1, difference: -0.1, sign: -1, max: Number.MAX_SAFE_INTEGER, step: 0.1, raw: '0.10000000000000001' });
  });

  test.each(['0.10000000000000001', '0.99999999999999999', '1e-999', '-1e-999', '9007199254740991.1', '1e400', '0.05'])('Number化で情報を失う数量tokenを拒否する: %s', token => {
    expect(() => parseExactJson(`{"quantity":${token}}`)).toThrow();
  });

  test('同じ十進値の科学表記と末尾0を保持する', () => {
    expect(parseExactJson('[1e-1, -0.10, 10e-1, null, true]')).toEqual([0.1, -0.1, 1, null, true]);
  });

  test('数値原文を取得できないruntimeでは拒否する', () => {
    const original = JSON.parse;
    vi.spyOn(JSON, 'parse').mockImplementation((raw, reviver) => original(raw, (key: string, value: unknown) => reviver ? reviver(key, value) : value));
    expect(() => parseExactJson('{"version":5}')).toThrow('原文を検査できない');
  });
});
