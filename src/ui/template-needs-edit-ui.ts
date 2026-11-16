import { own } from '../domain/masters.ts';
import { checkField, choiceField, h, textField, type Values } from './dom.ts';
import { amountFields } from './fields.ts';
import { itemRef, projectText } from './format.ts';
import { needQuantityText } from './supply-format.ts';
import type { Ctx, State, UiOp } from './supply-ui.ts';
import { prepareTemplateNeedChange, templateNeedChangeInput } from './template-needs-edit-preview.ts';
import { currentTemplateVersionText, templateNeedSurplusViewOf, templateNeedVersionText } from './template-needs-format.ts';
import { editTemplateNeeds, followTemplateNeeds, recalculateTemplateNeeds, templateNeedContextOf } from '../domain/template-needs.ts';
import { previewMeta, templateNeedPreviewSignature } from './template-needs-preview.ts';

function changeFields(ctx: Ctx, nextOpId: () => string, preflight: (form: HTMLFormElement | null, state: State) => void): HTMLElement[] {
  const state = { ledger: ctx.ledger(), supply: ctx.supply() };
  const project = choiceField('needProject', '案件ID', Object.keys(state.supply.templateNeeds).map(id => [id, projectText(state.ledger.masters, { kind: 'case', id })]));
  const action = choiceField('needAction', '変更方法', [['change', '必要明細を変更'], ['add', '案件独自の明細を追加'], ['exclude', '明細を除外'], ['recalculate', '台数を変えて再計算'], ['follow', 'セットの最新版に追従']]);
  const specific = h('div'), fields = h('div', {}, project, action, specific);
  const root = h('div', { 'data-need-preview': '', 'aria-live': 'polite' });
  const signature = h('input', { type: 'hidden', name: 'needPreview', value: '' });
  const confirm = checkField('needConfirmed', '差分・適用後の必要数を確認した');
  const confirmation = confirm.querySelector('input')!; confirmation.dataset['receiptConfirm'] = '';
  const clear = () => { signature.value = ''; confirmation.checked = false; confirmation.disabled = true; root.replaceChildren(); };
  confirmation.disabled = true;
  const refreshFields = () => {
    clear(); specific.replaceChildren();
    const projectId = project.querySelector('select')!.value, kind = action.querySelector('select')!.value;
    if (kind === 'change' || kind === 'exclude') {
      const origins = own(ctx.supply().templateNeeds, projectId)?.origins ?? [];
      specific.append(choiceField('need', '必要明細', origins.map(origin => {
        const need = own(ctx.supply().needs, origin.needId)!;
        return [need.id, `${itemRef(ctx.ledger().masters, need.item)}・${needQuantityText(need.required, need.unit)}`];
      })));
    }
    if (kind === 'add') {
      const item = choiceField('item', '品目', Object.values(ctx.ledger().masters.items).filter(item => item.active).map(item => [item.id, itemRef(ctx.ledger().masters, item.id)]));
      const unit = choiceField('unit', '単位', []);
      item.addEventListener('change', () => {
        const select = unit.querySelector('select')!;
        select.replaceChildren(h('option', { value: '' }, '選ぶ'), ...(own(ctx.ledger().masters.items, item.querySelector('select')!.value)?.units ?? []).map(value => h('option', { value }, value)));
      });
      specific.append(item, unit, textField('needDue', '必要日（省略可）', 'date'));
    }
    if (kind === 'change' || kind === 'add') specific.append(...amountFields());
    if (kind === 'change') {
      specific.append(textField('needDue', '必要日（省略可）', 'date'), textField('needSource', '元資料'), textField('needRevision', '改訂'));
      specific.querySelector<HTMLSelectElement>('[name=need]')!.addEventListener('change', () => {
        const need = own(ctx.supply().needs, specific.querySelector<HTMLSelectElement>('[name=need]')!.value);
        for (const [name, value] of Object.entries({ basis: need?.required.basis ?? '', value: need?.required.value?.toString() ?? '', needDue: need?.dueDate ?? '', needSource: need?.source ?? '', needRevision: need?.revision ?? '' })) {
          specific.querySelector<HTMLInputElement | HTMLSelectElement>(`[name=${name}]`)!.value = value;
        }
      });
    }
    if (kind === 'recalculate') specific.append(textField('needCount', '変更後の台数', 'integer'));
    if (kind && kind !== 'follow') specific.append(textField('needReason', '理由'));
  };
  project.addEventListener('change', refreshFields); action.addEventListener('change', refreshFields);
  fields.addEventListener('input', clear); fields.addEventListener('change', clear);
  const values = (): Values => ({ text: name => fields.querySelector<HTMLInputElement | HTMLSelectElement>(`[name=${name}]`)?.value ?? '', checked: name => root.querySelector<HTMLInputElement>(`[name=${name}]`)?.checked ?? false });
  const showPreview = () => {
    const v = values(), current = { ledger: ctx.ledger(), supply: ctx.supply() };
    // チェック状態を入力へ読み取ってから表を作り直す。通常の入力変更では選択を引き継がない。
    try {
      const input = templateNeedChangeInput(current, v), meta = previewMeta(root.closest('form'), nextOpId());
      clear();
      const result = prepareTemplateNeedChange(current, meta, input), before = own(current.supply.templateNeeds, input.project)!;
      const versions = templateNeedContextOf(current.supply).versions, initial = own(versions, before.initialVersion)!, baseline = own(versions, before.version)!;
      root.append(h('h3', {}, projectText(current.ledger.masters, { kind: 'case', id: input.project })),
        h('p', {}, `セット「${result.version.template.name}」・${before.count}台 → ${result.plan.count}台・初回版${templateNeedVersionText(current.supply, initial)}・計算基準の版${templateNeedVersionText(current.supply, baseline)} → ${result.version.id}`));
      if (input.action === 'follow') root.append(h('p', {}, `追従する版 ${result.version.id}・${currentTemplateVersionText(current.ledger.masters, current.supply, result.version.template.id)}`));
      const origins = before.origins;
      const body = h('tbody');
      let hasSurplus = false;
      for (const row of result.rows) {
        const label = itemRef(current.ledger.masters, row.item), surplus = templateNeedSurplusViewOf(current, row.after);
        if (surplus.value !== null && surplus.value > 0) hasSurplus = true;
        const choose = row.selectable ? checkField(`needApply${origins.findIndex(origin => origin.needId === row.key)}`, '新標準値を適用', row.selected) : null;
        const box = choose?.querySelector('input');
        if (box) {
          const name = `${label}（${row.unit}）に新標準値を適用${row.collision ? '・案件独自からセット由来へ' : '・手修正あり'}`;
          box.setAttribute('aria-label', name); box.dataset['conflictLabel'] = name;
          box.addEventListener('change', () => {
            showPreview();
            root.querySelector<HTMLInputElement>(`[name=${box.name}]`)?.focus();
          });
        }
        body.append(h('tr', {}, h('td', {}, label, row.added ? '・追加' : '', row.removed ? '・新版にない明細' : ''),
          h('td', {}, row.oldStandard === null ? 'なし' : `${row.oldStandard}${row.unit}`),
          h('td', {}, row.before === null ? '明細なし' : needQuantityText(row.before.required, row.unit)),
          h('td', {}, row.newStandard === null ? 'なし' : `${row.newStandard}${row.unit}`), h('td', {}, needQuantityText(row.after.required, row.unit)),
          h('td', {}, `${row.originBefore === 'custom' ? '案件独自' : row.originBefore === 'template' ? 'セット由来' : 'なし'} → ${row.originAfter === 'custom' ? '案件独自' : 'セット由来'}${row.manual ? '・手修正あり' : ''}`, choose),
          h('td', {}, surplus.value === null ? '判定できない' : `${surplus.value}${row.unit}`, surplus.caution ? `・${surplus.caution}` : '')));
      }
      root.append(h('div', { class: 'table-scroll', tabindex: '0', role: 'region', 'aria-label': '必要明細の差分（横スクロール）' },
        h('table', { 'aria-label': '必要明細の差分' }, h('thead', {}, h('tr', {}, ...['品目', '旧標準', '現在', '新標準', '適用後', '由来・適用', '余剰候補'].map(text => h('th', { scope: 'col' }, text)))), body)));
      if (hasSurplus) root.append(h('p', {}, '余った分は「余った分の振り分け」で記録する'));
      if (input.action === 'edit' && input.edit.kind === 'change') {
        const row = result.rows[0]!;
        root.append(h('dl', {}, ...(['dueDate', 'source', 'revision'] as const).flatMap((key, index) => [
          h('dt', {}, ['必要日', '元資料', '改訂'][index]), h('dd', {}, `${row.before?.[key] ?? 'なし'} → ${row.after[key] ?? 'なし'}`),
        ])));
      }
      const related = result.relatedCounts;
      if (related && related.difference !== '0') root.append(h('p', {}, `関連案件の台数：組立用${related.assembly}台・検査用合計${related.inspection}台・差${related.difference}台`));
      if (result.applicable) {
        preflight(root.closest('form'), result.state);
        signature.value = templateNeedPreviewSignature(current, input);
        confirmation.disabled = false;
      } else root.append(h('p', { role: 'status' }, '追従する案件独自の明細を選ぶ'));
    } catch (error) {
      signature.value = ''; confirmation.checked = false; confirmation.disabled = true;
      root.append(h('p', { role: 'status', class: 'error' }, error instanceof Error ? error.message : String(error)));
    }
  };
  const preview = h('button', { type: 'button' }, '変更をプレビュー'); preview.addEventListener('click', showPreview);
  return [fields, preview, signature, root, confirm];
}

export function templateNeedEditOp(ctx: Ctx, nextOpId: () => string, preflight: (form: HTMLFormElement | null, state: State) => void): UiOp {
  return { label: '生成した必要明細の変更', caseSubject: { field: 'needProject', accepts: (c) => own(ctx.supply().templateNeeds, c.id) !== undefined }, fields: () => changeFields(ctx, nextOpId, preflight), validateBeforeSave: preflight, run: (state, meta, v) => {
    const input = templateNeedChangeInput(state, v);
    if (v.text('needPreview') !== templateNeedPreviewSignature(state, input)) throw new Error('現在の入力と記録から変更をプレビューし直してください');
    if (!v.checked('needConfirmed')) throw new Error('差分・適用後の必要数を確認してください');
    if (input.action === 'edit') return { state: editTemplateNeeds(state, meta, input.project, input.edit, input.reason) };
    if (input.action === 'recalculate') return { state: recalculateTemplateNeeds(state, meta, input.project, input.count, input.selected, input.reason) };
    return { state: followTemplateNeeds(state, meta, input.project, input.selected) };
  } };
}
