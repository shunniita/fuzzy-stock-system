import { legacyEventLabels, legacyJson } from '../fixtures/history-labels.ts';
import { describe, expect, test } from 'vitest';
import { fixedMasters, type Masters } from '../../src/domain/masters.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { crc32, readBackup } from '../../src/ui/backup.ts';
import { seedLedger } from '../../src/ui/seed.ts';
import { initial, parse, serialize, type Snapshot } from '../../src/ui/storage.ts';
import { decodePending } from '../../src/ui/storageparse.ts';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const at = '2026-10-09T09:00:00+09:00';

// 版3の写しから、以前の版の形（ledgerにmastersがない）の文字列を作る。版1は数量の表を持たない形。
function olderText(snapshot: Snapshot, version: 1 | 2): string {
  const value = JSON.parse(version === 1 ? JSON.stringify(snapshot) : serialize(snapshot)) as { version: number; ledger: Record<string, unknown> };
  delete value.ledger['masters'];
  delete (value as Record<string, unknown>)['conflictReviews'];
  value.version = version;
  return JSON.stringify(value, (key, entry: unknown) => key === 'itemLabels' || key === 'receiptTemplates' ? undefined : entry);
}

function wrap(snapshotText: string): Uint8Array {
  const hex = crc32(utf8(`${at}\n${snapshotText}`)).toString(16).padStart(8, '0');
  return utf8(JSON.stringify({ notice: '試験', format: 'fuzzy-stock-backup', version: 1, createdAt: at, crc32: hex, snapshot: snapshotText }));
}

const current = (): Snapshot => initial(seedLedger(), emptySupply);
const withMasters = (s: Snapshot, masters: unknown): string => {
  const value = JSON.parse(serialize(s)) as { ledger: Record<string, unknown> };
  value.ledger['masters'] = masters;
  return JSON.stringify(value, (key, entry: unknown) => key === 'receiptTemplates' ? undefined : entry);
};

describe('F1-B 1.2・9.4 以前の版の記録を固定の架空登録情報で補って読む', () => {
  for (const version of [1, 2] as const) {
    test(`版${version}の写しは、保管単位・履歴をそのままに、固定登録情報を補った現行版として読む`, () => {
      const original = current();
      const read = parse(olderText(original, version));
      expect(read.version).toBe(10);
      expect(read.ledger.masters).toEqual(fixedMasters);
      expect(read.ledger.lots).toEqual(original.ledger.lots);
      expect(read.ledger.history).toEqual(original.ledger.history.map(e => ({ ...e, ...legacyEventLabels })));
    });
  }

  test('mastersのない保存中の操作（版2の画面が書いたもの）は、保存の単位ごとに固定登録情報を補う', () => {
    const original = current();
    const { masters: _, ...ledger } = original.ledger;
    const pending = decodePending({
      progress: 'saving', unknownSince: null, savingSince: at, baseRevision: 0, opId: 'op1', opLabel: '登録', fingerprint: 'f',
      values: {}, actor: '架空担当A', startedAt: at, units: [{ ledger: JSON.parse(legacyJson(ledger)), supply: { needs: {}, declarations: {}, requests: {}, levels: {}, acks: {}, receipts: {}, log: [] }, targets: [] }],
    });
    expect(pending.units[0]?.ledger.masters).toEqual(fixedMasters);
  });

  test('版2の写しを包んだバックアップは、固定登録情報を補って復元に使える', () => {
    const read = readBackup(wrap(olderText(current(), 2)));
    expect(read.kind).toBe('ok');
    if (read.kind === 'ok') expect(read.snapshot.ledger.masters).toEqual(fixedMasters);
  });
});

describe('F1-B 1.2・9.1・9.7 版3の保存と検査', () => {
  test('現行版で書き、往復しても登録情報が同じ', () => {
    const changed: Masters = { ...fixedMasters, items: { ...fixedMasters.items, P: { ...fixedMasters.items.P!, name: '架空部品P改', active: false } } };
    const original = { ...current(), ledger: { ...current().ledger, masters: changed } };
    expect(JSON.parse(serialize(original))).toMatchObject({ version: 10 });
    expect(parse(serialize(original)).ledger.masters).toEqual(changed);
  });

  test('版11の写しは読まず、版11の写しを包んだバックアップは新しい版として断る', () => {
    const text = serialize(current()).replace('"version":10', '"version":11');
    expect(() => parse(text)).toThrow('version');
    expect(readBackup(wrap(text)).kind).toBe('newer');
  });

  const broken: [string, (m: Record<string, Record<string, Record<string, unknown>>>) => void][] = [
    ['辞書のキーとidが違う', (m) => { m['items']!['P']!['id'] = 'Q'; }],
    ['同じ種類で品番・コードが重なる', (m) => { m['items']!['Q']!['code'] = 'P'; }],
    ['案件・用途の内部の識別が共通在庫を表す値', (m) => { m['cases']!['common'] = { type: 'case', id: 'common', code: 'C-9', name: null, source: null, active: true }; }],
    ['案件・用途の内部の識別が所属不明を表す値', (m) => { m['cases']!['unassigned'] = { type: 'case', id: 'unassigned', code: null, name: '架空', source: null, active: true }; }],
    ['時系列の先頭が最初からでない', (m) => { m['locations']!['S1']!['scope'] = [{ from: at, inScope: true }]; }],
    ['時系列が昇順でない', (m) => { m['items']!['S']!['packaging'] = { boxUnit: '箱', pieceUnit: '本', perBox: [{ from: null, value: 1000 }, { from: at, value: 800 }, { from: '2026-10-08T09:00:00+09:00', value: 900 }] }; }],
    ['1箱あたりの数が1以上の整数でない', (m) => { m['items']!['S']!['packaging'] = { boxUnit: '箱', pieceUnit: '本', perBox: [{ from: null, value: 0 }] }; }],
    ['案件・用途が品番・コードも名称も持たない', (m) => { m['cases']!['A-001']!['code'] = null; m['cases']!['A-001']!['name'] = null; }],
    ['種類の印が違う', (m) => { m['cases']!['A-001']!['type'] = 'item'; }],
    ['担当者が欠ける欄を持つ', (m) => { delete m['actors']!['架空担当A']!['active']; }],
  ];
  for (const [label, breakIt] of broken) {
    test(`崩れた登録情報は読み込めない：${label}`, () => {
      const masters = JSON.parse(JSON.stringify(fixedMasters)) as Record<string, Record<string, Record<string, unknown>>>;
      breakIt(masters);
      expect(() => parse(withMasters(current(), masters))).toThrow();
    });
  }

  test('版3の写しにmastersがなければ読み込めない（補うのは以前の版だけ）', () => {
    expect(() => parse(withMasters(current(), undefined))).toThrow('masters');
  });
});
