import { describe, expect, test } from 'vitest';
import fixtureText from '../fixtures/template-needs-v12/saved.json?raw';
import { load, parse, retry, type Snapshot, type StoreLike } from '../../src/ui/storage.ts';
import { readBackup } from '../../src/ui/backup.ts';
import { decodeDraft } from '../../src/ui/conflictdraft.ts';
import { shortageOf } from '../../src/domain/shortage.ts';
import { supplyEventText } from '../../src/ui/supply-format.ts';

const fixture: { writerRevision: string; snapshotVersion: number; sha256: string; snapshot: string; data: [string, string][]; backup: string; draftRaw: string; expected: { before: unknown; saved: unknown; retried: unknown; draft: unknown } } = JSON.parse(fixtureText);
class Memory implements StoreLike {
  readonly data: Map<string, string>;
  constructor(entries: [string, string][]) { this.data = new Map(entries); }
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { this.data.set(key, value); }
  removeItem(key: string): void { this.data.delete(key); }
}
const shown = (snapshot: Snapshot) => ({ needs: snapshot.supply.needs,
  shortage: shortageOf(snapshot.ledger, snapshot.supply, { project: { kind: 'case', id: 'A-001' }, item: 'P', unit: '個' }),
  history: snapshot.supply.log.map(e => supplyEventText(snapshot.ledger.masters, e)),
});

describe('8.4 FT-16: 変更前の版12 writer互換性', () => {
  test('writerと原文hashを固定し、旧版自身の期待表示を保持する', async () => {
    expect(fixture.writerRevision).toBe('f0043db707869a819085ab0ed0988278437b9251');
    expect(fixture.snapshotVersion).toBe(12);
    const body = { snapshot: fixture.snapshot, data: fixture.data, backup: fixture.backup, draftRaw: fixture.draftRaw, expected: fixture.expected };
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(body)));
    expect([...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')).toBe(fixture.sha256);
    expect(shown(parse(fixture.snapshot))).toEqual(fixture.expected.before);
  });

  test('応答不明の保存途中を照会・再試行して二重改訂せず元の期待表示を保つ', () => {
    const store = new Memory(fixture.data), original = [...store.data];
    const loaded = load(store);
    if (loaded.kind !== 'ok' || loaded.pending === null) throw new Error('旧pendingの読込に失敗');
    expect([...store.data]).toEqual(original);
    expect(shown(loaded.snapshot)).toEqual(fixture.expected.saved);
    const result = retry(store, loaded.snapshot, loaded.pending, '架空担当', '2026-10-30T00:00:00+09:00');
    if (result.kind !== 'saved' && result.kind !== 'duplicate' && result.kind !== 'recovered') throw new Error(`再試行失敗: ${result.kind}`);
    expect(shown(result.snapshot)).toEqual(fixture.expected.retried);
    expect(result.snapshot.supply.log.filter(e => e.kind === 'needRevise')).toHaveLength(1);
  });

  test('backupと退避の原文を旧形式のまま読める', () => {
    expect(readBackup(new TextEncoder().encode(fixture.backup)).kind).toBe('ok');
    expect(decodeDraft(fixture.draftRaw).draft).toEqual(fixture.expected.draft);
  });
});
