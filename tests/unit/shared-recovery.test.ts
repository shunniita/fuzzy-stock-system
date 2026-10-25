import { expect, test } from 'vitest';
import { addEntry, archiveRow, archiveRows, canonical, identityKey, openEntry, unionArchive, type ArchiveEntry } from '../../src/ui/shared-archive.ts';
import { decodeDraft } from '../../src/ui/conflictdraft.ts';
import { backupTextOf, readBackup } from '../../src/ui/backup.ts';
import { validateRecovery } from '../../src/ui/shared-backup.ts';
import { snapshot } from './record-fixture.ts';

const at = '2026-10-25T12:00:00+09:00';
const draft = (id = 'fictional-review', value = ' 01.30\n') => ({ reviewId: id, origin: { kind: 'unsent' }, opKey: 'use', opLabel: '使用', actor: '架空担当', occurredAt: null,
  baseRevision: 0, baseLastWriter: 'init', detectedAt: at, detectedReason: '外部更新', fields: [{ kind: 'text', name: 'qty', label: '数量', value }], readEvidence: [], targets: [], unapplied: ['未送信'] });
const raw = (id?: string, value?: string, generation = 'fictional-generation') => JSON.stringify({ format: 'fuzzy-stock-conflict-draft', version: 2, draft: draft(id, value), generation });
const terminal = (entry: ArchiveEntry): ArchiveEntry & { kind: 'terminal' } => ({ kind: 'terminal', generation: entry.generation, reviewId: entry.reviewId, hash: entry.hash, disposition: 'withdraw', actor: '架空担当', at, proof: 'a'.repeat(64) });

test('FH-SCR-IDENTITY: キー順だけを正規化し空白・配列順・世代の差は別に保持する', async () => {
  const original = await openEntry(raw());
  const rearranged = JSON.stringify({ generation: 'fictional-generation', draft: draft(), version: 2, format: 'fuzzy-stock-conflict-draft' }, null, 2);
  expect(identityKey(await openEntry(rearranged))).toBe(identityKey(original));
  expect(identityKey(await openEntry(raw(undefined, '01.30\n')))).not.toBe(identityKey(original));
  expect(identityKey(await openEntry(raw(undefined, undefined, 'other-generation')))).not.toBe(identityKey(original));
  expect(canonical(['a', 'b'])).not.toBe(canonical(['b', 'a']));
  const old = JSON.stringify({ format: 'fuzzy-stock-conflict-draft', version: 1, draft: draft() });
  expect(decodeDraft(old).generation).toBe('legacy/unknown');
  expect(identityKey(await openEntry(old))).toBe(identityKey(await openEntry(old)));
});
test('FH-SCR-UNION: terminal優先・同ID異hash保持・矛盾した処置は全体を拒否する', async () => {
  const one = await openEntry(raw()), two = await openEntry(raw(undefined, '2'));
  const left: Record<string, string> = {}, right: Record<string, string> = {};
  addEntry(left, one); addEntry(left, two); addEntry(right, terminal(one));
  const united = unionArchive(left, right);
  expect((await archiveRows(united)).filter(row => row.kind === 'valid' && row.entry.kind === 'open')).toHaveLength(1);
  expect(unionArchive(united, left)).toEqual(united);
  const before = JSON.stringify(united);
  expect(() => unionArchive(united, { [identityKey(one)]: JSON.stringify({ ...terminal(one), disposition: 'review' }) })).toThrow('異なる処置');
  expect(JSON.stringify(united)).toBe(before);
});
test('FH-SCR-CAPACITY: 64件で新規受付中断、既存照会とterminal化は可能、無効terminalは原文保持', async () => {
  const archive: Record<string, string> = {};
  for (let i = 0; i < 64; i++) addEntry(archive, await openEntry(raw(`fictional-${i}`)));
  const first = await openEntry(raw('fictional-0')), next = await openEntry(raw('fictional-64'));
  const before = JSON.stringify(archive);
  expect(() => addEntry(archive, next)).toThrow('保管上限');
  expect(JSON.stringify(archive)).toBe(before);
  expect(addEntry(archive, first)).toEqual(first);
  expect(() => addEntry(archive, { ...terminal(first), actor: '' })).toThrow();
  expect(JSON.stringify(archive)).toBe(before);
  addEntry(archive, terminal(first));
  expect(addEntry(archive, first).kind).toBe('terminal');
});
test('FH-SCR-CORRUPT: 個別破損は別件を隠さず、復元はhash不一致を拒否する', async () => {
  const good = await openEntry(raw()), wrong = { ...await openEntry(raw('wrong')), hash: 'f'.repeat(64) };
  const archive = { [identityKey(good)]: JSON.stringify(good), [identityKey(wrong)]: JSON.stringify(wrong), broken: 'not-json' };
  expect((await archiveRows(archive)).map(row => row.kind)).toEqual(['valid', 'broken', 'broken']);
  await expect(validateRecovery({ generation: 'g', archive, receipts: {} })).rejects.toThrow('検査値');
  expect(archive.broken).toBe('not-json');
  expect((await archiveRow(identityKey(good), JSON.stringify({ ...good, extra: 1 }))).kind).toBe('broken');
});
test('FH-SCR-BACKUP: 外版2は退避と終端を含み改変を拒否し、外版1も読める', async () => {
  const entry = await openEntry(raw()), recovery = { generation: 'g', archive: { [identityKey(entry)]: JSON.stringify(entry) }, receipts: {} };
  const text = backupTextOf(snapshot(), at, recovery), read = readBackup(new TextEncoder().encode(text));
  expect(JSON.parse(text).version).toBe(2);
  expect(read.kind).toBe('ok');
  if (read.kind !== 'ok') throw new Error('復元できない');
  expect(read.recovery).toEqual(recovery);
  expect(readBackup(new TextEncoder().encode(text.replace('fictional-review', 'tampered-review'))).kind).toBe('unreadable');
  expect(readBackup(new TextEncoder().encode(backupTextOf(snapshot(), at))).kind).toBe('ok');
});
