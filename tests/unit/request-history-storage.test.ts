import { describe, expect, test } from 'vitest';
import { deepFreeze, practiceLedger, type Meta } from '../../src/domain/ledger.ts';
import { receiveTemplate, saveReceiptTemplate, type ReceiptTemplate } from '../../src/domain/receipt-template.ts';
import { allocateArrival, cancelRequest, confirmOrder, emptySupply, receiveLot, recordReply, recordRequest, reviseArrival, reviseReceipt, type Supply } from '../../src/domain/supply.ts';
import { backupTextOf, crc32, readBackup } from '../../src/ui/backup.ts';
import { seedScn02 } from '../../src/ui/seed.ts';
import { initial, load, parse, serialize, type Snapshot, type StoreLike } from '../../src/ui/storage.ts';
import { decodePending, decodeSnapshot } from '../../src/ui/storageparse.ts';

const at = '2026-10-24T09:00:00+09:00';
const meta = (eventId: string): Meta => ({ eventId, occurredAt: at, recordedAt: at, actor: '架空担当A' });
const project = { kind: 'case', id: 'A-001' } satisfies Parameters<typeof recordRequest>[3]['project'];
const manual = () => recordRequest(emptySupply, practiceLedger.masters, meta('q1'), {
  project, item: 'P', unit: '個', quantity: 10, vendor: '架空手配先', requestedOn: '2026-10-24', reply: { kind: 'none' },
});
const getRequest = (supply: Supply, id = 'q1') => {
  const request = supply.requests[id];
  if (request === undefined) throw new Error(`試験用依頼がない: ${id}`);
  return request;
};
const unitOf = (snapshot: Snapshot) => ({ ledger: snapshot.ledger, supply: snapshot.supply, targets: [], conflictReviews: [] });
const pendingOf = (snapshot: Snapshot) => ({
  format: 'fuzzy-stock-pending', version: 9,
  pending: { progress: 'saving', unknownSince: null, savingSince: at, baseRevision: 0, opId: 'op1', opLabel: '依頼', fingerprint: 'f', values: {}, actor: '架空担当A', startedAt: at, units: [unitOf(snapshot)] },
});
const readAsBackup = (snapshot: Snapshot) => readBackup(new TextEncoder().encode(backupTextOf(snapshot, at)));
const mismatch = '依頼の履歴と現在値が一致しない';
const withoutCancellationHistory = (s: Supply): Supply => ({ ...s, requests: { q1: { ...getRequest(s), cancelled: { eventId: 'x1', reason: '架空取消' } } } });

class Store implements StoreLike {
  readonly values = new Map<string, string>();
  readonly writes: string[] = [];
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.writes.push(key); this.values.set(key, value); }
  removeItem(key: string) { this.writes.push(key); this.values.delete(key); }
}

const corruptions: { name: string; change: (supply: Supply) => Supply }[] = [
  { name: '作成記録のない依頼', change: s => ({ ...s, log: [] }) },
  { name: '作成記録のない別IDの依頼', change: s => ({ ...s, requests: { ...s.requests, fake: { ...getRequest(s), id: 'fake' } } }) },
  { name: '履歴のない取消', change: withoutCancellationHistory },
  { name: '現在値のない作成記録', change: s => ({ ...s, requests: {} }) },
  { name: '現在の依頼数だけの改変', change: s => ({ ...s, requests: { q1: { ...getRequest(s), quantity: 11 } } }) },
];

describe('依頼照合 要件3.1・3.3: すべての保存入口で拒否する', () => {
  for (const boundary of ['snapshot', 'pending', 'backup']) {
    test.each(corruptions)(`${boundary}: $name`, ({ change }) => {
      const input = deepFreeze(initial(practiceLedger, change(manual())));
      const before = JSON.stringify(input);
      if (boundary === 'snapshot') expect(() => parse(serialize(input))).toThrow(mismatch);
      else if (boundary === 'pending') expect(() => decodePending(deepFreeze(pendingOf(input)))).toThrow(mismatch);
      else expect(readAsBackup(input)).toMatchObject({ kind: 'unreadable', reason: expect.stringContaining(mismatch) });
      expect(JSON.stringify(input)).toBe(before);
    });
  }

  test.each([0, 1, 2])('pendingの第%s単位も検査し、入力を変更しない', brokenIndex => {
    const valid = initial(practiceLedger, manual());
    const broken = initial(practiceLedger, withoutCancellationHistory(manual()));
    const base = pendingOf(valid);
    const input = deepFreeze({ ...base, pending: { ...base.pending, units: [0, 1, 2].map(index => unitOf(index === brokenIndex ? broken : valid)) } });
    const before = JSON.stringify(input);
    expect(() => decodePending(input)).toThrow(`${mismatch}（q1: 現在値の内容が違う）`);
    expect(JSON.stringify(input)).toBe(before);
  });

  test.each(['snapshot', 'pending'])('保存先の%s読込失敗は理由を返し、原文を保持する', boundary => {
    const store = new Store();
    const valid = initial(practiceLedger, manual());
    const broken = initial(practiceLedger, withoutCancellationHistory(manual()));
    store.values.set('fuzzy-stock/head', 'A');
    store.values.set('fuzzy-stock/slot-A', serialize(boundary === 'snapshot' ? broken : valid));
    if (boundary === 'pending') store.values.set('fuzzy-stock/pending', JSON.stringify(pendingOf(broken)));
    const before = [...store.values];
    expect(load(store)).toMatchObject({ kind: 'unreadable', reason: expect.stringContaining(mismatch) });
    expect([...store.values]).toEqual(before);
    expect(store.writes).toEqual([]);
  });
});

function expectAccepted(snapshot: Snapshot): void {
  const input = deepFreeze(snapshot), before = JSON.stringify(input);
  expect(parse(serialize(input))).toEqual(snapshot);
  expect(decodePending(deepFreeze(pendingOf(input))).units[0]?.supply).toEqual(snapshot.supply);
  expect(readAsBackup(input)).toMatchObject({ kind: 'ok', snapshot });
  expect(JSON.stringify(input)).toBe(before);
}

describe('依頼照合 要件3.2: 正当な既存データと後日変更', () => {
  test('シードと手動依頼をそのまま受け付け、保存版9で読む', () => {
    const seed = seedScn02();
    expectAccepted(initial(seed.ledger, seed.supply));
    expectAccepted(initial(practiceLedger, manual()));
    expect(parse(serialize(initial(seed.ledger, seed.supply))).version).toBe(10);
  });

  test('回答・発注・到着・取消後訂正と、過剰割り当て中の訂正を受け付ける', () => {
    let supply = recordReply(manual(), practiceLedger.masters, meta('reply'), 'q1', { kind: 'answered', date: '2026-10-25' });
    supply = confirmOrder(supply, practiceLedger.masters, meta('confirm'), 'q1');
    const received = receiveLot(practiceLedger, supply, meta('receive'), { id: 'R1', project, item: 'P', unit: '個', location: 'S1' }, 'counted', 10);
    supply = allocateArrival(received.ledger, received.supply, meta('arrival'), 'q1', { receiptLotId: 'R1', arrived: 8, good: 7 });
    supply = cancelRequest(supply, practiceLedger.masters, meta('cancel'), 'q1', '架空の不要化');
    supply = reviseReceipt(received.ledger, supply, meta('receipt-revise'), 'R1', 2, '架空再確認');
    supply = reviseArrival(received.ledger, supply, meta('revise'), 'q1', 'arrival', { arrived: 7, good: 6 });
    expectAccepted(initial(received.ledger, supply));
    supply = reviseArrival(received.ledger, supply, meta('revise-good'), 'q1', 'arrival', { arrived: 7, good: 5 });
    expectAccepted(initial(received.ledger, supply));
    supply = reviseArrival(received.ledger, supply, meta('revise-zero'), 'q1', 'arrival', { arrived: 0, good: 0 });
    expectAccepted(initial(received.ledger, supply));
  });

  test('セットの派生依頼も後日の回答・分納・取消後訂正を保持する', () => {
    const recipe: ReceiptTemplate = { id: 'recipe', name: '架空セット', product: 'R', project: null, basis: 'label', rows: [{ item: 'P', unit: '個', perSet: 2, location: 'S1' }] };
    const saved = { ledger: practiceLedger, supply: saveReceiptTemplate(practiceLedger, emptySupply, meta('save'), recipe) };
    const received = receiveTemplate(saved, meta('batch'), 'recipe', project, 5, [{ quantity: 7, shortfall: 3 }], '架空手配先');
    let supply = confirmOrder(received.supply, received.ledger.masters, meta('confirm'), 'batch-s1');
    supply = recordReply(supply, practiceLedger.masters, meta('reply'), 'batch-s1', { kind: 'estimated', date: '2026-10-25' });
    const later = receiveLot(received.ledger, supply, meta('late'), { id: 'late-lot', project, item: 'P', unit: '個', location: 'S1' }, 'counted', 3);
    supply = allocateArrival(later.ledger, later.supply, meta('arrival'), 'batch-s1', { receiptLotId: 'late-lot', arrived: 2, good: 2 });
    supply = cancelRequest(supply, practiceLedger.masters, meta('cancel'), 'batch-s1', '架空取消');
    supply = reviseArrival(later.ledger, supply, meta('revise'), 'batch-s1', 'arrival', { arrived: 1, good: 1 });
    expectAccepted(initial(later.ledger, supply));
  });

  test.each([1, 2, 3, 4, 5, 6, 7, 8])('旧版%sのシード依頼を数量・履歴不変で受け付ける', version => {
    const seed = seedScn02(), current = initial(seed.ledger, seed.supply);
    const withoutLabels = <T extends { itemLabels: unknown }>({ itemLabels: _, ...body }: T) => body;
    const oldSupply = { ...seed.supply, log: seed.supply.log.map(e => ({ ...e, itemLabels: { kind: 'legacy-unavailable' as const } })) };
    const oldLedger = { ...seed.ledger, history: seed.ledger.history.map(e => ({ ...e, itemLabels: { kind: 'legacy-unavailable' as const } })) };
    const { conflictReviews, ...withoutReviews } = current;
    const { receiptTemplates, ...withoutTemplates } = seed.supply;
    const { masters, ...withoutMasters } = seed.ledger;
    const oldMasters = { ...masters, items: Object.fromEntries(Object.entries(masters.items).map(([id, master]) => {
      const { unitSteps, ...old } = master;
      return [id, old];
    })) };
    const input = deepFreeze({ ...withoutReviews, version,
      ...(version >= 6 ? { conflictReviews } : {}),
      ledger: { ...withoutMasters, history: seed.ledger.history.map(withoutLabels), ...(version >= 3 ? { masters: version >= 5 ? masters : oldMasters } : {}) },
      supply: { ...withoutTemplates, log: seed.supply.log.map(withoutLabels), ...(version >= 7 ? { receiptTemplates } : {}) },
    });
    const text = JSON.stringify(input);
    expect(decodeSnapshot(input).supply).toEqual(oldSupply);
    expect(parse(text).ledger).toEqual(oldLedger);
    expect(JSON.stringify(input)).toBe(text);
    const checksum = crc32(new TextEncoder().encode(`${at}\n${text}`)).toString(16).padStart(8, '0');
    const backup = JSON.stringify({ notice: '架空試験', format: 'fuzzy-stock-backup', version: 1, createdAt: at, crc32: checksum, snapshot: text });
    expect(readBackup(new TextEncoder().encode(backup))).toMatchObject({ kind: 'ok', snapshot: { supply: oldSupply } });
    const base = pendingOf(current);
    const pending = { ...base.pending, units: [{ ledger: input.ledger, supply: input.supply, targets: [], ...(version >= 6 ? { conflictReviews } : {}) }] };
    const oldPending = deepFreeze(version >= 4 ? { format: base.format, version, pending } : pending);
    const beforePending = JSON.stringify(oldPending);
    expect(decodePending(oldPending).units[0]?.supply).toEqual(oldSupply);
    expect(JSON.stringify(oldPending)).toBe(beforePending);
    const store = new Store();
    store.values.set('fuzzy-stock/head', 'A'); store.values.set('fuzzy-stock/slot-A', text);
    const beforeStore = [...store.values];
    expect(load(store)).toMatchObject({ kind: 'ok', snapshot: { supply: oldSupply } });
    expect([...store.values]).toEqual(beforeStore);
    expect(store.writes).toEqual([]);
  });
});
