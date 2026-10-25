import { describe, expect, test } from 'vitest';
import { fixedMasters, type ItemMaster, type Masters } from '../../src/domain/masters.ts';
import { captureItemLabels, type EventItemLabels } from '../../src/domain/history-labels.ts';

const item = (id: string, name = '架空品目', code: string | null = null): ItemMaster => ({ ...fixedMasters.items['P']!, id, name, code });
const masters = (items: ItemMaster[]): Masters => ({ ...fixedMasters, items: Object.fromEntries(items.map(value => [value.id, value])) });

describe('履歴品目表示 task1 要件1.1,1.4,3.1,3.2,5.3', () => {
  test('必要品目だけの名称と正式コードを取得し、内部ID・先頭ゼロ・重複除去を維持する', () => {
    const current = masters([item('001', '架空の当時名称', '007'), item('P', '架空の仮品目'), item('unused')]);
    expect(captureItemLabels(current, ['001', 'P', '001'])).toEqual({ kind: 'recorded', items: { '001': { name: '架空の当時名称', code: '007' }, P: { name: '架空の仮品目', code: null } } });
    expect(Object.keys(captureItemLabels(current, ['001']).items)).toEqual(['001']);
  });
  test('対象なしは空のrecordedで、旧当時表示不明とは区別する', () => {
    const legacy: EventItemLabels = { kind: 'legacy-unavailable' };
    expect(captureItemLabels(fixedMasters, [])).toEqual({ kind: 'recorded', items: {} });
    expect(captureItemLabels(fixedMasters, [])).not.toEqual(legacy);
  });
  test('正式化・改名・コード再付替え後も取得時点の値を変更せず、登録情報を凍結しない', () => {
    const original = item('known', '架空の元名称'), current = masters([original]);
    const captured = captureItemLabels(current, ['known']);
    expect(Object.isFrozen(original)).toBe(false);
    expect(Object.isFrozen(current.items)).toBe(false);
    original.name = '架空の新名称';
    original.code = 'NEW';
    expect(captured.items['known']).toEqual({ name: '架空の元名称', code: null });
    expect(captureItemLabels(current, ['known']).items['known']).toEqual({ name: '架空の新名称', code: 'NEW' });
    expect(captured.items['known']).not.toBe(original);
  });
  test('取得した外側・辞書・各値を独立して凍結する', () => {
    const captured = captureItemLabels(masters([item('known')]), ['known']);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured.items)).toBe(true);
    expect(Object.isFrozen(captured.items['known'])).toBe(true);
    expect(Reflect.set(captured.items['known']!, 'name', '架空の書換え')).toBe(false);
    expect(Reflect.set(captured.items, 'extra', { name: '架空', code: null })).toBe(false);
  });
  test('利用停止中でも当時の名称・コードだけを取得し、現在のactiveを含めない', () => {
    const current = masters([{ ...item('stopped', '架空の中断品目', 'OLD'), active: false }]);
    expect(captureItemLabels(current, ['stopped'])).toEqual({ kind: 'recorded', items: { stopped: { name: '架空の中断品目', code: 'OLD' } } });
  });
  test('未知の既知品目IDは空やlegacyへ置換せず理由付きで拒否し、元登録情報を変えない', () => {
    const before = JSON.stringify(fixedMasters);
    expect(() => captureItemLabels(fixedMasters, ['P', 'missing'])).toThrow('missing');
    expect(JSON.stringify(fixedMasters)).toBe(before);
  });
  test('辞書の継承プロパティを品目として取得しない', () => {
    expect(() => captureItemLabels(fixedMasters, ['constructor'])).toThrow('constructor');
    expect(() => captureItemLabels(fixedMasters, ['__proto__'])).toThrow('__proto__');
    expect(() => captureItemLabels(fixedMasters, ['toString'])).toThrow('toString');
  });
  test('登録済みの__proto__/constructorも独立した安全な辞書キーとして保持する', () => {
    const current = masters([item('__proto__', '架空特殊1', '000'), item('constructor', '架空特殊2')]);
    const result = captureItemLabels(current, ['__proto__', 'constructor']);
    expect(Object.hasOwn(result.items, '__proto__')).toBe(true);
    expect(Object.hasOwn(result.items, 'constructor')).toBe(true);
    expect(result.items['__proto__']).toEqual({ name: '架空特殊1', code: '000' });
    expect(result.items['constructor']).toEqual({ name: '架空特殊2', code: null });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
  test.each([
    item('invalid', ''), item('invalid', ' \t '), item('invalid', '架空', ''), item('invalid', '架空', ' \t '),
  ])('空白だけの名称・コードは当時表示として取得しない %#', invalid => {
    expect(() => captureItemLabels(masters([invalid]), ['invalid'])).toThrow();
  });
});
