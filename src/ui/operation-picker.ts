import { h } from './dom.ts';

export const operationGroups = [
  { id: 'stock', label: '現物の登録・使用・移動', keys: ['register', 'use', 'handover', 'move', 'splitMove', 'split', 'merge', 'transfer', 'hold', 'release'] },
  { id: 'production', label: '製造・工程', keys: ['start', 'recipeStart', 'finish', 'inspect', 'toNext', 'stageFix', 'stop', 'stopUpdate', 'resume'] },
  { id: 'rework', label: 'やり直し・修理', keys: ['reworkBegin', 'reworkReplace', 'reworkDiscard', 'reworkRecover', 'returnRecord', 'returnAssign', 'returnRework'] },
  { id: 'requests', label: '必要な数・依頼・発注', keys: ['needRegister', 'needRevise', 'declareShortage', 'linkDeclaration', 'requestRecord', 'orderConfirm', 'replyRecord', 'requestCancel'] },
  { id: 'receipts', label: '受け取り・割り当て・返却', keys: ['receive', 'templateReceive', 'templateSave', 'templateDelete', 'allocate', 'receiptRevise', 'arrivalRevise', 'surplusAllocate', 'spareSwap', 'returnAck', 'remainder'] },
  { id: 'corrections', label: '数え直し・訂正・照合', keys: ['recount', 'declare', 'correctTime', 'void', 'resolve', 'needImportResolve'] },
  { id: 'provisional', label: '仮の記録・所属の整理', keys: ['provisional', 'identify', 'adopt', 'assignProject'] },
  { id: 'masters', label: '登録情報の登録・変更', keys: ['masterItem', 'masterLocation', 'masterCase', 'masterActor', 'masterRename', 'masterDeactivate', 'masterReactivate', 'masterCode', 'masterSource', 'masterPerBox', 'masterScope'] },
];

export function operationPicker(operations: Readonly<Record<string, { label: string }>>, current: string): { browsing: HTMLElement; operation: HTMLSelectElement } {
  const seen = new Set<string>();
  for (const group of operationGroups) {
    if (group.keys.length === 0 || group.keys.length > 12) throw new Error('作業の分類件数が不正です');
    for (const key of group.keys) {
      if (!Object.hasOwn(operations, key) || seen.has(key)) throw new Error(`操作の分類が不正です：${key}`);
      seen.add(key);
    }
  }
  if (Object.keys(operations).some(key => !seen.has(key))) throw new Error('未分類の操作があります');
  const initialGroup = operationGroups.find(group => group.keys.includes(current));
  if (initialGroup === undefined) throw new Error('現在の操作が分類にありません');
  const category = h('select', { id: 'operation-group', 'aria-describedby': 'operation-group-help' });
  for (const group of operationGroups) category.append(h('option', { value: group.id }, group.label));
  category.value = initialGroup.id;
  const operation = h('select', { name: 'op' });
  const option = (key: string) => h('option', { value: key }, operations[key]!.label);
  const show = () => {
    const group = operationGroups.find(item => item.id === category.value);
    if (group === undefined) throw new Error('作業の種類を選んでください');
    operation.replaceChildren();
    if (!group.keys.includes(current)) operation.append(h('optgroup', { label: '入力中の操作' }, option(current)));
    operation.append(h('optgroup', { label: group.label, 'data-operation-group': group.id }, ...group.keys.map(option)));
    operation.value = current;
  };
  category.addEventListener('change', show);
  show();
  return {
    browsing: h('div', { class: 'operation-picker' }, h('label', { for: 'operation-group' }, '作業の種類'), category,
      h('p', { id: 'operation-group-help' }, '種類を選ぶと操作の候補が絞られます。入力中の操作は残ります。別の操作を選ぶと入力欄が切り替わります。')),
    operation,
  };
}
