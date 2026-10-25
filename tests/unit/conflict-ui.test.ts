import { describe, expect, test } from 'vitest';
import { basisOf, captureDraft, confirmationStale, fieldsOf, panelModel, type CaptureSource, type ControlLike, type ConfirmationBasis, type Decision, type LatestRecord, type PanelInput } from '../../src/ui/conflict-ui.ts';
import { parseConflictReview, type ConflictDraft, type ConflictField } from '../../src/ui/conflictrecord.ts';

const at = '2026-10-17T04:00:00+09:00';
const initial: ConflictField[] = [
  { kind: 'text', name: 'qty', label: '数量', value: '' },
  { kind: 'text', name: 'qty', label: '', value: '' },
  { kind: 'checkbox', name: 'ok', label: '確認済み', checked: false },
  { kind: 'select', name: 'lot', label: '保管単位', value: 'P-001', text: 'P-001 ネジ' },
  { kind: 'file', name: 'doc', label: '架空文書', names: [], readState: 'unread' },
];
const source = (patch: Partial<CaptureSource> = {}): CaptureSource => ({ initial, fields: initial, initialActor: '架空担当A', actor: '架空担当A', initialOccurredAt: null, occurredAt: null,
  origin: { kind: 'unsent' }, opKey: 'use', opLabel: '使用', baseRevision: 3, baseLastWriter: 'op3', detectedAt: at, detectedReason: '別画面の更新',
  readEvidence: [], targets: [], unapplied: ['未送信・数量へ未反映'], ...patch });
const typed = (value = ' 001.30\r\n'): ConflictField[] => [{ ...initial[0]!, kind: 'text', value } as ConflictField, ...initial.slice(1)];
const draftOf = (patch: Partial<CaptureSource> = {}): ConflictDraft => {
  const result = captureDraft(source({ fields: typed(), ...patch }), () => 'review-1');
  if (result.kind !== 'captured') throw new Error(`捕捉できていない: ${result.kind}`);
  return result.draft;
};
const latest: LatestRecord = { revision: 7, lastWriter: 'op9', recordedAt: '2026-10-17T03:59:00+09:00', summary: '保管単位P-001：数量 70（根拠：数えた）' };
const decision = (patch: Partial<Decision> = {}): Decision => ({ outcome: 'reenter', reason: '最新記録を確認した', actor: '架空担当A', ...patch });
const key = 'snapshot-A', epoch = 2;
// 確認した時点の基準（現在の入力から作る）。
const confirmedAt = (draft: ConflictDraft, d: Decision = decision(), snapshotKey = key, generation = epoch): ConfirmationBasis => {
  const made = basisOf(draft, snapshotKey, generation, d);
  if (made === null) throw new Error('解消の結果が未選択');
  return made;
};
const input = (patch: Partial<PanelInput> & Pick<PanelInput, 'state'>): PanelInput => ({ latest, decision: decision(), copied: true, confirmed: null, snapshotKey: key, epoch, ...patch });
const text = (model: ReturnType<typeof panelModel>): string => [model.status, ...model.sections.flatMap(s => [s.heading, ...s.lines])].join('\n');
const action = (model: ReturnType<typeof panelModel>, name: string) => model.actions.find(a => a.name === name);

describe('競合保持: 元入力の捕捉', () => {
  test('初期値から変更のないフォームは元入力を作らない（検出時刻・理由は変更に数えない）', () => {
    expect(captureDraft(source({ detectedAt: '2026-10-17T05:00:00+09:00', detectedReason: '別の理由' }), () => 'review-1')).toEqual({ kind: 'unchanged' });
  });

  test.each([
    ['数量欄の入力', source({ fields: typed('1') })],
    ['担当者の変更', source({ actor: '架空担当B' })],
    ['実際の日時の入力', source({ occurredAt: '2026-10-17T03:00:00+09:00' })],
    ['チェックの変更', source({ fields: initial.map(f => f.kind === 'checkbox' ? { ...f, checked: true } : f) })],
    ['選択の変更', source({ fields: initial.map(f => f.kind === 'select' ? { ...f, value: 'P-002', text: 'P-002 ボルト' } : f) })],
    ['ファイルの選択', source({ fields: initial.map(f => f.kind === 'file' ? { ...f, names: ['架空.csv'], readState: 'reading' as const } : f) })],
  ])('%sがあれば変更した欄を元入力にする', (_, changed) => {
    expect(captureDraft(changed, () => 'review-1')).toMatchObject({ kind: 'captured', draft: { reviewId: 'review-1', origin: { kind: 'unsent' } } });
  });

  test('欄の順序・重複名・空欄・数量原文・読取中を損なわずに保持し、書込前拒否の由来を持てる', () => {
    const draft = draftOf({ origin: { kind: 'rejected', opId: 'op4', attemptedAt: at, reason: 'identityCollision' }, fields: initial.map((f, i) => i === 0 ? { ...f, value: ' 001.30\r\n' } as ConflictField : f.kind === 'file' ? { ...f, names: ['架空.csv'], readState: 'reading' as const } : f) });
    expect(draft.fields.map(f => `${f.kind}:${f.name}:${f.label}`)).toEqual(initial.map(f => `${f.kind}:${f.name}:${f.label}`));
    expect(draft.fields[0]).toMatchObject({ value: ' 001.30\r\n' });
    expect(draft.fields.at(-1)).toMatchObject({ readState: 'reading', names: ['架空.csv'] });
    expect(draft.origin).toEqual({ kind: 'rejected', opId: 'op4', attemptedAt: at, reason: 'identityCollision' });
  });

  test.each([['例外', () => { throw new Error('crypto.randomUUIDを使えない'); }], ['空文字', () => ''], ['空白のみ', () => '  ']])('識別子を作れないとき（%s）は入力を残して退避を成立させない', (_, newId) => {
    expect(captureDraft(source({ fields: typed() }), newId)).toMatchObject({ kind: 'kept', reason: expect.stringContaining('識別子') });
  });

  test('退避用の形に直せない入力（基準版が不正）も、入力を残して退避を成立させない', () => {
    expect(captureDraft(source({ fields: typed(), baseRevision: -1 }), () => 'review-1')).toMatchObject({ kind: 'kept', reason: expect.stringContaining('退避用の形') });
  });

  test('読取済みの原文と採用証拠は文字列として保持する（確認済みの状態は持たない）', () => {
    const draft = draftOf({ readEvidence: [{ kind: 'needRaw', raw: '架空文書\n不明' }, { kind: 'scan', raw: '{"token":"偽の確認token"}' }] });
    expect(draft.readEvidence).toEqual([{ kind: 'needRaw', raw: '架空文書\n不明' }, { kind: 'scan', raw: '{"token":"偽の確認token"}' }]);
    expect(JSON.stringify(draft)).not.toContain('"confirmed"');
  });
});

describe('競合保持: 未解消・確定済みの表示', () => {
  test('未解消：元入力・現在記録・未反映範囲・限界を別の見出しで文字として示し、数量へ未反映と明示する', () => {
    const model = panelModel(input({ state: { kind: 'unresolved', draft: draftOf() } }));
    const shown = text(model);
    for (const heading of ['元入力（参照用', '現在の記録（最新）', '対象と未反映範囲', '照合結果（未確定）', '保持できる範囲の限界']) expect(model.sections.map(s => s.heading).join('\n')).toContain(heading);
    expect(shown).toContain('未解消');
    expect(shown).toContain('状態：未送信');
    expect(shown).toContain('数量：" 001.30\\r\\n"');
    expect(shown).toContain('（名称なし：qty）');
    expect(shown).toContain('記録の版：7');
    expect(shown).toContain('保管単位P-001：数量 70');
    expect(shown).toContain('対象：未特定');
    expect(shown).toContain('未反映の範囲：未送信・数量へ未反映');
    expect(shown).toContain('数量・台帳へ反映されていません');
    expect(shown).toContain('タブやブラウザーを閉じると残りません');
    expect(shown).toContain('元の担当：架空担当A');
    expect(shown).toContain('元の担当・実際の日時とは別');
  });

  test('原文はHTMLとして解釈されず、そのまま文字として引用される', () => {
    const attack = '<img src=x onerror=alert(1)><script>1</script>';
    const shown = text(panelModel(input({ state: { kind: 'unresolved', draft: draftOf({ fields: typed(attack), readEvidence: [{ kind: 'needRaw', raw: attack }] }) } })));
    expect(shown).toContain(JSON.stringify(attack));
  });

  test('読取中のファイルは読み終えたことにせず、書込前に拒否された由来を区別する', () => {
    const draft = draftOf({ origin: { kind: 'rejected', opId: 'op4', attemptedAt: at, reason: 'snapshotChanged' }, fields: initial.map(f => f.kind === 'file' ? { ...f, names: ['架空.csv'], readState: 'reading' as const } : f) });
    const shown = text(panelModel(input({ state: { kind: 'unresolved', draft } })));
    expect(shown).toContain('この送信では書込前に拒否');
    expect(shown).toContain('版の相違');
    expect(shown).toContain('読取中（読み終えていない）');
    expect(shown).not.toContain('状態：未送信');
  });

  test('確認の条件が揃うまで保存できず、理由を一つずつ示す', () => {
    const draft = draftOf();
    const base = { state: { kind: 'unresolved', draft } } as const;
    const blockedBy = (patch: Partial<PanelInput>) => action(panelModel(input({ ...base, ...patch })), 'confirm')?.blockedBy;
    expect(blockedBy({ copied: false })).toContain('控えた');
    expect(blockedBy({ decision: decision({ outcome: null }) })).toContain('解消の結果');
    expect(blockedBy({ decision: decision({ reason: '  ' }) })).toContain('理由');
    expect(blockedBy({ decision: decision({ actor: '' }) })).toContain('確認者');
    expect(blockedBy({ confirmed: null })).toContain('最新の記録を確認');
    const ready = action(panelModel(input({ ...base, confirmed: confirmedAt(draft) })), 'confirm');
    expect(ready).toMatchObject({ enabled: true });
    expect(ready?.blockedBy).toBeUndefined();
    expect(ready?.label).toContain('最新記録から入力し直す');
  });

  // 失効させる変更：確認後に決定・写し全体・世代・元入力のどれかが変わる。表示側は現在の入力から基準を作るので、決定だけを変えて古い確認が有効なままになる経路はない。
  test.each([
    ['理由', { decision: decision({ reason: '別の理由' }) }],
    ['確認者', { decision: decision({ actor: '架空担当B' }) }],
    ['解消の結果', { decision: decision({ outcome: 'dismiss' }) }],
    ['最新の記録（写し全体）', { snapshotKey: 'snapshot-B' }],
    ['画面の世代', { epoch: 3 }],
  ] satisfies [string, Partial<PanelInput>][])('確認後に%sが変わると確認が失効し、保存できなくなる', (label, change) => {
    const draft = draftOf(), confirmed = confirmedAt(draft);
    const model = panelModel(input({ state: { kind: 'unresolved', draft }, confirmed, ...change }));
    expect(action(model, 'confirm')).toMatchObject({ enabled: false, blockedBy: expect.stringContaining('確認後') });
    expect(action(model, 'confirm')?.blockedBy).toContain(label);
    expect(text(model)).toContain('確認をやり直してください');
  });

  test('別の元入力の確認は、同じ決定・同じ写しでも現在の元入力には使えない', () => {
    const draft = draftOf(), other = draftOf({ fields: typed('999') });
    expect(confirmationStale(confirmedAt(other), confirmedAt(draft))).toContain('退避した元入力');
    const model = panelModel(input({ state: { kind: 'unresolved', draft }, confirmed: confirmedAt(other) }));
    expect(action(model, 'confirm')).toMatchObject({ enabled: false, blockedBy: expect.stringContaining('退避した元入力') });
  });

  test('写しの版・最終操作が同じでも、写し全体が変われば失効する（写し全体を表す値で比べる）', () => {
    const draft = draftOf();
    expect(latest.revision).toBe(7);
    expect(confirmationStale(confirmedAt(draft, decision(), 'revision7-opFloor6'), confirmedAt(draft, decision(), 'revision7-opFloor7'))).toContain('写し全体');
  });

  test('確認の基準を作れない（解消の結果が未選択）あいだは保存できず、古い確認が残っていても有効にならない', () => {
    const draft = draftOf();
    const model = panelModel(input({ state: { kind: 'unresolved', draft }, decision: decision({ outcome: null }), confirmed: confirmedAt(draft) }));
    expect(action(model, 'confirm')).toMatchObject({ enabled: false, blockedBy: expect.stringContaining('解消の結果') });
    expect(basisOf(draft, key, epoch, decision({ outcome: null }))).toBeNull();
  });

  test('確認が変わっていなければ失効せず、確認していなければ失効の判定もしない', () => {
    const draft = draftOf();
    expect(confirmationStale(confirmedAt(draft), confirmedAt(draft))).toBeNull();
    expect(confirmationStale(null, confirmedAt(draft))).toBeNull();
  });

  test('退避失敗：入力を残して転記用に示し、再読込を許可しない', () => {
    const model = panelModel(input({ state: { kind: 'saveFailed', draft: draftOf(), reason: '保存容量不足' }, copied: false }));
    const shown = text(model);
    expect(shown).toContain('退避に失敗');
    expect(shown).toContain('保存容量不足');
    expect(shown).toContain('数量：" 001.30\\r\\n"');
    expect(shown).toContain('再読込すると入力が消えます');
    expect(action(model, 'reload')).toMatchObject({ enabled: false });
  });

  test('読込不能：原文を引用して示し、控え確認の後にだけ取り下げられる。原文がなければ控えを確認できない', () => {
    const unread = (raw: string | null, copied: boolean) => panelModel(input({ state: { kind: 'unreadable', raw, reason: '未知の版' }, copied }));
    const raw = '{"format":"fuzzy-stock-conflict-draft","version":9}';
    expect(text(unread(raw, false))).toContain(JSON.stringify(raw));
    expect(action(unread(raw, false), 'discardUnreadable')).toMatchObject({ enabled: false, blockedBy: expect.stringContaining('控えた') });
    expect(action(unread(raw, true), 'discardUnreadable')).toMatchObject({ enabled: true });
    const none = unread(null, true);
    expect(text(none)).toContain('原文を取得できていません');
    expect(action(none, 'copied')).toMatchObject({ enabled: false });
    expect(action(none, 'discardUnreadable')).toMatchObject({ enabled: false, blockedBy: expect.stringContaining('原文を取得できない') });
  });

  test('確定済み：解消結果・理由・確認者・確認日時を元の担当・実際の日時と区別し、登録していないと示し、操作を出さない', () => {
    const draft = draftOf({ occurredAt: '2026-10-17T03:00:00+09:00' });
    const review = parseConflictReview({ eventId: 'op10', reviewId: draft.reviewId, draft, resolution: { outcome: 'dismiss', reason: '重複入力のため', actor: '架空担当B', at } });
    const model = panelModel(input({ state: { kind: 'resolved', review } }));
    const shown = text(model);
    expect(shown).toContain('確定済み：この入力を取り下げる');
    expect(shown).toContain('数量は変わっていません');
    expect(shown).toContain('確認者：架空担当B');
    expect(shown).toContain(`確認日時：${at}`);
    expect(shown).toContain('元の担当：架空担当A（確認者とは別）');
    expect(shown).toContain('入力済みの実際の日時：2026-10-17T03:00:00+09:00');
    expect(shown).toContain('元入力の数量・業務操作を登録したことにはなりません');
    expect(model.actions).toEqual([]);
  });

  test('表示モデルは元入力をフォームへ書き戻す・再送する操作を持たない', () => {
    const names = [panelModel(input({ state: { kind: 'unresolved', draft: draftOf() } })), panelModel(input({ state: { kind: 'saveFailed', draft: draftOf(), reason: 'x' } })),
      panelModel(input({ state: { kind: 'unreadable', raw: 'x', reason: 'x' } }))].flatMap(m => m.actions.map(a => a.name));
    expect(new Set(names)).toEqual(new Set(['copied', 'confirm', 'reload', 'discardUnreadable']));
  });

  test('3.7: 確定前に一件と合計の使用量・上限を示し、上限超過では保存を止めて原文の控えとバックアップ取得を案内する', () => {
    const draft = draftOf(), base = { state: { kind: 'unresolved' as const, draft }, confirmed: confirmedAt(draft) };
    const within = panelModel(input({ ...base, capacity: { one: 1200, total: 3400, over: false } }));
    expect(text(within)).toContain('この照合記録：1200 bytes／上限65536 bytes（UTF-8）');
    expect(text(within)).toContain('照合記録の合計：3400 bytes／上限262144 bytes');
    expect(action(within, 'confirm')?.enabled).toBe(true);
    const over = panelModel(input({ ...base, capacity: { one: 70000, total: 70002, over: true } }));
    expect(action(over, 'confirm')).toMatchObject({ enabled: false, blockedBy: '照合記録の容量の上限を超えるため保存できません' });
    expect(text(over)).toContain('原文を切り詰めたり、過去の照合記録を削除したりはしません');
    expect(text(over)).toContain('「復元用バックアップを保存」');
    expect(text(over)).not.toContain('理由を短くすれば保存できます');
    expect(text(panelModel(input({ ...base, capacity: { one: 70000, total: 70002, over: true, reasonOnly: true } })))).toContain('理由を短くすれば上限内に収まり、保存できます。');
    // 保存を止める理由（保存中の操作など）は容量より先に示す。
    expect(action(panelModel(input({ ...base, capacity: { one: 70000, total: 70002, over: true }, hold: '保存中の操作' })), 'confirm')?.blockedBy).toBe('保存中の操作');
  });

  test.each(['budget', 'quota'] as const)('3.8: 記録なし取下げ(%s)は理由と共有の記録が残らないことを示し、控えと明示の確認がそろうまで実行できない', offered => {
    const draft = draftOf(), model = (copied: boolean, ack: boolean, hold: string | null = null) => panelModel(input({ state: { kind: 'unresolved', draft }, copied, hold, withdraw: { offered, ack } }));
    const shown = text(model(true, true));
    expect(shown).toContain(offered === 'budget' ? '容量の上限を超えるため、通常の照合を確定できません' : '保存先の容量不足で失敗し、未保存と確認しました（容量の上限の超過ではありません）');
    expect(shown).toContain('共有の照合記録・確認者・解消結果は残りません。照合済みにはなりません。');
    expect(action(model(true, true), 'withdraw')?.enabled).toBe(true);
    expect(action(model(false, true), 'withdraw')).toMatchObject({ enabled: false, blockedBy: '元入力を控えたことを確認してください' });
    expect(action(model(true, false), 'withdraw')).toMatchObject({ enabled: false, blockedBy: '共有の照合記録を残さずに取り下げることを確認してください' });
    expect(action(model(true, true, '保存中の操作'), 'withdraw')).toMatchObject({ enabled: false, blockedBy: '保存中の操作' });
    expect(action(panelModel(input({ state: { kind: 'unresolved', draft } })), 'withdraw')).toBeUndefined();
  });
});

describe('競合保持: フォームの欄から元入力の欄への変換', () => {
  test('旧保存対象の接頭辞だけを表示変換し、元入力と退避内容を保つ', () => {
    const draft = draftOf({ targets: ['まとまり別のまとまり', '元票「架空元票」・動き「001」'] });
    const before = JSON.stringify(draft);
    const shown = text(panelModel(input({ state: { kind: 'unresolved', draft } })));
    expect(shown).toContain('対象：保管単位別のまとまり、元の資料「架空元票」・動き「001」');
    expect(JSON.stringify(draft)).toBe(before);
  });
  const control = (patch: Partial<ControlLike>): ControlLike => ({ type: 'text', name: 'x', label: '', value: '', checked: false, selectedText: '', fileNames: [], readState: 'unread', ...patch });
  test('種類ごとに変換し、順序・重複名・名称なし・数量原文・読取状態をそのまま残す', () => {
    const fields = fieldsOf([
      control({ name: 'qty', label: '数量', value: ' 001.30\r\n' }), control({ name: 'qty' }), control({ type: 'textarea', name: 'memo', label: 'メモ', value: '行1\n行2' }),
      control({ type: 'checkbox', name: 'ok', label: '確認', checked: true }), control({ type: 'select-one', name: 'lot', label: '保管単位', value: 'P-001', selectedText: 'P-001 ネジ' }),
      control({ type: 'file', name: 'doc', label: '文書', fileNames: ['架空.json'], readState: 'reading' }), control({ type: 'number', name: 'n', value: '007' }),
    ]);
    expect(fields).toEqual([
      { kind: 'text', name: 'qty', label: '数量', value: ' 001.30\r\n' }, { kind: 'text', name: 'qty', label: '', value: '' }, { kind: 'text', name: 'memo', label: 'メモ', value: '行1\n行2' },
      { kind: 'checkbox', name: 'ok', label: '確認', checked: true }, { kind: 'select', name: 'lot', label: '保管単位', value: 'P-001', text: 'P-001 ネジ' },
      { kind: 'file', name: 'doc', label: '文書', names: ['架空.json'], readState: 'reading' }, { kind: 'text', name: 'n', label: '', value: '007' },
    ]);
  });
  test('読取済みと失敗の状態を区別し、ファイル名の配列を共有しない', () => {
    const names = ['a.json'];
    const [read, failed] = fieldsOf([control({ type: 'file', name: 'd1', fileNames: names, readState: 'read' }), control({ type: 'file', name: 'd2', fileNames: names, readState: 'failed' })]);
    expect(read).toMatchObject({ readState: 'read' }); expect(failed).toMatchObject({ readState: 'failed' });
    names.push('b.json');
    expect(read).toMatchObject({ names: ['a.json'] });
  });
});
