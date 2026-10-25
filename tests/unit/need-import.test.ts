import { describe, expect, test } from 'vitest';
import { practiceLedger, type Meta } from '../../src/domain/ledger.ts';
import { fixedMasters, type Masters } from '../../src/domain/masters.ts';
import { emptySupply, registerNeed, reviseNeed, type Supply } from '../../src/domain/supply.ts';
import { applyNeedImport, openNeedImports, previewNeedImport, previewNeedImportResolution, readNeedRow, resolveNeedImport, type NeedRow } from '../../src/domain/need-import.ts';
import { shortageOf } from '../../src/domain/shortage.ts';

const at = '2026-10-14T09:00:00+09:00';
const meta = (eventId: string): Meta => ({ eventId, actor: '架空担当A', occurredAt: at, recordedAt: at });
const row: NeedRow = { format: 'fuzzy-stock-need-row', version: 1, source: '架空部品表001', line: '007', revision: '初版', previousRevision: null, caseCode: 'A-001', itemCode: 'P', unit: '個', required: { basis: 'counted', value: 100 }, dueDate: '2026-10-20' };
const rawOf = (change: Partial<NeedRow> = {}): string => JSON.stringify({ ...row, ...change });
const apply = (supply = emptySupply, id = 'import1', raw = rawOf(), masters = fixedMasters): Supply =>
  applyNeedImport(supply, masters, meta(id), raw, previewNeedImport(supply, masters, raw).token);
const revised = (): string => rawOf({ revision: '改訂2', previousRevision: '初版', required: { basis: 'label', value: 80 } });
const manual = (): Supply => registerNeed(emptySupply, fixedMasters, meta('manual'), { project: { kind: 'case', id: 'A-001' }, item: 'P', unit: '個', required: row.required, dueDate: row.dueDate, source: '手入力', revision: '初版' });

describe('架空文書の読取と差分判定', () => {
  test('1.1〜1.4: 原文の先頭ゼロ・記号と不明を保持し、確認だけでは状態を変えない', () => {
    const raw = ` \r\n${rawOf({ source: '=SUM(A1:A2)', required: { basis: 'unknown', value: null } })}\r\n`;
    const p = previewNeedImport(emptySupply, fixedMasters, raw);
    expect(p.input).toEqual({ raw, row: { ...row, source: '=SUM(A1:A2)', required: { basis: 'unknown', value: null } } });
    expect(p.decision.kind).toBe('create');
    expect(emptySupply.needs).toEqual({});
    expect(readNeedRow(raw).line).toBe('007');
  });

  test.each([
    { version: 2 }, { format: 'real-csv' }, { extra: 1 }, { line: 7 }, { dueDate: '2026-02-30' },
    { required: { basis: 'unknown', value: 0 } }, { required: { basis: 'counted', value: null } },
    { required: { basis: 'counted', value: -1 } }, { required: { basis: 'counted', value: 1.5 } },
    { required: { basis: 'counted', value: Number.MAX_SAFE_INTEGER + 1 } }, { source: 'x'.repeat(513) },
  ])('1.3: 不正な文書%jは保留へも反映しない', change => {
    expect(() => apply(emptySupply, 'bad', JSON.stringify({ ...row, ...change }))).toThrow();
    expect(emptySupply.log).toHaveLength(0);
  });

  test('1.3: 大きな原文・壊れたJSON・欠けた属性を拒否する', () => {
    expect(() => readNeedRow(' '.repeat(65537) + rawOf())).toThrow('上限');
    expect(() => readNeedRow('{')).toThrow();
    expect(() => readNeedRow('{}')).toThrow();
  });

  test.each([{ source: null }, { line: null }, { revision: null }, { source: ' ' }, { caseCode: null }, { itemCode: 'unknown' }, { unit: '本' }])('3.1: 識別/対応不足%jは必要な数を変えず保留する', change => {
    const s = apply(emptySupply, 'held', rawOf(change));
    expect(s.needs).toEqual({});
    expect(openNeedImports(s)).toHaveLength(1);
    expect(s.log[0]).toMatchObject({ kind: 'needImport', decision: { kind: 'hold' } });
  });

  test('3.1: 利用停止登録情報は自動適用しない', () => {
    const masters: Masters = { ...fixedMasters, items: { ...fixedMasters.items, P: { ...fixedMasters.items['P']!, active: false } } };
    expect(previewNeedImport(emptySupply, masters, rawOf()).decision.kind).toBe('hold');
  });

  test('2.1〜2.3・4.1〜4.4: 同じ明細100→80を改訂し、他明細・依頼・受け取りを変えず不足だけ再評価する', () => {
    const initial = apply();
    const before = apply(initial, 'other', rawOf({ line: '008', itemCode: 'Q' }));
    const p = previewNeedImport(before, fixedMasters, revised());
    expect(p.decision).toMatchObject({ kind: 'revise', before: { id: 'import1', required: { value: 100 } }, after: { required: { value: 80 } } });
    const after = apply(before, 'revision', revised());
    expect(Object.keys(after.needs)).toEqual(['import1', 'other']);
    expect(after.needs['import1']?.required).toEqual({ basis: 'label', value: 80 });
    expect(after.needs['other']).toBe(before.needs['other']);
    expect(after.requests).toBe(before.requests);
    expect(after.receipts).toBe(before.receipts);
    const group = { project: { kind: 'case', id: 'A-001' }, item: 'P', unit: '個' } as const;
    expect(shortageOf(practiceLedger, before, group).shortage).toBe(100);
    expect(shortageOf(practiceLedger, after, group).shortage).toBe(80);
    expect(after.log.at(-1)).toMatchObject({ decision: { before: { required: { value: 100 } }, after: { required: { value: 80 } } } });
  });

  test('2.2: 同じ再取込は明細と現在値を増やさず、読取の履歴だけを残す', () => {
    const s = apply(), p = previewNeedImport(s, fixedMasters, rawOf());
    expect(p.decision.kind).toBe('unchanged');
    const again = apply(s, 'again');
    expect(again.needs).toBe(s.needs);
    expect(again.log).toHaveLength(2);
  });

  test.each([
    { revision: '初版', required: { basis: 'label', value: 80 } },
    { revision: '改訂2', previousRevision: 'another' },
    { itemCode: 'Q', revision: '改訂2', previousRevision: '初版' },
    { line: '別の明細' },
  ] satisfies Partial<NeedRow>[])('2.4: 内容/改訂/対応の衝突%jは保留', change => {
    const s = apply(), held = apply(s, 'held', rawOf(change));
    expect(held.needs).toBe(s.needs);
    expect(openNeedImports(held)).toHaveLength(1);
  });

  test('2.4: 過去の改訂を新しい改訂と推測せず保留する', () => {
    const s = apply(apply(), 'revision', revised());
    expect(previewNeedImport(s, fixedMasters, rawOf()).decision.kind).toBe('hold');
  });

  test('2.4: 手動変更を元へ戻しても、無確認で再取込しない', () => {
    const s = apply(), current = s.needs['import1']!;
    const edited = reviseNeed(s, fixedMasters, meta('edit'), current.id, { ...current, required: { basis: 'counted', value: 90 } });
    const reverted = reviseNeed(edited, fixedMasters, meta('revert'), current.id, current);
    expect(previewNeedImport(reverted, fixedMasters, revised()).decision.kind).toBe('hold');
  });

  test('3.5: 確認後の対象変更は拒否し、無関係な明細の変更は拒否しない', () => {
    const s = apply(), p = previewNeedImport(s, fixedMasters, revised()), current = s.needs['import1']!;
    const edited = reviseNeed(s, fixedMasters, meta('edit'), current.id, { ...current, required: { basis: 'counted', value: 90 } });
    expect(() => applyNeedImport(edited, fixedMasters, meta('stale'), revised(), p.token)).toThrow('確認');
    const other = apply(s, 'other', rawOf({ line: '008', itemCode: 'Q' }));
    expect(applyNeedImport(other, fixedMasters, meta('ok'), revised(), p.token).needs['import1']?.required.value).toBe(80);
  });
});

describe('保留の理由付き照合', () => {
  test('3.1〜3.3: 手入力明細との対応は保留し、前後値と理由を確認して同じIDへ適用する', () => {
    const s = apply(manual(), 'held');
    expect(s.needs['manual']?.source).toBe('手入力');
    const p = previewNeedImportResolution(s, fixedMasters, 'held', 'apply', 'manual');
    const after = resolveNeedImport(s, fixedMasters, meta('resolve'), 'held', 'apply', 'manual', '架空の明細を照合済み', p.token);
    expect(Object.keys(after.needs)).toEqual(['manual']);
    expect(after.needs['manual']?.source).toBe(row.source);
    expect(openNeedImports(after)).toHaveLength(0);
    expect(after.log.at(-1)).toMatchObject({ kind: 'needImportResolve', importEventId: 'held', reason: '架空の明細を照合済み' });
    expect(previewNeedImport(after, fixedMasters, revised()).decision.kind).toBe('revise');
  });

  test('3.4: 見送りは元候補を残し数量を変えず、二重解消できない', () => {
    const s = apply(manual(), 'held'), p = previewNeedImportResolution(s, fixedMasters, 'held', 'dismiss', '');
    const after = resolveNeedImport(s, fixedMasters, meta('resolve'), 'held', 'dismiss', '', '別資料のため見送り', p.token);
    expect(after.needs).toBe(s.needs);
    expect(after.log[1]).toEqual(s.log[1]);
    expect(openNeedImports(after)).toHaveLength(0);
    expect(() => resolveNeedImport(after, fixedMasters, meta('again'), 'held', 'dismiss', '', '見送り', p.token)).toThrow();
  });

  test('3.3〜3.5: 識別不足、別の組、理由空、古い確認、対応変更の強制適用を拒否', () => {
    const missing = apply(manual(), 'held', rawOf({ line: null }));
    expect(() => previewNeedImportResolution(missing, fixedMasters, 'held', 'apply', 'manual')).toThrow();
    const s = apply(manual(), 'held'), p = previewNeedImportResolution(s, fixedMasters, 'held', 'apply', 'manual');
    expect(() => resolveNeedImport(s, fixedMasters, meta('resolve'), 'held', 'apply', 'manual', ' ', p.token)).toThrow('理由');
    const current = s.needs['manual']!;
    const edited = reviseNeed(s, fixedMasters, meta('edit'), 'manual', { ...current, required: { basis: 'counted', value: 75 } });
    expect(() => resolveNeedImport(edited, fixedMasters, meta('resolve'), 'held', 'apply', 'manual', '確認済み', p.token)).toThrow('確認');
    const different = apply(apply(), 'held', rawOf({ line: 'different' }));
    expect(() => previewNeedImportResolution(different, fixedMasters, 'held', 'apply', 'import1')).toThrow('対応');
  });
});
