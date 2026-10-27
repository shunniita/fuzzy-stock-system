import { InclusionRequired, noStage, processUsed, register, type Ledger, type Lot, type Meta, type Process, type Project, type Stage } from '../domain/ledger.ts';
import type { Basis } from '../domain/quantity.ts';
import { choiceField, h, textField, type Values } from './dom.ts';
import { inScopeAt, own, processOf, processRef, quantityStepOf, unassignedCode, type Masters } from '../domain/masters.ts';
import { parseSignedScalar, scalarLimitText, StepMismatch, type Step } from '../domain/scalar.ts';
import type { Supply } from '../domain/supply.ts';
import { basisLabel, criterionText, itemRef, locationRef, projectText, stageText } from './format.ts';

// 台帳の画面と供給の画面で共有する、状態を持たない入力欄の部品。

// 作業の開始の材料ごとの包含の回答欄を指す。画面は、このエラーの欄だけを出す。
export class MaterialInclusionRequired extends InclusionRequired {
  field: string;

  constructor(message: string, field: string) {
    super(message);
    this.field = field;
  }
}

export function codeTarget(node: HTMLLabelElement, kind: 'item' | 'project' | 'location' | 'lot', options: { quantity?: string; basis?: string; hold?: 'project' | 'location' } = {}): HTMLLabelElement {
  const select = node.querySelector('select')!;
  select.dataset['codeTarget'] = kind;
  if (options.quantity !== undefined) select.dataset['codeQuantity'] = options.quantity;
  if (options.basis !== undefined) select.dataset['codeBasis'] = options.basis;
  if (options.hold !== undefined) select.dataset['codeHold'] = options.hold;
  return node;
}

export function lotOptions(ledger: Ledger, where: (lot: Lot) => boolean = () => true): [string, string][] {
  const m = ledger.masters;
  return Object.values(ledger.lots)
    .filter((l) => l.mergedInto === null && where(l))
    .map((l) => [l.id, `${l.id}（品目${itemRef(m, l.item)}・${locationRef(m, l.location)}・${projectText(m, l.project)}${l.stage.kind === 'none' ? '' : `・${stageText(l.stage, id => processRef(m, id))}`}）`]);
}

// 新しい置き場所は、利用中で記録の対象だったことのある場所を出す。どの時点で範囲内かは、入力中の実際の日時で決まる（要件3.1・7.3・7.4）ので、
// 画面が選択肢を絞る（restrictPlaces）。
export const placeOptions = (masters: Masters): [string, string][] =>
  Object.values(masters.locations).filter((l) => l.active && l.scope.some((s) => s.inScope)).map((l) => [l.id, `${l.name}（${l.code}）`]);

// 新しく工程に載せる入力の選択肢。利用停止中の工程は出さない（MST-03）。
export const processOptions = (masters: Masters): [string, string][] =>
  Object.values(masters.processes).filter((p) => p.active).map((p) => [p.id, `工程${p.name}（完了基準：${criterionText(p.criterion)}）`]);

// 中断は過去の日時でも記録できる（MFG-08a）ので、利用停止中の工程でも記録に使われていれば選べる。
export function stopProcessOptions(ledger: Ledger): [string, string][] {
  return Object.values(ledger.masters.processes).filter((p) => p.active || processUsed(ledger, p.id))
    .map((p) => [p.id, `工程${processRef(ledger.masters, p.id)}（完了基準：${criterionText(p.criterion)}）`]);
}

// 場所の選択肢のうち、その時点で記録の対象外のものを選べなくする（要件7.3・7.4）。選ぶ欄は、選んでいたものが外れたら選び直させる。
// 不明を選べる欄（仮の記録）は、選んでいた場所を黙って不明にしないよう、選んだままにして台帳に断らせる。
// 判断の時点が入力中の実際の日時でない欄（data-place-time=fixed。仮の記録からの登録は仮の記録の時点で判断する）は絞らない。
export function restrictPlaces(form: HTMLFormElement, masters: Masters, at: string): void {
  for (const select of form.querySelectorAll<HTMLSelectElement>('select[name=location]')) {
    if (select.dataset['placeTime'] === 'fixed') continue;
    const choosing = select.dataset['required'] !== undefined;
    for (const option of select.options) {
      const place = option.value === '' ? undefined : own(masters.locations, option.value);
      const outside = place !== undefined && !inScopeAt(place, at);
      option.disabled = option.hidden = outside && (choosing || !option.selected);
    }
    if (choosing && select.selectedOptions[0]?.disabled) select.value = '';
  }
}

export function projectKey(p: Project): string {
  return p.kind === 'case' ? p.id : p.kind;
}

export const basisOptions = (Object.keys(basisLabel) as Basis[]).map((b) => [b, basisLabel[b]] as const);

export const amountFields = () => [
  choiceField('basis', '数量の根拠', basisOptions),
  textField('value', '数量（数が不明なら空欄。0は0と入力）', 'number'),
];

export function amount(v: Values, prefix = ''): { basis: Basis; value: number | null } {
  const basis = v.text(`${prefix}basis`) as Basis;
  const raw = v.text(`${prefix}value`).trim();
  // 空欄を0にしない。数が不明と数値の組、数が不明以外の空欄は、そのまま台帳の検査で拒否される（QTY-01a）。
  return { basis, value: raw === '' ? null : quantityValue(raw, v.step?.(`${prefix}value`)) };
}

// Number()は0.10000000000000001を0.1へ丸めるので、原文のまま検査してから数値にする。最終の照合は対象の単位を知る台帳・供給も行う。
// 最小単位が分からないときは整数を先に読み、0.1単位の上限より大きい整数単位の数量を拒否しない。
export function quantityValue(raw: string, step?: Step): number {
  if (step !== undefined) return parseSignedScalar(raw, step);
  try {
    return parseSignedScalar(raw, 1);
  } catch (integerError) {
    if (!(integerError instanceof StepMismatch)) throw integerError;
    try {
      return parseSignedScalar(raw, 0.1);
    } catch (tenthError) {
      if (tenthError instanceof StepMismatch) throw new Error('数量は品目・単位の最小単位（1または0.1）に合う値で入力する');
      throw tenthError;
    }
  }
}
export function countOrUnknown(v: Values, name: string, label: string): number | null {
  if (v.checked(`${name}Unknown`)) return null;
  const raw = v.text(name).trim();
  if (raw === '') throw new Error(`${label}を入力するか、不明を選ぶ`);
  return quantityValue(raw, v.step?.(name));
}


export type QuantityTarget = { item: string; unit: string } | 'unitless' | null;

// 数量の欄が指す品目・単位を、同じ入力の選択欄から引く（欄がなければvalue()はnull）。台帳・供給の操作が数量の精度を引くのと同じ対象
// （選んだまとまり・依頼・必要明細・中断、なければ品目と単位）。数量の欄でなければundefined。
export function quantityTargetOf(value: (name: string) => string | null, ledger: Ledger, supply: Supply, name: string): QuantityTarget | undefined {
  const lot = (id: string | null) => (id === null ? null : ledger.lots[id] ?? null);
  const request = (id: string | null) => (id === null ? null : supply.requests[id] ?? null);
  const row = /^(m|r)(\d)(value|arrived|good)$/.exec(name);
  if (row) return row[1] === 'm' ? lot(value(`m${row[2]}lot`)) : request(value(`r${row[2]}request`));
  if (name === 'shortageValue') return value('shortageItem') && value('shortageUnit') ? { item: value('shortageItem')!, unit: value('shortageUnit')! } : null;
  if (!['value', 'affected', 'quantity', 'arrived', 'good', 'received'].includes(name)) return undefined;
  const arrival = value('arrival');
  if (arrival !== null) return request(arrival.split('/')[0] ?? null);
  if (value('request') !== null) return request(value('request'));
  const need = value('need');
  if (need !== null) return supply.needs[need] ?? null;
  const stop = value('stop');
  if (stop !== null) return ledger.stops[stop] ?? null;
  if (value('receipt') !== null) return lot(value('receipt'));
  if (value('lot') !== null) return lot(value('lot'));
  const item = value('item');
  if (item === null) return null;
  if (value('unit') === null) return 'unitless';
  return item !== '' && value('unit') !== '' ? { item, unit: value('unit')! } : null;
}

// 登録済みの品目・単位の精度だけを返す。未登録の文脈は台帳・供給が設定不明として断るので、画面は推測しない。
export function quantityStepFor(masters: Masters, target: QuantityTarget): Step | undefined {
  if (target === 'unitless') return 1;
  return target === null ? undefined : own(own(masters.items, target.item)?.unitSteps ?? {}, target.unit);
}

export function hintText(masters: Masters, target: QuantityTarget): string {
  if (target === null) return '最小単位と上限は、対象（品目と単位、または保管単位・依頼）を選ぶと示す';
  if (target === 'unitless') return '最小単位1（単位を持たない仮の記録は整数だけ）・上限' + scalarLimitText(1);
  const step = quantityStepOf(masters, target.item, target.unit);
  return `${target.unit}の最小単位${step}${step === 1 ? '（整数）' : ''}・上限${scalarLimitText(step)}`;
}

export function formValue(form: HTMLFormElement): (name: string) => string | null {
  return (name) => {
    const control = form.elements.namedItem(name);
    return control instanceof HTMLInputElement || control instanceof HTMLSelectElement ? control.value : null;
  };
}

// 数量の欄の下に、対象の単位の最小単位と上限を示す。ブラウザーの妥当性検査には頼らず、記録するときに同じ対象の精度で検査する。
export function precisionHints(form: HTMLFormElement, ledger: Ledger, supply: Supply): void {
  const value = formValue(form);
  const targetOf = (name: string) => quantityTargetOf(value, ledger, supply, name);
  const hints: [HTMLInputElement, HTMLElement][] = [];
  for (const input of form.querySelectorAll<HTMLInputElement>('input[inputmode=decimal]')) {
    if (targetOf(input.name) === undefined) continue;
    const hint = h('p', { id: `hint-${input.name}`, class: 'hint' });
    input.setAttribute('aria-describedby', hint.id);
    input.closest('label')!.after(hint);
    hints.push([input, hint]);
  }
  const sync = () => { for (const [input, hint] of hints) hint.textContent = hintText(ledger.masters, targetOf(input.name) ?? null); };
  form.addEventListener('change', sync);
  sync();
}

// 新しい記録の品目・案件・用途は、利用中の登録情報だけを出す（要件3.1）。値は記録が指す内部の識別、表示は現在の既存ID。
export const itemOptions = (masters: Masters): [string, string][] =>
  Object.values(masters.items).filter((i) => i.active).map((i) => [i.id, `${i.name}（${i.code ?? unassignedCode}）`]);

export function itemFields(masters: Masters, quantity: string | null = 'value'): HTMLElement[] {
  const itemSelect = codeTarget(choiceField('item', '品目', itemOptions(masters)), 'item', quantity === null ? {} : { quantity, basis: 'basis' });
  const unitSelect = choiceField('unit', '単位', []);
  // 単位が一つの品目は選ぶまでもないので、その単位だけにする。
  const fillUnits = () => {
    const id = itemSelect.querySelector('select')!.value;
    const units = own(masters.items, id)?.units ?? [];
    const options = units.length === 1 ? units : ['', ...units];
    unitSelect.querySelector('select')!.replaceChildren(...options.map((u) => h('option', { value: u }, u || '選ぶ')));
  };
  itemSelect.addEventListener('change', fillUnits);
  fillUnits();
  return [itemSelect, unitSelect];
}

export const projectsOf = (masters: Masters): Project[] => [
  ...Object.values(masters.cases).filter((c) => c.active).map((c): Project => ({ kind: 'case', id: c.id })),
  { kind: 'common' },
  { kind: 'unassigned' },
];
export const projectField = (masters: Masters) => codeTarget(choiceField('project', '案件・用途', projectsOf(masters).map((p) => [projectKey(p), projectText(masters, p)])), 'project', { hold: 'project' });
// 案件・用途の内部の識別は common・unassigned にならない（登録で避ける）ので、値から案件・用途を戻せる。
export function projectOf(v: Values): Project {
  const key = v.text('project');
  return key === 'common' ? { kind: 'common' } : key === 'unassigned' ? { kind: 'unassigned' } : { kind: 'case', id: key };
}

export function registerFromValues(ledger: Ledger, meta: Meta, v: Values): Ledger {
  const { basis, value } = amount(v);
  const kind = v.text('stage');
  let stage: Stage;
  switch (kind) {
    case '':
    case 'none':
      stage = noStage;
      break;
    case 'working':
    case 'inspecting':
    case 'awaitingHandover': {
      const process = processOf(ledger.masters, v.text('process'));
      if (!process) throw new Error('工程を選ぶ');
      stage = { kind, process };
      break;
    }
    default:
      throw new Error('作業の状態を選ぶ');
  }
  return register(ledger, meta, { id: v.text('newId'), item: v.text('item'), unit: v.text('unit'), project: projectOf(v), location: v.text('location'), stage }, basis, value);
}
