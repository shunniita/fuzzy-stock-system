import { describe, expect, test } from 'vitest';
import { practiceLedger } from '../../src/domain/ledger.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { at, snapshot } from './record-fixture.ts';
import { commit, confirmedUnreadableReset, fingerprintOf, load, nextOpIdOf, replace, ReplaceUncertain, sameSnapshot, serialize, type Snapshot, type StoreLike } from '../../src/ui/storage.ts';

const head = 'fuzzy-stock/head';
const pendingKey = 'fuzzy-stock/pending';
const slotA = 'fuzzy-stock/slot-A';
const slotB = 'fuzzy-stock/slot-B';
const recoveryKey = 'fuzzy-stock/reset-recovery';
const garbage = '壊れた操作';

type Fault = { op: 'set' | 'remove'; key: string; after?: boolean };

// 失敗の位置を指定できる保存先。deadAfterSetは、そのキーへ一度でも書く操作をしたあと、そのキーを読めなくする。
class FaultStore implements StoreLike {
  readonly data = new Map<string, string>();
  readonly log: string[] = [];
  faults: Fault[] = [];
  deadAfterSet: string[] = [];
  private attempted = new Set<string>();
  getItem(key: string): string | null {
    if (this.deadAfterSet.includes(key) && this.attempted.has(key)) throw new Error('保存先を読めない');
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.log.push(`set ${key}`);
    this.attempted.add(key);
    const fault = this.faults.find(f => f.op === 'set' && f.key === key);
    if (fault && !fault.after) throw new Error('保存容量不足');
    this.data.set(key, value);
    if (fault?.after) throw new Error('書込後の応答を受け取れない');
  }
  removeItem(key: string): void {
    this.log.push(`remove ${key}`);
    this.attempted.add(key);
    const fault = this.faults.find(f => f.op === 'remove' && f.key === key);
    if (fault && !fault.after) throw new Error('保存中の操作を消せない');
    this.data.delete(key);
    if (fault?.after) throw new Error('削除後の応答を受け取れない');
  }
}

function readableStore(value: Snapshot): FaultStore {
  const store = new FaultStore();
  store.data.set(head, 'A');
  store.data.set(slotA, serialize(value));
  return store;
}

function unreadableStore(withPending: boolean): FaultStore {
  const store = new FaultStore();
  store.data.set(head, 'A');
  store.data.set(slotA, '壊れた値');
  if (withPending) store.data.set(pendingKey, garbage);
  return store;
}

const empty = { ledger: practiceLedger, supply: emptySupply };

describe('FH-F1A-02・F1-A 2.2〜2.5: 置き換えは記録全体（操作の索引・保存結果の解消・次の操作IDの下限）を持ち越す', () => {
  test('replaceは渡された記録全体を書き、同じ操作IDの再送が保存済みになり、次の操作IDが下限以上になる', () => {
    const backup = snapshot();
    const store = new FaultStore();
    const restored = replace(store, null, backup);
    expect(restored).toMatchObject({ revision: 0, lastWriter: 'init', opFloor: 30, ops: backup.ops, saveChecks: backup.saveChecks });
    expect(sameSnapshot({ ...restored, revision: backup.revision, lastWriter: backup.lastWriter }, backup)).toBe(true);
    expect(Number(nextOpIdOf(restored).slice(2))).toBeGreaterThanOrEqual(30);
    const loaded = load(store);
    if (loaded.kind !== 'ok') throw new Error('読込失敗');
    const op = { opId: 'op9', opLabel: '受入', values: { label: '0012-AB' }, fingerprint: '入力', actor: '架空担当A', startedAt: at, savingSince: at };
    const resend = commit(store, loaded.snapshot, op, [{ conflictReviews: [], ledger: backup.ledger, supply: backup.supply, targets: ['保管単位交換品'] }]);
    expect(resend.kind).toBe('duplicate');
    // 同じ操作IDを違う内容で使うことは断る。
    expect(commit(store, loaded.snapshot, { ...op, fingerprint: fingerprintOf('受け取り', { label: '別' }) }, [{ conflictReviews: [], ledger: backup.ledger, supply: backup.supply, targets: [] }]).kind).toBe('mismatch');
  });

  test('別の記録がある保存先へ置き換えても、在庫の操作の索引や下限は引き継がず、渡した記録のものになる', () => {
    const store = readableStore(snapshot());
    const current = load(store);
    if (current.kind !== 'ok') throw new Error('読込失敗');
    expect(Object.keys(current.snapshot.ops)).toEqual(['op9']);
    const restored = replace(store, current.snapshot, { ...empty, ops: {}, saveChecks: [], opFloor: 5 });
    expect(restored.revision).toBe(current.snapshot.revision + 1);
    expect(restored.ops).toEqual({});
    expect(restored.saveChecks).toEqual([]);
    expect(restored.opFloor).toBe(5);
  });

  test('操作の索引などを渡さない初期化は、これまでどおり空の索引と下限1になる', () => {
    const restored = replace(new FaultStore(), null, empty);
    expect(restored).toMatchObject({ ops: {}, saveChecks: [], opFloor: 1, revision: 0 });
  });

  test('読み込めない記録の置き換えも記録全体を書き、版は読めた見出しの版＋1、読めなければ0', () => {
    const store = unreadableStore(true);
    const restored = confirmedUnreadableReset(store, snapshot());
    expect(restored).toMatchObject({ revision: 0, opFloor: 30, ops: snapshot().ops });
    expect(load(store)).toMatchObject({ kind: 'ok', snapshot: restored, pending: null });
  });
});

describe('FH-F1A-02・F1-A 2.9・2.11: replaceの失敗は、前の記録のままか確かめられないときを区別する', () => {
  test('空の復元で見出しを書けず、孤立した写しも消せなければReplaceUncertainで再復元を求める', () => {
    const store = new FaultStore();
    store.faults = [{ op: 'set', key: head }, { op: 'remove', key: slotA }];
    expect(() => replace(store, null, empty)).toThrow(ReplaceUncertain);
    store.faults = [];
    expect(load(store).kind).toBe('unreadable');
    const next = confirmedUnreadableReset(store, empty);
    expect(load(store)).toMatchObject({ kind: 'ok', snapshot: next });
  });

  test('新しい写しの書き込みに失敗したら、元の例外で前の記録のまま', () => {
    const store = readableStore(snapshot()); store.faults = [{ op: 'set', key: slotB }];
    const before = serialize(snapshot());
    expect(() => replace(store, snapshot(), empty)).toThrow('保存容量不足');
    expect(store.data.get(head)).toBe('A');
    expect(store.data.get(slotA)).toBe(before);
  });

  test('見出しの書き込みに失敗し、見出しがそのままと確かめられたら、元の例外で前の記録のまま', () => {
    const store = readableStore(snapshot()); store.faults = [{ op: 'set', key: head }];
    expect(() => replace(store, snapshot(), empty)).toThrow('保存容量不足');
    expect(store.data.get(head)).toBe('A');
  });

  test('見出しの書き込み後の応答例外は、新しい写しを返す', () => {
    const store = readableStore(snapshot()); store.faults = [{ op: 'set', key: head, after: true }];
    const next = replace(store, snapshot(), empty);
    expect(load(store)).toMatchObject({ kind: 'ok', snapshot: next });
  });

  test('見出しの書き込みに失敗し、見出しを読み直せないときは、前の記録のままと言わずReplaceUncertain', () => {
    const store = readableStore(snapshot()); store.faults = [{ op: 'set', key: head }]; store.deadAfterSet = [head];
    expect(() => replace(store, snapshot(), empty)).toThrow(ReplaceUncertain);
  });

  test('見出しの書き込み後の応答例外で、見出しを読み直せないときもReplaceUncertain', () => {
    const store = readableStore(snapshot()); store.faults = [{ op: 'set', key: head, after: true }]; store.deadAfterSet = [head];
    expect(() => replace(store, snapshot(), empty)).toThrow(ReplaceUncertain);
  });

  test('空の保存先への置き換えで見出しの書き込みに失敗し、見出しがないままなら、元の例外で、書いた写しも残さない', () => {
    const store = new FaultStore(); store.faults = [{ op: 'set', key: head }];
    expect(() => replace(store, null, empty)).toThrow('保存容量不足');
    expect(store.data.has(head)).toBe(false);
    // 見出しのない写しが残ると、次の起動で空ではなく読み込めない記録になる。
    expect(store.data.has(slotA)).toBe(false);
    expect(load(store)).toEqual({ kind: 'empty' });
  });
});

describe('FH-F1A-02・F1-A 2.8・2.9・2.11: 読み込めない記録の置き換えは、古いpendingを見出しの切り替えより前に消す', () => {
  test('壊れた退避も、明示復元の失敗では文字列のまま残し、成功してから消す', () => {
    const store = unreadableStore(true);
    store.data.set(recoveryKey, '読めない復元の退避');
    const before = new Map(store.data);
    store.faults = [{ op: 'set', key: head }];
    expect(() => confirmedUnreadableReset(store, empty)).toThrow('保存容量不足');
    expect(store.data).toEqual(before);
    store.faults = [];
    const next = confirmedUnreadableReset(store, empty);
    expect(load(store)).toMatchObject({ kind: 'ok', snapshot: next, pending: null });
    expect(store.data.has(recoveryKey)).toBe(false);
  });

  test('退避の容量不足では、元の写し・見出し・pendingに触れない', () => {
    const store = unreadableStore(true);
    const before = new Map(store.data);
    store.faults = [{ op: 'set', key: recoveryKey }];
    expect(() => confirmedUnreadableReset(store, empty)).toThrow('保存容量不足');
    expect(store.data).toEqual(before);
  });

  test('新しい見出しを書いた直後に画面が閉じても、再読込で新しい記録を保持する', () => {
    const store = unreadableStore(true);
    const interrupted: Map<string, string>[] = [];
    const set = store.setItem.bind(store);
    store.setItem = (key, value) => { set(key, value); if (key === head) interrupted.push(new Map(store.data)); };
    const next = confirmedUnreadableReset(store, empty);
    const restarted = new FaultStore();
    for (const [key, value] of interrupted[0] ?? []) restarted.data.set(key, value);
    expect(load(restarted)).toMatchObject({ kind: 'ok', snapshot: next, pending: null });
    expect(restarted.data.has(recoveryKey)).toBe(false);
  });

  test('退避を片付けられない間は通常の保存を止め、再読込で新しい記録を保ったまま片付ける', () => {
    const store = unreadableStore(true);
    store.faults = [{ op: 'remove', key: recoveryKey }];
    expect(() => confirmedUnreadableReset(store, empty)).toThrow(ReplaceUncertain);
    expect(load(store).kind).toBe('unreadable');
    expect(store.data.has(recoveryKey)).toBe(true);
    store.faults = [];
    expect(load(store)).toMatchObject({ kind: 'ok', snapshot: { ledger: practiceLedger, supply: emptySupply }, pending: null });
    expect(store.data.has(recoveryKey)).toBe(false);
  });

  test.each([null, '壊れた見出し'])('FH-F1A-02: 見出しが%sの復元中に画面が閉じても、再読込で元の写しとpendingが戻る', previousHead => {
    const store = new FaultStore();
    if (previousHead !== null) store.data.set(head, previousHead);
    store.data.set(slotA, serialize(snapshot()));
    store.data.set(slotB, '元の読めない写し');
    store.data.set(pendingKey, garbage);
    const before = new Map(store.data);
    const interrupted: Map<string, string>[] = [];
    const set = store.setItem.bind(store);
    const remove = store.removeItem.bind(store);
    store.setItem = (key, value) => { set(key, value); if (key === slotA) interrupted.push(new Map(store.data)); };
    store.removeItem = key => { remove(key); if (key === pendingKey) interrupted.push(new Map(store.data)); };
    confirmedUnreadableReset(store, empty);
    expect(interrupted).toHaveLength(2);
    for (const data of interrupted) {
      const restarted = new FaultStore();
      for (const [key, value] of data) restarted.data.set(key, value);
      expect(load(restarted).kind).toBe('unreadable');
      expect(restarted.data).toEqual(before);
    }
  });

  test.each([null, '壊れた見出し'])('FH-F1A-02: 見出しが%sでも、復元の見出し書き込みに失敗したら両方の元の写しを残す', previousHead => {
    const store = new FaultStore();
    if (previousHead !== null) store.data.set(head, previousHead);
    store.data.set(slotA, serialize(snapshot()));
    store.data.set(slotB, '読み込めない旧写し');
    store.data.set(pendingKey, garbage);
    const before = new Map(store.data);
    store.faults = [{ op: 'set', key: head }];
    expect(() => confirmedUnreadableReset(store, empty)).toThrow('保存容量不足');
    expect(store.data).toEqual(before);
  });

  test('成功すると、新しい写しの見出しになり、古いpendingは残らない。pendingの削除は見出しの書き込みより前', () => {
    const store = unreadableStore(true);
    const next = confirmedUnreadableReset(store, empty);
    expect(store.data.get(head)).toBe('B');
    expect(store.data.has(pendingKey)).toBe(false);
    expect(store.log.indexOf(`remove ${pendingKey}`)).toBeLessThan(store.log.indexOf(`set ${head}`));
    expect(load(store)).toMatchObject({ kind: 'ok', snapshot: next, pending: null });
  });

  test('新しい写しの書き込みに失敗したら、見出し・写し・pendingのすべてが前のまま', () => {
    const store = unreadableStore(true); store.faults = [{ op: 'set', key: slotB }];
    const before = [...store.data];
    expect(() => confirmedUnreadableReset(store, empty)).toThrow('保存容量不足');
    expect([...store.data]).toEqual(before);
  });

  test('pendingの削除に失敗し、残っていると確かめられたら、見出しを切り替えず前の記録のまま', () => {
    const store = unreadableStore(true); store.faults = [{ op: 'remove', key: pendingKey }];
    expect(() => confirmedUnreadableReset(store, empty)).toThrow('保存中の操作を消せない');
    expect(store.data.get(head)).toBe('A');
    expect(store.data.get(pendingKey)).toBe(garbage);
    expect(store.log).not.toContain(`set ${head}`);
  });

  test('削除の応答例外でも、pendingが消えていれば続けて完了する', () => {
    const store = unreadableStore(true); store.faults = [{ op: 'remove', key: pendingKey, after: true }];
    const next = confirmedUnreadableReset(store, empty);
    expect(load(store)).toMatchObject({ kind: 'ok', snapshot: next, pending: null });
  });

  test('pendingの削除に失敗し、残っているか読み直せないときは、見出しを切り替えずReplaceUncertain', () => {
    const store = unreadableStore(true); store.faults = [{ op: 'remove', key: pendingKey }]; store.deadAfterSet = [];
    // 削除を試みたあとだけ読めなくする。
    const original = store.removeItem.bind(store);
    let removed = false;
    store.removeItem = (key: string) => { removed = true; original(key); };
    const get = store.getItem.bind(store);
    store.getItem = (key: string) => { if (removed && key === pendingKey) throw new Error('保存先を読めない'); return get(key); };
    expect(() => confirmedUnreadableReset(store, empty)).toThrow(ReplaceUncertain);
    expect(store.data.get(head)).toBe('A');
    expect(store.log).not.toContain(`set ${head}`);
  });

  test('見出しの書き込みに失敗し、見出しがそのままと確かめられたら、pendingを元の文字列で書き戻して前の記録のまま', () => {
    const store = unreadableStore(true); store.faults = [{ op: 'set', key: head }];
    expect(() => confirmedUnreadableReset(store, empty)).toThrow('保存容量不足');
    expect(store.data.get(head)).toBe('A');
    expect(store.data.get(slotA)).toBe('壊れた値');
    expect(store.data.get(pendingKey)).toBe(garbage);
  });

  test('控えたpendingがなければ、見出しの失敗でpendingを書かない', () => {
    const store = unreadableStore(false); store.faults = [{ op: 'set', key: head }];
    expect(() => confirmedUnreadableReset(store, empty)).toThrow('保存容量不足');
    expect(store.log).not.toContain(`set ${pendingKey}`);
    expect(store.data.has(pendingKey)).toBe(false);
  });

  test('見出しの書き込みに失敗し、pendingの書き戻しにも失敗したらReplaceUncertain', () => {
    const store = unreadableStore(true); store.faults = [{ op: 'set', key: head }, { op: 'set', key: pendingKey }];
    expect(() => confirmedUnreadableReset(store, empty)).toThrow(ReplaceUncertain);
  });

  test('見出しの書き込み後の応答例外は、新しい写しを返す。pendingは先に消えている', () => {
    const store = unreadableStore(true); store.faults = [{ op: 'set', key: head, after: true }];
    const next = confirmedUnreadableReset(store, empty);
    expect(store.data.has(pendingKey)).toBe(false);
    expect(load(store)).toMatchObject({ kind: 'ok', snapshot: next });
  });

  test('見出しの書き込みに失敗し、見出しを読み直せないときは、pendingを書き戻さずReplaceUncertain', () => {
    const store = unreadableStore(true); store.faults = [{ op: 'set', key: head }]; store.deadAfterSet = [head];
    expect(() => confirmedUnreadableReset(store, empty)).toThrow(ReplaceUncertain);
    expect(store.log).not.toContain(`set ${pendingKey}`);
  });

  test('読み込める記録には使わない', () => {
    const store = readableStore(snapshot());
    const before = [...store.data];
    expect(() => confirmedUnreadableReset(store, empty)).toThrow();
    expect([...store.data]).toEqual(before);
  });
});

describe('FH-F1A-02・F1-A 2.9・2.11: どの失敗の位置でも、新しい写しのそばに古いpendingが残らず、再読込のあとにもう一度置き換えられる', () => {
  const keys = [slotB, pendingKey, head];
  const combos: { faults: Fault[]; dead: string[] }[] = [];
  for (const key of keys) {
    for (const op of ['set', 'remove'] as const) {
      for (const after of [false, true]) {
        for (const dead of [[], [head], [pendingKey]]) combos.push({ faults: [{ op, key, after }], dead });
      }
    }
  }
  // 見出しの失敗と、pendingの書き戻しの失敗の組み合わせ。
  for (const dead of [[], [head]]) combos.push({ faults: [{ op: 'set', key: head }, { op: 'set', key: pendingKey }], dead });

  test.each(combos.map((combo, index) => [index, JSON.stringify(combo)] as const))('位置%i：%s', (index) => {
    const combo = combos[index];
    if (combo === undefined) throw new Error('試験の組み合わせがない');
    const store = unreadableStore(true); store.faults = combo.faults; store.deadAfterSet = combo.dead;
    let outcome: 'returned' | 'uncertain' | 'failed';
    try { confirmedUnreadableReset(store, empty); outcome = 'returned'; }
    catch (error) { outcome = error instanceof ReplaceUncertain ? 'uncertain' : 'failed'; }
    // 新しい見出しなら、古いpendingはない。
    if (store.data.get(head) === 'B') expect(store.data.has(pendingKey)).toBe(false);
    // 見出しが前のままなら、前の記録（壊れた写し）のまま。
    if (store.data.get(head) === 'A') expect(store.data.get(slotA)).toBe('壊れた値');
    if (outcome === 'returned') expect(store.data.get(head)).toBe('B');
    // 再読込のあと（読めなくする細工を外した保存先）は、読めるか読めないかのどちらかで、もう一度置き換えられる。
    const reloaded = new FaultStore();
    for (const [key, value] of store.data) reloaded.data.set(key, value);
    const state = load(reloaded);
    expect(['ok', 'unreadable']).toContain(state.kind);
    const again = state.kind === 'ok'
      ? (state.pending === null ? replace(reloaded, state.snapshot, empty) : confirmedUnreadableReset(reloaded, empty))
      : confirmedUnreadableReset(reloaded, empty);
    expect(again).toMatchObject({ opFloor: 1 });
    expect(reloaded.data.has(pendingKey)).toBe(false);
  });
});
