import { expect, test } from 'vitest';
import { changeMasters, practiceLedger, type Meta } from '../../src/domain/ledger.ts';
import { declareShortage, emptySupply, receiveLot, recordRequest, recordTemplateNeeds, registerNeed } from '../../src/domain/supply.ts';
import { deleteReceiptTemplate, saveReceiptTemplate, type ReceiptTemplate } from '../../src/domain/receipt-template.ts';
import { buildTemplateNeedFollow, buildTemplateNeedRecalculation, defaultTemplateNeedSplit, editTemplateNeeds, followTemplateNeeds, generateTemplateNeeds, generateTemplateNeedsBatch, recalculateTemplateNeeds, templateNeedContextOf } from '../../src/domain/template-needs.ts';
import { initial, parse, serialize, serializePending, type Pending } from '../../src/ui/storage.ts';
import { decodePending } from '../../src/ui/storageparse.ts';
import { parseExactJson } from '../../src/domain/exact-json.ts';
import { backupTextOf, crc32, readBackup } from '../../src/ui/backup.ts';
import { supplyEventItemIds } from '../../src/domain/history-targets.ts';
import { supplyEventText } from '../../src/ui/supply-format.ts';
import { viewSheetsOf } from '../../src/ui/viewsheets.ts';

const meta = (eventId: string): Meta => ({ eventId, actor: '架空担当A', occurredAt: '2026-10-30T09:00:00+09:00', recordedAt: '2026-10-30T09:00:00+09:00' });
const generated = () => generateTemplateNeeds({ ledger: practiceLedger, supply: saveReceiptTemplate(practiceLedger, emptySupply, meta('op1'), { id: 'kit', name: '架空標準セット', product: 'R', basis: 'label', rows: [{ item: 'P', unit: '個', perSet: 2, location: 'S1' }] }) }, meta('op2'), { templateId: 'kit', caseCode: '000007', count: 10, dueDate: '2026-11-10' });
const reason = '架空の台数変更';
const revised = (state = generated(), rows: ReceiptTemplate['rows'] = [{ item: 'P', unit: '個', perSet: 3, location: 'S1' }], eventId = 'op3') => ({ ...state, supply: saveReceiptTemplate(state.ledger, state.supply, meta(eventId), { ...state.supply.receiptTemplates.kit!, rows }) });

test.each(['counted', 'approximate'] as const)('根拠だけを%sへ変えた明細は再計算・追従で未選択なら保持する', basis => {
  const state = editTemplateNeeds(generated(), meta('manual'), '000007', { kind: 'change', needId: 'op2-n1', required: { basis, value: 20 } }, '架空の根拠訂正');
  for (const action of ['recalculate', 'follow'] as const) {
    const current = action === 'follow' ? revised(state) : state;
    const preview = action === 'follow' ? buildTemplateNeedFollow(current, meta('next'), '000007', []) : buildTemplateNeedRecalculation(current, meta('next'), '000007', 20, [], reason);
    expect(preview.rows[0]).toMatchObject({ manual: true, selectable: true, selected: false, after: { required: { basis, value: 20 } } });
    const off = action === 'follow' ? followTemplateNeeds(current, meta('next'), '000007', []) : recalculateTemplateNeeds(current, meta('next'), '000007', 20, [], reason);
    expect(off.supply.log.at(-1)).toMatchObject({ calculationPolicy: 'preserve-exclusion' });
    expect(parse(serialize(initial(off.ledger, off.supply))).supply).toEqual(off.supply);
    const on = action === 'follow' ? followTemplateNeeds(current, meta('next'), '000007', ['op2-n1']) : recalculateTemplateNeeds(current, meta('next'), '000007', 20, ['op2-n1'], reason);
    expect(on.supply.needs['op2-n1']?.required).toEqual({ basis: 'label', value: action === 'follow' ? 30 : 40 });
  }
});

test.each(['recalculate', 'follow'] as const)('旧v13のpolicyなし%sイベントは数値比較のまま読み、新しいpolicyの不正値を拒否する', action => {
  const base = editTemplateNeeds(generated(), meta('manual'), '000007', { kind: 'change', needId: 'op2-n1', required: { basis: 'approximate', value: 20 } }, '架空の根拠訂正');
  const state = action === 'follow' ? revised(base) : base;
  const before = state.supply.needs['op2-n1']!, beforePlan = state.supply.templateNeeds['000007']!;
  const after = { ...before, required: { basis: 'label', value: action === 'follow' ? 30 : 40 }, revision: action === 'follow' ? 'legacy-v1' : before.revision }, afterPlan = { ...beforePlan, count: action === 'follow' ? 10 : 20, version: action === 'follow' ? 'legacy-v1' : beforePlan.version };
  const wire = JSON.parse(serialize(initial(state.ledger, state.supply)));
  wire.supply.needs[before.id] = after; wire.supply.templateNeeds['000007'] = afterPlan;
  wire.supply.log.push({ ...meta('legacy'), kind: 'templateNeeds', action, reason: action === 'follow' ? 'セットの最新版に追従' : reason, selected: [], plansBefore: [beforePlan], plansAfter: [afterPlan], changes: [{ before, after }], itemLabels: state.supply.log.at(-1)!.itemLabels,
    ...(action === 'follow' ? { targetVersion: 'legacy-v1', versions: [{ id: 'legacy-v1', template: state.supply.receiptTemplates.kit }] } : {}) });
  const legacy = parse(JSON.stringify(wire));
  expect(legacy.supply.needs[before.id]?.required).toEqual(after.required);
  expect(JSON.parse(serialize(legacy))).toEqual(wire);
  expect(() => decodePending(pendingWire(wire))).not.toThrow();
  expect(readBackup(backupWire(wire)).kind).toBe('ok');
  wire.supply.log.at(-1).calculationPolicy = 'preserve-basis';
  expect(() => parse(JSON.stringify(wire))).toThrow();
  wire.supply.log.at(-1).calculationPolicy = 'future-policy';
  expect(() => parse(JSON.stringify(wire))).toThrow('calculationPolicy');
});

test('旧v13の空白付き案件は原文のまま読めて既存明細を再計算できる', () => {
  const state = generated(), wire = serialize(initial(state.ledger, state.supply)).replaceAll('000007', '000007 ');
  const legacy = parse(wire);
  expect(legacy.ledger.masters.cases['000007 ']?.code).toBe('000007 ');
  const next = recalculateTemplateNeeds(legacy, meta('next'), '000007 ', 20, [], reason);
  expect(next.supply.needs['op2-n1']?.project.id).toBe('000007 ');
  expect(parse(serialize(initial(next.ledger, next.supply))).supply).toEqual(next.supply);
});

test('5.1 正当な台数再計算の履歴を通常読込で受け付ける', () => {
  const state = generated(), before = state.supply.needs['op2-n1']!, beforePlan = state.supply.templateNeeds['000007']!;
  const after = { ...before, required: { basis: 'label', value: 40 } }, afterPlan = { ...beforePlan, count: 20 };
  const wire = JSON.parse(serialize(initial(state.ledger, state.supply)));
  wire.supply.needs[before.id] = after; wire.supply.templateNeeds['000007'] = afterPlan;
  wire.supply.log.push({ ...meta('op3'), kind: 'templateNeeds', action: 'recalculate', reason: '架空の増産', selected: [], plansBefore: [beforePlan], plansAfter: [afterPlan], changes: [{ before, after }], itemLabels: state.supply.log.at(-1)!.itemLabels });
  expect(() => parse(JSON.stringify(wire))).not.toThrow();
});

test('5.1–5.4 旧標準で手修正を判定し、新標準と同じ現在値も未選択なら原文の根拠を保つ', () => {
  const base = generated(), state = editTemplateNeeds(base, meta('manual'), '000007', { kind: 'change', needId: 'op2-n1', required: { basis: 'counted', value: 40 } }, '架空の実数確認');
  const before = JSON.stringify(state), preview = buildTemplateNeedRecalculation(state, meta('op3'), '000007', 20, [], reason);
  expect(preview.rows[0]).toMatchObject({ oldStandard: 20, newStandard: 40, manual: true, selectable: true, selected: false, added: false, removed: false });
  expect(preview.rows[0]?.after.required).toEqual({ basis: 'counted', value: 40 });
  expect(JSON.stringify(state)).toBe(before);
  const result = recalculateTemplateNeeds(state, meta('op3'), '000007', 20, [], reason);
  expect(result.supply.needs['op2-n1']).toEqual(state.supply.needs['op2-n1']);
  expect(result.supply.templateNeeds['000007']).toMatchObject({ count: 20, version: 'op2-v1', initialVersion: 'op2-v1', generationId: 'op2' });
  expect(result.supply.log.at(-1)).toMatchObject({ action: 'recalculate', reason, changes: [], selected: [] });
  expect(parse(serialize(initial(result.ledger, result.supply))).supply).toEqual(result.supply);
  expect(buildTemplateNeedRecalculation(result, meta('next'), '000007', 30, [], reason).rows[0]).toMatchObject({ oldStandard: 40, newStandard: 60, manual: true });
});

test('5.1–5.4 通常行は自動更新し、手修正・不明行は選択したときだけlabel標準へ置き換える', () => {
  const base = generated(), normal = recalculateTemplateNeeds(base, meta('op3'), '000007', 20, [], reason);
  expect(normal.supply.needs['op2-n1']?.required).toEqual({ basis: 'label', value: 40 });
  let state = editTemplateNeeds(base, meta('manual'), '000007', { kind: 'change', needId: 'op2-n1', required: { basis: 'unknown', value: null } }, '架空の不明');
  state = editTemplateNeeds(state, meta('custom'), '000007', { kind: 'add', item: 'Q', unit: '個', required: { basis: 'counted', value: 9 }, dueDate: null }, '架空の独自追加');
  const off = recalculateTemplateNeeds(state, meta('off'), '000007', 20, [], reason);
  expect(off.supply.needs['op2-n1']?.required).toEqual({ basis: 'unknown', value: null });
  expect(off.supply.needs['custom-n1']).toEqual(state.supply.needs['custom-n1']);
  const on = recalculateTemplateNeeds(state, meta('on'), '000007', 20, ['op2-n1'], reason);
  expect(on.supply.needs['op2-n1']?.required).toEqual({ basis: 'label', value: 40 });
  expect(on.supply.needs['custom-n1']).toEqual(state.supply.needs['custom-n1']);
});

test.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('5.1 不正な再計算台数 %s を丸めず拒否する', count => {
  const state = generated(), before = JSON.stringify(state);
  expect(() => recalculateTemplateNeeds(state, meta('op3'), '000007', count, [], reason)).toThrow();
  expect(JSON.stringify(state)).toBe(before);
});
test('5.2, 6.6 理由空・同台数・重複/未知/選択対象外の明細を拒否する', () => {
  const state = generated();
  expect(() => recalculateTemplateNeeds(state, meta('op3'), '000007', 20, [], ' \n')).toThrow('理由');
  expect(() => recalculateTemplateNeeds(state, meta('op3'), '000007', 10, [], reason)).toThrow('変わっていない');
  for (const selected of [['unknown'], ['op2-n1'], ['op2-n1', 'op2-n1']]) expect(() => recalculateTemplateNeeds(state, meta('op3'), '000007', 20, selected, reason)).toThrow('選択');
  for (const id of ['op1', 'op2-c1']) {
    expect(() => recalculateTemplateNeeds(state, meta(id), '000007', 20, [], reason)).toThrow('使用済み');
    expect(() => followTemplateNeeds(revised(state), meta(id), '000007', [])).toThrow('使用済み');
  }
});

test('5.1 保存元削除・既存品目の停止後も再計算でき、削除されたセットへの追従は拒否する', () => {
  const base = generated(), ledger = changeMasters(base.ledger, meta('stop'), { action: 'deactivate', type: 'item', id: 'P', reason: '架空停止' });
  const state = { ledger, supply: deleteReceiptTemplate(base.supply, ledger.masters, meta('delete'), 'kit') };
  const result = recalculateTemplateNeeds(state, meta('op3'), '000007', 20, [], reason);
  expect(result.supply.needs['op2-n1']?.required.value).toBe(40);
  expect(parse(serialize(initial(result.ledger, result.supply))).supply).toEqual(result.supply);
  expect(() => followTemplateNeeds(state, meta('op3'), '000007', [])).toThrow('削除');
});

test('5.5 個別台数変更は合計を制限せず、関連案件の差をBigIntから正確に返す', () => {
  const base = generated(), supply = saveReceiptTemplate(base.ledger, base.supply, meta('wide'), { ...base.supply.receiptTemplates.kit!, rows: [{ item: 'P', unit: '個', perSet: 1, location: 'S1' }] });
  let state = generateTemplateNeedsBatch({ ...base, supply }, meta('batch'), { group: { assemblyIndex: 0, mode: 'split', split: 17 }, dueDate: null, projects: [{ templateId: 'kit', caseCode: '000A', count: 2 }, { templateId: 'kit', caseCode: '000I1', count: 1 }, { templateId: 'kit', caseCode: '000I2', count: 1 }] });
  state = recalculateTemplateNeeds(state, meta('large1'), '000I1', Number.MAX_SAFE_INTEGER, [], reason);
  const preview = buildTemplateNeedRecalculation(state, meta('large2'), '000I2', Number.MAX_SAFE_INTEGER, [], reason);
  expect(preview.relatedCounts).toEqual({ generationId: 'batch', mode: 'split', assembly: '2', inspection: '18014398509481982', difference: '18014398509481980' });
  const next = recalculateTemplateNeeds(state, meta('large2'), '000I2', Number.MAX_SAFE_INTEGER, [], reason);
  expect(next.supply.templateNeeds['000A']?.count).toBe(2);
  expect(defaultTemplateNeedSplit(next.supply)).toBe(17);
  expect(parse(serialize(initial(next.ledger, next.supply))).supply).toEqual(next.supply);
});

test('6.1, 6.3 セット保存だけでは変えず、明示追従が通常行と基準版だけを進める', () => {
  const base = generated(), state = revised(base);
  expect(state.supply.needs).toBe(base.supply.needs); expect(state.supply.templateNeeds).toBe(base.supply.templateNeeds);
  const result = followTemplateNeeds(state, meta('op4'), '000007', []);
  expect(result.supply.needs['op2-n1']?.required.value).toBe(30);
  expect(result.supply.templateNeeds['000007']).toMatchObject({ version: 'op4-v1', count: 10, initialVersion: 'op2-v1', generationId: 'op2' });
  expect(result.supply.log.at(-1)).toMatchObject({ action: 'follow', targetVersion: 'op4-v1', reason: 'セットの最新版に追従', selected: [], versions: [{ id: 'op4-v1' }] });
  expect(result.ledger).toBe(state.ledger);
});

test('6.4 手修正は追従前標準で判定し、数量不明も未選択保持と選択置換を分ける', () => {
  const base = editTemplateNeeds(generated(), meta('manual'), '000007', { kind: 'change', needId: 'op2-n1', required: { basis: 'unknown', value: null } }, '架空の不明'), state = revised(base);
  const preview = buildTemplateNeedFollow(state, meta('op4'), '000007', []);
  expect(preview.rows[0]).toMatchObject({ manual: true, oldStandard: 20, newStandard: 30, selected: false, after: { required: { basis: 'unknown', value: null } } });
  expect(followTemplateNeeds(state, meta('off'), '000007', []).supply.needs['op2-n1']?.required.value).toBeNull();
  expect(followTemplateNeeds(state, meta('on'), '000007', ['op2-n1']).supply.needs['op2-n1']?.required).toEqual({ basis: 'label', value: 30 });
});

test('6.2, 6.4 外注化B/C→Xは削除行を0標準で残し、手修正を保持し新規行を追加する', () => {
  let ledger = practiceLedger;
  for (const code of ['B', 'C']) ledger = changeMasters(ledger, meta(`item-${code}`), { action: 'register', master: { type: 'item', code, name: `架空${code}`, units: ['個'], unitSteps: { 個: 1 }, trial: true, source: null } });
  const supply = saveReceiptTemplate(ledger, emptySupply, meta('op1'), { id: 'kit', name: '架空外注セット', product: 'R', basis: 'label', rows: [{ item: 'B', unit: '個', perSet: 2, location: 'S1' }, { item: 'C', unit: '個', perSet: 3, location: 'S1' }] });
  let state = generateTemplateNeeds({ ledger, supply }, meta('op2'), { templateId: 'kit', caseCode: '000007', count: 10, dueDate: '2026-11-10' });
  state = editTemplateNeeds(state, meta('manual'), '000007', { kind: 'change', needId: 'op2-n1', required: { basis: 'label', value: 25 } }, '架空の手修正');
  state = revised(state, [{ item: 'X', unit: '個', perSet: 1, location: 'S1' }]);
  const preview = buildTemplateNeedFollow(state, meta('op4'), '000007', []);
  expect(preview.rows.map(row => [row.item, row.oldStandard, row.newStandard, row.manual, row.added, row.removed])).toEqual([['B', 20, 0, true, false, true], ['C', 30, 0, false, false, true], ['X', 0, 10, false, true, false]]);
  const result = followTemplateNeeds(state, meta('op4'), '000007', []);
  expect(Object.values(result.supply.needs).map(need => [need.item, need.required.value])).toEqual([['B', 25], ['C', 0], ['X', 10]]);
  expect(result.supply.needs['op4-n1']).toMatchObject({ dueDate: '2026-11-10', source: '架空外注セット', revision: 'op4-v1' });
  expect(result.supply.templateNeeds['000007']?.origins).toHaveLength(3);
  expect(followTemplateNeeds(state, meta('selected'), '000007', ['op2-n1']).supply.needs['op2-n1']?.required.value).toBe(0);
});

test.each([7, 30])('6.5 custom数量%sは同版でも衝突を毎回提示し、選択した時だけ変換して二重適用を拒否する', value => {
  let state = editTemplateNeeds(generated(), meta('custom'), '000007', { kind: 'add', item: 'Q', unit: '個', required: { basis: 'counted', value }, dueDate: '2026-11-12' }, '架空独自');
  state = revised(state, [{ item: 'P', unit: '個', perSet: 2, location: 'S1' }, { item: 'Q', unit: '個', perSet: 3, location: 'S1' }]);
  const off = followTemplateNeeds(state, meta('op4'), '000007', []);
  expect(off.supply.needs['custom-n1']).toEqual(state.supply.needs['custom-n1']);
  for (const id of ['preview1', 'preview2']) {
    const preview = buildTemplateNeedFollow(off, meta(id), '000007', []);
    expect(preview.applicable).toBe(false);
    expect(preview.rows.find(row => row.key === 'custom-n1')).toMatchObject({ collision: true, selected: false, selectable: true, oldStandard: null, newStandard: 30, originAfter: 'custom' });
  }
  expect(() => followTemplateNeeds(off, meta('op5'), '000007', [])).toThrow('選ぶ');
  const on = followTemplateNeeds(off, meta('op5'), '000007', ['custom-n1']);
  expect(on.supply.needs['custom-n1']).toMatchObject({ required: { basis: 'label', value: 30 }, source: '架空標準セット', revision: 'op4-v1', dueDate: '2026-11-12' });
  expect(on.supply.templateNeeds['000007']?.origins[1]?.origin).toBe('template');
  expect(on.supply.log.at(-1)).toMatchObject({ targetVersion: 'op4-v1', versions: [], selected: ['custom-n1'] });
  expect(() => followTemplateNeeds(on, meta('op6'), '000007', [])).toThrow('適用済み');
});

test('6.3 数量が同じ名称変更でも版を進め、既知の旧内容へ戻した場合は元の版を再利用する', () => {
  const base = generated(), original = base.supply.receiptTemplates.kit!;
  const state = { ...base, supply: saveReceiptTemplate(base.ledger, base.supply, meta('op3'), { ...original, name: '架空改名セット' }) };
  const result = followTemplateNeeds(state, meta('op4'), '000007', []);
  expect(result.supply.needs['op2-n1']?.required.value).toBe(20);
  expect(result.supply.templateNeeds['000007']?.version).toBe('op4-v1');
  const reverted = { ...result, supply: saveReceiptTemplate(result.ledger, result.supply, meta('op5'), original) };
  const back = followTemplateNeeds(reverted, meta('op6'), '000007', []);
  expect(back.supply.log.at(-1)).toMatchObject({ versions: [], targetVersion: 'op2-v1' });
  expect(back.supply.templateNeeds['000007']).toMatchObject({ initialVersion: 'op2-v1', version: 'op2-v1', generationId: 'op2' });
  expect(Object.keys(templateNeedContextOf(back.supply).versions)).toHaveLength(2);
  expect(parse(serialize(initial(back.ledger, back.supply))).supply).toEqual(back.supply);
});

test('既知版のオブジェクトの属性順が異なっても正規化した内容で再利用し保存できる', () => {
  const base = generated(), followed = followTemplateNeeds(revised(base), meta('new-version'), '000007', []);
  const log = followed.supply.log.map(event => event.kind === 'templateNeeds' && event.action === 'generate'
    ? { ...event, versions: event.versions.map(version => {
      const { rows, ...fields } = version.template;
      return { ...version, template: { rows, ...fields } };
    }) } : event);
  const state = { ...followed, supply: saveReceiptTemplate(followed.ledger, { ...followed.supply, log }, meta('revert'), base.supply.receiptTemplates.kit!) };
  const next = followTemplateNeeds(state, meta('back'), '000007', []);
  expect(next.supply.log.at(-1)).toMatchObject({ versions: [], targetVersion: 'op2-v1' });
  expect(parse(serialize(initial(next.ledger, next.supply))).supply).toEqual(next.supply);
});

test('6.3 子構成だけの変更でも版を進め、子明細は必要数へ展開しない', () => {
  const child = { id: 'child', name: '架空子構成', product: 'P', productUnit: '個', project: null, basis: 'label' as const, rows: [{ item: 'Q', unit: '個', perSet: 2, location: 'S1' }] };
  let supply = saveReceiptTemplate(practiceLedger, emptySupply, meta('child1'), child);
  supply = saveReceiptTemplate(practiceLedger, supply, meta('op1'), { id: 'kit', name: '架空親構成', product: 'R', productUnit: '台', basis: 'label', rows: [{ item: 'P', unit: '個', perSet: 1, location: 'S1', assembly: supply.receiptTemplates.child! }] });
  const state = generateTemplateNeeds({ ledger: practiceLedger, supply }, meta('op2'), { templateId: 'kit', caseCode: '000007', count: 10, dueDate: null });
  supply = saveReceiptTemplate(state.ledger, state.supply, meta('child2'), { ...child, rows: [{ item: 'Q', unit: '個', perSet: 3, location: 'S1' }] });
  supply = saveReceiptTemplate(state.ledger, supply, meta('op3'), { ...supply.receiptTemplates.kit!, rows: [{ ...supply.receiptTemplates.kit!.rows[0]!, assembly: supply.receiptTemplates.child! }] });
  const result = followTemplateNeeds({ ...state, supply }, meta('op4'), '000007', []);
  expect(Object.values(result.supply.needs).map(need => [need.item, need.required.value])).toEqual([['P', 10]]);
  expect(result.supply.templateNeeds['000007']?.version).toBe('op4-v1');
  expect(parse(serialize(initial(result.ledger, result.supply))).supply).toEqual(result.supply);
});

test('6.2 新規追従では現在品目/製品の停止を拒否し、追従後の停止は履歴の読込を妨げない', () => {
  const base = revised();
  for (const id of ['P', 'R']) {
    const ledger = changeMasters(base.ledger, meta(`stop-${id}`), { action: 'deactivate', type: 'item', id, reason: '架空停止' });
    expect(() => followTemplateNeeds({ ...base, ledger }, meta('op4'), '000007', [])).toThrow('利用停止');
  }
  const followed = followTemplateNeeds(base, meta('op4'), '000007', []), ledger = changeMasters(followed.ledger, meta('stop-later'), { action: 'deactivate', type: 'item', id: 'P', reason: '架空停止' });
  expect(parse(serialize(initial(ledger, followed.supply))).supply).toEqual(followed.supply);
});

test('5.2, 6.6 古いpreviewの差分は必要数または最新版の変更後には記録できない', () => {
  const state = generated(), preview = buildTemplateNeedRecalculation(state, meta('op4'), '000007', 20, [], reason);
  const edited = editTemplateNeeds(state, meta('manual'), '000007', { kind: 'change', needId: 'op2-n1', required: { basis: 'label', value: 19 } }, reason);
  expect(() => recordTemplateNeeds(edited.ledger, edited.supply, meta('op4'), preview.event)).toThrow();
  const current = revised(), follow = buildTemplateNeedFollow(current, meta('op4'), '000007', []);
  const newer = revised(current, [{ item: 'P', unit: '個', perSet: 4, location: 'S1' }], 'newer');
  expect(() => recordTemplateNeeds(newer.ledger, newer.supply, meta('op4'), follow.event)).toThrow();
});

test('5.4, 5.6, 6.5, 6.7 両操作は非衝突custom・他案件・現物・受け取り・依頼・申告と履歴prefixを保持する', () => {
  let state = generateTemplateNeeds(generated(), meta('other'), { templateId: 'kit', caseCode: '000008', count: 5, dueDate: null });
  state = editTemplateNeeds(state, meta('custom'), '000007', { kind: 'add', item: 'Q', unit: '個', required: { basis: 'counted', value: 7 }, dueDate: '2026-11-12' }, '架空独自');
  state = receiveLot(state.ledger, state.supply, meta('receipt'), { id: '架空現物', item: 'P', unit: '個', project: { kind: 'case', id: '000007' }, location: 'S1' }, 'label', 12);
  state = { ...state, supply: recordRequest(state.supply, state.ledger.masters, meta('request'), { project: { kind: 'case', id: '000007' }, item: 'P', unit: '個', quantity: 8, vendor: '架空依頼先', requestedOn: '2026-10-30', reply: { kind: 'none' } }) };
  state = { ...state, supply: declareShortage(state.supply, state.ledger.masters, meta('declaration'), { project: { kind: 'case', id: '000007' }, item: 'P', unit: '個', value: 8, reason: '架空確認' }) };
  state = revised(state);
  const before = JSON.stringify(state);
  for (const result of [recalculateTemplateNeeds(state, meta('recalculate'), '000007', 20, [], reason), followTemplateNeeds(state, meta('follow'), '000007', [])]) {
    expect(result.ledger).toBe(state.ledger);
    for (const key of ['receiptTemplates', 'receipts', 'requests', 'declarations', 'levels', 'acks'] as const) expect(result.supply[key]).toBe(state.supply[key]);
    expect(result.supply.log.slice(0, -1)).toEqual(state.supply.log);
    expect(result.supply.needs['custom-n1']).toEqual(state.supply.needs['custom-n1']);
    expect(result.supply.needs['other-n1']).toEqual(state.supply.needs['other-n1']);
    expect(result.supply.templateNeeds['000008']).toEqual(state.supply.templateNeeds['000008']);
  }
  expect(JSON.stringify(state)).toBe(before);
});

test('5.1, 6.2 小数の行合算と再計算・追従を最小単位どおり保持する', () => {
  const ledger = changeMasters(practiceLedger, meta('decimal'), { action: 'register', master: { type: 'item', code: 'D', name: '架空小数品目', units: ['kg'], unitSteps: { kg: 0.1 }, trial: true, source: null } });
  const supply = saveReceiptTemplate(ledger, emptySupply, meta('op1'), { id: 'kit', name: '架空小数セット', product: 'R', basis: 'label', rows: [{ item: 'D', unit: 'kg', perSet: 0.1, location: 'S1' }, { item: 'D', unit: 'kg', perSet: 0.2, location: 'S1' }] });
  const state = generateTemplateNeeds({ ledger, supply }, meta('op2'), { templateId: 'kit', caseCode: '000007', count: 3, dueDate: null });
  expect(state.supply.needs['op2-n1']?.required.value).toBe(0.9);
  const recalc = recalculateTemplateNeeds(state, meta('recalculate'), '000007', 6, [], reason);
  expect(recalc.supply.needs['op2-n1']?.required.value).toBe(1.8);
  const next = followTemplateNeeds(revised(recalc, [{ item: 'D', unit: 'kg', perSet: 0.2, location: 'S1' }, { item: 'D', unit: 'kg', perSet: 0.3, location: 'S1' }]), meta('follow'), '000007', []);
  expect(next.supply.needs['op2-n1']?.required.value).toBe(3);
  expect(parse(serialize(initial(next.ledger, next.supply))).supply).toEqual(next.supply);
});

test('6.6 追従の重複・未知・通常行の選択と、新規明細IDの他案件との衝突を拒否する', () => {
  const state = revised(generated(), [{ item: 'P', unit: '個', perSet: 3, location: 'S1' }, { item: 'Q', unit: '個', perSet: 1, location: 'S1' }]);
  for (const selected of [['unknown'], ['op2-n1'], ['op2-n1', 'op2-n1']]) expect(() => followTemplateNeeds(state, meta('op4'), '000007', selected)).toThrow('選択');
  const supply = registerNeed(state.supply, state.ledger.masters, meta('op4-n1'), { project: { kind: 'case', id: 'A-001' }, item: 'Q', unit: '個', required: { basis: 'label', value: 1 }, dueDate: null, source: '架空旧資料', revision: '1' });
  expect(() => followTemplateNeeds({ ...state, supply }, meta('op4'), '000007', [])).toThrow('必要明細ID op4-n1');
});

test('保持1,000明細までを実際の20版で作り、退役行を消さず1,001件目の追従を拒否する', () => {
  let ledger = practiceLedger;
  for (let index = 0; index < 1000; index++) ledger = changeMasters(ledger, meta(`item${index}`), { action: 'register', master: { type: 'item', code: `Z${index}`, name: `架空${index}`, units: ['個'], unitSteps: { 個: 1 }, trial: true, source: null } });
  const rows = (version: number): ReceiptTemplate['rows'] => Array.from({ length: 50 }, (_, index) => ({ item: `Z${version * 50 + index}`, unit: '個', perSet: 1, location: 'S1' }));
  let state = generateTemplateNeeds({ ledger, supply: saveReceiptTemplate(ledger, emptySupply, meta('save0'), { id: 'kit', name: '架空50行', product: 'R', basis: 'label', rows: rows(0) }) }, meta('generate'), { templateId: 'kit', caseCode: '000007', count: 1, dueDate: null });
  for (let version = 1; version < 20; version++) state = followTemplateNeeds(revised(state, rows(version), `save${version}`), meta(`follow${version}`), '000007', []);
  expect(state.supply.templateNeeds['000007']?.origins).toHaveLength(1000);
  expect(Object.keys(state.supply.needs)).toHaveLength(1000);
  expect(state.supply.needs['generate-n1']?.required.value).toBe(0);
  const extra = revised(state, [{ item: 'P', unit: '個', perSet: 1, location: 'S1' }], 'save20'), before = JSON.stringify(extra);
  expect(() => followTemplateNeeds(extra, meta('follow20'), '000007', [])).toThrow('1,000件');
  expect(JSON.stringify(extra)).toBe(before);
}, 30000);

const recalculated = () => recalculateTemplateNeeds(generated(), meta('op3'), '000007', 20, [], reason);
const followed = () => followTemplateNeeds(revised(generated(), [{ item: 'P', unit: '個', perSet: 3, location: 'S1' }, { item: 'Q', unit: '個', perSet: 1, location: 'S1' }]), meta('op4'), '000007', []);
const pendingOf = (state: ReturnType<typeof generated>): Pending => ({ progress: 'saving', unknownSince: null, savingSince: meta('op5').recordedAt, baseRevision: 0, opId: state.supply.log.at(-1)!.eventId, opLabel: '必要明細の更新', fingerprint: '架空入力', values: {}, actor: meta('op5').actor, startedAt: meta('op5').recordedAt, units: [{ ...state, conflictReviews: [], targets: [] }] });
const wireOf = (action: 'recalculate' | 'follow') => { const state = action === 'recalculate' ? recalculated() : followed(); return JSON.parse(serialize(initial(state.ledger, state.supply))); };
const pendingWire = (value: ReturnType<typeof wireOf>) => ({ format: 'fuzzy-stock-pending', version: 13, quantities: value.quantities, pending: { ...pendingOf(value), units: [{ ledger: value.ledger, supply: value.supply, conflictReviews: [], targets: [] }] } });
const bytes = (text: string) => new TextEncoder().encode(text);
const backupWire = (value: ReturnType<typeof wireOf>) => {
  const text = JSON.stringify(value), at = meta('op5').recordedAt;
  return bytes(JSON.stringify({ notice: '架空試験', format: 'fuzzy-stock-backup', version: 1, createdAt: at, crc32: crc32(bytes(`${at}\n${text}`)).toString(16).padStart(8, '0'), snapshot: text }));
};
test.each(['recalculate', 'follow'] as const)('8.5 %sを通常/pending/backupで復号し、履歴の版・台数・変更前後・理由を残す', action => {
  const state = action === 'recalculate' ? recalculated() : followed(), snapshot = initial(state.ledger, state.supply);
  expect(parse(serialize(snapshot))).toEqual(snapshot);
  expect(decodePending(parseExactJson(serializePending(pendingOf(state))))).toEqual(pendingOf(state));
  expect(readBackup(bytes(backupTextOf(snapshot, meta('op5').recordedAt)))).toMatchObject({ kind: 'ok', snapshot });
  const event = state.supply.log.at(-1)!, text = supplyEventText(state.ledger.masters, event);
  expect(text).toContain(action === 'recalculate' ? '台数再計算' : '最新版への追従');
  expect(text).toContain('op2-v1');
  expect(text).toContain(action === 'recalculate' ? '10台 → 20台' : 'op2-v1 → op4-v1');
  const row = viewSheetsOf(state, meta('op5').recordedAt).find(sheet => sheet.name === '供給の履歴')?.rows.at(-1);
  expect(row?.[1]).toBe(action === 'recalculate' ? '必要明細の台数再計算' : '必要明細の最新版への追従');
  expect(row?.[5]).toBe(text); expect(row?.[6]).toContain('20個'); expect(row?.[7]).toContain(action === 'recalculate' ? '40個' : '30個');
  expect(row?.[8]).toBe(action === 'recalculate' ? reason : 'セットの最新版に追従');
  expect(supplyEventItemIds(event, state)).toEqual(action === 'recalculate' ? ['P', 'R'] : ['P', 'Q', 'R']);
  const afterRecalc = recalculateTemplateNeeds(state, meta('op5'), '000007', 30, [], reason);
  expect(supplyEventItemIds(afterRecalc.supply.log.at(-1)!, afterRecalc)).toEqual(action === 'recalculate' ? ['P', 'R'] : ['P', 'Q', 'R']);
});

const commonCorruptions: [string, (value: ReturnType<typeof wireOf>) => void][] = [
  ['変更前計画', value => { value.supply.log.at(-1).plansBefore[0].count = 9; }],
  ['初回版', value => { value.supply.log.at(-1).plansAfter[0].initialVersion = 'future'; }],
  ['生成ID', value => { value.supply.log.at(-1).plansAfter[0].generationId = 'other'; }],
  ['未知選択', value => { value.supply.log.at(-1).selected = ['unknown']; }],
  ['通常行選択', value => { value.supply.log.at(-1).selected = ['op2-n1']; }],
  ['重複選択', value => { value.supply.log.at(-1).selected = ['op2-n1', 'op2-n1']; }],
  ['変更前値', value => { value.supply.log.at(-1).changes[0].before.required.value = 19; }],
  ['計算後値', value => { value.supply.log.at(-1).changes[0].after.required.value = 39; value.supply.needs['op2-n1'].required.value = 39; }],
  ['差分欠落', value => { value.supply.log.at(-1).changes = []; }],
  ['由来改変', value => { value.supply.log.at(-1).plansAfter[0].origins[0].origin = 'custom'; }],
  ['余分な属性', value => { value.supply.log.at(-1).group = null; }],
  ['不正な計算方針', value => { value.supply.log.at(-1).calculationPolicy = 'future-policy'; }],
  ['nullの計算方針', value => { value.supply.log.at(-1).calculationPolicy = null; }],
];
for (const action of ['recalculate', 'follow'] as const) test.each(commonCorruptions)(`8.5 ${action}の%sを通常/pending/backupで拒否する`, (_label, corrupt) => {
  const value = wireOf(action); corrupt(value);
  const raw = JSON.stringify(value);
  expect(() => parse(raw)).toThrow(); expect(() => decodePending(pendingWire(value))).toThrow(); expect(readBackup(backupWire(value)).kind).toBe('unreadable');
  expect(JSON.stringify(value)).toBe(raw);
});

test.each(['理由空', '同台数', '基準版変更'] as const)('8.5 再計算%sを拒否する', key => {
  const value = wireOf('recalculate'), event = value.supply.log.at(-1);
  if (key === '理由空') event.reason = ' ';
  if (key === '同台数') event.plansAfter[0].count = 10;
  if (key === '基準版変更') event.plansAfter[0].version = 'other';
  expect(() => parse(JSON.stringify(value))).toThrow(); expect(() => decodePending(pendingWire(value))).toThrow(); expect(readBackup(backupWire(value)).kind).toBe('unreadable');
});

test.each(['理由', '未来版', '版欠落', '版重複', '写し', 'ID', '台数変更', '新行ID'] as const)('8.5 追従%sを拒否する', key => {
  const value = wireOf('follow'), event = value.supply.log.at(-1);
  if (key === '理由') event.reason = '任意理由';
  if (key === '未来版') event.targetVersion = 'future';
  if (key === '版欠落') event.versions = [];
  if (key === '版重複') event.versions.push(event.versions[0]);
  if (key === '写し') event.versions[0].template.rows[0].perSet = 4;
  if (key === 'ID') event.versions[0].id = 'other-v1';
  if (key === '台数変更') event.plansAfter[0].count = 20;
  if (key === '新行ID') event.changes[1].after.id = 'other-n1';
  expect(() => parse(JSON.stringify(value))).toThrow(); expect(() => decodePending(pendingWire(value))).toThrow(); expect(readBackup(backupWire(value)).kind).toBe('unreadable');
});

test.each([{ basis: 'unknown', value: null }, { basis: 'approximate', value: 20 }] as const)('8.5 未選択の手修正%sを強制更新する偽差分を両actionで拒否する', required => {
  const base = editTemplateNeeds(generated(), meta('manual'), '000007', { kind: 'change', needId: 'op2-n1', required }, '架空未確認');
  for (const action of ['recalculate', 'follow']) {
    const state = action === 'recalculate' ? recalculateTemplateNeeds(base, meta('op4'), '000007', 20, [], reason) : followTemplateNeeds(revised(base), meta('op4'), '000007', []);
    const value = JSON.parse(serialize(initial(state.ledger, state.supply))), event = value.supply.log.at(-1), before = base.supply.needs['op2-n1']!, after = { ...before, required: { basis: 'label', value: action === 'recalculate' ? 40 : 30 }, revision: action === 'recalculate' ? 'op2-v1' : 'op4-v1' };
    event.changes = [{ before, after }]; value.supply.needs[before.id] = after;
    expect(() => parse(JSON.stringify(value))).toThrow(); expect(() => decodePending(pendingWire(value))).toThrow(); expect(readBackup(backupWire(value)).kind).toBe('unreadable');
  }
});

test('8.5 同じ数量でも別セットの既知版へ付け替えた追従を拒否する', () => {
  const base = generated();
  const other = saveReceiptTemplate(base.ledger, base.supply, meta('other-save'), { ...base.supply.receiptTemplates.kit!, id: 'other', name: '架空別セット', rows: [{ item: 'P', unit: '個', perSet: 3, location: 'S1' }] });
  const known = generateTemplateNeeds({ ...base, supply: other }, meta('other-gen'), { templateId: 'other', caseCode: '000008', count: 10, dueDate: null });
  const state = followTemplateNeeds(revised(known), meta('op4'), '000007', []), value = JSON.parse(serialize(initial(state.ledger, state.supply))), event = value.supply.log.at(-1);
  event.versions = []; event.targetVersion = 'other-gen-v1'; event.plansAfter[0].version = 'other-gen-v1';
  event.changes[0].after.source = '架空別セット'; event.changes[0].after.revision = 'other-gen-v1'; value.supply.templateNeeds['000007'].version = 'other-gen-v1'; value.supply.needs['op2-n1'] = event.changes[0].after;
  expect(() => parse(JSON.stringify(value))).toThrow(); expect(() => decodePending(pendingWire(value))).toThrow(); expect(readBackup(backupWire(value)).kind).toBe('unreadable');
});

test('6.7 製品だけを改訂した追従も変更前後両版の品目ラベルを保持する', () => {
  const base = generated(), supply = saveReceiptTemplate(base.ledger, base.supply, meta('op3'), { ...base.supply.receiptTemplates.kit!, product: 'S' });
  const state = followTemplateNeeds({ ...base, supply }, meta('op4'), '000007', []), event = state.supply.log.at(-1)!;
  expect(supplyEventItemIds(event, state)).toEqual(['P', 'R', 'S']);
  expect(event.itemLabels).toMatchObject({ kind: 'recorded', items: { R: { name: '架空半製品R' }, S: { name: '架空共通ネジS' } } });
  expect(parse(serialize(initial(state.ledger, state.supply))).supply).toEqual(state.supply);
});

test.each(['recalculate', 'follow'] as const)('8.5 %sの最終ラベル込み1MiB境界を守る', action => {
  const state = action === 'recalculate' ? generated() : revised(), id = action === 'recalculate' ? 'op3' : 'op4';
  const run = (actor: string) => action === 'recalculate' ? recalculateTemplateNeeds(state, { ...meta(id), actor }, '000007', 20, [], reason) : followTemplateNeeds(state, { ...meta(id), actor }, '000007', []);
  const baseline = run(meta(id).actor).supply.log.at(-1), length = 1024 * 1024 - bytes(JSON.stringify(baseline)).length + bytes(meta(id).actor).length;
  expect(bytes(JSON.stringify(run('x'.repeat(length)).supply.log.at(-1))).length).toBe(1024 * 1024);
  const before = JSON.stringify(state);
  expect(() => run('x'.repeat(length + 1))).toThrow('1MiB');
  expect(JSON.stringify(state)).toBe(before);
});

test('6.2 正当な保存済み最新版への追従履歴を通常読込で受け付ける', () => {
  const base = generated(), current = { ...base.supply.receiptTemplates.kit!, rows: [{ item: 'P', unit: '個', perSet: 3, location: 'S1' }] };
  const state = { ...base, supply: saveReceiptTemplate(base.ledger, base.supply, meta('op3'), current) }, before = state.supply.needs['op2-n1']!, beforePlan = state.supply.templateNeeds['000007']!;
  const after = { ...before, required: { basis: 'label', value: 30 }, revision: 'op4-v1' }, afterPlan = { ...beforePlan, version: 'op4-v1' };
  const wire = JSON.parse(serialize(initial(state.ledger, state.supply)));
  wire.supply.needs[before.id] = after; wire.supply.templateNeeds['000007'] = afterPlan;
  wire.supply.log.push({ ...meta('op4'), kind: 'templateNeeds', action: 'follow', reason: 'セットの最新版に追従', targetVersion: 'op4-v1', versions: [{ id: 'op4-v1', template: state.supply.receiptTemplates.kit }], selected: [], plansBefore: [beforePlan], plansAfter: [afterPlan], changes: [{ before, after }], itemLabels: state.supply.log.at(-1)!.itemLabels });
  expect(() => parse(JSON.stringify(wire))).not.toThrow();
});
