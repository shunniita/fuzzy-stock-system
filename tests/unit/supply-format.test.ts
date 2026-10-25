import { describe, expect, test } from 'vitest';
import { fixedMasters } from '../../src/domain/masters.ts';
import type { Meta, Project } from '../../src/domain/ledger.ts';
import {
  allocateArrival,
  cancelRequest,
  confirmOrder,
  declareShortage,
  emptySupply,
  linkDeclaration,
  receiveLot,
  recordReply,
  recordRequest,
  registerNeed,
  reviseNeed,
  reviseArrival,
  reviseReceipt,
  type Supply,
} from '../../src/domain/supply.ts';
import { correctOccurredAt, practiceLedger } from '../../src/domain/ledger.ts';
import { receivedText, replyText, supplyEventText, supplyOccurredText } from '../../src/ui/supply-format.ts';
import { jst } from '../../src/ui/format.ts';

const b001: Project & { kind: 'case' } = { kind: 'case', id: 'B-001' };

function meta(eventId: string, hour = 9): Meta {
  const at = `2026-10-02T${String(hour).padStart(2, '0')}:00:00+09:00`;
  return { eventId, occurredAt: at, recordedAt: at, actor: '架空担当A' };
}

describe('供給の履歴の文言', () => {
  test('B3 3.4: 受け取りの履歴と受け入れた現物の一覧の文言に架空ラベルを表示する', () => {
    const label = '000123-架空箱';
    const r = receiveLot(practiceLedger, emptySupply, meta('e1'), { id: 'R1', item: 'P', unit: '個', project: b001, location: 'S1' }, 'counted', 5, label);
    expect(supplyEventText(fixedMasters, r.supply.log.at(-1)!)).toContain(`ラベル「${label}」`);
    expect(receivedText(5, 'confirmed', label)).toBe(`5・ラベル「${label}」`);
    expect(receivedText(5, 'provisional', label)).toBe(`5（仮）・ラベル「${label}」`);
    expect(receivedText(null, 'unconfirmed', label)).toContain(`ラベル「${label}」`);
    expect(receivedText(5, 'confirmed')).toBe('5');
    expect(receivedText(5, 'confirmed', null)).toBe('5');
    const unlabeled = receiveLot(practiceLedger, emptySupply, meta('e1'), { id: 'R1', item: 'P', unit: '個', project: b001, location: 'S1' }, 'counted', 5);
    expect(supplyEventText(fixedMasters, unlabeled.supply.log.at(-1)!)).not.toContain('架空ラベル');
  });

  test('実際に受け取った数の記録の実際の日時は、受け取りの登録の実際の日時（訂正後）と同じに示し、訂正前を添える', () => {
    const r = receiveLot(practiceLedger, emptySupply, meta('e1', 9), { id: 'R1', item: 'P', unit: '個', project: b001, location: 'S1' }, 'counted', 5);
    const record = r.supply.log.at(-1)!;
    expect(supplyOccurredText(r.ledger, record)).toBe(jst(record.occurredAt));
    const moved = correctOccurredAt(r.ledger, meta('t1', 12), 'e1', '2026-10-02T11:00:00+09:00');
    expect(supplyOccurredText(moved, record)).toBe(`${jst('2026-10-02T11:00:00+09:00')}（訂正前 ${jst(record.occurredAt)}）`);
  });

  test('表示の数（ラベル・パッケージ）・だいたいの受け取りの実際に受け取った数は「仮」と書き、数が不明の受け取りは「未確認」と書く', () => {
    const r = receiveLot(practiceLedger, emptySupply, meta('e1'), { id: 'R1', item: 'P', unit: '個', project: b001, location: 'S1' }, 'label', 100);
    expect(supplyEventText(fixedMasters, r.supply.log.at(-1)!)).toContain('届いた数100（仮');
    const u = receiveLot(practiceLedger, emptySupply, meta('e1'), { id: 'R1', item: 'P', unit: '個', project: b001, location: 'S1' }, 'unknown', null);
    expect(supplyEventText(fixedMasters, u.supply.log.at(-1)!)).toContain('届いた数 未確認');
  });

  test('必要明細・改訂・申告・対応付け・依頼・注文の確定・回答・取消が、何が起きたか読める文になる', () => {
    let s: Supply = registerNeed(emptySupply, fixedMasters, meta('n1'), { project: b001, item: 'P', unit: '個', required: { basis: 'counted', value: 100 }, dueDate: '2026-10-10', source: '架空の必要部品一覧', revision: '初版' });
    s = reviseNeed(s, fixedMasters, meta('n2'), 'n1', { required: { basis: 'approximate', value: 80 }, dueDate: null, source: '架空の必要部品一覧', revision: '改訂2' });
    s = declareShortage(s, fixedMasters, meta('d1'), { project: b001, item: 'P', unit: '個', value: null, reason: '数は不明だが足りない' });
    s = linkDeclaration(s, fixedMasters, meta('l1'), 'd1', true);
    s = recordRequest(s, fixedMasters, meta('q1'), { project: b001, item: 'P', unit: '個', quantity: 5, vendor: '架空の仕入先X', requestedOn: '2026-10-02', reply: { kind: 'none' } });
    s = confirmOrder(s, fixedMasters, meta('q2'), 'q1');
    s = recordReply(s, fixedMasters, meta('q3'), 'q1', { kind: 'estimated', date: '2026-10-08' });
    s = cancelRequest(s, fixedMasters, meta('q4'), 'q1', '現物が見つかった');
    const texts = s.log.map((e) => supplyEventText(fixedMasters, e));
    expect(texts[0]).toContain('必要明細');
    expect(texts[0]).toContain('B-001');
    expect(texts[0]).toContain('100個（数えた）');
    expect(texts[0]).toContain('必要日2026-10-10');
    expect(texts[1]).toContain('改訂');
    expect(texts[1]).toContain('100個（数えた）→約80個'.replace('約80個', '80個（だいたい）'));
    expect(texts[2]).toContain('足りない分の記録');
    expect(texts[2]).toContain('数が不明');
    expect(texts[3]).toContain('対応付け');
    expect(texts[4]).toContain('依頼');
    expect(texts[4]).toContain('5個');
    expect(texts[4]).toContain('未回答');
    expect(texts[5]).toContain('注文の確定');
    expect(texts[6]).toContain('推定の予定日2026-10-08');
    expect(texts[7]).toContain('取消');
    expect(texts[7]).toContain('現物が見つかった');
  });

  test('1.4: 元の資料だけを変える改訂も、改訂前後の元の資料が履歴の文に出る（変えていないときは元の資料を一度だけ示す）', () => {
    let s: Supply = registerNeed(emptySupply, fixedMasters, meta('n1'), { project: b001, item: 'P', unit: '個', required: { basis: 'counted', value: 100 }, dueDate: '2026-10-10', source: '必要部品一覧（旧）', revision: '初版' });
    s = reviseNeed(s, fixedMasters, meta('n2'), 'n1', { required: { basis: 'counted', value: 100 }, dueDate: '2026-10-10', source: '必要部品一覧（新）', revision: '初版' });
    const text = supplyEventText(fixedMasters, s.log.at(-1)!);
    expect(text).toContain('元の資料「必要部品一覧（旧）」→「必要部品一覧（新）」');
    const same = reviseNeed(s, fixedMasters, meta('n3'), 'n1', { required: { basis: 'counted', value: 90 }, dueDate: '2026-10-10', source: '必要部品一覧（新）', revision: '改訂2' });
    expect(supplyEventText(fixedMasters, same.log.at(-1)!)).toContain('元の資料「必要部品一覧（新）」');
    expect(supplyEventText(fixedMasters, same.log.at(-1)!)).not.toContain('→「');
  });

  test('受け取り・実際に受け取った数・割り当て・訂正が、届いた数と使える数を別々に示す', () => {
    let s = recordRequest(emptySupply, fixedMasters, meta('q1', 8), { project: b001, item: 'P', unit: '個', quantity: 5, vendor: '架空の仕入先X', requestedOn: '2026-10-02', reply: { kind: 'none' } });
    const r = receiveLot(practiceLedger, s, meta('e1'), { id: 'R1', item: 'P', unit: '個', project: b001, location: 'S1' }, 'counted', 5);
    s = allocateArrival(r.ledger, r.supply, meta('a1'), 'q1', { receiptLotId: 'R1', arrived: 5, good: 3 });
    s = reviseArrival(r.ledger, s, meta('a2'), 'q1', 'a1', { arrived: 4, good: 3 });
    s = reviseReceipt(r.ledger, s, meta('v1'), 'R1', 4, '4個だった');
    const texts = s.log.map((e) => supplyEventText(fixedMasters, e));
    expect(texts.find((t) => t.includes('実際に受け取った数の記録'))).toContain('R1');
    expect(texts.find((t) => t.includes('割り当て：'))).toMatch(/到着5.*良品3/);
    expect(texts.find((t) => t.includes('割り当ての訂正'))).toMatch(/到着5→4/);
    expect(texts.find((t) => t.includes('実際に受け取った数の訂正'))).toContain('5→4');
  });

  test('回答の文言は、未回答・推定の予定日・相手が回答した予定日を区別する', () => {
    expect(replyText({ kind: 'none' })).toBe('未回答');
    expect(replyText({ kind: 'estimated', date: '2026-10-08' })).toBe('推定の予定日2026-10-08');
    expect(replyText({ kind: 'answered', date: '2026-10-09' })).toBe('相手が回答した予定日2026-10-09');
  });
});
