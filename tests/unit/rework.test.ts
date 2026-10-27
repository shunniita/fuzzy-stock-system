import { describe, expect, test } from 'vitest';
import { beginRework, changeMasters, changeStage, correctOccurredAt, declareDiscrepancy, practiceLedger as practiceBase, handOver, hold, InclusionRequired, isUsable, merge, productionOf, recount, recordReworkPart, register, release, reworksOf, split, start, totalOf, use, voidRecord, type Ledger, type Meta, type Process, type Project } from '../../src/domain/ledger.ts';
import { withProcesses } from './process-fixture.ts';
const practiceLedger = withProcesses(practiceBase, { id: '架空組立', criterion: 'workEnd' }, { id: '架空検査組立', criterion: 'inspection' });
// 同じ工程IDの完了基準は一つなので、完了基準ごとに別の工程を使う。
const processFor = (criterion: Process['criterion']): Process => criterion === 'workEnd' ? process : { id: '架空検査組立', criterion };

const project = { kind: 'case', id: 'A-001' } satisfies Project;
const process = { id: '架空組立', criterion: 'workEnd' } satisfies Process;
const meta = (eventId: string, hour = 12): Meta => ({ eventId, occurredAt: `2026-10-14T${String(hour).padStart(2, '0')}:00:00+09:00`, recordedAt: '2026-10-14T22:00:00+09:00', actor: '架空担当A' });
const product = (id: string) => ({ id, item: 'R', unit: '台', project, location: 'T' });
const part = (id: string, owner: Project = project) => ({ id, item: 'P', unit: '個', project: owner, location: 'S1' });
function base(criterion: Process['criterion'] = 'workEnd'): Ledger {
  let l = register(practiceLedger, meta('parts', 8), part('parts'), 'counted', 100);
  l = use(l, meta('original-use', 9), 'parts', 'counted', 20, '初回組立');
  l = start(l, meta('start', 10), product('working'), processFor(criterion), 'counted', 20, ['original-use']);
  return changeStage(l, meta('complete', 11), 'working', 'finished', 'counted', 20, { kind: 'awaitingHandover', process: processFor(criterion) });
}
const begun = () => beginRework(base(), meta('rework'), 'finished', 'repair', 'counted', 2, '架空のやり直し・修理');
const count = (l: Ledger, id: string) => l.lots[id]?.quantity;

describe('AT-16・やり直し・修理の元現物と数量', () => {
  test('1.1〜1.3・2.1〜2.2・3.1〜3.2: 20台のうち2台をやり直し・修理し交換部品2個だけ使って再完了', () => {
    const original = base();
    let l = beginRework(original, meta('rework'), 'finished', 'repair', 'counted', 2, '架空のやり直し・修理');
    expect(count(original, 'finished')).toMatchObject({ numeric: { value: 20 } });
    expect(count(l, 'finished')).toMatchObject({ numeric: { value: 18 } });
    expect(l.lots['repair']).toMatchObject({ splitFrom: 'finished', item: 'R', unit: '台', project, location: 'T', stage: { kind: 'working', process }, quantity: { numeric: { value: 2 } } });
    expect(totalOf(l, 'R')).toMatchObject({ numeric: { value: 20 } });
    expect(productionOf(l, process.id, 'R', '台', project)).toMatchObject({ reworkStarted: { numeric: { value: 2 } }, returned: { numeric: { value: 0 } } });
    l = recordReworkPart(l, meta('replace', 13), { action: 'replace', reworkId: 'rework', subjectLotId: 'repair', lotId: 'parts', value: 2, reason: '交換2個' });
    expect(count(l, 'parts')).toMatchObject({ numeric: { value: 78 } });
    l = changeStage(l, meta('recomplete', 14), 'repair', 'repaired', 'counted', 2, { kind: 'awaitingHandover', process });
    expect(productionOf(l, process.id, 'R', '台', project)).toMatchObject({ working: { numeric: { value: 0 } }, awaitingHandover: { numeric: { value: 20 } }, completed: { numeric: { value: 22 } }, reworkStarted: { numeric: { value: 2 } }, returned: { numeric: { value: 0 } } });
    expect(totalOf(l, 'R')).toMatchObject({ numeric: { value: 20 } });
    expect(l.history.filter(e => e.kind === 'use')).toHaveLength(2);
    expect(l.history.find(e => e.eventId === 'original-use')).toEqual(original.history.find(e => e.eventId === 'original-use'));
  });

  test.each(['counted', 'label', 'approximate'] as const)('1.3: 取り出し根拠%sと取り分けた理由を引き継ぐ', basis => {
    const l = beginRework(hold(base(), meta('hold'), 'finished', 'defective'), meta('rw', 13), 'finished', 'repair', basis, 2, '修理');
    expect(l.lots['repair']?.holds).toEqual(['defective']);
    expect(count(l, 'repair')?.terms).toEqual([{ sign: 1, observation: { id: 'rw', basis, value: 2 } }]);
  });

  test.each([0, -1, 21, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null])('1.4: 不正・過量%sは元と子を変更しない', value => {
    const l = base(), before = JSON.stringify(l);
    expect(() => beginRework(l, meta('rw'), 'finished', 'repair', 'counted', value, '修理')).toThrow();
    expect(JSON.stringify(l)).toBe(before);
  });

  test('1.4: 未解決・数が不明・作業なし・ID重複・理由なしを拒否', () => {
    const l = base();
    const issue = declareDiscrepancy(l, meta('issue'), 'finished', '数量差');
    expect(() => beginRework(issue, meta('rw', 13), 'finished', 'repair', 'counted', 2, '修理')).toThrow(/確認事項/);
    const unknown = register(practiceLedger, meta('unknown', 8), { ...product('unknown'), stage: { kind: 'awaitingHandover', process } }, 'unknown', null);
    expect(() => beginRework(unknown, meta('rw'), 'unknown', 'repair', 'counted', 2, '修理')).toThrow(/数量/);
    expect(() => beginRework(l, meta('rw'), 'parts', 'repair', 'counted', 2, '修理')).toThrow(/完成（渡す前）/);
    expect(() => beginRework(l, meta('rw'), 'finished', 'parts', 'counted', 2, '修理')).toThrow(/ID/);
    expect(() => beginRework(l, meta('rw'), 'finished', 'repair', 'counted', 2, ' ')).toThrow(/理由/);
  });

  test('1.5: 数え直し以前のやり直し・修理は包含未回答・含む・不明で子を作らない', () => {
    const l = recount(base(), meta('count', 14), 'finished', 20, { kind: 'unknown' });
    const run = (answer?: 'included' | 'notIncluded' | 'unknown') => beginRework(l, meta('rw', 13), 'finished', 'repair', 'counted', 2, '修理', answer);
    expect(() => run()).toThrow(InclusionRequired);
    expect(() => run('included')).toThrow(/確認/);
    expect(() => run('unknown')).toThrow(/確認/);
    expect(totalOf(run('notIncluded'), 'R')).toMatchObject({ numeric: { value: 20 } });
  });

  test('1.3: 場所の利用停止後も既存現物の場所を継承してやり直し・修理できる', () => {
    const l = changeMasters(base(), meta('deactivate'), { action: 'deactivate', type: 'location', id: 'T', reason: '新しい配置を止める' });
    const next = beginRework(l, meta('rework', 13), 'finished', 'repair', 'counted', 2, 'その場で修理');
    expect(next.lots['repair']?.location).toBe('T');
    expect(totalOf(next, 'R')).toMatchObject({ numeric: { value: 20 } });
  });

  test.each(['O', 'OUT'])('1.4: 記録の対象外・外%sの現物はやり直し・修理しない', location => {
    const original = changeMasters(base(), meta('scope'), { action: 'scope', id: 'O', inScope: false, reason: '管理範囲から外す' });
    const l = { ...original, lots: { ...original.lots, finished: { ...original.lots['finished']!, location } } };
    const before = JSON.stringify(l);
    expect(() => beginRework(l, meta('rework', 13), 'finished', 'repair', 'counted', 2, '修理')).toThrow(/記録の対象外|手元/);
    expect(JSON.stringify(l)).toBe(before);
  });

  test('2.1: 検査を経て再完了しても20台', () => {
    let l = beginRework(base('inspection'), meta('rw'), 'finished', 'repair', 'counted', 2, '修理');
    const inspection = processFor('inspection');
    l = changeStage(l, meta('end', 13), 'repair', 'inspect', 'counted', 2, { kind: 'inspecting', process: inspection });
    l = changeStage(l, meta('check', 14), 'inspect', 'done', 'counted', 2, { kind: 'awaitingHandover', process: inspection });
    expect(productionOf(l, inspection.id, 'R', '台', project).awaitingHandover).toMatchObject({ numeric: { value: 20 } });
  });

  test('2.3: 別のやり直し・修理を混同せず、分割・統合・再度のやり直し・修理を追跡する', () => {
    let l = beginRework(begun(), meta('sibling', 13), 'finished', 'sibling', 'counted', 1, '別の現物');
    expect(reworksOf(l, 'repair').map(e => e.eventId)).toEqual(['rework']);
    l = split(l, meta('split', 14), 'repair', 'half', 'counted', 1);
    expect(reworksOf(l, 'half').map(e => e.eventId)).toEqual(['rework']);
    l = merge(l, meta('merge', 15), 'half', 'sibling');
    expect(new Set(reworksOf(l, 'sibling').map(e => e.eventId))).toEqual(new Set(['rework', 'sibling']));
    l = changeStage(l, meta('done', 16), 'sibling', 'done', 'counted', 2, { kind: 'awaitingHandover', process });
    l = beginRework(l, meta('again', 17), 'done', 'again', 'counted', 1, '再やり直し・修理');
    expect(new Set(reworksOf(l, 'again').map(e => e.eventId))).toEqual(new Set(['rework', 'sibling', 'again']));
    expect(productionOf(l, process.id, 'R', '台', project).reworkStarted).toMatchObject({ numeric: { value: 4 } });
    expect(totalOf(l, 'R')).toMatchObject({ numeric: { value: 20 } });
  });

  test('R2c: 新規作業中と統合しても、やり直し・修理開始累計を現在の工程内数から推定しない', () => {
    const l = register(begun(), meta('new', 13), { ...product('new'), stage: { kind: 'working', process } }, 'counted', 3);
    const combined = merge(l, meta('mixed', 14), 'repair', 'new');
    expect(productionOf(combined, process.id, 'R', '台', project)).toMatchObject({ working: { numeric: { value: 5 } }, reworkStarted: { numeric: { value: 2 } } });
    const beforeTotal = totalOf(l, 'R'), afterTotal = totalOf(combined, 'R');
    expect(afterTotal).toMatchObject({ kind: 'known', numeric: { value: 23, approximate: false, unconfirmed: 'none' } });
    expect(afterTotal.terms.map(term => JSON.stringify(term)).sort()).toEqual(beforeTotal.terms.map(term => JSON.stringify(term)).sort());
  });

  test('2.4: やり直し・修理由来の過量分割・完了、包含済みの分割で子だけを作らない', () => {
    const l = begun();
    expect(() => split(l, meta('split', 13), 'repair', 'extra', 'counted', 3)).toThrow();
    expect(() => changeStage(l, meta('done', 13), 'repair', 'extra', 'counted', 3, { kind: 'awaitingHandover', process })).toThrow();
    const counted = recount(l, meta('count', 14), 'repair', 2, { kind: 'unknown' });
    expect(() => split(counted, meta('split', 13), 'repair', 'extra', 'counted', 1, 'included')).toThrow();
    expect(l.lots['extra']).toBeUndefined();
  });
});

describe('FH-C06・やり直し・修理の部品処置', () => {
  test('R2: 再完了・外引渡しの後でも、元のやり直し・修理中の実処置を後入力できる', () => {
    let l = changeStage(begun(), meta('done', 13), 'repair', 'done', 'counted', 2, { kind: 'awaitingHandover', process });
    l = handOver(l, meta('outside', 14), 'done', 'counted', 2, '架空の外');
    const delayed = { ...meta('late'), occurredAt: '2026-10-14T12:30:00+09:00', recordedAt: '2026-10-14T15:00:00+09:00' };
    const next = recordReworkPart(l, delayed, { action: 'replace', reworkId: 'rework', subjectLotId: 'repair', lotId: 'parts', value: 2, reason: '手直し中の実処置を後入力' });
    expect(next.lots.parts?.quantity).toMatchObject({ numeric: { value: 78 } });
    expect(next.history.at(-1)).toMatchObject({ occurredAt: delayed.occurredAt, recordedAt: delayed.recordedAt });
    expect(totalOf(next, 'R')).toEqual(totalOf(l, 'R'));
  });

  test('R2b: 利用停止中の案件・用途への新しい回収Lotは拒否し、明示的な利用再開後に記録する', () => {
    const stopped = changeMasters(begun(), meta('stop-case'), { action: 'deactivate', type: 'case', id: 'A-001', reason: '新規記録を止める' });
    const request = { action: 'recover', reworkId: 'rework', subjectLotId: 'repair', lotId: 'recovered', item: 'P', unit: '個', location: 'S1', value: 1, reason: '実回収' } as const;
    const before = JSON.stringify(stopped);
    expect(() => recordReworkPart(stopped, meta('recover', 13), request)).toThrow(/案件・用途.*利用停止/);
    expect(JSON.stringify(stopped)).toBe(before);
    const active = changeMasters(stopped, meta('resume-case', 14), { action: 'reactivate', type: 'case', id: 'A-001', reason: '回収登録のため再開' });
    expect(recordReworkPart(active, meta('recover', 15), request).lots.recovered?.project).toEqual(project);
  });

  test('R2d: 利用停止中の品目を新たな廃棄記録に指定せず、利用再開後も未使用品は減らさない', () => {
    const stopped = changeMasters(begun(), meta('stop-part'), { action: 'deactivate', type: 'item', id: 'P', reason: '新規記録を止める' });
    const request = { action: 'discard', reworkId: 'rework', subjectLotId: 'repair', item: 'P', unit: '個', value: 1, reason: '実廃棄' } as const;
    const before = JSON.stringify(stopped);
    expect(() => recordReworkPart(stopped, meta('discard', 13), request)).toThrow(/品目.*利用停止/);
    expect(JSON.stringify(stopped)).toBe(before);
    const active = changeMasters(stopped, meta('resume-part', 14), { action: 'reactivate', type: 'item', id: 'P', reason: '廃棄記録のため再開' });
    expect(recordReworkPart(active, meta('discard', 15), request).lots).toEqual(active.lots);
  });

  test('3.3〜3.4: 共通部品を明示使用でき、二重作業の開始と単独取消は拒否', () => {
    let l = register(begun(), meta('common', 8), part('common', { kind: 'common' }), 'counted', 3);
    l = recordReworkPart(l, meta('replace', 13), { action: 'replace', reworkId: 'rework', subjectLotId: 'repair', lotId: 'common', value: 2, reason: '実際の交換' });
    const e = l.history.find(e => e.eventId === 'replace');
    if (e?.kind !== 'reworkPart' || e.action !== 'replace') throw new Error('交換の対応記録がない');
    expect(() => voidRecord(l, meta('void', 14), e.useEventId, '誤り')).toThrow(/対応/);
    expect(() => start(l, meta('other', 14), product('other'), process, 'counted', 1, [e.useEventId])).toThrow(/対応/);
    expect(count(l, 'common')).toMatchObject({ numeric: { value: 1 } });
  });

  test('3.3: 別案件・用途・除外・過量・包含あり・未解決は一部だけ記録しない', () => {
    const l = register(begun(), meta('foreign', 8), part('foreign', { kind: 'case', id: 'A-002' }), 'counted', 5);
    const attempt = (ledger: Ledger, id: string, value = 2, answer?: 'included') => recordReworkPart(ledger, meta('replace', 13), { action: 'replace', reworkId: 'rework', subjectLotId: 'repair', lotId: id, value, reason: '交換' }, answer);
    for (const [ledger, id, value] of [[l, 'foreign', 2], [hold(l, meta('hold'), 'parts', 'defective'), 'parts', 2], [l, 'parts', 81], [declareDiscrepancy(l, meta('issue'), 'parts', '差'), 'parts', 2]] as const) {
      const before = JSON.stringify(ledger);
      expect(() => attempt(ledger, id, value)).toThrow();
      expect(JSON.stringify(ledger)).toBe(before);
    }
    expect(() => attempt(recount(l, meta('count', 14), 'parts', 80, { kind: 'unknown' }), 'parts', 2, 'included')).toThrow();
  });

  test('4.1〜4.3: 廃棄は未使用を変えず、実回収1個だけを確認待ちにする', () => {
    const original = begun();
    let l = recordReworkPart(original, meta('discard', 13), { action: 'discard', reworkId: 'rework', subjectLotId: 'repair', item: 'P', unit: '個', value: 1, reason: '取外し廃棄' });
    expect(l.lots).toEqual(original.lots);
    l = recordReworkPart(l, meta('recover', 14), { action: 'recover', reworkId: 'rework', subjectLotId: 'repair', lotId: 'recovered', item: 'P', unit: '個', location: 'S1', value: 1, reason: '取外し回収' });
    expect(l.lots['recovered']).toMatchObject({ project, holds: ['usabilityCheck'], quantity: { numeric: { value: 1 } } });
    const recovered = l.lots['recovered'];
    if (!recovered) throw new Error('回収品がない');
    expect(isUsable(recovered)).toBe(false);
    expect(count(l, 'parts')).toEqual(count(original, 'parts'));
    expect(totalOf(l, 'P')).toMatchObject({ numeric: { value: 81 } });
    l = release(l, meta('release', 15), 'recovered', 'usabilityCheck');
    expect(l.lots['recovered'] && isUsable(l.lots['recovered'])).toBe(true);
  });

  test.each([0, -1, 0.5, NaN, Infinity])('4.4: 廃棄/回収の不正量%sを推定しない', value => {
    const l = begun();
    expect(() => recordReworkPart(l, meta('discard', 13), { action: 'discard', reworkId: 'rework', subjectLotId: 'repair', item: 'P', unit: '個', value, reason: '廃棄' })).toThrow();
    expect(() => recordReworkPart(l, meta('recover', 13), { action: 'recover', reworkId: 'rework', subjectLotId: 'repair', lotId: 'recovered', item: 'P', unit: '個', location: 'S1', value, reason: '回収' })).toThrow();
  });

  test('4.4: 後半のID衝突と不正参照でも回収/使用を残さない', () => {
    const l = register(begun(), meta('collision', 8), part('extra'), 'counted', 1), before = JSON.stringify(l);
    expect(() => recordReworkPart(l, meta('collision', 13), { action: 'recover', reworkId: 'rework', subjectLotId: 'repair', lotId: 'recovered', item: 'P', unit: '個', location: 'S1', value: 1, reason: '回収' })).toThrow();
    expect(() => recordReworkPart(l, meta('collision', 13), { action: 'replace', reworkId: 'rework', subjectLotId: 'repair', lotId: 'parts', value: 1, reason: '交換' })).toThrow();
    expect(() => recordReworkPart(l, meta('missing', 13), { action: 'discard', reworkId: 'absent', subjectLotId: 'repair', item: 'P', unit: '個', value: 1, reason: '廃棄' })).toThrow();
    expect(JSON.stringify(l)).toBe(before);
  });

  test('5.3: 新規記録と日時訂正でやり直し・修理/部品/回収生成の順序を保つ', () => {
    let l = begun();
    expect(() => beginRework(base(), meta('rw', 10), 'finished', 'early', 'counted', 1, '修理')).toThrow(/前/);
    expect(() => recordReworkPart(l, meta('discard', 11), { action: 'discard', reworkId: 'rework', subjectLotId: 'repair', item: 'P', unit: '個', value: 1, reason: '廃棄' })).toThrow(/前/);
    l = recordReworkPart(l, meta('recover', 13), { action: 'recover', reworkId: 'rework', subjectLotId: 'repair', lotId: 'recovered', item: 'P', unit: '個', location: 'S1', value: 1, reason: '回収' });
    expect(() => correctOccurredAt(l, meta('correct', 14), 'rework', meta('after', 14).occurredAt)).toThrow();
    expect(() => correctOccurredAt(l, meta('correct', 14), 'recover', meta('before', 11).occurredAt)).toThrow();
    l = release(l, meta('release', 14), 'recovered', 'usabilityCheck');
    expect(() => use(l, meta('early-use', 12), 'recovered', 'counted', 1, '再利用')).toThrow(/前/);
  });

  // 日時不明を許すのは対象枝のない旧記録だけ。
  test.each(['replace', 'recover'] as const)('5.3: 旧記録の中間の%s日時が不明でも、既知の開始と対応付けを逆転させない', action => {
    const request = action === 'replace'
      ? { action, reworkId: 'rework', subjectLotId: 'repair', lotId: 'parts', value: 1, reason: '交換' }
      : { action, reworkId: 'rework', subjectLotId: 'repair', lotId: 'recovered', item: 'P', unit: '個', location: 'S1', value: 1, reason: '回収' };
    const l = recordReworkPart(begun(), meta('part', 13), request);
    const legacy: Ledger = { ...l, history: l.history.map(e => {
      if (!e.eventId.startsWith('part')) return e;
      if (e.kind !== 'reworkPart') return { ...e, occurredAt: null };
      const { subjectLotId: _, ...rest } = e;
      return { ...rest, occurredAt: null };
    }) };
    expect(() => correctOccurredAt(legacy, meta('fix', 14), 'part', meta('before', 11).occurredAt)).toThrow(/前後/);
  });
});
