import { describe, expect, test } from 'vitest';
import { changeMasters, practiceLedger, move, register, type Ledger, type MasterRequest, type Meta } from '../../src/domain/ledger.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { eventText, itemNameText, itemRef, locationRef, projectText, totalsOf, totalsText, trialText } from '../../src/ui/format.ts';
import { candidatesText } from '../../src/ui/master-ui.ts';
import { viewSheetsOf } from '../../src/ui/viewsheets.ts';

const day = (time: string): string => `2026-10-09T${time}:00+09:00`;
const meta = (eventId: string, time: string): Meta => ({ eventId, occurredAt: day(time), recordedAt: day(time), actor: '架空担当A' });
const change = (l: Ledger, id: string, time: string, request: MasterRequest): Ledger => changeMasters(l, meta(id, time), request);
const lotsRow = (ledger: Ledger, lotId: string): readonly string[] => {
  const sheet = viewSheetsOf({ ledger, supply: emptySupply }, day('23:00')).find((s) => s.name === '保管単位');
  const row = sheet?.rows.find((r) => r[0] === lotId);
  if (!row) throw new Error(`行がない：${lotId}`);
  return row;
};

describe('F1-B 6.1 登録情報の現在の品番・コードと名称を表示する', () => {
  const base = register(practiceLedger, meta('r1', '08:00'), { id: 'P-1', item: 'P', unit: '個', project: { kind: 'case', id: 'A-001' }, location: 'S1' }, 'counted', 5);

  test('履歴は当時の品目コードと名称を示し、現在の一覧の文言は維持する', () => {
    expect(eventText(base, base.history[0]!)).toBe('登録：P-1（品目P「架空部品P」、案件・用途A-001、S1）5個・数えた');
    expect(itemNameText(base.masters, 'P')).toBe('架空部品P');
    expect(lotsRow(base, 'P-1').slice(0, 6)).toEqual(['P-1', 'P', '架空部品P', '個', 'S1', '案件・用途A-001']);
  });

  test('4.3: 品番・コードを変えても過去の品目表示と識別は維持し、案件・用途と場所は現在コードを示す', () => {
    let l = change(base, 'm1', '09:00', { action: 'code', type: 'item', id: 'P', code: '0012', reason: '正式IDの付与' });
    l = change(l, 'm2', '09:01', { action: 'code', type: 'location', id: 'S1', code: '棚-01', reason: '棚番の変更' });
    l = change(l, 'm3', '09:02', { action: 'code', type: 'case', id: 'A-001', code: 'A-101', reason: '案件IDの変更' });
    expect(l.lots['P-1']).toMatchObject({ item: 'P', location: 'S1', project: { kind: 'case', id: 'A-001' } });
    expect(eventText(l, l.history[0]!)).toBe('登録：P-1（品目P「架空部品P」、案件・用途A-101、棚-01）5個・数えた');
    expect(totalsText(l.masters, totalsOf(l, [l.lots['P-1']!])[0]!)).toMatch(/^品目0012（個）/);
    expect(lotsRow(l, 'P-1').slice(0, 6)).toEqual(['P-1', '0012', '架空部品P', '個', '棚-01', '案件・用途A-101']);
  });

  test('3.2・4.7: 仮の品目は「（仮）名称」、利用停止は「（利用停止）」を付ける', () => {
    let l = change(base, 'm1', '09:00', { action: 'register', master: { type: 'item', code: null, name: '品目不明の試作ネジ', units: ['本'], unitSteps: { '本': 1 }, trial: true, source: null } });
    l = register(l, meta('r2', '09:10'), { id: 'N-1', item: 'item-m1', unit: '本', project: { kind: 'common' }, location: 'S2' }, 'counted', 3);
    l = change(l, 'm2', '09:20', { action: 'deactivate', type: 'item', id: 'P', reason: '廃番' });
    l = change(l, 'm3', '09:21', { action: 'deactivate', type: 'case', id: 'A-001', reason: '完了' });
    expect(itemRef(l.masters, 'item-m1')).toBe('（仮）品目不明の試作ネジ');
    expect(itemNameText(l.masters, 'item-m1')).toBe('品目不明の試作ネジ（品番・コードなし（仮））');
    expect(itemRef(l.masters, 'P')).toBe('P（利用停止）');
    expect(itemNameText(l.masters, 'P')).toBe('架空部品P（利用停止）');
    expect(projectText(l.masters, { kind: 'case', id: 'A-001' })).toBe('案件・用途A-001（利用停止）');
    expect(lotsRow(l, 'N-1').slice(0, 3)).toEqual(['N-1', '（仮）品目不明の試作ネジ', '品目不明の試作ネジ（品番・コードなし（仮））']);
    expect(lotsRow(l, 'P-1').slice(0, 3)).toEqual(['P-1', 'P（利用停止）', '架空部品P（利用停止）']);
    // 知らないIDは、そのまま見せる
    expect(itemRef(l.masters, 'Z')).toBe('Z');
    expect(locationRef(l.masters, '__proto__')).toBe('__proto__');
  });

  test('7.6: 今は記録の対象外の場所への過去の配置には、記録の時点では記録の対象だったと注記する', () => {
    let l = move(base, meta('v1', '09:00'), 'P-1', 'S2');
    l = move(l, meta('v2', '09:30'), 'P-1', 'T');
    l = change(l, 'm1', '10:00', { action: 'scope', id: 'S1', inScope: false, reason: '棚の撤去' });
    const note = '（記録の時点では記録の対象。場所S1は2026-10-09 10:00（日本時間）から記録の対象外）';
    expect(eventText(l, l.history[0]!)).toBe(`登録：P-1（品目P「架空部品P」、案件・用途A-001、S1）5個・数えた${note}`);
    expect(eventText(l, l.history[1]!)).not.toContain('記録の時点では');
    expect(eventText(l, l.history[2]!)).not.toContain('記録の時点では');
    expect(trialText(l.masters, l.lots['P-1']!)).toBe('試行対象');
  });
});

describe('F1-B 8.2・8.4 確認の文に現存する保管単位の数量・根拠・案件・用途を示す', () => {
  test('候補ごとに数量と根拠、案件・用途を示す。現存しない識別は飛ばす', () => {
    const l = register(practiceLedger, meta('r1', '08:00'), { id: 'R-2', item: 'R', unit: '台', project: { kind: 'case', id: 'A-002' }, location: 'S2' }, 'counted', 1);
    const text = candidatesText(l, ['R-2', 'なし']);
    expect(text).toContain('R-2は1台');
    expect(text).toContain('数えた');
    expect(text).toContain('A-002');
    expect(text).not.toContain('なし');
    expect(candidatesText(l, [])).toBe('');
  });
});
