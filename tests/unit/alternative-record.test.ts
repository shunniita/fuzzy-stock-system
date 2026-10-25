import { describe, expect, test } from 'vitest';
import { beginAlternativeRecord, correctOccurredAt, practiceLedger, move, recount, register, resolveIssue, use, voidRecord, type Meta } from '../../src/domain/ledger.ts';
import { eventText } from '../../src/ui/format.ts';
import { targetsOf } from '../../src/ui/storage.ts';
import { emptySupply } from '../../src/domain/supply.ts';

const meta = (eventId: string, hour = 11): Meta => ({ eventId, actor: '架空担当A', occurredAt: `2026-09-29T${String(hour).padStart(2, '0')}:00:00+09:00`, recordedAt: '2026-10-14T04:20:00+09:00' });
const source = () => ({ source: '架空原票A', entry: '001a', originalActor: '架空の原票記入者B' });
const base = () => register(practiceLedger, meta('r', 10), { id: 'p', item: 'P', unit: '個', location: 'S1', project: { kind: 'case', id: 'A-001' } }, 'counted', 52);
const used = () => use(beginAlternativeRecord(base(), meta('u'), 'use', source(), ['P']), meta('u'), 'p', 'counted', 8, '架空作業');

describe('代替記録1〜3: 元の資料の識別と数量を分離する', () => {
  test('証拠追加は数量を変えず、原票記入者・入力担当・対応操作を原文で保持する', () => {
    const before = base(), input = source();
    const staged = beginAlternativeRecord(before, meta('u'), 'use', input, ['P']);
    input.entry = '呼出元の変更';
    expect(staged.lots).toEqual(before.lots); expect(staged.issues).toEqual(before.issues); expect(staged.stops).toEqual(before.stops);
    expect(staged.masters).toEqual(before.masters);
    const ledger = use(staged, meta('u'), 'p', 'counted', 8, '架空作業');
    expect(ledger.lots['p']?.quantity).toMatchObject({ numeric: { value: 44 }, computed: true });
    expect(ledger.lots['p']?.lastCount).toEqual({ value: 52, eventId: 'r' });
    const evidence = ledger.history[1]!;
    expect(evidence).toMatchObject({ ...meta('u-alternative'), kind: 'alternativeRecord', operation: 'use', operationId: 'u', source: source(), changes: [] });
    const text = eventText(ledger, evidence);
    for (const value of Object.values(source())) expect(text).toContain(value);
    expect(text).toContain('操作u'); expect(text).toContain('全処理の完了ではない');
    expect(targetsOf({ ledger: before, supply: emptySupply }, { ledger, supply: emptySupply })).toContain('元票「架空原票A」・動き「001a」');
  });

  test.each(['use', 'move', 'start', 'receive'] as const)('同じ元の資料を新IDの%sとして再入力しても無変更で拒否', operation => {
    const ledger = used(), before = JSON.stringify(ledger);
    expect(() => beginAlternativeRecord(ledger, meta('again'), operation, source(), ['P'])).toThrow(/記録済み.*u/);
    expect(JSON.stringify(ledger)).toBe(before);
  });

  test.each([
    { source: '' }, { source: ' A' }, { source: 'A ' }, { entry: '\t' }, { entry: '001a\n' }, { originalActor: ' \r\n ' },
  ])('不正な識別%sを拒否し元の状態を保つ', patch => {
    const ledger = base(), before = JSON.stringify(ledger);
    expect(() => beginAlternativeRecord(ledger, meta('bad'), 'use', { ...source(), ...patch }, ['P'])).toThrow();
    expect(JSON.stringify(ledger)).toBe(before);
  });

  test('先頭0・大小文字・区切り文字が異なる別元の資料は同じ数量でも別の動きとして通す', () => {
    let ledger = base();
    for (const [i, pair] of [['A', '001a'], ['A', '1a'], ['A', '001A'], ['A:B', 'C'], ['A', 'B:C']].entries()) {
      const m = meta(`u${i}`);
      ledger = use(beginAlternativeRecord(ledger, m, 'use', { source: pair[0]!, entry: pair[1]!, originalActor: '架空B' }, ['P']), m, 'p', 'counted', 1, '別の動き');
    }
    expect(ledger.lots['p']?.quantity).toMatchObject({ numeric: { value: 47 } });
    expect(ledger.history.filter(e => e.kind === 'alternativeRecord')).toHaveLength(5);
  });

  test.each(['included', 'unknown'] as const)('AT-22: 包含%sでも52を再減算せず、元の資料を記録済みにする', inclusion => {
    const m = meta('late', 9);
    const ledger = use(beginAlternativeRecord(base(), m, 'use', source(), ['P']), m, 'p', 'counted', 8, '棚卸前の使用', inclusion);
    expect(ledger.lots['p']?.quantity).toMatchObject({ numeric: { value: 52 } });
    expect(ledger.history.at(-1)).toMatchObject({ kind: 'use', applied: false, inclusion });
    expect(ledger.issues['late']?.resolution === null).toBe(inclusion === 'unknown');
    expect(() => beginAlternativeRecord(ledger, meta('again'), 'use', source(), ['P'])).toThrow('記録済み');
  });

  test('取消・日時訂正・照合後も元の資料を解放せず、証拠自体の日時訂正を拒否する', () => {
    let ledger = correctOccurredAt(used(), meta('time', 12), 'u', '2026-09-29T11:30:00+09:00');
    ledger = voidRecord(ledger, meta('void', 12), 'u', '記録誤り');
    expect(() => beginAlternativeRecord(ledger, meta('again'), 'move', source(), ['P'])).toThrow('記録済み');
    expect(() => correctOccurredAt(ledger, meta('bad', 12), 'u-alternative', null)).toThrow(/対応する操作.*u/);
    const m = meta('late', 9);
    let held = use(beginAlternativeRecord(base(), m, 'use', source(), ['P']), m, 'p', 'counted', 8, '棚卸前', 'unknown');
    held = resolveIssue(held, meta('close', 12), 'late', 'close', 'included');
    held = recount(held, meta('count', 13), 'p', 52, { kind: 'unknown' });
    expect(() => beginAlternativeRecord(held, meta('again'), 'use', source(), ['P'])).toThrow('記録済み');
  });

  test('使った操作IDを元の資料に付け直せず、物理操作失敗でも呼出元は変わらない', () => {
    const ledger = used(), before = JSON.stringify(ledger);
    expect(() => beginAlternativeRecord(ledger, meta('u'), 'move', { ...source(), entry: '002' }, ['P'])).toThrow('操作ID');
    expect(() => move(beginAlternativeRecord(ledger, meta('bad'), 'move', { ...source(), entry: '002' }, ['P']), meta('bad'), 'p', 'OUT')).toThrow();
    expect(JSON.stringify(ledger)).toBe(before);
  });
});
