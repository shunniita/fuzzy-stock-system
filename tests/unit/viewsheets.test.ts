import { describe, expect, test } from 'vitest';
import { fixedMasters } from '../../src/domain/masters.ts';
import { correctOccurredAt, declareDiscrepancy, merge, recount, register, start, use, voidRecord, type Ledger, type Lot, type Meta } from '../../src/domain/ledger.ts';
import { allocateArrival, cancelRequest, emptySupply, receiveLot, recordReply, recordRequest, reviseArrival, reviseNeed, reviseReceipt, type Supply } from '../../src/domain/supply.ts';
import { observe, quantityOf } from '../../src/domain/quantity.ts';
import { jst, quantityText, totalsOf, totalsText } from '../../src/ui/format.ts';
import { needQuantityText, replyText } from '../../src/ui/supply-format.ts';
import { seedLedger, seedScn02 } from '../../src/ui/seed.ts';
import { processes } from '../../src/domain/ledger.ts';
import type { Sheet } from '../../src/ui/xlsx.ts';
import { viewSheetsOf } from '../../src/ui/viewsheets.ts';
import { meta } from './record-fixture.ts';

const created = '2026-10-07T15:30:00+09:00';

function sheetOf(sheets: Sheet[], name: string): { header: string[]; rows: Record<string, string>[] } {
  const found = sheets.find(s => s.name === name);
  if (!found) throw new Error(`シートがない：${name}`);
  const header = found.columns.map(c => c.header);
  return { header, rows: found.rows.map(row => Object.fromEntries(row.map((text, i) => [header[i] ?? '', text]))) };
}

function rowOf(sheets: Sheet[], sheet: string, key: string, id: string): Record<string, string> {
  const row = sheetOf(sheets, sheet).rows.find(r => r[key] === id);
  if (!row) throw new Error(`行がない：${sheet}/${id}`);
  return row;
}

const rich = (): { ledger: Ledger; supply: typeof emptySupply } => {
  let ledger = seedLedger();
  const process = processes[0];
  if (!process) throw new Error('試験用の工程がない');
  ledger = start(ledger, meta('t1'), { id: 'R-W1', item: 'R', unit: '台', project: { kind: 'case', id: 'A-001' }, location: 'T' }, process, 'counted', 1, []);
  ledger = declareDiscrepancy(ledger, meta('t2'), 'P-001', '架空の差異');
  return { ledger, supply: emptySupply };
};

describe('FH-F1A-03・F1-A 4.2〜4.4・4.12・5.3: 説明・集計・保管単位・元の記録のシート', () => {
  const state = rich();
  const sheets = viewSheetsOf(state, created);

  test('説明のシートが最初にあり、閲覧用で復元には使えないことを先頭に書く', () => {
    expect(sheets[0]?.name).toBe('説明');
    const { rows } = sheetOf(sheets, '説明');
    expect(rows[0]?.['内容']).toMatch(/^閲覧用の出力（復元には使えない）/);
    const text = rows.map(r => `${r['項目']}：${r['内容']}`).join('\n');
    expect(text).toContain('復元用バックアップ');
    expect(text).toContain('このブラウザーに保存された記録の写し');
    expect(text).toContain('2026-10-07 15:30（日本時間）');
    expect(text).toContain('集計');
    expect(text).toContain('長い値');
    expect(text).toContain('箱・束など、ひとまとまりとして記録する現物');
    expect(text).toContain('数量の単位（個・本・箱など）とは別');
  });

  test('説明のシートが、各シートの各列の意味と、不明・なし・約・中身未確認・計算値の表し方を書く', () => {
    const { rows } = sheetOf(sheets, '説明');
    const items = rows.map(r => r['項目']);
    for (const name of ['集計', '保管単位', '元の記録']) {
      const found = sheets.find(s => s.name === name);
      for (const column of found?.columns ?? []) expect(items).toContain(`${name}「${column.header}」`);
    }
    for (const word of ['不明', 'なし', '約', '中身未確認', '計算値']) expect(items).toContain(word);
  });

  test('保管単位：数が不明な場合は「不明」で0や空欄でなく、0と区別され、根拠が分かる', () => {
    const unknown = rowOf(sheets, '保管単位', '保管単位ID', 'P-004');
    expect(unknown).toMatchObject({ 数量の状態: '不明', 数値: '不明', だいたい: 'なし', 数量の根拠: '数が不明', 中身未確認: '対象外' });
    const zero = rowOf(sheets, '保管単位', '保管単位ID', '0012');
    expect(zero).toMatchObject({ 数量の状態: '分かっている', 数値: '0', 数量の根拠: '数えた' });
    const approximateZero = rowOf(sheets, '保管単位', '保管単位ID', 'P-003');
    expect(approximateZero).toMatchObject({ 数値: '0', だいたい: 'だいたいの数を含む', 数量の根拠: 'だいたい' });
    expect(rowOf(sheets, '保管単位', '保管単位ID', 'P-002')).toMatchObject({ 数値: '50', だいたい: '含まない', 数量の根拠: '表示の数（ラベル・パッケージ）' });
  });

  test('保管単位：先頭が0のIDは文字列のまま、案件・用途・取り分けた理由・作業の状態・確認が必要な件数が出る', () => {
    expect(sheetOf(sheets, '保管単位').rows.map(r => r['保管単位ID'])).toContain('0012');
    const defective = rowOf(sheets, '保管単位', '保管単位ID', 'P-001-D');
    expect(defective['取り分けた理由']).toBe('不良');
    expect(rowOf(sheets, '保管単位', '保管単位ID', 'P-001')).toMatchObject({ 案件・用途: '案件・用途A-001', 確認が必要な件数: '1', 記録上の数の表示: expect.stringContaining('記録上の数') });
    expect(rowOf(sheets, '保管単位', '保管単位ID', 'P-001')['数量の根拠']).toMatch(/^計算値/);
    expect(rowOf(sheets, '保管単位', '保管単位ID', 'R-W1')['作業の状態']).toBe('工程R組立・作業中');
    expect(rowOf(sheets, '保管単位', '保管単位ID', 'P-001-D')['分割元']).toBe('P-001');
    expect(rowOf(sheets, '保管単位', '保管単位ID', 'P-001')['分割元']).toBe('なし');
  });

  test('保管単位：統合済みの保管単位は出さない。一部不明の数量は、数値部分と不明の件数が分かる', () => {
    const added = register(state.ledger, meta('m0'), { id: 'P-005', item: 'P', unit: '個', project: { kind: 'case', id: 'A-002' }, location: 'S2' }, 'unknown', null);
    const merged = merge(added, meta('m1'), 'P-005', 'P-002');
    const out = viewSheetsOf({ ledger: merged, supply: emptySupply }, created);
    const ids = sheetOf(out, '保管単位').rows.map(r => r['保管単位ID']);
    expect(ids).not.toContain('P-005');
    const row = rowOf(out, '保管単位', '保管単位ID', 'P-002');
    expect(row).toMatchObject({ 数量の状態: '一部不明', 数値: '50' });
    expect(row['記録上の数の表示']).toContain('数が不明1件');
  });

  test('保管単位：数値部分がない一部不明は「なし」、中身未確認の程度が出る', () => {
    const lot = state.ledger.lots['P-002'];
    if (!lot) throw new Error('試験用データがない');
    const unknownTerm = { sign: 1 as const, observation: observe('u1', 'unknown', null) };
    const synthetic: Lot = { ...lot, id: 'X-1', quantity: { kind: 'partlyUnknown', numeric: null, unknownParts: [{ kind: 'unknown', before: null, terms: [unknownTerm] }], terms: [unknownTerm] } };
    const partial: Lot = { ...lot, id: 'X-2', quantity: { kind: 'known', numeric: { value: 3, approximate: true, unconfirmed: 'partial' }, computed: true, terms: [{ sign: 1, observation: observe('a', 'approximate', 3) }, { sign: 1, observation: observe('b', 'label', 0) }] } };
    const all: Lot = { ...lot, id: 'X-3', quantity: quantityOf(observe('c', 'label', 8)) };
    const ledger: Ledger = { ...state.ledger, lots: { ...state.ledger.lots, 'X-1': synthetic, 'X-2': partial, 'X-3': { ...all, quantity: { kind: 'known', numeric: { value: 8, approximate: false, unconfirmed: 'all' }, computed: false, terms: all.quantity.terms } } } };
    const out = viewSheetsOf({ ledger, supply: emptySupply }, created);
    expect(rowOf(out, '保管単位', '保管単位ID', 'X-1')).toMatchObject({ 数量の状態: '一部不明', 数値: 'なし' });
    expect(rowOf(out, '保管単位', '保管単位ID', 'X-2')).toMatchObject({ 中身未確認: '一部', だいたい: 'だいたいの数を含む' });
    expect(rowOf(out, '保管単位', '保管単位ID', 'X-2')['数量の根拠']).toBe('計算値（だいたい・表示の数（ラベル・パッケージ））');
    expect(rowOf(out, '保管単位', '保管単位ID', 'X-3')['中身未確認']).toBe('全部');
  });

  test('元の記録：保管単位の記録上の数の計算に使った記録が、保管単位ごとに一行ずつ出る', () => {
    const rows = sheetOf(sheets, '元の記録').rows;
    const p001 = state.ledger.lots['P-001'];
    if (!p001) throw new Error('試験用データがない');
    const mine = rows.filter(r => r['保管単位ID'] === 'P-001');
    expect(mine.length).toBe(p001.quantity.terms.length);
    expect(mine.map(r => r['操作ID'])).toEqual(p001.quantity.terms.map(t => t.observation.id));
    expect(mine.map(r => r['符号'])).toEqual(p001.quantity.terms.map(t => (t.sign === 1 ? '＋' : '－')));
    const unknown = rows.filter(r => r['保管単位ID'] === 'P-004');
    expect(unknown[0]).toMatchObject({ 値: '不明', 根拠: '数が不明' });
    expect(rows.filter(r => r['保管単位ID'] === '0012')[0]).toMatchObject({ 値: '0', 根拠: '数えた' });
  });

  test('集計：画面の集計と同じ値と文言で、単位の違う数を足さず、不明を0にしない', () => {
    const rows = sheetOf(sheets, '集計').rows;
    const lots = Object.values(state.ledger.lots).filter(l => l.mergedInto === null);
    const expected = totalsOf(state.ledger, lots);
    expect(rows.map(r => `${r['品目']}/${r['単位']}`)).toEqual(expected.map(t => `${t.item}/${t.unit}`));
    for (const t of expected) {
      const row = rows.find(r => r['品目'] === t.item && r['単位'] === t.unit);
      expect(row?.['在庫']).toBe(quantityText(t.onHand, t.unit));
      expect(row?.['使用可能']).toBe(quantityText(t.usable, t.unit));
      expect(row?.['取り分け']).toBe(quantityText(t.excluded, t.unit));
      expect(row?.['確認が必要な件数']).toBe(String(t.issueCount));
      expect(totalsText(fixedMasters, t)).toContain(row?.['在庫'] ?? '見つからない');
    }
    const p = rows.find(r => r['品目'] === 'P');
    expect(p?.['在庫']).toContain('数が不明');
    expect(p?.['備考']).toContain('使用可能数として断定しない');
    expect(rows.filter(r => r['品目'] === 'S').map(r => r['単位']).sort()).toEqual(['本', '箱']);
  });

  test('どのシートにも空のセルがなく、行の長さが列と同じ', () => {
    for (const s of [...sheets, ...viewSheetsOf(seedScn02(), created), ...viewSheetsOf({ ledger: seedLedger(), supply: emptySupply }, created)]) {
      for (const row of s.rows) {
        expect(row.length).toBe(s.columns.length);
        for (const text of row) expect(text).not.toBe('');
      }
    }
  });
});

// 数えて確認・取消・日時の訂正・未反映の使用と、必要な数の改訂・実際に受け取った数の訂正・割り当ての訂正・依頼の回答と取消を持つ架空の記録。
const t = (eventId: string, hhmm: string): Meta => ({ eventId, occurredAt: `2026-10-05T${hhmm}:00+09:00`, recordedAt: `2026-10-05T${hhmm}:00+09:00`, actor: '架空担当A' });

function corrected(): { ledger: Ledger; supply: Supply } {
  const base = seedScn02();
  let ledger = recount(base.ledger, meta('rc1'), 'P-B01', 98, { kind: 'stated', text: '架空の原因' });
  ledger = use(ledger, t('u1', '11:00'), 'P-B01', 'counted', 5, '架空作業');
  ledger = correctOccurredAt(ledger, meta('ct1'), 'u1', '2026-10-05T10:30:00+09:00');
  ledger = voidRecord(ledger, t('v1', '12:00'), 'u1', '架空の誤り');
  ledger = use(ledger, t('u2', '13:00'), 'P-B01', 'counted', 500, '架空の大きな使用');
  let supply = reviseNeed(base.supply, fixedMasters, t('nr1', '14:00'), 'sc-n1', { required: { basis: 'counted', value: 120 }, dueDate: '2026-10-12', source: '架空の必要部品一覧', revision: '第2版' });
  ({ ledger, supply } = receiveLot(ledger, supply, t('rl1', '14:10'), { id: '0099', item: 'P', unit: '個', project: { kind: 'case', id: 'B-001' }, location: 'S1' }, 'label', 10, null));
  supply = reviseReceipt(ledger, supply, t('rr1', '14:20'), '0099', 9, '数えた');
  supply = recordRequest(supply, fixedMasters, t('rq2', '14:30'), { project: { kind: 'case', id: 'B-001' }, item: 'P', unit: '個', quantity: 20, vendor: '架空の仕入先Y', requestedOn: '2026-10-05', reply: { kind: 'none' } });
  supply = recordRequest(supply, fixedMasters, t('rq3', '14:40'), { project: { kind: 'case', id: 'B-001' }, item: 'P', unit: '個', quantity: 6, vendor: '架空の仕入先Z', requestedOn: '2026-10-05', reply: { kind: 'answered', date: '2026-10-09' } });
  supply = recordReply(supply, fixedMasters, t('rp1', '14:50'), 'sc-q1', { kind: 'estimated', date: '2026-10-08' });
  supply = allocateArrival(ledger, supply, t('al1', '15:00'), 'rq3', { receiptLotId: '0099', arrived: 4, good: 4 });
  supply = reviseArrival(ledger, supply, t('ar1', '15:10'), 'rq3', 'al1', { arrived: 5, good: 4 });
  supply = cancelRequest(supply, fixedMasters, t('cx1', '15:20'), 'rq2', '架空の不要');
  return { ledger, supply };
}

describe('FH-F1A-03・F1-A 4.6・4.7: 訂正の前後・理由・担当・日時・反映、依頼の回答の状態と未着', () => {
  test('FH-F1A-03: 取消後に使用しても、取消した時点の数量70→80と根拠を出力する', () => {
    let ledger = register(seedLedger(), t('v-register', '09:00'), { id: '取消の試験', item: 'P', unit: '個', project: { kind: 'common' }, location: 'S1' }, 'counted', 100);
    ledger = use(ledger, t('v-use1', '10:00'), '取消の試験', 'counted', 10, '架空作業');
    ledger = use(ledger, t('v-use2', '11:00'), '取消の試験', 'counted', 20, '架空作業');
    ledger = voidRecord(ledger, t('v-cancel', '12:00'), 'v-use1', '架空の誤り');
    ledger = use(ledger, t('v-use3', '13:00'), '取消の試験', 'counted', 10, '架空作業');
    const row = rowOf(viewSheetsOf({ ledger, supply: emptySupply }, created), '台帳の履歴', '操作ID', 'v-cancel');
    expect(row['訂正の前']).toMatch(/取消の試験：.*70個/);
    expect(row['訂正の後']).toMatch(/取消の試験：.*80個/);
    expect(row['訂正の前']).toContain('数えた');
    expect(row['訂正の後']).toContain('数えた');
    expect(row['訂正の前']).toContain('操作v-use1');
  });

  const state = corrected();
  const sheets = viewSheetsOf(state, created);
  const history = sheetOf(sheets, '台帳の履歴').rows;
  const byId = (id: string) => history.find(r => r['操作ID'] === id);

  test('台帳の履歴：全操作が一行ずつ、古い順に出る', () => {
    expect(history.map(r => r['操作ID'])).toEqual(state.ledger.history.map(e => e.eventId));
  });

  test('数えて確認：訂正の前（それまでの記録上の数）・後・理由・担当・入力した日時・反映が出る', () => {
    const recounted = state.ledger.history.find(e => e.eventId === 'rc1');
    if (recounted?.kind !== 'recount') throw new Error('試験用データがない');
    expect(byId('rc1')).toMatchObject({ 種類: '数えて確認', 訂正の前: quantityText(recounted.compared, '個'), 訂正の後: '98個（数えた）', 訂正の理由: '架空の原因', 反映: '反映した', 担当: '架空担当A', 入力した日時: jst('2026-10-05T10:00:00+09:00') });
  });

  test('反映しなかった操作は、反映しなかったと分かる', () => {
    expect(byId('u2')?.['反映']).toBe('反映しなかった（親から減らしていない）');
    expect(byId('u1')?.['反映']).toBe('反映した');
  });

  test('確認事項が開いて数量に反映しなかった数え直しは、反映しなかったと分かる', () => {
    const history = state.ledger.history.map(e => (e.eventId === 'rc1' && e.kind === 'recount' ? { ...e, applied: false, changes: [] } : e));
    const out = viewSheetsOf({ ledger: { ...state.ledger, history }, supply: state.supply }, created);
    expect(sheetOf(out, '台帳の履歴').rows.find(r => r['操作ID'] === 'rc1')?.['反映']).toBe('反映しなかった（確認事項あり）');
  });

  test('依頼の回答の記録：回答の前と後の状態が出る', () => {
    const row = sheetOf(sheets, '供給の履歴').rows.find(r => r['操作ID'] === 'rp1');
    expect(row).toMatchObject({ 訂正の前: '未回答', 訂正の後: '推定の予定日2026-10-08' });
  });

  test('間違えた記録の取り消し：取消した操作・理由・反映と、取り消された側の取消の欄', () => {
    expect(byId('v1')).toMatchObject({ 種類: '間違えた記録の取り消し', 訂正の理由: '架空の誤り' });
    expect(byId('v1')?.['訂正の前']).toContain('操作u1');
    expect(byId('v1')?.['反映']).toMatch(/^反映した|^反映しなかった/);
    expect(byId('u1')?.['取消']).toBe('v1');
    expect(byId('rc1')?.['取消']).toBe('なし');
  });

  test('実際の日時の訂正：訂正の前後の日時と、訂正された操作の実際の日時（訂正前も）', () => {
    expect(byId('ct1')).toMatchObject({ 訂正の前: jst('2026-10-05T11:00:00+09:00'), 訂正の後: jst('2026-10-05T10:30:00+09:00') });
    expect(byId('u1')).toMatchObject({ 実際の日時: jst('2026-10-05T10:30:00+09:00'), 訂正前の実際の日時: jst('2026-10-05T11:00:00+09:00') });
    expect(byId('rc1')?.['訂正前の実際の日時']).toBe('なし');
  });

  test('供給の履歴：必要な数の改訂・実際に受け取った数の訂正・割り当ての訂正の前後と理由が出る', () => {
    const supplyRows = sheetOf(sheets, '供給の履歴').rows;
    expect(supplyRows.map(r => r['操作ID'])).toEqual(state.supply.log.map(e => e.eventId));
    const need = supplyRows.find(r => r['操作ID'] === 'nr1');
    const revised = state.supply.log.find(e => e.eventId === 'nr1');
    if (revised?.kind !== 'needRevise') throw new Error('試験用データがない');
    expect(need?.['訂正の前']).toContain(needQuantityText(revised.before.required, revised.before.unit));
    expect(need?.['訂正の後']).toContain(needQuantityText(revised.after.required, revised.after.unit));
    expect(need?.['訂正の後']).toContain('第2版');
    expect(supplyRows.find(r => r['操作ID'] === 'rr1')).toMatchObject({ 訂正の前: '10', 訂正の後: '9', 訂正の理由: '数えた' });
    expect(supplyRows.find(r => r['操作ID'] === 'ar1')?.['訂正の前']).toContain('到着4');
    expect(supplyRows.find(r => r['操作ID'] === 'ar1')?.['訂正の後']).toContain('到着5');
    expect(supplyRows.find(r => r['操作ID'] === 'al1')?.['訂正の前']).toBe('なし');
  });

  test('依頼：回答の三状態（未回答・推定の予定日・相手が回答した予定日）と、届いた数・未着の数・取消', () => {
    const requests = sheetOf(sheets, '依頼').rows;
    const q = (id: string) => requests.find(r => r['依頼ID'] === id);
    expect(q('sc-q1')).toMatchObject({ 回答の状態: replyText({ kind: 'estimated', date: '2026-10-08' }), 届いた数: '0', 未着の数: '1', 取消: 'なし' });
    expect(q('rq2')).toMatchObject({ 回答の状態: '未回答', 未着の数: 'なし', 取消: expect.stringContaining('架空の不要') });
    expect(q('rq3')).toMatchObject({ 回答の状態: '相手が回答した予定日2026-10-09', 依頼数: '6', 届いた数: '5', 使える数: '4', 未着の数: '1' });
    expect(q('sc-q1')?.['依頼先']).toBe('架空の仕入先X');
  });

  test('説明のシートが、履歴と依頼のシートの各列も説明する', () => {
    const items = sheetOf(sheets, '説明').rows.map(r => r['項目']);
    for (const name of ['台帳の履歴', '供給の履歴', '依頼']) {
      expect(sheets.map(s => s.name)).toContain(name);
      for (const column of sheets.find(s => s.name === name)?.columns ?? []) expect(items).toContain(`${name}「${column.header}」`);
    }
    const all = sheetOf(sheets, '説明').rows.map(r => `${r['項目']}：${r['内容']}`).join('\n');
    for (const word of ['反映しなかった', '取消']) expect(all).toContain(word);
  });

  test('空のセルがなく、行の長さが列と同じ', () => {
    for (const s of sheets) for (const row of s.rows) { expect(row.length).toBe(s.columns.length); for (const text of row) expect(text).not.toBe(''); }
  });
});
