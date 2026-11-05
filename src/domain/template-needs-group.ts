import type { Supply } from './supply.ts';

export type TemplateNeedGroup = { assemblyIndex: 0 } & ({ mode: 'same'; split: null } | { mode: 'split'; split: number });
export const templateNeedProjectLimit = 20;

function positiveCount(count: number): void {
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error('台数・分割単位は正の安全な整数にする');
}

export function checkTemplateNeedGroup(counts: readonly number[], group: TemplateNeedGroup | null): void {
  if (counts.length < 1 || counts.length > templateNeedProjectLimit) throw new Error(`組立用を含め一回${templateNeedProjectLimit}案件以下にする。分割台数を増やすか検査用の案件数を減らす`);
  counts.forEach(positiveCount);
  if (group === null) { if (counts.length !== 1) throw new Error('単独生成は1案件にする'); return; }
  if (group.assemblyIndex !== 0 || counts.length < 2) throw new Error('組立用1案件と検査用1案件以上を指定する');
  if (group.mode === 'same') {
    if (group.split !== null || counts.length !== 2 || counts[0] !== counts[1]) throw new Error('同数方式は検査用1案件を組立用と同じ台数にする');
  } else {
    positiveCount(group.split);
    const difference = counts.slice(1).reduce((total, count) => total + BigInt(count), 0n) - BigInt(counts[0]!);
    if (difference !== 0n) throw new Error(`検査用と組立用の台数の差は${difference}台。合計を一致させる`);
  }
}

export function defaultTemplateNeedSplit(supply: Supply): number {
  for (let index = supply.log.length - 1; index >= 0; index--) {
    const event = supply.log[index]!;
    if (event.kind === 'templateNeeds' && event.action === 'generate' && event.group?.mode === 'split') return event.group.split;
  }
  return 20;
}

export function proposeTemplateNeedSplit(count: number, split: number): number[] {
  positiveCount(count); positiveCount(split);
  const rows = (BigInt(count) + BigInt(split) - 1n) / BigInt(split);
  if (rows > BigInt(templateNeedProjectLimit - 1)) throw new Error(`組立用を含め一回${templateNeedProjectLimit}案件以下にする。分割台数を増やす`);
  return Array.from({ length: Number(rows) }, (_, index) => index === Number(rows) - 1 ? count - split * index : split);
}
