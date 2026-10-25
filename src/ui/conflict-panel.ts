import { h } from './dom.ts';
import type { Decision, PanelAction, PanelModel } from './conflict-ui.ts';

// 表示モデルをDOMにする薄い層。入力原文を含むすべての文字は、hのtextContent（子の文字列）としてだけ画面に出し、HTMLとして解釈しない。
export type PanelHandlers = {
  setCopied(value: boolean): void; setConfirmed(value: boolean): void; setOutcome(value: 'reenter' | 'dismiss'): void;
  setReason(value: string): void; setActor(value: string): void; confirm(): void; discardUnreadable(): void; reload(): void;
  setWithdrawAck(value: boolean): void; withdraw(): void;
};
export type PanelControls = { decision: Decision; copied: boolean; confirmedChecked: boolean; actors: readonly string[]; withdrawAck?: boolean };

const disabled = (action: PanelAction | undefined): Partial<Record<string, string>> => action === undefined || action.enabled ? {} : { disabled: '', 'aria-disabled': 'true' };

// 無効な操作には、色に頼らず理由を文字で添える。
const note = (action: PanelAction, prefix: string): HTMLElement[] => action.enabled || action.blockedBy === undefined ? [] : [h('p', { class: 'conflict-blocked' }, `${prefix}${action.blockedBy}`)];

export function conflictPanelNode(model: PanelModel, controls: PanelControls, handlers: PanelHandlers): HTMLElement {
  const root = h('div', { role: 'region', 'aria-label': '更新競合の照合', 'aria-live': 'polite' }, h('p', { class: 'conflict-status' }, model.status));
  for (const section of model.sections) root.append(h('h3', {}, section.heading), ...section.lines.map(line => h('p', { class: 'conflict-line' }, line)));
  const find = (name: PanelAction['name']): PanelAction | undefined => model.actions.find(action => action.name === name);
  const copied = find('copied');
  if (copied !== undefined) {
    const box = h('input', { type: 'checkbox', name: 'conflict-copied', ...disabled(copied) });
    box.checked = controls.copied;
    box.addEventListener('change', () => handlers.setCopied(box.checked));
    root.append(h('label', { class: 'check' }, box, copied.label));
  }
  const confirm = find('confirm');
  if (confirm !== undefined) {
    const seen = h('input', { type: 'checkbox', name: 'conflict-confirmed' });
    seen.checked = controls.confirmedChecked;
    seen.addEventListener('change', () => handlers.setConfirmed(seen.checked));
    const outcome = (value: 'reenter' | 'dismiss', label: string) => {
      const radio = h('input', { type: 'radio', name: 'conflict-outcome', value });
      radio.checked = controls.decision.outcome === value;
      radio.addEventListener('change', () => { if (radio.checked) handlers.setOutcome(value); });
      return h('label', { class: 'check' }, radio, label);
    };
    const reason = h('textarea', { name: 'conflict-reason', rows: '3', autocomplete: 'off' });
    reason.value = controls.decision.reason;
    const save = h('button', { type: 'button', ...disabled(confirm) }, confirm.label);
    // 理由の入力は描き直さない（入力中に欄が置き換わると、続くクリックが失われる）。確認と保存ボタンをその場で無効に戻す。
    reason.addEventListener('input', () => { handlers.setReason(reason.value); seen.checked = false; save.disabled = true; save.setAttribute('aria-disabled', 'true'); });
    const actor = h('select', { name: 'conflict-actor' }, ...controls.actors.map(a => h('option', { value: a }, a)));
    actor.value = controls.decision.actor;
    actor.addEventListener('change', () => handlers.setActor(actor.value));
    save.addEventListener('click', handlers.confirm);
    root.append(h('label', { class: 'check' }, seen, '最新の記録を確認した'), outcome('reenter', '最新記録から入力し直す'), outcome('dismiss', 'この入力を取り下げる'),
      h('label', {}, '理由', reason), h('label', {}, '確認者', actor), save, ...note(confirm, '保存できない理由：'));
  }
  const ack = find('withdrawAck'), withdraw = find('withdraw');
  if (ack !== undefined && withdraw !== undefined) {
    const box = h('input', { type: 'checkbox', name: 'conflict-withdraw-ack' });
    box.checked = controls.withdrawAck === true;
    box.addEventListener('change', () => handlers.setWithdrawAck(box.checked));
    const button = h('button', { type: 'button', ...disabled(withdraw) }, withdraw.label);
    button.addEventListener('click', handlers.withdraw);
    root.append(h('label', { class: 'check' }, box, ack.label), button, ...note(withdraw, '取り下げできない理由：'));
  }
  const discard = find('discardUnreadable');
  if (discard !== undefined) {
    const button = h('button', { type: 'button', ...disabled(discard) }, discard.label);
    button.addEventListener('click', handlers.discardUnreadable);
    root.append(button, ...note(discard, '取り下げできない理由：'));
  }
  const reload = find('reload');
  if (reload !== undefined) {
    const button = h('button', { type: 'button', ...disabled(reload) }, reload.label);
    button.addEventListener('click', handlers.reload);
    root.append(button, ...note(reload, ''));
  }
  return root;
}
