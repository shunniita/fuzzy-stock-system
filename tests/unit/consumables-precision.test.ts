import { describe, expect, test } from 'vitest';
import { practiceLedger, register, type Ledger } from '../../src/domain/ledger.ts';
import { replenishmentOf, stockOf } from '../../src/domain/packaging.ts';
import { multiplyScalarByInteger, type Step } from '../../src/domain/scalar.ts';
import { emptySupply } from '../../src/domain/supply.ts';

function ledger(pieceStep: Step, boxStep: Step, perBox = 10): Ledger {
  const item = practiceLedger.masters.items.S!;
  return { ...practiceLedger, masters: { ...practiceLedger.masters, items: { ...practiceLedger.masters.items,
    S: { ...item, unitSteps: { 本: pieceStep, 箱: boxStep }, packaging: { boxUnit: '箱', pieceUnit: '本', perBox: [{ from: null, value: perBox }] } },
  } } };
}

function add(l: Ledger, id: string, unit: string, value: number): Ledger {
  return register(l, { eventId: id, actor: '架空担当A', occurredAt: '2026-10-02T08:00:00+09:00', recordedAt: '2026-10-02T08:00:00+09:00' },
    { id, item: 'S', unit, project: { kind: 'common' }, location: 'S1' }, 'counted', value);
}
const stock = (l: Ledger) => stockOf(l, emptySupply, 'S', '本');

describe('共通消耗品 3.1–3.4: 単位ごとの精度を保った換算', () => {
  test('入力と出力の最小単位を別々に検査する', () => {
    expect(multiplyScalarByInteger(0.1, 10, 0.1, 1)).toBe(1);
    expect(multiplyScalarByInteger(562949953421311.9, 10, 0.1, 1)).toBe(5629499534213119);
    expect(() => multiplyScalarByInteger(0.1, 3, 0.1, 1)).toThrow();
    expect(() => multiplyScalarByInteger(0.1, 10, 1, 1)).toThrow();
  });

  test('0.1本と0.2本を0.3本に合計し、元の数量を保つ', () => {
    const l = add(add(ledger(0.1, 1), 'A', '本', 0.1), 'B', '本', 0.2);
    const before = JSON.stringify(l);
    expect(stock(l).pieces).toMatchObject({ kind: 'known', numeric: { value: 0.3, unconfirmed: 'none' } });
    expect(stock(l).unconverted).toEqual([]);
    expect(JSON.stringify(l)).toBe(before);
  });

  test.each([[1, 0.1, 10, 1], [0.1, 0.3, 3, 0.9], [1, 562949953421311.9, 10, 5629499534213119]] as const)
  ('%s単位へ箱数%s×%sを換算する', (pieceStep, count, perBox, expected) => {
    const l = add(ledger(pieceStep, 0.1, perBox), 'BOX', '箱', count);
    const result = stock(l);
    expect(result.pieces).toMatchObject({ kind: 'known', numeric: { value: expected, unconfirmed: 'all' } });
    expect(result.unconverted).toEqual([]);
    expect(result.pieces?.terms[0]?.observation.basis).toBe('label');
    expect(l.lots.BOX?.quantity).toMatchObject({ kind: 'known', numeric: { value: count, unconfirmed: 'none' } });
  });

  test('出力の最小単位に合わない換算は精度上限と区別し、補充の確認を残す', () => {
    const result = stock(add(add(ledger(1, 0.1, 3), 'A', '本', 100), 'BOX', '箱', 0.1));
    expect(result.pieces).toMatchObject({ kind: 'known', numeric: { value: 100 } });
    expect(result.unconverted.map(l => l.id)).toEqual(['BOX']);
    expect(result.stepMismatched.map(l => l.id)).toEqual(['BOX']);
    expect(result.precisionLimited).toEqual([]);
    expect(replenishmentOf(result, { item: 'S', pieceUnit: '本', threshold: 1, standardOrder: { value: 1, unit: '箱' } })).toMatchObject({ kind: 'replenishCheck', hasUnknown: true });
  });

  test('小数の合計上限を超えた分は元の数量のまま残す', () => {
    const result = stock(add(add(ledger(0.1, 1), 'A', '本', 562949953421311.9), 'B', '本', 0.1));
    expect(result.pieces).toMatchObject({ kind: 'known', numeric: { value: 562949953421311.9 } });
    expect(result.precisionLimited.map(l => l.id)).toEqual(['B']);
    expect(result.unconverted[0]?.quantity).toMatchObject({ numeric: { value: 0.1 } });
  });
});
