import type { Ledger, MasterChange, Process, Project } from './ledger.ts';
import { validateScalar, type Step } from './scalar.ts';

// 元の資料（全社の品目一覧など）の情報。手元の名称とは別に持つ（MST-06）。
export type Source = { name: string; revision: string };

// 時点つきの値。先頭だけfromがnull（最初から）で、fromの昇順。途中へは差し込まない（ADR-024）。
export type PerBox = { from: string | null; value: number | null };
export type ScopeEntry = { from: string | null; inScope: boolean };

// 箱の本数への換算（SUP-01）。箱ごとの1箱あたりの数は、その箱の受け取りの時点の値を使う（MST-05）。
export type Packaging = { boxUnit: string; pieceUnit: string; perBox: readonly PerBox[] };

export type ConsumableSetting = { pieceUnit: string; rule: { threshold: number; standardOrder: { value: number; unit: string } } | null };

// idは記録が指す変わらない識別、codeは画面と出力で見せる既存ID。codeがnullなら仮の品目・案件・用途（MST-07）。
export type ItemMaster = {
  type: 'item'; id: string; code: string | null; name: string; source: Source | null;
  units: readonly string[]; unitSteps: Readonly<Record<string, Step>>; trial: boolean; active: boolean; packaging: Packaging | null;
  consumable: ConsumableSetting | null;
};
// nextProcessは次工程への引渡しの渡し先。台帳全体で一件まで（MFG-06）。
export type LocationMaster = { type: 'location'; id: string; code: string; name: string; trial: boolean; active: boolean; scope: readonly ScopeEntry[]; nextProcess: boolean };
export type CaseMaster = { type: 'case'; id: string; code: string | null; name: string | null; source: Source | null; active: boolean };
// 担当者は名前で識別する（TBD-13の決定まで）。idが名前。
export type ActorMaster = { type: 'actor'; id: string; active: boolean };
// 記録には工程の値{ id, criterion }を写すので、名前を変えてもidは変えない。
export type ProcessMaster = { type: 'process'; id: string; name: string; criterion: Process['criterion']; active: boolean };
export type Master = ItemMaster | LocationMaster | CaseMaster | ActorMaster | ProcessMaster;

export const masterTypeLabel: Record<Master['type'], string> = { item: '品目', location: '場所', case: '案件', actor: '担当者', process: '工程' };

// masterTypeLabelは保存済み対象名にも使うため、表示だけを別にする。
export const masterTypeDisplayLabel: Record<Master['type'], string> = { ...masterTypeLabel, case: '案件・用途' };

export type Masters = {
  items: Readonly<Record<string, ItemMaster>>;
  locations: Readonly<Record<string, LocationMaster>>;
  cases: Readonly<Record<string, CaseMaster>>;
  actors: Readonly<Record<string, ActorMaster>>;
  processes: Readonly<Record<string, ProcessMaster>>;
};

// 現在値と履歴は同じオブジェクトを共有するため、凍結しないと現在値の書換えで過去の記録まで変わる。
// 凍結済みのものは中身まで凍結済みなので辿らず、履歴全体を毎回たどらずに済ませる。
// 台帳がこのファイルを読み込むので、台帳側に置くと循環する。
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const item = (id: string, name: string, units: string[], trial = true, packaging: Packaging | null = null): ItemMaster =>
  ({ type: 'item', id, code: id, name, source: null, units, unitSteps: integerUnitSteps(units), trial, active: true, packaging, consumable: null });
const location = (id: string, name: string, trial = true, nextProcess = false): LocationMaster =>
  ({ type: 'location', id, code: id, name, trial, active: true, scope: [{ from: null, inScope: true }], nextProcess });
const byId = <T extends { id: string }>(list: T[]): Record<string, T> => Object.fromEntries(list.map((m) => [m.id, m]));

// F0_SCOPE.mdの固定の架空登録情報。実品目・実案件・用途ではない（NFR-10）。練習用の台帳と、以前の形式の記録の読み込みに使う。
export const fixedMasters: Masters = deepFreeze({
  items: byId([
    item('P', '架空部品P', ['個']),
    item('Q', '架空部品Q', ['個']),
    item('R', '架空半製品R', ['台']),
    // ネジは本で数えるが、入り数の分からない箱のまま持つこともある。入り数は試験データで、現場の設定ではない（ADR-005、TBD-05）。
    item('S', '架空共通ネジS', ['本', '箱'], true, { boxUnit: '箱', pieceUnit: '本', perBox: [{ from: null, value: 1000 }] }),
    // AT-42の別品目。開封分は残量区分だけを登録する。包装の入り数と補充基準は持たない（B2）。
    item('V', '架空共通ワッシャV', ['本']),
    item('X', '架空対象外部品X', ['個'], false),
  ]),
  locations: byId([location('S1', '棚S1'), location('S2', '棚S2'), location('T', '作業台T'), location('N', '次工程N', true, true), location('O', '対象外の棚O', false)]),
  cases: byId(['A-001', 'A-002', 'B-001'].map((id): CaseMaster => ({ type: 'case', id, code: id, name: null, source: null, active: true }))),
  actors: byId(['架空担当A', '架空担当B'].map((id): ActorMaster => ({ type: 'actor', id, active: true }))),
  // 旧版の工程は記録から補うので、記録に現れない工程をここで足さない。
  processes: {},
});

function entryAt<T extends { from: string | null }>(entries: readonly T[], at: string): T {
  const time = Date.parse(at);
  const found = entries.findLast((e) => e.from === null || Date.parse(e.from) <= time);
  if (!found) throw new Error('時点つきの値に、最初からの値がない');
  return found;
}

export const perBoxAt = (packaging: Packaging, at: string): number | null => entryAt(packaging.perBox, at).value;
export const inScopeAt = (location: LocationMaster, at: string): boolean => entryAt(location.scope, at).inScope;

// 画面は案件・用途を共通在庫・所属不明の値（common・unassigned）と案件・用途の内部の識別で選ぶので、案件・用途の内部の識別にこの値を使わない。
export const reservedCaseIds: readonly string[] = ['common', 'unassigned'];

// 辞書は利用者の入力した文字列をキーにするので、「constructor」などで継承したプロパティを引かない。
export function own<T>(group: Readonly<Record<string, T>>, id: string): T | undefined {
  return Object.hasOwn(group, id) ? group[id] : undefined;
}

// 旧形式と現行の整数入力だけに使う。新規登録の精度欠落を暗黙に補わない。
export function integerUnitSteps(units: readonly string[]): Record<string, Step> {
  return Object.fromEntries(units.map(unit => [unit, 1 as const]));
}

export function checkedUnitSteps(value: unknown, units: readonly string[]): Record<string, Step> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.keys(value).length !== units.length || units.some(unit => !Object.hasOwn(value, unit))) {
    throw new Error('単位ごとの最小単位は管理単位と同じ欄が必要');
  }
  return Object.fromEntries(units.map(unit => {
    const step: unknown = Reflect.get(value, unit);
    if (step !== 1 && step !== 0.1) throw new Error(`単位 ${unit} の最小単位は1または0.1にする`);
    return [unit, step];
  }));
}

export function quantityStepOf(masters: Masters, itemId: string, unit: string): Step {
  const item = own(masters.items, itemId);
  return item === undefined ? 1 : own(item.unitSteps, unit) ?? 1;
}

export function checkedConsumable(item: ItemMaster, setting: ConsumableSetting | null): ConsumableSetting | null {
  if (setting === null) return null;
  const step = own(item.unitSteps, setting.pieceUnit);
  if (step === undefined) throw new Error('集計単位は品目の管理単位から選ぶ');
  if (item.packaging !== null && setting.pieceUnit !== item.packaging.pieceUnit) throw new Error('集計単位は包装の中身の単位とそろえる');
  if (setting.rule === null) return { pieceUnit: setting.pieceUnit, rule: null };
  const { threshold, standardOrder } = setting.rule;
  validateScalar(threshold, step);
  const orderStep = own(item.unitSteps, standardOrder.unit);
  if (orderStep === undefined) throw new Error('標準依頼の単位は品目の管理単位から選ぶ');
  if (validateScalar(standardOrder.value, orderStep) <= 0) throw new Error('標準依頼数量は0より大きくする');
  return { pieceUnit: setting.pieceUnit, rule: { threshold, standardOrder: { ...standardOrder } } };
}

export function checkPackagingUnits(item: ItemMaster, packaging: Packaging): void {
  if (packaging.boxUnit === packaging.pieceUnit || !item.units.includes(packaging.boxUnit) || !item.units.includes(packaging.pieceUnit)) {
    throw new Error('包装と中身には異なる管理単位を選ぶ');
  }
  if (item.consumable !== null && item.consumable.pieceUnit !== packaging.pieceUnit) throw new Error('包装の中身の単位は共通消耗品の集計単位とそろえる');
}

const itemSettings = (item: ItemMaster) => ({ packaging: item.packaging, consumable: item.consumable });
const sameSettings = (a: ItemMaster, b: ItemMaster) => JSON.stringify(itemSettings(a)) === JSON.stringify(itemSettings(b));

function requirePerBoxChange(before: ItemMaster, after: ItemMaster, meta: { occurredAt: string | null; recordedAt: string }): void {
  const old = before.packaging, next = after.packaging, last = next?.perBox.at(-1);
  if (old === null || next === null || last === undefined || last.value === null
    || JSON.stringify({ ...before, packaging: next }) !== JSON.stringify(after)
    || old.boxUnit !== next.boxUnit || old.pieceUnit !== next.pieceUnit
    || next.perBox.length !== old.perBox.length + 1 || JSON.stringify(next.perBox.slice(0, -1)) !== JSON.stringify(old.perBox)
    || !Number.isSafeInteger(last.value) || last.value < 1 || last.value === old.perBox.at(-1)?.value
    || last.from === null || last.from !== meta.occurredAt || Date.parse(last.from) > Date.parse(meta.recordedAt)) {
    throw new Error('入り数の変更は包装単位と既存設定を保って一件だけ追加する');
  }
  const previous = old.perBox.at(-1)?.from;
  if (previous != null && Date.parse(last.from) <= Date.parse(previous)) throw new Error('入り数の適用時点は前回より後にする');
}

export function requireConsistentItemSettings(ledger: Ledger): void {
  const seen = new Map<string, ItemMaster>();
  for (const event of ledger.history) {
    if (event.kind !== 'master') continue;
    for (const { before, after } of event.masters) {
      if (after.type !== 'item') continue;
      const previous = seen.get(after.id);
      if ((before !== null && (before.type !== 'item' || before.id !== after.id))
        || (previous !== undefined && (before === null || before.type !== 'item' || !sameSettings(previous, before)))) {
        throw new Error('品目の設定の変更前が直前の変更後と一致しない');
      }
      if (before?.type === 'item') {
        if (event.action === 'perBox') requirePerBoxChange(before, after, event);
        if (event.action !== 'consumable' && JSON.stringify(before.consumable) !== JSON.stringify(after.consumable)) throw new Error('共通消耗品以外の操作で設定を変えられない');
        if (event.action !== 'packaging' && event.action !== 'perBox' && JSON.stringify(before.packaging) !== JSON.stringify(after.packaging)) throw new Error('包装以外の操作で包装を変えられない');
      } else if (after.packaging !== null || after.consumable !== null) throw new Error('新規品目の包装・共通消耗品設定は未設定から始める');
      seen.set(after.id, after);
    }
  }
  for (const [id, historical] of seen) {
    const current = own(ledger.masters.items, id);
    if (current === undefined || !sameSettings(historical, current)) throw new Error('現在の品目設定が最後の変更履歴と一致しない');
  }
}

// 保存する単位では、元の設定から新しいmaster履歴だけを適用した結果と現在値を照合する。
export function requireItemSettingsTransition(before: Masters, after: Masters, changes: readonly MasterChange[]): void {
  const items = new Map(Object.values(before.items).map(item => [item.id, item]));
  for (const change of changes) {
    if (change.after.type !== 'item') continue;
    const previous = items.get(change.after.id);
    if (previous === undefined ? change.before !== null : change.before?.type !== 'item' || !sameSettings(previous, change.before)) throw new Error('保存する品目設定の変更前が元の設定と一致しない');
    items.set(change.after.id, change.after);
  }
  if (items.size !== Object.keys(after.items).length || [...items].some(([id, item]) => {
    const current = own(after.items, id);
    return current === undefined || !sameSettings(item, current);
  })) throw new Error('保存する品目設定が変更履歴に対応していない');
}

// 保存する単位では、元の工程と次工程の指定に新しいmaster履歴だけを適用した結果と現在値を照合する。
// recordedは記録から補える工程。版12より前の保存途中の単位は、記録に初めて現れた工程を履歴なしで補うので、それとの一致は認める。
// 版は見ない。版12の単位でこの形の工程を足しても、旧版の読込で補う工程と同じ値にしかならない。
export function requireProcessTransition(before: Masters, after: Masters, changes: readonly MasterChange[], recorded: Readonly<Record<string, ProcessMaster>> = {}): void {
  const processes = new Map(Object.values(before.processes).map(p => [p.id, p]));
  for (const p of Object.values(after.processes)) {
    const legacy = own(recorded, p.id);
    if (!processes.has(p.id) && legacy !== undefined && !changes.some(c => c.after.type === 'process' && c.after.id === p.id)) processes.set(p.id, legacy);
  }
  const flags = new Map(Object.values(before.locations).map(l => [l.id, l.nextProcess]));
  for (const { before: from, after: to } of changes) {
    if (to.type === 'process') {
      if (JSON.stringify(processes.get(to.id) ?? null) !== JSON.stringify(from)) throw new Error('保存する工程の変更前が元の設定と一致しない');
      processes.set(to.id, to);
    } else if (to.type === 'location') flags.set(to.id, to.nextProcess);
  }
  if (processes.size !== Object.keys(after.processes).length || [...processes].some(([id, p]) => JSON.stringify(own(after.processes, id)) !== JSON.stringify(p))) {
    throw new Error('保存する工程の設定が変更履歴に対応していない');
  }
  if (Object.values(after.locations).some(l => (flags.get(l.id) ?? false) !== l.nextProcess)) throw new Error('保存する次工程の指定が変更履歴に対応していない');
}

// 練習開始時だけの架空設定。旧版補完に使うfixedMastersへは混ぜない。
export const practiceMasters: Masters = deepFreeze({ ...fixedMasters,
  processes: { R組立: { type: 'process', id: 'R組立', name: 'R組立', criterion: 'inspection', active: true } },
  items: { ...fixedMasters.items,
  S: { ...fixedMasters.items.S!, consumable: { pieceUnit: '本', rule: { threshold: 3000, standardOrder: { value: 1, unit: '箱' } } } },
  V: { ...fixedMasters.items.V!, consumable: { pieceUnit: '本', rule: null } },
} });

// 精度不明の単位と、登録済みの整数単位の小数拒否を区別する。整数の既存契約は変えない。
export function inputStepOf(masters: Masters, itemId: string, unit: string, value: number | null): Step {
  const item = own(masters.items, itemId);
  if (value !== null && Number.isFinite(value) && !Number.isInteger(value)
    && (item === undefined || !Object.hasOwn(item.unitSteps, unit))) {
    throw new Error(`品目 ${itemId}・単位 ${unit} の最小単位の設定が不明なので小数を入力できない`);
  }
  return quantityStepOf(masters, itemId, unit);
}

// 変更前後にある同じ品目IDは同じ単位/精度を持つ。新規IDの登録は妨げない。
export function requireSameItemPrecisions(before: Masters, after: Masters): void {
  for (const item of Object.values(before.items)) {
    const next = own(after.items, item.id);
    if (next !== undefined && (item.units.length !== next.units.length
      || item.units.some((unit, index) => unit !== next.units[index] || item.unitSteps[unit] !== next.unitSteps[unit]))) {
      throw new Error(`品目 ${item.id} の管理単位と最小単位は登録後に変更できない`);
    }
  }
}

// 単位列で一時的にIDが欠けても、再出現した同じIDの精度を取り替えない。
export function requireConsistentItemPrecisions(states: readonly Masters[]): void {
  const seen = new Map<string, ItemMaster>();
  for (const state of states) for (const item of Object.values(state.items)) {
    const previous = seen.get(item.id);
    if (previous !== undefined && (previous.units.length !== item.units.length
      || previous.units.some((unit, index) => unit !== item.units[index] || previous.unitSteps[unit] !== item.unitSteps[unit]))) {
      throw new Error(`品目 ${item.id} の管理単位と最小単位は登録後に変更できない`);
    }
    seen.set(item.id, item);
  }
}

// 現在の一覧・入力で見せる工程の名前。利用停止中は状態を付ける。知らないIDはそのまま見せる。
export function processRef(masters: Masters, id: string): string {
  const m = own(masters.processes, id);
  return m === undefined ? id : m.active ? m.name : `${m.name}（利用停止）`;
}

export function processOf(masters: Masters, id: string): Process | undefined {
  const m = own(masters.processes, id);
  return m === undefined ? undefined : { id: m.id, criterion: m.criterion };
}

export function nextProcessOf(masters: Masters): LocationMaster | null {
  return Object.values(masters.locations).find(location => location.nextProcess) ?? null;
}

export function codeOwner(masters: Masters, type: 'item' | 'location' | 'case', code: string): Master | undefined {
  const group: Readonly<Record<string, Master>> = type === 'item' ? masters.items : type === 'location' ? masters.locations : masters.cases;
  return Object.values(group).find((m) => m.type !== 'actor' && m.type !== 'process' && m.code === code);
}

// 新しい記録に利用停止中の登録情報を使わせない（MST-03）。知らないIDは画面が出さないので、ここでは止めない（ADR-024）。
export function requireActive(masters: Masters, ref: { item?: string; project?: Project }): void {
  const stopped = (m: { active: boolean } | undefined): boolean => m !== undefined && !m.active;
  if (ref.item !== undefined && stopped(own(masters.items, ref.item))) throw new Error(`品目 ${own(masters.items, ref.item)?.code ?? ref.item} は利用停止中`);
  if (ref.project?.kind === 'case' && stopped(own(masters.cases, ref.project.id))) throw new Error(`案件・用途 ${own(masters.cases, ref.project.id)?.code ?? ref.project.id} は利用停止中`);
}

export const unassignedCode = '品番・コードなし（仮）';

// 記録が指す内部の識別から、画面と出力と確認の文で見せる現在の既存IDを引く（ADR-024）。仮は「（仮）名称」、利用停止は「（利用停止）」を付ける。
// 固定の架空登録情報のままなら、内部の識別と同じ文字になる。知らないIDはそのまま見せる。
export function refOf(group: Readonly<Record<string, { id: string; code: string | null; name: string | null; active: boolean }>>, id: string): string {
  const m = own(group, id);
  if (!m) return id;
  const code = m.code ?? `（仮）${m.name ?? m.id}`;
  return m.active ? code : `${code}（利用停止）`;
}
