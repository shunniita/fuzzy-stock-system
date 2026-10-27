import { checkPackagingUnits, checkedUnitSteps, codeOwner, masterTypeDisplayLabel, own, reservedCaseIds, unassignedCode, type ItemMaster, type Packaging, type Master, type Masters, type Source } from './masters.ts';
import type { Step } from './scalar.ts';
import type { Process } from './ledger.ts';

// 台帳の確定と履歴には触れない、登録情報の登録と変更の入力の検査（要件1〜7）。ledger.tsのmasterPlanがこれを使って変更後の登録情報を組む。

function required(text: string, label: string): void {
  if (text.trim() === '') throw new Error(`${label}を入力する`);
}

export type NewMaster =
  | { type: 'item'; code: string | null; name: string; units: readonly string[]; unitSteps: Readonly<Record<string, Step>>; trial: boolean; source: Source | null }
  | { type: 'location'; code: string; name: string; trial: boolean; inScope: boolean }
  | { type: 'case'; code: string | null; name: string | null; source: Source | null }
  | { type: 'actor'; name: string }
  | { type: 'process'; name: string; criterion: Process['criterion'] };

export type TrialReview = { quantities: string; requests: string; corrections: string; restore: string; initial: string };

export function checkTrialReview(review: TrialReview): void {
  required(review.quantities, '既存数量の確認');
  required(review.requests, '未完了依頼の確認');
  required(review.corrections, '訂正手順の確認');
  required(review.restore, '復元手順の確認');
  required(review.initial, '開始数量の確認');
}

function masterName(m: Master): string {
  return m.type === 'actor' ? m.id : m.type === 'process' ? m.name : m.name ?? m.code ?? m.id;
}

export function masterRef(m: Master): string {
  const code = m.type === 'actor' ? m.id : m.type === 'process' ? '' : m.code ?? unassignedCode;
  return `${masterTypeDisplayLabel[m.type]}${code}「${masterName(m)}」（${m.active ? '利用中' : '利用停止中'}）`;
}

export function masterOf(masters: Masters, type: Master['type'], id: string): Master {
  const group: Readonly<Record<string, Master>> = type === 'item' ? masters.items : type === 'location' ? masters.locations : type === 'case' ? masters.cases : type === 'process' ? masters.processes : masters.actors;
  const found = own(group, id);
  if (!found) throw new Error(`${masterTypeDisplayLabel[type]} ${id} は登録されていない`);
  return found;
}

// 既存IDを変えても記録が同じ登録情報を指すよう、内部の識別は変えない。登録の時点で既存IDが内部の識別として空いていればそれを使う。
// 案件・用途の内部の識別は、共通在庫・所属不明を表す値（common・unassigned）と重ねない。画面は案件・用途をこの値で選ぶ。
function newMasterId(group: Readonly<Record<string, Master>>, code: string | null, prefix: string, eventId: string, reserved: readonly string[] = []): string {
  if (code !== null && !Object.hasOwn(group, code) && !reserved.includes(code)) return code;
  let id = `${prefix}-${eventId}`;
  for (let n = 2; Object.hasOwn(group, id); n++) id = `${prefix}-${eventId}-${n}`;
  return id;
}

// 同じ種類で同じ既存IDの登録情報を二つ作らない（要件1.5・1.6）。
function codeFree(masters: Masters, type: 'item' | 'location' | 'case', code: string): void {
  const owner = codeOwner(masters, type, code);
  if (owner) throw new Error(`品番・コード ${code} は${masterRef(owner)}が使っている。同じ物ならその登録情報を使い、違う物なら別の品番・コードで登録する`);
}

function sourceOf(source: Source | null): Source | null {
  if (source === null) return null;
  required(source.name, '元の資料の名称');
  required(source.revision, '元の資料の版');
  return { name: source.name, revision: source.revision };
}

export function registered(masters: Masters, eventId: string, m: NewMaster): Master {
  switch (m.type) {
    case 'item': {
      required(m.name, '呼び名');
      if (m.code !== null) { required(m.code, '品番・コード'); codeFree(masters, 'item', m.code); }
      for (const unit of m.units) required(unit, '単位');
      if (m.units.length === 0 || new Set(m.units).size !== m.units.length) throw new Error('単位は重ならずに一つ以上入力する');
      return { type: 'item', id: newMasterId(masters.items, m.code, 'item', eventId), code: m.code, name: m.name, source: sourceOf(m.source), units: [...m.units], unitSteps: checkedUnitSteps(m.unitSteps, m.units), trial: m.trial, active: true, packaging: null, consumable: null };
    }
    case 'location':
      required(m.code, '品番・コード');
      required(m.name, '名称');
      codeFree(masters, 'location', m.code);
      return { type: 'location', id: newMasterId(masters.locations, m.code, 'location', eventId), code: m.code, name: m.name, trial: m.trial, active: true, scope: [{ from: null, inScope: m.inScope }], nextProcess: false };
    case 'case':
      if (m.code !== null) { required(m.code, '品番・コード'); codeFree(masters, 'case', m.code); }
      if (m.name !== null) required(m.name, '呼び名');
      if (m.code === null && m.name === null) throw new Error('品番・コードのない仮の案件・用途には、呼び名を入力する');
      return { type: 'case', id: newMasterId(masters.cases, m.code, 'case', eventId, reservedCaseIds), code: m.code, name: m.name, source: sourceOf(m.source), active: true };
    case 'actor': {
      required(m.name, '担当者の名前');
      const same = own(masters.actors, m.name);
      if (same) throw new Error(`同じ名前の担当者「${m.name}」がいる（${same.active ? '利用中' : '利用停止中'}）`);
      return { type: 'actor', id: m.name, active: true };
    }
    case 'process': {
      const name = m.name.trim();
      processNameFree(masters, name);
      if (m.criterion !== 'workEnd' && m.criterion !== 'inspection') throw new Error('工程の完了基準を選ぶ');
      return { type: 'process', id: newMasterId(masters.processes, name, 'process', eventId), name, criterion: m.criterion, active: true };
    }
  }
}

// 工程は名前で選ぶので、利用停止中も含めて現在の名前を重ねない（要件1.2・2.5）。
export function processNameFree(masters: Masters, name: string, except?: string): void {
  required(name, '工程の名前');
  const same = Object.values(masters.processes).find(p => p.id !== except && p.name.trim() === name.trim());
  if (same) throw new Error(`同じ名前の工程「${same.name}」がある（${same.active ? '利用中' : '利用停止中'}）`);
}

// 適用時点は実際の日時で、入力した日時より後（未来）と、前回の変更の適用時点以前は受け付けない（要件6.10・7.8）。
export function effectiveFrom(meta: { occurredAt: string | null; recordedAt: string }, entries: readonly { from: string | null }[]): string {
  if (meta.occurredAt === null) throw new Error('適用時点（実際の日時）を入力する');
  if (Date.parse(meta.occurredAt) > Date.parse(meta.recordedAt)) throw new Error('未来の適用時点は扱わない');
  const previous = entries[entries.length - 1]?.from ?? null;
  if (previous !== null && Date.parse(meta.occurredAt) <= Date.parse(previous)) throw new Error(`適用時点は前回の変更の適用時点（${previous}）より後にする`);
  return meta.occurredAt;
}

export function initialPackaging(item: ItemMaster, meta: { occurredAt: string | null; recordedAt: string }, boxUnit: string, pieceUnit: string, value: number): Packaging {
  if (item.packaging !== null) throw new Error('包装は設定済み。入り数の変更を使う');
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('入り数は1以上の安全な整数にする');
  const packaging = { boxUnit, pieceUnit, perBox: [{ from: null, value: null }, { from: effectiveFrom(meta, []), value }] };
  checkPackagingUnits(item, packaging);
  return packaging;
}
