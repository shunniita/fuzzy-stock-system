import { openNeedImports, previewNeedImportResolution, resolveNeedImport } from '../domain/need-import.ts';
import { checkField, choiceField, h, selectField, textField, type Values } from './dom.ts';
import { importedNeedText } from './supply-format.ts';
import type { Ctx, UiOp } from './supply-ui.ts';

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);


function confirmation() {
  const token = h('input', { type: 'hidden', name: 'needToken' });
  const check = checkField('needConfirmed', '差分と未反映の範囲を確認した');
  const box = check.querySelector('input')!;
  box.disabled = true;
  const output = h('div', { 'aria-live': 'polite', 'aria-label': '必要明細の差分' }, '差分は未確認');
  const invalidate = () => { token.value = ''; box.checked = false; box.disabled = true; output.replaceChildren('差分は未確認'); };
  const show = (value: string, ...lines: string[]) => { token.value = value; box.checked = false; box.disabled = false; output.replaceChildren(...lines.map(line => h('p', {}, line))); };
  const button = h('button', { type: 'button' }, '差分を確認');
  return { token, check, output, button, invalidate, show };
}

function resolutionAction(value: string): 'apply' | 'dismiss' {
  if (value !== 'apply' && value !== 'dismiss') throw Error('照合結果を選ぶ');
  return value;
}

function resolutionFields(ctx: Ctx): HTMLElement[] {
  const open = openNeedImports(ctx.supply());
  const held = choiceField('needHeld', '未解消の取込', open.map(e => [e.eventId, `${e.eventId}：${e.input.row.source ?? '元の資料不明'}・明細${e.input.row.line ?? '不明'}・${e.decision.reasons.join('、')}`]));
  const action = choiceField('needAction', '照合結果', [['apply', '既存明細へ適用'], ['dismiss', '適用せず解消']]);
  const target = selectField('needTarget', '適用先の既存明細（適用するとき）', [['', '選ぶ'], ...Object.values(ctx.supply().needs).map(n => [n.id, `${n.id}：${importedNeedText(ctx.ledger().masters, n)}`] as const)]);
  const reason = textField('needReason', '照合の理由');
  const original = h('pre', { 'aria-label': '保留した文書と理由' });
  const confirm = confirmation();
  const selected = (node: HTMLElement): string => node.querySelector('select')!.value;
  for (const control of [held, action, target, reason]) control.addEventListener('input', confirm.invalidate);
  for (const control of [held, action, target]) control.addEventListener('change', confirm.invalidate);
  held.addEventListener('change', () => {
    const e = open.find(e => e.eventId === selected(held));
    original.textContent = e ? `未反映：${e.decision.reasons.join('、')}\n関連明細：${e.decision.candidates.join('、') || 'なし'}\n読取原文：${e.input.raw}` : '';
  });
  confirm.button.addEventListener('click', () => {
    confirm.invalidate();
    try {
      if (!reason.querySelector('input')!.value.trim()) throw Error('照合の理由を入力する');
      const p = previewNeedImportResolution(ctx.supply(), ctx.ledger().masters, selected(held), resolutionAction(selected(action)), selected(target));
      confirm.show(p.token, p.resolution.kind === 'dismiss' ? '適用せず解消する。必要な数は変わらず原文と理由を残す。' : `変更前：${importedNeedText(ctx.ledger().masters, p.resolution.before)}\n変更後：${importedNeedText(ctx.ledger().masters, p.resolution.after)}`, '現物・使用履歴・依頼・受け取りは変わらない。');
    } catch (error) { confirm.output.replaceChildren(errorText(error)); }
  });
  return [h('p', {}, `未解消の取込は${open.length}件。識別不足や確定済み対応の変更は強制適用できない。適用できない場合も原文を残し、適用せず解消できる。`), held, original, action, target, reason, confirm.token, confirm.button, confirm.output, confirm.check];
}

function confirmedToken(v: Values): string {
  if (!v.checked('needConfirmed') || !v.text('needToken')) throw Error('差分を確認し、確認済みにチェックする');
  return v.text('needToken');
}

export function needImportOps(ctx: Ctx): Record<string, UiOp> {
  return {
    needImportResolve: {
      label: '必要明細取込の照合（保留の適用・見送り）', fields: () => resolutionFields(ctx),
      run: (s, m, v) => ({ state: { ...s, supply: resolveNeedImport(s.supply, s.ledger.masters, m, v.text('needHeld'), resolutionAction(v.text('needAction')), v.text('needTarget'), v.text('needReason'), confirmedToken(v)) } }),
    },
  };
}
