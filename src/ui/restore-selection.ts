import { confirmedUnreadableReset, load, replace, ReplaceUncertain, sameSnapshot, type Pending, type RecordContents, type Snapshot, type StoreLike } from './storage.ts';
import { maxBackupBytes, readBackup, type BackupRead, type RecoveryData } from './backup.ts';
import { validateRecovery } from './shared-backup.ts';
import { requestReplace, restoreTexts, savePresentation, type FeedbackOrigin, type ResetRequest, type SaveView } from './saveui.ts';

const direct = { load, replace, confirmedUnreadableReset };
type StorageActions = {
  load: (store: StoreLike) => ReturnType<typeof load> | Promise<ReturnType<typeof load>>;
  replace: (store: StoreLike, current: Snapshot | null, next: RecordContents, recovery?: RecoveryData, requestId?: string) => Snapshot | Promise<Snapshot>;
  confirmedUnreadableReset: (store: StoreLike, next: RecordContents, recovery?: RecoveryData, requestId?: string) => Snapshot | Promise<Snapshot>;
  inquireReplacement?: (store: StoreLike, current: Snapshot | null, next: RecordContents, recovery: RecoveryData | undefined, requestId: string, unreadable: boolean) => Promise<Snapshot | null>;
};

// main の現在値を accessor で共有し、読込中の別操作も同じ状態から検査する。
export interface RestoreState {
  readonly snapshot: Snapshot;
  pending: Pending | null;
  stale: boolean;
  resetEpoch: number;
  saveView: SaveView;
  saveError: string | null;
  resetRequest: ResetRequest | null;
  resetOrigin: FeedbackOrigin;
  notice: string | null;
  noticeOrigin: FeedbackOrigin;
  restoreFromUnreadable: boolean;
  restoreSelection: number;
  resetFailure: string | null;
  selectedLot: string | null;
  message: { kind: 'ok' | 'error'; text: string } | null;
  // 未解消の更新競合の入力があるあいだ、通常の初期化・復元を止める理由。なければnull。保存先を読めない状態からの復元(unreadable)には適用しない。
  readonly conflictBlock: string | null;
}

export function restoreSelectionOf(state: RestoreState, restoreInput: { files: ArrayLike<Pick<File, 'size' | 'arrayBuffer'>> | null; value: string; click(): void }, browserStore: StoreLike, effects: {
  renderSave: () => void; renderAll: () => void;
  useSnapshot: (next: Snapshot) => void; stopUnreadable: (reason: string) => void;
  blockedFor: (action: string) => string; clearCodeHolds: () => void;
}, io: StorageActions & { guard?: (action: () => Promise<void>) => Promise<void> } = direct) {
  const { renderSave, renderAll, useSnapshot, stopUnreadable, blockedFor, clearCodeHolds } = effects;
  function setNotice(text: string, unreadable: boolean): void {
    state.notice = text;
    state.noticeOrigin = unreadable ? 'recovery' : 'management';
  }
  // 初期化と復元で同じ確認・置換の寿命を使う。
  function askReplace(make: (run: () => void | Promise<void>, current: () => Pending | null) => ResetRequest, next: () => RecordContents, unreadable: boolean, done: string, recovery?: RecoveryData): void {
    if (state.stale) { state.saveView = { kind: 'conflict' }; setNotice(state.conflictBlock ?? savePresentation(state.saveView).lines.join(' '), unreadable); renderSave(); return; }
    if (!unreadable && state.conflictBlock !== null) { setNotice(state.conflictBlock, unreadable); renderSave(); return; }
    const selection = ++state.restoreSelection;
    const epoch = state.resetEpoch;
    const requestId = crypto.randomUUID();
    let contents: RecordContents | null = null;
    const expected = unreadable ? null : state.snapshot;
    const applyReplacement = (replacement: Snapshot): void => {
      if (selection !== state.restoreSelection || epoch !== state.resetEpoch || state.resetRequest !== request) throw new Error('現在の確認からやり直してください');
      useSnapshot(replacement); state.pending = null; state.resetEpoch++; state.selectedLot = null; clearCodeHolds();
      state.saveView = { kind: 'ready' }; state.saveError = null; state.message = { kind: 'ok', text: done }; state.notice = null;
      if (!unreadable) setNotice(done, false);
    };
    const knownReplacement = async (): Promise<Snapshot | null> => {
      if (io.inquireReplacement === undefined || contents === null) return null;
      return io.inquireReplacement(browserStore, expected, contents, recovery, requestId, unreadable);
    };
    state.resetFailure = null;
    // 読み込み不能の確認は破損したpendingも対象にする。通常の置き換えは未完了を拒否する。
    const execute = async (): Promise<void> => {
      if (selection !== state.restoreSelection || epoch !== state.resetEpoch || state.resetRequest !== request) throw new Error('現在の確認からやり直してください');
      if (state.stale) throw new Error('別の画面で記録が保存された。再読込してください');
      if (!unreadable && state.conflictBlock !== null) throw new Error(state.conflictBlock);
      try {
        contents ??= next();
        const known = await knownReplacement();
        if (known !== null) { applyReplacement(known); return; }
        if (!unreadable) {
          const current = await io.load(browserStore);
          if (current.kind !== 'ok' || current.pending !== null || !sameSnapshot(current.snapshot, state.snapshot)) throw new Error('保存先の状態が変わっている。再読込してください');
        }
        if (selection !== state.restoreSelection || epoch !== state.resetEpoch || state.resetRequest !== request) throw new Error('現在の確認からやり直してください');
        const replacement = unreadable ? await io.confirmedUnreadableReset(browserStore, contents, recovery, requestId) : await io.replace(browserStore, state.snapshot, contents, recovery, requestId);
        applyReplacement(replacement);
      } catch (error) {
        try {
          const known = await knownReplacement();
          if (known !== null) { applyReplacement(known); return; }
        } catch (inquiryError) { if (!(error instanceof ReplaceUncertain)) error = inquiryError; }
        // 前の記録のままか確かめられないときは、別の画面の保存と区別して止め、再読込のあとにやり直せるようにする。
        if (error instanceof ReplaceUncertain) {
          state.stale = true; state.resetEpoch++; clearCodeHolds(); state.saveView = { kind: 'replaceUncertain', reason: error.message };
          return;
        }
        // 画面を描き直すと確認の欄も作り直されるので、失敗の理由を先に控えて、作り直した欄にも示す。
        if (state.resetRequest?.kind === 'confirmation') state.resetFailure = state.resetRequest.failed(error instanceof Error ? error.message : String(error));
        const loaded = await io.load(browserStore);
        if (loaded.kind === 'unreadable') { stopUnreadable(loaded.reason); }
        else if (loaded.kind === 'ok' && (loaded.pending !== null || !sameSnapshot(loaded.snapshot, state.snapshot))) {
          useSnapshot(loaded.snapshot); state.pending = loaded.pending; state.resetEpoch++; clearCodeHolds();
          state.stale = true; state.saveView = { kind: 'conflict' }; state.resetRequest = null; state.resetFailure = null;
          renderAll();
        }
        throw error;
      }
    };
    const request = make(() => io.guard === undefined ? execute() : io.guard(execute), () => unreadable ? null : state.pending);
    state.resetRequest = request;
    state.resetOrigin = unreadable ? 'recovery' : 'management';
    renderSave();
  }

  function chooseRestoreFile(unreadable: boolean): void {
    cancelRestoreFile();
    state.notice = null;
    if (!unreadable) {
      if (state.stale) { state.saveView = { kind: 'conflict' }; setNotice(state.conflictBlock ?? savePresentation(state.saveView).lines.join(' '), unreadable); renderSave(); return; }
      if (state.pending !== null) { setNotice(`復元しなかった。${blockedFor('復元')}`, unreadable); renderSave(); return; }
      if (state.conflictBlock !== null) { setNotice(state.conflictBlock, unreadable); renderSave(); return; }
    }
    state.restoreFromUnreadable = unreadable;
    restoreInput.value = '';
    restoreInput.click();
  }

  function cancelRestoreFile(): void {
    state.restoreSelection++;
    state.resetRequest = null; state.resetFailure = null;
    renderSave();
  }

  const refusal = (read: Exclude<BackupRead, { kind: 'ok' }>): string => {
    switch (read.kind) {
      case 'viewOutput': return '復元に使えない：閲覧用の出力は復元に使えない。復元には、復元用バックアップ（.json）を選んでください。';
      case 'newer': return '復元に使えない：このソフトが読めない新しい版のバックアップ（版が違う）。';
      case 'unreadable': return `復元に使えない：${read.reason}`;
    }
  };

  async function restoreFileChosen(): Promise<void> {
    const file = restoreInput.files?.[0];
    const unreadable = state.restoreFromUnreadable;
    const selection = ++state.restoreSelection;
    const epoch = state.resetEpoch;
    const before = state.snapshot;
    const beforePending = state.pending;
    const current = (): boolean => selection === state.restoreSelection && epoch === state.resetEpoch && before === state.snapshot && beforePending === state.pending && !state.stale;
    state.resetRequest = null; state.resetFailure = null;
    restoreInput.value = '';
    if (file === undefined) return;
    state.notice = null;
    try {
      // 読み込む前に大きさを確かめる。巨大なファイルをメモリへ読まない。
      if (file.size > maxBackupBytes) { setNotice(refusal({ kind: 'unreadable', reason: 'ファイルが大きすぎる（64MiBを超える）' }), unreadable); renderSave(); return; }
      const bytes = await file.arrayBuffer();
      if (!current()) return;
      const read = readBackup(new Uint8Array(bytes));
      if (read.kind !== 'ok') { setNotice(refusal(read), unreadable); renderSave(); return; }
      if (read.recovery !== undefined) await validateRecovery(read.recovery);
      if (!current()) return;
      const texts = restoreTexts(read.createdAt, read.counts, unreadable);
      texts.message += ' 元の資料の重複確認は復元した履歴の範囲だけです。復元時点より後の原票は別途照合してください。';
      askReplace((run, current) => requestReplace(texts, run, current), () => read.snapshot, unreadable, `復元した（${read.createdAt}のバックアップ）`, read.recovery);
    } catch (error) {
      if (!current()) return;
      setNotice(`復元に使えない：ファイルを読めなかった（${error instanceof Error ? error.message : String(error)}）`, unreadable);
      renderSave();
    }
  }

  return { askReplace, chooseRestoreFile, cancelRestoreFile, restoreFileChosen };
}
