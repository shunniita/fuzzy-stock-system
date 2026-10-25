import { afterEach, describe, expect, test } from 'vitest';
import { correctOccurredAt, practiceLedger, type Meta } from '../../src/domain/ledger.ts';
import { emptySupply, receiveLot, reviseReceipt } from '../../src/domain/supply.ts';
import { deleteReceiptTemplate, receiveTemplate, saveReceiptTemplate, type ReceiptTemplate } from '../../src/domain/receipt-template.ts';
import { backupTextOf, readBackup } from '../../src/ui/backup.ts';
import { commit, faults, fingerprintOf, initial, load, parse, replace, retry, serialize, targetsOf, type StoreLike } from '../../src/ui/storage.ts';
import { decodePending, decodeSnapshot } from '../../src/ui/storageparse.ts';
import { supplyEventText } from '../../src/ui/supply-format.ts';

const at = '2026-10-19T09:00:00+09:00';
const meta = (eventId: string): Meta => ({ eventId, occurredAt: at, recordedAt: at, actor: '架空担当A' });
const template: ReceiptTemplate = { id: 'kit', name: '架空セット', product: 'R', project: null, basis: 'label', rows: [{ item: 'P', unit: '個', perSet: 2, location: 'S1' }, { item: 'Q', unit: '個', perSet: 1, location: 'S2' }] };
const recv = (s: Parameters<typeof receiveTemplate>[0], m: Meta, sets: number, quantities: number[]) => receiveTemplate(s, m, 'kit', { kind: 'common' }, sets, quantities.map(quantity => ({ quantity, shortfall: 0 })), null);
const state = () => ({ ledger: practiceLedger, supply: saveReceiptTemplate(practiceLedger, emptySupply, meta('op1'), template) });
const raw = () => ({ ...initial(state().ledger, state().supply) });
const pendingOf = (snapshot: ReturnType<typeof initial>) => ({
  format: 'fuzzy-stock-pending', version: 9,
  pending: { progress: 'saving', unknownSince: null, savingSince: at, baseRevision: 0, opId: 'op2', opLabel: 'テンプレートから一括受入', fingerprint: 'f', values: {}, actor: '架空担当A', startedAt: at,
    units: [{ ledger: snapshot.ledger, supply: snapshot.supply, targets: [], conflictReviews: [] }] },
});
class Store implements StoreLike {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
afterEach(() => { faults.loseResponseAt = faults.failMidwayAt = null; });
describe('セット 要件3.1 保存境界', () => {
  for (const entry of ['snapshot', 'pending', 'backup']) {
    test.each([
      { field: 'actor', change: { actor: '架空担当B' } },
      { field: 'occurredAt', change: { occurredAt: null } },
      { field: 'recordedAt', change: { recordedAt: '2026-10-19T10:00:00+09:00' } },
    ])(`${entry}で部品元受け取りの $field だけが一括出典と異なる記録を拒否する`, ({ change }) => {
      const received = recv(state(), meta('op2'), 10, [20, 10]);
      const broken = initial(received.ledger, { ...received.supply, log: received.supply.log.map(e => e.eventId === 'op2-r1-c' ? { ...e, ...change } : e) });
      if (entry === 'backup') {
        expect(readBackup(new TextEncoder().encode(backupTextOf(broken, at)))).toMatchObject({ kind: 'unreadable', reason: expect.stringContaining('出典') });
      } else if (entry === 'pending') {
        const pending = { progress: 'saving', unknownSince: null, savingSince: at, baseRevision: 0, opId: 'op2', opLabel: 'テンプレートから一括受入', fingerprint: 'f', values: {}, actor: '架空担当A', startedAt: at,
          units: [{ ledger: broken.ledger, supply: broken.supply, targets: [], conflictReviews: [] }] };
        expect(() => decodePending({ format: 'fuzzy-stock-pending', version: 9, pending })).toThrow('出典');
      } else {
        expect(() => parse(serialize(broken))).toThrow('明細1の担当者・日時');
      }
    });
  }
  test('実際の日時不明のまとめて受け取りと別担当による後日訂正を保存・復元できる', () => {
    const received = recv(state(), { ...meta('op2'), occurredAt: null }, 10, [20, 10]);
    const later = { eventId: 'op3', actor: '架空担当B', occurredAt: '2026-10-19T10:00:00+09:00', recordedAt: '2026-10-19T10:00:00+09:00' };
    const supply = reviseReceipt(received.ledger, received.supply, later, 'op2-lot1', 20, '架空の実受け取り再確認');
    const ledger = correctOccurredAt(received.ledger, { ...later, eventId: 'op4' }, 'op2-r1', at);
    const snapshot = initial(ledger, supply);
    expect(parse(serialize(snapshot))).toEqual(snapshot);
    expect(readBackup(new TextEncoder().encode(backupTextOf(snapshot, at)))).toMatchObject({ kind: 'ok', snapshot });
  });
  test('固定形の版6pendingを空の構成へ移行し、原入力を書き換えない', () => {
    const pending = { progress: 'saving', unknownSince: null, savingSince: at, baseRevision: 0, opId: 'op1', opLabel: '受入', fingerprint: 'f', values: {}, actor: '架空担当A', startedAt: at,
      units: [{ ledger: practiceLedger, supply: { needs: {}, declarations: {}, requests: {}, levels: {}, acks: {}, receipts: {}, log: [] }, targets: [], conflictReviews: [] }] };
    const input = { format: 'fuzzy-stock-pending', version: 6, pending }, before = JSON.stringify(input);
    expect(decodePending(input).units[0]?.supply.receiptTemplates).toEqual({});
    expect(JSON.stringify(input)).toBe(before);
    expect(() => decodePending({ ...input, pending: { ...pending, units: [{ ...pending.units[0], supply: emptySupply }] } })).toThrow();
  });
  test('版8の再読込・バックアップ復元で構成と履歴を保持する', () => {
    const before = state(), received = recv(before, meta('op2'), 10, [20, 10]);
    const removed = { ...received, supply: deleteReceiptTemplate(received.supply, received.ledger.masters, meta('op3'), 'kit') };
    const snapshot = initial(removed.ledger, removed.supply);
    expect(parse(serialize(snapshot))).toEqual(snapshot);
    const backup = readBackup(new TextEncoder().encode(backupTextOf(snapshot, at)));
    expect(backup).toMatchObject({ kind: 'ok', snapshot });
    const source = removed.supply.log.find(e => e.kind === 'templateReceipt');
    expect(source && supplyEventText(removed.ledger.masters, source)).toContain('架空セット');
    expect(source && supplyEventText(removed.ledger.masters, source)).toContain('20個');
  });
  test.each([1, 2, 3, 4, 5, 6])('旧版%sの固定空写しは構成を空へ移行し入力は変更しない', version => {
    const legacy = { format: 'fuzzy-stock-f0', version, revision: 0, lastWriter: 'init', opFloor: 1,
      ledger: { lots: {}, history: [], issues: {}, stops: {} }, supply: { needs: {}, declarations: {}, requests: {}, levels: {}, acks: {}, receipts: {}, log: [] }, ops: {}, saveChecks: [], ...(version >= 6 ? { conflictReviews: [] } : {}) };
    // 版3以降は登録情報必須。旧精度版の登録情報は固定の保存fixtureで別途回帰する。
    const oldMasters = Object.fromEntries(Object.entries(practiceLedger.masters).map(([group, entries]) => [group, Object.fromEntries(Object.entries(entries).map(([id, master]) => {
      const { unitSteps, ...rest } = 'unitSteps' in master ? master : { ...master, unitSteps: undefined };
      return [id, version >= 5 ? master : rest];
    }))]));
    const input = { ...legacy, ledger: { ...legacy.ledger, ...(version >= 3 ? { masters: oldMasters } : {}) } };
    const text = JSON.stringify(input);
    expect(decodeSnapshot(input).supply.receiptTemplates).toEqual({});
    expect(JSON.stringify(input)).toBe(text);
    expect(() => decodeSnapshot({ ...input, supply: { ...input.supply, receiptTemplates: {} } })).toThrow();
  });
  test('新版辞書の欠損・不正な構成・偽の現在値・不正な履歴を拒否する', () => {
    const before = raw();
    const { receiptTemplates: _omitted, ...without } = before.supply;
    expect(() => decodeSnapshot({ ...before, supply: without })).toThrow();
    for (const rows of [[], [{ ...template.rows[0], unit: '未知' }], [{ ...template.rows[0], perSet: 0 }]]) {
      expect(() => decodeSnapshot({ ...before, supply: { ...before.supply, receiptTemplates: { kit: { ...template, rows } } } })).toThrow();
    }
    expect(() => decodeSnapshot({ ...before, supply: { ...before.supply, receiptTemplates: {} } })).toThrow();
    expect(() => decodeSnapshot({ ...before, supply: { ...before.supply, log: [{ ...meta('op1'), kind: 'receiptTemplateSave', before: null, after: { ...template, extra: true } }] } })).toThrow();
  });
  test('廃止済登録情報を持つ履歴を読み、以後の新規受け取りは拒否する', () => {
    const before = raw(), master = practiceLedger.masters.items['P']!;
    const ledger = { ...before.ledger, masters: { ...before.ledger.masters, items: { ...before.ledger.masters.items, P: { ...master, active: false } } } };
    expect(decodeSnapshot({ ...before, ledger }).supply.receiptTemplates['kit']).toEqual(template);
    expect(() => recv({ ledger, supply: before.supply }, meta('op2'), 1, [2, 1])).toThrow();
  });
  test('一括出典の数量・対象・セット数の破損を拒否する', () => {
    const received = recv(state(), meta('op2'), 10, [20, 10]);
    for (const change of [{ sets: 0 }, { rows: [{ lotId: '別', quantity: 20, shortfall: 0 }, { lotId: 'op2-lot2', quantity: 10, shortfall: 0 }] }, { rows: [{ lotId: 'op2-lot1', quantity: 19, shortfall: 0 }, { lotId: 'op2-lot2', quantity: 10, shortfall: 0 }] }]) {
      expect(() => decodeSnapshot({ ...initial(received.ledger, received.supply), supply: { ...received.supply, log: received.supply.log.map(e => e.kind === 'templateReceipt' ? { ...e, ...change } : e) } })).toThrow();
    }
  });
  for (const entry of ['snapshot', 'pending', 'backup']) {
    test.each([
      ['全件欠落', {}],
      ['一件欠落', { 'op2-lot1': undefined }],
      ['存在しない操作', { eventId: 'missing' }],
      ['別種の操作', { eventId: 'op1' }],
      ['別の物品の受け取り', { eventId: 'op2-r2-c' }],
      ['元受け取りと異なる数', { received: 19 }],
      ['元受け取りと異なる根拠', { provisional: false }],
      ['元受け取りと異なるラベル', { label: '別ラベル' }],
    ])(`${entry}でまとめて受け取りの現在記録の%sを拒否する`, (damage, change) => {
      const received = recv(state(), meta('op2'), 10, [20, 10]);
      const receipts = { ...received.supply.receipts };
      if (damage === '全件欠落') { delete receipts['op2-lot1']; delete receipts['op2-lot2']; }
      else if (damage === '一件欠落') delete receipts['op2-lot1'];
      else receipts['op2-lot1'] = { ...receipts['op2-lot1']!, ...change };
      const broken = initial(received.ledger, { ...received.supply, receipts });
      if (entry === 'backup') {
        expect(readBackup(new TextEncoder().encode(backupTextOf(broken, at)))).toMatchObject({ kind: 'unreadable', reason: expect.stringContaining('現在の受け取り記録') });
      } else if (entry === 'pending') {
        expect(() => decodePending(pendingOf(broken))).toThrow('現在の受け取り記録');
      } else {
        expect(() => parse(serialize(broken))).toThrow('現在の受け取り記録');
      }
    });
  }
  test.each([0, 19, 21])('後日%s個へ訂正した受け取りをsnapshot・pending・backupから復元できる', quantity => {
    const received = recv(state(), meta('op2'), 10, [20, 10]);
    const later = { ...meta('op3'), actor: '架空担当B', occurredAt: '2026-10-20T09:00:00+09:00', recordedAt: '2026-10-20T09:00:00+09:00' };
    const supply = reviseReceipt(received.ledger, received.supply, later, 'op2-lot1', quantity, '後日確認');
    const snapshot = initial(received.ledger, supply);
    expect(parse(serialize(snapshot))).toEqual(snapshot);
    expect(decodePending(pendingOf(snapshot)).units[0]?.supply).toEqual(supply);
    expect(readBackup(new TextEncoder().encode(backupTextOf(snapshot, later.recordedAt)))).toMatchObject({ kind: 'ok', snapshot });
    expect(supply.receipts['op2-lot1']).toMatchObject({ received: quantity, provisional: false, eventId: 'op3' });
  });
  for (const entry of ['snapshot', 'pending', 'backup']) {
    test.each([
      ['数量', { received: 777 }],
      ['根拠', { provisional: true }],
      ['ラベル', { label: '偽のラベル' }],
      ['旧訂正への参照', { received: 19, eventId: 'op3' }],
    ])(`${entry}で後日訂正後の現在記録の%s改変を拒否する`, (_name, change) => {
      const received = recv(state(), meta('op2'), 10, [20, 10]);
      let supply = reviseReceipt(received.ledger, received.supply, meta('op3'), 'op2-lot1', 19, '一回目の確認');
      supply = reviseReceipt(received.ledger, supply, meta('op4'), 'op2-lot1', 18, '二回目の確認');
      const snapshot = initial(received.ledger, supply);
      const broken = { ...snapshot, supply: { ...supply, receipts: { ...supply.receipts, 'op2-lot1': { ...supply.receipts['op2-lot1']!, ...change } } } };
      if (entry === 'snapshot') expect(() => decodeSnapshot(broken)).toThrow('現在の受け取り記録');
      else if (entry === 'pending') expect(() => decodePending(pendingOf(broken))).toThrow('現在の受け取り記録');
      else expect(readBackup(new TextEncoder().encode(backupTextOf(broken, at)))).toMatchObject({ kind: 'unreadable', reason: expect.stringContaining('現在の受け取り記録') });
    });
    test.each(['訂正前の数', '受け取りの重複'])(`${entry}で受け取りからの履歴の%sを拒否する`, damage => {
      const received = recv(state(), meta('op2'), 10, [20, 10]);
      const supply = reviseReceipt(received.ledger, received.supply, meta('op3'), 'op2-lot1', 19, '後日確認');
      const receipt = supply.log.find(e => e.eventId === 'op2-r1-c');
      if (!receipt) throw new Error('受け取りの試験記録がない');
      const log = damage === '訂正前の数'
        ? supply.log.map(e => e.kind === 'receiptRevise' ? { ...e, before: 999 } : e)
        : [...supply.log, { ...receipt, eventId: 'duplicate' }];
      const broken = initial(received.ledger, { ...supply, log });
      if (entry === 'snapshot') expect(() => decodeSnapshot(broken)).toThrow('現在の受け取り記録');
      else if (entry === 'pending') expect(() => decodePending(pendingOf(broken))).toThrow('現在の受け取り記録');
      else expect(readBackup(new TextEncoder().encode(backupTextOf(broken, at)))).toMatchObject({ kind: 'unreadable', reason: expect.stringContaining('現在の受け取り記録') });
    });
  }
  test('複数回の正当な後入力訂正は記録順の現在値を保存復元できる', () => {
    const received = recv(state(), meta('op2'), 10, [20, 10]);
    const later = { ...meta('op3'), occurredAt: null, recordedAt: '2026-10-20T09:00:00+09:00' };
    let supply = reviseReceipt(received.ledger, received.supply, later, 'op2-lot1', 19, '日時不明の後日確認');
    supply = reviseReceipt(received.ledger, supply, { ...later, eventId: 'op4', occurredAt: at }, 'op2-lot1', 18, '後入力の再確認');
    const snapshot = initial(received.ledger, supply);
    expect(parse(serialize(snapshot))).toEqual(snapshot);
    expect(decodePending(pendingOf(snapshot)).units[0]?.supply).toEqual(supply);
    expect(readBackup(new TextEncoder().encode(backupTextOf(snapshot, at)))).toMatchObject({ kind: 'ok', snapshot });
  });
  test.each([[0, 10], [20, 0]])('未受け取り0を含む%s/%sの現在記録は受け取り行だけで復元できる', (first, second) => {
    const received = recv(state(), meta('op2'), 10, [first, second]);
    const snapshot = initial(received.ledger, received.supply);
    expect(Object.keys(received.supply.receipts)).toEqual([first === 0 ? 'op2-lot2' : 'op2-lot1']);
    expect(parse(serialize(snapshot))).toEqual(snapshot);
    expect(decodePending(pendingOf(snapshot)).units[0]?.supply).toEqual(received.supply);
    expect(readBackup(new TextEncoder().encode(backupTextOf(snapshot, at)))).toMatchObject({ kind: 'ok', snapshot });
  });
  test.each(['snapshot', 'pending', 'backup'])('%sで受け取り済み行を未受け取り0へ改変した履歴を拒否する', entry => {
    const received = recv(state(), meta('op2'), 10, [20, 10]);
    for (const evidence of ['both', 'ledger', 'receipt']) {
      const broken = initial(
        evidence === 'receipt' ? { ...received.ledger, history: received.ledger.history.filter(e => e.eventId !== 'op2-r2') } : received.ledger,
        { ...received.supply, log: received.supply.log.filter(e => evidence !== 'ledger' || e.eventId !== 'op2-r2-c').map(e => e.kind === 'templateReceipt' ? { ...e, rows: [e.rows[0]!, { lotId: null, quantity: 0, shortfall: 0 }] } : e) },
      );
      if (entry === 'backup') {
        expect(readBackup(new TextEncoder().encode(backupTextOf(broken, at)))).toMatchObject({ kind: 'unreadable', reason: expect.stringContaining('未受け取り行') });
      } else if (entry === 'pending') {
        const pending = { progress: 'saving', unknownSince: null, savingSince: at, baseRevision: 0, opId: 'op2', opLabel: 'テンプレートから一括受入', fingerprint: 'f', values: {}, actor: '架空担当A', startedAt: at,
          units: [{ ledger: broken.ledger, supply: broken.supply, targets: [], conflictReviews: [] }] };
        expect(() => decodePending({ format: 'fuzzy-stock-pending', version: 9, pending })).toThrow('未受け取り行');
      } else {
        expect(() => parse(serialize(broken))).toThrow('未受け取り行');
      }
    }
  });
  for (const entry of ['snapshot', 'pending', 'backup']) {
    test(`${entry}で不足0の明細に履歴のない派生依頼が現在値だけある場合を拒否する`, () => {
      const received = recv(state(), meta('op2'), 10, [20, 10]);
      const request = { id: 'op2-s1', project: { kind: 'common' as const }, item: 'P', unit: '個', quantity: 1, vendor: '架空商社', requestedOn: '2026-10-19', orderConfirmedBy: null, reply: { kind: 'none' as const }, cancelled: null, arrivals: [] };
      const broken = initial(received.ledger, { ...received.supply, requests: { ...received.supply.requests, 'op2-s1': request } });
      if (entry === 'snapshot') expect(() => decodeSnapshot(broken)).toThrow('不足のない明細1');
      else if (entry === 'pending') expect(() => decodePending(pendingOf(broken))).toThrow('不足のない明細1');
      else expect(readBackup(new TextEncoder().encode(backupTextOf(broken, at)))).toMatchObject({ kind: 'unreadable', reason: expect.stringContaining('不足のない明細1') });
    });
  }
  for (const entry of ['snapshot', 'pending', 'backup']) {
    test.each([
      ['注文の確定', { orderConfirmedBy: 'op9' }],
      ['取消', { cancelled: { eventId: 'op9', reason: '架空' } }],
    ])(`${entry}で不足の依頼作成の履歴が初期状態でない（%s済み）場合を拒否する`, (_name, change) => {
      const received = receiveTemplate(state(), meta('op2'), 'kit', { kind: 'common' }, 10, [{ quantity: 20, shortfall: 0 }, { quantity: 7, shortfall: 3 }], '架空商社');
      const log = received.supply.log.map(e => e.kind === 'requestRecord' && e.eventId === 'op2-s2' ? { ...e, request: { ...e.request, ...change } } : e);
      const broken = initial(received.ledger, { ...received.supply, log });
      if (entry === 'snapshot') expect(() => decodeSnapshot(broken)).toThrow('不足と注文・購入予定の記録が一致しない');
      else if (entry === 'pending') expect(() => decodePending(pendingOf(broken))).toThrow('不足と注文・購入予定の記録が一致しない');
      else expect(readBackup(new TextEncoder().encode(backupTextOf(broken, at)))).toMatchObject({ kind: 'unreadable', reason: expect.stringContaining('不足と注文・購入予定の記録が一致しない') });
    });
  }
  test('正当な未受け取り0と同じ物品IDを持つ別操作の受け取りは保存・復元できる', () => {
    const before = state();
    const unrelated = receiveLot(before.ledger, before.supply, meta('op0'), { id: 'op2-lot2', item: 'Q', unit: '個', project: { kind: 'common' }, location: 'S2' }, 'label', 3);
    const received = recv(unrelated, meta('op2'), 10, [20, 0]);
    const snapshot = initial(received.ledger, received.supply);
    expect(parse(serialize(snapshot))).toEqual(snapshot);
    expect(readBackup(new TextEncoder().encode(backupTextOf(snapshot, at)))).toMatchObject({ kind: 'ok', snapshot });
    expect(received.supply.log.at(-1)).toMatchObject({ kind: 'templateReceipt', rows: [{ quantity: 20 }, { lotId: null, quantity: 0 }] });
  });
  test('一単位で全行を確定し応答不明のpending再読込・再試行で二重計上しない', () => {
    const store = new Store(), before = state(), snapshot = replace(store, null, before);
    const next = recv(before, meta('op2'), 10, [20, 10]);
    const context = { opId: 'op2', opLabel: 'テンプレートから一括受入', fingerprint: fingerprintOf('まとめて受け取り', { sets: '10', template: 'kit' }), values: { sets: '10' }, actor: '架空担当A', startedAt: at, savingSince: at };
    faults.loseResponseAt = 1;
    const result = commit(store, snapshot, context, [{ ...next, conflictReviews: [], targets: targetsOf(before, next) }]);
    expect(result.kind).toBe('unknown');
    if (result.kind !== 'unknown') throw new Error('応答不明の注入が効いていない');
    expect(result.pending.units).toHaveLength(1);
    const pendingText = store.getItem('fuzzy-stock/pending');
    expect(pendingText).not.toBeNull();
    const pending = decodePending(JSON.parse(pendingText ?? 'null'));
    expect(pending.units[0]?.supply.receiptTemplates['kit']).toEqual(template);
    const loaded = load(store);
    expect(loaded.kind).toBe('ok');
    if (loaded.kind !== 'ok') throw new Error('保存を読み込めない');
    const retried = retry(store, loaded.snapshot, pending, '架空担当A', at);
    expect(['saved', 'duplicate', 'recovered']).toContain(retried.kind);
    const final = load(store);
    expect(final.kind === 'ok' ? Object.keys(final.snapshot.supply.receipts).length : -1).toBe(2);
    expect(() => decodePending({ format: 'fuzzy-stock-pending', version: 6, pending })).toThrow();
  });
});
