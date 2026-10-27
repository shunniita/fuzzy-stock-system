import type { EventItemLabels } from '../../src/domain/history-labels.ts';

// 改良前からある手作りの履歴本文fixtureは、当時表示の証拠を持たない。
export const legacyEventLabels = { itemLabels: { kind: 'legacy-unavailable' } } satisfies { itemLabels: EventItemLabels };

export function legacyJson(value: unknown): string {
  return JSON.stringify(value, (key, entry: unknown) => key === 'consumable' || key === 'processes' || key === 'nextProcess' || key === 'itemLabels' ? undefined : entry);
}
