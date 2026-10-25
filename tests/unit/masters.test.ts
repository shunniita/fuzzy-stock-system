import { describe, expect, test } from 'vitest';
import { codeOwner, fixedMasters, inScopeAt, perBoxAt, requireActive, type Masters, type Packaging } from '../../src/domain/masters.ts';
import { stockItems } from '../../src/ui/seed.ts';

describe('F1-B 1.1 固定の架空登録情報', () => {
  test('9.5: 品目・場所・案件・用途・担当者は、F1-Aまでの固定の架空データと同じ', () => {
    const items: [string, string, string[], boolean][] = [
      ['P', '架空部品P', ['個'], true], ['Q', '架空部品Q', ['個'], true], ['R', '架空半製品R', ['台'], true],
      ['S', '架空共通ネジS', ['本', '箱'], true], ['V', '架空共通ワッシャV', ['本'], true], ['X', '架空対象外部品X', ['個'], false],
    ];
    expect(Object.values(fixedMasters.items).map(({ id, code, name, units, trial, active, source }) => ({ id, code, name, units, trial, active, source }))).toEqual(
      items.map(([id, name, units, trial]) => ({ id, code: id, name, units, trial, active: true, source: null })),
    );
    const locations: [string, string, boolean][] = [['S1', '棚S1', true], ['S2', '棚S2', true], ['T', '作業台T', true], ['N', '次工程N', true], ['O', '対象外の棚O', false]];
    expect(Object.values(fixedMasters.locations).map(({ id, code, name, trial, active, scope }) => ({ id, code, name, trial, active, scope }))).toEqual(
      locations.map(([id, name, trial]) => ({ id, code: id, name, trial, active: true, scope: [{ from: null, inScope: true }] })),
    );
    expect(Object.values(fixedMasters.cases).map(({ id, code, name, active }) => ({ id, code, name, active }))).toEqual(
      ['A-001', 'A-002', 'B-001'].map((id) => ({ id, code: id, name: null, active: true })),
    );
    expect(Object.keys(fixedMasters.actors)).toEqual(['架空担当A', '架空担当B']);
  });

  test('6.2: ネジSの1箱あたりの数は最初から1000本（F1-Aまでの固定の値）、包装のないほかの品目は換算しない', () => {
    expect(fixedMasters.items.S?.packaging).toEqual({ boxUnit: '箱', pieceUnit: '本', perBox: [{ from: null, value: 1000 }] });
    expect(stockItems.map((cfg) => cfg.item)).toEqual(['S', 'V']);
    expect(Object.values(fixedMasters.items).filter((i) => i.packaging !== null).map((i) => i.id)).toEqual(['S']);
  });

  test('辞書のキーと内部の識別が同じで、凍結されている', () => {
    for (const group of Object.values(fixedMasters)) {
      for (const [key, master] of Object.entries(group as Record<string, { id: string }>)) expect(master.id).toBe(key);
    }
    expect(Object.isFrozen(fixedMasters.items.S?.packaging?.perBox)).toBe(true);
  });
});

describe('F1-B 1.1 時点の値', () => {
  const packaging: Packaging = {
    boxUnit: '箱', pieceUnit: '本',
    perBox: [{ from: null, value: 1000 }, { from: '2026-10-09T10:00:00+09:00', value: 800 }],
  };

  test('6.2・6.3: 適用時点より前は前の1箱あたりの数、適用時点ちょうどと以後は変更後の1箱あたりの数', () => {
    expect(perBoxAt(packaging, '2026-10-09T09:59:59+09:00')).toBe(1000);
    expect(perBoxAt(packaging, '2026-10-09T10:00:00+09:00')).toBe(800);
    expect(perBoxAt(packaging, '2026-10-09T01:00:00Z')).toBe(800);
    expect(perBoxAt(packaging, '2026-01-01T00:00:00+09:00')).toBe(1000);
  });

  test('7.4: 記録の対象は、その時点の内外を返す', () => {
    const shelf = { ...fixedMasters.locations.O!, scope: [{ from: null, inScope: true }, { from: '2026-10-09T10:00:00+09:00', inScope: false }] };
    expect(inScopeAt(shelf, '2026-10-09T09:00:00+09:00')).toBe(true);
    expect(inScopeAt(shelf, '2026-10-09T10:00:00+09:00')).toBe(false);
    expect(inScopeAt(fixedMasters.locations.S1!, '2000-01-01T00:00:00+09:00')).toBe(true);
  });
});

describe('F1-B 1.1 品番・コードの持ち主と利用停止', () => {
  const stopped: Masters = {
    ...fixedMasters,
    items: { ...fixedMasters.items, P: { ...fixedMasters.items.P!, active: false } },
    cases: { ...fixedMasters.cases, 'A-001': { ...fixedMasters.cases['A-001']!, active: false } },
    locations: { ...fixedMasters.locations, T: { ...fixedMasters.locations.T!, active: false } },
  };

  test('品番・コードの持ち主は同じ種類の中だけで探す', () => {
    expect(codeOwner(fixedMasters, 'item', 'P')?.id).toBe('P');
    expect(codeOwner(fixedMasters, 'location', 'P')).toBeUndefined();
    expect(codeOwner(fixedMasters, 'case', 'A-002')?.id).toBe('A-002');
  });

  test('3.4: 利用停止中の品目・案件・用途だけを断る。知らないIDと共通在庫・所属不明は通す', () => {
    expect(() => requireActive(stopped, { item: 'P' })).toThrow('利用停止');
    expect(() => requireActive(stopped, { project: { kind: 'case', id: 'A-001' } })).toThrow('利用停止');
    expect(() => requireActive(stopped, { item: 'Q', project: { kind: 'case', id: 'A-002' } })).not.toThrow();
    expect(() => requireActive(stopped, { item: '0012', project: { kind: 'case', id: '007' } })).not.toThrow();
    expect(() => requireActive(stopped, { project: { kind: 'common' } })).not.toThrow();
    expect(() => requireActive(stopped, { project: { kind: 'unassigned' } })).not.toThrow();
  });

  test('継承したプロパティの名前のIDは、知らないIDとして扱う（利用停止と言わない）', () => {
    for (const id of ['constructor', 'toString', '__proto__']) {
      expect(() => requireActive(stopped, { item: id, project: { kind: 'case', id } })).not.toThrow();
    }
  });
});
