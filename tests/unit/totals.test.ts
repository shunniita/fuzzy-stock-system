import { describe, expect, test } from 'vitest';
import { fixedMasters } from '../../src/domain/masters.ts';
import { changeStage, declareDiscrepancy, holdReasons, isUsable, openIssuesOf, start, totalOf, type Ledger, type Lot } from '../../src/domain/ledger.ts';
import { holdLabel, quantityText, totalsOf, totalsText } from '../../src/ui/format.ts';
import { seedLedger } from '../../src/ui/seed.ts';
import { processes } from '../../src/domain/ledger.ts';
import { meta } from './record-fixture.ts';

// 移す前の画面（main.tsのrenderTotals）の計算そのまま。移したあとも同じ文言になることを守る。
function legacy(ledger: Ledger, lots: Lot[]): { text: string; warn: boolean }[] {
  const groups = new Map<string, { item: string; unit: string }>();
  for (const l of lots) groups.set(`${l.item}\u0000${l.unit}`, { item: l.item, unit: l.unit });
  const ids = new Set(lots.map((l) => l.id));
  const lines: { text: string; warn: boolean }[] = [];
  for (const { item, unit } of groups.values()) {
    const inGroup = (l: Lot) => ids.has(l.id) && l.unit === unit;
    const issueCount = lots.filter((l) => l.item === item && l.unit === unit).flatMap((l) => openIssuesOf(ledger, l.id)).length;
    const excludable = (l: Lot) => inGroup(l) && l.stage.kind === 'none';
    const held = holdReasons
      .filter((r) => lots.some((l) => l.item === item && excludable(l) && l.holds.includes(r)))
      .map((r) => `${holdLabel[r]} ${quantityText(totalOf(ledger, item, (l) => excludable(l) && l.holds.includes(r)), unit)}`);
    const breakdown = held.length ? `（内訳 ${held.join('、')}）` : '';
    const staged = lots.some((l) => l.item === item && inGroup(l) && l.stage.kind !== 'none')
      ? `／製造中・完成（渡す前） ${quantityText(totalOf(ledger, item, (l) => inGroup(l) && l.stage.kind !== 'none'), unit)}（内訳は製造の欄）`
      : '';
    const text = `品目${item}（${unit}）：在庫 ${quantityText(totalOf(ledger, item, inGroup), unit)}／使用可能 ${quantityText(totalOf(ledger, item, (l) => inGroup(l) && isUsable(l)), unit)}／取り分け ${quantityText(totalOf(ledger, item, (l) => excludable(l) && l.holds.length > 0), unit)}${breakdown}${staged}`;
    lines.push({ text: issueCount ? `${text}。確認が必要 ${issueCount}件：使用可能数として断定しない` : text, warn: issueCount > 0 });
  }
  return lines;
}

const active = (ledger: Ledger): Lot[] => Object.values(ledger.lots).filter((l) => l.mergedInto === null);

function withStageAndIssue(): Ledger {
  let l = seedLedger();
  const process = processes[0];
  if (!process) throw new Error('試験用の工程がない');
  l = start(l, meta('t1'), { id: 'R-W1', item: 'R', unit: '台', project: { kind: 'case', id: 'A-001' }, location: 'T' }, process, 'counted', 1, []);
  return declareDiscrepancy(l, meta('t2'), 'P-001', '架空の差異');
}

describe('FH-F1A-06・F1-A 5.1: 在庫一覧の集計は、画面と閲覧用の出力で同じ計算と文言を使う', () => {
  test('工程完了後の完成（渡す前）を仕掛中と呼ばず、製造中・完成（渡す前）の数に含める', () => {
    const process = processes[0];
    if (!process) throw new Error('試験用の工程がない');
    let ledger = withStageAndIssue();
    ledger = changeStage(ledger, meta('inspect'), 'R-W1', 'R-I1', 'counted', 1, { kind: 'inspecting', process });
    ledger = changeStage(ledger, meta('complete'), 'R-I1', 'R-H1', 'counted', 1, { kind: 'awaitingHandover', process });
    const shown = totalsOf(ledger, active(ledger)).map(t => totalsText(ledger.masters, t)).join('\n');
    expect(shown).toContain('製造中・完成（渡す前） 記録上の数1台');
    expect(shown).not.toContain('仕掛中');
  });
  const cases: [string, Ledger][] = [['固定の架空データ', seedLedger()], ['工程に載った物と確認事項がある', withStageAndIssue()]];

  test.each(cases)('%s：移す前の計算と同じ文言になる（全体と、品目・場所で絞った範囲）', (_name, ledger) => {
    for (const lots of [active(ledger), active(ledger).filter((l) => l.item === 'P'), active(ledger).filter((l) => l.location === 'S1'), active(ledger).filter((l) => l.holds.length > 0), []]) {
      const expected = legacy(ledger, lots);
      const actual = totalsOf(ledger, lots).map((t) => ({ text: totalsText(fixedMasters, t), warn: t.issueCount > 0 }));
      expect(actual).toEqual(expected);
    }
  });

  test('値を返す：品目と単位ごとに、在庫・使用可能・除外・内訳・製造中・完成（渡す前）・確認が必要な件数', () => {
    const ledger = withStageAndIssue();
    const p = totalsOf(ledger, active(ledger)).find((t) => t.item === 'P');
    expect(p).toMatchObject({ item: 'P', unit: '個', issueCount: 1 });
    expect(p?.breakdown.map((b) => b.reason)).toEqual(['defective']);
    expect(p?.staged).toBeNull();
    const r = totalsOf(ledger, active(ledger)).find((t) => t.item === 'R');
    expect(r?.staged).not.toBeNull();
  });

  test('単位の違う数は、同じ品目でも別の行にして足さない', () => {
    const ledger = seedLedger();
    const s = totalsOf(ledger, active(ledger)).filter((t) => t.item === 'S').map((t) => t.unit);
    expect(s.sort()).toEqual(['本', '箱']);
  });
});
