import { describe, expect, test } from 'vitest';
import { practiceLedger, type Ledger, type Meta } from '../../src/domain/ledger.ts';
import { deleteReceiptTemplate, receiveTemplate, saveReceiptTemplate, type ReceiptRoute, type ReceiptTemplate } from '../../src/domain/receipt-template.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { backupTextOf, crc32, readBackup } from '../../src/ui/backup.ts';
import { initial, parse, serialize, serializePending, type Pending, type Snapshot } from '../../src/ui/storage.ts';
import { decodePending, decodeSnapshot } from '../../src/ui/storageparse.ts';

const at = '2026-10-24T09:00:00+09:00';
const meta = (eventId: string): Meta => ({ eventId, occurredAt: at, recordedAt: at, actor: '架空担当A' });
const ledger: Ledger = { ...practiceLedger, masters: { ...practiceLedger.masters, items: { ...practiceLedger.masters.items,
  X: { ...practiceLedger.masters.items.R!, id: 'X', code: 'X', name: '架空組立X' },
} } };
const row = (item: string, unit: string, perSet: number) => ({ item, unit, perSet, location: 'S1' });
const child: ReceiptTemplate = { id: 'child', name: '架空組立Xの構成', product: 'X', productUnit: '台', project: null, basis: 'counted', rows: [row('P', '個', 2), row('Q', '個', 3)] };
const parent: ReceiptTemplate = { id: 'parent', name: '架空製品Rの構成', product: 'R', productUnit: '台', project: null, basis: 'label', rows: [row('P', '個', 2), { ...row('X', '台', 1), assembly: child }] };
const pending = (s: Snapshot): Pending => ({ progress: 'saving', unknownSince: null, savingSince: at, baseRevision: 0, opId: 'receive', opLabel: '架空組立受入', fingerprint: 'f', values: {}, actor: '架空担当A', startedAt: at, units: [{ ledger: s.ledger, supply: s.supply, conflictReviews: [], targets: [] }] });
function received(route: ReceiptRoute = 'parts'): Snapshot {
  let supply = saveReceiptTemplate(ledger, emptySupply, meta('child-save'), child);
  supply = saveReceiptTemplate(ledger, supply, meta('parent-save'), parent);
  const values = route === 'parts' ? [20, 20, 30] : [20, 10];
  const state = receiveTemplate({ ledger, supply }, meta('receive'), parent.id, { kind: 'case', id: 'A-001' }, 10, values.map(quantity => ({ quantity, shortfall: 0 })), null, ['assembled', route]);
  return initial(state.ledger, state.supply);
}
function snapshotBackup(value: Snapshot): Uint8Array {
  const text = JSON.stringify(value), bytes = new TextEncoder();
  const envelope = { notice: '架空試験', format: 'fuzzy-stock-backup', version: 1, createdAt: at, crc32: crc32(bytes.encode(`${at}\n${text}`)).toString(16).padStart(8, '0'), snapshot: text };
  return bytes.encode(JSON.stringify(envelope));
}
function rejectsAtThreeBoundaries(value: Snapshot, reason: string): void {
  expect(() => decodeSnapshot(value)).toThrow(reason);
  expect(() => decodePending({ format: 'fuzzy-stock-pending', version: 11, pending: pending(value) })).toThrow(reason);
  const backup = readBackup(snapshotBackup(value));
  expect(backup).toMatchObject({ kind: 'unreadable', reason: expect.stringContaining('記録の検査を通らない') });
  if (backup.kind === 'unreadable') expect(backup.reason).toContain(reason);
}

describe('履歴表示 task3 版9の組立構成と受け取り経路', () => {
  test.each(['assembled', 'parts'] as const)('%s経路の構成・出力単位・当時表示をsnapshot/pending/backupで往復する', route => {
    const s = received(route), wire = serialize(s), source = s.supply.log.find(e => e.kind === 'templateReceipt')!;
    expect(parse(wire)).toEqual(s);
    expect(decodePending(JSON.parse(serializePending(pending(s))))).toEqual(pending(s));
    expect(readBackup(new TextEncoder().encode(backupTextOf(s, at)))).toMatchObject({ kind: 'ok', snapshot: s });
    expect(source).toHaveProperty('routes', ['assembled', route]);
    expect(source).toHaveProperty('template.productUnit', '台');
    expect(source).toHaveProperty('template.rows.1.assembly.productUnit', '台');
    expect(source.itemLabels.kind).toBe('recorded');
    if (source.itemLabels.kind === 'recorded') expect(Object.keys(source.itemLabels.items).sort()).toEqual(['P', 'Q', 'R', 'X']);
    expect(Object.values(s.ledger.lots).map(l => l.item)).toEqual(route === 'parts' ? ['P', 'P', 'Q'] : ['P', 'X']);
    expect(Object.hasOwn(parse(wire).supply.receiptTemplates.parent!.rows[0]!, 'assembly')).toBe(false);
  });
  test('元子を変更・削除した後も、保存親と受け取りに固定した子の版を保つ', () => {
    const s = received();
    let supply = saveReceiptTemplate(s.ledger, s.supply, meta('child-edit'), { ...child, name: '架空変更後', rows: [row('P', '個', 4)] });
    supply = deleteReceiptTemplate(supply, s.ledger.masters, meta('child-delete'), child.id);
    const next = initial(s.ledger, supply), decoded = parse(serialize(next));
    expect(decoded).toEqual(next);
    expect(decoded.supply.receiptTemplates.parent!.rows[1]!.assembly).toEqual(child);
    expect(decoded.supply.log.find(e => e.kind === 'templateReceipt')).toHaveProperty('template.rows.1.assembly', child);
  });
  test.each(['missing-route', 'invalid-route', 'output-unit', 'child-unit', 'height', 'row-limit', 'tree-limit'] as const)('%sを3保存境界で拒否する', mode => {
    const s = received();
    expect(readBackup(snapshotBackup(s))).toMatchObject({ kind: 'ok', snapshot: s });
    const value = JSON.parse(JSON.stringify(s));
    const source = value.supply.log.find((e: { kind: string }) => e.kind === 'templateReceipt');
    if (mode === 'missing-route') delete source.routes;
    if (mode === 'invalid-route') source.routes[1] = 'unknown';
    if (mode === 'output-unit') source.template.productUnit = '箱';
    if (mode === 'child-unit') source.template.rows[1].assembly.productUnit = '個';
    if (mode === 'height') source.template.rows[1].assembly.rows[0].assembly = child;
    if (mode === 'row-limit') source.template.rows = Array.from({ length: 51 }, () => row('P', '個', 1));
    if (mode === 'tree-limit') source.template.rows = Array.from({ length: 10 }, () => ({ ...row('X', '台', 1), assembly: { ...child, rows: Array.from({ length: 50 }, () => row('P', '個', 1)) } }));
    const reasons = { 'missing-route': '経路', 'invalid-route': 'routes', 'output-unit': '単位', 'child-unit': '単位', height: '高さ', 'row-limit': '明細は', 'tree-limit': '全構成は' };
    rejectsAtThreeBoundaries(value, reasons[mode]);
  });
  test.each(['productUnit', 'assembly', 'routes'] as const)('旧版8へ新しい%s欄だけを混ぜた場合も黙って落とさない', field => {
    const { productUnit: _, ...flat } = child;
    const supply = saveReceiptTemplate(ledger, emptySupply, meta('flat-save'), flat);
    const state = receiveTemplate({ ledger, supply }, meta('flat-receive'), child.id, { kind: 'case', id: 'A-001' }, 10, [20, 30].map(quantity => ({ quantity, shortfall: 0 })), null);
    const s = initial(state.ledger, state.supply);
    const value = JSON.parse(JSON.stringify({ ...s, version: 8 }, (key, entry: unknown) => key === 'consumable' || key === 'itemLabels' ? undefined : entry));
    expect(() => decodeSnapshot(value)).not.toThrow();
    if (field === 'productUnit') value.supply.receiptTemplates.child.productUnit = '台';
    if (field === 'assembly') value.supply.receiptTemplates.child.rows[0].assembly = child;
    if (field === 'routes') value.supply.log.find((e: { kind: string }) => e.kind === 'templateReceipt').routes = ['assembled', 'assembled'];
    expect(() => decodeSnapshot(value)).toThrow('欄が不正');
  });
});
