import { h } from './dom.ts';

// 登録情報のidは、入力欄の対象の値と同じ「種類:内部の識別」。
export type OperationTarget = { kind: 'lot' | 'template' | 'master' | 'request' | 'event' | 'case' | 'need' | 'issue'; id: string };

// 閉じたselectは矢印キーだけでchangeが起き、眺めただけで操作が切り替わるので、候補はボタンで並べて畳む。
export function otherOperations(buttons: readonly HTMLButtonElement[]): HTMLElement | null {
  return buttons.length === 0 ? null : h('details', { class: 'other-operations' }, h('summary', {}, 'その他の操作'), ...buttons);
}

// 元selectを読む既存フォームのclosureと、コンテナ内を読むプレビューを保つ。
export function fixSubject(form: HTMLFormElement, name: string, id: string): void {
  const control = form.elements.namedItem(name);
  if (!(control instanceof HTMLSelectElement) || ![...control.options].some(option => option.value === id)) throw new Error(`対象 ${id} は現在の候補にありません`);
  control.value = id;
  control.dispatchEvent(new Event('change', { bubbles: true }));
  const label = control.closest('label');
  if (label === null) throw new Error('対象の入力欄がありません');
  const text = control.selectedOptions[0]?.textContent ?? id;
  const fixed = h('input', { type: 'hidden', name, value: id, 'data-conflict-label': `固定した対象：${text}` });
  control.removeAttribute('name');
  for (const key of ['codeTarget', 'codeQuantity', 'codeBasis', 'codeHold']) delete control.dataset[key];
  control.disabled = true;
  label.hidden = true;
  label.after(h('p', { 'data-fixed-subject': '' }, `対象：${text}`), fixed);
}
