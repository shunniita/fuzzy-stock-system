import { own, quantityStepOf, type Masters } from './masters.ts';
import type { ReceiptRoute, ReceiptTemplate, ReceiptTemplateRow } from './receipt-template.ts';
import { multiplyScalarByInteger, validateScalar } from './scalar.ts';

export const assemblyRecipeRowLimit = 50;
export const assemblyRecipeTreeRowLimit = 500;
export type ExpandedAssemblyRow = Omit<ReceiptTemplateRow, 'assembly'> & { parentIndex: number; childIndex: number | null; planned: number };

// 深さと件数を先に制限する。循環した入力をコピーやJSON比較へ渡さない。
function boundedRecipes(template: ReceiptTemplate): ReceiptTemplate[] {
  const recipes = [template];
  let total = template.rows.length;
  checkRowCount(template);
  for (const row of template.rows) {
    if (!('assembly' in row)) continue;
    const child = row.assembly;
    if (!child) throw new Error('取り込む子の構成がない');
    checkRowCount(child);
    total += child.rows.length;
    if (total > assemblyRecipeTreeRowLimit) throw new Error(`全構成は${assemblyRecipeTreeRowLimit}行以下にする`);
    if (child.rows.some(part => 'assembly' in part)) throw new Error('構成の高さは2以下にする');
    recipes.push(child);
  }
  return recipes;
}

function checkRowCount(template: ReceiptTemplate): void {
  if (!Array.isArray(template.rows) || template.rows.length < 1 || template.rows.length > assemblyRecipeRowLimit) throw new Error(`明細は1〜${assemblyRecipeRowLimit}行にする`);
}

function checkRecipeFields(template: ReceiptTemplate, masters: Masters): void {
  if (!template.id.trim() || template.id.length > 120 || !template.name.trim() || template.name.length > 120) throw new Error('テンプレートの識別と名前は1〜120文字にする');
  if (!['counted', 'label', 'approximate'].includes(template.basis)) throw new Error('テンプレートの数量根拠を選ぶ（数が不明な場合は構成に使えない）');
  if (template.project?.kind === 'case' && !own(masters.cases, template.project.id)) throw new Error('案件・用途は登録済みのものを選ぶ');
  const product = template.product === null ? undefined : own(masters.items, template.product);
  if (template.product !== null && !product) throw new Error('製品の品目は登録済みのものを選ぶ');
  if ('productUnit' in template && (typeof template.productUnit !== 'string' || !product?.units.includes(template.productUnit))) throw new Error('製品の単位は製品の登録済み単位を宣言する');
}

function checkPart(row: ReceiptTemplateRow, masters: Masters, ancestors: readonly (string | null)[]): void {
  const item = own(masters.items, row.item);
  if (!item || !item.units.includes(row.unit)) throw new Error(`品目 ${row.item}・単位 ${row.unit} が登録されていない`);
  if (!own(masters.locations, row.location)) throw new Error(`場所 ${row.location} が登録されていない`);
  validateScalar(row.perSet, quantityStepOf(masters, row.item, row.unit));
  if (row.perSet <= 0) throw new Error('製品1個あたりの数量は正数にする');
  if (ancestors.includes(row.item)) throw new Error('自己または祖先の製品を材料にする構成は保存できない');
}

export function checkAssemblyRecipe(template: ReceiptTemplate, masters: Masters, options: { allowLegacySelfReference?: boolean } = {}): void {
  const recipes = boundedRecipes(template);
  for (const recipe of recipes) checkRecipeFields(recipe, masters);
  const hasAssembly = recipes.length > 1;
  if (hasAssembly && template.productUnit === undefined) throw new Error('組立構成の製品単位を宣言する');
  const legacy = options.allowLegacySelfReference !== false && !('productUnit' in template) && !hasAssembly;
  for (const row of template.rows) {
    checkPart(row, masters, legacy ? [] : [template.product]);
    if (row.assembly === undefined) continue;
    const child = row.assembly;
    if (child.id === template.id) throw new Error('祖先のセットIDを子に繰り返すことはできない');
    if (child.product !== row.item) throw new Error('子セットの製品は親行の品目と一致させる');
    if (child.productUnit === undefined || child.productUnit !== row.unit) throw new Error('子セットの製品単位を宣言し、親行の単位と一致させる');
    if (!Number.isSafeInteger(row.perSet)) throw new Error('組立品の親あたり数量は正の安全な整数にする');
    for (const part of child.rows) checkPart(part, masters, [template.product, child.product]);
  }
}

function copyRecipe(template: ReceiptTemplate): ReceiptTemplate {
  return { id: template.id, name: template.name, product: template.product,
    ...(template.productUnit === undefined ? {} : { productUnit: template.productUnit }),
    project: template.project === null ? null : template.project.kind === 'case' ? { kind: 'case', id: template.project.id } : { kind: template.project.kind },
    basis: template.basis, rows: template.rows.map(row => ({ item: row.item, unit: row.unit, perSet: row.perSet, location: row.location,
      ...(row.assembly === undefined ? {} : { assembly: copyRecipe(row.assembly) }) })) };
}

// 新たな保存では自己参照を拒否する。既知版の比較時だけ旧平面の読込規則を明示できる。
export function normalizeAssemblyRecipe(template: ReceiptTemplate, masters: Masters, options: { allowLegacySelfReference: boolean } = { allowLegacySelfReference: false }): ReceiptTemplate {
  checkAssemblyRecipe(template, masters, options);
  return copyRecipe(template);
}

export function defaultAssemblyRoutes(template: ReceiptTemplate): ReceiptRoute[] {
  boundedRecipes(template);
  return template.rows.map(() => 'assembled');
}

// 画面の初期経路は組立済み。記録済み受け取りの経路欠落は呼出側で拒否する。
export function expandAssemblyRecipe(masters: Masters, template: ReceiptTemplate, sets: number, routes: readonly ReceiptRoute[] = defaultAssemblyRoutes(template)): ExpandedAssemblyRow[] {
  if (!Number.isSafeInteger(sets) || sets <= 0) throw new Error('個数は正の安全な整数にする');
  checkAssemblyRecipe(template, masters);
  if (routes.length !== template.rows.length) throw new Error('経路と親セットの明細数が異なる');
  return template.rows.flatMap((row, parentIndex) => {
    const route = routes[parentIndex];
    if (route === 'assembled') return [expandedRow(masters, row, 1, sets, parentIndex, null)];
    if (route !== 'parts' || row.assembly === undefined) throw new Error('自作分の部品には取り込み済み構成と有効な経路が必要');
    return row.assembly.rows.map((part, childIndex) => expandedRow(masters, part, row.perSet, sets, parentIndex, childIndex));
  });
}

function expandedRow(masters: Masters, row: ReceiptTemplateRow, multiplier: number, sets: number, parentIndex: number, childIndex: number | null): ExpandedAssemblyRow {
  const step = quantityStepOf(masters, row.item, row.unit);
  const perSet = multiplyScalarByInteger(row.perSet, multiplier, step);
  return { item: row.item, unit: row.unit, perSet, location: row.location, parentIndex, childIndex, planned: multiplyScalarByInteger(perSet, sets, step) };
}

export function assemblyItemIds(template: ReceiptTemplate): string[] {
  const ids = new Set<string>();
  for (const recipe of boundedRecipes(template)) {
    if (recipe.product !== null) ids.add(recipe.product);
    for (const row of recipe.rows) ids.add(row.item);
  }
  return [...ids];
}
