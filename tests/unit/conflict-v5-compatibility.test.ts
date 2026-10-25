import { describe, expect, test } from 'vitest';
import type { Ledger } from '../../src/domain/ledger.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { readBackup } from '../../src/ui/backup.ts';
import { inquire, load, parse, retry, type SaveCheck, type StoreLike } from '../../src/ui/storage.ts';
import { conflictV5 } from '../fixtures/conflict-v5/cases.ts';

const at = '2026-10-16T06:00:00+09:00';
const later = '2026-10-16T06:01:00+09:00';
const fingerprint = '["架空の二段階使用",[["原文"," 001.3\\r\\n"],["未確認",false]]]';
const oldCheck: SaveCheck = { opId: 'op10', opLabel: '架空の二段階使用', savedTargets: ['まとまりinteger'], unsavedTargets: [],
  attempt: JSON.stringify(['op10', at, fingerprint]), openedAt: at, resolution: { outcome: 'saved', actor: '架空の旧確認者', at: later } };
const hashes = {
  snapshot: '31a8ce0a0f2e4e2b76fe7596023d742f4a86ff5173093e05d2c1c39be383b766',
  backup: 'b0d404ba142cf835925e9b477f75c25bf3c7554545dae7e71665f31c78fd74da',
  unwritten: 'd447e891ce272e2276d614f96c7fe2c813869c59c617f74f29911728c335d7c0',
  partial: 'ccd29c6c07a5f2a05d0a996b030adb5588ea4b71a21857e2d734358e981168de',
  allSaved: '09c1c2b610f59768c3ff3111ef6603e2174af82918ebba098d09c95af2e8a3ba',
};
async function sha(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
function storeOf(data: Readonly<Record<string, string>>, readonly = true) {
  const stored = new Map(Object.entries(data));
  let writes = 0;
  const beforeWrite = () => { writes++; if (readonly) throw new Error('読込で保存先を変えない'); };
  return { stored, writes: () => writes, getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { beforeWrite(); stored.set(key, value); },
    removeItem: (key: string) => { beforeWrite(); stored.delete(key); },
  } satisfies StoreLike & { stored: Map<string, string>; writes(): number };
}
function checkLedger(ledger: Ledger, saved: number): void {
  expect(ledger.masters.items['D']?.unitSteps).toEqual({ kg: 0.1 });
  expect(ledger.lots['decimal']?.quantity).toMatchObject({ kind: 'known', numeric: { value: saved === 0 ? 1.3 : 1.2 } });
  expect(ledger.lots['integer']?.quantity).toMatchObject({ kind: 'known', numeric: { value: saved === 2 ? 6 : 7 } });
  expect(ledger.lots['unknown']?.quantity).toEqual({ kind: 'unknown', before: null, terms: [{ sign: 1, observation: { id: 'op3', basis: 'unknown', value: null } }] });
  expect(ledger.history.map(e => e.eventId)).toEqual(['op1', 'op2', 'op3', 'op4', 'op10', ...['op11-1', 'op11-2'].slice(0, saved)]);
  expect(ledger.history.every(e => e.actor === '架空の元担当' && e.occurredAt === at && e.recordedAt === at)).toBe(true);
}

describe('競合保持5.1: 版6導入前の固定版5基準', () => {
  test.each(['snapshot', 'backup'] as const)('%sの固定原文は旧writerの検証済みhashと一致する', async kind => {
    expect(await sha(conflictV5[kind])).toBe(hashes[kind]);
  });

  test('旧snapshotの小数・不明・履歴・過去の保存確認を読み、保存先を変えない', () => {
    const snapshot = parse(conflictV5.snapshot);
    checkLedger(snapshot.ledger, 0);
    expect(snapshot.supply).toEqual(emptySupply);
    expect(snapshot.saveChecks).toEqual([oldCheck]);
    expect(snapshot.ops).toEqual({ op10: { fingerprint, units: [['op10']] } });
    const store = storeOf({ 'fuzzy-stock/head': 'A', 'fuzzy-stock/slot-A': conflictV5.snapshot, unrelated: 'そのまま' });
    const before = [...store.stored];
    expect(load(store)).toEqual({ kind: 'ok', snapshot, pending: null, recovered: null });
    expect(store.writes()).toBe(0);
    expect([...store.stored]).toEqual(before);
  });

  test('旧backupの原bytesと元担当・保存確認者を保つ', () => {
    const raw = new TextEncoder().encode(conflictV5.backup), before = raw.slice();
    const loaded = readBackup(raw);
    expect(loaded.kind).toBe('ok');
    if (loaded.kind !== 'ok') throw new Error('固定版5backupを読めない');
    checkLedger(loaded.snapshot.ledger, 0);
    expect(loaded.snapshot.saveChecks).toEqual([oldCheck]);
    expect(loaded.snapshot).toEqual(parse(conflictV5.snapshot));
    expect(raw).toEqual(before);
  });

  for (const c of conflictV5.cases) {
    test(`${c.mode}: 全保存keyの固定原文が検証済みhashと一致する`, async () => {
      expect(await sha(JSON.stringify(c.data))).toBe(hashes[c.mode]);
    });

    test(`${c.mode}: 保存済み${c.savedUnits}/2を数量・履歴・候補から区別し、読込と照会は無書込`, () => {
      const store = storeOf(c.data), before = [...store.stored];
      const result = load(store);
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok' || result.pending === null) throw new Error('固定pendingを読めない');
      const { snapshot, pending } = result;
      expect(inquire(store, pending)).toEqual({ snapshot, savedUnits: c.savedUnits, total: 2 });
      checkLedger(snapshot.ledger, c.savedUnits);
      expect(snapshot.supply).toEqual(emptySupply);
      expect(snapshot.saveChecks).toEqual([oldCheck]);
      expect(snapshot.revision).toBe(2 + c.savedUnits);
      expect(snapshot.opFloor).toBe(c.savedUnits === 0 ? 11 : 12);
      expect(snapshot.ops['op10']).toEqual({ fingerprint, units: [['op10']] });
      expect(snapshot.ops['op11']).toEqual(c.savedUnits === 0 ? undefined : { fingerprint, units: [['op11-1'], ['op11-2']].slice(0, c.savedUnits) });
      expect(pending).toMatchObject({ progress: c.mode === 'partial' ? 'partial' : 'saving', unknownSince: null, savingSince: at,
        baseRevision: 2, opId: 'op11', opLabel: '架空の二段階使用', fingerprint,
        values: { 原文: ' 001.3\r\n', 未確認: false }, actor: '架空の元担当', startedAt: at });
      expect(pending.units).toHaveLength(2);
      pending.units.forEach((unit, index) => { checkLedger(unit.ledger, index + 1); expect(unit.supply).toEqual(emptySupply); });
      expect(pending.units.map(unit => unit.targets)).toEqual([['まとまりdecimal'], ['まとまりinteger']]);
      expect(store.writes()).toBe(0);
      expect([...store.stored]).toEqual(before);
    });

    test(`${c.mode}: 旧pendingを再試行しても保存済み分を重ねず、既存確認履歴を保持する`, () => {
      const store = storeOf(c.data, false), loaded = load(store);
      if (loaded.kind !== 'ok' || loaded.pending === null) throw new Error('固定pendingを読めない');
      const result = retry(store, loaded.snapshot, loaded.pending, '架空の再確認者', '2026-10-16T06:02:00+09:00');
      expect(result.kind).toBe(c.mode === 'allSaved' ? 'recovered' : 'saved');
      const after = load(store);
      if (after.kind !== 'ok') throw new Error('再試行後を読めない');
      checkLedger(after.snapshot.ledger, 2);
      expect(after.pending).toBeNull();
      expect(after.snapshot.saveChecks[0]).toEqual(oldCheck);
      expect(after.snapshot.ops['op11']).toEqual({ fingerprint, units: [['op11-1'], ['op11-2']] });
      expect(store.getItem('unrelated')).toBe('架空の別保存');
    });
  }
});
