import { describe, expect, test } from 'vitest';
import { add, observe, quantityOf, subtract, sumQuantities, type Basis, type Quantity } from '../../src/domain/quantity.ts';
import type { Step } from '../../src/domain/scalar.ts';

// 乱数は固定の種から作り、失敗した組み合わせを再現できるようにする。
function random(seed: number) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
}

function quantities(seed: number, length: number, step: Step): Quantity[] {
  const next = random(seed);
  const value = () => step === 1 ? Math.floor(next() * 50) : Math.floor(next() * 500) / 10;
  const one = (id: string): Quantity => {
    const basis = (['counted', 'label', 'approximate', 'unknown'] as const satisfies readonly Basis[])[Math.floor(next() * 4)]!;
    return quantityOf(observe(id, basis, basis === 'unknown' ? null : value(), step));
  };
  return Array.from({ length }, (_, i) => {
    const kind = next();
    // 観測そのもの・足した計算値・引いた計算値（不明の前の数量を持つものを含む）を混ぜる。
    if (kind < 0.5) return one(`q${i}`);
    if (kind < 0.8) return add(one(`a${i}`), one(`b${i}`), step);
    return subtract(add(one(`c${i}`), one(`d${i}`), step), one(`e${i}`), step);
  });
}

describe('数量の合計（sumQuantities）', () => {
  test('空なら計算上の0で、根拠を持たない', () => {
    expect(sumQuantities([], 1)).toEqual({ kind: 'known', numeric: { value: 0, approximate: false, unconfirmed: 'none' }, computed: true, terms: [] });
  });

  test('1件ならその数量をそのまま返す（計算値にしない）', () => {
    const only = quantityOf(observe('L1', 'label', 3));
    expect(sumQuantities([only], 1)).toBe(only);
  });

  test.each([1, 0.1] as const)('左から順に add で足した結果と、根拠・不明部分・並びまで同じ（最小単位 %s）', (step) => {
    for (let seed = 1; seed <= 200; seed++) {
      const list = quantities(seed, 2 + (seed % 9), step);
      expect(sumQuantities(list, step), `seed ${seed}`).toEqual(list.reduce((total, quantity) => add(total, quantity, step)));
    }
  });

  test('最小単位に合わない数量は add と同じ文で拒否する', () => {
    const list = [quantityOf(observe('E1', 'counted', 1)), quantityOf(observe('E2', 'counted', 0.5, 0.1))];
    expect(() => list.reduce((total, quantity) => add(total, quantity, 1))).toThrow();
    const expected = (() => { try { list.reduce((total, quantity) => add(total, quantity, 1)); } catch (error) { return (error as Error).message; } })();
    expect(() => sumQuantities(list, 1)).toThrow(expected);
  });

  test('上限を超える合計は add と同じ文で拒否する', () => {
    const big = quantityOf(observe('E1', 'counted', Number.MAX_SAFE_INTEGER));
    const list = [big, quantityOf(observe('E2', 'counted', 1)), quantityOf(observe('U', 'unknown', null))];
    const expected = (() => { try { list.reduce((total, quantity) => add(total, quantity, 1)); } catch (error) { return (error as Error).message; } })();
    expect(expected).toBeDefined();
    expect(() => sumQuantities(list, 1)).toThrow(expected);
  });
});
