import { emptySupply, recordRequest, registerNeed, type Supply } from '../domain/supply.ts';
import { practiceLedger, hold, recordProvisional, register, split, use, type Ledger, type Meta, type Project } from '../domain/ledger.ts';

const actor = '架空担当A';

function meta(eventId: string, time: string): Meta {
  const at = `2026-09-29T${time}:00+09:00`;
  return { eventId, occurredAt: at, recordedAt: at, actor };
}

const a001: Project = { kind: 'case', id: 'A-001' };

// 開始時点の現物を登録するだけで、過去の受入を作らない（RUN-01）。
// 品目Pは仕様書11章の品目詳細の表示例（基準は10時の実数確認100、30使用、2不良隔離）。
export function seedLedger(): Ledger {
  let l = register(practiceLedger, meta('s01', '10:00'), { id: 'P-001', item: 'P', unit: '個', project: a001, location: 'S1' }, 'counted', 100);
  l = use(l, meta('s02', '10:30'), 'P-001', 'counted', 30, 'A-001 架空作業W1');
  l = split(l, meta('s03', '11:00'), 'P-001', 'P-001-D', 'counted', 2);
  l = hold(l, meta('s04', '11:00'), 'P-001-D', 'defective');
  l = register(l, meta('s05', '09:00'), { id: 'P-002', item: 'P', unit: '個', project: { kind: 'case', id: 'A-002' }, location: 'S2' }, 'label', 50);
  l = register(l, meta('s06', '09:00'), { id: 'P-003', item: 'P', unit: '個', project: { kind: 'common' }, location: 'T' }, 'approximate', 0);
  l = register(l, meta('s07', '09:00'), { id: 'P-004', item: 'P', unit: '個', project: { kind: 'unassigned' }, location: 'S2' }, 'unknown', null);
  // 先頭ゼロのIDは文字列のまま保つ（INP-02a）。
  l = register(l, meta('s08', '09:00'), { id: '0012', item: 'Q', unit: '個', project: a001, location: 'S1' }, 'counted', 0);
  l = register(l, meta('s09', '09:00'), { id: 'Q-002', item: 'Q', unit: '個', project: { kind: 'common' }, location: 'S1' }, 'label', 0);
  l = register(l, meta('s10', '09:00'), { id: 'R-001', item: 'R', unit: '台', project: a001, location: 'T' }, 'counted', 3);
  l = register(l, meta('s11', '09:00'), { id: 'S-001', item: 'S', unit: '本', project: { kind: 'common' }, location: 'S1' }, 'approximate', 2200);
  l = register(l, meta('s12', '09:00'), { id: 'S-002', item: 'S', unit: '箱', project: { kind: 'common' }, location: 'S2' }, 'counted', 2);
  return recordProvisional(l, meta('s13', '09:30'), {
    direction: 'found',
    item: null,
    location: 'T',
    basis: 'unknown',
    value: null,
    note: '品目不明の箱（架空の読取文字列 0012-AB）',
  });
}

// SCN-02（中身の不足・交換・ネジ補充）の初期状態（FH-B02）。案件B-001の品目Pの必要数100、ラベル100個の現物、
// 共通ネジの既存の補充依頼1箱。実数98への訂正、不良の隔離、追加依頼、交換品の受入などは、利用者が画面から記録する。
// 既存の初期データ（seedLedger。ネジS-001・S-002を含む）とは別の数え方なので、混ぜない。
export function seedScn02(): { ledger: Ledger; supply: Supply } {
  const at = '2026-09-29T08:00:00+09:00';
  const m = (eventId: string, time: string): Meta => ({ eventId, occurredAt: `2026-09-29T${time}:00+09:00`, recordedAt: at, actor });
  const ledger = register(practiceLedger, m('sc-r1', '08:00'), { id: 'P-B01', item: 'P', unit: '個', project: { kind: 'case', id: 'B-001' }, location: 'S1' }, 'label', 100);
  let supply = registerNeed(emptySupply, ledger.masters, m('sc-n1', '07:00'), {
    project: { kind: 'case', id: 'B-001' },
    item: 'P',
    unit: '個',
    required: { basis: 'counted', value: 100 },
    dueDate: '2026-10-10',
    source: '架空の必要部品一覧',
    revision: '初版',
  });
  supply = recordRequest(supply, ledger.masters, m('sc-q1', '07:30'), { project: { kind: 'common' }, item: 'S', unit: '箱', quantity: 1, vendor: '架空の仕入先X', requestedOn: '2026-09-29', reply: { kind: 'none' } });
  return { ledger, supply };
}
