import { buildTemplateNeedBatchGeneration, defaultTemplateNeedSplit, generateTemplateNeedsBatch, proposeTemplateNeedSplit, templateNeedContextOf, templateNeedProjectLimit, type TemplateNeedBatchInput } from '../domain/template-needs.ts';
import { recordTemplateNeeds } from '../domain/supply.ts';
import { checkField, choiceField, h, selectField, textField, type Values } from './dom.ts';
import { quantityValue } from './fields.ts';
import type { Ctx, State, UiOp } from './supply-ui.ts';
import { generationPreview, previewMeta, templateNeedOptions, templateNeedPreviewSignature } from './template-needs-preview.ts';

export function templateNeedBatchInput(v: Values): TemplateNeedBatchInput {
  const mode = v.text('needMode');
  if (mode !== 'same' && mode !== 'split') throw new Error('生成方法を選んでください');
  const size = quantityValue(v.text('needRows'), 1);
  if (size >= templateNeedProjectLimit) throw new Error(`一度に生成できる案件は${templateNeedProjectLimit}件までです`);
  const assembly = { templateId: v.text('needAssemblyTemplate'), caseCode: v.text('needAssemblyCase'), count: quantityValue(v.text('needAssemblyCount'), 1) };
  return { dueDate: v.text('needDue') || null,
    group: mode === 'same' ? { assemblyIndex: 0, mode, split: null } : { assemblyIndex: 0, mode, split: quantityValue(v.text('needSplit'), 1) },
    projects: [assembly, ...Array.from({ length: size }, (_, index) => ({ templateId: v.text('needInspectionTemplate'), caseCode: v.text(`needInspectionCase${index}`), count: quantityValue(v.text(`needInspectionCount${index}`), 1) }))] };
}

function batchFields(ctx: Ctx, nextOpId: () => string, preflight: (form: HTMLFormElement | null, state: State) => void): HTMLElement[] {
  const state = { ledger: ctx.ledger(), supply: ctx.supply() }, options = templateNeedOptions(state);
  const mode = selectField('needMode', '生成方法', [['same', '同じ台数'], ['split', '検査用を分割']]);
  const split = textField('needSplit', '分割台数', 'integer');
  split.querySelector('input')!.value = String(defaultTemplateNeedSplit(state.supply));
  const rows = h('div', { 'data-inspection-rows': '' });
  const size = h('input', { type: 'hidden', name: 'needRows', value: '0', 'data-conflict-label': '検査用の案件数' });
  const signature = h('input', { type: 'hidden', name: 'needPreview', value: '' });
  const root = h('div', { 'data-need-preview': '', 'aria-live': 'polite' });
  const confirmed = checkField('needConfirmed', '全案件のID・版・必要明細を確認した');
  const confirmation = confirmed.querySelector('input')!;
  confirmation.dataset['receiptConfirm'] = ''; confirmation.disabled = true;
  const clear = () => { signature.value = ''; root.replaceChildren(); confirmation.checked = false; confirmation.disabled = true; };
  const fields = h('div', {}, choiceField('needAssemblyTemplate', '組立用セット', options), choiceField('needInspectionTemplate', '検査用セット', options),
    textField('needAssemblyCase', '組立用の案件ID'), textField('needAssemblyCount', '組立用の台数', 'integer'), mode, split, textField('needDue', '必要日（省略可）', 'date'), rows, size);
  const values: Values = { text: name => fields.querySelector<HTMLInputElement | HTMLSelectElement>(`[name=${name}]`)?.value ?? '', checked: () => false };
  const showRows = (counts: readonly string[], ids: readonly string[]) => {
    rows.replaceChildren(...counts.map((count, index) => {
      const id = textField(`needInspectionCase${index}`, `検査用${index + 1}の案件ID`), amount = textField(`needInspectionCount${index}`, `検査用${index + 1}の台数`, 'integer');
      id.querySelector('input')!.value = ids[index] ?? ''; amount.querySelector('input')!.value = count;
      amount.querySelector('input')!.readOnly = values.text('needMode') === 'same';
      const remove = h('button', { type: 'button', 'aria-label': `検査用${index + 1}の案件を削除` }, '削除');
      remove.hidden = values.text('needMode') === 'same' || counts.length < 2;
      remove.addEventListener('click', () => showRows(currentCounts().filter((_, row) => row !== index), currentIds().filter((_, row) => row !== index)));
      return h('div', {}, id, amount, remove);
    }));
    size.value = String(counts.length); clear();
  };
  const currentIds = () => Array.from({ length: Number(size.value) }, (_, index) => values.text(`needInspectionCase${index}`));
  const currentCounts = () => Array.from({ length: Number(size.value) }, (_, index) => values.text(`needInspectionCount${index}`));
  const error = (caught: unknown) => { clear(); root.append(h('p', { role: 'status', class: 'error' }, caught instanceof Error ? caught.message : String(caught))); };
  const propose = h('button', { type: 'button' }, '検査用の台数を提案');
  propose.addEventListener('click', () => {
    try {
      const count = quantityValue(values.text('needAssemblyCount'), 1);
      const counts = values.text('needMode') === 'same' ? [count] : proposeTemplateNeedSplit(count, quantityValue(values.text('needSplit'), 1));
      showRows(counts.map(String), currentIds());
    } catch (caught) { error(caught); }
  });
  const add = h('button', { type: 'button' }, '検査用の案件を追加');
  add.addEventListener('click', () => { if (Number(size.value) >= templateNeedProjectLimit - 1) { error(new Error(`一度に生成できる案件は${templateNeedProjectLimit}件までです`)); return; } showRows([...currentCounts(), ''], currentIds()); });
  const preview = h('button', { type: 'button' }, '全案件の必要明細をプレビュー');
  preview.addEventListener('click', () => {
    clear();
    try {
      const input = templateNeedBatchInput(values), state = { ledger: ctx.ledger(), supply: ctx.supply() }, meta = previewMeta(preview.closest('form'), nextOpId());
      const result = buildTemplateNeedBatchGeneration(state, templateNeedContextOf(state.supply), meta, input);
      preflight(preview.closest('form'), { ledger: result.ledger, supply: recordTemplateNeeds(result.ledger, state.supply, meta, result.event) });
      root.append(...result.projects.map(project => generationPreview({ ...state, ledger: result.ledger }, project)));
      signature.value = templateNeedPreviewSignature(state, input);
      confirmation.disabled = false;
    } catch (caught) { error(caught); }
  });
  fields.addEventListener('input', clear); fields.addEventListener('change', clear);
  let partition: { counts: string[]; ids: string[] } | null = null;
  const syncMode = () => {
    const same = values.text('needMode') === 'same';
    split.hidden = same; propose.hidden = same; add.hidden = same;
  };
  mode.querySelector('select')!.addEventListener('change', () => {
    const ids = currentIds();
    if (values.text('needMode') === 'same') {
      partition = { counts: currentCounts(), ids };
      showRows([values.text('needAssemblyCount')], ids);
    } else {
      showRows(partition?.counts ?? currentCounts(), partition === null ? ids : [ids[0] ?? '', ...partition.ids.slice(1)]);
    }
    syncMode();
  });
  fields.querySelector<HTMLInputElement>('[name=needAssemblyCount]')!.addEventListener('input', () => {
    if (values.text('needMode') === 'same') rows.querySelector<HTMLInputElement>('[name=needInspectionCount0]')!.value = values.text('needAssemblyCount');
  });
  showRows([''], []);
  syncMode();
  return [fields, propose, add, preview, signature, root, confirmed];
}

export function templateNeedBatchOp(ctx: Ctx, nextOpId: () => string, preflight: (form: HTMLFormElement | null, state: State) => void): UiOp {
  return { label: '組立用と検査用をまとめて生成', fields: () => batchFields(ctx, nextOpId, preflight), validateBeforeSave: preflight, run: (state, meta, values) => {
    const input = templateNeedBatchInput(values);
    if (values.text('needPreview') !== templateNeedPreviewSignature(state, input)) throw new Error('現在の入力と記録から全案件をプレビューし直してください');
    if (!values.checked('needConfirmed')) throw new Error('全案件のID・版・必要明細を確認してください');
    return { state: generateTemplateNeedsBatch(state, meta, input) };
  } };
}
