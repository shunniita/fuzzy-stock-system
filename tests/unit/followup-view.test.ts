import { fixedMasters } from '../../src/domain/masters.ts';
import { describe, expect, test } from 'vitest';
import {
  correctOccurredAt, declareDiscrepancy, practiceLedger, handOver, hold, merge,
  recordStop, register, resumeWork, voidRecord, type Ledger, type Meta, type Project,
} from '../../src/domain/ledger.ts';
import type { Basis } from '../../src/domain/quantity.ts';
import {
  allocateArrival, cancelRequest, declareShortage, emptySupply, receiveLot, recordReply,
  recordRequest, registerNeed, reviseReceipt, type Reply, type Supply,
} from '../../src/domain/supply.ts';
import { followupRowsOf, followupText, type FollowupRow } from '../../src/ui/followupview.ts';

const project = { kind: 'case', id: 'A-001' } satisfies Project;
const asOf = '2026-10-05';
function meta(eventId: string, time = '12:00'): Meta {
  const at = `2026-09-29T${time}:00+09:00`;
  return { eventId, occurredAt: at, recordedAt: at, actor: '架空担当A' };
}
const lotOf = (id: string, membership: Project = project, unit = '個') => ({ id, project: membership, item: 'P', unit, location: 'S1' });
function need(quantity = 20): Supply {
  return registerNeed(emptySupply, fixedMasters, meta('need', '07:00'), {
    project, item: 'P', unit: '個', required: { basis: 'counted', value: quantity },
    dueDate: '2026-10-10', source: '架空部品一覧', revision: '初版',
  });
}
function request(supply: Supply, id = 'request', reply: Reply = { kind: 'none' }, membership: Project = project, unit = '個'): Supply {
  return recordRequest(supply, fixedMasters, meta(id, '08:00'), {
    project: membership, item: 'P', unit, quantity: 5, vendor: '架空仕入先', requestedOn: '2026-09-29', reply,
  });
}
function rowOf(ledger: Ledger, supply: Supply): FollowupRow {
  const row = followupRowsOf(ledger, supply, asOf).find((r) => r.key.project.kind === 'case' && r.key.project.id === 'A-001' && r.key.item === 'P' && r.key.unit === '個');
  if (!row) throw new Error('案件・用途A-001・品目P・個の行がない');
  return row;
}
function pending(basis: Basis = 'counted', value: number | null = 4): Ledger {
  const ledger = register(practiceLedger, meta('register', '07:00'), lotOf('return'), basis, value);
  return hold(ledger, meta('hold', '07:10'), 'return', 'returnPending');
}
function stop(ledger: Ledger = practiceLedger, membership: Project = project, unit = '個', withShortage = true, id = 'stop'): Ledger {
  return recordStop(ledger, meta(id, '08:00'), {
    process: 'R組立', item: 'R', unit: '台', project: membership, reason: '材料待ち',
    shortage: withShortage ? { item: 'P', unit, value: 99 } : null, affected: null,
  });
}
function conflicted(kind: 'overAllocated' | 'predatedArrivals' | 'predatedRevisions', reply: Reply): { ledger: Ledger; supply: Supply } {
  const initial = request(request(need(), 'bad'), 'clean', reply);
  const received = receiveLot(practiceLedger, initial, meta('receipt', '09:00'), lotOf('receipt-lot'), 'counted', 4);
  let ledger = received.ledger;
  let supply = allocateArrival(ledger, received.supply, meta('arrival', '09:05'), 'bad', { receiptLotId: 'receipt-lot', arrived: 2, good: 2 });
  if (kind === 'overAllocated') supply = reviseReceipt(ledger, supply, meta('revision', '09:10'), 'receipt-lot', 1, '架空の訂正');
  if (kind === 'predatedArrivals') ledger = correctOccurredAt(ledger, meta('correction', '11:00'), 'receipt', '2026-09-29T10:00:00+09:00');
  if (kind === 'predatedRevisions') {
    supply = reviseReceipt(ledger, supply, meta('revision', '09:03'), 'receipt-lot', 3, '架空の訂正');
    ledger = correctOccurredAt(ledger, meta('correction', '11:00'), 'receipt', '2026-09-29T09:04:00+09:00');
  }
  return { ledger, supply };
}

describe('B3 7.1〜7.6・9.1・9.2 未着・不足・対応一覧（FH-B03の文言部分）', () => {
  test('記録がなければ空の一覧を表示する', () => {
    expect(followupRowsOf(practiceLedger, emptySupply, asOf)).toEqual([]);
    expect(followupText(practiceLedger, emptySupply, asOf)).toContain('記録はまだない');
  });

  test('一つの群に当てはまる五つの状態をすべて残し、中断を推定しない', () => {
    const supply = request(request(need(), 'no-reply'), 'late', { kind: 'answered', date: '2026-10-01' });
    const row = rowOf(pending(), supply);
    expect(row.flags).toEqual(['未手配', '依頼済み', '納期未回答', '入荷遅れ', '返却待ち']);
    expect(row.stops).toEqual([]);
    expect(row.undecided).toEqual([]);
  });

  test('必要な数だけなら未手配を示す', () => {
    expect(rowOf(practiceLedger, need()).flags).toEqual(['未手配']);
  });

  test('予定日当日は入荷遅れにしない', () => {
    const supply = request(need(), 'request', { kind: 'answered', date: asOf });
    expect(rowOf(practiceLedger, supply).flags).toEqual(['未手配', '依頼済み']);
  });

  test('回答済み予定日が必要日より後でも、予定日超過前には入荷遅れにしない', () => {
    const supply = request(need(), 'request', { kind: 'estimated', date: '2026-10-11' });
    expect(rowOf(practiceLedger, supply).flags).not.toContain('入荷遅れ');
    expect(followupText(practiceLedger, supply, asOf)).toContain('推定の予定日2026-10-11');
  });

  test('納期未回答と相手の回答した予定日を別の文字で示す', () => {
    let supply = request(need());
    expect(followupText(practiceLedger, supply, asOf)).toContain('未回答');
    supply = recordReply(supply, fixedMasters, meta('reply'), 'request', { kind: 'answered', date: '2026-10-08' });
    const text = followupText(practiceLedger, supply, asOf);
    expect(text).toContain('相手が回答した予定日2026-10-08');
    expect(rowOf(practiceLedger, supply).flags).not.toContain('納期未回答');
  });

  test('取消後は依頼済み・納期未回答・入荷遅れを外し、依頼の元記録を残す', () => {
    const supply = cancelRequest(request(need(), 'request', { kind: 'answered', date: '2026-10-01' }), fixedMasters, meta('cancel'), 'request', '架空の取消');
    expect(rowOf(practiceLedger, supply).flags).toEqual(['未手配']);
    expect(followupText(practiceLedger, supply, asOf)).toContain('依頼 request：取消済み');
  });

  test('全量到着後は未着の状態を外しても、中断は別記録の再開まで残す', () => {
    const received = receiveLot(stop(), request(need(5)), meta('receipt', '09:00'), lotOf('receipt-lot'), 'counted', 5);
    const supply = allocateArrival(received.ledger, received.supply, meta('arrival', '09:05'), 'request', { receiptLotId: 'receipt-lot', arrived: 5, good: 5 });
    const row = rowOf(received.ledger, supply);
    expect(row.flags).toEqual([]);
    expect(row.stops.join('\n')).toContain('中断 stop');
    expect(row.stops.join('\n')).toContain('影響数不明');
    const resumed = resumeWork(received.ledger, meta('resume'), 'stop');
    expect(rowOf(resumed, supply).stops).toEqual([]);
  });

  test('中断だけの群は不足品目・不足単位で残し、中断不足99から手配や未着を作らない', () => {
    const ledger = stop();
    const row = rowOf(ledger, emptySupply);
    expect(row.key).toEqual({ project, item: 'P', unit: '個' });
    expect(row.flags).toEqual([]);
    expect(row.undecided.join('\n')).toContain('必要な数が未登録');
    expect(row.stops.join('\n')).toContain('工程R組立・品目R（台）');
    const text = followupText(ledger, emptySupply, asOf);
    expect(text).toContain('必要な数：未登録');
    expect(text).toContain('依頼済み 0個／依頼の未着 0個');
    expect(text).not.toContain('該当する状態なし');
    expect(followupRowsOf(resumeWork(ledger, meta('resume'), 'stop'), emptySupply, asOf)).toEqual([]);
  });

  test('不足品目のない中断だけでは行を作らない', () => {
    expect(followupRowsOf(stop(practiceLedger, project, '個', false), emptySupply, asOf)).toEqual([]);
  });

  test('中断を案件・用途・不足単位ごとに分け、同じ群の複数中断をすべて残す', () => {
    let ledger = stop();
    ledger = stop(ledger, project, '個', true, 'same');
    ledger = stop(ledger, project, '箱', true, 'box');
    ledger = stop(ledger, { kind: 'common' }, '個', true, 'common');
    ledger = stop(ledger, { kind: 'unassigned' }, '個', true, 'unassigned');
    ledger = stop(ledger, { kind: 'case', id: 'B-001' }, '個', true, 'other');
    expect(followupRowsOf(ledger, emptySupply, asOf)).toHaveLength(5);
    expect(rowOf(ledger, emptySupply).stops).toHaveLength(2);
    expect(rowOf(ledger, emptySupply).stops.join('\n')).not.toMatch(/中断 (box|common|unassigned|other)：/);
  });

  test('供給の記録がなくても返却待ちの現物だけの群を残す', () => {
    expect(rowOf(pending(), emptySupply).flags).toEqual(['返却待ち']);
  });

  test('全量4個の実返却で行が消え、間違えた記録の取り消しで返却待ちが戻る', () => {
    const ledger = handOver(pending(), meta('handover', '09:00'), 'return', 'counted', 4, '架空仕入先へ返却');
    expect(followupRowsOf(ledger, emptySupply, asOf)).toEqual([]);
    expect(rowOf(voidRecord(ledger, meta('void'), 'handover', '実際は返却なし'), emptySupply).flags).toEqual(['返却待ち']);
  });

  test.each([
    ['counted', 0, null],
    ['label', 0, '中身未確認'],
    ['approximate', 0, '約0個'],
    ['unknown', null, '数が不明'],
  ] satisfies [Basis, number | null, string | null][])('返却待ちの根拠%s・%sでは確実な0だけを外す', (basis, value, pattern) => {
    const ledger = pending(basis, value);
    if (pattern === null) expect(followupRowsOf(ledger, emptySupply, asOf)).toEqual([]);
    else {
      const row = rowOf(ledger, emptySupply);
      expect(row.flags).toContain('返却待ち');
      expect(row.undecided.join('\n')).toContain(pattern);
      expect(row.undecided.join('\n')).toContain('保管単位return');
    }
  });

  test('数えた0でも未解決の確認事項があれば返却待ちと確認が必要を残す', () => {
    const ledger = declareDiscrepancy(pending('counted', 0), meta('issue'), 'return', '架空の差異確認');
    const row = rowOf(ledger, emptySupply);
    expect(row.flags).toContain('返却待ち');
    expect(row.undecided.join('\n')).toContain('確認が必要');
    expect(row.undecided.join('\n')).toContain('issue');
  });

  test('数値部分0と数が不明が混在する返却待ちを確実な0として外さない', () => {
    let ledger = pending('counted', 0);
    ledger = register(ledger, meta('unknown-register', '07:00'), lotOf('unknown'), 'unknown', null);
    ledger = hold(ledger, meta('unknown-hold', '07:10'), 'unknown', 'returnPending');
    ledger = merge(ledger, meta('merge'), 'unknown', 'return');
    expect(rowOf(ledger, emptySupply).flags).toContain('返却待ち');
    expect(rowOf(ledger, emptySupply).undecided.join('\n')).toContain('全体数量は不明');
  });

  test('統合済みの元を返却待ちの根拠として重ねない', () => {
    let ledger = register(pending(), meta('target', '07:00'), lotOf('target'), 'counted', 4);
    ledger = hold(ledger, meta('target-hold', '07:10'), 'target', 'returnPending');
    ledger = merge(ledger, meta('merge', '08:00'), 'return', 'target');
    ledger = handOver(ledger, meta('handover', '09:00'), 'target', 'counted', 8, '架空仕入先へ返却');
    expect(followupRowsOf(ledger, emptySupply, asOf)).toEqual([]);
  });

  test('返却待ちだけの案件・用途・共通・所属不明・単位の違いを混ぜない', () => {
    let ledger = pending();
    for (const [id, membership, unit] of [
      ['common', { kind: 'common' }, '個'], ['unassigned', { kind: 'unassigned' }, '個'],
      ['other', { kind: 'case', id: 'B-001' }, '個'], ['box', project, '箱'],
    ] satisfies [string, Project, string][]) {
      ledger = register(ledger, meta(`${id}-register`, '07:00'), lotOf(id, membership, unit), 'counted', 4);
      ledger = hold(ledger, meta(`${id}-hold`, '07:10'), id, 'returnPending');
    }
    expect(followupRowsOf(ledger, emptySupply, asOf)).toHaveLength(5);
    const text = followupText(ledger, emptySupply, asOf);
    for (const label of ['案件・用途A-001', '案件・用途B-001', '共通在庫', '案件・用途が不明', '品目P（箱）']) expect(text).toContain(label);
  });

  test('未知の必要な数を不足なし・未手配なしと断定しない', () => {
    const supply = registerNeed(emptySupply, fixedMasters, meta('need'), { project, item: 'P', unit: '個', required: { basis: 'unknown', value: null }, dueDate: null, source: '架空の未確認一覧', revision: '初版' });
    expect(rowOf(practiceLedger, supply).undecided.join('\n')).toContain('必要な数が不明');
    expect(followupText(practiceLedger, supply, asOf)).not.toContain('該当する状態なし');
  });

  test('独立した数が不明の申告による手配対象数の保留理由を残す', () => {
    const supply = declareShortage(need(), fixedMasters, meta('declaration'), { project, item: 'P', unit: '個', value: null, reason: '架空の不足申告' });
    expect(rowOf(practiceLedger, supply).undecided.join('\n')).toContain('不足が不明');
  });

  test('だいたい・表示の数（ラベル・パッケージ）を含む不足は確定していない理由を添える', () => {
    const ledger = register(practiceLedger, meta('register'), lotOf('label'), 'label', 20);
    const row = rowOf(ledger, need());
    expect(row.flags).not.toContain('未手配');
    expect(row.undecided.join('\n')).toContain('不足が確定していない');
    expect(row.undecided.join('\n')).toContain('中身未確認');
  });

  test('仮の割当でも該当する状態を表示し、仮の注記を添える', () => {
    const received = receiveLot(practiceLedger, request(need()), meta('receipt', '09:00'), lotOf('provisional'), 'label', 2);
    const supply = allocateArrival(received.ledger, received.supply, meta('arrival', '09:05'), 'request', { receiptLotId: 'provisional', arrived: 2, good: 2 });
    const row = rowOf(received.ledger, supply);
    expect(row.flags).toEqual(['依頼済み', '納期未回答']);
    expect(row.provisional).toBe(true);
    expect(followupText(received.ledger, supply, asOf)).toContain('仮の割当を含む');
  });

  test.each(['overAllocated', 'predatedArrivals', 'predatedRevisions'] satisfies ('overAllocated' | 'predatedArrivals' | 'predatedRevisions')[])('%sを依頼別に判定し、同じ群の正常な依頼の未回答を抑えない', (kind) => {
    const { ledger, supply } = conflicted(kind, { kind: 'none' });
    const row = rowOf(ledger, supply);
    expect(row.flags).toContain('納期未回答');
    expect(row.undecided.join('\n')).toContain('依頼 badの納期は確認待ち');
    expect(row.undecided.join('\n')).not.toContain('依頼 cleanの納期は確認待ち');
    expect(row.flags).not.toContain('未手配');
  });

  test.each(['overAllocated', 'predatedArrivals', 'predatedRevisions'] satisfies ('overAllocated' | 'predatedArrivals' | 'predatedRevisions')[])('%sの依頼を未回答扱いせず、同じ群の正常な依頼の入荷遅れを残す', (kind) => {
    const { ledger, supply } = conflicted(kind, { kind: 'answered', date: '2026-10-01' });
    const row = rowOf(ledger, supply);
    expect(row.flags).toContain('入荷遅れ');
    expect(row.flags).not.toContain('納期未回答');
    const reasons = row.undecided.join('\n');
    expect(reasons).toContain(kind === 'overAllocated' ? '過剰割り当て' : kind === 'predatedArrivals' ? '割り当ての日時が受け取りより前' : '実際に受け取った数の訂正の日時が受け取りより前');
  });

  test('文言の列を必要な数・未着と依頼・状態と判定・実中断で分け、描画用の導出で記録を変えない', () => {
    const ledger = stop(pending());
    const supply = request(need());
    const before = JSON.stringify({ ledger, supply });
    const text = followupText(ledger, supply, asOf);
    for (const label of ['品目P（個）', '必要な数：', '未着・依頼：', '状態・判定：', 'その不足で止まっている作業：', '中断 stop', '依頼 request', '必要明細 need']) expect(text).toContain(label);
    expect(JSON.stringify({ ledger, supply })).toBe(before);
  });
});
