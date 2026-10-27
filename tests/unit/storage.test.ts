import { legacyEventLabels } from '../fixtures/history-labels.ts';
import { beforeEach, describe, expect, test } from 'vitest';
import { add, observe, quantityOf, subtract } from '../../src/domain/quantity.ts';
import { correctOccurredAt, declareDiscrepancy, deepFreeze, practiceLedger as practiceBase, move, recount, recordProvisional, recordStop, resolveIssue, resumeWork, start, updateStop, use, voidRecord, type EventDetail, type Ledger, type Lot, type Meta, type Stop } from '../../src/domain/ledger.ts';
import { withProcesses } from './process-fixture.ts';
const practiceLedger = withProcesses(practiceBase, { id: '工程', criterion: 'inspection' }, { id: '仕上げ工程', criterion: 'workEnd' });
import { fixedMasters } from '../../src/domain/masters.ts';
import { allocateArrival, cancelRequest, confirmOrder, emptySupply, receiveLot, recordReply, recordRequest, reviseArrival, type Declaration, type Supply, type SupplyDetail } from '../../src/domain/supply.ts';
import { differenceText, eventText, quantityText } from '../../src/ui/format.ts';
import { supplyEventText } from '../../src/ui/supply-format.ts';
import { seedLedger, seedScn02 } from '../../src/ui/seed.ts';
import { abandon, attemptOf, commit, confirmedUnreadableReset, confirmSaved, faults, fingerprintOf, initial, inquire, load, nextOpIdOf, parse, replace, retry, sameSnapshot, serialize, targetsOf, unknownSinceOf, type Pending, type Snapshot, type StoreLike, type UnitState } from '../../src/ui/storage.ts';

const at = '2026-10-05T10:00:00+09:00';
const later = '2026-10-05T11:00:00+09:00';
const meta = (eventId: string): Meta => ({ eventId, occurredAt: at, recordedAt: at, actor: '架空担当A' });

class MemoryStore implements StoreLike {
  readonly data = new Map<string, string>();
  readonly writes: string[] = [];
  failOn: string | null = null;
  failGetOn: string | null = null;
  failSetAt: number | null = null;
  failAfterSetAt: number | null = null;
  failGetAfterSetAt: number | null = null;
  failRemove = false;
  failAfterRemove = false;
  setCalls = 0;
  getItem(key: string): string | null {
    if (key === this.failGetOn && (this.failGetAfterSetAt === null || this.setCalls >= this.failGetAfterSetAt)) throw new Error('保存先を読めない');
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.writes.push(key);
    this.setCalls++;
    if (key === this.failOn || this.setCalls === this.failSetAt) throw new Error('保存容量不足');
    this.data.set(key, value);
    if (this.setCalls === this.failAfterSetAt) throw new Error('書込後の応答を受け取れない');
  }
  removeItem(key: string): void {
    this.writes.push(key);
    if (this.failRemove) throw new Error('保存中の操作を消せない');
    this.data.delete(key);
    if (this.failAfterRemove) throw new Error('削除後の応答を受け取れない');
  }
}

describe('B3 5.1: 確認後の読み込み不能の初期化', () => {
  test('写しの同一性は復号で変わるキー順に依存せず、版の変化を見落とさない', () => {
    const original = initial(seedLedger(), emptySupply);
    const decoded = parse(serialize(original));
    expect(sameSnapshot(original, decoded)).toBe(true);
    expect(sameSnapshot(original, { ...decoded, revision: decoded.revision + 1 })).toBe(false);
    expect(sameSnapshot(original, { ...decoded, lastWriter: 'op1' })).toBe(false);
  });
  test('確認済みの破損記録を新しい写しへ置換し、版不明なら0から始める', () => {
    const store = new MemoryStore();
    store.data.set('fuzzy-stock/head', 'A');
    store.data.set('fuzzy-stock/slot-A', '壊れた値');
    const next = confirmedUnreadableReset(store, { ledger: practiceLedger, supply: emptySupply });
    expect(next.revision).toBe(0);
    expect(store.data.get('fuzzy-stock/head')).toBe('B');
    expect(load(store)).toMatchObject({ kind: 'ok', snapshot: next, pending: null });
  });
  test('pendingだけ読み込めない場合は読めるheadの版数を続ける', () => {
    const store = new MemoryStore();
    const current = replace(store, null, seedScn02());
    store.data.set('fuzzy-stock/pending', '壊れた操作');
    const next = confirmedUnreadableReset(store, { ledger: practiceLedger, supply: emptySupply });
    expect(next.revision).toBe(current.revision + 1);
    expect(load(store)).toMatchObject({ kind: 'ok', snapshot: next, pending: null });
  });
  test('読み込める記録は専用の初期化で上書きしない', () => {
    const store = new MemoryStore();
    replace(store, null, seedScn02());
    const before = [...store.data];
    expect(() => confirmedUnreadableReset(store, { ledger: practiceLedger, supply: emptySupply })).toThrow();
    expect([...store.data]).toEqual(before);
  });
  test('head前の書込失敗で既存のhead・写し・pendingを消さない', () => {
    const store = new MemoryStore();
    store.data.set('fuzzy-stock/head', 'A');
    store.data.set('fuzzy-stock/slot-A', '壊れた値');
    store.data.set('fuzzy-stock/pending', '残存する操作');
    store.failOn = 'fuzzy-stock/slot-B';
    const before = [...store.data];
    expect(() => confirmedUnreadableReset(store, { ledger: practiceLedger, supply: emptySupply })).toThrow('保存容量不足');
    expect([...store.data]).toEqual(before);
  });
  test('head確定後の応答例外は保存した写しを返し、未保存とはしない', () => {
    const store = new MemoryStore();
    store.data.set('fuzzy-stock/head', 'A');
    store.data.set('fuzzy-stock/slot-A', '壊れた値');
    const set = store.setItem.bind(store);
    store.setItem = (key, value) => {
      set(key, value);
      if (key === 'fuzzy-stock/head') throw new Error('書込後の応答を受け取れない');
    };
    const next = confirmedUnreadableReset(store, { ledger: practiceLedger, supply: emptySupply });
    expect(load(store)).toMatchObject({ kind: 'ok', snapshot: next });
  });
  test('通常の置換もhead確定後の応答例外を読み直して新しい写しを返す', () => {
    const store = new MemoryStore();
    const current = replace(store, null, seedScn02());
    store.failAfterSetAt = store.setCalls + 2;
    const next = replace(store, current, { ledger: practiceLedger, supply: emptySupply });
    expect(next.revision).toBe(current.revision + 1);
    expect(load(store)).toMatchObject({ kind: 'ok', snapshot: next });
  });
  test('headを書けなければ古い写しを保ち、先に消したpendingを元の文字列で書き戻す', () => {
    const store = new MemoryStore();
    store.data.set('fuzzy-stock/head', 'A');
    store.data.set('fuzzy-stock/slot-A', '壊れた値');
    store.data.set('fuzzy-stock/pending', '残存する操作');
    store.failOn = 'fuzzy-stock/head';
    expect(() => confirmedUnreadableReset(store, { ledger: practiceLedger, supply: emptySupply })).toThrow('保存容量不足');
    expect(store.data.get('fuzzy-stock/head')).toBe('A');
    expect(store.data.get('fuzzy-stock/slot-A')).toBe('壊れた値');
    expect(store.data.get('fuzzy-stock/pending')).toBe('残存する操作');
  });
  test('pendingが削除済みなら削除後の応答例外でも完了と返す', () => {
    const store = new MemoryStore();
    store.data.set('fuzzy-stock/head', 'A');
    store.data.set('fuzzy-stock/slot-A', '壊れた値');
    store.data.set('fuzzy-stock/pending', '残存する操作');
    store.failAfterRemove = true;
    const next = confirmedUnreadableReset(store, { ledger: practiceLedger, supply: emptySupply });
    expect(load(store)).toMatchObject({ kind: 'ok', snapshot: next, pending: null });
  });
  test('pending削除が失敗したら残存証跡を保持し、見出しを切り替えず完了と返さない', () => {
    const store = new MemoryStore();
    store.data.set('fuzzy-stock/head', 'A');
    store.data.set('fuzzy-stock/slot-A', '壊れた値');
    store.data.set('fuzzy-stock/pending', '残存する操作');
    store.failRemove = true;
    expect(() => confirmedUnreadableReset(store, { ledger: practiceLedger, supply: emptySupply })).toThrow('保存中の操作を消せない');
    expect(store.data.get('fuzzy-stock/pending')).toBe('残存する操作');
    expect(store.data.get('fuzzy-stock/head')).toBe('A');
  });
});

function populated(): { ledger: Ledger; supply: ReturnType<typeof seedScn02>['supply'] } {
  let { ledger, supply } = seedScn02();
  ledger = recount(ledger, meta('count'), 'P-B01', 98, { kind: 'unknown' });
  ledger = recordStop(ledger, meta('stop'), { process: 'R組立', item: 'R', unit: '台', project: { kind: 'case', id: 'B-001' }, reason: '部品不足', shortage: { item: 'P', unit: '個', value: 2 }, affected: null });
  ({ ledger, supply } = receiveLot(ledger, supply, meta('received'), { id: '交換品', item: 'S', unit: '箱', project: { kind: 'common' }, location: 'S1' }, 'label', 1, '0012-AB'));
  supply = allocateArrival(ledger, supply, meta('arrival'), 'sc-q1', { receiptLotId: '交換品', arrived: 1, good: 1 });
  return { ledger, supply };
}

function snapshot(): Snapshot {
  return deepFreeze({ format: 'fuzzy-stock-f0', version: 12, conflictReviews: [], revision: 4, lastWriter: 'op9', opFloor: 30,
    ...populated(), ops: { op9: { fingerprint: '入力', units: [['received'], ['arrival']] } },
    saveChecks: [{ opId: 'op8', opLabel: '受入', savedTargets: ['まとまり0012'], unsavedTargets: ['依頼op7'], attempt: '登録操作', openedAt: at, resolution: { outcome: 'remainderAbandoned', actor: '架空担当B', at: later } }],
  });
}

const pendingText = (value: unknown): string => JSON.stringify({ format: 'fuzzy-stock-pending', version: 12, pending: value });

function pending(): Pending {
  return { progress: 'saving', unknownSince: null, savingSince: later, baseRevision: 3,
    opId: 'op9', opLabel: '受入', fingerprint: '入力', values: { label: '0012-AB', flag: false }, actor: '架空担当A', startedAt: at,
    units: [{ conflictReviews: [], ...populated(), targets: ['まとまり交換品', '依頼sc-q1'] }],
  };
}

function storeOf(value = snapshot()): MemoryStore {
  const store = new MemoryStore();
  store.data.set('fuzzy-stock/head', 'A');
  store.data.set('fuzzy-stock/slot-A', JSON.stringify(value));
  return store;
}

function alter(text: string, path: (string | number)[], value: unknown): string {
  const root: unknown = JSON.parse(text);
  let target = root;
  for (const part of path.slice(0, -1)) {
    if (typeof target !== 'object' || target === null || !(part in target)) throw new Error('試験の対象がない');
    target = Reflect.get(target, part);
  }
  const key = path.at(-1);
  if (typeof target !== 'object' || target === null || key === undefined) throw new Error('試験の対象がない');
  if (value === undefined) Reflect.deleteProperty(target, key);
  else Reflect.set(target, key, value);
  return JSON.stringify(root);
}

function lot(): Lot {
  const found = seedLedger().lots['P-001'];
  if (!found) throw new Error('試験用保管単位がない');
  return found;
}
const q = quantityOf(observe('qty', 'counted', 2));
const stop: Stop = { id: 'st', process: 'R組立', item: 'R', unit: '台', project: { kind: 'case', id: 'B-001' }, reason: '不足', shortage: { item: 'P', unit: '個', value: null }, affected: null, resumedBy: null };
const details: EventDetail[] = [
  { kind: 'register' }, { kind: 'move' }, { kind: 'merge' },
  { kind: 'master', action: 'code', reason: '付け替え', confirmed: true, masters: [
    { before: fixedMasters.items.Q!, after: { ...fixedMasters.items.Q!, code: null } }, { before: fixedMasters.items.P!, after: { ...fixedMasters.items.P!, code: 'Q' } }] },
  { kind: 'identify', issueId: 'i', lotId: 'P-001', reason: '同じ箱' }, { kind: 'adopt', issueId: 'i', lotId: 'P-001' },
  { kind: 'assignProject', lotId: 'P-001', before: { kind: 'unassigned' }, after: { kind: 'case', id: 'A-001' }, reason: '伝票で判明' },
  { kind: 'transfer', lotId: 'P-001', childId: 'P-transfer', from: { kind: 'case', id: 'A-001' }, to: { kind: 'case', id: 'B-001' }, basis: 'counted', value: 1, applied: true, inclusion: null },
  { kind: 'recount', lotId: 'P-001', value: 1, compared: q, cause: { kind: 'stated', text: '架空の原因' }, difference: subtract(quantityOf(observe('one', 'counted', 1)), q), applied: true, inclusion: null, answeredFor: ['old'] },
  { kind: 'hold', reason: 'spare', note: null }, { kind: 'release', reason: 'returnPending', note: '解除' },
  { kind: 'resolve', issueId: 'i', outcome: 'close', inclusion: 'unknown', countedBy: null },
  { kind: 'correctTime', targetEventId: 'old', previous: null, corrected: at }, { kind: 'declare', lotId: 'P-001', note: '差異' },
  { kind: 'provisional', direction: 'removed', item: null, location: null, basis: 'unknown', value: null, note: '未特定' },
  { kind: 'start', lotId: 'P-001', materials: ['use1'] }, { kind: 'void', targetEventId: 'use1', lotId: 'P-001', reason: '誤り', applied: false },
  { kind: 'stop', stop }, { kind: 'stopUpdate', stopId: 'st', previous: null, affected: 2 }, { kind: 'resume', stopId: 'st' },
  { kind: 'use', lotId: 'P-001', basis: 'approximate', value: 1, usedFor: '架空作業', applied: false, inclusion: 'included' },
  { kind: 'handover', lotId: 'P-001', basis: 'label', value: 1, counterpart: 'OUT', applied: true, inclusion: 'notIncluded' },
  { kind: 'split', lotId: 'P-001', basis: 'counted', value: 1, childId: 'child', applied: true, inclusion: null },
  { kind: 'stage', lotId: 'P-001', basis: 'unknown', value: null, childId: 'child', to: { kind: 'awaitingHandover', process: { id: '仕上げ工程', criterion: 'workEnd' } }, correction: true, applied: false, inclusion: null },
];
const seed = seedScn02();
const need = Object.values(seed.supply.needs)[0];
const request = Object.values(seed.supply.requests)[0];
if (!need || !request) throw new Error('試験用供給データがない');
const declaration: Declaration = { id: 'd', project: { kind: 'unassigned' }, item: 'P', unit: '個', value: null, reason: '未確認', linked: false };
const arrival = { id: 'ar', receiptLotId: 'P-001', arrived: 3, good: 2 };
const supplyDetails: SupplyDetail[] = [
  { kind: 'needRegister', need }, { kind: 'needRevise', before: need, after: need }, { kind: 'shortageDeclare', declaration },
  { kind: 'declarationLink', declarationId: 'd', linked: true }, { kind: 'requestRecord', request }, { kind: 'orderConfirm', requestId: 'r' },
  { kind: 'replyRecord', requestId: 'r', before: { kind: 'none' }, after: { kind: 'answered', date: '2026-10-08' } },
  { kind: 'requestCancel', requestId: 'r', reason: '不要' }, { kind: 'receiptRecord', lotId: 'P-001', received: null, provisional: false, label: '0012-AB' },
  { kind: 'receiptRevise', lotId: 'P-001', before: null, after: 2, provisional: false, reason: '実数確認' },
  { kind: 'arrival', requestId: 'r', arrival }, { kind: 'arrivalRevise', requestId: 'r', before: arrival, after: { ...arrival, good: 1 } },
  { kind: 'remainder', lotId: 'P-001', level: 'nearEmpty' }, { kind: 'returnAck', handoverEventId: 'h' },
];

function requestEventFixture(detail: SupplyDetail): { ledger: Ledger; supply: Supply } | null {
  if (detail.kind === 'requestRecord') return { ledger: practiceLedger, supply: recordRequest(emptySupply, fixedMasters, meta(detail.request.id), detail.request) };
  if (!('requestId' in detail)) return null;
  const source = recordRequest(emptySupply, fixedMasters, meta('r'), {
    project: { kind: 'common' }, item: 'P', unit: '個', quantity: 5, vendor: '架空先', requestedOn: '2026-10-05', reply: { kind: 'none' },
  });
  switch (detail.kind) {
    case 'orderConfirm': return { ledger: practiceLedger, supply: confirmOrder(source, fixedMasters, meta('event'), detail.requestId) };
    case 'replyRecord': return { ledger: practiceLedger, supply: recordReply(source, fixedMasters, meta('event'), detail.requestId, detail.after) };
    case 'requestCancel': return { ledger: practiceLedger, supply: cancelRequest(source, fixedMasters, meta('event'), detail.requestId, detail.reason) };
    case 'arrival': case 'arrivalRevise': {
      const received = receiveLot(practiceLedger, source, meta('receipt-source'), { id: 'P-001', item: 'P', unit: '個', project: { kind: 'common' }, location: 'S1' }, 'counted', 3);
      const allocation = detail.kind === 'arrival' ? detail.arrival : detail.before;
      const arrived = allocateArrival(received.ledger, received.supply, meta(allocation.id), detail.requestId, allocation);
      return { ledger: received.ledger, supply: detail.kind === 'arrival' ? arrived
        : reviseArrival(received.ledger, arrived, meta('event'), detail.requestId, allocation.id, detail.after) };
    }
    default: {
      const exhaustive: never = detail;
      return exhaustive;
    }
  }
}

describe('Task 2.1 保存形式とローカル読み込み (AT-38/FH-B05の保存層部分)', () => {
  test('固定初期データとSCN-02操作後の写しは値と表示の文言をそのまま再現する', () => {
    for (const original of [initial(seedLedger(), emptySupply), snapshot()]) {
      const restored = parse(serialize(original));
      expect(restored).toEqual(original);
      expect(restored).not.toBe(original);
      expect(restored.ledger.history.map(e => eventText(restored.ledger, e))).toEqual(original.ledger.history.map(e => eventText(original.ledger, e)));
      expect(restored.supply.log.map((e) => supplyEventText(restored.ledger.masters, e))).toEqual(original.supply.log.map((e) => supplyEventText(original.ledger.masters, e)));
      expect(Object.values(restored.ledger.lots).map(l => quantityText(l.quantity, l.unit))).toEqual(Object.values(original.ledger.lots).map(l => quantityText(l.quantity, l.unit)));
    }
  });

  test('不明・一部不明の数量、符号付き差異と根拠の観測を失わない', () => {
    const unknown = quantityOf(observe('unknown', 'unknown', null));
    const partly = add(q, unknown);
    const diff = subtract(quantityOf(observe('one', 'counted', 1)), q);
    const original = snapshot();
    const withQuantities = { ...original, ledger: { ...original.ledger, lots: { ...original.ledger.lots, unknown: { ...lot(), id: 'unknown', quantity: unknown }, partly: { ...lot(), id: 'partly', quantity: partly }, signed: { ...lot(), id: 'signed', quantity: diff } } } };
    const restored = parse(JSON.stringify(withQuantities));
    expect(restored).toEqual(withQuantities);
    expect(Object.values(restored.ledger.lots).map(l => differenceText(l.quantity, l.unit))).toEqual(Object.values(withQuantities.ledger.lots).map(l => differenceText(l.quantity, l.unit)));
  });

  test.each(details)('台帳の履歴 $kind の全欄を読み戻す', detail => {
    const event = { ...meta('event'), ...legacyEventLabels, ...detail, changes: [{ before: null, after: lot() }, { before: lot(), after: lot() }] };
    const original = { ...snapshot(), supply: emptySupply, ledger: { ...practiceLedger, history: [event], lots: { 'P-001': lot() }, stops: { st: stop }, issues: { i: { id: 'i', lotId: null, reason: 'timeCorrected', resolution: { eventId: 'close', outcome: 'close', actor: '架空担当A' } } } } } satisfies Snapshot;
    expect(parse(JSON.stringify(original))).toEqual(original);
  });

  test.each(supplyDetails)('供給の履歴 $kind の全欄を読み戻す', detail => {
    const event = { ...meta('event'), ...legacyEventLabels, ...detail };
    let receipts: Supply['receipts'] = {}, log: Supply['log'] = [event];
    if (event.kind === 'receiptRecord') receipts = { [event.lotId]: { received: event.received, provisional: event.provisional, eventId: event.eventId, label: event.label } };
    if (event.kind === 'receiptRevise') {
      receipts = { [event.lotId]: { received: event.after, provisional: event.provisional, eventId: event.eventId, label: null } };
      log = [{ ...meta('receipt-source'), ...legacyEventLabels, kind: 'receiptRecord', lotId: event.lotId, received: event.before, provisional: false, label: null }, event];
    }
    const requestState = requestEventFixture(detail);
    const original = { ...snapshot(), ...(requestState === null ? {} : { ledger: requestState.ledger }),
      supply: { ...(requestState?.supply ?? { ...emptySupply, receipts, log }), needs: { n: need }, declarations: { d: declaration }, levels: { p: { level: 'half', eventId: 'l', quantityKey: 'qty' } }, acks: { h: 'ack' } } } satisfies Snapshot;
    expect(parse(JSON.stringify(original))).toEqual(original);
  });

  test.each(details)('台帳の履歴 $kind の必要な欄を欠けば拒否する', detail => {
    const key = Object.keys(detail).find(key => key !== 'kind') ?? 'changes';
    const original = { ...snapshot(), ledger: { ...practiceLedger, history: [{ ...meta('event'), ...legacyEventLabels, ...detail, changes: [] }] } };
    expect(() => parse(alter(JSON.stringify(original), ['ledger', 'history', 0, key], undefined))).toThrow(`.${key}`);
  });

  test.each(supplyDetails)('供給の履歴 $kind の必要な欄を欠けば拒否する', detail => {
    const key = Object.keys(detail).find(key => key !== 'kind');
    if (!key) throw new Error('履歴の固有の欄がない');
    const original = { ...snapshot(), supply: { ...emptySupply, log: [{ ...meta('event'), ...legacyEventLabels, ...detail }] } };
    expect(() => parse(alter(JSON.stringify(original), ['supply', 'log', 0, key], undefined))).toThrow(`.${key}`);
  });

  test.each([
    ['declaration', ['supply', 'declarations', 'd', 'linked'], 'yes'],
    ['reply date', ['supply', 'requests', 'r', 'reply', 'date'], '2026-02-30'],
    ['cancelled', ['supply', 'requests', 'r', 'cancelled', 'eventId'], undefined],
    ['level', ['supply', 'levels', 'p', 'level'], 'empty'],
    ['quantityKey', ['supply', 'levels', 'p', 'quantityKey'], undefined],
    ['ack', ['supply', 'acks', 'h'], false],
    ['resolution', ['ledger', 'issues', 'i', 'resolution', 'actor'], undefined],
    ['process', ['ledger', 'lots', 'p', 'stage', 'process', 'criterion'], 'invalid'],
    ['unknownParts', ['ledger', 'lots', 'p', 'quantity', 'unknownParts', 0, 'kind'], 'known'],
    ['unknown before', ['ledger', 'lots', 'p', 'quantity', 'unknownParts', 0, 'before'], undefined],
    ['numeric enum', ['ledger', 'lots', 'p', 'quantity', 'numeric', 'unconfirmed'], 'invalid'],
  ] satisfies [string, (string | number)[], unknown][])('%s の入れ子が不正なら該当箇所を示して拒否する', (_name, path, value) => {
    const original = { ...snapshot(),
      ledger: { ...practiceLedger, lots: { p: { ...lot(), quantity: add(q, quantityOf(observe('u', 'unknown', null))), stage: { kind: 'working', process: { id: '工程', criterion: 'inspection' } } } }, issues: { i: { id: 'i', lotId: 'p', reason: 'declared', resolution: { eventId: 'close', outcome: 'close', actor: '架空担当A' } } } },
      supply: { ...emptySupply, declarations: { d: declaration }, requests: { r: { ...request, reply: { kind: 'estimated', date: '2026-10-07' }, cancelled: { eventId: 'cancel', reason: '不要' } } }, levels: { p: { level: 'half', eventId: 'level', quantityKey: 'key' } }, acks: { h: 'ack' } },
    } satisfies Snapshot;
    expect(() => parse(alter(JSON.stringify(original), path, value))).toThrow(path.at(-1)?.toString());
  });

  test('不明の観測値や必要な数に数値を入れず、確認済みの根拠には値を必要とする', () => {
    const value = snapshot();
    for (const required of [{ basis: 'unknown', value: 0 }, { basis: 'counted', value: null }]) {
      expect(() => parse(alter(JSON.stringify(value), ['supply', 'needs', 'sc-n1', 'required'], required))).toThrow('value');
    }
    const invalidObservation = { ...quantityOf(observe('u', 'unknown', null)), terms: [{ sign: 1, observation: { id: 'u', basis: 'unknown', value: 0 } }] };
    expect(() => parse(alter(JSON.stringify(value), ['ledger', 'lots', 'P-B01', 'quantity'], invalidObservation))).toThrow('value');
  });

  test('型が合っていても実在しない日時・日付は拒否し、正当な時刻帯と秒なしの日時は保つ', () => {
    for (const wrong of ['2026-02-30T10:00:00+09:00', '2026-10-05T10:00:00', '2026-10-05T24:00:00Z']) {
      expect(() => parse(alter(JSON.stringify(snapshot()), ['ledger', 'history', 0, 'recordedAt'], wrong))).toThrow('recordedAt');
    }
    const text = alter(JSON.stringify(snapshot()), ['ledger', 'history', 0, 'recordedAt'], '2026-10-05T10:00Z');
    expect(parse(text).ledger.history[0]?.recordedAt).toBe('2026-10-05T10:00Z');
    expect(() => parse(alter(text, ['supply', 'needs', 'sc-n1', 'dueDate'], '2026-02-30'))).toThrow('dueDate');
  });

  test.each(['opId', 'opLabel', 'savedTargets', 'unsavedTargets', 'attempt', 'openedAt', 'resolution'])('保存照合の%sは必須で、同じ操作の解消を二重に読まない', key => {
    expect(() => parse(alter(JSON.stringify(snapshot()), ['saveChecks', 0, key], undefined))).toThrow(key);
    const value = snapshot();
    expect(() => parse(JSON.stringify({ ...value, saveChecks: [...value.saveChecks, ...value.saveChecks] }))).toThrow('一件');
  });

  test('初期化・解析・読み込みで返す写しの入れ子はすべて凍結する', () => {
    const original = snapshot();
    for (const value of [initial(original.ledger, original.supply), parse(JSON.stringify(original))]) {
      const visit = (v: unknown): void => { if (typeof v === 'object' && v !== null) { expect(Object.isFrozen(v)).toBe(true); Object.values(v).forEach(visit); } };
      visit(value);
      expect(Reflect.set(value.ledger.lots, 'new', lot())).toBe(false);
      expect(() => { value.lastWriter = '変更'; }).toThrow();
    }
    const store = storeOf();
    store.data.set('fuzzy-stock/pending', pendingText(pending()));
    const result = load(store);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(Object.isFrozen(result.pending?.units[0]?.targets)).toBe(true);
      expect(Object.isFrozen(result.pending?.values)).toBe(true);
    }
  });

  test.each([
    ['format', ['format'], '別形式'], ['version', ['version'], 13], ['revision', ['revision'], -1], ['opFloor', ['opFloor'], 0], ['lastWriter', ['lastWriter'], undefined],
    ['ledger', ['ledger'], []], ['lots', ['ledger', 'lots'], []], ['stage', ['ledger', 'lots', 'P-B01', 'stage', 'kind'], 'invalid'],
    ['project', ['ledger', 'lots', 'P-B01', 'project', 'id'], undefined], ['holds', ['ledger', 'lots', 'P-B01', 'holds'], ['invalid']],
    ['quantity', ['ledger', 'lots', 'P-B01', 'quantity', 'kind'], 'invalid'], ['numeric', ['ledger', 'lots', 'P-B01', 'quantity', 'numeric', 'value'], 1.5],
    ['observation', ['ledger', 'lots', 'P-B01', 'quantity', 'terms', 0, 'observation', 'value'], -1], ['term', ['ledger', 'lots', 'P-B01', 'quantity', 'terms', 0, 'sign'], 0],
    ['lastCount', ['ledger', 'lots', 'P-B01', 'lastCount', 'value'], -1], ['history', ['ledger', 'history', 0, 'kind'], 'invalid'],
    ['changes', ['ledger', 'history', 0, 'changes', 0, 'after', 'item'], undefined], ['meta', ['ledger', 'history', 0, 'recordedAt'], 0],
    ['issue', ['ledger', 'issues', 'stop', 'reason'], 'invalid'], ['stop', ['ledger', 'stops', 'stop', 'shortage', 'unit'], undefined],
    ['supply', ['supply'], null], ['need', ['supply', 'needs', 'sc-n1', 'required', 'value'], -1], ['request', ['supply', 'requests', 'sc-q1', 'reply', 'kind'], 'invalid'],
    ['arrival', ['supply', 'requests', 'sc-q1', 'arrivals', 0, 'good'], '1'], ['receipt', ['supply', 'receipts', '交換品', 'label'], undefined],
    ['supplyEvent', ['supply', 'log', 0, 'need', 'required', 'basis'], 'invalid'], ['ops', ['ops', 'op9', 'units', 0, 0], false],
    ['saveCheck', ['saveChecks', 0, 'resolution', 'outcome'], 'invalid'], ['targets', ['saveChecks', 0, 'unsavedTargets'], [3]],
  ] satisfies [string, (string | number)[], unknown][])('%s が壊れていれば理由付きで拒否し、何も書かない', (_name, path, value) => {
    const store = storeOf();
    // 中断の確認事項は台数不明なので自動では開かない。
    const withIssue = { ...snapshot(), ledger: { ...snapshot().ledger, issues: { stop: { id: 'stop', lotId: null, reason: 'negative', resolution: null } } } };
    const text = alter(JSON.stringify(withIssue), path, value);
    expect(() => parse(text)).toThrow();
    store.data.set('fuzzy-stock/slot-A', text);
    expect(load(store)).toMatchObject({ kind: 'unreadable', reason: expect.any(String) });
    expect(store.writes).toEqual([]);
  });

  test.each(['null', '[]', '{}', '{', '"文字列"'])('不完全なJSON %s は理由付きで拒否する', text => expect(() => parse(text)).toThrow());

  test('空の保存先だけをemptyとし、孤立した写しやpendingは上書きしない', () => {
    expect(load(new MemoryStore())).toEqual({ kind: 'empty' });
    for (const key of ['fuzzy-stock/slot-A', 'fuzzy-stock/slot-B', 'fuzzy-stock/pending']) {
      const store = new MemoryStore(); store.data.set(key, '{}');
      expect(load(store)).toMatchObject({ kind: 'unreadable' });
      expect(() => replace(store, null, seedScn02())).toThrow();
      expect(store.writes).toEqual([]);
    }
  });

  test.each(['?', '', 'C'])('不正なhead %s と欠けたスロットを拒否する', head => {
    const store = new MemoryStore(); store.data.set('fuzzy-stock/head', head);
    expect(load(store)).toMatchObject({ kind: 'unreadable' }); expect(store.writes).toEqual([]);
  });

  test('headが指すスロットを読み、別スロットの未確定の写しは使わない', () => {
    const store = storeOf();
    store.data.set('fuzzy-stock/slot-B', '{}');
    expect(load(store)).toMatchObject({ kind: 'ok', snapshot: snapshot() });
    store.data.set('fuzzy-stock/head', 'B');
    expect(load(store)).toMatchObject({ kind: 'unreadable' });
    store.data.delete('fuzzy-stock/slot-B');
    expect(load(store)).toMatchObject({ kind: 'unreadable', reason: expect.stringContaining('写しがない') });
    expect(store.writes).toEqual([]);
  });

  test('読み込み自体の例外をunreadableとして返す', () => {
    const store = new MemoryStore();
    store.getItem = () => { throw new Error('アクセス拒否'); };
    expect(load(store)).toEqual({ kind: 'unreadable', reason: expect.stringContaining('アクセス拒否') });
  });

  test('有効なsaving/partialのpendingを保持して読み込み、初期化を止める', () => {
    for (const progress of ['saving', 'partial'] as const) {
      const store = storeOf(); const p = { ...pending(), progress, unknownSince: at };
      store.data.set('fuzzy-stock/pending', pendingText(p));
      expect(load(store)).toEqual({ kind: 'ok', snapshot: snapshot(), pending: p, recovered: null });
      expect(() => replace(store, snapshot(), seedScn02())).toThrow(); expect(store.writes).toEqual([]);
    }
  });

  test.each([
    ['progress', ['progress'], 'done'], ['unknownSince', ['unknownSince'], undefined], ['savingSince', ['savingSince'], undefined], ['baseRevision', ['baseRevision'], -1],
    ['opId', ['opId'], 9], ['opLabel', ['opLabel'], undefined], ['fingerprint', ['fingerprint'], false], ['values', ['values', 'flag'], 0],
    ['actor', ['actor'], undefined], ['startedAt', ['startedAt'], undefined], ['units', ['units'], {}], ['unit ledger', ['units', 0, 'ledger', 'lots'], []],
    ['unit supply', ['units', 0, 'supply', 'receipts', '交換品', 'provisional'], 'yes'], ['targets', ['units', 0, 'targets'], [0]],
  ] satisfies [string, (string | number)[], unknown][])('pendingの%sが壊れていても何も書かない', (_name, path, value) => {
    const store = storeOf(); store.data.set('fuzzy-stock/pending', pendingText(JSON.parse(alter(JSON.stringify(pending()), path, value))));
    expect(load(store)).toMatchObject({ kind: 'unreadable' }); expect(store.writes).toEqual([]);
  });

  test('初回は版0でAに書き、以後は逆のスロットからheadを切り替え、操作索引・解消記録・番号下限を初期化する', () => {
    const store = new MemoryStore();
    const first = replace(store, null, seedScn02());
    expect(first).toMatchObject({ revision: 0, lastWriter: 'init', opFloor: 1, ops: {}, saveChecks: [] });
    expect(store.writes).toEqual(['fuzzy-stock/slot-A', 'fuzzy-stock/head']);
    const current = { ...snapshot(), revision: 0 };
    store.data.set('fuzzy-stock/slot-A', JSON.stringify(current)); store.writes.length = 0;
    const next = replace(store, current, { ledger: practiceLedger, supply: emptySupply });
    expect(next).toEqual({ ...initial(practiceLedger, emptySupply), revision: 1 });
    expect(nextOpIdOf(next)).toBe('op1'); expect(Object.isFrozen(next)).toBe(true);
    expect(store.writes).toEqual(['fuzzy-stock/slot-B', 'fuzzy-stock/head']);
    expect(store.getItem('fuzzy-stock/head')).toBe('B');
    expect(load(store)).toEqual({ kind: 'ok', snapshot: next, pending: null, recovered: null });
  });

  test.each(['fuzzy-stock/slot-B', 'fuzzy-stock/head'])('%s の書き込み失敗では確定した写しを変えない', key => {
    const store = storeOf(); const before = load(store); store.failOn = key;
    expect(() => replace(store, snapshot(), seedScn02())).toThrow('保存容量不足');
    expect(store.getItem('fuzzy-stock/head')).toBe('A'); expect(load(store)).toEqual(before);
  });

  test('古い写し・未読の既存データ・壊れたデータを置換で上書きしない', () => {
    const store = storeOf();
    expect(() => replace(store, { ...snapshot(), revision: 3 }, seedScn02())).toThrow();
    expect(() => replace(store, null, seedScn02())).toThrow();
    store.data.set('fuzzy-stock/slot-A', '{}');
    expect(() => replace(store, snapshot(), seedScn02())).toThrow(); expect(store.writes).toEqual([]);
  });

  test('操作IDは台帳と供給の履歴の合計と番号下限の大きい方で振る', () => {
    const value = snapshot();
    expect(nextOpIdOf(value)).toBe('op30');
    expect(nextOpIdOf({ ...value, opFloor: 1 })).toBe(`op${value.ledger.history.length + value.supply.log.length + 1}`);
  });

  test('入力のfingerprintは順序に依存せず、種類・値・型を区別する', () => {
    expect(fingerprintOf('受け取り', { label: '0012', enabled: false })).toBe(fingerprintOf('受け取り', { enabled: false, label: '0012' }));
    expect(fingerprintOf('受け取り', { enabled: false })).not.toBe(fingerprintOf('受け取り', { enabled: 'false' }));
    expect(fingerprintOf('受け取り', { label: '0012' })).not.toBe(fingerprintOf('割り当て', { label: '0012' }));
    expect(fingerprintOf('受け取り', { label: '0012' })).not.toBe(fingerprintOf('受け取り', { label: '12' }));
  });

  test('保存結果不明の開始日時と登録操作の同一性を区別する', () => {
    const p = pending();
    expect(unknownSinceOf(p)).toBe(later);
    expect(unknownSinceOf({ ...p, unknownSince: at })).toBe(at);
    expect(unknownSinceOf({ ...p, progress: 'partial' })).toBeNull();
    expect(unknownSinceOf({ ...p, progress: 'partial', unknownSince: at })).toBe(at);
    expect(attemptOf(p)).toBe(attemptOf({ ...p, savingSince: at, progress: 'partial' }));
    for (const change of [{ opId: 'op10' }, { startedAt: later }, { fingerprint: '別の入力' }]) expect(attemptOf(p)).not.toBe(attemptOf({ ...p, ...change }));
  });
});

describe('B3 task2.3 確定単位の対象（要件4.2・4.6、AT-24・AT-38の単体部分）', () => {
  test('実際の受け取りは台帳・供給で重なる保管単位を一度だけ、割り当ては依頼と受け取りの保管単位を返す', () => {
    const { current, units } = commitCase(); const first = units[0]; const second = units[1]; const third = units[2];
    if (!first || !second || !third) throw new Error('受け取りと割り当ての単位が必要');
    expect(targetsOf(current, first)).toEqual(['まとまり新しい箱']);
    expect(targetsOf(first, second)).toEqual(['依頼request1', 'まとまり新しい箱']);
    expect(targetsOf(second, third)).toEqual(['依頼request2', 'まとまり新しい箱']);
    expect(targetsOf(current, third)).toEqual(['まとまり新しい箱', '依頼request1', '依頼request2']);
  });

  test('履歴が増えていなければ現在値や以前のtargetsから対象を作らない', () => {
    const { current } = commitCase();
    expect(targetsOf(current, current)).toEqual([]);
    expect(targetsOf({ ...current, targets: ['以前の対象'] }, { ...current, ledger: { ...current.ledger, lots: {} } })).toEqual([]);
  });

  test('数量を変えない日時の訂正でも、訂正した操作とその保管単位を返す', () => {
    const before = { ledger: move(seedLedger(), meta('moved'), 'P-001', 'T'), supply: emptySupply };
    const after = { ...before, ledger: correctOccurredAt(before.ledger, meta('corrected'), 'moved', later) };
    expect(after.ledger.lots).toEqual(before.ledger.lots);
    expect(targetsOf(before, after)).toEqual(['操作moved', 'まとまりP-001']);
  });

  test('数量を変えない確認事項を片付けるでも、事項とその保管単位を返す', () => {
    let ledger = declareDiscrepancy(seedLedger(), meta('issue'), 'P-001', '架空の差異');
    ledger = recount(ledger, meta('checked'), 'P-001', 68, { kind: 'unknown' });
    const before = { ledger, supply: emptySupply }; const after = { ...before, ledger: resolveIssue(ledger, meta('resolved'), 'issue', 'close') };
    expect(after.ledger.lots).toEqual(before.ledger.lots);
    expect(targetsOf(before, after)).toEqual(['照合事項issue', 'まとまりP-001']);
  });

  test('作業の中断・台数の更新・作業の再開は、ほかの数量の対象を混ぜず同じ中断を指す', () => {
    const before = { ledger: seedLedger(), supply: emptySupply };
    const halted = { ...before, ledger: recordStop(before.ledger, meta('halt'), stop) };
    const updated = { ...halted, ledger: updateStop(halted.ledger, meta('updated'), 'halt', 0) };
    const resumed = { ...updated, ledger: resumeWork(updated.ledger, meta('resumed'), 'halt') };
    expect(targetsOf(before, halted)).toEqual(['停止halt']);
    expect(targetsOf(halted, updated)).toEqual(['停止halt']);
    expect(targetsOf(updated, resumed)).toEqual(['停止halt']);
    expect(targetsOf(before, resumed)).toEqual(['停止halt']);
  });

  test('使用の取消は取り消した操作と保管単位を返し、取消前のほかの操作を載せない', () => {
    const before = { ledger: use(seedLedger(), meta('used'), 'P-001', 'counted', 1, '架空作業'), supply: emptySupply };
    const after = { ...before, ledger: voidRecord(before.ledger, meta('voided'), 'used', '架空の入力誤り') };
    expect(targetsOf(before, after)).toEqual(['まとまりP-001', '操作used']);
  });

  test('対象の保管単位がまだ分からない仮の記録でも、その新しい操作を対象にする', () => {
    const before = { ledger: seedLedger(), supply: emptySupply };
    const after = { ...before, ledger: recordProvisional(before.ledger, meta('unidentified'), { direction: 'found', item: null, location: null, basis: 'unknown', value: null, note: '架空の未特定の物' }) };
    expect(targetsOf(before, after)).toEqual(['操作unidentified']);
    const resolved = { ...after, ledger: resolveIssue(after.ledger, meta('closed'), 'unidentified', 'close') };
    expect(targetsOf(after, resolved)).toEqual(['照合事項unidentified']);
  });

  const expectedSupply: Record<SupplyDetail['kind'], string[]> = {
    receiptTemplateSave: ['受入テンプレートkit'], receiptTemplateDelete: ['受入テンプレートkit'], templateReceipt: ['一括受入new'],
    needImport: ['必要明細取込new'], needImportResolve: ['必要明細取込held'],
    needRegister: [`必要明細${need.id}`], needRevise: [`必要明細${need.id}`], shortageDeclare: ['申告d'], declarationLink: ['申告d'],
    requestRecord: [`依頼${request.id}`], orderConfirm: ['依頼r'], replyRecord: ['依頼r'], requestCancel: ['依頼r'],
    receiptRecord: ['まとまりP-001'], receiptRevise: ['まとまりP-001'], arrival: ['依頼r', 'まとまりP-001'], arrivalRevise: ['依頼r', 'まとまりP-001'],
    remainder: ['まとまりP-001'], returnAck: ['操作h'], usageEstimate: ['レシピ推計new'],
  };
  test.each(supplyDetails)('供給の $kind は指している対象を種類つきで返し、以前の記録を対象にしない', detail => {
    const before = { ledger: seedLedger(), supply: seed.supply };
    const after = { ...before, supply: deepFreeze({ ...before.supply, log: [...before.supply.log, { ...meta('new'), ...legacyEventLabels, ...detail }] }) };
    expect(targetsOf(before, after)).toEqual(expectedSupply[detail.kind]);
    expect(targetsOf(before, after)).not.toEqual([]);
    expect(targetsOf(after, after)).toEqual([]);
  });

  test('割り当ての訂正が指す受け取りが変われば、訂正前と訂正後の保管単位を両方残す', () => {
    const before = { ledger: seedLedger(), supply: emptySupply };
    const after = { ...before, supply: { ...emptySupply, log: [{ ...meta('changed'), ...legacyEventLabels, kind: 'arrivalRevise', requestId: 'r', before: arrival, after: { ...arrival, receiptLotId: '別の受入' } } satisfies ReturnType<typeof seedScn02>['supply']['log'][number]] } };
    expect(targetsOf(before, after)).toEqual(['依頼r', 'まとまりP-001', 'まとまり別の受入']);
  });

  const expectedLedger: Record<EventDetail['kind'], string[]> = {
    alternativeRecord: ['元票「架空原票」・動き「001」'],
    rework: ['まとまりP-001'], reworkPart: ['操作rework'],
    register: [], move: [], merge: [], hold: [], release: [], provisional: [], master: ['品目（仮）架空部品Q', '品目Q'],
    identify: ['まとまりP-001', '照合事項i'], adopt: ['まとまりP-001', '照合事項i'], assignProject: ['まとまりP-001'],
    recount: ['まとまりP-001'], declare: ['まとまりP-001'], start: ['まとまりP-001'], use: ['まとまりP-001'], handover: ['まとまりP-001'], split: ['まとまりP-001'], stage: ['まとまりP-001'], transfer: ['まとまりP-001'],
    resolve: ['照合事項i', 'まとまり参照元'], correctTime: ['操作old', 'まとまり参照元'], void: ['まとまりP-001', '操作use1'], stop: ['停止st'], stopUpdate: ['停止st'], resume: ['停止st'],
  };
  test.each(details)('台帳の $kind は変えた保管単位と明示の参照を順序を保って重複なく返す', detail => {
    const ref = { ...lot(), id: '参照元' }; const changed = { ...lot(), id: '変更先' };
    const before = { ledger: deepFreeze({ ...practiceLedger, history: [{ ...meta('old'), ...legacyEventLabels, kind: 'register', changes: [{ before: null, after: ref }] }], issues: { i: { id: 'i', lotId: ref.id, reason: 'declared', resolution: null } } } satisfies Ledger), supply: emptySupply };
    const after = { ...before, ledger: deepFreeze({ ...before.ledger, history: [...before.ledger.history, { ...meta('new'), ...legacyEventLabels, ...detail, changes: [{ before: null, after: changed }, { before: null, after: changed }] }] }) };
    expect(targetsOf(before, after)).toEqual(['まとまり変更先', ...expectedLedger[detail.kind]]);
    expect(targetsOf(before, after)).toHaveLength(new Set(targetsOf(before, after)).size);
  });

  test('明示のlotIdだけを持つ保留の使用と、複数の保管単位を変えた操作の日時訂正を漏らさない', () => {
    const before = { ledger: seedLedger(), supply: emptySupply };
    const held = { ...before, ledger: use(before.ledger, meta('held'), 'P-001', 'counted', 200, '架空作業') };
    expect(held.ledger.history.at(-1)?.changes).toEqual([]);
    expect(targetsOf(before, held)).toEqual(['まとまりP-001']);
    const a = { ...lot(), id: '0012' }; const b = { ...lot(), id: '別のまとまり' };
    const pair = { ...before, ledger: { ...before.ledger, history: [...before.ledger.history, { ...meta('combined'), ...legacyEventLabels, kind: 'merge', changes: [{ before: null, after: a }, { before: null, after: b }] } satisfies Ledger['history'][number]] } };
    const correction = { ...pair, ledger: { ...pair.ledger, history: [...pair.ledger.history, { ...meta('corrected'), ...legacyEventLabels, kind: 'correctTime', targetEventId: 'combined', previous: at, corrected: later, changes: [] } satisfies Ledger['history'][number]] } };
    expect(targetsOf(pair, correction)).toEqual(['操作combined', 'まとまり0012', 'まとまり別のまとまり']);
  });

  test('確認事項を片付けるの日時を直した場合も、その参照先の保管単位を返す', () => {
    const ledger = { ...practiceLedger, issues: { i: { id: 'i', lotId: '参照元', reason: 'declared', resolution: null } }, history: [{ ...meta('resolved'), ...legacyEventLabels, kind: 'resolve', issueId: 'i', outcome: 'close', inclusion: null, countedBy: null, changes: [] }] } satisfies Ledger;
    const before = { ledger, supply: emptySupply };
    const after = { ...before, ledger: { ...ledger, history: [...ledger.history, { ...meta('corrected'), ...legacyEventLabels, kind: 'correctTime', targetEventId: 'resolved', previous: at, corrected: later, changes: [] } satisfies Ledger['history'][number]] } };
    expect(targetsOf(before, after)).toEqual(['操作resolved', 'まとまり参照元']);
  });

  test('afterから参照がなくなっても、beforeにある操作と確認事項をたどれる', () => {
    const ref = { ...lot(), id: '参照元' };
    const before = { ledger: { ...practiceLedger, history: [{ ...meta('old'), ...legacyEventLabels, kind: 'register', changes: [{ before: null, after: ref }] }], issues: { i: { id: 'i', lotId: ref.id, reason: 'declared', resolution: null } } } satisfies Ledger, supply: emptySupply };
    const after = { ...before, ledger: { ...practiceLedger, history: [{ ...meta('filler'), ...legacyEventLabels, kind: 'provisional', direction: 'found', item: null, location: null, basis: 'unknown', value: null, note: '架空', changes: [] }, { ...meta('corrected'), ...legacyEventLabels, kind: 'correctTime', targetEventId: 'old', previous: at, corrected: later, changes: [] }, { ...meta('resolved'), ...legacyEventLabels, kind: 'resolve', issueId: 'i', outcome: 'close', inclusion: null, countedBy: null, changes: [] }] satisfies Ledger['history'] } };
    expect(targetsOf(before, after)).toEqual(['操作old', 'まとまり参照元', '照合事項i']);
  });

  test('同じ文字列のIDでも種類を区別し、凍結した状態や以前のtargetsを変更しない', () => {
    const { current, units } = commitCase(); const first = units[0]; if (!first) throw new Error('受け取り単位が必要');
    const beforeText = serialize(current); const afterText = JSON.stringify(first); const targets = targetsOf(current, first);
    targets.push('呼出側の追記');
    expect(serialize(current)).toBe(beforeText); expect(JSON.stringify(first)).toBe(afterText);
    expect(targetsOf(current, first)).toEqual(['まとまり新しい箱']);
    const detail: SupplyDetail = { kind: 'requestRecord', request: { ...request, id: '新しい箱' } };
    const after = deepFreeze({ ...first, supply: { ...first.supply, log: [...first.supply.log, { ...meta('same-id'), ...legacyEventLabels, ...detail }] } });
    expect(targetsOf(current, after)).toEqual(['まとまり新しい箱', '依頼新しい箱']);
  });
});

type Operation = Parameters<typeof commit>[2];
function operation(opId = 'op20'): Operation {
  const values = { label: '0012-AB', received: '4' };
  return { opId, opLabel: '受入と充当', values, fingerprint: fingerprintOf('受け取りと割り当て', values), actor: '架空担当A', startedAt: at, savingSince: later };
}

function commitCase(): { current: Snapshot; op: Operation; units: UnitState[]; store: MemoryStore } {
  let supply = emptySupply;
  for (const id of ['request1', 'request2']) supply = recordRequest(supply, fixedMasters, meta(id), {
    project: { kind: 'common' }, item: 'S', unit: '箱', quantity: 1, vendor: '架空仕入先', requestedOn: '2026-10-05', reply: { kind: 'none' },
  });
  const current = initial(seedLedger(), supply);
  const received = receiveLot(current.ledger, current.supply, meta('op20-r'), { id: '新しい箱', item: 'S', unit: '箱', project: { kind: 'common' }, location: 'S1' }, 'counted', 4, '0012-AB');
  const first = { ...received, conflictReviews: current.conflictReviews, targets: ['まとまり新しい箱'] };
  const second = { ledger: first.ledger, conflictReviews: current.conflictReviews, supply: allocateArrival(first.ledger, first.supply, meta('op20-a1'), 'request1', { receiptLotId: '新しい箱', arrived: 1, good: 1 }), targets: ['まとまり新しい箱', '依頼request1'] };
  const third = { ledger: second.ledger, conflictReviews: current.conflictReviews, supply: allocateArrival(second.ledger, second.supply, meta('op20-a2'), 'request2', { receiptLotId: '新しい箱', arrived: 1, good: 1 }), targets: ['まとまり新しい箱', '依頼request2'] };
  return { current, op: operation(), units: [first, second, third], store: storeOf(current) };
}

function loadedCommit(store: StoreLike): Extract<ReturnType<typeof load>, { kind: 'ok' }> {
  const result = load(store);
  if (result.kind !== 'ok') throw new Error(`保存先を読めない: ${result.kind}`);
  return result;
}

function activeSnapshot(store: MemoryStore): Snapshot {
  const head = store.data.get('fuzzy-stock/head');
  const text = store.data.get(`fuzzy-stock/slot-${head}`);
  if (!text) throw new Error('確定した写しが必要');
  return parse(text);
}

function interrupted(saved: number, known = false): { store: MemoryStore; current: Snapshot; pending: Pending; units: UnitState[] } {
  const { current, op, units, store } = commitCase();
  let p: Pending;
  if (saved === 0) {
    p = { ...op, progress: 'saving', savingSince: at, unknownSince: null, baseRevision: current.revision, units };
    store.data.set('fuzzy-stock/pending', pendingText(p));
  } else {
    store.failAfterSetAt = 1 + saved * 2;
    const result = commit(store, current, op, units);
    if (result.kind !== 'unknown') throw new Error('応答喪失の状態が必要');
    p = result.pending;
    store.failAfterSetAt = null;
  }
  if (known) {
    p = { ...p, progress: 'partial', unknownSince: null };
    store.data.set('fuzzy-stock/pending', pendingText(p));
  }
  store.writes.length = 0; store.setCalls = 0;
  return { store, current: activeSnapshot(store), pending: p, units };
}

describe('B3 task2.4 照会・再試行・解消と復旧（AT-24・AT-38の保存層部分）', () => {
  beforeEach(() => { faults.failMidwayAt = null; faults.loseResponseAt = null; });
  const actor = '架空確認者B';
  const after = '2026-10-05T12:00:00+09:00';
  const settlements = [confirmSaved, abandon];
  const operations = [retry, confirmSaved, abandon];

  test.each([0, 1, 2, 3])('照会は保存済み %i 単位と総数を返すだけでpendingも保存先も変えない', saved => {
    const { store, current, pending } = interrupted(saved); const before = new Map(store.data);
    expect(inquire(store, pending)).toEqual({ snapshot: current, savedUnits: saved, total: 3 });
    expect(store.data).toEqual(before); expect(store.writes).toEqual([]);
  });

  test.each([1, 2])('既知の一部保存 %i 単位から残りだけ再試行し、確認事項も重複履歴も作らない', saved => {
    const { store, current, pending, units } = interrupted(saved, true);
    const result = retry(store, current, pending, actor, later);
    expect(result.kind).toBe('saved');
    if (result.kind !== 'saved') throw new Error('再試行で保存が必要');
    expect(result.snapshot.ledger).toEqual(units[2]?.ledger); expect(result.snapshot.supply).toEqual(units[2]?.supply);
    expect(result.snapshot.ops.op20?.units).toEqual([['op20-r', 'op20-r-c'], ['op20-a1'], ['op20-a2']]);
    expect(result.snapshot.revision).toBe(3); expect(result.snapshot.saveChecks).toEqual([]);
    expect(store.writes.filter(k => k.includes('slot'))).toHaveLength(3 - saved);
    expect(loadedCommit(store).pending).toBeNull(); expect(attemptOf(pending)).toBe(attemptOf({ ...pending, savingSince: later }));
  });

  test.each([0, 1, 2])('保存結果不明の %i 単位から再試行し、最後の単位と解消を同じ写しに一回だけ確定する', saved => {
    const { store, current, pending, units } = interrupted(saved);
    const result = retry(store, current, pending, actor, later);
    expect(result.kind).toBe('saved');
    if (result.kind !== 'saved') throw new Error('再試行で保存が必要');
    expect(result.snapshot.saveChecks).toEqual([{ opId: 'op20', opLabel: pending.opLabel, attempt: attemptOf(pending), openedAt: at,
      savedTargets: ['まとまり新しい箱', '依頼request1', '依頼request2'], unsavedTargets: [], resolution: { outcome: 'retried', actor, at: later } }]);
    expect(result.snapshot.revision).toBe(3); expect(result.snapshot.supply).toEqual(units[2]?.supply);
    expect(store.writes.filter(k => k.includes('slot'))).toHaveLength(3 - saved);
    expect(retry(store, result.snapshot, pending, actor, after)).toMatchObject({ kind: 'recovered', check: result.snapshot.saveChecks[0] });
    expect(activeSnapshot(store).saveChecks).toHaveLength(1);
  });

  test('保存結果不明から再試行の途中で失敗しても開いた日時を残し、再々試行で一件だけ解消する', () => {
    const { store, current, pending } = interrupted(1); faults.failMidwayAt = 2;
    const result = retry(store, current, pending, actor, later);
    expect(result.kind).toBe('partial');
    if (result.kind !== 'partial') throw new Error('一部保存が必要');
    expect(result).toMatchObject({ saved: 2, total: 3, pending: { progress: 'partial', unknownSince: at, startedAt: at, savingSince: later } });
    expect(unknownSinceOf(result.pending)).toBe(at); expect(result.snapshot.saveChecks).toEqual([]);
    const next = retry(store, result.snapshot, result.pending, actor, after);
    expect(next.kind).toBe('saved');
    if (next.kind === 'saved') expect(next.snapshot.saveChecks).toEqual([expect.objectContaining({ openedAt: at, resolution: { outcome: 'retried', actor, at: after } })]);
  });

  test('既知の一部保存から再試行の応答を失った時点で確認事項を開き、全保存でもloadは消さない', () => {
    const { store, current, pending } = interrupted(2, true); faults.loseResponseAt = 1;
    const result = retry(store, current, pending, actor, later);
    expect(result.kind).toBe('unknown');
    if (result.kind !== 'unknown') throw new Error('応答喪失が必要');
    expect(result.pending).toMatchObject({ progress: 'saving', unknownSince: null, savingSince: later, startedAt: at });
    expect(unknownSinceOf(result.pending)).toBe(later);
    const loaded = loadedCommit(store); expect(loaded.pending).toEqual(result.pending); expect(loaded.snapshot.saveChecks).toEqual([]);
    const settled = confirmSaved(store, loaded.snapshot, result.pending, actor, after);
    expect(settled).toMatchObject({ kind: 'settled', outcome: 'saved', snapshot: { saveChecks: [expect.objectContaining({ openedAt: later, resolution: { outcome: 'saved', actor, at: after } })] } });
  });

  test('全保存の再試行は保存済みの確定として解消し、台帳と供給を再適用しない', () => {
    const { store, current, pending } = interrupted(3); const result = retry(store, current, pending, actor, later);
    expect(result).toMatchObject({ kind: 'recovered', check: { resolution: { outcome: 'saved', actor, at: later } }, snapshot: { revision: 4, ledger: current.ledger, supply: current.supply } });
    expect(store.writes.filter(k => k.includes('slot'))).toHaveLength(1);
  });

  test.each([1, 2])('再試行の応答喪失設定 %i でも残りの全単位と解消を保存する', n => {
    const { store, current, pending, units } = interrupted(1); faults.loseResponseAt = n;
    expect(retry(store, current, pending, actor, later).kind).toBe('unknown');
    const saved = activeSnapshot(store);
    expect(saved.ops.op20?.units).toHaveLength(3);
    expect(saved.ledger).toEqual(units[2]?.ledger); expect(saved.supply).toEqual(units[2]?.supply);
    expect(saved.saveChecks).toEqual([expect.objectContaining({ resolution: { outcome: 'retried', actor, at: later } })]);
    expect(loadedCommit(store)).toMatchObject({ pending: null, recovered: saved.saveChecks[0] });
  });

  test('照会だけでは解消せず、明示した保存済み確定で確認者・日時・対象を残す', () => {
    const { store, current, pending } = interrupted(3); inquire(store, pending);
    expect(store.writes).toEqual([]); expect(store.data.has('fuzzy-stock/pending')).toBe(true);
    const result = confirmSaved(store, current, pending, actor, later);
    expect(result).toMatchObject({ kind: 'settled', outcome: 'saved', snapshot: { lastWriter: 'op20', opFloor: 21,
      saveChecks: [{ opId: 'op20', attempt: attemptOf(pending), openedAt: at, savedTargets: ['まとまり新しい箱', '依頼request1', '依頼request2'], unsavedTargets: [], resolution: { outcome: 'saved', actor, at: later } }] } });
    expect(store.writes).toEqual(['fuzzy-stock/pending', 'fuzzy-stock/slot-A', 'fuzzy-stock/head', 'fuzzy-stock/pending']);
    expect(loadedCommit(store).pending).toBeNull();
  });

  test.each([0, 1, 2])('保存済み確定は %i 単位のままでは何も書かず拒否する', saved => {
    const { store, current, pending } = interrupted(saved); const before = new Map(store.data);
    expect(confirmSaved(store, current, pending, actor, later)).toMatchObject({ kind: 'failed' });
    expect(store.writes).toEqual([]); expect(store.data).toEqual(before);
  });

  test.each([0, 1, 2, 3])('取りやめは保存済み %i 単位を保持し、三つの結果と保存済み・未保存の対象を区別する', saved => {
    const { store, current, pending } = interrupted(saved); const result = abandon(store, current, pending, actor, later);
    const outcome = saved === 0 ? 'abandoned' : saved === 3 ? 'saved' : 'remainderAbandoned';
    expect(result.kind).toBe('settled');
    if (result.kind !== 'settled') throw new Error('取りやめの確定が必要');
    expect(result.outcome).toBe(outcome); expect(result.snapshot.ledger).toEqual(current.ledger); expect(result.snapshot.supply).toEqual(current.supply);
    const targets = (units: UnitState[]) => [...new Set(units.flatMap(unit => unit.targets))];
    expect(result.snapshot.saveChecks).toEqual([expect.objectContaining({ opId: 'op20', attempt: attemptOf(pending), openedAt: at,
      savedTargets: targets(pending.units.slice(0, saved)), unsavedTargets: targets(pending.units.slice(saved)), resolution: { outcome, actor, at: later } })]);
    expect(result.snapshot.opFloor).toBe(21); expect(loadedCommit(store).pending).toBeNull();
  });

  test('記録を残さず取りやめても番号下限を確定し、次の操作IDを再利用しない', () => {
    const { store, current, pending } = interrupted(0, true);
    const p = { ...pending, opId: 'op40' }; store.data.set('fuzzy-stock/pending', pendingText(p));
    const result = abandon(store, current, p, actor, later);
    expect(result).toMatchObject({ kind: 'settled', outcome: null, snapshot: { opFloor: 41, saveChecks: [], ops: {} } });
    if (result.kind === 'settled') expect(nextOpIdOf(result.snapshot)).toBe('op41');
    expect(store.writes).toEqual(['fuzzy-stock/pending', 'fuzzy-stock/slot-B', 'fuzzy-stock/head', 'fuzzy-stock/pending']);
  });

  test.each([false, true])('未保存のまま取りやめた操作IDは解消記録の有無 %s にかかわらず新規保存に使えない', known => {
    const { store, current, pending, units } = interrupted(0, known);
    const result = abandon(store, current, pending, actor, later);
    if (result.kind !== 'settled') throw new Error('取りやめの確定が必要');
    const before = new Map(store.data); store.writes.length = 0;
    faults.loseResponseAt = 1;
    expect(commit(store, result.snapshot, { ...operation(), fingerprint: '別の内容' }, units)).toMatchObject({ kind: 'mismatch' });
    expect(store.data).toEqual(before); expect(store.writes).toEqual([]);
    expect(loadedCommit(store).pending).toBeNull();
  });

  test.each([1, 2])('既知の一部保存 %i 単位の取りやめは番号下限が確定済みなので写しを書かずpendingだけ消す', saved => {
    const { store, current, pending } = interrupted(saved, true); faults.loseResponseAt = 1; faults.failMidwayAt = 1;
    expect(abandon(store, current, pending, actor, later)).toEqual({ kind: 'settled', snapshot: current, outcome: null });
    expect(store.writes).toEqual(['fuzzy-stock/pending']); expect(activeSnapshot(store)).toEqual(current);
    expect(faults).toEqual({ failMidwayAt: null, loseResponseAt: null }); expect(loadedCommit(store).pending).toBeNull();
  });

  test.each([false, true])('既知の一部保存の削除例外 after=%s はreadbackで未削除失敗と削除完了を分ける', removed => {
    const { store, current, pending } = interrupted(1, true); store.failRemove = !removed; store.failAfterRemove = removed;
    const result = abandon(store, current, pending, actor, later);
    expect(result.kind).toBe(removed ? 'settled' : 'failed');
    expect(activeSnapshot(store)).toEqual(current);
    expect(store.data.has('fuzzy-stock/pending')).toBe(!removed);
    if (!removed) expect(loadedCommit(store).pending).toEqual(pending);
    expect(store.writes).toEqual(['fuzzy-stock/pending']);
  });

  test.each(settlements)('解消の途中失敗 %s は写しを確定せずpendingと元の結果不明を残す', settle => {
    const { store, current, pending } = interrupted(settle === confirmSaved ? 3 : 1); faults.failMidwayAt = 1;
    expect(settle(store, current, pending, actor, later)).toMatchObject({ kind: 'failed', reason: expect.stringContaining('途中失敗') });
    const loaded = loadedCommit(store); expect(loaded.snapshot).toEqual(current); expect(loaded.snapshot.saveChecks).toEqual([]);
    expect(loaded.pending).toEqual(pending);
    expect(settle(store, current, loaded.pending ?? pending, actor, after).kind).toBe('settled');
  });

  test.each(settlements)('解消 %s の確定後応答喪失はunknownで残し、loadが同じattemptの記録だけで片付ける', settle => {
    const { store, current, pending } = interrupted(settle === confirmSaved ? 3 : 1); faults.loseResponseAt = 1;
    const result = settle(store, current, pending, actor, later); expect(result.kind).toBe('unknown');
    expect(store.data.has('fuzzy-stock/pending')).toBe(true); const snapshot = activeSnapshot(store); expect(snapshot.saveChecks).toHaveLength(1);
    const loaded = loadedCommit(store); expect(loaded).toEqual({ kind: 'ok', snapshot, pending: null, recovered: snapshot.saveChecks[0] });
    expect(loadedCommit(store).recovered).toBeNull(); expect(activeSnapshot(store).saveChecks).toHaveLength(1);
  });

  test.each(operations)('取りやめの確定直後の中断から %s は元の解消を返し、未保存の割り当てを追加しない', recover => {
    const { store, current, pending } = interrupted(1); faults.loseResponseAt = 1;
    expect(abandon(store, current, pending, actor, later).kind).toBe('unknown');
    const snapshot = activeSnapshot(store); store.writes.length = 0;
    const result = recover(store, current, pending, actor, after);
    expect(result).toMatchObject({ kind: 'recovered', snapshot, check: { resolution: { outcome: 'remainderAbandoned' }, savedTargets: ['まとまり新しい箱'], unsavedTargets: ['まとまり新しい箱', '依頼request1', '依頼request2'] } });
    expect(activeSnapshot(store)).toEqual(snapshot); expect(snapshot.ops.op20?.units).toHaveLength(1); expect(store.writes).toEqual(['fuzzy-stock/pending']);
    expect(recover(store, snapshot, pending, actor, after)).toMatchObject({ kind: 'recovered', snapshot });
  });

  test('照会は解消済みのpendingがあっても復旧の削除をしない', () => {
    const { store, current, pending } = interrupted(1); faults.loseResponseAt = 1;
    abandon(store, current, pending, actor, later); const before = new Map(store.data); store.writes.length = 0;
    expect(inquire(store, pending)).toMatchObject({ savedUnits: 1, total: 3 });
    expect(store.data).toEqual(before); expect(store.writes).toEqual([]);
  });

  test.each([load, ...operations])('opIdだけ同じでattemptが違う解消記録から %s は新しいpendingを消さない', operation => {
    const { store, current, pending } = interrupted(0); const prior = snapshot().saveChecks[0]; if (!prior) throw new Error('古い解消が必要');
    const value = { ...current, saveChecks: [{ ...prior, opId: pending.opId, attempt: attemptOf({ ...pending, startedAt: later }) }] };
    store.data.set('fuzzy-stock/slot-A', serialize(value)); const before = new Map(store.data);
    if (operation === load) expect(load(store)).toMatchObject({ kind: 'ok', pending });
    else expect(operation(store, value, pending, actor, after).kind).toBe('conflict');
    expect(store.writes).toEqual([]); expect(store.data).toEqual(before);
  });

  test('確認事項がないpartialだけは全保存を確認できればloadで片付ける', () => {
    const { store, current } = interrupted(3, true);
    expect(load(store)).toEqual({ kind: 'ok', snapshot: current, pending: null, recovered: null });
    expect(store.writes).toEqual(['fuzzy-stock/pending']);
  });

  test.each(operations)('前提が崩れた %s は最後の書込者・版数・所有pendingを確認して何も書かない', operation => {
    for (const saved of [0, 1, 3]) {
      const { store, current, pending } = interrupted(saved);
      const changed = { ...current, revision: current.revision + 1, lastWriter: 'op99' };
      store.data.set(`fuzzy-stock/slot-${store.data.get('fuzzy-stock/head')}`, serialize(changed)); const before = new Map(store.data);
      expect(operation(store, changed, pending, actor, later)).toEqual({ kind: 'conflict' });
      expect(operation(store, current, pending, actor, later)).toEqual({ kind: 'conflict' });
      expect(store.writes).toEqual([]); expect(store.data).toEqual(before);
    }
  });

  test.each(operations)('同じattemptでも単位や入力をすり替えた %s は保存前に拒否する', operation => {
    const { store, current, pending } = interrupted(1); const before = new Map(store.data);
    expect(operation(store, current, { ...pending, units: pending.units.slice(0, 1) }, actor, later)).toEqual({ kind: 'conflict' });
    expect(operation(store, current, { ...pending, values: { label: '別の入力' } }, actor, later)).toEqual({ kind: 'conflict' });
    expect(store.data).toEqual(before); expect(store.writes).toEqual([]);
  });

  test.each(['fingerprint', 'ids'])('保存済み索引の%sがpendingと違えば再試行は競合で何も書かない', change => {
    const { store, current, pending } = interrupted(1);
    const changed = { ...current, ops: { op20: { fingerprint: change === 'fingerprint' ? '別の入力' : pending.fingerprint, units: [[change === 'ids' ? 'request1' : 'op20-r', 'op20-r-c']] } } };
    store.data.set('fuzzy-stock/slot-B', serialize(changed)); const before = new Map(store.data);
    expect(retry(store, changed, pending, actor, later)).toEqual({ kind: 'conflict' }); expect(store.writes).toEqual([]); expect(store.data).toEqual(before);
  });

  test.each(operations)('事前のpending読み込み失敗 %s は保存せずfailedで理由を返す', operation => {
    const { store, current, pending } = interrupted(operation === confirmSaved ? 3 : 1); store.failGetOn = 'fuzzy-stock/pending';
    expect(operation(store, current, pending, actor, later)).toMatchObject({ kind: 'failed', reason: expect.any(String) }); expect(store.writes).toEqual([]);
  });

  test.each(operations)('savingのmarkerを書けない %s は単位も解消も書かず、元のmarkerを保持する', operation => {
    const { store, current, pending } = interrupted(operation === confirmSaved ? 3 : 1); store.failSetAt = 1;
    expect(operation(store, current, pending, actor, later)).toMatchObject({ kind: 'failed', reason: expect.any(String) });
    expect(activeSnapshot(store)).toEqual(current); expect(loadedCommit(store).pending).toEqual(pending);
    expect(store.writes).toEqual(['fuzzy-stock/pending']);
  });

  test.each(operations)('savingのmarker書込後に応答を失った %s はunknownで開始日時と元のattemptを保持する', operation => {
    const { store, current, pending } = interrupted(operation === confirmSaved ? 3 : 1); store.failAfterSetAt = 1;
    expect(operation(store, current, pending, actor, later)).toMatchObject({ kind: 'unknown', pending: { progress: 'saving', savingSince: later, unknownSince: at, startedAt: at } });
    expect(activeSnapshot(store)).toEqual(current); expect(loadedCommit(store).pending?.startedAt).toBe(at);
    expect(store.writes.filter(k => k.includes('slot'))).toEqual([]);
  });

  test.each(operations)('確定後の削除失敗 %s はunknownで証跡を残し、解消は一回だけ復旧する', operation => {
    const { store, current, pending } = interrupted(operation === confirmSaved ? 3 : 1); store.failRemove = true;
    const result = operation(store, current, pending, actor, later); expect(result.kind).toBe('unknown');
    const value = activeSnapshot(store); expect(value.saveChecks).toHaveLength(1); expect(store.data.has('fuzzy-stock/pending')).toBe(true);
    expect(load(store).kind).toBe('unreadable'); store.failRemove = false;
    expect(loadedCommit(store)).toMatchObject({ pending: null, recovered: value.saveChecks[0] }); expect(activeSnapshot(store).saveChecks).toHaveLength(1);
  });

  test.each(settlements)('解消のhead書込後に実際の応答を失った %s はunknownで確定済みを未保存扱いしない', settle => {
    const { store, current, pending } = interrupted(settle === confirmSaved ? 3 : 1); store.failAfterSetAt = 3;
    expect(settle(store, current, pending, actor, later).kind).toBe('unknown');
    const value = activeSnapshot(store); expect(value.saveChecks).toHaveLength(1); expect(value.revision).toBe(current.revision + 1);
    expect(loadedCommit(store)).toMatchObject({ pending: null, recovered: value.saveChecks[0] });
  });

  test('同じopIdの別attemptの解消は、全保存に見える既知partialの復旧にも使わない', () => {
    const { store, current, pending } = interrupted(3, true);
    const value = { ...current, saveChecks: [{ opId: pending.opId, opLabel: pending.opLabel, savedTargets: [], unsavedTargets: [],
      attempt: attemptOf({ ...pending, startedAt: later }), openedAt: at, resolution: { outcome: 'saved', actor, at: later } satisfies Snapshot['saveChecks'][number]['resolution'] }] };
    store.data.set('fuzzy-stock/slot-B', serialize(value)); const before = new Map(store.data);
    expect(load(store)).toEqual({ kind: 'ok', snapshot: value, pending, recovered: null });
    expect(store.data).toEqual(before); expect(store.writes).toEqual([]);
  });

  test.each([2, 3, 4, 5])('既知の一部保存の再試行で実際の書込 %i が失敗しても結果不明の照合を開かない', write => {
    const { store, current, pending } = interrupted(1, true); store.failSetAt = write;
    const result = retry(store, current, pending, actor, later); const saved = write <= 3 ? 1 : 2;
    expect(result).toMatchObject({ kind: 'partial', saved, total: 3, pending: { progress: 'partial', unknownSince: null, savingSince: later, startedAt: at } });
    const loaded = loadedCommit(store); expect(loaded.snapshot.ops.op20?.units).toHaveLength(saved);
    expect(loaded.snapshot.saveChecks).toEqual([]); expect(loaded.pending && unknownSinceOf(loaded.pending)).toBeNull();
  });

  test.each([2, 3])('未保存から再試行の最初の実際の書込 %i が失敗しても元の確認事項を保持する', write => {
    const { store, current, pending } = interrupted(0); store.failSetAt = write;
    expect(retry(store, current, pending, actor, later)).toMatchObject({ kind: 'failed', reason: '保存容量不足' });
    const loaded = loadedCommit(store); expect(loaded.snapshot).toEqual(current);
    expect(loaded.pending).toEqual(pending);
  });

  test.each([false, true])('再試行のpartial書込の例外 after=%s はsavingを保持し、その試みの結果不明を開く', afterWrite => {
    const { store, current, pending } = interrupted(1, true); faults.failMidwayAt = 2;
    if (afterWrite) store.failAfterSetAt = 5; else store.failSetAt = 5;
    const result = retry(store, current, pending, actor, later);
    expect(result).toMatchObject({ kind: 'unknown', pending: { progress: 'saving', unknownSince: null, savingSince: later } });
    const loaded = loadedCommit(store); expect(loaded.snapshot.ops.op20?.units).toHaveLength(2);
    expect(loaded.pending?.progress).toBe('saving'); expect(loaded.pending && unknownSinceOf(loaded.pending)).toBe(later);
  });

  test.each(operations)('解消済みpendingの削除応答を失った %s はunknownで復元し、新しい解消を足さない', operation => {
    const { store, current, pending } = interrupted(1); faults.loseResponseAt = 1;
    abandon(store, current, pending, actor, later); const value = activeSnapshot(store); store.failAfterRemove = true;
    expect(operation(store, current, pending, actor, after)).toMatchObject({ kind: 'unknown' });
    expect(store.data.has('fuzzy-stock/pending')).toBe(true); expect(activeSnapshot(store)).toEqual(value);
    store.failAfterRemove = false;
    expect(operation(store, current, pending, actor, after)).toMatchObject({ kind: 'recovered', check: value.saveChecks[0] });
    expect(activeSnapshot(store).saveChecks).toHaveLength(1);
  });

  test('loadの復旧で削除後の応答を失ってもpendingの証跡を復元し、次回に同じ解消を返す', () => {
    const { store, current, pending } = interrupted(1); faults.loseResponseAt = 1;
    abandon(store, current, pending, actor, later); store.failAfterRemove = true;
    expect(load(store)).toMatchObject({ kind: 'unreadable', reason: '削除後の応答を受け取れない' });
    expect(store.data.has('fuzzy-stock/pending')).toBe(true); expect(activeSnapshot(store).saveChecks).toHaveLength(1);
    store.failAfterRemove = false;
    expect(loadedCommit(store)).toMatchObject({ pending: null, recovered: { resolution: { outcome: 'remainderAbandoned' } } });
  });

  test('復旧のcleanup前のpending読込が失敗しても解消済みの写しを変えない', () => {
    const { store, current, pending } = interrupted(1); faults.loseResponseAt = 1;
    abandon(store, current, pending, actor, later); const before = new Map(store.data); store.writes.length = 0; store.failGetOn = 'fuzzy-stock/pending';
    expect(load(store).kind).toBe('unreadable');
    expect(retry(store, current, pending, actor, after)).toMatchObject({ kind: 'failed' });
    expect(store.data).toEqual(before); expect(store.writes).toEqual([]);
  });

  test.each(settlements)('解消 %s のhead失敗と同時にreadbackも失敗したら未保存と断定しない', settle => {
    const { store, current, pending } = interrupted(settle === confirmSaved ? 3 : 1);
    store.failSetAt = 3; store.failGetOn = 'fuzzy-stock/head'; store.failGetAfterSetAt = 3;
    expect(settle(store, current, pending, actor, later)).toMatchObject({ kind: 'unknown' });
    store.failGetOn = null;
    expect(activeSnapshot(store)).toEqual(current); expect(loadedCommit(store).pending?.progress).toBe('saving');
  });

  test('削除結果を読めない既知の一部保存の取りやめは競合で中断し、元の証跡を残す', () => {
    const { store, current, pending } = interrupted(1, true);
    store.removeItem = key => { store.writes.push(key); store.failGetOn = 'fuzzy-stock/pending'; throw new Error('削除結果不明'); };
    expect(abandon(store, current, pending, actor, later)).toEqual({ kind: 'conflict' });
    expect(activeSnapshot(store)).toEqual(current); expect(store.writes).toEqual(['fuzzy-stock/pending']);
    store.failGetOn = null; expect(loadedCommit(store).pending).toEqual(pending);
  });

  test('照会時に壊れた写しや読込障害があってもpending・headを書かない', () => {
    for (const key of ['fuzzy-stock/head', 'fuzzy-stock/slot-B']) {
      const { store, pending } = interrupted(1); const before = new Map(store.data); store.failGetOn = key;
      expect(() => inquire(store, pending)).toThrow(); expect(store.data).toEqual(before); expect(store.writes).toEqual([]);
    }
  });

  test('別の正当な操作が追加されても照会は保存済み接頭部を返し、再試行だけを競合で止める', () => {
    const { store, current, pending } = interrupted(1);
    const received = receiveLot(current.ledger, current.supply, meta('op21-r'), { id: '別の箱', item: 'S', unit: '箱', project: { kind: 'common' }, location: 'S2' }, 'counted', 1, '別の架空ラベル');
    const changed = { ...current, ...received, revision: current.revision + 1, lastWriter: 'op21', opFloor: 22,
      ops: { ...current.ops, op21: { fingerprint: '別の受け取り', units: [['op21-r', 'op21-r-c']] } } };
    store.data.set('fuzzy-stock/slot-A', serialize(changed)); store.data.set('fuzzy-stock/head', 'A'); const before = new Map(store.data);
    expect(inquire(store, pending)).toEqual({ snapshot: changed, savedUnits: 1, total: 3 });
    expect(retry(store, changed, pending, actor, later)).toEqual({ kind: 'conflict' });
    expect(retry(store, current, pending, actor, later)).toEqual({ kind: 'conflict' });
    expect(store.data).toEqual(before); expect(store.writes).toEqual([]);
  });

  test('再試行の最後の単位と解消を確定した直後に応答を失ってもretriedの解消を一回だけ復旧する', () => {
    const { store, current, pending } = interrupted(1); faults.loseResponseAt = 2;
    expect(retry(store, current, pending, actor, later)).toMatchObject({ kind: 'unknown' });
    const value = activeSnapshot(store); expect(value.ops.op20?.units).toHaveLength(3);
    expect(value.saveChecks).toEqual([expect.objectContaining({ resolution: { outcome: 'retried', actor, at: later } })]);
    faults.loseResponseAt = 1;
    expect(retry(store, current, pending, actor, after)).toMatchObject({ kind: 'recovered', check: value.saveChecks[0] });
    expect(faults.loseResponseAt).toBeNull(); expect(activeSnapshot(store)).toEqual(value);
  });
});

describe('B3 task2.2 保存の確定境界（AT-23・AT-24・AT-38・AT-39の単体部分）', () => {
  beforeEach(() => { faults.failMidwayAt = null; faults.loseResponseAt = null; });

  test('各単位をスロット→headで確定し、受け取りの台帳と供給を一つの単位として索引に載せる', () => {
    const { current, op, units, store } = commitCase();
    const result = commit(store, current, op, units);
    expect(result.kind).toBe('saved');
    if (result.kind !== 'saved') throw new Error('全単位の保存が必要');
    expect(store.writes).toEqual(['fuzzy-stock/pending', 'fuzzy-stock/slot-B', 'fuzzy-stock/head', 'fuzzy-stock/slot-A', 'fuzzy-stock/head', 'fuzzy-stock/slot-B', 'fuzzy-stock/head', 'fuzzy-stock/pending']);
    expect(result.snapshot).toMatchObject({ revision: 3, lastWriter: 'op20', opFloor: 21, ops: { op20: { fingerprint: op.fingerprint, units: [['op20-r', 'op20-r-c'], ['op20-a1'], ['op20-a2']] } } });
    expect(result.snapshot.ledger).toEqual(units[2]?.ledger);
    expect(result.snapshot.supply).toEqual(units[2]?.supply);
    expect(loadedCommit(store)).toEqual({ kind: 'ok', snapshot: result.snapshot, pending: null, recovered: null });
    expect(Object.isFrozen(result.snapshot.ops.op20?.units[0])).toBe(true);
    expect(Object.isFrozen(result.snapshot.supply.receipts['新しい箱'])).toBe(true);
    expect(current.ops).toEqual({}); expect(current.revision).toBe(0);
  });

  test.each(['A', 'B'])('現在のhead %s の反対のスロットを使い、既存の索引・解消・下限を保持する', head => {
    const { current, op, units, store } = commitCase();
    const prior = { ...current, revision: 9, opFloor: 50, ops: { op1: { fingerprint: '別入力', units: [['request1']] } }, saveChecks: snapshot().saveChecks };
    store.data.set('fuzzy-stock/head', head); store.data.set(`fuzzy-stock/slot-${head}`, serialize(prior));
    const result = commit(store, prior, { ...op, opId: 'op50' }, units.slice(0, 1));
    expect(result.kind).toBe('saved');
    if (result.kind === 'saved') {
      expect(result.snapshot).toMatchObject({ revision: 10, opFloor: 51, lastWriter: 'op50', ops: { op1: prior.ops.op1 }, saveChecks: prior.saveChecks });
      expect(store.getItem('fuzzy-stock/head')).toBe(head === 'A' ? 'B' : 'A');
    }
  });

  test.each(['fuzzy-stock/head', 'fuzzy-stock/slot-A', 'fuzzy-stock/pending'])('事前読込の%sが失敗しても何も書かない', key => {
    const { current, op, units, store } = commitCase(); const before = new Map(store.data);
    store.failGetOn = key;
    expect(commit(store, current, op, units)).toMatchObject({ kind: 'unreadable', reason: expect.any(String) });
    expect(store.data).toEqual(before); expect(store.writes).toEqual([]);
  });

  test('pendingの書込が失敗すれば単位には触れず、障害設定はこの保存の試みで消費する', () => {
    const { current, op, units, store } = commitCase(); store.failSetAt = 1; faults.loseResponseAt = 2;
    expect(commit(store, current, op, units)).toMatchObject({ kind: 'failed', reason: '保存容量不足' });
    expect(loadedCommit(store).snapshot).toEqual(current); expect(store.data.has('fuzzy-stock/pending')).toBe(false);
    expect(store.writes.filter(k => k.includes('slot'))).toEqual([]); expect(faults.loseResponseAt).toBeNull();
  });

  test.each([2, 3])('1つ目の単位の実際の書込 %i が失敗すれば台帳・供給とも入力前でpendingを消す', write => {
    const { current, op, units, store } = commitCase(); store.failSetAt = write;
    expect(commit(store, current, op, units)).toMatchObject({ kind: 'failed', reason: '保存容量不足' });
    expect(loadedCommit(store)).toEqual({ kind: 'ok', snapshot: current, pending: null, recovered: null });
    expect(store.getItem('fuzzy-stock/head')).toBe('A');
  });

  test.each([4, 5, 6, 7])('後続の実際の書込 %i が失敗すれば保存済みの接頭部だけを返し、確認事項は開かない', write => {
    const { current, op, units, store } = commitCase(); store.failSetAt = write;
    const result = commit(store, current, op, units); const saved = write < 6 ? 1 : 2;
    expect(result.kind).toBe('partial');
    if (result.kind !== 'partial') throw new Error('一部保存が必要');
    expect(result).toMatchObject({ saved, total: 3, reason: '保存容量不足', snapshot: { revision: saved }, pending: { progress: 'partial', unknownSince: null, savingSince: at, baseRevision: 0, units } });
    expect(result.snapshot.ledger).toEqual(units[saved - 1]?.ledger); expect(result.snapshot.supply).toEqual(units[saved - 1]?.supply);
    expect(result.snapshot.ops.op20?.units).toHaveLength(saved); expect(unknownSinceOf(result.pending)).toBeNull();
    expect(loadedCommit(store)).toEqual({ kind: 'ok', snapshot: result.snapshot, pending: result.pending, recovered: null });
    expect(result.snapshot.saveChecks).toEqual([]);
  });

  test.each([1, 2, 3])('途中失敗の単位 %i のスロットだけを書き、headの写しは前の確定から変えない', n => {
    const { current, op, units, store } = commitCase(); faults.failMidwayAt = n;
    const result = commit(store, current, op, units);
    expect(result.kind).toBe(n === 1 ? 'failed' : 'partial');
    const loaded = loadedCommit(store);
    expect(loaded.snapshot.revision).toBe(n - 1); expect(loaded.snapshot.ops.op20?.units.length ?? 0).toBe(n - 1);
    expect(loaded.snapshot.ledger).toEqual(n === 1 ? current.ledger : units[n - 2]?.ledger);
    expect(loaded.snapshot.supply).toEqual(n === 1 ? current.supply : units[n - 2]?.supply);
    const inactive = store.getItem('fuzzy-stock/head') === 'A' ? 'B' : 'A';
    expect(parse(store.getItem(`fuzzy-stock/slot-${inactive}`) ?? '').revision).toBe(n);
    expect(faults.failMidwayAt).toBeNull();
  });

  test.each([1, 2, 3])('応答喪失の設定 %i は一回の全保存を完了し、結果だけ失ってpendingを残す', n => {
    const { current, op, units, store } = commitCase(); faults.loseResponseAt = n;
    const result = commit(store, current, op, units);
    expect(result.kind).toBe('unknown');
    if (result.kind !== 'unknown') throw new Error('応答喪失が必要');
    expect(result.pending).toEqual({ ...op, progress: 'saving', unknownSince: null, savingSince: at, baseRevision: current.revision, units });
    expect(unknownSinceOf(result.pending)).toBe(at);
    const loaded = loadedCommit(store); expect(loaded.snapshot.revision).toBe(3); expect(loaded.snapshot.ops.op20?.units).toHaveLength(3);
    expect(loaded.snapshot.ledger).toEqual(units[2]?.ledger); expect(loaded.snapshot.supply).toEqual(units[2]?.supply);
    expect(loaded.pending).toEqual(result.pending); expect(faults.loseResponseAt).toBeNull();
    expect(store.writes).toHaveLength(7);
  });

  test('保存後のpending削除失敗を未保存と言わずunknownとし、次の操作でmarkerを上書きしない', () => {
    const { current, op, units, store } = commitCase(); store.failRemove = true;
    const result = commit(store, current, op, units);
    expect(result.kind).toBe('unknown');
    const loaded = loadedCommit(store); expect(loaded.snapshot.revision).toBe(3); expect(loaded.pending?.progress).toBe('saving');
    const before = new Map(store.data); store.writes.length = 0;
    expect(commit(store, loaded.snapshot, operation('op21'), units)).toEqual({ kind: 'conflict' });
    expect(store.data).toEqual(before); expect(store.writes).toEqual([]);
  });

  test('部分保存のmarker書き直し失敗はsavingのままunknownとし、確定済みの数量を失敗扱いしない', () => {
    const { current, op, units, store } = commitCase(); faults.failMidwayAt = 2; store.failSetAt = 5;
    expect(commit(store, current, op, units)).toMatchObject({ kind: 'unknown', pending: { progress: 'saving', unknownSince: null } });
    const loaded = loadedCommit(store); expect(loaded.snapshot.revision).toBe(1); expect(loaded.snapshot.supply).toEqual(units[0]?.supply);
    expect(loaded.pending?.progress).toBe('saving');
  });

  test('部分保存のmarkerを書き終えたあとの応答喪失でもsavingを戻し、unknownを再読込で失わない', () => {
    const { current, op, units, store } = commitCase(); faults.failMidwayAt = 2; store.failAfterSetAt = 5;
    expect(commit(store, current, op, units)).toMatchObject({ kind: 'unknown', pending: { progress: 'saving' } });
    const loaded = loadedCommit(store); expect(loaded.snapshot.revision).toBe(1); expect(loaded.pending?.progress).toBe('saving');
    expect(loaded.pending && unknownSinceOf(loaded.pending)).toBe(at);
  });

  test('pendingを書き終えて応答だけが失敗したときも単位に触れず、消せればfailedとする', () => {
    const { current, op, units, store } = commitCase(); store.failAfterSetAt = 1;
    expect(commit(store, current, op, units)).toMatchObject({ kind: 'failed', reason: '書込後の応答を受け取れない' });
    expect(loadedCommit(store)).toEqual({ kind: 'ok', snapshot: current, pending: null, recovered: null });
    expect(store.writes.filter(key => key.includes('slot'))).toEqual([]);
  });

  test('削除済みでもcleanupの応答を失ったらsavingのmarkerを復元してunknownを保持する', () => {
    const { current, op, units, store } = commitCase(); store.failAfterRemove = true;
    expect(commit(store, current, op, units)).toMatchObject({ kind: 'unknown', pending: { progress: 'saving' } });
    const loaded = loadedCommit(store); expect(loaded.snapshot.revision).toBe(3); expect(loaded.pending?.progress).toBe('saving');
  });

  test('head失敗後の読込でも失敗したら未保存と決めつけず、markerと確定済みの元の状態を残す', () => {
    const { current, op, units, store } = commitCase(); store.failSetAt = 3; store.failGetOn = 'fuzzy-stock/head'; store.failGetAfterSetAt = 3;
    expect(commit(store, current, op, units)).toMatchObject({ kind: 'unknown', pending: { progress: 'saving' } });
    store.failGetOn = null;
    const loaded = loadedCommit(store); expect(loaded.snapshot).toEqual(current); expect(loaded.pending?.progress).toBe('saving');
  });

  test('最初の単位の失敗後にpendingを消せなければmarkerを残し、新しい保存を拒否する', () => {
    const { current, op, units, store } = commitCase(); store.failSetAt = 2; store.failRemove = true;
    expect(commit(store, current, op, units)).toMatchObject({ kind: 'unknown', pending: { progress: 'saving' } });
    const loaded = loadedCommit(store); expect(loaded.snapshot).toEqual(current);
    const before = new Map(store.data); store.writes.length = 0; store.failRemove = false;
    expect(commit(store, current, operation('op21'), units)).toEqual({ kind: 'conflict' });
    expect(store.data).toEqual(before); expect(store.writes).toEqual([]);
  });

  test.each([3, 5, 7])('headの書込 %i 自体は完了して応答だけ失敗した場合もunknownでその確定を保持する', write => {
    const { current, op, units, store } = commitCase(); store.failAfterSetAt = write;
    const result = commit(store, current, op, units);
    expect(result.kind).toBe('unknown');
    const loaded = loadedCommit(store); expect(loaded.snapshot.revision).toBe((write - 1) / 2); expect(loaded.pending?.progress).toBe('saving');
  });

  test('同じ操作の再送は二重計上せず、違うfingerprintは理由つきで拒否する（AT-23単体）', () => {
    const { current, op, units, store } = commitCase(); const first = commit(store, current, op, units);
    if (first.kind !== 'saved') throw new Error('初回保存が必要');
    const before = new Map(store.data); store.writes.length = 0; faults.loseResponseAt = 1;
    expect(commit(store, first.snapshot, op, units)).toEqual({ kind: 'duplicate', snapshot: first.snapshot });
    expect(commit(store, first.snapshot, { ...op, fingerprint: '別内容' }, units)).toMatchObject({ kind: 'mismatch', reason: expect.any(String) });
    expect(store.data).toEqual(before); expect(store.writes).toEqual([]); expect(faults.loseResponseAt).toBe(1);
  });

  test('保存中の接頭部を新しいcommitの保存済み結果として返さない', () => {
    const { store, current, units } = interrupted(1); const before = new Map(store.data);
    expect(commit(store, current, operation(), units)).toEqual({ kind: 'conflict' });
    expect(store.data).toEqual(before); expect(store.writes).toEqual([]);
  });

  test('保存先の版数が進んでも同じ操作の再送は保存済みを返し、書き直さない', () => {
    const { current, op, units, store } = commitCase(); commit(store, current, op, units);
    const before = new Map(store.data); store.writes.length = 0; faults.failMidwayAt = 1;
    expect(commit(store, current, op, units)).toEqual({ kind: 'duplicate', snapshot: loadedCommit(store).snapshot });
    expect(store.data).toEqual(before); expect(store.writes).toEqual([]); expect(faults.failMidwayAt).toBe(1);
  });

  test.each(['saving', 'partial'] satisfies Pending['progress'][])('別の登録操作のpending %s を一切書き換えない', progress => {
    const { current, op, units, store } = commitCase(); const marker = { ...pending(), progress };
    store.data.set('fuzzy-stock/pending', pendingText(marker)); const before = new Map(store.data);
    expect(commit(store, current, op, units)).toEqual({ kind: 'conflict' });
    expect(store.data).toEqual(before); expect(store.writes).toEqual([]);
  });

  test('同じopIdでもstartedAtが違うmarkerと、同じ登録操作の未確定markerを上書きしない', () => {
    for (const startedAt of [at, later]) {
      const { current, op, units, store } = commitCase();
      store.data.set('fuzzy-stock/pending', pendingText({ ...op, startedAt, progress: 'saving', unknownSince: null, baseRevision: current.revision, units }));
      const before = new Map(store.data);
      expect(commit(store, current, op, units)).toEqual({ kind: 'conflict' });
      expect(store.data).toEqual(before); expect(store.writes).toEqual([]);
    }
  });

  test.each(['ledger', 'supply'] satisfies ('ledger' | 'supply')[])('%sの古い履歴から計算した単位を保存前に拒否し、新しい記録を保持する', field => {
    const { current, op, units, store } = commitCase(); const first = units[0];
    if (!first) throw new Error('受け取り単位が必要');
    const stale = field === 'ledger' ? { ...first, ledger: { ...first.ledger, history: first.ledger.history.slice(current.ledger.history.length) } } : { ...first, supply: { ...first.supply, log: first.supply.log.slice(current.supply.log.length) } };
    const before = new Map(store.data);
    expect(commit(store, current, op, [stale])).toMatchObject({ kind: 'failed', reason: expect.any(String) });
    expect(store.data).toEqual(before); expect(store.writes).toEqual([]);
  });

  test('同じ履歴数でも履歴の内容を置き換えた単位を拒否する', () => {
    const { current, op, units, store } = commitCase(); const first = units[0]; const old = first?.ledger.history[0];
    if (!first || !old) throw new Error('履歴が必要');
    const unit = { ...first, ledger: { ...first.ledger, history: [{ ...old, actor: '違う担当' }, ...first.ledger.history.slice(1)] } };
    expect(commit(store, current, op, [unit])).toMatchObject({ kind: 'failed' }); expect(store.writes).toEqual([]);
  });

  test('currentの版数だけが保存先と同じでも、状態の違う写しで上書きしない', () => {
    const { current, op, units, store } = commitCase();
    const forged = { ...current, ledger: { ...current.ledger, lots: {} } }; const before = new Map(store.data);
    expect(commit(store, forged, op, units)).toEqual({ kind: 'conflict' });
    expect(store.data).toEqual(before); expect(store.writes).toEqual([]);
  });

  test('増えた記録のbeforeが現状と異なる単位と、履歴なしの現在値変更を拒否する', () => {
    const { current, op, store } = commitCase(); const moved = move(current.ledger, meta('op20-m'), 'P-001', 'T');
    const event = moved.history.at(-1); const change = event?.changes[0];
    if (!event || !change?.before) throw new Error('移動の変化が必要');
    const staleEvent = { ...event, changes: [{ ...change, before: { ...change.before, location: 'S2' } }] };
    const stale = { ...moved, history: [...current.ledger.history, staleEvent] };
    for (const ledger of [stale, { ...moved, history: current.ledger.history }]) {
      expect(commit(store, current, op, [{ conflictReviews: [], ledger, supply: current.supply, targets: ['まとまりP-001'] }])).toMatchObject({ kind: 'failed' });
    }
    expect(store.writes).toEqual([]);
  });

  test('後の単位が古い受け取り前の状態を含んでいれば先頭単位を書く前に拒否する', () => {
    const { current, op, units, store } = commitCase();
    const unit = { ledger: move(current.ledger, meta('op20-m'), 'P-001', 'T'), supply: current.supply, conflictReviews: current.conflictReviews, targets: ['まとまりP-001'] };
    expect(commit(store, current, op, [...units, unit])).toMatchObject({ kind: 'failed' }); expect(store.writes).toEqual([]);
  });

  test.each([null, 1])('同じ材料を二度使う作業の開始を一単位にし、途中失敗 %s でも材料と仕掛品を分けない（AT-39単体）', fail => {
    const current = initial(seedLedger(), emptySupply); const store = storeOf(current); const op = operation();
    let ledger = use(current.ledger, meta('op20-use1'), 'P-001', 'counted', 2, '架空作業の開始');
    ledger = use(ledger, meta('op20-use2'), 'P-001', 'counted', 3, '架空作業の開始');
    ledger = start(ledger, meta('op20-start'), { id: '仕掛品', item: 'R', unit: '台', project: { kind: 'case', id: 'B-001' }, location: 'T' }, { id: 'R組立', criterion: 'inspection' }, 'counted', 1, ['op20-use1', 'op20-use2']);
    faults.failMidwayAt = fail;
    const result = commit(store, current, op, [{ conflictReviews: [], ledger, supply: emptySupply, targets: ['まとまりP-001', 'まとまり仕掛品'] }]);
    expect(result.kind).toBe(fail === null ? 'saved' : 'failed');
    const loaded = loadedCommit(store);
    expect(loaded.snapshot.ledger).toEqual(fail === null ? ledger : current.ledger);
    if (fail === null) expect(loaded.snapshot.ops.op20?.units).toEqual([['op20-use1', 'op20-use2', 'op20-start']]);
  });

  test.each([...[0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 4].map(n => ({ n, fault: 'failMidwayAt' as const })), ...[0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY].map(n => ({ n, fault: 'loseResponseAt' as const }))])('不正か範囲外の障害位置 $fault:$n は次の保存だけで消費し、書込前に理由つきで拒否する', ({ n, fault }) => {
    const { current, op, units, store } = commitCase(); faults[fault] = n;
    expect(commit(store, current, op, units)).toMatchObject({ kind: 'failed', reason: expect.any(String) });
    expect(store.writes).toEqual([]); expect(faults[fault]).toBeNull();
    expect(commit(store, current, op, units).kind).toBe('saved');
  });

  test('要件5.1：応答喪失の位置が単位の数を超えていても、次の保存を全単位完了させたうえで結果だけを返さない', () => {
    const { current, op, units, store } = commitCase(); faults.loseResponseAt = 4;
    expect(commit(store, current, op, units).kind).toBe('unknown');
    expect(loadedCommit(store).snapshot.ops.op20?.units).toHaveLength(3); expect(faults.loseResponseAt).toBeNull();
  });

  test('要件3.2：一つも保存せずに取りやめた操作を同じ内容で再送すると、記録済みの「未保存のまま取りやめた」を返し、何も書かない。違う内容なら拒否する', () => {
    const { store, current, pending, units } = interrupted(0);
    const settled = abandon(store, current, pending, '架空確認者B', later);
    if (settled.kind !== 'settled') throw new Error('取りやめの確定が必要');
    expect(settled.outcome).toBe('abandoned');
    const before = new Map(store.data); store.writes.length = 0;
    const resent = commit(store, settled.snapshot, operation(), units);
    expect(resent).toMatchObject({ kind: 'recovered', check: { opId: 'op20', resolution: { outcome: 'abandoned' } } });
    expect(store.data).toEqual(before); expect(store.writes).toEqual([]);
    const values = { label: '別の内容', received: '5' };
    expect(commit(store, settled.snapshot, { ...operation(), values, fingerprint: fingerprintOf('受け取りと割り当て', values) }, units).kind).toBe('mismatch');
  });

  test('同じ保存に設定した両障害を消費し、先の障害で止まっても後の障害を別操作へ持ち越さない', () => {
    const { current, op, units, store } = commitCase(); faults.failMidwayAt = 1; faults.loseResponseAt = 3;
    expect(commit(store, current, op, units).kind).toBe('failed'); expect(faults).toEqual({ failMidwayAt: null, loseResponseAt: null });
    expect(commit(store, current, op, units).kind).toBe('saved');
  });

  test.each(['empty', 'revision', 'opNumber', 'noEvents'])('保存不能な入力 %s は書込前に拒否する', invalid => {
    const { current, op, units, store } = commitCase();
    const value = invalid === 'revision' ? { ...current, revision: Number.MAX_SAFE_INTEGER } : current;
    store.data.set('fuzzy-stock/slot-A', serialize(value));
    const selected = invalid === 'empty' ? [] : invalid === 'noEvents' ? [{ ledger: current.ledger, supply: current.supply, conflictReviews: current.conflictReviews, targets: ['まとまりP-001'] }] : units;
    expect(commit(store, value, invalid === 'opNumber' ? operation('op9007199254740991') : op, selected)).toMatchObject({ kind: 'failed' });
    expect(store.writes).toEqual([]);
  });
});
