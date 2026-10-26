import { confirmedUnreadableReset, abandon, commit, confirmSaved, inquire, inquireReplacement, load, replace, retry, repository, generationOf } from './browser-repository.ts';
import { restoreSelectionOf } from './restore-selection.ts';
import { navigationOf } from './navigation.ts';
import { operationPicker } from './operation-picker.ts';
import { createHistoryTargetCollector } from '../domain/history-targets.ts';
import type { HistoryTargetCollector } from './history-item-format.ts';
import {
  beginAlternativeRecord,
  beginRework,
  changeStage,
  correctOccurredAt,
  declareDiscrepancy,
  emptyLedger,
  practiceLedger,
  handOver,
  hold,
  holdReasons,
  ConfirmationRequired,
  InclusionRequired,
  isUsable,
  merge,
  move,
  nextProcessLocation,
  nextStage,
  noStage,
  occurredAtOf,
  openIssues,
  openIssuesOf,
  originOf,
  processes,
  productionOf,
  productionGroupsOf,
  productionIssuesOf,
  recordProvisional,
  recordReworkPart,
  reworksOf,
  recordStop,
  recount,
  release,
  resolveIssue,
  resumeWork,
  split,
  transferProject,
  start,
  stopExcessOf,
  updateStop,
  use,
  voidOf,
  voidRecord,
  type HoldReason,
  type Inclusion,
  type Ledger,
  type LedgerEvent,
  type Lot,
  type Meta,
  type Project,
  type Stage,
} from '../domain/ledger.ts';
import type { Basis } from '../domain/quantity.ts';
import {
  affectedText,
  basisLabel,
  cumulativeText,
  eventsOf,
  eventText,
  holdLabel,
  inclusionLabel,
  issueLabel,
  jst,
  lastCountText,
  lastUpdatedOf,
  materialsOf,
  projectText,
  caseRef,
  itemNameText,
  itemRef,
  locationRef,
  quantityText,
  reworkHistoryOf,
  stageLabel,
  stageText,
  stopText,
  targetLabel,
  termText,
  tokyoText,
  totalsOf,
  totalsText,
} from './format.ts';
import { checkField, choiceField, field, h, section, selectField, textField, type Child, type Values } from './dom.ts';
import { alternativeFields, alternativeOperationOf, alternativeSourceOf } from './alternative-input.ts';
import type { AlternativeOperation } from '../domain/alternative-record.ts';
import { own } from '../domain/masters.ts';
import { emptySupply } from '../domain/supply.ts';
import { requireQuantityTotals } from '../domain/shortage.ts';
import { amount, amountFields, countOrUnknown, MaterialInclusionRequired, formValue, precisionHints, quantityStepFor, quantityTargetOf, quantityValue, basisOptions, codeTarget, itemFields, itemOptions, lotOptions as lotChoices, placeOptions as placeChoices, projectField, projectKey, projectOf, registerFromValues, restrictPlaces } from './fields.ts';
import { codeInput, type CodeHolds, type CodeInput } from './code-input.ts';
import { recountWithReceiptChoice, renderConsumables, renderSupply, supplyAsOf, supplyOps, type Ctx, type UiOp } from './supply-ui.ts';
import { seedLedger, seedScn02 } from './seed.ts';
import { browserStore, fingerprintOf, initial, nextOpIdOf, sameSnapshot, targetsOf, unknownSinceOf, type CommitResult, type Pending, type RecordContents, type SettleResult, type Snapshot, type UnitState } from './storage.ts';
import { backupFileName, recordCountsOf, viewFileName } from './backup.ts';
import { authorityClient } from './shared-authority.ts';
import { basisOf, captureDraft, confirmationStale, fieldsOf, panelModel, type CaptureSource, type ConfirmationBasis, type ControlLike, type Decision, type PanelState } from './conflict-ui.ts';
import { conflictPanelNode, type PanelHandlers } from './conflict-panel.ts';
import { clearDraft, discardUnreadableDraft, readDraft, writeDraft } from './conflictdraft.ts';
import { captureShared, recoveryRows, withdrawShared } from './shared-recovery.ts';
import { canonical, hashText, identityKey, openEntry, type ArchiveRow } from './shared-archive.ts';
import { sharedRecoveryPanel } from './shared-recovery-panel.ts';
import { sharedBackupText } from './shared-backup.ts';
import { conflictReviewFingerprint, parseConflictReview, reviewOpLabel, reviewPendingValues, reviewUsage, type ConflictEvidence, type ConflictReview, type ConflictField, type ConflictOrigin } from './conflictrecord.ts';
import { backupResultText, pendingView, requestReset, resetPanel, savePanel, savePresentation, setupTestHooks, type FeedbackOrigin, type ResetRequest, type SaveActions, type SaveView } from './saveui.ts';
import { caseDetailPanel } from './caseview.ts';
import { lotEvidencePanel } from './lot-evidence.ts';
import { needImportOps } from './need-import-ui.ts';
import { receiptTemplateOps } from './receipt-template-ui.ts';
import { recipeStartOps } from './recipe-start-ui.ts';
import { followupPanel } from './followupview.ts';
import { candidatesText, masterOps, mastersPanel, supplyRefsText } from './master-ui.ts';
import { returnIntakeOps } from './return-intake-ui.ts';

const rootNode = document.getElementById('app');
if (rootNode === null) throw new Error('画面のルートがありません');
const appRoot = rootNode;
const navigation = navigationOf(appRoot);

let snapshot = initial(emptyLedger, emptySupply);
// 描画は一つの写しから取り出した台帳と供給を使う。更新はuseSnapshotだけで同時に行う。
let ledger = snapshot.ledger;
let supply = snapshot.supply;
let pending: Pending | null = null;
let stale = false;
let resetEpoch = 0;
const codeHolds: CodeHolds = { project: null, location: null };
let saveView: SaveView = { kind: 'ready' };
let saveError: string | null = null;
let resetRequest: ResetRequest | null = null;
let resetOrigin: FeedbackOrigin = 'management';
// 管理操作の結果と回復の確認は、各操作を始めた場所へ別々に表示する。
let notice: string | null = null;
let noticeOrigin: FeedbackOrigin = 'management';
let restoreFromUnreadable = false;
let restoreSelection = 0;
let resetFailure: string | null = null;
let selectedProject = '';
let selectedMaster = '';

function useSnapshot(next: Snapshot): void {
  snapshot = next;
  ledger = next.ledger;
  supply = next.supply;
}
let selectedLot: string | null = null;
let currentOp = 'register';
const filter = { item: '', project: '', location: '' };


function nowIso(): string {
  return `${tokyoText(new Date()).replace(' ', 'T')}+09:00`;
}

// datetime-localは時刻帯を持たないので、日本時間の入力として時刻帯を付ける（NFR-08a）。
function fromLocal(value: string): string {
  return `${value.length === 16 ? `${value}:00` : value}+09:00`;
}

function enteredTime(form: HTMLFormElement): string {
  const unknown = (form.elements.namedItem('occurredUnknown') as HTMLInputElement).checked;
  const value = (form.elements.namedItem('occurredAt') as HTMLInputElement).value;
  return unknown || value === '' ? nowIso() : fromLocal(value);
}

const activeLots = (): Lot[] => Object.values(ledger.lots).filter((l) => l.mergedInto === null);

const lotOptions = (where?: (lot: Lot) => boolean) => lotChoices(ledger, where);
const lotField = (name = 'lot', label = '対象の保管単位', where?: (lot: Lot) => boolean) => codeTarget(choiceField(name, label, lotOptions(where)), 'lot', { quantity: 'value', basis: 'basis' });
const placeOptions = () => placeChoices(ledger.masters);
const locationField = (label = '場所') => codeTarget(choiceField('location', label, placeOptions()), 'location', { hold: 'location' });
const holdField = () => choiceField('reason', '理由', holdReasons.map((r) => [r, holdLabel[r]]));
const holdsText = (lot: Lot): string => lot.holds.map((r) => holdLabel[r]).join('・') || 'なし';

const reworkField = () => choiceField('reworkId', '対象のやり直し・修理（開始記録・元現物→やり直し・修理分）', ledger.history.flatMap(e => e.kind === 'rework' ? [[e.eventId, `${e.eventId}：${e.lotId} → ${e.childId}（${e.reason}）`] as [string, string]] : []));
// やり直し・修理との組合せと作業区間は domain が検査する。後入力では処置後に統合された枝も選べるよう、統合済みも示す。
const subjectField = () => choiceField('subjectLotId', '処置した対象枝（そのとき作業中・確認検査待ちだったやり直し・修理分）', Object.values(ledger.lots).flatMap(lot => {
  if (lot.stage.kind !== 'working' && lot.stage.kind !== 'inspecting') return [];
  const reworks = reworksOf(ledger, lot.id);
  return reworks.length > 0 ? [[lot.id, `${lot.id}（${stageLabel[lot.stage.kind]}、やり直し・修理${reworks.map(e => e.eventId).join('・')}）`] as [string, string]] : [];
}));
const partCountFields = () => [
  subjectField(),
  h('p', {}, '元のやり直し・修理で実際に行った処置を、実際の日時と理由で記録する。対象枝は処置したときの枝を選ぶ。再完了・引渡し後の後入力も、処置した時点の枝と日時を入れれば記録できる。再完了した物への新しい作業は、やり直し・修理開始から別のやり直し・修理として記録する。帰属を確かめるため、実際の日時は不明にできない。新たなやり直し・修理や外からの返ってきた物を、この部品記録で代用しない。'),
  textField('value', '実際に処置した部品の実数', 'number'), textField('reason', '部品処置の理由'),
];
function partCount(v: Values): number {
  const raw = v.text('value').trim();
  if (raw === '') throw new Error('実際に処置した部品の実数を入力する');
  return quantityValue(raw, v.step?.('value'));
}



// 空欄を黙って不明にも0にもしない。不明はチェックで選ぶ（unknownPairs）。


const processField = (label = '工程') =>
  choiceField(
    'process',
    label,
    processes.map((p) => [p.id, `工程${p.id}（完了基準：${p.criterion === 'inspection' ? '作業終了後の確認の完了' : '作業終了'}）`]),
  );

// 作業の開始と材料の使用を一つの入力で記録する。材料の行は使うものだけ選ぶ。
const materialRows = [1, 2, 3] as const;

function historyChoices(events: readonly LedgerEvent[], withTime = false): [string, string][] {
  const targets = createHistoryTargetCollector({ ledger, supply });
  return events.map(e => [e.eventId, `${e.eventId}：${withTime ? `${jst(occurredAtOf(ledger, e.eventId))}：` : ''}${eventText(ledger, e, targets)}`]);
}

function materialFields(): HTMLElement[] {
  return materialRows.flatMap((i) => [
    codeTarget(selectField(`m${i}lot`, `材料${i}の保管単位`, [['', 'なし'], ...lotOptions(isUsable)]), 'lot', { quantity: `m${i}value`, basis: `m${i}basis` }),
    selectField(`m${i}basis`, `材料${i}の数量の根拠`, [['', '選ぶ'], ...basisOptions]),
    textField(`m${i}value`, `材料${i}の使用数（数が不明なら空欄）`, 'number'),
    inclusionField(`m${i}inclusion`, `材料${i}：最後に数えた数に含まれていたか`),
  ]);
}

// 作業終了・確認の完了・次工程への引渡しは、完了基準に従った次の位置へ一部の数量を移す。
function stageStep(label: string, from: Stage['kind'], toNextProcess = false): Op {
  return {
    label,
    fields: () => [
      lotField('lot', `対象の保管単位（${stageLabel[from]}）`, (l) => l.stage.kind === from),
      textField('childId', '移した分の新しいID'),
      ...amountFields(),
      ...(toNextProcess ? [codeTarget(choiceField('location', '渡した先（手元の次工程）', placeOptions().filter(([id]) => id === nextProcessLocation)), 'location', { hold: 'location' })] : []),
    ],
    run: (l, m, v, inc) => {
      const lot = l.lots[v.text('lot')]!;
      const { basis, value } = amount(v);
      const changed = changeStage(l, m, lot.id, v.text('childId'), basis, value, nextStage(lot.stage)!, inc);
      return toNextProcess ? move(changed, { ...m, eventId: `${m.eventId}-m` }, v.text('childId'), v.text('location')) : changed;
    },
  };
}

// 最初の選択肢が選ばれたまま再送すると、答えていないのに回答として扱われるので、空を先頭に置く。回答を求められるまで隠す。
function inclusionField(name: string, label: string): HTMLLabelElement {
  const node = selectField(name, label, [['', '選ぶ'], ...(Object.keys(inclusionLabel) as Inclusion[]).map((k) => [k, inclusionLabel[k]] as const)]);
  node.hidden = true;
  return node;
}

// 不足品目の単位は、複数の単位を持つ品目（ネジの本・箱）で取り違えないよう選んで記録する（MFG-08a）。
function shortageFields(): HTMLElement[] {
  const itemSelect = codeTarget(selectField('shortageItem', '不足品目', [['', 'なし'], ...itemOptions(ledger.masters)]), 'item', { quantity: 'shortageValue' });
  const unitSelect = selectField('shortageUnit', '不足数の単位', [['', 'なし']]);
  itemSelect.addEventListener('change', () => {
    const id = itemSelect.querySelector('select')!.value;
    const units = own(ledger.masters.items, id)?.units ?? [];
    const options = units.length === 1 ? units : ['', ...units];
    unitSelect.querySelector('select')!.replaceChildren(...options.map((u) => h('option', { value: u }, u || '選ぶ')));
  });
  return [itemSelect, unitSelect];
}

const openStopField = () =>
  choiceField(
    'stop',
    '中断',
    Object.values(ledger.stops)
      .filter((s) => s.resumedBy === null)
      .map((s) => [s.id, `${s.id}：${stopText(ledger.masters, s)}`]),
  );
const affectedFields = () => [textField('affected', '影響数（工程内数の内数）', 'number'), checkField('affectedUnknown', '影響数は不明')];

function cause(v: Values) {
  return v.checked('causeUnknown') ? ({ kind: 'unknown' } as const) : ({ kind: 'stated', text: v.text('causeText') } as const);
}

type Op = {
  label: string;
  fields: () => HTMLElement[];
  run: (l: Ledger, m: Meta, v: Values, inclusion: Inclusion | undefined) => Ledger;
};

const ops = {
  register: {
    label: '登録（開始時点の現物・既にある物。依頼への受け取りは「受け取り」を使う）',
    fields: () => [
      textField('newId', '新しい保管単位のID（文字列のまま保存）'),
      ...itemFields(ledger.masters),
      projectField(ledger.masters),
      locationField(),
      selectField('stage', '作業の状態', [['none', stageLabel.none], ['working', stageLabel.working], ['inspecting', stageLabel.inspecting], ['awaitingHandover', stageLabel.awaitingHandover]]),
      selectField('process', '工程（作業なしでは不要）', [['', 'なし'], ...processes.map((p) => [p.id, `工程${p.id}（完了基準：${p.criterion === 'inspection' ? '作業終了後の確認の完了' : '作業終了'}）`] as const)]),
      ...amountFields(),
    ],
    run: (l, m, v) => registerFromValues(l, m, v),
  },
  start: {
    label: '作業の開始（材料の使用とまとめて記録）',
    fields: () => [
      processField(),
      textField('newId', '作業中の保管単位の新しいID'),
      ...itemFields(ledger.masters),
      projectField(ledger.masters),
      codeTarget(choiceField('location', '作業の場所', placeOptions().filter(([id]) => id !== nextProcessLocation)), 'location', { hold: 'location' }),
      ...amountFields(),
      ...materialFields(),
    ],
    // 材料の使用と作業の開始は一つの入力なので、どれかで失敗したら全部を台帳に残さない（DAT-04・AT-39）。
    run: (l, m, v) => {
      const process = processes.find((p) => p.id === v.text('process'))!;
      const id = v.text('newId');
      const materials: string[] = [];
      let next = l;
      for (const i of materialRows) {
        const lot = v.text(`m${i}lot`);
        // 数量や根拠だけ入れた行を黙って捨てない。使わない行は全部を空にする。
        if (lot === '' && (v.text(`m${i}basis`) !== '' || v.text(`m${i}value`).trim() !== '')) {
          throw new Error(`材料${i}の保管単位を選ぶ（使わない材料なら根拠と数量も空にする）`);
        }
        if (lot === '') continue;
        if (v.text(`m${i}basis`) === '') throw new Error(`材料${i}の数量の根拠を選ぶ`);
        const { basis, value } = amount(v, `m${i}`);
        const eventId = `${m.eventId}-u${i}`;
        // 包含の回答は材料のまとまりごとの最後に数えた数に対するので、材料ごとに答えさせる。
        const answer = v.text(`m${i}inclusion`) as Inclusion | '';
        try {
          next = use(next, { ...m, eventId }, lot, basis, value, `${id}の着手（工程${process.id}）`, answer === '' ? undefined : answer);
        } catch (err) {
          if (err instanceof InclusionRequired) throw new MaterialInclusionRequired(`材料${i}：${err.message}`, `m${i}inclusion`);
          throw err;
        }
        materials.push(eventId);
      }
      const { basis, value } = amount(v);
      return start(next, m, { id, item: v.text('item'), unit: v.text('unit'), project: projectOf(v), location: v.text('location') }, process, basis, value, materials);
    },
  },
  finish: stageStep('作業終了', 'working'),
  reworkBegin: {
    label: 'やり直し・修理を開始（同じ現物を工程へ戻す）',
    fields: () => [
      h('p', {}, '手元の完成（渡す前）で、元の現物と数量が分かる分を同じ工程へ戻す。作業をしていない返ってきた物は仮の記録の新規割当後に「返ってきた物のやり直し・修理を開始」を使う。専用の取消は未実装。'),
      lotField('lot', 'やり直し・修理元の保管単位', lot => lot.stage.kind === 'awaitingHandover'),
      textField('childId', 'やり直し・修理分の新しいID'), ...amountFields(), textField('reason', 'やり直し・修理の理由'),
    ],
    run: (l, m, v, inc) => {
      const { basis, value } = amount(v);
      return beginRework(l, m, v.text('lot'), v.text('childId'), basis, value, v.text('reason'), inc);
    },
  },
  reworkReplace: {
    label: 'やり直し・修理の交換部品を使用',
    fields: () => [reworkField(), codeTarget(choiceField('lot', '交換元の未使用部品', lotOptions(isUsable)), 'lot'), ...partCountFields(), h('p', {}, '同じ案件・用途か共通在庫から、実際に交換へ使った数だけ減らす。元の作業の開始材料は巻き戻さない。')],
    run: (l, m, v, inc) => recordReworkPart(l, m, { action: 'replace', reworkId: v.text('reworkId'), subjectLotId: v.text('subjectLotId'), lotId: v.text('lot'), value: partCount(v), reason: v.text('reason') }, inc),
  },
  reworkDiscard: {
    label: 'やり直し・修理で取り外した部品を廃棄',
    fields: () => [reworkField(), ...itemFields(ledger.masters, null), ...partCountFields(), h('p', {}, '取り外して廃棄した実数を記録する。未使用品の記録上の数は減らさない。利用停止中の品目は新たに指定できない。必要なら登録情報の利用再開を確認する。')],
    run: (l, m, v) => recordReworkPart(l, m, { action: 'discard', reworkId: v.text('reworkId'), subjectLotId: v.text('subjectLotId'), item: v.text('item'), unit: v.text('unit'), value: partCount(v), reason: v.text('reason') }),
  },
  reworkRecover: {
    label: 'やり直し・修理で取り外した部品を回収',
    fields: () => [reworkField(), textField('newId', '回収品の新しいID'), ...itemFields(ledger.masters, null), locationField(), ...partCountFields(), h('p', {}, '実際に取り外して回収した数を、やり直し・修理と同じ案件・用途の新しい保管単位へ記録する。使用可否確認待ちを付け、確認するまで使える数に含めない。新しい保管単位を作るため、案件・用途・品目・場所が利用停止中なら回収を記録できない。必要なら登録情報の利用再開を確認する。')],
    run: (l, m, v) => recordReworkPart(l, m, { action: 'recover', reworkId: v.text('reworkId'), subjectLotId: v.text('subjectLotId'), lotId: v.text('newId'), item: v.text('item'), unit: v.text('unit'), location: v.text('location'), value: partCount(v), reason: v.text('reason') }),
  },
  inspect: stageStep('確認の完了', 'inspecting'),
  toNext: stageStep('次の作業へ渡す', 'awaitingHandover', true),
  stageFix: {
    label: '作業の状態の訂正',
    fields: () => [
      lotField(),
      textField('childId', '位置を変える分の新しいID'),
      ...amountFields(),
      choiceField('to', '正しい位置', (Object.keys(stageLabel) as Stage['kind'][]).map((k) => [k, stageLabel[k]])),
      selectField('process', '工程（作業なしから変えるときだけ）', [['', '今の工程のまま'], ...processes.map((p) => [p.id, `工程${p.id}`] as const)]),
    ],
    run: (l, m, v, inc) => {
      const lot = l.lots[v.text('lot')]!;
      const kind = v.text('to') as Stage['kind'];
      const process = processes.find((p) => p.id === v.text('process')) ?? (lot.stage.kind === 'none' ? undefined : lot.stage.process);
      if (kind !== 'none' && !process) throw new Error('作業なしから変えるときは工程を選ぶ');
      const to: Stage = kind === 'none' || !process ? noStage : { kind, process };
      const { basis, value } = amount(v);
      return changeStage(l, m, lot.id, v.text('childId'), basis, value, to, inc, true);
    },
  },
  stop: {
    label: '作業の中断',
    fields: () => [
      processField(),
      ...itemFields(ledger.masters),
      projectField(ledger.masters),
      textField('reason', '中断した理由'),
      ...shortageFields(),
      textField('shortageValue', '不足数（不明なら空欄）', 'number'),
      ...affectedFields(),
    ],
    run: (l, m, v) => {
      const raw = v.text('shortageValue').trim();
      const shortage = v.text('shortageItem') ? { item: v.text('shortageItem'), unit: v.text('shortageUnit'), value: raw === '' ? null : quantityValue(raw, v.step?.('shortageValue')) } : null;
      if (!shortage && (raw !== '' || v.text('shortageUnit') !== '')) throw new Error('不足数を入れるなら不足品目を選ぶ');
      const affected = countOrUnknown(v, 'affected', '影響数');
      return recordStop(l, m, { process: v.text('process'), item: v.text('item'), unit: v.text('unit'), project: projectOf(v), reason: v.text('reason'), shortage, affected });
    },
  },
  stopUpdate: {
    label: '中断した数の更新',
    fields: () => [openStopField(), ...affectedFields()],
    run: (l, m, v) => updateStop(l, m, v.text('stop'), countOrUnknown(v, 'affected', '影響数')),
  },
  resume: {
    label: '作業の再開（材料の受け取りとは別に記録）',
    fields: () => [openStopField()],
    run: (l, m, v) => resumeWork(l, m, v.text('stop')),
  },
  void: {
    label: '間違えた記録の取り消し（使用・引渡し）',
    fields: () => [
      choiceField(
        'target',
        '取り消す操作',
        historyChoices(ledger.history.filter((e) => (e.kind === 'use' || e.kind === 'handover') && !voidOf(ledger, e.eventId))),
      ),
      textField('reason', '取り消す理由'),
    ],
    run: (l, m, v) => voidRecord(l, m, v.text('target'), v.text('reason')),
  },
  use: {
    label: '使用',
    fields: () => [lotField(), ...amountFields(), textField('usedFor', '使用先の案件・用途・作業')],
    run: (l, m, v, inc) => {
      const { basis, value } = amount(v);
      return use(l, m, v.text('lot'), basis, value, v.text('usedFor'), inc);
    },
  },
  handover: {
    label: '外へ出す（譲渡・持ち出し）',
    fields: () => [lotField(), ...amountFields(), textField('counterpart', '相手先または処置')],
    run: (l, m, v, inc) => {
      const { basis, value } = amount(v);
      return handOver(l, m, v.text('lot'), basis, value, v.text('counterpart'), inc);
    },
  },
  move: {
    label: '移動（保管単位全部）',
    fields: () => [lotField(), locationField('移動先')],
    run: (l, m, v) => move(l, m, v.text('lot'), v.text('location')),
  },
  splitMove: {
    label: '一部を分けて移動',
    fields: () => [
      lotField(),
      textField('childId', '分けた分の新しいID'),
      ...amountFields(),
      locationField('移動先'),
    ],
    // 分割と移動は一つの入力なので、移動で失敗したら分割も台帳に残さない（FH-A03）。
    run: (l, m, v, inc) => {
      const { basis, value } = amount(v);
      const parted = split(l, m, v.text('lot'), v.text('childId'), basis, value, inc);
      return move(parted, { ...m, eventId: `${m.eventId}-m` }, v.text('childId'), v.text('location'));
    },
  },
  split: {
    label: '分割（同じ場所で分ける）',
    fields: () => [lotField(), textField('childId', '分けた分の新しいID'), ...amountFields()],
    run: (l, m, v, inc) => {
      const { basis, value } = amount(v);
      return split(l, m, v.text('lot'), v.text('childId'), basis, value, inc);
    },
  },
  transfer: {
    label: '案件・用途の付け替え（場所は変えない）',
    fields: () => [
      lotField('lot', '元案件・用途の保管単位', l => l.project.kind === 'case'),
      codeTarget(choiceField('toProject', '先案件・用途', Object.values(ledger.masters.cases).filter(c => c.active).map(c => [c.id, caseRef(ledger.masters, c.id)])), 'project'),
      textField('childId', '振替した分の新しいID'),
      ...amountFields(),
    ],
    run: (l, m, v, inc) => {
      const { basis, value } = amount(v);
      return transferProject(l, m, v.text('lot'), v.text('childId'), { kind: 'case', id: v.text('toProject') }, basis, value, inc);
    },
  },
  merge: {
    label: '統合',
    fields: () => [lotField('lot', '統合元'), lotField('target', '統合先')],
    run: (l, m, v) => merge(l, m, v.text('lot'), v.text('target')),
  },
  recount: {
    label: '数えて確認・訂正（原因不明でもよい）',
    fields: () => [
      codeTarget(choiceField('lot', '対象の保管単位', lotOptions()), 'lot'),
      textField('value', '保管単位全体を数えた数', 'number'),
      checkField('causeUnknown', '原因不明', true),
      textField('causeText', '原因の記述（原因不明でなければ）'),
    ],
    run: (l, m, v, inc) => {
      const raw = v.text('value').trim();
      if (raw === '') throw new Error('数えた数を入力する');
      return recount(l, m, v.text('lot'), quantityValue(raw, v.step?.('value')), cause(v), inc);
    },
  },
  hold: {
    label: '取り分ける（不良・使用可否確認待ち・返却待ち・予備）',
    fields: () => [lotField(), holdField(), textField('note', 'メモ（任意）')],
    run: (l, m, v) => hold(l, m, v.text('lot'), v.text('reason') as HoldReason, v.text('note') || undefined),
  },
  release: {
    label: '取り分けを戻す',
    fields: () => [lotField(), holdField(), textField('note', 'メモ（任意。予備を外すときは交換の理由が必要）')],
    run: (l, m, v) => release(l, m, v.text('lot'), v.text('reason') as HoldReason, v.text('note') || undefined),
  },
  declare: {
    label: '数の食い違いをメモする（数量は変えない）',
    fields: () => [lotField(), textField('note', '申告の内容')],
    run: (l, m, v) => declareDiscrepancy(l, m, v.text('lot'), v.text('note')),
  },
  provisional: {
    label: '仮の記録（適用先の保管単位が分からない）',
    fields: () => [
      choiceField('direction', '内容', [
        ['found', '見つかった'],
        ['removed', 'なくなった'],
      ]),
      codeTarget(selectField('item', '品目', [['', '不明'], ...itemOptions(ledger.masters)]), 'item', { quantity: 'value', basis: 'basis' }),
      codeTarget(selectField('location', '場所', [['', '不明'], ...placeOptions()]), 'location', { hold: 'location' }),
      ...amountFields(),
      textField('note', '備考（読取文字列等もそのまま）'),
    ],
    run: (l, m, v) => {
      const { basis, value } = amount(v);
      const direction = v.text('direction') === 'found' ? 'found' : 'removed';
      return recordProvisional(l, m, { direction, item: v.text('item') || null, location: v.text('location') || null, basis, value, note: v.text('note') });
    },
  },
  correctTime: {
    label: '実際の日時の訂正',
    fields: () => [
      choiceField(
        'target',
        '訂正する操作',
        historyChoices(ledger.history.filter((e) => e.kind !== 'correctTime'), true),
      ),
      textField('corrected', '正しい実際の日時（日本時間）', 'datetime-local'),
      checkField('correctedUnknown', '正しい実際の日時も不明'),
    ],
    run: (l, m, v) => {
      if (!v.checked('correctedUnknown') && v.text('corrected') === '') throw new Error('正しい実際の日時を入力するか、不明を選ぶ');
      return correctOccurredAt(l, m, v.text('target'), v.checked('correctedUnknown') ? null : fromLocal(v.text('corrected')));
    },
  },
  resolve: {
    label: '確認事項を片付ける',
    fields: () => [
      choiceField('issue', '確認事項', openIssues(ledger).map((i) => [i.id, `${i.id}：${issueLabel[i.reason]}（${i.lotId ?? '対象なし'}）`])),
      choiceField('outcome', '解消の仕方', [
        ['close', '閉じる（数量に反映済み・適用しない）'],
        ['apply', '適用する（保留した操作を親へ反映）'],
      ]),
    ],
    run: (l, m, v, inc) => {
      return resolveIssue(l, m, v.text('issue'), v.text('outcome') === 'apply' ? 'apply' : 'close', inc);
    },
  },
} satisfies Record<string, Op>;

const ctx: Ctx = { ledger: () => ledger, supply: () => supply, asOfChanged: () => renderFollowup() };

// 既存の台帳の操作は、台帳だけを更新する操作として包む。供給の操作は supply-ui が持つ。
const allOps: Record<string, UiOp> = {
  ...Object.fromEntries(
    Object.entries(ops).map(([key, op]): [string, UiOp] => [
      key,
      { label: op.label, fields: op.fields, run: (s, m, v, inc) => ({ state: { ...s, ledger: op.run(s.ledger, m, v, inc) } }) },
    ]),
  ),
  ...supplyOps(ctx),
  ...needImportOps(ctx),
  ...receiptTemplateOps(ctx),
  ...recipeStartOps(ctx),
  ...masterOps(ctx),
  ...returnIntakeOps(ctx),
};
// 受け入れた現物の数え直しでは、実際に受け取った数の扱いを必須で選ばせる（直し忘れを防ぐ）。
allOps['recount'] = recountWithReceiptChoice(allOps['recount']!, ctx);

let message: { kind: 'ok' | 'error'; text: string } | null = null;

function renderInput(): void {
  const root = section('input');
  liveInput = null;
  if (conflict !== null && conflict.kind !== 'resolved') {
    if (stale) root.append(h('p', {}, saveView.kind === 'replaceUncertain' ? '復元の途中で保存先の状態を確かめられなくなった。再読込してください。' : '別の画面で記録が保存された。再読込してください。'));
    root.append(h('p', {}, conflict.kind === 'saveFailed' ? '入力を退避できていません。元の入力をこの画面に残しています。再読込せず、上の更新競合の欄の元入力を転記してください。' : '未解消の更新競合があります。上の照合を終えるまで、新しい入力は作りません。'));
    if (conflict.kind === 'saveFailed' && heldForm !== null) root.append(heldForm);
    return;
  }
  heldForm = null;
  if (pending !== null || stale) {
    root.append(h('p', {}, stale ? (saveView.kind === 'replaceUncertain' ? '復元の途中で保存先の状態を確かめられなくなった。再読込してください。' : '別の画面で記録が保存された。再読込してください。') : '保存中の入力を照会・再試行・取りやめで確かめてから、新しい記録を入力してください。'));
    return;
  }
  const capture: FormCapture = { opId: nextOpIdOf(snapshot), op: allOps[currentOp]!, alternative: alternativeOperationOf(currentOp), baseRevision: snapshot.revision, epoch: resetEpoch, metadata: null, units: null, code: null };
  const picker = operationPicker(allOps, currentOp);
  const opSelect = picker.operation;
  opSelect.addEventListener('input', (event) => {
    if (currentOp === opSelect.value) event.stopPropagation();
  });
  opSelect.addEventListener('change', (event) => {
    if (currentOp === opSelect.value) { event.stopPropagation(); return; }
    currentOp = opSelect.value;
    message = null;
    renderInput();
    root.querySelector<HTMLSelectElement>('[name=op]')?.focus();
  });
  // 最初の選択肢が選ばれたまま再送すると、答えていないのに回答として扱われるので、空を先頭に置く。
  const inclusion = inclusionField('inclusion', '最後に数えた数に含まれていたか');
  // 衝突・重複の確認は、求められるまで隠す。確認したあとに入力を変えたら、確認をやり直させる。
  const confirm = checkField('confirmed', '確認した（上の内容を確かめたうえで記録する）');
  confirm.hidden = true;
  const form = h(
    'form',
    { 'aria-label': '操作の入力' },
    field('操作', opSelect),
    ...capture.op.fields(),
    ...alternativeFields(capture.alternative),
    textField('occurredAt', '実際の日時（日本時間）', 'datetime-local'),
    checkField('occurredUnknown', '実際の日時は不明'),
    inclusion,
    confirm,
    h('button', { type: 'submit' }, '記録する'),
  );
  (form.elements.namedItem('occurredAt') as HTMLInputElement).value = nowIso().slice(0, 16);
  for (const [box, input] of unknownPairs) exclusive(form, box, input);
  const confirmBox = confirm.querySelector('input')!;
  const resetConfirm = (event: Event) => {
    for (const box of form.querySelectorAll<HTMLInputElement>('[data-receipt-confirm]')) if (event.target !== box) box.checked = false;
    if (event.target === confirmBox) return;
    confirmBox.checked = false;
    confirm.hidden = true;
  };
  form.addEventListener('input', resetConfirm);
  form.addEventListener('change', resetConfirm);
  // 実際の日時が不明なら、台帳が判断に使う記録の時点（今）で絞る。
  const syncPlaces = () => restrictPlaces(form, ledger.masters, enteredTime(form));
  form.addEventListener('input', syncPlaces);
  form.addEventListener('change', syncPlaces);
  syncPlaces();
  precisionHints(form, ledger, supply);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void guarded(() => submit(form, !inclusion.hidden, capture));
  });
  capture.code = codeInput(form, ledger, capture.op.label, codeHolds);
  root.append(capture.code.node, picker.browsing, form);
  if (message) root.append(h('p', { class: message.kind === 'ok' ? '' : 'error', role: 'status' }, message.text));
  liveInput = { form, capture, initial: fieldsOf(controlsOf(form, capture.code)), initialActor: actorSelect.value, initialOccurredAt: occurredOf(form), baseLastWriter: snapshot.lastWriter, generation: generationOf(snapshot) };
}

// 「不明」のチェックと値の欄の組。両方があると、どちらかを黙って捨てることになる。
const unknownPairs = [
  ['occurredUnknown', 'occurredAt'],
  ['causeUnknown', 'causeText'],
  ['valueUnknown', 'value'],
  ['correctedUnknown', 'corrected'],
  ['affectedUnknown', 'affected'],
  ['codeNone', 'code'],
] as const;

// 最後に触った側を画面上で残す。チェックを入れれば値の欄を空にし、値を入れればチェックを外す。
function exclusive(form: HTMLFormElement, boxName: string, inputName: string): void {
  const box = form.elements.namedItem(boxName) as HTMLInputElement | null;
  const input = form.elements.namedItem(inputName) as HTMLInputElement | null;
  if (!box || !input) return;
  box.addEventListener('change', () => {
    if (box.checked) input.value = '';
  });
  input.addEventListener('input', () => {
    if (input.value !== '') box.checked = false;
  });
}

type FormCapture = { opId: string; op: UiOp; alternative: AlternativeOperation | null; baseRevision: number; epoch: number; metadata: { actor: string; recordedAt: string } | null; units: UnitState[] | null; code: CodeInput | null };

let persistenceBusy = false;
let sharedChangePending = false;
async function guarded(action: () => Promise<void>): Promise<void> {
  if (persistenceBusy) throw new Error('保存処理の完了を待ってください');
  persistenceBusy = true;
  const app = document.getElementById('app')!;
  const inert = app.inert;
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const focusOrigin = active?.closest('#save, #management-feedback, #input')?.id;
  app.inert = true;
  try { await action(); }
  finally {
    persistenceBusy = false; app.inert = inert;
    if (active?.isConnected) active.focus();
    else if (focusOrigin !== undefined) {
      const target = focusOrigin === 'input' ? document.querySelector<HTMLElement>('#input [name=op]')
        : document.getElementById(focusOrigin === 'save' ? 'save-h' : navigation.current === 'management' ? 'management-feedback-h' : `nav-${navigation.current}`);
      target?.focus();
    }
    if (sharedChangePending) void checkSharedChanges();
  }
}

async function checkSharedChanges(): Promise<void> {
  if (persistenceBusy) { sharedChangePending = true; return; }
  sharedChangePending = false;
  try {
    const current = await load(browserStore);
    if (current.kind !== 'ok') { if (current.kind === 'unreadable') stopUnreadable(current.reason); return; }
    if (!sameSnapshot(current.snapshot, snapshot) || generationOf(current.snapshot) !== generationOf(snapshot) || JSON.stringify(current.pending) !== JSON.stringify(pending)) {
      markStale('別の画面で記録が保存された'); saveView = { kind: 'conflict' }; resetRequest = null; renderAll();
    }
    if (generationOf(snapshot) !== null) { await refreshShared(); renderShared(); renderConflict(); }
  } catch (error) { sharedCaptureError = String(error); renderShared(); }
}

function inputValues(form: HTMLFormElement): { raw: Record<string, string | boolean>; readable: Record<string, string | boolean> } {
  const raw: Record<string, string | boolean> = {};
  const readable: Record<string, string | boolean> = {};
  for (const control of form.querySelectorAll('input, select, textarea')) {
    if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement)) continue;
    if (control.matches(':disabled')) continue;
    const value = control instanceof HTMLInputElement && control.type === 'checkbox' ? control.checked : control.value;
    raw[control.name] = value;
    const label = control.closest('label');
    if (control.name === 'op' || label?.hidden) continue;
    const text = label ? Array.from(label.childNodes).filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent ?? '').join('').trim() : control.name;
    readable[text] = control instanceof HTMLSelectElement ? control.selectedOptions[0]?.textContent ?? control.value : value;
  }
  return { raw, readable };
}

function showInputError(form: HTMLFormElement, text: string): void {
  const root = document.getElementById('input')!;
  root.querySelector('[role=status]')?.remove();
  message = { kind: 'error', text };
  if (form.isConnected) form.after(h('p', { class: 'error', role: 'status' }, text));
  else root.append(h('p', { class: 'error', role: 'status' }, text));
}

async function submit(form: HTMLFormElement, answered: boolean, capture: FormCapture): Promise<void> {
  message = null;
  document.querySelector('#input > [role=status]')?.remove();
  let openedBefore = 0;
  let notice: string | null = null;
  const control = (name: string) => form.elements.namedItem(name) as HTMLInputElement | null;
  const v: Values = { text: (name) => control(name)?.value ?? '', checked: (name) => control(name)?.checked ?? false, step: (name) => quantityStepFor(ledger.masters, quantityTargetOf(formValue(form), ledger, supply, name) ?? null) };
  const eventId = capture.opId;
  try {
    if (capture.epoch !== resetEpoch) throw new Error('初期化より前の入力は記録できない。現在の入力欄から記録する');
    if (stale) { saveView = { kind: 'conflict' }; renderSave(); throw new Error('別の画面で記録が保存された。再読込してください'); }
    if (pending !== null) throw new Error('保存中の入力を確かめてから、新しい記録を入力する');
    const values = inputValues(form);
    const scan = capture.code?.evidence();
    values.raw['scan'] = scan === undefined ? '' : JSON.stringify(scan);
    if (scan !== undefined) { values.readable['読取原文'] = scan.raw; values.readable['読取証拠'] = JSON.stringify(scan); }
    // 担当者が一人もいない台帳では、最初の担当者の登録だけを本人の名前で記録する。
    const noActors = Object.keys(ledger.masters.actors).length === 0;
    if (capture.metadata === null && noActors && capture.op !== allOps['masterActor']) throw new Error('最初に担当者（自分の名前）を登録する');
    const actor = noActors && capture.units === null ? v.text('name') : capture.metadata?.actor ?? actorSelect.value;
    if (capture.metadata === null && !noActors && !own(ledger.masters.actors, actor)?.active) throw new Error(`担当者「${actor}」は利用停止中、または登録されていない`);
    const fingerprint = fingerprintOf(capture.op.label, { ...values.raw, actor });
    if (capture.units !== null && capture.metadata !== null) {
      const result = await commit(browserStore, snapshot, { opId: eventId, opLabel: capture.op.label, fingerprint, values: values.readable, actor, startedAt: capture.metadata.recordedAt, savingSince: capture.metadata.recordedAt }, capture.units);
      await applyCommit(result, eventId);
      if (result.kind === 'mismatch') showInputError(form, `記録していない：${result.reason}`);
      renderSave();
      return;
    }
    if (capture.baseRevision !== snapshot.revision) throw new Error('この入力欄より後の記録がある。現在の入力欄から記録する');
    for (const [box, input] of unknownPairs) {
      if (v.checked(box) && v.text(input) !== '') throw new Error('「不明」と値の両方が入っている。どちらかにする');
    }
    for (const select of form.querySelectorAll<HTMLSelectElement>('select[data-required]:not(:disabled)')) {
      if (select.value === '') throw new Error(`${select.dataset['required']}を選ぶ`);
    }
    if (!v.checked('occurredUnknown') && v.text('occurredAt') === '') throw new Error('実際の日時を入力するか、不明を選ぶ');
    capture.metadata ??= { actor, recordedAt: nowIso() };
    if (noActors) capture.metadata.actor = actor;
    const meta: Meta = {
      eventId,
      occurredAt: v.checked('occurredUnknown') ? null : fromLocal(v.text('occurredAt')),
      ...capture.metadata,
      ...(scan === undefined ? {} : { scan }),
    };
    const answer = answered && v.text('inclusion') ? (v.text('inclusion') as Inclusion) : undefined;
    openedBefore = openIssues(ledger).length;
    const source = capture.alternative === null ? null : alternativeSourceOf(v);
    const alternativeItems = capture.alternative === 'receive' ? [v.text('item')]
      : capture.alternative === 'start' ? [v.text('item'), ...materialRows.flatMap(i => {
        const id = v.text(`m${i}lot`);
        if (id === '') return [];
        const lot = own(ledger.lots, id);
        if (!lot) throw new Error(`材料の保管単位 ${id} がない`);
        return [lot.item];
      })] : capture.alternative === null ? [] : (() => {
        const lot = own(ledger.lots, v.text('lot'));
        if (!lot) throw new Error('元の資料に対応する保管単位を選ぶ');
        return [lot.item];
      })();
    const staged = source !== null && capture.alternative !== null ? beginAlternativeRecord(ledger, meta, capture.alternative, source, alternativeItems) : ledger;
    const result = capture.op.run({ ledger: staged, supply }, meta, v, answer);
    let before = { ledger, supply };
    const units: UnitState[] = (result.units ?? [result.state]).map(state => {
      const unit = { ...state, conflictReviews: snapshot.conflictReviews, targets: targetsOf(before, state) };
      before = state;
      return unit;
    });
    // 保存層でも拒否するが、そこでは保存の失敗として出るので、入力の誤りとして保存前に知らせる。
    for (const unit of units) requireQuantityTotals(unit.ledger, unit.supply);
    saveView = { kind: 'ready' };
    saveError = '保存中';
    renderSave();
    const saved = await commit(browserStore, snapshot, { opId: eventId, opLabel: capture.op.label, fingerprint, values: { ...values.readable, '記録する人': actor }, actor, startedAt: meta.recordedAt, savingSince: meta.recordedAt }, units);
    const heldBefore = conflict;
    await captureRejectedInput(saved, eventId, units);
    await applyCommit(saved, eventId);
    if (conflict !== heldBefore) renderAll();
    if (saved.kind === 'unreadable') { renderAll(); return; }
    if (saved.kind === 'failed' || saved.kind === 'mismatch' || saved.kind === 'conflict') {
      if (saved.kind !== 'conflict' && liveInput?.form === form) liveInput.unsavedSend = true;
      showInputError(form, saved.kind === 'failed' ? `保存できなかった。入力内容を残している：${saved.reason}` : saved.kind === 'mismatch' ? `記録していない：${saved.reason}` : '別の画面で記録が保存された。再読込してください');
      renderSave();
      return;
    }
    capture.units = units;
    notice = result.notice ?? null;
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    form.parentElement?.querySelector('[role=status]')?.remove();
    if (err instanceof InclusionRequired) {
      const field = err instanceof MaterialInclusionRequired ? err.field : 'inclusion';
      (form.querySelector(`[name=${field}]`)!.parentElement as HTMLElement).hidden = false;
      showInputError(form, `回答が必要：${text}。選んでからもう一度「記録する」を押す。`);
    } else if (err instanceof ConfirmationRequired) {
      (form.querySelector('[name=confirmed]')!.parentElement as HTMLElement).hidden = false;
      showInputError(form, `確認が必要：${text}${err.kind === 'code' ? supplyRefsText(supply, ledger.masters, err.master) : candidatesText(ledger, err.lots)}。何も保存していない。内容を確かめ、「確認した」に印を付けてからもう一度「記録する」を押す。`);
    } else {
      showInputError(form, `記録していない：${text}`);
    }
    return;
  }
  // 負数や後入力で未反映になった操作があっても記録は成功と出るので、確認事項が開いたことをその場で知らせる（REC-05・UI-06）。
  const opened = openIssues(ledger).length - openedBefore;
  message = pending === null && !stale ? { kind: 'ok', text: `記録した（操作${eventId}）${opened > 0 ? `。確認事項が${opened}件開いた（未反映の操作がある）。確認が必要な記録で確認する` : ''}${notice ? `。${notice}` : ''}` } : null;
  renderAll();
}

function filteredLots(): Lot[] {
  return activeLots().filter(
    (l) =>
      (!filter.item || l.item === filter.item) &&
      (!filter.project || projectKey(l.project) === filter.project) &&
      (!filter.location || l.location === filter.location),
  );
}

function renderList(): void {
  const root = section('list');
  const filterSelect = (key: keyof typeof filter, label: string, options: [string, string][]) => {
    const node = selectField(`f-${key}`, label, [['', 'すべて'], ...options], filter[key]);
    node.addEventListener('change', (e) => {
      filter[key] = (e.target as HTMLSelectElement).value;
      renderList();
    });
    return node;
  };
  root.append(
    h(
      'div',
      { class: 'filters' },
      filterSelect('item', '品目', Object.values(ledger.masters.items).map((i) => [i.id, itemNameText(ledger.masters, i.id)])),
      filterSelect('project', '案件・用途', [...Object.values(ledger.masters.cases).map((c): Project => ({ kind: 'case', id: c.id })), { kind: 'common' } as const, { kind: 'unassigned' } as const].map((p) => [projectKey(p), projectText(ledger.masters, p)])),
      filterSelect('location', '場所', Object.values(ledger.masters.locations).map((l) => [l.id, `${l.name}（${l.code}）${l.active ? '' : '（利用停止）'}`])),
    ),
  );
  const lots = filteredLots();
  root.append(renderTotals(lots));
  const table = h(
    'table',
    { 'aria-label': '在庫の保管単位' },
    h('thead', {}, h('tr', {}, ...['ID', '品目', '案件・用途', '場所', '記録上の数と根拠', '取り分けた理由', '作業の状態', '最後に数えた数', '最終記録更新', '確認が必要'].map((t) => h('th', {}, t)))),
  );
  const body = h('tbody');
  for (const lot of lots) {
    const issues = openIssuesOf(ledger, lot.id);
    body.append(
      h(
        'tr',
        { class: lot.id === selectedLot ? 'selected' : '', 'data-lot': lot.id },
        h('td', {}, lotButton(lot.id)),
        h('td', {}, itemRef(ledger.masters, lot.item)),
        h('td', {}, projectText(ledger.masters, lot.project)),
        h('td', {}, locationRef(ledger.masters, lot.location)),
        h('td', {}, quantityText(lot.quantity, lot.unit)),
        h('td', {}, holdsText(lot)),
        h('td', {}, stageText(lot.stage)),
        h('td', {}, lastCountText(ledger, lot)),
        h('td', {}, jst(lastUpdatedOf(ledger, lot.id))),
        h('td', issues.length ? { class: 'warn' } : {}, issues.length ? `確認が必要 ${issues.length}件` : 'なし'),
      ),
    );
  }
  table.append(body);
  root.append(lots.length ? table : h('p', {}, '該当する保管単位はない（0個ではなく、記録がない）'));
  wrapTables(root);
}

function renderTotals(lots: Lot[]): HTMLElement {
  const list = h('ul', { 'aria-label': '絞り込んだ範囲の集計' });
  for (const t of totalsOf(ledger, lots)) list.append(h('li', t.issueCount ? { class: 'warn' } : {}, totalsText(ledger.masters, t)));
  return list;
}

function lotButton(id: string): HTMLButtonElement {
  const b = h('button', { type: 'button', class: 'link' }, id);
  b.addEventListener('click', () => {
    selectedLot = id;
    renderViews();
    navigation.select({ kind: 'detail' });
  });
  return b;
}

function renderDetail(): void {
  const root = section('detail');
  const targets = createHistoryTargetCollector({ ledger, supply });
  const lot = selectedLot ? ledger.lots[selectedLot] : undefined;
  if (!lot) {
    root.append(h('p', {}, '在庫一覧のIDを選ぶと、根拠と履歴を表示する。'));
    return;
  }
  const mergedFrom = Object.values(ledger.lots).filter((l) => l.mergedInto === lot.id);
  const children = Object.values(ledger.lots).filter((l) => l.splitFrom === lot.id);
  const issues = openIssuesOf(ledger, lot.id);
  const row = (term: string, ...desc: Child[]) => [h('dt', {}, term), h('dd', {}, ...desc)];
  root.append(
    h(
      'dl',
      { 'aria-label': `保管単位${lot.id}` },
      ...row('ID', lot.id),
      ...row('品目・単位', `${itemNameText(ledger.masters, lot.item)}（${itemRef(ledger.masters, lot.item)}）・${lot.unit}`),
      ...row('案件・用途', projectText(ledger.masters, lot.project)),
      ...row('場所', locationRef(ledger.masters, lot.location)),
      ...row('現在の記録上の数', quantityText(lot.quantity, lot.unit)),
      ...row('最後に数えた数', lastCountText(ledger, lot)),
      ...row('取り分けた理由', holdsText(lot)),
      ...row('作業の状態', stageText(lot.stage)),
      ...row('最終記録更新', jst(lastUpdatedOf(ledger, lot.id))),
      ...row('分割元', lot.splitFrom ? lotButton(lot.splitFrom) : 'なし'),
      ...row('分けた先', ...(children.length ? children.map((c) => lotButton(c.id)) : ['なし'])),
      ...row('統合先', lot.mergedInto ? lotButton(lot.mergedInto) : 'なし（集計の対象）'),
      ...row('統合元', ...(mergedFrom.length ? mergedFrom.map((c) => lotButton(c.id)) : ['なし'])),
    ),
  );
  if (lot.quantity.kind === 'known' && lot.quantity.computed) {
    root.append(h('p', {}, '現在の記録上の数は計算値で、この数を数えたわけではない。'));
  }
  if (issues.length) {
    root.append(h('p', { class: 'warn' }, `確認が必要 ${issues.length}件：${issues.map((i) => `${i.id}（${issueLabel[i.reason]}）`).join('、')}。記録上の数は直前の適用済みの値。`));
  }
  const materials = materialsOf(ledger, lot);
  if (materials !== null) {
    root.append(
      h('h3', {}, '作業の開始に使った材料の使用記録'),
      materials.length ? h('ul', {}, ...materials.map((e) => h('li', {}, `${e.eventId}　${eventText(ledger, e, targets)}`))) : h('p', {}, '対応付けた使用記録はない'),
    );
  }
  const reworks = reworkHistoryOf(ledger, lot);
  if (reworks.length > 0) root.append(h('h3', {}, 'やり直し・修理と部品処置（元の作業の開始材料と別）'), historyList(reworks, targets));
  root.append(h('h3', {}, '元記録（記録上の数の計算に使った記録）'), h('ul', {}, ...lot.quantity.terms.map((t) => h('li', {}, termText(t, lot.unit)))));
  root.append(h('h3', {}, 'この保管単位の履歴'), historyList(eventsOf(ledger, lot.id), targets));
  root.append(lotEvidencePanel(ledger, supply, lot.id));
}

function historyList(events: readonly LedgerEvent[], targets: HistoryTargetCollector = createHistoryTargetCollector({ ledger, supply })): HTMLElement {
  const list = h('ol', { reversed: '' });
  for (const e of [...events].reverse()) {
    const corrected = occurredAtOf(ledger, e.eventId) !== e.occurredAt ? `（訂正前 ${jst(e.occurredAt)}）` : '';
    list.append(
      h('li', {}, `${e.eventId}　発生 ${jst(occurredAtOf(ledger, e.eventId))}${corrected}　記録 ${jst(e.recordedAt)}　担当 ${e.actor}　${eventText(ledger, e, targets)}`),
    );
  }
  return list;
}

function renderIssues(): void {
  const root = section('issues');
  const targets = createHistoryTargetCollector({ ledger, supply });
  const all = Object.values(ledger.issues);
  const unknownAt = pending === null ? null : unknownSinceOf(pending);
  if (all.length === 0 && unknownAt === null && snapshot.saveChecks.length === 0) {
    root.append(h('p', {}, '確認事項はない'));
    return;
  }
  const table = h('table', { 'aria-label': '確認事項' }, h('thead', {}, h('tr', {}, ...['ID', '状態', '理由', '対象', '照合する内容・操作', '解消結果'].map((t) => h('th', {}, t)))));
  const body = h('tbody');
  for (const issue of [...all].sort((a, b) => Number(a.resolution !== null) - Number(b.resolution !== null))) {
    const origin = originOf(ledger, issue.id);
    const r = issue.resolution;
    body.append(
      h(
        'tr',
        { 'data-issue': issue.id },
        h('td', {}, issue.id),
        h('td', r ? {} : { class: 'warn' }, r ? '解消済み' : '確認が必要（未解決）'),
        h('td', {}, issueLabel[issue.reason]),
        h('td', {}, issue.lotId ? lotButton(issue.lotId) : '対象なし（仮の記録）'),
        h('td', {}, origin ? eventText(ledger, origin, targets) : ''),
        h('td', {}, r ? `${r.outcome === 'apply' ? '適用' : '閉じた'}（${r.actor}、${jst(occurredAtOf(ledger, r.eventId))}、操作${r.eventId}）` : '未解決'),
      ),
    );
  }
  if (pending !== null && unknownAt !== null) {
    body.append(h('tr', { 'data-save-issue': pending.opId },
      h('td', {}, pending.opId), h('td', { class: 'warn' }, '確認が必要（未解決）'), h('td', {}, '保存結果不明'),
      h('td', {}, [...new Set(pending.units.flatMap(unit => unit.targets))].map(targetLabel).join('、')),
      h('td', {}, `${pending.opLabel}（操作ID：${pending.opId}）。担当 ${pending.actor}、開始 ${jst(unknownAt)}。保存されたかは照会で確認する`),
      h('td', {}, '未解決。保存の状態から照会・再試行・取りやめ')));
  }
  const outcomeText = { saved: '保存済みだった', retried: '再試行で保存した', remainderAbandoned: '未保存の残りを取りやめた', abandoned: '未保存のまま取りやめた' };
  for (const check of snapshot.saveChecks) {
    body.append(h('tr', { 'data-save-issue': check.opId },
      h('td', {}, check.opId), h('td', {}, '解消済み'), h('td', {}, '保存結果不明'),
      h('td', {}, `保存済み：${check.savedTargets.map(targetLabel).join('、') || 'なし'}／未保存：${check.unsavedTargets.map(targetLabel).join('、') || 'なし'}`),
      h('td', {}, `${check.opLabel}（操作ID：${check.opId}）、開始 ${jst(check.openedAt)}`),
      h('td', {}, `${outcomeText[check.resolution.outcome]}（確認者 ${check.resolution.actor}、確認日時 ${jst(check.resolution.at)}）`)));
  }
  table.append(body);
  root.append(table);
}

// 工程ごとの工程内・完成（渡す前）と、履歴から求めた累計を分けて示す（MFG-01b）。中断台数は工程内数の内数として書く（11章）。
function renderProduction(): void {
  const root = section('production');
  const groups = productionGroupsOf(ledger);
  const stops = Object.values(ledger.stops);
  if (groups.length === 0 && stops.length === 0) {
    root.append(h('p', {}, '工程内の仕掛品と作業の中断はない'));
    return;
  }
  const list = h('ul', { 'aria-label': '工程ごとの数' });
  for (const g of groups) {
    const p = productionOf(ledger, g.process, g.item, g.unit, g.project);
    const stopped = stops
      .filter((s) => s.resumedBy === null && s.process === g.process && s.item === g.item && s.unit === g.unit && projectKey(s.project) === projectKey(g.project))
      .map((s) => {
        const excess = stopExcessOf(ledger, s);
        return `中断${s.id} ${affectedText(s.affected, g.unit)}${excess ? `（警告：中断した数${excess.affected}が工程内数${excess.total}を超えている。中断した数を更新する）` : ''}`;
      });
    // 保留した位置の変更は親から減らさず子だけを作るので、集計の数は直前の適用済みの値。確定した数として断定しない（04章・DESIGN_NOTES）。
    const issueCount = productionIssuesOf(ledger, g).length;
    const returned = p.returned.kind === 'known' && p.returned.numeric.value === 0 ? '' : `／訂正で工程内へ戻した数 ${cumulativeText(p.returned, g.unit)}（完了累計から引かない）`;
    list.append(
      h(
        'li',
        issueCount ? { class: 'warn' } : {},
        `工程${g.process}・品目${itemRef(ledger.masters, g.item)}（${g.unit}）・${projectText(ledger.masters, g.project)}：工程内 ${quantityText(p.inProcess, g.unit)}` +
          `（作業中 ${quantityText(p.working, g.unit)}、確認待ち ${quantityText(p.inspecting, g.unit)}）` +
          `${stopped.length ? `、うち ${stopped.join('、')}` : ''}` +
          `／完成（渡す前） ${quantityText(p.awaitingHandover, g.unit)}／工程完了累計 ${cumulativeText(p.completed, g.unit)}／やり直し・修理開始累計 ${cumulativeText(p.reworkStarted, g.unit)}（現在の現物数には足さない）／引渡済み累計 ${cumulativeText(p.handedOver, g.unit)}${returned}${issueCount ? `。確認が必要 ${issueCount}件：この数を確定した製造の数として断定しない` : ''}`,
      ),
    );
  }
  root.append(list);
  if (stops.length) {
    root.append(
      h('h3', {}, '中断'),
      h(
        'ul',
        { 'aria-label': '中断の記録' },
        ...stops.map((s) => h('li', {}, `${s.id}：${stopText(ledger.masters, s)}。${s.resumedBy ? `作業の再開済み（操作${s.resumedBy}）` : '中断中'}`)),
      ),
    );
  }
}

// 見るだけの操作では入力欄を作り直さない。包含の回答を求めている途中でも、入力を残したまま根拠を確かめられる（AT-22）。
function renderViews(): void {
  const last = lastRecordedAt();
  document.getElementById('updated')!.textContent = `最終記録更新：${last ? jst(last) : 'なし'}`;
  renderList();
  renderProduction();
  renderDetail();
  renderIssues();
  renderSupply(ctx);
  renderCase();
  renderFollowup();
  renderConsumables(ctx);
  renderMasters();
  section('history').append(historyList(ledger.history));
  wrapTables(appRoot);
  syncNavigation();
}

function wrapTables(root: HTMLElement): void {
  for (const table of root.querySelectorAll('table')) {
    if (table.parentElement?.classList.contains('table-scroll')) continue;
    const wrapper = h('div', { class: 'table-scroll', tabindex: '0', role: 'region', 'aria-label': `${table.getAttribute('aria-label') ?? '表'}（横スクロール）` });
    table.before(wrapper);
    wrapper.append(table);
  }
}

function syncNavigation(): void {
  navigation.setIssueCount(openIssues(ledger).length + (pending !== null && unknownSinceOf(pending) !== null ? 1 : 0));
  navigation.setReadable(saveView.kind !== 'unreadable');
}

// 元入力はタブ内に保持し、回収を有効にした保存先では共有退避にも控える。
const draftSource = (): Storage => window.sessionStorage;
// unsavedSend：このフォームの送信が未保存で戻った（failed・外部更新のないmismatch）。後の外部更新で退避するとき、送信前の入力と区別する。
type LiveInput = { form: HTMLFormElement; capture: FormCapture; initial: ConflictField[]; initialActor: string; initialOccurredAt: string | null; baseLastWriter: string; generation: string | null; unsavedSend?: true };
let liveInput: LiveInput | null = null;
let heldForm: HTMLFormElement | null = null;
let conflict: PanelState | null = null;
let conflictRaw: string | null = null;
let sharedRows: ArchiveRow[] = [];
let sharedSelected: ArchiveRow | null = null;
let sharedCaptureBusy = false;
let sharedCaptureError: string | null = null;
let sharedRefreshEpoch = 0;

async function refreshShared(): Promise<void> {
  const epoch = ++sharedRefreshEpoch, before = snapshot, shown = conflict, raw = conflictRaw, generation = generationOf(before);
  if (generation === null) return;
  const current = () => epoch === sharedRefreshEpoch && before === snapshot && generation === generationOf(snapshot) && shown === conflict && raw === conflictRaw;
  const rows = await recoveryRows(repository());
  if (!current()) return;
  sharedRows = rows;
  sharedSelected = raw === null ? null : sharedRows.find(row => row.key === sharedSelected?.key) ?? null;
  if (raw !== null && shown?.kind === 'unresolved') {
    const key = identityKey(await openEntry(raw));
    if (!current()) return;
    sharedSelected = sharedRows.find(row => row.key === key) ?? null;
    if (sharedSelected?.kind === 'valid' && sharedSelected.entry.kind === 'terminal') {
      const terminal = sharedSelected.entry;
      const review = before.conflictReviews.find(review => review.reviewId === terminal.reviewId);
      const matches = review !== undefined && await hashText(canonical(review)) === terminal.proof;
      if (!current()) return;
      const done = clearDraft(draftSource, shown.draft.reviewId, raw);
      if (done.kind !== 'cleared') sharedCaptureError = done.reason;
      else if (terminal.disposition === 'withdraw' || !matches) {
        conflict = null; conflictRaw = null; withdrawnNotice = 'この元入力には保存済みの解消・取下げ記録があります。未解消として再表示しません。';
      }
    }
  }
}
async function archiveLocalDraft(raw: string): Promise<void> {
  if (generationOf(snapshot) === null || sharedCaptureBusy) return;
  sharedCaptureBusy = true; sharedCaptureError = null;
  try {
    for (let attempt = 0; ; attempt++) {
      try { await captureShared(repository(), raw); break; }
      catch (error) { if (attempt === 1) throw error; }
    }
  } catch (error) { sharedCaptureError = `共有退避に保存できません。タブを閉じず原文を控えてください：${error instanceof Error ? error.message : String(error)}`; }
  finally {
    try { await refreshShared(); } catch (error) { sharedCaptureError = String(error); }
    sharedCaptureBusy = false; renderShared(); renderConflict();
  }
}
function renderShared(): void {
  document.getElementById('shared-recovery')?.remove();
  const generation = generationOf(snapshot);
  if (generation === null) return;
  const panel = sharedRecoveryPanel(sharedRows, generation, {
    export: row => download(`fuzzy-stock_競合原文_${Date.now()}.json`, row.kind === 'valid' && row.entry.kind === 'open' ? row.entry.raw : row.encoded, 'application/json'),
    select: row => {
      if (row.kind !== 'valid' || row.entry.kind !== 'open' || row.draft === null) return;
      const local = readDraft(draftSource);
      if (hasEditedLiveInput() || conflict?.kind === 'saveFailed' || conflict?.kind === 'unreadable' || local.kind === 'unreadable' || (local.kind === 'ready' && local.raw !== row.entry.raw)) {
        sharedCaptureError = 'この画面に残っている入力・退避を先に確認してください。回収する元入力へ切り替えていません'; renderShared(); return;
      }
      if (conflictRaw !== null && conflictRaw !== row.entry.raw && conflict?.kind !== 'resolved') { sharedCaptureError = '現在表示中の元入力を先に照合してください'; renderShared(); return; }
      conflict = { kind: 'unresolved', draft: row.draft }; conflictRaw = row.entry.raw; sharedSelected = row; resetConflictInput(); renderAll();
    },
    withdraw: (row, copied) => { void guarded(async () => {
      const shown = conflict;
      try { await withdrawShared(repository(), snapshot, row, copied, actorSelect.value, nowIso(), generation); await refreshShared(); if (conflict !== shown) renderAll(); else { renderShared(); renderConflict(); } }
      catch (error) { sharedCaptureError = `取り下げていません：${error instanceof Error ? error.message : String(error)}`; renderShared(); }
    }); },
  });
  if (sharedCaptureBusy) panel.append(h('p', {}, '元入力を共有退避に保存しています。'));
  if (sharedCaptureError !== null) {
    panel.append(h('p', { class: 'error' }, sharedCaptureError));
    if (conflictRaw !== null) {
      const retryCapture = h('button', { type: 'button' }, '共有退避を再試行する');
      retryCapture.addEventListener('click', () => { if (conflictRaw !== null) void archiveLocalDraft(conflictRaw); });
      panel.append(retryCapture);
    }
  }
  document.getElementById('conflict')!.before(panel);
}
let conflictCopied = false;
let conflictConfirmed: ConfirmationBasis | null = null;
let conflictDecision: Decision = { outcome: null, reason: '', actor: '' };
let conflictBusy = false;
let conflictMessage: string | null = null;
// 直前の照合結果の保存がnative容量不足で失敗し、未保存と確かめた候補の基準。このタブのメモリにだけ持ち、再読込で消える。
let quotaFailure: ConfirmationBasis | null = null;
// 「共有の照合記録を残さずに取り下げる」を確認した時点の退避の原文・写し・世代。実行時に同じであることを要求する。
let withdrawFixed: { raw: string; reviewId: string; snapshotKey: string; epoch: number; offered: 'budget' | 'quota' } | null = null;
let withdrawnNotice: string | null = null;
const snapshotIds = new WeakMap<Snapshot, number>();
let snapshotCount = 0;
// 写し全体の変更を、オブジェクトの同一性で表す。読み直しで別の写しになれば確認は失効する（安全側）。
function snapshotKey(): string {
  let id = snapshotIds.get(snapshot);
  if (id === undefined) { id = ++snapshotCount; snapshotIds.set(snapshot, id); }
  return `${id}:${snapshot.revision}:${snapshot.lastWriter}`;
}

function controlsOf(form: HTMLFormElement, code: CodeInput | null): ControlLike[] {
  const controls: ControlLike[] = [];
  for (const control of form.querySelectorAll('input, select, textarea')) {
    if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement)) continue;
    if (control instanceof HTMLInputElement && (['submit', 'button', 'reset'].includes(control.type) || (control.type === 'hidden' && !control.dataset['conflictLabel']))) continue;
    const label = control.closest('label');
    if (label?.hidden) continue;
    const labelText = control.dataset['conflictLabel'] ?? (label === null ? '' : Array.from(label.childNodes).filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent ?? '').join('').trim());
    const files = control instanceof HTMLInputElement && control.type === 'file' ? Array.from(control.files ?? [], file => file.name) : [];
    controls.push({ type: control.type, name: control.name, label: labelText, value: control.value,
      checked: control instanceof HTMLInputElement && control.type === 'checkbox' ? control.checked : false,
      selectedText: control instanceof HTMLSelectElement ? control.selectedOptions[0]?.textContent ?? control.value : '',
      fileNames: files, readState: readStateOf(control, files.length) });
  }
  // フォームの外にあるコード入力補助の読取原文も、変更の判定と参照資料に含める。
  const codeInputs = code?.reference() ?? { raw: '', query: '', target: '' };
  if (code !== null) {
    controls.push({ type: 'text', name: 'codeRaw', label: 'コード入力補助の読取原文', value: codeInputs.raw, checked: false, selectedText: '', fileNames: [], readState: 'unread' });
    controls.push({ type: 'text', name: 'codeQuery', label: 'コード入力補助の検索語', value: codeInputs.query, checked: false, selectedText: '', fileNames: [], readState: 'unread' });
    controls.push({ type: 'text', name: 'codeTarget', label: 'コード入力補助の入力先の選択', value: codeInputs.target, checked: false, selectedText: '', fileNames: [], readState: 'unread' });
  }
  return controls;
}
// ファイルの読取状態は、読取を行う部品が欄に記録した値を使う。選択だけで原文が空なら、読み終えていない扱い。
function readStateOf(control: HTMLElement, count: number): ControlLike['readState'] {
  const state = control.dataset['readState'];
  if (count === 0) return 'unread';
  return state === 'read' || state === 'failed' || state === 'reading' ? state : 'reading';
}
function occurredOf(form: HTMLFormElement): string | null {
  const unknown = form.elements.namedItem('occurredUnknown');
  const entered = (form.elements.namedItem('occurredAt') as HTMLInputElement | null)?.value ?? '';
  return (unknown instanceof HTMLInputElement && unknown.checked) || entered === '' ? null : fromLocal(entered);
}
function evidenceOf(live: LiveInput): ConflictEvidence[] {
  const evidence: ConflictEvidence[] = [];
  for (const input of live.form.querySelectorAll<HTMLInputElement>('input[name=needRaw]')) if (input.value !== '') evidence.push({ kind: 'needRaw', raw: input.value });
  // 採用済みで対象の確認前の証拠も、参照用に残す（送信用のevidenceは確認前に例外を投げる）。
  const scan = live.capture.code?.reference().adopted;
  if (scan !== undefined) evidence.push({ kind: 'scan', raw: JSON.stringify(scan) });
  return evidence;
}

// 外部の更新を検出して記録を止める（stale）前に、変更のある入力を捕捉する。再描画がフォームを消す前に必ず通す。
function markStale(reason: string): void {
  captureLiveInput({ kind: 'unsent' }, reason);
  stale = true;
}

function hasEditedLiveInput(): boolean {
  const live = liveInput;
  return live !== null && live.form.isConnected && (JSON.stringify(fieldsOf(controlsOf(live.form, live.capture.code))) !== JSON.stringify(live.initial)
    || live.initialActor !== actorSelect.value || live.initialOccurredAt !== occurredOf(live.form));
}

function holdForm(form: HTMLFormElement): void {
  for (const control of form.querySelectorAll('input, select, textarea, button')) (control as HTMLInputElement).disabled = true;
  heldForm = form;
}

// 外部更新の通知や書込前の拒否で、フォームを消す前に元入力を捕捉する。すでに未解消の入力があれば上書きしない。
function captureLiveInput(origin: ConflictOrigin, reason: string, targets: readonly string[] = []): void {
  const live = liveInput;
  if ((conflict !== null && conflict.kind !== 'resolved') || live === null || !live.form.isConnected) return;
  const rejected = origin.kind === 'rejected';
  const source: CaptureSource = { initial: live.initial, fields: fieldsOf(controlsOf(live.form, live.capture.code)), initialActor: live.initialActor, actor: actorSelect.value,
    initialOccurredAt: live.initialOccurredAt, occurredAt: occurredOf(live.form), origin, opKey: currentOp, opLabel: live.capture.op.label,
    baseRevision: live.capture.baseRevision, baseLastWriter: live.baseLastWriter, detectedAt: nowIso(), detectedReason: reason, readEvidence: evidenceOf(live),
    targets: rejected ? targets : [], unapplied: [rejected ? 'この送信は書込前に拒否・数量へ未反映' : live.unsavedSend ? '前回の送信は保存されていない・数量へ未反映' : '未送信・数量へ未反映'] };
  const made = captureDraft(source, () => crypto.randomUUID());
  if (made.kind === 'unchanged') return;
  if (made.kind === 'kept') {
    // 識別子を作れないときも入力は消さない。表示用の仮の識別子で転記用に示し、退避は成立させない。
    const fallback = captureDraft(source, () => `unsaved-${Date.now()}`);
    if (fallback.kind === 'captured') { conflict = { kind: 'saveFailed', draft: fallback.draft, reason: made.reason }; holdForm(live.form); }
    return;
  }
  const written = writeDraft(draftSource, made.draft, live.generation ?? undefined);
  if (written.kind === 'retained') { conflict = { kind: 'unresolved', draft: made.draft }; conflictRaw = written.raw; resetConflictInput(); void archiveLocalDraft(written.raw); }
  else { conflict = { kind: 'saveFailed', draft: made.draft, reason: written.reason }; holdForm(live.form); }
}

// 外部更新のない内容不一致では、更新競合と推測して元入力を退避しない。
async function captureRejectedInput(result: CommitResult, opId: string, units: readonly UnitState[]): Promise<void> {
  const targets = units.flatMap(unit => unit.targets);
  if (result.kind === 'conflict') { captureLiveInput({ kind: 'rejected', opId, attemptedAt: nowIso(), reason: 'snapshotChanged' }, '送信の保存前検査で外部の更新を検出した', targets); return; }
  if (result.kind !== 'mismatch') return;
  // 書込前の拒否の直後に、保存先の最新の版を読み直して外部の更新の有無を判断する（読むだけで保存先は変えない）。
  const head = await load(browserStore);
  if (head.kind === 'ok' && !sameSnapshot(head.snapshot, snapshot)) captureLiveInput({ kind: 'rejected', opId, attemptedAt: nowIso(), reason: 'identityCollision' }, '送信の保存前検査で外部の更新と操作IDの内容不一致を検出した', targets);
}

function resetConflictInput(): void {
  conflictCopied = false; conflictConfirmed = null; conflictMessage = null; quotaFailure = null; withdrawFixed = null; withdrawnNotice = null;
  conflictDecision = { outcome: null, reason: '', actor: actorSelect.value };
}

function restoreConflict(): void {
  const read = readDraft(draftSource);
  if (read.kind === 'ready') { conflict = { kind: 'unresolved', draft: read.draft }; conflictRaw = read.raw; resetConflictInput(); }
  else if (read.kind === 'unreadable') { conflict = { kind: 'unreadable', raw: read.raw, reason: read.reason }; resetConflictInput(); }
}

// 保存済みの照合記録が元入力と全文一致して読み戻せたときだけ、タブ内の退避を削除して確定済みの表示にする。
function finalizeConflict(): void {
  // 初期化・復元で写しが置き換わり、表示していた確定済みの照合記録が保存先に無くなったら、古い表示を残さない。
  if (conflict?.kind === 'resolved') {
    const shown = JSON.stringify(conflict.review);
    if (!snapshot.conflictReviews.some(review => JSON.stringify(review) === shown)) conflict = null;
  }
  if (conflict?.kind !== 'unresolved' || pending !== null || stale) return;
  if (generationOf(snapshot) !== null && !(sharedSelected?.kind === 'valid' && sharedSelected.entry.kind === 'terminal' && sharedSelected.entry.disposition === 'review')) return;
  const { draft } = conflict;
  const review = snapshot.conflictReviews.find(r => r.reviewId === draft.reviewId);
  if (review === undefined) return;
  if (JSON.stringify(review.draft) !== JSON.stringify(draft)) { conflictMessage = '同じ元入力に、内容の違う照合結果がすでに保存されています。退避した元入力は残しています。'; return; }
  if (conflictRaw !== null) {
    const cleared = clearDraft(draftSource, draft.reviewId, conflictRaw);
    conflictMessage = cleared.kind === 'cleared' ? null : `照合結果は保存済みですが、タブ内の退避を削除できませんでした：${cleared.reason}`;
  }
  conflict = { kind: 'resolved', review }; conflictRaw = null;
}

function conflictHold(): string | null {
  if (stale) return '別の画面で記録が保存されました。再読込してから照合してください';
  if (pending !== null) return '保存中・結果不明の操作を、照会・再試行・取りやめで確かめてから照合してください';
  if (generationOf(snapshot) !== null) {
    if (sharedCaptureBusy || sharedSelected?.kind !== 'valid') return '元入力の共有退避が完了してから照合してください';
    if (sharedSelected.entry.generation !== generationOf(snapshot)) return '元の台帳世代が異なります。原文を控え、現在の記録と別に照合してください';
  }
  const reviewId = conflict?.kind === 'unresolved' ? conflict.draft.reviewId : null;
  if (snapshot.conflictReviews.some(review => review.reviewId === reviewId)) return '同じ元入力の照合結果がすでに保存されています。別の結果では保存しません';
  return conflictBusy ? '照合結果を保存しています' : null;
}
function currentBasis(): ConfirmationBasis | null {
  return conflict?.kind === 'unresolved' ? basisOf(conflict.draft, snapshotKey(), resetEpoch, conflictDecision) : null;
}

// 現在の写しに対して、いまの決定で保存したときの照合記録の使用量。結果が未選択でも、二つの結果の文字列は同じ長さなので使用量は変わらない。
// reasonOnlyは、理由を最短の有効な一文字にすれば上限内に収まる（理由を短くすれば記録できる）こと。理由は空にできないので、空で測らない。
function candidateUsage(): (ReturnType<typeof reviewUsage> & { reasonOnly: boolean }) | null {
  if (conflict?.kind !== 'unresolved') return null;
  const { outcome, reason, actor } = conflictDecision, { draft } = conflict;
  const usage = (text: string) => reviewUsage(snapshot.conflictReviews, { eventId: nextOpIdOf(snapshot), reviewId: draft.reviewId, draft,
    resolution: { outcome: outcome ?? 'reenter', reason: text, actor, at: nowIso() } });
  const full = usage(reason);
  return { ...full, reasonOnly: full.over && !usage('x').over };
}

// 容量で照合結果を記録できないときだけ、記録なしの取下げを提示する。保存を止める理由（再読込待ち・保存中の操作・同じ元入力の結果）があれば提示しない。
function withdrawOffer(): 'budget' | 'quota' | null {
  if (conflict?.kind !== 'unresolved' || conflictRaw === null || conflictHold() !== null) return null;
  const usage = candidateUsage();
  if (usage?.over === true && !usage.reasonOnly) return 'budget';
  const current = currentBasis();
  return quotaFailure !== null && current !== null && confirmationStale(quotaFailure, current) === null ? 'quota' : null;
}
function withdrawStale(): boolean {
  const fixed = withdrawFixed;
  return fixed !== null && (conflict?.kind !== 'unresolved' || fixed.raw !== conflictRaw || fixed.reviewId !== conflict.draft.reviewId || fixed.snapshotKey !== snapshotKey() || fixed.epoch !== resetEpoch || withdrawOffer() !== fixed.offered);
}

// 台帳・供給の記録と、保存結果の解消・照合の記録を更新に数える（UI-07）。
function lastRecordedAt(): string | null {
  return [ledger.history.at(-1)?.recordedAt, supply.log.at(-1)?.recordedAt, ...snapshot.saveChecks.map(c => c.resolution.at), ...snapshot.conflictReviews.map(r => r.resolution.at)]
    .filter((x): x is string => x !== undefined).reduce<string | null>((latest, at) => latest === null || Date.parse(at) > Date.parse(latest) ? at : latest, null);
}

// 保存先に確定している照合記録を、業務操作の履歴とは別に一覧する（復元・再読込のあとも参照できる）。原文はtextContentだけで示す。
let reviewsOpen = false;
// 写しに書けていても、保存中・結果不明の操作の照合記録は照会・再試行・取りやめで確かめるまで確定済みと示さない。
function confirmedReviews(): readonly ConflictReview[] {
  return snapshot.conflictReviews.filter(review => review.eventId !== pending?.opId);
}
function confirmedReviewsNode(): HTMLElement {
  const reviews = confirmedReviews();
  const none = { outcome: null, reason: '', actor: '' };
  const shown = conflict?.kind === 'resolved' ? JSON.stringify(conflict.review) : null;
  const node = h('details', reviewsOpen ? { open: '' } : {}, h('summary', {}, `確定した照合記録（${reviews.length}件${shown === null ? '' : '。うち1件は上に表示中'}・業務操作の履歴とは別に数えます）`), ...reviews.filter(review => JSON.stringify(review) !== shown).map(review => conflictPanelNode(
    panelModel({ state: { kind: 'resolved', review }, latest: null, decision: none, copied: false, confirmed: null, snapshotKey: snapshotKey(), epoch: resetEpoch }),
    { decision: none, copied: false, confirmedChecked: false, actors: [] }, conflictHandlers)));
  node.addEventListener('toggle', () => { reviewsOpen = node.open; });
  return node;
}

function renderConflict(): void {
  const root = section('conflict');
  root.hidden = conflict === null && confirmedReviews().length === 0 && withdrawnNotice === null;
  if (conflict === null) {
    if (withdrawnNotice !== null) root.append(h('p', { role: 'status' }, withdrawnNotice));
    if (confirmedReviews().length > 0) root.append(confirmedReviewsNode());
    return;
  }
  const current = currentBasis();
  const why = current === null ? null : confirmationStale(conflictConfirmed, current);
  if (why !== null) { conflictConfirmed = null; conflictMessage = why; }
  if (withdrawStale()) { withdrawFixed = null; conflictMessage = '確認後に記録・入力・容量の状態が変わったため、取下げの確認をやり直してください。'; }
  const offered = withdrawOffer();
  const actors = Object.values(ledger.masters.actors).filter(a => a.active).map(a => a.id);
  if (!actors.includes(conflictDecision.actor)) conflictDecision = { ...conflictDecision, actor: actors.includes(actorSelect.value) ? actorSelect.value : actors[0] ?? '' };
  const model = panelModel({ state: conflict, latest: stale ? null : { revision: snapshot.revision, lastWriter: snapshot.lastWriter, recordedAt: lastRecordedAt(), summary: `在庫の保管単位${Object.keys(ledger.lots).length}件・履歴${ledger.history.length}件・照合記録${snapshot.conflictReviews.length}件${snapshot.conflictReviews.length === confirmedReviews().length ? '' : '（うち保存結果を確認中の1件）'}（業務操作の履歴とは別に数えます）` },
    decision: conflictDecision, copied: conflictCopied, confirmed: conflictConfirmed, snapshotKey: snapshotKey(), epoch: resetEpoch, hold: conflictHold(),
    capacity: candidateUsage(), withdraw: offered === null ? null : { offered, ack: withdrawFixed !== null } });
  root.append(conflictPanelNode(model, { decision: conflictDecision, copied: conflictCopied, confirmedChecked: conflictConfirmed !== null, actors, withdrawAck: withdrawFixed !== null }, conflictHandlers));
  if (conflictMessage !== null) root.append(h('p', { class: 'error', role: 'status' }, conflictMessage));
  if (confirmedReviews().length > 0) root.append(confirmedReviewsNode());
}

function invalidateConfirmation(): void { conflictConfirmed = null; }
const conflictHandlers: PanelHandlers = {
  setCopied: value => { conflictCopied = value; invalidateConfirmation(); renderConflict(); },
  setConfirmed: value => {
    const made = currentBasis();
    if (value && made === null) { conflictConfirmed = null; conflictMessage = '解消の結果を選んでから確認してください'; }
    else { conflictConfirmed = value ? made : null; conflictMessage = null; }
    renderConflict();
  },
  setOutcome: value => { conflictDecision = { ...conflictDecision, outcome: value }; invalidateConfirmation(); renderConflict(); },
  setReason: value => { conflictDecision = { ...conflictDecision, reason: value }; invalidateConfirmation(); },
  setActor: value => { conflictDecision = { ...conflictDecision, actor: value }; invalidateConfirmation(); renderConflict(); },
  confirm: () => { void guarded(resolveConflict); },
  discardUnreadable: discardUnreadableConflict,
  setWithdrawAck: value => {
    const offered = withdrawOffer();
    withdrawFixed = value && offered !== null && conflict?.kind === 'unresolved' && conflictRaw !== null
      ? { raw: conflictRaw, reviewId: conflict.draft.reviewId, snapshotKey: snapshotKey(), epoch: resetEpoch, offered } : null;
    renderConflict();
  },
  withdraw: () => { void guarded(withdrawConflict); },
  reload: () => {
    if (sharedCaptureBusy) { conflictMessage = '共有退避の保存完了を待ってから再読込してください'; renderConflict(); }
    else if (conflict?.kind === 'saveFailed') { conflictMessage = '入力を退避できていないため、再読込すると入力が消えます。表示している元入力を転記してください'; renderConflict(); }
    else window.location.reload();
  },
};

function discardUnreadableConflict(): void {
  if (conflict?.kind !== 'unreadable' || conflict.raw === null || !conflictCopied) return;
  const done = discardUnreadableDraft(draftSource, conflict.raw);
  if (done.kind === 'cleared') { conflict = null; conflictRaw = null; conflictMessage = null; }
  else conflictMessage = `読めない退避を取り下げられませんでした（原文は残しています）：${done.reason}`;
  renderAll();
}

// 容量で記録できない有効な退避を、共有の記録へ何も書かずにこのタブから取り下げる。実行直前に保存先を読み直し、提示時と同じ状態であることを要求する。
async function withdrawConflict(): Promise<void> {
  const state = conflict, fixed = withdrawFixed;
  if (state?.kind !== 'unresolved' || fixed === null || !conflictCopied) return;
  if (withdrawStale()) { withdrawFixed = null; conflictMessage = '確認後に記録・入力・容量の状態が変わったため、取り下げませんでした。確認をやり直してください。'; renderConflict(); return; }
  const loaded = await load(browserStore);
  if (loaded.kind !== 'ok' || loaded.pending !== null || loaded.recovered !== null || !sameSnapshot(loaded.snapshot, snapshot)) {
    withdrawFixed = null;
    if (loaded.kind === 'ok' && !sameSnapshot(loaded.snapshot, snapshot)) markStale('記録なし取下げの前の確認で外部の更新を検出した');
    else if (loaded.kind === 'ok') await readback();
    conflictMessage = '保存先が変わった、または保存中の操作があるため、取り下げませんでした。元入力は残しています。再読込して確かめてください。';
    renderAll();
    return;
  }
  const generation = generationOf(snapshot);
  if (generation !== null) {
    try {
      if (sharedSelected === null) throw new Error('共有退避を確認できません');
      await withdrawShared(repository(), snapshot, sharedSelected, conflictCopied, actorSelect.value, nowIso(), generation);
      await refreshShared(); renderAll();
    } catch (error) { conflictMessage = `取り下げていません：${error instanceof Error ? error.message : String(error)}`; renderConflict(); }
    return;
  }
  const done = clearDraft(draftSource, state.draft.reviewId, fixed.raw);
  if (done.kind === 'cleared') {
    conflict = null; conflictRaw = null; resetConflictInput();
    withdrawnNotice = 'このタブの退避を記録せずに取り下げました。照合済みではありません。共有の照合記録・確認者・解消結果は残っていません。';
  } else conflictMessage = `退避を取り下げられませんでした（元入力は残しています）：${done.reason}`;
  renderAll();
}

function reviewSaveMessage(result: CommitResult): string | null {
  switch (result.kind) {
    case 'failed': return result.quota === true ? `保存先の容量が不足して照合結果を保存できませんでした（容量の上限の超過ではありません。未保存です）。元入力は残しています：${result.reason}`
      : `照合結果を保存できませんでした（元入力は残しています）：${result.reason}`;
    case 'mismatch': return `照合結果を保存できませんでした（元入力は残しています）：${result.reason}`;
    case 'unknown': case 'partial': return '照合結果の保存結果が不明です。上の「保存の状態」で照会・再試行・取りやめを選んでください。元入力は残しています。';
    case 'conflict': return '別の画面で記録が保存されました。再読込してから照合してください。元入力は残しています。';
    default: return null;
  }
}

// 最新の記録を確認した利用者の決定を、通常の保存単位（一単位・一記録）として一回だけ保存する。
async function resolveConflict(): Promise<void> {
  const state = conflict;
  if (state?.kind !== 'unresolved' || conflictBusy) return;
  const held = conflictHold();
  if (held !== null) { conflictMessage = held; renderConflict(); return; }
  const { reason, actor } = conflictDecision;
  const basis = currentBasis();
  const staleWhy = basis === null ? null : confirmationStale(conflictConfirmed, basis);
  if (basis === null || conflictConfirmed === null || staleWhy !== null || !conflictCopied || reason.trim() === '' || actor.trim() === '') {
    if (staleWhy !== null) invalidateConfirmation();
    conflictMessage = staleWhy ?? '元入力を控え、最新の記録を確認し、結果・理由・確認者を入れてから保存してください';
    renderConflict();
    return;
  }
  if (candidateUsage()?.over === true) { conflictConfirmed = null; conflictMessage = '照合記録の容量の上限を超えるため、保存しませんでした（何も書き込んでいません）。元入力は残しています。'; renderConflict(); return; }
  const epoch = resetEpoch, key = snapshotKey();
  conflictBusy = true; quotaFailure = null;
  try {
    const review = parseConflictReview({ eventId: nextOpIdOf(snapshot), reviewId: state.draft.reviewId, draft: state.draft,
      resolution: { outcome: basis.outcome, reason, actor, at: nowIso() } });
    const fingerprint = await conflictReviewFingerprint(review);
    // 非同期の計算のあいだに、写し・世代・保存中の操作・未解消の入力・確認が変わっていないか再検査する。
    const after = currentBasis();
    if (resetEpoch !== epoch || snapshotKey() !== key || conflict !== state || stale || pending !== null || !conflictCopied || conflictConfirmed === null || after === null || confirmationStale(basis, after) !== null) {
      throw new Error('計算中に記録または入力が変わったため、確認をやり直してください');
    }
    const unit: UnitState = { ledger, supply, conflictReviews: [...snapshot.conflictReviews, review], targets: [] };
    unit.targets.push(...targetsOf(snapshot, unit));
    const op = { opId: review.eventId, opLabel: reviewOpLabel, fingerprint, values: reviewPendingValues(review), actor, startedAt: review.resolution.at, savingSince: review.resolution.at };
    const result = await commit(browserStore, snapshot, op, [unit]);
    await applyCommit(result, op.opId);
    await refreshShared();
    if (result.kind === 'failed' && result.quota === true && pending === null) quotaFailure = basis;
    conflictMessage = reviewSaveMessage(result);
  } catch (error) {
    conflictMessage = `照合結果を保存できませんでした（元入力は残しています）：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    // 確定しなかった候補は、未保存でも結果不明でも失効させる。次の候補は明示の再確認から最新の操作ID・確認日時で作る。
    conflictBusy = false; conflictConfirmed = null;
    renderAll();
  }
}

function renderAll(): void {
  finalizeConflict();
  renderShared();
  const unreadable = saveView.kind === 'unreadable';
  actorSelect.disabled = unreadable;
  document.getElementById('actor-unavailable')!.hidden = !unreadable;
  if (!unreadable) renderActors();
  renderSave();
  if (unreadable) {
    document.getElementById('updated')!.textContent = '最終記録更新：保存記録を読み込めないため確認できません。';
    document.getElementById('conflict')!.hidden = true;
    const input = document.getElementById('input')!;
    for (const child of input.children) if (child instanceof HTMLElement && child.id !== 'input-h') child.hidden = true;
    const explanation = document.getElementById('input-unavailable') ?? h('p', { id: 'input-unavailable' }, '保存記録を読み込めないため、新しい記録を入力できません。上部の保存の状態から回復操作を選んでください。');
    explanation.hidden = false;
    input.append(explanation);
    return;
  }
  renderConflict();
  renderViews();
  renderInput();
  renderGettingStarted();
}

// 案内は入力欄の操作を切り替えるだけで、記録を作らない。
function renderGettingStarted(): void {
  const { actors, locations, items } = ledger.masters;
  const steps = [
    { op: 'masterActor', label: '担当者（自分の名前）を登録する', done: Object.keys(actors).length > 0 },
    { op: 'masterLocation', label: '置き場所を登録する', done: Object.keys(locations).length > 0 },
    { op: 'masterItem', label: '品目と単位を登録する', done: Object.keys(items).length > 0 },
  ];
  const root = section('getting-started');
  root.hidden = steps.every(step => step.done);
  if (root.hidden) return;
  const next = steps.find(step => !step.done)!;
  const open = h('button', { type: 'button' }, '入力欄で開く');
  open.addEventListener('click', () => {
    currentOp = next.op; message = null; renderInput();
    document.querySelector<HTMLSelectElement>('#input [name=op]')?.focus();
  });
  root.append(
    h('p', {}, '記録を始める前に、次の順で登録してください。その後、現物の登録で在庫を記録します。'),
    h('ol', {}, ...steps.map(step => h('li', {}, `${step.label}：${step.done ? '登録済み' : '未登録'}`, ...(step === next ? [' ', open] : [])))),
  );
}

function renderCase(): void {
  const root = section('case');
  const cases = Object.values(ledger.masters.cases);
  if (!cases.some((c) => c.id === selectedProject)) selectedProject = cases.find((c) => c.active)?.id ?? cases[0]?.id ?? '';
  const choice = selectField('case-project', '表示する案件・用途', cases.map((c) => [c.id, caseRef(ledger.masters, c.id)]), selectedProject);
  choice.addEventListener('change', event => {
    if (event.target instanceof HTMLSelectElement) selectedProject = event.target.value;
    renderCase();
  });
  root.append(choice, caseDetailPanel(ledger, supply, selectedProject, id => { selectedLot = id; renderViews(); navigation.select({ kind: 'detail' }); }));
  wrapTables(root);
}

function renderMasters(): void {
  const root = section('masters');
  root.append(...mastersPanel(ledger, selectedMaster, (key) => { selectedMaster = key; renderMasters(); }));
  wrapTables(root);
}

function renderFollowup(): void {
  const root = section('followup');
  root.append(followupPanel(ledger, supply, supplyAsOf()));
  wrapTables(root);
}

function stopUnreadable(reason: string): void {
  saveView = { kind: 'unreadable', reason };
  renderAll();
}

async function readback(): Promise<void> {
  const loaded = await load(browserStore);
  if (loaded.kind === 'unreadable') { stopUnreadable(loaded.reason); return; }
  if (loaded.kind !== 'ok') { stopUnreadable('保存済みの写しが見つからない。再読込してください'); return; }
  useSnapshot(loaded.snapshot);
  if (loaded.recovered !== null) { pending = null; saveView = { kind: 'recovered', check: loaded.recovered }; }
  else pending = loaded.pending ?? pending;
}

async function applyCommit(result: CommitResult, opId: string): Promise<void> {
  saveError = null;
  switch (result.kind) {
    case 'unreadable':
      stopUnreadable(result.reason); break;
    case 'saved':
      useSnapshot(result.snapshot); pending = null; saveView = { kind: 'saved', opId }; break;
    case 'duplicate':
      useSnapshot(result.snapshot); pending = null; saveView = { kind: 'duplicate', opId, ...(result.remainder === undefined ? {} : { remainder: result.remainder }) }; break;
    case 'partial':
      useSnapshot(result.snapshot); pending = result.pending; saveView = pendingView(result.pending, { snapshot: result.snapshot, savedUnits: result.saved, total: result.total }, result.reason);
      if (saveView.kind === 'unknown') saveError = `処理を完了できなかった：${result.reason}`;
      break;
    case 'unknown':
      pending = result.pending; saveView = { ...result, inquiry: null }; await readback(); break;
    case 'recovered':
      useSnapshot(result.snapshot); pending = null; saveView = { kind: 'recovered', check: result.check }; break;
    case 'failed':
      if (pending === null) saveView = result;
      else saveError = `処理を完了できなかった：${result.reason}`;
      break;
    case 'mismatch': {
      const head = await load(browserStore);
      if (head.kind === 'ok' && !sameSnapshot(head.snapshot, snapshot)) {
        markStale('保存の応答で外部の更新と操作IDの内容不一致を検出した');
        invalidateConfirmation();
        saveView = { kind: 'conflict' };
      }
      saveError = result.reason;
      break;
    }
    case 'conflict': markStale('保存の応答で外部の更新を検出した'); saveView = result; break;
    default: { const exhaustive: never = result; return exhaustive; }
  }
}

async function applySettlement(result: SettleResult, original: Pending): Promise<void> {
  if (result.kind === 'settled') {
    useSnapshot(result.snapshot); pending = null; saveError = null;
    saveView = { ...result, pending: original };
  } else await applyCommit(result, original.opId);
}

async function pendingAction(action: 'inquire' | 'retry' | 'abandon' | 'confirmSaved'): Promise<void> {
  const original = pending;
  if (original === null || stale) return;
  try {
    if (action === 'inquire') {
      const inquiry = await inquire(browserStore, original);
      useSnapshot(inquiry.snapshot);
      if (saveView.kind === 'unknown' || saveView.kind === 'partial') saveView = { ...saveView, inquiry };
      saveError = null;
    } else {
      // 最初の担当者の登録を確かめる時点では選べる担当者がいないため、登録しようとした本人を記録する。
      const actor = Object.keys(ledger.masters.actors).length === 0 ? original.actor : actorSelect.value;
      const at = nowIso();
      if (action === 'retry') await applyCommit(await retry(browserStore, snapshot, original, actor, at), original.opId);
      else await applySettlement(action === 'abandon' ? await abandon(browserStore, snapshot, original, actor, at) : await confirmSaved(browserStore, snapshot, original, actor, at), original);
    }
  } catch (error) {
    saveError = `処理を完了できなかった：${error instanceof Error ? error.message : String(error)}`;
    await readback();
  }
  try { await refreshShared(); } catch (error) { sharedCaptureError = String(error); }
  renderAll();
}

const saveActions: SaveActions = {
  inquire: () => { void guarded(() => pendingAction('inquire')); }, retry: () => { void guarded(() => pendingAction('retry')); }, abandon: () => { void guarded(() => pendingAction('abandon')); }, confirmSaved: () => { void guarded(() => pendingAction('confirmSaved')); },
  reload: () => conflictHandlers.reload(),
  unreadableReset: () => askReset('空の台帳', () => ({ ledger: emptyLedger, supply: emptySupply }), true),
  unreadableRestore: () => chooseRestoreFile(true),
};

function renderSave(): void {
  syncNavigation();
  const active = document.activeElement;
  const focusOrigin = active !== null && document.getElementById('management-feedback')!.contains(active) ? 'management'
    : active !== null && document.getElementById('save')!.contains(active) ? 'recovery' : null;
  const root = section('save');
  root.classList.toggle('save-compact', saveView.kind === 'ready' && saveError === null && notice === null && resetRequest === null && (conflict === null || conflict.kind === 'resolved') && conflictMessage === null && withdrawnNotice === null);
  const management = section('management-feedback');
  const target = (origin: FeedbackOrigin) => origin === 'management' ? management : root;
  root.append(savePanel(saveView, saveActions, saveError));
  if (notice !== null) target(noticeOrigin).append(h('p', { 'aria-live': 'polite', class: 'notice' }, notice));
  if (resetRequest !== null) {
    const epoch = resetEpoch;
    const request = resetRequest;
    target(resetOrigin).append(resetPanel(request, () => {
      if (resetRequest !== request) return;
      restoreSelection++;
      resetRequest = null; resetFailure = null;
      if (resetEpoch === epoch) renderSave();
      else renderAll();
    }, resetFailure));
  }
  if (focusOrigin !== null && active !== null && !active.isConnected) {
    const id = focusOrigin === 'recovery' ? 'save-h' : navigation.current === 'management' ? 'management-feedback-h' : `nav-${navigation.current}`;
    document.getElementById(id)!.focus();
  }
}

function askReset(label: string, next: () => RecordContents, unreadable = false): void {
  askReplace((run, current) => requestReset(label, run, current), next, unreadable, '初期化した');
}

const xlsxType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function download(name: string, content: string | Uint8Array<ArrayBuffer>, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = h('a', { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const blockedFor = (action: string): string => `保存結果不明・一部だけ保存した入力を、照会・再試行・取りやめで確かめてから${action}してください。`;

async function saveBackup(): Promise<void> {
  notice = null;
  noticeOrigin = 'management';
  if (stale) { saveView = { kind: 'conflict' }; notice = savePresentation(saveView).lines.join(' '); renderSave(); return; }
  if (pending !== null) { notice = `バックアップを作らなかった。${blockedFor('バックアップ')}`; renderSave(); return; }
  const loaded = await load(browserStore);
  if (loaded.kind === 'unreadable') { notice = `バックアップを作れない：保存された記録を読み込めない（理由：${loaded.reason}）`; stopUnreadable(loaded.reason); return; }
  if (loaded.kind !== 'ok' || loaded.recovered !== null || !sameSnapshot(loaded.snapshot, snapshot)) { markStale('バックアップを作る前の確認で外部の更新を検出した'); saveView = { kind: 'conflict' }; notice = savePresentation(saveView).lines.join(' '); renderAll(); return; }
  if (loaded.pending !== null) { notice = `バックアップを作らなかった。${blockedFor('バックアップ')}`; renderSave(); return; }
  try {
    const at = nowIso();
    const name = backupFileName(at);
    download(name, await sharedBackupText(repository(), loaded.snapshot, at), 'application/json');
    notice = backupResultText(name, recordCountsOf(loaded.snapshot));
  } catch (error) {
    notice = `バックアップを作れなかった：${error instanceof Error ? error.message : String(error)}`;
  }
  renderSave();
}

const restoreInput = document.getElementById('backup-file') as HTMLInputElement;

// 部品の読み込みは、配信が混み合うと通信の失敗で落ちることがある。ブラウザーは失敗した読み込みを同じURLでは覚えたままにするので、
// やり直すときは問い合わせ文字列を変えて別のURLとして読む。
let moduleRead = 0;
function importWithRetry(name: 'xlsx'): Promise<typeof import('./xlsx.ts')>;
function importWithRetry(name: 'viewsheets'): Promise<typeof import('./viewsheets.ts')>;
async function importWithRetry(name: 'xlsx' | 'viewsheets'): Promise<typeof import('./xlsx.ts') | typeof import('./viewsheets.ts')> {
  const read = ++moduleRead;
  for (let attempt = 0; ; attempt++) {
    try { return await import(new URL(`./${name}.js${attempt === 0 ? '' : `?retry=${read}-${attempt}`}`, import.meta.url).href); }
    catch (error) {
      if (attempt >= 4) throw error;
      await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
}

// 閲覧用の出力。保存先も画面の状態も変えない。xlsxを書くSheetJSは、使うときだけ読み込む。
async function exportView(): Promise<void> {
  notice = null;
  try {
    const [{ xlsxOf }, { viewSheetsOf }] = await Promise.all([importWithRetry('xlsx'), importWithRetry('viewsheets')]);
    const at = nowIso();
    const name = viewFileName(at);
    download(name, xlsxOf(viewSheetsOf({ ledger, supply }, at)), xlsxType);
    notice = `閲覧用の出力を書き出した（${name}）。復元には使えない`;
  } catch (error) {
    notice = `閲覧用の出力を作れなかった：${error instanceof Error ? error.message : String(error)}`;
  }
  noticeOrigin = 'management';
  renderSave();
}

const actorSelect = document.getElementById('actor') as HTMLSelectElement;
actorSelect.addEventListener('change', () => {
  for (const box of document.querySelectorAll<HTMLInputElement>('#input [data-receipt-confirm]')) box.checked = false;
});

// 担当者の選択肢は利用中の担当者だけ（USR-03）。選んでいた担当者が利用中なら、描き直しても選んだままにする。
function renderActors(): void {
  const current = actorSelect.value;
  const active = Object.values(ledger.masters.actors).filter((a) => a.active).map((a) => a.id);
  actorSelect.replaceChildren(...(active.length === 0 ? [h('option', { value: '' }, '未登録')] : active.map((a) => h('option', { value: a }, a))));
  if (active.includes(current)) actorSelect.value = current;
}
const { askReplace, chooseRestoreFile, cancelRestoreFile, restoreFileChosen } = restoreSelectionOf({
  get snapshot() { return snapshot; },
  get pending() { return pending; }, set pending(value) { pending = value; },
  get stale() { return stale; }, set stale(value) { if (value && !stale) markStale('復元の確認で外部の更新を検出した'); else stale = value; },
  get resetEpoch() { return resetEpoch; }, set resetEpoch(value) { resetEpoch = value; },
  get saveView() { return saveView; }, set saveView(value) { saveView = value; },
  get saveError() { return saveError; }, set saveError(value) { saveError = value; },
  get resetRequest() { return resetRequest; }, set resetRequest(value) { resetRequest = value; },
  get resetOrigin() { return resetOrigin; }, set resetOrigin(value) { resetOrigin = value; },
  get notice() { return notice; }, set notice(value) { notice = value; },
  get noticeOrigin() { return noticeOrigin; }, set noticeOrigin(value) { noticeOrigin = value; },
  get restoreFromUnreadable() { return restoreFromUnreadable; }, set restoreFromUnreadable(value) { restoreFromUnreadable = value; },
  get restoreSelection() { return restoreSelection; }, set restoreSelection(value) { restoreSelection = value; },
  get resetFailure() { return resetFailure; }, set resetFailure(value) { resetFailure = value; },
  get selectedLot() { return selectedLot; }, set selectedLot(value) { selectedLot = value; },
  get message() { return message; }, set message(value) { message = value; },
  get conflictBlock() {
    if (conflict === null || conflict.kind === 'resolved') return null;
    const next = conflict.kind === 'saveFailed' ? '画面に残している元入力を転記し、退避できない原因を直してから' : conflict.kind === 'unreadable' ? '更新競合の欄で、読めない退避の原文を控えて取り下げてから' : '更新競合の欄で照合を終えてから';
    return `未解消の更新競合の入力があるため、初期化・復元はしません。${next}行ってください。`;
  },
}, restoreInput, browserStore, { renderSave, renderAll, useSnapshot, stopUnreadable, blockedFor,
  clearCodeHolds: () => { codeHolds.project = null; codeHolds.location = null; },
}, { load, replace, confirmedUnreadableReset, inquireReplacement, guard: guarded });

document.getElementById('reset-seed')!.addEventListener('click', () => askReset('固定の架空データ', () => ({ ledger: seedLedger(), supply: emptySupply })));
document.getElementById('reset-scn02')!.addEventListener('click', () => askReset('SCN-02の架空データ', seedScn02));
document.getElementById('reset-empty')!.addEventListener('click', () => askReset('空の台帳', () => ({ ledger: emptyLedger, supply: emptySupply })));
document.getElementById('reset-practice')!.addEventListener('click', () => askReset('練習用の台帳（架空の登録情報入り）', () => ({ ledger: practiceLedger, supply: emptySupply })));
document.getElementById('backup-save')!.addEventListener('click', () => { void guarded(saveBackup); });
document.getElementById('shared-enable')!.addEventListener('click', () => {
  if (hasEditedLiveInput()) { notice = '入力中の内容を先に記録するか、原文を控えてください。保存方式は変更していません'; noticeOrigin = 'management'; renderSave(); return; }
  if (!window.confirm('他のタブを閉じ、バックアップを控えてから有効にしてください。保存方式を切り替え、旧版へ自動では戻しません。有効にしますか。')) return;
  void guarded(async () => {
    try { await repository().enable(snapshot); window.location.reload(); }
    catch (error) { notice = error instanceof Error ? error.message : String(error); noticeOrigin = 'management'; renderSave(); }
  });
});
document.getElementById('shared-raw')!.addEventListener('click', () => {
  void guarded(async () => {
    try { download(`fuzzy-stock_原資料控え_${Date.now()}.json`, JSON.stringify(await repository().inspectRaw()), 'application/json'); }
    catch (error) { notice = `原資料を控えられない：${error instanceof Error ? error.message : String(error)}`; noticeOrigin = 'management'; renderSave(); }
  });
});
document.getElementById('backup-restore')!.addEventListener('click', () => chooseRestoreFile(false));
document.getElementById('view-export')!.addEventListener('click', () => { void exportView(); });
restoreInput.addEventListener('cancel', cancelRestoreFile);
restoreInput.addEventListener('change', () => { void restoreFileChosen(); });
window.addEventListener('storage', event => {
  if (event.key !== null && event.key !== 'fuzzy-stock/head' && event.key !== 'fuzzy-stock/pending') return;
  // フォームを消す再描画の前に、変更のある入力を元入力として捕捉する。
  markStale('別の画面で記録が保存された');
  saveView = { kind: 'conflict' }; resetRequest = null; renderAll();
});
if (typeof BroadcastChannel !== 'undefined') {
  try {
    const changes = new BroadcastChannel('fuzzy-stock-shared/changes');
    changes.addEventListener('message', event => {
      const data: unknown = event.data;
      if (typeof data === 'object' && data !== null && 'client' in data && data.client !== authorityClient) void checkSharedChanges();
    });
  } catch { /* 通知を使えなくても保存と起動を止めない。操作前・再表示時に照会する。 */ }
}
window.addEventListener('focus', () => { void checkSharedChanges(); });
setupTestHooks(window);
// 退避できていない入力があるあいだは、ブラウザーの再読込・閉じる操作の前に確認を求める。
window.addEventListener('beforeunload', event => { if (conflict?.kind === 'saveFailed' || sharedCaptureBusy || sharedCaptureError !== null) event.preventDefault(); });
{
  const loaded = await load(browserStore);
  if (loaded.kind === 'unreadable') saveView = loaded;
  else if (loaded.kind === 'ok') {
    useSnapshot(loaded.snapshot); pending = loaded.pending;
    if (loaded.recovered !== null) saveView = { kind: 'recovered', check: loaded.recovered };
    else if (pending !== null) {
      if (pending.progress === 'partial') {
        try {
          const inquiry = await inquire(browserStore, pending);
          saveView = pendingView(pending, inquiry);
        } catch (error) { saveView = { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) }; }
      } else saveView = { kind: 'unknown', pending, inquiry: null };
    }
  } else {
    try { useSnapshot(await replace(browserStore, null, { ledger: emptyLedger, supply: emptySupply })); }
    catch (error) { saveView = { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) }; }
  }
}
restoreConflict();
if (generationOf(snapshot) !== null) {
  if (conflictRaw !== null) await archiveLocalDraft(conflictRaw);
  else { try { await refreshShared(); } catch (error) { sharedCaptureError = String(error); } }
}
document.getElementById('shared-enable')!.hidden = generationOf(snapshot) !== null;
document.getElementById('shared-status')!.textContent = generationOf(snapshot) === null ? 'タブ終了後の入力回収：未有効' : 'タブ終了後の入力回収：有効';
renderAll();
