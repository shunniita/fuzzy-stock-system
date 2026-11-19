import { codeOwner, own } from '../domain/masters.ts';
import type { Meta } from '../domain/ledger.ts';
import { receiveTemplate, type ReceiptRoute } from '../domain/receipt-template.ts';
import { recordTemplateNeeds, type Supply } from '../domain/supply.ts';
import { buildTemplateNeedGeneration, generateTemplateNeeds, templateNeedContextOf } from '../domain/template-needs.ts';
import { checkField, h, selectField, textField, type Values } from './dom.ts';
import { quantityValue } from './fields.ts';
import { routesOf, templateReceiptInputsOf, templateReceiptRowsView, templateRouteFields } from './receipt-template-ui.ts';
import { attachRegisteredCaseNotice } from './registered-case-notice.ts';
import { suffixed, type Ctx, type State, type UiOp } from './supply-ui.ts';
import { generationPreview, previewMeta, templateNeedOptions, templateNeedPreviewSignature } from './template-needs-preview.ts';

export type CaseRegistrationPlan = {
  templateId: string;
  total: number;
  dueDate: string | null;
  receipt: null | { sets: number; routes: readonly ReceiptRoute[] };
};

function totalOf(raw: string): number {
  let total = 0;
  try { total = quantityValue(raw, 1); } catch { /* 下の文言で欄を示す */ }
  if (total < 1) throw new Error('総予定数は1以上の整数で入力する');
  return total;
}

// 受け取り経路の欄は子構成のある行にしかないので、行の並びを知るセットを引いて読む。
export function caseRegistrationPlanOf(v: Values, supply: Supply): CaseRegistrationPlan | null {
  const templateId = v.text('caseSet');
  if (templateId === '') return null;
  if (v.checked('codeNone') || v.text('code') === '') throw new Error('セットを使うときは品番・コードを入力する（品番・コードなしでは必要明細を作れない）');
  const total = totalOf(v.text('caseTotal')), dueDate = v.text('caseDue').trim() || null;
  if (v.text('caseReceipt') !== 'record') return { templateId, total, dueDate, receipt: null };
  const template = own(supply.receiptTemplates, templateId);
  if (!template) throw new Error('セットを選ぶ（なければ先に登録する）');
  return { templateId, total, dueDate, receipt: { sets: quantityValue(v.text('sets'), 1), routes: routesOf(template, name => v.text(name)) } };
}

// 各段階は新しい状態を返すだけなので、途中で投げれば呼び出し元の状態は入力前のまま残る（1.8）。
export function applyCaseRegistration(state: State, meta: Meta, v: Values, base: UiOp, plan: CaseRegistrationPlan | null): State {
  const registered = base.run(state, meta, v, undefined).state;
  if (plan === null) return registered;
  const code = v.text('code');
  const generated = generateTemplateNeeds(registered, { ...meta, eventId: suffixed(meta.eventId, 'g') }, { templateId: plan.templateId, caseCode: code, count: plan.total, dueDate: plan.dueDate });
  if (plan.receipt === null) return generated;
  const { sets, routes } = plan.receipt, template = own(generated.supply.receiptTemplates, plan.templateId)!;
  const inputs = templateReceiptInputsOf(generated.ledger.masters, template, sets, routes, v);
  const vendor = inputs.some(row => row.shortfall > 0) ? v.text('vendor') : null;
  return receiveTemplate(generated, { ...meta, eventId: suffixed(meta.eventId, 't') }, plan.templateId, { kind: 'case', id: codeOwner(generated.ledger.masters, 'case', code)!.id },
    sets, inputs, vendor, routes);
}

export const caseSetChoices = (state: State): [string, string][] => [['', '使わない'], ...templateNeedOptions(state)];

export const caseRegistrationShown = (set: string, receipt: string): { plan: boolean; receipt: boolean } => ({ plan: set !== '', receipt: set !== '' && receipt === 'record' });

// 行ごとの受け取った数・足りない数はプレビューの後に入れるので、セットからの受け取りと同じく署名に含めない。
// 呼び名・元の資料・実際の日時は必要明細を変えないが、記録する案件・用途と日時を変えるので含める（1.9）。
// 記録する人は含めない：main.ts は最初の記録の試みの担当者を再試行でも使うので、署名に入れると選び直しても一致しなくなる。
export function caseRegistrationPreviewSignature(state: State, v: Values, plan: CaseRegistrationPlan): string {
  return JSON.stringify([templateNeedPreviewSignature(state, { templateId: plan.templateId, caseCode: v.text('code'), count: plan.total, dueDate: plan.dueDate }), plan.receipt,
    v.text('name'), v.text('sourceName'), v.text('sourceRevision'), v.checked('occurredUnknown') ? null : v.text('occurredAt')]);
}

function registrationFields(base: UiOp, ctx: Ctx, nextOpId: () => string, preflight: (form: HTMLFormElement | null, state: State) => void): HTMLElement[] {
  const baseFields = base.fields(), choices = caseSetChoices({ ledger: ctx.ledger(), supply: ctx.supply() });
  const codeField = baseFields.find(node => node.querySelector('[name=code]')) as HTMLLabelElement;
  const code = codeField.querySelector('input')!, none = baseFields.map(node => node.querySelector<HTMLInputElement>('[name=codeNone]')).find(box => box)!;
  const set = selectField('caseSet', '使うセット', choices), setSelect = set.querySelector('select')!;
  const total = textField('caseTotal', '総予定数', 'integer'), totalInput = total.querySelector('input')!;
  const receipt = selectField('caseReceipt', '最初の受け取り', [['', '今回は記録しない'], ['record', '記録する']]), receiptSelect = receipt.querySelector('select')!;
  const sets = textField('sets', '受け取った台数', 'integer'), routes = h('div', {});
  const receiptInputs = h('div', {}, sets, routes);
  const planInputs = h('div', {}, total, textField('caseDue', '必要日（省略可）', 'date'), receipt, receiptInputs);
  const open = ctx.openOperation, templates = choices.length === 1 && open ? h('button', { type: 'button' }, 'セットの登録・変更') : null;
  templates?.addEventListener('click', () => open!('templateSave'));
  const inputs = h('div', {}, set, templates, planInputs);

  const preview = h('button', { type: 'button' }, '必要明細をプレビュー');
  const signature = h('input', { type: 'hidden', name: 'caseRegistrationPreview', value: '' });
  const root = h('div', { 'data-case-registration-preview': '', 'aria-live': 'polite' });
  const vendor = textField('vendor', '欠品の手配先（不足があるときだけ必須。欠品リストの発行元など）');
  const confirm = checkField('caseRegistrationConfirmed', '案件ID・セット・必要明細・受け取りを確認した'), confirmation = confirm.querySelector('input')!;
  confirmation.dataset['receiptConfirm'] = ''; confirmation.disabled = true;
  const output = h('div', {}, preview, signature, root, vendor, confirm);

  // 入力の写し（main.ts の inputValues）は label の hidden だけを見て除くので、隠す欄の label にも付ける。
  const hide = (node: HTMLElement, hidden: boolean) => {
    node.hidden = hidden;
    for (const label of node.querySelectorAll('label')) label.hidden = hidden;
  };
  const sync = () => {
    const shown = caseRegistrationShown(setSelect.value, receiptSelect.value);
    hide(planInputs, !shown.plan); hide(output, !shown.plan);
    if (shown.plan) { hide(receiptInputs, !shown.receipt); hide(vendor, !shown.receipt); }
  };
  const clear = () => { signature.value = ''; root.replaceChildren(); confirmation.checked = false; confirmation.disabled = true; };
  // 受け取った数・足りない数・手配先はプレビューの後に入れる欄なので、それらの変更ではプレビューを消さない。
  for (const node of [inputs, ...baseFields]) { node.addEventListener('input', clear); node.addEventListener('change', clear); }
  // main.ts の exclusive は印を付けると品番・コードを input を出さずに空にし、しかもこの後に登録されるので、先に空にして案内を描き直す。
  none.addEventListener('change', () => { if (none.checked) { code.value = ''; code.dispatchEvent(new Event('input')); } clear(); });
  setSelect.addEventListener('change', () => { routes.replaceChildren(...templateRouteFields(ctx, own(ctx.supply().receiptTemplates, setSelect.value))); sync(); });
  receiptSelect.addEventListener('change', sync);
  // 受け取った台数を利用者が直したあとは、総予定数を直しても上書きしない。
  let copiedTotal = '';
  totalInput.addEventListener('input', () => {
    const setsInput = sets.querySelector('input')!;
    if (setsInput.value === '' || setsInput.value === copiedTotal) setsInput.value = totalInput.value;
    copiedTotal = totalInput.value;
  });

  preview.addEventListener('click', () => {
    clear();
    try {
      const form = preview.closest('form'), control = (name: string) => form?.elements.namedItem(name) as HTMLInputElement | null | undefined;
      const v: Values = { text: name => control(name)?.value ?? '', checked: name => control(name)?.checked ?? false };
      const state = { ledger: ctx.ledger(), supply: ctx.supply() }, plan = caseRegistrationPlanOf(v, state.supply);
      if (plan === null) throw new Error('セットを選ぶ');
      const meta = previewMeta(form, nextOpId()), generationMeta = { ...meta, eventId: suffixed(meta.eventId, 'g') };
      const registered = base.run(state, meta, v, undefined).state;
      const result = buildTemplateNeedGeneration(registered, templateNeedContextOf(registered.supply), generationMeta, { templateId: plan.templateId, caseCode: v.text('code'), count: plan.total, dueDate: plan.dueDate });
      preflight(form, { ledger: result.ledger, supply: recordTemplateNeeds(result.ledger, registered.supply, generationMeta, result.event) });
      root.append(generationPreview({ ...registered, ledger: result.ledger }, result));
      if (plan.receipt) root.append(templateReceiptRowsView(ctx, own(state.supply.receiptTemplates, plan.templateId)!, plan.receipt.sets, plan.receipt.routes));
      signature.value = caseRegistrationPreviewSignature(state, v, plan);
      confirmation.disabled = false;
    } catch (error) { root.append(h('p', { role: 'status', class: 'error' }, error instanceof Error ? error.message : String(error))); }
  });
  sync();
  return [...baseFields.flatMap(node => node === codeField ? [node, attachRegisteredCaseNotice(codeField, ctx, 'register')] : [node]), inputs, output];
}

export function caseRegistrationOp(base: UiOp, ctx: Ctx, nextOpId: () => string, preflight: (form: HTMLFormElement | null, state: State) => void): UiOp {
  return {
    ...base,
    fields: () => registrationFields(base, ctx, nextOpId, preflight),
    // 使わないときは今の登録と同じ検査だけにする（1.3）。
    validateBeforeSave: (form, state) => { if ((form?.elements.namedItem('caseSet') as HTMLSelectElement | null)?.value) preflight(form, state); },
    run: (s, m, v, inclusion) => {
      const plan = caseRegistrationPlanOf(v, s.supply);
      if (plan === null) return base.run(s, m, v, inclusion);
      // 登録自体が通らない入力ではプレビューも止まるので、プレビューのし直しを求めるより先にその理由を示す。
      base.run(s, m, v, inclusion);
      if (v.text('caseRegistrationPreview') !== caseRegistrationPreviewSignature(s, v, plan)) throw new Error('現在の入力と記録から必要明細をプレビューし直してください');
      if (!v.checked('caseRegistrationConfirmed')) throw new Error('案件ID・セット・必要明細・受け取りを確認してください');
      return { state: applyCaseRegistration(s, m, v, base, plan) };
    },
  };
}
