import { deepFreeze, recordStop, recount, type Meta } from '../../src/domain/ledger.ts';
import { allocateArrival, receiveLot } from '../../src/domain/supply.ts';
import { seedScn02 } from '../../src/ui/seed.ts';
import type { Snapshot } from '../../src/ui/storage.ts';

export const at = '2026-10-05T10:00:00+09:00';
export const later = '2026-10-05T11:00:00+09:00';
export const meta = (eventId: string): Meta => ({ eventId, occurredAt: at, recordedAt: at, actor: '架空担当A' });

// 操作の索引・保存結果の解消・次の操作IDの下限（30）を持つ、版4の架空の写し。
export function snapshot(): Snapshot {
  let { ledger, supply } = seedScn02();
  ledger = recount(ledger, meta('count'), 'P-B01', 98, { kind: 'unknown' });
  ledger = recordStop(ledger, meta('stop'), { process: 'R組立', item: 'R', unit: '台', project: { kind: 'case', id: 'B-001' }, reason: '部品不足', shortage: { item: 'P', unit: '個', value: 2 }, affected: null });
  ({ ledger, supply } = receiveLot(ledger, supply, meta('received'), { id: '交換品', item: 'S', unit: '箱', project: { kind: 'common' }, location: 'S1' }, 'label', 1, '0012-AB'));
  supply = allocateArrival(ledger, supply, meta('arrival'), 'sc-q1', { receiptLotId: '交換品', arrived: 1, good: 1 });
  return deepFreeze({ format: 'fuzzy-stock-f0', version: 10, conflictReviews: [], revision: 4, lastWriter: 'op9', opFloor: 30, ledger, supply,
    ops: { op9: { fingerprint: '入力', units: [['received'], ['arrival']] } },
    saveChecks: [{ opId: 'op8', opLabel: '受入', savedTargets: ['まとまり0012'], unsavedTargets: ['依頼op7'], attempt: '登録操作', openedAt: at, resolution: { outcome: 'remainderAbandoned', actor: '架空担当B', at: later } }],
  });
}
