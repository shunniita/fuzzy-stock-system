export type Step = 1 | 0.1;

const integerLimit = BigInt(Number.MAX_SAFE_INTEGER) * 10n;
const decimalLimit = 5629499534213119n;
const integerStepText = '数量は最小単位1に合う整数で入力する';

// 最小単位に合わない値の拒否。最小単位の分からない画面は、これを見て特定の最小単位を言い切らない文言に替える。
export class StepMismatch extends Error {}

const numberPattern = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/;

function ticksFromText(raw: string): bigint {
  const text = raw.trim();
  if (text.length === 0 || text.length > 128) throw new Error('数量は1〜128文字の十進数で入力する');
  const match = numberPattern.exec(text);
  if (!match) throw new Error('数量は十進数で入力する');
  const fraction = match[3] ?? match[4] ?? '';
  const digits = `${match[2] ?? ''}${fraction}`.replace(/^0+/, '');
  if (digits === '') return 0n;
  const exponent = Number(match[5] ?? '0');
  if (!Number.isSafeInteger(exponent)) throw new Error('数量の指数が許容範囲を超えている');
  const shift = exponent - fraction.length + 1;
  let whole: string;
  if (shift >= 0) {
    if (digits.length + shift > 17) throw new Error('数量が許容範囲を超えている');
    whole = digits + '0'.repeat(shift);
  } else {
    const removed = -shift;
    if (removed >= digits.length || /[1-9]/.test(digits.slice(-removed))) throw new StepMismatch('数量は最小単位0.1に合う値で入力する');
    whole = digits.slice(0, -removed);
  }
  const ticks = BigInt(whole);
  return match[1] === '-' ? -ticks : ticks;
}

function ticksFromNumber(value: number): bigint {
  if (!Number.isFinite(value)) throw new Error('数量は有限の数値で入力する');
  return Number.isInteger(value) ? BigInt(value) * 10n : ticksFromText(String(value));
}

function checkedTicks(ticks: bigint, step: Step): bigint {
  if (step !== 1 && step !== 0.1) throw new Error('数量の最小単位は1または0.1にする');
  if (step === 1 && ticks % 10n !== 0n) throw new StepMismatch(integerStepText);
  const limit = step === 1 ? integerLimit : decimalLimit;
  if (ticks > limit || ticks < -limit) throw new Error(`数量の絶対値は${scalarLimitText(step)}以下にする`);
  return ticks;
}

export function scalarLimitText(step: Step): string {
  return step === 1 ? String(Number.MAX_SAFE_INTEGER) : '562949953421311.9';
}

function numberFromTicks(ticks: bigint): number {
  const magnitude = ticks < 0n ? -ticks : ticks;
  const value = Number(`${ticks < 0n ? '-' : ''}${magnitude / 10n}.${magnitude % 10n}`);
  if (ticksFromNumber(value) !== ticks) throw new Error('数量を精度を保った数値へ戻せない');
  return value;
}

export function parseSignedScalar(raw: string, step: Step): number {
  let ticks: bigint;
  try {
    ticks = ticksFromText(raw);
  } catch (error) {
    // 原文の読取は0.1より細かい値を0.1の文言で断るので、最小単位1の数量では整数の文言にする。
    if (step === 1 && error instanceof StepMismatch) throw new StepMismatch(integerStepText);
    throw error;
  }
  return numberFromTicks(checkedTicks(ticks, step));
}

export function parseScalar(raw: string, step: Step): number {
  const value = parseSignedScalar(raw, step);
  if (value < 0) throw new Error('入力する数量は0以上にする');
  return value;
}

export function validateSignedScalar(value: number, step: Step): number {
  return numberFromTicks(checkedTicks(ticksFromNumber(value), step));
}

export function validateScalar(value: number, step: Step): number {
  const checked = validateSignedScalar(value, step);
  if (checked < 0) throw new Error('入力する数量は0以上にする');
  return checked;
}

export function addScalar(a: number, b: number, step: Step): number {
  const left = checkedTicks(ticksFromNumber(a), step);
  const right = checkedTicks(ticksFromNumber(b), step);
  return numberFromTicks(checkedTicks(left + right, step));
}

export function subtractScalar(a: number, b: number, step: Step): number {
  const left = checkedTicks(ticksFromNumber(a), step);
  const right = checkedTicks(ticksFromNumber(b), step);
  return numberFromTicks(checkedTicks(left - right, step));
}

export function sumScalars(values: readonly number[], step: Step): number {
  let ticks = checkedTicks(0n, step);
  for (const value of values) ticks = checkedTicks(ticks + checkedTicks(ticksFromNumber(value), step), step);
  return numberFromTicks(ticks);
}

// 時点の差分を戻す途中和は実際の数量とは限らない。各入力と最終和を検査する。
export function sumScalarsFinal(values: readonly number[], step: Step): number {
  let ticks = 0n;
  for (const value of values) ticks += checkedTicks(ticksFromNumber(value), step);
  return numberFromTicks(checkedTicks(ticks, step));
}

// max(0, Σplus−Σminus) − subtrahend。0で打ち切る前後の仮の値は実際の数量ではないので、各入力と結果だけを検査する。
export function positivePartMinus(plus: readonly number[], minus: readonly number[], subtrahend: number, step: Step): number {
  const total = (values: readonly number[]) => values.reduce((ticks, value) => ticks + checkedTicks(ticksFromNumber(value), step), 0n);
  const difference = total(plus) - total(minus);
  return numberFromTicks(checkedTicks((difference > 0n ? difference : 0n) - checkedTicks(ticksFromNumber(subtrahend), step), step));
}

export function multiplyScalarByInteger(value: number, multiplier: number, step: Step): number {
  if (!Number.isSafeInteger(multiplier) || multiplier < 0) throw new Error('倍率は0以上の安全な整数にする');
  const ticks = checkedTicks(ticksFromNumber(value), step);
  return numberFromTicks(checkedTicks(ticks * BigInt(multiplier), step));
}
