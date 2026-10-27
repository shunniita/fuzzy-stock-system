import { describe, expect, test } from 'vitest';
import { createHistoryTargetCollector } from '../../src/domain/history-targets.ts';
import { practiceLedger, type Meta } from '../../src/domain/ledger.ts';
import { allocateArrival, emptySupply, receiveLot, requestProgressOf } from '../../src/domain/supply.ts';
import { receiveTemplate, saveReceiptTemplate, type ReceiptTemplate } from '../../src/domain/receipt-template.ts';
import { backupTextOf, crc32, readBackup } from '../../src/ui/backup.ts';
import { initial, parse, serialize } from '../../src/ui/storage.ts';
import { decodePending, decodeSnapshot } from '../../src/ui/storageparse.ts';
import { supplyEventText } from '../../src/ui/supply-format.ts';

const at = '2026-10-23T09:00:00+09:00';
const meta = (eventId: string, occurredAt: string | null = at): Meta => ({ eventId, actor: '架空担当A', occurredAt, recordedAt: at });
const caseA = { kind: 'case', id: 'A-001' } as const;
const recipe: ReceiptTemplate = { id: 'r1', name: '架空セット', product: 'R', project: null, basis: 'label', rows: [
  { item: 'P', unit: '個', perSet: 2, location: 'S1' }, { item: 'Q', unit: '個', perSet: 1, location: 'S1' }, { item: 'S', unit: '本', perSet: 4, location: 'S2' },
] };
const saved = () => ({ ledger: practiceLedger, supply: saveReceiptTemplate(practiceLedger, emptySupply, meta('op1'), recipe) });
const rows = (quantities: number[], shortfalls: number[]) => quantities.map((quantity, i) => ({ quantity, shortfall: shortfalls[i] ?? 0 }));
const withShortfall = () => receiveTemplate(saved(), meta('op2'), 'r1', caseA, 10, rows([20, 7, 40], [0, 3, 0]), '架空商社');
const pendingOf = (s: ReturnType<typeof initial>, version = 12) => ({ format: 'fuzzy-stock-pending', version, pending: { progress: 'saving', unknownSince: null, savingSince: at, baseRevision: 0, opId: 'op2', opLabel: '一括受入', fingerprint: 'f', values: {}, actor: '架空担当A', startedAt: at, units: [{ ledger: s.ledger, supply: s.supply, targets: [], conflictReviews: [] }] } });

describe('セット 要件1', () => {
  test('製品を持ち案件・用途を持たない形で保存し、製品なしは拒否する', () => {
    expect(saved().supply.receiptTemplates['r1']).toEqual(recipe);
    expect(() => saveReceiptTemplate(practiceLedger, emptySupply, meta('op1'), { ...recipe, product: null })).toThrow('製品');
    expect(() => saveReceiptTemplate(practiceLedger, emptySupply, meta('op1'), { ...recipe, product: '未登録' })).toThrow('製品');
    const stopped = { ...practiceLedger, masters: { ...practiceLedger.masters, items: { ...practiceLedger.masters.items, R: { ...practiceLedger.masters.items['R']!, active: false } } } };
    expect(() => saveReceiptTemplate(stopped, emptySupply, meta('op1'), recipe)).toThrow('製品');
  });
});

describe('案件・用途・個数からの受け取りと欠品 要件2・3', () => {
  test('案件・用途A-001・10個でP20/Q10/S40を展開し、Q不足3は受け取り7と依頼3にする', () => {
    const result = withShortfall();
    const lots = Object.values(result.ledger.lots);
    expect(lots.map(l => [l.item, l.quantity.kind === 'known' ? l.quantity.numeric.value : null, l.project])).toEqual([['P', 20, caseA], ['Q', 7, caseA], ['S', 40, caseA]]);
    expect(result.supply.requests['op2-s2']).toMatchObject({ project: caseA, item: 'Q', unit: '個', quantity: 3, vendor: '架空商社', requestedOn: '2026-10-23', reply: { kind: 'none' }, arrivals: [] });
    expect(Object.keys(result.supply.requests)).toEqual(['op2-s2']);
    expect(result.supply.log.at(-1)).toMatchObject({ kind: 'templateReceipt', project: caseA, sets: 10, vendor: '架空商社',
      rows: [{ quantity: 20, shortfall: 0 }, { quantity: 7, shortfall: 3 }, { quantity: 40, shortfall: 0 }] });
    const text = supplyEventText(result.ledger.masters, result.supply.log.at(-1)!);
    expect(text).toContain('予定10個・不足3個・受け取り7個');
    expect(text).toContain('架空商社');
  });
  test('後日届いた欠品3個を既存の到着として依頼へ割り当てでき、未着が0になる', () => {
    const result = withShortfall();
    const later = receiveLot(result.ledger, result.supply, meta('op3', '2026-10-25T09:00:00+09:00'), { id: 'late', item: 'Q', unit: '個', project: caseA, location: 'S1' }, 'counted', 3);
    const supply = allocateArrival(later.ledger, later.supply, meta('op4', '2026-10-25T09:00:00+09:00'), 'op2-s2', { receiptLotId: 'late', arrived: 3, good: 3 });
    expect(requestProgressOf(later.ledger.masters, supply.requests['op2-s2']!)).toMatchObject({ arrived: 3, outstanding: 0 });
    const snapshot = initial(later.ledger, supply);
    expect(parse(serialize(snapshot))).toEqual(snapshot);
  });
  test('受け取った数を直しただけの行は不足0で残り、欠品と区別できる', () => {
    const result = receiveTemplate(saved(), meta('op2'), 'r1', caseA, 10, rows([19, 10, 40], [0, 0, 0]), null);
    expect(result.supply.log.at(-1)).toMatchObject({ vendor: null, rows: [{ quantity: 19, shortfall: 0 }, { quantity: 10, shortfall: 0 }, { quantity: 40, shortfall: 0 }] });
    expect(result.supply.requests).toEqual({});
  });
  test('全量欠品は受け取り0でも依頼だけで記録でき、受け取りも不足も全行0は拒否する', () => {
    const result = receiveTemplate(saved(), meta('op2'), 'r1', caseA, 1, rows([0, 0, 0], [2, 1, 4]), '架空商社');
    expect(result.ledger.lots).toEqual({});
    expect(Object.values(result.supply.requests).map(r => r.quantity)).toEqual([2, 1, 4]);
    expect(parse(serialize(initial(result.ledger, result.supply)))).toEqual(initial(result.ledger, result.supply));
    expect(() => receiveTemplate(saved(), meta('op2'), 'r1', caseA, 1, rows([0, 0, 0], [0, 0, 0]), null)).toThrow('全行0');
  });
  test.each([
    ['予定を超える不足', rows([20, 0, 40], [0, 11, 0]), '架空商社', '予定数'],
    ['負の不足', rows([20, 10, 40], [0, -1, 0]), '架空商社', ''],
    ['小数の不足', rows([20, 10, 40], [0, 0.5, 0]), '架空商社', ''],
    ['不足があるのに手配先なし', rows([20, 7, 40], [0, 3, 0]), null, '手配先'],
    ['空白の手配先', rows([20, 7, 40], [0, 3, 0]), ' ', '手配先'],
    ['不足がないのに手配先', rows([20, 10, 40], [0, 0, 0]), '架空商社', '手配先'],
  ])('%sは何も適用せず拒否する', (_name, input, vendor, message) => {
    const state = saved();
    expect(() => receiveTemplate(state, meta('op2'), 'r1', caseA, 10, input, vendor)).toThrow(message);
    expect(state.ledger.lots).toEqual({});
    expect(state.supply.requests).toEqual({});
  });
  test('未登録の案件・用途は拒否し、共通にも受け入れられる', () => {
    expect(() => receiveTemplate(saved(), meta('op2'), 'r1', { kind: 'case', id: '未登録' }, 1, rows([2, 1, 4], []), null)).toThrow('案件・用途');
    const common = receiveTemplate(saved(), meta('op2'), 'r1', { kind: 'common' }, 1, rows([2, 1, 4], []), null);
    expect(Object.values(common.ledger.lots).every(l => l.project.kind === 'common')).toBe(true);
  });
});

// 版7の記録は、セットに案件・用途があり製品がなく、まとめて受け取りに案件・用途・手配先・不足がない。
function asVersion7(snapshot: ReturnType<typeof initial>): Record<string, unknown> {
  const text = JSON.stringify({ ...snapshot, version: 7 }, (key, value: unknown) => {
    if ((key === 'consumable' || key === 'processes' || key === 'nextProcess') || key === 'itemLabels') return undefined;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
    const o = value as Record<string, unknown>;
    if ('basis' in o && 'rows' in o && 'name' in o) { const { product: _p, ...rest } = o; return { ...rest, project: caseA }; }
    if (o['kind'] === 'templateReceipt') { const { project: _p, vendor: _v, ...rest } = o; return rest; }
    if ('lotId' in o && 'shortfall' in o) { const { shortfall: _s, ...rest } = o; return rest; }
    return o;
  });
  return JSON.parse(text);
}

describe('保存と互換性 要件4', () => {
  test('版8の欠品付き受け取りをsnapshot・pending・backupで往復する', () => {
    const result = withShortfall(), snapshot = initial(result.ledger, result.supply);
    expect(parse(serialize(snapshot))).toEqual(snapshot);
    expect(decodePending(pendingOf(snapshot)).units[0]?.supply).toEqual(result.supply);
    expect(readBackup(new TextEncoder().encode(backupTextOf(snapshot, at)))).toMatchObject({ kind: 'ok', snapshot });
  });
  test('版7のテンプレートとまとめて受け取りを、案件・用途を保ち製品なし・不足0として読み、入力は書き換えない', () => {
    const result = receiveTemplate(saved(), meta('op2'), 'r1', caseA, 10, rows([20, 10, 40], []), null);
    const old = asVersion7(initial(result.ledger, result.supply)), before = JSON.stringify(old);
    const decoded = decodeSnapshot(old);
    expect(JSON.stringify(old)).toBe(before);
    expect(decoded.version).toBe(12);
    expect(decoded.supply.receiptTemplates['r1']).toEqual({ ...recipe, product: null, project: caseA });
    expect(decoded.supply.log.at(-1)).toMatchObject({ kind: 'templateReceipt', project: caseA, vendor: null, rows: [{ shortfall: 0 }, { shortfall: 0 }, { shortfall: 0 }] });
    const source = decoded.supply.log.at(-1)!;
    const shown = supplyEventText(decoded.ledger.masters, source, createHistoryTargetCollector(decoded).supplyEventItemIds(source));
    expect(shown).toContain('予定10個・受け取り10個');
    expect(shown).not.toContain('不足');
    expect(decodePending(pendingOf(old as ReturnType<typeof initial>, 7)).units[0]?.supply.receiptTemplates['r1']?.project).toEqual(caseA);
    // 版7の内側をそのまま包んだバックアップを読む（移行済みの値を包み直さない）。
    const text = JSON.stringify(old), utf8 = (t: string) => new TextEncoder().encode(t);
    const v7Backup = utf8(JSON.stringify({ notice: '試験', format: 'fuzzy-stock-backup', version: 1, createdAt: at, crc32: crc32(utf8(`${at}\n${text}`)).toString(16).padStart(8, '0'), snapshot: text }));
    const read = readBackup(v7Backup);
    expect(read).toMatchObject({ kind: 'ok' });
    if (read.kind === 'ok') expect(read.snapshot.supply.receiptTemplates['r1']).toEqual({ ...recipe, product: null, project: caseA });
  });
  test('旧案件・用途が利用停止でも、利用中の別案件・用途へは受け入れられる', () => {
    const result = receiveTemplate(saved(), meta('op2'), 'r1', caseA, 1, rows([2, 1, 4], []), null);
    const decoded = decodeSnapshot(asVersion7(initial(result.ledger, result.supply)));
    const masters = decoded.ledger.masters, ledger = { ...decoded.ledger, masters: { ...masters, cases: { ...masters.cases, 'A-001': { ...masters.cases['A-001']!, active: false } } } };
    const again = receiveTemplate({ ledger, supply: decoded.supply }, meta('op3'), 'r1', { kind: 'case', id: 'B-001' }, 1, rows([2, 1, 4], []), null);
    expect(Object.keys(again.supply.receipts)).toHaveLength(6);
    expect(() => receiveTemplate({ ledger, supply: decoded.supply }, meta('op4'), 'r1', caseA, 1, rows([2, 1, 4], []), null)).toThrow('案件・用途');
  });
  test('依頼日はUTC表記の実際の日時・入力した日時でも日本時間の暦日にする', () => {
    const utc = '2026-10-22T23:30:00Z';
    const byOccurred = receiveTemplate(saved(), { ...meta('op2'), occurredAt: utc }, 'r1', caseA, 1, rows([2, 0, 4], [0, 1, 0]), '架空商社');
    expect(byOccurred.supply.requests['op2-s2']?.requestedOn).toBe('2026-10-23');
    const byRecorded = receiveTemplate(saved(), { ...meta('op2', null), recordedAt: utc }, 'r1', caseA, 1, rows([2, 0, 4], [0, 1, 0]), '架空商社');
    expect(byRecorded.supply.requests['op2-s2']?.requestedOn).toBe('2026-10-23');
    expect(parse(serialize(initial(byOccurred.ledger, byOccurred.supply)))).toEqual(initial(byOccurred.ledger, byOccurred.supply));
  });
  test('旧テンプレートを変更すると案件・用途の固定を外し、旧案件・用途の受け取りも新しい案件・用途で受けられる', () => {
    const result = receiveTemplate(saved(), meta('op2'), 'r1', caseA, 1, rows([2, 1, 4], []), null);
    const decoded = decodeSnapshot(asVersion7(initial(result.ledger, result.supply)));
    const legacy = decoded.supply.receiptTemplates['r1']!;
    const again = receiveTemplate({ ledger: decoded.ledger, supply: decoded.supply }, meta('op3'), 'r1', { kind: 'case', id: 'B-001' }, 1, rows([2, 1, 4], []), null);
    expect(Object.values(again.ledger.lots).filter(l => l.id.startsWith('op3')).every(l => l.project.kind === 'case' && l.project.id === 'B-001')).toBe(true);
    const revised = saveReceiptTemplate(again.ledger, again.supply, meta('op4'), { ...legacy, product: 'R' });
    expect(revised.receiptTemplates['r1']).toEqual(recipe);
    expect(revised.log.at(-1)).toMatchObject({ before: { project: caseA, product: null }, after: { project: null, product: 'R' } });
    const snapshot = initial(again.ledger, revised);
    expect(parse(serialize(snapshot))).toEqual(snapshot);
  });
  test('版7への新しい欄の混入と、版8の欄の欠落を拒否する', () => {
    const result = withShortfall(), snapshot = initial(result.ledger, result.supply);
    const v8 = JSON.parse(serialize(snapshot)) as Record<string, unknown>;
    expect(() => decodeSnapshot({ ...v8, version: 7 })).toThrow();
    const strip = (key: string) => JSON.parse(JSON.stringify(snapshot, (k, v: unknown) => k === key ? undefined : v));
    for (const key of ['product', 'vendor', 'shortfall']) expect(() => decodeSnapshot(strip(key))).toThrow();
  });
  test.each([
    ['依頼の数量', (s: ReturnType<typeof withShortfall>) => ({ ...s.supply, log: s.supply.log.map(e => e.kind === 'requestRecord' ? { ...e, request: { ...e.request, quantity: 2 } } : e), requests: { 'op2-s2': { ...s.supply.requests['op2-s2']!, quantity: 2 } } })],
    ['依頼の欠落', (s: ReturnType<typeof withShortfall>) => ({ ...s.supply, log: s.supply.log.filter(e => e.kind !== 'requestRecord'), requests: {} })],
    ['依頼の手配先', (s: ReturnType<typeof withShortfall>) => ({ ...s.supply, log: s.supply.log.map(e => e.kind === 'templateReceipt' ? { ...e, vendor: '別の商社' } : e) })],
    ['不足の改変', (s: ReturnType<typeof withShortfall>) => ({ ...s.supply, log: s.supply.log.map(e => e.kind === 'templateReceipt' ? { ...e, rows: e.rows.map((r, i) => i === 1 ? { ...r, shortfall: 2 } : r) } : e) })],
    ['案件・用途の改変', (s: ReturnType<typeof withShortfall>) => ({ ...s.supply, log: s.supply.log.map(e => e.kind === 'templateReceipt' ? { ...e, project: { kind: 'common' as const } } : e) })],
    ['現在の依頼の削除', (s: ReturnType<typeof withShortfall>) => ({ ...s.supply, requests: {} })],
    ['現在の依頼の数量', (s: ReturnType<typeof withShortfall>) => ({ ...s.supply, requests: { 'op2-s2': { ...s.supply.requests['op2-s2']!, quantity: 30 } } })],
  ])('%sの不一致をsnapshot・pending・backupで拒否する', (_name, damage) => {
    const result = withShortfall(), broken = initial(result.ledger, damage(result));
    expect(() => decodeSnapshot(JSON.parse(serialize(broken)))).toThrow();
    expect(() => decodePending(pendingOf(broken))).toThrow();
    expect(readBackup(new TextEncoder().encode(backupTextOf(broken, at)))).toMatchObject({ kind: 'unreadable' });
  });
});

describe('現在の台帳との照合 要件4.2', () => {
  test('受け取り済みの保管単位を現在の台帳から消した記録を拒否する', () => {
    const result = withShortfall();
    const { 'op2-lot1': _removed, ...lots } = result.ledger.lots;
    const broken = initial({ ...result.ledger, lots }, result.supply);
    expect(() => decodeSnapshot(JSON.parse(serialize(broken)))).toThrow();
    expect(() => decodePending(pendingOf(broken))).toThrow();
    expect(readBackup(new TextEncoder().encode(backupTextOf(broken, at)))).toMatchObject({ kind: 'unreadable' });
  });
  test('後日の到着を割り当てした依頼は現在値が変わっても読み込める', () => {
    const result = withShortfall();
    const later = receiveLot(result.ledger, result.supply, meta('op3', '2026-10-25T09:00:00+09:00'), { id: 'late', item: 'Q', unit: '個', project: caseA, location: 'S1' }, 'counted', 2);
    const supply = allocateArrival(later.ledger, later.supply, meta('op4', '2026-10-25T09:00:00+09:00'), 'op2-s2', { receiptLotId: 'late', arrived: 2, good: 2 });
    const snapshot = initial(later.ledger, supply);
    expect(decodePending(pendingOf(snapshot)).units[0]?.supply).toEqual(supply);
    expect(readBackup(new TextEncoder().encode(backupTextOf(snapshot, at)))).toMatchObject({ kind: 'ok', snapshot });
  });
});
