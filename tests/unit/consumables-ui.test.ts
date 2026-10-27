import { describe, expect, test } from 'vitest';
import { changeMasters, practiceLedger } from '../../src/domain/ledger.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { masterOps } from '../../src/ui/master-ui.ts';
import type { Values } from '../../src/ui/dom.ts';
import { operationGroups } from '../../src/ui/operation-picker.ts';

const at = '2026-10-02T10:00:00+09:00';
const meta = (eventId: string) => ({ eventId, occurredAt: at, recordedAt: at, actor: '架空担当A' });
const base = () => ({ ledger: changeMasters(practiceLedger, meta('item'), { action: 'register', master: { type: 'item', code: 'D', name: '架空消耗品', units: ['個', '袋'], unitSteps: { 個: 0.1, 袋: 1 }, source: null, trial: true } }), supply: emptySupply });
const values = (entries: Record<string, string | boolean>): Values => ({ text: key => typeof entries[key] === 'string' ? entries[key] : '', checked: key => entries[key] === true });

describe('共通消耗品1.6・3.1: 設定入力', () => {
  test('包装未設定の品目と、設定済みの入り数変更を同じ操作から使う', () => {
    const state = base(), ops = masterOps({ ledger: () => state.ledger, supply: () => state.supply });
    const first = ops.masterPerBox!.run(state, meta('pack'), values({ target: 'item:D', boxUnit: '袋', pieceUnit: '個', perBox: '0010', reason: '包装確認' }), undefined).state;
    expect(first.ledger.masters.items.D?.packaging?.perBox).toEqual([{ from: null, value: null }, { from: at, value: 10 }]);
    const later = { ...meta('changed'), occurredAt: '2026-10-02T11:00:00+09:00', recordedAt: '2026-10-02T11:00:00+09:00' };
    const changed = ops.masterPerBox!.run(first, later, values({ target: 'item:D', perBox: '20', reason: '包装変更' }), undefined).state;
    expect(changed.ledger.masters.items.D?.packaging?.perBox.at(-1)?.value).toBe(20);
  });

  test.each(['threshold', 'standardOrderValue'])('%sの原文をNumberで丸めずに拒否し、履歴と入力を保つ', field => {
    const state = base(), before = JSON.stringify(state);
    const entries = { target: 'item:D', consumableEnabled: true, pieceUnit: '個', replenishmentEnabled: true, threshold: '0.3', standardOrderValue: '0.1', standardOrderUnit: '個', reason: '設定', [field]: '0.10000000000000001' };
    const op = masterOps({ ledger: () => state.ledger, supply: () => state.supply }).masterConsumable;
    expect(op).toBeDefined();
    expect(() => op!.run(state, meta('cfg'), values(entries), undefined)).toThrow('最小単位');
    expect(JSON.stringify(state)).toBe(before);
    expect(entries[field]).toBe('0.10000000000000001');
  });

  test('指定解除と基準なしでは不要な数値を読まない', () => {
    let state = base();
    const op = masterOps({ ledger: () => state.ledger, supply: () => state.supply }).masterConsumable!;
    state = op.run(state, meta('cfg'), values({ target: 'item:D', consumableEnabled: true, pieceUnit: '個', replenishmentEnabled: false, threshold: '不正な残入力', reason: '対象へ' }), undefined).state;
    expect(state.ledger.masters.items.D?.consumable).toEqual({ pieceUnit: '個', rule: null });
    state = op.run(state, meta('clear'), values({ target: 'item:D', consumableEnabled: false, pieceUnit: '不正な残入力', reason: '解除' }), undefined).state;
    expect(state.ledger.masters.items.D?.consumable).toBeNull();
  });

  test('登録情報の分類は12操作までで重複しない', () => {
    const masters = operationGroups.find(group => group.id === 'masters')!;
    expect(masters.keys).toContain('masterConsumable');
    expect(masters.keys.length).toBeLessThanOrEqual(12);
    expect(new Set(masters.keys).size).toBe(masters.keys.length);
  });
});
