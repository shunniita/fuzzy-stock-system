import {
  adoptProvisional,
  assignProject,
  changeMasters,
  identifyProvisional,
  openIssues,
  type Ledger,
  type MasterRequest,
  type NewMaster,
} from '../domain/ledger.ts';
import { masterTypeDisplayLabel, unassignedCode, type Master, type Masters, type Source } from '../domain/masters.ts';
import type { Supply } from '../domain/supply.ts';
import { requestProgressOf } from '../domain/supply.ts';
import { checkField, choiceField, h, selectField, textField, type Values } from './dom.ts';
import { codeTarget, itemFields, lotOptions, placeOptions, projectField, projectKey, projectOf, projectsOf } from './fields.ts';
import type { Step } from '../domain/scalar.ts';
import { caseRef, eventText, itemRef, jst, locationRef, projectText, quantityText } from './format.ts';
import type { Ctx, UiOp } from './supply-ui.ts';

// 確認が要る操作は、画面の「確認した」の欄を読む。

function masterLabel(masters: Masters, m: Master): string {
  switch (m.type) {
    case 'item': return `品目${itemRef(masters, m.id)}「${m.name}」`;
    case 'location': return `場所${locationRef(masters, m.id)}「${m.name}」`;
    case 'case': return `案件・用途${caseRef(masters, m.id)}${m.name === null ? '' : `「${m.name}」`}`;
    case 'actor': return `担当者「${m.id}」${m.active ? '' : '（利用停止）'}`;
  }
}

// 登録情報の操作の対象は、利用停止と仮も含めて全部出す（要件3.5）。値は「種類:内部の識別」。
function targetField(masters: Masters, types: readonly Master['type'][]): HTMLLabelElement {
  const groups = { item: masters.items, location: masters.locations, case: masters.cases, actor: masters.actors };
  const options = types.flatMap((type) => Object.values(groups[type] as Readonly<Record<string, Master>>).map((m): [string, string] => [`${type}:${m.id}`, masterLabel(masters, m)]));
  return choiceField('target', '対象の登録情報', options);
}

function targetOf<T extends Master['type']>(v: Values, types: readonly T[]): { type: T; id: string } {
  const raw = v.text('target');
  const at = raw.indexOf(':');
  const type = raw.slice(0, at) as T;
  if (at < 0 || !types.includes(type)) throw new Error('対象の登録情報を選ぶ');
  return { type, id: raw.slice(at + 1) };
}

const codeFields = (label: string) => [textField('code', label), checkField('codeNone', unassignedCode)];
const codeOf = (v: Values): string | null => (v.checked('codeNone') ? null : v.text('code'));
const sourceFields = () => [textField('sourceName', '元の資料の名称（なければ空欄）'), textField('sourceRevision', '元の資料の版（なければ空欄）')];
const reasonField = () => textField('reason', '理由');

function sourceOf(v: Values): Source | null {
  const name = v.text('sourceName');
  const revision = v.text('sourceRevision');
  return name === '' && revision === '' ? null : { name, revision };
}

const masterOp = (label: string, fields: (masters: Masters) => HTMLElement[], request: (v: Values) => MasterRequest, ctx: Ctx): UiOp => ({
  label: `登録情報：${label}`,
  fields: () => fields(ctx.ledger().masters),
  run: (s, m, v) => ({ state: { ...s, ledger: changeMasters(s.ledger, m, request(v), v.checked('confirmed')) } }),
});

// Number()は0x10・0b11・1e1も整数にしてしまうので、十進の数字だけを1箱あたりの数として読む。
function perBoxOf(raw: string): number {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) throw new Error('1箱あたりの数は1以上の整数にする');
  return Number(text);
}

const unitsOf = (text: string): string[] => text.split(/[、,]/).map((u) => u.trim());
const unitStepName = (unit: string): string => `unitStep-${unit}`;

// 選んだ最小単位は単位名に結び付けて覚え、単位の欄で削除・並べ替えをしても別の単位へ移さない。
function unitStepFields(): HTMLElement[] {
  const units = textField('units', '単位（複数は「、」で区切る）');
  const input = units.querySelector('input')!;
  const chosen = new Map<string, string>();
  const box = h('fieldset', {}, h('legend', {}, '単位ごとの最小単位（登録後は変えられない）'));
  input.addEventListener('input', () => {
    for (const select of box.querySelectorAll('select')) chosen.set(select.dataset['unit']!, select.value);
    const names = [...new Set(unitsOf(input.value))].filter((u) => u !== '');
    box.replaceChildren(box.firstElementChild!, ...names.map((u) => {
      const node = selectField(unitStepName(u), `${u}の最小単位`, [['1', '1（整数）'], ['0.1', '0.1']], chosen.get(u) ?? '1');
      node.querySelector('select')!.dataset['unit'] = u;
      return node;
    }));
  });
  return [units, box];
}

const register = (master: (v: Values) => NewMaster) => (v: Values): MasterRequest => ({ action: 'register', master: master(v) });

// 見つかった物の未解消の仮の記録だけが対応付けの対象（要件8.1・8.8）。
function foundIssueField(ledger: Ledger): HTMLLabelElement {
  const options = openIssues(ledger).flatMap((i): [string, string][] => {
    const origin = ledger.history.find((e) => e.eventId === i.id);
    return i.reason === 'unassigned' && origin?.kind === 'provisional' && origin.direction === 'found' ? [[i.id, `${i.id}：${eventText(ledger, origin)}`]] : [];
  });
  return choiceField('issue', '見つかった物の仮の記録', options);
}

// 仮の記録からの登録は、入力欄の実際の日時でなく仮の記録の時点で場所の記録の対象を判断するので、画面は場所を絞らない。
function fixedPlaceTime(node: HTMLLabelElement): HTMLLabelElement {
  node.querySelector('select')!.dataset['placeTime'] = 'fixed';
  return node;
}

export function masterOps(ctx: Ctx): Record<string, UiOp> {
  const all = ['item', 'location', 'case', 'actor'] as const;
  const coded = ['item', 'location', 'case'] as const;
  return {
    masterItem: masterOp('品目の登録', () => [...codeFields('品番・コード（文字列のまま保存）'), textField('name', '呼び名'), ...unitStepFields(), ...sourceFields()],
      register((v) => {
        const units = unitsOf(v.text('units'));
        const unitSteps = Object.fromEntries(units.map((u): [string, Step] => [u, v.text(unitStepName(u)) === '0.1' ? 0.1 : 1]));
        return { type: 'item', code: codeOf(v), name: v.text('name'), units, unitSteps, trial: true, source: sourceOf(v) };
      }), ctx),
    masterLocation: masterOp('場所の登録', () => [textField('code', '品番・コード（文字列のまま保存）'), textField('name', '名称'), choiceField('inScope', '記録の対象', [['true', '記録の対象'], ['false', '記録の対象外']])],
      register((v) => ({ type: 'location', code: v.text('code'), name: v.text('name'), trial: true, inScope: v.text('inScope') === 'true' })), ctx),
    masterCase: masterOp('案件・用途の登録', () => [...codeFields('品番・コード（文字列のまま保存）'), textField('name', '呼び名（品番・コードがあれば空欄でもよい）'), ...sourceFields()],
      register((v) => ({ type: 'case', code: codeOf(v), name: v.text('name') === '' ? null : v.text('name'), source: sourceOf(v) })), ctx),
    masterActor: masterOp('担当者の登録', () => [textField('name', '担当者の名前')], register((v) => ({ type: 'actor', name: v.text('name') })), ctx),
    masterRename: masterOp('名称の変更', (ms) => [targetField(ms, coded), textField('name', '新しい名称'), reasonField()],
      (v) => ({ action: 'rename', ...targetOf(v, coded), name: v.text('name'), reason: v.text('reason') }), ctx),
    masterDeactivate: masterOp('利用停止（過去の記録は消さない）', (ms) => [targetField(ms, all), reasonField()],
      (v) => ({ action: 'deactivate', ...targetOf(v, all), reason: v.text('reason') }), ctx),
    masterReactivate: masterOp('利用の再開', (ms) => [targetField(ms, all), reasonField()],
      (v) => ({ action: 'reactivate', ...targetOf(v, all), reason: v.text('reason') }), ctx),
    masterCode: masterOp('品番・コードの変更・付与（仮の正式化を含む）', (ms) => [targetField(ms, coded), textField('code', '新しい品番・コード'), reasonField()],
      (v) => ({ action: 'code', ...targetOf(v, coded), code: v.text('code'), reason: v.text('reason') }), ctx),
    masterSource: masterOp('元の資料の更新（呼び名は変えない）', () => [choiceField('type', '種類', [['item', '品目'], ['case', '案件・用途']]), textField('code', '品番・コード'), textField('sourceName', '元の資料の名称'), textField('sourceRevision', '元の資料の版')],
      (v) => ({ action: 'source', type: v.text('type') === 'case' ? 'case' : 'item', code: v.text('code'), source: { name: v.text('sourceName'), revision: v.text('sourceRevision') } }), ctx),
    masterPerBox: masterOp('1箱あたりの数の変更（実際の日時を適用時点にする）', (ms) => [choiceField('target', '品目', Object.values(ms.items).filter((i) => i.packaging !== null).map((i) => [`item:${i.id}`, masterLabel(ms, i)])), textField('perBox', '新しい1箱あたりの数', 'integer'), reasonField()],
      (v) => ({ action: 'perBox', id: targetOf(v, ['item']).id, value: perBoxOf(v.text('perBox')), reason: v.text('reason') }), ctx),
    masterScope: masterOp('記録の対象の変更（実際の日時を適用時点にする）', (ms) => [targetField(ms, ['location']), choiceField('inScope', '変更後', [['false', '記録の対象外'], ['true', '記録の対象']]), reasonField()],
      (v) => ({ action: 'scope', id: targetOf(v, ['location']).id, inScope: v.text('inScope') === 'true', reason: v.text('reason') }), ctx),
    identify: {
      label: '仮の記録を既存の保管単位と同じ現物として対応付ける（数量は足さない）',
      fields: () => [foundIssueField(ctx.ledger()), codeTarget(choiceField('lot', '同じ現物の保管単位', lotOptions(ctx.ledger())), 'lot'), reasonField()],
      run: (s, m, v) => ({ state: { ...s, ledger: identifyProvisional(s.ledger, m, v.text('issue'), v.text('lot'), v.text('reason'), v.checked('confirmed')) } }),
    },
    adopt: {
      label: '仮の記録を新しい保管単位として登録する（数量は仮の記録のまま）',
      fields: () => {
        const masters = ctx.ledger().masters;
        return [foundIssueField(ctx.ledger()), textField('newId', '新しい保管単位のID（文字列のまま保存）'), ...itemFields(masters),
          projectField(masters), codeTarget(fixedPlaceTime(choiceField('location', '場所', placeOptions(masters))), 'location', { hold: 'location' })];
      },
      run: (s, m, v) => ({ state: { ...s, ledger: adoptProvisional(s.ledger, m, v.text('issue'), { id: v.text('newId'), item: v.text('item'), unit: v.text('unit'), project: projectOf(v), location: v.text('location') }, v.checked('confirmed')) } }),
    },
    assignProject: {
      label: '案件・用途が不明な保管単位を案件・用途・共通在庫へ結び付ける',
      fields: () => {
        const masters = ctx.ledger().masters;
        return [codeTarget(choiceField('lot', '案件・用途が不明な保管単位', lotOptions(ctx.ledger(), (l) => l.project.kind === 'unassigned')), 'lot'),
          codeTarget(choiceField('project', '結び付け先', projectsOf(masters).filter((p) => p.kind !== 'unassigned').map((p) => [projectKey(p), projectText(masters, p)])), 'project'), reasonField()];
      },
      run: (s, m, v) => ({ state: { ...s, ledger: assignProject(s.ledger, m, v.text('lot'), projectOf(v), v.text('reason'), v.checked('confirmed')) } }),
    },
  };
}

const stateText = (m: Master): string => (m.active ? '利用中' : '利用停止');
const sinceText = (from: string | null): string => (from === null ? '最初から' : `${jst(from)}から`);

function table(label: string, header: readonly string[], rows: readonly (readonly string[])[]): HTMLElement {
  return h('table', { 'aria-label': label },
    h('thead', {}, h('tr', {}, ...header.map((t) => h('th', {}, t)))),
    h('tbody', {}, ...rows.map((r) => h('tr', {}, ...r.map((t) => h('td', {}, t))))));
}

// 登録情報の一覧と、選んだ登録情報の変更の履歴（要件10.1〜10.4）。値は利用者の入力なので文字としてだけ出す。
export function mastersPanel(ledger: Ledger, selected: string, onSelect: (key: string) => void): HTMLElement[] {
  const ms = ledger.masters;
  const items = Object.values(ms.items).map((i) => [
    i.code ?? unassignedCode, i.code === null ? '仮' : '', i.name, stateText(i),
    `${i.units.join('・')}${i.packaging ? `（1${i.packaging.boxUnit}の1箱あたりの数：${i.packaging.perBox.map((p) => `${sinceText(p.from)}${p.value}${i.packaging!.pieceUnit}`).join('、')}）` : ''}`,
    i.units.map((u) => `${u}：${i.unitSteps[u]}`).join('、'), i.source ? `${i.source.name}（版${i.source.revision}）` : 'なし',
  ]);
  const locations = Object.values(ms.locations).map((l) => [
    l.code, l.name, stateText(l), l.scope.map((s) => `${sinceText(s.from)}${s.inScope ? '記録の対象' : '記録の対象外'}`).join('、'),
  ]);
  const cases = Object.values(ms.cases).map((c) => [
    c.code ?? unassignedCode, c.code === null ? '仮' : '', c.name ?? 'なし', stateText(c), c.source ? `${c.source.name}（版${c.source.revision}）` : 'なし',
  ]);
  const actors = Object.values(ms.actors).map((a) => [a.id, stateText(a)]);
  const all: Master[] = [...Object.values(ms.items), ...Object.values(ms.locations), ...Object.values(ms.cases), ...Object.values(ms.actors)];
  const key = (m: Master) => `${m.type}:${m.id}`;
  const current = all.find((m) => key(m) === selected) ?? all[0];
  const choice = selectField('master-history', '変更の履歴を見る登録情報', all.map((m) => [key(m), masterLabel(ms, m)]), current ? key(current) : '');
  choice.addEventListener('change', (event) => { if (event.target instanceof HTMLSelectElement) onSelect(event.target.value); });
  const events = current ? ledger.history.filter((e) => e.kind === 'master' && e.masters.some((c) => c.after.type === current.type && c.after.id === current.id)) : [];
  return [
    h('p', {}, '品目・場所・案件・用途・担当者を登録・変更するときは、入力で作業の種類「登録情報の登録・変更」を選ぶ。権限による制限はなく、画面を使える人は誰でも変えられる。変更は履歴に残り、過去の記録は消さない。'),
    h('h3', {}, '品目'), table('品目の登録情報', ['品番・コード', '仮', '名称', '状態', '単位と1箱あたりの数', '単位ごとの最小単位（登録後は変えない）', '元の資料'], items),
    h('h3', {}, '場所'), table('場所の登録情報', ['品番・コード', '名称', '状態', '記録の対象'], locations),
    h('h3', {}, '案件・用途'), table('案件・用途の登録情報', ['品番・コード', '仮', '名称', '状態', '元の資料'], cases),
    h('h3', {}, '担当者'), table('担当者の登録情報', ['名前', '状態'], actors),
    h('h3', {}, '変更の履歴'), choice,
    events.length === 0
      ? h('p', {}, 'この登録情報の変更の記録はない（最初からの値のまま）')
      : table('登録情報の変更の履歴', ['操作ID', '前後', '実際の日時・適用時点', '入力した日時', '担当者'], events.map((e) => [e.eventId, eventText(ledger, e), jst(e.occurredAt), jst(e.recordedAt), e.actor])),
  ];
}

// 既存IDの付替えで仮になる相手の登録情報を、供給の未完了の記録がまだ指している件数を確認の文に足す。0件も示し、未確認と見分けられるようにする。
export function supplyRefsText(supply: Supply, masters: Masters, m: Master | null): string {
  if (m === null || (m.type !== 'item' && m.type !== 'case')) return '';
  const refers = (r: { item: string; project: { kind: string; id?: string } }) => (m.type === 'item' ? r.item === m.id : r.project.kind === 'case' && r.project.id === m.id);
  const requests = Object.values(supply.requests).filter((r) => refers(r) && r.cancelled === null && requestProgressOf(masters, r).outstanding !== 0).length;
  const needs = Object.values(supply.needs).filter(refers).length;
  return `。この${masterTypeDisplayLabel[m.type]}を指す未完了の依頼${requests}件・必要明細${needs}件は、そのまま仮の${masterTypeDisplayLabel[m.type]}を指す`;
}

// 同じ現物を二重に数えていないか判断できるよう、現存するまとまりの数量・根拠・案件・用途を確認の文に足す（要件8.2・8.4）。
export function candidatesText(ledger: Ledger, lotIds: readonly string[]): string {
  const lines = lotIds.flatMap((id) => {
    const lot = ledger.lots[id];
    return lot ? [`${id}は${quantityText(lot.quantity, lot.unit)}、案件・用途${projectText(ledger.masters, lot.project)}`] : [];
  });
  return lines.length === 0 ? '' : `。現存する保管単位の数量・根拠・案件・用途：${lines.join('、')}`;
}
