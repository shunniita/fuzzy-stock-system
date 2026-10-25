import type { AlternativeOperation, AlternativeSource } from '../domain/alternative-record.ts';
import { checkField, h, textField, type Values } from './dom.ts';

export function alternativeOperationOf(key: string): AlternativeOperation | null {
  switch (key) {
    case 'use': case 'move': case 'start': case 'receive': return key;
    default: return null;
  }
}

export function alternativeFields(operation: AlternativeOperation | null): HTMLElement[] {
  if (operation === null) return [];
  const selected = checkField('alternative', '別記録・元の資料からの後入力');
  const fields = h('div');
  selected.querySelector('input')!.addEventListener('change', event => {
    const checked = event.currentTarget instanceof HTMLInputElement && event.currentTarget.checked;
    fields.replaceChildren(...(checked ? [
      h('p', {}, '架空の原票の、一つの動きを識別する番号を入力する。同じ原票でも複数の動きは番号を分ける。現場の発番方法は別途決める。この証拠を保存した台帳・バックアップは先行版では開けません。'),
      textField('alternativeSource', '元の資料の識別名・番号'),
      textField('alternativeEntry', '元の資料の動きの番号'),
      textField('alternativeActor', '原票記入者（入力担当とは別）'),
    ] : []));
  });
  return [selected, fields];
}

export function alternativeSourceOf(v: Values): AlternativeSource | null {
  return v.checked('alternative') ? { source: v.text('alternativeSource'), entry: v.text('alternativeEntry'), originalActor: v.text('alternativeActor') } : null;
}
