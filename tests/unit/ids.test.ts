import { fixedMasters } from '../../src/domain/masters.ts';
import { describe, expect, test } from 'vitest';
import { practiceLedger, register, type Meta } from '../../src/domain/ledger.ts';
import { emptySupply, receiveLot, registerNeed } from '../../src/domain/supply.ts';
import { baseEventId, suffixed } from '../../src/ui/supply-ui.ts';

function meta(eventId: string): Meta {
  const at = '2026-10-02T09:00:00+09:00';
  return { eventId, occurredAt: at, recordedAt: at, actor: '架空担当A' };
}

const lot = (id: string) => ({ id, item: 'P', unit: '個', project: { kind: 'case', id: 'B-001' } as const, location: 'S1' });

describe('画面の操作ID（台帳とSupplyの記録でIDが重ならない）', () => {
  test('基本IDは台帳の履歴とSupplyの履歴の件数の和から付ける。接尾辞は基本IDの後ろに付ける', () => {
    expect(baseEventId(practiceLedger, emptySupply)).toBe('op1');
    expect(suffixed('op7', 'a1')).toBe('op7-a1');
  });

  test('台帳だけ・Supplyだけを変える入力を交互に行っても、基本IDは重ならない。一回の入力が複数の記録を作っても重ならない', () => {
    let ledger = practiceLedger;
    let supply = emptySupply;
    const seen = new Set<string>();
    const take = (id: string) => {
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    };
    // 台帳だけの入力
    let base = baseEventId(ledger, supply);
    take(base);
    ledger = register(ledger, meta(base), lot('L1'), 'counted', 5);
    // Supplyだけの入力
    base = baseEventId(ledger, supply);
    take(base);
    supply = registerNeed(supply, fixedMasters, meta(base), { project: { kind: 'case', id: 'B-001' }, item: 'P', unit: '個', required: { basis: 'counted', value: 10 }, dueDate: null, source: '架空', revision: '初版' });
    // 台帳とSupplyの両方に記録が残る入力（受け取り：登録と実際に受け取った数の記録）
    base = baseEventId(ledger, supply);
    take(base);
    take(suffixed(base, 'c'));
    const r = receiveLot(ledger, supply, meta(base), lot('R1'), 'counted', 3);
    ledger = r.ledger;
    supply = r.supply;
    expect(supply.log.at(-1)?.eventId).toBe(suffixed(base, 'c'));
    // 次の入力の基本IDは、直前の基本IDと接尾辞つきのIDのどれとも重ならない
    base = baseEventId(ledger, supply);
    take(base);
    expect(base).toBe('op5');
  });
});
