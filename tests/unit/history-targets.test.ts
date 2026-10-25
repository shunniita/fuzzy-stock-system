import { describe, expect, test } from 'vitest';
import { practiceLedger, type EventDetail, type LedgerEvent, type Lot, type Meta, type Stop } from '../../src/domain/ledger.ts';
import { emptySupply, type Declaration, type Need, type Request, type SupplyDetail } from '../../src/domain/supply.ts';
import { quantityOf, observe } from '../../src/domain/quantity.ts';
import type { ReceiptTemplate } from '../../src/domain/receipt-template.ts';
import type { NeedImportInput } from '../../src/domain/need-import.ts';
import { createHistoryTargetCollector, ledgerEventItemIds, supplyEventItemIds, type HistoryTargetContext, type LedgerTargetEvent, type SupplyTargetEvent } from '../../src/domain/history-targets.ts';

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
const none: HistoryTargetContext = { ledger: null, supply: null };

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

describe('対象品目列挙 task2 全判別子の明示契約', () => {
  test.each(Object.values(ledgerCases).map(value => [value.event.kind, value.event, value.ids] satisfies [string, LedgerTargetEvent, string[]]))('台帳 %s', (_kind, entry, ids) => {
    expect(ledgerEventItemIds(entry, context)).toEqual(ids);
  });
  test.each(Object.values(supplyCases).map(value => [value.event.kind, value.event, value.ids] satisfies [string, SupplyTargetEvent, string[]]))('供給 %s', (_kind, entry, ids) => {
    expect(supplyEventItemIds(entry, context)).toEqual(ids);
  });
  test('masterの前後値とscanの埋込み証拠は別正本なので空の対象集合を許す', () => {
    const entry = { ...ledgerCases.master.event, scan: JSON.parse('{"raw":"FAKE","item":"P"}'), itemLabels: { kind: 'recorded', items: { FAKE: { name: '架空', code: null } } } };
    expect(ledgerEventItemIds(entry, none)).toEqual([]);
    const unknown = { ...provisional, item: null, scan: entry.scan, note: 'PやRのような文字列', itemLabels: entry.itemLabels } satisfies LedgerTargetEvent & { itemLabels: unknown };
    expect(ledgerEventItemIds(unknown, none)).toEqual([]);
  });
  test('新規の変更前後は追記前contextに現物がなくても品目を取得できる', () => {
    expect(ledgerEventItemIds(registerS, none)).toEqual(['S']);
    const entry = event('changes', { kind: 'merge' }, [{ before: lot('old', '001'), after: lot('new', '002') }, { before: null, after: lot('newer', '001') }]);
    expect(ledgerEventItemIds(entry, none)).toEqual(['001', '002']);
  });
  test.each(['recover', 'discard'] as const)('やり直し・修理部品 %s は対象枝・親と処置元の品目を列挙する', action => {
    const detail: EventDetail = action === 'recover'
      ? { kind: 'reworkPart', action, reworkId: 'rework', subjectLotId: 'subject', registerEventId: 'register-S', reason: '架空回収' }
      : { kind: 'reworkPart', action, reworkId: 'rework', subjectLotId: 'subject', item: 'P', unit: '個', value: 1, reason: '架空廃棄' };
    expect(ledgerEventItemIds(event('part', detail), context)).toEqual(action === 'recover' ? ['R', 'S', 'X'] : ['P', 'R', 'X']);
  });
  test('対象枝欄のない旧やり直し・修理部品も親と処置元を列挙し、枝を推測しない', () => {
    expect(ledgerEventItemIds(event('part', { kind: 'reworkPart', action: 'replace', reworkId: 'rework', useEventId: 'use-P', reason: '架空の旧記録' }), context)).toEqual(['P', 'R']);
  });
  test('返ってきた物のやり直し・修理は新規割当元の仮の記録も参照する', () => {
    const adopt = event('adopt-source', { kind: 'adopt', issueId: 'provisional', lotId: 'child' });
    const entry = { ...rework, returnSource: { adoptEventId: 'adopt-source', process: { id: '架空工程', criterion: 'workEnd' }, confirmedPhysical: true } } satisfies LedgerTargetEvent;
    expect(ledgerEventItemIds(entry, { ...context, ledger: { ...context.ledger!, history: [...context.ledger!.history, adopt] } })).toEqual(['R', 'S']);
  });
  test('日時訂正由来の確認事項ID@timeは既存originOfと同じ元操作を参照する', () => {
    const entry = event('resolve-time', { kind: 'resolve', issueId: 'use-P@time', outcome: 'close', inclusion: null, countedBy: null });
    expect(ledgerEventItemIds(entry, context)).toEqual(['P']);
  });
  test.each(['create', 'revise', 'unchanged'] as const)('取込 %s の適用前後を取得し、未解決raw codeをIDにしない', kind => {
    const detail: SupplyDetail = { kind: 'needImport', input, decision: kind === 'create' ? { kind, before: null, after: need } : { kind, before: need, after: { ...need, item: 'Q' } } };
    expect(supplyEventItemIds(supplyEvent('applied', detail), none)).toEqual(kind === 'create' ? ['P'] : ['P', 'Q']);
  });
  test('未解決raw codeだけの取込は空集合、取込解消は元保留の既知candidateを維持', () => {
    expect(supplyEventItemIds(supplyEvent('unknown-import', { kind: 'needImport', input, decision: { kind: 'hold', reasons: ['未解決'], candidates: [] } }), none)).toEqual([]);
    expect(supplyEventItemIds(supplyEvent('dismiss', { kind: 'needImportResolve', importEventId: 'import', reason: '架空確認', resolution: { kind: 'dismiss' } }), context)).toEqual(['P']);
  });
  test('構成参照だけの子品目を組立済み経路でも当時表示の対象へ含める', () => {
    expect(supplyEventItemIds(supplyCases.templateReceipt.event, context)).toContain('S');
  });
  test('通常decodeでは元の資料の未来参照欠落を空集合にしない', () => {
    const entry = event('alternative', { kind: 'alternativeRecord', operation: 'start', operationId: 'future-start', source: { source: '架空資料', entry: '001', originalActor: '架空担当A' } });
    expect(() => ledgerEventItemIds(entry, context)).toThrow('future-start');
    expect(ledgerEventItemIds(entry, context, { operationId: 'future-start', itemIds: ['R', 'P', 'P'] })).toEqual(['P', 'R']);
    expect(() => ledgerEventItemIds(entry, context, { operationId: 'other', itemIds: ['P'] })).toThrow();
    expect(() => ledgerEventItemIds(entry, context, { operationId: 'future-start', itemIds: [] })).toThrow();
  });
  test('実際の元の資料対応操作があるときはforwardの宣言で対象を書き換えない', () => {
    expect(ledgerEventItemIds(ledgerCases.alternativeRecord.event, context, { operationId: 'use-P', itemIds: ['FAKE'] })).toEqual(['P']);
  });
  test('前置き用forwardの結果を共有collectorへcacheして通常decodeの欠落を隠さない', () => {
    const collector = createHistoryTargetCollector(context);
    const entry = event('alternative', { kind: 'alternativeRecord', operation: 'receive', operationId: 'future-receive', source: { source: '架空資料', entry: '001', originalActor: '架空担当A' } });
    expect(collector.ledgerEventItemIds(entry, { operationId: 'future-receive', itemIds: ['P'] })).toEqual(['P']);
    expect(() => collector.ledgerEventItemIds(entry)).toThrow('future-receive');
  });
  test('共有collectorは同じsnapshotの索引・参照集合を再利用し、返却配列の変更に影響されない', () => {
    let historyReads = 0, referenceReads = 0;
    const source = event('shared', { kind: 'correctTime', targetEventId: 'register-S', previous: null, corrected: null });
    Object.defineProperty(source, 'targetEventId', { get: () => { referenceReads++; return 'register-S'; } });
    const ledger = { ...context.ledger! };
    Object.defineProperty(ledger, 'history', { get: () => { historyReads++; return [source, registerS]; } });
    const collector = createHistoryTargetCollector({ ...context, ledger });
    const first = collector.ledgerEventItemIds(source);
    first.push('FAKE');
    expect(collector.ledgerEventItemIds(event('second', { kind: 'correctTime', targetEventId: 'shared', previous: null, corrected: null }))).toEqual(['S']);
    expect(collector.ledgerEventItemIds(source)).toEqual(['S']);
    expect(historyReads).toBe(1);
    expect(referenceReads).toBe(1);
    expect(Object.isFrozen(source)).toBe(false);
    expect(Object.isFrozen(ledger)).toBe(false);
  });
  test('別snapshotでは別collectorを作り、同じ業務IDでもそのsnapshotの参照を使う', () => {
    const before = createHistoryTargetCollector(context);
    const after = createHistoryTargetCollector({ ...context, ledger: { ...context.ledger!, lots: { ...context.ledger!.lots, p: lot('p', 'Q') } } });
    expect(before.ledgerEventItemIds(useP)).toEqual(['P']);
    expect(after.ledgerEventItemIds(useP)).toEqual(['Q']);
    expect(before.ledgerEventItemIds(useP)).toEqual(['P']);
  });
  test.each([
    ['lot', event('use', { ...decrease, kind: 'use', lotId: 'missing-lot', usedFor: '架空' }), 'missing-lot'],
    ['issue', event('identify', { kind: 'identify', issueId: 'missing-issue', lotId: 'p', reason: '架空' }), 'missing-issue'],
    ['stop', event('resume', { kind: 'resume', stopId: 'missing-stop' }), 'missing-stop'],
    ['event', event('correct', { kind: 'correctTime', targetEventId: 'missing-event', previous: null, corrected: null }), 'missing-event'],
    ['material', event('start', { kind: 'start', lotId: 'r', materials: ['missing-material'] }), 'missing-material'],
  ] satisfies [string, LedgerTargetEvent, string][])('台帳の必要参照%sが欠けたら理由付きで失敗', (_type, entry, missing) => {
    expect(() => ledgerEventItemIds(entry, context)).toThrow(missing);
  });
  test.each([
    ['request', supplyEvent('cancel', { kind: 'requestCancel', requestId: 'missing-request', reason: '架空' }), 'missing-request'],
    ['declaration', supplyEvent('link', { kind: 'declarationLink', declarationId: 'missing-declaration', linked: true }), 'missing-declaration'],
    ['need', supplyEvent('import', { kind: 'needImport', input, decision: { kind: 'hold', reasons: ['架空'], candidates: ['missing-need'] } }), 'missing-need'],
    ['lot', supplyEvent('receipt', { kind: 'receiptRecord', lotId: 'missing-lot', received: 1, provisional: false, label: null }), 'missing-lot'],
    ['handover', supplyEvent('ack', { kind: 'returnAck', handoverEventId: 'missing-handover' }), 'missing-handover'],
    ['import', supplyEvent('resolve', { kind: 'needImportResolve', importEventId: 'missing-import', reason: '架空', resolution: { kind: 'dismiss' } }), 'missing-import'],
  ] satisfies [string, SupplyTargetEvent, string][])('供給の必要参照%sが欠けたら理由付きで失敗', (_type, entry, missing) => {
    expect(() => supplyEventItemIds(entry, context)).toThrow(missing);
  });
  test('必要なcontextがない場合も空集合にせず、直接値だけならcontextなしで取得', () => {
    expect(() => ledgerEventItemIds(useP, none)).toThrow();
    expect(() => supplyEventItemIds(supplyCases.orderConfirm.event, none)).toThrow();
    expect(supplyEventItemIds(supplyCases.requestRecord.event, none)).toEqual(['P']);
  });
  test('辞書の継承プロパティを業務IDの参照先にしない', () => {
    expect(() => ledgerEventItemIds(event('use', { ...decrease, kind: 'use', lotId: 'constructor', usedFor: '架空' }), context)).toThrow('constructor');
    expect(() => supplyEventItemIds(supplyEvent('cancel', { kind: 'requestCancel', requestId: '__proto__', reason: '架空' }), context)).toThrow('__proto__');
  });
  test('参照循環は理由付きで拒否し、同じ参照を別枝で再利用できる', () => {
    const a = event('a', { kind: 'correctTime', targetEventId: 'b', previous: null, corrected: null });
    const b = event('b', { kind: 'correctTime', targetEventId: 'a', previous: null, corrected: null });
    expect(() => ledgerEventItemIds(a, { ...context, ledger: { ...context.ledger!, history: [a, b] } })).toThrow('循環');
    expect(ledgerEventItemIds(ledgerCases.start.event, context)).toEqual(['P', 'Q', 'R']);
  });
  test('深い参照鎖も再帰スタックに依存せず、同じ品目集合を返す', () => {
    const chain = Array.from({ length: 10000 }, (_, i) => event(`chain-${i}`, { kind: 'correctTime', targetEventId: i === 9999 ? 'register-S' : `chain-${i + 1}`, previous: null, corrected: null }));
    expect(ledgerEventItemIds(chain[0]!, { ...context, ledger: { ...context.ledger!, history: [...chain, registerS] } })).toEqual(['S']);
  });
  test('参照するイベントIDが重複して曖昧なら拒否する', () => {
    expect(() => ledgerEventItemIds(ledgerCases.correctTime.event, { ...context, ledger: { ...context.ledger!, history: [useP, { ...useQ, eventId: 'use-P' }] } })).toThrow('重複');
  });
  test('参照元の種類が違うときは別種の履歴を代用しない', () => {
    const entry = event('start', { kind: 'start', lotId: 'r', materials: ['register-S'] });
    expect(() => ledgerEventItemIds(entry, context)).toThrow();
    expect(() => supplyEventItemIds(supplyEvent('ack', { kind: 'returnAck', handoverEventId: 'use-P' }), context)).toThrow();
  });
  test('未対応の台帳・供給・部品処置種別を空集合として通さない', () => {
    expect(() => ledgerEventItemIds(JSON.parse(JSON.stringify({ ...useP, kind: 'unsupported' })), context)).toThrow('未対応');
    expect(() => supplyEventItemIds(JSON.parse(JSON.stringify({ ...supplyCases.requestRecord.event, kind: 'unsupported' })), context)).toThrow('未対応');
    expect(() => ledgerEventItemIds(JSON.parse(JSON.stringify({ ...ledgerCases.reworkPart.event, action: 'unsupported' })), context)).toThrow('未対応');
    expect(() => supplyEventItemIds(JSON.parse(JSON.stringify({ ...heldImport, decision: { kind: 'unsupported' } })), context)).toThrow('未対応');
    expect(() => supplyEventItemIds(JSON.parse(JSON.stringify({ ...supplyCases.needImportResolve.event, resolution: { kind: 'unsupported' } })), context)).toThrow('未対応');
  });
  test('日時・現在登録情報・既存itemLabelsを対象集合の根拠にせず、入力を変えない', () => {
    const before = JSON.stringify(context);
    const entry = { ...ledgerCases.correctTime.event, occurredAt: '2030-01-01T00:00:00+09:00', itemLabels: { kind: 'recorded', items: { FAKE: { name: '架空', code: null } } } };
    expect(ledgerEventItemIds(entry, context)).toEqual(['P']);
    expect(JSON.stringify(context)).toBe(before);
  });
});
