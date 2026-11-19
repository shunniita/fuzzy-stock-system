import type { Ledger } from '../domain/ledger.ts';
import { codeOwner, unassignedCode, type CaseMaster } from '../domain/masters.ts';
import type { Supply } from '../domain/supply.ts';
import { generationBlockerOf, generationCaseOf, templateNeedContextOf } from '../domain/template-needs.ts';
import { templateNeedProgressOf } from '../domain/template-needs-progress.ts';
import { h } from './dom.ts';
import { progressUnitOf, progressUsedText } from './template-needs-format.ts';
import type { Ctx } from './supply-ui.ts';

// 照合は記録を止める規則と同じ関数に任せる。複数一致の例外は呼び出し側で案内の文にする。
export function registeredCaseNoticeOf(state: { ledger: Ledger; supply: Supply }, value: string, use: 'register' | 'generate'): { caseId: string; lines: string[] } | null {
  if (value === '') return null;
  const { ledger, supply } = state;
  let found: CaseMaster | null;
  if (use === 'generate') found = generationCaseOf(ledger.masters, value);
  else { const owner = codeOwner(ledger.masters, 'case', value); found = owner?.type === 'case' ? owner : null; }
  if (found === null) return null;

  const lines = [`品番・コード ${found.code ?? unassignedCode}`, `名称 ${found.name ?? 'なし'}`, found.active ? '利用中' : '利用停止'];
  const progress = templateNeedProgressOf(state, found.id);
  if (progress !== null) {
    const unit = progressUnitOf(progress);
    lines.push(`総予定数 ${progress.total}${unit}`, `作業で使った台数 ${progress.used === null ? '数えられない' : progressUsedText(progress.used, unit)}`);
  }
  const reason = use === 'generate' ? generationBlockerOf(supply, templateNeedContextOf(supply), found, value) : 'この品番・コードは登録済み。既存の案件を使う';
  if (reason !== null) lines.push(reason);
  return { caseId: found.id, lines };
}

export function attachRegisteredCaseNotice(field: HTMLLabelElement, ctx: Ctx, use: 'register' | 'generate'): HTMLElement {
  const input = field.querySelector('input')!;
  const root = h('div', { 'data-case-notice': '', 'aria-live': 'polite' });
  // 入力の後に「この案件を開く」を押すと、欄を離れた change で描き直して押したボタンが消え、押しても開かない。値が同じなら描き直さない。
  let drawn = '';
  const draw = (): void => {
    if (input.value === drawn) return;
    drawn = input.value;
    try {
      const notice = registeredCaseNoticeOf({ ledger: ctx.ledger(), supply: ctx.supply() }, input.value, use);
      const rows: HTMLElement[] = notice === null ? [] : notice.lines.map(line => h('div', {}, line));
      const open = ctx.openCase;
      if (notice !== null && open !== undefined) {
        const button = h('button', { type: 'button' }, 'この案件を開く');
        button.addEventListener('click', () => open(notice.caseId));
        rows.push(button);
      }
      root.replaceChildren(...rows);
    } catch (error) { root.replaceChildren(h('div', {}, error instanceof Error ? error.message : String(error))); }
  };
  input.addEventListener('input', draw);
  input.addEventListener('change', draw);
  return root;
}
