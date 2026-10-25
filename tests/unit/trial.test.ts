import { describe, expect, test } from 'vitest';
import { changeMasters, declareDiscrepancy, practiceLedger, hold, register, type Ledger, type MasterRequest, type Meta, type TrialReview } from '../../src/domain/ledger.ts';
import { eventText, trialText } from '../../src/ui/format.ts';

const at = '2026-10-14T03:00:00+09:00';
const meta = (eventId: string): Meta => ({ eventId, actor: '架空担当A', occurredAt: at, recordedAt: '2026-10-14T03:05:00+09:00' });
const checks = (): TrialReview => ({ quantities: '既存7個と数が不明を別に確認', requests: '未完了依頼を確認', corrections: '訂正手順を確認', restore: '復元演習済み\r\n架空台帳', initial: '表示2個はラベル、Oは数が不明のまま' });
const enable = (type: 'item' | 'location' = 'item', id = 'X'): Extract<MasterRequest, { action: 'trial' }> => ({ action: 'trial', type, id, trial: true, review: checks(), reason: '架空の試行拡大' });
function base(): Ledger {
  let ledger = register(practiceLedger, meta('r1'), { id: 'p', item: 'P', unit: '個', location: 'S1', project: { kind: 'case', id: 'A-001' } }, 'counted', 7);
  ledger = register(ledger, meta('r2'), { id: 'x', item: 'X', unit: '個', location: 'S1', project: { kind: 'common' } }, 'label', 2);
  ledger = register(ledger, meta('r3'), { id: 'o', item: 'X', unit: '個', location: 'O', project: { kind: 'unassigned' } }, 'unknown', null);
  ledger = hold(ledger, meta('h'), 'p', 'defective', '架空の不良');
  return declareDiscrepancy(ledger, meta('i'), 'o', '不明のまま確認を引き継ぐ');
}

describe('試行変更1〜3: 現在対象だけを変更し確認記録を残す', () => {
  test('X追加→O追加→P除外で数量・根拠・所属・不良・確認事項を保持する', () => {
    const original = base();
    let ledger = changeMasters(original, meta('x'), enable());
    expect(trialText(ledger.masters, ledger.lots['x']!)).toBe('試行対象');
    expect(trialText(ledger.masters, ledger.lots['o']!)).toBe('対象外');
    ledger = changeMasters(ledger, meta('o'), enable('location', 'O'));
    expect(trialText(ledger.masters, ledger.lots['o']!)).toBe('試行対象');
    ledger = changeMasters(ledger, meta('p'), { action: 'trial', type: 'item', id: 'P', trial: false, review: null, reason: '架空の縮小' });
    expect(trialText(ledger.masters, ledger.lots['p']!)).toBe('対象外');
    expect(ledger.lots).toEqual(original.lots);
    expect(ledger.issues).toEqual(original.issues);
    expect(ledger.stops).toEqual(original.stops);
    expect(ledger.history.slice(0, original.history.length)).toEqual(original.history);
    expect(ledger.history.at(-1)).toMatchObject({ ...meta('p'), kind: 'master', action: 'trial', review: null, reason: '架空の縮小', confirmed: false, changes: [], masters: [{ before: { id: 'P', trial: true }, after: { id: 'P', trial: false } }] });
  });

  test('追加の五確認を複製し、後の名称・trial変更でも当時の値と原文を残す', () => {
    const review = checks();
    let ledger = changeMasters(base(), meta('x'), { action: 'trial', type: 'item', id: 'X', trial: true, review, reason: '追加' });
    review.initial = '呼出元の変更';
    const event = ledger.history.at(-1)!;
    ledger = changeMasters(ledger, meta('rename'), { action: 'rename', type: 'item', id: 'X', name: '架空の改名', reason: '識別改善' });
    ledger = changeMasters(ledger, meta('off'), { action: 'trial', type: 'item', id: 'X', trial: false, review: null, reason: '終了' });
    expect(event).toMatchObject({ review: checks() });
    expect(eventText(ledger, event)).toContain('対象外 → 試行対象');
    expect(eventText(ledger, event)).toContain('架空対象外部品X');
    expect(eventText(ledger, event)).toContain('人が確認した内容（実物一致・復元成功の自動保証ではない）');
    for (const value of Object.values(checks())) expect(eventText(ledger, event)).toContain(value);
    expect(eventText(ledger, ledger.history.at(-1)!)).toContain('試行対象 → 対象外');
  });

  test('中断中の対象も変更できるが利用再開や記録の対象変更にはならない', () => {
    let ledger = changeMasters(practiceLedger, meta('off'), { action: 'deactivate', type: 'location', id: 'O', reason: '一時停止' });
    ledger = changeMasters(ledger, meta('scope'), { action: 'scope', id: 'O', inScope: false, reason: '架空の範囲' });
    const before = ledger.masters.locations['O'];
    ledger = changeMasters(ledger, meta('trial'), enable('location', 'O'));
    expect(ledger.masters.locations['O']).toEqual({ ...before, trial: true });
  });

  const bad: [string, MasterRequest][] = [
    ['同値', enable('item', 'P')],
    ['未登録', enable('item', 'missing')],
    ['空理由', { ...enable(), reason: ' \t' }],
    ...Object.keys(checks()).map((key): [string, MasterRequest] => [key, { action: 'trial', type: 'item', id: 'X', trial: true, review: { ...checks(), [key]: ' \r\n ' }, reason: '追加' }]),
  ];
  test.each(bad)('%sを拒否して元の台帳を変えない', (_label, request) => {
    const ledger = base(); const before = JSON.stringify(ledger);
    expect(() => changeMasters(ledger, meta('bad'), request)).toThrow();
    expect(JSON.stringify(ledger)).toBe(before);
  });

  test('型境界外の案件・用途や除外時の確認内容を受け付けない', () => {
    // @ts-expect-error 外部入力が契約を破ったときの防御を確認する。
    expect(() => changeMasters(practiceLedger, meta('bad'), { action: 'trial', type: 'case', id: 'A-001', trial: true, review: checks(), reason: '不可' })).toThrow();
    // @ts-expect-error 除外に追加の確認内容を混ぜない。
    expect(() => changeMasters(practiceLedger, meta('bad'), { action: 'trial', type: 'item', id: 'P', trial: false, review: checks(), reason: '不可' })).toThrow();
  });
});
