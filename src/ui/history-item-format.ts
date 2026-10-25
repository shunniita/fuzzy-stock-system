import type { EventItemLabels } from '../domain/history-labels.ts';
import { own } from '../domain/masters.ts';
import type { createHistoryTargetCollector } from '../domain/history-targets.ts';

export type ItemFormatter = (id: string) => string;
export type HistoryTargetCollector = ReturnType<typeof createHistoryTargetCollector>;

function historicalItem(labels: EventItemLabels, id: string): string {
  if (labels.kind === 'legacy-unavailable') return `${id}（当時の名称・コード不明）`;
  const label = own(labels.items, id);
  if (!label) throw new Error(`履歴の品目 ${id} の当時表示がない`);
  return `${label.code ?? '正式コード未登録'}「${label.name}」`;
}

// 本文で表示済みの対象を記録し、IDだけの操作にも未表示の品目を補う。
export function historyItems(labels: EventItemLabels, itemIds: readonly string[]) {
  const shown = new Set<string>();
  const ref: ItemFormatter = id => {
    shown.add(id);
    return historicalItem(labels, id);
  };
  return { ref, complete(text: string): string {
    const remaining = [...new Set(itemIds)].filter(id => !shown.has(id));
    return remaining.length ? `${text}／品目${remaining.map(ref).join('、')}` : text;
  } };
}
