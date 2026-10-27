import { describe, expect, test } from 'vitest';
import {
  changeMasters, ConfirmationRequired, correctOccurredAt, practiceLedger, register, use,
  type Ledger, type LedgerEvent, type MasterRequest, type Meta,
} from '../../src/domain/ledger.ts';
import { fixedMasters } from '../../src/domain/masters.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { commit, fingerprintOf, initial, load, parse, serialize, type StoreLike } from '../../src/ui/storage.ts';

const day = (time: string): string => `2026-10-09T${time}:00+09:00`;
const meta = (eventId: string, occurred: string | null = '09:00', recorded = occurred ?? '12:00', actor = '架空担当A'): Meta =>
  ({ eventId, occurredAt: occurred === null ? null : day(occurred), recordedAt: day(recorded), actor });
const change = (l: Ledger, id: string, request: MasterRequest, confirmed = false, occurred: string | null = '09:00'): Ledger =>
  changeMasters(l, meta(id, occurred), request, confirmed);
const last = (l: Ledger): LedgerEvent => l.history[l.history.length - 1]!;
const lotOf = (id: string, item = 'P', location = 'S1') => ({ id, item, unit: '個', project: { kind: 'common' } as const, location });

function confirmation(run: () => unknown): ConfirmationRequired {
  try { run(); } catch (error) { if (error instanceof ConfirmationRequired) return error; throw error; }
  throw new Error('確認を求めなかった');
}

describe('F1-B 3.1・要件1 登録情報の登録', () => {
  test('1.1・1.9・1.10: 品目を登録すると、品番・コードを文字列のまま持ち、履歴に前後と担当者が残る。保管単位は変わらない', () => {
    const before = register(practiceLedger, meta('r1', '08:00'), lotOf('P-1'), 'counted', 5);
    const l = change(before, 'm1', { action: 'register', master: { type: 'item', code: '0012', name: '架空部品0012', units: ['個'], unitSteps: { '個': 1 }, trial: true, source: null } });
    expect(l.masters.items['0012']).toEqual({ type: 'item', id: '0012', code: '0012', name: '架空部品0012', source: null, units: ['個'], unitSteps: { '個': 1 }, trial: true, active: true, packaging: null, consumable: null });
    expect(last(l)).toMatchObject({ kind: 'master', action: 'register', eventId: 'm1', actor: '架空担当A', confirmed: false, reason: null, changes: [], masters: [{ before: null, after: { id: '0012' } }] });
    expect(l.lots).toEqual(before.lots);
  });

  test('1.1・1.3: 品番・コードのない仮の品目・仮の案件・用途は、操作IDから作った内部の識別で登録する', () => {
    let l = change(practiceLedger, 'm1', { action: 'register', master: { type: 'item', code: null, name: '品目不明の試作ネジ', units: ['本'], unitSteps: { '本': 1 }, trial: true, source: null } });
    l = change(l, 'm2', { action: 'register', master: { type: 'case', code: null, name: '案件・用途ID未定の試作', source: null } });
    expect(l.masters.items['item-m1']).toMatchObject({ code: null, name: '品目不明の試作ネジ' });
    expect(l.masters.cases['case-m2']).toMatchObject({ code: null, name: '案件・用途ID未定の試作' });
  });

  test('1.2・1.3・1.4: 場所（記録の対象の内外を選ぶ）・案件・用途（元の資料の名称と版）・担当者を登録する', () => {
    let l = change(practiceLedger, 'm1', { action: 'register', master: { type: 'location', code: 'S3', name: '棚S3', trial: true, inScope: true } });
    l = change(l, 'm2', { action: 'register', master: { type: 'location', code: 'W', name: '別棟の倉庫W', trial: false, inScope: false } });
    l = change(l, 'm3', { action: 'register', master: { type: 'case', code: 'A-003', name: '架空機種K', source: { name: '架空案件・用途K', revision: '初版' } } });
    l = change(l, 'm4', { action: 'register', master: { type: 'actor', name: '架空担当C' } });
    expect(l.masters.locations.S3?.scope).toEqual([{ from: null, inScope: true }]);
    expect(l.masters.locations.W?.scope).toEqual([{ from: null, inScope: false }]);
    expect(l.masters.cases['A-003']).toMatchObject({ code: 'A-003', name: '架空機種K', source: { name: '架空案件・用途K', revision: '初版' } });
    expect(l.masters.actors['架空担当C']).toEqual({ type: 'actor', id: '架空担当C', active: true });
  });

  test('1.5・1.6: 同じ種類で使われている品番・コードは、利用停止中も含めて登録せず、その登録情報を示す', () => {
    expect(() => change(practiceLedger, 'm1', { action: 'register', master: { type: 'item', code: 'P', name: '別の部品', units: ['個'], unitSteps: { '個': 1 }, trial: true, source: null } }))
      .toThrow(/品番・コード P.*架空部品P.*利用中/);
    const stopped = change(practiceLedger, 'm1', { action: 'deactivate', type: 'case', id: 'A-002', reason: '完了' });
    expect(() => change(stopped, 'm2', { action: 'register', master: { type: 'case', code: 'A-002', name: null, source: null } })).toThrow(/A-002.*利用停止中/);
    // 種類が違えば同じ文字列でもよい
    expect(change(practiceLedger, 'm3', { action: 'register', master: { type: 'location', code: 'P', name: '棚P', trial: true, inScope: true } }).masters.locations.P?.code).toBe('P');
  });

  test('1.7・1.8: 同じ名前の担当者と、必須の項目が空の登録をしない', () => {
    expect(() => change(practiceLedger, 'm1', { action: 'register', master: { type: 'actor', name: '架空担当A' } })).toThrow('同じ名前');
    const empty: MasterRequest[] = [
      { action: 'register', master: { type: 'item', code: 'P9', name: ' ', units: ['個'], unitSteps: { '個': 1 }, trial: true, source: null } },
      { action: 'register', master: { type: 'item', code: 'P9', name: '架空部品P9', units: [], unitSteps: {}, trial: true, source: null } },
      { action: 'register', master: { type: 'item', code: 'P9', name: '架空部品P9', units: ['個', '個'], unitSteps: { '個': 1 }, trial: true, source: null } },
      { action: 'register', master: { type: 'item', code: '', name: '架空部品P9', units: ['個'], unitSteps: { '個': 1 }, trial: true, source: null } },
      { action: 'register', master: { type: 'location', code: 'S3', name: '', trial: true, inScope: true } },
      { action: 'register', master: { type: 'actor', name: '' } },
    ];
    for (const request of empty) expect(() => change(practiceLedger, 'm1', request)).toThrow();
    expect(() => change(practiceLedger, 'm1', { action: 'register', master: { type: 'case', code: null, name: null, source: null } }))
      .toThrow('品番・コードのない仮の案件・用途には、呼び名を入力する');
  });
});

describe('F1-B 3.1・要件2・要件3 名称の変更と利用停止', () => {
  test('2.1・2.2: 名称を変えても同じ登録情報で、前後・変更時点（不明も可）・担当者・理由が残る', () => {
    const before = register(practiceLedger, meta('r1', '08:00'), lotOf('P-1'), 'counted', 5);
    const l = change(before, 'm1', { action: 'rename', type: 'item', id: 'P', name: '架空部品P改', reason: '型番の変更' }, false, null);
    expect(l.masters.items.P).toMatchObject({ id: 'P', code: 'P', name: '架空部品P改' });
    expect(last(l)).toMatchObject({ action: 'rename', occurredAt: null, reason: '型番の変更', masters: [{ before: { name: '架空部品P' }, after: { name: '架空部品P改' } }] });
    expect(l.lots['P-1']?.item).toBe('P');
    expect(() => change(l, 'm2', { action: 'rename', type: 'item', id: 'P', name: '架空部品P改', reason: '同じ' })).toThrow('同じ');
    expect(() => change(l, 'm3', { action: 'rename', type: 'location', id: 'S1', name: '', reason: '空' })).toThrow();
    expect(() => change(l, 'm4', { action: 'rename', type: 'item', id: 'ZZ', name: '何か', reason: '知らない' })).toThrow('登録されていない');
  });

  test('3.1・3.5・3.6: 利用停止と再開は状態を変え、理由を残す。同じ状態への変更と理由のない変更はしない', () => {
    let l = change(practiceLedger, 'm1', { action: 'deactivate', type: 'actor', id: '架空担当B', reason: '異動' });
    expect(l.masters.actors['架空担当B']?.active).toBe(false);
    expect(() => change(l, 'm2', { action: 'deactivate', type: 'actor', id: '架空担当B', reason: '二度目' })).toThrow('すでに利用停止中');
    expect(() => change(l, 'm3', { action: 'deactivate', type: 'item', id: 'P', reason: ' ' })).toThrow('理由');
    l = change(l, 'm4', { action: 'reactivate', type: 'actor', id: '架空担当B', reason: '復帰' });
    expect(l.masters.actors['架空担当B']?.active).toBe(true);
    expect(last(l)).toMatchObject({ action: 'reactivate', reason: '復帰', masters: [{ before: { active: false }, after: { active: true } }] });
    expect(() => change(l, 'm5', { action: 'reactivate', type: 'item', id: 'P', reason: '利用中' })).toThrow('すでに利用中');
  });
});

describe('F1-B 3.2・要件4 品番・コードの変更と対応変更', () => {
  test('4.1・4.3: 使われていない品番・コードへ変えると、内部の識別と記録はそのままで、前後が残る', () => {
    const before = register(practiceLedger, meta('r1', '08:00'), lotOf('P-1'), 'counted', 5);
    const l = change(before, 'm1', { action: 'code', type: 'item', id: 'P', code: 'P-100', reason: '管理コードの誤り' });
    expect(l.masters.items.P).toMatchObject({ id: 'P', code: 'P-100' });
    expect(l.lots['P-1']?.item).toBe('P');
    expect(last(l)).toMatchObject({ action: 'code', confirmed: false, masters: [{ before: { code: 'P' }, after: { code: 'P-100' } }] });
    // 内部の識別Pと同じ文字列の品番・コードで新しく登録しても、内部の識別は重ならない
    const again = change(l, 'm2', { action: 'register', master: { type: 'item', code: 'P', name: '新しい部品P', units: ['個'], unitSteps: { '個': 1 }, trial: true, source: null } });
    expect(again.masters.items['item-m2']).toMatchObject({ code: 'P', name: '新しい部品P' });
    expect(again.masters.items.P?.code).toBe('P-100');
  });

  test('4.2: 仮の品目に品番・コードを付けて正式にする', () => {
    let l = change(practiceLedger, 'm1', { action: 'register', master: { type: 'item', code: null, name: '試作ネジ', units: ['本'], unitSteps: { '本': 1 }, trial: true, source: null } });
    l = change(l, 'm2', { action: 'code', type: 'item', id: 'item-m1', code: 'S-200', reason: '全社の品目IDが決まった' });
    expect(l.masters.items['item-m1']).toMatchObject({ code: 'S-200' });
    expect(last(l)).toMatchObject({ masters: [{ before: { code: null }, after: { code: 'S-200' } }] });
  });

  test('4.4〜4.6: 別の品目が使う品番・コードは、確認するまで付けない。確認すると、もとの品目を仮にして付け替え、二組の前後と確認した担当者が残る', () => {
    const before = register(practiceLedger, meta('r1', '08:00'), lotOf('Q-1', 'Q'), 'counted', 3);
    const request: MasterRequest = { action: 'code', type: 'item', id: 'P', code: 'Q', reason: 'Qの管理コードは本当はPのもの' };
    const asked = confirmation(() => change(before, 'm1', request));
    expect(asked.kind).toBe('code');
    expect(asked.master).toMatchObject({ id: 'Q', code: 'Q' });
    expect(asked.lots).toEqual(['Q-1']);
    expect(asked.message).toContain('架空部品Q');
    const l = changeMasters(before, meta('m1', '09:00', '09:00', '架空担当B'), request, true);
    expect(l.masters.items.P?.code).toBe('Q');
    expect(l.masters.items.Q?.code).toBeNull();
    expect(last(l)).toMatchObject({ action: 'code', actor: '架空担当B', confirmed: true, reason: 'Qの管理コードは本当はPのもの', masters: [
      { before: { id: 'Q', code: 'Q' }, after: { id: 'Q', code: null } },
      { before: { id: 'P', code: 'P' }, after: { id: 'P', code: 'Q' } },
    ] });
    expect(l.lots).toEqual(before.lots);
  });

  test('4.8: 場所の品番・コードの衝突は確認でも付け替えず断る', () => {
    expect(() => change(practiceLedger, 'm1', { action: 'code', type: 'location', id: 'S1', code: 'S2', reason: '入れ違い' }, true)).toThrow(/S2.*棚S2/);
  });

  test('今と同じ品番・コードや空の品番・コードへは変えない', () => {
    expect(() => change(practiceLedger, 'm1', { action: 'code', type: 'item', id: 'P', code: 'P', reason: '同じ' })).toThrow('同じ');
    expect(() => change(practiceLedger, 'm2', { action: 'code', type: 'case', id: 'A-001', code: ' ', reason: '空' })).toThrow();
  });
});

describe('F1-B 3.2・要件5 元の資料の更新', () => {
  test('5.2・5.3・5.5: 確認するまで変えず、呼び名との食い違いを示し、確認すると元の資料だけ変わる', () => {
    const request: MasterRequest = { action: 'source', type: 'item', code: 'P', source: { name: '全社部品P-改', revision: '2026-10版' } };
    const asked = confirmation(() => change(practiceLedger, 'm1', request));
    expect(asked.kind).toBe('source');
    expect(asked.message).toContain('全社部品P-改');
    expect(asked.message).toContain('呼び名「架空部品P」と食い違う');
    const l = change(practiceLedger, 'm1', request, true);
    expect(l.masters.items.P).toMatchObject({ name: '架空部品P', source: { name: '全社部品P-改', revision: '2026-10版' } });
    expect(last(l)).toMatchObject({ action: 'source', confirmed: true, masters: [{ before: { source: null }, after: { source: { revision: '2026-10版' } } }] });
  });

  test('5.4・5.6: 未登録の品番・コードと、変わらない更新は断る', () => {
    expect(() => change(practiceLedger, 'm1', { action: 'source', type: 'case', code: 'Z-999', source: { name: '何か', revision: '1' } }, true)).toThrow('未登録');
    const l = change(practiceLedger, 'm1', { action: 'source', type: 'case', code: 'A-001', source: { name: '架空案件・用途A', revision: '1' } }, true);
    expect(() => change(l, 'm2', { action: 'source', type: 'case', code: 'A-001', source: { name: '架空案件・用途A', revision: '1' } }, true)).toThrow('変更がない');
  });
});

describe('F1-B 3.3・要件6・要件7 1箱あたりの数と記録の対象の変更', () => {
  const perBox = (value: number, reason = '仕入先の包装変更'): MasterRequest => ({ action: 'perBox', id: 'S', value, reason });

  test('6.1: 1箱あたりの数を適用時点（実際の日時）つきで変え、時系列に足す', () => {
    const l = change(practiceLedger, 'm1', perBox(800), false, '10:00');
    expect(l.masters.items.S?.packaging?.perBox).toEqual([{ from: null, value: 1000 }, { from: day('10:00'), value: 800 }]);
    expect(last(l)).toMatchObject({ action: 'perBox', reason: '仕入先の包装変更' });
  });

  test('6.10: 整数で1以上・今と違う値・適用時点あり・入力した日時以前・前回より後だけを受け付ける。包装のない品目は変えない', () => {
    const once = change(practiceLedger, 'm1', perBox(800), false, '10:00');
    expect(() => change(practiceLedger, 'x1', perBox(0), false, '10:00')).toThrow();
    expect(() => change(practiceLedger, 'x2', perBox(1.5), false, '10:00')).toThrow();
    expect(() => change(practiceLedger, 'x3', perBox(1000), false, '10:00')).toThrow('同じ');
    expect(() => change(practiceLedger, 'x4', perBox(800), false, null)).toThrow('適用時点');
    expect(() => changeMasters(practiceLedger, meta('x5', '13:00', '12:00'), perBox(800))).toThrow('未来');
    expect(() => change(once, 'x6', perBox(900), false, '10:00')).toThrow('前回');
    expect(() => change(once, 'x7', perBox(900), false, '09:00')).toThrow('前回');
    expect(() => change(practiceLedger, 'x8', { action: 'perBox', id: 'P', value: 10, reason: '包装なし' }, false, '10:00')).toThrow('包装');
    expect(() => change(practiceLedger, 'x9', perBox(800, ''), false, '10:00')).toThrow('理由');
  });

  test('7.1・7.8: 記録の対象の内外を適用時点つきで変え、同じ状態や時点の条件を満たさない変更はしない', () => {
    const out = change(practiceLedger, 'm1', { action: 'scope', id: 'O', inScope: false, reason: '他部署へ移管' }, false, '10:00');
    expect(out.masters.locations.O?.scope).toEqual([{ from: null, inScope: true }, { from: day('10:00'), inScope: false }]);
    expect(() => change(out, 'm2', { action: 'scope', id: 'O', inScope: false, reason: '二度目' }, false, '11:00')).toThrow('同じ');
    expect(() => change(out, 'm3', { action: 'scope', id: 'O', inScope: true, reason: '戻す' }, false, '10:00')).toThrow('前回');
    expect(change(out, 'm4', { action: 'scope', id: 'O', inScope: true, reason: '戻す' }, false, '11:00').masters.locations.O?.scope).toHaveLength(3);
    expect(() => change(practiceLedger, 'm5', { action: 'scope', id: 'O', inScope: false, reason: '時点なし' }, false, null)).toThrow('適用時点');
  });

  test('7.2: 数量が0と分かっていない現存する保管単位が残る場所は外へ変えず、残りを示す。数量0の保管単位は止めない', () => {
    let l = register(practiceLedger, meta('r1', '08:00'), lotOf('X-1', 'X', 'O'), 'counted', 2);
    l = register(l, meta('r2', '08:00'), lotOf('X-2', 'X', 'O'), 'unknown', null);
    expect(() => change(l, 'm1', { action: 'scope', id: 'O', inScope: false, reason: '移管' }, false, '10:00')).toThrow(/X-1.*X-2|X-2.*X-1/);
    let emptied = use(register(practiceLedger, meta('r1', '08:00'), lotOf('X-1', 'X', 'O'), 'counted', 2), meta('u1', '08:30'), 'X-1', 'counted', 2, '架空作業');
    emptied = change(emptied, 'm1', { action: 'scope', id: 'O', inScope: false, reason: '移管' }, false, '10:00');
    expect(emptied.masters.locations.O?.scope).toHaveLength(2);
  });

  test('D9: 登録情報の変更の記録は、実際の日時の訂正の対象にしない', () => {
    const l = change(practiceLedger, 'm1', perBox(800), false, '10:00');
    expect(() => correctOccurredAt(l, meta('t1', '11:00'), 'm1', day('09:00'))).toThrow('登録情報');
  });
});

describe('F1-B 3.1・9.1・9.2 保存', () => {
  class MemoryStore implements StoreLike {
    readonly data = new Map<string, string>();
    getItem(key: string): string | null { return this.data.get(key) ?? null; }
    setItem(key: string, value: string): void { this.data.set(key, value); }
    removeItem(key: string): void { this.data.delete(key); }
  }

  test('登録情報の変更を書いた写しを読み直すと同じで、同じ操作IDの再送は二重に適用しない', () => {
    let l = change(practiceLedger, 'op1', { action: 'register', master: { type: 'item', code: null, name: '試作', units: ['個'], unitSteps: { '個': 1 }, trial: true, source: null } });
    l = change(l, 'op2', { action: 'deactivate', type: 'location', id: 'T', reason: '撤去' });
    l = change(l, 'op3', { action: 'code', type: 'item', id: 'P', code: 'Q', reason: '付け替え' }, true);
    const snapshot = initial(l, emptySupply);
    expect(parse(serialize(snapshot))).toEqual(snapshot);

    const store = new MemoryStore();
    const base = initial(practiceLedger, emptySupply);
    store.setItem('fuzzy-stock/slot-A', serialize(base));
    store.setItem('fuzzy-stock/head', 'A');
    const next = change(practiceLedger, 'op1', { action: 'rename', type: 'item', id: 'P', name: '架空部品P改', reason: '改名' });
    const values = { name: '架空部品P改' };
    const op = { opId: 'op1', opLabel: '名称の変更', values, fingerprint: fingerprintOf('名称の変更', values), actor: '架空担当A', startedAt: day('09:00'), savingSince: day('09:00') };
    const saved = commit(store, base, op, [{ conflictReviews: [], ledger: next, supply: emptySupply, targets: ['品目P'] }]);
    expect(saved.kind).toBe('saved');
    const reloaded = load(store);
    if (reloaded.kind !== 'ok') throw new Error(reloaded.kind);
    expect(reloaded.snapshot.ledger.masters.items.P?.name).toBe('架空部品P改');
    const again = commit(store, reloaded.snapshot, op, [{ conflictReviews: [], ledger: next, supply: emptySupply, targets: ['品目P'] }]);
    expect(again.kind).toBe('duplicate');
    if (again.kind === 'duplicate') expect(again.snapshot.ledger.history.filter((e) => e.kind === 'master')).toHaveLength(1);
  });

  test('固定登録情報は変更で書き換わらない', () => {
    change(practiceLedger, 'm1', { action: 'rename', type: 'item', id: 'P', name: '別名', reason: '試験' });
    expect(fixedMasters.items.P?.name).toBe('架空部品P');
  });
});
