import { addScalar, subtractScalar, validateScalar, validateSignedScalar, type Step } from './scalar.ts';

// 仕様書03・04章の記号との対応: E=counted, L=label, A=approximate, U=unknown
export type Basis = 'counted' | 'label' | 'approximate' | 'unknown';

export type Observation =
  | { id: string; basis: 'counted' | 'label' | 'approximate'; value: number }
  | { id: string; basis: 'unknown'; value: null };

export type Unconfirmed = 'none' | 'partial' | 'all';

export type Numeric = { value: number; approximate: boolean; unconfirmed: Unconfirmed };

export type Term = { sign: 1 | -1; observation: Observation };

// before: 残数不明になる直前の数量。数が不明の観測そのものは null。
export type UnknownQuantity = { kind: 'unknown'; before: Quantity | null; terms: Term[] };

// partlyUnknown は加算でしか生じないため、常に計算値である。
export type Quantity =
  | { kind: 'known'; numeric: Numeric; computed: boolean; terms: Term[] }
  | { kind: 'partlyUnknown'; numeric: Numeric | null; unknownParts: UnknownQuantity[]; terms: Term[] }
  | UnknownQuantity;

// 保存の復号でオブジェクトの参照は変わる。数値だけでなく根拠と元の観測も比べる。
export function sameQuantity(a: Quantity, b: Quantity): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind || a.terms.length !== b.terms.length) return false;
  if (!a.terms.every((term, i) => {
    const other = b.terms[i]!;
    return term.sign === other.sign && term.observation.id === other.observation.id
      && term.observation.basis === other.observation.basis && term.observation.value === other.observation.value;
  })) return false;
  switch (a.kind) {
    case 'known':
      return b.kind === 'known' && a.computed === b.computed && sameNumeric(a.numeric, b.numeric);
    case 'partlyUnknown':
      return b.kind === 'partlyUnknown' && sameNumeric(a.numeric, b.numeric)
        && a.unknownParts.length === b.unknownParts.length
        && a.unknownParts.every((part, i) => sameQuantity(part, b.unknownParts[i]!));
    case 'unknown':
      return b.kind === 'unknown' && (a.before === null || b.before === null
        ? a.before === b.before : sameQuantity(a.before, b.before));
  }
}

function sameNumeric(a: Numeric | null, b: Numeric | null): boolean {
  return a === null || b === null ? a === b
    : a.value === b.value && a.approximate === b.approximate && a.unconfirmed === b.unconfirmed;
}

export function observe(id: string, basis: Basis, value: number | null, step: Step = 1): Observation {
  if (basis === 'unknown') {
    validateSignedScalar(0, step);
    if (value !== null) throw new Error('「数が不明」には数値を持たせない');
    return { id, basis, value };
  }
  if (value === null) throw new Error('「数が不明」以外は数値を入力する');
  return { id, basis, value: validateScalar(value, step) };
}

function addNumeric(a: Numeric, b: Numeric, step: Step): Numeric {
  return {
    value: addScalar(a.value, b.value, step),
    approximate: a.approximate || b.approximate,
    unconfirmed: a.unconfirmed === b.unconfirmed && a.unconfirmed !== 'partial' ? a.unconfirmed : 'partial',
  };
}

function numericPart(q: Quantity): Numeric | null {
  return q.kind === 'unknown' ? null : q.numeric;
}

function unknownPartsOf(q: Quantity): UnknownQuantity[] {
  switch (q.kind) {
    case 'known':
      return [];
    case 'partlyUnknown':
      return q.unknownParts;
    case 'unknown':
      return [q];
  }
}

export function add(a: Quantity, b: Quantity, step: Step = 1): Quantity {
  checkNumericPart(a, step);
  checkNumericPart(b, step);
  const terms = [...a.terms, ...b.terms];
  if (a.kind === 'known' && b.kind === 'known') {
    return { kind: 'known', numeric: addNumeric(a.numeric, b.numeric, step), computed: true, terms };
  }
  const na = numericPart(a);
  const nb = numericPart(b);
  return {
    kind: 'partlyUnknown',
    numeric: na && nb ? addNumeric(na, nb, step) : (na ?? nb),
    unknownParts: [...unknownPartsOf(a), ...unknownPartsOf(b)],
    terms,
  };
}

// 不明分岐で数値部分を引き継ぐ場合も、演算対象の精度外の値を通さない。
function checkNumericPart(q: Quantity, step: Step): void {
  validateSignedScalar(numericPart(q)?.value ?? 0, step);
}

// L−E は中身未確認のまま、L−A は未確認部分ありになる（04章の減算表）。
function remainderUnconfirmed(base: Numeric, decrease: Numeric): Unconfirmed {
  switch (base.unconfirmed) {
    case 'all':
      return decrease.approximate ? 'partial' : 'all';
    case 'none':
      return decrease.unconfirmed === 'none' ? 'none' : 'partial';
    case 'partial':
      return 'partial';
  }
}

export function subtract(base: Quantity, decrease: Quantity, step: Step = 1): Quantity {
  checkNumericPart(base, step);
  checkNumericPart(decrease, step);
  const terms = [
    ...base.terms,
    ...decrease.terms.map((t): Term => ({ sign: t.sign === 1 ? -1 : 1, observation: t.observation })),
  ];
  if (base.kind !== 'known' || decrease.kind !== 'known') {
    return { kind: 'unknown', before: base, terms };
  }
  return {
    kind: 'known',
    numeric: {
      value: subtractScalar(base.numeric.value, decrease.numeric.value, step),
      approximate: base.numeric.approximate || decrease.numeric.approximate,
      unconfirmed: remainderUnconfirmed(base.numeric, decrease.numeric),
    },
    computed: true,
    terms,
  };
}

// 呼び出し側が観測を後から書き換えても数値と元記録が食い違わないよう、写しを持つ。
export function quantityOf(source: Observation): Quantity {
  const observation = { ...source };
  const terms: Term[] = [{ sign: 1, observation }];
  switch (observation.basis) {
    case 'unknown':
      return { kind: 'unknown', before: null, terms };
    case 'counted':
    case 'label':
    case 'approximate':
      return {
        kind: 'known',
        numeric: {
          value: observation.value,
          approximate: observation.basis === 'approximate',
          unconfirmed: observation.basis === 'label' ? 'all' : 'none',
        },
        computed: false,
        terms,
      };
  }
}
