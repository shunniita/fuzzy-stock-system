import { practiceLedger, type EventDetail, type LedgerEvent, type Lot, type Meta, type Stop } from '../../src/domain/ledger.ts';
import { emptySupply, type Declaration, type Need, type Request, type SupplyDetail } from '../../src/domain/supply.ts';
import { quantityOf, observe } from '../../src/domain/quantity.ts';
import type { ReceiptTemplate } from '../../src/domain/receipt-template.ts';
import type { NeedImportInput } from '../../src/domain/need-import.ts';
import { type HistoryTargetContext, type LedgerTargetEvent, type SupplyTargetEvent } from '../../src/domain/history-targets.ts';

const meta = (eventId: string): Meta => ({ eventId, actor: '架空担当A', occurredAt: null, recordedAt: '2026-10-24T09:00:00+09:00' });
const quantity = quantityOf(observe('fictional-observation', 'label', 10));
const lot = (id: string, item: string): Lot => ({ id, item, unit: '個', project: { kind: 'common' }, location: 'S1', quantity, lastCount: null, splitFrom: null, mergedInto: null, holds: [], stage: { kind: 'none' } });
const event = <D extends EventDetail>(id: string, detail: D, changes: LedgerEvent['changes'] = []): Meta & D & { changes: LedgerEvent['changes'] } => ({ ...meta(id), ...detail, changes });
const supplyEvent = <D extends SupplyDetail>(id: string, detail: D): Meta & D => ({ ...meta(id), ...detail });
const decrease = { basis: 'label', value: 1, applied: false, inclusion: null } satisfies Pick<Extract<EventDetail, { kind: 'use' }>, 'basis' | 'value' | 'applied' | 'inclusion'>;
const useP = event('use-P', { ...decrease, kind: 'use', lotId: 'p', usedFor: '架空使用先' });
const useQ = event('use-Q', { ...decrease, kind: 'use', lotId: 'q', usedFor: '架空使用先' });
const registerS = event('register-S', { kind: 'register' }, [{ before: null, after: lot('s', 'S') }]);
const provisional = event('provisional', { kind: 'provisional', direction: 'found', item: 'S', location: null, basis: 'unknown', value: null, note: '架空の確認待ち' });
const rework = event('rework', { ...decrease, kind: 'rework', lotId: 'r', childId: 'child', reason: '架空理由' }, [{ before: lot('r', 'R'), after: lot('r', 'R') }, { before: null, after: lot('child', 'R') }]);
const recount = event('count', { kind: 'recount', lotId: 'r', value: 10, compared: quantity, cause: { kind: 'unknown' }, difference: quantity, applied: false, inclusion: null, answeredFor: [] });
const handover = event('handover', { ...decrease, kind: 'handover', lotId: 'q', counterpart: '架空返却先' });
const stop: Stop = { id: 'stop', process: '架空工程', item: 'R', unit: '台', project: { kind: 'common' }, reason: '架空不足', shortage: { item: 'S', unit: '本', value: null }, affected: null, resumedBy: null };
const need: Need = { id: 'need', item: 'P', unit: '個', project: { kind: 'case', id: 'A-001' }, required: { basis: 'label', value: 10 }, dueDate: null, source: '架空資料', revision: '01' };
const declaration: Declaration = { id: 'declaration', item: 'Q', unit: '個', project: { kind: 'common' }, value: null, reason: '架空不足', linked: false };
const request: Request = { id: 'request', item: 'P', unit: '個', project: { kind: 'common' }, quantity: 1, vendor: '架空商社', requestedOn: '2026-10-24', orderConfirmedBy: null, reply: { kind: 'none' }, cancelled: null, arrivals: [] };
const arrival = { id: 'arrival', receiptLotId: 'q', arrived: 1, good: 1 };
const input: NeedImportInput = { raw: '架空原文 品目コードFAKE', row: { format: 'fuzzy-stock-need-row', version: 1, source: '架空資料', line: '001', revision: '01', previousRevision: null, caseCode: 'A-001', itemCode: 'FAKE', unit: '個', required: { basis: 'unknown', value: null }, dueDate: null } };
const heldImport = supplyEvent('import', { kind: 'needImport', input, decision: { kind: 'hold', reasons: ['架空の未確認'], candidates: ['need'] } });
const child: ReceiptTemplate = { id: 'child', name: '架空組立X', product: 'X', productUnit: '個', project: null, basis: 'label', rows: [{ item: 'S', unit: '本', perSet: 1, location: 'S1' }] };
const template: ReceiptTemplate = { id: 'parent', name: '架空製品R', product: 'R', productUnit: '台', project: null, basis: 'label', rows: [{ item: 'Q', unit: '個', perSet: 2, location: 'S1' }, { item: 'X', unit: '個', perSet: 1, location: 'S1', assembly: child }] };
const context: HistoryTargetContext = { ledger: { ...practiceLedger, lots: Object.fromEntries([lot('p', 'P'), lot('q', 'Q'), lot('r', 'R'), lot('s', 'S'), lot('child', 'R'), lot('subject', 'X')].map(l => [l.id, l])),
  history: [useP, useQ, registerS, provisional, rework, recount, handover], stops: { stop }, issues: { provisional: { id: 'provisional', lotId: null, reason: 'unassigned', resolution: null }, 'use-P@time': { id: 'use-P@time', lotId: 'p', reason: 'timeCorrected', resolution: null } } },
  supply: { ...emptySupply, needs: { need }, declarations: { declaration }, requests: { request }, log: [heldImport] },
};

const ledgerCases = {
  register: { event: registerS, ids: ['S'] },
  move: { event: event('move', { kind: 'move' }, [{ before: lot('p', 'P'), after: lot('p', 'P') }]), ids: ['P'] },
  merge: { event: event('merge', { kind: 'merge' }, [{ before: lot('p', 'P'), after: lot('q', 'Q') }]), ids: ['P', 'Q'] },
  master: { event: event('master', { kind: 'master', action: 'rename', reason: null, confirmed: false, masters: [{ before: practiceLedger.masters.items['P']!, after: { ...practiceLedger.masters.items['P']!, name: '架空新名' } }] }), ids: [] },
  identify: { event: event('identify', { kind: 'identify', issueId: 'provisional', lotId: 'p', reason: '架空確認' }), ids: ['P', 'S'] },
  adopt: { event: event('adopt', { kind: 'adopt', issueId: 'provisional', lotId: 'new' }, [{ before: null, after: lot('new', 'Q') }]), ids: ['Q', 'S'] },
  assignProject: { event: event('assign', { kind: 'assignProject', lotId: 'p', before: { kind: 'common' }, after: { kind: 'case', id: 'A-001' }, reason: '架空確認' }), ids: ['P'] },
  recount: { event: { ...recount, answeredFor: ['use-Q'] }, ids: ['Q', 'R'] },
  hold: { event: event('hold', { kind: 'hold', reason: 'spare', note: null }, [{ before: lot('p', 'P'), after: lot('p', 'P') }]), ids: ['P'] },
  release: { event: event('release', { kind: 'release', reason: 'spare', note: '架空の解除' }, [{ before: lot('p', 'P'), after: lot('p', 'P') }]), ids: ['P'] },
  resolve: { event: event('resolve', { kind: 'resolve', issueId: 'provisional', outcome: 'close', inclusion: null, countedBy: 'count' }), ids: ['R', 'S'] },
  correctTime: { event: event('time', { kind: 'correctTime', targetEventId: 'use-P', previous: null, corrected: null }), ids: ['P'] },
  declare: { event: event('declare', { kind: 'declare', lotId: 'p', note: 'FAKEは品目ではない' }), ids: ['P'] },
  provisional: { event: provisional, ids: ['S'] },
  start: { event: event('start', { kind: 'start', lotId: 'new-product', materials: ['use-P', 'use-Q', 'use-P'] }, [{ before: null, after: lot('new-product', 'R') }]), ids: ['P', 'Q', 'R'] },
  reworkPart: { event: event('part', { kind: 'reworkPart', action: 'replace', reworkId: 'rework', subjectLotId: 'subject', useEventId: 'use-P', reason: '架空部品処置' }), ids: ['P', 'R', 'X'] },
  void: { event: event('void', { kind: 'void', targetEventId: 'use-Q', lotId: 'p', applied: false, reason: '架空訂正' }), ids: ['P', 'Q'] },
  stop: { event: event('stop', { kind: 'stop', stop }), ids: ['R', 'S'] },
  stopUpdate: { event: event('stop-edit', { kind: 'stopUpdate', stopId: 'stop', previous: null, affected: 1 }), ids: ['R', 'S'] },
  resume: { event: event('resume', { kind: 'resume', stopId: 'stop' }), ids: ['R', 'S'] },
  use: { event: useP, ids: ['P'] },
  handover: { event: handover, ids: ['Q'] },
  split: { event: event('split', { ...decrease, kind: 'split', lotId: 'r', childId: 'child' }), ids: ['R'] },
  transfer: { event: event('transfer', { ...decrease, kind: 'transfer', lotId: 'r', childId: 'child', from: { kind: 'common' }, to: { kind: 'case', id: 'A-001' } }), ids: ['R'] },
  rework: { event: rework, ids: ['R'] },
  stage: { event: event('stage', { ...decrease, kind: 'stage', lotId: 'r', childId: 'child', to: { kind: 'working', process: { id: '架空工程', criterion: 'workEnd' } }, correction: false }), ids: ['R'] },
  alternativeRecord: { event: event('alternative', { kind: 'alternativeRecord', operation: 'use', operationId: 'use-P', source: { source: '架空資料', entry: '001', originalActor: '架空担当A' } }), ids: ['P'] },
} satisfies Record<LedgerTargetEvent['kind'], { event: LedgerTargetEvent; ids: string[] }>;
const supplyCases = {
  receiptTemplateSave: { event: supplyEvent('template-save', { kind: 'receiptTemplateSave', before: { ...template, rows: [{ item: 'P', unit: '個', perSet: 1, location: 'S1' }] }, after: template }), ids: ['P', 'Q', 'R', 'S', 'X'] },
  receiptTemplateDelete: { event: supplyEvent('template-delete', { kind: 'receiptTemplateDelete', before: template }), ids: ['Q', 'R', 'S', 'X'] },
  templateReceipt: { event: supplyEvent('template-receipt', { kind: 'templateReceipt', template, project: { kind: 'common' }, sets: 1, vendor: null, rows: [{ lotId: 'q', quantity: 2, shortfall: 0 }, { lotId: null, quantity: 0, shortfall: 0 }], routes: ['assembled', 'assembled'] }), ids: ['Q', 'R', 'S', 'X'] },
  needImport: { event: heldImport, ids: ['P'] },
  needImportResolve: { event: supplyEvent('import-resolve', { kind: 'needImportResolve', importEventId: 'import', reason: '架空の照合', resolution: { kind: 'apply', before: need, after: { ...need, item: 'S' } } }), ids: ['P', 'S'] },
  needRegister: { event: supplyEvent('need', { kind: 'needRegister', need }), ids: ['P'] },
  needRevise: { event: supplyEvent('need-edit', { kind: 'needRevise', before: need, after: { ...need, item: 'Q' } }), ids: ['P', 'Q'] },
  shortageDeclare: { event: supplyEvent('shortage', { kind: 'shortageDeclare', declaration }), ids: ['Q'] },
  declarationLink: { event: supplyEvent('declaration-link', { kind: 'declarationLink', declarationId: 'declaration', linked: true }), ids: ['Q'] },
  requestRecord: { event: supplyEvent('request', { kind: 'requestRecord', request }), ids: ['P'] },
  orderConfirm: { event: supplyEvent('order', { kind: 'orderConfirm', requestId: 'request' }), ids: ['P'] },
  replyRecord: { event: supplyEvent('reply', { kind: 'replyRecord', requestId: 'request', before: { kind: 'none' }, after: { kind: 'answered', date: '2026-10-25' } }), ids: ['P'] },
  requestCancel: { event: supplyEvent('cancel', { kind: 'requestCancel', requestId: 'request', reason: '架空の取消' }), ids: ['P'] },
  receiptRecord: { event: supplyEvent('receipt', { kind: 'receiptRecord', lotId: 'p', received: 1, provisional: true, label: '架空ラベル' }), ids: ['P'] },
  receiptRevise: { event: supplyEvent('receipt-edit', { kind: 'receiptRevise', lotId: 'q', before: null, after: 1, provisional: false, reason: '架空訂正' }), ids: ['Q'] },
  arrival: { event: supplyEvent('arrival', { kind: 'arrival', requestId: 'request', arrival }), ids: ['P', 'Q'] },
  arrivalRevise: { event: supplyEvent('arrival-edit', { kind: 'arrivalRevise', requestId: 'request', before: arrival, after: { ...arrival, receiptLotId: 's' } }), ids: ['P', 'Q', 'S'] },
  remainder: { event: supplyEvent('remainder', { kind: 'remainder', lotId: 's', level: 'half' }), ids: ['S'] },
  returnAck: { event: supplyEvent('ack', { kind: 'returnAck', handoverEventId: 'handover' }), ids: ['Q'] },
  usageEstimate: { event: supplyEvent('estimate', { kind: 'usageEstimate', startEventId: 'start', template, sets: 2, rows: [{ calculated: 4, confirmed: 4, decision: 'use', uses: ['start-u1'] }, { calculated: 2, confirmed: null, decision: 'exclude', uses: [] }] }), ids: ['Q', 'R', 'S', 'X'] },
} satisfies Record<SupplyTargetEvent['kind'], { event: SupplyTargetEvent; ids: string[] }>;


export { context, ledgerCases, supplyCases };
