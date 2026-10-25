import { legacyEventLabels } from '../fixtures/history-labels.ts';
import { fixedMasters } from '../../src/domain/masters.ts';
import { describe, expect, test } from 'vitest';
import { practiceLedger, type Meta } from '../../src/domain/ledger.ts';
import { emptySupply, registerNeed, reviseNeed } from '../../src/domain/supply.ts';
import { applyNeedImport, previewNeedImport, previewNeedImportResolution, resolveNeedImport } from '../../src/domain/need-import.ts';
import { backupTextOf, readBackup } from '../../src/ui/backup.ts';
import { commit, initial, inquire, load, parse, replace, retry, serialize, targetsOf, type StoreLike } from '../../src/ui/storage.ts';
import { decodePending } from '../../src/ui/storageparse.ts';
import { supplyEventText } from '../../src/ui/supply-format.ts';
import { viewSheetsOf } from '../../src/ui/viewsheets.ts';

const at = '2026-10-14T09:00:00+09:00';
const meta = (eventId: string): Meta => ({ eventId, actor: '架空担当A', occurredAt: at, recordedAt: at });
const raw = ' \r\n' + JSON.stringify({ format: 'fuzzy-stock-need-row', version: 1, source: '=架空資料', line: '007', revision: '初版', previousRevision: null, caseCode: 'A-001', itemCode: 'P', unit: '個', required: { basis: 'counted', value: 100 }, dueDate: null }) + '\r\n';
const imported = () => applyNeedImport(emptySupply, practiceLedger.masters, meta('import'), raw, previewNeedImport(emptySupply, practiceLedger.masters, raw).token);
const storeOf = () => {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } } satisfies StoreLike & { data: Map<string, string> };
};

describe('取込と照合の保存境界', () => {
  test.each(['missing', 'changed', 'alias'])('5.4: 保留候補の既存明細が破損（%s）していれば拒否', damage => {
    const manual = registerNeed(emptySupply, fixedMasters, meta('manual'), { project: { kind: 'case', id: 'A-001' }, item: 'P', unit: '個', required: { basis: 'counted', value: 100 }, dueDate: null, source: '手入力', revision: '初版' });
    const s = applyNeedImport(manual, practiceLedger.masters, meta('held'), raw, previewNeedImport(manual, practiceLedger.masters, raw).token);
    const n = manual.needs['manual']!;
    const needs = damage === 'missing' ? {} : damage === 'changed' ? { manual: { ...n, required: { basis: 'counted', value: 7 } as const } } : { alias: n, ...s.needs };
    expect(() => parse(serialize(initial(practiceLedger, { ...s, needs })))).toThrow();
  });

  test.each(['item', 'project'])('5.4: 取込履歴と現在値を揃えても未登録%sへの参照は拒否', target => {
    const s = imported(), e = s.log[0];
    if (e?.kind !== 'needImport' || e.decision.kind === 'hold') throw Error('fixture');
    const after = target === 'item' ? { ...e.decision.after, item: 'MISSING' } : { ...e.decision.after, project: { kind: 'case', id: 'MISSING' } as const };
    const damaged = { ...s, needs: { import: after }, log: [{ ...e, decision: { ...e.decision, after } }] };
    expect(() => parse(serialize(initial(practiceLedger, damaged)))).toThrow();
  });

  test.each([100, 7])('5.4: 同じ内部IDの辞書別名（必要な数%d）を先に置いた取込記録は拒否', value => {
    const s = imported(), n = s.needs['import']!;
    const damaged = { ...s, needs: { alias: { ...n, required: { ...n.required, value } }, ...s.needs } };
    expect(() => parse(serialize(initial(practiceLedger, damaged)))).toThrow();
  });

  test('5.3: 現在の登録情報が名称/コード変更・利用停止でも当時の対応を保持', () => {
    const masters = practiceLedger.masters;
    const ledger = { ...practiceLedger, masters: { ...masters, items: { ...masters.items, P: { ...masters.items['P']!, code: '変更後P', name: '変更後名称', active: false } } } };
    const s = initial(ledger, imported());
    expect(parse(serialize(s))).toEqual(s);
  });

  test('5.1・5.3: 取込/手動衝突/保留/理由付き照合がsnapshotとbackupを往復', () => {
    let s = imported();
    s = reviseNeed(s, fixedMasters, meta('manual'), 'import', { ...s.needs['import']!, required: { basis: 'counted', value: 80 } });
    s = applyNeedImport(s, practiceLedger.masters, meta('held'), raw, previewNeedImport(s, practiceLedger.masters, raw).token);
    const p = previewNeedImportResolution(s, practiceLedger.masters, 'held', 'apply', 'import');
    s = resolveNeedImport(s, practiceLedger.masters, meta('resolve'), 'held', 'apply', 'import', '架空資料を確認', p.token);
    const snapshot = initial(practiceLedger, s);
    expect(parse(serialize(snapshot))).toEqual(snapshot);
    const backup = readBackup(new TextEncoder().encode(backupTextOf(snapshot, at)));
    expect(backup.kind).toBe('ok');
    if (backup.kind === 'ok') expect(backup.snapshot).toEqual(snapshot);
  });

  test.each(['event-extra', 'row-extra', 'raw-mismatch', 'after-extra', 'after-quantity', 'current-quantity', 'missing-need', 'wrong-id'])('5.4: 破損%sを拒否し原保存を保持', damage => {
    const s = imported(), e = s.log[0];
    if (e?.kind !== 'needImport' || e.decision.kind === 'hold') throw Error('fixture');
    let event: unknown = e;
    if (damage === 'event-extra') event = { ...e, extra: 'discarded' };
    if (damage === 'row-extra') event = { ...e, input: { ...e.input, row: { ...e.input.row, extra: 1 } } };
    if (damage === 'raw-mismatch') event = { ...e, input: { ...e.input, raw: raw.replace('007', '008') } };
    if (damage === 'after-extra') event = { ...e, decision: { ...e.decision, after: { ...e.decision.after, extra: 1 } } };
    if (damage === 'after-quantity') event = { ...e, decision: { ...e.decision, after: { ...e.decision.after, required: { basis: 'counted', value: 99 } } } };
    if (damage === 'wrong-id') event = { ...e, decision: { ...e.decision, after: { ...e.decision.after, id: 'another' } } };
    const needs = damage === 'missing-need' ? {} : damage === 'current-quantity' ? { import: { ...s.needs['import'], required: { basis: 'counted', value: 99 } } } : s.needs;
    const text = JSON.stringify({ ...initial(practiceLedger, s), supply: { ...s, needs, log: [event] } });
    expect(() => parse(text)).toThrow();
    const store = storeOf(); store.data.set('fuzzy-stock/head', 'A'); store.data.set('fuzzy-stock/slot-A', text);
    const before = [...store.data];
    expect(load(store).kind).toBe('unreadable');
    expect([...store.data]).toEqual(before);
  });

  test('5.4: 存在しない保留への参照と二重解消を拒否', () => {
    let s = imported();
    const conflict = raw.replace('100', '90');
    s = applyNeedImport(s, practiceLedger.masters, meta('held'), conflict, previewNeedImport(s, practiceLedger.masters, conflict).token);
    const p = previewNeedImportResolution(s, practiceLedger.masters, 'held', 'dismiss', '');
    s = resolveNeedImport(s, practiceLedger.masters, meta('resolve'), 'held', 'dismiss', '', '見送り', p.token);
    const event = s.log.at(-1);
    expect(() => parse(serialize(initial(practiceLedger, { ...s, log: [...s.log, { ...meta('duplicate'), ...legacyEventLabels, kind: 'needImportResolve', importEventId: 'held', reason: '再度', resolution: { kind: 'dismiss' } }] })))).toThrow();
    if (event?.kind !== 'needImportResolve') throw Error('fixture');
    expect(() => parse(serialize(initial(practiceLedger, { ...s, log: [...s.log.slice(0, -1), { ...event, importEventId: 'missing' }] })))).toThrow();
  });

  test('5.2: 応答喪失後の照会と再試行でも必要明細と取込証拠を一回だけ保存', () => {
    const store = storeOf(), before = replace(store, null, { ledger: practiceLedger, supply: emptySupply });
    const after = { ledger: practiceLedger, supply: imported() };
    const write = store.setItem;
    store.setItem = (key, value) => { write(key, value); if (key === 'fuzzy-stock/head') throw Error('応答喪失'); };
    const result = commit(store, before, { opId: 'op1', opLabel: '必要明細取込', fingerprint: raw, values: { 原文: raw }, actor: '架空担当A', startedAt: at, savingSince: at }, [{ conflictReviews: [], ...after, targets: targetsOf(before, after) }]);
    expect(result, JSON.stringify(result)).toMatchObject({ kind: 'unknown' });
    store.setItem = write;
    const wire: unknown = JSON.parse(store.getItem('fuzzy-stock/pending') ?? 'null');
    const pending = decodePending(wire), checked = inquire(store, pending);
    expect(checked.savedUnits).toBe(1);
    expect(retry(store, checked.snapshot, pending, '架空担当A', at).kind).toBe('recovered');
    const loaded = load(store);
    if (loaded.kind !== 'ok') throw Error('保存が必要');
    expect(loaded.snapshot.supply).toEqual(after.supply);
    expect(loaded.snapshot.ledger).toEqual(practiceLedger);
    expect(targetsOf(before, after)).toEqual(['必要明細import', '必要明細取込import']);
  });

  test('5.3: 履歴と閲覧出力に読取原文・明細007と前後値を保持', () => {
    const s = imported(), event = s.log[0];
    if (!event) throw Error('fixture');
    expect(supplyEventText(practiceLedger.masters, event)).toContain(raw);
    const text = JSON.stringify(viewSheetsOf({ ledger: practiceLedger, supply: s }, at));
    expect(text).toContain('007');
    expect(text).toContain('=架空資料');
    expect(text).toContain('100');
  });
});
