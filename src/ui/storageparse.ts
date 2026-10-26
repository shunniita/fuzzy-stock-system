import type { Cause, EventDetail, Issue, Ledger, LedgerEvent, Lot, MasterChange, Meta, Process, Project, Stage, Stop, TrialReview } from '../domain/ledger.ts';
import { checkedConsumable, checkPackagingUnits, checkedUnitSteps, integerUnitSteps, inputStepOf, own, quantityStepOf, requireConsistentItemPrecisions, fixedMasters, reservedCaseIds, type ConsumableSetting, type ActorMaster, type CaseMaster, type ItemMaster, type LocationMaster, type Master, type Masters, type Packaging, type PerBox, type ScopeEntry, type Source } from '../domain/masters.ts';
import type { Basis, Numeric, Observation, Quantity, Term, UnknownQuantity } from '../domain/quantity.ts';
import type { Arrival, Declaration, Need, Reply, Request, Supply, SupplyDetail, SupplyEvent } from '../domain/supply.ts';
import type { OpEntry, Pending, SaveCheck, Snapshot, UnitState } from './storage.ts';
import { isReviewFingerprint, isReviewOperation, parseConflictReviews, reviewOpLabel, reviewPendingValues, type ConflictReview } from './conflictrecord.ts';
import { readCode, type CodeReference, type Scan } from '../domain/code.ts';
import { validateReworkLinks } from '../domain/ledger.ts';
import { readNeedRow, validateNeedImports, type NeedImportDetail, type NeedImportInput } from '../domain/need-import.ts';
import { checkAlternativeSource, validateAlternativeRecords, type AlternativeRecord } from '../domain/alternative-record.ts';
import { validateScalar, validateSignedScalar, type Step } from '../domain/scalar.ts';
import { requireQuantityTotals } from '../domain/shortage.ts';
import { validateReceiptTemplates, type ReceiptTemplate } from '../domain/receipt-template.ts';
import { validateUsageEstimates } from '../domain/usage-estimate.ts';
import { validateReceipts } from '../domain/supply.ts';
import { validateRequests } from '../domain/request-history.ts';
import type { EventItemLabels } from '../domain/history-labels.ts';
import { createHistoryTargetCollector } from '../domain/history-targets.ts';
import { assemblyRecipeRowLimit, assemblyRecipeTreeRowLimit } from '../domain/assembly-recipes.ts';
import { requireConsistentItemSettings } from '../domain/masters.ts';
import { initialPackaging } from '../domain/master-edit.ts';

type Decoder<T> = (value: unknown, path: string) => T;

function invalid(path: string, expected: string): never {
  throw new Error(`${path}: ${expected}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid(path, 'オブジェクトが必要');
  return Object.fromEntries(Object.entries(value));
}

function string(value: unknown, path: string): string {
  return typeof value === 'string' ? value : invalid(path, '文字列が必要');
}

function boolean(value: unknown, path: string): boolean {
  return typeof value === 'boolean' ? value : invalid(path, '真偽値が必要');
}

function integer(value: unknown, path: string): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : invalid(path, '精度を保てる整数が必要');
}

function nonnegative(value: unknown, path: string): number {
  const parsed = integer(value, path);
  return parsed >= 0 ? parsed : invalid(path, '0以上の整数が必要');
}

// 数量の欄は品目を知らずに表せる最大の範囲だけを見る。精度は復号後に対象の品目・単位で照合する。
function signedAmount(value: unknown, path: string): number {
  if (typeof value !== 'number') return invalid(path, '数値が必要');
  try { validateSignedScalar(value, Number.isInteger(value) ? 1 : 0.1); }
  catch (error) { return invalid(path, error instanceof Error ? error.message : String(error)); }
  return value;
}

function amount(value: unknown, path: string): number {
  const parsed = signedAmount(value, path);
  return parsed >= 0 ? parsed : invalid(path, '0以上の数量が必要');
}

function oneOf<T extends string | number>(value: unknown, path: string, choices: readonly T[]): T {
  const found = choices.find(choice => choice === value);
  return found === undefined ? invalid(path, `値は ${choices.join(' / ')} のいずれか`) : found;
}

function nullable<T>(value: unknown, path: string, decode: Decoder<T>): T | null {
  return value === null ? null : decode(value, path);
}

function array<T>(value: unknown, path: string, decode: Decoder<T>): T[] {
  if (!Array.isArray(value)) return invalid(path, '配列が必要');
  const entries: unknown[] = value;
  return entries.map((entry, i) => decode(entry, `${path}[${i}]`));
}

function dictionary<T>(value: unknown, path: string, decode: Decoder<T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record(value, path)).map(([key, entry]) => [key, decode(entry, `${path}.${key}`)]));
}

function field<T>(value: Record<string, unknown>, key: string, path: string, decode: Decoder<T>): T {
  return decode(value[key], `${path}.${key}`);
}

function date(value: unknown, path: string): string {
  const text = string(value, path);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match || new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).toISOString().slice(0, 10) !== text) return invalid(path, '実在する YYYY-MM-DD が必要');
  return text;
}

function time(value: unknown, path: string): string {
  const text = string(value, path);
  const [, y, mo, d, h, mi, sec = '0', oh = '0', om = '0'] = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(text) ?? [];
  if (y === undefined || new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d))).toISOString().slice(0, 10) !== `${y}-${mo}-${d}` || Number(h) >= 24 || Number(mi) >= 60 || Number(sec) >= 60 || Number(oh) > 14 || Number(om) >= 60) return invalid(path, '時刻帯付きの正しい日時が必要');
  return text;
}

const textOrNull: Decoder<string | null> = (v, p) => nullable(v, p, string);
const timeOrNull: Decoder<string | null> = (v, p) => nullable(v, p, time);
const countOrNull: Decoder<number | null> = (v, p) => nullable(v, p, amount);
const strings: Decoder<string[]> = (v, p) => array(v, p, string);
const basis: Decoder<Basis> = (v, p) => oneOf(v, p, ['counted', 'label', 'approximate', 'unknown']);
const holdReason: Decoder<Lot['holds'][number]> = (v, p) => oneOf(v, p, ['defective', 'usabilityCheck', 'returnPending', 'spare']);
const inclusion: Decoder<'included' | 'notIncluded' | 'unknown' | null> = (v, p) => nullable(v, p, (v, p) => oneOf(v, p, ['included', 'notIncluded', 'unknown']));
const outcome: Decoder<'apply' | 'close'> = (v, p) => oneOf(v, p, ['apply', 'close']);
const level: Decoder<Supply['levels'][string]['level']> = (v, p) => oneOf(v, p, ['plenty', 'half', 'few', 'nearEmpty']);

function basisValue(o: Record<string, unknown>, path: string): { basis: Basis; value: number | null } {
  const b = field(o, 'basis', path, basis);
  const value = b === 'unknown' ? oneOfNull(o.value, `${path}.value`) : field(o, 'value', path, amount);
  return { basis: b, value };
}

function oneOfNull(value: unknown, path: string): null {
  return value === null ? null : invalid(path, '数が不明の値はnullが必要');
}

function observation(value: unknown, path: string): Observation {
  const o = record(value, path);
  const id = field(o, 'id', path, string);
  const b = field(o, 'basis', path, basis);
  if (b === 'unknown') return { id, basis: b, value: oneOfNull(o.value, `${path}.value`) };
  return { id, basis: b, value: field(o, 'value', path, amount) };
}

function numeric(value: unknown, path: string): Numeric {
  const o = record(value, path);
  // 計算による差異は負数になり得る。観測値の非負制約とは分ける。
  return { value: field(o, 'value', path, signedAmount), approximate: field(o, 'approximate', path, boolean), unconfirmed: oneOf(o.unconfirmed, `${path}.unconfirmed`, ['none', 'partial', 'all']) };
}

function term(value: unknown, path: string): Term {
  const o = record(value, path);
  return { sign: oneOf(o.sign, `${path}.sign`, [1, -1]), observation: field(o, 'observation', path, observation) };
}

function unknownQuantity(value: unknown, path: string): UnknownQuantity {
  const o = record(value, path);
  return { kind: oneOf(o.kind, `${path}.kind`, ['unknown']), before: nullable(o.before, `${path}.before`, quantity), terms: array(o.terms, `${path}.terms`, term) };
}

// 版2の写しとpendingは、同じ数量と、観測・不明部分の並びを一度だけ持つ表を参照する。
// 並びの節と表の項目は自分より前の番号だけを指すので、循環を作れない。
type QuantityTable = { item(ref: unknown, path: string): Quantity };
type ListNode<T> = { parent: number; element: T } | { left: number; right: number };

// 正規の記録は保存先の容量で操作数が限られ、並びの要素とたどる節の合計はこれより十分小さい。壊れた表で画面ごと止まらないよう、ここで止める。
const listElementLimit = 10_000_000;

function below(value: unknown, path: string, limit: number): number {
  const n = integer(value, path);
  return n >= 0 && n < limit ? n : invalid(path, `${limit}未満の番号が必要`);
}

function listNodes<T>(value: unknown, path: string, size: number, element: (payload: unknown[], path: string) => T): ListNode<T>[] {
  if (!Array.isArray(value)) return invalid(path, '配列が必要');
  const entries: unknown[] = value;
  return entries.map((entry, i): ListNode<T> => {
    const p = `${path}[${i}]`;
    if (Array.isArray(entry)) {
      const values: unknown[] = entry;
      if (values.length !== size) return invalid(p, `${size}個の値の節が必要`);
      return { parent: below(values[0], `${p}[0]`, i + 1), element: element(values.slice(1), p) };
    }
    const pair = record(entry, p).concat;
    if (!Array.isArray(pair) || pair.length !== 2) return invalid(`${p}.concat`, '二つの並びの番号が必要');
    return { left: below(pair[0], `${p}.concat[0]`, i + 1), right: below(pair[1], `${p}.concat[1]`, i + 1) };
  });
}

// 項目が参照した並びだけを作る。参照されない長い並びまで先に作ると、壊れた表で時間とメモリが節の数の二乗になる。
function listReader<T>(nodes: ListNode<T>[], spend: (path: string) => void): (ref: unknown, path: string) => T[] {
  const memo = new Map<number, T[]>([[0, []]]);
  return (ref, path) => {
    const id = below(ref, path, nodes.length + 1);
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    // 長い並びでも呼び出しが深くならないよう、末尾から逆順に集める。
    const reversed: T[] = [];
    const stack = [id];
    for (let k = stack.pop(); k !== undefined; k = stack.pop()) {
      const done = memo.get(k);
      if (done !== undefined) {
        for (let x = done.length - 1; x >= 0; x--) { const e = done[x]; if (e !== undefined) { spend(path); reversed.push(e); } }
        continue;
      }
      const node = nodes[k - 1];
      if (node === undefined) continue;
      // 空の並びをつなぐ節を倍々に重ねると、要素を作らずにたどる回数だけが指数で増えるので、たどった節も数える。
      spend(path);
      if ('element' in node) { spend(path); reversed.push(node.element); stack.push(node.parent); }
      else stack.push(node.left, node.right);
    }
    const list = reversed.reverse();
    memo.set(id, list);
    return list;
  };
}

function quantityTable(value: unknown, path: string): QuantityTable {
  const o = record(value, path);
  if (!Array.isArray(o.items)) return invalid(`${path}.items`, '配列が必要');
  const rawItems: unknown[] = o.items;
  let used = 0;
  const spend = (p: string): void => { if (++used > listElementLimit) invalid(p, '数量の表の並びが大きすぎる'); };
  const termsOf = listReader(listNodes(o.terms, `${path}.terms`, 5, ([sign, id, b, val], p) => term({ sign, observation: { id, basis: b, value: val } }, p)), spend);
  const partNodes = listNodes(o.parts, `${path}.parts`, 2, ([ref], p) => below(ref, `${p}[1]`, rawItems.length));
  const partsOf = listReader(partNodes, spend);
  const items: Quantity[] = [];
  const itemBefore = (ref: unknown, p: string, limit: number): Quantity => items[below(ref, p, limit)] ?? invalid(p, '数量の番号が必要');
  const unknownPart = (part: Quantity, p: string): UnknownQuantity => part.kind === 'unknown' ? part : invalid(p, '不明部分には数が不明の数量が必要');
  for (const [i, v] of rawItems.entries()) {
    const p = `${path}.items[${i}]`;
    const it = record(v, p);
    const terms = termsOf(it.terms, `${p}.terms`);
    const kind = oneOf(it.kind, `${p}.kind`, ['known', 'partlyUnknown', 'unknown']);
    switch (kind) {
      case 'known': items.push({ kind, numeric: field(it, 'numeric', p, numeric), computed: field(it, 'computed', p, boolean), terms }); break;
      case 'partlyUnknown': {
        const unknownParts = partsOf(it.unknownParts, `${p}.unknownParts`).map((ref, x) => {
          // 並びをキャッシュから読めても、項目ごとに作る配列の要素は予算を使う。
          spend(`${p}.unknownParts`);
          return unknownPart(itemBefore(ref, `${p}.unknownParts[${x}]`, i), `${p}.unknownParts[${x}]`);
        });
        items.push({ kind, numeric: nullable(it.numeric, `${p}.numeric`, numeric), unknownParts, terms });
        break;
      }
      case 'unknown': items.push({ kind, before: it.before === null ? null : itemBefore(it.before, `${p}.before`, i), terms }); break;
      default: { const exhaustive: never = kind; return exhaustive; }
    }
  }
  for (const [j, node] of partNodes.entries()) if ('element' in node) unknownPart(itemBefore(node.element, `${path}.parts[${j}][1]`, items.length), `${path}.parts[${j}][1]`);
  return { item: (ref, p) => itemBefore(ref, p, items.length) };
}

function quantity(value: unknown, path: string, table: QuantityTable | null = null): Quantity {
  if (typeof value === 'number') return table === null ? invalid(path, '数量の表がないので数量の番号を読めない') : table.item(value, path);
  const o = record(value, path);
  const kind = oneOf(o.kind, `${path}.kind`, ['known', 'partlyUnknown', 'unknown']);
  switch (kind) {
    case 'known': return { kind, numeric: field(o, 'numeric', path, numeric), computed: field(o, 'computed', path, boolean), terms: array(o.terms, `${path}.terms`, term) };
    case 'partlyUnknown': return { kind, numeric: nullable(o.numeric, `${path}.numeric`, numeric), unknownParts: array(o.unknownParts, `${path}.unknownParts`, unknownQuantity), terms: array(o.terms, `${path}.terms`, term) };
    case 'unknown': return unknownQuantity(value, path);
    default: { const exhaustive: never = kind; return exhaustive; }
  }
}

function project(value: unknown, path: string): Project {
  const o = record(value, path);
  const kind = oneOf(o.kind, `${path}.kind`, ['case', 'common', 'unassigned']);
  return kind === 'case' ? { kind, id: field(o, 'id', path, string) } : { kind };
}

function process(value: unknown, path: string): Process {
  const o = record(value, path);
  return { id: field(o, 'id', path, string), criterion: oneOf(o.criterion, `${path}.criterion`, ['workEnd', 'inspection']) };
}

function stage(value: unknown, path: string): Stage {
  const o = record(value, path);
  const kind = oneOf(o.kind, `${path}.kind`, ['none', 'working', 'inspecting', 'awaitingHandover']);
  return kind === 'none' ? { kind } : { kind, process: field(o, 'process', path, process) };
}

function lot(value: unknown, path: string, table: QuantityTable | null = null): Lot {
  const o = record(value, path);
  return {
    id: field(o, 'id', path, string), item: field(o, 'item', path, string), unit: field(o, 'unit', path, string), project: field(o, 'project', path, project), location: field(o, 'location', path, string),
    quantity: quantity(o.quantity, `${path}.quantity`, table), lastCount: nullable(o.lastCount, `${path}.lastCount`, (v, p) => { const c = record(v, p); return { value: field(c, 'value', p, amount), eventId: field(c, 'eventId', p, string) }; }),
    splitFrom: field(o, 'splitFrom', path, textOrNull), mergedInto: field(o, 'mergedInto', path, textOrNull), holds: array(o.holds, `${path}.holds`, holdReason), stage: field(o, 'stage', path, stage),
  };
}

function stop(value: unknown, path: string): Stop {
  const o = record(value, path);
  return {
    id: field(o, 'id', path, string), process: field(o, 'process', path, string), item: field(o, 'item', path, string), unit: field(o, 'unit', path, string), project: field(o, 'project', path, project), reason: field(o, 'reason', path, string),
    shortage: nullable(o.shortage, `${path}.shortage`, (v, p) => { const s = record(v, p); return { item: field(s, 'item', p, string), unit: field(s, 'unit', p, string), value: field(s, 'value', p, countOrNull) }; }),
    affected: field(o, 'affected', path, countOrNull), resumedBy: field(o, 'resumedBy', path, textOrNull),
  };
}

function exactKeys(o: Record<string, unknown>, expected: readonly string[], path: string): void {
  if (Object.keys(o).sort().join() !== [...expected].sort().join()) invalid(path, '記録の欄が不正');
}

function codeReference(value: unknown, code: string, path: string): CodeReference {
  const o = record(value, path);
  if (o.code !== code) return invalid(path, '原文から解釈した品番・コードと一致しない');
  if (o.kind === 'missing') {
    exactKeys(o, ['kind', 'code'], path);
    return { kind: 'missing', code };
  }
  if (o.kind !== 'found') return invalid(path, '登録情報対応の種類が不正');
  exactKeys(o, ['kind', 'code', 'id', 'name', 'active'], path);
  const id = field(o, 'id', path, string);
  if (id === '') return invalid(path, '空でない内部識別が必要');
  return { kind: 'found', code, id, name: nullable(o.name, `${path}.name`, string), active: field(o, 'active', path, boolean) };
}

function scan(value: unknown, path: string): Scan {
  const o = record(value, path);
  exactKeys(o, ['raw', 'format', 'interpreted'], path);
  const raw = field(o, 'raw', path, string);
  // 文法だけを再検査する。当時の名称・内部識別・利用状態を現在の登録情報で置き換えない。
  const parsed = readCode(raw, { items: {}, cases: {}, locations: {}, actors: {} });
  if (o.format !== parsed.format) return invalid(path, '原文と形式が一致しない');
  const detailsPath = `${path}.interpreted`;
  const details = record(o.interpreted, detailsPath);
  exactKeys(details, Object.keys(parsed.interpreted), detailsPath);
  for (const [key, expected] of Object.entries(parsed.interpreted)) {
    if (typeof expected === 'string' && details[key] !== expected) return invalid(`${detailsPath}.${key}`, '原文の解釈と一致しない');
  }
  switch (parsed.format) {
    case 'labelA': case 'labelB':
      return { ...parsed, interpreted: { ...parsed.interpreted,
        item: codeReference(details.item, parsed.interpreted.item.code, `${detailsPath}.item`),
        project: codeReference(details.project, parsed.interpreted.project.code, `${detailsPath}.project`) } };
    case 'itemId':
      return { ...parsed, interpreted: { ...parsed.interpreted, item: codeReference(details.item, parsed.interpreted.item.code, `${detailsPath}.item`) } };
    case 'document': case 'unreadable': return parsed;
    default: { const exhaustive: never = parsed; return exhaustive; }
  }
}

function eventMetaKeys(o: Record<string, unknown>, version: number): string[] {
  return ['kind', 'eventId', 'occurredAt', 'recordedAt', 'actor', ...(Object.hasOwn(o, 'scan') ? ['scan'] : []), ...(version >= 9 ? ['itemLabels'] : [])];
}

function itemLabels(value: unknown, path: string): EventItemLabels {
  const o = record(value, path), kind = oneOf(o.kind, `${path}.kind`, ['recorded', 'legacy-unavailable']);
  exactKeys(o, kind === 'recorded' ? ['kind', 'items'] : ['kind'], path);
  if (kind === 'legacy-unavailable') return { kind };
  return { kind, items: dictionary(o.items, `${path}.items`, (value, p) => {
    const item = record(value, p);
    exactKeys(item, ['name', 'code'], p);
    return { name: field(item, 'name', p, nonblank), code: nullable(item.code, `${p}.code`, nonblank) };
  }) };
}

function meta(o: Record<string, unknown>, path: string, version: number): Meta & { itemLabels: EventItemLabels } {
  if (version < 9 && Object.hasOwn(o, 'itemLabels')) return invalid(`${path}.itemLabels`, '旧版は履歴品目表示を持たない');
  return { eventId: field(o, 'eventId', path, string), occurredAt: field(o, 'occurredAt', path, timeOrNull), recordedAt: field(o, 'recordedAt', path, time), actor: field(o, 'actor', path, string),
    ...(Object.hasOwn(o, 'scan') ? { scan: scan(o.scan, `${path}.scan`) } : {}),
    itemLabels: version < 9 ? { kind: 'legacy-unavailable' } : field(o, 'itemLabels', path, itemLabels) };
}

function cause(value: unknown, path: string): Cause {
  const o = record(value, path);
  const kind = oneOf(o.kind, `${path}.kind`, ['unknown', 'stated']);
  return kind === 'unknown' ? { kind } : { kind, text: field(o, 'text', path, string) };
}

function anyMaster(value: unknown, path: string, version: number): Master {
  const type = oneOf(record(value, path).type, `${path}.type`, ['item', 'location', 'case', 'actor']);
  switch (type) {
    case 'item': return itemMaster(value, path, version);
    case 'location': return locationMaster(value, path);
    case 'case': return caseMaster(value, path);
    case 'actor': return actorMaster(value, path);
  }
}

function masterChange(value: unknown, path: string, version: number): MasterChange {
  const c = record(value, path);
  return { before: c.before === null ? null : anyMaster(c.before, `${path}.before`, version), after: anyMaster(c.after, `${path}.after`, version) };
}

function eventDetail(o: Record<string, unknown>, path: string, table: QuantityTable | null, version: number): EventDetail {
  const kind = oneOf<EventDetail['kind']>(o.kind, `${path}.kind`, ['alternativeRecord', 'register', 'move', 'merge', 'master', 'identify', 'adopt', 'assignProject', 'recount', 'hold', 'release', 'resolve', 'correctTime', 'declare', 'provisional', 'start', 'void', 'stop', 'stopUpdate', 'resume', 'use', 'handover', 'split', 'stage', 'transfer', 'rework', 'reworkPart']);
  switch (kind) {
    case 'alternativeRecord': return alternativeRecord(o, path, version);
    case 'register': case 'move': case 'merge': return { kind };
    case 'identify': return { kind, issueId: field(o, 'issueId', path, string), lotId: field(o, 'lotId', path, string), reason: field(o, 'reason', path, string) };
    case 'adopt': return { kind, issueId: field(o, 'issueId', path, string), lotId: field(o, 'lotId', path, string) };
    case 'assignProject': return { kind, lotId: field(o, 'lotId', path, string), before: field(o, 'before', path, project), after: field(o, 'after', path, project), reason: field(o, 'reason', path, string) };
    case 'master': return o.action === 'trial' ? trialChange(o, path, version) : o.action === 'packaging' || o.action === 'consumable' ? settingChange(o, path, version) : {
      kind, action: oneOf(o.action, `${path}.action`, ['register', 'rename', 'deactivate', 'reactivate', 'code', 'source', 'perBox', 'scope']), reason: field(o, 'reason', path, textOrNull),
      confirmed: field(o, 'confirmed', path, boolean), masters: array(o.masters, `${path}.masters`, (v, p) => masterChange(v, p, version)),
    };
    case 'recount': return { kind, lotId: field(o, 'lotId', path, string), value: field(o, 'value', path, amount), compared: quantity(o.compared, `${path}.compared`, table), cause: field(o, 'cause', path, cause), difference: quantity(o.difference, `${path}.difference`, table), applied: field(o, 'applied', path, boolean), inclusion: field(o, 'inclusion', path, inclusion), answeredFor: field(o, 'answeredFor', path, strings) };
    case 'hold': case 'release': return { kind, reason: field(o, 'reason', path, holdReason), note: field(o, 'note', path, textOrNull) };
    case 'resolve': return { kind, issueId: field(o, 'issueId', path, string), outcome: field(o, 'outcome', path, outcome), inclusion: field(o, 'inclusion', path, inclusion), countedBy: field(o, 'countedBy', path, textOrNull) };
    case 'correctTime': return { kind, targetEventId: field(o, 'targetEventId', path, string), previous: field(o, 'previous', path, timeOrNull), corrected: field(o, 'corrected', path, timeOrNull) };
    case 'declare': return { kind, lotId: field(o, 'lotId', path, string), note: field(o, 'note', path, string) };
    case 'provisional': return { kind, direction: oneOf(o.direction, `${path}.direction`, ['found', 'removed']), item: field(o, 'item', path, textOrNull), location: field(o, 'location', path, textOrNull), ...basisValue(o, path), note: field(o, 'note', path, string) };
    case 'start': return { kind, lotId: field(o, 'lotId', path, string), materials: field(o, 'materials', path, strings) };
    case 'reworkPart': return reworkPart(o, path, version);
    case 'void': return { kind, targetEventId: field(o, 'targetEventId', path, string), lotId: field(o, 'lotId', path, string), reason: field(o, 'reason', path, string), applied: field(o, 'applied', path, boolean) };
    case 'stop': return { kind, stop: field(o, 'stop', path, stop) };
    case 'stopUpdate': return { kind, stopId: field(o, 'stopId', path, string), previous: field(o, 'previous', path, countOrNull), affected: field(o, 'affected', path, countOrNull) };
    case 'resume': return { kind, stopId: field(o, 'stopId', path, string) };
    case 'use': case 'handover': case 'split': case 'stage': case 'transfer': case 'rework': {
      const common = { lotId: field(o, 'lotId', path, string), ...basisValue(o, path), applied: field(o, 'applied', path, boolean), inclusion: field(o, 'inclusion', path, inclusion) };
      switch (kind) {
        case 'use': return { kind, ...common, usedFor: field(o, 'usedFor', path, string) };
        case 'handover': return { kind, ...common, counterpart: field(o, 'counterpart', path, string) };
        case 'split': return { kind, ...common, childId: field(o, 'childId', path, string) };
        case 'stage': return { kind, ...common, childId: field(o, 'childId', path, string), to: field(o, 'to', path, stage), correction: field(o, 'correction', path, boolean) };
        case 'rework':
          exactKeys(o, [...eventMetaKeys(o, version), 'changes', 'lotId', 'basis', 'value', 'applied', 'inclusion', 'childId', 'reason', ...(o.returnSource === undefined ? [] : ['returnSource'])], path);
          if (!common.applied || common.basis === 'unknown' || common.value === null || common.value <= 0 || common.inclusion === 'included' || common.inclusion === 'unknown') return invalid(path, 'やり直し・修理には適用済みの正の数量が必要');
          return { kind, ...common, childId: field(o, 'childId', path, nonblank), reason: field(o, 'reason', path, nonblank), ...(o.returnSource === undefined ? {} : { returnSource: returnedReworkSource(o.returnSource, `${path}.returnSource`) }) };
        case 'transfer': {
          const from = field(o, 'from', path, project);
          const to = field(o, 'to', path, project);
          if (from.kind !== 'case' || to.kind !== 'case' || from.id === to.id) return invalid(path, '振替元と振替先には異なる案件・用途が必要');
          if (!common.applied || common.basis === 'unknown' || common.value === null || common.value <= 0 || common.inclusion === 'included' || common.inclusion === 'unknown') return invalid(path, '振替には適用済みの正の数量が必要');
          return { kind, ...common, childId: field(o, 'childId', path, string), from, to };
        }
        default: { const exhaustive: never = kind; return exhaustive; }
      }
    }
    default: { const exhaustive: never = kind; return exhaustive; }
  }
}

function ledgerEvent(value: unknown, path: string, table: QuantityTable | null, version: number): LedgerEvent {
  const o = record(value, path);
  return { ...meta(o, path, version), ...eventDetail(o, path, table, version), changes: array(o.changes, `${path}.changes`, (v, p) => { const c = record(v, p); return { before: c.before === null ? null : lot(c.before, `${p}.before`, table), after: lot(c.after, `${p}.after`, table) }; }) };
}

function nonblank(value: unknown, path: string): string {
  const parsed = string(value, path);
  return parsed.trim() ? parsed : invalid(path, '空でない文字列が必要');
}

function trialReview(value: unknown, path: string): TrialReview {
  const o = record(value, path);
  exactKeys(o, ['quantities', 'requests', 'corrections', 'restore', 'initial'], path);
  return { quantities: field(o, 'quantities', path, nonblank), requests: field(o, 'requests', path, nonblank), corrections: field(o, 'corrections', path, nonblank), restore: field(o, 'restore', path, nonblank), initial: field(o, 'initial', path, nonblank) };
}

function trialChange(o: Record<string, unknown>, path: string, version: number): Extract<EventDetail, { kind: 'master'; action: 'trial' }> {
  exactKeys(o, [...eventMetaKeys(o, version), 'changes', 'action', 'reason', 'confirmed', 'masters', 'review'], path);
  if (!Array.isArray(o.changes) || o.changes.length !== 0 || o.confirmed !== false) return invalid(path, '試行変更には現物changesを持たずconfirmedはfalse');
  const changes = array(o.masters, `${path}.masters`, (value, p) => {
    const pair = record(value, p), decoded = masterChange(value, p, version);
    exactKeys(pair, ['before', 'after'], p);
    const { before, after } = decoded;
    if (before === null || (before.type !== 'item' && before.type !== 'location') || after.type !== before.type || after.id !== before.id || !('trial' in after) || after.trial === before.trial) return invalid(p, '同じ品目/場所のtrial反転が必要');
    const storedKeys = (m: Master) => Object.keys(m).filter(key => (version >= 5 || key !== 'unitSteps') && (version >= 11 || key !== 'consumable'));
    exactKeys(record(pair.before, `${p}.before`), storedKeys(before), `${p}.before`);
    exactKeys(record(pair.after, `${p}.after`), storedKeys(after), `${p}.after`);
    if (JSON.stringify({ ...before, trial: after.trial }) !== JSON.stringify(after)) return invalid(p, '試行変更でtrial以外の登録情報属性は変えない');
    return decoded;
  });
  const after = changes[0]?.after;
  if (changes.length !== 1 || after === undefined || !('trial' in after)) return invalid(path, '試行変更は一つの品目/場所が対象');
  const review = after.trial ? trialReview(o.review, `${path}.review`) : null;
  if (!after.trial && o.review !== null) return invalid(path, '対象外への変更はreview:nullが必要');
  return { kind: 'master', action: 'trial', reason: field(o, 'reason', path, nonblank), confirmed: false, masters: changes, review };
}

function alternativeRecord(o: Record<string, unknown>, path: string, version: number): AlternativeRecord {
  exactKeys(o, [...eventMetaKeys(o, version), 'changes', 'operation', 'operationId', 'source'], path);
  if (!Array.isArray(o.changes) || o.changes.length !== 0) return invalid(path, '元の資料の識別証拠に現物変更は持てない');
  const input = record(o.source, `${path}.source`);
  exactKeys(input, ['source', 'entry', 'originalActor'], `${path}.source`);
  const source = { source: field(input, 'source', `${path}.source`, string), entry: field(input, 'entry', `${path}.source`, string), originalActor: field(input, 'originalActor', `${path}.source`, string) };
  checkAlternativeSource(source);
  return { kind: 'alternativeRecord', operation: oneOf(o.operation, `${path}.operation`, ['use', 'move', 'start', 'receive']), operationId: field(o, 'operationId', path, nonblank), source };
}

function positive(value: unknown, path: string): number {
  const parsed = amount(value, path);
  return parsed > 0 ? parsed : invalid(path, '正の実数が必要');
}

function returnedReworkSource(value: unknown, path: string): NonNullable<Extract<EventDetail, { kind: 'rework' }>['returnSource']> {
  const o = record(value, path);
  exactKeys(o, ['adoptEventId', 'process', 'confirmedPhysical'], path);
  if (o.confirmedPhysical !== true) return invalid(path, '物理的なやり直し・修理の確認が必要');
  const selected = record(o.process, `${path}.process`);
  exactKeys(selected, ['id', 'criterion'], `${path}.process`);
  const chosen = process(selected, `${path}.process`);
  return { adoptEventId: field(o, 'adoptEventId', path, nonblank), process: { ...chosen, id: nonblank(chosen.id, `${path}.process.id`) }, confirmedPhysical: true };
}

function reworkPart(o: Record<string, unknown>, path: string, version: number): Extract<EventDetail, { kind: 'reworkPart' }> {
  if (!Array.isArray(o.changes) || o.changes.length !== 0) return invalid(path, '部品対応記録に数量変更は持てない');
  const action = oneOf(o.action, `${path}.action`, ['replace', 'recover', 'discard']);
  exactKeys(o, [...eventMetaKeys(o, version), 'changes', 'reworkId', ...(o.subjectLotId === undefined ? [] : ['subjectLotId']), 'reason', 'action', ...(action === 'replace' ? ['useEventId'] : action === 'recover' ? ['registerEventId'] : ['item', 'unit', 'value'])], path);
  const common = { kind: 'reworkPart', reworkId: field(o, 'reworkId', path, nonblank), ...(o.subjectLotId === undefined ? {} : { subjectLotId: field(o, 'subjectLotId', path, nonblank) }), reason: field(o, 'reason', path, nonblank) } as const;
  switch (action) {
    case 'replace': return { ...common, action, useEventId: field(o, 'useEventId', path, nonblank) };
    case 'recover': return { ...common, action, registerEventId: field(o, 'registerEventId', path, nonblank) };
    case 'discard': return { ...common, action, item: field(o, 'item', path, nonblank), unit: field(o, 'unit', path, nonblank), value: field(o, 'value', path, positive) };
  }
}

function issue(value: unknown, path: string): Issue {
  const o = record(value, path);
  return { id: field(o, 'id', path, string), lotId: field(o, 'lotId', path, textOrNull), reason: oneOf(o.reason, `${path}.reason`, ['negative', 'lateEntry', 'declared', 'unassigned', 'timeCorrected']),
    resolution: nullable(o.resolution, `${path}.resolution`, (v, p) => { const r = record(v, p); return { eventId: field(r, 'eventId', p, string), outcome: field(r, 'outcome', p, outcome), actor: field(r, 'actor', p, string) }; }),
  };
}

function source(value: unknown, path: string): Source {
  const o = record(value, path);
  return { name: field(o, 'name', path, string), revision: field(o, 'revision', path, string) };
}

// 時点つきの値の並び。先頭だけ最初から（null）で、あとは前より後の日時。並びの途中へ差し込まない（ADR-024）。
function timeline<T extends { from: string | null }>(value: unknown, path: string, decode: Decoder<T>): T[] {
  const entries = array(value, path, decode);
  if (entries[0]?.from !== null) return invalid(`${path}[0].from`, '最初からの値（null）が必要');
  for (let i = 1; i < entries.length; i++) {
    const from = entries[i]!.from; const previous = entries[i - 1]!.from;
    if (from === null || (previous !== null && Date.parse(from) <= Date.parse(previous))) return invalid(`${path}[${i}].from`, '前の値より後の日時が必要');
  }
  return entries;
}

function perBox(value: unknown, path: string, version: number): PerBox {
  const o = record(value, path);
  if (version >= 11 && o.value === null && o.from === null) return { from: null, value: null };
  const count = field(o, 'value', path, nonnegative);
  return count >= 1 ? { from: field(o, 'from', path, timeOrNull), value: count } : invalid(`${path}.value`, '1以上の整数が必要');
}

function scopeEntry(value: unknown, path: string): ScopeEntry {
  const o = record(value, path);
  return { from: field(o, 'from', path, timeOrNull), inScope: field(o, 'inScope', path, boolean) };
}

function packaging(value: unknown, path: string, version: number): Packaging {
  const o = record(value, path);
  const entries = field(o, 'perBox', path, (v, p) => timeline(v, p, (x, q) => perBox(x, q, version)));
  if (entries[0]?.value === null && entries.length < 2) return invalid(path, '未知の初期値の後に設定時点の入り数が必要');
  return { boxUnit: field(o, 'boxUnit', path, string), pieceUnit: field(o, 'pieceUnit', path, string), perBox: entries };
}

function settingChange(o: Record<string, unknown>, path: string, version: number): Extract<EventDetail, { kind: 'master' }> {
  if (version < 11) return invalid(path, '旧版は包装・共通消耗品の設定操作を持たない');
  exactKeys(o, [...eventMetaKeys(o, version), 'changes', 'action', 'reason', 'confirmed', 'masters'], path);
  if (!Array.isArray(o.changes) || o.changes.length !== 0 || o.confirmed !== false) return invalid(path, '設定操作は現物を変更せずconfirmedはfalse');
  const action = oneOf(o.action, `${path}.action`, ['packaging', 'consumable']);
  const changes = array(o.masters, `${path}.masters`, (v, p) => {
    const pair = record(v, p);
    exactKeys(pair, ['before', 'after'], p);
    const change = masterChange(v, p, version);
    const { before, after } = change;
    if (before?.type !== 'item' || after.type !== 'item' || before.id !== after.id) return invalid(p, '同じ品目の変更前後が必要');
    exactKeys(record(pair.before, `${p}.before`), Object.keys(before), `${p}.before`);
    exactKeys(record(pair.after, `${p}.after`), Object.keys(after), `${p}.after`);
    const expected = action === 'consumable' ? { ...before, consumable: after.consumable } : { ...before, packaging: after.packaging };
    if (JSON.stringify(expected) !== JSON.stringify(after) || JSON.stringify(before) === JSON.stringify(after)) return invalid(p, '設定操作は対象設定だけを変更する');
    if (action === 'packaging') {
      const packaging = after.packaging, last = packaging?.perBox.at(-1);
      if (packaging === null || last?.value === null || last?.value === undefined) return invalid(p, '包装の初期設定が必要');
      const expectedPackaging = initialPackaging(before, { occurredAt: field(o, 'occurredAt', path, timeOrNull), recordedAt: field(o, 'recordedAt', path, time) }, packaging.boxUnit, packaging.pieceUnit, last.value);
      if (JSON.stringify(expectedPackaging) !== JSON.stringify(packaging)) return invalid(p, '包装は未知の初期値と適用時点の入り数で始める');
    }
    return change;
  });
  if (changes.length !== 1) return invalid(path, '設定操作は一つの品目だけが対象');
  return { kind: 'master', action, reason: field(o, 'reason', path, nonblank), confirmed: false, masters: changes };
}

function consumable(value: unknown, path: string): ConsumableSetting {
  const o = record(value, path);
  exactKeys(o, ['pieceUnit', 'rule'], path);
  return { pieceUnit: field(o, 'pieceUnit', path, nonblank), rule: nullable(o.rule, `${path}.rule`, (value, p) => {
    const rule = record(value, p);
    exactKeys(rule, ['threshold', 'standardOrder'], p);
    const order = record(rule.standardOrder, `${p}.standardOrder`);
    exactKeys(order, ['value', 'unit'], `${p}.standardOrder`);
    return { threshold: field(rule, 'threshold', p, amount), standardOrder: { value: field(order, 'value', `${p}.standardOrder`, amount), unit: field(order, 'unit', `${p}.standardOrder`, nonblank) } };
  }) };
}

function units(value: unknown, path: string): string[] {
  const list = strings(value, path);
  return list.length > 0 && new Set(list).size === list.length ? list : invalid(path, '重なりのない一つ以上の単位が必要');
}

function masterType<T extends string>(o: Record<string, unknown>, path: string, type: T): T {
  return oneOf(o.type, `${path}.type`, [type]);
}

function itemMaster(value: unknown, path: string, version: number): ItemMaster {
  const o = record(value, path);
  const decodedUnits = field(o, 'units', path, units);
  if (version < 5 && Object.hasOwn(o, 'unitSteps')) return invalid(`${path}.unitSteps`, '旧版は精度属性を持たない');
  const unitSteps = version >= 5 ? checkedUnitSteps(o.unitSteps, decodedUnits) : integerUnitSteps(decodedUnits);
  if (version < 11 && Object.hasOwn(o, 'consumable')) return invalid(`${path}.consumable`, '旧版は共通消耗品の設定を持たない');
  const item: ItemMaster = {
    type: masterType(o, path, 'item'), id: field(o, 'id', path, string), code: field(o, 'code', path, textOrNull), name: field(o, 'name', path, string),
    source: nullable(o.source, `${path}.source`, source), units: decodedUnits, unitSteps, trial: field(o, 'trial', path, boolean),
    active: field(o, 'active', path, boolean), packaging: nullable(o.packaging, `${path}.packaging`, (v, p) => packaging(v, p, version)),
    consumable: version < 11 ? null : nullable(o.consumable, `${path}.consumable`, consumable),
  };
  checkedConsumable(item, item.consumable);
  if (item.packaging !== null) checkPackagingUnits(item, item.packaging);
  return item;
}

function locationMaster(value: unknown, path: string): LocationMaster {
  const o = record(value, path);
  return {
    type: masterType(o, path, 'location'), id: field(o, 'id', path, string), code: field(o, 'code', path, string), name: field(o, 'name', path, string),
    trial: field(o, 'trial', path, boolean), active: field(o, 'active', path, boolean), scope: field(o, 'scope', path, (v, p) => timeline(v, p, scopeEntry)),
  };
}

function caseMaster(value: unknown, path: string): CaseMaster {
  const o = record(value, path);
  const master: CaseMaster = {
    type: masterType(o, path, 'case'), id: field(o, 'id', path, string), code: field(o, 'code', path, textOrNull), name: field(o, 'name', path, textOrNull),
    source: nullable(o.source, `${path}.source`, source), active: field(o, 'active', path, boolean),
  };
  // 画面は既存IDか名称で案件・用途を見分けるので、どちらもない案件・用途は区別できない。
  return master.code === null && master.name === null ? invalid(path, '品番・コードか呼び名のどちらかが必要') : master;
}

function actorMaster(value: unknown, path: string): ActorMaster {
  const o = record(value, path);
  return { type: masterType(o, path, 'actor'), id: field(o, 'id', path, string), active: field(o, 'active', path, boolean) };
}

// 辞書のキーは記録が指す内部の識別。同じ種類の既存IDは一つの登録情報だけが持つ（要件1.6）。
function masterGroup<T extends { id: string; code?: string | null }>(value: unknown, path: string, decode: Decoder<T>): Record<string, T> {
  const group = dictionary(value, path, decode);
  for (const [key, master] of Object.entries(group)) if (master.id !== key) return invalid(`${path}.${key}.id`, '辞書のキーと同じidが必要');
  const codes = Object.values(group).flatMap((master) => (master.code === undefined || master.code === null ? [] : [master.code]));
  return new Set(codes).size === codes.length ? group : invalid(path, '同じ種類で品番・コードの重なりがないことが必要');
}

function masters(value: unknown, path: string, version: number): Masters {
  const o = record(value, path);
  const cases = masterGroup(o.cases, `${path}.cases`, caseMaster);
  const reserved = reservedCaseIds.find((id) => Object.hasOwn(cases, id));
  if (reserved !== undefined) return invalid(`${path}.cases.${reserved}`, '共通在庫・所属不明を表す値でない案件・用途の内部の識別が必要');
  return {
    items: masterGroup(o.items, `${path}.items`, (v, p) => itemMaster(v, p, version)), locations: masterGroup(o.locations, `${path}.locations`, locationMaster),
    cases, actors: masterGroup(o.actors, `${path}.actors`, actorMaster),
  };
}

// 現在と履歴の同じIDが持つ単位/精度は登録後に変えない。表示属性の変更は比較しない。
function validateMasterPrecision(decoded: Ledger, path: string): void {
  for (const event of decoded.history) {
    if (event.kind !== 'master') continue;
    for (const pair of event.masters) for (const historical of [pair.before, pair.after]) {
      if (historical?.type !== 'item') continue;
      const current = Object.hasOwn(decoded.masters.items, historical.id) ? decoded.masters.items[historical.id] : undefined;
      if (current === undefined || current.units.length !== historical.units.length
        || current.units.some((unit, index) => unit !== historical.units[index] || current.unitSteps[unit] !== historical.unitSteps[unit])) {
        return invalid(path, '同じ品目IDの単位と最小単位は現在と履歴で一致することが必要');
      }
    }
  }
}

// 版2までの記録は登録情報を持たない。そのころの登録情報は固定の架空登録情報だけなので、それを補う（要件9.4）。
function ledger(value: unknown, path: string, table: QuantityTable | null, version: number): Ledger {
  const o = record(value, path);
  const decoded = {
    lots: dictionary(o.lots, `${path}.lots`, (v, p) => lot(v, p, table)), history: array(o.history, `${path}.history`, (v, p) => ledgerEvent(v, p, table, version)), issues: dictionary(o.issues, `${path}.issues`, issue), stops: dictionary(o.stops, `${path}.stops`, stop),
    masters: o.masters === undefined && version < 3 ? fixedMasters : field(o, 'masters', path, (v, p) => masters(v, p, version)),
  };
  validateMasterPrecision(decoded, path);
  requireConsistentItemSettings(decoded);
  validateSplitLineage(decoded, path);
  validateReworkLinks(decoded);
  for (const event of decoded.history) {
    if (event.kind !== 'master' || event.action !== 'trial') continue;
    for (const { after } of event.masters) {
      const group = after.type === 'item' ? decoded.masters.items : decoded.masters.locations;
      if (!Object.hasOwn(group, after.id)) return invalid(path, '試行変更の対象が現在の登録情報に存在しない');
    }
  }
  return decoded;
}

function need(value: unknown, path: string): Need {
  const o = record(value, path);
  const p = field(o, 'project', path, project);
  if (p.kind !== 'case') return invalid(`${path}.project`, '必要明細には案件・用途が必要');
  return { id: field(o, 'id', path, string), project: p, item: field(o, 'item', path, string), unit: field(o, 'unit', path, string), required: basisValue(record(o.required, `${path}.required`), `${path}.required`), dueDate: nullable(o.dueDate, `${path}.dueDate`, date), source: field(o, 'source', path, string), revision: field(o, 'revision', path, string) };
}

function declaration(value: unknown, path: string): Declaration {
  const o = record(value, path);
  return { id: field(o, 'id', path, string), project: field(o, 'project', path, project), item: field(o, 'item', path, string), unit: field(o, 'unit', path, string), value: field(o, 'value', path, countOrNull), reason: field(o, 'reason', path, string), linked: field(o, 'linked', path, boolean) };
}

function reply(value: unknown, path: string): Reply {
  const o = record(value, path);
  const kind = oneOf(o.kind, `${path}.kind`, ['none', 'estimated', 'answered']);
  return kind === 'none' ? { kind } : { kind, date: field(o, 'date', path, date) };
}

function arrival(value: unknown, path: string): Arrival {
  const o = record(value, path);
  return { id: field(o, 'id', path, string), receiptLotId: field(o, 'receiptLotId', path, string), arrived: field(o, 'arrived', path, amount), good: field(o, 'good', path, amount) };
}

function request(value: unknown, path: string): Request {
  const o = record(value, path);
  return {
    id: field(o, 'id', path, string), project: field(o, 'project', path, project), item: field(o, 'item', path, string), unit: field(o, 'unit', path, string), quantity: field(o, 'quantity', path, amount), vendor: field(o, 'vendor', path, string), requestedOn: field(o, 'requestedOn', path, date), orderConfirmedBy: field(o, 'orderConfirmedBy', path, textOrNull), reply: field(o, 'reply', path, reply),
    cancelled: nullable(o.cancelled, `${path}.cancelled`, (v, p) => { const c = record(v, p); return { eventId: field(c, 'eventId', p, string), reason: field(c, 'reason', p, string) }; }), arrivals: array(o.arrivals, `${path}.arrivals`, arrival),
  };
}

function importedNeed(value: unknown, path: string): Need {
  const o = record(value, path);
  exactKeys(o, ['id', 'project', 'item', 'unit', 'required', 'dueDate', 'source', 'revision'], path);
  exactKeys(record(o.project, `${path}.project`), ['kind', 'id'], `${path}.project`);
  exactKeys(record(o.required, `${path}.required`), ['basis', 'value'], `${path}.required`);
  const n = need(o, path);
  if ([n.id, n.project.id, n.item, n.unit, n.source, n.revision].some(s => !s.trim())) return invalid(path, '取込明細の識別・単位は空にできない');
  return n;
}

function importInput(value: unknown, path: string): NeedImportInput {
  const o = record(value, path);
  exactKeys(o, ['raw', 'row'], path);
  const raw = field(o, 'raw', path, string), row = readNeedRow(raw), stored = readNeedRow(JSON.stringify(o.row));
  if (JSON.stringify(row) !== JSON.stringify(stored)) return invalid(path, '取込原文と読取値が一致しない');
  return { raw, row };
}

function importDetail(o: Record<string, unknown>, path: string, kind: NeedImportDetail['kind'], version: number): NeedImportDetail {
  const metaKeys = eventMetaKeys(o, version);
  if (kind === 'needImportResolve') {
    exactKeys(o, [...metaKeys, 'importEventId', 'reason', 'resolution'], path);
    const r = record(o.resolution, `${path}.resolution`), action = oneOf(r.kind, `${path}.resolution.kind`, ['apply', 'dismiss']);
    exactKeys(r, action === 'dismiss' ? ['kind'] : ['kind', 'before', 'after'], `${path}.resolution`);
    return { kind, importEventId: field(o, 'importEventId', path, string), reason: field(o, 'reason', path, string),
      resolution: action === 'dismiss' ? { kind: 'dismiss' } : { kind: 'apply', before: field(r, 'before', `${path}.resolution`, importedNeed), after: field(r, 'after', `${path}.resolution`, importedNeed) } };
  }
  exactKeys(o, [...metaKeys, 'input', 'decision'], path);
  const input = field(o, 'input', path, importInput), d = record(o.decision, `${path}.decision`), action = oneOf(d.kind, `${path}.decision.kind`, ['hold', 'create', 'revise', 'unchanged']);
  exactKeys(d, action === 'hold' ? ['kind', 'reasons', 'candidates'] : ['kind', 'before', 'after'], `${path}.decision`);
  if (action === 'hold') return { kind, input, decision: { kind: 'hold', reasons: field(d, 'reasons', path, strings), candidates: field(d, 'candidates', path, strings) } };
  const after = field(d, 'after', `${path}.decision`, importedNeed);
  if (action === 'create') return { kind, input, decision: { kind: 'create', before: oneOfNull(d.before, `${path}.decision.before`), after } };
  return { kind, input, decision: { kind: action, before: field(d, 'before', `${path}.decision`, importedNeed), after } };
}

function exactProject(value: unknown, path: string): Project {
  const p = project(value, path);
  exactKeys(record(value, path), p.kind === 'case' ? ['kind', 'id'] : ['kind'], path);
  return p;
}

// 版7のテンプレートは案件・用途を必ず持ち製品を持たない。版8は製品と案件・用途をnullable で持つ。
// 入力中の固定コピーにも保存と同じ形・深さ・件数の境界を使う。出自と業務条件は保存側で検査する。
export function decodeReceiptTemplate(value: unknown): ReceiptTemplate {
  return receiptTemplate(value, 'セットの固定コピー', 9);
}

function receiptTemplate(value: unknown, path: string, version: number, depth = 0, budget = { rows: 0 }): ReceiptTemplate {
  const o = record(value, path);
  exactKeys(o, [...(version < 8 ? ['id', 'name', 'project', 'basis', 'rows'] : ['id', 'name', 'product', 'project', 'basis', 'rows']), ...(version >= 9 && Object.hasOwn(o, 'productUnit') ? ['productUnit'] : [])], path);
  if (!Array.isArray(o.rows) || o.rows.length < 1 || o.rows.length > assemblyRecipeRowLimit) return invalid(`${path}.rows`, `明細は1〜${assemblyRecipeRowLimit}行にする`);
  budget.rows += o.rows.length;
  if (budget.rows > assemblyRecipeTreeRowLimit) return invalid(`${path}.rows`, `全構成は${assemblyRecipeTreeRowLimit}行以下にする`);
  return { id: field(o, 'id', path, string), name: field(o, 'name', path, string),
    product: version < 8 ? null : field(o, 'product', path, textOrNull),
    ...(version >= 9 && Object.hasOwn(o, 'productUnit') ? { productUnit: field(o, 'productUnit', path, nonblank) } : {}),
    project: version < 8 ? field(o, 'project', path, exactProject) : nullable(o.project, `${path}.project`, exactProject),
    basis: oneOf(o.basis, `${path}.basis`, ['counted', 'label', 'approximate']),
    rows: array(o.rows, `${path}.rows`, (v, p) => {
      const r = record(v, p);
      const assembly = version >= 9 && Object.hasOwn(r, 'assembly');
      exactKeys(r, ['item', 'unit', 'perSet', 'location', ...(assembly ? ['assembly'] : [])], p);
      if (assembly && depth >= 1) return invalid(`${p}.assembly`, '構成の高さは2以下にする');
      return { item: field(r, 'item', p, string), unit: field(r, 'unit', p, string), perSet: field(r, 'perSet', p, amount), location: field(r, 'location', p, string),
        ...(assembly ? { assembly: receiptTemplate(r.assembly, `${p}.assembly`, version, depth + 1, budget) } : {}) };
    }) };
}

// 版7のまとめて受け取りは案件・用途をテンプレートから取り、不足0・手配先なしとして読む（保存済みの値は書き換えない）。
function templateDetail(o: Record<string, unknown>, path: string, kind: 'receiptTemplateSave' | 'receiptTemplateDelete' | 'templateReceipt', version: number): SupplyDetail {
  const keys = eventMetaKeys(o, version);
  const template = (v: unknown, p: string) => receiptTemplate(v, p, version);
  if (kind === 'receiptTemplateSave') {
    exactKeys(o, [...keys, 'before', 'after'], path);
    return { kind, before: nullable(o.before, `${path}.before`, template), after: field(o, 'after', path, template) };
  }
  if (kind === 'receiptTemplateDelete') {
    exactKeys(o, [...keys, 'before'], path);
    return { kind, before: field(o, 'before', path, template) };
  }
  const legacy = version < 8;
  const hasRoutes = version >= 9 && Object.hasOwn(o, 'routes');
  exactKeys(o, legacy ? [...keys, 'template', 'sets', 'rows'] : [...keys, 'template', 'project', 'sets', 'vendor', 'rows', ...(hasRoutes ? ['routes'] : [])], path);
  const decoded = field(o, 'template', path, template);
  const receiptProject = legacy ? decoded.project : field(o, 'project', path, exactProject);
  if (receiptProject === null) return invalid(`${path}.project`, 'まとめて受け取りの案件・用途がない');
  return { kind, template: decoded, project: receiptProject, sets: field(o, 'sets', path, integer), vendor: legacy ? null : field(o, 'vendor', path, textOrNull),
    rows: array(o.rows, `${path}.rows`, (v, p) => {
      const r = record(v, p);
      exactKeys(r, legacy ? ['lotId', 'quantity'] : ['lotId', 'quantity', 'shortfall'], p);
      return { lotId: field(r, 'lotId', p, textOrNull), quantity: field(r, 'quantity', p, amount), shortfall: legacy ? 0 : field(r, 'shortfall', p, amount) };
    }), ...(hasRoutes ? { routes: array(o.routes, `${path}.routes`, (v, p) => oneOf(v, p, ['assembled', 'parts'])) } : {}) };
}

function supplyDetail(o: Record<string, unknown>, path: string, version: number): SupplyDetail {
  const kind = oneOf<SupplyDetail['kind']>(o.kind, `${path}.kind`, ['receiptTemplateSave', 'receiptTemplateDelete', 'templateReceipt', 'needImport', 'needImportResolve', 'needRegister', 'needRevise', 'shortageDeclare', 'declarationLink', 'requestRecord', 'orderConfirm', 'replyRecord', 'requestCancel', 'receiptRecord', 'receiptRevise', 'arrival', 'arrivalRevise', 'remainder', 'returnAck', 'usageEstimate']);
  switch (kind) {
    case 'receiptTemplateSave': case 'receiptTemplateDelete': case 'templateReceipt': return templateDetail(o, path, kind, version);
    case 'needImport': case 'needImportResolve': return importDetail(o, path, kind, version);
    case 'needRegister': return { kind, need: field(o, 'need', path, need) };
    case 'needRevise': return { kind, before: field(o, 'before', path, need), after: field(o, 'after', path, need) };
    case 'shortageDeclare': return { kind, declaration: field(o, 'declaration', path, declaration) };
    case 'declarationLink': return { kind, declarationId: field(o, 'declarationId', path, string), linked: field(o, 'linked', path, boolean) };
    case 'requestRecord': return { kind, request: field(o, 'request', path, request) };
    case 'orderConfirm': return { kind, requestId: field(o, 'requestId', path, string) };
    case 'replyRecord': return { kind, requestId: field(o, 'requestId', path, string), before: field(o, 'before', path, reply), after: field(o, 'after', path, reply) };
    case 'requestCancel': return { kind, requestId: field(o, 'requestId', path, string), reason: field(o, 'reason', path, string) };
    case 'receiptRecord': return { kind, lotId: field(o, 'lotId', path, string), received: field(o, 'received', path, countOrNull), provisional: field(o, 'provisional', path, boolean), label: field(o, 'label', path, textOrNull) };
    case 'receiptRevise': return { kind, lotId: field(o, 'lotId', path, string), before: field(o, 'before', path, countOrNull), after: field(o, 'after', path, amount), provisional: field(o, 'provisional', path, boolean), reason: field(o, 'reason', path, string) };
    case 'arrival': return { kind, requestId: field(o, 'requestId', path, string), arrival: field(o, 'arrival', path, arrival) };
    case 'arrivalRevise': return { kind, requestId: field(o, 'requestId', path, string), before: field(o, 'before', path, arrival), after: field(o, 'after', path, arrival) };
    case 'remainder': return { kind, lotId: field(o, 'lotId', path, string), level: field(o, 'level', path, level) };
    case 'returnAck': return { kind, handoverEventId: field(o, 'handoverEventId', path, string) };
    case 'usageEstimate': return usageEstimateDetail(o, path, version);
    default: { const exhaustive: never = kind; return exhaustive; }
  }
}

// 版10より前はセット推計を持たない。照合は保存境界の validateUsageEstimates が台帳と突き合わせる。
function usageEstimateDetail(o: Record<string, unknown>, path: string, version: number): SupplyDetail {
  if (version < 10) return invalid(path, '旧版はセット推計を持たない');
  exactKeys(o, [...eventMetaKeys(o, version), 'startEventId', 'template', 'sets', 'rows'], path);
  return { kind: 'usageEstimate', startEventId: field(o, 'startEventId', path, string), template: field(o, 'template', path, (v, p) => receiptTemplate(v, p, version)), sets: field(o, 'sets', path, integer),
    rows: array(o.rows, `${path}.rows`, (v, p) => {
      const r = record(v, p);
      exactKeys(r, ['calculated', 'confirmed', 'decision', 'uses'], p);
      return { calculated: nullable(r.calculated, `${p}.calculated`, amount), confirmed: nullable(r.confirmed, `${p}.confirmed`, amount), decision: oneOf(r.decision, `${p}.decision`, ['use', 'exclude', 'unresolved']), uses: field(r, 'uses', p, strings) };
    }) };
}

function supplyEvent(value: unknown, path: string, version: number): SupplyEvent {
  const o = record(value, path);
  return { ...meta(o, path, version), ...supplyDetail(o, path, version) };
}

function validateSplitLineage(ledger: Ledger, path: string): void {
  const checked = new Set<string>();
  for (const lot of Object.values(ledger.lots)) {
    const ancestors = new Set<string>();
    for (let id: string | null = lot.id; id !== null && !checked.has(id); id = ledger.lots[id]?.splitFrom ?? null) {
      if (ancestors.has(id)) invalid(path, '保管単位の分割元が循環している');
      ancestors.add(id);
    }
    for (const id of ancestors) checked.add(id);
  }
}

function supply(value: unknown, path: string, masters: Masters, version: number): Supply {
  const o = record(value, path);
  const log = array(o.log, `${path}.log`, (v, p) => supplyEvent(v, p, version));
  const importedIds = new Set(log.flatMap(e => e.kind === 'needImport' ? e.decision.kind === 'hold' ? e.decision.candidates : [e.decision.after.id] : e.kind === 'needImportResolve' && e.resolution.kind === 'apply' ? [e.resolution.after.id] : []));
  const decoded = {
    receiptTemplates: version < 7 ? {} : dictionary(o.receiptTemplates, `${path}.receiptTemplates`, (v, p) => receiptTemplate(v, p, version)),
    needs: dictionary(o.needs, `${path}.needs`, (v, p) => { const n = need(v, p); return importedIds.has(n.id) ? importedNeed(v, p) : n; }), declarations: dictionary(o.declarations, `${path}.declarations`, declaration), requests: dictionary(o.requests, `${path}.requests`, request),
    levels: dictionary(o.levels, `${path}.levels`, (v, p) => { const l = record(v, p); return { level: field(l, 'level', p, level), eventId: field(l, 'eventId', p, string), quantityKey: field(l, 'quantityKey', p, string) }; }), acks: dictionary(o.acks, `${path}.acks`, string),
    receipts: dictionary(o.receipts, `${path}.receipts`, (v, p) => { const r = record(v, p); return { received: field(r, 'received', p, countOrNull), provisional: field(r, 'provisional', p, boolean), eventId: field(r, 'eventId', p, string), label: field(r, 'label', p, textOrNull) }; }), log,
  };
  if (version < 7 && (Object.hasOwn(o, 'receiptTemplates') || log.some(e => e.kind === 'receiptTemplateSave' || e.kind === 'receiptTemplateDelete' || e.kind === 'templateReceipt'))) invalid(path, '旧版はセットとその履歴を持たない');
  validateNeedImports(decoded, masters);
  return decoded;
}

function opEntry(value: unknown, path: string): OpEntry {
  const o = record(value, path);
  return { fingerprint: field(o, 'fingerprint', path, string), units: array(o.units, `${path}.units`, strings) };
}

function saveCheck(value: unknown, path: string): SaveCheck {
  const o = record(value, path);
  const r = record(o.resolution, `${path}.resolution`);
  return { opId: field(o, 'opId', path, string), opLabel: field(o, 'opLabel', path, string), savedTargets: field(o, 'savedTargets', path, strings), unsavedTargets: field(o, 'unsavedTargets', path, strings), attempt: field(o, 'attempt', path, string), openedAt: field(o, 'openedAt', path, time),
    resolution: { outcome: oneOf(r.outcome, `${path}.resolution.outcome`, ['saved', 'retried', 'remainderAbandoned', 'abandoned']), actor: field(r, 'actor', `${path}.resolution`, string), at: field(r, 'at', `${path}.resolution`, time) },
  };
}

type PrecisionMemo = ReadonlyMap<Step, WeakSet<object>>;
const precisionMemo = (): PrecisionMemo => new Map([[1, new WeakSet()], [0.1, new WeakSet()]]);
type Target = { item: string; unit: string };
const noTarget: Target = { item: '', unit: '' };

// 数量の表は同じ参照を複数の記録から共有する。同じ精度での再訪は省き、別の精度から指されたら検査し直す。
// 直前値の連なりは操作数だけ深くなるので、呼び出しを重ねずにたどる。
function checkQuantity(root: Quantity, step: Step, memo: PrecisionMemo): void {
  const done = memo.get(step)!;
  const stack = [root];
  for (let q = stack.pop(); q !== undefined; q = stack.pop()) {
    if (done.has(q)) continue;
    done.add(q);
    if (!done.has(q.terms)) {
      done.add(q.terms);
      for (const t of q.terms) if (t.observation.value !== null) validateScalar(t.observation.value, step);
    }
    if (q.kind === 'unknown') { if (q.before !== null) stack.push(q.before); continue; }
    if (q.numeric !== null) validateSignedScalar(q.numeric.value, step);
    if (q.kind === 'partlyUnknown') for (const part of q.unknownParts) stack.push(part);
  }
}

type ItemSteps = Readonly<Record<string, Step>>;
type CodeSpan = { op: number | null; steps: ItemSteps; before: string | null; after: string | null };
type CodeIndex = { spans: Map<string, CodeSpan[]>; initial: Map<string, ItemSteps[]> };

// 前後関係は記録時刻ではなく操作番号で決める。時計は巻き戻り得るが、操作番号は台帳と供給をまたいで増え続ける。
function opNumberOf(eventId: string): number | null {
  const match = /^op([1-9]\d*)(?:-|$)/.exec(eventId);
  return match === null ? null : Number(match[1]);
}

function pushTo<T>(map: Map<string, T[]>, key: string | null, value: T): void {
  if (key === null) return;
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]); else list.push(value);
}

// 既存IDごとに、それを付け外しした登録情報変更を台帳の順に持つ。履歴に現れない品目は現在のIDを最初から持つ。
function codeIndex(ledger: Ledger): CodeIndex {
  const spans = new Map<string, CodeSpan[]>(), initial = new Map<string, ItemSteps[]>(), seen = new Set<string>();
  for (const e of ledger.history) {
    if (e.kind !== 'master') continue;
    const op = opNumberOf(e.eventId);
    for (const { before, after } of e.masters) {
      if (after.type !== 'item') continue;
      const span: CodeSpan = { op, steps: after.unitSteps, before: before?.type === 'item' ? before.code : null, after: after.code };
      if (!seen.has(after.id)) { seen.add(after.id); pushTo(initial, span.before, span.steps); }
      pushTo(spans, span.before, span);
      if (span.after !== span.before) pushTo(spans, span.after, span);
    }
  }
  for (const m of Object.values(ledger.masters.items)) if (!seen.has(m.id)) pushTo(initial, m.code, m.unitSteps);
  return { spans, initial };
}

// 保留した時点でその既存IDを持っていた品目の精度を、操作の順と矛盾しない全ての場合について返す。持ち主がなければ1。
function heldRowSteps(ledger: Ledger): (code: string | null, unit: string, eventId: string) => Step[] {
  let index: CodeIndex | null = null;
  return (code, unit, eventId) => {
    if (code === null) return [1];
    const { spans, initial } = index ??= codeIndex(ledger);
    const hold = opNumberOf(eventId), related = spans.get(code) ?? [];
    // 同じ操作番号や番号のない記録は前後を決められない。
    const order = related.map(s => s.op === null || hold === null || s.op === hold ? 0 : s.op < hold ? -1 : 1);
    let from = order.lastIndexOf(-1) + 1, to = order.includes(1) ? order.indexOf(1) : related.length;
    if (from > to) { from = 0; to = related.length; }
    const stepOf = (steps: ItemSteps | null): Step => steps === null ? 1 : own(steps, unit) ?? 1;
    const result: Step[] = [];
    for (let position = from; position <= to; position++) {
      const span = related[position - 1];
      if (span !== undefined) result.push(stepOf(span.after === code ? span.steps : null));
      else { const owners = initial.get(code) ?? []; result.push(...(owners.length === 0 ? [1 as const] : owners.map(stepOf))); }
    }
    return result;
  };
}

// 持ち主を一つに決められないときは、どの場合の精度にも合うことを求める。
function checkHeldRow(value: number | null, steps: readonly Step[]): void {
  if (value === null) return;
  for (const step of steps) validateScalar(value, step);
}

type CountCheck = (value: number | null, ref: Target) => void;

// 現在と履歴のまとまり・記録の数量を検査し、記録が指すまとまりの品目・単位を返す。
function checkLedgerPrecision(ledger: Ledger, memo: PrecisionMemo, count: CountCheck): (id: string) => Target {
  const masters = ledger.masters;
  const lots = new Map<string, Target>();
  const lotRef = (id: string): Target => lots.get(id) ?? noTarget;
  const checkLot = (lot: Lot): void => {
    if (!lots.has(lot.id)) lots.set(lot.id, lot);
    checkQuantity(lot.quantity, quantityStepOf(masters, lot.item, lot.unit), memo);
    count(lot.lastCount?.value ?? null, lot);
  };
  const checkStop = (stop: Stop): void => { count(stop.affected, stop); if (stop.shortage !== null) count(stop.shortage.value, stop.shortage); };
  for (const lot of Object.values(ledger.lots)) checkLot(lot);
  for (const e of ledger.history) {
    for (const change of e.changes) { if (change.before !== null) checkLot(change.before); checkLot(change.after); }
    switch (e.kind) {
      case 'recount': {
        const ref = lotRef(e.lotId), step = quantityStepOf(masters, ref.item, ref.unit);
        count(e.value, ref); checkQuantity(e.compared, step, memo); checkQuantity(e.difference, step, memo);
        break;
      }
      case 'use': case 'handover': case 'split': case 'stage': case 'transfer': case 'rework': count(e.value, lotRef(e.lotId)); break;
      // 単位を持たない仮の記録は整数のまま。
      case 'provisional': if (e.value !== null) validateScalar(e.value, 1); break;
      case 'stop': checkStop(e.stop); break;
      case 'stopUpdate': { const ref = own(ledger.stops, e.stopId) ?? noTarget; count(e.previous, ref); count(e.affected, ref); break; }
      case 'reworkPart': if (e.action === 'discard') count(e.value, e); break;
      default: break;
    }
  }
  for (const stop of Object.values(ledger.stops)) checkStop(stop);
  return lotRef;
}

function checkSupplyPrecision(ledger: Ledger, supply: Supply, lotRef: (id: string) => Target, count: CountCheck): void {
  const requestRef = (id: string): Target => own(supply.requests, id) ?? noTarget;
  const checkNeed = (need: Need): void => count(need.required.value, need);
  const checkArrival = (a: Arrival, ref: Target): void => { count(a.arrived, ref); count(a.good, ref); };
  const checkRequest = (request: Request): void => { count(request.quantity, request); for (const a of request.arrivals) checkArrival(a, request); };
  const stepsOf = heldRowSteps(ledger);
  for (const need of Object.values(supply.needs)) checkNeed(need);
  for (const d of Object.values(supply.declarations)) count(d.value, d);
  for (const request of Object.values(supply.requests)) checkRequest(request);
  for (const [lotId, receipt] of Object.entries(supply.receipts)) count(receipt.received, lotRef(lotId));
  for (const e of supply.log) {
    switch (e.kind) {
      case 'needRegister': checkNeed(e.need); break;
      case 'needRevise': checkNeed(e.before); checkNeed(e.after); break;
      case 'shortageDeclare': count(e.declaration.value, e.declaration); break;
      case 'requestRecord': checkRequest(e.request); break;
      case 'receiptRecord': count(e.received, lotRef(e.lotId)); break;
      case 'receiptRevise': count(e.before, lotRef(e.lotId)); count(e.after, lotRef(e.lotId)); break;
      case 'arrival': checkArrival(e.arrival, requestRef(e.requestId)); break;
      case 'arrivalRevise': checkArrival(e.before, requestRef(e.requestId)); checkArrival(e.after, requestRef(e.requestId)); break;
      case 'needImport':
        if (e.decision.kind === 'hold') checkHeldRow(e.input.row.required.value, stepsOf(e.input.row.itemCode, e.input.row.unit, e.eventId));
        else { if (e.decision.before !== null) checkNeed(e.decision.before); checkNeed(e.decision.after); }
        break;
      case 'needImportResolve': if (e.resolution.kind === 'apply') { checkNeed(e.resolution.before); checkNeed(e.resolution.after); } break;
      default: break;
    }
  }
}

// 構造の復号は品目を知らないので、現在・履歴・各保存単位の数量を対象の品目・単位の精度へ照合する。
function validatePrecision(ledger: Ledger, supply: Supply, memo: PrecisionMemo, path: string): void {
  const count: CountCheck = (value, ref) => { if (value !== null) validateScalar(value, inputStepOf(ledger.masters, ref.item, ref.unit, value)); };
  try {
    checkSupplyPrecision(ledger, supply, checkLedgerPrecision(ledger, memo, count), count);
  } catch (error) {
    invalid(path, `数量が品目・単位の精度に合わない（${error instanceof Error ? error.message : String(error)}）`);
  }
}

// 描画される写しだけに当てる。精度と参照の検査を通った後に行い、それぞれの拒否理由を合計の超過で隠さない。全ての版に同じ上限を当てる（ADR-035）。
function requireDecodedTotals(ledger: Ledger, supply: Supply, path: string): void {
  try { requireQuantityTotals(ledger, supply); }
  catch (error) { invalid(path, error instanceof Error ? error.message : String(error)); }
}

// 旧版は第三の記録列を持たないので空へ補完し、新欄が紛れ込んでいれば黙って落とさず拒否する。
function conflictReviews(o: Record<string, unknown>, path: string, version: number): readonly ConflictReview[] {
  if (version < 6) return Object.hasOwn(o, 'conflictReviews') ? invalid(`${path}.conflictReviews`, '旧版は照合記録の列を持たない') : [];
  try { return parseConflictReviews(o.conflictReviews); }
  catch (error) { return invalid(`${path}.conflictReviews`, error instanceof Error ? error.message : String(error)); }
}

// 三つの記録列は同じ操作IDの空間を共有する。
function requireDistinctRecordIds(ledger: Ledger, supply: Supply, reviews: readonly ConflictReview[], path: string): void {
  const used = new Set([...ledger.history, ...supply.log].map(event => event.eventId));
  for (const review of reviews) if (used.has(review.eventId)) invalid(`${path}.conflictReviews`, `照合記録の操作ID ${review.eventId} が台帳または供給の記録と重複している`);
}

function validateHistoryLabels(ledger: Ledger, supply: Supply, path: string): void {
  const collector = createHistoryTargetCollector({ ledger, supply });
  const validate = (labels: EventItemLabels, ids: () => string[], eventPath: string) => {
    if (labels.kind === 'legacy-unavailable') return;
    try {
      if (JSON.stringify(Object.keys(labels.items).sort()) !== JSON.stringify(ids().sort())) invalid(`${eventPath}.itemLabels.items`, '対象品目IDの集合が履歴本文と一致しない');
    } catch (error) { return invalid(`${eventPath}.itemLabels`, error instanceof Error ? error.message : String(error)); }
  };
  ledger.history.forEach((event, index) => validate(event.itemLabels, () => collector.ledgerEventItemIds(event), `${path}.ledger.history[${index}]`));
  supply.log.forEach((event, index) => validate(event.itemLabels, () => collector.supplyEventItemIds(event), `${path}.supply.log[${index}]`));
}

export function decodeSnapshot(value: unknown): Snapshot {
  const path = 'snapshot';
  const o = record(value, path);
  const opFloor = field(o, 'opFloor', path, nonnegative);
  if (opFloor < 1) return invalid(`${path}.opFloor`, '1以上の番号下限が必要');
  const saveChecks = array(o.saveChecks, `${path}.saveChecks`, saveCheck);
  if (new Set(saveChecks.map(check => check.opId)).size !== saveChecks.length) return invalid(`${path}.saveChecks`, '操作IDごとの解消記録は一件まで');
  // 旧版も読み込むが保存先は書き換えない。次の確定から共通消耗品の設定を持てる版11で書く。
  const version = oneOf(o.version, `${path}.version`, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  if (version === 1 && o.quantities !== undefined) return invalid(`${path}.version`, '版1の写しは数量の表を持たない');
  const table = o.quantities === undefined ? null : quantityTable(o.quantities, `${path}.quantities`);
  const decodedLedger = ledger(o.ledger, `${path}.ledger`, table, version);
  const decodedSupply = supply(o.supply, `${path}.supply`, decodedLedger.masters, version);
  validatePrecision(decodedLedger, decodedSupply, precisionMemo(), path);
  validateAlternativeRecords(decodedLedger, decodedSupply);
  validateReceiptTemplates(decodedLedger, decodedSupply);
  validateUsageEstimates(decodedLedger, decodedSupply);
  validateReceipts(decodedSupply);
  validateRequests(decodedSupply);
  validateHistoryLabels(decodedLedger, decodedSupply, path);
  requireDecodedTotals(decodedLedger, decodedSupply, path);
  const reviews = conflictReviews(o, path, version);
  requireDistinctRecordIds(decodedLedger, decodedSupply, reviews, path);
  return {
    format: oneOf(o.format, `${path}.format`, ['fuzzy-stock-f0']), version: 11, revision: field(o, 'revision', path, nonnegative), lastWriter: field(o, 'lastWriter', path, string), opFloor,
    ledger: decodedLedger, supply: decodedSupply, ops: dictionary(o.ops, `${path}.ops`, opEntry), saveChecks, conflictReviews: reviews,
  };
}

// 包みなしの旧pendingも読む。版2以前の不足登録情報だけ補い、照合で見出しとの差を検査する。
function unitState(value: unknown, path: string, table: QuantityTable | null, version: number, memo: PrecisionMemo): UnitState {
  const o = record(value, path);
  const decodedLedger = ledger(o.ledger, `${path}.ledger`, table, version);
  const decodedSupply = supply(o.supply, `${path}.supply`, decodedLedger.masters, version);
  validatePrecision(decodedLedger, decodedSupply, memo, path);
  validateAlternativeRecords(decodedLedger, decodedSupply);
  validateReceiptTemplates(decodedLedger, decodedSupply);
  validateUsageEstimates(decodedLedger, decodedSupply);
  validateReceipts(decodedSupply);
  validateRequests(decodedSupply);
  validateHistoryLabels(decodedLedger, decodedSupply, path);
  const reviews = conflictReviews(o, path, version);
  requireDistinctRecordIds(decodedLedger, decodedSupply, reviews, path);
  // 合計の上限はここで検査しない。未確定の単位は描画されず、写しになる前に書く側の検査（preparedUnits）を必ず通るので、拒否すると照会・破棄による復旧の道だけを失う。
  return { ledger: decodedLedger, supply: decodedSupply, conflictReviews: reviews, targets: field(o, 'targets', path, strings) };
}

export function decodePending(value: unknown): Pending {
  const path = 'pending';
  const envelope = record(value, path);
  const table = envelope.quantities === undefined ? null : quantityTable(envelope.quantities, `${path}.quantities`);
  let o = envelope;
  let version = 1;
  if (Object.hasOwn(envelope, 'format') || Object.hasOwn(envelope, 'version') || Object.hasOwn(envelope, 'pending')) {
    oneOf(envelope.format, `${path}.format`, ['fuzzy-stock-pending']);
    version = oneOf(envelope.version, `${path}.version`, [4, 5, 6, 7, 8, 9, 10, 11]);
    o = record(envelope.pending, `${path}.pending`);
  }
  // 単位どうしは同じ数量の表を共有するので、検査済みの組も共有する。
  const memo = precisionMemo();
  const decodedUnits = array(o.units, `${path}.units`, (v, p) => unitState(v, p, table, version, memo));
  requireConsistentItemPrecisions(decodedUnits.map(unit => unit.ledger.masters));
  const decoded: Pending = {
    progress: oneOf(o.progress, `${path}.progress`, ['saving', 'partial']), unknownSince: field(o, 'unknownSince', path, timeOrNull), savingSince: field(o, 'savingSince', path, time), baseRevision: field(o, 'baseRevision', path, nonnegative), opId: field(o, 'opId', path, string), opLabel: field(o, 'opLabel', path, string), fingerprint: field(o, 'fingerprint', path, string),
    values: dictionary(o.values, `${path}.values`, (v, p) => typeof v === 'boolean' ? v : string(v, p)), actor: field(o, 'actor', path, string), startedAt: field(o, 'startedAt', path, time), units: decodedUnits,
  };
  if (isReviewOperation(decoded)) requireReviewPending(decoded, path);
  return decoded;
}

// 照合結果の保存は一単位・一記録で、Pendingの固定欄は確定する記録から決まる。追加された記録かどうかは基準の写しが要るので保存層（preparedUnits）が検査する。
function requireReviewPending(pending: Pending, path: string): void {
  if (pending.opLabel !== reviewOpLabel) return invalid(`${path}.opLabel`, '照合結果のfingerprintを持つ操作は固定の操作名が必要');
  const [unit, ...rest] = pending.units, review = unit?.conflictReviews.at(-1);
  if (unit === undefined || rest.length > 0 || review === undefined) return invalid(`${path}.units`, '照合結果の保存は一単位で、末尾に確定する照合記録が必要');
  if (review.eventId !== pending.opId) return invalid(`${path}.opId`, '照合記録の操作IDと保存する操作IDが一致しない');
  if (!isReviewFingerprint(pending.fingerprint)) return invalid(`${path}.fingerprint`, '照合結果のfingerprintは全文digestの版付き形式が必要');
  const values = reviewPendingValues(review);
  if (Object.keys(pending.values).length !== 2 || pending.values['reviewId'] !== values.reviewId || pending.values['outcome'] !== values.outcome) return invalid(`${path}.values`, '照合結果の値は識別子と結果だけで、記録と一致する必要がある');
  if (pending.actor !== review.resolution.actor || pending.startedAt !== review.resolution.at) return invalid(`${path}.actor`, '確認者と開始日時は照合記録と一致する必要がある');
}
