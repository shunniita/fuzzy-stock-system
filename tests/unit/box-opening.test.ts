import { describe, expect, test } from 'vitest';
import { observe, quantityOf } from '../../src/domain/quantity.ts';
import { declareDiscrepancy, decreased, openBox, practiceLedger, register, start, use, voidRecord, type Ledger, type Meta } from '../../src/domain/ledger.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { initial, parse, serialize } from '../../src/ui/storage.ts';
import { eventText } from '../../src/ui/format.ts';
import { withProcesses } from './process-fixture.ts';

const meta = (eventId: string, hour = 12): Meta => ({ eventId, occurredAt: `2026-11-20T${String(hour).padStart(2, '0')}:00:00+09:00`, recordedAt: '2026-11-20T22:00:00+09:00', actor: '架空担当A' });
const common = { kind: 'common' } as const;
// 品目Sは箱（1000本入り）と本の包装を持つ。
const boxes = (basis: 'label' | 'counted' | 'approximate' | 'unknown' = 'label', value: number | null = 3): Ledger =>
  register(practiceLedger, meta('box', 9), { id: 'box', item: 'S', unit: '箱', project: common, location: 'S1' }, basis, value);
const opened = () => openBox(boxes(), meta('open', 10), { lotId: 'box', childId: 'loose', boxes: 1, counted: 998 });

describe('p2-box-opening・開封', () => {
  test('1.2・1.3: 1箱を開けて数えた998本を入れると、箱は2箱、中身は998本（数えた）の新しい保管単位', () => {
    const l = opened();
    expect(l.lots['box']?.quantity).toMatchObject({ numeric: { value: 2 } });
    expect(l.lots['loose']).toMatchObject({ item: 'S', unit: '本', project: common, location: 'S1', splitFrom: 'box', stage: { kind: 'none' }, lastCount: { eventId: 'open' } });
    expect(l.lots['loose']?.quantity).toMatchObject({ kind: 'known', numeric: { value: 998, approximate: false, unconfirmed: 'none' } });
    expect(l.history.at(-1)).toMatchObject({ kind: 'open', lotId: 'box', childId: 'loose', basis: 'counted', value: 1, childUnit: '本', childValue: 998 });
  });

  test('3.1: 開封は使用ではない。中身を使って取り消すと、中身は開封の数から引き直される', () => {
    let l = use(opened(), meta('use', 11), 'loose', 'counted', 1, '架空の作業');
    expect(l.lots['loose']?.quantity).toMatchObject({ numeric: { value: 997 } });
    expect(l.history.filter(e => e.kind === 'use')).toHaveLength(1);
    l = voidRecord(l, meta('void', 12), 'use', '間違い');
    expect(l.lots['loose']?.quantity).toMatchObject({ kind: 'known', numeric: { value: 998, unconfirmed: 'none' } });
  });

  test('1.4・2.1〜2.3: 根拠のない開封は拒否し、台帳を変えない', () => {
    const l = boxes(), before = JSON.stringify(l);
    const run = (ledger: Ledger, request: Partial<Parameters<typeof openBox>[2]>) => () => openBox(ledger, meta('open', 10), { lotId: 'box', childId: 'loose', boxes: 1, counted: 998, ...request });
    expect(run(l, { counted: -1 })).toThrow();
    expect(run(l, { counted: Number.NaN })).toThrow();
    expect(run(l, { boxes: 0 })).toThrow();
    expect(run(l, { boxes: 1.5 })).toThrow();
    expect(run(l, { boxes: 4 })).toThrow();
    expect(run(l, { childId: 'box' })).toThrow(/ID/);
    expect(run(boxes('unknown', null), {})).toThrow(/数量/);
    expect(run(boxes('approximate', 3), {})).toThrow(/だいたい/);
    expect(run(declareDiscrepancy(l, meta('issue', 9), 'box', '数量差'), {})).toThrow(/確認事項/);
    const pieces = register(practiceLedger, meta('p', 9), { id: 'box', item: 'S', unit: '本', project: common, location: 'S1' }, 'counted', 5);
    expect(run(pieces, {})).toThrow(/包装の単位/);
    const plain = register(practiceLedger, meta('p', 9), { id: 'box', item: 'P', unit: '個', project: common, location: 'S1' }, 'counted', 5);
    expect(run(plain, {})).toThrow(/包装/);
    const working = start(withProcesses(practiceLedger, { id: '架空組立', criterion: 'workEnd' }), meta('w', 9), { id: 'box', item: 'S', unit: '箱', project: common, location: 'T' }, { id: '架空組立', criterion: 'workEnd' }, 'counted', 2, []);
    expect(run(working, {})).toThrow(/作業なし/);
    expect(JSON.stringify(l)).toBe(before);
  });

  test('0本を数えた（空だった）開封も記録できる', () => {
    expect(openBox(boxes(), meta('open', 10), { lotId: 'box', childId: 'loose', boxes: 1, counted: 0 }).lots['loose']?.quantity).toMatchObject({ numeric: { value: 0 } });
  });

  test('3.2・3.3: 開封を含む写しを保存して読み込み直せ、履歴に箱の数と中身の数を出す', () => {
    const s = initial(opened(), emptySupply);
    expect(parse(serialize(s)).ledger).toEqual(s.ledger);
    const e = s.ledger.history.find(x => x.kind === 'open')!;
    expect(eventText(s.ledger, e)).toContain('boxから1箱を開けてlooseへ998本（数えた）');
  });

  test('3.3: 開封の記録と保管単位の前後が食い違う写しは、読み込みで拒否する', () => {
    const s = initial(opened(), emptySupply);
    type Change = (typeof s.ledger.history)[number]['changes'][number];
    const forge = (edit: (change: Change, e: Extract<(typeof s.ledger.history)[number], { kind: 'open' }>) => Change, patch: object = {}) => serialize({ ...s, ledger: { ...s.ledger, history: s.ledger.history.map(e => e.kind === 'open' ? { ...e, ...patch, changes: e.changes.map(c => edit(c, e)) } : e) } });
    const child = s.ledger.lots['loose']!;
    // 子の単位を箱のままにする
    expect(() => parse(forge(c => c.after.id === 'loose' ? { ...c, after: { ...c.after, unit: '箱' } } : c))).toThrow(/開封/);
    // 記録の中身の数と子の数量が違う
    expect(() => parse(forge(c => c, { childValue: 5 }))).toThrow(/開封/);
    // 親を減らしていない
    expect(() => parse(forge(c => c.after.id === 'box' && c.before !== null ? { ...c, after: c.before } : c))).toThrow(/開封/);
    // 子の場所が親と違う
    expect(() => parse(forge(c => c.after.id === 'loose' ? { ...c, after: { ...child, location: 'S2' } } : c))).toThrow(/開封/);
    // 親子の対応がない
    expect(() => parse(forge(c => c, { childId: 'other' }))).toThrow(/開封/);
  });

  test('1.4・3.3: だいたいの箱数から開封した写しは、読み込みで拒否する', () => {
    const l = opened(), approx = boxes('approximate', 3), before = approx.lots['box']!;
    const after = decreased(approx, before, quantityOf(observe('open', 'counted', 1)))!;
    const ledger: Ledger = { ...l, lots: { ...l.lots, box: after }, history: [...approx.history, ...l.history.slice(approx.history.length).map(e => e.kind === 'open' ? { ...e, changes: e.changes.map(c => c.after.id === 'box' ? { before, after } : c) } : e)] };
    expect(() => parse(serialize(initial(ledger, emptySupply)))).toThrow(/開封/);
  });
});
