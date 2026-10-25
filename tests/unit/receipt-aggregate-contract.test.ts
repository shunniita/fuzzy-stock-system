import { expect, test } from 'vitest';
import { changeMasters, practiceLedger, use, type Meta } from '../../src/domain/ledger.ts';
import { requireQuantityTotals } from '../../src/domain/shortage.ts';
import { allocateArrival, emptySupply, receiveLot, recordRequest } from '../../src/domain/supply.ts';
import type { Values } from '../../src/ui/dom.ts';
import { commit, initial, load, serialize, targetsOf, type StoreLike } from '../../src/ui/storage.ts';
import { supplyOps } from '../../src/ui/supply-ui.ts';

const at = '2026-10-15T12:00:00+09:00';
const meta = (eventId: string): Meta => ({ eventId, occurredAt: `2026-10-15T10:${eventId.slice(2).padStart(2, '0')}:00+09:00`, recordedAt: at, actor: '架空担当A' });
const project = { kind: 'case', id: 'A-001' } as const;

for (const scenario of [
  { unit: '個', step: 1, prior: 9007199254740990, receipt: '2', allocation: '1' },
  { unit: 'kg', step: 0.1, prior: 562949953421311.8, receipt: '0.2', allocation: '0.1' },
] as const) {
  test(`ADR-035・2.4・3.2: ${scenario.unit}の第二割り当てで合計超過なら受け取りと第一割り当ても保存しない`, () => {
    const { unit, step, prior, receipt, allocation } = scenario;
    let ledger = changeMasters(practiceLedger, meta('op1'), { action: 'register', master: {
      type: 'item', code: 'D', name: '架空境界品目', source: null, units: [unit], unitSteps: { [unit]: step }, trial: true,
    } });
    let supply = recordRequest(emptySupply, ledger.masters, meta('op2'), { project, item: 'D', unit, quantity: prior, vendor: '架空仕入先', requestedOn: '2026-10-15', reply: { kind: 'none' } });
    supply = recordRequest(supply, ledger.masters, meta('op3'), { project, item: 'D', unit, quantity: step, vendor: '架空仕入先', requestedOn: '2026-10-15', reply: { kind: 'none' } });
    ({ ledger, supply } = receiveLot(ledger, supply, meta('op4'), { id: 'OLD', item: 'D', unit, project, location: 'S1' }, 'counted', prior));
    supply = allocateArrival(ledger, supply, meta('op5'), 'op2', { receiptLotId: 'OLD', arrived: prior, good: 0 });
    ledger = use(ledger, meta('op6'), 'OLD', 'counted', prior, '架空作業');
    const current = initial(ledger, supply);
    const data = new Map([['fuzzy-stock/head', 'A'], ['fuzzy-stock/slot-A', serialize(current)]]);
    const writes: string[] = [];
    const store: StoreLike = {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => { writes.push(key); data.set(key, value); },
      removeItem: (key) => { writes.push(key); data.delete(key); },
    };
    expect(load(store)).toMatchObject({ kind: 'ok', snapshot: current, pending: null });
    const entries: Record<string, string> = {
      newId: 'NEW', item: 'D', unit, project: 'A-001', location: 'S1', basis: 'counted', value: receipt,
      r1request: 'op2', r1arrived: allocation, r1good: '0', r2request: 'op3', r2arrived: allocation, r2good: '0',
    };
    const values: Values = { text: (name) => entries[name] ?? '', checked: () => false, step: () => step };
    const receive = supplyOps({ ledger: () => ledger, supply: () => supply })['receive'];
    if (receive === undefined) throw new Error('受け取り操作が必要');
    const result = receive.run({ ledger, supply }, meta('op7'), values, undefined);
    const states = result.units;
    if (states === undefined || states.length !== 3) throw new Error('受け取りと割り当て二行の三単位が必要');
    expect(result.notice).toBeUndefined();
    for (const state of states.slice(0, 2)) expect(() => requireQuantityTotals(state.ledger, state.supply)).not.toThrow();
    expect(() => requireQuantityTotals(result.state.ledger, result.state.supply)).toThrow('届いた数の合計が上限を超える');
    let before = { ledger, supply };
    const units = states.map(state => {
      const unitState = { ...state, conflictReviews: current.conflictReviews, targets: targetsOf(before, state) };
      before = state;
      return unitState;
    });
    const savedBytes = [...data];
    const op = { opId: 'op7', opLabel: receive.label, fingerprint: '架空受け取りと二行割り当て', values: entries, actor: '架空担当A', startedAt: at, savingSince: at };
    expect(commit(store, current, op, units)).toMatchObject({ kind: 'failed', reason: expect.stringContaining('届いた数の合計が上限を超える') });
    expect(writes).toEqual([]);
    expect([...data]).toEqual(savedBytes);
    expect(load(store)).toMatchObject({ kind: 'ok', snapshot: current, pending: null });

    // 合計がちょうど上限なら、同じ受け取りと第一割り当てを一回だけ確定できる。
    const accepted = commit(store, current, op, units.slice(0, 2));
    expect(accepted.kind).toBe('saved');
    if (accepted.kind !== 'saved') throw new Error('上限内の受け取りが保存されなかった');
    expect(accepted.snapshot.supply.receipts['NEW']?.received).toBe(Number(receipt));
    expect(accepted.snapshot.supply.requests['op2']?.arrivals).toHaveLength(2);
    expect(accepted.snapshot.supply.requests['op3']?.arrivals).toEqual([]);
    const after = [...data];
    expect(commit(store, accepted.snapshot, op, units.slice(0, 2)).kind).toBe('duplicate');
    expect([...data]).toEqual(after);
  });
}
