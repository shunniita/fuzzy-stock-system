import { describe, expect, test } from 'vitest';
import { beginAlternativeRecord, changeMasters, correctOccurredAt, practiceLedger, register, use, type Meta } from '../../src/domain/ledger.ts';
import { emptySupply, receiveLot, recordRequest } from '../../src/domain/supply.ts';
import { applyNeedImport, previewNeedImport } from '../../src/domain/need-import.ts';
import { backupTextOf, crc32, readBackup } from '../../src/ui/backup.ts';
import { initial, load, parse, serialize, serializePending, type Pending, type Snapshot } from '../../src/ui/storage.ts';
import { decodePending, decodeSnapshot } from '../../src/ui/storageparse.ts';

const at = '2026-10-24T09:00:00+09:00';
const meta = (eventId: string, occurredAt: string | null = at): Meta => ({ eventId, actor: '架空担当A', recordedAt: at, occurredAt });
const received = () => receiveLot(practiceLedger, emptySupply, meta('receive'), { id: 'p', item: 'P', unit: '個', location: 'S1', project: { kind: 'common' } }, 'label', 10);
const pending = (s: Snapshot): Pending => ({ progress: 'saving', unknownSince: null, savingSince: at, baseRevision: 0, opId: 'receive', opLabel: '架空受入', fingerprint: 'f', values: {}, actor: '架空担当A', startedAt: at, units: [{ ledger: s.ledger, supply: s.supply, conflictReviews: [], targets: ['p'] }] });
const snapshot = () => { const state = received(); return initial(state.ledger, state.supply); };
const raw = () => JSON.parse(serialize(snapshot()));
const bytes = (text: string) => new TextEncoder().encode(text);
const backup = (value: unknown) => {
  const text = JSON.stringify(value);
  return bytes(JSON.stringify({ notice: '架空試験', format: 'fuzzy-stock-backup', version: 1, createdAt: at, crc32: crc32(bytes(`${at}\n${text}`)).toString(16).padStart(8, '0'), snapshot: text }));
};
const rejectThree = (value: ReturnType<typeof raw>, reason?: string) => {
  expect(() => decodeSnapshot(value)).toThrow(reason);
  expect(() => decodePending({ format: 'fuzzy-stock-pending', version: value.version, quantities: value.quantities, pending: pending(value) })).toThrow(reason);
  const restored = readBackup(backup(value));
  expect(restored).toMatchObject({ kind: 'unreadable', reason: expect.stringContaining('記録の検査を通らない') });
  if (reason !== undefined && restored.kind === 'unreadable') expect(restored.reason).toContain(reason);
};
function legacy(value: unknown, version = 8) {
  return JSON.parse(JSON.stringify(value, (key, entry: unknown) => {
    if ((key === 'consumable' || key === 'processes' || key === 'nextProcess') || key === 'itemLabels' || (version < 7 && key === 'receiptTemplates') || (version < 6 && key === 'conflictReviews') || (version < 5 && key === 'unitSteps') || (version < 3 && key === 'masters')) return undefined;
    return entry;
  }));
}

describe('履歴表示 task3 追記時の固定', () => {
  test('ledgerとsupplyは返却時点で名称・コードを凍結し、後の同時刻改名・中断でも変えない', () => {
    const state = received();
    expect(state.ledger.history[0]).toHaveProperty('itemLabels', { kind: 'recorded', items: { P: { name: '架空部品P', code: 'P' } } });
    expect(state.supply.log[0]).toHaveProperty('itemLabels', { kind: 'recorded', items: { P: { name: '架空部品P', code: 'P' } } });
    let changed = changeMasters(state.ledger, meta('rename'), { action: 'rename', type: 'item', id: 'P', name: '架空の変更後', reason: '架空の改名' });
    changed = changeMasters(changed, meta('deactivate'), { action: 'deactivate', type: 'item', id: 'P', reason: '架空の停止' });
    expect(changed.history[0]).toEqual(state.ledger.history[0]);
    expect(changed.history.at(-1)).toHaveProperty('itemLabels', { kind: 'recorded', items: {} });
    expect(Object.isFrozen(Reflect.get(state.ledger.history[0]!, 'itemLabels'))).toBe(true);
  });
  test('正式コードなしの既知品目→正式化→再付替えでも当時表示を保持', () => {
    let ledger = changeMasters(practiceLedger, meta('new'), { action: 'register', master: { type: 'item', code: null, name: '架空仮品目', units: ['個'], unitSteps: { 個: 1 }, trial: true, source: null } });
    const id = Object.keys(ledger.masters.items).find(id => !(id in practiceLedger.masters.items))!;
    ledger = register(ledger, meta('register', null), { id: 'new-lot', item: id, unit: '個', location: 'S1', project: { kind: 'common' } }, 'label', 1);
    const record = ledger.history.at(-1)!;
    expect(record).toHaveProperty('itemLabels', { kind: 'recorded', items: { [id]: { name: '架空仮品目', code: null } } });
    ledger = changeMasters(ledger, meta('formal'), { action: 'code', type: 'item', id, code: '0007', reason: '架空正式化' });
    ledger = changeMasters(ledger, meta('recode'), { action: 'code', type: 'item', id, code: '0008', reason: '架空変更' });
    expect(ledger.history.find(e => e.eventId === 'register')).toEqual(record);
  });
  test('後入力と日時訂正は現在の記録追加時に取得し、元イベントを上書きしない', () => {
    const first = received();
    const changed = changeMasters(first.ledger, meta('rename'), { action: 'rename', type: 'item', id: 'P', name: '架空の新名称', reason: '架空' });
    const used = use(changed, meta('use', null), 'p', 'label', 1, '架空使用先');
    expect(used.history.at(-1)).toHaveProperty('itemLabels.items.P.name', '架空の新名称');
    const corrected = correctOccurredAt(used, meta('correct'), 'use', at);
    expect(corrected.history.at(-1)).toHaveProperty('itemLabels.items.P.name', '架空の新名称');
    expect(corrected.history.find(e => e.eventId === 'receive')).toEqual(first.ledger.history[0]);
  });
  test('need-importの直接追記にも現在の品目表示を保持する', () => {
    const text = JSON.stringify({ format: 'fuzzy-stock-need-row', version: 1, source: '架空資料', line: '001', revision: '01', previousRevision: null, caseCode: 'A-001', itemCode: 'P', unit: '個', required: { basis: 'label', value: 2 }, dueDate: null });
    const preview = previewNeedImport(emptySupply, practiceLedger.masters, text);
    const supply = applyNeedImport(emptySupply, practiceLedger.masters, meta('import'), text, preview.token);
    expect(supply.log.at(-1)).toHaveProperty('itemLabels.items.P', { name: '架空部品P', code: 'P' });
    expect(parse(serialize(initial(practiceLedger, supply))).supply).toEqual(supply);
  });
  test('元の資料の前置きは呼出元の明示対象で固定し、本体の実際の集合と復号時に照合', () => {
    const base = received();
    const staged = beginAlternativeRecord(base.ledger, meta('use'), 'use', { source: '架空資料', entry: '001', originalActor: '架空担当A' }, ['P']);
    expect(staged.history.at(-1)).toHaveProperty('itemLabels.items.P.name', '架空部品P');
    const ledger = use(staged, meta('use'), 'p', 'label', 1, '架空使用先');
    const state = initial(ledger, base.supply);
    expect(parse(serialize(state))).toEqual(state);
    const corrupt = JSON.parse(serialize(state));
    corrupt.ledger.history.find((e: { kind: string }) => e.kind === 'alternativeRecord').itemLabels.items = { Q: { name: '架空', code: null } };
    rejectThree(corrupt, 'itemLabels');
    expect(() => decodeSnapshot(initial(staged, base.supply))).toThrow();
  });
});

describe('履歴表示 task3 統合保存版9と旧版', () => {
  test('負例と同じ手作りbackup包みの正常対照は内側snapshotを読み取れる', () => {
    expect(readBackup(backup(raw()))).toMatchObject({ kind: 'ok', snapshot: snapshot() });
  });
  test('新規snapshot/pending/backupを版12で往復し、外側backup版1を保つ', () => {
    const s = snapshot();
    expect(s.version).toBe(12);
    expect(parse(serialize(s))).toEqual(s);
    expect(JSON.parse(serializePending(pending(s))).version).toBe(12);
    expect(decodePending(JSON.parse(serializePending(pending(s))))).toEqual(pending(s));
    const envelope = JSON.parse(backupTextOf(s, at));
    expect(envelope.version).toBe(1);
    expect(readBackup(bytes(JSON.stringify(envelope)))).toMatchObject({ kind: 'ok', snapshot: s });
  });
  test.each([1, 2, 3, 4, 5, 6, 7, 8])('真正旧版%sは当時表示不明へ読み、読込だけでは保存先を変えない', version => {
    const value = legacy({ ...(version === 1 ? snapshot() : raw()), version }, version), before = JSON.stringify(value);
    const restored = decodeSnapshot(value);
    expect(restored.version).toBe(12);
    expect(restored.ledger.history[0]).toHaveProperty('itemLabels', { kind: 'legacy-unavailable' });
    expect(restored.supply.log[0]).toHaveProperty('itemLabels', { kind: 'legacy-unavailable' });
    expect(JSON.stringify(value)).toBe(before);
    const data = new Map([['fuzzy-stock/head', 'A'], ['fuzzy-stock/slot-A', before]]);
    const store = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
    expect(load(store).kind).toBe('ok');
    expect([...data]).toEqual([['fuzzy-stock/head', 'A'], ['fuzzy-stock/slot-A', before]]);
    expect(parse(serialize(restored))).toEqual(restored);
  });
  test.each([1, 2, 3, 4, 5, 6, 7, 8])('旧版%sへ新表示欄が混じったときは拒否', version => {
    const value = legacy({ ...(version === 1 ? snapshot() : raw()), version }, version);
    value.ledger.history[0].itemLabels = { kind: 'recorded', items: {} };
    expect(() => decodeSnapshot(value)).toThrow('itemLabels');
  });
  test.each(['missing', 'unknown-outer', 'unknown-item', 'missing-name', 'number-name', 'blank-name', 'missing-code', 'number-code', 'blank-code', 'missing-id', 'extra-id', 'bad-kind', 'legacy-extra'])('表示欄%sを3保存境界で拒否', mode => {
    const value = raw();
    const record = value.ledger.history[0];
    record.itemLabels = { kind: 'recorded', items: { P: { name: '架空部品P', code: 'P' } } };
    const labels = record.itemLabels;
    if (mode === 'missing') delete record.itemLabels;
    if (mode === 'unknown-outer') labels.extra = true;
    if (mode === 'unknown-item') labels.items.P.active = true;
    if (mode === 'missing-name') delete labels.items.P.name;
    if (mode === 'number-name') labels.items.P.name = 1;
    if (mode === 'blank-name') labels.items.P.name = ' \t ';
    if (mode === 'missing-code') delete labels.items.P.code;
    if (mode === 'number-code') labels.items.P.code = 1;
    if (mode === 'blank-code') labels.items.P.code = ' \t ';
    if (mode === 'missing-id') labels.items = {};
    if (mode === 'extra-id') labels.items.Q = { name: '架空', code: null };
    if (mode === 'bad-kind') labels.kind = 'unknown';
    if (mode === 'legacy-extra') record.itemLabels = { kind: 'legacy-unavailable', items: {} };
    rejectThree(value, 'itemLabels');
  });
  test('現在の名称・コードと異なる正当な記録表示を受理し、数量・依頼照合を保つ', () => {
    const state = received();
    const supply = recordRequest(state.supply, state.ledger.masters, meta('request'), { project: { kind: 'common' }, item: 'P', unit: '個', quantity: 1, vendor: '架空商社', requestedOn: '2026-10-24', reply: { kind: 'none' } });
    const ledger = changeMasters(state.ledger, meta('rename'), { action: 'rename', type: 'item', id: 'P', name: '架空の新名称', reason: '架空' });
    const s = initial(ledger, supply);
    expect(parse(serialize(s))).toEqual(s);
    expect(supply.requests['request']!.quantity).toBe(1);
  });
});
