import { parseConflictDraft, reviewLimits, type ConflictDraft, type ConflictEvidence, type ConflictField, type ConflictOrigin, type ConflictReview } from './conflictrecord.ts';
import { targetLabel } from './format.ts';

// 更新競合の元入力の捕捉と、未解消・確定済みの表示を決める。DOM・保存先には触れない（保存は呼出側が行う）。
// 入力原文は文字列のまま渡し、HTMLとして解釈する表示部品を作らない。表示側はtextContentで描く。

// フォームの一つの欄から読んだ値（DOMに依存しない形）。DOMからこの形への変換は薄い層（main.ts）に置き、実Edgeで確かめる。
export type ControlLike = { type: string; name: string; label: string; value: string; checked: boolean; selectedText: string; fileNames: readonly string[]; readState: 'unread' | 'reading' | 'read' | 'failed' };

// 表示順の欄の列へ変換する。名称なし・重複名の欄も辞書にせず順に残す。
export function fieldsOf(controls: readonly ControlLike[]): ConflictField[] {
  return controls.map((c): ConflictField => {
    const base = { name: c.name, label: c.label };
    switch (c.type) {
      case 'checkbox': return { kind: 'checkbox', ...base, checked: c.checked };
      case 'select-one': case 'select': return { kind: 'select', ...base, value: c.value, text: c.selectedText };
      case 'file': return { kind: 'file', ...base, names: [...c.fileNames], readState: c.readState };
      default: return { kind: 'text', ...base, value: c.value };
    }
  });
}

export type CaptureSource = {
  initial: readonly ConflictField[]; fields: readonly ConflictField[];
  initialActor: string; actor: string; initialOccurredAt: string | null; occurredAt: string | null;
  origin: ConflictOrigin; opKey: string; opLabel: string; baseRevision: number; baseLastWriter: string | null;
  detectedAt: string; detectedReason: string; readEvidence: readonly ConflictEvidence[]; targets: readonly string[]; unapplied: readonly string[];
};
export type CaptureResult =
  | { kind: 'unchanged' }
  | { kind: 'captured'; draft: ConflictDraft }
  // 識別子を作れない、または検査を通らないときは、入力を消さず画面に残して送信を止める。
  | { kind: 'kept'; reason: string };

// 初期値から変更された欄だけを元入力にする。検出時刻・検出理由は入力の変更に数えない。
export function captureDraft(source: CaptureSource, newId: () => string): CaptureResult {
  const changed = JSON.stringify(source.fields) !== JSON.stringify(source.initial) || source.actor !== source.initialActor || source.occurredAt !== source.initialOccurredAt;
  if (!changed) return { kind: 'unchanged' };
  let reviewId: string;
  try {
    reviewId = newId();
    if (typeof reviewId !== 'string' || reviewId.trim() === '') throw new Error('識別子が空');
  } catch (error) { return { kind: 'kept', reason: `識別子を作れないため入力を退避できない（${error instanceof Error ? error.message : String(error)}）` }; }
  try {
    return { kind: 'captured', draft: parseConflictDraft({ reviewId, origin: source.origin, opKey: source.opKey, opLabel: source.opLabel, actor: source.actor,
      occurredAt: source.occurredAt, baseRevision: source.baseRevision, baseLastWriter: source.baseLastWriter, detectedAt: source.detectedAt, detectedReason: source.detectedReason,
      fields: source.fields, readEvidence: source.readEvidence, targets: source.targets, unapplied: source.unapplied }) };
  } catch (error) { return { kind: 'kept', reason: `入力を退避用の形に直せない（${error instanceof Error ? error.message : String(error)}）` }; }
}

export type PanelState =
  | { kind: 'unresolved'; draft: ConflictDraft }
  | { kind: 'saveFailed'; draft: ConflictDraft; reason: string }
  | { kind: 'unreadable'; raw: string | null; reason: string }
  | { kind: 'resolved'; review: ConflictReview };
export type LatestRecord = { revision: number; lastWriter: string; recordedAt: string | null; summary: string };
export type Decision = { outcome: 'reenter' | 'dismiss' | null; reason: string; actor: string };
// 確認を成立させた時点の基準。ここに含めた値のどれかが変われば確認は失効する。
// snapshotKeyは保存先の写し全体を表す文字列（例：直列化した写し）。版や最終操作IDが同じでも、写しの内容が変われば値が変わるものを渡す。
export type ConfirmationBasis = { reviewId: string; draftRaw: string; snapshotKey: string; epoch: number; outcome: 'reenter' | 'dismiss'; reason: string; actor: string };
export type PanelAction = { name: 'copied' | 'confirm' | 'discardUnreadable' | 'reload' | 'withdrawAck' | 'withdraw'; label: string; enabled: boolean; blockedBy?: string };
export type PanelSection = { heading: string; lines: readonly string[] };
export type PanelModel = { status: string; sections: readonly PanelSection[]; actions: readonly PanelAction[] };

const originText = (origin: ConflictOrigin): string => origin.kind === 'unsent'
  ? '未送信（保存していない入力のまま、外部の更新を検出した）'
  : `この送信では書込前に拒否（操作ID ${origin.opId}、試行日時 ${origin.attemptedAt}、理由 ${origin.reason === 'snapshotChanged' ? '版の相違、または保存中の操作' : '操作IDの内容不一致'}）`;
const outcomeText = (outcome: 'reenter' | 'dismiss'): string => outcome === 'reenter' ? '最新記録から入力し直す' : 'この入力を取り下げる';
// 先頭の空白・改行・CRLFが見えるように、原文を引用符付きの文字として示す。
const quotedText = (value: string): string => JSON.stringify(value);

function fieldText(field: ConflictField): string {
  const name = field.label === '' ? `（名称なし：${field.name}）` : field.label;
  switch (field.kind) {
    case 'text': return `${name}：${quotedText(field.value)}`;
    case 'checkbox': return `${name}：${field.checked ? 'オン' : 'オフ'}`;
    case 'select': return `${name}：${quotedText(field.text)}（値 ${quotedText(field.value)}）`;
    case 'file': return `${name}：${field.names.map(quotedText).join('、') || 'なし'}（${{ unread: '未読取', reading: '読取中（読み終えていない）', read: '読取済み', failed: '読取失敗' }[field.readState]}）`;
  }
}

function originalSections(draft: ConflictDraft): PanelSection[] {
  return [
    { heading: '元入力（参照用。自動では登録しない）', lines: [`状態：${originText(draft.origin)}`, `操作：${draft.opLabel}`, `元の担当：${draft.actor === '' ? '（未入力）' : draft.actor}`,
      `入力済みの実際の日時：${draft.occurredAt ?? '（未入力・不明）'}`, `検出：${draft.detectedAt}（${draft.detectedReason}）`, ...draft.fields.map(fieldText)] },
    { heading: '読取原文・採用証拠（参照用の文字。確認済みの状態としては復元しない）', lines: draft.readEvidence.length === 0 ? ['なし'] : draft.readEvidence.map(e => `${e.kind === 'needRaw' ? '必要明細の原文' : '採用したコード証拠'}：${quotedText(e.raw)}`) },
    { heading: '対象と未反映範囲', lines: [`対象：${draft.targets.length === 0 ? '未特定' : draft.targets.map(targetLabel).join('、')}`, `未反映の範囲：${draft.unapplied.length === 0 ? '未特定' : draft.unapplied.join('、')}`, 'この元入力は数量・台帳へ反映されていません。'] },
  ];
}
// 保存結果を確認中の照合候補。pendingのvaluesは識別子と結果だけなので、全文は保存中の単位のConflictReviewから示す。
export function candidateLines(review: ConflictReview): string[] {
  const { resolution } = review;
  return [...originalSections(review.draft).flatMap(section => [`［${section.heading}］`, ...section.lines]),
    `解消の結果：${outcomeText(resolution.outcome)}`, `理由：${quotedText(resolution.reason)}`, `確認者：${resolution.actor}`, `確認日時：${resolution.at}`];
}
const latestSection = (latest: LatestRecord): PanelSection => ({ heading: '現在の記録（最新）',
  lines: [`記録の版：${latest.revision}`, `最後の記録操作：${latest.lastWriter}`, `最終記録更新：${latest.recordedAt ?? '（なし）'}`, latest.summary] });
const limitSection: PanelSection = { heading: '保持できる範囲の限界', lines: ['この未確定の入力は、このタブにだけ置いています。タブやブラウザーを閉じると残りません。', '共有の確認が必要な記録の一覧には登録していません。'] };

// 現在の入力から確認の基準を一箇所で作る。表示する決定と確認の対象が食い違わないよう、基準は呼出側から別に受け取らない。結果が未選択なら基準を作れない。
export function basisOf(draft: ConflictDraft, snapshotKey: string, epoch: number, decision: Decision): ConfirmationBasis | null {
  return decision.outcome === null ? null : { reviewId: draft.reviewId, draftRaw: JSON.stringify(draft), snapshotKey, epoch, outcome: decision.outcome, reason: decision.reason, actor: decision.actor };
}

// 元入力・写し全体・画面の世代・解消の結果・理由・確認者のどれかが変われば、確認済みの状態を失効させる。
export function confirmationStale(confirmed: ConfirmationBasis | null, current: ConfirmationBasis): string | null {
  if (confirmed === null) return null;
  const labels: [keyof ConfirmationBasis, string][] = [['reviewId', '元入力'], ['draftRaw', '退避した元入力'], ['snapshotKey', '最新の記録（写し全体）'],
    ['epoch', '画面の世代'], ['outcome', '解消の結果'], ['reason', '理由'], ['actor', '確認者']];
  const changed = labels.filter(([key]) => confirmed[key] !== current[key]).map(([, label]) => label);
  return changed.length === 0 ? null : `確認後に${changed.join('・')}が変わったため、確認をやり直してください。`;
}

export type PanelInput = {
  state: PanelState; latest: LatestRecord | null; decision: Decision; copied: boolean;
  // 利用者が「最新の記録を確認した」と示した時点の基準。未確認ならnull。現在の基準は、決定・写し全体・世代から表示側で作る。
  confirmed: ConfirmationBasis | null; snapshotKey: string; epoch: number;
  // 保存中・結果不明の操作、再読込が必要な状態など、呼出側が照合の保存を止める理由。
  hold?: string | null;
  // 確定前の照合記録の使用量（呼出側が現在の写しと候補で測る）と、容量で確定できないときの記録なし取下げの提示。
  capacity?: { one: number; total: number; over: boolean; reasonOnly?: boolean } | null;
  withdraw?: { offered: 'budget' | 'quota'; ack: boolean } | null;
};

const backupLine = '上の元入力の全文を控え、画面上部の「復元用バックアップを保存」で最新のバックアップを取得してください。';
function capacitySection(capacity: NonNullable<PanelInput['capacity']>): PanelSection {
  return { heading: '照合記録の容量（確定前の見込み）', lines: [`この照合記録：${capacity.one} bytes／上限${reviewLimits.one} bytes（UTF-8）`,
    `照合記録の合計：${capacity.total} bytes／上限${reviewLimits.total} bytes（保存済みの照合記録を含む）`,
    ...(capacity.over ? ['容量の上限を超えるため、この照合結果は確定できません。原文を切り詰めたり、過去の照合記録を削除したりはしません。', backupLine] : []),
    ...(capacity.reasonOnly === true ? ['理由を短くすれば上限内に収まり、保存できます。'] : [])] };
}
function withdrawSection(offered: 'budget' | 'quota'): PanelSection {
  return { heading: '記録せずにこのタブの退避を取り下げる', lines: [offered === 'budget' ? '照合記録が容量の上限を超えるため、通常の照合を確定できません。'
    : '直前の照合結果の保存が保存先の容量不足で失敗し、未保存と確認しました（容量の上限の超過ではありません）。', backupLine,
    'この取下げでは、共有の照合記録・確認者・解消結果は残りません。照合済みにはなりません。', '取り下げた判断は、後の起動や別のタブから追跡できません。'] };
}

function withdrawActions(ack: boolean, copied: boolean, hold: string | null | undefined): PanelAction[] {
  const blocked = hold ?? (!copied ? '元入力を控えたことを確認してください' : !ack ? '共有の照合記録を残さずに取り下げることを確認してください' : undefined);
  return [{ name: 'withdrawAck', label: '共有の照合記録を残さずに取り下げることを確認した', enabled: true },
    { name: 'withdraw', label: '記録せずにこのタブの退避を取り下げる', enabled: blocked === undefined, ...(blocked === undefined ? {} : { blockedBy: blocked }) }];
}

export function panelModel(input: PanelInput): PanelModel {
  const { state, latest, decision, copied } = input;
  const current = state.kind === 'unresolved' ? basisOf(state.draft, input.snapshotKey, input.epoch, decision) : null;
  const stale = current === null ? null : confirmationStale(input.confirmed, current);
  const latestLines = latest === null ? [] : [latestSection(latest)];
  switch (state.kind) {
    case 'unresolved': {
      const over = input.capacity?.over === true ? '照合記録の容量の上限を超えるため保存できません' : null;
      const blocked = (input.hold ?? over ?? (!copied ? '元入力を控えたことを確認してください' : decision.outcome === null ? '解消の結果を選んでください' : decision.reason.trim() === '' ? '理由を入力してください'
        : decision.actor.trim() === '' ? '確認者を入力してください' : stale ?? (input.confirmed === null ? '最新の記録を確認してください' : undefined))) || undefined;
      return { status: '未解消：更新競合で保持した入力があります。', sections: [...originalSections(state.draft), ...latestLines,
        { heading: '照合結果（未確定）', lines: ['解消の結果：未選択または未確定', `確認者と確認日時：未確定（元の担当・実際の日時とは別に記録します）`, ...(stale === null ? [] : [stale])] },
        ...(input.capacity == null ? [] : [capacitySection(input.capacity)]), ...(input.withdraw == null ? [] : [withdrawSection(input.withdraw.offered)]), limitSection],
      actions: [{ name: 'copied', label: '元入力を控えた', enabled: true }, { name: 'confirm', label: decision.outcome === null ? '照合結果を保存する' : `「${outcomeText(decision.outcome)}」で保存する`, enabled: blocked === undefined, ...(blocked === undefined ? {} : { blockedBy: blocked }) },
        ...(input.withdraw == null ? [] : withdrawActions(input.withdraw.ack, copied, input.hold))] };
    }
    case 'saveFailed':
      return { status: '退避に失敗：入力はこの画面に残しています。', sections: [...originalSections(state.draft), { heading: '失敗の理由', lines: [state.reason, '次の元入力を転記してから、原因を直して再度試してください。再読込すると入力が消えます。'] }, limitSection],
        actions: [{ name: 'reload', label: '再読込する', enabled: false, blockedBy: '入力を退避できていないため、再読込すると入力が消えます' }] };
    case 'unreadable': {
      const blocked = state.raw === null ? '退避の原文を取得できないため、控えを確認できません' : !copied ? '退避の原文を控えたことを確認してください' : undefined;
      return { status: '読めない退避があります。原文を保全しています。', sections: [{ heading: '読めない理由', lines: [state.reason] },
        { heading: '退避の原文（文字として表示）', lines: state.raw === null ? ['原文を取得できていません。'] : [quotedText(state.raw)] }, limitSection],
      actions: [{ name: 'copied', label: '原文を控えた', enabled: state.raw !== null }, { name: 'discardUnreadable', label: '読めない退避だけを取り下げる', enabled: blocked === undefined, ...(blocked === undefined ? {} : { blockedBy: blocked }) }] };
    }
    case 'resolved': {
      const { review } = state, { resolution } = review;
      return { status: `確定済み：${outcomeText(resolution.outcome)}（数量は変わっていません）`, sections: [...originalSections(review.draft), ...latestLines,
        { heading: '照合結果（確定）', lines: [`解消の結果：${outcomeText(resolution.outcome)}`, `理由：${quotedText(resolution.reason)}`, `確認者：${resolution.actor}`, `確認日時：${resolution.at}`,
          `元の担当：${review.draft.actor === '' ? '（未入力）' : review.draft.actor}（確認者とは別）`, 'この照合結果だけでは、元入力の数量・業務操作を登録したことにはなりません。'] }],
      actions: [] };
    }
  }
}
