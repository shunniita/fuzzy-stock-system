import { describe, expect, test } from 'vitest';
import {
  adoptProvisional, assignProject, changeMasters, ConfirmationRequired, practiceLedger, identifyProvisional, occurredAtOf, recordProvisional, register, totalOf,
  type Ledger, type Meta, type ProvisionalContent,
} from '../../src/domain/ledger.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { initial, parse, serialize } from '../../src/ui/storage.ts';

const day = (time: string): string => `2026-10-09T${time}:00+09:00`;
const meta = (eventId: string, occurred: string | null = '10:00'): Meta =>
  ({ eventId, occurredAt: occurred === null ? null : day(occurred), recordedAt: day('12:00'), actor: '架空担当A' });
const found: ProvisionalContent = { direction: 'found', item: null, location: 'T', basis: 'counted', value: 3, note: '品目の分からない箱（架空）' };
const value = (l: Ledger, id: string): number | null => {
  const q = l.lots[id]?.quantity;
  return q?.kind === 'known' ? q.numeric.value : null;
};

// 品目Qの箱（5個、棚S1）があり、作業台Tで品目の分からない箱（3個）を見つけて仮の記録にした台帳。
function withFound(content: ProvisionalContent = found): Ledger {
  const l = register(practiceLedger, meta('r1', '08:00'), { id: 'Q-1', item: 'Q', unit: '個', project: { kind: 'common' }, location: 'S1' }, 'counted', 5);
  return recordProvisional(l, meta('p1', '09:00'), content);
}

function confirmation(run: () => unknown): ConfirmationRequired {
  try { run(); } catch (error) { if (error instanceof ConfirmationRequired) return error; throw error; }
  throw new Error('確認を求めなかった');
}

describe('F1-B 5.1・8.1 仮の記録を既存の保管単位と同じ現物として対応付ける', () => {
  test('数量を足さずに確認事項を閉じ、対応付けた先・担当者・理由を残す', () => {
    const before = withFound();
    const l = identifyProvisional(before, meta('i1'), 'p1', 'Q-1', '数え直すと同じ箱だった');
    expect(value(l, 'Q-1')).toBe(5);
    expect(totalOf(l, 'Q')).toEqual(totalOf(before, 'Q'));
    expect(l.issues['p1']?.resolution).toEqual({ eventId: 'i1', outcome: 'close', actor: '架空担当A' });
    expect(l.history.at(-1)).toMatchObject({ kind: 'identify', issueId: 'p1', lotId: 'Q-1', reason: '数え直すと同じ箱だった', changes: [] });
    expect(l.lots).toEqual(before.lots);
  });

  test('8.7・8.8: 解消済み・現存しない保管単位・減った物の仮の記録・理由なしでは対応付けない', () => {
    const l = identifyProvisional(withFound(), meta('i1'), 'p1', 'Q-1', '同じ箱');
    expect(() => identifyProvisional(l, meta('i2'), 'p1', 'Q-1', '二度目')).toThrow('解消済み');
    expect(() => identifyProvisional(withFound(), meta('i3'), 'p1', 'ZZ', 'ない')).toThrow('ZZ');
    expect(() => identifyProvisional(withFound({ ...found, direction: 'removed' }), meta('i4'), 'p1', 'Q-1', '減った')).toThrow('減った物');
    expect(() => identifyProvisional(withFound(), meta('i5'), 'p1', 'Q-1', ' ')).toThrow('理由');
    expect(() => identifyProvisional(withFound(), meta('i6'), 'r1', 'Q-1', '確認事項でない')).toThrow();
  });
});

describe('F1-B 5.1・8.2・8.3 仮の記録を新しい保管単位として登録する', () => {
  const lot = { id: 'Q-found', item: 'Q', unit: '個', project: { kind: 'common' } as const, location: 'T' };

  test('同じ品目の現存する保管単位があれば、別の現物と確認するまで登録しない', () => {
    const asked = confirmation(() => adoptProvisional(withFound(), meta('a1'), 'p1', lot));
    expect(asked.kind).toBe('adopt');
    expect(asked.lots).toEqual(['Q-1']);
    expect(asked.message).toContain('Q-1');
  });

  test('確認すると、仮の記録の数量・根拠・実際の日時のまま登録し、確認事項を適用として解消する', () => {
    const l = adoptProvisional(withFound(), meta('a1'), 'p1', lot, true);
    expect(l.lots['Q-found']).toMatchObject({ item: 'Q', location: 'T', project: { kind: 'common' }, quantity: { kind: 'known', numeric: { value: 3 } } });
    expect(l.lots['Q-found']?.lastCount).toEqual({ value: 3, eventId: 'a1' });
    expect(occurredAtOf(l, 'a1')).toBe(day('09:00'));
    expect(l.issues['p1']?.resolution).toEqual({ eventId: 'a1', outcome: 'apply', actor: '架空担当A' });
    expect(l.history.at(-1)).toMatchObject({ kind: 'adopt', issueId: 'p1', lotId: 'Q-found' });
    expect(value(l, 'Q-1')).toBe(5);
  });

  test('同じ品目の保管単位がなければ、確認なしで登録する。利用停止の品目では登録しない', () => {
    expect(adoptProvisional(withFound(), meta('a1'), 'p1', { ...lot, id: 'R-found', item: 'R', unit: '台' }).lots['R-found']?.item).toBe('R');
    const stopped = changeMasters(withFound(), meta('m1'), { action: 'deactivate', type: 'item', id: 'R', reason: '廃番' });
    expect(() => adoptProvisional(stopped, meta('a2'), 'p1', { ...lot, id: 'R-found', item: 'R', unit: '台' })).toThrow('利用停止');
  });

  test('8.8: 減った物の仮の記録は新しい保管単位にしない', () => {
    expect(() => adoptProvisional(withFound({ ...found, direction: 'removed' }), meta('a1'), 'p1', lot, true)).toThrow('減った物');
  });
});

describe('F1-B 5.2・8.4・8.5 案件・用途が不明な保管単位を案件・用途・共通在庫へ結び付ける', () => {
  function withUnassigned(): Ledger {
    let l = register(practiceLedger, meta('r1', '08:00'), { id: 'P-a', item: 'P', unit: '個', project: { kind: 'case', id: 'A-001' }, location: 'S1' }, 'counted', 10);
    l = register(l, meta('r2', '08:00'), { id: 'P-u', item: 'P', unit: '個', project: { kind: 'unassigned' }, location: 'S2' }, 'label', 4);
    return l;
  }

  test('結び付け先に同じ品目の保管単位があれば確認を求め、確認すると案件・用途だけ変えて前後を残す', () => {
    const asked = confirmation(() => assignProject(withUnassigned(), meta('j1'), 'P-u', { kind: 'case', id: 'A-001' }, '伝票で案件が分かった'));
    expect(asked.kind).toBe('assignProject');
    expect(asked.lots).toEqual(['P-a']);
    const before = withUnassigned();
    const l = assignProject(before, meta('j1'), 'P-u', { kind: 'case', id: 'A-001' }, '伝票で案件が分かった', true);
    expect(l.lots['P-u']).toEqual({ ...before.lots['P-u'], project: { kind: 'case', id: 'A-001' } });
    expect(l.history.at(-1)).toMatchObject({ kind: 'assignProject', lotId: 'P-u', before: { kind: 'unassigned' }, after: { kind: 'case', id: 'A-001' }, reason: '伝票で案件が分かった' });
    expect(l.lots['P-a']).toEqual(before.lots['P-a']);
  });

  test('結び付け先に同じ品目がなければ確認なしで結び付ける（共通在庫へも結び付けられる）', () => {
    expect(assignProject(withUnassigned(), meta('j1'), 'P-u', { kind: 'common' }, '共通在庫と分かった').lots['P-u']?.project).toEqual({ kind: 'common' });
  });

  test('8.7: 所属不明でない保管単位、所属不明への結び付け、利用停止・未登録の案件・用途、理由なしは断る', () => {
    const l = withUnassigned();
    expect(() => assignProject(l, meta('j1'), 'P-a', { kind: 'common' }, '所属あり')).toThrow('不明でない');
    expect(() => assignProject(l, meta('j2'), 'P-u', { kind: 'unassigned' }, '不明のまま')).toThrow();
    const stopped = changeMasters(l, meta('m1'), { action: 'deactivate', type: 'case', id: 'A-002', reason: '完了' });
    expect(() => assignProject(stopped, meta('j3'), 'P-u', { kind: 'case', id: 'A-002' }, '中断', true)).toThrow('利用停止');
    expect(() => assignProject(l, meta('j4'), 'P-u', { kind: 'case', id: '007' }, '未登録', true)).toThrow('登録されていない');
    expect(() => assignProject(l, meta('j5'), 'P-u', { kind: 'common' }, '')).toThrow('理由');
  });
});

describe('F1-B 5.1・5.2 保存', () => {
  test('対応付け・新しい保管単位・結び付けの記録を書いた写しを読み直すと同じ', () => {
    let l = identifyProvisional(withFound(), meta('i1'), 'p1', 'Q-1', '同じ箱');
    l = recordProvisional(l, meta('p2', '09:30'), { ...found, location: 'S2' });
    l = adoptProvisional(l, meta('a1'), 'p2', { id: 'Q-found', item: 'Q', unit: '個', project: { kind: 'unassigned' }, location: 'S2' }, true);
    l = assignProject(l, meta('j1'), 'Q-found', { kind: 'common' }, '共通在庫', true);
    const snapshot = initial(l, emptySupply);
    expect(parse(serialize(snapshot))).toEqual(snapshot);
  });
});

describe('F1-B 確認の文の品目・場所', () => {
  test('4.3・4.7: 品番・コードを変えた品目・場所と仮の品目は、内部の識別でなく現在の品番・コードで示す', () => {
    let l = changeMasters(withFound({ ...found, item: 'Q' }), meta('m1', '10:00'), { action: 'code', type: 'item', id: 'Q', code: '0012', reason: '正式IDの付与' });
    l = changeMasters(l, meta('m2', '10:01'), { action: 'code', type: 'location', id: 'S1', code: '棚-01', reason: '棚番の変更' });
    const adopt = confirmation(() => adoptProvisional(l, meta('a1'), 'p1', { id: 'Q-2', item: 'Q', unit: '個', project: { kind: 'common' }, location: 'T' }));
    expect(adopt.message).toContain('品目0012の現存する保管単位がある（Q-1：場所棚-01）');
    l = changeMasters(l, meta('m3', '10:02'), { action: 'register', master: { type: 'item', code: null, name: '品目不明の試作部品', units: ['個'], unitSteps: { '個': 1 }, trial: true, source: null } });
    l = register(l, meta('r2', '10:03'), { id: 'U-1', item: 'item-m3', unit: '個', project: { kind: 'unassigned' }, location: 'T' }, 'counted', 1);
    l = register(l, meta('r3', '10:04'), { id: 'U-2', item: 'item-m3', unit: '個', project: { kind: 'common' }, location: 'T' }, 'counted', 1);
    expect(confirmation(() => assignProject(l, meta('g1', '10:05'), 'U-1', { kind: 'common' }, '共通在庫と判明')).message).toContain('結び付け先に品目（仮）品目不明の試作部品の現存する保管単位がある（U-2：場所T）');
  });
});
