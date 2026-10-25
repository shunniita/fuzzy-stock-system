import { adoptProvisional, ConfirmationRequired, hold, identifyProvisional, occurredAtOf, type Ledger, type Meta } from './ledger.ts';
import { refOf } from './masters.ts';

type NewReturnLot = Parameters<typeof adoptProvisional>[3];
export type ReturnAssignment = { issueId: string; reason: string; confirmed: boolean } & (
  | { kind: 'included'; lotId: string }
  | { kind: 'notIncluded'; lot: NewReturnLot }
);

export function assignReturnedProvisional(ledger: Ledger, meta: Meta, request: ReturnAssignment): Ledger {
  if (request.reason.trim() === '') throw new Error('返ってきた物の割当理由を入力する');
  const foundAt = occurredAtOf(ledger, request.issueId);
  if (foundAt !== null && meta.occurredAt !== null && Date.parse(foundAt) > Date.parse(meta.occurredAt)) throw new Error('返ってきた物の仮の記録より前の日時には割り当てない');
  if (request.kind === 'included') return identifyProvisional(ledger, meta, request.issueId, request.lotId, request.reason, request.confirmed);
  const adopted = adoptProvisional(ledger, meta, request.issueId, request.lot, true);
  if (!request.confirmed) {
    const origin = ledger.history.find(e => e.eventId === request.issueId);
    const item = origin?.kind === 'provisional' ? origin.item : null;
    const candidates = Object.values(ledger.lots).filter(l => l.item === request.lot.item && l.mergedInto === null).map(l => l.id);
    throw new ConfirmationRequired('adopt', `仮の記録の品目「${item === null ? '不明' : refOf(ledger.masters.items, item)}」と今回の品目「${refOf(ledger.masters.items, request.lot.item)}」・単位「${request.lot.unit}」を照合し、返ってきた物が現在の記録上の数に含まれていないことを確認する。同じ元の現物でも、出庫で減った分の返ってきた物は未包含として登録する。登録後は使用可否確認待ち`, candidates);
  }
  return hold(adopted, { ...meta, eventId: `${meta.eventId}-return-hold` }, request.lot.id, 'usabilityCheck', request.reason);
}
