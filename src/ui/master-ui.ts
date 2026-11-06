import {
  adoptProvisional,
  assignProject,
  changeMasters,
  processUsed,
  identifyProvisional,
  openIssues,
  type Issue,
  type Ledger,
  type Lot,
  type MasterRequest,
  type NewMaster,
  type Process,
} from '../domain/ledger.ts';
import { masterTypeDisplayLabel, nextProcessOf, own, unassignedCode, type ItemMaster, type Master, type Masters, type Source } from '../domain/masters.ts';
import type { Supply } from '../domain/supply.ts';
import { requestProgressOf } from '../domain/supply.ts';
import { checkField, choiceField, h, selectField, textField, type Child, type Values } from './dom.ts';
import { otherOperations } from './subject-actions.ts';
import { codeTarget, itemFields, lotOptions, placeOptions, projectField, projectKey, projectOf, projectsOf } from './fields.ts';
import { parseScalar, type Step } from '../domain/scalar.ts';
import { caseRef, consumableSettingText, criterionText, packagingSettingText, eventText, itemRef, jst, locationRef, projectText, quantityText } from './format.ts';
import type { Ctx, UiOp } from './supply-ui.ts';

// 確認が要る操作は、画面の「確認した」の欄を読む。

export function masterOf(masters: Masters, key: string): Master | undefined {
  const at = key.indexOf(':');
  const groups = { item: masters.items, location: masters.locations, case: masters.cases, actor: masters.actors, process: masters.processes } as const;
  const type = key.slice(0, at);
  return at < 0 || !Object.hasOwn(groups, type) ? undefined : own(groups[type as keyof typeof groups] as Readonly<Record<string, Master>>, key.slice(at + 1));
}

function masterLabel(masters: Masters, m: Master): string {
  switch (m.type) {
    case 'item': return `品目${itemRef(masters, m.id)}「${m.name}」`;
    case 'location': return `場所${locationRef(masters, m.id)}「${m.name}」`;
    case 'case': return `案件・用途${caseRef(masters, m.id)}${m.name === null ? '' : `「${m.name}」`}`;
    case 'actor': return `担当者「${m.id}」${m.active ? '' : '（利用停止）'}`;
    case 'process': return `工程「${m.name}」${m.active ? '' : '（利用停止）'}`;
  }
}

// 登録情報の操作の対象は、利用停止と仮も含めて全部出す（要件3.5）。値は「種類:内部の識別」。
function targetField(masters: Masters, types: readonly Master['type'][]): HTMLLabelElement {
  const groups = { item: masters.items, location: masters.locations, case: masters.cases, actor: masters.actors, process: masters.processes };
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

const masterOp = (label: string, fields: (masters: Masters) => HTMLElement[], request: (v: Values, masters: Masters) => MasterRequest, ctx: Ctx, accepts?: (m: Master) => boolean): UiOp => ({
  label,
  ...(accepts === undefined ? {} : { subject: { kind: 'master', field: 'target', accepts } }),
  fields: () => fields(ctx.ledger().masters),
  run: (s, m, v) => ({ state: { ...s, ledger: changeMasters(s.ledger, m, request(v, s.ledger.masters), v.checked('confirmed')) } }),
});

// Number()は0x10・0b11・1e1も整数にしてしまうので、十進の数字だけを1箱あたりの数として読む。
function perBoxOf(raw: string): number {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) throw new Error('1箱あたりの数は1以上の整数にする');
  return Number(text);
}

function selectedItem(masters: Masters, v: Values): ItemMaster {
  const item = own(masters.items, targetOf(v, ['item']).id);
  if (item === undefined) throw new Error('対象の品目を選ぶ');
  return item;
}

function itemSettingFields(masters: Masters, fields: (item: ItemMaster) => HTMLElement[]): HTMLElement[] {
  const target = choiceField('target', '品目', Object.values(masters.items).map(item => [`item:${item.id}`, masterLabel(masters, item)]));
  const details = h('div', {});
  target.addEventListener('change', () => {
    const item = own(masters.items, target.querySelector('select')!.value.slice(5));
    details.replaceChildren(...(item === undefined ? [] : fields(item)));
  });
  return [target, details, reasonField()];
}

function unitChoice(item: ItemMaster, name: string, label: string, current = ''): HTMLLabelElement {
  const field = choiceField(name, label, item.units.map(unit => [unit, unit]));
  field.querySelector('select')!.value = current;
  return field;
}

function packagingFields(item: ItemMaster): HTMLElement[] {
  const count = textField('perBox', item.packaging === null ? '入り数（1包装あたりの数）' : `新しい1${item.packaging.boxUnit}あたりの数`, 'integer');
  if (item.packaging !== null) {
    count.querySelector('input')!.value = String(item.packaging.perBox.at(-1)!.value);
    return [h('p', {}, `包装：${item.packaging.boxUnit} → ${item.packaging.pieceUnit}`), count];
  }
  return [unitChoice(item, 'boxUnit', '包装の単位'), unitChoice(item, 'pieceUnit', '中身の単位', item.consumable?.pieceUnit ?? ''), count];
}

function consumableFields(item: ItemMaster): HTMLElement[] {
  const setting = item.consumable;
  const enabled = checkField('consumableEnabled', '共通消耗品として表示する', setting !== null);
  const piece = unitChoice(item, 'pieceUnit', '集計する単位', setting?.pieceUnit ?? item.packaging?.pieceUnit ?? '');
  const useRule = checkField('replenishmentEnabled', '補充基準を設定する', setting?.rule != null);
  const threshold = textField('threshold', '補充基準', 'number');
  const order = textField('standardOrderValue', '標準依頼数量', 'number');
  const orderUnit = unitChoice(item, 'standardOrderUnit', '標準依頼の単位', setting?.rule?.standardOrder.unit ?? '');
  threshold.querySelector('input')!.value = setting?.rule ? String(setting.rule.threshold) : '';
  order.querySelector('input')!.value = setting?.rule ? String(setting.rule.standardOrder.value) : '';
  const ruleFields = h('div', {}), detail = h('div', {});
  const showRule = () => ruleFields.replaceChildren(...(useRule.querySelector('input')!.checked ? [threshold, order, orderUnit] : []));
  const showSetting = () => detail.replaceChildren(...(enabled.querySelector('input')!.checked ? [piece, useRule, ruleFields] : []));
  enabled.addEventListener('change', showSetting);
  useRule.addEventListener('change', showRule);
  showRule(); showSetting();
  return [enabled, detail];
}

function consumableRequest(v: Values, masters: Masters): MasterRequest {
  const item = selectedItem(masters, v);
  const base = { action: 'consumable', id: item.id, reason: v.text('reason') } as const;
  if (!v.checked('consumableEnabled')) return { ...base, setting: null };
  const pieceUnit = v.text('pieceUnit'), pieceStep = own(item.unitSteps, pieceUnit);
  if (pieceStep === undefined) throw new Error('集計する単位を選ぶ');
  if (!v.checked('replenishmentEnabled')) return { ...base, setting: { pieceUnit, rule: null } };
  const unit = v.text('standardOrderUnit'), orderStep = own(item.unitSteps, unit);
  if (orderStep === undefined) throw new Error('標準依頼の単位を選ぶ');
  return { ...base, setting: { pieceUnit, rule: { threshold: parseScalar(v.text('threshold'), pieceStep), standardOrder: { value: parseScalar(v.text('standardOrderValue'), orderStep), unit } } } };
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
function foundIssue(ledger: Ledger, i: Issue): boolean {
  const origin = ledger.history.find((e) => e.eventId === i.id);
  return i.resolution === null && i.reason === 'unassigned' && origin?.kind === 'provisional' && origin.direction === 'found';
}

const unassigned = (l: Lot): boolean => l.project.kind === 'unassigned';

function foundIssueField(ledger: Ledger): HTMLLabelElement {
  const options = openIssues(ledger).flatMap((i): [string, string][] => foundIssue(ledger, i) ? [[i.id, `${i.id}：${eventText(ledger, ledger.history.find((e) => e.eventId === i.id)!)}`]] : []);
  return choiceField('issue', '見つかった物の仮の記録', options);
}

// 仮の記録からの登録は、入力欄の実際の日時でなく仮の記録の時点で場所の記録の対象を判断するので、画面は場所を絞らない。
function fixedPlaceTime(node: HTMLLabelElement): HTMLLabelElement {
  node.querySelector('select')!.dataset['placeTime'] = 'fixed';
  return node;
}

// 完了基準の意味は選択肢の文言で示す（要件1.4）。
const criterionField = () => choiceField('criterion', '完了基準', [
  ['workEnd', '作業終了（作業終了の後は完成（渡す前））'],
  ['inspection', '作業終了後の確認の完了（作業終了の後は確認待ち、確認の完了の後は完成（渡す前））'],
]);

function criterionOf(v: Values): Process['criterion'] {
  const criterion = v.text('criterion');
  if (criterion !== 'workEnd' && criterion !== 'inspection') throw new Error('工程の完了基準を選ぶ');
  return criterion;
}

const is = (types: readonly Master['type'][], m: Master) => types.includes(m.type);

export function masterOps(ctx: Ctx): Record<string, UiOp> {
  const all = ['item', 'location', 'case', 'actor', 'process'] as const;
  const coded = ['item', 'location', 'case'] as const;
  const named = ['item', 'location', 'case', 'process'] as const;
  return {
    masterProcess: masterOp('工程の登録', () => [textField('name', '工程の名前'), criterionField()],
      register((v) => ({ type: 'process', name: v.text('name'), criterion: criterionOf(v) })), ctx),
    masterProcessCriterion: masterOp('工程の完了基準の変更',
      (ms) => {
        const unused = Object.values(ms.processes).filter((p) => !processUsed(ctx.ledger(), p.id)).map((p): [string, string] => [keyOf(p), masterLabel(ms, p)]);
        return [...(unused.length === 0 ? [h('p', { class: 'warn' }, '完了基準を変えられる工程がありません。作業や中断を記録した工程の完了基準は変えられません。別の工程を登録してください。')] : []),
          choiceField('target', '工程', unused), criterionField(), reasonField()];
      },
      (v) => ({ action: 'criterion', id: targetOf(v, ['process']).id, criterion: criterionOf(v), reason: v.text('reason') }), ctx,
      m => m.type === 'process' && !processUsed(ctx.ledger(), m.id)),
    masterNextProcess: masterOp('次工程の場所の指定・解除',
      (ms) => [selectField('location', '次工程の場所', [['', '指定しない（解除する）'], ...Object.values(ms.locations).filter((l) => l.active).map((l): [string, string] => [l.id, `${l.name}（${l.code}）`])], nextProcessOf(ms)?.id ?? ''), reasonField()],
      (v) => ({ action: 'nextProcess', id: v.text('location') === '' ? null : v.text('location'), reason: v.text('reason') }), ctx),
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
    masterRename: masterOp('名称の変更', (ms) => [targetField(ms, named), textField('name', '新しい名称'), reasonField()],
      (v) => ({ action: 'rename', ...targetOf(v, named), name: v.text('name'), reason: v.text('reason') }), ctx, m => is(named, m)),
    masterDeactivate: masterOp('利用停止', (ms) => [targetField(ms, all), reasonField()],
      (v) => ({ action: 'deactivate', ...targetOf(v, all), reason: v.text('reason') }), ctx, m => m.active),
    masterReactivate: masterOp('利用の再開', (ms) => [targetField(ms, all), reasonField()],
      (v) => ({ action: 'reactivate', ...targetOf(v, all), reason: v.text('reason') }), ctx, m => !m.active),
    masterCode: masterOp('品番・コードの変更・付与', (ms) => [targetField(ms, coded), textField('code', '新しい品番・コード'), reasonField()],
      (v) => ({ action: 'code', ...targetOf(v, coded), code: v.text('code'), reason: v.text('reason') }), ctx, m => is(coded, m)),
    masterSource: masterOp('元の資料の更新', () => [choiceField('type', '種類', [['item', '品目'], ['case', '案件・用途']]), textField('code', '品番・コード'), textField('sourceName', '元の資料の名称'), textField('sourceRevision', '元の資料の版')],
      (v) => ({ action: 'source', type: v.text('type') === 'case' ? 'case' : 'item', code: v.text('code'), source: { name: v.text('sourceName'), revision: v.text('sourceRevision') } }), ctx),
    masterPerBox: masterOp('包装・入り数の設定', ms => itemSettingFields(ms, packagingFields),
      (v, ms) => {
        const item = selectedItem(ms, v), common = { id: item.id, value: perBoxOf(v.text('perBox')), reason: v.text('reason') };
        return item.packaging === null ? { action: 'packaging', ...common, boxUnit: v.text('boxUnit'), pieceUnit: v.text('pieceUnit') } : { action: 'perBox', ...common };
      }, ctx, m => m.type === 'item'),
    masterConsumable: masterOp('共通消耗品・補充基準の設定', ms => itemSettingFields(ms, consumableFields), consumableRequest, ctx, m => m.type === 'item'),
    masterScope: masterOp('記録の対象の変更', (ms) => [targetField(ms, ['location']), choiceField('inScope', '変更後', [['false', '記録の対象外'], ['true', '記録の対象']]), reasonField()],
      (v) => ({ action: 'scope', id: targetOf(v, ['location']).id, inScope: v.text('inScope') === 'true', reason: v.text('reason') }), ctx, m => m.type === 'location'),
    identify: {
      subject: { kind: 'issue', field: 'issue', accepts: (i) => foundIssue(ctx.ledger(), i) },
      label: '仮の記録を既存の保管単位に対応付ける',
      fields: () => [foundIssueField(ctx.ledger()), codeTarget(choiceField('lot', '同じ現物の保管単位', lotOptions(ctx.ledger())), 'lot'), reasonField()],
      run: (s, m, v) => ({ state: { ...s, ledger: identifyProvisional(s.ledger, m, v.text('issue'), v.text('lot'), v.text('reason'), v.checked('confirmed')) } }),
    },
    adopt: {
      subject: { kind: 'issue', field: 'issue', accepts: (i) => foundIssue(ctx.ledger(), i) },
      label: '仮の記録を新しい保管単位にする',
      fields: () => {
        const masters = ctx.ledger().masters;
        const issue = foundIssueField(ctx.ledger()), items = itemFields(masters);
        const place = codeTarget(fixedPlaceTime(choiceField('location', '場所', placeOptions(masters))), 'location', { hold: 'location' });
        // 仮の記録に書いた品目・場所で始める。選び直せる。
        issue.querySelector('select')!.addEventListener('change', (event) => {
          const origin = ctx.ledger().history.find((e) => e.eventId === (event.target as HTMLSelectElement).value);
          if (origin?.kind !== 'provisional') return;
          for (const [label, value] of [[items[0]!, origin.item], [place, origin.location]] as const) {
            const select = label.querySelector('select')!;
            if (value === null || ![...select.options].some((o) => o.value === value)) continue;
            select.value = value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
          }
        });
        return [issue, textField('newId', '新しい保管単位のID（文字列のまま保存）'), ...items, projectField(masters), place];
      },
      run: (s, m, v) => ({ state: { ...s, ledger: adoptProvisional(s.ledger, m, v.text('issue'), { id: v.text('newId'), item: v.text('item'), unit: v.text('unit'), project: projectOf(v), location: v.text('location') }, v.checked('confirmed')) } }),
    },
    assignProject: {
      subject: { kind: 'lot', field: 'lot', accepts: (l) => l.mergedInto === null && unassigned(l) },
      label: '所属が不明な保管単位の結び付け',
      fields: () => {
        const masters = ctx.ledger().masters;
        return [codeTarget(choiceField('lot', '案件・用途が不明な保管単位', lotOptions(ctx.ledger(), unassigned)), 'lot'),
          codeTarget(choiceField('project', '結び付け先', projectsOf(masters).filter((p) => p.kind !== 'unassigned').map((p) => [projectKey(p), projectText(masters, p)])), 'project'), reasonField()];
      },
      run: (s, m, v) => ({ state: { ...s, ledger: assignProject(s.ledger, m, v.text('lot'), projectOf(v), v.text('reason'), v.checked('confirmed')) } }),
    },
  };
}

const stateText = (m: Master): string => (m.active ? '利用中' : '利用停止');
const sinceText = (from: string | null): string => (from === null ? '最初から' : `${jst(from)}から`);

function table(label: string, header: readonly string[], rows: readonly (readonly Child[])[], keys: readonly string[] = []): HTMLTableElement {
  return h('table', { 'aria-label': label },
    h('thead', {}, h('tr', {}, ...header.map((t) => h('th', {}, t)))),
    h('tbody', {}, ...rows.map((r, i) => h('tr', keys[i] === undefined ? {} : { 'data-master': keys[i] }, ...r.map((t) => h('td', {}, t))))));
}

export type MastersPanelHandlers = {
  select: (key: string, focus: string) => void;
  open: (op: string, target?: string) => void;
  openSets?: (item: string) => void;
  query: string;
  setQuery: (query: string) => void;
};

const keyOf = (m: Master) => `${m.type}:${m.id}`;
// 全角・半角と大文字・小文字の違いで見落とさないよう、比べる前に揃える。
const searchable = (text: string) => text.normalize('NFKC').toLowerCase();

// 登録情報の一覧と、選んだ登録情報の操作・変更の履歴（要件10.1〜10.4）。値は利用者の入力なので文字としてだけ出す。
export function mastersPanel(ledger: Ledger, ops: Readonly<Record<string, UiOp>>, selected: string, on: MastersPanelHandlers): HTMLElement[] {
  const ms = ledger.masters;
  const button = (text: string, click: () => void, props: Record<string, string> = {}) => {
    const node = h('button', { type: 'button', ...props }, text);
    node.addEventListener('click', click);
    return node;
  };
  const pick = (m: Master, text: string) => button(text, () => on.select(keyOf(m), 'master-selected-h'), { class: 'link' });
  const items = Object.values(ms.items), locations = Object.values(ms.locations), cases = Object.values(ms.cases), actors = Object.values(ms.actors), processes = Object.values(ms.processes);
  const next = nextProcessOf(ms);
  const groups = [
    { title: '品目', op: 'masterItem', header: ['品番・コード', '仮', '名称', '状態', '単位', '単位ごとの最小単位（登録後は変えない）', '包装・入り数', '共通消耗品・補充基準', '元の資料'], masters: items, rows: items.map((i) => [
      pick(i, i.code ?? unassignedCode), i.code === null ? '仮' : '', i.name, stateText(i),
      i.units.join('・'), i.units.map((u) => `${u}：${i.unitSteps[u]}`).join('、'), packagingSettingText(i.packaging), consumableSettingText(i.consumable),
      i.source ? `${i.source.name}（版${i.source.revision}）` : 'なし',
    ]) },
    { title: '場所', op: 'masterLocation', header: ['品番・コード', '名称', '状態', '記録の対象'], masters: locations, rows: locations.map((l) => [
      pick(l, l.code), l.name, stateText(l), l.scope.map((s) => `${sinceText(s.from)}${s.inScope ? '記録の対象' : '記録の対象外'}`).join('、'),
    ]) },
    { title: '案件・用途', op: 'masterCase', header: ['品番・コード', '仮', '名称', '状態', '元の資料'], masters: cases, rows: cases.map((c) => [
      pick(c, c.code ?? unassignedCode), c.code === null ? '仮' : '', c.name ?? 'なし', stateText(c), c.source ? `${c.source.name}（版${c.source.revision}）` : 'なし',
    ]) },
    { title: '担当者', op: 'masterActor', header: ['名前', '状態'], masters: actors, rows: actors.map((a) => [pick(a, a.id), stateText(a)]) },
    { title: '工程', op: 'masterProcess', header: ['名前', 'ID', '完了基準', '状態'], masters: processes, rows: processes.map((p) => [pick(p, p.name), p.id, criterionText(p.criterion), stateText(p)]) },
  ].map((g) => {
    const list = table(`${g.title}の登録情報`, g.header, g.rows, g.masters.map(keyOf));
    return { ...g, list, box: h('div', {}, list), empty: h('p', {}, `${g.title}：該当なし`) };
  });
  const query = h('input', { type: 'search', name: 'master-query' });
  query.value = on.query;
  const filter = () => {
    const needle = searchable(query.value.trim());
    for (const g of groups) {
      let shown = 0;
      for (const row of g.list.tBodies[0]!.rows) {
        row.hidden = needle !== '' && !searchable(row.textContent ?? '').includes(needle);
        if (!row.hidden) shown++;
      }
      g.box.hidden = needle !== '' && shown === 0;
      g.empty.hidden = !g.box.hidden;
    }
  };
  query.addEventListener('input', () => { on.setQuery(query.value); filter(); });
  filter();

  const all: Master[] = [...items, ...locations, ...cases, ...actors, ...processes];
  const current = all.find((m) => keyOf(m) === selected) ?? all[0];
  const choice = selectField('master-history', '対象', all.map((m) => [keyOf(m), masterLabel(ms, m)]), current ? keyOf(current) : '');
  choice.addEventListener('change', (event) => { if (event.target instanceof HTMLSelectElement) on.select(event.target.value, 'master-history'); });
  choice.querySelector('select')!.id = 'master-history';
  const actions = current === undefined ? [] : Object.entries(ops).filter(([, op]) => op.subject?.kind === 'master' && op.subject.accepts(current));
  const actionButton = ([key, op]: [string, UiOp]) => button(op.label, () => on.open(key, keyOf(current!)), { 'data-op': key });
  const primary = ['masterRename', 'masterCode', 'masterDeactivate', 'masterReactivate'];
  const events = current ? ledger.history.filter((e) => e.kind === 'master' && e.masters.some((c) => c.after.type === current.type && c.after.id === current.id)) : [];
  return [
    h('div', { class: 'filters' }, h('label', {}, '名称・品番・コードで絞り込み', query)),
    ...groups.flatMap((g) => [
      h('h3', {}, g.title), ...(Object.hasOwn(ops, g.op) ? [button(`${g.title}を登録`, () => on.open(g.op))] : []), g.box, g.empty,
      ...(g.op === 'masterProcess' ? [h('p', {}, `次工程の場所：${next === null ? '指定なし' : `${next.name}（${next.code}）${next.active ? '' : '（利用停止）'}`}`, ...(Object.hasOwn(ops, 'masterNextProcess') ? [' ', button('次工程の場所を指定', () => on.open('masterNextProcess'))] : []))] : []),
    ]),
    h('h3', { id: 'master-selected-h', tabindex: '-1' }, '選んだ登録情報'), choice,
    ...(actions.length === 0 ? [] : [h('div', { role: 'group', 'aria-label': 'この登録情報にできる操作' },
      ...primary.flatMap((key) => actions.filter(([candidate]) => candidate === key)).map(actionButton),
      otherOperations(actions.filter(([key]) => !primary.includes(key)).map(actionButton)))]),
    ...(current?.type === 'item' && on.openSets !== undefined ? [button('この品目のセット', () => on.openSets!(current.id))] : []),
    h('h4', {}, '変更の履歴'),
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
