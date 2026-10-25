import { describe, expect, test } from 'vitest';
import { changeMasters, practiceLedger, register, use, type Ledger, type Lot, type Meta, type Project } from '../../src/domain/ledger.ts';
import { fixedMasters } from '../../src/domain/masters.ts';
import { replenishmentOf, stockOf } from '../../src/domain/packaging.ts';
import { emptySupply, recordReply, recordRemainder, recordRequest, type Supply } from '../../src/domain/supply.ts';
import { consumableLinesText } from '../../src/ui/supply-format.ts';
import { stockItems } from '../../src/ui/seed.ts';

const common: Project = { kind: 'common' };

function meta(eventId: string, hour = 9): Meta {
  const at = `2026-10-02T${String(hour).padStart(2, '0')}:00:00+09:00`;
  return { eventId, occurredAt: at, recordedAt: at, actor: '架空担当A' };
}

const reg = (l: Ledger, id: string, item: string, unit: string, basis: 'counted' | 'label' | 'approximate' | 'unknown', value: number | null): Ledger =>
  register(l, meta(id, 8), { id, item, unit, project: common, location: 'S1' }, basis, value);

const screws = stockItems.find((s) => s.item === 'S')!;
const washers = stockItems.find((s) => s.item === 'V')!;

function linesOf(cfg: (typeof stockItems)[number], ledger: Ledger, supply: Supply): string {
  const stock = stockOf(ledger, supply, cfg.item, cfg.pieceUnit);
  const lots: Lot[] = Object.values(ledger.lots).filter((l) => l.item === cfg.item && l.mergedInto === null);
  const requests = Object.values(supply.requests).filter((r) => r.item === cfg.item);
  return consumableLinesText(ledger, cfg, lots, stock, cfg.rule ? replenishmentOf(stock, cfg.rule) : { kind: 'none' }, requests).join('\n');
}

const askBox = (s: Supply): Supply =>
  recordRequest(s, fixedMasters, meta('q1', 8), { project: common, item: 'S', unit: '箱', quantity: 1, vendor: '架空の仕入先X', requestedOn: '2026-10-01', reply: { kind: 'none' } });

describe('ネジの欄の文言', () => {
  test('個で管理する消耗品の数量見出しは本に固定しない', () => {
    const text = linesOf({ ...washers, pieceUnit: '個' }, reg(practiceLedger, 'V-OPEN', 'V', '個', 'counted', 7), emptySupply);
    expect(text).toContain('開封済み・バラの数量（個）：V-OPEN 7個');
    expect(text).toContain('数量合計（個） 7個');
    expect(text).not.toContain('数量（本）');
  });
  test('AT-35・AT-52・QTY-05b: 1箱あたりの数既知の精度上限を1箱あたりの数不明と表示せず、本数は小計と補充判定不能を示す', () => {
    let l = changeMasters(practiceLedger, meta('pb', 9), { action: 'perBox', id: 'S', value: 9007199254740991, reason: '架空の境界試験' });
    l = register(l, meta('BOX', 10), { id: 'BOX', item: 'S', unit: '箱', project: common, location: 'S1' }, 'counted', 2);
    l = reg(l, 'OPEN', 'S', '本', 'counted', 4000);
    const text = linesOf(screws, l, emptySupply);
    expect(text).toContain('数量の数値部分の小計（本） 4000本');
    expect(text).toContain('合算していない分（整数の精度を保てる上限を超える）：BOX 2箱');
    expect(text).not.toContain('合算していない分（1箱あたりの数が分からない');
    expect(text).toContain('精度の上限で合算していない分があるので、補充の要否を断定できない');
    expect(text).not.toContain('だいたい・中身未確認を含むので');
    expect(text).not.toContain('補充確認は出ていない');
    expect(text).toContain('1箱あたりの数9007199254740991本');
  });

  test('固定データ: ネジSは1箱1000本・補充基準3000本・標準依頼数量1箱。ワッシャVは包装も基準もない（試験データ）', () => {
    expect(fixedMasters.items.S?.packaging).toEqual({ boxUnit: '箱', pieceUnit: '本', perBox: [{ from: null, value: 1000 }] });
    expect(screws.rule).toEqual({ item: 'S', pieceUnit: '本', threshold: 3000, standardOrder: { value: 1, unit: '箱' } });
    expect(fixedMasters.items.V?.packaging).toBeNull();
    expect(washers.rule).toBeNull();
  });

  test('AT-42・8.8・9.2: 未開封2箱と開封済み約200本は、約2200本・未確認部分あり。補充基準を下回るので補充確認と、既存の依頼1箱を並べて示す。依頼は自動で作らない', () => {
    let l = reg(practiceLedger, 'S-BOX', 'S', '箱', 'counted', 2);
    l = reg(l, 'S-OPEN', 'S', '本', 'approximate', 200);
    const text = linesOf(screws, l, askBox(emptySupply));
    expect(text).toContain('未開封の箱：S-BOX');
    expect(text).toContain('開封済み・バラの数量（本）：S-OPEN');
    expect(text).toMatch(/数量合計（本） .*約2200本.*未確認部分あり/);
    expect(text).toContain('箱は1箱あたり1000本の表示で換算（現物を数えた値ではない）');
    expect(text).toContain('補充確認');
    expect(text).toContain('補充基準3000本');
    expect(text).toContain('標準依頼数量1箱');
    expect(text).toContain('確定した判定ではない');
    expect(text).toContain('依頼は自動では作らない');
    expect(text).toContain('既存の依頼 q1：1箱・架空の仕入先X・未回答・注文の確定なし・到着0箱・未着1箱');
  });

  test('F1-B 6.8: 1箱あたりの数を変えたあとは、箱ごとの1箱あたりの数と、適用時点ごとの1箱あたりの数を示す', () => {
    let l = reg(practiceLedger, 'S-old', 'S', '箱', 'counted', 2);
    l = changeMasters(l, meta('pb', 10), { action: 'perBox', id: 'S', value: 800, reason: '包装の変更' });
    l = register(l, meta('S-new', 11), { id: 'S-new', item: 'S', unit: '箱', project: common, location: 'S1' }, 'counted', 1);
    const text = linesOf(screws, l, emptySupply);
    expect(text).toMatch(/S-old 2箱.*（1箱あたりの数1000本）/);
    expect(text).toMatch(/S-new 1箱.*（1箱あたりの数800本）/);
    expect(text).toContain('箱は受け取りのときの1箱あたりの表示で換算（1箱あたり1000本、2026-10-02 10:00（日本時間）以後の受け取りは800本。現物を数えた値ではない）');
    expect(text).toContain('数量合計（本） 記録上の数2800本・中身未確認');
  });

  test('9.2: 既存の依頼の回答（予定日）と取消も併せて示す。依頼がなければ、ない、と書く', () => {
    const l = reg(practiceLedger, 'S-BOX', 'S', '箱', 'counted', 2);
    expect(linesOf(screws, l, emptySupply)).toContain('既存の依頼はない');
    const replied = recordReply(askBox(emptySupply), fixedMasters, meta('q2', 9), 'q1', { kind: 'answered', date: '2026-10-09' });
    expect(linesOf(screws, l, replied)).toContain('相手が回答した予定日2026-10-09');
  });

  test('AT-20・8.9: 未開封はラベル根拠の本数、開封済みで数が不明の箱は残量区分だけ。区分を本数にしない', () => {
    let l = reg(practiceLedger, 'S-BOX', 'S', '箱', 'counted', 2);
    l = reg(l, 'S-OPEN', 'S', '本', 'unknown', null);
    const s = recordRemainder(l, askBox(emptySupply), meta('m1'), 'S-OPEN', 'few');
    const text = linesOf(screws, l, s);
    expect(text).toContain('残量区分のみ（数量へは換算しない）：S-OPEN 少ない');
    expect(text).toMatch(/数量合計（本） .*2000本/);
    expect(text).not.toMatch(/数量合計（本） .*2[0-9]{3}本.*少ない/);
  });

  test('9.4: 数値部分がなく区分だけのときは、本数で比べず、区分と既存の依頼を示す。8.5: 1箱あたりの数が分からない包装は合算せず別に書く', () => {
    let l = reg(practiceLedger, 'S-OPEN', 'S', '本', 'unknown', null);
    l = reg(l, 'S-BAG', 'S', '袋', 'counted', 3);
    const s = recordRemainder(l, askBox(emptySupply), meta('m1'), 'S-OPEN', 'nearEmpty');
    const text = linesOf(screws, l, s);
    expect(text).toContain('数値部分がなく残量区分だけなので、数量では比べない');
    expect(text).toContain('合算していない分（1箱あたりの数が分からない包装・だいたいや数が不明の箱）：S-BAG');
    expect(text).toContain('既存の依頼 q1');
  });

  test('9.3: 未解決の確認事項で補充確認が出るとき、基準以上の本数を「下回る」とは書かず、理由を正しく書く', () => {
    const l = use(reg(practiceLedger, 'S-OPEN', 'S', '本', 'counted', 4000), meta('u1', 9), 'S-OPEN', 'counted', 5000, '作業');
    const text = linesOf(screws, l, emptySupply);
    expect(text).toContain('補充確認：');
    expect(text).toContain('数量の数値部分は補充基準3000本以上に見えるが、未解決の確認事項があるので、補充の要否を断定できない');
    expect(text).not.toContain('下回る');
    expect(text).toContain('未解決の確認事項がある');
  });

  test('9.3: 合算できない不確かな在庫だけのときは、補充確認を出し、比べられる数値がないと書く（基準を下回るとも、未解決の確認事項とも書かない）', () => {
    const text = linesOf(screws, reg(practiceLedger, 'S-BOX', 'S', '箱', 'approximate', 2), emptySupply);
    expect(text).toContain('補充確認：数量の数値部分がなく、合算していない分・不明の部分だけなので、補充の要否を断定できない');
    expect(text).not.toContain('下回る');
    expect(text).not.toContain('未解決の確認事項があるので');
  });

  test('9.3: ラベル換算の本数が基準以上に見えても、補充確認を残し、基準を下回るとは書かない。数えたの本数が基準以上なら出ない。ワッシャV（基準なし）は区分だけを示し、補充確認の行を出さない', () => {
    const tentative = linesOf(screws, reg(practiceLedger, 'S-BOX', 'S', '箱', 'counted', 4), emptySupply);
    expect(tentative).toContain('補充確認：数量の数値部分は補充基準3000本以上に見えるが、だいたい・中身未確認を含むので、補充の要否を断定できない');
    expect(tentative).not.toContain('下回る');
    expect(linesOf(screws, reg(practiceLedger, 'S-OPEN', 'S', '本', 'counted', 4000), emptySupply)).toContain('補充確認は出ていない');
    let l = reg(practiceLedger, 'V-1', 'V', '本', 'unknown', null);
    const s = recordRemainder(l, emptySupply, meta('m1'), 'V-1', 'half');
    const text = linesOf(washers, l, s);
    expect(text).toContain('残量区分のみ（数量へは換算しない）：V-1 半分程度');
    expect(text).not.toContain('補充');
  });
});
