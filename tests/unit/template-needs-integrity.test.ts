import { expect, test } from 'vitest';
import { practiceLedger, type Meta } from '../../src/domain/ledger.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { saveReceiptTemplate } from '../../src/domain/receipt-template.ts';
import { buildTemplateNeedFollow, editTemplateNeeds, followTemplateNeeds, generateTemplateNeeds, recalculateTemplateNeeds } from '../../src/domain/template-needs.ts';
import { initial, load, parse, serialize, serializePending, type Pending, type StoreLike } from '../../src/ui/storage.ts';
import { decodePending } from '../../src/ui/storageparse.ts';
import { parseExactJson } from '../../src/domain/exact-json.ts';
import { backupTextOf, crc32, readBackup } from '../../src/ui/backup.ts';

const meta = (eventId: string): Meta => ({ eventId, actor: '架空担当A', occurredAt: '2026-10-30T09:00:00+09:00', recordedAt: '2026-10-30T09:00:00+09:00' });
const bytes = (text: string) => new TextEncoder().encode(text);

function sequence() {
  const template = { id: 'kit', name: '架空連続変更セット', product: 'R', basis: 'label', rows: [{ item: 'P', unit: '個', perSet: 2, location: 'S1' }] } as const;
  let state = generateTemplateNeeds({ ledger: practiceLedger, supply: saveReceiptTemplate(practiceLedger, emptySupply, meta('save'), template) }, meta('gen'), { templateId: 'kit', caseCode: '000007', count: 10, dueDate: null });
  state = editTemplateNeeds(state, meta('manual'), '000007', { kind: 'change', needId: 'gen-n1', required: { basis: 'counted', value: 19 } }, '架空の個別変更');
  state = editTemplateNeeds(state, meta('custom'), '000007', { kind: 'add', item: 'Q', unit: '個', required: { basis: 'counted', value: 9 }, dueDate: null }, '架空の独自追加');
  state = recalculateTemplateNeeds(state, meta('count15'), '000007', 15, [], '架空の減産');
  state = { ...state, supply: saveReceiptTemplate(state.ledger, state.supply, meta('revise'), { ...template, rows: [{ item: 'P', unit: '個', perSet: 3, location: 'S1' }, { item: 'Q', unit: '個', perSet: 3, location: 'S1' }] }) };
  const unselected = followTemplateNeeds(state, meta('follow'), '000007', []);
  state = followTemplateNeeds(unselected, meta('pick'), '000007', ['custom-n1']);
  state = recalculateTemplateNeeds(state, meta('count20'), '000007', 20, ['gen-n1'], '架空の増産');
  return { state, unselected };
}

type State = ReturnType<typeof sequence>['state'];
const pendingOf = (state: State): Pending => ({ progress: 'saving', unknownSince: null, savingSince: meta('pending').recordedAt, baseRevision: 0, opId: state.supply.log.at(-1)!.eventId, opLabel: '架空の連続変更', fingerprint: '架空入力', values: {}, actor: meta('pending').actor, startedAt: meta('pending').recordedAt, units: [{ ...state, conflictReviews: [], targets: [] }] });
const wireOf = (state: State) => JSON.parse(serialize(initial(state.ledger, state.supply)));
const pendingWire = (wire: ReturnType<typeof wireOf>) => ({ format: 'fuzzy-stock-pending', version: 13, quantities: wire.quantities, pending: { ...pendingOf(wire), units: [{ ledger: wire.ledger, supply: wire.supply, conflictReviews: [], targets: [] }] } });
const backupWire = (raw: string) => {
  const createdAt = meta('backup').recordedAt;
  return bytes(JSON.stringify({ format: 'fuzzy-stock-backup', version: 1, notice: '架空試験', createdAt, crc32: crc32(bytes(`${createdAt}\n${raw}`)).toString(16).padStart(8, '0'), snapshot: raw }));
};

function rejectedWithoutWrites(state: State, wire: ReturnType<typeof wireOf>) {
  const raw = JSON.stringify(wire), pending = JSON.stringify(pendingWire(wire)), original = serialize(initial(state.ledger, state.supply));
  expect(() => parse(raw)).toThrow();
  expect(() => decodePending(parseExactJson(pending))).toThrow();
  expect(readBackup(backupWire(raw)).kind).toBe('unreadable');
  for (const entry of ['snapshot', 'pending']) {
    const data = new Map([['fuzzy-stock/head', 'A'], ['fuzzy-stock/slot-A', entry === 'snapshot' ? raw : original]]);
    if (entry === 'pending') data.set('fuzzy-stock/pending', pending);
    const before = [...data], writes: string[] = [];
    const store: StoreLike = { getItem: key => data.get(key) ?? null, setItem: key => { writes.push(key); }, removeItem: key => { writes.push(key); } };
    expect(load(store).kind).toBe('unreadable');
    expect(writes).toEqual([]); expect([...data]).toEqual(before);
  }
  expect(JSON.stringify(wire)).toBe(raw);
  expect(serialize(initial(state.ledger, state.supply))).toBe(original);
}

test('4.4 FT-17: 連続した個別変更・再計算・追従・同版選択を全読込入口で保ち、加算や二重適用をしない', () => {
  const { state, unselected } = sequence(), snapshot = initial(state.ledger, state.supply);
  expect(unselected.supply.needs['gen-n1']?.required.value).toBe(19);
  expect(unselected.supply.needs['custom-n1']?.required.value).toBe(9);
  expect(Object.values(state.supply.needs).map(need => need.required.value)).toEqual([60, 60]);
  expect(state.supply.templateNeeds['000007']).toMatchObject({ initialVersion: 'gen-v1', version: 'follow-v1', count: 20 });
  expect(state.supply.log.filter(event => event.kind === 'templateNeeds').map(event => event.action)).toEqual(['generate', 'edit', 'edit', 'recalculate', 'follow', 'follow', 'recalculate']);
  expect(parse(serialize(snapshot))).toEqual(snapshot);
  expect(decodePending(parseExactJson(serializePending(pendingOf(state))))).toEqual(pendingOf(state));
  expect(readBackup(bytes(backupTextOf(snapshot, meta('backup').recordedAt)))).toMatchObject({ kind: 'ok', snapshot });
  expect(() => followTemplateNeeds(state, meta('again'), '000007', [])).toThrow('適用済み');
});

test.each(['現在明細余分', '現在明細欠落', 'イベント重複', '旧入口後付け'])('4.4 連続変更後の%sを拒否し、通常保存・pendingと原文を変えない', corruption => {
  const { state } = sequence(), wire = wireOf(state);
  if (corruption === '現在明細余分') wire.supply.needs.extra = { ...wire.supply.needs['gen-n1'], id: 'extra' };
  if (corruption === '現在明細欠落') delete wire.supply.needs['gen-n1'];
  if (corruption === 'イベント重複') wire.supply.log.push(wire.supply.log.at(-1));
  if (corruption === '旧入口後付け') {
    const before = wire.supply.needs['gen-n1'], after = { ...before, required: { basis: 'label', value: 61 } };
    wire.supply.needs[before.id] = after;
    wire.supply.log.push({ ...meta('old-entry'), kind: 'needRevise', before, after, itemLabels: { kind: 'legacy-unavailable' } });
  }
  rejectedWithoutWrites(state, wire);
});

test('4.4 効果なし同版custom追従の偽イベントを、正当なpreviewの形でも読込で拒否する', () => {
  const { unselected: state } = sequence(), preview = buildTemplateNeedFollow(state, meta('noop'), '000007', []);
  expect(preview.applicable).toBe(false);
  const wire = wireOf(state);
  wire.supply.log.push({ ...preview.event, itemLabels: state.supply.log.at(-1)!.itemLabels });
  rejectedWithoutWrites(state, wire);
});
