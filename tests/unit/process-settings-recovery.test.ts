import { afterEach, describe, expect, test } from 'vitest';
import { changeMasters, emptyLedger, practiceLedger, recordStop, register, start, use, type Ledger, type MasterRequest } from '../../src/domain/ledger.ts';
import { withProcesses } from './process-fixture.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { commit, faults, initial, inquire, load, parse, replace, retry, serialize, type StoreLike, type UnitState } from '../../src/ui/storage.ts';
import { decodePending } from '../../src/ui/storageparse.ts';
import { backupTextOf, readBackup } from '../../src/ui/backup.ts';

class Memory implements StoreLike {
  readonly data = new Map<string, string>();
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { this.data.set(key, value); }
  removeItem(key: string): void { this.data.delete(key); }
}
const at = '2026-10-27T09:00:00+09:00';
const meta = (eventId: string) => ({ eventId, occurredAt: at, recordedAt: at, actor: '架空担当A' });
const changed = (l: Ledger, eventId: string, request: MasterRequest) => changeMasters(l, meta(eventId), request);
const operation = { opId: 'op40', opLabel: '架空の工程の設定', fingerprint: '工程の設定の原文', values: { name: '塗装' }, actor: '架空担当A', startedAt: at, savingSince: at };
const unit = (ledger: Ledger): UnitState => ({ ledger, supply: emptySupply, conflictReviews: [], targets: ['工程塗装'] });

function setup() {
  const store = new Memory();
  const current = replace(store, null, initial(practiceLedger, emptySupply));
  const registered = changed(current.ledger, 'op40a', { action: 'register', master: { type: 'process', name: '塗装', criterion: 'workEnd' } });
  const designated = changed(registered, 'op40b', { action: 'nextProcess', id: 'S2', reason: '次工程の棚' });
  return { store, current, units: [unit(registered), unit(designated)] };
}

function settled(): Ledger {
  let l = changed(practiceLedger, 'a', { action: 'register', master: { type: 'process', name: '塗装', criterion: 'workEnd' } });
  l = changed(l, 'b', { action: 'rename', type: 'process', id: '塗装', name: '塗装ライン', reason: '呼び方' });
  l = changed(l, 'c', { action: 'criterion', id: '塗装', criterion: 'inspection', reason: '確認を入れる' });
  l = changed(l, 'd', { action: 'deactivate', type: 'process', id: '塗装', reason: '休止' });
  return changed(l, 'e', { action: 'nextProcess', id: 'S2', reason: '次工程の棚' });
}

afterEach(() => { faults.failMidwayAt = null; faults.loseResponseAt = null; });

describe('工程の設定 2.3・6.2・6.4・6.5: 保存途中と復元', () => {
  test('工程と次工程の変更履歴は写し・バックアップ・再読込で同じに戻る', () => {
    const s = initial(settled(), emptySupply);
    expect(parse(serialize(s))).toEqual(s);
    const backup = readBackup(new TextEncoder().encode(backupTextOf(s, at)));
    expect(backup).toMatchObject({ kind: 'ok', snapshot: s });
  });

  test('現在だけ・履歴だけの工程や指定の改変は拒否する', () => {
    const wire = () => JSON.parse(serialize(initial(settled(), emptySupply)));
    const currentOnly = wire(); currentOnly.ledger.masters.processes['塗装'].name = '改変';
    expect(() => parse(JSON.stringify(currentOnly))).toThrow('現在の工程 塗装 が最後の変更履歴と一致しない');
    const historyOnly = wire(); historyOnly.ledger.history[1].masters[0].after.name = '改変';
    expect(() => parse(JSON.stringify(historyOnly))).toThrow('塗装');
    const flagOnly = wire(); flagOnly.ledger.masters.locations.S2.nextProcess = false; flagOnly.ledger.masters.locations.N.nextProcess = true;
    expect(() => parse(JSON.stringify(flagOnly))).toThrow('次工程の指定が最後の変更履歴と一致しない');
  });

  test('登録の操作を経ない工程は、記録から補った値か練習の初期値と一致しなければ拒否する', () => {
    const wire = () => JSON.parse(serialize(initial(settled(), emptySupply)));
    const added = wire(); added.ledger.masters.processes['架空'] = { type: 'process', id: '架空', name: '改変', criterion: 'workEnd', active: true };
    expect(() => parse(JSON.stringify(added))).toThrow('工程 架空 は変更履歴がなく');
    for (const edit of [(p: Record<string, unknown>) => { p['name'] = '改変'; }, (p: Record<string, unknown>) => { p['criterion'] = 'workEnd'; }, (p: Record<string, unknown>) => { p['active'] = false; }]) {
      const practice = wire(); edit(practice.ledger.masters.processes['R組立']);
      expect(() => parse(JSON.stringify(practice))).toThrow('工程 R組立 は変更履歴がなく');
    }
    const deactivated = JSON.parse(serialize(initial(changed(practiceLedger, 'off', { action: 'deactivate', type: 'process', id: 'R組立', reason: '休止' }), emptySupply)));
    expect(parse(JSON.stringify(deactivated))?.ledger.masters.processes['R組立']?.active).toBe(false);
    deactivated.ledger.history[0].masters[0].before.name = '改変';
    expect(() => parse(JSON.stringify(deactivated))).toThrow('工程 R組立 の最初の変更前');
    const inactive = wire(); inactive.ledger.history[0].masters[0].after.active = false;
    for (const later of inactive.ledger.history.slice(1)) for (const pair of later.masters) if (pair.after.id === '塗装') { if (pair.before) pair.before.active = false; pair.after.active = false; }
    inactive.ledger.masters.processes['塗装'].active = false;
    expect(() => parse(JSON.stringify(inactive))).toThrow('利用停止のまま登録できない');
  });

  test('次工程の指定は、登録で付かず、変更前後が同じ場所を指し、途中でも一か所までに限る', () => {
    const registered = changed(practiceLedger, 'loc', { action: 'register', master: { type: 'location', code: 'L9', name: '架空の棚', trial: true, inScope: true } });
    const flagged = JSON.parse(serialize(initial(registered, emptySupply)));
    flagged.ledger.history[0].masters[0].after.nextProcess = true;
    flagged.ledger.masters.locations.L9.nextProcess = true; flagged.ledger.masters.locations.N.nextProcess = false;
    expect(() => parse(JSON.stringify(flagged))).toThrow('場所 L9 は次工程の場所として登録できない');

    // v1.2.0の空の台帳で品番・コード「N」の場所を登録すると、版11では登録の写しから次工程として読む。
    const blank = changed(emptyLedger, 'n', { action: 'register', master: { type: 'location', code: 'N', name: '架空の次工程', trial: true, inScope: true } });
    const legacyN = JSON.stringify({ ...JSON.parse(serialize(initial(blank, emptySupply))), version: 11 }, (k, v: unknown) => k === 'processes' || k === 'nextProcess' ? undefined : v);
    expect(parse(legacyN)?.ledger.masters.locations.N?.nextProcess).toBe(true);

    const swapped = JSON.parse(serialize(initial(settled(), emptySupply)));
    const designate = swapped.ledger.history.find((e: { eventId: string }) => e.eventId === 'e');
    designate.masters[0].before = { ...designate.masters[1].before };
    expect(() => parse(JSON.stringify(swapped))).toThrow('場所の変更前と変更後が同じ場所を指さない');

    let l = changed(practiceLedger, 'd1', { action: 'nextProcess', id: 'S2', reason: '棚へ' });
    l = changed(l, 'd2', { action: 'nextProcess', id: null, reason: '解除' });
    l = changed(l, 'd3', { action: 'nextProcess', id: 'S1', reason: '別の棚へ' });
    expect(parse(serialize(initial(l, emptySupply)))?.ledger.masters.locations.S1?.nextProcess).toBe(true);
    const twice = JSON.parse(serialize(initial(l, emptySupply)));
    const [first, second] = twice.ledger.history;
    const n = first.masters.findIndex((pair: { after: { id: string } }) => pair.after.id === 'N');
    second.masters.push(...first.masters.splice(n, 1));
    expect(() => parse(JSON.stringify(twice))).toThrow('次工程の場所は一か所まで');
  });

  test.each(['partial', 'unknown'] as const)('%sでも設定と元入力を保ち、再試行で履歴が一度だけ残る', mode => {
    const { store, current, units } = setup();
    if (mode === 'partial') faults.failMidwayAt = 2; else faults.loseResponseAt = 1;
    expect(commit(store, current, operation, units).kind).toBe(mode);
    const loaded = load(store);
    if (loaded.kind !== 'ok' || loaded.pending === null) throw new Error('保存途中を読めない');
    expect(loaded.pending).toMatchObject(operation);
    const done = retry(store, loaded.snapshot, loaded.pending, '架空担当A', at);
    if (done.kind !== 'saved' && done.kind !== 'recovered') throw new Error(`再試行に失敗: ${done.kind}`);
    expect(done.snapshot.ledger.history.map(event => event.eventId)).toEqual(['op40a', 'op40b']);
    expect(done.snapshot.ledger.masters.processes['塗装']?.criterion).toBe('workEnd');
    expect(done.snapshot.ledger.masters.locations.S2?.nextProcess).toBe(true);
    retry(store, done.snapshot, loaded.pending, '架空担当A', at);
    const again = load(store);
    if (again.kind !== 'ok') throw new Error('再読込できない');
    expect(again.snapshot.ledger.history.map(event => event.eventId)).toEqual(['op40a', 'op40b']);
  });

  test.each(['partial', 'unknown'] as const)('版11の保存途中で記録に初めて現れた工程も、更新後に照会・再試行できる（%s）', mode => {
    const store = new Memory();
    const current = replace(store, null, initial(practiceLedger, emptySupply));
    const renamed = changed(current.ledger, 'm1', { action: 'rename', type: 'location', id: 'T', name: '作業台T2', reason: '名前' });
    const started = start(renamed, meta('s1'), { id: 'W1', item: 'R', unit: '台', project: { kind: 'case', id: 'A-001' }, location: 'T' }, { id: 'R組立', criterion: 'inspection' }, 'counted', 1, []);
    if (mode === 'partial') faults.failMidwayAt = 2; else faults.loseResponseAt = 1;
    expect(commit(store, current, operation, [unit(renamed), unit(started)]).kind).toBe(mode);
    faults.failMidwayAt = null; faults.loseResponseAt = null;
    // 版11のwriterが書いた形へ戻す。
    for (const [key, text] of store.data) if (text.startsWith('{')) {
      const value = JSON.parse(text);
      if (value.version === 12) store.data.set(key, JSON.stringify({ ...value, version: 11 }, (k, v: unknown) => k === 'processes' || k === 'nextProcess' ? undefined : v));
    }
    const loaded = load(store);
    if (loaded.kind !== 'ok' || loaded.pending === null) throw new Error('旧版の保存途中を読めない');
    expect(inquire(store, loaded.pending).savedUnits).toBe(mode === 'partial' ? 1 : 2);
    const done = retry(store, loaded.snapshot, loaded.pending, '架空担当A', at);
    expect(done.kind).toBe(mode === 'partial' ? 'saved' : 'recovered');
    if (done.kind !== 'saved' && done.kind !== 'recovered') throw new Error('再試行に失敗');
    expect(done.snapshot.ledger.masters.processes['R組立']).toMatchObject({ name: 'R組立', criterion: 'inspection', active: true });
  });

  test('版11で同じ工程IDに別の完了基準がある台帳でも、保存途中の材料使用と着手を再試行できる（保管単位のIDの並びに依らない）', () => {
    const store = new Memory();
    // 旧形の手直しでできた食い違いを、別IDの工程で作ってから版11の原文で同じIDへ書き換える。
    let l = withProcesses(practiceLedger, { id: '架空工程', criterion: 'workEnd' }, { id: '架空工程B', criterion: 'inspection' });
    l = register(l, meta('r30'), { id: '30', item: 'R', unit: '台', project: { kind: 'case', id: 'A-001' }, location: 'T', stage: { kind: 'working', process: { id: '架空工程', criterion: 'workEnd' } } }, 'counted', 1);
    l = register(l, meta('r20'), { id: '20', item: 'R', unit: '台', project: { kind: 'case', id: 'A-001' }, location: 'T', stage: { kind: 'working', process: { id: '架空工程B', criterion: 'inspection' } } }, 'counted', 1);
    l = register(l, meta('rp'), { id: 'P1', item: 'P', unit: '個', project: { kind: 'case', id: 'A-001' }, location: 'S1' }, 'counted', 10);
    const current = replace(store, null, initial(l, emptySupply));
    const used = use(current.ledger, meta('u1'), 'P1', 'counted', 2, '1の着手（工程架空工程）', 'notIncluded');
    const started = start(used, meta('s1'), { id: '1', item: 'R', unit: '台', project: { kind: 'case', id: 'A-001' }, location: 'T' }, { id: '架空工程', criterion: 'workEnd' }, 'counted', 1, ['u1']);
    faults.failMidwayAt = 2;
    expect(commit(store, current, operation, [unit(used), unit(started)]).kind).toBe('partial');
    faults.failMidwayAt = null;
    for (const [key, text] of store.data) if (text.startsWith('{')) {
      const value = JSON.parse(text);
      if (value.version === 12) store.data.set(key, JSON.stringify({ ...value, version: 11 }, (k, v: unknown) => k === 'processes' || k === 'nextProcess' ? undefined : v).replaceAll('架空工程B', '架空工程'));
    }
    const loaded = load(store);
    if (loaded.kind !== 'ok' || loaded.pending === null) throw new Error('旧版の保存途中を読めない');
    expect(loaded.snapshot.ledger.masters.processes['架空工程']?.criterion).toBe('workEnd');
    const done = retry(store, loaded.snapshot, loaded.pending, '架空担当A', at);
    expect(done.kind).toBe('saved');
    if (done.kind !== 'saved') throw new Error('再試行に失敗');
    expect(done.snapshot.ledger.lots['20']?.stage).toEqual({ kind: 'working', process: { id: '架空工程', criterion: 'inspection' } });
  });

  test('版11で記録に別の完了基準で現れた工程を、保存途中で初めて停止しても再試行できる（停止は記録の順で見る）', () => {
    const store = new Memory();
    // 旧形の手直しで「R組立」に作業終了の記録ができた台帳を、別IDの工程で作ってから版11の原文で同じIDへ書き換える。
    let l = withProcesses(practiceLedger, { id: '架空R', criterion: 'workEnd' });
    l = register(l, meta('r1'), { id: 'W1', item: 'R', unit: '台', project: { kind: 'case', id: 'A-001' }, location: 'T', stage: { kind: 'working', process: { id: '架空R', criterion: 'workEnd' } } }, 'counted', 1);
    const current = replace(store, null, initial(l, emptySupply));
    const renamed = changed(current.ledger, 'm1', { action: 'rename', type: 'location', id: 'T', name: '作業台T2', reason: '名前' });
    const stopped = recordStop(renamed, meta('stop'), { process: 'R組立', item: 'R', unit: '台', project: { kind: 'case', id: 'A-001' }, reason: '部品不足', shortage: null, affected: null });
    faults.failMidwayAt = 2;
    expect(commit(store, current, operation, [unit(renamed), unit(stopped)]).kind).toBe('partial');
    faults.failMidwayAt = null;
    for (const [key, text] of store.data) if (text.startsWith('{')) {
      const value = JSON.parse(text);
      if (value.version === 12) store.data.set(key, JSON.stringify({ ...value, version: 11 }, (k, v: unknown) => k === 'processes' || k === 'nextProcess' ? undefined : v).replaceAll('架空R', 'R組立'));
    }
    const loaded = load(store);
    if (loaded.kind !== 'ok' || loaded.pending === null) throw new Error('旧版の保存途中を読めない');
    expect(loaded.snapshot.ledger.masters.processes['R組立']?.criterion).toBe('workEnd');
    const done = retry(store, loaded.snapshot, loaded.pending, '架空担当A', at);
    expect(done.kind).toBe('saved');
    if (done.kind !== 'saved') throw new Error('再試行に失敗');
    expect(done.snapshot.ledger.masters.processes['R組立']?.criterion).toBe('workEnd');
    expect(done.snapshot.ledger.stops['stop']?.process).toBe('R組立');
  });

  test('未登録の工程では停止を記録しない', () => {
    expect(() => recordStop(practiceLedger, meta('stop'), { process: '未登録', item: 'R', unit: '台', project: { kind: 'common' }, reason: '架空', shortage: null, affected: null })).toThrow('工程 未登録 は登録されていない');
  });

  test('保存途中の中間unitだけの工程や指定の改変は拒否する', () => {
    const { store, current, units } = setup();
    faults.failMidwayAt = 2;
    expect(commit(store, current, operation, units).kind).toBe('partial');
    const raw = JSON.parse(store.getItem('fuzzy-stock/pending')!);
    raw.pending.units[0].ledger.masters.processes['塗装'].criterion = 'inspection';
    expect(() => decodePending(raw)).toThrow();
    const flag = JSON.parse(store.getItem('fuzzy-stock/pending')!);
    flag.pending.units[0].ledger.masters.locations.T.nextProcess = true;
    expect(() => decodePending(flag)).toThrow();
  });
});
