import { describe, expect, it } from 'vitest';
import { readCode } from '../../src/domain/code.ts';
import { practiceLedger } from '../../src/domain/ledger.ts';
import { fixedMasters, type Masters } from '../../src/domain/masters.ts';
import { emptySupply, receiveLot } from '../../src/domain/supply.ts';

const masters: Masters = {
  ...fixedMasters,
  items: {
    ...fixedMasters.items,
    item007: { type: 'item', id: 'item007', code: '007', name: '架空007', source: null, units: ['個'], unitSteps: { '個': 1 }, trial: true, active: true, packaging: null, consumable: null },
    item7: { type: 'item', id: 'item7', code: '7', name: '架空7', source: null, units: ['個'], unitSteps: { '個': 1 }, trial: true, active: false, packaging: null, consumable: null },
  },
};

describe('AT-30/46 架空コードの解釈', () => {
  it.each(['LABA|A-001|007', '007~A-001~LABB'])('ラベル %s をID文字列のまま対応付ける', raw => {
    const scan = readCode(raw, masters);
    expect(scan.interpreted).toMatchObject({ kind: 'label', item: { kind: 'found', code: '007', id: 'item007', name: '架空007', active: true }, project: { kind: 'found', code: 'A-001' } });
    expect(scan.raw).toBe(raw);
  });
  it('両端だけ照合用に除き原文とCR/LFを失わない', () => {
    const raw = ' \tLABA|A-001|007\t\r\n';
    expect(readCode(raw, masters)).toMatchObject({ raw, format: 'labelA', interpreted: { matching: 'LABA|A-001|007', leading: ' \t', trailing: '\t\r\n' } });
  });
  it('手入力の007と7、大文字と小文字、記号を区別する', () => {
    expect(readCode('007', masters).interpreted).toMatchObject({ kind: 'item', item: { id: 'item007', active: true } });
    expect(readCode('7', masters).interpreted).toMatchObject({ kind: 'item', item: { id: 'item7', active: false } });
    expect(readCode('P_Q-02', masters).interpreted).toMatchObject({ kind: 'item', item: { kind: 'missing', code: 'P_Q-02' } });
    expect(readCode('p', masters).interpreted).toMatchObject({ item: { kind: 'missing', code: 'p' } });
  });
  it('帳票は現物の対象や数量へ解決しない', () => {
    expect(readCode('DOC:SRC_01:R_00:LINE-007', masters)).toEqual({ raw: 'DOC:SRC_01:R_00:LINE-007', format: 'document', interpreted: { kind: 'document', matching: 'DOC:SRC_01:R_00:LINE-007', leading: '', trailing: '', source: 'SRC_01', revision: 'R_00', line: 'LINE-007' } });
  });
  it.each(['', ' \t\r\n', 'LABA||007', 'LABA|A-001|007|9', 'LABA|A 001|007', '007~A-001~BAD', '<script>alert(1)</script>', '=SUM(A1)', '\u3000007', 'DOC:S:R:'])('不能でも原文 %j を残す', raw => {
    const scan = readCode(raw, masters);
    expect(scan.raw).toBe(raw);
    expect(scan.format).toBe('unreadable');
    expect(scan.interpreted).toHaveProperty('reason');
  });
  it('登録情報変更後も当時の解決を保持し登録情報自身を凍結しない', () => {
    const item = { type: 'item', id: 'mutable', code: '007', name: '変更前', source: null, units: ['個'], unitSteps: { '個': 1 }, trial: true, active: true, packaging: null, consumable: null } satisfies Masters['items'][string];
    const scan = readCode('007', { ...masters, items: { mutable: item } });
    item.name = '変更後'; item.code = '008';
    expect(scan.interpreted).toMatchObject({ item: { code: '007', name: '変更前' } });
    expect(Object.isFrozen(scan.interpreted)).toBe(true);
  });
  it('同じ受け取りの台帳/供給に証拠を付け既存labelへ原文を保つ', () => {
    const scan = readCode('LABA|A-001|P', fixedMasters);
    const meta = { eventId: 'scan-receive', occurredAt: '2026-10-13T09:00:00+09:00', recordedAt: '2026-10-13T09:00:00+09:00', actor: '架空担当A', scan };
    const result = receiveLot(practiceLedger, emptySupply, meta, { id: 'box', item: 'P', unit: '個', project: { kind: 'case', id: 'A-001' }, location: 'S1' }, 'label', 5);
    expect(result.ledger.history[0]?.scan).toEqual(scan);
    expect(result.supply.log[0]?.scan).toEqual(scan);
    expect(result.supply.receipts.box?.label).toBe(scan.raw);
    expect(() => receiveLot(practiceLedger, emptySupply, meta, { id: 'box', item: 'P', unit: '個', project: { kind: 'case', id: 'A-001' }, location: 'S1' }, 'label', 5, '別原文')).toThrow('手入力ラベル');
    const matching = receiveLot(practiceLedger, emptySupply, meta, { id: 'box', item: 'P', unit: '個', project: { kind: 'case', id: 'A-001' }, location: 'S1' }, 'label', 5, scan.raw);
    expect(matching.supply.receipts.box?.label).toBe(scan.raw);
  });
});
