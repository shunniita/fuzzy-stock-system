import { expect, test } from 'vitest';
import type { Ledger } from '../../src/domain/ledger.ts';
import { readBackup } from '../../src/ui/backup.ts';
import { load } from '../../src/ui/storage.ts';
import { decodePending, decodeSnapshot } from '../../src/ui/storageparse.ts';
import { precisionV5Cases } from '../fixtures/precision-v5/cases.ts';

const wireHashes = {
  snapshot: 'e87fe1323daf1a7a6ee44999796c5123fa7fd738a2eaa645f718dc6fc70dce2b',
  pending: '3d234e6f813df049b7ae23dca10fd1126f935e03509695e83baf152bed7ff883',
  backup: '1d1ee094f61df24791147edcab479cc6b6d725d0190bc556236c1cc3bd3b9967',
};

function checkLedger(ledger: Ledger, value: number): void {
  expect(ledger.masters.items['D']?.unitSteps).toEqual({ kg: 0.1 });
  expect(ledger.lots['V5']).toMatchObject({ item: 'D', unit: 'kg', quantity: { kind: 'known', numeric: { value } } });
  expect(ledger.history[0]).toMatchObject({ kind: 'master', action: 'register', masters: [{ after: { id: 'D', unitSteps: { kg: 0.1 } } }] });
  expect(ledger.history.map(event => event.eventId)).toEqual(value === 2 ? ['op1', 'op2'] : ['op1', 'op2', 'op3']);
}

for (const c of precisionV5Cases) {
  test(`4.4: 固定版5 ${c.kind}の原文は検証済みwriterのhashと一致する`, async () => {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(c.wire));
    expect(Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')).toBe(wireHashes[c.kind]);
  });

  test(`4.4: 固定版5 ${c.kind}を現decoderが精度・数量・履歴を保って読む`, () => {
    const input: unknown = JSON.parse(c.wire), before = JSON.stringify(input);
    if (c.kind === 'snapshot') {
      const snapshot = decodeSnapshot(input);
      expect(snapshot.version).toBe(11);
      checkLedger(snapshot.ledger, 2);
      const data = new Map([['fuzzy-stock/head', 'A'], ['fuzzy-stock/slot-A', c.wire]]);
      const bytes = [...data];
      let writes = 0;
      const refuse = () => { writes++; throw new Error('読取は書き換えない'); };
      expect(load({ getItem: key => data.get(key) ?? null, setItem: refuse, removeItem: refuse })).toMatchObject({ kind: 'ok', snapshot, pending: null });
      expect(writes).toBe(0);
      expect([...data]).toEqual(bytes);
    } else if (c.kind === 'pending') {
      const pending = decodePending(input);
      expect(pending).toMatchObject({ progress: 'partial', opId: 'op50', values: { 原文: '002\r\n' } });
      expect(pending.units).toHaveLength(2);
      pending.units.forEach((unit, index) => checkLedger(unit.ledger, index === 0 ? 2 : 1));
      expect(pending.units.map(unit => unit.targets)).toEqual([['品目D', 'まとまりV5'], ['まとまりV5']]);
    } else {
      const bytes = new TextEncoder().encode(c.wire), original = bytes.slice();
      const result = readBackup(bytes);
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') throw new Error('版5backupが読めない');
      checkLedger(result.snapshot.ledger, 2);
      expect(bytes).toEqual(original);
    }
    expect(JSON.stringify(input)).toBe(before);
  });
}
