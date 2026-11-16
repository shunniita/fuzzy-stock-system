import { describe, expect, test } from 'vitest';
import { practiceLedger, productionOf, type Meta } from '../../src/domain/ledger.ts';
import type { Values } from '../../src/ui/dom.ts';
import { overdrawnLots, registerFromValues, type WarningRow } from '../../src/ui/fields.ts';

describe('数量の超過の注意', () => {
  const at = '2026-10-05T10:00:00+09:00';
  const stock = (basis: string) => registerFromValues(practiceLedger, meta, values({ value: '50', basis }));
  const row = (value: string, basis = 'counted'): WarningRow => ({ lot: 'W1', basis, value, inclusion: null });
  const shown = (result: ReturnType<typeof overdrawnLots>) => result.map(lot => lot?.quantity.kind === 'known' ? lot.quantity.numeric.value : null);

  test('記録上の数を超える行だけに、差し引く前の数を返す', () => {
    expect(shown(overdrawnLots(stock('counted'), [row('60')], at))).toEqual([50]);
    expect(shown(overdrawnLots(stock('counted'), [row('50')], at))).toEqual([null]);
  });

  test('同じ保管単位の行は実行順に差し引き、超過した行は残数を減らさない', () => {
    expect(shown(overdrawnLots(stock('counted'), [row('30'), row('30'), row('20')], at))).toEqual([null, 20, null]);
  });

  test('だいたいの数・未入力の行は注意しない', () => {
    expect(shown(overdrawnLots(stock('approximate'), [row('60')], at))).toEqual([null]);
    expect(shown(overdrawnLots(stock('counted'), [row('')], at))).toEqual([null]);
  });
});

const meta: Meta = { eventId: 'initial', occurredAt: '2026-10-05T09:00:00+09:00', recordedAt: '2026-10-05T09:00:00+09:00', actor: '架空担当A' };
const values = (extra: Record<string, string> = {}): Values => {
  const entries: Record<string, string> = { newId: 'W1', item: 'R', unit: '台', project: 'A-001', location: 'T', basis: 'counted', value: '12', ...extra };
  return { text: (name) => entries[name] ?? '', checked: () => false };
};

describe('B3 8.1・8.2・FH-B05: 開始時点の現物の登録', () => {
  test.each(['working', 'inspecting', 'awaitingHandover'])('%sの位置で初期登録し、作業の開始・使用・完了の過去を作らない', (stage) => {
    const ledger = registerFromValues(practiceLedger, meta, values({ stage, process: 'R組立', basis: 'approximate' }));
    expect(ledger.lots['W1']?.stage).toEqual({ kind: stage, process: { id: 'R組立', criterion: 'inspection' } });
    expect(ledger.history.map((event) => event.kind)).toEqual(['register']);
    const production = productionOf(ledger, 'R組立', 'R', '台', { kind: 'case', id: 'A-001' });
    const positioned = stage === 'working' ? production.working : stage === 'inspecting' ? production.inspecting : production.awaitingHandover;
    expect(positioned).toMatchObject({ kind: 'known', numeric: { value: 12, approximate: true } });
    expect(production.completed).toMatchObject({ kind: 'known', numeric: { value: 0 } });
    expect(production.handedOver).toMatchObject({ kind: 'known', numeric: { value: 0 } });
  });

  test('数が不明の工程完了品も、0へ変えずその位置で登録する', () => {
    const ledger = registerFromValues(practiceLedger, meta, values({ stage: 'awaitingHandover', process: 'R組立', basis: 'unknown', value: '' }));
    expect(ledger.lots['W1']?.quantity.kind).toBe('unknown');
    expect(productionOf(ledger, 'R組立', 'R', '台', { kind: 'case', id: 'A-001' }).awaitingHandover.kind).toBe('unknown');
    expect(ledger.history.map((event) => event.kind)).toEqual(['register']);
  });

  test('作業なしと旧入力（位置の欄なし）は工程を要求せず、残った工程の入力を無視する', () => {
    for (const stage of ['', 'none']) {
      const ledger = registerFromValues(practiceLedger, meta, values({ stage, process: '存在しない工程' }));
      expect(ledger.lots['W1']?.stage).toEqual({ kind: 'none' });
      expect(ledger.history.map((event) => event.kind)).toEqual(['register']);
    }
    expect(registerFromValues(practiceLedger, meta, values()).lots['W1']?.stage).toEqual({ kind: 'none' });
  });

  test('工程に載せるときは実在する工程を要求し、不正な位置も拒否する', () => {
    expect(() => registerFromValues(practiceLedger, meta, values({ stage: 'working' }))).toThrow('工程');
    expect(() => registerFromValues(practiceLedger, meta, values({ stage: 'inspecting', process: '存在しない工程' }))).toThrow('工程');
    expect(() => registerFromValues(practiceLedger, meta, values({ stage: 'finished', process: 'R組立' }))).toThrow('作業の状態');
    expect(practiceLedger.history).toEqual([]);
  });
});
