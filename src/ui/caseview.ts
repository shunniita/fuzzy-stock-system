import { processRef } from '../domain/masters.ts';
import { openIssuesOf, type Ledger, type Lot } from '../domain/ledger.ts';
import { groupsOf, requestSummaryOf, shortageOf, stopGroupsOf, stopsOf, type GroupKey } from '../domain/shortage.ts';
import { requestProgressOf, sameProject, type Supply } from '../domain/supply.ts';
import { h } from './dom.ts';
import { holdLabel, issueLabel, itemRef, locationRef, projectText, quantityText, stageText } from './format.ts';
import { needQuantityText, replyText, requestStateText, shortageLinesText, stopLineText } from './supply-format.ts';

export type CaseDetail = {
  project: string;
  title: string;
  groups: {
    item: string; unit: string; label: string;
    need: string;
    outstanding: string;
    unused: string[];
    working: string[];
    completed: string[];
    shortage: string;
    stops: string[];
  }[];
};

function caseLotsOf(ledger: Ledger, projectId: string): Lot[] {
  return Object.values(ledger.lots).filter((lot) => lot.mergedInto === null && sameProject(lot.project, { kind: 'case', id: projectId }));
}

function lotText(ledger: Ledger, lot: Lot): string {
  const issues = openIssuesOf(ledger, lot.id);
  return [
    `保管単位${lot.id}`, `所在${locationRef(ledger.masters, lot.location)}`, quantityText(lot.quantity, lot.unit), stageText(lot.stage, id => processRef(ledger.masters, id)),
    lot.holds.length > 0 ? `取り分けた理由：${lot.holds.map((r) => holdLabel[r]).join('・')}` : null,
    issues.length > 0 ? `確認が必要：${issues.map((i) => `${i.id}（${issueLabel[i.reason]}）`).join('・')}` : null,
  ].filter((line) => line !== null).join('・');
}

export function caseDetailOf(ledger: Ledger, supply: Supply, projectId: string): CaseDetail {
  const project = { kind: 'case', id: projectId } satisfies GroupKey['project'];
  const lots = caseLotsOf(ledger, projectId);
  const keys = new Map<string, GroupKey>();
  const add = (item: string, unit: string) => keys.set(JSON.stringify([item, unit]), { project, item, unit });
  for (const key of groupsOf(ledger, supply)) if (sameProject(key.project, project)) add(key.item, key.unit);
  for (const lot of lots) add(lot.item, lot.unit);
  for (const key of stopGroupsOf(ledger)) if (sameProject(key.project, project)) add(key.item, key.unit);

  return {
    project: projectId,
    title: projectText(ledger.masters, project),
    groups: [...keys.values()].map((key) => {
      const groupLots = lots.filter((lot) => lot.item === key.item && lot.unit === key.unit);
      const need = Object.values(supply.needs).find((n) => n.project.id === projectId && n.item === key.item && n.unit === key.unit);
      const requests = Object.values(supply.requests).filter((r) => sameProject(r.project, project) && r.item === key.item && r.unit === key.unit);
      const declarations = Object.values(supply.declarations).filter((d) => sameProject(d.project, project) && d.item === key.item && d.unit === key.unit);
      return {
        item: key.item,
        unit: key.unit,
        label: `品目${itemRef(ledger.masters, key.item)}（${key.unit}）`,
        need: need
          ? `必要明細 ${need.id}：必要な数 ${needQuantityText(need.required, key.unit)}、${need.dueDate === null ? '必要日なし' : `必要日 ${need.dueDate}`}、元の資料「${need.source}」・${need.revision}`
          : '必要明細は未登録（必要な数が分からないので、不足は判定不能）',
        outstanding: [
          ...requestStateText(requestSummaryOf(ledger, supply, key), key.unit),
          ...requests.map((r) => {
            const { arrived, outstanding } = requestProgressOf(ledger.masters, r);
            return r.cancelled !== null
              ? `依頼 ${r.id}：取消済み（理由「${r.cancelled.reason}」）。${r.quantity}${r.unit}・${r.vendor}`
              : `依頼 ${r.id}：${r.quantity}${r.unit}・${r.vendor}・依頼日${r.requestedOn}・${replyText(r.reply)}・${r.orderConfirmedBy === null ? '注文の確定なし' : '注文の確定済み'}・到着${arrived}${r.unit}・未着${outstanding}${r.unit}`;
          }),
        ].join('\n'),
        unused: groupLots.filter((lot) => lot.stage.kind === 'none').map((lot) => lotText(ledger, lot)),
        working: groupLots.filter((lot) => lot.stage.kind === 'working' || lot.stage.kind === 'inspecting').map((lot) => lotText(ledger, lot)),
        completed: groupLots.filter((lot) => lot.stage.kind === 'awaitingHandover').map((lot) => lotText(ledger, lot)),
        shortage: [
          ...shortageLinesText(shortageOf(ledger, supply, key), key.unit),
          ...declarations.map((d) => `足りない分の記録 ${d.id}：${d.value === null ? '数が不明' : `${d.value}${d.unit}`}（${d.reason}）、${d.linked ? '自動の不足候補に対応付け済み' : '対応付けなし（別の不足として数える）'}`),
        ].join('\n'),
        stops: stopsOf(ledger, key).map((s) => stopLineText(ledger.masters, s)),
      };
    }),
  };
}

export function caseDetailText(detail: CaseDetail): string {
  return [
    detail.title,
    ...(detail.groups.length === 0 ? ['この案件・用途の必要明細・申告・依頼・現物・不足に関連する作業の中断の記録はまだない'] : []),
    ...detail.groups.flatMap((group) => [
      group.label,
      `必要な数：${group.need}`,
      `未着・依頼：\n${group.outstanding}`,
      `未使用の部品：\n${group.unused.length === 0 ? 'なし' : group.unused.join('\n')}`,
      `仕掛品：\n${group.working.length === 0 ? 'なし' : group.working.join('\n')}`,
      `工程完了品：\n${group.completed.length === 0 ? 'なし' : group.completed.join('\n')}`,
      `不足と判定：\n${group.shortage}`,
      `その不足で止まっている作業：\n${group.stops.length === 0 ? '記録なし' : group.stops.join('\n')}`,
    ]),
  ].join('\n');
}

export function caseDetailPanel(ledger: Ledger, supply: Supply, projectId: string, openLotDetail: (lotId: string) => void): HTMLElement {
  const detail = caseDetailOf(ledger, supply, projectId);
  const panel = h('div', { role: 'region', 'aria-label': `${detail.title}の詳細` }, h('h3', {}, detail.title));
  if (detail.groups.length === 0) panel.append(h('p', {}, 'この案件・用途の記録はまだない'));
  const lots = caseLotsOf(ledger, projectId);
  for (const group of detail.groups) {
    const article = h('article', { class: 'group', 'data-item': group.item, 'data-unit': group.unit }, h('h4', {}, group.label));
    const appendLines = (label: string, lines: string[]) => article.append(h('h5', {}, label), h('ul', {}, ...lines.map((line) => h('li', {}, line))));
    appendLines('必要な数', [group.need]);
    appendLines('未着・依頼', group.outstanding.split('\n'));
    const groupLots = lots.filter((lot) => lot.item === group.item && lot.unit === group.unit);
    for (const [label, selected] of [
      ['未使用の部品', groupLots.filter((lot) => lot.stage.kind === 'none')],
      ['仕掛品', groupLots.filter((lot) => lot.stage.kind === 'working' || lot.stage.kind === 'inspecting')],
      ['工程完了品', groupLots.filter((lot) => lot.stage.kind === 'awaitingHandover')],
    ] satisfies [string, Lot[]][]) {
      const list = h('ul');
      for (const lot of selected) {
        const button = h('button', { type: 'button', 'data-lot': lot.id }, '保管単位の詳細');
        button.addEventListener('click', () => openLotDetail(lot.id));
        list.append(h('li', {}, lotText(ledger, lot), ' ', button));
      }
      if (selected.length === 0) list.append(h('li', {}, 'なし'));
      article.append(h('h5', {}, label), list);
    }
    appendLines('不足と判定', group.shortage.split('\n'));
    appendLines('その不足で止まっている作業', group.stops.length === 0 ? ['記録なし'] : group.stops);
    panel.append(article);
  }
  return panel;
}
