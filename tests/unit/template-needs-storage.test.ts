import { afterEach, describe, expect, test } from 'vitest';
import { changeMasters, practiceLedger, start, type Meta } from '../../src/domain/ledger.ts';
import { emptySupply, registerNeed, reviseNeed } from '../../src/domain/supply.ts';
import { abandon, commit, faults, initial, load, parse, replace, retry, serialize, serializePending, targetsOf, type Pending, type Snapshot, type StoreLike } from '../../src/ui/storage.ts';
import { decodePending } from '../../src/ui/storageparse.ts';
import { backupTextOf, crc32, readBackup } from '../../src/ui/backup.ts';
import { buildTemplateNeedGeneration, generateTemplateNeeds, templateNeedContextOf } from '../../src/domain/template-needs.ts';
import { saveReceiptTemplate, type ReceiptTemplate } from '../../src/domain/receipt-template.ts';
import { applyNeedImport, previewNeedImport, previewNeedImportResolution, resolveNeedImport, type NeedRow } from '../../src/domain/need-import.ts';
import { supplyEventItemIds } from '../../src/domain/history-targets.ts';
import { supplyEventText } from '../../src/ui/supply-format.ts';

const meta = (eventId: string): Meta => ({ eventId, actor: '架空担当A', occurredAt: '2026-10-30T09:00:00+09:00', recordedAt: '2026-10-30T09:00:00+09:00' });
const need = { project: { kind: 'case', id: 'A-001' } as const, item: 'P', unit: '個', required: { basis: 'label', value: 20 } as const, dueDate: null, source: '架空部品表', revision: '1' };
const template: ReceiptTemplate = { id: 'kit', name: '架空標準部品表', product: 'R', project: null, basis: 'counted', rows: [{ item: 'P', unit: '個', perSet: 2, location: 'S1' }] };
const input = { templateId: 'kit', caseCode: '000007', count: 10, dueDate: '2026-11-10' };
const saved = () => ({ ledger: practiceLedger, supply: saveReceiptTemplate(practiceLedger, emptySupply, meta('save'), template) });
const generated = () => generateTemplateNeeds(saved(), meta('gen'), input);
const snapshot = () => { const state = generated(); return initial(state.ledger, state.supply); };
const wire = () => JSON.parse(serialize(snapshot()));
const pending = (s: Pick<Snapshot, 'ledger' | 'supply'>): Pending => ({ progress: 'saving', unknownSince: null, savingSince: meta('p').recordedAt, baseRevision: 0, opId: 'op1', opLabel: 'セットから必要明細を生成', fingerprint: '架空入力', values: { caseCode: '000007' }, actor: '架空担当A', startedAt: meta('p').recordedAt, units: [{ ledger: s.ledger, supply: s.supply, conflictReviews: [], targets: ['必要明細gen-n1'] }] });
const envelope = (value: ReturnType<typeof wire>) => ({ format: 'fuzzy-stock-pending', version: 13, quantities: value.quantities, pending: { ...pending(value), units: [{ ledger: value.ledger, supply: value.supply, conflictReviews: [], targets: [] }] } });
const bytes = (text: string) => new TextEncoder().encode(text);
const backup = (value: ReturnType<typeof wire>) => {
  const text = JSON.stringify(value), at = meta('p').recordedAt;
  return bytes(JSON.stringify({ notice: '架空試験', format: 'fuzzy-stock-backup', version: 1, createdAt: at, crc32: crc32(bytes(`${at}\n${text}`)).toString(16).padStart(8, '0'), snapshot: text }));
};
class Memory implements StoreLike {
  readonly data = new Map<string, string>();
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { this.data.set(key, value); }
  removeItem(key: string): void { this.data.delete(key); }
}
afterEach(() => { faults.loseResponseAt = null; faults.failMidwayAt = null; });

describe('Task2.2 保存版と生成済み案件の旧入口保護', () => {
  test('現在writerは保存版13を出力する', () => {
    expect(JSON.parse(serialize(initial(practiceLedger, emptySupply))).version).toBe(13);
  });
  test('計画がある案件は旧登録と旧改訂から変更できない', () => {
    const { ledger, supply } = generated();
    expect(() => registerNeed(supply, ledger.masters, meta('add'), { ...need, project: { kind: 'case', id: input.caseCode }, item: 'Q' })).toThrow('生成');
    expect(() => reviseNeed(supply, ledger.masters, meta('edit'), 'gen-n1', { ...need, required: { basis: 'label', value: 10 } })).toThrow('生成');
  });
  test('版13のsnapshot・pending・backupに必要数と原文コード・初回版が残る', () => {
    const s = snapshot();
    expect(parse(serialize(s))).toEqual(s);
    expect(decodePending(JSON.parse(serializePending(pending(s))))).toEqual(pending(s));
    expect(readBackup(bytes(backupTextOf(s, meta('p').recordedAt)))).toMatchObject({ kind: 'ok', snapshot: s });
    expect(s.ledger.masters.cases['000007']?.code).toBe('000007');
    expect(s.supply.log.filter(e => e.kind === 'templateNeeds')).toHaveLength(1);
    expect(s.supply.templateNeeds['000007']).toMatchObject({ initialVersion: 'gen-v1', count: 10 });
    expect(s.supply.needs['gen-n1']?.required).toEqual({ basis: 'label', value: 20 });
    expect(targetsOf(saved(), s)).toEqual(['案件000007', '必要明細gen-n1']);
  });
  const corruptions: [string, (value: ReturnType<typeof wire>) => void][] = [
    ['計画欠落', value => { delete value.supply.templateNeeds['000007']; }],
    ['計画余分', value => { value.supply.templateNeeds.other = value.supply.templateNeeds['000007']; }],
    ['計画key', value => { value.supply.templateNeeds.other = value.supply.templateNeeds['000007']; delete value.supply.templateNeeds['000007']; }],
    ['台数', value => { value.supply.log[1].plansAfter[0].count = 11; value.supply.templateNeeds['000007'].count = 11; }],
    ['初回版', value => { value.supply.log[1].plansAfter[0].initialVersion = 'future'; }],
    ['未来版', value => { value.supply.log[1].plansAfter[0].version = 'future'; }],
    ['版欠落', value => { value.supply.log[1].versions = []; }],
    ['版重複', value => { value.supply.log[1].versions.push(value.supply.log[1].versions[0]); }],
    ['未知版の写し', value => { value.supply.log[1].versions[0].template.name = '知らない版'; }],
    ['変更前', value => { value.supply.log[1].changes[0].before = value.supply.log[1].changes[0].after; }],
    ['計画変更前', value => { value.supply.log[1].plansBefore[0] = value.supply.log[1].plansAfter[0]; }],
    ['明細欠落', value => { delete value.supply.needs['gen-n1']; }],
    ['明細余分', value => { value.supply.needs.extra = { ...value.supply.needs['gen-n1'], id: 'extra' }; }],
    ['明細key', value => { value.supply.needs.extra = value.supply.needs['gen-n1']; delete value.supply.needs['gen-n1']; }],
    ['現在必要数', value => { value.supply.needs['gen-n1'].required.value = 19; }],
    ['計算値', value => { value.supply.log[1].changes[0].after.required.value = 19; value.supply.needs['gen-n1'].required.value = 19; }],
    ['由来', value => { value.supply.log[1].plansAfter[0].origins[0].origin = 'custom'; }],
    ['由来重複', value => { value.supply.log[1].plansAfter[0].origins.push(value.supply.log[1].plansAfter[0].origins[0]); }],
    ['由来needId', value => { value.supply.log[1].plansAfter[0].origins[0].needId = 'other'; }],
    ['余分な属性', value => { value.supply.log[1].changes[0].after.extra = '未対応'; }],
    ['記録時品目名欠落', value => { value.supply.log[1].itemLabels = { kind: 'legacy-unavailable' }; }],
    ['既存0明細', value => { value.supply.log.splice(1, 0, { ...meta('old'), itemLabels: { kind: 'legacy-unavailable' }, kind: 'needRegister', need: { ...value.supply.needs['gen-n1'], id: 'old', required: { basis: 'label', value: 0 } } }); }],
    ['保存前の生成', value => { value.supply.log.reverse(); }],
    ['二重生成', value => { value.supply.log.push(value.supply.log[1]); }],
  ];
  test.each(corruptions)('%sを通常・pending・backupの共通境界で拒否する', (_name, corrupt) => {
    const value = wire(); corrupt(value);
    expect(() => parse(JSON.stringify(value))).toThrow();
    expect(() => decodePending(envelope(value))).toThrow();
    expect(readBackup(backup(value)).kind).toBe('unreadable');
  });
  // 通常の記録は進み具合の確認で止まるが、読込・復元・保存中の操作の再試行はそこを通らないので、案件の詳細を描けない状態を読まず、書かない。
  describe('案件の進み具合を0.1の精度で表せない状態', () => {
    const items = practiceLedger.masters.items, ledger = { ...practiceLedger, masters: { ...practiceLedger.masters, items: { ...items, R: { ...items['R']!, unitSteps: { 台: 0.1 as const } } } } };
    const kit: ReceiptTemplate = { ...template, productUnit: '台', rows: [{ item: 'P', unit: '個', perSet: 1, location: 'S1' }] };
    const plan = () => generateTemplateNeeds({ ledger, supply: saveReceiptTemplate(ledger, emptySupply, meta('save'), kit) }, meta('gen'), { ...input, count: 562949953421313 });
    const lot = { id: 'W1', item: 'R', unit: '台', project: { kind: 'case', id: input.caseCode } as const, location: 'S1' };
    const startedOf = (state: ReturnType<typeof plan>) => ({ ...state, ledger: start(state.ledger, meta('s1'), lot, { id: 'R組立', criterion: 'inspection' }, 'counted', 0.1, []) });
    const message = `案件${input.caseCode}の作業で使った台数・未使用の残りが上限を超える`;

    test('写しは snapshot・backup・保存先の読込で拒否する', () => {
      const state = startedOf(plan()), text = serialize(initial(state.ledger, state.supply));
      expect(() => parse(text)).toThrow(message);
      expect(readBackup(backup(JSON.parse(text))).kind).toBe('unreadable');
      const store = new Memory(); store.setItem('fuzzy-stock/head', 'A'); store.setItem('fuzzy-stock/slot-A', text);
      expect(load(store).kind).toBe('unreadable');
    });

    test('保存はせず、保存先を変えない', () => {
      const store = new Memory(), base = plan(), current = replace(store, null, initial(base.ledger, base.supply)), before = [...store.data];
      const state = startedOf(current);
      expect(commit(store, current, pending(current), [{ ...state, conflictReviews: [], targets: targetsOf(current, state) }])).toMatchObject({ kind: 'failed', reason: expect.stringContaining(message) });
      expect([...store.data]).toEqual(before);
    });

    test('保存中の操作に残っていても読めて、再試行は保存先を変えずに拒否し、取り下げはできる', () => {
      const store = new Memory(), base = plan(), current = replace(store, null, initial(base.ledger, base.supply)), state = startedOf(current);
      store.setItem('fuzzy-stock/pending', serializePending({ ...pending(state), baseRevision: current.revision, units: [{ ...state, conflictReviews: [], targets: targetsOf(current, state) }] }));
      const loaded = load(store);
      if (loaded.kind !== 'ok' || loaded.pending === null) throw new Error(`保存中の操作が読めない: ${loaded.kind}`);
      const before = [...store.data];
      expect(retry(store, loaded.snapshot, loaded.pending, '架空担当A', meta('p').recordedAt)).toMatchObject({ kind: 'failed', reason: expect.stringContaining(message) });
      expect([...store.data]).toEqual(before);
      expect(abandon(store, loaded.snapshot, loaded.pending, '架空担当A', meta('p').recordedAt).kind).not.toBe('failed');
      expect(load(store)).toMatchObject({ kind: 'ok', pending: null });
    });
  });

  test('版12以前へ新欄または新イベントを混ぜず、空欄だけを補う', () => {
    const current = JSON.parse(serialize(initial(practiceLedger, emptySupply)));
    expect(() => parse(JSON.stringify({ ...current, version: 12 }))).toThrow('旧版');
    delete current.supply.templateNeeds;
    const legacy = { ...current, version: 12 };
    expect(parse(JSON.stringify(legacy)).supply.templateNeeds).toEqual({});
    const value = wire(); delete value.supply.templateNeeds; value.version = 12;
    expect(() => parse(JSON.stringify(value))).toThrow('旧版');
    const units = envelope(value); units.version = 12;
    expect(() => decodePending(units)).toThrow('旧版');
    const missing = wire(); delete missing.supply.templateNeeds;
    expect(() => parse(JSON.stringify(missing))).toThrow('templateNeeds');
  });
  test('後日の利用停止・セット改訂後も当時の計画は読めるが、改訂済み版を過去生成の版に偽装できない', () => {
    let state = generated();
    const ledger = changeMasters(state.ledger, meta('stop'), { action: 'deactivate', type: 'item', id: 'P', reason: '架空の停止' });
    expect(parse(serialize(initial(ledger, state.supply))).supply.needs).toEqual(state.supply.needs);
    state = { ...state, supply: saveReceiptTemplate(state.ledger, state.supply, meta('revise'), { ...template, name: '架空第2版' }) };
    const value = JSON.parse(serialize(initial(state.ledger, state.supply)));
    value.supply.log[1].versions[0].template = value.supply.log[2].after;
    expect(() => parse(JSON.stringify(value))).toThrow();
  });
  test('再利用版からも製品・子品目の記録時ラベルを収集する', () => {
    const state = generated(), next = generateTemplateNeeds(state, meta('gen2'), { ...input, caseCode: 'A-001' });
    const event = next.supply.log.at(-1)!;
    expect(event.kind).toBe('templateNeeds');
    if (event.kind !== 'templateNeeds' || event.action !== 'generate') throw new Error('生成イベントがない');
    expect(event.versions).toEqual([]);
    expect(supplyEventItemIds(event, next)).toEqual(['P', 'R']);
    expect(event.itemLabels).toMatchObject({ kind: 'recorded', items: { P: { name: '架空部品P' }, R: { name: '架空半製品R' } } });
    expect(supplyEventText(next.ledger.masters, event)).toContain('10台');
    expect(parse(serialize(initial(next.ledger, next.supply))).supply).toEqual(next.supply);
  });
  test('再利用版での生成に、参照しない別セットの既知版を余分に導入できない', () => {
    const base = saved(), other = { ...template, id: 'other', name: '架空の別セット' };
    const supply = saveReceiptTemplate(base.ledger, base.supply, meta('save-other'), other);
    const first = generateTemplateNeeds({ ...base, supply }, meta('gen'), input);
    const second = generateTemplateNeeds(first, meta('gen2'), { ...input, caseCode: 'A-001' });
    const value = JSON.parse(serialize(initial(second.ledger, second.supply)));
    value.supply.log[3].versions.push({ id: 'gen2-v1', template: value.supply.log[1].after });
    expect(() => parse(JSON.stringify(value))).toThrow();
    expect(() => decodePending(envelope(value))).toThrow();
    expect(readBackup(backup(value)).kind).toBe('unreadable');
  });
  test('生成素材が上限内でも最終itemLabels込みで1MiBを超えれば確定せず元状態を保つ', () => {
    const base = saved(), ledger = changeMasters(base.ledger, meta('rename'), { action: 'rename', type: 'item', id: 'P', name: '架'.repeat(400000), reason: '架空の長い名称' });
    const state = { ...base, ledger }, before = JSON.stringify(state);
    expect(buildTemplateNeedGeneration(state, templateNeedContextOf(state.supply), meta('gen'), input).needs).toHaveLength(1);
    expect(() => generateTemplateNeeds(state, meta('gen'), input)).toThrow('1MiB');
    expect(JSON.stringify(state)).toBe(before);
  });
  test('保留は後で生成した明細を参照しても読める。通常取込・変更なし取込・保留applyを拒否しdismissは許可する', () => {
    const row: NeedRow = { format: 'fuzzy-stock-need-row', version: 1, source: '架空部品表', line: '001', revision: '1', previousRevision: null, caseCode: '000007', itemCode: 'P', unit: '個', required: { basis: 'label', value: 20 }, dueDate: null };
    const raw = JSON.stringify(row), before = saved();
    const held = applyNeedImport(before.supply, before.ledger.masters, meta('held'), raw, previewNeedImport(before.supply, before.ledger.masters, raw).token);
    const state = generateTemplateNeeds({ ...before, supply: held }, meta('gen'), input);
    expect(() => previewNeedImport(state.supply, state.ledger.masters, raw)).toThrow('生成');
    expect(() => applyNeedImport(state.supply, state.ledger.masters, meta('again'), raw, 'old')).toThrow('生成');
    expect(() => previewNeedImportResolution(state.supply, state.ledger.masters, 'held', 'apply', 'gen-n1')).toThrow('生成');
    const preview = previewNeedImportResolution(state.supply, state.ledger.masters, 'held', 'dismiss', '');
    const supply = resolveNeedImport(state.supply, state.ledger.masters, meta('dismiss'), 'held', 'dismiss', '', '生成した必要明細で扱う', preview.token);
    expect(parse(serialize(initial(state.ledger, supply))).supply).toEqual(supply);
  });
  test('旧登録・改訂・取込applyの後付けで生成した明細を変えた履歴を拒否する', () => {
    const value = wire(), generatedNeed = value.supply.needs['gen-n1'];
    for (const detail of [{ kind: 'needRegister', need: { ...generatedNeed, id: 'extra', item: 'Q' } }, { kind: 'needRevise', before: generatedNeed, after: { ...generatedNeed, required: { basis: 'label', value: 19 } } }]) {
      const altered = wire(); altered.supply.log.push({ ...meta('old-entry'), itemLabels: { kind: 'legacy-unavailable' }, ...detail });
      expect(() => parse(JSON.stringify(altered))).toThrow('生成');
    }
  });
  test('生成明細を候補に持つ取込保留は読めるが、applyで変更する履歴は拒否する', () => {
    const value = wire(), current = value.supply.needs['gen-n1'];
    const row: NeedRow = { format: 'fuzzy-stock-need-row', version: 1, source: current.source, line: '001', revision: current.revision, previousRevision: null, caseCode: '000007', itemCode: 'P', unit: current.unit, required: current.required, dueDate: current.dueDate };
    value.supply.log.push({ ...meta('held'), itemLabels: { kind: 'legacy-unavailable' }, kind: 'needImport', input: { row, raw: JSON.stringify(row) }, decision: { kind: 'hold', reasons: ['架空の照合待ち'], candidates: ['gen-n1'] } });
    expect(parse(JSON.stringify(value)).supply.needs['gen-n1']).toEqual(current);
    expect(decodePending(envelope(value)).units[0]?.supply.needs['gen-n1']).toEqual(current);
    value.supply.log.push({ ...meta('apply'), itemLabels: { kind: 'legacy-unavailable' }, kind: 'needImportResolve', importEventId: 'held', reason: '架空の照合', resolution: { kind: 'apply', before: current, after: current } });
    expect(() => parse(JSON.stringify(value))).toThrow('生成');
    expect(() => decodePending(envelope(value))).toThrow('生成');
    expect(readBackup(backup(value)).kind).toBe('unreadable');
  });
  test('一単位の保存失敗で元snapshotと案件登録を置換しない', () => {
    const store = new Memory(), base = saved(), current = replace(store, null, initial(base.ledger, base.supply));
    const state = generateTemplateNeeds(current, meta('op1'), input), head = store.getItem('fuzzy-stock/head'), raw = store.getItem(`fuzzy-stock/slot-${head}`);
    faults.failMidwayAt = 1;
    expect(commit(store, current, pending(current), [{ ...state, conflictReviews: [], targets: targetsOf(current, state) }]).kind).toBe('failed');
    expect(store.getItem('fuzzy-stock/head')).toBe(head);
    expect(store.getItem(`fuzzy-stock/slot-${head}`)).toBe(raw);
    expect(current.ledger.masters.cases['000007']).toBeUndefined();
    expect(current.supply.templateNeeds).toEqual({});
  });
  test('保存応答不明でも全明細と案件登録を一単位で照会・再試行し、失敗時には元保存を保つ', () => {
    const store = new Memory(), base = saved(), current = replace(store, null, initial(base.ledger, base.supply));
    const state = generateTemplateNeeds(current, meta('op1'), input);
    faults.loseResponseAt = 1;
    const result = commit(store, current, { ...pending(current), opId: 'op1' }, [{ ...state, conflictReviews: [], targets: targetsOf(current, state) }]);
    expect(result.kind).toBe('unknown');
    if (result.kind !== 'unknown') throw new Error('応答不明の生成が必要');
    faults.loseResponseAt = null;
    const loaded = load(store);
    if (loaded.kind !== 'ok' || loaded.pending === null) throw new Error('生成の保存途中が読めない');
    const done = retry(store, loaded.snapshot, loaded.pending, '架空担当A', meta('p').recordedAt);
    expect(['recovered', 'saved']).toContain(done.kind);
    if (done.kind !== 'recovered' && done.kind !== 'saved') throw new Error('生成の再試行に失敗');
    expect(done.snapshot.supply.log.filter(e => e.kind === 'templateNeeds')).toHaveLength(1);
    expect(done.snapshot.ledger.history.filter(e => e.eventId === 'op1-c1')).toHaveLength(1);
    expect(Object.values(done.snapshot.supply.needs)).toHaveLength(1);
  });
});
