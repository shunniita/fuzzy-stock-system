import { describe, expect, test } from 'vitest';
import { clearDraft, discardUnreadableDraft, readDraft, writeDraft } from '../../src/ui/conflictdraft.ts';
import { parseConflictDraft, type ConflictDraft } from '../../src/ui/conflictrecord.ts';
import type { StoreLike } from '../../src/ui/storage.ts';

const key = 'fuzzy-stock/conflict-draft', limit = 512 * 1024;
const draft = (reviewId = 'fictional-1', value = ' 001.30\r\n') => parseConflictDraft({ reviewId, origin: { kind: 'unsent' },
  opKey: 'use', opLabel: '使用', actor: '', occurredAt: null, baseRevision: 7, baseLastWriter: 'op7',
  detectedAt: '2026-10-16T13:30:00+09:00', detectedReason: '別画面の更新',
  fields: [{ kind: 'text', name: 'qty', label: '数量', value }, { kind: 'text', name: 'qty', label: '', value: '' }],
  readEvidence: [{ kind: 'needRaw', raw: '架空文書\n不明' }], targets: [], unapplied: ['未送信・数量へ未反映'] });
const rawOf = (value: ConflictDraft) => JSON.stringify({ format: 'fuzzy-stock-conflict-draft', version: 1, draft: value });
const bytes = (raw: string) => new TextEncoder().encode(raw).length;
function storeOf(raw: string | null = null) {
  const data = new Map<string, string>([['fuzzy-stock/pending', '無関係な保存中操作'], ['other', '保持']]);
  if (raw !== null) data.set(key, raw);
  const writes: string[] = [];
  const store: StoreLike = { getItem: name => data.get(name) ?? null,
    setItem: (name, value) => { writes.push(`set:${name}`); data.set(name, value); },
    removeItem: name => { writes.push(`remove:${name}`); data.delete(name); } };
  return { data, writes, store };
}
const fail = () => { throw new Error('架空の保存先障害'); };

describe('競合保持: タブ内一件退避', () => {
  test('空の読取りは書かず、版付き原文を保存・読戻しし別の読取口で復元する', () => {
    const { store, data, writes } = storeOf(), value = draft(), raw = rawOf(value);
    expect(readDraft(store)).toEqual({ kind: 'empty' }); expect(writes).toEqual([]);
    expect(writeDraft(store, value)).toEqual({ kind: 'retained', draft: value, raw });
    expect(data.get(key)).toBe(raw);
    const result = readDraft(() => ({ ...store }));
    expect(result).toEqual({ kind: 'ready', draft: value, raw });
    if (result.kind !== 'ready') throw new Error('読取口から元入力を取得できない');
    expect(result.draft).not.toBe(value); expect(Object.isFrozen(result.draft.fields[0])).toBe(true);
    expect(writes).toEqual([`set:${key}`]);
    expect(data.get('fuzzy-stock/pending')).toBe('無関係な保存中操作');
  });
  test('同じ内容の既存退避はキー順・空白の異なる元rawも書き換えない', () => {
    const value = draft(), raw = JSON.stringify({ draft: value, version: 1, format: 'fuzzy-stock-conflict-draft' }, null, 2);
    const { store, data, writes } = storeOf(raw), before = [...data];
    expect(writeDraft(store, value)).toEqual({ kind: 'retained', draft: value, raw });
    expect([...data]).toEqual(before); expect(writes).toEqual([]);
  });
  test.each([draft('fictional-2'), draft('fictional-1', '0')])('既存退避を別ID・同じIDの異なる内容で置き換えない %#', value => {
    const raw = rawOf(draft()), { store, data, writes } = storeOf(raw), before = [...data];
    expect(writeDraft(store, value)).toMatchObject({ kind: 'failed', draft: value, raw: rawOf(value), observedRaw: raw });
    expect([...data]).toEqual(before); expect(writes).toEqual([]);
  });
  test.each(['壊れた原文\r\n', 'null', '[]', '{}', rawOf(draft()).replace('"version":1', '"version":2'),
    rawOf(draft()).replace('"version":1', '"version":1.0000000000000000001'),
    rawOf(draft()).replace('"baseRevision":7', '"baseRevision":7.000000000000000001'),
    rawOf(draft()).replace('"origin":{"kind":"unsent"}', '"origin":null'),
    rawOf(draft()).replace('"version":1', '"extra":true,"version":1'), 'x'.repeat(limit + 1)])('未知版・破損・超過を原文のまま保全する %#', raw => {
    const { store, data, writes } = storeOf(raw), before = [...data], value = draft();
    expect(readDraft(store)).toMatchObject({ kind: 'unreadable', raw });
    expect(writeDraft(store, value)).toMatchObject({ kind: 'failed', draft: value, observedRaw: raw });
    expect(clearDraft(store, value.reviewId, raw)).toMatchObject({ kind: 'failed', raw });
    expect([...data]).toEqual(before); expect(writes).toEqual([]);
  });
  test('包み全体512KiBちょうどを受理し1byte超過は読込・書込前に拒否する', () => {
    const empty = draft('fictional-1', ''), overhead = bytes(rawOf(empty));
    const value = draft('fictional-1', 'x'.repeat(limit - overhead)), raw = rawOf(value), { store, writes } = storeOf();
    expect(bytes(raw)).toBe(limit); expect(writeDraft(store, value).kind).toBe('retained');
    expect(readDraft(store)).toMatchObject({ kind: 'ready', raw });
    const larger = draft('fictional-1', 'x'.repeat(limit - overhead + 1)), target = storeOf();
    expect(writeDraft(target.store, larger)).toMatchObject({ kind: 'failed', draft: larger, raw: rawOf(larger) });
    expect(target.writes).toEqual([]); expect(writes).toEqual([`set:${key}`]);
    expect(readDraft(storeOf(rawOf(larger)).store)).toMatchObject({ kind: 'unreadable', raw: rawOf(larger) });
  });
  test.each(['日', '😀', '"', '\n', '\\'])('文字数でなくJSON後UTF-8で測る %j', text => {
    const value = draft('fictional-1', text.repeat(300000)), { store, writes } = storeOf();
    expect(writeDraft(store, value)).toMatchObject({ kind: 'failed', draft: value, raw: rawOf(value) });
    expect(writes).toEqual([]);
  });
  test.each(['source', 'getItem', 'setItem'] as const)('保存先取得・メソッドgetter %s の例外を保持失敗で返す', stage => {
    const { store, data } = storeOf(), before = [...data], value = draft();
    const source = stage === 'source' ? fail : store;
    if (stage !== 'source') Object.defineProperty(store, stage, { get: fail });
    if (stage !== 'setItem') expect(readDraft(source)).toMatchObject({ kind: 'unreadable', raw: null });
    expect(writeDraft(source, value)).toMatchObject({ kind: 'failed', draft: value, raw: rawOf(value) });
    if (stage !== 'setItem') expect(clearDraft(source, value.reviewId, rawOf(value))).toMatchObject({ kind: 'failed', raw: rawOf(value) });
    else expect(clearDraft(source, value.reviewId, rawOf(value))).toEqual({ kind: 'cleared' });
    expect([...data]).toEqual(before);
  });
  test.each(['before', 'after', 'readback', 'different'] as const)('書込の障害 %s で成功を推測せずメモリ原文を返す', stage => {
    const { store, data } = storeOf(), set = store.setItem.bind(store), value = draft(), raw = rawOf(value);
    store.setItem = (name, input) => { if (stage === 'before') fail(); set(name, stage === 'different' ? '別の原文' : input);
      if (stage === 'after') fail(); if (stage === 'readback') store.getItem = fail; };
    expect(writeDraft(store, value)).toMatchObject({ kind: 'failed', draft: value, raw });
    expect(data.get(key)).toBe(stage === 'before' ? undefined : stage === 'different' ? '別の原文' : raw);
  });
  test('取得後にsetItem getterが失敗しても既存の別退避へ書かない', () => {
    const { store, data } = storeOf(rawOf(draft('other'))), before = [...data];
    Object.defineProperty(store, 'setItem', { get: fail });
    expect(writeDraft(store, draft()).kind).toBe('failed'); expect([...data]).toEqual(before);
  });
  test('同一reviewIdとrawだけを削除し、null読戻しで確定する', () => {
    const value = draft(), raw = rawOf(value), { store, data, writes } = storeOf(raw);
    expect(clearDraft(store, 'wrong', raw).kind).toBe('failed'); expect(writes).toEqual([]);
    expect(clearDraft(store, value.reviewId, raw)).toEqual({ kind: 'cleared' });
    expect(data.has(key)).toBe(false); expect(writes).toEqual([`remove:${key}`]);
    expect(data.get('other')).toBe('保持'); expect(data.get('fuzzy-stock/pending')).toBe('無関係な保存中操作');
  });
  test.each([rawOf(draft('fictional-1', 'changed')), rawOf(draft()) + ' '])('同じIDでも確認後にrawが変われば削除しない %#', other => {
    const value = draft(), raw = rawOf(value), { store, data, writes } = storeOf(other);
    expect(clearDraft(store, value.reviewId, raw)).toMatchObject({ kind: 'failed', raw });
    expect(data.get(key)).toBe(other); expect(writes).toEqual([]);
  });
  test('getItem呼出失敗は空と推測せず、元入力と全keyを保持する', () => {
    const { store, data, writes } = storeOf(rawOf(draft())), before = [...data], value = draft();
    store.getItem = fail;
    expect(readDraft(store)).toMatchObject({ kind: 'unreadable', raw: null });
    expect(writeDraft(store, value)).toMatchObject({ kind: 'failed', draft: value, raw: rawOf(value) });
    expect(clearDraft(store, value.reviewId, rawOf(value))).toMatchObject({ kind: 'failed', raw: rawOf(value) });
    expect([...data]).toEqual(before); expect(writes).toEqual([]);
  });
  test.each(['getter', 'before', 'after', 'readback', 'different'] as const)('削除の障害 %s で元rawを保持し、null再照会まで失敗を返す', stage => {
    const value = draft(), raw = rawOf(value), { store, data } = storeOf(raw), remove = store.removeItem.bind(store);
    if (stage === 'getter') Object.defineProperty(store, 'removeItem', { get: fail });
    else store.removeItem = name => { if (stage === 'before') fail(); remove(name);
      if (stage === 'after') fail(); if (stage === 'readback') store.getItem = fail; if (stage === 'different') data.set(key, '新しい原文'); };
    expect(clearDraft(store, value.reviewId, raw)).toMatchObject({ kind: 'failed', raw });
    const reader: StoreLike = { getItem: name => data.get(name) ?? null, setItem: fail, removeItem: fail };
    expect(readDraft(reader).kind).toBe(stage === 'getter' || stage === 'before' ? 'ready' : stage === 'different' ? 'unreadable' : 'empty');
    if (stage === 'after' || stage === 'readback') expect(clearDraft(reader, value.reviewId, raw)).toEqual({ kind: 'cleared' });
  });
});

describe('競合保持: 読めない退避の局所的な取り下げ', () => {
  const broken = ['壊れた原文\r\n', rawOf(draft()).replace('"version":1', '"version":2'), 'x'.repeat(limit + 1)];
  test.each(broken)('確認した同一rawだけを削除し、null読戻しで確定する %#', raw => {
    const { store, data, writes } = storeOf(raw);
    expect(readDraft(store)).toMatchObject({ kind: 'unreadable', raw });
    expect(discardUnreadableDraft(store, raw)).toEqual({ kind: 'cleared' });
    expect(data.has(key)).toBe(false); expect(writes).toEqual([`remove:${key}`]);
    expect(data.get('other')).toBe('保持'); expect(data.get('fuzzy-stock/pending')).toBe('無関係な保存中操作');
    expect(readDraft(store)).toEqual({ kind: 'empty' });
  });
  test('有効な退避は破損用の経路で捨てられず、書込も起きない', () => {
    const raw = rawOf(draft()), { store, data, writes } = storeOf(raw), before = [...data];
    expect(discardUnreadableDraft(store, raw)).toMatchObject({ kind: 'failed', raw, observedRaw: null });
    expect([...data]).toEqual(before); expect(writes).toEqual([]);
  });
  test.each([['別の破損原文', 'changed'], ['有効な退避へ変化', rawOf(draft())], ['末尾の差', broken[0] + ' ']])('確認後に値が変わったら削除せず現在値を返す %s', (_, current) => {
    const { store, data, writes } = storeOf(current);
    expect(discardUnreadableDraft(store, broken[0]!)).toMatchObject({ kind: 'failed', raw: broken[0], observedRaw: current });
    expect(data.get(key)).toBe(current); expect(writes).toEqual([]);
  });
  test('確認後に既に消えていればnull再照会で取り下げ完了とし、書かない', () => {
    const { store, writes } = storeOf();
    expect(discardUnreadableDraft(store, broken[0]!)).toEqual({ kind: 'cleared' }); expect(writes).toEqual([]);
  });
  test.each(['source', 'getItem', 'removeItem'] as const)('保存先取得・メソッドgetter %s の例外で原文を保持する', stage => {
    const { store, data } = storeOf(broken[0]), before = [...data];
    const source = stage === 'source' ? fail : store;
    if (stage !== 'source') Object.defineProperty(store, stage, { get: fail });
    expect(discardUnreadableDraft(source, broken[0]!)).toMatchObject({ kind: 'failed', raw: broken[0] });
    expect([...data]).toEqual(before);
  });
  test.each(['before', 'after', 'readback', 'different'] as const)('削除の障害 %s で成功を推測せず、null再照会まで失敗を返す', stage => {
    const raw = broken[0]!, { store, data } = storeOf(raw), remove = store.removeItem.bind(store);
    store.removeItem = name => { if (stage === 'before') fail(); remove(name);
      if (stage === 'after') fail(); if (stage === 'readback') store.getItem = fail; if (stage === 'different') data.set(key, '新しい原文'); };
    expect(discardUnreadableDraft(store, raw)).toMatchObject({ kind: 'failed', raw });
    const reader: StoreLike = { getItem: name => data.get(name) ?? null, setItem: fail, removeItem: fail };
    expect(readDraft(reader).kind).toBe(stage === 'before' ? 'unreadable' : stage === 'different' ? 'unreadable' : 'empty');
    if (stage === 'after' || stage === 'readback') expect(discardUnreadableDraft(reader, raw)).toEqual({ kind: 'cleared' });
  });
  test('getItemが失敗する間は原文を得られず、控え確認も取り下げも成立しない', () => {
    const { store, data, writes } = storeOf(broken[0]), before = [...data];
    store.getItem = fail;
    expect(readDraft(store)).toMatchObject({ kind: 'unreadable', raw: null });
    expect(discardUnreadableDraft(store, broken[0]!)).toMatchObject({ kind: 'failed', raw: broken[0] });
    expect([...data]).toEqual(before); expect(writes).toEqual([]);
  });
});
