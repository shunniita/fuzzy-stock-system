import { describe, expect, test } from 'vitest';
import { beginAlternativeRecord, correctOccurredAt, practiceLedger, move, register, start, use, voidRecord, type Ledger, type Meta } from '../../src/domain/ledger.ts';
import { emptySupply, receiveLot } from '../../src/domain/supply.ts';
import { backupTextOf, crc32, readBackup } from '../../src/ui/backup.ts';
import { commit, initial, inquire, load, parse, replace, retry, serialize, targetsOf, type StoreLike } from '../../src/ui/storage.ts';
import { decodePending } from '../../src/ui/storageparse.ts';
import { viewSheetsOf } from '../../src/ui/viewsheets.ts';

const at = '2026-09-29T11:00:00+09:00';
const meta = (eventId: string): Meta => ({ eventId, occurredAt: at, recordedAt: '2026-10-14T04:20:00+09:00', actor: '架空担当A' });
const original = { source: '架空資料A:B', entry: '001a', originalActor: '架空原票担当B' };
const lot = { id: 'p', item: 'P', unit: '個', location: 'S1', project: { kind: 'case', id: 'A-001' } } as const;
const base = () => register(practiceLedger, { ...meta('r'), occurredAt: '2026-09-29T10:00:00+09:00' }, lot, 'counted', 52);
function used(): Ledger { return use(beginAlternativeRecord(base(), meta('u'), 'use', original, ['P']), meta('u'), 'p', 'counted', 8, '架空作業'); }
const storeOf = () => {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } } satisfies StoreLike & { data: Map<string, string> };
};
function rejects(ledger: unknown, supply: unknown = emptySupply): void {
  const snapshot = { ...initial(practiceLedger, emptySupply), ledger, supply }, text = JSON.stringify(snapshot), bytes = new TextEncoder();
  expect(() => parse(text)).toThrow();
  expect(readBackup(bytes.encode(JSON.stringify({ format: 'fuzzy-stock-backup', version: 1, createdAt: at, crc32: crc32(bytes.encode(`${at}\n${text}`)).toString(16).padStart(8, '0'), snapshot: text }))).kind).not.toBe('ok');
  const store = storeOf(); store.data.set('fuzzy-stock/head', 'A'); store.data.set('fuzzy-stock/slot-A', text);
  const before = [...store.data];
  expect(load(store).kind).toBe('unreadable'); expect([...store.data]).toEqual(before);
  expect(() => decodePending({ progress: 'saving', unknownSince: null, savingSince: at, baseRevision: 0, opId: 'op1', opLabel: '後入力', fingerprint: 'f', values: {}, actor: '架空担当A', startedAt: at, units: [{ ledger, supply, targets: [] }] })).toThrow();
}

describe('代替記録4: 保存された元の資料と物理操作を一組として読む', () => {
  test('後の日時訂正・取消・移動を許し、元の時点と元の資料をbackup/xlsxで保持する', () => {
    let ledger = correctOccurredAt(used(), meta('time'), 'u', '2026-09-29T10:30:00+09:00');
    ledger = voidRecord(ledger, meta('void'), 'u', '架空の記録誤り');
    ledger = move(ledger, meta('move'), 'p', 'T');
    const snapshot = initial(ledger, emptySupply);
    expect(parse(serialize(snapshot))).toEqual(snapshot);
    const backup = readBackup(new TextEncoder().encode(backupTextOf(snapshot, at)));
    expect(backup.kind).toBe('ok');
    if (backup.kind === 'ok') {
      expect(backup.snapshot).toEqual(snapshot);
      expect(() => beginAlternativeRecord(backup.snapshot.ledger, meta('again'), 'receive', original, ['P'])).toThrow('記録済み');
    }
    const history = JSON.stringify(viewSheetsOf(snapshot, at).find(s => s.name === '台帳の履歴'));
    for (const text of [...Object.values(original), '操作u', '2026-09-29 11:00（日本時間）', '2026-09-29 10:30（日本時間）']) expect(history).toContain(text);
  });

  test('全量移動・材料付き作業の開始・受け取りの対応を保存し、その後の消費も許す', () => {
    const moved = move(beginAlternativeRecord(base(), meta('m'), 'move', original, ['P']), meta('m'), 'p', 'T');
    const material = use(beginAlternativeRecord(base(), meta('s'), 'start', original, ['P']), meta('s-u0'), 'p', 'counted', 2, '材料');
    const started = start(material, meta('s'), { ...lot, id: 'w' }, { id: '架空工程', criterion: 'workEnd' }, 'counted', 1, ['s-u0']);
    const received = receiveLot(beginAlternativeRecord(practiceLedger, meta('in'), 'receive', original, ['P']), emptySupply, meta('in'), lot, 'label', 10);
    received.ledger = use(received.ledger, meta('after'), 'p', 'counted', 3, '受け取り後');
    for (const state of [{ ledger: moved, supply: emptySupply }, { ledger: started, supply: emptySupply }, received]) {
      const snapshot = initial(state.ledger, state.supply); expect(parse(serialize(snapshot))).toEqual(snapshot);
    }
  });

  const patches: [string, Record<string, unknown>][] = [
    ['source欠落', { source: undefined }], ['entry欠落', { source: { source: original.source, originalActor: original.originalActor } }],
    ['資料空白', { source: { ...original, source: ' A' } }], ['番号空白', { source: { ...original, entry: ' ' } }], ['記入者欠落', { source: { ...original, originalActor: undefined } }],
    ['記入者空白', { source: { ...original, originalActor: ' \t' } }], ['source余剰', { source: { ...original, extra: '残すべき' } }], ['余剰', { extra: '残すべき' }],
    ['対応操作欠落', { operationId: 'missing' }], ['対応種別違い', { operation: 'move' }], ['未知種別', { operation: 'other' }],
    ['eventId規則違い', { eventId: 'bad' }], ['元日時違い', { occurredAt: null }], ['入力した日時違い', { recordedAt: at }], ['担当違い', { actor: '架空B' }],
  ];
  test.each(patches)('%sはsnapshot/backup/pendingで拒否して元bytesを保つ', (_name, patch) => {
    const ledger = used(); rejects({ ...ledger, history: ledger.history.map(e => e.kind === 'alternativeRecord' ? { ...e, ...patch } : e) });
  });

  test.each(['missing-primary', 'duplicate-source', 'shared-operation', 'duplicate-primary', 'wrong-order', 'fake-changes', 'correct-marker'] as const)('%sの履歴を拒否する', kind => {
    const ledger = used(), marker = ledger.history[1]!, primary = ledger.history[2]!;
    let history: unknown[] = [...ledger.history];
    if (kind === 'missing-primary') history = history.slice(0, -1);
    if (kind === 'duplicate-source') history.push({ ...marker, eventId: 'again-alternative', operationId: 'again' }, { ...primary, eventId: 'again' });
    if (kind === 'shared-operation') history.push({ ...marker, source: { ...original, entry: '002' } });
    if (kind === 'duplicate-primary') history.push(primary);
    if (kind === 'wrong-order') history = [ledger.history[0], primary, marker];
    if (kind === 'fake-changes') history[1] = { ...marker, changes: primary.changes };
    if (kind === 'correct-marker') history.push({ ...meta('bad'), kind: 'correctTime', targetEventId: marker.eventId, previous: at, corrected: null, changes: [] });
    rejects({ ...ledger, history });
  });

  test.each(['missing', 'lot', 'actor', 'time', 'duplicate'] as const)('受け取りのreceiptRecord%sを拒否する', kind => {
    const state = receiveLot(beginAlternativeRecord(practiceLedger, meta('in'), 'receive', original, ['P']), emptySupply, meta('in'), lot, 'counted', 10);
    const receipt = state.supply.log[0]!;
    const log = kind === 'missing' ? [] : kind === 'duplicate' ? [receipt, receipt] : [{ ...receipt, ...(kind === 'lot' ? { lotId: 'other' } : kind === 'actor' ? { actor: '架空B' } : { occurredAt: null }) }];
    rejects(state.ledger, { ...state.supply, log });
  });

  test('証拠だけの保存単位を確定せず、旧台帳のbytesも変えない', () => {
    const store = storeOf(), before = replace(store, null, { ledger: base(), supply: emptySupply });
    const bytes = [...store.data], ledger = beginAlternativeRecord(before.ledger, meta('u'), 'use', original, ['P']);
    const result = commit(store, before, { opId: 'op1', opLabel: '後入力', fingerprint: 'f', values: {}, actor: meta('u').actor, startedAt: at, savingSince: at }, [{ conflictReviews: [], ledger, supply: emptySupply, targets: ['元の資料'] }]);
    expect(result.kind).toBe('failed'); expect([...store.data]).toEqual(bytes);
  });

  test('保存応答喪失の再読込・照会・再試行で元の資料と受け取りを一回だけ残す', () => {
    const store = storeOf(), current = replace(store, null, { ledger: practiceLedger, supply: emptySupply });
    const state = receiveLot(beginAlternativeRecord(practiceLedger, meta('in'), 'receive', original, ['P']), emptySupply, meta('in'), lot, 'counted', 10), write = store.setItem;
    store.setItem = (key, value) => { write(key, value); if (key === 'fuzzy-stock/head') throw Error('応答喪失'); };
    const result = commit(store, current, { opId: 'op1', opLabel: '後入力受入', fingerprint: 'f', values: original, actor: meta('in').actor, startedAt: at, savingSince: at }, [{ conflictReviews: [], ...state, targets: targetsOf(current, state) }]);
    expect(result.kind).toBe('unknown'); store.setItem = write;
    const pending = decodePending(JSON.parse(store.getItem('fuzzy-stock/pending') ?? 'null'));
    const checked = inquire(store, pending); expect(checked.savedUnits).toBe(1);
    expect(retry(store, checked.snapshot, pending, meta('retry').actor, at).kind).toBe('recovered');
    const loaded = load(store); expect(loaded.kind).toBe('ok');
    if (loaded.kind === 'ok') {
      expect(loaded.snapshot.ledger).toEqual(state.ledger); expect(loaded.snapshot.supply).toEqual(state.supply);
      expect(() => beginAlternativeRecord(loaded.snapshot.ledger, meta('again'), 'receive', original, ['P'])).toThrow('記録済み');
    }
  });

  test('証拠を持たない従来の保存を読む', () => {
    const snapshot = initial(base(), emptySupply); expect(parse(serialize(snapshot))).toEqual(snapshot);
  });
});
