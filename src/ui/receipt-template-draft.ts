import { parseExactJson } from '../domain/exact-json.ts';
import { normalizeAssemblyRecipe } from '../domain/assembly-recipes.ts';
import type { Masters } from '../domain/masters.ts';
import type { ReceiptRoute, ReceiptTemplate } from '../domain/receipt-template.ts';
import type { Project } from '../domain/ledger.ts';
import { decodeReceiptTemplate } from './storageparse.ts';

export function readPinnedRecipe(raw: string, masters: Masters): ReceiptTemplate {
  return normalizeAssemblyRecipe(decodeReceiptTemplate(parseExactJson(raw)), masters);
}

export function receiptPreviewSignature(template: ReceiptTemplate, project: Project, sets: number, routes: readonly ReceiptRoute[]): string {
  return JSON.stringify({ template, project, sets, routes });
}
