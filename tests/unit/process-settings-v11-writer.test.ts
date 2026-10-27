import fixtureText from '../fixtures/process-v11/partial.json?raw';
import { describe, expect, test } from 'vitest';
import { productionOf, type Ledger } from '../../src/domain/ledger.ts';
import { processRef } from '../../src/domain/masters.ts';
import { eventText, stageText } from '../../src/ui/format.ts';
import { load, retry, type StoreLike } from '../../src/ui/storage.ts';

type Shown = { production: Record<string, unknown>; history: [string, string][]; stages: Record<string, string> };
const fixture: { sha256: string; data: [string, string][]; expected: { saved: Shown; retried: Shown } } = JSON.parse(fixtureText);

class Memory implements StoreLike {
  readonly data: Map<string, string>;
  constructor(entries: [string, string][]) { this.data = new Map(entries); }
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { this.data.set(key, value); }
  removeItem(key: string): void { this.data.delete(key); }
}

// v1.2.0の画面と同じ引数で、工程の集計・履歴の文言・工程上の位置を引く。
const shown = (ledger: Ledger): Shown => ({
  production: Object.fromEntries(['R組立', '架空塗装'].map(p => [p, productionOf(ledger, p, 'R', '台', { kind: 'case', id: 'A-001' })])),
  history: ledger.history.map(e => [e.eventId, eventText(ledger, e)]),
  stages: Object.fromEntries(Object.values(ledger.lots).map(lot => [lot.id, lot.stage.kind === 'none' ? 'なし' : stageText(lot.stage, id => processRef(ledger.masters, id))])),
});

describe('工程の設定 5.3・5.4: v1.2.0（保存版11）のwriterが書いた保存途中データ', () => {
  test('固定データは生成時のまま', async () => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ data: fixture.data, expected: fixture.expected })));
    expect([...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')).toBe(fixture.sha256);
  });

  test('工程と次工程の場所を補って読み、集計・履歴・工程上の位置をv1.2.0と同じに示し、再試行後も同じ', () => {
    const store = new Memory(fixture.data);
    const loaded = load(store);
    if (loaded.kind !== 'ok' || loaded.pending === null) throw new Error('v1.2.0の保存途中を読めない');
    expect(loaded.snapshot.ledger.masters.processes).toEqual({
      R組立: { type: 'process', id: 'R組立', name: 'R組立', criterion: 'inspection', active: true },
      架空塗装: { type: 'process', id: '架空塗装', name: '架空塗装', criterion: 'workEnd', active: true },
    });
    expect(Object.values(loaded.snapshot.ledger.masters.locations).filter(l => l.nextProcess).map(l => l.id)).toEqual(['N']);
    expect(shown(loaded.snapshot.ledger)).toEqual(fixture.expected.saved);
    const done = retry(store, loaded.snapshot, loaded.pending, '架空担当A', '2026-10-27T16:00:00+09:00');
    if (done.kind !== 'saved') throw new Error(`再試行に失敗: ${done.kind}`);
    expect(shown(done.snapshot.ledger)).toEqual(fixture.expected.retried);
    const again = load(store);
    if (again.kind !== 'ok') throw new Error('再試行後に読めない');
    expect(again.pending).toBeNull();
    expect(again.snapshot.ledger.masters.processes).toEqual(loaded.snapshot.ledger.masters.processes);
  });
});
