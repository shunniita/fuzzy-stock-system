import { expect, test } from 'vitest';
import { addEntry, archiveLimits, bytesOf, identityKey, openEntry, parseEntry, requireArchiveBudget, type ArchiveEntry } from '../../src/ui/shared-archive.ts';
import { parseReceipt, requireReceipts } from '../../src/ui/shared-backup.ts';
import { backupTextOf, maxBackupBytes } from '../../src/ui/backup.ts';
import { initial } from '../../src/ui/storage.ts';
import { emptySupply } from '../../src/domain/supply.ts';
import { seedLedger } from '../../src/ui/seed.ts';

const at = '2026-10-25T12:00:00+09:00';
const raw = (id: string, text = '') => JSON.stringify({ format: 'fuzzy-stock-conflict-draft', version: 2, generation: 'fictional',
  draft: { reviewId: id, origin: { kind: 'unsent' }, opKey: 'use', opLabel: '使用', actor: '架空担当', occurredAt: null,
    baseRevision: 0, baseLastWriter: 'init', detectedAt: at, detectedReason: '外部更新',
    fields: [{ kind: 'text', name: 'value', label: '数量', value: text }], readEvidence: [], targets: [], unapplied: ['未送信'] } });
const receipt = JSON.stringify({ requestHash: 'a'.repeat(64), generation: 'fictional', snapshotHash: 'b'.repeat(64) });

test('FH-SCR-LIMIT-TERMINAL: UTF8 8KiBちょうどを認め、1byte超過の処置は原文を変えず拒否', async () => {
  const open = await openEntry(raw('terminal-limit'));
  const base: ArchiveEntry = { kind: 'terminal', generation: open.generation, reviewId: open.reviewId, hash: open.hash,
    disposition: 'withdraw', actor: '架空担当', at, proof: 'c'.repeat(64) };
  const exact = { ...base, actor: base.actor + 'x'.repeat(archiveLimits.terminal - bytesOf(JSON.stringify(base))) };
  expect(bytesOf(JSON.stringify(exact))).toBe(8192);
  expect(parseEntry(JSON.stringify(exact))).toEqual(exact);
  const archive = { [identityKey(open)]: JSON.stringify(open) }, before = JSON.stringify(archive);
  expect(() => addEntry(archive, { ...exact, actor: `${exact.actor}x` })).toThrow('終端');
  expect(JSON.stringify(archive)).toBe(before);
  addEntry(archive, exact); expect(parseEntry(archive[identityKey(open)]!).kind).toBe('terminal');
});

test('FH-SCR-LIMIT-ARCHIVE: UTF8論理8MiB境界と1byte超過を区別し、満杯で原文を保持', async () => {
  const entries = await Promise.all(Array.from({ length: 16 }, (_, i) => openEntry(raw(`large-${i}`, 'x'.repeat(500 * 1024)))));
  const archive = Object.fromEntries(entries.map(entry => [identityKey(entry), JSON.stringify(entry)]));
  const logicalBytes = () => 2 + Object.entries(archive).reduce((sum, entry) => sum + Math.max(8192, bytesOf(JSON.stringify(entry))), 0);
  let remaining = archiveLimits.bytes - logicalBytes();
  for (const [index, entry] of entries.entries()) {
    const extra = Math.min(remaining, 512 * 1024 - bytesOf(entry.raw));
    const enlarged = await openEntry(raw(`large-${index}`, 'x'.repeat(500 * 1024 + extra)));
    delete archive[identityKey(entry)]; archive[identityKey(enlarged)] = JSON.stringify(enlarged); remaining -= extra;
  }
  expect(remaining).toBe(0); expect(logicalBytes()).toBe(8 * 1024 * 1024);
  expect(() => requireArchiveBudget(archive)).not.toThrow();
  const first = Object.keys(archive)[0]!;
  const tooLarge = { ...archive, [first]: `${archive[first]} ` };
  expect(() => requireArchiveBudget(tooLarge)).toThrow('保管上限');
  const before = JSON.stringify(archive), another = await openEntry(raw('not-admitted'));
  expect(() => addEntry(archive, another)).toThrow('保管上限'); expect(JSON.stringify(archive)).toBe(before);
});

test('FH-SCR-LIMIT-RECEIPT: 2KiB、4096件、UTF8 8MiBの境界を守る', () => {
  const exact = receipt.padEnd(2048, ' ');
  expect(parseReceipt(exact).generation).toBe('fictional');
  expect(() => parseReceipt(`${exact} `)).toThrow('大きすぎる');
  const count = Object.fromEntries(Array.from({ length: 4096 }, (_, i) => [String(i), receipt]));
  expect(() => requireReceipts(count)).not.toThrow();
  const beforeCount = JSON.stringify(count);
  expect(() => requireReceipts({ ...count, more: receipt })).toThrow('保管上限'); expect(JSON.stringify(count)).toBe(beforeCount);
  const capacity = Object.fromEntries(Array.from({ length: 4096 }, (_, i) => [String(i), receipt.padEnd(2000, ' ')]));
  let remaining = 8 * 1024 * 1024 - bytesOf(JSON.stringify(capacity));
  for (const key of Object.keys(capacity)) {
    const added = Math.min(remaining, 48); capacity[key] += ' '.repeat(added); remaining -= added;
  }
  expect(remaining).toBe(0); expect(bytesOf(JSON.stringify(capacity))).toBe(8 * 1024 * 1024);
  expect(() => requireReceipts(capacity)).not.toThrow();
  const key = Object.keys(capacity).find(key => capacity[key]!.length < 2048)!;
  const before = JSON.stringify(capacity);
  expect(() => requireReceipts({ ...capacity, [key]: `${capacity[key]} ` })).toThrow('保管上限');
  expect(JSON.stringify(capacity)).toBe(before);
});

test('FH-SCR-LIMIT-BACKUP: 外版2のUTF8包み全体64MiBちょうどを出力し、1byte超過を拒否', () => {
  const state = initial(seedLedger(), emptySupply), item = state.ledger.masters.items['P'];
  if (item === undefined) throw new Error('架空品目がない');
  const withName = (name: string) => ({ ...state, ledger: { ...state.ledger, masters: { ...state.ledger.masters, items: { ...state.ledger.masters.items, P: { ...item, name } } } } });
  const recovery = { generation: 'fictional', archive: {}, receipts: {} };
  const small = backupTextOf(withName('架空'), at, recovery);
  const name = '架空' + 'x'.repeat(maxBackupBytes - bytesOf(small));
  expect(bytesOf(backupTextOf(withName(name), at, recovery))).toBe(maxBackupBytes);
  expect(() => backupTextOf(withName(`${name}x`), at, recovery)).toThrow('64MiB');
  expect(item.name).toBe('架空部品P');
}, 20_000);
