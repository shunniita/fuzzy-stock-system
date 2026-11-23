import { describe, expect, test } from 'vitest';
import { changeMasters, practiceLedger, type Ledger, type Meta } from '../../src/domain/ledger.ts';
import { formerCaseCodeHoldersOf } from '../../src/domain/masters.ts';
import { saveReceiptTemplate, type ReceiptTemplate } from '../../src/domain/receipt-template.ts';
import { emptySupply, type Supply } from '../../src/domain/supply.ts';
import { buildTemplateNeedGeneration, generateTemplateNeeds, generateTemplateNeedsBatch, generationBlockerOf, generationCaseOf, generationTargetsOf, templateNeedContextOf } from '../../src/domain/template-needs.ts';
import { masterOps } from '../../src/ui/master-ui.ts';
import { applyCaseRegistration, caseRegistrationPlanOf } from '../../src/ui/case-registration-ui.ts';
import { registeredCaseNoticeOf } from '../../src/ui/registered-case-notice.ts';
import type { Values } from '../../src/ui/dom.ts';

type State = { ledger: Ledger; supply: Supply };
const at = '2026-11-20T09:00:00+09:00';
const meta = (eventId: string): Meta => ({ eventId, actor: '架空担当A', occurredAt: at, recordedAt: at });
const kit: ReceiptTemplate = { id: 'kit', name: '架空標準部品表', product: 'R', project: null, basis: 'counted', rows: [{ item: 'P', unit: '個', perSet: 2, location: 'S1' }] };
const input = { templateId: 'kit', caseCode: 'A-001', count: 10, dueDate: null };
const values = (entries: Record<string, string | boolean>): Values => ({ text: k => typeof entries[k] === 'string' ? entries[k] as string : '', checked: k => entries[k] === true });
const withKit = (ledger: Ledger): State => ({ ledger, supply: saveReceiptTemplate(ledger, emptySupply, meta('save'), kit) });

// 段階1：A-001（内部ID A-001）に呼び名を付け、品番・コード A-001 を B-001 へ対応変更する。
const reassigned = (): Ledger => {
  const named = changeMasters(practiceLedger, meta('m1'), { action: 'rename', type: 'case', id: 'A-001', name: '架空旧案件A', reason: '架空の名称付与' });
  return changeMasters(named, meta('m2'), { action: 'code', type: 'case', id: 'B-001', code: 'A-001', reason: '架空の付け替え' }, true);
};
// 段階2：B-001 の品番・コードを B-009 に変え、A-001 を持つ案件・用途がなくなる。
const freed = (): Ledger => changeMasters(reassigned(), meta('m3'), { action: 'code', type: 'case', id: 'B-001', code: 'B-009', reason: '架空の変更' });

describe('案件IDの照合は品番・コードだけ（要件1）', () => {
  test('1.3: 対応変更の直後、品番・コードを受け取った案件・用途に生成する', () => {
    const generated = generateTemplateNeeds(withKit(reassigned()), meta('gen'), input);
    expect(Object.keys(generated.supply.templateNeeds)).toEqual(['B-001']);
  });

  test('1.1・1.2: 品番・コードが空いた後は、外された仮の案件・用途に付けず、新しい案件・用途を登録して生成する', () => {
    const state = withKit(freed());
    expect(generationCaseOf(state.ledger.masters, 'A-001')).toBeNull();
    const generated = generateTemplateNeeds(state, meta('gen'), input);
    const [project] = Object.keys(generated.supply.templateNeeds);
    expect(project).not.toBe('A-001');
    expect(generated.ledger.masters.cases[project!]?.code).toBe('A-001');
    expect(generated.ledger.masters.cases['A-001']).toEqual(state.ledger.masters.cases['A-001']);
  });

  test('1.4: 同じ品番・コードで案件・用途を登録し、セットを使うと、登録した案件・用途に生成する。案内と記録を止める条件がそろう', () => {
    const state = withKit(freed());
    expect(registeredCaseNoticeOf(state, 'A-001', 'register')?.caseId).toBeUndefined();
    expect(registeredCaseNoticeOf(state, 'A-001', 'generate')?.caseId).toBeUndefined();
    const base = masterOps({ ledger: () => state.ledger, supply: () => state.supply }).masterCase!;
    const v = values({ code: 'A-001', name: '架空新案件', caseSet: 'kit', caseTotal: '10', caseDue: '' });
    const next = applyCaseRegistration(state, meta('op9'), v, base, caseRegistrationPlanOf(v, state.supply));
    const [project] = Object.keys(next.supply.templateNeeds);
    expect(next.ledger.masters.cases[project!]).toMatchObject({ code: 'A-001', name: '架空新案件' });
  });

  test('品番・コードのない案件・用途は、内部IDを入れても照合しない', () => {
    expect(generationCaseOf(freed().masters, 'A-001')).toBeNull();
  });
});

describe('一覧から選んだ案件・用途への生成（要件2）', () => {
  test('2.2: 内部IDで選んだ品番・コードのない案件・用途に生成し、案件IDの欄は使わない', () => {
    const state = withKit(freed());
    const generated = generateTemplateNeeds(state, meta('gen'), { ...input, caseCode: '', caseId: 'A-001' });
    expect(Object.keys(generated.supply.templateNeeds)).toEqual(['A-001']);
    expect(Object.keys(generated.ledger.masters.cases)).toEqual(Object.keys(state.ledger.masters.cases));
  });

  test('2.3: 選んだ案件・用途が生成できなければ、今の理由で止める', () => {
    const state = withKit(freed());
    const once = generateTemplateNeeds(state, meta('gen'), { ...input, caseCode: '', caseId: 'A-001' });
    expect(() => buildTemplateNeedGeneration(once, templateNeedContextOf(once.supply), meta('gen2'), { ...input, caseCode: '', caseId: 'A-001' })).toThrow('（仮）架空旧案件A は必要明細を持つ');
    const stopped = { ...state, ledger: changeMasters(state.ledger, meta('m4'), { action: 'deactivate', type: 'case', id: 'A-001', reason: '架空の停止' }) };
    expect(() => generateTemplateNeeds(stopped, meta('gen'), { ...input, caseCode: '', caseId: 'A-001' })).toThrow('利用停止中');
    expect(() => generateTemplateNeeds(state, meta('gen'), { ...input, caseCode: '', caseId: 'none' })).toThrow('選んだ案件・用途がない');
  });
});

test('一括生成は caseId を受け付けず、案件IDの検査を迂回しない', () => {
  const state = withKit(practiceLedger);
  const project = (caseId: string) => Object.assign({ templateId: 'kit', caseCode: '重複', count: 1 }, { caseId });
  expect(() => generateTemplateNeedsBatch(state, meta('gen'), { dueDate: null, group: { assemblyIndex: 0, mode: 'same', split: null }, projects: [project('A-001'), project('A-002')] })).toThrow('重複');
});

test('2.1: 一覧の生成先は、生成できない理由のない案件・用途とちょうど同じ', () => {
  let state = withKit(freed());
  state = generateTemplateNeeds(state, meta('gen'), { ...input, caseCode: 'B-009' });
  state = { ...state, ledger: changeMasters(state.ledger, meta('m5'), { action: 'deactivate', type: 'case', id: 'A-002', reason: '架空の停止' }) };
  const context = templateNeedContextOf(state.supply);
  const expected = Object.values(state.ledger.masters.cases).filter(m => generationBlockerOf(state.supply, context, m, m.id) === null).map(m => m.id);
  expect(generationTargetsOf(state).map(m => m.id)).toEqual(expected);
  expect(expected).toContain('A-001');
  expect(expected).not.toContain('B-001');
  expect(expected).not.toContain('A-002');
});

describe('以前その品番・コードを使っていた案件・用途（要件3）', () => {
  test('3.3: 対応変更・変更の履歴から求め、今の持ち主は除く', () => {
    expect(formerCaseCodeHoldersOf(reassigned(), 'A-001').map(c => c.id)).toEqual(['A-001']);
    expect(formerCaseCodeHoldersOf(freed(), 'A-001').map(c => c.id)).toEqual(['A-001', 'B-001']);
    expect(formerCaseCodeHoldersOf(freed(), 'B-009')).toEqual([]);
    expect(formerCaseCodeHoldersOf(practiceLedger, 'A-001')).toEqual([]);
  });

  test('3.1・3.2: 今の持ち主がいなければ案内に以前の持ち主を出し、開く入口は出さない', () => {
    const state = withKit(freed());
    const generate = registeredCaseNoticeOf(state, 'A-001', 'generate')!;
    expect(generate.caseId).toBeUndefined();
    expect(generate.lines).toEqual([
      'この品番・コードを今持つ案件・用途はない。以前は（仮）架空旧案件A、B-009が使っていた',
      '以前の案件・用途に作るなら「対象」の一覧から選ぶ。このまま記録すると新しい案件・用途になる',
    ]);
    expect(registeredCaseNoticeOf(state, 'A-001', 'register')!.lines[1]).toBe('以前の案件・用途を使うなら、その品番・コードを付け直す。このまま記録すると新しい案件・用途になる');
  });
});
