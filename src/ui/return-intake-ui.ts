import { beginReturnedRework, openIssues, recordProvisional } from '../domain/ledger.ts';
import { assignReturnedProvisional, type ReturnAssignment } from '../domain/return-intake.ts';
import { checkField, choiceField, h, selectField, textField } from './dom.ts';
import { amount, amountFields, codeTarget, itemFields, itemOptions, lotOptions, placeOptions, projectField, projectOf } from './fields.ts';
import { eventText, holdLabel, itemRef, quantityText } from './format.ts';
import type { Ctx, UiOp } from './supply-ui.ts';

function assignmentFields(ctx: Ctx): HTMLElement[] {
  const l = ctx.ledger();
  const issues = openIssues(l).flatMap(issue => {
    const origin = l.history.find(e => e.eventId === issue.id);
    return issue.reason === 'unassigned' && origin?.kind === 'provisional' && origin.direction === 'found'
      ? [[issue.id, `${issue.id}：${eventText(l, origin)}`] as [string, string]] : [];
  });
  const inclusion = choiceField('returnInclusion', '返ってきた物は現在の記録上の数に含まれているか', [
    ['included', '現在の記録上の数に含まれている（数量は足さない）'],
    ['notIncluded', '現在の記録上の数に含まれていない（新しく登録する）'],
  ]);
  const included = h('div', {}, choiceField('lot', '数量に含まれる保管単位', lotOptions(l)));
  const location = choiceField('location', '返ってきた物を置く場所', placeOptions(l.masters));
  location.querySelector('select')!.dataset['placeTime'] = 'fixed';
  const separate = h('div', {}, textField('newId', '返ってきた物の新しい保管単位のID'), ...itemFields(l.masters), projectField(l.masters), location);
  const sync = () => {
    for (const [node, kind] of [[included, 'included'], [separate, 'notIncluded']] as const) {
      const active = inclusion.querySelector('select')!.value === kind;
      node.hidden = !active;
      for (const control of node.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select')) {
        control.disabled = !active;
      }
    }
  };
  inclusion.addEventListener('change', sync);
  sync();
  return [choiceField('issue', '返ってきた物の仮の記録（見つかった物）', issues), inclusion, included, separate, textField('reason', '現在数量への包含を確認した理由'),
    h('p', {}, '元の現物が同じかどうかだけで選ばない。出庫で台帳から減った分が戻った場合は「含まれていない」。新規登録は使用可否確認待ち・作業なしとなり、やり直し・修理開始や出庫取消にはならない。')];
}

export function returnIntakeOps(ctx: Ctx): Record<string, UiOp> {
  return {
    returnRework: {
      label: '返ってきた物のやり直し・修理を開始',
      fields: () => {
        const l = ctx.ledger();
        const candidates = l.history.flatMap(e => {
          const lot = e.kind === 'adopt' ? l.lots[e.lotId] : undefined;
          return lot && lot.stage.kind === 'none' && lot.mergedInto === null && lot.splitFrom === null
            ? [[lot.id, `${lot.id}：${itemRef(l.masters, lot.item)} ${quantityText(lot.quantity, lot.unit)}／${lot.holds.map(r => holdLabel[r]).join('・') || '除外なし'}／新規割当の記録${e.eventId}`] as [string, string]] : [];
        });
        const physical = checkField('confirmedPhysical', 'この返ってきた物の新しい物理的なやり直し・修理を開始する');
        physical.querySelector('input')!.dataset['receiptConfirm'] = '';
        return [codeTarget(choiceField('lot', '返ってきた物と新規割当の記録', candidates), 'lot'),
          textField('process', 'やり直し・修理の工程ID'), choiceField('criterion', '工程の完了基準', [['workEnd', '作業終了'], ['inspection', '確認の完了']]),
          textField('childId', 'やり直し・修理分の新しいID'), ...amountFields(), textField('reason', 'やり直し・修理の理由'), physical,
          h('p', {}, '直接新規割当した作業をしていない現物だけを対象とする。工程・完了基準を選び、今回の物理作業を確認する。使用可否確認待ちは引き継ぎ、元の製造個体の自動特定や修理権限の認定はしない。')];
      },
      run: (s, m, v, inc) => {
        const adopted = s.ledger.history.find(e => e.kind === 'adopt' && e.lotId === v.text('lot'));
        if (!adopted) throw new Error('返ってきた物と新規割当の記録を選ぶ');
        const criterion = v.text('criterion');
        if (criterion !== 'workEnd' && criterion !== 'inspection') throw new Error('工程の完了基準を選ぶ');
        const { basis, value } = amount(v);
        return { state: { ...s, ledger: beginReturnedRework(s.ledger, m, { lotId: v.text('lot'), adoptEventId: adopted.eventId,
          childId: v.text('childId'), process: { id: v.text('process'), criterion }, basis, value, reason: v.text('reason'), confirmedPhysical: v.checked('confirmedPhysical') }, inc) } };
      },
    },
    returnRecord: {
      label: '返ってきた物を仮の記録に残す（まだ数量へ反映しない）',
      fields: () => [codeTarget(selectField('item', '返ってきた物の品目', [['', '不明'], ...itemOptions(ctx.ledger().masters)]), 'item'),
        codeTarget(selectField('location', '返ってきた物がある場所', [['', '不明'], ...placeOptions(ctx.ledger().masters)]), 'location'), ...amountFields(),
        textField('returnOrigin', '元の現物の手掛かり（ID・出庫記録など。不明なら空欄）'), textField('note', '返ってきた物の備考'),
        h('p', {}, '外から戻った物や元の現物が不明な返ってきた物を、未反映の仮の記録として受け付ける。既知品目の使用可能数には加えない。後で「返ってきた物の仮の記録を割り当てる（現在数量への包含を確認）」から現在数量への包含を確認する。')],
      run: (s, m, v) => {
        const { basis, value } = amount(v);
        const note = `戻り品／元の現物の手掛かり：${v.text('returnOrigin').trim() || '不明'}／備考：${v.text('note')}`;
        return { state: { ...s, ledger: recordProvisional(s.ledger, m, { direction: 'found', item: v.text('item') || null, location: v.text('location') || null, basis, value, note }) } };
      },
    },
    returnAssign: {
      label: '返ってきた物の仮の記録を割り当てる（現在数量への包含を確認）',
      fields: () => assignmentFields(ctx),
      run: (s, m, v) => {
        const common = { issueId: v.text('issue'), reason: v.text('reason'), confirmed: v.checked('confirmed') };
        const kind = v.text('returnInclusion');
        if (kind !== 'included' && kind !== 'notIncluded') throw new Error('返ってきた物が現在の記録上の数に含まれているかを選ぶ');
        const request: ReturnAssignment = kind === 'included'
          ? { ...common, kind, lotId: v.text('lot') }
          : { ...common, kind, lot: { id: v.text('newId'), item: v.text('item'), unit: v.text('unit'), project: projectOf(v), location: v.text('location') } };
        return { state: { ...s, ledger: assignReturnedProvisional(s.ledger, m, request) } };
      },
    },
  };
}
