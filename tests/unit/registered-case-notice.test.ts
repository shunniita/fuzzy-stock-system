import { describe, expect, test } from 'vitest';
import { practiceLedger, start, type Ledger, type Meta } from '../../src/domain/ledger.ts';
import type { CaseMaster, ItemMaster } from '../../src/domain/masters.ts';
import { saveReceiptTemplate, type ReceiptTemplate } from '../../src/domain/receipt-template.ts';
import { emptySupply, type Supply } from '../../src/domain/supply.ts';
import { generateTemplateNeeds } from '../../src/domain/template-needs.ts';
import { registeredCaseNoticeOf } from '../../src/ui/registered-case-notice.ts';

const at = '2026-10-30T09:00:00+09:00';
const meta = (eventId: string): Meta => ({ eventId, actor: '架空担当A', occurredAt: at, recordedAt: at });
const item = (id: string): ItemMaster => ({ ...practiceLedger.masters.items['P']!, id, code: null, name: `架空${id}`, units: ['個', '台'], unitSteps: { 個: 1, 台: 1 } });
const base = practiceLedger.masters;
const noCode: CaseMaster = { type: 'case', id: 'ZZ', code: null, name: null, source: null, active: true };
const masters = { ...base, items: { ...base.items, P: item('P'), R: item('R') }, cases: { ...base.cases, ZZ: noCode } };
const template: ReceiptTemplate = { id: 'kit', name: '架空製品R', product: 'R', productUnit: '台', project: null, basis: 'label', rows: [{ item: 'P', unit: '個', perSet: 2, location: 'S1' }] };

type State = { ledger: Ledger; supply: Supply };

function state(): State {
  const ledger: Ledger = { ...practiceLedger, masters };
  const saved = { ledger, supply: saveReceiptTemplate(ledger, emptySupply, meta('save'), template) };
  return generateTemplateNeeds(saved, meta('gen'), { templateId: 'kit', caseCode: 'C1', count: 10, dueDate: null });
}

function withCases(current: State, cases: Record<string, CaseMaster>): State {
  return { ...current, ledger: { ...current.ledger, masters: { ...current.ledger.masters, cases: { ...current.ledger.masters.cases, ...cases } } } };
}

describe('登録済み案件の案内 2.1・2.2・2.4・2.5', () => {
  test('登録用は品番・コードの一致で出て、値を変えると消える', () => {
    expect(registeredCaseNoticeOf(state(), 'A-001', 'register')).toEqual({
      caseId: 'A-001',
      lines: ['品番・コード A-001', '名称 なし', '利用中', 'この品番・コードは登録済み。既存の案件を使う'],
    });
    expect(registeredCaseNoticeOf(state(), 'A-00', 'register')).toBeNull();
    expect(registeredCaseNoticeOf(state(), '', 'register')).toBeNull();
  });

  test('登録用は品番・コードなしの案件の内部IDでは出ない（記録を止めない）', () => {
    expect(registeredCaseNoticeOf(state(), 'ZZ', 'register')).toBeNull();
  });

  test('生成用も品番・コードなしの案件の内部IDでは出ない。利用停止中の文を完全一致で出す', () => {
    expect(registeredCaseNoticeOf(state(), 'ZZ', 'generate')).toBeNull();
    expect(registeredCaseNoticeOf(withCases(state(), { YY: { ...noCode, id: 'YY', code: 'YY', active: false } }), 'YY', 'generate')).toEqual({
      caseId: 'YY',
      lines: ['品番・コード YY', '名称 なし', '利用停止', '案件ID YY は利用停止中'],
    });
  });

  test('生成用は必要明細を持つ案件の文を完全一致で出し、総予定数と作業で使った台数を並べる', () => {
    expect(registeredCaseNoticeOf(state(), 'C1', 'generate')).toEqual({
      caseId: 'C1',
      lines: ['品番・コード C1', '名称 なし', '利用中', '総予定数 10台', '作業で使った台数 記録上の数0台', '案件ID C1 は必要明細を持つ。既存の必要明細を確認・変更する'],
    });
  });

  test('3.3: 台数不明の開始を含むと、作業で使った台数は小計を出さず案件の詳細と同じ「不明」にする', () => {
    const lot = (id: string) => ({ id, item: 'R', unit: '台', project: { kind: 'case', id: 'C1' } as const, location: 'S1' });
    const process = { id: 'R組立', criterion: 'inspection' } as const;
    const current = state();
    const ledger = start(start(current.ledger, meta('s1'), lot('W1'), process, 'counted', 3, []), meta('s2'), lot('W2'), process, 'unknown', null, []);
    expect(registeredCaseNoticeOf({ ...current, ledger }, 'C1', 'generate')?.lines).toContain('作業で使った台数 不明');
  });

  test('計画がない案件では総予定数を出さず、生成できるなら理由もない', () => {
    expect(registeredCaseNoticeOf(state(), 'A-001', 'generate')).toEqual({ caseId: 'A-001', lines: ['品番・コード A-001', '名称 なし', '利用中'] });
  });

  test('照合した案件のIDを返す（「この案件を開く」はこのIDで開く）', () => {
    expect(registeredCaseNoticeOf(state(), 'A-001', 'register')?.caseId).toBe('A-001');
    expect(registeredCaseNoticeOf(state(), 'A-001', 'generate')?.caseId).toBe('A-001');
  });

  test('品番・コードなしの案件の内部IDと同じ品番・コードを持つ案件があれば、その案件だけを示す（曖昧にしない）', () => {
    const coded = withCases(state(), { YY: { ...noCode, id: 'YY', code: 'ZZ' } });
    expect(registeredCaseNoticeOf(coded, 'ZZ', 'generate')?.caseId).toBe('YY');
  });
});
