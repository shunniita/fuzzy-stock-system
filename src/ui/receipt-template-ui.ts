import { deleteReceiptTemplate, receiptTemplateRowLimit, receiveTemplate, saveReceiptTemplate, type ReceiptRoute, type ReceiptTemplate } from '../domain/receipt-template.ts';
import { expandAssemblyRecipe, normalizeAssemblyRecipe, type ExpandedAssemblyRow } from '../domain/assembly-recipes.ts';
import { own, quantityStepOf } from '../domain/masters.ts';
import { subtractScalar } from '../domain/scalar.ts';
import { checkField, choiceField, h, selectField, textField, type Values } from './dom.ts';
import { placeOptions, projectField, projectKey, projectOf, quantityValue } from './fields.ts';
import { basisLabel, itemRef, locationRef, projectText } from './format.ts';
import type { Ctx, UiOp } from './supply-ui.ts';
import { readPinnedRecipe, receiptPreviewSignature } from './receipt-template-draft.ts';

type DraftRow = { item: string; unit: string; perSet: string; location: string; assembly: string };
const emptyRow = (): DraftRow => ({ item: '', unit: '', perSet: '', location: '', assembly: '' });
const templateLabel = (ctx: Ctx, t: ReceiptTemplate): string => `${t.product === null ? '製品未設定' : itemRef(ctx.ledger().masters, t.product)}／${t.name}`;
const choices = (ctx: Ctx): [string, string][] => Object.values(ctx.supply().receiptTemplates).map(t => [t.id, templateLabel(ctx, t)]);
const changed = (node: HTMLElement) => node.dispatchEvent(new Event('input', { bubbles: true }));
const templateChoice = (ctx: Ctx) => choiceField('template', 'セット（製品／名前）', choices(ctx));
const emptyHelp = (ctx: Ctx) => h('p', {}, choices(ctx).length === 0 ? 'セットはまだありません。「セットの登録・変更」で製品ごとの部品構成を登録してください。' : 'セットからの計算は現物を数えた数ではありません。予定数・不足数・今回受け取った数と根拠を確かめてください。');

function basisOf(v: Values): ReceiptTemplate['basis'] {
  const basis = v.text('templateBasis');
  if (basis !== 'label' && basis !== 'counted' && basis !== 'approximate') throw new Error('数量の根拠を選ぶ');
  return basis;
}

function itemOptions(ctx: Ctx, current: string): [string, string][] {
  const masters = ctx.ledger().masters;
  return Object.values(masters.items).filter(item => item.active || item.id === current).map(item => [item.id, itemRef(masters, item.id)]);
}

function assemblyReference(ctx: Ctx, child: ReceiptTemplate): HTMLElement {
  return h('details', { 'data-assembly-reference': '' }, h('summary', {}, `固定した子構成：${child.name}（1${child.productUnit}あたり）`),
    ...child.rows.map((part, i) => h('p', {}, `${i + 1}：${itemRef(ctx.ledger().masters, part.item)}／${part.perSet}${part.unit}／${locationRef(ctx.ledger().masters, part.location)}`)));
}

function draftRow(ctx: Ctx, index: number, draft: DraftRow, productUnit: string): HTMLElement {
  const masters = ctx.ledger().masters, prefix = `t${index}`;
  const itemField = selectField(`${prefix}item`, `明細${index + 1}の品目`, [['', '選ぶ'], ...itemOptions(ctx, draft.item)], draft.item);
  const unitField = selectField(`${prefix}unit`, `明細${index + 1}の単位`, []);
  const item = itemField.querySelector('select')!, unit = unitField.querySelector('select')!;
  const fillUnits = () => {
    unit.replaceChildren(h('option', { value: '' }, '選ぶ'), ...(own(masters.items, item.value)?.units ?? []).map(value => h('option', { value }, value)));
  };
  fillUnits(); unit.value = draft.unit;
  const quantity = textField(`${prefix}perSet`, `明細${index + 1}の製品1${productUnit || '単位'}あたりの数量`, 'number');
  quantity.querySelector('input')!.value = draft.perSet;
  const hint = h('p');
  const pin = h('input', { type: 'hidden', name: `${prefix}assembly`, value: draft.assembly, 'data-conflict-label': `明細${index + 1}の固定した子構成` });
  const updateHint = () => { hint.textContent = pin.value ? '組立品の数量は正の整数' : unit.value ? `${unit.value}の最小単位${quantityStepOf(masters, item.value, unit.value)}` : '品目と単位を選んでください'; };
  const sourceField = selectField(`${prefix}source`, `明細${index + 1}の子セット`, []), source = sourceField.querySelector('select')!;
  const refresh = h('button', { type: 'button', 'aria-label': `明細${index + 1}の現在の構成を取り込む` }, '現在の構成を取り込む'), reference = h('div');
  const fillSources = () => {
    const child = pin.value ? readPinnedRecipe(pin.value, masters) : undefined;
    const eligible = Object.values(ctx.supply().receiptTemplates).filter(t => t.product === item.value && t.productUnit === unit.value && t.rows.every(row => row.assembly === undefined));
    const options: [string, string][] = [['', '子構成なし'], ...eligible.map((t): [string, string] => [t.id, `${t.name}（1${t.productUnit}あたり）`])];
    if (child && !eligible.some(t => t.id === child.id)) options.push([child.id, `${child.name}（取り込み済み・現在の候補なし）`]);
    source.replaceChildren(...options.map(([value, text]) => h('option', { value }, text))); source.value = child?.id ?? '';
    refresh.disabled = !child || !eligible.some(t => t.id === child.id);
    refresh.hidden = !child;
    reference.replaceChildren(...(child ? [assemblyReference(ctx, child)] : []));
  };
  const importSource = () => {
    const child = own(ctx.supply().receiptTemplates, source.value);
    pin.value = child ? JSON.stringify(normalizeAssemblyRecipe(child, masters)) : ''; fillSources(); updateHint(); changed(pin);
  };
  source.addEventListener('change', importSource); refresh.addEventListener('click', importSource);
  const clearLink = () => { pin.value = ''; fillSources(); updateHint(); };
  item.addEventListener('change', () => { fillUnits(); clearLink(); }); unit.addEventListener('change', clearLink);
  updateHint(); fillSources();
  const locations = placeOptions(masters);
  if (draft.location && !locations.some(([id]) => id === draft.location)) locations.push([draft.location, locationRef(masters, draft.location)]);
  return h('fieldset', { 'data-template-row': '' }, h('legend', {}, `明細${index + 1}`), itemField, unitField, quantity, hint,
    selectField(`${prefix}location`, `明細${index + 1}の受け取り場所`, [['', '選ぶ'], ...locations], draft.location),
    pin, sourceField, refresh, reference);
}

function editFields(ctx: Ctx): HTMLElement[] {
  const selection = selectField('template', '変更するセット', [['', '新規登録'], ...choices(ctx)]);
  const name = textField('templateName', 'セット名（120文字まで）');
  name.querySelector('input')!.maxLength = 120;
  const product = selectField('templateProduct', '製品の品目', [['', '選ぶ'], ...itemOptions(ctx, '')]);
  const productUnitField = selectField('templateProductUnit', '製品の構成を表す単位', [['', '選ぶ']]), productUnit = productUnitField.querySelector('select')!;
  const fillProductUnits = () => productUnit.replaceChildren(h('option', { value: '' }, '選ぶ'), ...(own(ctx.ledger().masters.items, product.querySelector('select')!.value)?.units ?? []).map(value => h('option', { value }, value)));
  const basis = selectField('templateBasis', '共通の数量の根拠', [['label', '表示の数（ラベル・パッケージ）（中身未確認）'], ['approximate', 'だいたい'], ['counted', '数えた（実際に数えたとき）']], 'label');
  const legacy = h('p', { 'aria-live': 'polite' });
  const rows = h('div', { 'data-template-rows': '' }), count = h('input', { type: 'hidden', name: 'templateRows', value: '1' });
  const add = h('button', { type: 'button' }, '明細を追加');
  const message = h('p', { 'aria-live': 'polite' });
  const read = (): DraftRow[] => [...rows.querySelectorAll('[data-template-row]')].map((_, i) => {
    const value = (suffix: string) => rows.querySelector<HTMLInputElement | HTMLSelectElement>(`[name=t${i}${suffix}]`)?.value ?? '';
    return { item: value('item'), unit: value('unit'), perSet: value('perSet'), location: value('location'), assembly: value('assembly') };
  });
  const render = (drafts: readonly DraftRow[]) => {
    rows.replaceChildren(); count.value = String(drafts.length);
    drafts.forEach((draft, index) => {
      const row = draftRow(ctx, index, draft, productUnit.value), remove = h('button', { type: 'button', 'aria-label': `明細${index + 1}を削除` }, 'この明細を削除');
      remove.addEventListener('click', () => {
        const current = read();
        if (current.length === 1) { message.textContent = '明細は1行以上必要です'; return; }
        render(current.filter((_, i) => i !== index)); changed(rows); add.focus();
      });
      row.append(remove); rows.append(row);
    });
  };
  product.addEventListener('change', () => { fillProductUnits(); render(read()); });
  productUnit.addEventListener('change', () => render(read()));
  add.addEventListener('click', () => {
    const drafts = read();
    if (drafts.length >= receiptTemplateRowLimit) { message.textContent = `明細は${receiptTemplateRowLimit}行までです`; return; }
    render([...drafts, emptyRow()]); changed(rows);
    rows.querySelectorAll('[data-template-row]').item(drafts.length)?.querySelector('select')?.focus();
  });
  selection.querySelector('select')!.addEventListener('change', event => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    const template = own(ctx.supply().receiptTemplates, target.value);
    name.querySelector('input')!.value = template?.name ?? '';
    const p = product.querySelector('select')!;
    p.replaceChildren(...[['', '選ぶ'], ...itemOptions(ctx, template?.product ?? '')].map(([value, text]) => h('option', { value }, text)));
    p.value = template?.product ?? '';
    fillProductUnits(); productUnit.value = template?.productUnit ?? '';
    legacy.textContent = template?.project ? `このセットは旧版で${projectText(ctx.ledger().masters, template.project)}に固定されています。保存すると案件・用途の固定を外し、案件・用途は受け取りのときに選びます。` : '';
    basis.querySelector('select')!.value = template?.basis ?? 'label';
    render(template?.rows.map(row => ({ ...row, perSet: String(row.perSet), assembly: row.assembly ? JSON.stringify(row.assembly) : '' })) ?? [emptyRow()]);
    changed(rows);
  });
  render([emptyRow()]);
  return [selection, name, product, productUnitField, legacy, basis,
    h('p', {}, `明細は1〜${receiptTemplateRowLimit}行。製品の宣言単位あたりの数量を入力してください。子構成のある行は正の整数です。案件・用途は受け取りのときに選びます。`),
    count, rows, add, message];
}

function previewRow(ctx: Ctx, root: HTMLElement, row: ExpandedAssemblyRow, index: number, productUnit: string): void {
  const masters = ctx.ledger().masters, step = quantityStepOf(masters, row.item, row.unit), planned = row.planned;
  const position = `${row.parentIndex + 1}${row.childIndex === null ? '' : `-${row.childIndex + 1}`}`;
  const shortfall = textField(`shortfall${index}`, `明細${position}の不足数（欠品リスト）`, 'number');
  const actual = textField(`actual${index}`, `明細${position}の今回受け取った数`, 'number');
  const shortInput = shortfall.querySelector('input')!, actualInput = actual.querySelector('input')!;
  shortInput.value = '0'; actualInput.value = String(planned);
  shortInput.addEventListener('input', () => {
    try { actualInput.value = String(subtractScalar(planned, quantityValue(shortInput.value || '0', step), step)); } catch { /* 不正な不足数は記録時に断る */ }
  });
  root.append(h('p', {}, `明細${position}：${itemRef(masters, row.item)}／予定${planned}${row.unit}（製品1${productUnit}あたり${row.perSet}${row.unit}）／${locationRef(masters, row.location)}／最小単位${step}`), shortfall, actual);
}

function routesOf(template: ReceiptTemplate, value: (name: string) => string): ReceiptRoute[] {
  return template.rows.map((row, i) => {
    const route = value(`route${i}`) || 'assembled';
    if (route !== 'assembled' && (route !== 'parts' || !row.assembly)) throw new Error('受け取り経路を選んでください');
    return route;
  });
}

function receiptFields(ctx: Ctx): HTMLElement[] {
  const selection = templateChoice(ctx), project = projectField(ctx.ledger().masters), sets = textField('sets', '製作個数（正の整数）', 'integer');
  const setsLabel = sets.firstChild;
  sets.querySelector('input')!.value = '1';
  const root = h('div', { 'data-template-preview': '' }), preview = h('button', { type: 'button' }, '予定数を展開');
  const signature = h('input', { type: 'hidden', name: 'templateRevision', value: '' });
  const references = h('div', { 'data-template-references': '' });
  const vendor = textField('vendor', '欠品の手配先（不足があるときだけ必須。欠品リストの発行元など）');
  const confirm = checkField('templateConfirmed', '案件・用途・明細・不足数・今回受け取った数・根拠・場所を確認した');
  confirm.querySelector('input')!.dataset['receiptConfirm'] = '';
  const clear = () => { root.replaceChildren(h('p', {}, '「予定数を展開」で今回の明細を表示してください。')); signature.value = ''; changed(root); };
  selection.addEventListener('change', () => {
    const template = own(ctx.supply().receiptTemplates, selection.querySelector('select')!.value), p = project.querySelector('select')!;
    if (template?.project && [...p.options].some(o => o.value === projectKey(template.project!))) p.value = projectKey(template.project);
    if (setsLabel) setsLabel.textContent = template?.productUnit ? `製作数量（${template.productUnit}・正の整数）` : '製作個数（正の整数）';
    references.replaceChildren();
    template?.rows.forEach((row, i) => {
      if (!row.assembly) return;
      const route = selectField(`route${i}`, `明細${i + 1}の受け取り経路`, [['assembled', '組立済みで受け取り'], ['parts', '自作分の部品を受け取り']], 'assembled');
      route.addEventListener('change', clear);
      references.append(h('p', {}, `明細${i + 1}：${itemRef(ctx.ledger().masters, row.item)}／${row.perSet}${row.unit}`), assemblyReference(ctx, row.assembly), route);
    });
    clear();
  });
  sets.addEventListener('input', clear);
  project.addEventListener('change', clear);
  preview.addEventListener('click', () => {
    try {
      const template = own(ctx.supply().receiptTemplates, selection.querySelector('select')!.value);
      if (!template) throw new Error('セットを選んでください');
      const routes = routesOf(template, name => references.querySelector<HTMLSelectElement>(`[name=${name}]`)?.value ?? '');
      const count = quantityValue(sets.querySelector('input')!.value, 1), projectValue = projectOf({ text: () => project.querySelector('select')!.value, checked: () => false });
      const planned = expandAssemblyRecipe(ctx.ledger().masters, template, count, routes);
      root.replaceChildren(h('p', {}, `${templateLabel(ctx, template)}／${project.querySelector('select')!.selectedOptions[0]?.textContent ?? ''}／${basisLabel[template.basis]}。不足数を入れると今回受け取った数は「予定−不足」になります。不足のある明細は手配先への依頼として記録し、後日の到着は依頼への割り当てで受けます。`));
      planned.forEach((row, i) => previewRow(ctx, root, row, i, template.productUnit ?? '個'));
      signature.value = receiptPreviewSignature(template, projectValue, count, routes); changed(root);
    } catch (error) { clear(); root.append(h('p', { class: 'error', role: 'status' }, error instanceof Error ? error.message : String(error))); }
  });
  clear();
  return [emptyHelp(ctx), selection, project, sets, references, preview, signature, root, vendor, confirm];
}

export function receiptTemplateOps(ctx: Ctx): Record<string, UiOp> {
  return {
    templateSave: {
      label: 'セットの登録・変更', fields: () => editFields(ctx),
      run: (state, meta, v) => {
        const length = quantityValue(v.text('templateRows'), 1);
        if (length < 1 || length > receiptTemplateRowLimit) throw new Error(`明細は1〜${receiptTemplateRowLimit}行にする`);
        if (!v.text('templateProductUnit')) throw new Error('製品の構成を表す単位を選ぶ');
        const rows = Array.from({ length }, (_, i) => {
          const raw = v.text(`t${i}assembly`), assembly = raw ? readPinnedRecipe(raw, state.ledger.masters) : undefined;
          return { item: v.text(`t${i}item`), unit: v.text(`t${i}unit`), perSet: quantityValue(v.text(`t${i}perSet`), assembly ? 1 : quantityStepOf(state.ledger.masters, v.text(`t${i}item`), v.text(`t${i}unit`))), location: v.text(`t${i}location`), ...(assembly ? { assembly } : {}) };
        });
        return { state: { ...state, supply: saveReceiptTemplate(state.ledger, state.supply, meta, { id: v.text('template') || meta.eventId, name: v.text('templateName'), product: v.text('templateProduct') || null, productUnit: v.text('templateProductUnit'), basis: basisOf(v), rows }) } };
      },
    },
    templateDelete: {
      label: 'セットの削除',
      fields: () => [emptyHelp(ctx), templateChoice(ctx), h('p', {}, 'セットを削除しても過去の受け取りと履歴は残ります。')],
      run: (state, meta, v) => ({ state: { ...state, supply: deleteReceiptTemplate(state.supply, state.ledger.masters, meta, v.text('template')) } }),
    },
    templateReceive: {
      label: 'セットからまとめて受け取り（欠品の入力）', fields: () => receiptFields(ctx),
      run: (state, meta, v) => {
        const template = own(state.supply.receiptTemplates, v.text('template'));
        if (!template) throw new Error('現在のセットから予定数を展開してください');
        const sets = quantityValue(v.text('sets'), 1), routes = routesOf(template, name => v.text(name)), project = projectOf(v);
        if (receiptPreviewSignature(template, project, sets, routes) !== v.text('templateRevision')) throw new Error('現在のセットから予定数を展開してください');
        if (!v.checked('templateConfirmed')) throw new Error('案件・用途・明細・不足数・今回受け取った数・根拠・場所を確認してください');
        const inputs = expandAssemblyRecipe(state.ledger.masters, template, sets, routes).map((row, i) => {
          const step = quantityStepOf(state.ledger.masters, row.item, row.unit);
          return { quantity: quantityValue(v.text(`actual${i}`), step), shortfall: quantityValue(v.text(`shortfall${i}`) || '0', step) };
        });
        const vendor = inputs.some(row => row.shortfall > 0) ? v.text('vendor') : null;
        return { state: receiveTemplate(state, meta, template.id, project, sets, inputs, vendor, routes) };
      },
    },
  };
}
