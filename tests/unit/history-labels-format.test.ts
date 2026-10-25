import { describe, expect, test } from 'vitest';
import { changeMasters, practiceLedger, register, use, type Ledger, type LedgerEvent, type Meta } from '../../src/domain/ledger.ts';
import { emptySupply, type Supply, type SupplyEvent } from '../../src/domain/supply.ts';
import { createHistoryTargetCollector } from '../../src/domain/history-targets.ts';
import type { EventItemLabels } from '../../src/domain/history-labels.ts';
import { eventText, itemRef, itemNameText, stopText } from '../../src/ui/format.ts';
import { supplyEventText, importedNeedText } from '../../src/ui/supply-format.ts';
import { viewSheetsOf } from '../../src/ui/viewsheets.ts';
import { readCode } from '../../src/domain/code.ts';
import { scanText } from '../../src/ui/code-format.ts';
import { context, ledgerCases, supplyCases } from '../fixtures/history-display.ts';

const collector = createHistoryTargetCollector(context);
const labels = (ids: readonly string[]): EventItemLabels => ({ kind: 'recorded', items: Object.fromEntries(ids.map(id => [id, { name: `当時の架空${id}`, code: `OLD-${id}` }])) });
const currentItems = Object.fromEntries(['P', 'Q', 'R', 'S', 'X'].map(id => [id, { ...practiceLedger.masters.items.P!, id, code: `NOW-${id}`, name: `現在の架空${id}`, active: false, units: ['個', '本', '台'], unitSteps: { 個: 1 as const, 本: 1 as const, 台: 1 as const } }]));
const ledgerEvents: LedgerEvent[] = Object.values(ledgerCases).map(c => ({ ...c.event, itemLabels: labels(c.ids) }));
const sourceEvents = context.ledger!.history.map(e => ({ ...e, itemLabels: labels(collector.ledgerEventItemIds(e)) }));
const ledger: Ledger = { ...practiceLedger, ...context.ledger!, masters: { ...practiceLedger.masters, items: currentItems }, history: [...new Map([...sourceEvents, ...ledgerEvents].map(e => [e.eventId, e])).values()] };
const supplyEvents: SupplyEvent[] = Object.values(supplyCases).map(c => ({ ...c.event, itemLabels: labels(c.ids) }));
const supply: Supply = { ...emptySupply, ...context.supply!, log: supplyEvents };
const at = '2026-10-24T09:00:00+09:00';
const meta = (eventId: string): Meta => ({ eventId, occurredAt: at, recordedAt: at, actor: '架空担当A' });

describe('履歴表示 task4 全種の当時品目', () => {
  test.each(Object.values(ledgerCases))('台帳 $event.kind は本文または補足で全対象の保存済み名称とコードを示す', ({ event, ids }) => {
    const stored = ledgerEvents.find(e => e.eventId === event.eventId)!;
    const text = eventText(ledger, stored);
    for (const id of ids) { expect(text).toContain(`当時の架空${id}`); expect(text).toContain(`OLD-${id}`); }
    expect(text).not.toContain('現在の架空');
    expect(text).not.toContain('利用停止');
  });
  test.each(Object.values(supplyCases))('供給 $event.kind は間接参照・参照専用子を含む全対象の保存済み名称とコードを示す', ({ event, ids }) => {
    const stored = supplyEvents.find(e => e.eventId === event.eventId)!;
    const text = supplyEventText(ledger.masters, stored);
    for (const id of ids) { expect(text).toContain(`当時の架空${id}`); expect(text).toContain(`OLD-${id}`); }
    expect(text).not.toContain('現在の架空');
    expect(text).not.toContain('利用停止');
  });
  test.each(Object.values(ledgerCases))('旧台帳 $event.kind の対象内部IDも現在登録情報で推測補完しない', ({ event, ids }) => {
    const stored = { ...event, itemLabels: { kind: 'legacy-unavailable' } } satisfies LedgerEvent;
    const text = eventText(ledger, stored, collector);
    for (const id of ids) expect(text).toContain(`${id}（当時の名称・コード不明）`);
    expect(text).not.toContain('現在の架空'); expect(text).not.toContain('NOW-');
  });
  test.each(Object.values(supplyCases))('旧供給 $event.kind の対象内部IDも実contextから取得する', ({ event, ids }) => {
    const stored = { ...event, itemLabels: { kind: 'legacy-unavailable' } } satisfies SupplyEvent;
    const text = supplyEventText(ledger.masters, stored, collector.supplyEventItemIds(stored));
    for (const id of ids) expect(text).toContain(`${id}（当時の名称・コード不明）`);
    expect(text).not.toContain('現在の架空'); expect(text).not.toContain('NOW-');
  });
  test('旧供給の単発呼出は実対象を省略したら理由付きで拒否し、空集合へ読み替えない', () => {
    const source = supplyEvents.find(e => e.kind === 'orderConfirm')!;
    const stored = { ...source, itemLabels: { kind: 'legacy-unavailable' } } satisfies SupplyEvent;
    expect(() => supplyEventText(ledger.masters, stored)).toThrow('対象品目を実際の記録から渡す');
  });
  test('本文で既に品目を示す登録は同じ対象の注記を重ねない', () => {
    const text = eventText(ledger, ledgerEvents.find(e => e.kind === 'register')!);
    expect(text.match(/当時の架空S/g)).toHaveLength(1);
    const stored = supplyEvents.find(e => e.kind === 'needRegister')!;
    expect(supplyEventText(ledger.masters, stored).match(/当時の架空P/g)).toHaveLength(1);
  });
  test('正式コード未登録と旧当時表示不明を区別し、現在名称・コードで補わない', () => {
    const source = ledgerEvents.find(e => e.kind === 'register')!;
    const noCode = { ...source, itemLabels: { kind: 'recorded', items: { S: { name: '架空の仮品目', code: null } } } } satisfies LedgerEvent;
    const legacy = { ...source, itemLabels: { kind: 'legacy-unavailable' } } satisfies LedgerEvent;
    expect(eventText(ledger, noCode)).toContain('正式コード未登録');
    expect(eventText(ledger, noCode)).toContain('架空の仮品目');
    const text = eventText(ledger, legacy);
    expect(text).toContain('S'); expect(text).toContain('当時の名称・コード不明');
    expect(text).not.toContain('現在の架空'); expect(text).not.toContain('NOW-S');
    expect(text).not.toContain('正式コード未登録');
  });
  test.each(['orderConfirm', 'arrival', 'returnAck', 'needImportResolve'] as const)('旧供給%sも実contextから内部IDを求め、当時表示不明を示す', kind => {
    const e = supplyEvents.find(e => e.kind === kind)!;
    const legacy = { ...e, itemLabels: { kind: 'legacy-unavailable' } } satisfies SupplyEvent;
    const text = supplyEventText(ledger.masters, legacy, collector.supplyEventItemIds(legacy));
    for (const id of collector.supplyEventItemIds(e)) expect(text).toContain(`${id}（当時の名称・コード不明）`);
    expect(text).not.toContain('現在の架空');
  });
  test('入れ子の交換使用は元イベント自身の表示を使い、処置追加時点の名称へ置き換えない', () => {
    const parent = ledgerEvents.find(e => e.kind === 'reworkPart')!;
    const outer = { ...parent, itemLabels: labels(['P', 'R', 'X']) };
    const oldUse = ledger.history.find(e => e.eventId === 'use-P')!;
    const nested = { ...oldUse, itemLabels: { kind: 'recorded', items: { P: { name: '交換使用当時の架空P', code: null } } } } satisfies LedgerEvent;
    const l = { ...ledger, history: ledger.history.map(e => e.eventId === 'use-P' ? nested : e) };
    const text = eventText(l, outer);
    expect(text).toContain('交換使用当時の架空P'); expect(text).toContain('正式コード未登録');
    expect(text).toContain('当時の架空P'); expect(text).toContain('OLD-P');
  });
  test('共有の中断・取込本文の現在表示は現在登録情報のまま使える', () => {
    expect(stopText(ledger.masters, context.ledger!.stops.stop!)).toContain('NOW-R');
    expect(importedNeedText(ledger.masters, context.supply!.needs.need!)).toContain('NOW-P');
    expect(itemRef(ledger.masters, 'P')).toContain('NOW-P');
    expect(itemNameText(ledger.masters, 'P')).toContain('現在の架空P（利用停止）');
  });
  test('master前後値とscan原文・当時解釈は独立した証拠のまま表示し、業務stateを変えない', () => {
    const master = ledgerEvents.find(e => e.kind === 'master')!;
    const masterText = eventText(ledger, master);
    expect(masterText).toContain('架空部品P'); expect(masterText).toContain('架空新名');
    expect(masterText).not.toContain('OLD-P');
    const scan = readCode(' \tLABA|A-001|P\r\n', practiceLedger.masters);
    const source = ledgerEvents.find(e => e.kind === 'register')!;
    const withScan = { ...source, scan };
    const before = JSON.stringify({ ledger, supply, withScan });
    expect(eventText(ledger, withScan)).toContain(scanText(scan));
    for (const e of ledgerEvents) eventText(ledger, e, collector);
    for (const e of supplyEvents) supplyEventText(ledger.masters, e, collector.supplyEventItemIds(e));
    expect(JSON.stringify({ ledger, supply, withScan })).toBe(before);
  });
});

describe('履歴表示 task4 変更とExcel', () => {
  test('同時刻の改名・正式化・中断とコードX→Y→他品目Xでも内部IDと過去表示を保持する', () => {
    let l = changeMasters(practiceLedger, meta('new'), { action: 'register', master: { type: 'item', code: null, name: '架空の仮部品', source: null, units: ['個'], unitSteps: { 個: 1 }, trial: true } });
    const id = Object.keys(l.masters.items).find(id => !(id in practiceLedger.masters.items))!;
    l = register(l, meta('r'), { id: 'fictional-lot', item: id, unit: '個', project: { kind: 'common' }, location: 'S1' }, 'label', 10);
    const before = eventText(l, l.history.at(-1)!);
    l = changeMasters(l, meta('code-X'), { action: 'code', type: 'item', id, code: 'X', reason: '架空正式化' }, true);
    l = use(l, meta('use-X'), 'fictional-lot', 'counted', 1, '架空使用先');
    l = changeMasters(l, meta('rename'), { action: 'rename', type: 'item', id, name: '架空の現在名称', reason: '架空改名' });
    l = changeMasters(l, meta('code-Y'), { action: 'code', type: 'item', id, code: 'Y', reason: '架空変更' });
    l = changeMasters(l, meta('other-X'), { action: 'register', master: { type: 'item', code: 'X', name: '架空の別品目', source: null, units: ['個'], unitSteps: { 個: 1 }, trial: true } });
    l = changeMasters(l, meta('stop'), { action: 'deactivate', type: 'item', id, reason: '架空停止' });
    expect(eventText(l, l.history.find(e => e.eventId === 'r')!)).toBe(before);
    const used = eventText(l, l.history.find(e => e.eventId === 'use-X')!);
    expect(used).toContain('X'); expect(used).toContain('架空の仮部品');
    expect(used).not.toContain('架空の現在名称'); expect(used).not.toContain('架空の別品目'); expect(used).not.toContain('利用停止');
    expect(l.lots['fictional-lot']!.item).toBe(id);
    expect(itemRef(l.masters, id)).toContain('Y');
    const sheets = viewSheetsOf({ ledger: l, supply: emptySupply }, at);
    const history = sheets.find(s => s.name === '台帳の履歴')!;
    const row = history.rows.find(r => r[0] === 'r')!;
    expect(row[6]).toBe(before);
    expect(JSON.stringify(sheets.find(s => s.name === '保管単位'))).toContain('架空の現在名称');
    expect(JSON.stringify(sheets.find(s => s.name === '保管単位'))).toContain('利用停止');
  });
});
