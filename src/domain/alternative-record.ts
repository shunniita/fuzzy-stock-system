import type { Ledger, Meta } from './ledger.ts';
import type { Supply } from './supply.ts';

export type AlternativeOperation = 'use' | 'move' | 'start' | 'receive';
export type AlternativeSource = { source: string; entry: string; originalActor: string };
export type AlternativeRecord = { kind: 'alternativeRecord'; operation: AlternativeOperation; operationId: string; source: AlternativeSource };

export function checkAlternativeSource(source: AlternativeSource): void {
  for (const [label, value] of [['資料識別', source.source], ['動きの番号', source.entry]]) {
    if (!value?.trim() || value !== value.trim()) throw new Error(`${label}は空でなく前後の空白なしで入力する`);
  }
  if (!source.originalActor.trim()) throw new Error('原票記入者を入力する');
}

function sameOriginalMeta(a: Meta, b: Meta): boolean {
  return a.actor === b.actor && a.occurredAt === b.occurredAt && a.recordedAt === b.recordedAt;
}

export function validateAlternativeRecords(ledger: Ledger, supply: Supply): void {
  const records = ledger.history.filter(e => e.kind === 'alternativeRecord');
  if (records.length === 0) return;
  const events = new Map(ledger.history.map((event, index) => [event.eventId, { event, index }]));
  const receipts = new Map(supply.log.map(event => [event.eventId, event]));
  if (events.size !== ledger.history.length || receipts.size !== supply.log.length) throw new Error('元の資料に対応する操作IDが重複している');
  const sources = new Set<string>(), operations = new Set<string>(), evidenceIds = new Set<string>();
  for (const record of records) {
    checkAlternativeSource(record.source);
    const key = JSON.stringify([record.source.source, record.source.entry]);
    if (sources.has(key) || operations.has(record.operationId)) throw new Error('元の資料または対応する操作が重複している');
    sources.add(key); operations.add(record.operationId); evidenceIds.add(record.eventId);
    if (record.eventId !== `${record.operationId}-alternative` || record.changes.length !== 0) throw new Error('元の資料の識別証拠のIDまたは現物変更が不正');
    const target = events.get(record.operationId), marker = events.get(record.eventId);
    if (!target || !marker || target.index <= marker.index || target.event.kind !== (record.operation === 'receive' ? 'register' : record.operation) || !sameOriginalMeta(record, target.event)) {
      throw new Error(`元の資料に対応する操作 ${record.operationId} の種別・順序・元の日時・担当が一致しない`);
    }
    if (record.operation === 'receive') {
      const receipt = receipts.get(`${record.operationId}-c`), change = target.event.changes[0];
      if (receipt?.kind !== 'receiptRecord' || target.event.changes.length !== 1 || !change || change.before !== null || receipt.lotId !== change.after.id || !sameOriginalMeta(record, receipt)) {
        throw new Error(`元の資料に対応する受け取り ${record.operationId} の現物と受け取り記録が一致しない`);
      }
    }
  }
  if (ledger.history.some(e => e.kind === 'correctTime' && evidenceIds.has(e.targetEventId))) throw new Error('元の資料の識別証拠自体の日時は訂正できない');
}
