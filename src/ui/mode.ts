export type Mode = 'simple' | 'advanced';

// 保存記録の`fuzzy-stock/`接頭辞の外に置き、保存先の検査・容量の数え方・バックアップに混ぜない。
const modeKey = 'fuzzy-stock-mode';

// 読めないブラウザー（保存の無効化など）でも画面は出す。選んだことがない場合と同じく簡単操作モードにする。
export function readMode(): Mode {
  try {
    return localStorage.getItem(modeKey) === 'advanced' ? 'advanced' : 'simple';
  } catch {
    return 'simple';
  }
}

export function writeMode(mode: Mode): void {
  try {
    localStorage.setItem(modeKey, mode);
  } catch {
    // 保存できなくても、この画面では切り替える。次に開いたときは簡単操作モードに戻る。
  }
}

// 簡単操作モードで入口から開ける操作。ここにない操作は二段選択（高度な操作モード）からだけ開く。
export const simpleOps: ReadonlySet<string> = new Set([
  'register', 'use', 'move', 'split', 'splitMove', 'merge', 'recount', 'hold', 'release',
  'masterItem', 'masterLocation', 'masterRename', 'masterDeactivate', 'masterReactivate',
  'void', 'correctTime', 'resolve',
]);

// 統合済みを含む全保管単位のIDと重ならない、次の連番。
export function nextLotId(lots: Readonly<Record<string, unknown>>): string {
  for (let n = 1; ; n++) {
    const id = `L-${String(n).padStart(4, '0')}`;
    if (!Object.hasOwn(lots, id)) return id;
  }
}

export function nextSplitId(lots: Readonly<Record<string, unknown>>, source: string): string {
  if (source === '' || /^L-(?:\d{4}|[1-9]\d{4,})$/.test(source)) return nextLotId(lots);
  const parts = /^(.*?)(\d+)$/.exec(source);
  if (parts === null) return '';
  const prefix = parts[1]!, digits = parts[2]!;
  for (let n = BigInt(digits) + 1n; ; n++) {
    const id = `${prefix}${String(n).padStart(digits.length, '0')}`;
    if (!Object.hasOwn(lots, id)) return id;
  }
}
