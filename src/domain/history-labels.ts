import { deepFreeze, own, type ItemMaster, type Masters } from './masters.ts';

export type ItemLabel = Readonly<Pick<ItemMaster, 'name' | 'code'>>;
export type RecordedItemLabels = { readonly kind: 'recorded'; readonly items: Readonly<Record<string, ItemLabel>> };
export type EventItemLabels = RecordedItemLabels | { readonly kind: 'legacy-unavailable' };

export function captureItemLabels(masters: Masters, itemIds: readonly string[]): RecordedItemLabels {
  const items = Object.fromEntries([...new Set(itemIds)].map(id => {
    const item = own(masters.items, id);
    if (!item) throw new Error(`履歴の品目 ${id} が登録情報にない`);
    if (!item.name.trim() || (item.code !== null && !item.code.trim())) throw new Error(`履歴の品目 ${id} の名称・コードは空白だけにしない`);
    return [id, { name: item.name, code: item.code }];
  }));
  return deepFreeze({ kind: 'recorded', items });
}
