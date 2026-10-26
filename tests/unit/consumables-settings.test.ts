import { describe, expect, test } from 'vitest';
import { changeMasters, merge, practiceLedger, register, split, type Ledger, type MasterRequest, type Meta } from '../../src/domain/ledger.ts';
import { stockOf } from '../../src/domain/packaging.ts';
import type { ConsumableSetting } from '../../src/domain/masters.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { initial, parse, serialize, type Snapshot } from '../../src/ui/storage.ts';

const meta = (eventId: string, hour = 9): Meta => ({ eventId, actor: '架空担当A', occurredAt: `2026-10-02T${String(hour).padStart(2, '0')}:00:00+09:00`, recordedAt: '2026-10-02T20:00:00+09:00' });
const setting: ConsumableSetting = { pieceUnit: '個', rule: { threshold: 0.3, standardOrder: { value: 1, unit: '袋' } } };
const base = () => changeMasters(practiceLedger, meta('item'), { action: 'register', master: { type: 'item', code: 'D', name: '架空消耗品D', units: ['個', '袋'], unitSteps: { 個: 0.1, 袋: 1 }, trial: true, source: null } });
const configure = (l: Ledger, eventId: string, value: ConsumableSetting | null) => changeMasters(l, meta(eventId), { action: 'consumable', id: 'D', setting: value, reason: '架空の設定' });
const pack = (l: Ledger, hour = 10) => changeMasters(l, meta('pack', hour), { action: 'packaging', id: 'D', boxUnit: '袋', pieceUnit: '個', value: 10, reason: '包装を確認' });
const reg = (l: Ledger, id: string, hour: number) => register(l, meta(id, hour), { id, item: 'D', unit: '袋', project: { kind: 'common' }, location: 'S1' }, 'counted', 1);

describe('共通消耗品1・2・4.1: 設定の変更', () => {
  test('指定・基準設定・変更・基準解除・指定解除で現物を変えず前後を残す', () => {
    let l = reg(base(), 'BOX', 8);
    const lots = l.lots;
    for (const [index, value] of [{ pieceUnit: '個', rule: null }, setting, { ...setting, rule: { threshold: 5, standardOrder: { value: 2, unit: '袋' } } }, { pieceUnit: '個', rule: null }, null].entries()) {
      const before = l.masters.items.D;
      l = configure(l, `setting${index}`, value);
      expect(l.masters.items.D?.consumable).toEqual(value);
      expect(l.history.at(-1)).toMatchObject({ kind: 'master', action: 'consumable', reason: '架空の設定', changes: [], masters: [{ before, after: l.masters.items.D }] });
      expect(l.lots).toEqual(lots);
      expect(parse(serialize(initial(l, emptySupply))).ledger).toEqual(l);
    }
  });

  test.each([
    { pieceUnit: '未登録', rule: null },
    { pieceUnit: '個', rule: { threshold: -1, standardOrder: { value: 1, unit: '袋' } } },
    { pieceUnit: '個', rule: { threshold: 0.05, standardOrder: { value: 1, unit: '袋' } } },
    { pieceUnit: '個', rule: { threshold: 0, standardOrder: { value: 0, unit: '袋' } } },
    { pieceUnit: '個', rule: { threshold: 0, standardOrder: { value: 0.1, unit: '袋' } } },
    { pieceUnit: '個', rule: { threshold: Infinity, standardOrder: { value: 1, unit: '袋' } } },
  ])('不正設定を原子的に拒否する: %j', value => {
    const l = base(), before = JSON.stringify(l);
    expect(() => configure(l, 'bad', value)).toThrow();
    expect(JSON.stringify(l)).toBe(before);
  });

  test('包装設定前の現物とその分割は不明のまま、設定後の袋だけ換算する', () => {
    let l = pack(reg(base(), 'OLD', 8));
    l = reg(l, 'NEW', 11);
    l = split(l, meta('split', 12), 'OLD', 'CHILD', 'counted', 1);
    const result = stockOf(l, emptySupply, 'D', '個');
    expect(result.pieces).toMatchObject({ kind: 'known', numeric: { value: 10, unconfirmed: 'all' } });
    expect(result.unconverted.map(lot => lot.id)).toEqual(['OLD', 'CHILD']);
    expect(l.masters.items.D?.packaging?.perBox).toEqual([{ from: null, value: null }, { from: meta('pack', 10).occurredAt, value: 10 }]);
    expect(parse(serialize(initial(l, emptySupply))).ledger).toEqual(l);
    const changed = changeMasters(l, meta('change', 12), { action: 'perBox', id: 'D', value: 20, reason: '新しい包装' });
    expect(stockOf(changed, emptySupply, 'D', '個').pieces).toEqual(result.pieces);
  });

  test('統合済みの包装の根拠を変える設定時点を拒否する', () => {
    let l = reg(reg(base(), 'A', 10), 'B', 11);
    l = merge(l, meta('merge', 12), 'A', 'B');
    const before = JSON.stringify(l);
    expect(() => pack(l, 10)).toThrow('統合');
    expect(JSON.stringify(l)).toBe(before);
    expect(() => pack(l, 13)).not.toThrow();
  });

  test('包装の付け直し・不正単位・未来時点・不明時点を拒否する', () => {
    const request: MasterRequest = { action: 'packaging', id: 'D', boxUnit: '袋', pieceUnit: '個', value: 10, reason: '設定' };
    expect(() => pack(pack(base()), 12)).toThrow();
    for (const changed of [{ ...request, boxUnit: '個' }, { ...request, value: 0 }, { ...request, value: 1.1 }]) expect(() => changeMasters(base(), meta('bad'), changed)).toThrow();
    expect(() => changeMasters(base(), { ...meta('bad'), occurredAt: null }, request)).toThrow();
    expect(() => changeMasters(base(), meta('bad', 21), request)).toThrow();
    expect(() => configure(pack(base()), 'bad', { pieceUnit: '袋', rule: null })).toThrow();
    expect(() => pack(configure(base(), 'cfg', { pieceUnit: '袋', rule: null }))).toThrow();
  });

  test('現在値・中間のbefore・別actionでの設定変更を読み込みで拒否する', () => {
    const l = configure(configure(base(), 'cfg1', setting), 'cfg2', { pieceUnit: '個', rule: null });
    const wire = serialize(initial(l, emptySupply));
    for (const target of ['current', 'before', 'action', 'name']) {
      const value: Snapshot = JSON.parse(wire);
      const event = value.ledger.history[2];
      if (event?.kind !== 'master') throw new Error('設定変更がない');
      const pair = event.masters[0]!;
      if (pair.before?.type !== 'item' || pair.after.type !== 'item') throw new Error('品目の変更前後がない');
      if (target === 'current') value.ledger.masters.items.D!.consumable = setting;
      if (target === 'before') pair.before.consumable!.rule!.threshold = 0.4;
      if (target === 'action' && event.action !== 'trial') event.action = 'rename';
      if (target === 'name') { pair.after.name = '密かな改名'; value.ledger.masters.items.D!.name = '密かな改名'; }
      expect(() => parse(JSON.stringify(value))).toThrow();
    }
  });

  test.each(['remove', 'swap', 'past', 'extra', 'time', 'name'])('入り数変更を装う%s改変は現在値と履歴を揃えても拒否する', target => {
    const l = changeMasters(pack(base()), meta('perbox', 11), { action: 'perBox', id: 'D', value: 20, reason: '新しい袋' });
    const value: Snapshot = JSON.parse(serialize(initial(l, emptySupply)));
    const event = value.ledger.history.at(-1);
    if (event?.kind !== 'master') throw new Error('入り数履歴がない');
    const item = event.masters[0]!.after;
    if (item.type !== 'item' || item.packaging === null) throw new Error('包装がない');
    const packaging = item.packaging;
    if (target === 'remove') item.packaging = null;
    if (target === 'swap') { packaging.boxUnit = '個'; packaging.pieceUnit = '袋'; }
    if (target === 'past') packaging.perBox[1]!.value = 999;
    if (target === 'extra') item.packaging = { ...packaging, perBox: [...packaging.perBox, { from: meta('extra', 12).occurredAt, value: 30 }] };
    if (target === 'time') packaging.perBox[2]!.from = meta('wrong', 12).occurredAt;
    if (target === 'name') item.name = '密かな改名';
    Object.assign(value.ledger.masters.items.D!, item);
    expect(() => parse(JSON.stringify(value))).toThrow('入り数');
  });
});
