import { parseExactJson } from '../domain/exact-json.ts';
import type { Ledger } from '../domain/ledger.ts';
import type { Numeric, Quantity, Term, UnknownQuantity } from '../domain/quantity.ts';
import type { Supply } from '../domain/supply.ts';
import { deepFreeze } from '../domain/ledger.ts';
import { masterTypeLabel, requireSameItemPrecisions } from '../domain/masters.ts';
import { requireQuantityTotals } from '../domain/shortage.ts';
import { decodePending, decodeSnapshot } from './storageparse.ts';
import { isReviewOperation, type ConflictReview } from './conflictrecord.ts';

export type StoreLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export const browserStore: StoreLike = {
  getItem: key => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
  removeItem: key => window.localStorage.removeItem(key),
};
export type OpEntry = { fingerprint: string; units: string[][] };
export type SaveOutcome = 'saved' | 'retried' | 'remainderAbandoned' | 'abandoned';
export type SaveCheck = {
  opId: string; opLabel: string; savedTargets: string[]; unsavedTargets: string[];
  attempt: string; openedAt: string;
  resolution: { outcome: SaveOutcome; actor: string; at: string };
};
export type Snapshot = {
  format: 'fuzzy-stock-f0'; version: 10; revision: number; lastWriter: string; opFloor: number;
  ledger: Ledger; supply: Supply; ops: Readonly<Record<string, OpEntry>>; saveChecks: readonly SaveCheck[];
  conflictReviews: readonly ConflictReview[];
};
export type UnitState = { ledger: Ledger; supply: Supply; conflictReviews: readonly ConflictReview[]; targets: string[] };
export type Pending = {
  progress: 'saving' | 'partial'; unknownSince: string | null; savingSince: string;
  baseRevision: number; opId: string; opLabel: string; fingerprint: string;
  values: Readonly<Record<string, string | boolean>>; actor: string; startedAt: string; units: UnitState[];
};
export type LoadResult =
  | { kind: 'empty' }
  | { kind: 'ok'; snapshot: Snapshot; pending: Pending | null; recovered: SaveCheck | null }
  | { kind: 'unreadable'; reason: string };

export type CommitResult =
  | { kind: 'saved'; snapshot: Snapshot }
  | { kind: 'duplicate'; snapshot: Snapshot; remainder?: { savedTargets: string[]; unsavedTargets: string[] } }
  | { kind: 'mismatch'; reason: string }
  | { kind: 'partial'; snapshot: Snapshot; saved: number; total: number; reason: string; pending: Pending }
  // quota：保存先のnative容量不足（QuotaExceededError）で書けず、未保存と確かめた失敗。上限の超過とは区別する。
  | { kind: 'failed'; reason: string; quota?: true }
  | { kind: 'unreadable'; reason: string }
  | { kind: 'unknown'; pending: Pending }
  | { kind: 'conflict' }
  | { kind: 'recovered'; snapshot: Snapshot; check: SaveCheck };

export const faults: { loseResponseAt: number | null; failMidwayAt: number | null } = { loseResponseAt: null, failMidwayAt: null };

export type SettleResult =
  | { kind: 'settled'; snapshot: Snapshot; outcome: SaveOutcome | null }
  | { kind: 'recovered'; snapshot: Snapshot; check: SaveCheck }
  | { kind: 'failed'; reason: string }
  | { kind: 'unknown'; pending: Pending }
  | { kind: 'conflict' };

export function inquire(store: StoreLike, pending: Pending): { snapshot: Snapshot; savedUnits: number; total: number } {
  const requested = checkedPending(pending);
  const { snapshot } = readHead(store);
  const owned = readPending(store);
  if (owned !== null && !sameRegistration(owned, requested)) throw new Error('保存中の操作が確認した入力と異なる');
  return { snapshot, savedUnits: savedCount(snapshot, requested), total: requested.units.length };
}
export function retry(store: StoreLike, current: Snapshot, pending: Pending, actor: string, at: string): CommitResult {
  const context = settlementContext(store, current, pending);
  if (context.kind !== 'ready') return context;
  if (context.saved === context.pending.units.length) {
    const result = confirmSaved(store, current, context.pending, actor, at);
    if (result.kind !== 'settled') return result;
    const check = matchingCheck(result.snapshot, context.pending);
    return check === null ? { kind: 'duplicate', snapshot: result.snapshot } : { kind: 'recovered', snapshot: result.snapshot, check };
  }
  let prepared: { unit: UnitState; ids: string[] }[];
  let saving: Pending;
  let selected: typeof faults;
  let opFloor: number;
  try {
    prepared = preparedUnits(context.snapshot, context.pending.units.slice(context.saved), context.pending);
    saving = savingPending(context.pending, at);
    opFloor = nextFloor(context.snapshot, saving);
    if (!Number.isSafeInteger(context.snapshot.revision + prepared.length)) throw new Error('保存の版数が整数の精度を超える');
    // 確認者も、最後の単位を書き始める前に検査する。
    if (unknownSinceOf(context.pending) !== null) checkedSnapshot({ ...context.snapshot, saveChecks: [...context.snapshot.saveChecks, saveCheckOf(context.pending, context.pending.units.length, 'retried', actor, at)] });
    selected = takeFaults(prepared.length);
  } catch (error) {
    return { kind: 'failed', reason: reasonOf(error) };
  }
  const markerError = writeSaving(store, context.pending, saving);
  if (markerError !== null) return markerError;
  let snapshot = context.snapshot;
  let slot = context.slot;
  let saved = context.saved;
  for (const [index, { unit, ids }] of prepared.entries()) {
    const check = index === prepared.length - 1 && unknownSinceOf(context.pending) !== null
      ? saveCheckOf(context.pending, saving.units.length, 'retried', actor, at) : null;
    const next = deepFreeze({ ...snapshot, ledger: unit.ledger, supply: unit.supply, conflictReviews: unit.conflictReviews, revision: snapshot.revision + 1,
      lastWriter: saving.opId, opFloor,
      ops: { ...snapshot.ops, [saving.opId]: { fingerprint: saving.fingerprint, units: [...(snapshot.ops[saving.opId]?.units ?? []), ids] } },
      saveChecks: check === null ? snapshot.saveChecks : [...snapshot.saveChecks, check],
    });
    const written = writeSnapshot(store, { snapshot, slot }, next, selected, index + 1);
    if (written.kind === 'unknown') return uncertain(store, saving);
    if (written.kind === 'failed') {
      const retained = saved === 0 ? context.pending : deepFreeze({ ...saving, progress: 'partial' } satisfies Pending);
      const markerError = retainPending(store, saving, retained);
      if (markerError !== null) return markerError;
      const partial = deepFreeze({ ...saving, progress: 'partial' } satisfies Pending);
      return saved === 0 ? written : { kind: 'partial', reason: written.reason, snapshot, saved, total: saving.units.length, pending: partial };
    }
    snapshot = next; slot = written.slot; saved++;
  }
  if (selected.loseResponseAt !== null) return uncertain(store, saving);
  try {
    clearPending(store, saving);
    return { kind: 'saved', snapshot };
  } catch {
    return uncertain(store, saving);
  }
}
export function confirmSaved(store: StoreLike, current: Snapshot, pending: Pending, actor: string, at: string): SettleResult {
  const context = settlementContext(store, current, pending);
  if (context.kind !== 'ready') return context;
  if (context.saved !== context.pending.units.length) return { kind: 'failed', reason: '未保存の単位があるため保存済みと確定できない' };
  return settle(store, context, 'saved', actor, at);
}
export function abandon(store: StoreLike, current: Snapshot, pending: Pending, actor: string, at: string): SettleResult {
  const context = settlementContext(store, current, pending);
  if (context.kind !== 'ready') return context;
  const outcome = settlementOutcome(context.saved, context.pending.units.length);
  return settle(store, context, outcome, actor, at);
}

export function settlementOutcome(saved: number, total: number): SaveOutcome {
  return saved === total ? 'saved' : saved === 0 ? 'abandoned' : 'remainderAbandoned';
}

type HeadState = { snapshot: Snapshot; slot: 'A' | 'B' };
type ReadySettlement = HeadState & { kind: 'ready'; pending: Pending; saved: number };
type SettlementContext = ReadySettlement | Exclude<SettleResult, { kind: 'settled' }>;

function readHead(store: StoreLike): HeadState {
  const slot = store.getItem('fuzzy-stock/head');
  if (slot !== 'A' && slot !== 'B') throw new Error('保存の見出しはAまたはBが必要');
  const text = store.getItem(`fuzzy-stock/slot-${slot}`);
  if (text === null) throw new Error('保存の見出しが指す写しがない');
  return { slot, snapshot: parse(text) };
}

function readPending(store: StoreLike): Pending | null {
  const text = store.getItem('fuzzy-stock/pending');
  return text === null ? null : deepFreeze(decodePending(parseExactJson(text)));
}

function sameRegistration(a: Pending, b: Pending): boolean {
  const identity = (p: Pending) => ({ opId: p.opId, opLabel: p.opLabel, fingerprint: p.fingerprint, values: p.values,
    actor: p.actor, startedAt: p.startedAt, baseRevision: p.baseRevision, units: p.units });
  return sameValue(identity(a), identity(b));
}

function savedCount(snapshot: Snapshot, pending: Pending): number {
  for (const unit of pending.units) requireSameItemPrecisions(snapshot.ledger.masters, unit.ledger.masters);
  if (pending.units.length === 0) throw new Error('確定する単位がない');
  const entry = Object.hasOwn(snapshot.ops, pending.opId) ? snapshot.ops[pending.opId] : undefined;
  // 解消記録がある照合結果は、復旧と同じ条件で保存先の実状態と整合しなければ照会も成り立たない。
  const check = isReviewOperation(pending) ? snapshot.saveChecks.find(saved => saved.opId === pending.opId) : undefined;
  if (check !== undefined && reviewRecoveryBlocked(snapshot, check, pending, pending.units) !== null) throw new Error('解消記録と保存先の照合記録が矛盾している');
  if (!entry) {
    if (!isReviewOperation(pending) || !snapshot.conflictReviews.some(review => review.eventId === pending.opId)) return 0;
    // 索引がなくても同じ操作IDの照合記録があれば、未保存の証明にしない。整合する保存済みの解消記録があるときだけ保存済み。
    if (check !== undefined) return pending.units.length;
    throw new Error('索引がないが同じ操作IDの照合記録が保存先にある');
  }
  if (entry.fingerprint !== pending.fingerprint || entry.units.length > pending.units.length) throw new Error('保存済みの操作索引が入力と違う');
  // 照合結果の索引は、操作IDの一件の記録だけを指す。別の既存記録を指す索引で保存済みと数えない。
  if (isReviewOperation(pending) && !sameValue(entry.units, [[pending.opId]])) throw new Error('保存済みの操作索引が入力と違う');
  const first = pending.units[0];
  const ids = entry.units[0];
  if (ids) {
    if (!first || ids.length === 0 || new Set(ids).size !== ids.length) throw new Error('保存済みの単位の記録IDが入力と違う');
    const ledgerIds = first.ledger.history.map(event => event.eventId);
    const supplyIds = first.supply.log.map(event => event.eventId);
    const reviewIds = first.conflictReviews.map(review => review.eventId);
    const ledgerAdded = ids.filter(id => ledgerIds.includes(id));
    const supplyAdded = ids.filter(id => supplyIds.includes(id));
    const reviewAdded = ids.filter(id => reviewIds.includes(id));
    if (!sameValue(ids, [...ledgerAdded, ...supplyAdded, ...reviewAdded])
      || !sameValue(ledgerAdded, ledgerIds.slice(ledgerIds.length - ledgerAdded.length))
      || !sameValue(supplyAdded, supplyIds.slice(supplyIds.length - supplyAdded.length))
      || !sameValue(reviewAdded, reviewIds.slice(reviewIds.length - reviewAdded.length))) throw new Error('保存済みの単位の記録IDが入力と違う');
  }
  for (let i = 1; i < entry.units.length; i++) {
    const before = pending.units[i - 1]; const after = pending.units[i];
    if (!before || !after || !sameValue(entry.units[i], appendedIds(before, after))) throw new Error('保存済みの単位の記録IDが入力と違う');
  }
  // IDだけが索引にあっても保存済みとはしない。三つの記録列それぞれで、保存先の実記録が入力の記録と全文一致することを確かめる。
  const records = [...snapshot.ledger.history, ...snapshot.supply.log, ...snapshot.conflictReviews];
  for (const [index, ids] of entry.units.entries()) {
    const unit = pending.units[index];
    if (!unit) throw new Error('保存済みの単位が入力にない');
    const expected = [...unit.ledger.history, ...unit.supply.log, ...unit.conflictReviews];
    for (const id of ids) {
      const record = records.find(record => record.eventId === id);
      const intended = expected.find(record => record.eventId === id);
      if (!record || !intended || !sameValue(record, intended)) throw new Error('保存済みの単位の記録が入力と違う');
    }
  }
  return entry.units.length;
}

function matchingCheck(snapshot: Snapshot, pending: Pending): SaveCheck | null {
  return snapshot.saveChecks.find(check => check.opId === pending.opId && check.attempt === attemptOf(pending)) ?? null;
}

function settlementContext(store: StoreLike, current: Snapshot, pending: Pending): SettlementContext {
  try {
    const requested = deepFreeze(checkedPending(pending));
    const head = readHead(store); const owned = readPending(store);
    if (owned !== null && !sameRegistration(owned, requested)) return { kind: 'conflict' };
    const check = matchingCheck(head.snapshot, requested);
    if (check !== null) {
      // 未保存の取りやめ以外は、解消済みでも保存先の照合記録が入力と全文一致するときだけ復旧とする。拒否では障害注入の設定を消費しない。
      if (reviewRecoveryBlocked(head.snapshot, check, requested, requested.units) !== null) return { kind: 'conflict' };
      takeFaults(0);
      if (owned !== null) {
        try { clearPending(store, owned); }
        catch { return uncertain(store, { ...owned, progress: 'saving', unknownSince: check.openedAt }); }
      }
      return { kind: 'recovered', snapshot: head.snapshot, check };
    }
    if (owned === null || head.snapshot.saveChecks.some(check => check.opId === requested.opId) || !sameValue(head.snapshot, current)) return { kind: 'conflict' };
    let saved: number;
    try { saved = savedCount(head.snapshot, owned); }
    catch { return { kind: 'conflict' }; }
    if (saved === 0 ? head.snapshot.revision !== owned.baseRevision : head.snapshot.lastWriter !== owned.opId) return { kind: 'conflict' };
    const last = owned.units[saved - 1];
    if (last && (!sameValue(head.snapshot.ledger, last.ledger) || !sameValue(head.snapshot.supply, last.supply) || !sameValue(head.snapshot.conflictReviews, last.conflictReviews))) return { kind: 'conflict' };
    return { ...head, kind: 'ready', pending: owned, saved };
  } catch (error) {
    return { kind: 'failed', reason: reasonOf(error) };
  }
}

function savingPending(pending: Pending, at: string): Pending {
  return deepFreeze(checkedPending({ ...pending, progress: 'saving', savingSince: at, unknownSince: unknownSinceOf(pending) }));
}

function nextFloor(snapshot: Snapshot, pending: Pick<Pending, 'opId'>): number {
  const number = /^op([1-9]\d*)$/.exec(pending.opId)?.[1];
  const floor = Math.max(snapshot.opFloor, Number(number) + 1);
  if (number === undefined || !Number.isSafeInteger(floor)) throw new Error('操作IDの番号が不正、または整数の精度を超える');
  return floor;
}

function takeFaults(writes: number): typeof faults {
  const selected = { ...faults }; faults.loseResponseAt = null; faults.failMidwayAt = null;
  for (const n of Object.values(selected)) if (n !== null && (!Number.isSafeInteger(n) || n < 1)) throw new Error('試験用の障害の位置は1以上の整数が必要');
  // 応答喪失は全単位の保存後に起こすので（要件5.1）、位置が単位の数を超えても拒否しない。
  if (selected.failMidwayAt !== null && writes > 0 && selected.failMidwayAt > writes) throw new Error('試験用の障害の位置は写しの書き込みの範囲の整数が必要');
  return selected;
}

function writeSaving(store: StoreLike, original: Pending, saving: Pending): Extract<SettleResult, { kind: 'failed' | 'unknown' }> | null {
  try {
    requirePending(store, original);
    store.setItem('fuzzy-stock/pending', serializePending(saving));
    return null;
  } catch (error) {
    try {
      const present = readPending(store);
      if (present !== null && sameValue(present, original)) return { kind: 'failed', reason: reasonOf(error) };
    } catch { /* markerの確定も読めない場合は、保存結果を断定しない。 */ }
    return uncertain(store, saving);
  }
}

function retainPending(store: StoreLike, saving: Pending, retained: Pending): Extract<SettleResult, { kind: 'unknown' }> | null {
  try {
    requirePending(store, saving);
    store.setItem('fuzzy-stock/pending', serializePending(retained));
    return null;
  } catch { return uncertain(store, saving); }
}

function writeSnapshot(store: StoreLike, before: HeadState, next: Snapshot, selected: typeof faults, index: number):
  | { kind: 'written'; slot: 'A' | 'B' } | { kind: 'failed'; reason: string; quota?: true } | { kind: 'unknown' } {
  const slot = before.slot === 'A' ? 'B' : 'A';
  try {
    store.setItem(`fuzzy-stock/slot-${slot}`, serialize(next));
    if (selected.failMidwayAt === index) throw new Error('試験用の保存途中失敗');
    store.setItem('fuzzy-stock/head', slot);
  } catch (error) {
    try { if (sameValue(readHead(store).snapshot, before.snapshot)) return { kind: 'failed', ...failureOf(error) }; }
    catch { /* headの書込後の例外かもしれないので、未保存と断定しない。 */ }
    return { kind: 'unknown' };
  }
  return { kind: 'written', slot };
}

function saveCheckOf(pending: Pending, saved: number, outcome: SaveOutcome, actor: string, at: string): SaveCheck {
  const openedAt = unknownSinceOf(pending);
  if (openedAt === null) throw new Error('保存結果不明の確認事項が開いていない');
  const targets = (units: UnitState[]) => [...new Set(units.flatMap(unit => unit.targets))];
  return { opId: pending.opId, opLabel: pending.opLabel, attempt: attemptOf(pending), openedAt,
    savedTargets: targets(pending.units.slice(0, saved)), unsavedTargets: targets(pending.units.slice(saved)), resolution: { outcome, actor, at } };
}

function clearKnownPending(store: StoreLike, context: ReadySettlement): SettleResult {
  try {
    clearPending(store, context.pending);
    return { kind: 'settled', snapshot: context.snapshot, outcome: null };
  } catch (error) {
    try {
      const remaining = readPending(store);
      if (remaining === null) return { kind: 'settled', snapshot: context.snapshot, outcome: null };
      if (sameValue(remaining, context.pending)) return { kind: 'failed', reason: reasonOf(error) };
      return { kind: 'conflict' };
    } catch { return { kind: 'conflict' }; }
  }
}

function settle(store: StoreLike, context: ReadySettlement, outcome: SaveOutcome, actor: string, at: string): SettleResult {
  let saving: Pending; let next: Snapshot; let selected: typeof faults;
  const opened = unknownSinceOf(context.pending) !== null;
  try {
    const opFloor = nextFloor(context.snapshot, context.pending);
    if (!opened && context.snapshot.opFloor >= opFloor) {
      takeFaults(0);
      return clearKnownPending(store, context);
    }
    saving = savingPending(context.pending, at);
    next = deepFreeze(checkedSnapshot({ ...context.snapshot, revision: context.snapshot.revision + 1, lastWriter: saving.opId, opFloor,
      saveChecks: opened ? [...context.snapshot.saveChecks, saveCheckOf(context.pending, context.saved, outcome, actor, at)] : context.snapshot.saveChecks }));
    selected = takeFaults(1);
  } catch (error) { return { kind: 'failed', reason: reasonOf(error) }; }
  const markerError = writeSaving(store, context.pending, saving);
  if (markerError !== null) return markerError;
  const written = writeSnapshot(store, context, next, selected, 1);
  if (written.kind === 'unknown') return uncertain(store, saving);
  if (written.kind === 'failed') return retainPending(store, saving, context.pending) ?? { kind: 'failed', reason: written.reason };
  if (selected.loseResponseAt !== null) return uncertain(store, saving);
  try {
    clearPending(store, saving);
    return { kind: 'settled', snapshot: next, outcome: opened ? outcome : null };
  } catch { return uncertain(store, saving); }
}

// 照合結果の復旧・重複判定が成り立たない理由。保存済みの解消は、fingerprintが同じでも保存先の実記録が入力の記録と全文一致するときだけ認める。
// 未保存の取りやめは、保存先に同じ操作IDの照合記録も索引もないときだけ認める。実記録があるのに未保存とは扱わない。
function reviewRecoveryBlocked(snapshot: Snapshot, check: { resolution: Pick<SaveCheck['resolution'], 'outcome'> } | undefined | null, op: Pick<Pending, 'opId' | 'opLabel' | 'fingerprint'>, units: readonly UnitState[]): string | null {
  if (!isReviewOperation(op)) return null;
  if (check?.resolution.outcome === 'abandoned') {
    return Object.hasOwn(snapshot.ops, op.opId) || snapshot.conflictReviews.some(review => review.eventId === op.opId)
      ? `操作ID ${op.opId} は未保存の取りやめと記録されているが、保存先に同じ操作IDの照合記録または索引がある` : null;
  }
  const entry = Object.hasOwn(snapshot.ops, op.opId) ? snapshot.ops[op.opId] : undefined;
  if (entry !== undefined && !sameValue(entry.units, [[op.opId]])) return `操作ID ${op.opId} の索引が照合記録の一件を指していない`;
  const stored = snapshot.conflictReviews.find(review => review.eventId === op.opId), intended = units[0]?.conflictReviews.at(-1);
  return stored === undefined || intended === undefined || !sameValue(stored, intended) ? `操作ID ${op.opId} の照合記録が入力と違う` : null;
}

export function commit(store: StoreLike, current: Snapshot, op: Omit<Pending, 'units' | 'progress' | 'unknownSince' | 'baseRevision'>, units: UnitState[]): CommitResult {
  let pending: Pending;
  let prepared: { unit: UnitState; ids: string[] }[];
  let slot: 'A' | 'B';
  let opFloor: number;
  let selected: typeof faults;
  try {
    const loaded = load(store);
    if (loaded.kind === 'unreadable') return loaded;
    if (loaded.kind !== 'ok') return { kind: 'conflict' };
    if (loaded.pending !== null) return { kind: 'conflict' };
    const entry = Object.hasOwn(loaded.snapshot.ops, op.opId) ? loaded.snapshot.ops[op.opId] : undefined;
    if (entry) {
      if (entry.fingerprint !== op.fingerprint) return { kind: 'mismatch', reason: `操作ID ${op.opId} は違う内容で使用済み` };
      const check = loaded.snapshot.saveChecks.find(check => check.opId === op.opId);
      const differs = reviewRecoveryBlocked(loaded.snapshot, check, op, units);
      if (differs !== null) return { kind: 'mismatch', reason: differs };
      if (check !== undefined) return { kind: 'recovered', snapshot: loaded.snapshot, check };
      const remainder = units.length > entry.units.length ? {
        savedTargets: [...new Set(units.slice(0, entry.units.length).flatMap(unit => unit.targets))],
        unsavedTargets: [...new Set(units.slice(entry.units.length).flatMap(unit => unit.targets))],
      } : undefined;
      return { kind: 'duplicate', snapshot: loaded.snapshot, ...(remainder === undefined ? {} : { remainder }) };
    }
    // 一つも保存せずに取りやめた操作は ops に載らないので、同じ内容の再送には記録済みの解消を返す。
    const abandoned = loaded.snapshot.saveChecks.find(check => check.opId === op.opId && JSON.parse(check.attempt)[2] === op.fingerprint);
    if (abandoned !== undefined) {
      // 照合結果は、未保存の取りやめ以外の解消記録が索引なしで残っていても、保存先の実記録が入力と全文一致するときだけ復旧とする。
      const differs = reviewRecoveryBlocked(loaded.snapshot, abandoned, op, units);
      if (differs !== null) return { kind: 'mismatch', reason: differs };
      return { kind: 'recovered', snapshot: loaded.snapshot, check: abandoned };
    }
    if (!sameValue(loaded.snapshot, current) || loaded.pending !== null) return { kind: 'conflict' };
    opFloor = nextFloor(current, op);
    if (Number(op.opId.slice(2)) < current.opFloor || current.saveChecks.some(check => check.opId === op.opId)) return { kind: 'mismatch', reason: `操作ID ${op.opId} は使用済みのため新しい保存に使えない` };
    if (units.length === 0 || !Number.isSafeInteger(current.revision + units.length)) throw new Error('確定する単位がない、または保存の版数が整数の精度を超える');
    pending = deepFreeze(checkedPending({ ...op, units, progress: 'saving', unknownSince: null, savingSince: op.startedAt, baseRevision: current.revision }));
    for (const unit of pending.units) requireSameItemPrecisions(current.ledger.masters, unit.ledger.masters);
    prepared = preparedUnits(current, pending.units, pending);
    const head = store.getItem('fuzzy-stock/head');
    if (head !== 'A' && head !== 'B') return { kind: 'conflict' };
    slot = head;
    selected = takeFaults(prepared.length);
  } catch (error) {
    return { kind: 'failed', reason: reasonOf(error) };
  }

  try {
    store.setItem('fuzzy-stock/pending', serializePending(pending));
  } catch (error) {
    try {
      if (store.getItem('fuzzy-stock/pending') !== null) clearPending(store, pending);
      return { kind: 'failed', ...failureOf(error) };
    } catch {
      return uncertain(store, pending);
    }
  }

  let snapshot = current;
  let saved = 0;
  for (const { unit, ids } of prepared) {
    const next = deepFreeze({ ...snapshot, ledger: unit.ledger, supply: unit.supply, conflictReviews: unit.conflictReviews,
      revision: snapshot.revision + 1, lastWriter: op.opId, opFloor,
      ops: { ...snapshot.ops, [op.opId]: { fingerprint: op.fingerprint, units: [...(snapshot.ops[op.opId]?.units ?? []), ids] } },
    });
    const written = writeSnapshot(store, { snapshot, slot }, next, selected, saved + 1);
    if (written.kind === 'unknown') return uncertain(store, pending);
    if (written.kind === 'failed') {
      try {
        if (saved === 0) {
          clearPending(store, pending);
          return written;
        }
        const partial = deepFreeze({ ...pending, progress: 'partial' } satisfies Pending);
        return retainPending(store, pending, partial) ?? { kind: 'partial', reason: written.reason, snapshot, saved, total: prepared.length, pending: partial };
      } catch {
        return uncertain(store, pending);
      }
    }
    snapshot = next;
    slot = written.slot;
    saved++;
  }
  if (selected.loseResponseAt !== null) return uncertain(store, pending);
  try {
    clearPending(store, pending);
    return { kind: 'saved', snapshot };
  } catch {
    return uncertain(store, pending);
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function failureOf(error: unknown): { reason: string; quota?: true } {
  return { reason: reasonOf(error), ...(error instanceof DOMException && error.name === 'QuotaExceededError' ? { quota: true as const } : {}) };
}

// 数量を表の番号にしてから比べる。メモリ上の数量は観測の並びを数量ごとに持つので、そのまま文字列にすると比較が操作数の二乗で遅くなる。
function sameValue(a: unknown, b: unknown): boolean {
  const x = encodeQuantities(a, true); const y = encodeQuantities(b, true);
  return x.body === y.body && x.table === y.table;
}

export function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  return sameValue(a, b);
}

// 新しい写しになる単位は、新規の保存も再試行もここを通す。合計の検査を保存の経路ごとに置くと、通らない経路が残る。
function preparedUnits(before: Pick<UnitState, 'ledger' | 'supply' | 'conflictReviews'>, units: readonly UnitState[], op: Pick<Pending, 'opId' | 'opLabel' | 'fingerprint'>): { unit: UnitState; ids: string[] }[] {
  const reviewOp = isReviewOperation(op);
  return units.map(unit => {
    requireQuantityTotals(unit.ledger, unit.supply);
    const ids = appendedIds(before, unit);
    const added = unit.conflictReviews.length - before.conflictReviews.length;
    // 照合結果は照合専用の保存だけが一単位・一記録で追記し、通常の業務保存は列を変えない。
    if (added !== (reviewOp ? 1 : 0)) throw new Error(reviewOp ? '照合結果の保存は照合記録を一件だけ追記する' : '通常の業務保存は照合記録を追記できない');
    before = unit;
    return { unit, ids };
  });
}

function appendedIds(before: Pick<UnitState, 'ledger' | 'supply' | 'conflictReviews'>, after: UnitState): string[] {
  requireSameItemPrecisions(before.ledger.masters, after.ledger.masters);
  // 既存の照合記録は完全一致の接頭辞として残し、追記は末尾に高々一件。
  const reviewPrefix = after.conflictReviews.slice(0, before.conflictReviews.length);
  const reviews = after.conflictReviews.slice(before.conflictReviews.length);
  if (!sameValue(reviewPrefix, before.conflictReviews) || reviews.length > 1) throw new Error('確定する単位が既存の照合記録を変更している');
  const ledgerPrefix = after.ledger.history.slice(0, before.ledger.history.length);
  const supplyPrefix = after.supply.log.slice(0, before.supply.log.length);
  if (!sameValue(ledgerPrefix, before.ledger.history) || !sameValue(supplyPrefix, before.supply.log)) throw new Error('確定する単位の履歴が現在の状態に続いていない');
  const events = after.ledger.history.slice(before.ledger.history.length);
  const log = after.supply.log.slice(before.supply.log.length);
  const ids = [...events, ...log, ...reviews].map(event => event.eventId);
  const used = new Set([...before.ledger.history, ...before.supply.log].map(event => event.eventId));
  if (reviews.length > 0 && ids.length > 1) throw new Error('照合記録を追加する単位は他の記録を追加しない');
  if (ids.length === 0 || ids.some(id => used.has(id)) || new Set(ids).size !== ids.length) throw new Error('確定する単位に新しい記録のIDが必要');
  const lots = { ...before.ledger.lots };
  for (const event of events) {
    for (const change of event.changes) {
      if (!sameValue(change.before, lots[change.after.id] ?? null)) throw new Error('確定する単位の変更前の保管単位が現在の状態と違う');
      lots[change.after.id] = change.after;
    }
  }
  if (!sameValue(lots, after.ledger.lots) || (events.length === 0 && !sameValue(before.ledger, after.ledger)) || (log.length === 0 && !sameValue(before.supply, after.supply))) throw new Error('確定する単位の現在値が記録に対応していない');
  return ids;
}

function requirePending(store: StoreLike, pending: Pending): void {
  const text = store.getItem('fuzzy-stock/pending');
  if (text === null || !sameRegistration(decodePending(parseExactJson(text)), pending)) throw new Error('保存中の操作が変わっている');
}

function clearPending(store: StoreLike, pending: Pending): void {
  requirePending(store, pending);
  store.removeItem('fuzzy-stock/pending');
}

function uncertain(store: StoreLike, pending: Pending): { kind: 'unknown'; pending: Pending } {
  try {
    const text = store.getItem('fuzzy-stock/pending');
    const existing = text === null ? null : decodePending(parseExactJson(text));
    if (existing === null || (attemptOf(existing) === attemptOf(pending) && existing.progress !== 'saving')) store.setItem('fuzzy-stock/pending', serializePending(pending));
  } catch {
    // markerの書き直しも失敗し得る。確定済みの写しを未保存と決めつけず、残せた証跡で照会を求める。
  }
  return { kind: 'unknown', pending };
}

export function parse(text: string): Snapshot {
  const value: unknown = parseExactJson(text);
  return deepFreeze(decodeSnapshot(value));
}

// メモリ上の値の検査も、数量を表にした形を通す。展開した入れ子をそのまま復号すると、数が不明の入れ子で操作数の三乗の時間がかかる。
function checkedPending(value: Pending): Pending {
  return decodePending(parseExactJson(serializePending(value)));
}

function checkedSnapshot(value: Snapshot): Snapshot {
  return decodeSnapshot(parseExactJson(encodeWithQuantities(value)));
}

export function serializePending(pending: Pending): string {
  return encodeWithQuantities({ format: 'fuzzy-stock-pending', version: 10, pending });
}

export function serialize(snapshot: Snapshot): string {
  return encodeWithQuantities(snapshot);
}

type QuantityItem =
  | { kind: 'known'; numeric: Numeric; computed: boolean; terms: number }
  | { kind: 'partlyUnknown'; numeric: Numeric | null; unknownParts: number; terms: number }
  | { kind: 'unknown'; before: number | null; terms: number };
type ListNode = unknown[] | { concat: [left: number, right: number] };

function isQuantity(value: unknown): value is Quantity {
  return typeof value === 'object' && value !== null && 'kind' in value && 'terms' in value && Array.isArray(value.terms)
    && (value.kind === 'known' || value.kind === 'partlyUnknown' || value.kind === 'unknown');
}

// 数量を表の番号に置き換え、本文の末尾に表を足す。履歴の各記録は前後の数量を丸ごと持ち、観測の並びは操作ごとに伸びるので、
// 並びと数量を共有しないと、写しが操作数の二乗（数が不明の入れ子では三乗）で増える。
function encodeWithQuantities(value: object): string {
  const { body, table } = encodeQuantities(value, false);
  return table === null ? body : `${body.slice(0, -1)},"quantities":${table}}`;
}

// 並びの番号0は空の並び。節は「親の並び＋新しい要素」か「既知の並び＋既知の並び全体」を表す。
// 数量の和は二つの並びをつなぐので、先頭の共有だけでは、古いまとまりを新しいまとまりへ合流させるたびに古い並びを書き直すことになる。
function listTable<E extends object>(payload: (element: E) => unknown[], replacer: (key: string, value: unknown) => unknown) {
  const nodes: ListNode[] = [];
  const runs: { source: readonly E[]; length: number }[] = [{ source: [], length: 0 }];
  const keys = new WeakMap<E, string>();
  const keyOf = (element: E): string => {
    let key = keys.get(element);
    if (key === undefined) { key = JSON.stringify(payload(element), replacer); keys.set(element, key); }
    return key;
  };
  const byStart = new Map<string, Map<number, number[]>>();
  const ids = new Map<string, number>();
  const whole = new WeakMap<readonly E[], number>();
  const matches = (id: number, list: readonly E[], from: number): boolean => {
    const run = runs[id];
    if (run === undefined) return false;
    for (let x = 0; x < run.length; x++) {
      const a = run.source[x]; const b = list[from + x];
      if (a === undefined || b === undefined || (a !== b && keyOf(a) !== keyOf(b))) return false;
    }
    return true;
  };
  const find = (list: readonly E[], from: number, length: number): number | undefined => {
    const first = list[from];
    return first === undefined ? undefined : byStart.get(keyOf(first))?.get(length)?.find(id => matches(id, list, from));
  };
  const node = (key: string, entry: ListNode, source: readonly E[], length: number): number => {
    const known = ids.get(key);
    if (known !== undefined) return known;
    nodes.push(entry);
    const id = nodes.length;
    ids.set(key, id);
    runs.push({ source, length });
    const first = source[0];
    if (first !== undefined) {
      const lengths = byStart.get(keyOf(first)) ?? new Map<number, number[]>();
      byStart.set(keyOf(first), lengths);
      const same = lengths.get(length);
      if (same === undefined) lengths.set(length, [id]); else same.push(id);
    }
    return id;
  };
  // nested は、つなぐ相手として独立に符号化する残りの並び。そこではさらに分けず、既知の先頭部分に要素を足す。
  const encode = (list: readonly E[], nested = false): number => {
    const known = whole.get(list);
    if (known !== undefined) return known;
    let id = 0; let i = 0;
    for (let length = list.length; length > 0 && i === 0; length--) {
      const found = find(list, 0, length);
      if (found !== undefined) { id = found; i = length; }
    }
    // 既知の先頭部分の後ろが二つ以上なら、残りを独立した並びにしてつなぐ。適用しない数え直しの差異のように、
    // 新しい観測の後ろに前回と同じ並びが伸びて続く形では、残りが前回の残りを先頭部分として共有できる。
    const [first] = list;
    if (!nested && i === 0 && first !== undefined) { id = node(`0:${keyOf(first)}`, [0, ...payload(first)], list, 1); i = 1; }
    if (!nested && list.length - i > 1) {
      const rest = encode(list.slice(i), true);
      id = node(`${id}+${rest}`, { concat: [id, rest] }, list, list.length);
      whole.set(list, id);
      return id;
    }
    for (let element = list[i]; element !== undefined; element = list[i]) {
      const run = i > 0 ? find(list, i, list.length - i) : undefined;
      if (run !== undefined) { id = node(`${id}+${run}`, { concat: [id, run] }, list, list.length); break; }
      i++;
      id = node(`${id}:${keyOf(element)}`, [id, ...payload(element)], list, i);
    }
    whole.set(list, id);
    return id;
  };
  return { nodes, encode };
}

// sortKeys は比較用で、オブジェクトの欄の順序の違いを無視する。表の項目は欄の順序を固定して作るので並べ替えない。
function encodeQuantities(value: unknown, sortKeys: boolean): { body: string; table: string | null } {
  // 保存では、JSONがnullに変えてしまう数値を拒否する。nullとして書くと、元と違う値の記録が復号の検査を通ってしまう。
  const finite = (_key: string, v: unknown): unknown => {
    if (!sortKeys && typeof v === 'number' && !Number.isFinite(v)) throw new Error('JSONで表せない数値は保存できない');
    return v;
  };
  const terms = listTable<Term>(t => [t.sign, t.observation.id, t.observation.basis, t.observation.value], finite);
  const parts = listTable<UnknownQuantity>(part => [item(part)], finite);
  const items: QuantityItem[] = []; const itemIds = new Map<string, number>();
  const seen = new WeakMap<Quantity, number>();
  const numericOf = (n: Numeric): Numeric => ({ value: n.value, approximate: n.approximate, unconfirmed: n.unconfirmed });
  function item(q: Quantity): number {
    const known = seen.get(q);
    if (known !== undefined) return known;
    let entry: QuantityItem;
    switch (q.kind) {
      case 'known': entry = { kind: q.kind, numeric: numericOf(q.numeric), computed: q.computed, terms: terms.encode(q.terms) }; break;
      case 'partlyUnknown': entry = { kind: q.kind, numeric: q.numeric === null ? null : numericOf(q.numeric), unknownParts: parts.encode(q.unknownParts), terms: terms.encode(q.terms) }; break;
      case 'unknown': entry = { kind: q.kind, before: q.before === null ? null : item(q.before), terms: terms.encode(q.terms) }; break;
    }
    const key = JSON.stringify(entry);
    let id = itemIds.get(key);
    if (id === undefined) { items.push(entry); id = items.length - 1; itemIds.set(key, id); }
    seen.set(q, id);
    return id;
  }
  // 履歴は古い順なので、記録の前後の数量を先に表へ入れておくと、後の並びが前の並びをつなぎとして参照できる。
  // 本文の順（現在のまとまりが先）のままだと、最新の長い並びを先に要素ごとに書いてしまう。
  const visit = (v: unknown): void => {
    if (typeof v !== 'object' || v === null || isQuantity(v)) return;
    if (Array.isArray(v)) { for (const child of v) visit(child); return; }
    if ('changes' in v && Array.isArray(v.changes)) {
      const changes: unknown[] = v.changes;
      for (const side of ['before', 'after']) {
        for (const change of changes) {
          const lot: unknown = typeof change === 'object' && change !== null ? Object.entries(change).find(([key]) => key === side)?.[1] : undefined;
          const quantity: unknown = typeof lot === 'object' && lot !== null && 'quantity' in lot ? lot.quantity : undefined;
          if (isQuantity(quantity)) item(quantity);
        }
      }
    }
    for (const [key, child] of Object.entries(v)) {
      if ((key === 'compared' || key === 'difference') && isQuantity(child)) item(child);
      visit(child);
    }
  };
  visit(value);
  const body = JSON.stringify(value, (key, v: unknown) => {
    if (isQuantity(v)) return item(v);
    finite(key, v);
    if (sortKeys && typeof v === 'object' && v !== null && !Array.isArray(v)) return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    return v;
  });
  return { body, table: items.length === 0 ? null : JSON.stringify({ terms: terms.nodes, parts: parts.nodes, items }, finite) };
}

export function initial(ledger: Ledger, supply: Supply): Snapshot {
  return deepFreeze({ format: 'fuzzy-stock-f0', version: 10, revision: 0, lastWriter: 'init', opFloor: 1, ledger, supply, ops: {}, saveChecks: [], conflictReviews: [] });
}

export function load(store: StoreLike): LoadResult {
  try {
    recoverInterruptedReset(store);
    const head = store.getItem('fuzzy-stock/head');
    const pendingText = store.getItem('fuzzy-stock/pending');
    if (head === null) {
      // headが消えていても残存データを空とみなして上書きしない。
      if (pendingText !== null || store.getItem('fuzzy-stock/slot-A') !== null || store.getItem('fuzzy-stock/slot-B') !== null) throw new Error('保存の見出しがないが、写しまたは保存中の操作が残っている');
      return { kind: 'empty' };
    }
    if (head !== 'A' && head !== 'B') throw new Error('保存の見出しはAまたはBが必要');
    const text = store.getItem(`fuzzy-stock/slot-${head}`);
    if (text === null) throw new Error('保存の見出しが指す写しがない');
    const snapshot = parse(text);
    const pendingValue: unknown = pendingText === null ? null : parseExactJson(pendingText);
    const pending = pendingText === null ? null : deepFreeze(decodePending(pendingValue));
    if (pending !== null) {
      for (const unit of pending.units) requireSameItemPrecisions(snapshot.ledger.masters, unit.ledger.masters);
      const check = matchingCheck(snapshot, pending);
      let completed = false;
      if (check === null && !snapshot.saveChecks.some(check => check.opId === pending.opId) && unknownSinceOf(pending) === null) {
        try { completed = savedCount(snapshot, pending) === pending.units.length; }
        catch { /* 不一致の索引は復旧の根拠にしない。 */ }
      }
      const recoverable = check === null || reviewRecoveryBlocked(snapshot, check, pending, pending.units) === null;
      if ((check !== null && recoverable) || completed) {
        try { clearPending(store, pending); }
        catch (error) {
          uncertain(store, pending);
          throw error;
        }
        return { kind: 'ok', snapshot, pending: null, recovered: check };
      }
    }
    return { kind: 'ok', snapshot, pending, recovered: null };
  } catch (error) {
    return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
  }
}

// 置き換えの途中で、保存先が前の記録のままか新しい記録かを確かめられなくなったとき。呼び出し側は記録を止め、再読込を求める。
export class ReplaceUncertain extends Error {}

// 操作の索引・保存結果の解消・次の操作IDの下限は、復元で再送の見分けと操作IDを持ち越すために渡す。省けば初期化と同じ空の値になる。
export type RecordContents = Pick<Snapshot, 'ledger' | 'supply'> & Partial<Pick<Snapshot, 'ops' | 'saveChecks' | 'opFloor' | 'conflictReviews'>>;

function snapshotFrom(next: RecordContents, revision: number): Snapshot {
  if (!Number.isSafeInteger(revision)) throw new Error('保存の版数が整数の精度を超える');
  return parse(serialize({ ...initial(next.ledger, next.supply), revision, ops: next.ops ?? {}, saveChecks: next.saveChecks ?? [], conflictReviews: next.conflictReviews ?? [], opFloor: next.opFloor ?? 1 }));
}

// 見出しの書き込みが例外になったあと、見出しを読み直して判定する。読み直せない、またはどちらとも違うときは、前の記録のままとは言えない。
function headAfterFailure(store: StoreLike, slot: 'A' | 'B', written: Snapshot, previousHead: string | null): 'new' | 'previous' | 'unknown' {
  try {
    const now = store.getItem('fuzzy-stock/head');
    if (now === previousHead) return 'previous';
    if (now !== slot) return 'unknown';
    const text = store.getItem(`fuzzy-stock/slot-${slot}`);
    return text !== null && sameValue(parse(text), written) ? 'new' : 'unknown';
  } catch { return 'unknown'; }
}

const replaceUncertain = (error: unknown): ReplaceUncertain => new ReplaceUncertain(`保存先が置き換え前のままか確かめられない（${reasonOf(error)}）`);

function restoreItem(store: StoreLike, key: string, previous: string | null): boolean {
  try {
    if (store.getItem(key) === previous) return true;
    if (previous === null) store.removeItem(key);
    else store.setItem(key, previous);
  } catch { /* 応答だけ失敗した場合も、保存値を読み直して確かめる。 */ }
  try { return store.getItem(key) === previous; }
  catch { return false; }
}

const resetRecoveryKey = 'fuzzy-stock/reset-recovery';

// 読めない記録の置換だけに使う退避。画面終了後も、元の文字列を復旧し終えるまで消さない。
function recoverInterruptedReset(store: StoreLike): void {
  const text = store.getItem(resetRecoveryKey);
  if (text === null) return;
  const saved: unknown = parseExactJson(text);
  if (typeof saved !== 'object' || saved === null || !('slot' in saved) || !('previousHead' in saved)
    || !('previousSlot' in saved) || !('savedPending' in saved) || !('nextText' in saved) || !('previousRecovery' in saved)
    || (saved.slot !== 'A' && saved.slot !== 'B')
    || (saved.previousHead !== null && typeof saved.previousHead !== 'string')
    || (saved.previousSlot !== null && typeof saved.previousSlot !== 'string')
    || (saved.savedPending !== null && typeof saved.savedPending !== 'string')
    || (saved.previousRecovery !== null && typeof saved.previousRecovery !== 'string')
    || typeof saved.nextText !== 'string') throw new Error('復元の退避を読み込めない。元の退避は残している');
  const head = store.getItem('fuzzy-stock/head');
  const slotKey = `fuzzy-stock/slot-${saved.slot}`;
  const slot = store.getItem(slotKey);
  const pending = store.getItem('fuzzy-stock/pending');
  const committed = head === saved.slot && slot === saved.nextText && pending === null;
  if (!committed) {
    if ((head !== saved.previousHead && head !== saved.slot)
      || (slot !== saved.previousSlot && slot !== saved.nextText)
      || (pending !== saved.savedPending && pending !== null)) throw new Error('復元の途中で保存先が変わった。元の退避は残している');
    if (!restoreItem(store, slotKey, saved.previousSlot)
      || !restoreItem(store, 'fuzzy-stock/pending', saved.savedPending)
      || !restoreItem(store, 'fuzzy-stock/head', saved.previousHead)) throw new Error('復元前の記録を戻せない。元の退避は残している');
  }
  if (!restoreItem(store, resetRecoveryKey, committed ? null : saved.previousRecovery)) throw new Error('復元の退避を片付けられない。再読込して確かめる');
  if (!committed && saved.previousRecovery !== null) throw new Error('元の復元の退避が残っている。明示復元で置き換えられる');
}

export function replace(store: StoreLike, current: Snapshot | null, next: RecordContents): Snapshot {
  const loaded = load(store);
  if (loaded.kind === 'unreadable') throw new Error(loaded.reason);
  if (loaded.kind === 'ok' && loaded.pending !== null) throw new Error('保存中の操作を確かめてから初期化する');
  if (current === null ? loaded.kind !== 'empty' : loaded.kind !== 'ok' || loaded.snapshot.revision !== current.revision) throw new Error('保存先の状態が変わっている');
  const snapshot = snapshotFrom(next, current === null ? 0 : current.revision + 1);
  const previousHead = store.getItem('fuzzy-stock/head');
  const slot = previousHead === 'A' ? 'B' : 'A';
  try {
    store.setItem(`fuzzy-stock/slot-${slot}`, serialize(snapshot));
    store.setItem('fuzzy-stock/head', slot);
  } catch (error) {
    // 書込後の例外でも、見出しが新しい写しを指していれば置換は確定している。
    const outcome = headAfterFailure(store, slot, snapshot, previousHead);
    if (outcome === 'new') return snapshot;
    if (outcome === 'previous') {
      // 空の保存先では、見出しのない写しが残ると次の起動で空ではなく読み込めない記録になるので、書いた写しを片付ける。
      if (previousHead === null && !restoreItem(store, `fuzzy-stock/slot-${slot}`, null)) throw replaceUncertain(error);
      throw error;
    }
    throw replaceUncertain(error);
  }
  return snapshot;
}

// 古いpendingの削除は見出しの切り替えより前に置く。切り替えのあとに消すと、削除だけが失敗したとき、保存先は新しい記録なのに
// 失敗が返り、新しい写しのそばに古いpendingが残って記録が止まったままになる。切り替えが失敗したらpendingを書き戻す。
export function confirmedUnreadableReset(store: StoreLike, next: RecordContents): Snapshot {
  try { recoverInterruptedReset(store); }
  catch { /* 明示的な置換では、復旧不能な退避自体も新しい退避の中へ保持してから進む。 */ }
  if (load(store).kind !== 'unreadable') throw new Error('読み込める記録には通常の初期化を使う');
  let revision = 0;
  try { revision = readHead(store).snapshot.revision + 1; }
  catch { /* 元の版を確かめられない明示初期化は版0から始める。 */ }
  const snapshot = snapshotFrom(next, revision);
  const previousHead = store.getItem('fuzzy-stock/head');
  const savedPending = store.getItem('fuzzy-stock/pending');
  const slot = previousHead === 'A' ? 'B' : 'A';
  const slotKey = `fuzzy-stock/slot-${slot}`;
  // 見出しが欠損・不正な場合は、書く側にも旧記録が残っている。復元失敗時に文字列のまま戻せるよう控える。
  const previousSlot = store.getItem(slotKey);
  const previousRecovery = store.getItem(resetRecoveryKey);
  const nextText = serialize(snapshot);
  const recovery = JSON.stringify({ slot, previousHead, previousSlot, savedPending, nextText, previousRecovery });
  try { store.setItem(resetRecoveryKey, recovery); }
  catch (error) {
    if (store.getItem(resetRecoveryKey) !== recovery) throw error;
  }
  if (store.getItem(resetRecoveryKey) !== recovery) throw replaceUncertain(new Error('復元前の記録の退避を確かめられない'));
  try { store.setItem(slotKey, nextText); }
  catch (error) {
    if (!restoreItem(store, slotKey, previousSlot)) throw replaceUncertain(error);
    if (!restoreItem(store, resetRecoveryKey, previousRecovery)) throw replaceUncertain(error);
    throw error;
  }
  if (savedPending !== null) {
    try { store.removeItem('fuzzy-stock/pending'); }
    catch (error) {
      let remains: boolean | null;
      try { remains = store.getItem('fuzzy-stock/pending') !== null; }
      catch { remains = null; }
      // 残っているか分からないまま見出しを切り替えると、残っていた場合に新しい写しのそばへ古いpendingが残る。
      if (remains === null) { restoreItem(store, slotKey, previousSlot); throw replaceUncertain(error); }
      if (remains) {
        if (!restoreItem(store, slotKey, previousSlot)) throw replaceUncertain(error);
        if (!restoreItem(store, resetRecoveryKey, previousRecovery)) throw replaceUncertain(error);
        throw error;
      }
    }
  }
  try {
    store.setItem('fuzzy-stock/head', slot);
  } catch (error) {
    const outcome = headAfterFailure(store, slot, snapshot, previousHead);
    if (outcome === 'new') {
      if (!restoreItem(store, resetRecoveryKey, null)) throw replaceUncertain(error);
      return snapshot;
    }
    if (outcome === 'unknown') throw replaceUncertain(error);
    const pendingRestored = restoreItem(store, 'fuzzy-stock/pending', savedPending);
    const slotRestored = restoreItem(store, slotKey, previousSlot);
    if (!pendingRestored || !slotRestored) throw replaceUncertain(error);
    if (!restoreItem(store, resetRecoveryKey, previousRecovery)) throw replaceUncertain(error);
    throw error;
  }
  if (!restoreItem(store, resetRecoveryKey, null)) throw replaceUncertain(new Error('復元の退避を片付けられない'));
  return snapshot;
}

export function fingerprintOf(opLabel: string, values: Readonly<Record<string, string | boolean>>): string {
  return JSON.stringify([opLabel, Object.keys(values).sort().map(key => [key, values[key]])]);
}

export function nextOpIdOf(snapshot: Snapshot): string {
  return `op${Math.max(snapshot.ledger.history.length + snapshot.supply.log.length + 1, snapshot.opFloor)}`;
}

export function unknownSinceOf(pending: Pending): string | null {
  return pending.unknownSince ?? (pending.progress === 'saving' ? pending.savingSince : null);
}

export function attemptOf(pending: Pending): string {
  return JSON.stringify([pending.opId, pending.startedAt, pending.fingerprint]);
}

export function targetsOf(before: UnitState | { ledger: Ledger; supply: Supply; conflictReviews?: readonly ConflictReview[] }, after: { ledger: Ledger; supply: Supply; conflictReviews?: readonly ConflictReview[] }): string[] {
  const targets = new Set<string>();
  // 照合結果の保存単位は、元入力の識別子を対象にする。数量や台帳の対象とは別の名前空間で表示する。
  for (const review of (after.conflictReviews ?? []).slice(before.conflictReviews?.length ?? 0)) targets.add(`競合照合${review.reviewId}`);
  const issueLotOf = (id: string): string | null => (after.ledger.issues[id] ?? before.ledger.issues[id])?.lotId ?? null;
  const lotTargetsOf = (event: Ledger['history'][number]): string[] => {
    const lots = event.changes.map(change => `まとまり${change.after.id}`);
    if ('lotId' in event) lots.push(`まとまり${event.lotId}`);
    if (event.kind === 'reworkPart') {
      if (event.subjectLotId !== undefined) lots.push(`まとまり${event.subjectLotId}`);
      const references = [event.reworkId, ...(event.action === 'replace' ? [event.useEventId] : event.action === 'recover' ? [event.registerEventId] : [])];
      for (const id of references) {
        const reference = after.ledger.history.find(e => e.eventId === id);
        if (reference) {
          lots.push(...reference.changes.map(c => `まとまり${c.after.id}`));
          if ('lotId' in reference) lots.push(`まとまり${reference.lotId}`);
        }
      }
    }
    return lots;
  };
  for (const event of after.ledger.history.slice(before.ledger.history.length)) {
    const local = new Set(lotTargetsOf(event));
    switch (event.kind) {
      case 'correctTime': {
        local.add(`操作${event.targetEventId}`);
        const target = after.ledger.history.find(e => e.eventId === event.targetEventId) ?? before.ledger.history.find(e => e.eventId === event.targetEventId);
        if (target) {
          for (const lot of lotTargetsOf(target)) local.add(lot);
          if (target.kind === 'resolve') {
            const lotId = issueLotOf(target.issueId);
            if (lotId !== null) local.add(`まとまり${lotId}`);
          }
        }
        break;
      }
      case 'resolve': {
        local.add(`照合事項${event.issueId}`);
        const lotId = issueLotOf(event.issueId);
        if (lotId !== null) local.add(`まとまり${lotId}`);
        break;
      }
      case 'stopUpdate': case 'resume': local.add(`停止${event.stopId}`); break;
      case 'stop': local.add(`停止${event.stop.id}`); break;
      case 'void': local.add(`操作${event.targetEventId}`); break;
      case 'master':
        for (const { after } of event.masters) local.add(`${masterTypeLabel[after.type]}${after.type === 'actor' ? after.id : after.code ?? `（仮）${after.name ?? after.id}`}`);
        break;
      case 'identify': case 'adopt': local.add(`照合事項${event.issueId}`); break;
      case 'assignProject': break;
      case 'reworkPart': local.add(`操作${event.reworkId}`); break;
      case 'rework': {
        if (event.returnSource !== undefined) {
          local.add(`操作${event.returnSource.adoptEventId}`);
          const source = after.ledger.history.find(e => e.eventId === event.returnSource?.adoptEventId);
          if (source?.kind === 'adopt') local.add(`照合事項${source.issueId}`);
        }
        break;
      }
      case 'alternativeRecord': local.add(`元票「${event.source.source}」・動き「${event.source.entry}」`); break;
      case 'register': case 'move': case 'merge': case 'recount': case 'hold': case 'release': case 'declare':
      case 'provisional': case 'start': case 'use': case 'handover': case 'split': case 'stage': case 'transfer': break;
      default: { const exhaustive: never = event; return exhaustive; }
    }
    if (local.size === 0) local.add(`操作${event.eventId}`);
    for (const target of local) targets.add(target);
  }
  for (const event of after.supply.log.slice(before.supply.log.length)) {
    switch (event.kind) {
      case 'receiptTemplateSave': targets.add(`受入テンプレート${event.after.id}`); break;
      case 'receiptTemplateDelete': targets.add(`受入テンプレート${event.before.id}`); break;
      case 'templateReceipt': targets.add(`一括受入${event.eventId}`); break;
      case 'usageEstimate': targets.add(`レシピ推計${event.eventId}`); break;
      case 'needRegister': targets.add(`必要明細${event.need.id}`); break;
      case 'needRevise': targets.add(`必要明細${event.after.id}`); break;
      case 'needImport':
        if (event.decision.kind !== 'hold') targets.add(`必要明細${event.decision.after.id}`);
        targets.add(`必要明細取込${event.eventId}`);
        break;
      case 'needImportResolve':
        if (event.resolution.kind === 'apply') targets.add(`必要明細${event.resolution.after.id}`);
        targets.add(`必要明細取込${event.importEventId}`);
        break;
      case 'shortageDeclare': targets.add(`申告${event.declaration.id}`); break;
      case 'declarationLink': targets.add(`申告${event.declarationId}`); break;
      case 'requestRecord': targets.add(`依頼${event.request.id}`); break;
      case 'orderConfirm': case 'replyRecord': case 'requestCancel': targets.add(`依頼${event.requestId}`); break;
      case 'receiptRecord': case 'receiptRevise': case 'remainder': targets.add(`まとまり${event.lotId}`); break;
      case 'arrival':
        targets.add(`依頼${event.requestId}`);
        targets.add(`まとまり${event.arrival.receiptLotId}`);
        break;
      case 'arrivalRevise':
        targets.add(`依頼${event.requestId}`);
        targets.add(`まとまり${event.before.receiptLotId}`);
        targets.add(`まとまり${event.after.receiptLotId}`);
        break;
      case 'returnAck': targets.add(`操作${event.handoverEventId}`); break;
      default: { const exhaustive: never = event; return exhaustive; }
    }
  }
  return [...targets];
}
