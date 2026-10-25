import { describe, expect, test, vi } from 'vitest';
import { restoreSelectionOf, type RestoreState } from '../../src/ui/restore-selection.ts';
import { initial, load, replace, confirmedUnreadableReset, ReplaceUncertain, serialize, type RecordContents, type Snapshot, type StoreLike } from '../../src/ui/storage.ts';
import { requestReset } from '../../src/ui/saveui.ts';
import { backupTextOf } from '../../src/ui/backup.ts';
import { practiceLedger } from '../../src/domain/ledger.ts';
import type { CodeHolds } from '../../src/ui/code-input.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { seedLedger } from '../../src/ui/seed.ts';

const createdAt = (byte: number) => `2026-10-11T00:0${byte}:00+09:00`;
function screen(io?: Parameters<typeof restoreSelectionOf>[4]) {
  const data = new Map<string, string>();
  const writes = vi.fn((key: string, value: string) => { data.set(key, value); });
  const store: StoreLike = {
    getItem: key => data.get(key) ?? null,
    setItem: writes,
    removeItem: key => { data.delete(key); },
  };
  const snapshot = replace(store, null, initial(practiceLedger, emptySupply));
  const state: { -readonly [K in keyof RestoreState]: RestoreState[K] } = {
    snapshot, pending: null, stale: false, resetEpoch: 0, saveView: { kind: 'ready' },
    saveError: null, resetRequest: null, resetOrigin: 'management', notice: null, noticeOrigin: 'management', restoreFromUnreadable: false,
    restoreSelection: 0, resetFailure: null, selectedLot: null, message: null, conflictBlock: null,
  };
  const input: { value: string; files: Pick<File, 'size' | 'arrayBuffer'>[]; click: () => void } = { value: '', files: [], click: vi.fn() };
  const render = vi.fn();
  const codeHolds: CodeHolds = { project: 'A-001', location: 'S1' };
  const clearCodeHolds = vi.fn(() => { codeHolds.project = null; codeHolds.location = null; });
  const handlers = restoreSelectionOf(state, input, store, {
    renderSave: render, renderAll: render,
    useSnapshot: next => { state.snapshot = next; },
    stopUnreadable: reason => { state.saveView = { kind: 'unreadable', reason }; },
    clearCodeHolds,
    blockedFor: action => `blocked: ${action}`,
  }, io);
  writes.mockClear();
  const request = () => {
    const current = state.resetRequest;
    if (current === null || current.kind !== 'confirmation') return null;
    return current;
  };
  let resetRun: (() => void | Promise<void>) | null = null;
  return {
    input, render, state, writes, store, data, codeHolds, clearCodeHolds,
    get resetRun() { return resetRun; },
    choose: handlers.chooseRestoreFile, read: handlers.restoreFileChosen, cancel: handlers.cancelRestoreFile,
    get request() { return request(); }, get notice() { return state.notice; },
    reset: () => handlers.askReplace((run, current) => {
      resetRun = run;
      return requestReset('reset', run, current);
    }, () => snapshot, false, 'reset'),
    resetUnreadable: () => handlers.askReplace((run, current) => requestReset('reset', run, current), () => snapshot, true, 'reset'),
    change: (kind: string) => {
      if(kind === 'epoch') state.resetEpoch++;
      if(kind === 'snapshot') state.snapshot = initial(practiceLedger, emptySupply);
      if(kind === 'pending') state.pending = { progress: 'saving', unknownSince: null, savingSince: createdAt(1), baseRevision: 0,
        opId: 'pending', opLabel: 'pending', fingerprint: '', values: {}, actor: 'fictional', startedAt: createdAt(1), units: [] };
      if(kind === 'stale') state.stale = true;
    },
  };
}
function fileRead(byte: number) {
  // The handler reads this synthetic File's real asynchronous arrayBuffer contract.
  let resolve!: (data: ArrayBuffer) => void, reject!: (error: Error) => void;
  const promise = new Promise<ArrayBuffer>((yes, no) => {resolve=yes;reject=no;});
  return { file: {size:1,arrayBuffer:()=>promise}, resolve:()=>resolve(new TextEncoder().encode(byte === 0 ? 'invalid backup' : backupTextOf(initial(practiceLedger, emptySupply), createdAt(byte))).buffer), reject:()=>reject(new Error('old read failed')) };
}

function start(s: ReturnType<typeof screen>, byte: number) {
  s.choose(false);
  const deferred = fileRead(byte);
  s.input.files = [deferred.file];
  const finished = s.read();
  return {...deferred, finished};
}
describe('FH-F1A-14・FH-F1A-15の部分確認: 復元ファイルの選択と確認の寿命', () => {
  test('置換の応答が失われても同じ処置の保存済みreceiptを反映し、再適用しない', async () => {
    let saved: Snapshot | null = null;
    const apply = vi.fn((store: StoreLike, current: Snapshot | null, next: RecordContents) => {
      saved = replace(store, current, next); throw new Error('応答喪失');
    });
    const s = screen({ load, replace: apply, confirmedUnreadableReset, inquireReplacement: async () => saved });
    s.reset(); const request = s.request!;
    expect(await request.confirm()).toBe(true);
    expect(s.state.snapshot).toBe(saved); expect(s.state.resetEpoch).toBe(1);
    expect(await request.confirm()).toBe(false); expect(apply).toHaveBeenCalledTimes(1);
  });
  test('結果不明の置換はreceipt照会も失敗しても元の理由と中断状態を保持する', async () => {
    let attempted = false;
    const s = screen({ load, replace: () => { attempted = true; throw new ReplaceUncertain('置換応答喪失'); }, confirmedUnreadableReset,
      inquireReplacement: async () => { if (attempted) throw new Error('読戻し失敗'); return null; } });
    s.reset(); expect(await s.request!.confirm()).toBe(true);
    expect(s.state.saveView).toEqual({ kind: 'replaceUncertain', reason: '置換応答喪失' });
    expect(s.state.stale).toBe(true);
  });
  test.each(['success', 'invalid', 'error'])('新しい選択のあと古い%sを無視する', async outcome => {
    const s = screen();
    const first = start(s, outcome === 'invalid' ? 0 : 1);
    const second = start(s, 2);
    second.resolve(); await second.finished;
    const current = s.request;
    if(outcome === 'error') first.reject(); else first.resolve();
    await first.finished;
    expect(s.request).toBe(current);
    expect(s.request?.message).toContain('00:02');
    expect(s.request?.message).toContain('元の資料の重複確認は復元した履歴の範囲だけです。復元時点より後の原票は別途照合してください。');
    expect(s.notice).toBeNull();
  });
  test.each(['epoch','snapshot','pending','stale'])('読込中の%s変更で確認を作らない', async kind => {
    const s = screen(), read = start(s, 1);
    s.change(kind); read.resolve(); await read.finished;
    expect(s.request).toBeNull(); expect(s.writes).not.toHaveBeenCalled();
  });
  test('初期化の確認が古い読込で置き換わらない', async () => {
    const s = screen(), read = start(s, 1);
    s.reset(); const current = s.request;
    read.resolve(); await read.finished;
    expect(s.request).toBe(current);
  });
  test.each(['dialog','cancel','reset','epoch'])('古い確認は%sのあと保存できない', async action => {
    const s = screen(), read = start(s, 1);
    read.resolve(); await read.finished;
    const old = s.request!;
    if(action === 'dialog') s.choose(false);
    if(action === 'cancel') s.cancel();
    if(action === 'reset') s.reset();
    if(action === 'epoch') s.change('epoch');
    await expect(old.confirm()).rejects.toThrow();
    expect(s.writes).not.toHaveBeenCalled();
    if(action === 'dialog' || action === 'cancel') expect(s.request).toBeNull();
  });
  test('ファイル選択の取消は進行中の読込も無効にする', async () => {
    const s = screen(), read = start(s, 1);
    s.cancel(); read.resolve(); await read.finished;
    expect(s.request).toBeNull();
  });
  test('成功した置換の生callbackも再度保存できない', async () => {
    const s = screen();
    s.reset();
    const run = s.resetRun!;
    expect(await s.request!.confirm()).toBe(true);
    const savedWrites = s.writes.mock.calls.length;
    expect(savedWrites).toBeGreaterThan(0);
    // 確認部品のactiveとは別に、本体のepochによる失効を検査する。
    await expect(run()).rejects.toThrow('現在の確認からやり直してください');
    expect(s.writes).toHaveBeenCalledTimes(savedWrites);
  });
  test('現在の確認だけが一度復元できる', async () => {
    const s = screen(), read = start(s, 1);
    read.resolve(); await read.finished;
    const confirmation = s.request!;
    await confirmation.confirm();
    expect(s.codeHolds).toEqual({ project: null, location: null });
    expect(s.writes).toHaveBeenCalledTimes(2);
    expect(await confirmation.confirm()).toBe(false);
    expect(s.writes).toHaveBeenCalledTimes(2);
  });
  test('保存直前の別画面の更新を検出し、保持を解除して上書きしない', async () => {
    const s = screen(), read = start(s, 1);
    read.resolve(); await read.finished;
    const old = s.request!;
    const external = replace(s.store, s.state.snapshot, initial(practiceLedger, emptySupply));
    s.writes.mockClear();
    await expect(old.confirm()).rejects.toThrow('保存先の状態が変わっている');
    expect(s.writes).not.toHaveBeenCalled();
    expect(s.state.snapshot).toEqual(external);
    expect(s.state.saveView).toEqual({ kind: 'conflict' });
    expect(s.state.stale).toBe(true);
    expect(s.request).toBeNull();
    expect(s.codeHolds).toEqual({ project: null, location: null });
  });
  test('置換の結果を確かめられないときは保持を解除し、生callbackも失効する', async () => {
    const s = screen();
    s.reset();
    const run = s.resetRun!;
    const before = s.state.snapshot;
    s.writes.mockImplementation((key, value) => {
      if (key === 'fuzzy-stock/head') {
        s.store.getItem = () => { throw new Error('read lost'); };
        throw new Error('head response lost');
      }
      s.data.set(key, value);
    });
    expect(await s.request!.confirm()).toBe(true);
    expect(s.state.snapshot).toBe(before);
    expect(s.state.saveView.kind).toBe('replaceUncertain');
    expect(s.state.stale).toBe(true);
    expect(s.codeHolds).toEqual({ project: null, location: null });
    const savedWrites = s.writes.mock.calls.length;
    await expect(run()).rejects.toThrow('現在の確認からやり直してください');
    expect(s.writes).toHaveBeenCalledTimes(savedWrites);
  });
  test('保存直前に同じ版番号の内容だけが変わっても上書きせず、現在の記録を表示する', async () => {
    const s = screen(), read = start(s, 1);
    read.resolve(); await read.finished;
    const confirmation = s.request!;
    const external = initial(seedLedger(), emptySupply);
    expect(external.revision).toBe(s.state.snapshot.revision);
    const head = s.store.getItem('fuzzy-stock/head');
    expect(head).not.toBeNull();
    s.data.set(`fuzzy-stock/slot-${head}`, serialize(external));
    expect(load(s.store)).toMatchObject({ kind: 'ok', snapshot: external, pending: null });
    const stored = [...s.data];
    s.writes.mockClear();
    await expect(confirmation.confirm()).rejects.toThrow('保存先の状態が変わっている');
    expect(s.writes).not.toHaveBeenCalled();
    expect([...s.data]).toEqual(stored);
    expect(s.state.snapshot).toEqual(external);
    expect(s.state.saveView).toEqual({ kind: 'conflict' });
    expect(s.state.stale).toBe(true);
    expect(s.request).toBeNull();
    expect(s.codeHolds).toEqual({ project: null, location: null });
  });

});

describe('競合保持Task4.4: 未解消の更新競合の入力があるあいだの初期化・復元', () => {
  const block = '未解消の更新競合の入力があるため、初期化・復元はしません。';
  test('入口で止め、確認を作らず、保存先と選択窓を変えない', async () => {
    const s = screen();
    s.state.conflictBlock = block;
    const before = [...s.data];
    s.reset();
    expect(s.state.notice).toBe(block); expect(s.request).toBeNull(); expect(s.state.resetRequest).toBeNull();
    s.choose(false);
    expect(s.state.notice).toBe(block); expect(s.input.click).not.toHaveBeenCalled();
    expect(s.writes).not.toHaveBeenCalled(); expect([...s.data]).toEqual(before);
  });

  test('確認を作った後に未解消の入力が生じたら、実行時にも止めて保存先を変えない', async () => {
    const s = screen();
    s.reset();
    expect(s.request).not.toBeNull();
    s.state.conflictBlock = block;
    const before = [...s.data];
    await expect(s.resetRun?.()).rejects.toThrow(block);
    expect(s.writes).not.toHaveBeenCalled(); expect([...s.data]).toEqual(before);
    expect(s.state.snapshot.revision).toBe(0);
  });

  test('保存先を読めない状態からの明示復元(unreadable)は適用しない', async () => {
    const s = screen();
    s.state.conflictBlock = block;
    s.choose(true);
    expect(s.input.click).toHaveBeenCalledTimes(1);
    expect(s.state.restoreFromUnreadable).toBe(true);
  });

  test('保存先を読めない状態からの初期化の確認(unreadable)も未解消の入力で止めない', async () => {
    const s = screen();
    s.state.conflictBlock = block;
    s.resetUnreadable();
    expect(s.request).not.toBeNull(); expect(s.state.notice).toBeNull();
  });

  test('復元ファイルを選んだ後の読込のあいだに未解消の入力が生じたら、読込完了時に確認を作らず止める', async () => {
    const s = screen();
    const read = start(s, 1);
    s.state.conflictBlock = block;
    read.resolve();
    await read.finished;
    expect(s.request).toBeNull(); expect(s.state.resetRequest).toBeNull(); expect(s.state.notice).toBe(block);
    expect(s.writes).not.toHaveBeenCalled();
  });

  test('止める理由がなければ従来どおり確認が作られる', async () => {
    const s = screen();
    s.reset();
    expect(s.request).not.toBeNull(); expect(s.state.notice).toBeNull();
  });
});

describe('画面の並べ替え: 確認と通知は生成した入口を別々に保持する', () => {
  test.each(['reset', 'restore'] as const)('FH-F1A-14部分確認: 管理の%s成功は管理の通知へ残す', async operation => {
    const s = screen();
    if (operation === 'reset') s.reset();
    else {
      const read = start(s, 1);
      read.resolve(); await read.finished;
    }
    expect(s.writes).not.toHaveBeenCalled();
    s.state.notice = '架空の古い回復通知';
    s.state.noticeOrigin = 'recovery';
    expect(await s.request!.confirm()).toBe(true);
    expect(s.state.noticeOrigin).toBe('management');
    expect(s.notice).toBe(operation === 'reset' ? 'reset' : `復元した（${createdAt(1)}のバックアップ）`);
    expect(s.writes).toHaveBeenCalledTimes(2);
  });

  test('回復の確認後の管理拒否が、確認の表示元を変えない', async () => {
    const s = screen();
    s.resetUnreadable();
    const request = s.request;
    s.state.conflictBlock = '架空の競合';
    s.reset();
    expect(s.request).toBe(request);
    expect(s.state).toMatchObject({ resetOrigin: 'recovery', noticeOrigin: 'management', notice: '架空の競合' });
    expect(s.writes).not.toHaveBeenCalled();
  });
  test.each([false, true])('非同期拒否の表示元は読込開始時のunreadable=%s', async unreadable => {
    const s = screen();
    s.choose(unreadable);
    const read = fileRead(0);
    s.input.files = [read.file];
    const finished = s.read();
    s.state.restoreFromUnreadable = !unreadable;
    read.resolve(); await finished;
    expect(s.state).toMatchObject({ noticeOrigin: unreadable ? 'recovery' : 'management' });
    expect(s.notice).toContain('復元に使えない');
    expect(s.writes).not.toHaveBeenCalled();
  });
  test('新しい回復確認のあと古い通常読込の拒否が表示元を書き換えない', async () => {
    const s = screen(), read = start(s, 0);
    s.resetUnreadable();
    const request = s.request;
    read.resolve(); await read.finished;
    expect(s.request).toBe(request);
    expect(s.state).toMatchObject({ resetOrigin: 'recovery', noticeOrigin: 'management', notice: null });
  });
});
