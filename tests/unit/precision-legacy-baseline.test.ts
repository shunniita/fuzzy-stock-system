import { describe, expect, test } from 'vitest';
import type { Ledger } from '../../src/domain/ledger.ts';
import { fixedMasters } from '../../src/domain/masters.ts';
import { crc32, readBackup } from '../../src/ui/backup.ts';
import { load, parse, type StoreLike } from '../../src/ui/storage.ts';
import { decodePending, decodeSnapshot } from '../../src/ui/storageparse.ts';
import { legacyPrecisionCases } from '../fixtures/precision-legacy/cases.ts';

const snapshots = legacyPrecisionCases.filter(c => c.kind === 'snapshot');
const pendingCases = legacyPrecisionCases.filter(c => c.kind === 'pending');
const v4 = legacyPrecisionCases.find(c => c.id === 'snapshot-v4')!;
const backup = legacyPrecisionCases.find(c => c.kind === 'backup')!;
const bytes = (text: string) => new TextEncoder().encode(text);
const readonlyStore = (wire: string) => {
  const data = new Map([['fuzzy-stock/head', 'A'], ['fuzzy-stock/slot-A', wire], ['unrelated', '架空の保持値']]);
  let writes = 0;
  const refuse = () => { writes++; throw Error('読取で保存を書き換えない'); };
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: refuse, removeItem: refuse, writes: () => writes } satisfies StoreLike & { data: Map<string, string>; writes(): number };
};
function checkLegacyLedger(actual: Ledger, expected: Pick<Ledger, 'lots' | 'history'> & Partial<Pick<Ledger, 'masters'>>, value = 8): void {
  expect(actual.lots).toEqual(expected.lots);
  expect(actual.history).toMatchObject(expected.history);
  expect(actual.history.map(e => e.eventId)).toEqual(expected.history.map(e => e.eventId));
  expect(actual.masters).toMatchObject(expected.masters ?? fixedMasters);
  expect(actual.lots['legacy-known']?.quantity).toMatchObject({ kind: 'known', numeric: { value }, computed: true });
  expect(actual.lots['legacy-unknown']?.quantity).toMatchObject({ kind: 'unknown', before: null, terms: [{ sign: 1, observation: { id: 'legacy-unknown', basis: 'unknown', value: null } }] });
}
type RawLedger = { lots: Record<string, { quantity: unknown }>; history: { kind: string; action?: string; masters?: { before: Record<string, unknown> }[] }[] };
type RawPending = { units: { ledger: RawLedger }[] };
function pendingBody(value: { pending?: RawPending } & Partial<RawPending>): RawPending {
  return value.pending ?? value as RawPending;
}
function addTrialKey(ledger: RawLedger): void {
  const trial = ledger.history.find(e => e.kind === 'master' && e.action === 'trial');
  if (!trial?.masters?.[0]) throw Error('固定fixtureに試行履歴が必要');
  trial.masters[0].before['legacyExtra'] = '黙って捨てない';
}
function rejectsSnapshot(wire: string): void {
  const input: unknown = JSON.parse(wire), before = JSON.stringify(input);
  expect(() => decodeSnapshot(input)).toThrow();
  expect(JSON.stringify(input)).toBe(before);
  const store = readonlyStore(wire), stored = [...store.data];
  expect(load(store).kind).toBe('unreadable');
  expect(store.writes()).toBe(0);
  expect([...store.data]).toEqual(stored);
}

describe('数量精度Task2の準備：固定した旧writerの整数記録', () => {
  test.each(snapshots)('$id: 原文を作り直さず読め、数量・根拠・履歴と保存bytesを保つ', c => {
    const input: unknown = JSON.parse(c.wire), before = JSON.stringify(input);
    const expected = JSON.parse(c.expected) as Pick<Ledger, 'lots' | 'history'>;
    checkLegacyLedger(decodeSnapshot(input).ledger, expected);
    expect(JSON.stringify(input)).toBe(before);
    const store = readonlyStore(c.wire), stored = [...store.data];
    const loaded = load(store);
    expect(loaded.kind).toBe('ok');
    if (loaded.kind === 'ok') checkLegacyLedger(loaded.snapshot.ledger, expected);
    expect(store.writes()).toBe(0);
    expect([...store.data]).toEqual(stored);
  });

  test('版4の固定backupは包みの原bytesと試行当時の確認・前後値を保つ', () => {
    const input = bytes(backup.wire), before = input.slice(), restored = readBackup(input);
    expect(restored.kind).toBe('ok');
    if (restored.kind === 'ok') {
      checkLegacyLedger(restored.snapshot.ledger, JSON.parse(backup.expected));
      expect(restored.snapshot.ledger.history.at(-1)).toMatchObject({ kind: 'master', action: 'trial', review: { restore: '復元手順を確認\r\n実運用承認ではない' }, masters: [{ before: { id: 'X', trial: false }, after: { id: 'X', trial: true } }] });
    }
    expect(input).toEqual(before);
  });

  test.each(pendingCases)('$id: 最初だけでなく全二単位の数量・履歴・対象を保持', c => {
    const input: unknown = JSON.parse(c.wire), before = JSON.stringify(input);
    const decoded = decodePending(input);
    const expected = JSON.parse(c.expected) as { units: (Pick<Ledger, 'lots' | 'history'> & Partial<Pick<Ledger, 'masters'>>)[]; targets: string[][] };
    expect(decoded.units).toHaveLength(2);
    decoded.units.forEach((unit, index) => {
      checkLegacyLedger(unit.ledger, expected.units[index]!, c.sourceVersion === 2 && index === 1 ? 7 : 8);
      expect(unit.targets).toEqual(expected.targets[index]);
    });
    expect(decoded.progress).toBe('partial');
    expect(decoded.values).toEqual(c.sourceVersion === 2 ? { 原文: '007\r\n' } : { 五確認: '復元手順を確認\r\n実運用承認ではない' });
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('固定した旧入力の破損を無変更で拒否する', () => {
  test.each(snapshots)('$id: 壊れた数量を読まず、旧保存の初期化・上書きをしない', c => {
    const input = JSON.parse(c.wire) as { ledger: RawLedger };
    input.ledger.lots['legacy-known']!.quantity = { kind: 'not-a-quantity' };
    rejectsSnapshot(JSON.stringify(input));
  });

  for (const c of pendingCases) for (const index of [0, 1]) {
    test(`${c.id}: 単位${index + 1}だけが壊れていてもpending全体を拒否`, () => {
      const input = JSON.parse(c.wire) as { pending?: RawPending } & Partial<RawPending>;
      pendingBody(input).units[index]!.ledger.lots['legacy-known']!.quantity = { kind: 'not-a-quantity' };
      const before = JSON.stringify(input);
      expect(() => decodePending(input)).toThrow();
      expect(JSON.stringify(input)).toBe(before);
    });
  }

  test('版4の旧trial beforeの余分な欄を黙って捨てない', () => {
    const input = JSON.parse(v4.wire) as { ledger: RawLedger };
    addTrialKey(input.ledger);
    rejectsSnapshot(JSON.stringify(input));
  });
  for (const index of [0, 1]) {
    test(`版4pendingの単位${index + 1}: 旧trialの生キー集合を検査する`, () => {
      const c = pendingCases.find(c => c.id === 'pending-v4-trial')!;
      const input = JSON.parse(c.wire) as { pending: RawPending };
      addTrialKey(input.pending.units[index]!.ledger);
      const before = JSON.stringify(input);
      expect(() => decodePending(input)).toThrow('欄');
      expect(JSON.stringify(input)).toBe(before);
    });
  }
  test('CRCが正しくても旧trialを壊した固定backupは記録の検査で拒否する', () => {
    const envelope = JSON.parse(backup.wire) as { snapshot: string; createdAt: string; crc32: string };
    const input = JSON.parse(envelope.snapshot) as { ledger: RawLedger };
    addTrialKey(input.ledger);
    envelope.snapshot = JSON.stringify(input);
    envelope.crc32 = crc32(bytes(`${envelope.createdAt}\n${envelope.snapshot}`)).toString(16).padStart(8, '0');
    const raw = bytes(JSON.stringify(envelope)), before = raw.slice();
    expect(readBackup(raw)).toMatchObject({ kind: 'unreadable', reason: expect.stringContaining('記録の検査') });
    expect(raw).toEqual(before);
    expect(parse(v4.wire).ledger.history.at(-1)?.kind).toBe('master');
  });
});
