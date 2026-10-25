import { legacyNeedImport } from '../fixtures/n1-legacy-pending.ts';
import { legacyV5NeedImport } from '../fixtures/n1-v5-pending.ts';
import { describe, expect, test } from 'vitest';
import { changeMasters, practiceLedger, type Meta } from '../../src/domain/ledger.ts';
import { fixedMasters } from '../../src/domain/masters.ts';
import { emptySupply, registerNeed, reviseNeed, type Supply } from '../../src/domain/supply.ts';
import { applyNeedImport, previewNeedImport, previewNeedImportResolution, resolveNeedImport } from '../../src/domain/need-import.ts';
import { backupTextOf, readBackup } from '../../src/ui/backup.ts';
import { commit, fingerprintOf, initial, inquire, load, parse, replace, retry, serialize, targetsOf, type OpEntry, type StoreLike } from '../../src/ui/storage.ts';
import { decodePending } from '../../src/ui/storageparse.ts';

const at = '2026-10-14T09:00:00+09:00';
const meta = (eventId: string): Meta => ({ eventId, actor: '架空担当A', occurredAt: at, recordedAt: at });
const row = { format: 'fuzzy-stock-need-row', version: 1, source: '架空N1資料', line: '007', revision: '初版', previousRevision: null, caseCode: 'A-001', itemCode: 'P', unit: '個', required: { basis: 'counted', value: 100 }, dueDate: null };
const raw = JSON.stringify(row);
const apply = (s: Supply, id: string, text = raw, masters = fixedMasters) => applyNeedImport(s, masters, meta(id), text, previewNeedImport(s, masters, text).token);
const bytes = (text: string) => new TextEncoder().encode(text).length;
const storeOf = (data = new Map<string, string>()) => ({ data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } }) satisfies StoreLike & { data: Map<string, string> };
const manual = () => registerNeed(emptySupply, fixedMasters, meta('manual'), { project: { kind: 'case', id: 'A-001' }, item: 'P', unit: '個', required: { basis: 'counted', value: 100 }, dueDate: null, source: '手入力', revision: '初版' });
const decimalLedger = changeMasters(practiceLedger, meta('master'), { action: 'register', master: { type: 'item', code: 'D', name: '架空小数材料', source: null, units: ['kg'], unitSteps: { kg: 0.1 }, trial: true } });

describe('N1: 確認tokenの容量と履歴に対する失効', () => {
  test.each([
    { name: '整数', ledger: practiceLedger, input: row },
    { name: '0.1刻み', ledger: decimalLedger, input: { ...row, itemCode: 'D', unit: 'kg', required: { basis: 'counted', value: 0.1 } } },
  ])('$name: 同じ長い原文の再取込でも確認tokenを履歴量に比例して増やさず、保存と原履歴を保持する', ({ ledger, input }) => {
    const padded = ' '.repeat(12000) + JSON.stringify(input), masters = ledger.masters;
    const first = bytes(previewNeedImport(emptySupply, masters, padded).token);
    let s = emptySupply;
    const ops: Record<string, OpEntry> = {};
    for (let n = 1; n <= 24; n++) {
      const p = previewNeedImport(s, masters, padded), id = `import${n}`;
      ops[id] = { fingerprint: fingerprintOf('必要明細取込', { needRaw: padded, needToken: p.token, needConfirmed: true }), units: [[id]] };
      s = apply(s, id, padded, masters);
      expect(p.decision.kind).toBe(n === 1 ? 'create' : 'unchanged');
    }
    expect(bytes(previewNeedImport(s, masters, padded).token)).toBeLessThan(first * 3);
    expect(Object.keys(s.needs)).toEqual(['import1']);
    expect(s.needs['import1']?.required.value).toBe(input.required.value);
    expect(s.log).toHaveLength(24);
    for (const e of s.log) {
      expect(e.kind).toBe('needImport');
      if (e.kind === 'needImport') expect(e.input.raw).toBe(padded);
    }
    const snapshot = { ...initial(ledger, s), ops }, wire = serialize(snapshot);
    expect(bytes(wire)).toBeLessThan(bytes(padded) * 24 * 6);
    expect(parse(wire)).toEqual(snapshot);
  });

  test('現在値が同じでも別の取込履歴が追加された確認は拒否する', () => {
    const s = apply(emptySupply, 'first'), p = previewNeedImport(s, fixedMasters, raw);
    const newer = apply(s, 'unchanged');
    expect(newer.needs).toBe(s.needs);
    expect(() => applyNeedImport(newer, fixedMasters, meta('stale'), raw, p.token)).toThrow('確認');
    expect(newer.log).toHaveLength(2);
  });

  test('手動変更して値を戻しても取込と保留照合の古い確認を使わない', () => {
    const s = apply(emptySupply, 'first'), p = previewNeedImport(s, fixedMasters, raw), n = s.needs['first']!;
    const changed = reviseNeed(s, fixedMasters, meta('edit'), n.id, { ...n, required: { basis: 'counted', value: 90 } });
    const reverted = reviseNeed(changed, fixedMasters, meta('revert'), n.id, n);
    expect(() => applyNeedImport(reverted, fixedMasters, meta('stale'), raw, p.token)).toThrow('確認');
    const held = apply(reverted, 'held'), resolution = previewNeedImportResolution(held, fixedMasters, 'held', 'apply', n.id);
    const editedAgain = reviseNeed(held, fixedMasters, meta('edit2'), n.id, { ...n, required: { basis: 'counted', value: 80 } });
    const revertedAgain = reviseNeed(editedAgain, fixedMasters, meta('revert2'), n.id, n);
    expect(() => resolveNeedImport(revertedAgain, fixedMasters, meta('stale2'), 'held', 'apply', n.id, '確認', resolution.token)).toThrow('確認');
  });

  test('同じ資料と行が別の組へ先に対応した確認と、競合する保留照合を拒否する', () => {
    const p = previewNeedImport(emptySupply, fixedMasters, raw);
    const competitor = apply(emptySupply, 'competitor', JSON.stringify({ ...row, itemCode: 'Q' }));
    expect(() => applyNeedImport(competitor, fixedMasters, meta('stale'), raw, p.token)).toThrow('確認');
    let s = apply(manual(), 'held');
    const resolution = previewNeedImportResolution(s, fixedMasters, 'held', 'apply', 'manual');
    s = apply(s, 'competing-held', JSON.stringify({ ...row, line: '008' }));
    const other = previewNeedImportResolution(s, fixedMasters, 'competing-held', 'apply', 'manual');
    s = resolveNeedImport(s, fixedMasters, meta('competing-bind'), 'competing-held', 'apply', 'manual', '架空資料を確認', other.token);
    expect(() => resolveNeedImport(s, fixedMasters, meta('stale-resolve'), 'held', 'apply', 'manual', '確認', resolution.token)).toThrow('対応');
  });

  test('過去改訂の再使用は保留し、無関係な明細だけの変更では確認を失効しない', () => {
    const s = apply(emptySupply, 'first'), next = JSON.stringify({ ...row, revision: '改訂2', previousRevision: '初版', required: { basis: 'counted', value: 80 } });
    const p = previewNeedImport(s, fixedMasters, next);
    const other = apply(s, 'other', JSON.stringify({ ...row, source: '別資料', itemCode: 'Q' }));
    const revised = applyNeedImport(other, fixedMasters, meta('revision'), next, p.token);
    expect(previewNeedImport(revised, fixedMasters, raw).decision.kind).toBe('hold');
    const stopped = { ...fixedMasters, items: { ...fixedMasters.items, P: { ...fixedMasters.items['P']!, active: false } } };
    expect(() => applyNeedImport(s, stopped, meta('stale-master'), next, p.token)).toThrow('確認');
  });
});

describe('N1: 旧保存と保存競合の互換性', () => {
  test.each(legacyV5NeedImport.fixtures)('修正前の版5・0.1の$modeを旧fingerprintのまま一度だけ復旧する', fixture => {
    expect(legacyV5NeedImport.base).toBe('81c7c1d90869334076342bbf05fa097094350c35');
    const store = storeOf(new Map(Object.entries(fixture.data)));
    const pendingText = store.getItem('fuzzy-stock/pending');
    if (!pendingText) throw Error('旧pendingがない');
    const pending = decodePending(JSON.parse(pendingText)), loaded = load(store);
    if (loaded.kind !== 'ok') throw Error('修正前の版5を読み込める');
    expect(inquire(store, pending).savedUnits).toBe(fixture.savedUnits);
    expect(retry(store, loaded.snapshot, pending, '架空担当A', legacyV5NeedImport.at).kind).toBe(fixture.savedUnits === 0 ? 'saved' : 'recovered');
    const restored = load(store);
    if (restored.kind !== 'ok') throw Error('復旧後の保存を読み込める');
    expect(restored.pending).toBeNull();
    expect(restored.snapshot.ops['op2']?.fingerprint).toBe(pending.fingerprint);
    expect(restored.snapshot.supply).toEqual(pending.units[0]?.supply);
    expect(restored.snapshot.supply.log).toHaveLength(2);
    expect(restored.snapshot.supply.needs['op1']?.required.value).toBe(0.2);
    expect(restored.snapshot.ledger.masters.items['D']?.unitSteps['kg']).toBe(0.1);
    const beforeRetry = [...store.data];
    expect(inquire(store, pending).savedUnits).toBe(1);
    expect(['duplicate', 'recovered']).toContain(retry(store, restored.snapshot, pending, '架空担当A', legacyV5NeedImport.at).kind);
    expect([...store.data]).toEqual(beforeRetry);
    const backup = readBackup(new TextEncoder().encode(backupTextOf(restored.snapshot, legacyV5NeedImport.at)));
    expect(backup.kind).toBe('ok');
    if (backup.kind === 'ok') expect(backup.snapshot).toEqual(restored.snapshot);
  });

  test('基準commitで実生成した旧token付き版4の保存と応答喪失pendingを読んで一回だけ復旧する', () => {
    const fixture = legacyNeedImport;
    expect(fixture.base).toBe('d0e2ca6ab56eec628390a061fa888e8f855d9e42');
    const store = storeOf(new Map(Object.entries(fixture.data)));
    const pending = decodePending(JSON.parse(store.getItem('fuzzy-stock/pending')!));
    const loaded = load(store);
    if (loaded.kind !== 'ok') throw Error('旧保存を読み込める');
    expect(loaded.snapshot.ops['op2']?.fingerprint).toBe(pending.fingerprint);
    expect(pending.values['needToken']).toBeTruthy();
    const original = loaded.snapshot.supply;
    expect(inquire(store, pending).savedUnits).toBe(1);
    expect(retry(store, loaded.snapshot, pending, '架空担当A', at).kind).toBe('recovered');
    const restored = load(store);
    if (restored.kind !== 'ok') throw Error('復旧を読み込める');
    expect(restored.snapshot.supply).toEqual(original);
    expect(restored.snapshot.supply.log).toHaveLength(2);
    const backup = readBackup(new TextEncoder().encode(backupTextOf(restored.snapshot, at)));
    expect(backup.kind).toBe('ok');
    if (backup.kind === 'ok') expect(backup.snapshot).toEqual(restored.snapshot);
  });

  test('別画面が保存した古いsnapshotを上書きせず、応答喪失の照会と再試行は重複させない', () => {
    const store = storeOf(), before = replace(store, null, { ledger: practiceLedger, supply: emptySupply });
    const p = previewNeedImport(before.supply, before.ledger.masters, raw);
    const supply = applyNeedImport(before.supply, before.ledger.masters, meta('op1'), raw, p.token);
    const after = { ledger: practiceLedger, supply }, units = [{ ...after, conflictReviews: before.conflictReviews, targets: targetsOf(before, after) }];
    const op = { opId: 'op1', opLabel: '必要明細取込', fingerprint: fingerprintOf('必要明細取込', { needRaw: raw, needToken: p.token }), values: { needRaw: raw, needToken: p.token }, actor: '架空担当A', startedAt: at, savingSince: at };
    const write = store.setItem;
    store.setItem = (k, v) => { write(k, v); if (k === 'fuzzy-stock/head') throw Error('応答喪失'); };
    expect(commit(store, before, op, units).kind).toBe('unknown');
    store.setItem = write;
    const pending = decodePending(JSON.parse(store.getItem('fuzzy-stock/pending')!));
    const checked = inquire(store, pending);
    expect(retry(store, checked.snapshot, pending, '架空担当A', at).kind).toBe('recovered');
    const bytesBefore = [...store.data];
    expect(commit(store, before, { ...op, opId: 'op2' }, units).kind).toBe('conflict');
    expect([...store.data]).toEqual(bytesBefore);
    expect(load(store).kind).toBe('ok');
    expect(checked.snapshot.supply.log).toHaveLength(1);
  });
});
