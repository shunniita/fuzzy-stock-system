import { checkTime, type Ledger, type Meta, type Project } from './ledger.ts';
import { inScopeAt, own, quantityStepOf, type Masters } from './masters.ts';
import { validateScalar } from './scalar.ts';
import { receiveLot, recordReceiptTemplate, recordRequest, removeReceiptTemplate, recordTemplateReceipt, sameProject, type Supply } from './supply.ts';
import { assemblyRecipeRowLimit, checkAssemblyRecipe, defaultAssemblyRoutes, expandAssemblyRecipe, normalizeAssemblyRecipe, type ExpandedAssemblyRow } from './assembly-recipes.ts';

export type ReceiptTemplateRow = { item: string; unit: string; perSet: number; location: string; assembly?: ReceiptTemplate };
// project は版7の案件・用途固定テンプレートの名残で、受け取り時の初期値にだけ使う。新しい保存ではnullにする。
export type ReceiptTemplate = { id: string; name: string; product: string | null; productUnit?: string; project: Project | null; basis: 'counted' | 'label' | 'approximate'; rows: readonly ReceiptTemplateRow[] };
export type TemplateReceiptRow = { lotId: string | null; quantity: number; shortfall: number };
export type ReceiptRoute = 'assembled' | 'parts';
export type TemplateReceipt = { template: ReceiptTemplate; project: Project; sets: number; vendor: string | null; rows: readonly TemplateReceiptRow[]; routes?: readonly ReceiptRoute[] };
export type ReceiptInput = { quantity: number; shortfall: number };
export const receiptTemplateRowLimit = assemblyRecipeRowLimit;

function checkProject(masters: Masters, project: Project, at?: string): void {
  if (project.kind !== 'case') return;
  const found = own(masters.cases, project.id);
  if (!found || (at !== undefined && !found.active)) throw new Error('案件・用途は登録済みで利用中のものを選ぶ');
}

export function checkReceiptTemplate(template: ReceiptTemplate, masters: Masters, at?: string): void {
  checkAssemblyRecipe(template, masters);
  checkTemplateContext(template, masters, at);
  if (at !== undefined) for (const row of template.rows) checkReceiptTarget(row, masters, at);
}

function checkTemplateContext(template: ReceiptTemplate, masters: Masters, at?: string): void {
  if (at !== undefined) checkTime(at, '適用');
  if (template.project !== null) checkProject(masters, template.project, at);
  if (template.product !== null) {
    const product = own(masters.items, template.product);
    if (!product || (at !== undefined && !product.active)) throw new Error('製品の品目は登録済みで利用中のものを選ぶ');
  }
}

function checkReceiptTarget(row: ReceiptTemplateRow, masters: Masters, at: string): void {
  const item = own(masters.items, row.item), place = own(masters.locations, row.location);
  if (!item || !item.units.includes(row.unit)) throw new Error(`品目 ${row.item}・単位 ${row.unit} が登録されていない`);
  if (!place) throw new Error(`場所 ${row.location} が登録されていない`);
  if (!item.active || !place.active) throw new Error('利用停止中の品目・場所は新たに使えない');
  if (!inScopeAt(place, at)) throw new Error(`場所 ${row.location} は ${at} の時点で記録の対象外`);
}

export function saveReceiptTemplate(ledger: Ledger, supply: Supply, meta: Meta, template: Omit<ReceiptTemplate, 'project'>): Supply {
  if (template.product === null || !template.product) throw new Error('製品の品目を選ぶ');
  // 一致の検査はJSON文字列で比べるので、読込時の復号と同じキー順で保存する。
  const saved = normalizeAssemblyRecipe({ ...template, project: null }, ledger.masters);
  checkReceiptTemplate(saved, ledger.masters, meta.occurredAt ?? meta.recordedAt);
  const before = own(supply.receiptTemplates, saved.id);
  checkImportedRecipes(saved, before, supply, ledger.masters);
  if (before && JSON.stringify(before) === JSON.stringify(saved)) throw new Error('変更がない');
  return recordReceiptTemplate(supply, ledger.masters, meta, saved);
}

function checkImportedRecipes(template: ReceiptTemplate, before: ReceiptTemplate | undefined, supply: Supply, masters: Masters): void {
  const children = template.rows.flatMap(row => row.assembly === undefined ? [] : [row.assembly]);
  if (children.length === 0) return;
  const known = [...Object.values(supply.receiptTemplates)];
  for (const event of supply.log) {
    if (event.kind === 'receiptTemplateSave') {
      known.push(event.after);
      if (event.before !== null) known.push(event.before);
    } else if (event.kind === 'receiptTemplateDelete') known.push(event.before);
  }
  const childIds = new Set(children.map(child => child.id));
  const versions = new Set(known.filter(candidate => childIds.has(candidate.id))
    .map(candidate => recipeVersion(candidate, masters)));
  checkImportedRecipeVersions(template, before, versions, masters);
}

function recipeVersion(template: ReceiptTemplate, masters: Masters): string {
  return JSON.stringify(normalizeAssemblyRecipe(template, masters, { allowLegacySelfReference: true }));
}

function checkImportedRecipeVersions(template: ReceiptTemplate, before: ReceiptTemplate | undefined, versions: ReadonlySet<string>, masters: Masters): void {
  const retained = new Set(before?.rows.flatMap(row => row.assembly === undefined ? [] : [recipeVersion(row.assembly, masters)]));
  for (const row of template.rows) {
    if (row.assembly === undefined) continue;
    const version = recipeVersion(row.assembly, masters);
    if (!versions.has(version) && !retained.has(version)) throw new Error('子の構成は登録済みセットの保存版から取り込む');
  }
}

export function deleteReceiptTemplate(supply: Supply, masters: Masters, meta: Meta, id: string): Supply {
  const before = own(supply.receiptTemplates, id);
  if (!before) throw new Error('削除するテンプレートがない');
  return removeReceiptTemplate(supply, masters, meta, before);
}

export function checkSetCount(sets: number): void {
  if (!Number.isSafeInteger(sets) || sets <= 0) throw new Error('個数は正の安全な整数にする');
}

export function expandReceiptTemplate(ledger: Ledger, template: ReceiptTemplate, sets: number, routes?: readonly ReceiptRoute[]): number[] {
  return expandAssemblyRecipe(ledger.masters, template, sets, routes).map(row => row.planned);
}

function checkReceiptRows(ledger: Ledger, template: ReceiptTemplate, sets: number, rows: readonly ReceiptInput[], vendor: string | null, routes?: readonly ReceiptRoute[]): ExpandedAssemblyRow[] {
  const parts = expandAssemblyRecipe(ledger.masters, template, sets, routes);
  if (rows.length !== parts.length) throw new Error('今回の数量とテンプレートの展開明細数が異なる');
  for (const [index, row] of rows.entries()) {
    const part = parts[index]!, step = quantityStepOf(ledger.masters, part.item, part.unit);
    validateScalar(row.quantity, step);
    validateScalar(row.shortfall, step);
    if (row.shortfall > part.planned) throw new Error(`明細${index + 1}の不足数が予定数${part.planned}${part.unit}を超える`);
  }
  const short = rows.some(row => row.shortfall > 0);
  if (rows.every(row => row.quantity === 0 && row.shortfall === 0)) throw new Error('受け取った数も不足数も全行0では記録できない');
  if (short && (vendor === null || !vendor.trim())) throw new Error('不足があるときは手配先（欠品リストの発行元など）を入力する');
  if (!short && vendor !== null) throw new Error('不足がないときは手配先を記録しない');
  return parts;
}

// 依頼日は日本時間の暦日。UTC表記の日時の先頭10文字では日付がずれる。
const requestDateOf = (meta: Meta): string => new Date(Date.parse(meta.occurredAt ?? meta.recordedAt) + 9 * 3600_000).toISOString().slice(0, 10);

// 不足の行は既存の依頼として記録し、後日の到着を既存の割り当てで未着分として追えるようにする。依頼への自動割り当てはしない。
export function receiveTemplate(state: { ledger: Ledger; supply: Supply }, meta: Meta, id: string, project: Project, sets: number, inputs: readonly ReceiptInput[], vendor: string | null, routes?: readonly ReceiptRoute[]): { ledger: Ledger; supply: Supply } {
  const template = own(state.supply.receiptTemplates, id);
  if (!template) throw new Error('セットを選ぶ（なければ先に登録する）');
  const at = meta.occurredAt ?? meta.recordedAt;
  // 旧版の案件・用途は初期値にすぎないので、利用中かを検査するのは今回選んだ案件・用途だけ。
  checkTemplateContext({ ...template, project: null }, state.ledger.masters, at);
  checkProject(state.ledger.masters, project, at);
  const savedRoutes = routes === undefined ? defaultAssemblyRoutes(template) : [...routes];
  const parts = checkReceiptRows(state.ledger, template, sets, inputs, vendor, savedRoutes);
  for (const row of parts) checkReceiptTarget(row, state.ledger.masters, at);
  const saved: Project = project.kind === 'case' ? { kind: project.kind, id: project.id } : { kind: project.kind };
  let staged = state;
  const rows: TemplateReceiptRow[] = [];
  for (const [index, row] of parts.entries()) {
    const { quantity, shortfall } = inputs[index]!;
    let lotId: string | null = null;
    if (quantity > 0) {
      lotId = `${meta.eventId}-lot${index + 1}`;
      staged = receiveLot(staged.ledger, staged.supply, { ...meta, eventId: `${meta.eventId}-r${index + 1}` }, { id: lotId, item: row.item, unit: row.unit, project: saved, location: row.location }, template.basis, quantity);
    }
    if (shortfall > 0 && vendor !== null) {
      staged = { ...staged, supply: recordRequest(staged.supply, staged.ledger.masters, { ...meta, eventId: `${meta.eventId}-s${index + 1}` },
        { project: saved, item: row.item, unit: row.unit, quantity: shortfall, vendor, requestedOn: requestDateOf(meta), reply: { kind: 'none' } }) };
    }
    rows.push({ lotId, quantity, shortfall });
  }
  return { ledger: staged.ledger, supply: recordTemplateReceipt(staged.ledger, staged.supply, meta, { template, project: saved, sets, vendor, rows,
    ...(routes !== undefined || template.rows.some(row => row.assembly !== undefined) ? { routes: savedRoutes } : {}) }) };
}

// 現在の利用停止状態は過去の構成を無効にしない。構造・精度・受け取り出典の対応を保存境界で検査する。
export function validateReceiptTemplates(ledger: Ledger, supply: Supply): void {
  let templates: Record<string, ReceiptTemplate> = {};
  const knownVersions = new Set<string>();
  const same = (a: ReceiptTemplate | null, b: ReceiptTemplate | null) => JSON.stringify(a) === JSON.stringify(b);
  for (const e of supply.log) {
    if (e.kind === 'receiptTemplateSave') {
      checkReceiptTemplate(e.after, ledger.masters);
      if (e.before !== null) checkReceiptTemplate(e.before, ledger.masters);
      if (!same(own(templates, e.after.id) ?? null, e.before) || (e.before !== null && e.before.id !== e.after.id)) throw new Error('テンプレート変更の旧内容が履歴と一致しない');
      checkImportedRecipeVersions(e.after, e.before ?? undefined, knownVersions, ledger.masters);
      templates = { ...templates, [e.after.id]: e.after };
      knownVersions.add(recipeVersion(e.after, ledger.masters));
    } else if (e.kind === 'receiptTemplateDelete') {
      checkReceiptTemplate(e.before, ledger.masters);
      if (!same(own(templates, e.before.id) ?? null, e.before)) throw new Error('テンプレート削除の旧内容が履歴と一致しない');
      templates = Object.fromEntries(Object.entries(templates).filter(([id]) => id !== e.before.id));
    } else if (e.kind === 'templateReceipt') {
      checkTemplateReceipt(ledger, supply, e);
      if (!same(own(templates, e.template.id) ?? null, e.template)) throw new Error('まとめて受け取りのテンプレートが当時の構成と一致しない');
    }
  }
  for (const [id, template] of Object.entries(supply.receiptTemplates)) {
    checkReceiptTemplate(template, ledger.masters);
    if (id !== template.id || !same(own(templates, id) ?? null, template)) throw new Error('テンプレートの識別・現在値が履歴と一致しない');
  }
  if (Object.keys(templates).length !== Object.keys(supply.receiptTemplates).length) throw new Error('テンプレートの現在値が履歴から欠落している');
}

function checkTemplateReceipt(ledger: Ledger, supply: Supply, e: TemplateReceipt & Meta): void {
  checkProject(ledger.masters, e.project);
  if ('routes' in e && !Array.isArray(e.routes)) throw new Error('受け取り経路は親の各行に対応する配列で記録する');
  if (e.template.rows.some(row => row.assembly !== undefined) && e.routes === undefined) throw new Error('組立受け取りの経路が記録されていない');
  let parts: ExpandedAssemblyRow[];
  try { parts = checkReceiptRows(ledger, e.template, e.sets, e.rows, e.vendor, e.routes); } catch (error) { throw new Error(`まとめて受け取りの明細が不正（${error instanceof Error ? error.message : String(error)}）`); }
  for (const [index, row] of e.rows.entries()) {
    const part = parts[index]!;
    checkShortfallRequest(supply, e, index, part);
    const eventId = `${e.eventId}-r${index + 1}`;
    const creation = ledger.history.find(event => event.eventId === eventId);
    const receipt = supply.log.find(event => event.eventId === `${eventId}-c`);
    if (row.quantity === 0) {
      // 物品IDは別の受け取りでも手入力できるため、この行の派生操作IDで照合する。
      if (row.lotId !== null || creation !== undefined || receipt !== undefined) throw new Error('未受け取り行に保管単位または受け取り記録がある');
      continue;
    }
    if (row.lotId !== `${e.eventId}-lot${index + 1}`) throw new Error('まとめて受け取りの保管単位IDが一致しない');
    // 保管単位は統合しても消えず、品目・単位は変わらない。現在の台帳から消えていれば破損。
    const current = ledger.lots[row.lotId];
    if (!current || current.item !== part.item || current.unit !== part.unit) throw new Error(`まとめて受け取りの保管単位が現在の台帳にない（明細${index + 1}）`);
    const lot = creation?.changes.find(change => change.before === null && change.after.id === row.lotId)?.after;
    const mismatch = (what: string) => new Error(`まとめて受け取りの出典と部品の記録が一致しない（明細${index + 1}の${what}）`);
    if (!lot || creation?.kind !== 'register' || lot.item !== part.item || lot.unit !== part.unit || lot.location !== part.location
      || JSON.stringify(lot.project) !== JSON.stringify(e.project) || lot.quantity.kind !== 'known' || lot.quantity.numeric.value !== row.quantity
      || lot.quantity.terms[0]?.observation.basis !== e.template.basis) throw mismatch('保管単位の登録');
    if (receipt?.kind !== 'receiptRecord' || receipt.lotId !== row.lotId || receipt.received !== row.quantity || receipt.provisional !== (e.template.basis !== 'counted')) throw mismatch('受け取り記録');
    if (receipt.actor !== e.actor || receipt.occurredAt !== e.occurredAt || receipt.recordedAt !== e.recordedAt
      || creation.actor !== e.actor || creation.occurredAt !== e.occurredAt || creation.recordedAt !== e.recordedAt) throw mismatch('担当者・日時');
  }
}

function checkShortfallRequest(supply: Supply, e: TemplateReceipt & Meta, index: number, part: ExpandedAssemblyRow): void {
  const row = e.rows[index]!, eventId = `${e.eventId}-s${index + 1}`;
  const recorded = supply.log.find(event => event.eventId === eventId);
  if (row.shortfall === 0) {
    if (recorded !== undefined || Object.hasOwn(supply.requests, eventId)) throw new Error(`不足のない明細${index + 1}に注文・購入予定の記録がある`);
    return;
  }
  if (recorded?.kind !== 'requestRecord' || recorded.request.id !== eventId || !sameProject(recorded.request.project, e.project)
    || recorded.request.item !== part.item || recorded.request.unit !== part.unit || recorded.request.quantity !== row.shortfall
    || recorded.request.vendor !== e.vendor || recorded.request.requestedOn !== requestDateOf(e)
    || recorded.request.reply.kind !== 'none' || recorded.request.orderConfirmedBy !== null || recorded.request.cancelled !== null || recorded.request.arrivals.length !== 0
    || recorded.actor !== e.actor || recorded.occurredAt !== e.occurredAt || recorded.recordedAt !== e.recordedAt) {
    throw new Error(`まとめて受け取りの不足と注文・購入予定の記録が一致しない（明細${index + 1}）`);
  }
  // 後の回答・注文の確定・取消・到着は依頼の現在値を変えるが、作成時の対象と数量は変えない。
  const current = Object.hasOwn(supply.requests, eventId) ? supply.requests[eventId] : undefined;
  const created = recorded.request;
  if (!current || current.id !== eventId || !sameProject(current.project, created.project) || current.item !== created.item || current.unit !== created.unit
    || current.quantity !== created.quantity || current.vendor !== created.vendor || current.requestedOn !== created.requestedOn) {
    throw new Error(`まとめて受け取りの不足の依頼が現在の記録と一致しない（明細${index + 1}）`);
  }
}
