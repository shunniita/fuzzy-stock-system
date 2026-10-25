import { readCode, type Scan } from '../domain/code.ts';
import type { Ledger } from '../domain/ledger.ts';
import { own, type Masters } from '../domain/masters.ts';
import { codeFormat, interpretationText } from './code-format.ts';
import { field, h } from './dom.ts';
import { projectKey } from './fields.ts';
import { caseRef, locationRef, projectText } from './format.ts';

export type CodeHolds = { project: string | null; location: string | null };
// reference：送信の可否に関わらず、読取原文と採用済みの証拠（未確認を含む）を参照用に取り出す。送信にはevidenceを使う。
export type CodeInput = { node: HTMLElement; evidence(): Scan | undefined; reference(): { raw: string; query: string; target: string; adopted: Scan | undefined } };
const labelOf = (select: HTMLSelectElement): string => Array.from(select.closest('label')?.childNodes ?? []).filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent ?? '').join('').trim();
const selectedText = (select: HTMLSelectElement): string => select.value === '' ? '未選択' : select.selectedOptions[0]?.textContent ?? select.value;
const selectable = (select: HTMLSelectElement): HTMLOptionElement[] => Array.from(select.options).filter(o => o.value !== '' && !o.disabled && !o.hidden);

function projectName(masters: Masters, id: string): string {
  if (id === 'common' || id === 'unassigned') return projectText(masters, { kind: id });
  return `${own(masters.cases, id)?.name ?? '案件・用途'}（${caseRef(masters, id)}）`;
}
const placeName = (masters: Masters, id: string): string => `${own(masters.locations, id)?.name ?? '場所'}（${locationRef(masters, id)}）`;
function targetText(target: HTMLSelectElement, value: string, text: string, ledger: Ledger): string {
  if (value === '') return '未選択';
  switch (target.dataset['codeTarget']) {
    case 'project': return projectName(ledger.masters, value);
    case 'location': return placeName(ledger.masters, value);
    case 'lot': {
      const lot = own(ledger.lots, value);
      return lot ? `${text}・品名${own(ledger.masters.items, lot.item)?.name ?? lot.item}・${projectName(ledger.masters, projectKey(lot.project))}・${placeName(ledger.masters, lot.location)}` : text;
    }
    default: return text;
  }
}

function matches(scan: Scan, target: HTMLSelectElement, value: string, ledger: Ledger): boolean {
  const interpreted = scan.interpreted;
  if (interpreted.kind !== 'item' && interpreted.kind !== 'label') return false;
  const item = interpreted.item;
  switch (target.dataset['codeTarget']) {
    case 'item': return item.kind === 'found' && item.active && value === item.id;
    case 'project': return interpreted.kind === 'label' && interpreted.project.kind === 'found' && interpreted.project.active && value === interpreted.project.id;
    case 'lot': {
      const lot = ledger.lots[value];
      return lot !== undefined && item.kind === 'found' && item.active && lot.item === item.id && (interpreted.kind === 'item' || (interpreted.project.kind === 'found' && interpreted.project.active && projectKey(lot.project) === interpreted.project.id));
    }
    default: return false;
  }
}

function clearLabelQuantity(form: HTMLFormElement, target: HTMLSelectElement): void {
  const quantity = form.elements.namedItem(target.dataset['codeQuantity'] ?? '');
  if (quantity instanceof HTMLInputElement) quantity.value = '';
  const basis = form.elements.namedItem(target.dataset['codeBasis'] ?? '');
  if (basis instanceof HTMLSelectElement && selectable(basis).some(o => o.value === 'label')) basis.value = 'label';
}

// 一フォームの読取状態。保持だけは呼出し側がタブ内で共有し、保存データへは含めない。
export function codeInput(form: HTMLFormElement, ledger: Ledger, operation: string, holds: CodeHolds): CodeInput {
  const targets = Array.from(form.querySelectorAll<HTMLSelectElement>('select[data-code-target]'));
  const node = h('section', { class: 'code-input', 'aria-label': 'コード入力補助' }, h('h3', {}, 'コード入力・検索'));
  if (targets.length === 0) { node.hidden = true; return { node, evidence: () => undefined, reference: () => ({ raw: '', query: '', target: '', adopted: undefined }) }; }
  const raw = h('textarea', { rows: '2', autocomplete: 'off', spellcheck: 'false' });
  const result = h('div', { 'aria-live': 'polite', 'data-code-result': '' });
  const targetChoice = h('select');
  targetChoice.append(h('option', { value: '' }, '入力先を選ぶ'));
  for (const target of targets) targetChoice.append(h('option', { value: target.name }, labelOf(target)));
  const query = h('input', { type: 'search' });
  const options = h('div', { 'data-code-options': '' });
  const final = h('p', { 'data-code-final': '' });
  const confirm = h('button', { type: 'button' }, 'この対象で続ける');
  const held = h('div', { 'data-code-holds': '' });
  let rawText = '';
  let current: Scan | undefined;
  let adopted: Scan | undefined;
  let confirmed = false;
  let searching = false;
  const target = () => targets.find(t => t.name === targetChoice.value);

  function renderFinal(): void {
    const selections = targets.map(t => `${labelOf(t)}：${targetText(t, t.value, selectedText(t), ledger)}`).join(' ／ ');
    final.textContent = `操作：${operation}。最終対象：${selections || 'この操作には対象選択欄がない'}。${adopted ? `読取証拠は操作全体に一件を添付する。${confirmed ? '対象確認済み' : '対象を確認してください'}` : '読取証拠は未採用'}`;
    confirm.hidden = adopted === undefined;
  }
  function renderHeld(): void {
    const p = holds.project;
    const project = p === null ? '未設定' : projectName(ledger.masters, p);
    held.textContent = `保持中の案件・用途：${project} ／ 保持中の場所：${holds.location === null ? '未設定' : placeName(ledger.masters, holds.location)}。再読込・復元・初期化で保持は消えます。今回の選択は変更できます。`;
    for (const t of targets) {
      const key = t.dataset['codeHold'];
      const value = key === 'project' ? holds.project : key === 'location' ? holds.location : null;
      if (value !== null && !selectable(t).some(o => o.value === value)) held.append(h('p', { class: 'error' }, `${labelOf(t)}：保持値をこの入力では選べません。選び直してください。`));
    }
  }
  function renderResult(): void {
    result.replaceChildren();
    if (!current) return;
    result.append(h('p', {}, `原文：${JSON.stringify(current.raw)} ／ ${codeFormat[current.format]} ／ ${interpretationText(current)}`));
    if (current.interpreted.kind === 'label') {
      result.append(h('p', {}, 'ラベルだけでは数量・中身を確認したことになりません。候補適用時、根拠を選ぶ操作の数量は空欄、根拠は「表示の数（ラベル・パッケージ）（中身未確認）」になります。数え直し・予備の交換で入力済みの実数は保ちます。'));
      const p = current.interpreted.project;
      const expected = p.kind === 'found' ? p.id : null;
      const selected = targets.flatMap(t => {
        if (t.dataset['codeTarget'] === 'project') return t.value ? [t.value] : [];
        const lot = t.dataset['codeTarget'] === 'lot' ? ledger.lots[t.value] : undefined;
        return lot ? [projectKey(lot.project)] : [];
      });
      if ([...selected, ...(holds.project === null ? [] : [holds.project])].some(p => p !== expected)) result.append(h('p', { class: 'error' }, 'ラベルの案件・用途と現在の選択・保持中の案件・用途が異なります。今回の対象を選び、確認してください。'));
    }
  }
  function changed(): void {
    confirmed = false;
    renderFinal(); renderResult(); renderHeld();
  }
  function apply(value: string): void {
    const t = target();
    if (!t || !selectable(t).some(o => o.value === value) || current?.format === 'document') return;
    t.value = value;
    adopted = current;
    if (current?.interpreted.kind === 'label') clearLabelQuantity(form, t);
    t.dispatchEvent(new Event('change', { bubbles: true }));
    changed();
  }
  function showOptions(): void {
    options.replaceChildren();
    const t = target();
    if (!t) { options.append(h('p', {}, '操作の入力先を選んでください。')); return; }
    if (current?.format === 'document') { options.append(h('p', {}, '帳票コードは元の資料・改訂・明細を識別するだけです。現物の対象や数量には適用しません。別のコードを入力するか、原文を消して検索してください。')); return; }
    const found = selectable(t).filter(o => searching ? `${o.value} ${targetText(t, o.value, o.textContent ?? '', ledger)}`.includes(query.value.trim()) : current !== undefined && matches(current, t, o.value, ledger));
    for (const o of found) {
      const button = h('button', { type: 'button' }, `${targetText(t, o.value, o.textContent ?? o.value, ledger)}を適用`);
      button.addEventListener('click', () => apply(o.value));
      options.append(button);
    }
    if (found.length === 0) options.append(h('p', {}, '候補がありません。未登録・利用停止・形式不正の場合は、名称や品番・コードで検索するか、同じ原文欄へ品目IDを手入力してください。'));
  }
  function invalidateRaw(): void {
    current = undefined; adopted = undefined; searching = false;
    options.replaceChildren();
    form.dispatchEvent(new Event('input', { bubbles: true }));
    changed();
  }
  function interpret(): void {
    current = readCode(rawText, ledger.masters); adopted = undefined; searching = false;
    form.dispatchEvent(new Event('input', { bubbles: true }));
    changed(); showOptions();
  }
  raw.addEventListener('input', () => { rawText = raw.value; invalidateRaw(); });
  raw.addEventListener('paste', event => {
    const pasted = event.clipboardData?.getData('text/plain');
    if (pasted === undefined) return;
    event.preventDefault();
    const from = raw.selectionStart;
    rawText = raw.value.slice(0, from) + pasted + raw.value.slice(raw.selectionEnd);
    raw.value = rawText; raw.setSelectionRange(from + pasted.length, from + pasted.length);
    invalidateRaw();
  });
  raw.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); interpret(); }
  });
  const parse = h('button', { type: 'button' }, '解釈'); parse.addEventListener('click', interpret);
  const search = h('button', { type: 'button' }, '検索'); search.addEventListener('click', () => { searching = true; showOptions(); });
  query.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); searching = true; showOptions(); } });
  targetChoice.addEventListener('change', showOptions);
  confirm.addEventListener('click', () => { confirmed = true; renderFinal(); });
  const holdsButtons = h('div');
  for (const key of ['project', 'location'] as const) {
    const t = targets.find(t => t.dataset['codeHold'] === key);
    const name = key === 'project' ? '案件・用途' : '場所';
    if (t) {
      const value = holds[key];
      if (value !== null && selectable(t).some(o => o.value === value)) { t.value = value; t.dispatchEvent(new Event('change', { bubbles: true })); }
      const keep = h('button', { type: 'button' }, `現在の${name}を保持`);
      keep.addEventListener('click', () => { holds[key] = t.value || null; changed(); });
      holdsButtons.append(keep);
    }
    const clear = h('button', { type: 'button' }, `${name}の保持を解除`);
    clear.addEventListener('click', () => { holds[key] = null; changed(); }); holdsButtons.append(clear);
  }
  form.addEventListener('input', changed);
  form.addEventListener('change', event => {
    if (event.target instanceof HTMLSelectElement && targets.includes(event.target) && current && current.format !== 'document') {
      adopted = current;
    }
    changed();
  });
  node.append(held, holdsButtons, field('読取原文・品目ID', raw), parse, result, field('コードの入力先', targetChoice), field('名称・品番・コードで検索', query), search, options, final, confirm);
  changed();
  return { node, evidence: () => {
    if (adopted && !confirmed) throw new Error('読取後の最終対象を「この対象で続ける」で確認する');
    return adopted;
  }, reference: () => ({ raw: raw.value, query: query.value, target: targetChoice.value, adopted }) };
}
