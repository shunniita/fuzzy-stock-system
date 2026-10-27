import { describe, expect, test } from 'vitest';
import { practiceLedger } from '../../src/domain/ledger.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { seedScn02 } from '../../src/ui/seed.ts';
import { backupFileName, backupTextOf, crc32, readBackup, recordCountsOf, viewFileName, type BackupRead } from '../../src/ui/backup.ts';
import { initial, sameSnapshot, serialize } from '../../src/ui/storage.ts';
import { snapshot } from './record-fixture.ts';

const created = '2026-10-07T15:30:00+09:00';
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const hex = (n: number): string => n.toString(16).padStart(8, '0');

// 検査値を付け直した包み。ファイルの一部を変えたときに、検査値以外の理由で断ることを確かめるために使う。
function wrap(snapshotText: string, createdAt = created, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ notice: '試験', format: 'fuzzy-stock-backup', version: 1, createdAt, crc32: hex(crc32(utf8(`${createdAt}\n${snapshotText}`))), snapshot: snapshotText, ...extra });
}

function reason(result: BackupRead): string {
  if (result.kind !== 'unreadable') throw new Error(`読み込めない結果のはずが${result.kind}`);
  return result.reason;
}

describe('FH-F1A-05・F1-A 1.1・1.2: バックアップの書き出し', () => {
  test('CRC-32は既知の値と一致する', () => {
    expect(hex(crc32(utf8('123456789')))).toBe('cbf43926');
    expect(hex(crc32(new Uint8Array(0)))).toBe('00000000');
    expect(hex(crc32(utf8('a')))).toBe('e8b7be43');
    expect(hex(crc32(utf8('The quick brown fox jumps over the lazy dog')))).toBe('414fa339');
  });

  test('包みは用途の注意書きを先頭の欄にし、形式・版・作成日時・検査値・写しの文字列を順に持つ', () => {
    const text = backupTextOf(snapshot(), created);
    const envelope: Record<string, unknown> = JSON.parse(text);
    expect(Object.keys(envelope)).toEqual(['notice', 'format', 'version', 'createdAt', 'crc32', 'snapshot']);
    expect(envelope.format).toBe('fuzzy-stock-backup');
    expect(envelope.version).toBe(1);
    expect(envelope.createdAt).toBe(created);
    expect(envelope.notice).toEqual(expect.stringContaining('復元用バックアップ'));
    expect(envelope.notice).toEqual(expect.stringContaining('fuzzy-stock-system'));
    expect(envelope.notice).toEqual(expect.stringContaining('閲覧用ではない'));
    expect(envelope.notice).toEqual(expect.stringContaining('保存し直すと復元に使えなくなる'));
    expect(envelope.snapshot).toBe(serialize(snapshot()));
    expect(envelope.crc32).toBe(hex(crc32(utf8(`${created}\n${serialize(snapshot())}`))));
  });

  test('作成日時が日本時間の形でなければ書き出さない', () => {
    expect(() => backupTextOf(snapshot(), '2026-10-07 15:30')).toThrow();
    expect(() => backupTextOf(snapshot(), '')).toThrow();
  });

  test('1.7・5.2: ファイル名で用途が分かり、バックアップは.json、閲覧用の出力は.xlsx', () => {
    expect(backupFileName(created)).toBe('fuzzy-stock-system_復元用バックアップ_20261007-153000.json');
    expect(viewFileName(created)).toBe('fuzzy-stock-system_閲覧用_復元不可_20261007-153000.xlsx');
    expect(() => backupFileName('x')).toThrow();
  });

  test('1.5: 書き出しは渡した写しを変えない', () => {
    const before = snapshot();
    const text = backupTextOf(before, created);
    expect(text.length).toBeGreaterThan(0);
    expect(sameSnapshot(before, snapshot())).toBe(true);
  });
});

describe('FH-F1A-05・F1-A 1.6・2.1: 件数（保管単位・履歴・未完了の依頼）', () => {
  test('統合済みの保管単位、取消した依頼、全量到着した依頼を数えない', () => {
    const base = snapshot();
    const lot = Object.values(base.ledger.lots)[0];
    const request = Object.values(base.supply.requests)[0];
    if (!lot || !request) throw new Error('試験用データがない');
    const lots = { ...base.ledger.lots, 合流元: { ...lot, id: '合流元', mergedInto: lot.id } };
    const requests = {
      open: { ...request, id: 'open', quantity: 5, arrivals: [], cancelled: null },
      partial: { ...request, id: 'partial', quantity: 5, arrivals: [{ id: 'a', receiptLotId: lot.id, arrived: 2, good: 2 }], cancelled: null },
      done: { ...request, id: 'done', quantity: 2, arrivals: [{ id: 'a', receiptLotId: lot.id, arrived: 2, good: 2 }], cancelled: null },
      over: { ...request, id: 'over', quantity: 2, arrivals: [{ id: 'a', receiptLotId: lot.id, arrived: 3, good: 3 }], cancelled: null },
      cancelled: { ...request, id: 'cancelled', quantity: 5, arrivals: [], cancelled: { eventId: 'e', reason: '不要' } },
    };
    const counts = recordCountsOf({ ledger: { ...base.ledger, lots }, supply: { ...base.supply, requests } });
    expect(counts.openRequests).toBe(2);
    expect(counts.lots).toBe(Object.values(base.ledger.lots).filter(l => l.mergedInto === null).length);
    expect(counts.records).toBe(base.ledger.history.length + base.supply.log.length);
  });

  test('空の記録は0件', () => {
    expect(recordCountsOf({ ledger: practiceLedger, supply: emptySupply })).toEqual({ lots: 0, records: 0, openRequests: 0 });
  });
});

describe('FH-F1A-05・F1-A 2.1: 書き出した包みを読み戻す', () => {
  test.each([false, true])('公開版A: 旧noticeの版1/2を同じCRCで読み、文字列以外のnoticeは拒否する（回収資料=%s）', recovery => {
    const original = snapshot();
    const envelope: Record<string, unknown> = JSON.parse(backupTextOf(original, created, recovery ? { generation: 'legacy-generation', archive: {}, receipts: {} } : undefined));
    const checksum = envelope.crc32;
    expect(envelope.notice).not.toMatch(/架空|試作/);
    envelope.notice = 'fuzzy-stock 復元用バックアップ（架空データの試作）。閲覧用ではない。';
    const legacy = readBackup(utf8(JSON.stringify(envelope)));
    expect(legacy.kind).toBe('ok');
    if (legacy.kind !== 'ok') throw Error('旧noticeのバックアップを読めない');
    expect(sameSnapshot(legacy.snapshot, original)).toBe(true);
    expect(envelope.crc32).toBe(checksum);
    envelope.notice = 1;
    expect(readBackup(utf8(JSON.stringify(envelope))).kind).toBe('unreadable');
  });

  test('往復で写しが元と同じ値になり、作成日時と件数が付く', () => {
    const original = snapshot();
    const result = readBackup(utf8(backupTextOf(original, created)));
    if (result.kind !== 'ok') throw new Error(`読めない：${result.kind}`);
    expect(sameSnapshot(result.snapshot, original)).toBe(true);
    expect(result.createdAt).toBe(created);
    expect(result.counts).toEqual(recordCountsOf(original));
    expect(Object.isFrozen(result.snapshot)).toBe(true);
  });

  test('記録の空の写しも往復できる', () => {
    const original = initial(practiceLedger, emptySupply);
    const result = readBackup(utf8(backupTextOf(original, created)));
    expect(result.kind).toBe('ok');
  });

  test('固定の架空データの写しも往復できる', () => {
    const original = { ...initial(seedScn02().ledger, seedScn02().supply) };
    const result = readBackup(utf8(backupTextOf(original, created)));
    if (result.kind !== 'ok') throw new Error(`読めない：${result.kind}`);
    expect(sameSnapshot(result.snapshot, original)).toBe(true);
  });

  test('包みの空白を整形し直したものと、先頭のBOMは、記録が同じなので受け付ける', () => {
    const text = backupTextOf(snapshot(), created);
    const pretty = JSON.stringify(JSON.parse(text), null, 2);
    expect(readBackup(utf8(pretty)).kind).toBe('ok');
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(text)]);
    expect(readBackup(withBom).kind).toBe('ok');
  });
});

describe('FH-F1A-05・F1-A 3.1〜3.4: 復元に使えないファイルを断る', () => {
  const good = (): string => backupTextOf(snapshot(), created);

  test('3.1: 閲覧用の出力（xlsx＝ZIP）は、閲覧用の出力として断る', () => {
    expect(readBackup(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])).kind).toBe('viewOutput');
  });

  test('3.2: 空・切れた・壊れた・文字として読めない・JSONでないファイルを断る', () => {
    expect(reason(readBackup(new Uint8Array(0)))).toContain('壊れている');
    const text = good();
    expect(reason(readBackup(utf8(text.slice(0, Math.floor(text.length / 2)))))).toContain('壊れている');
    expect(reason(readBackup(new Uint8Array([0xff, 0xfe, 0xfd, 0x80])))).toContain('文字として読めない');
    expect(reason(readBackup(utf8('これは日本語の文章')))).toContain('壊れている');
    for (const other of ['[]', 'null', '42', '"text"', '{}']) expect(reason(readBackup(utf8(other)))).toContain('このソフトの復元用バックアップではない');
  });

  test('3.2: 形式・欄が違うものは、このソフトのバックアップではない', () => {
    const envelope: Record<string, unknown> = JSON.parse(good());
    expect(reason(readBackup(utf8(JSON.stringify({ ...envelope, format: 'other' }))))).toContain('このソフトの復元用バックアップではない');
    const missing = { ...envelope }; delete missing.createdAt;
    expect(reason(readBackup(utf8(JSON.stringify(missing))))).toContain('このソフトの復元用バックアップではない');
    expect(reason(readBackup(utf8(JSON.stringify({ ...envelope, extra: 1 }))))).toContain('このソフトの復元用バックアップではない');
    expect(reason(readBackup(utf8(JSON.stringify({ ...envelope, snapshot: 5 }))))).toContain('このソフトの復元用バックアップではない');
    expect(reason(readBackup(utf8(JSON.stringify({ ...envelope, createdAt: '昨日' }))))).toContain('このソフトの復元用バックアップではない');
    expect(reason(readBackup(utf8(JSON.stringify({ ...envelope, crc32: 'ABCDEF01' }))))).toContain('このソフトの復元用バックアップではない');
  });

  test('3.2: 包みの版が0・小数・文字列のものは断り、1より大きい整数は新しい版', () => {
    const envelope: Record<string, unknown> = JSON.parse(good());
    for (const version of [0, 1.5, '1', null, -1]) expect(readBackup(utf8(JSON.stringify({ ...envelope, version }))).kind).toBe('unreadable');
  });

  test('3.3: 新しい版の包みと、新しい版の写しを、版が違うものとして断る', () => {
    const envelope: Record<string, unknown> = JSON.parse(good());
    expect(readBackup(utf8(JSON.stringify({ ...envelope, version: 3 }))).kind).toBe('newer');
    // 新しい版は欄が増えているかもしれないので、欄の検査より前に版で判断する。
    expect(readBackup(utf8(JSON.stringify({ ...envelope, version: 7, extra: { a: 1 }, crc32: 'x' }))).kind).toBe('newer');
    expect(readBackup(utf8(wrap(serialize(snapshot()).replace('"version":12', '"version":13')))).kind).toBe('newer');
  });

  test('3.2: 作成時から変わっているもの（写しの1文字、作成日時）を断る', () => {
    const text = good();
    const changedSnapshot = text.replace('\\"revision\\":4', '\\"revision\\":5');
    expect(changedSnapshot).not.toBe(text);
    expect(reason(readBackup(utf8(changedSnapshot)))).toContain('作成時から変わっている');
    const changedTime = text.replace(created, '2026-10-07T15:31:00+09:00');
    expect(reason(readBackup(utf8(changedTime)))).toContain('作成時から変わっている');
  });

  test('3.4: 検査値を付け直した不正な写しは、記録の検査を通らないものとして断る', () => {
    const valid = serialize(snapshot());
    expect(reason(readBackup(utf8(wrap(valid.replace('"revision":4', '"revision":-1')))))).toContain('記録の検査');
    expect(reason(readBackup(utf8(wrap('{"format":"fuzzy-stock-f0"}'))))).toContain('記録の検査');
    expect(reason(readBackup(utf8(wrap('これはJSONではない'))))).toContain('記録の検査');
    expect(reason(readBackup(utf8(wrap('[]'))))).toContain('記録の検査');
  });

  test('3.2: 大きすぎるファイルは中身を見ずに断る', () => {
    const big = new Uint8Array(64 * 1024 * 1024 + 1);
    expect(reason(readBackup(big))).toContain('大きすぎる');
    // ZIPの見出しがあっても、大きさの上限が先。
    big.set([0x50, 0x4b, 0x03, 0x04]);
    expect(readBackup(big).kind).toBe('unreadable');
  });

  test('どんな入力でも例外を投げず、四つの結果のどれかを返す', () => {
    const base = utf8(good());
    for (let i = 0; i < base.length; i += Math.max(1, Math.floor(base.length / 300))) {
      const mutated = base.slice();
      mutated[i] = (mutated[i] ?? 0) ^ 0xff;
      expect(['ok', 'viewOutput', 'newer', 'unreadable']).toContain(readBackup(mutated).kind);
      expect(['ok', 'viewOutput', 'newer', 'unreadable']).toContain(readBackup(base.slice(0, i)).kind);
    }
  });
});
