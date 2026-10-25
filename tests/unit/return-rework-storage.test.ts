import { afterEach, describe, expect, test } from 'vitest';
import { adoptProvisional, assignProject, beginReturnedRework, beginRework, changeMasters, changeStage, practiceLedger, hold, merge, move, productionOf, recordProvisional, register, split, type Meta, type Process } from '../../src/domain/ledger.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { requireQuantityTotals } from '../../src/domain/shortage.ts';
import { backupTextOf, readBackup } from '../../src/ui/backup.ts';
import { decodePending, decodeSnapshot } from '../../src/ui/storageparse.ts';
import { commit, faults, initial, inquire, load, parse, replace, retry, serialize, targetsOf, type Snapshot, type StoreLike } from '../../src/ui/storage.ts';
import { eventText } from '../../src/ui/format.ts';
import { viewSheetsOf } from '../../src/ui/viewsheets.ts';

const at = '2026-10-21T14:00:00+09:00';
const meta = (eventId: string): Meta => ({ eventId, occurredAt: at, recordedAt: at, actor: '架空担当A' });
const process = { id: '戻り工程', criterion: 'workEnd' } satisfies Process;
const request = { lotId: 'returned', adoptEventId: 'assign', childId: 'repair', basis: 'label', value: 2, process, reason: '物理的な手直し', confirmedPhysical: true } as const;
function adopted(value = 2, custom = false) {
  let l = custom ? changeMasters(practiceLedger, meta('master'), { action: 'register', master: { type: 'item', code: 'D', name: '架空小数物品', units: ['kg'], unitSteps: { kg: 0.1 }, trial: true, source: null } }) : practiceLedger;
  const item = custom ? 'D' : 'R', unit = custom ? 'kg' : '台';
  l = recordProvisional(l, meta('found'), { direction: 'found', item, location: 'T', basis: 'label', value, note: '戻りの現物' });
  return adoptProvisional(l, meta('assign'), 'found', { id: 'returned', item, unit, project: { kind: 'case', id: 'A-001' }, location: 'T' }, true);
}
const begun = () => beginReturnedRework(adopted(), meta('repair-start'), request);
const pendingOf = (s: Snapshot) => ({ format: 'fuzzy-stock-pending', version: 9, pending: { progress: 'saving', unknownSince: null, savingSince: at, baseRevision: 0, opId: 'op1', opLabel: '戻り手直し', fingerprint: 'f', values: {}, actor: '架空担当A', startedAt: at, units: [{ ledger: s.ledger, supply: s.supply, targets: [], conflictReviews: [] }] } });
const storeOf = () => {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } } satisfies StoreLike & { data: Map<string, string> };
};
afterEach(() => { faults.loseResponseAt = faults.failMidwayAt = null; });

describe('FH-RRS-04 戻り開始の保存と証拠', () => {
  test.each(['finished', 'repair'])('旧形の%sの生成記録へ完了基準の追加照合を遡及しない', lotId => {
    const finished = register(practiceLedger, meta('register'), { id: 'finished', item: 'R', unit: '台', project: { kind: 'case', id: 'A-001' }, location: 'T', stage: { kind: 'awaitingHandover', process } }, 'label', 2);
    let s = structuredClone(parse(serialize(initial(beginRework(finished, meta('legacy'), 'finished', 'repair', 'label', 1, '従来のやり直し・修理'), emptySupply))));
    const event = s.ledger.history.find(e => e.kind === 'rework');
    const change = event?.changes.find(c => c.after.id === lotId);
    if (!change || change.after.stage.kind === 'none') throw Error('fixture');
    change.after.stage.process.criterion = 'inspection';
    s = { ...s, ledger: { ...s.ledger, lots: { ...s.ledger.lots, [lotId]: change.after } } };
    const parent = event?.changes.find(c => c.after.id === 'finished');
    expect(parent?.before?.stage).toMatchObject({ process: { criterion: 'workEnd' } });
    const text = serialize(s);
    expect(parse(text)).toEqual(s);
    expect(decodePending(pendingOf(s)).units[0]?.ledger).toEqual(s.ledger);
    expect(readBackup(new TextEncoder().encode(backupTextOf(s, at)))).toMatchObject({ kind: 'ok', snapshot: s });
    const store = storeOf(); store.data.set('fuzzy-stock/head', 'A'); store.data.set('fuzzy-stock/slot-A', text);
    const before = [...store.data];
    expect(load(store)).toMatchObject({ kind: 'ok', snapshot: s });
    expect([...store.data]).toEqual(before);
  });
  test.each(['子の生成記録と現在値', '由来の選択基準'])('新形の%sだけを変えた完了基準不一致は引き続き拒否する', damage => {
    let s = structuredClone(parse(serialize(initial(begun(), emptySupply))));
    const event = s.ledger.history.find(e => e.kind === 'rework');
    const child = event?.changes.find(c => c.after.id === 'repair');
    if (!event?.returnSource || !child || child.after.stage.kind !== 'working') throw Error('fixture');
    if (damage === '子の生成記録と現在値') {
      child.after.stage.process.criterion = 'inspection';
      s = { ...s, ledger: { ...s.ledger, lots: { ...s.ledger.lots, repair: child.after } } };
    } else event.returnSource.process.criterion = 'inspection';
    expect(() => decodeSnapshot(s)).toThrow(/やり直し・修理子/);
    expect(() => decodePending(pendingOf(s))).toThrow(/やり直し・修理子/);
    expect(readBackup(new TextEncoder().encode(backupTextOf(s, at))).kind).toBe('unreadable');
    const store = storeOf(); store.data.set('fuzzy-stock/head', 'A'); store.data.set('fuzzy-stock/slot-A', serialize(s));
    const before = [...store.data];
    expect(load(store).kind).toBe('unreadable');
    expect([...store.data]).toEqual(before);
  });
  test('snapshot/pending/backupの往復、由来・工程行・累計を出力する', () => {
    const s = initial(begun(), emptySupply);
    expect(parse(serialize(s))).toEqual(s);
    expect(decodePending(pendingOf(s)).units[0]?.ledger).toEqual(s.ledger);
    expect(readBackup(new TextEncoder().encode(backupTextOf(s, at)))).toMatchObject({ kind: 'ok', snapshot: s });
    const event = s.ledger.history.at(-1)!;
    expect(eventText(s.ledger, event)).toContain('新規割当の記録assign');
    expect(eventText(s.ledger, event)).toContain('工程戻り工程・作業終了基準');
    const sheets = viewSheetsOf(s, at);
    expect(sheets.find(sheet => sheet.name === '工程集計')?.rows[0]?.[8]).toContain('2台');
    expect(JSON.stringify(sheets.find(sheet => sheet.name === '台帳の履歴'))).toContain('物理的なやり直し・修理を確認');
    expect(targetsOf({ ledger: adopted(), supply: emptySupply }, s)).toEqual(expect.arrayContaining(['まとまりreturned', 'まとまりrepair', '操作assign', '照合事項found']));
  });
  test.each([
    ['欄削除', 'remove'], ['確認なし', 'confirm'], ['余分な欄', 'extra'], ['割当種別', 'kind'], ['別の元', 'lot'],
    ['親数量', 'parentQuantity'], ['子の工程', 'process'], ['子の完了基準', 'criterion'], ['子の取り分けた理由', 'holds'], ['仮の記録の種別', 'origin'], ['解消参照', 'resolution'],
  ])('%sの改変をsnapshot/pending/backupで拒否し、原保存を保持する', (_name, damage) => {
    const s = initial(begun(), emptySupply);
    const broken = structuredClone(s);
    const event = broken.ledger.history.find(e => e.kind === 'rework');
    if (event?.kind !== 'rework' || !event.returnSource) throw Error('fixture');
    const child = event.changes.find(c => c.after.id === 'repair')!, parent = event.changes.find(c => c.after.id === 'returned')!;
    if (damage === 'remove') delete event.returnSource;
    else if (damage === 'confirm') Object.assign(event.returnSource, { confirmedPhysical: false });
    else if (damage === 'extra') Object.assign(event.returnSource, { extra: true });
    else if (damage === 'kind') event.returnSource.adoptEventId = 'found';
    else if (damage === 'lot') event.lotId = 'repair';
    else if (damage === 'parentQuantity' && parent.after.quantity.kind === 'known') parent.after.quantity.numeric.value = 1;
    else if ((damage === 'process' || damage === 'criterion') && child.after.stage.kind !== 'none') child.after.stage.process = { id: damage === 'process' ? '偽工程' : process.id, criterion: damage === 'criterion' ? 'inspection' : process.criterion };
    else if (damage === 'holds') child.after = { ...child.after, holds: ['defective'] };
    else if (damage === 'origin') { const origin = broken.ledger.history.find(e => e.kind === 'provisional'); if (origin?.kind === 'provisional') origin.direction = 'removed'; }
    else if (damage === 'resolution') broken.ledger.issues['found']!.resolution!.eventId = 'other';
    expect(() => decodeSnapshot(broken)).toThrow();
    expect(() => decodePending(pendingOf(broken))).toThrow();
    expect(readBackup(new TextEncoder().encode(backupTextOf(broken, at))).kind).toBe('unreadable');
    const store = storeOf(); store.data.set('fuzzy-stock/head', 'A'); store.data.set('fuzzy-stock/slot-A', serialize(broken));
    const bytes = [...store.data]; expect(load(store).kind).toBe('unreadable'); expect([...store.data]).toEqual(bytes);
  });
  test('応答喪失後に照会・再試行しても親子を二重反映しない', () => {
    const before = { ledger: adopted(), supply: emptySupply }, after = { ledger: begun(), supply: emptySupply };
    const store = storeOf(), current = replace(store, null, before);
    faults.loseResponseAt = 1;
    const result = commit(store, current, { opId: 'op1', opLabel: '戻り手直し', fingerprint: 'f', values: {}, actor: '架空担当A', startedAt: at, savingSince: at }, [{ ...after, targets: targetsOf(before, after), conflictReviews: [] }]);
    expect(result.kind).toBe('unknown');
    if (result.kind !== 'unknown') throw Error('故障注入なし');
    const pending = decodePending(JSON.parse(store.getItem('fuzzy-stock/pending') ?? 'null'));
    const checked = inquire(store, pending);
    expect(checked.savedUnits).toBe(1);
    expect(retry(store, checked.snapshot, pending, '架空担当A', at).kind).toBe('recovered');
    const loaded = load(store); expect(loaded.kind).toBe('ok');
    if (loaded.kind === 'ok') expect(loaded.snapshot.ledger).toEqual(after.ledger);
  });
  test.each(['工程', '完了基準', '所属', '分割元', '品目と単位', '親の工程'])('現在値だけの%s改変をsnapshot/pending/backupで拒否する', damage => {
    const s = initial(begun(), emptySupply);
    const current = s.ledger.lots[damage === '親の工程' ? 'returned' : 'repair']!;
    let after = current;
    switch (damage) {
      case '工程': after = { ...current, stage: { kind: 'working', process: { id: '偽工程', criterion: 'workEnd' } } }; break;
      case '完了基準': after = { ...current, stage: { kind: 'working', process: { ...process, criterion: 'inspection' } } }; break;
      case '所属': after = { ...current, project: { kind: 'common' } }; break;
      case '分割元': after = { ...current, splitFrom: null }; break;
      case '品目と単位': after = { ...current, item: 'P', unit: '個' }; break;
      case '親の工程': after = { ...current, stage: { kind: 'working', process } }; break;
    }
    const broken = { ...s, ledger: { ...s.ledger, lots: { ...s.ledger.lots, [current.id]: after } } };
    expect(() => decodeSnapshot(broken)).toThrow();
    expect(() => decodePending(pendingOf(broken))).toThrow();
    expect(readBackup(new TextEncoder().encode(backupTextOf(broken, at))).kind).toBe('unreadable');
  });
  test('開始前の移動と開始後の統合は読み、混在後の新しい開始は拒否する', () => {
    let l = move(adopted(), meta('before-move'), 'returned', 'S1');
    l = beginReturnedRework(l, meta('repair-start'), { ...request, value: 1 });
    l = register(l, meta('other'), { id: 'other', item: 'R', unit: '台', project: { kind: 'case', id: 'A-001' }, location: 'S1' }, 'label', 1);
    l = merge(l, meta('after-merge'), 'other', 'returned');
    const s = initial(l, emptySupply);
    expect(parse(serialize(s))).toEqual(s);
    expect(decodePending(pendingOf(s)).units[0]?.ledger).toEqual(l);
    expect(productionOf(l, process.id, 'R', '台', { kind: 'case', id: 'A-001' }).reworkStarted).toMatchObject({ numeric: { value: 1 } });
    expect(() => beginReturnedRework(l, meta('mixed'), { ...request, childId: 'mixed', value: 1 })).toThrow(/統合/);
  });
  test('開始後の場所・取り分けた理由・数量の変更と、開始前の所属判明・後のコード変更を保持する', () => {
    let l = recordProvisional(practiceLedger, meta('found'), { direction: 'found', item: 'R', location: 'T', basis: 'label', value: 2, note: '所属未確認の戻り' });
    l = adoptProvisional(l, meta('assign'), 'found', { id: 'returned', item: 'R', unit: '台', project: { kind: 'unassigned' }, location: 'T' }, true);
    l = assignProject(l, meta('project'), 'returned', { kind: 'case', id: 'A-001' }, '所属を確認', true);
    l = beginReturnedRework(l, meta('repair-start'), request);
    l = changeMasters(l, meta('code'), { action: 'code', type: 'case', id: 'A-001', code: '新しい案件コード', reason: '管理コード変更' });
    l = move(l, meta('move'), 'repair', 'S1');
    l = split(l, meta('split'), 'repair', 'part', 'label', 1);
    l = hold(l, meta('hold'), 'repair', 'defective');
    const s = initial(l, emptySupply);
    expect(parse(serialize(s))).toEqual(s);
    expect(decodePending(pendingOf(s)).units[0]?.ledger).toEqual(l);
    expect(readBackup(new TextEncoder().encode(backupTextOf(s, at)))).toMatchObject({ kind: 'ok', snapshot: s });
  });
  test('0.1単位の戻り分割は精度を保ち、不一致を拒否する', () => {
    const l = adopted(2, true);
    const s = initial(beginReturnedRework(l, meta('repair-start'), { ...request, value: 0.3 }), emptySupply);
    expect(s.ledger.lots['returned']?.quantity).toMatchObject({ numeric: { value: 1.7 } });
    expect(parse(serialize(s))).toEqual(s);
    expect(() => beginReturnedRework(l, meta('bad'), { ...request, value: 0.25 })).toThrow();
  });
  test('累計上限を保存前とsnapshot復号で拒否し、pendingは照会可能のまま保存を拒否する', () => {
    let l = beginReturnedRework(adopted(Number.MAX_SAFE_INTEGER), meta('repair-start'), { ...request, value: Number.MAX_SAFE_INTEGER });
    l = changeStage(l, meta('finish'), 'repair', 'ready', 'label', Number.MAX_SAFE_INTEGER, { kind: 'awaitingHandover', process });
    const safe = initial(l, emptySupply);
    expect(() => requireQuantityTotals(l, emptySupply)).not.toThrow();
    l = beginRework(l, meta('again'), 'ready', 'again', 'label', 1, '同工程の再やり直し・修理');
    expect(() => requireQuantityTotals(l, emptySupply)).toThrow(/やり直し・修理開始累計/);
    const over = initial(l, emptySupply);
    expect(() => parse(serialize(over))).toThrow(/やり直し・修理開始累計/);
    const pending = decodePending(pendingOf(over));
    expect(pending.units).toHaveLength(1);
    const store = storeOf(), current = replace(store, null, safe), bytes = [...store.data];
    expect(commit(store, current, { opId: 'op1', opLabel: '上限', fingerprint: 'f', values: {}, actor: '架空担当A', startedAt: at, savingSince: at }, pending.units)).toMatchObject({ kind: 'failed', reason: expect.stringContaining('やり直し・修理開始累計') });
    expect([...store.data]).toEqual(bytes);
  });
});
