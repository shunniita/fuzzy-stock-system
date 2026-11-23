import { describe, expect, test } from 'vitest';
import { practiceLedger, start, type Meta } from '../../src/domain/ledger.ts';
import { ConfirmationRequired } from '../../src/domain/ledger.ts';
import type { ItemMaster } from '../../src/domain/masters.ts';
import { saveReceiptTemplate } from '../../src/domain/receipt-template.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { generateTemplateNeeds } from '../../src/domain/template-needs.ts';
import { withProgressConfirmation, type State, type UiOp } from '../../src/ui/supply-ui.ts';
import type { Values } from '../../src/ui/dom.ts';

const at = '2026-10-30T09:00:00+09:00';
const meta = (eventId: string): Meta => ({ eventId, actor: '架空担当A', occurredAt: at, recordedAt: at });
const item = (id: string): ItemMaster => ({ ...practiceLedger.masters.items['P']!, id, code: null, name: `架空${id}`, units: ['個', '台'], unitSteps: { 個: 1, 台: 1 } });
const masters = { ...practiceLedger.masters, items: { ...practiceLedger.masters.items, P: item('P'), R: item('R') } };
const template = { id: 'kit', name: '架空製品R', product: 'R', productUnit: '台', project: null, basis: 'label', rows: [{ item: 'P', unit: '個', perSet: 2, location: 'S1' }] } as const;
const ledger = { ...practiceLedger, masters };
const base: State = generateTemplateNeeds({ ledger, supply: saveReceiptTemplate(ledger, emptySupply, meta('save'), template) }, meta('gen'), { templateId: 'kit', caseCode: 'C1', count: 10, dueDate: null });

const startOp = (value: number, caseId = 'C1'): UiOp => ({
  label: '開始', fields: () => [],
  run: (s, m) => ({
    state: { ...s, ledger: start(s.ledger, m, { id: `W${s.ledger.history.length}`, item: 'R', unit: '台', project: { kind: 'case', id: caseId }, location: 'S1' }, { id: 'R組立', criterion: 'inspection' }, 'counted', value, []) },
    notice: '記録した',
  }),
});
const values = (confirmed: boolean): Values => ({ text: () => '', checked: name => name === 'confirmed' && confirmed });

describe('withProgressConfirmation', () => {
  test('超えるのに確認がなければ、超える台数を示して止める', () => {
    const run = () => withProgressConfirmation(startOp(12)).run(base, meta('s1'), values(false), undefined);
    expect(run).toThrow(ConfirmationRequired);
    expect(run).toThrow(/C1.*総予定数を2台超える/);
    expect(base.ledger.history.some(e => e.kind === 'start')).toBe(false);
  });

  test('製品の単位が台以外なら、超える数をその単位で示す', () => {
    const pieces = generateTemplateNeeds({ ledger, supply: saveReceiptTemplate(ledger, emptySupply, meta('save'), { ...template, productUnit: '個' }) }, meta('gen'), { templateId: 'kit', caseCode: 'C1', count: 10, dueDate: null });
    const op: UiOp = { label: '開始', fields: () => [], run: (s, m) => ({ state: { ...s, ledger: start(s.ledger, m, { id: 'W1', item: 'R', unit: '個', project: { kind: 'case', id: 'C1' }, location: 'S1' }, { id: 'R組立', criterion: 'inspection' }, 'counted', 12, []) } }) };
    expect(() => withProgressConfirmation(op).run(pieces, meta('s1'), values(false), undefined)).toThrow(/総予定数を2個超える/);
  });

  test('確認済みなら、包む前と同じ結果になる', () => {
    const args = [base, meta('s1'), values(true), undefined] as const;
    expect(withProgressConfirmation(startOp(12)).run(...args)).toEqual(startOp(12).run(...args));
  });

  test('超えない・関係ない案件の記録は、確認なしでも包む前と同じ結果になる', () => {
    const args = [base, meta('s1'), values(false), undefined] as const;
    expect(withProgressConfirmation(startOp(10)).run(...args)).toEqual(startOp(10).run(...args));
    expect(withProgressConfirmation(startOp(99, 'A-001')).run(...args)).toEqual(startOp(99, 'A-001').run(...args));
  });

  test('ラベル・対象・欄は元の操作のまま', () => {
    const op = startOp(1);
    const wrapped = withProgressConfirmation(op);
    expect(wrapped).toMatchObject({ label: op.label, fields: op.fields });
  });
});
