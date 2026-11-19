import { describe, expect, test } from 'vitest';
import { practiceLedger } from '../../src/domain/ledger.ts';
import { masterKindCounts, masterKindOf } from '../../src/ui/master-ui.ts';

describe('登録情報の種類（5.3・5.4）', () => {
  test('キーから種類を読む', () => {
    expect(masterKindOf('item:P')).toBe('item');
    expect(masterKindOf('location:S1')).toBe('location');
    expect(masterKindOf('case:A:1')).toBe('case');
  });

  const ms = practiceLedger.masters;
  test('絞りが空なら全件、全角・大文字小文字の違いを越えて数える', () => {
    const all = masterKindCounts(ms, '');
    expect(all.item).toBe(Object.keys(ms.items).length);
    expect(all.location).toBe(Object.keys(ms.locations).length);
    expect(all.case).toBe(Object.keys(ms.cases).length);
    expect(all.actor).toBe(Object.keys(ms.actors).length);
    expect(all.process).toBe(Object.keys(ms.processes).length);
    const s1 = masterKindCounts(ms, ' ｓ１ ');
    expect(s1.location).toBe(1);
    expect(s1.item).toBe(0);
  });

  test('表に出る文字（状態）でも当たる', () => {
    expect(masterKindCounts(ms, '利用中').item).toBe(Object.keys(ms.items).length);
    expect(masterKindCounts(ms, '存在しない文字列')).toEqual({ item: 0, location: 0, case: 0, actor: 0, process: 0 });
  });
});
