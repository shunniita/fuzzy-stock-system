import { describe, expect, test } from 'vitest';
import { changeMasters, practiceLedger, register, type Ledger, type Meta } from '../../src/domain/ledger.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { backupTextOf, crc32, readBackup } from '../../src/ui/backup.ts';
import { commit, initial, inquire, load, parse, replace, retry, serialize, targetsOf, type StoreLike } from '../../src/ui/storage.ts';
import { decodePending } from '../../src/ui/storageparse.ts';
import { viewSheetsOf } from '../../src/ui/viewsheets.ts';

const at = '2026-10-14T03:00:00+09:00';
const meta = (eventId: string): Meta => ({ eventId, occurredAt: at, recordedAt: at, actor: '架空担当A' });
const review = { quantities: '数が不明を残す', requests: '架空の未完了2件', corrections: '訂正を演習', restore: '架空台帳で復元\r\n成功を確認', initial: '2個はラベルのまま' };
function enabled(): Ledger {
  const ledger = register(practiceLedger, meta('r'), { id: 'x', item: 'X', unit: '個', location: 'O', project: { kind: 'common' } }, 'unknown', null);
  return changeMasters(ledger, meta('trial'), { action: 'trial', type: 'item', id: 'X', trial: true, review, reason: '架空の拡大' });
}
const storeOf = () => {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } } satisfies StoreLike & { data: Map<string, string> };
};
function backupOf(text: string): Uint8Array {
  const bytes = new TextEncoder();
  return bytes.encode(JSON.stringify({ notice: '架空', format: 'fuzzy-stock-backup', version: 1, createdAt: at, crc32: crc32(bytes.encode(`${at}\n${text}`)).toString(16).padStart(8, '0'), snapshot: text }));
}
function rejects(text: string): void {
  expect(() => parse(text)).toThrow();
  expect(readBackup(backupOf(text)).kind).not.toBe('ok');
  const store = storeOf(); store.data.set('fuzzy-stock/head', 'A'); store.data.set('fuzzy-stock/slot-A', text);
  const before = [...store.data];
  expect(load(store).kind).toBe('unreadable');
  expect([...store.data]).toEqual(before);
  const snapshot = JSON.parse(text) as { ledger: unknown; supply: unknown };
  expect(() => decodePending({ progress: 'saving', unknownSince: null, savingSince: at, baseRevision: 0, opId: 'op1', opLabel: '試行変更', fingerprint: 'f', values: {}, actor: meta('x').actor, startedAt: at, units: [{ ...snapshot, targets: [] }] })).toThrow();
}

describe('試行変更4: 保存・復元・再試行', () => {
  test('後の名称・コード・中断・trial変更を許し、当時の確認を原文で保存する', () => {
    let ledger = enabled();
    ledger = changeMasters(ledger, meta('rename'), { action: 'rename', type: 'item', id: 'X', name: '架空改名', reason: '改名' });
    ledger = changeMasters(ledger, meta('code'), { action: 'code', type: 'item', id: 'X', code: '001X', reason: '正式ID' });
    ledger = changeMasters(ledger, meta('stop'), { action: 'deactivate', type: 'item', id: 'X', reason: '終了' });
    ledger = changeMasters(ledger, meta('off'), { action: 'trial', type: 'item', id: 'X', trial: false, review: null, reason: '縮小' });
    const snapshot = initial(ledger, emptySupply);
    expect(parse(serialize(snapshot))).toEqual(snapshot);
    const restored = readBackup(new TextEncoder().encode(backupTextOf(snapshot, at)));
    expect(restored.kind).toBe('ok');
    if (restored.kind === 'ok') expect(restored.snapshot).toEqual(snapshot);
    const sheets = viewSheetsOf(snapshot, at);
    const history = sheets.find(s => s.name === '台帳の履歴');
    const text = JSON.stringify(history);
    expect(text).toContain('対象外 → 試行対象');
    expect(text).toContain('試行対象 → 対象外');
    for (const value of Object.values(review)) expect(text).toContain(JSON.stringify(value).slice(1, -1));
  });

  const patches: [string, Record<string, unknown>][] = [
    ['確認の欠落', { review: undefined }], ['空の確認', { review: null }], ['過剰な欄', { review: { ...review, extra: '紛失させない' } }],
    ['空理由', { reason: ' \t ' }], ['空でないconfirmed', { confirmed: true }], ['未知の欄', { unexpected: '紛失させない' }],
    ...Object.keys(review).flatMap((key): [string, Record<string, unknown>][] => [[`${key}空白`, { review: { ...review, [key]: '\r\n ' } }], [`${key}欠落`, { review: { ...review, [key]: undefined } }]]),
  ];
  test.each(patches)('%sの記録はsnapshot/backup/pendingで拒否し保存bytesを保持', (_name, patch) => {
    const ledger = enabled();
    rejects(JSON.stringify(initial({ ...ledger, history: ledger.history.map(e => e.kind === 'master' ? { ...e, ...patch } : e) }, emptySupply)));
  });

  test.each(['two', 'before-null', 'unchanged', 'id', 'name', 'active', 'units', 'type', 'lot', 'false-review', 'missing-master'] as const)('%sの破損を拒否する', kind => {
    const ledger = enabled(), event = ledger.history.at(-1)!;
    if (event.kind !== 'master') throw Error('fixture');
    const pair = event.masters[0]!;
    const after = { ...pair.after };
    const patch: Record<string, unknown> = {};
    if (kind === 'two') patch['masters'] = [pair, pair];
    if (kind === 'before-null') patch['masters'] = [{ ...pair, before: null }];
    if (kind === 'unchanged') patch['masters'] = [{ ...pair, after: pair.before }];
    if (kind === 'id') patch['masters'] = [{ ...pair, after: { ...after, id: 'P' } }];
    if (kind === 'name') patch['masters'] = [{ ...pair, after: { ...after, name: '偽の改名' } }];
    if (kind === 'active') patch['masters'] = [{ ...pair, after: { ...after, active: false } }];
    if (kind === 'units') patch['masters'] = [{ ...pair, after: { ...after, units: ['本'] } }];
    if (kind === 'type') patch['masters'] = [{ before: ledger.masters.cases['A-001'], after: ledger.masters.cases['A-001'] }];
    if (kind === 'lot') patch['changes'] = [{ before: null, after: ledger.lots['x'] }];
    if (kind === 'false-review') patch['masters'] = [{ before: pair.after, after: pair.before }];
    const { X: _missing, ...items } = ledger.masters.items;
    rejects(JSON.stringify(initial({ ...ledger, masters: kind === 'missing-master' ? { ...ledger.masters, items } : ledger.masters, history: ledger.history.map(e => e === event ? { ...e, ...patch } : e) }, emptySupply)));
  });

  test('場所scopeをtrialと同時に書き換えた記録を拒否する', () => {
    const ledger = changeMasters(practiceLedger, meta('o'), { action: 'trial', type: 'location', id: 'O', trial: true, review, reason: '追加' });
    rejects(JSON.stringify(initial({ ...ledger, history: ledger.history.map(e => e.kind === 'master' ? { ...e, masters: e.masters.map(pair => ({ ...pair, after: { ...pair.after, scope: [{ from: null, inScope: false }] } })) } : e) }, emptySupply)));
  });

  test('保存応答喪失から照会・再試行しても一回だけ適用する', () => {
    const store = storeOf(), current = replace(store, null, { ledger: practiceLedger, supply: emptySupply });
    const ledger = changeMasters(practiceLedger, meta('trial'), { action: 'trial', type: 'item', id: 'X', trial: true, review, reason: '追加' });
    const after = { ledger, supply: emptySupply }, write = store.setItem;
    store.setItem = (key, value) => { write(key, value); if (key === 'fuzzy-stock/head') throw Error('応答喪失'); };
    const result = commit(store, current, { opId: 'op1', opLabel: '試行対象の変更', fingerprint: 'f', values: { 確認: review.initial }, actor: meta('op1').actor, startedAt: at, savingSince: at }, [{ conflictReviews: [], ...after, targets: targetsOf(current, after) }]);
    expect(result.kind).toBe('unknown');
    store.setItem = write;
    const pending = decodePending(JSON.parse(store.getItem('fuzzy-stock/pending') ?? 'null'));
    expect(pending.units[0]?.targets).toEqual(['品目X']);
    const checked = inquire(store, pending);
    expect(checked.savedUnits).toBe(1);
    expect(retry(store, checked.snapshot, pending, meta('retry').actor, at).kind).toBe('recovered');
    const loaded = load(store);
    expect(loaded.kind).toBe('ok');
    if (loaded.kind === 'ok') { expect(loaded.snapshot.ledger).toEqual(ledger); expect(loaded.snapshot.supply).toEqual(emptySupply); }
  });

  test('新actionのない先行保存は今まで通り読める', () => {
    const old = initial(practiceLedger, emptySupply);
    expect(parse(serialize(old))).toEqual(old);
  });
});
