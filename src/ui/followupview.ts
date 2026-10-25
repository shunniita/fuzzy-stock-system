import { openIssuesOf, type Ledger, type Lot } from '../domain/ledger.ts';
import { dateStatusOf, groupsOf, requestSummaryOf, shortageOf, stopGroupsOf, stopsOf, type GroupKey } from '../domain/shortage.ts';
import { checkDate, sameProject, type DateText, type Supply } from '../domain/supply.ts';
import { h } from './dom.ts';
import { issueLabel, itemRef, projectText, quantityText } from './format.ts';
import { judgementText, needQuantityText, replyText, requestDateText, requestHasConflict, requestStateText, stopLineText } from './supply-format.ts';

export type FollowupFlag = '未手配' | '依頼済み' | '納期未回答' | '入荷遅れ' | '返却待ち';
export type FollowupRow = {
  key: GroupKey;
  flags: FollowupFlag[];
  undecided: string[];
  provisional: boolean;
  stops: string[];
};

function inGroup(lot: Lot, key: GroupKey): boolean {
  return sameProject(lot.project, key.project) && lot.item === key.item && lot.unit === key.unit;
}

function returnPendingLotsOf(ledger: Ledger): Lot[] {
  return Object.values(ledger.lots).filter((lot) => {
    if (lot.mergedInto !== null || !lot.holds.includes('returnPending')) return false;
    const q = lot.quantity;
    const certainZero = q.kind === 'known' && q.numeric.value === 0 && !q.numeric.approximate && q.numeric.unconfirmed === 'none' && openIssuesOf(ledger, lot.id).length === 0;
    return !certainZero;
  });
}

export function followupRowsOf(ledger: Ledger, supply: Supply, asOf: DateText): FollowupRow[] {
  checkDate(asOf, '判定日');
  const returns = returnPendingLotsOf(ledger);
  const keys = new Map<string, GroupKey>();
  const add = (key: GroupKey) => keys.set(JSON.stringify([key.project.kind, key.project.kind === 'case' ? key.project.id : null, key.item, key.unit]), key);
  for (const key of groupsOf(ledger, supply)) add(key);
  for (const lot of returns) add({ project: lot.project, item: lot.item, unit: lot.unit });
  for (const key of stopGroupsOf(ledger)) add(key);

  return [...keys.values()].map((key) => {
    const summary = requestSummaryOf(ledger, supply, key);
    const view = shortageOf(ledger, supply, key);
    const flags: FollowupFlag[] = [];
    const undecided: string[] = [];
    if (summary.toOrder !== null && summary.toOrder > 0) flags.push('未手配');
    if (summary.outstanding > 0) flags.push('依頼済み');
    if (view.judgement.kind === 'undecidable') undecided.push(judgementText(view.judgement));
    if (summary.effectiveShortage === null) undecided.push('手配対象数は判定不能：不足が不明（0ではない）');
    for (const o of summary.overAllocated) undecided.push(`過剰割り当て：保管単位${o.receiptLotId}、実際に受け取った数${o.received}に対して割り当て${o.allocated}`);
    for (const p of summary.predatedArrivals) undecided.push(`割り当ての日時が受け取りより前：依頼${p.requestId}の割り当て${p.arrivalId}（保管単位${p.receiptLotId}）`);
    for (const p of summary.predatedRevisions) undecided.push(`実際に受け取った数の訂正の日時が受け取りより前：保管単位${p.receiptLotId}の訂正${p.eventId}`);
    if (summary.tentative) undecided.push(`不足が確定していない：${judgementText(view.judgement)}`);

    let noReply = false;
    let overdue = false;
    for (const r of Object.values(supply.requests)) {
      if (!sameProject(r.project, key.project) || r.item !== key.item || r.unit !== key.unit) continue;
      if (requestHasConflict(r, summary)) {
        undecided.push(`依頼 ${r.id}の納期は確認待ち（この依頼の割り当てに、過剰割り当てまたは日時の食い違いがあるため）`);
        continue;
      }
      const date = dateStatusOf(supply, ledger.masters, r.id, asOf);
      noReply ||= date.noReply;
      overdue ||= date.overdue;
    }
    if (noReply) flags.push('納期未回答');
    if (overdue) flags.push('入荷遅れ');

    const groupReturns = returns.filter((lot) => inGroup(lot, key));
    if (groupReturns.length > 0) flags.push('返却待ち');
    for (const lot of groupReturns) {
      const q = lot.quantity;
      const issues = openIssuesOf(ledger, lot.id);
      if (q.kind !== 'known' || q.numeric.approximate || q.numeric.unconfirmed !== 'none' || issues.length > 0) {
        const issueText = issues.length === 0 ? '' : `・確認が必要：${issues.map((i) => `${i.id}（${issueLabel[i.reason]}）`).join('・')}`;
        undecided.push(`返却待ち：保管単位${lot.id}・${quantityText(q, lot.unit)}${issueText}`);
      }
    }
    return {
      key, flags, undecided, provisional: summary.provisionalReceipts.length > 0,
      stops: stopsOf(ledger, key).map((s) => stopLineText(ledger.masters, s)),
    };
  });
}

function displayOf(row: FollowupRow, ledger: Ledger, supply: Supply, asOf: DateText) {
  const { key } = row;
  const need = Object.values(supply.needs).find((n) => sameProject(n.project, key.project) && n.item === key.item && n.unit === key.unit);
  const summary = requestSummaryOf(ledger, supply, key);
  const requests = Object.values(supply.requests).filter((r) => sameProject(r.project, key.project) && r.item === key.item && r.unit === key.unit);
  return {
    group: `${projectText(ledger.masters, key.project)}・品目${itemRef(ledger.masters, key.item)}（${key.unit}）`,
    need: need ? `必要明細 ${need.id}：${needQuantityText(need.required, key.unit)}、${need.dueDate === null ? '必要日なし' : `必要日${need.dueDate}`}` : '未登録（必要な数が分からないので、不足は判定不能）',
    requests: [
      ...requestStateText(summary, key.unit),
      ...requests.map((r) => r.cancelled !== null
        ? `依頼 ${r.id}：取消済み（理由「${r.cancelled.reason}」）、${r.quantity}${r.unit}・${r.vendor}`
        : `依頼 ${r.id}：${r.quantity}${r.unit}・${r.vendor}・${replyText(r.reply)}・${requestDateText(r, summary, dateStatusOf(supply, ledger.masters, r.id, asOf))}`),
    ].join('\n'),
    state: [
      row.flags.length > 0 ? row.flags.join('・') : row.undecided.length === 0 ? '該当する状態なし' : '状態の判定は確認待ち',
      ...row.undecided,
      ...(row.provisional ? ['仮の割当を含む'] : []),
    ].join('\n'),
    stops: row.stops.length === 0 ? '記録なし' : row.stops.join('\n'),
  };
}

export function followupText(ledger: Ledger, supply: Supply, asOf: DateText): string {
  const rows = followupRowsOf(ledger, supply, asOf);
  if (rows.length === 0) return '未着・不足・対応一覧の記録はまだない';
  return rows.map((row) => {
    const display = displayOf(row, ledger, supply, asOf);
    return [display.group, `必要な数：${display.need}`, `未着・依頼：\n${display.requests}`, `状態・判定：\n${display.state}`, `その不足で止まっている作業：\n${display.stops}`].join('\n');
  }).join('\n\n');
}

export function followupPanel(ledger: Ledger, supply: Supply, asOf: DateText): HTMLElement {
  const panel = h('div', { role: 'region', 'aria-label': '未着・不足・対応一覧' });
  const rows = followupRowsOf(ledger, supply, asOf);
  if (rows.length === 0) {
    panel.append(h('p', {}, '未着・不足・対応一覧の記録はまだない'));
    return panel;
  }
  const body = h('tbody');
  for (const row of rows) {
    const display = displayOf(row, ledger, supply, asOf);
    body.append(h('tr', { 'data-item': row.key.item, 'data-unit': row.key.unit },
      ...[display.group, display.need, display.requests, display.state, display.stops].map((cell) => h('td', {}, ...cell.split('\n').map((line) => h('p', {}, line)))),
    ));
  }
  panel.append(h('table', {},
    h('caption', {}, `未着・不足・対応一覧（判定日${asOf}）`),
    h('thead', {}, h('tr', {}, ...['案件・用途・品目・単位', '必要な数', '未着・依頼', '状態・判定', 'その不足で止まっている作業'].map((label) => h('th', { scope: 'col' }, label)))),
    body,
  ));
  return panel;
}
