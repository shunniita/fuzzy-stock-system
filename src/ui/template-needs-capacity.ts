import { decodeDraft } from './conflictdraft.ts';
import { reviewUsage, type ConflictDraft } from './conflictrecord.ts';

export function requireTemplateNeedCaptureCapacity(draft: ConflictDraft, generation: string, eventId: string): void {
  decodeDraft(JSON.stringify({ format: 'fuzzy-stock-conflict-draft', version: 2, draft, generation }));
  const usage = reviewUsage([], { eventId, reviewId: draft.reviewId, draft,
    resolution: { outcome: 'reenter', reason: '最新記録から入力し直す', actor: draft.actor, at: draft.detectedAt } });
  if (usage.over) throw new Error(`この入力は競合時の照合記録上限（一件64KiB）を超えるため、案件数または入力を減らしてプレビューしてください（${usage.one}バイト）`);
}
