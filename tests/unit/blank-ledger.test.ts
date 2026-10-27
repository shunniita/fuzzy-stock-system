import { describe, expect, test } from 'vitest';
import { emptyLedger, practiceLedger } from '../../src/domain/ledger.ts';
import { practiceMasters } from '../../src/domain/masters.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { initial, parse, serialize } from '../../src/ui/storage.ts';

describe('P1 1.1・1.2・4.1: 空の台帳と練習用の台帳', () => {
  test('空の台帳は登録情報も空で、保存して読み直しても空のまま', () => {
    expect(emptyLedger.masters).toEqual({ items: {}, locations: {}, cases: {}, actors: {}, processes: {} });
    const original = initial(emptyLedger, emptySupply);
    expect(parse(serialize(original))).toEqual(original);
  });
  test('練習用の台帳は固定の架空登録情報だけを持ち、在庫と履歴は空', () => {
    expect(practiceLedger.masters).toBe(practiceMasters);
    expect(practiceLedger.lots).toEqual({});
    expect(practiceLedger.history).toEqual([]);
  });
});
