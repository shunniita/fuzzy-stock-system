import { legacyEventLabels } from '../fixtures/history-labels.ts';
import { describe, expect, test } from 'vitest';
import { beginRework, declareDiscrepancy, practiceLedger as practiceBase, recordReworkPart, register, use, type Ledger, type Meta } from '../../src/domain/ledger.ts';
import { withProcesses } from './process-fixture.ts';
const practiceLedger = withProcesses(practiceBase, { id: '組立', criterion: 'workEnd' });
import { readCode } from '../../src/domain/code.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { backupTextOf, readBackup } from '../../src/ui/backup.ts';
import { decodePending } from '../../src/ui/storageparse.ts';
import { commit, initial, inquire, load, parse, replace, retry, serialize, targetsOf, type StoreLike } from '../../src/ui/storage.ts';
import { eventsOf, eventText } from '../../src/ui/format.ts';
import { viewSheetsOf } from '../../src/ui/viewsheets.ts';

const at = '2026-10-14T09:00:00+09:00';
const meta = (eventId: string): Meta => ({ eventId, occurredAt: at, recordedAt: at, actor: '架空担当A' });
function base(): Ledger {
  const l = register(practiceLedger, meta('register'), { id: 'finished', item: 'R', unit: '台', project: { kind: 'case', id: 'A-001' }, location: 'T', stage: { kind: 'awaitingHandover', process: { id: '組立', criterion: 'workEnd' } } }, 'label', 20);
  return beginRework(l, meta('rework'), 'finished', 'repair', 'label', 2, '架空の修理');
}
function recovered(ledger = base()): Ledger {
  return recordReworkPart(ledger, { ...meta('recover'), scan: readCode(' LABA|A-001|P\r\n', ledger.masters) }, { action: 'recover', reworkId: 'rework', subjectLotId: 'repair', lotId: 'recovered', item: 'P', unit: '個', location: 'S1', value: 2, reason: '実際の回収' });
}
const storeOf = () => {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } } satisfies StoreLike & { data: Map<string, string> };
};

describe('FH-C07〜08・やり直し・修理の保存と出力', () => {
  test('R2c: 工程出力でも未解決事項のある製造数を確定値と示さない', () => {
    const ledger = declareDiscrepancy(base(), meta('issue'), 'repair', '架空の数量確認待ち');
    const sheet = viewSheetsOf({ ledger, supply: emptySupply }, at).find(sheet => sheet.name === '工程集計');
    expect(sheet?.rows[0]?.at(-1)).toBe('確認が必要 1件：確定した製造の数として断定しない');
  });

  test('R2e・6.3: 部品対応記録に数量変更を混ぜた写しを拒否し、原保存は変えない', () => {
    const s = initial(recovered(), emptySupply);
    const forged = { before: null, after: s.ledger.lots['recovered']! };
    const broken = { ...s, ledger: { ...s.ledger, history: s.ledger.history.map(event => event.kind === 'reworkPart' ? { ...event, changes: [forged] } : event) } };
    const text = serialize(broken);
    expect(() => parse(text)).toThrow(/部品対応.*数量変更/);
    expect(readBackup(new TextEncoder().encode(backupTextOf(broken, at))).kind).not.toBe('ok');
    const store = storeOf(); store.data.set('fuzzy-stock/head', 'A'); store.data.set('fuzzy-stock/slot-A', text);
    const before = [...store.data];
    expect(load(store).kind).toBe('unreadable');
    expect([...store.data]).toEqual(before);
  });

  test('6.1: 新イベント・部品対応・原文がsnapshotとbackupを往復する', () => {
    const s = initial(recovered(), emptySupply);
    expect(parse(serialize(s))).toEqual(s);
    const backup = readBackup(new TextEncoder().encode(backupTextOf(s, at)));
    expect(backup.kind).toBe('ok');
    if (backup.kind === 'ok') expect(backup.snapshot).toEqual(s);
  });

  test.each([{ reworkId: 'missing' }, { registerEventId: 'rework' }, { action: 'unknown' }, { unknownField: 'cannot lose' }, { reason: '' }])('6.3: 不正な部品記録%jを拒否し原保存を保持', change => {
    const s = initial(recovered(), emptySupply);
    const text = JSON.stringify({ ...s, ledger: { ...s.ledger, history: s.ledger.history.map(e => e.kind === 'reworkPart' ? { ...e, ...change } : e) } });
    expect(() => parse(text)).toThrow();
    const store = storeOf(); store.data.set('fuzzy-stock/head', 'A'); store.data.set('fuzzy-stock/slot-A', text);
    const before = [...store.data];
    expect(load(store).kind).toBe('unreadable');
    expect([...store.data]).toEqual(before);
  });

  test.each([1, 2])('6.2: %d単位保存後の応答喪失・照会・再試行でも回収と交換を一回だけ反映', saved => {
    const ledger = register(base(), meta('parts'), { id: 'parts', item: 'P', unit: '個', project: { kind: 'case', id: 'A-001' }, location: 'S1' }, 'label', 10);
    const store = storeOf(), current = replace(store, null, { ledger, supply: emptySupply });
    const first = { ledger: recovered(ledger), supply: emptySupply };
    const second = { ledger: recordReworkPart(first.ledger, meta('replacement'), { action: 'replace', reworkId: 'rework', subjectLotId: 'repair', lotId: 'parts', value: 2, reason: '交換' }), supply: emptySupply };
    const write = store.setItem; let heads = 0;
    store.setItem = (key, value) => { write(key, value); if (key === 'fuzzy-stock/head' && ++heads === saved) throw Error('見出し書込後に応答喪失'); };
    const result = commit(store, current, { opId: 'op1', opLabel: '部品処置', fingerprint: 'fictional', values: { 処置: '回収と交換' }, actor: meta('op1').actor, startedAt: at, savingSince: at }, [{ conflictReviews: [], ...first, targets: targetsOf(current, first) }, { conflictReviews: [], ...second, targets: targetsOf(first, second) }]);
    expect(result.kind).toBe('unknown');
    if (result.kind !== 'unknown') throw Error('保存結果不明が必要');
    store.setItem = write;
    const wire: unknown = JSON.parse(store.getItem('fuzzy-stock/pending') ?? 'null');
    const pending = decodePending(wire), checked = inquire(store, pending);
    expect(checked.savedUnits).toBe(saved);
    expect(retry(store, checked.snapshot, pending, meta('retry').actor, at).kind).toBe(saved === 1 ? 'saved' : 'recovered');
    const loaded = load(store);
    expect(loaded.kind).toBe('ok');
    if (loaded.kind === 'ok') {
      expect(loaded.snapshot.ledger).toEqual(second.ledger);
      expect(loaded.snapshot.ledger.lots['parts']?.quantity).toMatchObject({ numeric: { value: 8 } });
      expect(loaded.snapshot.ledger.lots['recovered']?.quantity).toMatchObject({ numeric: { value: 2 } });
    }
  });

  test('6.3: 回収品が欠落した記録は読込も復元も拒否し原保存を保持する', () => {
    const s = initial(recovered(), emptySupply);
    const { recovered: missing, ...lots } = s.ledger.lots;
    expect(missing).toBeDefined();
    const broken = { ...s, ledger: { ...s.ledger, lots } };
    const text = serialize(broken);
    expect(() => parse(text)).toThrow();
    expect(readBackup(new TextEncoder().encode(backupTextOf(broken, at))).kind).not.toBe('ok');
    const store = storeOf(); store.data.set('fuzzy-stock/head', 'A'); store.data.set('fuzzy-stock/slot-A', text);
    const before = [...store.data];
    expect(load(store).kind).toBe('unreadable');
    expect([...store.data]).toEqual(before);
  });

  test('5.1〜5.2: 履歴と出力からやり直し・修理元と部品処置を読める', () => {
    const ledger = recovered();
    const rework = ledger.history.find(e => e.kind === 'rework'), recovery = ledger.history.find(e => e.kind === 'reworkPart');
    if (!rework || !recovery) throw Error('fixture');
    expect(eventText(ledger, rework)).toContain('finished');
    expect(eventText(ledger, recovery)).toContain('回収');
    expect(eventText(ledger, recovery)).toContain('recovered');
    const sheets = viewSheetsOf({ ledger, supply: emptySupply }, at);
    const production = sheets.find(sheet => sheet.name === '工程集計');
    expect(production?.columns.map(column => column.header)).toContain('やり直し・修理開始累計');
    expect(production?.rows[0]?.[8]).toBe('2台・中身未確認');
    const text = JSON.stringify(sheets);
    expect(text).toContain('やり直し・修理');
    expect(text).toContain('元の作業の開始材料と別');
  });

  test('6.3: 親を減らさず子を作ったやり直し・修理記録を拒否する', () => {
    const l = base(), e = l.history.find(e => e.kind === 'rework');
    const parent = e?.changes.find(c => c.after.id === 'finished');
    if (!e || !parent?.before) throw Error('fixture');
    const inflated = { ...parent.after, quantity: parent.before.quantity };
    const ledger = { ...l, lots: { ...l.lots, finished: inflated }, history: l.history.map(h => h.eventId === e.eventId ? { ...h, changes: h.changes.map(c => c === parent ? { ...c, after: inflated } : c) } : h) };
    expect(() => parse(serialize(initial(ledger, emptySupply)))).toThrow();
  });

  test('対象枝4.1・4.5: 対象枝を往復し、履歴・枝ごとの記録・保存結果不明の影響対象に示す', () => {
    const s = initial(recovered(), emptySupply);
    const loaded = parse(serialize(s));
    const part = loaded.ledger.history.find(e => e.kind === 'reworkPart');
    expect(part).toMatchObject({ subjectLotId: 'repair' });
    if (!part) throw Error('fixture');
    expect(eventText(loaded.ledger, part)).toContain('対象枝repair');
    expect(eventsOf(loaded.ledger, 'repair').map(e => e.eventId)).toContain('recover');
    expect(targetsOf({ ledger: base(), supply: emptySupply }, { ledger: recovered(), supply: emptySupply })).toContain('まとまりrepair');
  });

  test('対象枝4.2: 対象枝のない旧記録はそのまま読み、旧記録と示す', () => {
    const s = initial(recovered(), emptySupply);
    const legacy = { ...s, ledger: { ...s.ledger, history: s.ledger.history.map(e => {
      if (e.kind !== 'reworkPart') return e;
      const { subjectLotId: _, ...rest } = e;
      return rest;
    }) } };
    const loaded = parse(JSON.stringify(legacy));
    const part = loaded.ledger.history.find(e => e.kind === 'reworkPart');
    expect(part && 'subjectLotId' in part).toBe(false);
    if (!part) throw Error('fixture');
    expect(eventText(loaded.ledger, part)).toContain('旧記録');
  });

  test.each([{ subjectLotId: 'finished' }, { subjectLotId: '' }, { subjectLotId: 'absent' }])('対象枝4.1: 読込時も対象枝%jを照合して拒否し、原保存を保持', change => {
    const s = initial(recovered(), emptySupply);
    const text = JSON.stringify({ ...s, ledger: { ...s.ledger, history: s.ledger.history.map(e => e.kind === 'reworkPart' ? { ...e, ...change } : e) } });
    expect(() => parse(text)).toThrow();
    const store = storeOf(); store.data.set('fuzzy-stock/head', 'A'); store.data.set('fuzzy-stock/slot-A', text);
    const before = [...store.data];
    expect(load(store).kind).toBe('unreadable');
    expect([...store.data]).toEqual(before);
  });

  test('3.3/6.3: 別案件・用途の使用記録への付け替えを拒否する', () => {
    let l = register(base(), meta('foreign'), { id: 'foreign', item: 'P', unit: '個', project: { kind: 'case', id: 'A-002' }, location: 'S1' }, 'label', 10);
    l = use(l, meta('foreign-use'), 'foreign', 'counted', 2, '別案件・用途の使用');
    const ledger: Ledger = { ...l, history: [...l.history, { ...meta('invalid'), ...legacyEventLabels, kind: 'reworkPart', action: 'replace', reworkId: 'rework', reason: '不正な対応', useEventId: 'foreign-use', changes: [] }] };
    expect(() => parse(serialize(initial(ledger, emptySupply)))).toThrow();
  });
});
