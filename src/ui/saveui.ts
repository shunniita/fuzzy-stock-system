import type { RecordCounts } from './backup.ts';
import { h } from './dom.ts';
import { jst, targetLabel } from './format.ts';
import { isReviewOperation } from './conflictrecord.ts';
import { candidateLines } from './conflict-ui.ts';
import { faults, settlementOutcome, unknownSinceOf, type CommitResult, type Pending, type SaveCheck, type SaveOutcome, type Snapshot, type inquire } from './storage.ts';

export type Inquiry = ReturnType<typeof inquire>;
export type SaveView =
  | { kind: 'ready' }
  | { kind: 'saved'; opId: string }
  | { kind: 'duplicate'; opId: string; remainder?: Extract<CommitResult, { kind: 'duplicate' }>['remainder'] }
  | (Extract<CommitResult, { kind: 'partial' }> & { inquiry: Inquiry | null })
  | { kind: 'failed'; reason: string }
  | { kind: 'unknown'; pending: Pending; inquiry: Inquiry | null }
  | { kind: 'recovered'; check: SaveCheck }
  | { kind: 'settled'; snapshot: Snapshot; pending: Pending; outcome: SaveOutcome | null }
  | { kind: 'conflict' }
  // 記録の置き換えの途中で、保存先が前の記録のままか確かめられなくなった。別の画面の保存（conflict）とは原因が違うので文言を分ける。
  | { kind: 'replaceUncertain'; reason: string }
  | { kind: 'unreadable'; reason: string };

export type SaveAction = 'inquire' | 'retry' | 'abandon' | 'confirmSaved' | 'reload' | 'unreadableReset' | 'unreadableRestore';
export type SaveActions = Record<SaveAction, () => void>;
export type SavePresentation = { lines: string[]; actions: { name: SaveAction; label: string }[] };
export type SaveTone = 'success' | 'error' | 'warning' | 'info';

export function saveTone(view: SaveView, errorNotice: string | null): SaveTone {
  if (errorNotice !== null) return 'error';
  switch (view.kind) {
    case 'unknown': case 'unreadable': case 'replaceUncertain': case 'failed': return 'error';
    case 'partial': return unknownSinceOf(view.pending) !== null ? 'error' : 'warning';
    case 'conflict': return 'warning';
    case 'duplicate': return view.remainder === undefined ? 'success' : 'warning';
    case 'saved': return 'success';
    case 'ready': return 'info';
    case 'recovered': return view.check.resolution.outcome === 'saved' || view.check.resolution.outcome === 'retried' ? 'success' : 'info';
    case 'settled': {
      const saved = view.snapshot.ops[view.pending.opId]?.units.length ?? 0;
      const outcome = view.outcome ?? settlementOutcome(saved, view.pending.units.length);
      return outcome === 'saved' || outcome === 'retried' ? 'success' : 'info';
    }
    default: {
      const exhaustive: never = view;
      return exhaustive;
    }
  }
}

export function pendingView(pending: Pending, inquiry: Inquiry | null, reason = '前回の未保存の単位が残っている'): SaveView {
  if (unknownSinceOf(pending) !== null || inquiry === null || inquiry.savedUnits === 0 || inquiry.savedUnits === inquiry.total) return { kind: 'unknown', pending, inquiry };
  return { kind: 'partial', snapshot: inquiry.snapshot, pending, saved: inquiry.savedUnits, total: inquiry.total, reason, inquiry };
}

export type ReplaceTexts = {
  label: string; message: string; confirmLabel: string; cancelLabel: string;
  // 確認を押したとき未完了の保存があって実行しなかった場合の説明と、実行が例外になった場合の説明。
  blocked: string; failed(reason: string): string;
};
export type ResetRequest =
  | { kind: 'blocked'; message: string }
  | { kind: 'confirmation'; label: string; message: string; confirmLabel: string; cancelLabel: string; blocked: string; failed(reason: string): string; confirm(): boolean | Promise<boolean>; cancel(): void };

export type TestHooks = { loseResponseAt(n: number): void; failMidwayAt(n: number): void };
export type TestHost = { location: Pick<Location, 'search'>; fuzzyStockTest?: TestHooks };

declare global {
  interface Window {
    fuzzyStockTest?: TestHooks;
  }
}

const targetsText = (targets: readonly string[]): string => [...new Set(targets)].map(targetLabel).join(', ') || 'なし';
const inputLines = (pending: Pending): string[] => [
  `操作：${pending.opLabel}`,
  ...Object.entries(pending.values).map(([label, value]) => `${label}：${typeof value === 'boolean' ? value ? 'はい' : 'いいえ' : value || '（空欄）'}`),
  `対象：${targetsText(pending.units.flatMap((unit) => unit.targets))}`,
];

function unitLines(pending: Pending, snapshot: Snapshot, saved: number): string[] {
  const idsOf = (state: Pick<Snapshot, 'ledger' | 'supply' | 'conflictReviews'>) => [...state.ledger.history, ...state.supply.log, ...state.conflictReviews].map((event) => event.eventId);
  return pending.units.map((unit, index) => {
    const before = new Set(idsOf(pending.units[index - 1] ?? snapshot));
    const ids = snapshot.ops[pending.opId]?.units[index] ?? idsOf(unit).filter((id) => !before.has(id));
    return `単位${index + 1}：${index < saved ? '保存済み' : '未保存'}　操作ID：${ids.join(', ') || 'なし'}　対象：${targetsText(unit.targets)}`;
  });
}

function outcomeText(outcome: SaveOutcome): string {
  switch (outcome) {
    case 'saved': return '保存済みだった';
    case 'retried': return '再試行で保存した';
    case 'remainderAbandoned': return '未保存の残りを取りやめた';
    case 'abandoned': return '未保存のまま取りやめた';
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

const targetLines = (savedTargets: readonly string[], unsavedTargets: readonly string[]): string[] => [
  `保存済みの対象：${targetsText(savedTargets)}`,
  `未保存の対象：${targetsText(unsavedTargets)}`,
];

const resolvedLines = (opId: string, opLabel: string, outcome: SaveOutcome, savedTargets: readonly string[], unsavedTargets: readonly string[]): string[] => [
  `記録済みの解消（操作ID：${opId}）`,
  `操作：${opLabel}`,
  `解消の結果：${outcomeText(outcome)}`,
  ...targetLines(savedTargets, unsavedTargets),
];

export function savePresentation(view: SaveView, errorNotice: string | null = null): SavePresentation {
  let lines: string[];
  const actions: SavePresentation['actions'] = [];
  switch (view.kind) {
    case 'ready':
      lines = ['記録を入力できます。'];
      break;
    case 'saved':
      lines = [`保存した（操作ID：${view.opId}）`];
      break;
    case 'duplicate':
      lines = view.remainder === undefined
        ? [`保存済み。もう一度は記録しない（操作ID：${view.opId}）`]
        : [`一部の記録は保存済み。もう一度は記録しない（操作ID：${view.opId}）`, '未保存の残りを取りやめた', ...targetLines(view.remainder.savedTargets, view.remainder.unsavedTargets)];
      break;
    case 'failed':
      lines = ['保存できなかった（記録されていない）', `理由：${view.reason}`, '入力内容を残しています。もう一度記録できます。'];
      break;
    case 'partial':
    case 'unknown': {
      const { pending, inquiry } = view;
      const unknown = unknownSinceOf(pending) !== null;
      lines = [view.kind === 'partial' && !unknown ? `一部だけ保存した（操作ID：${pending.opId}）` : `保存結果不明（操作ID：${pending.opId}）`, ...inputLines(pending)];
      if (view.kind === 'partial') {
        lines.push(`理由：${view.reason}`);
        const numbers = pending.units.map((_, index) => index + 1);
        lines.push(`保存した単位：${numbers.slice(0, view.saved).join(', ') || 'なし'}`, `保存できなかった単位：${numbers.slice(view.saved).join(', ') || 'なし'}`);
        if (inquiry === null) lines.push(...unitLines(pending, view.snapshot, view.saved));
      }
      if (unknownSinceOf(pending) !== null) {
        lines.push('保存結果不明の確認事項は未解決です。台帳の「確認が必要（未解決）・未反映」とは別の状態です。');
      }
      // 競合した元入力そのものではなく、その照合結果の保存が結果不明であることを区別する。
      if (isReviewOperation(pending)) {
        lines.push('この保存結果不明は、更新競合の元入力ではなく、照合結果の保存です。元入力の退避は、保存済みを確認するまで残します。数量は変わりません。');
        const candidate = pending.units[0]?.conflictReviews.at(-1);
        if (candidate !== undefined) lines.push('保存結果を確認中の照合結果（固定した候補。この内容のまま照会・再試行・取りやめを行う）', ...candidateLines(candidate));
      }
      actions.push({ name: 'inquire', label: '照会する' }, { name: 'retry', label: view.kind === 'partial' && !unknown ? '記録し直す' : '再試行する' }, { name: 'abandon', label: '取りやめる' });
      if (inquiry !== null) {
        lines.push(`照会の結果：${inquiry.total}単位中${inquiry.savedUnits}単位が保存済み`, ...unitLines(pending, inquiry.snapshot, inquiry.savedUnits));
        if (inquiry.savedUnits === inquiry.total) actions.push({ name: 'confirmSaved', label: '保存済みとして確定する' });
      }
      break;
    }
    case 'recovered': {
      const { check } = view;
      lines = [...resolvedLines(check.opId, check.opLabel, check.resolution.outcome, check.savedTargets, check.unsavedTargets), `確認者：${check.resolution.actor}`, `確認日時：${check.resolution.at}`];
      break;
    }
    case 'settled': {
      const saved = view.snapshot.ops[view.pending.opId]?.units.length ?? 0;
      const outcome = view.outcome ?? settlementOutcome(saved, view.pending.units.length);
      const savedTargets = view.pending.units.slice(0, saved).flatMap((unit) => unit.targets);
      const unsavedTargets = view.pending.units.slice(saved).flatMap((unit) => unit.targets);
      lines = view.outcome === null
        ? [`${outcome === 'saved' ? '保存済みを確認した' : '取りやめた'}（操作ID：${view.pending.opId}）`, `操作：${view.pending.opLabel}`, `結果：${outcomeText(outcome)}`, ...targetLines(savedTargets, unsavedTargets)]
        : resolvedLines(view.pending.opId, view.pending.opLabel, outcome, savedTargets, unsavedTargets);
      break;
    }
    case 'conflict':
      lines = ['別の画面で記録が保存された。記録を止めています。再読込してください。'];
      actions.push({ name: 'reload', label: '再読込する' });
      break;
    case 'replaceUncertain':
      lines = ['復元の途中で保存先の状態を確かめられなくなった', `理由：${view.reason}`, '記録を止めています。再読込して記録を確かめ、必要なら復元をやり直してください。'];
      actions.push({ name: 'reload', label: '再読込する' });
      break;
    case 'unreadable':
      lines = ['保存された記録を読み込めない', `理由：${view.reason}`, '初期化または復元を確認するまで、保存された記録は消したり上書きしたりしません。'];
      actions.push({ name: 'unreadableReset', label: '保存された記録を消して初期化する' }, { name: 'unreadableRestore', label: 'バックアップから復元する' });
      break;
    default: {
      const exhaustive: never = view;
      return exhaustive;
    }
  }
  if (errorNotice !== null) lines.push(errorNotice);
  return { lines, actions };
}

export type FeedbackOrigin = 'management' | 'recovery';

export function savePanel(view: SaveView, actions: SaveActions, errorNotice: string | null = null): HTMLElement {
  const shown = savePresentation(view, errorNotice);
  const tone = saveTone(view, errorNotice);
  const toneLabel = { success: '成功', error: 'エラー', warning: '警告', info: '情報' } satisfies Record<SaveTone, string>;
  const panel = h('div', { role: 'region', 'aria-label': '保存の状態', 'aria-live': 'polite', 'data-tone': tone, class: 'save-notice' },
    h('span', { class: 'save-tone' }, toneLabel[tone]), ...shown.lines.map((line) => h('p', {}, line)));
  for (const action of shown.actions) {
    const button = h('button', { type: 'button' }, action.label);
    button.addEventListener('click', actions[action.name]);
    panel.append(button);
  }
  return panel;
}

const resetBlocked = '保存結果不明・一部だけ保存した入力を、照会・再試行・取りやめで確かめてから初期化してください。';

export function requestReplace(texts: ReplaceTexts, replace: () => void | Promise<void>, pending: () => Pending | null): ResetRequest {
  if (pending() !== null) return { kind: 'blocked', message: texts.blocked };
  let active = true;
  return {
    kind: 'confirmation', ...texts,
    confirm: () => {
      if (!active || pending() !== null) return false;
      const result = replace();
      if (result instanceof Promise) {
        active = false;
        return result.then(() => true, (error: unknown) => { active = true; throw error; });
      }
      active = false;
      return true;
    },
    cancel: () => { active = false; },
  };
}

export function requestReset(label: string, reset: () => void | Promise<void>, pending: () => Pending | null): ResetRequest {
  return requestReplace({
    label: '初期化の確認', message: `保存済みの記録は消え、${label}で置き換わる。初期化しますか。`, confirmLabel: '初期化する', cancelLabel: 'やめる',
    blocked: resetBlocked, failed: reason => `初期化を完了できなかった：${reason}。もう一度確認できます。`,
  }, reset, pending);
}

const countsText = (counts: RecordCounts): string => `保管単位${counts.lots}件・履歴${counts.records}件・未完了の依頼${counts.openRequests}件`;

// 復元の確認。作成日時と件数を示し、読み込めない記録を置き換えるときはそう書く（要件2.1・2.8）。
export function restoreTexts(createdAt: string, counts: RecordCounts, unreadable: boolean): ReplaceTexts {
  return {
    label: '復元の確認',
    message: `${unreadable ? '読み込めない記録' : 'この端末の記録'}は消え、${jst(createdAt)}に作成したバックアップ（${countsText(counts)}）で置き換わる。復元しますか。`,
    confirmLabel: '復元する', cancelLabel: 'やめる',
    blocked: '保存結果不明・一部だけ保存した入力を、照会・再試行・取りやめで確かめてから復元してください。',
    failed: reason => `復元できなかった：${reason}。記録は復元前のまま。もう一度確認できます。`,
  };
}

export function backupResultText(fileName: string, counts: RecordCounts): string {
  return `復元用バックアップを書き出した（${fileName}、${countsText(counts)}）。ファイルは各自で保管する`;
}

// failure は、実行が例外になって画面が描き直されたあとにも、直前の失敗の理由を示すために渡す。
export function resetPanel(request: ResetRequest, close: () => void, failure: string | null = null): HTMLElement {
  const message = h('p', {}, failure ?? request.message);
  const panel = h('div', { role: 'region', 'aria-label': request.kind === 'confirmation' ? request.label : '初期化の確認' }, message);
  if (request.kind === 'confirmation') {
    const confirm = h('button', { type: 'button' }, request.confirmLabel);
    const cancel = h('button', { type: 'button' }, request.cancelLabel);
    confirm.addEventListener('click', async () => {
      const focused = document.activeElement === confirm;
      let completed = false;
      confirm.disabled = true; cancel.disabled = true;
      try { completed = await request.confirm(); if (!completed) message.textContent = request.blocked; }
      catch (error) { message.textContent = request.failed(error instanceof Error ? error.message : String(error)); }
      finally { confirm.disabled = false; cancel.disabled = false; if (focused) confirm.focus(); }
      if (completed) close();
    });
    cancel.addEventListener('click', () => { request.cancel(); close(); });
    panel.append(confirm, cancel);
  }
  return panel;
}

export function setupTestHooks(host: TestHost): void {
  delete host.fuzzyStockTest;
  if (!new URLSearchParams(host.location.search).has('test')) return;
  host.fuzzyStockTest = {
    loseResponseAt: (n) => { faults.loseResponseAt = n; },
    failMidwayAt: (n) => { faults.failMidwayAt = n; },
  };
}
