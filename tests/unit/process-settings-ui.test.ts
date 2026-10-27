import { describe, expect, test } from 'vitest';
import { changeMasters, changeStage, nextStage, practiceLedger, recordStop, register, start, type Ledger, type Meta } from '../../src/domain/ledger.ts';
import { stopProcessOptions } from '../../src/ui/fields.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { masterOps } from '../../src/ui/master-ui.ts';
import type { Values } from '../../src/ui/dom.ts';
import { operationGroups } from '../../src/ui/operation-picker.ts';
import { eventText, stageText } from '../../src/ui/format.ts';
import { processRef } from '../../src/domain/masters.ts';
import { viewSheetsOf } from '../../src/ui/viewsheets.ts';
import { startWithEstimate } from '../../src/domain/usage-estimate.ts';
import { initial, parse, serialize } from '../../src/ui/storage.ts';

const meta = (eventId: string, hour = 9): Meta => ({ eventId, occurredAt: `2026-10-27T${String(hour).padStart(2, '0')}:00:00+09:00`, recordedAt: '2026-10-27T18:00:00+09:00', actor: '架空担当A' });
const values = (entries: Record<string, string>): Values => ({ text: key => entries[key] ?? '', checked: () => false });
const product = { id: 'W', item: 'R', unit: '台', project: { kind: 'case' as const, id: 'A-001' }, location: 'T' };

function run(state: { ledger: Ledger; supply: typeof emptySupply }, key: string, entries: Record<string, string>, eventId: string, hour = 9) {
  const op = masterOps({ ledger: () => state.ledger, supply: () => state.supply })[key];
  if (op === undefined) throw new Error(`操作 ${key} がない`);
  return op.run(state, meta(eventId, hour), values(entries), undefined).state;
}

describe('工程の設定 3.1: 工程と次工程の設定の入力（1.1〜1.4・2.1・2.3〜2.5・3.1・3.4）', () => {
  test('新しい分類「工程の登録・設定」に3操作を置き、各分類は12件以内', () => {
    expect(operationGroups.find(g => g.id === 'processes')).toEqual({ id: 'processes', label: '工程の登録・設定', keys: ['masterProcess', 'masterProcessCriterion', 'masterNextProcess'] });
    for (const group of operationGroups) expect(group.keys.length).toBeLessThanOrEqual(12);
  });

  test('登録・完了基準の変更・名前の変更・利用停止・再開・次工程の指定を入力から記録する', () => {
    let state = { ledger: practiceLedger, supply: emptySupply };
    state = run(state, 'masterProcess', { name: '塗装', criterion: 'workEnd' }, 'p1', 8);
    expect(state.ledger.masters.processes['塗装']).toMatchObject({ name: '塗装', criterion: 'workEnd', active: true });
    state = run(state, 'masterProcessCriterion', { target: '塗装', criterion: 'inspection', reason: '確認を入れる' }, 'p2', 9);
    state = run(state, 'masterRename', { target: 'process:塗装', name: '塗装ライン', reason: '呼び方' }, 'p3', 10);
    state = run(state, 'masterDeactivate', { target: 'process:塗装', reason: '休止' }, 'p4', 11);
    state = run(state, 'masterReactivate', { target: 'process:塗装', reason: '再開' }, 'p5', 12);
    state = run(state, 'masterNextProcess', { location: 'S2', reason: '次工程の棚' }, 'p6', 13);
    expect(state.ledger.masters.processes['塗装']).toMatchObject({ name: '塗装ライン', criterion: 'inspection', active: true });
    state = run(state, 'masterNextProcess', { location: '', reason: '解除' }, 'p7', 14);
    expect(Object.values(state.ledger.masters.locations).some(l => l.nextProcess)).toBe(false);
  });

  test('完了基準の未選択と、品番・コードの変更への工程の指定は拒否し、台帳を変えない', () => {
    const state = { ledger: practiceLedger, supply: emptySupply }, before = JSON.stringify(state);
    expect(() => run(state, 'masterProcess', { name: '塗装', criterion: '' }, 'p1')).toThrow('完了基準を選ぶ');
    expect(() => run(state, 'masterCode', { target: 'process:R組立', code: 'X', reason: '付与' }, 'p2')).toThrow('対象の登録情報を選ぶ');
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe('工程の設定 3.2: 中断の工程の選択肢（2.3）', () => {
  test('中断では、利用停止中でも工程内の物がある工程を選べ、工程内の物がない停止中の工程は出さない', () => {
    let l = changeMasters(practiceLedger, meta('reg', 7), { action: 'register', master: { type: 'process', name: '塗装', criterion: 'workEnd' } });
    l = start(l, meta('s1', 8), product, { id: 'R組立', criterion: 'inspection' }, 'counted', 2, []);
    l = changeMasters(l, meta('off', 9), { action: 'deactivate', type: 'process', id: 'R組立', reason: '休止' });
    l = changeMasters(l, meta('off2', 9), { action: 'deactivate', type: 'process', id: '塗装', reason: '休止' });
    expect(stopProcessOptions(l)).toEqual([['R組立', '工程R組立（利用停止）（完了基準：作業終了後の確認の完了）']]);
    expect(recordStop(l, meta('stop', 10), { process: 'R組立', item: 'R', unit: '台', project: { kind: 'case', id: 'A-001' }, reason: '部品不足', shortage: null, affected: null }).stops['stop']?.process).toBe('R組立');
  });

  test('全数を完成させてから利用停止した工程でも、作業中だった過去の中断を記録できる', () => {
    let l = start(practiceLedger, meta('s1', 8), product, { id: 'R組立', criterion: 'inspection' }, 'counted', 2, []);
    l = changeStage(l, meta('e1', 10), 'W', 'W2', 'counted', 2, nextStage(l.lots['W']!.stage)!);
    l = changeStage(l, meta('e2', 11), 'W2', 'W3', 'counted', 2, nextStage(l.lots['W2']!.stage)!);
    l = changeMasters(l, meta('off', 12), { action: 'deactivate', type: 'process', id: 'R組立', reason: '休止' });
    expect(stopProcessOptions(l).map(([id]) => id)).toEqual(['R組立']);
    expect(recordStop(l, meta('stop', 9), { process: 'R組立', item: 'R', unit: '台', project: { kind: 'case', id: 'A-001' }, reason: '部品不足', shortage: null, affected: null }).stops['stop']?.process).toBe('R組立');
  });
});

describe('工程の設定 3.3: 一覧・履歴・保存文字列の工程名（2.6・4.5・6.3）', () => {
  test('一覧は今の名前と利用停止、履歴は記録当時の名前、旧版の工程はIDで示す', () => {
    let l = start(practiceLedger, meta('s1', 9), product, { id: 'R組立', criterion: 'inspection' }, 'counted', 2, []);
    const startedText = eventText(l, l.history.at(-1)!);
    expect(startedText).toContain('工程R組立・作業中');
    l = changeMasters(l, meta('rn', 10), { action: 'rename', type: 'process', id: 'R組立', name: '組立ライン1', reason: '呼び方' });
    l = changeMasters(l, meta('off', 11), { action: 'deactivate', type: 'process', id: 'R組立', reason: '休止' });
    expect(stageText(l.lots.W!.stage, id => processRef(l.masters, id))).toBe('工程組立ライン1（利用停止）・作業中');
    expect(eventText(l, l.history.find(e => e.eventId === 's1')!)).toBe(startedText);
  });

  test('材料の使用先は記録したときの工程名で書く', () => {
    let l = changeMasters(practiceLedger, meta('reg', 8), { action: 'register', master: { type: 'process', name: '塗装', criterion: 'workEnd' } });
    l = changeMasters(l, meta('rn', 8), { action: 'rename', type: 'process', id: '塗装', name: '塗装ライン', reason: '呼び方' });
    l = register(l, meta('part', 8), { id: 'P1', item: 'P', unit: '個', project: { kind: 'case', id: 'A-001' }, location: 'S1' }, 'counted', 10);
    const done = startWithEstimate({ ledger: l, supply: emptySupply }, meta('s1', 9), { lot: product, process: { id: '塗装', criterion: 'workEnd' }, basis: 'counted', value: 1, templateId: null, rows: [], manual: [{ lotId: 'P1', basis: 'counted', value: 2 }] });
    expect(done.ledger.history.find(e => e.kind === 'use')).toMatchObject({ usedFor: 'Wの着手（工程塗装ライン）' });
    expect(parse(serialize(initial(done.ledger, done.supply)))?.ledger).toEqual(done.ledger);
  });

  test('Excelの「工程の設定」シートに工程と次工程の場所を出す', () => {
    const l = changeMasters(practiceLedger, meta('reg', 8), { action: 'register', master: { type: 'process', name: '塗装', criterion: 'workEnd' } });
    const sheet = viewSheetsOf({ ledger: l, supply: emptySupply }, '2026-10-27T18:00:00+09:00').find(s => s.name === '工程の設定');
    expect(sheet?.columns.map(c => c.header)).toEqual(['種類', 'ID', '名前', '完了基準', '利用状況']);
    expect(sheet?.rows).toEqual([
      ['工程', 'R組立', 'R組立', '作業終了後の確認の完了', '利用中'],
      ['工程', '塗装', '塗装', '作業終了', '利用中'],
      ['次工程の場所', 'N', '次工程N', '対象外', '利用中'],
    ]);
  });
});
