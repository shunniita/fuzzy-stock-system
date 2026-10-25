import { creationsOf, openIssues, perBoxOfLot, type Ledger, type Lot } from './ledger.ts';
import { own } from './masters.ts';
import { add, observe, quantityOf, type Quantity } from './quantity.ts';
import { currentLevelOf, type RemainderLevel, type Supply } from './supply.ts';

// 箱から本数への換算（SUP-01）。1箱あたりの数はラベルの1箱あたりの数なので、換算した本数は数えたにしない（SUP-02b）。
// 箱ごとに受け取りのときの1箱あたりの数で換算する（MST-05、ADR-024）。
export type Replenishment = { item: string; pieceUnit: string; threshold: number; standardOrder: { value: number; unit: string } };

export type StockOfItem = {
  // 換算できた箱と本数のまとまりの合計。範囲にまとまりが一つもなければ手元0本。数値のもとがない（区分のみ・合算しない分だけ）ときは null。
  pieces: Quantity | null;
  // 1箱あたりの数が分からない包装、だいたい・数が不明の箱など、本数へ合算しないまとまり（SUP-01）。
  unconverted: Lot[];
  // 未換算のうち、1箱あたりの数の積や本数の合計が安全整数の精度を超えるまとまり。元の数量・根拠は変えない（QTY-05b）。
  precisionLimited: Lot[];
  // 数が不明で残量区分だけがある開封済み。本数へ換算しない（SUP-03）。
  levelOnly: { lotId: string; level: RemainderLevel }[];
  // 品目のまとまりに未解決の確認事項がある。保留した操作の前の数量を、通常の在庫として断定しない（REC-05・DESIGN_NOTES）。
  openIssue: boolean;
};

// 箱の数量が既知でだいたいでないときだけ、1箱あたりの数をかけてラベル根拠の本数にする。箱数が数えたでも、
// 中身の本数は数えていないので中身未確認とし、本数の数えたに見せない。
type BoxPieces = { kind: 'converted'; quantity: Quantity } | { kind: 'unconvertible' } | { kind: 'precisionLimit' };

function piecesOfBox(lot: Lot, perBox: number): BoxPieces {
  const q = lot.quantity;
  if (q.kind !== 'known' || q.numeric.approximate) return { kind: 'unconvertible' };
  const value = q.numeric.value * perBox;
  if (!Number.isSafeInteger(value)) return { kind: 'precisionLimit' };
  return { kind: 'converted', quantity: quantityOf(observe(`${lot.id}×${perBox}`, 'label', value, 1)) };
}

// 品目の手元の本数。まとめ直し済みの元は数えない。箱は換算し、本数のまとまり（開封済み・ばら）はそのまま足す。
// include で、案件・用途などの範囲に絞る（共通ネジの欄は共通在庫だけ。案件・用途に属する同じ品目を混ぜない）。
export function stockOf(ledger: Ledger, supply: Supply, item: string, pieceUnit: string, include: (lot: Lot) => boolean = () => true): StockOfItem {
  const packaging = own(ledger.masters.items, item)?.packaging ?? null;
  const created = creationsOf(ledger);
  const parts: { lot: Lot; quantity: Quantity }[] = [];
  const unconverted: Lot[] = [];
  const precisionLimited: Lot[] = [];
  const levelOnly: StockOfItem['levelOnly'] = [];
  const scoped = Object.values(ledger.lots).filter((l) => l.item === item && include(l));
  const scopedIds = new Set(scoped.map((l) => l.id));
  for (const lot of scoped) {
    if (lot.mergedInto !== null) continue;
    if (lot.unit === pieceUnit) {
      const level = currentLevelOf(ledger, supply, lot);
      if (level !== undefined) levelOnly.push({ lotId: lot.id, level });
      else parts.push({ lot, quantity: lot.quantity });
    } else if (packaging !== null && lot.unit === packaging.boxUnit) {
      const perBox = perBoxOfLot(ledger, lot, created);
      const pieces: BoxPieces = perBox === null ? { kind: 'unconvertible' } : piecesOfBox(lot, perBox);
      if (pieces.kind === 'converted') parts.push({ lot, quantity: pieces.quantity });
      else {
        unconverted.push(lot);
        if (pieces.kind === 'precisionLimit') precisionLimited.push(lot);
      }
    } else {
      unconverted.push(lot);
    }
  }
  let pieces: Quantity | null = null;
  for (const part of parts) {
    // 数値部分だけの精度を検査する。不明の数量はaddに渡し、その根拠を不明のまま保持する。
    const value = (numericOf(pieces)?.value ?? 0) + (numericOf(part.quantity)?.value ?? 0);
    if (!Number.isSafeInteger(value)) {
      unconverted.push(part.lot);
      precisionLimited.push(part.lot);
    } else {
      pieces = pieces === null ? part.quantity : add(pieces, part.quantity, 1);
    }
  }
  const openIssue = openIssues(ledger).some((i) => i.lotId !== null && scopedIds.has(i.lotId));
  // 範囲にまとまりが一つもないときは、数値がない不明ではなく、手元0本（計算上の0）。基準と比べて補充確認を出せるようにする。
  const none = parts.length === 0 && unconverted.length === 0 && levelOnly.length === 0;
  const zero: Quantity = { kind: 'known', numeric: { value: 0, approximate: false, unconfirmed: 'none' }, computed: true, terms: [] };
  return { pieces: pieces ?? (none ? zero : null), unconverted, precisionLimited, levelOnly, openIssue };
}

export type Notice =
  | { kind: 'none' } // 基準以上、または比べられる数値も区分もない
  // approximate・unconfirmed：本数の数値部分の約・中身未確認。hasUnknown：本数に不明の部分がある、または合算していない分がある。
  // levelOnly：数が不明で区分だけの開封分がある。いずれも、確定した判定として表示しない根拠（SUP-05）。
  // openIssue：未解決の確認事項がある。基準以上でも、通常の在庫として断定できないので補充確認を出す。
  | { kind: 'replenishCheck'; approximate: boolean; unconfirmed: boolean; hasUnknown: boolean; levelOnly: boolean; openIssue: boolean };

function numericOf(q: Quantity | null): { value: number; approximate: boolean; unconfirmed: boolean } | null {
  if (q === null || q.kind === 'unknown') return null;
  const n = q.numeric;
  return n === null ? null : { value: n.value, approximate: n.approximate, unconfirmed: n.unconfirmed !== 'none' };
}

// 補充確認。依頼は自動で作らない（SUP-05）。数値部分が基準を下回るとき、または数値部分がなく区分だけがあるときに出す。
// 区分だけのときは、本数の比較をしない（SUP-03・SUP-05）。
export function replenishmentOf(stock: StockOfItem, rule: Replenishment): Notice {
  const n = numericOf(stock.pieces);
  // 数値が一つもない不明（unknown）も、不明の在庫に数える。合算していない分があるときも同じ。
  const hasUnknown = (stock.pieces !== null && stock.pieces.kind !== 'known') || stock.unconverted.length > 0;
  const levelOnly = stock.levelOnly.length > 0;
  const { openIssue } = stock;
  if (n !== null) {
    // だいたい・表示の数（ラベル・パッケージ）（中身未確認）に基づく本数は、基準以上に見えても確定した充足とは扱わない（SUP-05・04章の不足表示の規則と同じ）。
    const tentative = n.approximate || n.unconfirmed;
    return n.value < rule.threshold || openIssue || tentative || stock.precisionLimited.length > 0
      ? { kind: 'replenishCheck', approximate: n.approximate, unconfirmed: n.unconfirmed, hasUnknown, levelOnly, openIssue }
      : { kind: 'none' };
  }
  // 数値部分がなくても、区分・未解決の確認事項・合算していない不確かな在庫があれば、確定した「補充不要」とは言えないので確認を残す。
  return levelOnly || openIssue || hasUnknown ? { kind: 'replenishCheck', approximate: false, unconfirmed: false, hasUnknown, levelOnly, openIssue } : { kind: 'none' };
}
