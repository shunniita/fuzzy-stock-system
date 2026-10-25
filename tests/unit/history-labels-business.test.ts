import { describe, expect, test } from 'vitest';
import { changeMasters, practiceLedger, type Meta } from '../../src/domain/ledger.ts';
import { allocateArrival, cancelRequest, confirmOrder, emptySupply, receiveLot, recordReply, recordRequest, requestProgressOf, reviseArrival } from '../../src/domain/supply.ts';
import { applyNeedImport, previewNeedImport } from '../../src/domain/need-import.ts';
import { backupTextOf, crc32, readBackup } from '../../src/ui/backup.ts';
import { initial, serialize, serializePending, type Pending, type Snapshot } from '../../src/ui/storage.ts';
import { decodePending, decodeSnapshot } from '../../src/ui/storageparse.ts';

const at = '2026-10-24T09:00:00+09:00';
const meta = (eventId: string): Meta => ({ eventId, actor: '架空担当A', occurredAt: at, recordedAt: at });
const project = { kind: 'case', id: 'A-001' } as const;
const request = () => recordRequest(emptySupply, practiceLedger.masters, meta('request'), { project, item: 'P', unit: '個', quantity: 10, vendor: '架空商社', requestedOn: '2026-10-24', reply: { kind: 'none' } });
const pending = (s: Snapshot): Pending => ({ progress: 'saving', unknownSince: null, savingSince: at, baseRevision: 0, opId: 'op20', opLabel: '架空依頼', fingerprint: 'f', values: {}, actor: '架空担当A', startedAt: at, units: [{ ledger: s.ledger, supply: s.supply, conflictReviews: [], targets: [] }] });
const bytes = (text: string) => new TextEncoder().encode(text);
function backupWire(value: unknown) {
  const text = JSON.stringify(value);
  return bytes(JSON.stringify({ notice: '架空試験', format: 'fuzzy-stock-backup', version: 1, createdAt: at, crc32: crc32(bytes(`${at}\n${text}`)).toString(16).padStart(8, '0'), snapshot: text }));
}
function wires(s: Snapshot) {
  return { snapshot: JSON.parse(serialize(s)), pending: JSON.parse(serializePending(pending(s))) };
}
function accepted(s: Snapshot) {
  const wire = wires(s), before = JSON.stringify(wire);
  expect(decodeSnapshot(wire.snapshot)).toEqual(s);
  expect(decodePending(wire.pending)).toEqual(pending(s));
  expect(readBackup(backupWire(wire.snapshot))).toMatchObject({ kind: 'ok', snapshot: s });
  expect(readBackup(bytes(backupTextOf(s, at)))).toMatchObject({ kind: 'ok', snapshot: s });
  expect(JSON.stringify(wire)).toBe(before);
  return wire;
}
function rejected(wire: ReturnType<typeof wires>, reason: string) {
  const before = JSON.stringify(wire);
  expect(() => decodeSnapshot(wire.snapshot)).toThrow(reason);
  expect(() => decodePending(wire.pending)).toThrow(reason);
  const result = readBackup(backupWire(wire.snapshot));
  expect(result).toMatchObject({ kind: 'unreadable', reason: expect.stringContaining('記録の検査を通らない') });
  if (result.kind === 'unreadable') expect(result.reason).toContain(reason);
  expect(JSON.stringify(wire)).toBe(before);
}

describe('履歴表示 task6 供給側の別復号経路と業務照合', () => {
  test.each(['missing', 'unknown-outer', 'unknown-item', 'missing-name', 'number-name', 'blank-name', 'missing-code', 'number-code', 'blank-code', 'missing-id', 'extra-id', 'bad-kind', 'legacy-extra'])('supply表示欄%sは正常backup対照と同じ3境界で内側理由まで拒否する', mode => {
    const wire = accepted(initial(practiceLedger, request()));
    for (const supply of [wire.snapshot.supply, wire.pending.pending.units[0].supply]) {
      const event = supply.log[0], labels = event.itemLabels;
      if (mode === 'missing') delete event.itemLabels;
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
      if (mode === 'legacy-extra') event.itemLabels = { kind: 'legacy-unavailable', items: {} };
    }
    rejected(wire, 'itemLabels');
  });

  test.each(['missing-labels', 'unknown-body'])('needImport特殊exactKeysの%sを3境界で拒み、通常のlabels付き取込を受理する', mode => {
    const raw = JSON.stringify({ format: 'fuzzy-stock-need-row', version: 1, source: '架空資料', line: '001', revision: '01', previousRevision: null, caseCode: 'A-001', itemCode: 'P', unit: '個', required: { basis: 'label', value: 2 }, dueDate: null });
    const preview = previewNeedImport(emptySupply, practiceLedger.masters, raw), supply = applyNeedImport(emptySupply, practiceLedger.masters, meta('import'), raw, preview.token);
    const wire = accepted(initial(practiceLedger, supply));
    for (const target of [wire.snapshot.supply, wire.pending.pending.units[0].supply]) {
      if (mode === 'missing-labels') delete target.log[0].itemLabels;
      else target.log[0].extra = true;
    }
    rejected(wire, mode === 'missing-labels' ? 'itemLabels' : '欄が不正');
  });

  test('作成→回答→発注→到着→取消→訂正は改名ごとの異なる正当な当時表示を3境界で受理し数量を保つ', () => {
    let ledger = practiceLedger, supply = request();
    const rename = (id: string, name: string) => { ledger = changeMasters(ledger, meta(id), { action: 'rename', type: 'item', id: 'P', name, reason: '架空改名' }); };
    rename('rename-reply', '架空回答時P'); supply = recordReply(supply, ledger.masters, meta('reply'), 'request', { kind: 'answered', date: '2026-10-25' });
    rename('rename-order', '架空発注時P'); supply = confirmOrder(supply, ledger.masters, meta('order'), 'request');
    rename('rename-arrival', '架空到着時P');
    const received = receiveLot(ledger, supply, meta('receive'), { id: 'r', item: 'P', unit: '個', location: 'S1', project }, 'counted', 10);
    ledger = received.ledger; supply = allocateArrival(ledger, received.supply, meta('arrival'), 'request', { receiptLotId: 'r', arrived: 8, good: 7 });
    rename('rename-cancel', '架空取消時P'); supply = cancelRequest(supply, ledger.masters, meta('cancel'), 'request', '架空取消');
    rename('rename-revise', '架空訂正時P'); supply = reviseArrival(ledger, supply, meta('revise'), 'request', 'arrival', { arrived: 7, good: 6 });
    const before = initial(ledger, supply), wire = accepted(before);
    for (const [id, name] of [['request', '架空部品P'], ['reply', '架空回答時P'], ['order', '架空発注時P'], ['receive-c', '架空到着時P'], ['arrival', '架空到着時P'], ['cancel', '架空取消時P'], ['revise', '架空訂正時P']]) {
      expect(supply.log.find(e => e.eventId === id)).toHaveProperty('itemLabels.items.P', { name, code: 'P' });
    }
    expect(supply.requests.request).toMatchObject({ quantity: 10, orderConfirmedBy: 'order', cancelled: { eventId: 'cancel' }, arrivals: [{ receiptLotId: 'r', arrived: 7, good: 6 }] });
    expect(requestProgressOf(ledger.masters, supply.requests.request!)).toEqual({ arrived: 7, good: 6, outstanding: null });
    expect(supply.receipts.r?.received).toBe(10);
    expect(decodeSnapshot(wire.snapshot)).toEqual(before);
  });

  test('labelsが正当でも履歴のないcurrent取消は独立した業務replayで3境界拒否する', () => {
    const wire = accepted(initial(practiceLedger, request()));
    for (const supply of [wire.snapshot.supply, wire.pending.pending.units[0].supply]) supply.requests.request.cancelled = { eventId: 'missing-cancel', reason: '架空取消' };
    rejected(wire, '依頼の履歴と現在値が一致しない');
  });
});
