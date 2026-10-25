import { describe, expect, test } from 'vitest';
import { changeMasters, practiceLedger, recount, register, use, type Ledger, type Meta, type Project } from '../../src/domain/ledger.ts';
import { replenishmentOf, stockOf, type Replenishment } from '../../src/domain/packaging.ts';
import { emptySupply, recordRemainder, type Supply } from '../../src/domain/supply.ts';
import { initial, parse, serialize } from '../../src/ui/storage.ts';

const common: Project = { kind: 'common' };

function meta(eventId: string, hour = 9): Meta {
  const at = `2026-10-02T${String(hour).padStart(2, '0')}:00:00+09:00`;
  return { eventId, occurredAt: at, recordedAt: at, actor: '架空担当A' };
}

// 試験データ。現場の設定ではない（ADR-005、TBD-05）。
const rule: Replenishment = { item: 'S', pieceUnit: '本', threshold: 3000, standardOrder: { value: 1, unit: '箱' } };

const reg = (l: Ledger, id: string, unit: string, basis: 'counted' | 'label' | 'approximate' | 'unknown', value: number | null, item = 'S'): Ledger =>
  register(l, meta(id, 8), { id, item, unit, project: common, location: 'S1' }, basis, value);

// 1箱あたりの数の分からない包装として数えるときは、台帳の登録情報からネジSの包装（1箱1000本）を外す。
const withoutPackaging = (l: Ledger): Ledger => ({ ...l, masters: { ...l.masters, items: { ...l.masters.items, S: { ...l.masters.items.S!, packaging: null } } } });
const stock = (l: Ledger, s: Supply = emptySupply, packaged = true, item = 'S') => stockOf(packaged ? l : withoutPackaging(l), s, item, '本');
const numeric = (q: ReturnType<typeof stock>['pieces']) => (q && q.kind === 'known' ? q.numeric : q && q.kind === 'partlyUnknown' ? q.numeric : null);

describe('要件8 箱から本数への換算', () => {
  test('AT-35・AT-52・QTY-05b: 1箱あたりの数は安全整数でも本数の積が精度を超える箱は、保存後も理由付きで未換算に残す', () => {
    let l = register(practiceLedger, meta('BOX', 11), { id: 'BOX', item: 'S', unit: '箱', project: common, location: 'S1' }, 'counted', 2);
    l = changeMasters(l, meta('pb', 10), { action: 'perBox', id: 'S', value: 9007199254740991, reason: '架空の境界試験' });
    const restored = parse(serialize(initial(l, emptySupply)));
    if (restored === null) throw new Error('保存した台帳を復元できない');
    const result = stock(restored.ledger);
    expect(result.pieces).toBeNull();
    expect(result.unconverted.map((lot) => lot.id)).toEqual(['BOX']);
    expect(result.precisionLimited.map((lot) => lot.id)).toEqual(['BOX']);
    expect(replenishmentOf(result, rule)).toMatchObject({ kind: 'replenishCheck', hasUnknown: true });
    expect(restored.ledger.lots.BOX?.quantity).toMatchObject({ kind: 'known', numeric: { value: 2 } });
  });

  test('AT-52・QTY-05b: 個別の換算が安全整数でも、合計の精度を超える分は別に残し、補充要否を断定しない', () => {
    let l = changeMasters(practiceLedger, meta('pb', 9), { action: 'perBox', id: 'S', value: 4503599627370496, reason: '架空の境界試験' });
    l = register(l, meta('A', 10), { id: 'A', item: 'S', unit: '箱', project: common, location: 'S1' }, 'counted', 1);
    l = register(l, meta('B', 10), { id: 'B', item: 'S', unit: '箱', project: common, location: 'S1' }, 'label', 1);
    const result = stock(l);
    expect(numeric(result.pieces)?.value).toBe(4503599627370496);
    expect(result.precisionLimited.map((lot) => lot.id)).toEqual(['B']);
    expect(result.unconverted.map((lot) => lot.id)).toEqual(['B']);
    let loose = reg(practiceLedger, 'A', '本', 'counted', 9007199254740991);
    loose = reg(loose, 'B', '本', 'counted', 1);
    const counted = stock(loose);
    expect(numeric(counted.pieces)?.value).toBe(9007199254740991);
    expect(counted.precisionLimited.map((lot) => lot.id)).toEqual(['B']);
    expect(replenishmentOf(counted, rule)).toMatchObject({ kind: 'replenishCheck', hasUnknown: true });
  });

  test('AT-42・8.8: 未開封2箱（数えたの箱数）と開封済み約200本は、約2200本・未確認部分あり', () => {
    let l = reg(practiceLedger, 'BOX', '箱', 'counted', 2);
    l = reg(l, 'OPEN', '本', 'approximate', 200);
    const s = stock(l);
    expect(numeric(s.pieces)).toEqual({ value: 2200, approximate: true, unconfirmed: 'partial' });
    expect(s.unconverted).toEqual([]);
    expect(s.levelOnly).toEqual([]);
  });

  test('8.2・8.3: 箱数は1箱あたりの数で本数に換算する。箱数が数えたでも、本数はラベル根拠（中身未確認）で、数量の数えたにしない', () => {
    const s = stock(reg(practiceLedger, 'BOX', '箱', 'counted', 2));
    expect(numeric(s.pieces)).toEqual({ value: 2000, approximate: false, unconfirmed: 'all' });
    expect(s.pieces?.terms[0]?.observation.basis).toBe('label');
  });

  test('8.4: 箱数の数えたと、本数への換算の根拠は区別できる（箱の保管単位の数量は「数えた」のまま、換算後がラベル根拠）', () => {
    const l = reg(practiceLedger, 'BOX', '箱', 'counted', 2);
    expect(l.lots['BOX']?.quantity.terms[0]?.observation.basis).toBe('counted');
    expect(stock(l).pieces?.terms[0]?.observation.basis).toBe('label');
  });

  test('AT-20・8.9: 未開封2箱はラベル根拠、開封済みで数が不明の箱は残量区分。根拠のない本数を作らず、区分を本数に足さない', () => {
    let l = reg(practiceLedger, 'BOX', '箱', 'counted', 2);
    l = reg(l, 'OPEN', '本', 'unknown', null);
    const s = recordRemainder(l, emptySupply, meta('m1'), 'OPEN', 'few');
    const r = stock(l, s);
    expect(numeric(r.pieces)).toEqual({ value: 2000, approximate: false, unconfirmed: 'all' });
    expect(r.levelOnly).toEqual([{ lotId: 'OPEN', level: 'few' }]);
    expect(r.unconverted).toEqual([]);
  });

  test('8.6: 開封済みの残量が実数・だいたいならそのまま足す。数が不明で区分もなければ、不明の部分として足す（数値部分と別）', () => {
    let l = reg(practiceLedger, 'OPEN1', '本', 'counted', 150);
    l = reg(l, 'OPEN2', '本', 'unknown', null);
    const r = stock(l);
    expect(r.pieces?.kind).toBe('partlyUnknown');
    expect(numeric(r.pieces)).toMatchObject({ value: 150 });
    expect(r.levelOnly).toEqual([]);
  });

  test('8.5: 1箱あたりの数が分からない包装・だいたいや数が不明の箱は、本数に合算せず別に返す', () => {
    let l = reg(practiceLedger, 'B1', '箱', 'approximate', 2);
    l = reg(l, 'B2', '箱', 'unknown', null);
    l = reg(l, 'BAG', '袋', 'counted', 3);
    const r = stock(l);
    expect(r.pieces).toBeNull();
    expect(r.unconverted.map((x) => x.id).sort()).toEqual(['B1', 'B2', 'BAG']);
    const noPackaging = stock(reg(practiceLedger, 'B3', '箱', 'counted', 2), emptySupply, false);
    expect(noPackaging.pieces).toBeNull();
    expect(noPackaging.unconverted.map((x) => x.id)).toEqual(['B3']);
  });

  test('別の品目は数えない。包装のない品目は、本の単位だけを数える', () => {
    let l = reg(practiceLedger, 'BOX', '箱', 'counted', 1);
    l = reg(l, 'OTHER', '本', 'counted', 999, 'V');
    expect(numeric(stock(l).pieces)?.value).toBe(1000);
    expect(numeric(stock(l, emptySupply, false, 'V').pieces)?.value).toBe(999);
  });

  test('AT-10の回帰: 部品の個・半製品の台・ネジの箱を足さない。ネジの箱は本数へ推定換算しない（1箱あたりの数が分からなければ合算しない）', () => {
    let l = reg(practiceLedger, 'P1', '個', 'counted', 10, 'P');
    l = reg(l, 'R1', '台', 'counted', 3, 'R');
    l = reg(l, 'S1', '箱', 'counted', 2);
    expect(stock(l, emptySupply, false).pieces).toBeNull();
    expect(stock(l, emptySupply, false, 'P').pieces).toBeNull();
  });
});

describe('残量区分が古くなる場合と、不確かな在庫だけの補充確認', () => {
  test('8.6: 残量区分は、記録した時点の数量のままのときだけ使う。数え直して数量が分かり、その後また数が不明になったら、古い区分を復活させない', () => {
    let l = reg(practiceLedger, 'S-OPEN', '本', 'unknown', null);
    const s = recordRemainder(l, emptySupply, meta('m1', 9), 'S-OPEN', 'few');
    expect(stock(l, s).levelOnly).toEqual([{ lotId: 'S-OPEN', level: 'few' }]);
    l = recount(l, meta('c1', 10), 'S-OPEN', 100, { kind: 'unknown' });
    expect(stock(l, s).levelOnly).toEqual([]);
    l = use(l, meta('u1', 11), 'S-OPEN', 'unknown', null, '作業');
    expect(l.lots['S-OPEN']?.quantity.kind).toBe('unknown');
    const again = stock(l, s);
    expect(again.levelOnly).toEqual([]); // 古い「少ない」を、いまの残量として出さない
    expect(again.pieces?.kind).toBe('unknown');
    // 新しく区分を記録すれば、また使える。
    const renewed = recordRemainder(l, s, meta('m2', 12), 'S-OPEN', 'nearEmpty');
    expect(stock(l, renewed).levelOnly).toEqual([{ lotId: 'S-OPEN', level: 'nearEmpty' }]);
  });

  test('9.3: 数が不明の本数の保管単位一つだけで、残量区分もないときも、不明の在庫として補充確認を残す', () => {
    const l = reg(practiceLedger, 'OPEN', '本', 'unknown', null);
    expect(stock(l).pieces?.kind).toBe('unknown');
    expect(replenishmentOf(stock(l), rule)).toEqual({ kind: 'replenishCheck', approximate: false, unconfirmed: false, hasUnknown: true, levelOnly: false, openIssue: false });
  });

  test('9.3: 合算できない不確かな在庫（だいたい・数が不明の箱、1箱あたりの数が分からない包装）だけで、数値も区分もないときも、補充確認を残す', () => {
    const l = reg(reg(practiceLedger, 'B1', '箱', 'approximate', 2), 'B2', '箱', 'unknown', null);
    expect(stock(l).pieces).toBeNull();
    expect(replenishmentOf(stock(l), rule)).toEqual({ kind: 'replenishCheck', approximate: false, unconfirmed: false, hasUnknown: true, levelOnly: false, openIssue: false });
    // 在庫の保管単位が一つもないときは、在庫0本として基準と比べる（補充確認を出す）。数値がない不明とは別。
    expect(numeric(stock(practiceLedger).pieces)?.value).toBe(0);
    expect(replenishmentOf(stock(practiceLedger), rule)).toEqual({ kind: 'replenishCheck', approximate: false, unconfirmed: false, hasUnknown: false, levelOnly: false, openIssue: false });
  });
});

describe('未解決の確認事項と、共通在庫への絞り込み', () => {
  test('9.3: 品目の保管単位に未解決の確認事項（負数で保留した使用など）があれば、基準以上でも補充確認を出し、確認が必要の印を付ける。解決済みなら印は付かない', () => {
    let l = reg(practiceLedger, 'S-OPEN', '本', 'counted', 4000);
    expect(stock(l).openIssue).toBe(false);
    expect(replenishmentOf(stock(l), rule)).toEqual({ kind: 'none' });
    l = use(l, meta('u1', 9), 'S-OPEN', 'counted', 5000, '作業');
    expect(l.issues['u1']?.resolution).toBeNull();
    expect(stock(l).openIssue).toBe(true);
    expect(replenishmentOf(stock(l), rule)).toEqual({ kind: 'replenishCheck', approximate: false, unconfirmed: false, hasUnknown: false, levelOnly: false, openIssue: true });
  });

  test('別の品目の確認事項は影響しない', () => {
    let l = reg(practiceLedger, 'S-OPEN', '本', 'counted', 4000);
    l = reg(l, 'W-1', '本', 'counted', 10, 'V');
    l = use(l, meta('u1', 9), 'W-1', 'counted', 50, '作業');
    expect(stock(l).openIssue).toBe(false);
  });

  test('共通在庫に絞ると、案件・用途に属する保管単位を合計に入れない（案件・用途の違う同じ品目を混ぜない）', () => {
    let l = reg(practiceLedger, 'S-COMMON', '本', 'counted', 1000);
    l = register(l, meta('S-CASE', 8), { id: 'S-CASE', item: 'S', unit: '本', project: { kind: 'case', id: 'B-001' }, location: 'S1' }, 'counted', 5000);
    expect(numeric(stockOf(l, emptySupply, 'S', '本').pieces)?.value).toBe(6000);
    expect(numeric(stockOf(l, emptySupply, 'S', '本', (x) => x.project.kind === 'common').pieces)?.value).toBe(1000);
  });
});

describe('要件9 補充確認', () => {
  const boxes = (n: number): Ledger => reg(practiceLedger, 'BOX', '箱', 'counted', n);

  test('AT-42・9.1・9.2: 約2200本が基準3000本を下回るので、補充確認（約・中身未確認部分あり）。確定した判定ではない', () => {
    const l = reg(boxes(2), 'OPEN', '本', 'approximate', 200);
    expect(replenishmentOf(stock(l), rule)).toEqual({ kind: 'replenishCheck', approximate: true, unconfirmed: true, hasUnknown: false, levelOnly: false, openIssue: false });
  });

  test('9.1: 数えたの本数が基準以上（ちょうど3000本を含む）なら通知しない。在庫の保管単位が一つもなければ、在庫0本として確認を出す', () => {
    expect(replenishmentOf(stock(reg(practiceLedger, 'OPEN', '本', 'counted', 3000)), rule)).toEqual({ kind: 'none' });
    expect(replenishmentOf(stock(reg(practiceLedger, 'OPEN', '本', 'counted', 4000)), rule)).toEqual({ kind: 'none' });
    // 在庫の保管単位が一つもないときは、在庫0本として基準と比べる（補充確認を出す）。数値がない不明とは別。
    expect(numeric(stock(practiceLedger).pieces)?.value).toBe(0);
    expect(replenishmentOf(stock(practiceLedger), rule)).toEqual({ kind: 'replenishCheck', approximate: false, unconfirmed: false, hasUnknown: false, levelOnly: false, openIssue: false });
  });

  test('9.3: ラベル換算・だいたいの本数が基準以上に見えても、確定した充足とは扱わず、補充確認を残す（中身未確認・だいたいの印つき）', () => {
    expect(replenishmentOf(stock(boxes(4)), rule)).toEqual({ kind: 'replenishCheck', approximate: false, unconfirmed: true, hasUnknown: false, levelOnly: false, openIssue: false });
    const approx = reg(practiceLedger, 'OPEN', '本', 'approximate', 4000);
    expect(replenishmentOf(stock(approx), rule)).toEqual({ kind: 'replenishCheck', approximate: true, unconfirmed: false, hasUnknown: false, levelOnly: false, openIssue: false });
  });

  test('9.3: 数えたの本数だけが基準を下回るときも補充確認で、だいたい・中身未確認の印は付かない', () => {
    const l = reg(practiceLedger, 'OPEN', '本', 'counted', 2000);
    expect(replenishmentOf(stock(l), rule)).toEqual({ kind: 'replenishCheck', approximate: false, unconfirmed: false, hasUnknown: false, levelOnly: false, openIssue: false });
  });

  test('9.4: 数値部分がなく残量区分だけのときは、本数で比べず、区分のみの補充確認にする', () => {
    let l = reg(practiceLedger, 'OPEN', '本', 'unknown', null);
    const s = recordRemainder(l, emptySupply, meta('m1'), 'OPEN', 'nearEmpty');
    expect(replenishmentOf(stock(l, s), rule)).toEqual({ kind: 'replenishCheck', approximate: false, unconfirmed: false, hasUnknown: false, levelOnly: true, openIssue: false });
    l = reg(l, 'COUNTED', '本', 'counted', 5000);
    expect(replenishmentOf(stock(l, s), rule)).toEqual({ kind: 'none' });
  });

  test('基準未満に区分のみの開封分が混在するときは、区分のみも印に残す。合算していない分があれば不明も印に残す', () => {
    let l = reg(boxes(1), 'OPEN', '本', 'unknown', null);
    const s = recordRemainder(l, emptySupply, meta('m1'), 'OPEN', 'few');
    l = reg(l, 'BAG', '袋', 'counted', 4);
    expect(replenishmentOf(stock(l, s), rule)).toEqual({ kind: 'replenishCheck', approximate: false, unconfirmed: true, hasUnknown: true, levelOnly: true, openIssue: false });
  });
});
