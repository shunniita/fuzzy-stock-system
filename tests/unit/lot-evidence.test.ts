import { fixedMasters } from '../../src/domain/masters.ts';
import { describe, expect, test } from 'vitest';
import { readCode } from '../../src/domain/code.ts';
import { assignProject, beginAlternativeRecord, correctOccurredAt, practiceLedger, merge, move, register, split, start, transferProject, use, voidRecord, type Lot, type Meta } from '../../src/domain/ledger.ts';
import { allocateArrival, cancelRequest, confirmOrder, emptySupply, receiveLot, recordReply, recordRequest, reviseArrival, reviseReceipt } from '../../src/domain/supply.ts';
import { lotEvidenceOf } from '../../src/ui/lot-evidence.ts';

const meta = (eventId: string, hour = 11): Meta => ({ eventId, actor: '架空入力A', occurredAt: `2026-09-29T${String(hour).padStart(2, '0')}:00:00+09:00`, recordedAt: '2026-10-14T05:20:00+09:00' });
const lot = (id: string): Pick<Lot, 'id' | 'item' | 'unit' | 'location' | 'project'> => ({ id, item: 'P', unit: '個', location: 'S1', project: { kind: 'case', id: 'A-001' } });
const source = (entry = '001') => ({ source: '架空原票\n<原文>', entry, originalActor: '架空記入B' });
const base = () => register(practiceLedger, meta('reg', 9), lot('p'), 'counted', 20);
const receipt = () => receiveLot(beginAlternativeRecord(practiceLedger, meta('receive', 10), 'receive', source(), ['P']), emptySupply, meta('receive', 10), lot('p'), 'label', 20, '001\n<ラベル>');
const request = { project: lot('p').project, item: 'P', unit: '個', quantity: 30, vendor: '架空仕入先', requestedOn: '2026-09-29', reply: { kind: 'none' } } as const;

function allocated() {
  let { ledger, supply } = receipt();
  supply = recordRequest(supply, fixedMasters, meta('req1', 9), request);
  supply = recordRequest(supply, fixedMasters, meta('req2', 9), { ...request, vendor: '架空別仕入先' });
  supply = recordRequest(supply, fixedMasters, meta('unallocated', 9), request);
  supply = allocateArrival(ledger, supply, meta('a1'), 'req1', { receiptLotId: 'p', arrived: 8, good: 7 });
  supply = allocateArrival(ledger, supply, meta('a2'), 'req2', { receiptLotId: 'p', arrived: 12, good: 11 });
  ({ ledger, supply } = receiveLot(ledger, supply, meta('other-receive', 10), lot('other'), 'counted', 9));
  supply = allocateArrival(ledger, supply, meta('other-arrival'), 'req1', { receiptLotId: 'other', arrived: 9, good: 9 });
  return { ledger, supply };
}

describe('物品詳細の証拠reader', () => {
  test('存在しない現物と、存在するが証拠のない現物を区別する', () => {
    expect(lotEvidenceOf(base(), emptySupply, 'absent')).toBeNull();
    expect(lotEvidenceOf(base(), emptySupply, 'p')).toEqual({ sources: [], scans: [], receipt: null, receiptHistory: [], requests: [] });
  });

  test('使用と移動の元の資料を操作IDで結び、似たIDの別現物へ混ぜない', () => {
    let ledger = register(base(), meta('reg-other', 9), lot('p-more'), 'counted', 20);
    ledger = use(beginAlternativeRecord(ledger, meta('u'), 'use', source(), ['P']), meta('u'), 'p', 'counted', 3, '架空作業');
    ledger = move(beginAlternativeRecord(ledger, meta('u-more'), 'move', source('002'), ['P']), meta('u-more'), 'p-more', 'S2');
    expect(lotEvidenceOf(ledger, emptySupply, 'p')?.sources).toMatchObject([{ record: { source: source(), operationId: 'u' }, operation: { kind: 'use', lotId: 'p', value: 3 }, materialUses: [] }]);
    expect(lotEvidenceOf(ledger, emptySupply, 'p-more')?.sources.map(s => s.operation.eventId)).toEqual(['u-more']);
  });

  test('材料付き作業の開始の元の資料は仕掛と各材料から参照し、別材料の使用を混ぜない', () => {
    let ledger = register(base(), meta('reg-q', 9), { ...lot('q'), item: 'Q' }, 'counted', 20);
    ledger = beginAlternativeRecord(ledger, meta('start', 12), 'start', source(), ['P', 'Q', 'R']);
    ledger = use(ledger, meta('up1'), 'p', 'counted', 2, '架空組立');
    ledger = use(ledger, meta('uq'), 'q', 'counted', 1, '架空組立');
    ledger = use(ledger, meta('up2'), 'p', 'counted', 3, '架空組立');
    ledger = start(ledger, meta('start', 12), { ...lot('r'), item: 'R', unit: '台' }, { id: 'R組立', criterion: 'inspection' }, 'counted', 1, ['up1', 'uq', 'up2']);
    expect(lotEvidenceOf(ledger, emptySupply, 'r')?.sources).toMatchObject([{ operation: { eventId: 'start' }, materialUses: [] }]);
    expect(lotEvidenceOf(ledger, emptySupply, 'p')?.sources[0]?.materialUses.map(e => e.eventId)).toEqual(['up1', 'up2']);
    expect(lotEvidenceOf(ledger, emptySupply, 'q')?.sources[0]?.materialUses.map(e => e.eventId)).toEqual(['uq']);
  });

  test('日時訂正・取消後も元の資料と元操作を保持する', () => {
    let ledger = use(beginAlternativeRecord(base(), meta('u'), 'use', source(), ['P']), meta('u'), 'p', 'counted', 3, '架空作業');
    ledger = correctOccurredAt(ledger, meta('time', 12), 'u', '2026-09-29T11:30:00+09:00');
    ledger = voidRecord(ledger, meta('void', 13), 'u', '架空の誤記訂正');
    expect(lotEvidenceOf(ledger, emptySupply, 'p')?.sources).toMatchObject([{ record: { eventId: 'u-alternative', source: source() }, operation: { eventId: 'u', occurredAt: meta('u').occurredAt } }]);
  });

  test.each(['included', 'unknown'] as const)('未反映の使用(%s)も元の資料の対応を失わない', answer => {
    const m = meta('late', 8);
    const ledger = use(beginAlternativeRecord(base(), m, 'use', source(), ['P']), m, 'p', 'counted', 3, '架空の遅れた記録', answer);
    expect(lotEvidenceOf(ledger, emptySupply, 'p')?.sources).toMatchObject([{ operation: { applied: false, inclusion: answer, changes: [] } }]);
  });

  test('読取原文と対象操作の日時訂正の読取を保ち、別現物の読取を除く', () => {
    const scan = readCode('001\n<原文>', practiceLedger.masters);
    let ledger = register(practiceLedger, { ...meta('r', 9), scan }, lot('p'), 'counted', 20);
    ledger = register(ledger, { ...meta('other', 9), scan: readCode('OTHER', ledger.masters) }, lot('q'), 'counted', 10);
    ledger = correctOccurredAt(ledger, { ...meta('time', 12), scan }, 'r', '2026-09-29T08:00:00+09:00');
    expect(lotEvidenceOf(ledger, emptySupply, 'p')?.scans.map(e => [e.eventId, e.scan?.raw])).toEqual([['r', scan.raw], ['time', scan.raw]]);
  });

  test('実受け取りを現在数と区別し、明示割り当てした複数依頼だけを参照する', () => {
    let { ledger, supply } = allocated();
    ledger = use(ledger, meta('use', 12), 'p', 'counted', 3, '架空作業');
    const evidence = lotEvidenceOf(ledger, supply, 'p');
    expect(evidence?.receipt).toMatchObject({ received: 20, status: 'provisional', label: '001\n<ラベル>' });
    expect(ledger.lots['p']?.quantity).toMatchObject({ numeric: { value: 17 } });
    expect(evidence?.sources[0]?.operation).toMatchObject({ kind: 'register', eventId: 'receive' });
    expect(evidence?.requests.map(r => r.request.id)).toEqual(['req1', 'req2']);
    expect(evidence?.requests[0]?.arrivals).toEqual([{ id: 'a1', receiptLotId: 'p', arrived: 8, good: 7 }]);
    expect(evidence?.requests[0]?.history.map(e => e.eventId)).toEqual(['req1', 'a1']);
  });

  test('受け取り・割り当ての前後、回答・確認・依頼取消の履歴と現在値を別々に返す', () => {
    let { ledger, supply } = allocated();
    supply = confirmOrder(supply, fixedMasters, meta('confirm'), 'req1');
    supply = recordReply(supply, fixedMasters, meta('reply'), 'req1', { kind: 'answered', date: '2026-09-30' });
    supply = reviseArrival(ledger, supply, meta('rev-arrival', 12), 'req1', 'a1', { arrived: 0, good: 0 });
    supply = reviseReceipt(ledger, supply, meta('rev-receipt', 12), 'p', 15, '架空の数え直し');
    supply = cancelRequest(supply, fixedMasters, meta('cancel', 13), 'req1', '架空の依頼取消');
    const evidence = lotEvidenceOf(ledger, supply, 'p');
    expect(evidence?.receipt).toMatchObject({ received: 15, status: 'confirmed' });
    expect(evidence?.receiptHistory.map(e => e.kind)).toEqual(['receiptRecord', 'receiptRevise']);
    expect(evidence?.requests[0]?.arrivals).toMatchObject([{ arrived: 0, good: 0 }]);
    expect(evidence?.requests[0]?.request).toMatchObject({ reply: { kind: 'answered' }, cancelled: { reason: '架空の依頼取消' } });
    expect(evidence?.requests[0]?.history.map(e => e.eventId)).toEqual(['req1', 'a1', 'confirm', 'reply', 'rev-arrival', 'cancel']);
  });

  test('数が不明の受け取りは0にせず、仮受け取りの使い切りと使用取消の現在状態を導出する', () => {
    const unknown = receiveLot(practiceLedger, emptySupply, meta('unknown'), lot('u'), 'unknown', null);
    expect(lotEvidenceOf(unknown.ledger, unknown.supply, 'u')?.receipt).toMatchObject({ received: null, status: 'unconfirmed' });
    let { ledger, supply } = receipt();
    ledger = use(ledger, meta('all', 12), 'p', 'counted', 20, '架空作業');
    expect(supply.receipts['p']?.provisional).toBe(true);
    expect(lotEvidenceOf(ledger, supply, 'p')?.receipt?.status).toBe('confirmed');
    ledger = voidRecord(ledger, meta('void', 13), 'all', '架空の記録誤り');
    expect(lotEvidenceOf(ledger, supply, 'p')?.receipt?.status).toBe('provisional');
  });

  test('分割や統合の子に祖先の元の資料と全受け取り量を混入しない', () => {
    let { ledger, supply } = allocated();
    ledger = split(ledger, meta('split', 12), 'p', 'child', 'counted', 5);
    ledger = merge(ledger, meta('merge', 13), 'p', 'child');
    expect(lotEvidenceOf(ledger, supply, 'child')).toMatchObject({ sources: [], receipt: null, receiptHistory: [], requests: [] });
    expect(lotEvidenceOf(ledger, supply, 'p')?.receipt?.received).toBe(20);
    expect(lotEvidenceOf(ledger, supply, 'p')?.requests.map(r => r.request.id)).toEqual(['req1', 'req2']);
  });

  test('場所変更・案件・用途振替で元の受け取りと依頼の対応を入れ替えない', () => {
    let { ledger, supply } = allocated();
    ledger = move(ledger, meta('move', 12), 'p', 'S2');
    ledger = transferProject(ledger, meta('transfer', 13), 'p', 'transferred', { kind: 'case', id: 'A-002' }, 'counted', 5);
    const evidence = lotEvidenceOf(ledger, supply, 'p');
    expect(evidence?.receipt?.received).toBe(20);
    expect(evidence?.requests.map(r => r.request.project)).toEqual([request.project, request.project]);
    expect(lotEvidenceOf(ledger, supply, 'transferred')).toMatchObject({ receipt: null, requests: [], sources: [] });
  });

  test('読み取りは台帳・供給の保存対象データを変えない', () => {
    const { ledger, supply } = allocated(), before = JSON.stringify({ ledger, supply });
    for (const id of ['p', 'other', 'missing']) lotEvidenceOf(ledger, supply, id);
    expect(JSON.stringify({ ledger, supply })).toBe(before);
  });

  test('所属不明の受け取りを案件・用途へ結び付けても元の資料と受け取りは同じ現物に残る', () => {
    let { ledger, supply } = receiveLot(beginAlternativeRecord(practiceLedger, meta('r'), 'receive', source(), ['P']), emptySupply, meta('r'), { ...lot('p'), project: { kind: 'unassigned' } }, 'counted', 5);
    ledger = assignProject(ledger, meta('assign', 12), 'p', request.project, '架空ラベルの照合', true);
    supply = recordRequest(supply, fixedMasters, meta('not-related'), request);
    expect(lotEvidenceOf(ledger, supply, 'p')).toMatchObject({ sources: [{ operation: { eventId: 'r' } }], receipt: { received: 5 }, requests: [] });
  });
});
