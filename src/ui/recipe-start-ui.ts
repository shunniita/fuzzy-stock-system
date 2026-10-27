import { isUsable, type Inclusion } from '../domain/ledger.ts';
import { nextProcessOf, own, processOf, quantityStepOf } from '../domain/masters.ts';
import type { Basis } from '../domain/quantity.ts';
import type { ReceiptTemplate } from '../domain/receipt-template.ts';
import { subtractScalar, sumScalars } from '../domain/scalar.ts';
import { EstimateInclusionRequired, estimateCandidates, estimateUseLimit, manualUseLimit, startWithEstimate, type Candidate, type EstimateInput, type ManualUse } from '../domain/usage-estimate.ts';
import { checkField, choiceField, h, selectField, textField, type Values } from './dom.ts';
import { amount, amountFields, basisOptions, codeTarget, itemFields, lotOptions, MaterialInclusionRequired, placeOptions, processOptions, projectField, projectOf, quantityValue } from './fields.ts';
import { inclusionLabel, itemRef } from './format.ts';
import type { Ctx, UiOp } from './supply-ui.ts';

const changed = (node: HTMLElement) => node.dispatchEvent(new Event('input', { bubbles: true }));
const estimateBasisOptions = [['approximate', 'だいたい（数えていない）'], ['counted', '数えた（今回の使用数全体）']] as const;

// 先頭を空にし、回答を求められるまで隠す（既存の作業の開始の材料と同じ）。
function inclusionField(name: string, label: string): HTMLLabelElement {
  const node = selectField(name, label, [['', '選ぶ'], ...(Object.keys(inclusionLabel) as Inclusion[]).map((k) => [k, inclusionLabel[k]] as const)]);
  node.hidden = true;
  return node;
}

const recipesFor = (ctx: Ctx, item: string): ReceiptTemplate[] => Object.values(ctx.supply().receiptTemplates).filter((t) => t.product === item);
const recipeLabel = (t: ReceiptTemplate) => `${t.name}（${t.productUnit === undefined ? '製品の単位が未宣言' : `製品1${t.productUnit}あたり`}）`;
// 候補を出した時点の前提。変わったら出し直させる。
const previewSignature = (template: ReceiptTemplate, item: string, unit: string, basis: string, value: string) => JSON.stringify({ template, item, unit, basis, value });

function allocation(ctx: Ctx, i: number, k: number, candidate: Candidate): HTMLElement {
  const p = `e${i}u${k}`, where = `明細${i + 1}の内訳${k + 1}`;
  const lot = codeTarget(selectField(`${p}lot`, `${where}の保管単位`, [['', '選ぶ'], ...lotOptions(ctx.ledger(), (l) => isUsable(l) && l.item === candidate.item && l.unit === candidate.unit)]), 'lot', { quantity: `${p}value` });
  const value = textField(`${p}value`, `${where}の今回の使用数（${candidate.unit}）`, 'number');
  if (k === 0 && candidate.calculated !== null) value.querySelector('input')!.value = String(candidate.calculated);
  return h('div', { 'data-estimate-use': '' }, lot, selectField(`${p}basis`, `${where}の数量の根拠`, estimateBasisOptions, 'approximate'), value, inclusionField(`${p}inclusion`, `${where}：最後に数えた数に含まれていたか`));
}

function candidateRow(ctx: Ctx, root: HTMLElement, candidate: Candidate, i: number, productUnit: string): void {
  const masters = ctx.ledger().masters, step = quantityStepOf(masters, candidate.item, candidate.unit);
  const decisions: [string, string][] = candidate.calculated === null ? [['unresolved', '未確定（使用を記録しない）'], ['use', '使う（数量を手で入れる）'], ['exclude', '除外']] : [['use', '使う'], ['exclude', '除外']];
  const decision = selectField(`e${i}decision`, `明細${i + 1}の扱い`, decisions);
  const count = h('input', { type: 'hidden', name: `e${i}count`, value: '1' });
  const uses = h('div', {}, allocation(ctx, i, 0, candidate));
  const total = h('p', { 'data-estimate-total': '' });
  const add = h('button', { type: 'button' }, '保管単位を分ける'), drop = h('button', { type: 'button' }, '最後の内訳を外す');
  const refresh = () => {
    const using = decision.querySelector('select')!.value === 'use';
    uses.hidden = add.hidden = drop.hidden = total.hidden = !using;
    try {
      const values = [...uses.querySelectorAll<HTMLInputElement>('input[name$=value]')].map((input) => quantityValue(input.value, step));
      const sum = sumScalars(values, step);
      total.textContent = `確定${sum}${candidate.unit}${candidate.calculated === null ? '' : `（算出との差${subtractScalar(sum, candidate.calculated, step) >= 0 ? '+' : ''}${subtractScalar(sum, candidate.calculated, step)}${candidate.unit}）`}`;
    } catch { total.textContent = '今回の使用数を入力してください'; }
  };
  add.addEventListener('click', () => {
    const n = Number(count.value);
    if (n >= estimateUseLimit) return;
    uses.append(allocation(ctx, i, n, candidate)); count.value = String(n + 1); refresh(); changed(root);
  });
  drop.addEventListener('click', () => {
    const n = Number(count.value);
    if (n <= 1) return;
    uses.lastElementChild?.remove(); count.value = String(n - 1); refresh(); changed(root);
  });
  decision.addEventListener('change', refresh);
  uses.addEventListener('input', refresh);
  const head = `明細${i + 1}：${itemRef(masters, candidate.item)}／製品1${productUnit}あたり${candidate.perSet}${candidate.unit}／`;
  root.append(h('div', { 'data-estimate-row': '' },
    h('p', {}, candidate.calculated === null ? `${head}未確定（${candidate.reason}）` : `${head}算出${candidate.calculated}${candidate.unit}／最小単位${step}`),
    decision, count, uses, add, drop, total));
  refresh();
}

function manualFields(ctx: Ctx): HTMLElement[] {
  return Array.from({ length: manualUseLimit }, (_, k) => k + 1).flatMap((i) => [
    codeTarget(selectField(`m${i}lot`, `手入力の材料${i}の保管単位（セットにない材料）`, [['', 'なし'], ...lotOptions(ctx.ledger(), isUsable)]), 'lot', { quantity: `m${i}value`, basis: `m${i}basis` }),
    selectField(`m${i}basis`, `手入力の材料${i}の数量の根拠`, [['', '選ぶ'], ...basisOptions]),
    textField(`m${i}value`, `手入力の材料${i}の使用数（数が不明なら空欄）`, 'number'),
    inclusionField(`m${i}inclusion`, `手入力の材料${i}：最後に数えた数に含まれていたか`),
  ]);
}

function recipeStartFields(ctx: Ctx): HTMLElement[] {
  const masters = ctx.ledger().masters;
  const [itemSelect, unitSelect] = itemFields(masters);
  const [basisField, valueField] = amountFields();
  const recipe = selectField('recipe', 'セット（製品／名前）', [['', '選ぶ']]);
  const status = h('p', { 'data-recipe-status': '' });
  const preview = h('button', { type: 'button' }, '使用候補を出す');
  const signature = h('input', { type: 'hidden', name: 'estimateRevision', value: '' });
  const root = h('div', { 'data-estimate-preview': '' });
  const confirm = checkField('estimateConfirmed', '台数・今回の使用数・根拠・保管単位を確認した');
  const value = (name: string) => preview.closest('form')?.querySelector<HTMLInputElement | HTMLSelectElement>(`[name=${name}]`)?.value ?? '';
  // 出し直した候補に、前の候補で付けた確認を引き継がない（3.8）。
  const clear = () => { root.replaceChildren(); signature.value = ''; confirm.querySelector('input')!.checked = false; changed(root); };
  const fillRecipes = () => {
    const item = itemSelect!.querySelector('select')!.value, select = recipe.querySelector('select')!;
    const found = item ? recipesFor(ctx, item) : [];
    select.replaceChildren(h('option', { value: '' }, found.length === 0 ? 'なし' : '選ぶ'), ...found.map((t) => h('option', { value: t.id }, recipeLabel(t))));
    recipe.hidden = preview.hidden = found.length === 0;
    // 構成が登録されていなければ推計せず、手入力の材料だけで作業の開始できる（2.1）。
    status.textContent = !item ? '' : found.length === 0 ? '構成未登録：この製品のセットがないので使用候補は出せません。材料は手入力の欄で入れてください。' : '';
    clear();
  };
  // 候補の数量・保管単位・扱いを変えたら、確認し直させる。
  for (const kind of ['change', 'input']) root.addEventListener(kind, () => { confirm.querySelector('input')!.checked = false; });
  itemSelect!.addEventListener('change', fillRecipes);
  for (const node of [unitSelect!, basisField!, valueField!, recipe]) node.addEventListener('change', clear);
  valueField!.addEventListener('input', clear);
  preview.addEventListener('click', () => {
    clear();
    try {
      const template = own(ctx.supply().receiptTemplates, recipe.querySelector('select')!.value);
      if (!template) throw new Error('セットを選んでください');
      const item = value('item'), unit = value('unit'), basis = value('basis'), raw = value('value');
      const sets = basis === 'unknown' || raw.trim() === '' ? null : quantityValue(raw, quantityStepOf(ctx.ledger().masters, item, unit));
      const candidates = estimateCandidates(ctx.ledger().masters, template, { item, unit }, sets);
      root.append(h('p', {}, `台数${sets}${unit}から求めた候補です。今回使った分だけを確定してください。保管単位は選び、使わない明細は除外にします。`));
      candidates.forEach((c, i) => candidateRow(ctx, root, c, i, template.productUnit ?? unit));
      signature.value = previewSignature(template, item, unit, basis, raw); changed(root);
    } catch (error) { root.append(h('p', { class: 'error', role: 'status' }, error instanceof Error ? error.message : String(error))); }
  });
  fillRecipes();
  return [
    ...(processOptions(masters).length === 0 ? [h('p', { class: 'warn' }, '利用中の工程がありません。作業の種類「工程の登録・設定」で工程を登録してください。')] : []),
    choiceField('process', '工程', processOptions(masters)),
    textField('newId', '作業中の保管単位の新しいID'),
    itemSelect!, unitSelect!, projectField(masters),
    codeTarget(choiceField('location', '作業の場所', placeOptions(masters).filter(([id]) => id !== nextProcessOf(masters)?.id)), 'location', { hold: 'location' }),
    basisField!, valueField!, status, recipe, preview, signature, root, ...manualFields(ctx), confirm,
  ];
}

function estimateInputs(state: Parameters<UiOp['run']>[0], template: ReceiptTemplate, v: Values, sets: number): EstimateInput[] {
  const candidates = estimateCandidates(state.ledger.masters, template, { item: v.text('item'), unit: v.text('unit') }, sets);
  return candidates.map((c, i): EstimateInput => {
    const decision = v.text(`e${i}decision`);
    if (decision === 'unresolved' || decision === 'exclude') return decision === 'exclude' ? { decision, uses: [] } : { decision };
    if (decision !== 'use') throw new Error(`明細${i + 1}の扱いを選ぶ`);
    const count = Number(v.text(`e${i}count`)), step = quantityStepOf(state.ledger.masters, c.item, c.unit);
    if (!Number.isInteger(count) || count < 1 || count > estimateUseLimit) throw new Error('使用候補を出し直してください');
    return { decision, uses: Array.from({ length: count }, (_, k) => {
      const p = `e${i}u${k}`, lotId = v.text(`${p}lot`), basis = v.text(`${p}basis`), raw = v.text(`${p}value`).trim(), answer = v.text(`${p}inclusion`);
      if (!lotId) throw new Error(`明細${i + 1}の内訳${k + 1}の保管単位を選ぶ（使わないなら除外にする）`);
      if (basis !== 'approximate' && basis !== 'counted') throw new Error(`明細${i + 1}の内訳${k + 1}の根拠を選ぶ`);
      if (raw === '') throw new Error(`明細${i + 1}の内訳${k + 1}の今回の使用数を入れる`);
      return { lotId, basis, value: quantityValue(raw, step), ...(answer === '' ? {} : { inclusion: answer as Inclusion }) };
    }) };
  });
}

// field は画面の欄番号。空の行を飛ばすので、domain の位置と欄番号は一致しない。
function manualInputs(v: Values): (ManualUse & { field: number })[] {
  return Array.from({ length: manualUseLimit }, (_, k) => k + 1).flatMap((i): (ManualUse & { field: number })[] => {
    const lotId = v.text(`m${i}lot`);
    // 数量や根拠だけ入れた行を黙って捨てない。使わない行は全部を空にする。
    if (lotId === '' && (v.text(`m${i}basis`) !== '' || v.text(`m${i}value`).trim() !== '')) throw new Error(`手入力の材料${i}の保管単位を選ぶ（使わない材料なら根拠と数量も空にする）`);
    if (lotId === '') return [];
    if (v.text(`m${i}basis`) === '') throw new Error(`手入力の材料${i}の数量の根拠を選ぶ`);
    const { basis, value } = amount(v, `m${i}`), answer = v.text(`m${i}inclusion`);
    return [{ field: i, lotId, basis: basis as Basis, value, ...(answer === '' ? {} : { inclusion: answer as Inclusion }) }];
  });
}

export function recipeStartOps(ctx: Ctx): Record<string, UiOp> {
  return {
    recipeStart: {
      label: 'セットで作業を開始（材料の使用を推計）', fields: () => recipeStartFields(ctx),
      run: (state, meta, v) => {
        const process = processOf(state.ledger.masters, v.text('process'));
        if (!process) throw new Error('工程を選ぶ');
        const { basis, value } = amount(v);
        const templateId = v.text('recipe');
        const template = templateId === '' ? undefined : own(state.supply.receiptTemplates, templateId);
        if (templateId !== '' && (!template || previewSignature(template, v.text('item'), v.text('unit'), v.text('basis'), v.text('value')) !== v.text('estimateRevision'))) throw new Error('現在のセットと台数で使用候補を出してください');
        // この操作でセットを選ばずに記録できるのは、構成未登録の製品だけ（2.1）。
        if (templateId === '' && recipesFor(ctx, v.text('item')).length > 0) throw new Error('セットを選んで使用候補を出す（推計しないなら「作業の開始（材料の使用とまとめて記録）」を使う）');
        if (template && !v.checked('estimateConfirmed')) throw new Error('台数・今回の使用数・根拠・保管単位を確認してください');
        const rows = template ? estimateInputs(state, template, v, value!) : [];
        const lot = { id: v.text('newId'), item: v.text('item'), unit: v.text('unit'), project: projectOf(v), location: v.text('location') };
        const manual = manualInputs(v);
        try {
          return { state: startWithEstimate(state, meta, { lot, process, basis, value, templateId: template?.id ?? null, rows, manual: manual.map(({ field: _, ...m }) => m) }) };
        } catch (error) {
          if (!(error instanceof EstimateInclusionRequired)) throw error;
          const t = error.target;
          throw new MaterialInclusionRequired(error.message, t.kind === 'estimate' ? `e${t.row}u${t.use}inclusion` : `m${manual[t.index]!.field}inclusion`);
        }
      },
    },
  };
}
