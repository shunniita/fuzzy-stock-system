import { describe, expect, test } from 'vitest';
import { fixedMasters } from '../../src/domain/masters.ts';

const items = Object.values(fixedMasters.items);
const locations = Object.values(fixedMasters.locations);

describe('FH-B05・RUN-04b: 固定の架空登録情報の試行対象', () => {
  test('既存の全品目は試行対象、架空対象外部品Xだけ対象外と明示する', () => {
    expect(items.map(({ id, trial }) => ({ id, trial }))).toEqual([
      { id: 'P', trial: true },
      { id: 'Q', trial: true },
      { id: 'R', trial: true },
      { id: 'S', trial: true },
      { id: 'V', trial: true },
      { id: 'X', trial: false },
    ]);
    expect(items.find((item) => item.id === 'X')).toMatchObject({ name: '架空対象外部品X', units: ['個'] });
  });

  test('既存の全場所は試行対象、対象外の棚Oだけ対象外と明示する', () => {
    expect(locations.map(({ id, trial }) => ({ id, trial }))).toEqual([
      { id: 'S1', trial: true },
      { id: 'S2', trial: true },
      { id: 'T', trial: true },
      { id: 'N', trial: true },
      { id: 'O', trial: false },
    ]);
    expect(locations.find((location) => location.id === 'O')).toMatchObject({ name: '対象外の棚O' });
  });
});
