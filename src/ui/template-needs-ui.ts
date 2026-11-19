import { refOf } from '../domain/masters.ts';
import { buildTemplateNeedGeneration, generateTemplateNeeds, generationTargetsOf, templateNeedContextOf, type TemplateNeedGenerationInput } from '../domain/template-needs.ts';
import { recordTemplateNeeds } from '../domain/supply.ts';
import { choiceField, checkField, h, selectField, textField, type Values } from './dom.ts';
import { quantityValue } from './fields.ts';
import { attachRegisteredCaseNotice } from './registered-case-notice.ts';
import type { Ctx, State, UiOp } from './supply-ui.ts';
import { generationPreview, previewMeta, templateNeedOptions, templateNeedPreviewSignature } from './template-needs-preview.ts';
export { templateNeedPreviewSignature } from './template-needs-preview.ts';
import { templateNeedEditOp } from './template-needs-edit-ui.ts';

function generationInput(v: Values): TemplateNeedGenerationInput {
  const caseId = v.text('needCaseTarget');
  return { templateId: v.text('needTemplate'), caseCode: caseId === '' ? v.text('needCase') : '', ...(caseId === '' ? {} : { caseId }), count: quantityValue(v.text('needCount'), 1), dueDate: v.text('needDue') || null };
}

const targetLabel = (state: State, id: string): string => {
  const m = state.ledger.masters.cases[id]!;
  return m.code !== null && m.name !== null ? `${m.code}「${m.name}」` : refOf(state.ledger.masters.cases, id);
};

function generationFields(ctx: Ctx, nextOpId: () => string, preflight: (form: HTMLFormElement | null, state: State) => void): HTMLElement[] {
  const state = { ledger: ctx.ledger(), supply: ctx.supply() }, options = templateNeedOptions(state);
  const caseField = textField('needCase', '案件ID');
  // 品番・コードのない案件・用途は案件IDで指せないので、内部IDを出さずに一覧から選ぶ。
  const target = selectField('needCaseTarget', '対象', [['', '案件IDで指定する（未登録なら登録する）'], ...generationTargetsOf(state).map(m => [m.id, targetLabel(state, m.id)] as const)]);
  const byCode = h('div', {}, caseField, attachRegisteredCaseNotice(caseField, ctx, 'generate'));
  target.querySelector('select')!.addEventListener('change', event => { byCode.hidden = caseField.hidden = (event.target as HTMLSelectElement).value !== ''; });
  const fields = h('div', {}, choiceField('needTemplate', 'セット', options), target, byCode, textField('needCount', '台数', 'integer'), textField('needDue', '必要日（省略可）', 'date'));
  const signature = h('input', { type: 'hidden', name: 'needPreview', value: '' });
  const root = h('div', { 'data-need-preview': '', 'aria-live': 'polite' });
  const confirm = checkField('needConfirmed', '案件ID・版・必要明細を確認した');
  const confirmation = confirm.querySelector('input')!;
  confirmation.dataset['receiptConfirm'] = ''; confirmation.disabled = true;
  const clear = () => { signature.value = ''; root.replaceChildren(); confirmation.checked = false; confirmation.disabled = true; };
  fields.addEventListener('input', clear); fields.addEventListener('change', clear);
  const preview = h('button', { type: 'button' }, '必要明細をプレビュー');
  preview.addEventListener('click', () => {
    clear();
    try {
      const value: Values = { text: name => fields.querySelector<HTMLInputElement | HTMLSelectElement>(`[name=${name}]`)?.value ?? '', checked: () => false };
      const input = generationInput(value), state = { ledger: ctx.ledger(), supply: ctx.supply() }, meta = previewMeta(preview.closest('form'), nextOpId());
      const result = buildTemplateNeedGeneration(state, templateNeedContextOf(state.supply), meta, input);
      preflight(preview.closest('form'), { ledger: result.ledger, supply: recordTemplateNeeds(result.ledger, state.supply, meta, result.event) });
      root.append(generationPreview({ ...state, ledger: result.ledger }, result));
      signature.value = templateNeedPreviewSignature(state, input);
      confirmation.disabled = false;
    } catch (error) { root.append(h('p', { role: 'status', class: 'error' }, error instanceof Error ? error.message : String(error))); }
  });
  return [...(options.length === 0 ? [h('p', {}, '「セットの登録・変更」で製品と部品を登録してください。')] : []), fields, preview, signature, root, confirm];
}

export function templateNeedsOps(ctx: Ctx, nextOpId: () => string, preflight: (form: HTMLFormElement | null, state: State) => void): Record<string, UiOp> {
  return {
    templateNeedEdit: templateNeedEditOp(ctx, nextOpId, preflight),
    templateNeedGenerate: {
      subject: { kind: 'template', field: 'needTemplate' },
      label: 'セットから必要明細を生成', fields: () => generationFields(ctx, nextOpId, preflight), validateBeforeSave: preflight,
      run: (state, meta, v) => {
        const input = generationInput(v);
        if (v.text('needPreview') !== templateNeedPreviewSignature(state, input)) throw new Error('現在の入力と記録から必要明細をプレビューし直してください');
        if (!v.checked('needConfirmed')) throw new Error('案件ID・版・必要明細を確認してください');
        return { state: generateTemplateNeeds(state, meta, input) };
      },
    },
  };
}
