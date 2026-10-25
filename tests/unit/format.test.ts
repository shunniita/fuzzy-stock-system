import { describe, expect, test } from 'vitest';
import { fixedMasters } from '../../src/domain/masters.ts';
import { changeStage, correctOccurredAt, recordStop, voidRecord, declareDiscrepancy, practiceLedger, merge, recount, register, resolveIssue, split, start, totalOf, use, type Meta, type Process, type Stage } from '../../src/domain/ledger.ts';
import { add, observe, quantityOf, subtract, type Basis } from '../../src/domain/quantity.ts';
import { cumulativeText, differenceText, materialsOf, stageChangeLabel, stopText, eventsOf, eventText, jst, lastCountText, lastUpdatedOf, quantityText, targetLabel, trialText } from '../../src/ui/format.ts';

test.each([
  ['まとまり別のまとまり', '保管単位別のまとまり'],
  ['元票「架空元票」・動き「まとまり001」', '元の資料「架空元票」・動き「まとまり001」'],
  ['依頼まとまり001', '依頼まとまり001'],
  ['保管・使用単位001', '保管・使用単位001'],
  ['照合事項案件・受入', '確認事項案件・受入'],
  ['停止案件・受入', '作業の中断案件・受入'],
  ['受入テンプレート案件・受入', 'セット案件・受入'],
  ['一括受入案件・受入', 'まとめて受け取り案件・受入'],
  ['レシピ推計案件・受入', 'セットの推計案件・受入'],
  ['案件案件・受入', '案件・用途案件・受入'],
  ['品目案件・受入', '品目案件・受入'],
])('保存対象の表示は接頭辞だけ変え、IDと入力原文を保つ: %s', (stored, shown) => {
  expect(targetLabel(stored)).toBe(shown);
});

const q = (id: string, basis: Basis, value: number | null) => quantityOf(observe(id, basis, value));

describe('FH-B05・RUN-04b: 試行対象の文言', () => {
  test.each([
    { item: 'P', location: 'S1', expected: '試行対象' },
    { item: 'V', location: 'N', expected: '試行対象' },
    { item: 'X', location: 'S1', expected: '対象外' },
    { item: 'P', location: 'O', expected: '対象外' },
    { item: 'X', location: 'O', expected: '対象外' },
    { item: '不明品目', location: 'S1', expected: '対象外' },
    { item: 'P', location: '不明場所', expected: '対象外' },
    { item: 'P', location: 'OUT', expected: '対象外' },
  ])('$item / $location → $expected（品目と場所の両方が対象のときだけ試行対象）', ({ item, location, expected }) => {
    expect(trialText(fixedMasters, { item, location })).toBe(expected);
  });
});

function meta(eventId: string, hour: number): Meta {
  const at = `2026-09-29T${String(hour).padStart(2, '0')}:00:00+09:00`;
  return { eventId, occurredAt: at, recordedAt: at, actor: '架空担当A' };
}

describe('数量の表示語（DESIGN_NOTES.md）', () => {
  test('AT-01: 数えた0・ラベル0・だいたい0・数が不明を別々に表示する', () => {
    expect(quantityText(q('e', 'counted', 0), '個')).toBe('0個・数えた');
    expect(quantityText(q('l', 'label', 0), '個')).toBe('0個・表示の数（ラベル・パッケージ）・中身未確認');
    expect(quantityText(q('a', 'approximate', 0), '個')).toBe('約0個・だいたい');
    expect(quantityText(q('u', 'unknown', null), '個')).toBe('数が不明');
  });

  test('AT-03・04・05: 集計の表示が根拠の混在と不明を隠さない', () => {
    expect(quantityText(add(q('e', 'counted', 100), q('a', 'approximate', 30)), '個')).toBe('記録上の数約130個');
    expect(quantityText(add(q('e', 'counted', 100), q('l', 'label', 30)), '個')).toBe('記録上の数130個・中身未確認部分あり');
    expect(quantityText(add(q('e', 'counted', 100), q('u', 'unknown', null)), '個')).toBe(
      '数値部分の小計100個、ほかに数が不明1件。全体数量は不明',
    );
  });

  test('ラベルだけの計算値は台帳の中身未確認、不明から引いた残りは直前の数量を参照として示す', () => {
    expect(quantityText(subtract(q('l', 'label', 100), q('e', 'counted', 30)), '個')).toBe('記録上の数70個・中身未確認');
    expect(quantityText(subtract(q('e', 'counted', 100), q('u', 'unknown', null)), '個')).toBe(
      '数が不明（残数不明。直前は100個・数えた）',
    );
  });

  test('AT-02: 使用後の70は台帳の計算値として表示し、最後に数えた数は10時の100と日本時間で示す', () => {
    const l = use(register(practiceLedger, meta('r1', 10), { id: 'X', item: 'P', unit: '個', project: { kind: 'common' }, location: 'S1' }, 'counted', 100), meta('u1', 11), 'X', 'counted', 30, '架空作業');
    const lot = l.lots.X!;
    expect(quantityText(lot.quantity, lot.unit)).toBe('記録上の数70個');
    expect(lastCountText(l, lot)).toBe('100個（2026-09-29 10:00（日本時間）、操作r1）');
    expect(quantityText(totalOf(l, 'P'), '個')).not.toContain('数えた');
  });

  test('AT-51: 時刻帯の違う日時を日本時間で表示し、日時不明を埋めない', () => {
    expect(jst('2026-09-29T01:30:00Z')).toBe('2026-09-29 10:30（日本時間）');
    expect(jst(null)).toBe('日時不明');
  });

  test('AT-21: 差異は符号付きで、訂正前が不明なら差異も不明', () => {
    expect(differenceText(subtract(q('c', 'counted', 52), subtract(q('e', 'counted', 60), q('u', 'counted', 7))), '個')).toBe('－1個');
    expect(differenceText(subtract(q('c', 'counted', 5), q('u', 'unknown', null)), '個')).toBe('不明');
  });

  test('QTY-12a: 保管単位の最終記録更新は、数量を変えない日時訂正・差異申告・照合の解消でも進む', () => {
    const lot = { id: 'X', item: 'P', unit: '個', project: { kind: 'common' }, location: 'S1' } as const;
    let l = register(practiceLedger, meta('r1', 9), lot, 'counted', 52);
    l = correctOccurredAt(l, meta('t1', 12), 'r1', '2026-09-29T08:00:00+09:00');
    expect(lastUpdatedOf(l, 'X')).toBe('2026-09-29T12:00:00+09:00');
    l = declareDiscrepancy(l, meta('d1', 13), 'X', '多い（架空）');
    expect(lastUpdatedOf(l, 'X')).toBe('2026-09-29T13:00:00+09:00');
    l = recount(l, meta('c1', 14), 'X', 52, { kind: 'unknown' });
    l = resolveIssue(l, { ...meta('v1', 14), eventId: 'v1', recordedAt: '2026-09-29T14:30:00+09:00' }, 'd1', 'close');
    expect(lastUpdatedOf(l, 'X')).toBe('2026-09-29T14:30:00+09:00');
    l = register(l, meta('r2', 15), { ...lot, id: 'Y' }, 'counted', 1);
    expect(lastUpdatedOf(l, 'X')).toBe('2026-09-29T14:30:00+09:00');
  });

  test('未反映の数え直しも対象の保管単位を示し、その保管単位の履歴に入る（Gemini）', () => {
    const lot = { id: 'X', item: 'P', unit: '個', project: { kind: 'common' }, location: 'S1' } as const;
    let l = use(register(practiceLedger, meta('r1', 9), lot, 'counted', 50), meta('u1', 11), 'X', 'counted', 10, '架空作業');
    l = recount(l, meta('c1', 10), 'X', 45, { kind: 'unknown' }, 'unknown');
    const event = l.history.at(-1)!;
    expect(eventText(l, event)).toContain('数えて確認：X 45個を数えた（それまでの記録上の数40個との差異＋5個）、原因不明・数量に反映していない（確認事項あり）');
    expect(eventsOf(l, 'X').map((e) => e.eventId)).toEqual(['r1', 'u1', 'c1']);
  });

  test('PR2-6: 統合元での操作の日時訂正は、統合先の履歴と最終記録更新に入る', () => {
    const lot = { id: 'X', item: 'P', unit: '個', project: { kind: 'common' }, location: 'S1' } as const;
    let l = register(practiceLedger, meta('r1', 9), lot, 'counted', 52);
    l = register(l, meta('r2', 9), { ...lot, id: 'Y' }, 'counted', 10);
    l = use(l, meta('u1', 10), 'X', 'counted', 5, '架空作業');
    l = merge(l, meta('g1', 11), 'X', 'Y');
    l = correctOccurredAt(l, meta('t1', 12), 'u1', '2026-09-29T08:50:00+09:00');
    expect(l.issues['u1@time']?.lotId).toBe('Y');
    expect(eventsOf(l, 'Y').map((e) => e.eventId)).toContain('t1');
    expect(lastUpdatedOf(l, 'Y')).toBe('2026-09-29T12:00:00+09:00');
  });
});

describe('工程完了累計の表示', () => {
  const counted = quantityOf(observe('a', 'counted', 10));
  const label = quantityOf(observe('b', 'label', 10));

  test('数えただけなら数だけ。計算値でも「台帳」は付けない', () => {
    expect(cumulativeText(counted, '台')).toBe('10台');
    expect(cumulativeText(add(counted, counted), '台')).toBe('20台');
  });

  test('表示の数（ラベル・パッケージ）を含む累計は、中身未確認の印を残す', () => {
    expect(cumulativeText(add(label, label), '台')).toBe('20台・中身未確認');
    expect(cumulativeText(add(counted, label), '台')).toBe('20台・中身未確認部分あり');
  });
});

describe('作業の状態の変更の呼び名', () => {
  const inspection: Process = { id: 'R組立', criterion: 'inspection' };
  const workEnd: Process = { id: 'R仮組', criterion: 'workEnd' };
  const at = (kind: 'working' | 'inspecting' | 'awaitingHandover', process = inspection): Stage => ({ kind, process });

  test('完了基準どおりの次の位置への変更だけを、作業終了・確認の完了・次工程への引渡しと呼ぶ', () => {
    expect(stageChangeLabel(at('working'), at('inspecting'))).toBe('作業終了');
    expect(stageChangeLabel(at('working', workEnd), at('awaitingHandover', workEnd))).toBe('作業終了');
    expect(stageChangeLabel(at('inspecting'), at('awaitingHandover'))).toBe('確認の完了');
    expect(stageChangeLabel(at('awaitingHandover'), { kind: 'none' })).toBe('次の作業へ渡す');
  });

  test('訂正の入力で記録した変更は、次の位置への変更でも訂正と呼ぶ', () => {
    expect(stageChangeLabel(at('working'), at('inspecting'), true)).toBe('作業の状態の訂正');
    expect(stageChangeLabel(at('awaitingHandover'), { kind: 'none' }, true)).toBe('作業の状態の訂正');
  });

  test('検査を飛ばした変更や戻しは、業務上の手順があったことにせず訂正と呼ぶ', () => {
    expect(stageChangeLabel(at('working'), at('awaitingHandover'))).toBe('作業の状態の訂正');
    expect(stageChangeLabel(at('awaitingHandover'), at('working'))).toBe('作業の状態の訂正');
    expect(stageChangeLabel({ kind: 'none' }, at('working'))).toBe('作業の状態の訂正');
  });
});

describe('作業の開始の材料の使用記録のたどり方（MFG-03a・06）', () => {
  const process: Process = { id: 'R組立', criterion: 'workEnd' };
  const part = (id: string) => ({ id, item: 'P', unit: '個', project: { kind: 'case', id: 'A-001' } as const, location: 'T' });
  const product = (id: string) => ({ id, item: 'R', unit: '台', project: { kind: 'case', id: 'A-001' } as const, location: 'T' });

  function twoStarts() {
    let l = register(practiceLedger, meta('p', 8), part('P1'), 'counted', 100);
    l = use(l, meta('u1', 9), 'P1', 'counted', 10, 'R1の作業の開始');
    l = use(l, meta('u2', 9), 'P1', 'counted', 20, 'R2の作業の開始');
    l = start(l, meta('s1', 10), product('R1'), process, 'counted', 10, ['u1']);
    return start(l, meta('s2', 10), product('R2'), process, 'counted', 20, ['u2']);
  }
  const ids = (l: ReturnType<typeof twoStarts>, lotId: string) => materialsOf(l, l.lots[lotId]!)?.map((e) => e.eventId);

  test('統合した相手の材料も、統合先とその後に分けた物からたどれる', () => {
    let l = merge(twoStarts(), meta('g', 11), 'R2', 'R1');
    expect(ids(l, 'R1')).toEqual(['u1', 'u2']);
    l = split(l, meta('sp', 12), 'R1', 'R3', 'counted', 5);
    expect(ids(l, 'R3')).toEqual(['u1', 'u2']);
  });

  test('統合していなければ、自分の作業の開始の材料だけ。作業の開始でできていない物は材料なし', () => {
    const l = changeStage(twoStarts(), meta('f', 11), 'R2', 'R4', 'counted', 5, { kind: 'awaitingHandover', process });
    expect(ids(l, 'R1')).toEqual(['u1']);
    expect(ids(l, 'R4')).toEqual(['u2']);
    expect(ids(l, 'P1')).toBeUndefined();
  });
});

describe('中断と取消の表示（MFG-08a・REC-02a）', () => {
  test('数が不明の不足も、単位を付けて、何の数量が不明かを読めるようにする', () => {
    const l = recordStop(practiceLedger, meta('s1', 9), { process: 'R組立', item: 'R', unit: '台', project: { kind: 'common' }, reason: 'ネジ不足', shortage: { item: 'S', unit: '箱', value: null }, affected: null });
    expect(stopText(l.masters, l.stops.s1!)).toContain('不足 品目S 数が不明（箱）');
  });

  test('数量を戻さなかった取消は、数え直しがあったとは書かず、今の数量に反映されていないためと書く', () => {
    const lot = { id: 'X', item: 'P', unit: '個', project: { kind: 'common' }, location: 'S1' } as const;
    let l = register(practiceLedger, meta('r1', 9), lot, 'counted', 52);
    l = use(l, meta('u1', 8), 'X', 'counted', 5, '作業', 'included');
    l = voidRecord(l, meta('v1', 10), 'u1', '誤り');
    const text = eventText(l, l.history.at(-1)!);
    expect(text).toContain('今の数量に反映されていないため数量は変えていない');
    expect(text).not.toContain('数え直し');
  });
});
