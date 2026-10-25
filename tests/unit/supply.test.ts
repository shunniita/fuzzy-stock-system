import { fixedMasters } from '../../src/domain/masters.ts';
import { describe, expect, test } from 'vitest';
import {
  cancelRequest,
  confirmOrder,
  declareShortage,
  emptySupply,
  linkDeclaration,
  recordReply,
  recordRequest,
  registerNeed,
  reviseNeed,
  type Supply,
} from '../../src/domain/supply.ts';
import type { Meta, Project } from '../../src/domain/ledger.ts';

const b001: Project & { kind: 'case' } = { kind: 'case', id: 'B-001' };

function meta(eventId: string, hour = 9, minute = 0): Meta {
  const at = `2026-10-02T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+09:00`;
  return { eventId, occurredAt: at, recordedAt: at, actor: '架空担当A' };
}

const needP = {
  project: b001,
  item: 'P',
  unit: '個',
  required: { basis: 'counted', value: 100 },
  dueDate: '2026-10-10',
  source: '架空の必要部品一覧',
  revision: '初版',
} as const;

const withNeed = (): Supply => registerNeed(emptySupply, fixedMasters, meta('n1'), needP);

describe('要件1 必要明細', () => {
  test('1.1: 案件・用途・品目・単位の必要明細を登録でき、IDは記録した操作のID', () => {
    const s = withNeed();
    expect(s.needs['n1']).toMatchObject({ id: 'n1', project: b001, item: 'P', unit: '個', required: { basis: 'counted', value: 100 }, dueDate: '2026-10-10' });
    expect(s.log.at(-1)).toMatchObject({ kind: 'needRegister', eventId: 'n1', actor: '架空担当A' });
  });

  test('1.2: 品目・案件・用途のIDは先頭のゼロを含む文字列のまま保つ', () => {
    const masters = { ...fixedMasters, items: { ...fixedMasters.items, '0012': { ...fixedMasters.items.P!, id: '0012', code: '0012' } } };
    const s = registerNeed(emptySupply, masters, meta('n1'), { ...needP, item: '0012', project: { kind: 'case', id: '007' } });
    expect(s.needs['n1']).toMatchObject({ item: '0012', project: { id: '007' } });
  });

  test('1.1: 同じ案件・用途・品目・単位の必要明細は一つだけで、二つ目は拒否して改訂を案内する。単位が違えば別の明細', () => {
    const s = withNeed();
    expect(() => registerNeed(s, fixedMasters, meta('n2'), needP)).toThrow('改訂');
    expect(registerNeed(s, fixedMasters, meta('n2'), { ...needP, unit: '箱' }).needs['n2']).toBeDefined();
    expect(registerNeed(s, fixedMasters, meta('n3'), { ...needP, project: { kind: 'case', id: 'A-001' } }).needs['n3']).toBeDefined();
  });

  test('1.5: 必要な数は数が不明・だいたいも持てる。数が不明に値は持たせず、0は0として登録できる', () => {
    expect(registerNeed(emptySupply, fixedMasters, meta('n1'), { ...needP, required: { basis: 'unknown', value: null } }).needs['n1']?.required).toEqual({ basis: 'unknown', value: null });
    expect(registerNeed(emptySupply, fixedMasters, meta('n1'), { ...needP, required: { basis: 'approximate', value: 100 } }).needs['n1']?.required).toEqual({ basis: 'approximate', value: 100 });
    expect(registerNeed(emptySupply, fixedMasters, meta('n1'), { ...needP, required: { basis: 'counted', value: 0 } }).needs['n1']?.required.value).toBe(0);
    expect(() => registerNeed(emptySupply, fixedMasters, meta('n1'), { ...needP, required: { basis: 'unknown', value: 5 } })).toThrow();
    expect(() => registerNeed(emptySupply, fixedMasters, meta('n1'), { ...needP, required: { basis: 'counted', value: null } })).toThrow();
    expect(() => registerNeed(emptySupply, fixedMasters, meta('n1'), { ...needP, required: { basis: 'counted', value: -1 } })).toThrow();
  });

  test('必要日は実在する日付だけ。必要日なし（null）と元の資料・改訂は扱いが決まっている', () => {
    expect(() => registerNeed(emptySupply, fixedMasters, meta('n1'), { ...needP, dueDate: '2026-02-30' })).toThrow('日付');
    expect(() => registerNeed(emptySupply, fixedMasters, meta('n1'), { ...needP, dueDate: '2026/10/10' })).toThrow('日付');
    expect(registerNeed(emptySupply, fixedMasters, meta('n1'), { ...needP, dueDate: null }).needs['n1']?.dueDate).toBeNull();
    expect(() => registerNeed(emptySupply, fixedMasters, meta('n1'), { ...needP, source: ' ' })).toThrow('元の資料');
    expect(() => registerNeed(emptySupply, fixedMasters, meta('n1'), { ...needP, revision: '' })).toThrow('改訂');
    expect(() => registerNeed(emptySupply, fixedMasters, meta('n1'), { ...needP, unit: ' ' })).toThrow('単位');
  });

  test('1.4: 必要な数の改訂は前後と改訂の識別を履歴に残し、ほかの明細に触れない', () => {
    let s = withNeed();
    s = registerNeed(s, fixedMasters, meta('n2'), { ...needP, item: 'Q' });
    const before = s;
    s = reviseNeed(s, fixedMasters, meta('n3', 10), 'n1', { required: { basis: 'counted', value: 80 }, dueDate: '2026-10-12', source: '架空の必要部品一覧', revision: '改訂2' });
    expect(s.needs['n1']).toMatchObject({ required: { value: 80 }, dueDate: '2026-10-12', revision: '改訂2' });
    expect(s.needs['n2']).toBe(before.needs['n2']);
    const e = s.log.at(-1);
    expect(e).toMatchObject({ kind: 'needRevise', eventId: 'n3' });
    expect(e?.kind === 'needRevise' && [e.before.required.value, e.after.required.value, e.before.revision, e.after.revision]).toEqual([100, 80, '初版', '改訂2']);
  });

  test('改訂は存在する明細だけ。何も変わらない改訂は拒否する', () => {
    const s = withNeed();
    expect(() => reviseNeed(s, fixedMasters, meta('n3'), 'zzz', { required: { basis: 'counted', value: 80 }, dueDate: null, source: 'x', revision: 'y' })).toThrow('必要明細');
    const same = { required: needP.required, dueDate: needP.dueDate, source: needP.source, revision: needP.revision };
    expect(() => reviseNeed(s, fixedMasters, meta('n3'), 'n1', same)).toThrow('変わっていない');
  });
});

describe('要件3 足りない分の記録', () => {
  const decl = { project: b001, item: 'P', unit: '個', value: 5, reason: '作業中に5個足りないと気付いた' } as const;

  test('3.1: 不足を申告でき、数が不明も申告できる。申告者・日時が残る', () => {
    let s = declareShortage(emptySupply, fixedMasters, meta('d1', 10), decl);
    s = declareShortage(s, fixedMasters, meta('d2', 11), { ...decl, value: null });
    expect(s.declarations['d1']).toMatchObject({ id: 'd1', value: 5, linked: false });
    expect(s.declarations['d2']?.value).toBeNull();
    expect(s.log.at(-1)).toMatchObject({ kind: 'shortageDeclare', actor: '架空担当A', occurredAt: '2026-10-02T11:00:00+09:00' });
    expect(() => declareShortage(s, fixedMasters, meta('d3'), { ...decl, reason: ' ' })).toThrow('理由');
    expect(() => declareShortage(s, fixedMasters, meta('d3'), { ...decl, unit: '' })).toThrow('単位');
    expect(() => declareShortage(s, fixedMasters, meta('d3'), { ...decl, value: -2 })).toThrow();
  });

  test('3.1: 共通在庫・所属不明の不足も申告できる', () => {
    expect(declareShortage(emptySupply, fixedMasters, meta('d1'), { ...decl, project: { kind: 'common' } }).declarations['d1']?.project).toEqual({ kind: 'common' });
  });

  test('3.2: 対応付けには同じ案件・用途・品目・単位の必要明細が要り、解除はいつでもできる', () => {
    let s = declareShortage(emptySupply, fixedMasters, meta('d1'), decl);
    expect(() => linkDeclaration(s, fixedMasters, meta('l1'), 'd1', true)).toThrow('必要明細');
    s = registerNeed(s, fixedMasters, meta('n1'), needP);
    s = linkDeclaration(s, fixedMasters, meta('l1'), 'd1', true);
    expect(s.declarations['d1']?.linked).toBe(true);
    expect(s.log.at(-1)).toMatchObject({ kind: 'declarationLink', declarationId: 'd1', linked: true });
    s = linkDeclaration(s, fixedMasters, meta('l2'), 'd1', false);
    expect(s.declarations['d1']?.linked).toBe(false);
    expect(() => linkDeclaration(s, fixedMasters, meta('l3'), 'd1', false)).toThrow('変わっていない');
    expect(() => linkDeclaration(s, fixedMasters, meta('l3'), 'zzz', true)).toThrow('申告');
  });

  test('3.2: 対応付けた申告は群に一件まで。解除したあとは別の申告を対応付けられる。別の群は別に数える', () => {
    let s = registerNeed(emptySupply, fixedMasters, meta('n1'), needP);
    s = registerNeed(s, fixedMasters, meta('n2'), { ...needP, item: 'Q' });
    s = declareShortage(s, fixedMasters, meta('d1'), decl);
    s = declareShortage(s, fixedMasters, meta('d2'), decl);
    s = declareShortage(s, fixedMasters, meta('d3'), { ...decl, item: 'Q' });
    s = linkDeclaration(s, fixedMasters, meta('l1'), 'd1', true);
    expect(() => linkDeclaration(s, fixedMasters, meta('l2'), 'd2', true)).toThrow('一件');
    expect(linkDeclaration(s, fixedMasters, meta('l2'), 'd3', true).declarations['d3']?.linked).toBe(true);
    s = linkDeclaration(s, fixedMasters, meta('l3'), 'd1', false);
    expect(linkDeclaration(s, fixedMasters, meta('l4'), 'd2', true).declarations['d2']?.linked).toBe(true);
  });
});

describe('供給の状態の共通の規則', () => {
  test('確定した記録は凍結され、書き換えようとすると例外になる', () => {
    const s = withNeed();
    expect(() => {
      (s.needs['n1'] as { item: string }).item = 'Z';
    }).toThrow();
    expect(() => {
      (s.log as unknown as unknown[]).push(1);
    }).toThrow();
  });

  test('失敗した操作は元の状態を変えない。操作IDの重複と、時刻帯のない日時は拒否する', () => {
    const s = withNeed();
    const log = s.log.length;
    expect(() => registerNeed(s, fixedMasters, meta('n1'), { ...needP, unit: '箱' })).toThrow('使用済み');
    expect(() => registerNeed(s, fixedMasters, { ...meta('n9'), occurredAt: '2026-10-02T09:00:00' }, { ...needP, unit: '箱' })).toThrow('時刻帯');
    expect(registerNeed(s, fixedMasters, { ...meta('n9'), occurredAt: null }, { ...needP, unit: '箱' }).needs['n9']).toBeDefined();
    expect(s.log.length).toBe(log);
  });

  test('3.4: 足りない分の記録・対応付けは確認事項を作らず、台帳（確認事項・中断）に触れない（Supplyは台帳を持たない）', () => {
    const s = declareShortage(emptySupply, fixedMasters, meta('d1'), { project: b001, item: 'P', unit: '個', value: 5, reason: '足りない' });
    expect(Object.keys(s).sort()).toEqual(['acks', 'declarations', 'levels', 'log', 'needs', 'receiptTemplates', 'receipts', 'requests']);
  });
});

describe('要件4・6 依頼', () => {
  const req = { project: b001, item: 'P', unit: '個', quantity: 5, vendor: '架空の仕入先X', requestedOn: '2026-10-02', reply: { kind: 'none' } } as const;
  const base = (): Supply => recordRequest(emptySupply, fixedMasters, meta('q1', 10), req);

  test('4.1: 依頼を記録でき、現物・受け取り・注文の確定・実際に受け取った数は作られない', () => {
    const s = base();
    expect(s.requests['q1']).toMatchObject({ id: 'q1', quantity: 5, vendor: '架空の仕入先X', requestedOn: '2026-10-02', orderConfirmedBy: null, reply: { kind: 'none' }, cancelled: null, arrivals: [] });
    expect(s.receipts).toEqual({});
    expect(s.log.at(-1)).toMatchObject({ kind: 'requestRecord', eventId: 'q1' });
  });

  test('4.1: 数量は1以上の整数。依頼先・品目・単位・依頼日は必須で、日付は実在する日付', () => {
    expect(() => recordRequest(emptySupply, fixedMasters, meta('q1'), { ...req, quantity: 0 })).toThrow('数量');
    expect(() => recordRequest(emptySupply, fixedMasters, meta('q1'), { ...req, quantity: 2.5 })).toThrow('数量');
    expect(() => recordRequest(emptySupply, fixedMasters, meta('q1'), { ...req, vendor: ' ' })).toThrow('依頼先');
    expect(() => recordRequest(emptySupply, fixedMasters, meta('q1'), { ...req, requestedOn: '2026-13-01' })).toThrow('日付');
    expect(() => recordRequest(emptySupply, fixedMasters, meta('q1'), { ...req, reply: { kind: 'answered', date: '2026-10-31x' } })).toThrow('日付');
    expect(recordRequest(emptySupply, fixedMasters, meta('q1'), { ...req, project: { kind: 'common' }, unit: '箱', item: 'S' }).requests['q1']?.project).toEqual({ kind: 'common' });
  });

  test('4.2: 注文の確定は依頼とは別の記録。二度は記録せず、取消済みの依頼には記録しない', () => {
    let s = base();
    s = confirmOrder(s, fixedMasters, meta('q2', 11), 'q1');
    expect(s.requests['q1']?.orderConfirmedBy).toBe('q2');
    expect(s.log.at(-1)).toMatchObject({ kind: 'orderConfirm', requestId: 'q1' });
    expect(() => confirmOrder(s, fixedMasters, meta('q3', 12), 'q1')).toThrow('注文の確定済み');
    const cancelled = cancelRequest(base(), fixedMasters, meta('q4', 11), 'q1', '不要になった');
    expect(() => confirmOrder(cancelled, fixedMasters, meta('q5', 12), 'q1')).toThrow('取消済み');
    expect(() => confirmOrder(s, fixedMasters, meta('q6', 12), 'zzz')).toThrow('依頼');
  });

  test('4.3: 回答は未回答・推定の予定日・相手が回答した予定日の三つで、更新の前後が残る。予定日が決まっても注文の確定は作られない', () => {
    let s = base();
    s = recordReply(s, fixedMasters, meta('q2', 11), 'q1', { kind: 'estimated', date: '2026-10-08' });
    expect(s.requests['q1']?.reply).toEqual({ kind: 'estimated', date: '2026-10-08' });
    s = recordReply(s, fixedMasters, meta('q3', 12), 'q1', { kind: 'answered', date: '2026-10-09' });
    expect(s.requests['q1']?.reply).toEqual({ kind: 'answered', date: '2026-10-09' });
    expect(s.requests['q1']?.orderConfirmedBy).toBeNull();
    const e = s.log.at(-1);
    expect(e?.kind === 'replyRecord' && [e.before, e.after]).toEqual([{ kind: 'estimated', date: '2026-10-08' }, { kind: 'answered', date: '2026-10-09' }]);
    s = recordReply(s, fixedMasters, meta('q4', 13), 'q1', { kind: 'none' });
    expect(s.requests['q1']?.reply).toEqual({ kind: 'none' });
  });

  test('4.3: 同じ回答への更新、存在しない依頼、取消済みの依頼、実在しない予定日は拒否する', () => {
    const s = base();
    expect(() => recordReply(s, fixedMasters, meta('q2'), 'q1', { kind: 'none' })).toThrow('変わっていない');
    expect(() => recordReply(s, fixedMasters, meta('q2'), 'zzz', { kind: 'none' })).toThrow('依頼');
    expect(() => recordReply(s, fixedMasters, meta('q2'), 'q1', { kind: 'estimated', date: '2026-02-30' })).toThrow('日付');
    expect(() => recordReply(cancelRequest(s, fixedMasters, meta('q3', 11), 'q1', '不要'), fixedMasters, meta('q4', 12), 'q1', { kind: 'answered', date: '2026-10-09' })).toThrow('取消済み');
  });

  test('6.1: 依頼は理由つきで取り消せ、元の依頼は残る。二度は取り消せず、理由は必須。割り当て済みの到着があっても取り消せる', () => {
    let s = base();
    expect(() => cancelRequest(s, fixedMasters, meta('q2'), 'q1', ' ')).toThrow('理由');
    s = cancelRequest(s, fixedMasters, meta('q2', 11), 'q1', '現物が見つかった');
    expect(s.requests['q1']).toMatchObject({ quantity: 5, cancelled: { eventId: 'q2', reason: '現物が見つかった' } });
    expect(s.log.at(-1)).toMatchObject({ kind: 'requestCancel', requestId: 'q1' });
    expect(() => cancelRequest(s, fixedMasters, meta('q3', 12), 'q1', 'また')).toThrow('取消済み');
  });

  test('依頼に続く記録は、依頼を記録した操作より前と言える日時では記録しない。日時不明・同時刻は記録できる', () => {
    const s = base();
    expect(() => confirmOrder(s, fixedMasters, meta('q2', 9), 'q1')).toThrow('より前');
    expect(() => recordReply(s, fixedMasters, meta('q2', 9), 'q1', { kind: 'estimated', date: '2026-10-08' })).toThrow('より前');
    expect(() => cancelRequest(s, fixedMasters, meta('q2', 9), 'q1', '不要')).toThrow('より前');
    expect(confirmOrder(s, fixedMasters, meta('q2', 10), 'q1').requests['q1']?.orderConfirmedBy).toBe('q2');
    expect(confirmOrder(s, fixedMasters, { ...meta('q3'), occurredAt: null }, 'q1').requests['q1']?.orderConfirmedBy).toBe('q3');
  });

  test('6.3・7.2: 依頼・取消のどれも、台帳の受け取り・中断・作業の再開を作らない（Supplyは台帳を持たない）。取消は未着から外すだけ', () => {
    const s = cancelRequest(confirmOrder(base(), fixedMasters, meta('q2', 11), 'q1'), fixedMasters, meta('q3', 12), 'q1', '不要');
    expect(Object.keys(s).sort()).toEqual(['acks', 'declarations', 'levels', 'log', 'needs', 'receiptTemplates', 'receipts', 'requests']);
    expect(s.receipts).toEqual({});
  });
});
