import type { Ledger } from '../domain/ledger.ts';
import type { ReceiptTemplate } from '../domain/receipt-template.ts';
import type { Supply } from '../domain/supply.ts';
import { h, selectField } from './dom.ts';
import { basisLabel, itemRef, jst, locationRef } from './format.ts';
import { otherOperations } from './subject-actions.ts';

export type SetSelection = { product: string; template: string };

function composition(ledger: Ledger, template: ReceiptTemplate): HTMLElement {
  return h('ol', {}, ...template.rows.map(row => h('li', {},
    `${itemRef(ledger.masters, row.item)}／1${template.productUnit ?? '単位'}あたり${row.perSet}${row.unit}／${locationRef(ledger.masters, row.location)}／${basisLabel[template.basis]}`,
    row.assembly === undefined ? null : h('details', { 'data-set-child': '' },
      h('summary', {}, `固定した子構成：${row.assembly.name}（${row.assembly.id}）`),
      composition(ledger, row.assembly)),
  )));
}

function savedRecordText(supply: Supply, id: string): string {
  const event = supply.log.findLast(event => event.kind === 'receiptTemplateSave' && event.after.id === id);
  return event === undefined ? '構成の識別記録なし' : `構成の保存記録：${event.eventId}／${jst(event.recordedAt)}`;
}

export function setsPanel(ledger: Ledger, supply: Supply, selection: SetSelection, select: (value: SetSelection) => void, operate: (key: string, id?: string) => void, labelOf: (key: string) => string): HTMLElement[] {
  const templates = Object.values(supply.receiptTemplates);
  const product = selectField('set-product', '製品で絞る', [['', 'すべて'], ...Object.values(ledger.masters.items).map(item => [item.id, itemRef(ledger.masters, item.id)] as const)], selection.product);
  product.addEventListener('change', () => select({ product: product.querySelector('select')!.value, template: '' }));
  const register = h('button', { type: 'button' }, 'セットを登録');
  register.addEventListener('click', () => operate('templateSave'));
  const found = templates.filter(template => !selection.product || template.product === selection.product);
  const list = h('ul', { class: 'set-list', 'aria-label': '登録済みセット' }, ...found.map(template => {
    const button = h('button', { type: 'button', 'data-set': template.id }, template.name);
    if (template.id === selection.template) button.setAttribute('aria-current', 'true');
    button.addEventListener('click', () => select({ ...selection, template: template.id }));
    return h('li', {}, button, h('p', {}, `${template.product === null ? '製品未設定' : itemRef(ledger.masters, template.product)}／${template.productUnit ?? '単位未設定'}／${template.rows.length}行`), h('p', {}, savedRecordText(supply, template.id)));
  }));
  const template = found.find(template => template.id === selection.template);
  const detail = h('div', { 'data-set-detail': '' });
  if (template) {
    const action = (key: string, label = labelOf(key)) => {
      const button = h('button', { type: 'button', 'data-op': key }, label);
      button.addEventListener('click', () => operate(key, template.id));
      return button;
    };
    detail.append(h('h3', {}, template.name),
      // セットから入る人には主操作を目的の言葉で示す。押した後の操作欄は既存の操作名のまま。
      action('templateReceive', 'このセットの部品を受け取る'),
      action('templateNeedGenerate'), action('recipeStart'),
      otherOperations([action('templateSave'), action('templateDelete')])!,
      h('p', {}, `${template.product === null ? '製品未設定' : itemRef(ledger.masters, template.product)}／1${template.productUnit ?? '単位'}あたり／${basisLabel[template.basis]}`),
      h('p', {}, savedRecordText(supply, template.id)), composition(ledger, template));
  }
  return [product, register, ...(found.length === 0 ? [h('p', {}, templates.length === 0 ? 'セットはまだありません' : 'この製品のセットは未登録です')] : [list]), detail];
}
