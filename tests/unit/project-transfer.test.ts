import { fixedMasters } from '../../src/domain/masters.ts';
import { describe, expect, test } from 'vitest';
import { changeMasters, correctOccurredAt, declareDiscrepancy, practiceLedger, hold, InclusionRequired, merge, perBoxOfLot, recount, register, split, totalOf, transferProject, use, voidRecord, type Ledger, type Meta, type Project } from '../../src/domain/ledger.ts';
import { emptySupply, registerNeed } from '../../src/domain/supply.ts';
import { shortageOf } from '../../src/domain/shortage.ts';
import type { Basis } from '../../src/domain/quantity.ts';
import { initial, parse, serialize, targetsOf } from '../../src/ui/storage.ts';
import { backupTextOf, readBackup } from '../../src/ui/backup.ts';
import { viewSheetsOf } from '../../src/ui/viewsheets.ts';
import { eventText } from '../../src/ui/format.ts';

const a = { kind: 'case', id: 'A-001' } satisfies Project;
const b = { kind: 'case', id: 'B-001' } satisfies Project;
const meta = (eventId: string, hour = 9): Meta => ({ eventId, occurredAt: `2026-10-02T${String(hour).padStart(2, '0')}:00:00+09:00`, recordedAt: '2026-10-02T12:00:00+09:00', actor: '架空担当A' });
const lot = (id: string, project: Project = a) => ({ id, item: 'P', unit: '個', project, location: 'S1' });
const base = (basis: Basis = 'counted', value: number | null = 20) => register(practiceLedger, meta('register', 8), lot('source'), basis, value);
const transfer = (l: Ledger, basis: Basis = 'counted', value: number | null = 10) => transferProject(l, meta('transfer'), 'source', 'dest', b, basis, value);

describe('AT-12・F1-C 案件・用途の付け替えの原子的な数量・不足・履歴', () => {
  test('1.1〜1.3・3.1: 自動流用なし、A−10/B＋10/部署合計50、A不足10・B不足0、共通30不変', () => {
    let ledger = register(base(), meta('common', 8), lot('common', { kind: 'common' }), 'counted', 30);
    let supply = emptySupply;
    for (const [eventId, project, value] of [['needA', a, 20], ['needB', b, 10]] as const) {
      supply = registerNeed(supply, fixedMasters, meta(eventId, 8), { project, item: 'P', unit: '個', required: { basis: 'counted', value }, dueDate: null, source: '架空明細', revision: '1' });
    }
    const view = (project: Project) => shortageOf(ledger, supply, { project, item: 'P', unit: '個' });
    expect(view(a).shortage).toBe(0);
    expect(view(b).shortage).toBe(10);
    const original = ledger;
    ledger = transfer(ledger);
    expect(original.lots['source']?.quantity).toMatchObject({ numeric: { value: 20 } });
    expect(ledger.lots['source']).toMatchObject({ project: a, quantity: { numeric: { value: 10 } } });
    expect(ledger.lots['dest']).toMatchObject({ project: b, item: 'P', unit: '個', location: 'S1', splitFrom: 'source', quantity: { numeric: { value: 10 } } });
    expect(totalOf(ledger, 'P')).toMatchObject({ numeric: { value: 50 } });
    expect(ledger.lots['common']).toEqual(original.lots['common']);
    expect(view(a)).toMatchObject({ shortage: 10, aux: { usable: 10 } });
    expect(view(b)).toMatchObject({ shortage: 0, aux: { usable: 10, used: 0 } });
    expect(ledger.history.at(-1)).toMatchObject({ kind: 'transfer', lotId: 'source', childId: 'dest', from: a, to: b, basis: 'counted', value: 10, applied: true, actor: '架空担当A' });
    expect(ledger.history.at(-1)?.changes).toHaveLength(2);
  });

  test.each(['counted', 'label', 'approximate'] as const)('2.1: 親ラベルと取り出した分%sの根拠を残す', basis => {
    const ledger = transfer(base('label'), basis);
    expect(ledger.lots['source']?.quantity).toMatchObject({ kind: 'known', numeric: { value: 10, unconfirmed: basis === 'approximate' ? 'partial' : 'all', approximate: basis === 'approximate' }, computed: true });
    expect(ledger.lots['dest']?.quantity.terms).toEqual([{ sign: 1, observation: { id: 'transfer', basis, value: 10 } }]);
    expect(ledger.lots['dest']?.lastCount).toEqual(basis === 'counted' ? { eventId: 'transfer', value: 10 } : null);
  });

  test('2.1: 全量でも元案件・用途を消さず、最大安全整数を保存する', () => {
    const ledger = transfer(base('counted', Number.MAX_SAFE_INTEGER), 'counted', Number.MAX_SAFE_INTEGER);
    expect(ledger.lots['source']?.quantity).toMatchObject({ numeric: { value: 0 } });
    expect(totalOf(ledger, 'P')).toMatchObject({ numeric: { value: Number.MAX_SAFE_INTEGER } });
  });

  test.each([0, -1, 21, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null])('2.2: 不正・過量%sは親・子・履歴無変更', value => {
    const ledger = base();
    const before = JSON.stringify(ledger);
    expect(() => transfer(ledger, 'counted', value)).toThrow();
    expect(JSON.stringify(ledger)).toBe(before);
  });

  test.each(['common', 'unassigned'] as const)('1.4: 元%sを自動で案件・用途用にしない', kind => {
    const ledger = register(practiceLedger, meta('register', 8), lot('source', { kind }), 'counted', 20);
    expect(() => transfer(ledger)).toThrow(/案件・用途/);
  });
  test.each([a, { kind: 'common' }, { kind: 'unassigned' }, { kind: 'case', id: 'missing' }] satisfies Project[])('1.4: 不正な先案件・用途%jを拒否', project => {
    expect(() => transferProject(base(), meta('transfer'), 'source', 'dest', project, 'counted', 10)).toThrow();
  });
  test('1.4: 利用停止中の振替先・ID重複・閉じた元を拒否', () => {
    const stopped = changeMasters(base(), meta('stop', 8), { action: 'deactivate', type: 'case', id: b.id, reason: '架空の利用終了' });
    expect(() => transfer(stopped)).toThrow(/利用停止中/);
    expect(() => transferProject(base(), meta('transfer'), 'source', 'source', b, 'counted', 10)).toThrow();
    const once = transfer(base());
    expect(() => transferProject(once, meta('transfer'), 'source', 'dest2', b, 'counted', 1)).toThrow(/使用済み/);
    const closed = merge(register(base(), meta('register2', 8), lot('other'), 'counted', 1), meta('merge'), 'source', 'other');
    expect(() => transfer(closed)).toThrow(/統合済み/);
  });
  test('2.2: 不明・除外・照合・工程内は先に確認し、数量を作らない', () => {
    expect(() => transfer(base('unknown', null))).toThrow(/数量/);
    expect(() => transfer(base(), 'unknown', null)).toThrow(/数量/);
    expect(() => transfer(hold(base(), meta('hold'), 'source', 'defective'))).toThrow(/取り分け/);
    expect(() => transfer(declareDiscrepancy(base(), meta('issue'), 'source', '架空差異'))).toThrow(/確認事項/);
    const staged = register(practiceLedger, meta('register', 8), { ...lot('source'), stage: { kind: 'working', process: { id: 'R組立', criterion: 'inspection' } } }, 'counted', 20);
    expect(() => transfer(staged)).toThrow(/作業の状態/);
  });
  test('2.3・2.4: 後入力の回答なし/包含済み/不明は無変更、未包含だけ同量を振替', () => {
    const ledger = recount(base(), meta('count', 10), 'source', 20, { kind: 'unknown' });
    expect(() => transfer(ledger)).toThrow(InclusionRequired);
    for (const answer of ['included', 'unknown'] as const) {
      expect(() => transferProject(ledger, meta('transfer'), 'source', 'dest', b, 'counted', 10, answer)).toThrow(/確認/);
    }
    expect(ledger.history).toHaveLength(2);
    const next = transferProject(ledger, meta('transfer'), 'source', 'dest', b, 'counted', 10, 'notIncluded');
    expect(totalOf(next, 'P')).toMatchObject({ numeric: { value: 20 } });
  });
  test('2.5: 振替した子の使用/取消/分割/統合・生成前拒否', () => {
    const once = transfer(base());
    expect(() => use(once, meta('before', 8), 'dest', 'counted', 1, 'B作業')).toThrow(/できる前/);
    let next = use(once, meta('use', 10), 'dest', 'counted', 2, 'B作業');
    next = voidRecord(next, meta('void', 11), 'use', '架空の入力誤り');
    expect(next.lots['dest']?.quantity).toMatchObject({ numeric: { value: 10, unconfirmed: 'none' } });
    next = split(next, meta('split', 11), 'dest', 'part', 'counted', 3);
    next = merge(next, meta('merge', 11), 'part', 'dest');
    expect(next.lots['dest']?.quantity).toMatchObject({ numeric: { value: 10 } });
    expect(() => correctOccurredAt(next, meta('fix', 12), 'transfer', meta('later', 12).occurredAt)).toThrow(/できる前/);
  });

  test('3.3・3.4: 保存・復元・出力で両案件・用途と根拠を保持、保存対象は親子の両方', () => {
    const before = base('label');
    const ledger = transfer(before);
    const snapshot = initial(ledger, emptySupply);
    const decoded = parse(serialize(snapshot));
    expect(decoded).toEqual(snapshot);
    const backup = readBackup(new TextEncoder().encode(backupTextOf(snapshot, '2026-10-02T12:00:00+09:00')));
    expect(backup.kind).toBe('ok');
    if (backup.kind !== 'ok') throw new Error('復元できない');
    expect(backup.snapshot).toEqual(snapshot);
    const text = eventText(decoded.ledger, decoded.ledger.history.at(-1)!);
    expect(text).toContain('案件・用途A-001 → 案件・用途B-001');
    expect(text).toContain('sourceからdestへ10個（数えた）');
    const rows = viewSheetsOf(decoded, '2026-10-02T12:00:00+09:00').find(s => s.name === '台帳の履歴')?.rows;
    expect(rows?.at(-1)?.join(' ')).toContain(text);
    expect(rows?.at(-1)?.join(' ')).toContain('反映した');
    expect(targetsOf({ ledger: before, supply: emptySupply }, decoded)).toEqual(['まとまりsource', 'まとまりdest']);
    expect(() => use(decoded.ledger, meta('before', 8), 'dest', 'counted', 1, 'B作業')).toThrow(/できる前/);
  });
  test('2.5・3.3: 振替で箱の1箱あたりの数の観測時点を変更しない', () => {
    let ledger = register(practiceLedger, meta('register', 8), { ...lot('source'), item: 'S', unit: '箱' }, 'label', 2);
    const original = perBoxOfLot(ledger, ledger.lots['source']!);
    ledger = changeMasters(ledger, meta('perBox'), { action: 'perBox', id: 'S', value: 123, reason: '架空の包装変更' });
    ledger = transferProject(ledger, meta('transfer', 10), 'source', 'dest', b, 'label', 1);
    expect(perBoxOfLot(ledger, ledger.lots['dest']!)).toBe(original);
    const decoded = parse(serialize(initial(ledger, emptySupply))).ledger;
    expect(perBoxOfLot(decoded, decoded.lots['dest']!)).toBe(original);
  });
  test('2.5: 子の観測を後に動かすと前提の食い違いを照合に残し、数量を再適用しない', () => {
    const once = transfer(base());
    const next = correctOccurredAt(once, meta('fix', 12), 'register', meta('late', 11).occurredAt);
    expect(next.issues['transfer@time']).toMatchObject({ reason: 'timeCorrected', resolution: null });
    expect(totalOf(next, 'P')).toMatchObject({ numeric: { value: 20 } });
  });
  test('2.5: 元案件・用途の過去の使用を先案件・用途へ移さず、使用の取消再計算で振替を失わない', () => {
    let ledger = use(base(), meta('used', 9), 'source', 'label', 2, 'A作業');
    ledger = transferProject(ledger, meta('transfer', 10), 'source', 'dest', b, 'counted', 10);
    const viewB = shortageOf(ledger, emptySupply, { project: b, item: 'P', unit: '個' });
    expect(viewB.aux.used).toBe(0);
    ledger = voidRecord(ledger, meta('void', 11), 'used', '架空の記録誤り');
    expect(ledger.lots['source']?.quantity).toMatchObject({ numeric: { value: 10, unconfirmed: 'none' } });
    expect(ledger.lots['dest']?.quantity).toMatchObject({ numeric: { value: 10 } });
    expect(totalOf(ledger, 'P')).toMatchObject({ numeric: { value: 20 } });
  });
  test.each([
    { to: { kind: 'common' } }, { from: b }, { applied: false }, { value: 0 }, { basis: 'unknown', value: null }, { inclusion: 'included' },
  ])('3.3: 不正な振替イベント%jを保存の境界で拒否', change => {
    const snapshot = initial(transfer(base()), emptySupply);
    const forged = { ...snapshot, ledger: { ...snapshot.ledger, history: snapshot.ledger.history.map(e => e.kind === 'transfer' ? { ...e, ...change } : e) } };
    expect(() => parse(JSON.stringify(forged))).toThrow();
  });
  test('2.3: 実際の日時不明も勝手に現在へ変えず、未包含の回答後だけ適用', () => {
    const ledger = base();
    const at = { ...meta('transfer'), occurredAt: null };
    expect(() => transferProject(ledger, at, 'source', 'dest', b, 'counted', 10)).toThrow(InclusionRequired);
    const next = transferProject(ledger, at, 'source', 'dest', b, 'counted', 10, 'notIncluded');
    expect(next.history.at(-1)?.occurredAt).toBeNull();
    expect(totalOf(next, 'P')).toMatchObject({ numeric: { value: 20 } });
  });
});
