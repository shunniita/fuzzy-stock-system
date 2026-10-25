import { describe, expect, test } from 'vitest';
import { appendConflictReview, parseConflictDraft, parseConflictReview, reviewLimits, reviewUsage, type ConflictReview } from '../../src/ui/conflictrecord.ts';

const at = '2026-10-16T12:36:00+09:00';
const draft = () => ({
  reviewId: 'fictional-draft-1', origin: { kind: 'unsent' }, opKey: 'use', opLabel: '使用', actor: '', occurredAt: null,
  baseRevision: 7, baseLastWriter: 'op7', detectedAt: at, detectedReason: '別画面の保存状態が変わった',
  fields: [
    { kind: 'text', name: 'quantity', label: '数量', value: ' 001.30\r\n' },
    { kind: 'text', name: 'quantity', label: '数量', value: '' },
    { kind: 'text', name: '', label: '', value: '<img src=x onerror=alert(1)>' },
    { kind: 'checkbox', name: 'confirmed', label: '確認', checked: false },
    { kind: 'select', name: 'basis', label: '根拠', value: 'unknown', text: '数が不明' },
    { kind: 'file', name: 'file', label: '文書', names: ['架空.txt'], readState: 'reading' },
  ],
  readEvidence: [{ kind: 'needRaw', raw: '架空文書\n0001\t不明' }, { kind: 'scan', raw: '{"raw":"0001","adopted":true}' }],
  targets: [], unapplied: ['未送信・数量へ未反映'],
});
const review = (id = 1) => ({ eventId: `op${id}`, reviewId: `fictional-draft-${id}`, draft: { ...draft(), reviewId: `fictional-draft-${id}` },
  resolution: { outcome: 'reenter', reason: ' 最新記録を確認した ', actor: '架空の確認者', at } });
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
function sizedReview(size: number, id = 1) {
  const value = review(id);
  value.draft.fields[0] = { kind: 'text', name: '', label: '', value: '' };
  const field = value.draft.fields[0];
  field.value = 'x'.repeat(size - bytes(value));
  expect(bytes(value)).toBe(size);
  return value;
}

describe('競合保持: 元入力と照合結果の値契約', () => {
  test('1.1/2.1/2.2: 順序・重複名・空欄・原文・不明・読取証拠を変換しない', () => {
    const input = draft(), before = structuredClone(input), result = parseConflictDraft(input);
    expect(result).toEqual(before);
    expect(input).toEqual(before);
    expect(result).not.toBe(input);
    expect(Object.isFrozen(result.fields[0])).toBe(true);
    input.fields[0]!.value = '外部変更';
    expect(result.fields[0]).toEqual(before.fields[0]);
  });
  test.each(['snapshotChanged', 'identityCollision'])('1.2: 書込前拒否 %s は元送信のID・日時を持つ', reason => {
    const value = { ...draft(), actor: '架空の元担当', occurredAt: '不正な入力日時も原文のまま',
      origin: { kind: 'rejected', opId: 'op8', attemptedAt: at, reason } };
    expect(parseConflictDraft(value)).toEqual(value);
  });
  test.each(['unread', 'reading', 'read', 'failed'])('2.2: ファイル読取状態 %s を保持する', readState => {
    const value = { ...draft(), fields: [{ kind: 'file', name: '', label: '', names: [], readState }] };
    expect(parseConflictDraft(value)).toEqual(value);
  });
  test.each(['reenter', 'dismiss'])('3.2: %s の確認者と日時を元入力と区別する', outcome => {
    const value = review(); value.resolution.outcome = outcome;
    expect(parseConflictReview(value)).toEqual(value);
    expect(parseConflictReview(value).draft.actor).toBe('');
  });
  const invalidDrafts = [null, [], {}, { ...draft(), reviewId: ' ' }, { ...draft(), baseRevision: -1 },
    { ...draft(), baseRevision: 1.5 }, { ...draft(), baseRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...draft(), baseLastWriter: 1 }, { ...draft(), detectedReason: '' }, { ...draft(), actor: null },
    { ...draft(), occurredAt: 0 }, { ...draft(), detectedAt: '2026-02-30T12:00:00Z' },
    { ...draft(), detectedAt: '2026-10-16T12:00' }, { ...draft(), detectedAt: null },
    { ...draft(), origin: { kind: 'unsent', opId: 'op8' } },
    ...['opId', 'attemptedAt', 'reason'].map(key => ({ ...draft(), origin: { kind: 'rejected', opId: 'op8', attemptedAt: at, reason: 'snapshotChanged', [key]: undefined } })),
    { ...draft(), origin: { kind: 'unknown' } }, { ...draft(), fields: 'text' },
    { ...draft(), fields: [{ kind: 'checkbox', name: '', label: '', checked: 'false' }] },
    { ...draft(), fields: [{ kind: 'text', name: '', label: '', value: null }] },
    { ...draft(), fields: [{ kind: 'select', name: '', label: '', value: '' }] },
    { ...draft(), fields: [{ kind: 'file', name: '', label: '', names: [1], readState: 'read' }] },
    { ...draft(), fields: [{ kind: 'file', name: '', label: '', names: [], readState: 'done' }] },
    { ...draft(), fields: [{ kind: 'script', name: '', label: '', value: 'x' }] },
    { ...draft(), readEvidence: [{ kind: 'token', raw: 'confirmed' }] }, { ...draft(), targets: [null] },
    { ...draft(), unapplied: undefined }, { ...draft(), confirmationToken: '再実行しない' }];
  test.each(invalidDrafts.map((value, index) => [index, value] as const))('不正な外部draft #%s を拒否する', (_index, value) => {
    expect(() => parseConflictDraft(value)).toThrow();
  });
  test.each([
    { ...review(), reviewId: 'other' }, { ...review(), eventId: 'op0' }, { ...review(), eventId: 'op9007199254740992' },
    ...['reason', 'actor', 'at', 'outcome'].map(key => ({ ...review(), resolution: { ...review().resolution, [key]: ' ' } })),
    { ...review(), resolution: { ...review().resolution, at: null } }, { ...review(), extra: '失わず拒否' },
  ])('不正な照合結果を拒否する %#', value => { expect(() => parseConflictReview(value)).toThrow(); });
  test('3.4: 同一元入力または操作IDの再追記を拒否し、既存結果を変えない', () => {
    const first = parseConflictReview(review()), existing = [first], before = JSON.stringify(existing);
    for (const candidate of [first, { ...first, eventId: 'op2' }, { ...first, resolution: { ...first.resolution, outcome: 'dismiss' as const } }, parseConflictReview({ ...review(2), eventId: first.eventId })]) {
      expect(() => appendConflictReview(existing, candidate)).toThrow(/重複/);
    }
    expect(JSON.stringify(existing)).toBe(before);
    expect(appendConflictReview(existing, parseConflictReview(review(2)))).toEqual([first, review(2)]);
    expect(() => appendConflictReview([first, first], parseConflictReview(review(2)))).toThrow(/重複/);
  });
  test('3.4: オブジェクトのキー順によらず正規順で直列化し、追記結果を凍結する', () => {
    const first = review(), reordered = Object.fromEntries(Object.entries(first).reverse());
    expect(JSON.stringify(parseConflictReview(reordered))).toBe(JSON.stringify(parseConflictReview(first)));
    expect(Object.isFrozen(appendConflictReview([], parseConflictReview(first)))).toBe(true);
  });
  test('3.7: 一件64KiBちょうどを受理し、1byte超過は拒否する', () => {
    expect(bytes(parseConflictReview(sizedReview(65536)))).toBe(65536);
    expect(() => parseConflictReview(sizedReview(65537))).toThrow(/64KiB/);
  });
  test('3.7: 配列の括弧・区切りを含め256KiBちょうどを受理し、1byte超過は拒否する', () => {
    const existing = [1, 2, 3].map(id => parseConflictReview(sizedReview(65536, id)));
    expect(bytes(appendConflictReview(existing, parseConflictReview(sizedReview(65531, 4))))).toBe(262144);
    expect(() => appendConflictReview(existing, parseConflictReview(sizedReview(65532, 4)))).toThrow(/256KiB/);
  });
  test('3.7: 確定前の使用量は復号時の検査と同じ直列化で測り、境界の1byteで超過になる', () => {
    const candidate = (size: number, id = 1) => sizedReview(size, id) as unknown as ConflictReview;
    expect(reviewUsage([], candidate(65536))).toEqual({ one: 65536, total: 65538, over: false });
    expect(reviewUsage([], candidate(65537))).toMatchObject({ one: 65537, over: true });
    const existing = [1, 2, 3].map(id => parseConflictReview(sizedReview(65536, id)));
    expect(reviewUsage(existing, candidate(65531, 4))).toEqual({ one: 65531, total: 262144, over: false });
    expect(reviewUsage(existing, candidate(65532, 4))).toEqual({ one: 65532, total: 262145, over: true });
    expect(reviewLimits).toEqual({ one: 65536, total: 262144 });
  });
  test.each(['日', '😀', '"', '\n', '\\'])('3.7: UTF-8とJSONエスケープ後の原文 %j で測る', text => {
    const value = review(); value.draft.fields[0]!.value = text.repeat(40000);
    expect(() => parseConflictReview(value)).toThrow(/64KiB/);
    expect(parseConflictDraft(value.draft).fields[0]).toEqual(value.draft.fields[0]);
  });
});
