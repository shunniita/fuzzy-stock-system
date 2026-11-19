import { own, processRef } from '../domain/masters.ts';
import { otherOperations, type OperationTarget } from './subject-actions.ts';
import type { UiOp } from './supply-ui.ts';
import { openIssuesOf, type Ledger, type Lot } from '../domain/ledger.ts';
import { groupsOf, requestSummaryOf, shortageOf, stopGroupsOf, stopsOf, type GroupKey } from '../domain/shortage.ts';
import { templateNeedContextOf } from '../domain/template-needs-context.ts';
import { templateNeedProgressOf, type TemplateNeedProgress } from '../domain/template-needs-progress.ts';
import { progressUnitOf, progressUsedText, templateNeedVersionText } from './template-needs-format.ts';
import { needOfGroup, requestProgressOf, sameProject, type Supply } from '../domain/supply.ts';
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
    status: { needed: boolean; short: boolean; undecidable: boolean; outstanding: boolean };
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
      const need = needOfGroup(supply, project, key.item, key.unit);
      const requests = Object.values(supply.requests).filter((r) => sameProject(r.project, project) && r.item === key.item && r.unit === key.unit);
      const declarations = Object.values(supply.declarations).filter((d) => sameProject(d.project, project) && d.item === key.item && d.unit === key.unit);
      const shortage = shortageOf(ledger, supply, key), requestSummary = requestSummaryOf(ledger, supply, key);
      return {
        item: key.item,
        unit: key.unit,
        label: `品目${itemRef(ledger.masters, key.item)}（${key.unit}）`,
        need: need
          ? `必要明細 ${need.id}：必要な数 ${needQuantityText(need.required, key.unit)}、${need.dueDate === null ? '必要日なし' : `必要日 ${need.dueDate}`}、元の資料「${need.source}」・${need.revision}`
          : '必要明細は未登録（必要な数が分からないので、不足は判定不能）',
        outstanding: [
          ...requestStateText(requestSummary, key.unit),
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
          ...shortageLinesText(shortage, key.unit),
          ...declarations.map((d) => `足りない分の記録 ${d.id}：${d.value === null ? '数が不明' : `${d.value}${d.unit}`}（${d.reason}）、${d.linked ? '自動の不足候補に対応付け済み' : '対応付けなし（別の不足として数える）'}`),
        ].join('\n'),
        stops: stopsOf(ledger, key).map((s) => stopLineText(ledger.masters, s)),
        status: {
          needed: need !== undefined,
          short: shortage.shortage !== null && shortage.shortage > 0,
          undecidable: shortage.shortage === null,
          outstanding: requestSummary.outstanding > 0,
        },
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

export type CaseSummary = { needed: number; short: number; undecidable: number; outstanding: number; progress: TemplateNeedProgress | null };

export function caseSummaryOf(detail: CaseDetail, progress: TemplateNeedProgress | null): CaseSummary {
  const count = (flag: StatusFlag) => detail.groups.filter(group => group.status[flag]).length;
  return { needed: count('needed'), short: count('short'), undecidable: count('undecidable'), outstanding: count('outstanding'), progress };
}

export function progressText(progress: TemplateNeedProgress | null, supply: Supply): string {
  if (progress === null) return 'セットからの必要明細なし';
  const version = own(templateNeedContextOf(supply).versions, progress.version);
  const unit = progressUnitOf(progress);
  const head = `セット「${version?.template.name ?? '不明'}」・計算基準の版${version ? templateNeedVersionText(supply, version) : progress.version}・総予定数${progress.total}${unit}`;
  if (progress.used === null) return `${head}・セットに製品がないため数えられない`;
  const remaining = progress.remaining === null ? '不明' : progress.remaining < 0 ? `超過${-progress.remaining}${unit}` : `${progress.remaining}${unit}`;
  return `${head}・作業で使った台数 ${progressUsedText(progress.used, unit)}・未使用の残り${remaining}`;
}

type StatusFlag = keyof CaseDetail['groups'][number]['status'];
const summaryCards: [StatusFlag, string][] = [
  ['needed', '必要明細のある品目'], ['short', '不足ありの品目'], ['undecidable', '不足を判定できない品目'], ['outstanding', '未着の依頼がある品目'],
];

function summaryCard(detail: CaseDetail, summary: CaseSummary, supply: Supply, panel: HTMLElement): HTMLElement {
  const goTo = (flag: StatusFlag) => {
    const group = detail.groups.find(g => g.status[flag]);
    const article = [...panel.querySelectorAll<HTMLElement>('article.group')].find(a => a.dataset['item'] === group?.item && a.dataset['unit'] === group?.unit);
    const heading = article?.querySelector<HTMLElement>('h4');
    heading?.scrollIntoView({ block: 'start' });
    heading?.focus();
  };
  const counts = summaryCards.map(([flag, label]) => {
    const text = `${label} ${summary[flag]}件`;
    if (summary[flag] === 0) return h('li', {}, text);
    const button = h('button', { type: 'button', 'data-summary': flag }, text);
    button.addEventListener('click', () => goTo(flag));
    return h('li', {}, button);
  });
  return h('section', { class: 'case-summary', 'aria-label': '数量カード' }, h('p', { 'data-progress': '' }, progressText(summary.progress, supply)), h('ul', {}, ...counts));
}

export type CaseActions = { ops: Readonly<Record<string, UiOp>>; open: (op: string, target: OperationTarget) => void };

function opButtons(actions: CaseActions, target: OperationTarget, fits: (op: UiOp) => boolean): HTMLButtonElement[] {
  return Object.entries(actions.ops).filter(([, op]) => fits(op)).map(([key, op]) => {
    const node = h('button', { type: 'button', 'data-op': key }, op.label);
    node.addEventListener('click', () => actions.open(key, target));
    return node;
  });
}

export function caseDetailPanel(ledger: Ledger, supply: Supply, projectId: string, openLotDetail: (lotId: string) => void, actions?: CaseActions): HTMLElement {
  const detail = caseDetailOf(ledger, supply, projectId);
  const panel = h('div', { role: 'region', 'aria-label': `${detail.title}の詳細` }, h('h3', {}, detail.title));
  panel.append(summaryCard(detail, caseSummaryOf(detail, templateNeedProgressOf({ ledger, supply }, projectId)), supply, panel));
  const project = own(ledger.masters.cases, projectId);
  const caseButtons = actions === undefined || project === undefined ? [] : opButtons(actions, { kind: 'case', id: projectId }, (op) => op.caseSubject?.accepts(project) === true);
  // 受け取りはセット一式と一つの品目を共有する欄がほとんどないので、一つのフォームで切り替えず入口を二つ並べる。
  const primary = ['templateReceive', 'receive', 'needRegister'], isPrimary = (b: HTMLButtonElement) => primary.includes(b.dataset['op']!);
  if (caseButtons.length > 0) panel.append(h('div', { role: 'group', 'aria-label': 'この案件・用途にできる操作' },
    ...primary.flatMap((key) => caseButtons.filter((b) => b.dataset['op'] === key)),
    otherOperations(caseButtons.filter((b) => !isPrimary(b)))));
  if (detail.groups.length === 0) panel.append(h('p', {}, 'この案件・用途の記録はまだない'));
  const lots = caseLotsOf(ledger, projectId);
  for (const group of detail.groups) {
    const article = h('article', { class: 'group', 'data-item': group.item, 'data-unit': group.unit }, h('h4', { tabindex: '-1' }, group.label));
    const appendLines = (label: string, lines: string[]) => article.append(h('h5', {}, label), h('ul', {}, ...lines.map((line) => h('li', {}, line))));
    appendLines('必要な数', [group.need]);
    const need = needOfGroup(supply, { kind: 'case', id: projectId }, group.item, group.unit);
    if (actions !== undefined && need !== undefined) article.append(...opButtons(actions, { kind: 'need', id: need.id }, (op) => op.subject?.kind === 'need' && op.subject.accepts(need)));
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
