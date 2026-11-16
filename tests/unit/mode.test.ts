import { expect, test } from 'vitest';
import { nextSplitId } from '../../src/ui/mode.ts';

test('分割IDは未使用の候補を出し、独自IDの桁と大きい番号を保つ', () => {
  expect(nextSplitId({ 'L-0001': {}, 'L-0002': {} }, 'L-0001')).toBe('L-0003');
  expect(nextSplitId({ 'WATER-02': {}, 'WATER-03': {} }, 'WATER-01')).toBe('WATER-04');
  expect(nextSplitId({}, 'L-01')).toBe('L-02');
  expect(nextSplitId({}, 'L-00001')).toBe('L-00002');
  expect(nextSplitId({ 'L-0001': {} }, 'L-10000')).toBe('L-0002');
  expect(nextSplitId({}, 'BOX-009')).toBe('BOX-010');
  expect(nextSplitId({}, 'BOX-9007199254740992')).toBe('BOX-9007199254740993');
  expect(nextSplitId({}, '架空の箱')).toBe('');
});
