import { fixedMasters } from '../../src/domain/masters.ts';
import { beforeEach, describe, expect, test } from 'vitest';
import { practiceLedger, type Meta } from '../../src/domain/ledger.ts';
import { allocateArrival, emptySupply, receiveLot, recordRequest } from '../../src/domain/supply.ts';
import { faults, initial, type Pending, type SaveCheck, type SaveOutcome, type Snapshot, type UnitState } from '../../src/ui/storage.ts';
import { backupResultText, pendingView, requestReplace, requestReset, restoreTexts, savePresentation, saveTone, setupTestHooks, type SaveTone, type SaveView, type TestHost } from '../../src/ui/saveui.ts';

const at = '2026-10-05T09:00:00+09:00';
const meta = (eventId: string): Meta => ({ eventId, occurredAt: at, recordedAt: at, actor: '架空担当A' });

function fixture() {
  const project = { kind: 'case', id: 'B-001' } satisfies Parameters<typeof recordRequest>[3]['project'];
  const request = { project, item: 'P', unit: '個', quantity: 8, vendor: '架空仕入先', requestedOn: '2026-10-05', reply: { kind: 'none' } } satisfies Parameters<typeof recordRequest>[3];
  const supplied = recordRequest(recordRequest(emptySupply, fixedMasters, meta('q1'), request), fixedMasters, meta('q2'), request);
  const before = initial(practiceLedger, supplied);
  const received = receiveLot(practiceLedger, supplied, meta('op10'), { id: 'R1', item: 'P', unit: '個', project, location: 'S1' }, 'counted', 10, '0001-架空箱');
  const first = { ledger: received.ledger, supply: allocateArrival(received.ledger, received.supply, meta('op10-a1'), 'q1', { receiptLotId: 'R1', arrived: 6, good: 4 }) };
  const second = { ledger: first.ledger, supply: allocateArrival(first.ledger, first.supply, meta('op10-a2'), 'q2', { receiptLotId: 'R1', arrived: 4, good: 4 }) };
  const units: UnitState[] = [{ conflictReviews: [], ...received, targets: ['まとまりR1'] }, { conflictReviews: [], ...first, targets: ['依頼q1', 'まとまりR1'] }, { conflictReviews: [], ...second, targets: ['依頼q2', 'まとまりR1'] }];
  const pending: Pending = { progress: 'saving', unknownSince: null, savingSince: at, baseRevision: before.revision, opId: 'op10', opLabel: '受入', fingerprint: '架空の入力', values: { '架空ラベル': '0001-架空箱', '数量': '10', '確認済み': false }, actor: '架空担当A', startedAt: at, units };
  const ids = [['op10', 'op10-c'], ['op10-a1'], ['op10-a2']];
  const snapshot = (saved: number): Snapshot => ({ ...before, ...(units[saved - 1] ?? {}), revision: saved, lastWriter: saved === 0 ? 'init' : 'op10', ops: saved === 0 ? {} : { op10: { fingerprint: pending.fingerprint, units: ids.slice(0, saved) } } });
  return { before, pending, snapshot };
}

beforeEach(() => { faults.loseResponseAt = null; faults.failMidwayAt = null; });

describe('画面整理4.3・4.4: 保存通知の種類は既存の結果から導く', () => {
  const { pending, snapshot } = fixture();
  const cases: [SaveView, SaveTone][] = [
    [{ kind: 'ready' }, 'info'],
    [{ kind: 'saved', opId: 'op10' }, 'success'],
    [{ kind: 'duplicate', opId: 'op10' }, 'success'],
    [{ kind: 'duplicate', opId: 'op10', remainder: { savedTargets: ['まとまりR1'], unsavedTargets: ['依頼q2'] } }, 'warning'],
    [{ kind: 'failed', reason: '架空の容量不足' }, 'error'],
    [{ kind: 'unknown', pending, inquiry: null }, 'error'],
    [{ kind: 'unknown', pending, inquiry: { snapshot: snapshot(3), savedUnits: 3, total: 3 } }, 'error'],
    [{ kind: 'partial', pending: { ...pending, progress: 'partial' }, snapshot: snapshot(2), saved: 2, total: 3, reason: '架空の失敗', inquiry: null }, 'warning'],
    [{ kind: 'partial', pending: { ...pending, progress: 'partial', unknownSince: at }, snapshot: snapshot(2), saved: 2, total: 3, reason: '架空の失敗', inquiry: null }, 'error'],
    [{ kind: 'conflict' }, 'warning'],
    [{ kind: 'replaceUncertain', reason: '架空の読取失敗' }, 'error'],
    [{ kind: 'unreadable', reason: '架空の破損' }, 'error'],
    [{ kind: 'settled', pending, snapshot: snapshot(0), outcome: null }, 'info'],
    [{ kind: 'settled', pending, snapshot: snapshot(2), outcome: null }, 'info'],
    [{ kind: 'settled', pending, snapshot: snapshot(3), outcome: null }, 'success'],
  ];
  for (const outcome of ['saved', 'retried', 'remainderAbandoned', 'abandoned'] as const) {
    const tone = outcome === 'saved' || outcome === 'retried' ? 'success' : 'info';
    cases.push([{ kind: 'settled', pending, snapshot: snapshot(2), outcome }, tone]);
    cases.push([{ kind: 'recovered', check: { opId: 'op10', opLabel: '受入', savedTargets: ['まとまりR1'], unsavedTargets: ['依頼q2'], attempt: '架空入力', openedAt: at, resolution: { outcome, actor: '架空担当B', at } } }, tone]);
  }
  test.each(cases)('%jを%sとして示し、原文と操作を変えない', (view, expected) => {
    const before = savePresentation(view);
    expect(saveTone(view, null)).toBe(expected);
    expect(savePresentation(view)).toEqual(before);
    expect(saveTone(view, '架空の追加エラー')).toBe('error');
    expect(savePresentation(view, '架空の追加エラー')).toEqual({ lines: [...before.lines, '架空の追加エラー'], actions: before.actions });
  });
});

describe('B3 3.2: 保存の状態の表示', () => {
  test.each([
    [{ kind: 'ready' }, '記録を入力できます'],
    [{ kind: 'saved', opId: 'op10' }, '保存した（操作ID：op10）'],
    [{ kind: 'duplicate', opId: 'op10' }, '保存済み。もう一度は記録しない（操作ID：op10）'],
    [{ kind: 'failed', reason: '容量不足' }, '保存できなかった（記録されていない）'],
    [{ kind: 'conflict' }, '別の画面で記録が保存された'],
    [{ kind: 'unreadable', reason: '試作の別の版の形式' }, '保存された記録を読み込めない'],
  ] satisfies [SaveView, string][])('%jの文言を保存結果に合わせる', (view, expected) => {
    const shown = savePresentation(view);
    expect(shown.lines.join('\n')).toContain(expected);
    if (view.kind === 'failed' || view.kind === 'unreadable') expect(shown.lines.join('\n')).toContain(view.reason);
    if (view.kind === 'conflict') expect(shown.actions).toEqual([{ name: 'reload', label: '再読込する' }]);
    if (view.kind === 'unreadable') expect(shown.actions).toEqual([{ name: 'unreadableReset', label: '保存された記録を消して初期化する' }, { name: 'unreadableRestore', label: 'バックアップから復元する' }]);
  });

  test('4.1・4.3・4.8: 保存結果不明はID・操作・日本語欄名と値・種類付き対象を残し、未反映と区別する', () => {
    const { pending } = fixture();
    const shown = savePresentation({ kind: 'unknown', pending, inquiry: null });
    const text = shown.lines.join('\n');
    expect(text).toContain('保存結果不明（操作ID：op10）');
    expect(text).toContain('操作：受入');
    expect(text).toContain('架空ラベル：0001-架空箱');
    expect(text).toContain('数量：10');
    expect(text).toContain('確認済み：いいえ');
    expect(text).toContain('保管単位R1');
    expect(text).toContain('依頼q2');
    expect(text).toContain('確認が必要（未解決）・未反映');
    expect(text).not.toContain('保存した');
    expect(text).not.toContain('保存できなかった');
    expect(shown.actions.map((action) => action.label)).toEqual(['照会する', '再試行する', '取りやめる']);
  });

  test('2.4: 一部保存は保存した単位・保存できなかった単位の操作IDと対象を分け、記録し直せる', () => {
    const { pending, snapshot } = fixture();
    const knownPartial: Pending = { ...pending, progress: 'partial' };
    const shown = savePresentation({ kind: 'partial', pending: knownPartial, snapshot: snapshot(2), saved: 2, total: 3, reason: '容量不足', inquiry: null });
    const text = shown.lines.join('\n');
    expect(text).toContain('一部だけ保存した');
    expect(text).toContain('保存した単位：1, 2');
    expect(text).toContain('保存できなかった単位：3');
    expect(text).toContain('単位1：保存済み　操作ID：op10, op10-c　対象：保管単位R1');
    expect(text).toContain('単位2：保存済み　操作ID：op10-a1　対象：依頼q1, 保管単位R1');
    expect(text).toContain('単位3：未保存　操作ID：op10-a2　対象：依頼q2, 保管単位R1');
    expect(text).toContain('数量：10');
    expect(text).not.toContain('保存結果不明');
    expect(shown.actions.find((action) => action.name === 'retry')?.label).toBe('記録し直す');
  });

  test.each([0, 2, 3])('4.7: 照会で%s単位保存済みと分かっても、不明の解消は全保存の明示確認まで行わない', (savedUnits) => {
    const { pending, snapshot } = fixture();
    const shown = savePresentation({ kind: 'unknown', pending, inquiry: { snapshot: snapshot(savedUnits), savedUnits, total: 3 } });
    expect(shown.lines[0]).toContain('保存結果不明');
    expect(shown.lines.filter((line) => line.startsWith('単位') && line.includes('：保存済み'))).toHaveLength(savedUnits);
    expect(shown.lines.filter((line) => line.startsWith('単位') && line.includes('：未保存'))).toHaveLength(3 - savedUnits);
    expect(shown.actions.some((action) => action.name === 'confirmSaved')).toBe(savedUnits === 3);
    if (savedUnits === 3) expect(shown.actions.at(-1)?.label).toBe('保存済みとして確定する');
    expect(pending.progress).toBe('saving');
  });

  test('結果不明からの再試行が一部保存になっても、未解決の保存照合と入力・再操作欄を残す', () => {
    const { pending, snapshot } = fixture();
    const shown = savePresentation({ kind: 'partial', pending: { ...pending, progress: 'partial', unknownSince: at }, snapshot: snapshot(2), saved: 2, total: 3, reason: '容量不足', inquiry: null });
    expect(shown.lines.join('\n')).toContain('保存結果不明の確認事項は未解決');
    expect(shown.lines.join('\n')).toContain('架空ラベル：0001-架空箱');
    expect(shown.actions.map((action) => action.name)).toEqual(['inquire', 'retry', 'abandon']);
  });

  test.each([
    ['saved', '保存済みだった'], ['retried', '再試行で保存した'],
    ['remainderAbandoned', '未保存の残りを取りやめた'], ['abandoned', '未保存のまま取りやめた'],
  ] satisfies [SaveOutcome, string][])('記録済みの解消%sを元の結果・対象・確認者・日時どおり表示する', (outcome, expected) => {
    const check: SaveCheck = { opId: 'op10', opLabel: '受入', savedTargets: outcome === 'abandoned' ? [] : ['まとまりR1'], unsavedTargets: outcome === 'saved' || outcome === 'retried' ? [] : ['依頼q2'], attempt: '架空入力', openedAt: at, resolution: { outcome, actor: '架空担当B', at } };
    const shown = savePresentation({ kind: 'recovered', check });
    const text = shown.lines.join('\n');
    expect(shown.lines[0]).toContain('記録済みの解消');
    expect(text).toContain(expected);
    expect(text).toContain('保存済みの対象：');
    expect(text).toContain('未保存の対象：');
    expect(text).toContain('架空担当B');
    expect(text).toContain(at);
    expect(shown.actions).toEqual([]);
  });

  test.each([
    [0, '取りやめた', '未保存のまま取りやめた'],
    [2, '取りやめた', '未保存の残りを取りやめた'],
    [3, '保存済みを確認した', '保存済みだった'],
  ] satisfies [number, string, string][])('解消記録0のoutcome:null（%s単位保存済み）は、記録済みとせず実際の結果と対象を示す', (saved, headline, outcome) => {
    const { pending, snapshot } = fixture();
    const current = snapshot(saved);
    expect(current.saveChecks).toEqual([]);
    const shown = savePresentation({ kind: 'settled', pending: { ...pending, progress: 'partial' }, snapshot: current, outcome: null });
    expect(shown.lines[0]).toBe(`${headline}（操作ID：op10）`);
    expect(shown.lines.join('\n')).toContain(outcome);
    expect(shown.lines.join('\n')).toContain('保存済みの対象：');
    expect(shown.lines.join('\n')).toContain('未保存の対象：');
    if (saved === 2) expect(shown.lines.join('\n')).toContain('未保存の対象：依頼q2, 保管単位R1');
    expect(shown.lines[0]).not.toContain('保存した');
    expect(shown.lines.join('\n')).not.toContain('記録済みの解消');
    expect(current.saveChecks).toEqual([]);
  });

  test.each([0, 3])('未解消の結果不明は保存済み%s単位でも一部保存と表示しない', savedUnits => {
    const { pending, snapshot } = fixture();
    const view = pendingView({ ...pending, progress: 'partial', unknownSince: at }, { snapshot: snapshot(savedUnits), savedUnits, total: 3 });
    expect(view.kind).toBe('unknown');
    const shown = savePresentation(view);
    expect(shown.lines[0]).toContain('保存結果不明');
    expect(shown.lines.join('\n')).not.toContain('一部だけ保存した');
    expect(shown.lines.join('\n')).toContain(`3単位中${savedUnits}単位が保存済み`);
  });

  test('取りやめ後の再送は保存済みと未保存の対象を分け、全保存と言わない', () => {
    const shown = savePresentation({ kind: 'duplicate', opId: 'op10', remainder: { savedTargets: ['まとまりR1'], unsavedTargets: ['依頼q2'] } });
    expect(shown.lines[0]).toContain('一部の記録は保存済み');
    expect(shown.lines).toContain('未保存の残りを取りやめた');
    expect(shown.lines).toContain('未保存の対象：依頼q2');
    expect(shown.actions).toEqual([]);
  });

  test('解消の試行失敗は元の不明の入力と再操作欄を残して理由を添えられる', () => {
    const { pending } = fixture();
    const shown = savePresentation({ kind: 'unknown', pending, inquiry: null }, '照会できなかった：保存先を読めない');
    expect(shown.lines[0]).toContain('保存結果不明');
    expect(shown.lines.join('\n')).toContain('保存先を読めない');
    expect(shown.actions.map((action) => action.name)).toEqual(['inquire', 'retry', 'abandon']);
  });
});

describe('8.4: 初期化の確認', () => {
  test('初期化の保存で例外になっても、同じ確認から再試行できる', () => {
    let attempts = 0;
    const request = requestReset('空の台帳', () => {
      if (++attempts === 1) throw new Error('保存容量不足');
    }, () => null);
    if (request.kind !== 'confirmation') throw new Error('確認が必要');
    expect(() => request.confirm()).toThrow('保存容量不足');
    expect(request.confirm()).toBe(true);
    expect(attempts).toBe(2);
    expect(request.confirm()).toBe(false);
  });
  test('確認前とやめた場合は初期化せず、確認だけが一度実行する', () => {
    let resets = 0;
    const cancelled = requestReset('固定の架空データ', () => { resets++; }, () => null);
    expect(resets).toBe(0);
    expect(cancelled.kind).toBe('confirmation');
    if (cancelled.kind !== 'confirmation') return;
    expect(cancelled.message).toBe('保存済みの記録は消え、固定の架空データで置き換わる。初期化しますか。');
    expect([cancelled.confirmLabel, cancelled.cancelLabel]).toEqual(['初期化する', 'やめる']);
    cancelled.cancel();
    expect(cancelled.confirm()).toBe(false);
    expect(resets).toBe(0);
    const confirmed = requestReset('空の台帳', () => { resets++; }, () => null);
    if (confirmed.kind !== 'confirmation') throw new Error('初期化の確認が必要');
    expect(confirmed.confirm()).toBe(true);
    expect(confirmed.confirm()).toBe(false);
    expect(resets).toBe(1);
  });

  test('保存結果不明・一部保存の間は要求を止め、確認欄を開いたあと未完了になっても初期化しない', () => {
    const { pending } = fixture();
    let resets = 0;
    for (const current of [pending, { ...pending, progress: 'partial' } satisfies Pending]) {
      expect(requestReset('SCN-02の架空データ', () => { resets++; }, () => current).kind).toBe('blocked');
    }
    let current: Pending | null = null;
    const request = requestReset('固定の架空データ', () => { resets++; }, () => current);
    current = pending;
    if (request.kind !== 'confirmation') throw new Error('確認前にpendingはない');
    expect(request.confirm()).toBe(false);
    expect(resets).toBe(0);
  });
});

describe('5.3・10.2: 画面に出ない試験用の口', () => {
  test('通常URL・通常のqueryには口を置かず、testというパラメーターがあるときだけ障害へつなぐ', () => {
    for (const search of ['', '?item=test', '?contest=1', '?testMode=true']) {
      const host: TestHost = { location: { search } };
      setupTestHooks(host);
      expect(host.fuzzyStockTest).toBeUndefined();
    }
    const host: TestHost = { location: { search: '?test' } };
    setupTestHooks(host);
    expect(host.fuzzyStockTest).toBeDefined();
    host.fuzzyStockTest?.loseResponseAt(2);
    host.fuzzyStockTest?.failMidwayAt(3);
    expect(faults).toEqual({ loseResponseAt: 2, failMidwayAt: 3 });
    host.location.search = '?item=P';
    setupTestHooks(host);
    expect(host.fuzzyStockTest).toBeUndefined();
  });
});

describe('FH-F1A-08・F1-A 2.1・2.7・2.8・2.11: 置き換えの確認（復元）と、前の記録のままか確かめられない表示', () => {
  const counts = { lots: 12, records: 340, openRequests: 3 };

  test('復元の確認は、作成日時と件数を示し、読み込めない記録を置き換えるときはそう書く', () => {
    const normal = restoreTexts('2026-10-07T15:30:00+09:00', counts, false);
    expect(normal.message).toBe('この端末の記録は消え、2026-10-07 15:30（日本時間）に作成したバックアップ（保管単位12件・履歴340件・未完了の依頼3件）で置き換わる。復元しますか。');
    expect([normal.confirmLabel, normal.cancelLabel]).toEqual(['復元する', 'やめる']);
    expect(restoreTexts('2026-10-07T15:30:00+09:00', counts, true).message).toMatch(/^読み込めない記録は消え、2026-10-07 15:30（日本時間）に作成したバックアップ/);
  });

  test('復元の確認を確かめると一度だけ実行し、取り消すと実行せず、失敗は同じ確認から再試行できる', () => {
    let runs = 0;
    const request = requestReplace(restoreTexts('2026-10-07T15:30:00+09:00', counts, false), () => { if (++runs === 1) throw new Error('保存容量不足'); }, () => null);
    if (request.kind !== 'confirmation') throw new Error('確認が必要');
    expect(request.label).toBe('復元の確認');
    expect(() => request.confirm()).toThrow('保存容量不足');
    expect(request.failed('保存容量不足')).toBe('復元できなかった：保存容量不足。記録は復元前のまま。もう一度確認できます。');
    expect(request.confirm()).toBe(true);
    expect(request.confirm()).toBe(false);
    expect(runs).toBe(2);
    const cancelled = requestReplace(restoreTexts('2026-10-07T15:30:00+09:00', counts, false), () => { runs++; }, () => null);
    if (cancelled.kind !== 'confirmation') throw new Error('確認が必要');
    cancelled.cancel();
    expect(cancelled.confirm()).toBe(false);
    expect(runs).toBe(2);
  });

  test('保存結果不明・一部だけ保存した入力があるときは、復元を止めて理由を示す。確認を開いたあとの未完了でも復元しない', () => {
    const { pending } = fixture();
    const blocked = requestReplace(restoreTexts('2026-10-07T15:30:00+09:00', counts, false), () => undefined, () => pending);
    expect(blocked).toMatchObject({ kind: 'blocked', message: '保存結果不明・一部だけ保存した入力を、照会・再試行・取りやめで確かめてから復元してください。' });
    let current: Pending | null = null;
    let runs = 0;
    const request = requestReplace(restoreTexts('2026-10-07T15:30:00+09:00', counts, false), () => { runs++; }, () => current);
    current = pending;
    if (request.kind !== 'confirmation') throw new Error('確認前にpendingはない');
    expect(request.confirm()).toBe(false);
    expect(runs).toBe(0);
  });

  test('初期化の確認は、これまでの文言のまま', () => {
    const request = requestReset('空の台帳', () => undefined, () => null);
    if (request.kind !== 'confirmation') throw new Error('確認が必要');
    expect(request.label).toBe('初期化の確認');
    expect(request.failed('保存容量不足')).toBe('初期化を完了できなかった：保存容量不足。もう一度確認できます。');
  });

  test('前の記録のままか確かめられないときは、別の画面の保存と言わず、理由と再読込を示す', () => {
    const shown = savePresentation({ kind: 'replaceUncertain', reason: '保存先を読めない' });
    const text = shown.lines.join(' ');
    expect(text).toContain('復元の途中で保存先の状態を確かめられなくなった');
    expect(text).toContain('理由：保存先を読めない');
    expect(text).toContain('再読込して記録を確かめ、必要なら復元をやり直してください');
    expect(text).not.toContain('別の画面');
    expect(shown.actions).toEqual([{ name: 'reload', label: '再読込する' }]);
  });

  test('バックアップを書き出したときの表示は、書き出したことと件数を示し、保管は各自の責任と書く', () => {
    expect(backupResultText('fuzzy-stock_復元用バックアップ_架空データ_20261007-153000.json', counts)).toBe(
      '復元用バックアップを書き出した（fuzzy-stock_復元用バックアップ_架空データ_20261007-153000.json、保管単位12件・履歴340件・未完了の依頼3件）。ファイルは各自で保管する');
  });
});
