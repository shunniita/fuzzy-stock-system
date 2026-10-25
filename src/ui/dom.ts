import type { Step } from '../domain/scalar.ts';

export type Child = Node | string | null | undefined | false;

// 利用者の入力はtextContentとしてだけ画面に出し、HTMLとして解釈しない（INP-02c）。
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<Record<string, string>> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) if (value !== undefined) node.setAttribute(key, value);
  for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

export function section(id: string): HTMLElement {
  const node = document.getElementById(id)!;
  node.replaceChildren(node.firstElementChild!);
  return node;
}

export function field(label: string, control: HTMLElement): HTMLLabelElement {
  return h('label', {}, label, control);
}

export function selectField(name: string, label: string, options: readonly (readonly [string, string])[], value = ''): HTMLLabelElement {
  const select = h('select', { name });
  for (const [v, text] of options) select.append(h('option', { value: v }, text));
  if (value) select.value = value;
  return field(label, select);
}

// 先頭の選択肢のまま送ると、選んでいない値（数えた、案件・用途A-001等）が黙って記録されるので、空から始めて選ばせる。
// 未選択は記録前に拒否する（submit）。ブラウザーのrequiredは、隠れた欄があると送信ごと止まり理由も残らないので使わない。
export function choiceField(name: string, label: string, options: readonly (readonly [string, string])[]): HTMLLabelElement {
  const node = selectField(name, label, [['', '選ぶ'], ...options]);
  node.querySelector('select')!.dataset['required'] = label;
  return node;
}

// type=numberはstep既定1で0.1の送信をブラウザーが止め、読めない原文を黙って空欄にするので、数値も文字として受けて画面が検査する。
// 'number'は数量（小数あり）、'integer'は1箱あたりの数のような整数だけの欄。
export function textField(name: string, label: string, type = 'text'): HTMLLabelElement {
  const numeric = type === 'number' ? 'decimal' : type === 'integer' ? 'numeric' : null;
  return field(label, h('input', numeric === null ? { name, type, autocomplete: 'off' } : { name, type: 'text', inputmode: numeric, autocomplete: 'off' }));
}

export function checkField(name: string, label: string, checked = false): HTMLLabelElement {
  const box = h('input', { name, type: 'checkbox' });
  box.checked = checked;
  return h('label', { class: 'check' }, box, label);
}

// stepは数量の欄が指す品目・単位の最小単位。分からなければundefined（入力欄を持たない呼出しも含む）。
export type Values = { text(name: string): string; checked(name: string): boolean; step?(name: string): Step | undefined };
