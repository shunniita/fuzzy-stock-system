import type { Meta } from '../domain/ledger.ts';
import type { TemplateNeedBatchInput, TemplateNeedGenerationInput, TemplateNeedGeneration } from '../domain/template-needs.ts';
import type { TemplateNeedChangeInput } from './template-needs-edit-preview.ts';
import type { State } from './supply-ui.ts';
import { h } from './dom.ts';
import { itemRef, projectText } from './format.ts';
import { currentTemplateVersionText } from './template-needs-format.ts';

// 台帳と供給は確定後に深く凍結され、変更操作は別オブジェクトを返すため同一性で変更を検出できる。
const identities = new WeakMap<object, number>();
let nextIdentity = 0;
function identity(value: object): number {
  let id = identities.get(value);
  if (id === undefined) { id = ++nextIdentity; identities.set(value, id); }
  return id;
}

export function templateNeedPreviewSignature(state: State, input: TemplateNeedGenerationInput | TemplateNeedBatchInput | TemplateNeedChangeInput): string {
  return JSON.stringify([input, identity(state.ledger), identity(state.supply)]);
}

export function previewMeta(form: HTMLFormElement | null, eventId: string): Meta {
  const recordedAt = new Date().toISOString();
  const raw = form?.querySelector<HTMLInputElement>('[name=occurredAt]')?.value;
  return { eventId, actor: document.querySelector<HTMLSelectElement>('#actor')?.value || 'プレビュー', recordedAt,
    occurredAt: form?.querySelector<HTMLInputElement>('[name=occurredUnknown]')?.checked ? null : raw ? `${raw}${raw.length === 16 ? ':00' : ''}+09:00` : recordedAt };
}

export function templateNeedOptions(state: State): [string, string][] {
  return Object.values(state.supply.receiptTemplates).map((template): [string, string] => [template.id,
    `${template.name}／${template.product === null ? '製品未設定' : itemRef(state.ledger.masters, template.product)}／${currentTemplateVersionText(state.ledger.masters, state.supply, template.id)}`]);
}

export function generationPreview(state: State, result: Omit<TemplateNeedGeneration, 'ledger' | 'event'>): HTMLElement {
  return h('section', {}, h('h3', {}, `${projectText(state.ledger.masters, { kind: 'case', id: result.plan.project })}・${result.plan.count}台${result.newProject ? '（新しく登録）' : ''}`),
    h('p', {}, `セット「${result.version.template.name}」・製品${result.version.template.product === null ? '未設定' : itemRef(state.ledger.masters, result.version.template.product)}・${currentTemplateVersionText(state.ledger.masters, state.supply, result.version.template.id)}・セット版${result.version.id}・必要日${result.needs[0]?.dueDate ?? 'なし'}`),
    h('div', { class: 'table-scroll', tabindex: '0', role: 'region', 'aria-label': '生成する必要明細（横スクロール）' },
      h('table', { 'aria-label': '生成する必要明細' }, h('thead', {}, h('tr', {}, ...['品目', '元の行', '1台あたり', '必要数（ラベル値）'].map(text => h('th', { scope: 'col' }, text)))),
        h('tbody', {}, ...result.rows.map(row => h('tr', {}, h('td', {}, itemRef(state.ledger.masters, row.item)), h('td', {}, row.sourceRows.join('、')), h('td', {}, `${row.perSet}${row.unit}`), h('td', {}, `${row.required}${row.unit}`)))))));
}

