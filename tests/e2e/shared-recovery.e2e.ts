import { test, expect, chromium, type Page } from '@playwright/test';
import { backupButton, downloadVia, goTo, lot, pickFile, record, recorded, row, startEmpty, waitForApp } from './helpers.ts';
import { readyToSave, typeUse, draftOf } from './conflict-helpers.ts';

async function enable(page: Page): Promise<void> {
  await goTo(page, 'management');
  page.once('dialog', dialog => { void dialog.accept(); });
  await page.getByRole('button', { name: 'タブ終了後の入力回収を有効にする' }).click();
  await expect(page.locator('#shared-status')).toHaveText('タブ終了後の入力回収：有効');
  await waitForApp(page);
  await goTo(page, 'stock');
}

test('FH-SCR-RACE: 遅延したAの再照会は、その後選んだBの元入力を消さない', async ({ page }) => {
  await startEmpty(page); await enable(page);
  const raws = await page.evaluate(async () => {
    const a = '/dist/ui/shared-authority.js', r = '/dist/ui/shared-recovery.js';
    const { SharedAuthority }: typeof import('../../src/ui/shared-authority.ts') = await import(a);
    const { captureShared }: typeof import('../../src/ui/shared-recovery.ts') = await import(r);
    const repo = new SharedAuthority(localStorage, indexedDB), current = await repo.read();
    if (current.state === null || current.loaded.kind !== 'ok') throw new Error('有効化が必要');
    const raws = ['race-a', 'race-b'].map(id => JSON.stringify({ format: 'fuzzy-stock-conflict-draft', version: 2, generation: current.state!.generation,
      draft: { reviewId: id, origin: { kind: 'unsent' }, opKey: 'use', opLabel: `使用 ${id}`, actor: '架空担当A', occurredAt: null,
        baseRevision: current.loaded.kind === 'ok' ? current.loaded.snapshot.revision : 0, baseLastWriter: 'init', detectedAt: '2026-10-25T12:00:00+09:00', detectedReason: '外部更新',
        fields: [], readEvidence: [], targets: [], unapplied: ['未送信'] } }));
    for (const raw of raws) await captureShared(repo, raw);
    return raws;
  });
  await page.reload(); await waitForApp(page);
  const a = page.locator('#shared-recovery details').filter({ hasText: 'race-a' });
  await a.locator('summary').click(); await a.getByRole('button', { name: 'この元入力を照合する' }).click();
  await page.evaluate(async raw => {
    sessionStorage.setItem('fuzzy-stock/conflict-draft', raw);
    const a = '/dist/ui/shared-authority.js', r = '/dist/ui/shared-recovery.js';
    const { SharedAuthority }: typeof import('../../src/ui/shared-authority.ts') = await import(a);
    const { recoveryRows, withdrawShared }: typeof import('../../src/ui/shared-recovery.ts') = await import(r);
    const repo = new SharedAuthority(localStorage, indexedDB), current = await repo.read();
    const selected = (await recoveryRows(repo)).find(row => row.kind === 'valid' && row.entry.reviewId === 'race-a');
    if (current.state === null || current.loaded.kind !== 'ok' || selected === undefined) throw new Error('Aがない');
    await withdrawShared(repo, current.loaded.snapshot, selected, true, '架空担当A', '2026-10-25T12:01:00+09:00', current.state.generation);
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let held = false;
    crypto.subtle.digest = async (...args: Parameters<typeof digest>) => {
      if (!held && new TextDecoder().decode(args[1]).includes('"reviewId":"race-a"')) {
        held = true; document.documentElement.dataset.raceWaiting = 'true';
        await new Promise<void>(resolve => window.addEventListener('release-race-a', () => resolve(), { once: true }));
      }
      return digest(...args);
    };
    window.dispatchEvent(new Event('focus'));
  }, raws[0]!);
  await expect(page.locator('html')).toHaveAttribute('data-race-waiting', 'true');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('#conflict')).toContainText('未解消として再表示しません');
  const b = page.locator('#shared-recovery details').filter({ hasText: 'race-b' });
  await b.locator('summary').click(); await b.getByRole('button', { name: 'この元入力を照合する' }).click();
  await page.evaluate(async raw => {
    sessionStorage.setItem('fuzzy-stock/conflict-draft', raw);
    window.dispatchEvent(new Event('release-race-a'));
    await new Promise(resolve => setTimeout(resolve, 100));
  }, raws[1]!);
  expect(await draftOf(page)).toBe(raws[1]);
  await expect(page.locator('#conflict')).toContainText('使用 race-b');
  await expect(page.locator('#conflict')).toContainText('未解消');
});

test('FH-SCR-UI: 二画面の未送信入力をタブ終了後に回収し、数量を変えず照合を一件確定する', async ({ page, context }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('p', 'P', 'S1', 'counted', '20'));
  await enable(page);
  const oldRaw = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
  const other = await context.newPage();
  await other.goto('/'); await waitForApp(other);
  await typeUse(other, ' 2.5');
  await recorded(page, 'move', { lot: 'p', location: 'T' });
  await expect(other.locator('#shared-recovery')).toContainText('回収した元入力（1件）');
  const raw = await draftOf(other);
  expect(raw).not.toBeNull();
  await other.close();
  const recovered = await context.newPage();
  await recovered.goto('/'); await waitForApp(recovered);
  const row = recovered.locator('#shared-recovery details');
  await row.locator('summary').click();
  await expect(row.locator('pre')).toHaveText(raw!);
  await typeUse(recovered, '7');
  await row.getByRole('button', { name: 'この元入力を照合する' }).click();
  await expect(recovered.locator('#shared-recovery')).toContainText('切り替えていません');
  await expect(recovered.locator('form [name=value]')).toHaveValue('7');
  // 未送信入力をこの試験で明示的に破棄してから、退避の照合へ進む。
  await recovered.reload(); await waitForApp(recovered);
  await row.locator('summary').click();
  await row.getByRole('button', { name: 'この元入力を照合する' }).click();
  await readyToSave(recovered.locator('#conflict'), '元入力を別途確認した');
  await recovered.locator('#conflict').getByRole('button', { name: /で保存する/ }).click();
  await expect(recovered.locator('#conflict')).toContainText('確定済み');
  await expect(recovered.locator('#shared-recovery')).toContainText('回収した元入力（0件）');
  expect(await recovered.evaluate(() => Object.fromEntries(Object.entries(localStorage)))).toEqual(oldRaw);
  await recovered.reload(); await waitForApp(recovered);
  await expect(recovered.locator('#shared-recovery')).toContainText('回収した元入力（0件）');
  const facts = await recovered.evaluate(async () => {
    const path = '/dist/ui/shared-authority.js';
    const { SharedAuthority }: typeof import('../../src/ui/shared-authority.ts') = await import(path);
    const current = await new SharedAuthority(localStorage, indexedDB).read();
    if (current.loaded.kind !== 'ok') throw new Error('台帳がない');
    return { quantity: current.loaded.snapshot.ledger.lots['p']?.quantity, reviews: current.loaded.snapshot.conflictReviews.length };
  });
  expect(facts.reviews).toBe(1);
  expect(facts.quantity).toMatchObject({ kind: 'known', numeric: { value: 20 } });
});

test('FH-SCR-GENERATION-SUBMIT: 通知なしで別タブが復元した後の送信も元入力を退避する', async ({ page, context }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('p', 'P', 'S1', 'counted', '20'));
  await enable(page);
  const other = await context.newPage();
  await other.addInitScript(() => {
    Reflect.deleteProperty(window, 'BroadcastChannel');
    const add = window.addEventListener.bind(window);
    window.addEventListener = ((type: string, ...rest: unknown[]) => type === 'storage' ? undefined : (add as (...a: unknown[]) => void)(type, ...rest)) as typeof window.addEventListener;
  });
  await other.goto('/'); await waitForApp(other);
  await typeUse(other, '3');
  await page.evaluate(async () => {
    const r = '/dist/ui/browser-repository.js', s = '/dist/ui/storage.js';
    const repo: typeof import('../../src/ui/browser-repository.ts') = await import(r);
    const core: typeof import('../../src/ui/storage.ts') = await import(s);
    const loaded = await repo.load(core.browserStore); if (loaded.kind !== 'ok') throw new Error('台帳がない');
    await repo.replace(core.browserStore, loaded.snapshot, loaded.snapshot);
  });
  await other.getByRole('form', { name: '操作の入力' }).getByRole('button', { name: '記録する' }).click();
  await expect(other.locator('#save')).toContainText('別の画面で記録が保存された');
  await expect(other.locator('#shared-recovery')).toContainText('回収した元入力（1件）');
  expect(await draftOf(other)).toContain('"reason":"snapshotChanged"');
  const after = await page.evaluate(async () => {
    const path = '/dist/ui/shared-authority.js';
    const { SharedAuthority }: typeof import('../../src/ui/shared-authority.ts') = await import(path);
    const current = await new SharedAuthority(localStorage, indexedDB).read();
    return current.loaded.kind === 'ok' ? current.loaded.snapshot.ledger.lots['p']?.quantity : null;
  });
  expect(after).toMatchObject({ kind: 'known', numeric: { value: 20 } });
});

test('FH-SCR-MULTI: 有効化後の複数単位の一部保存と再試行で数量を二重計上しない', async ({ page }) => {
  await startEmpty(page); await enable(page); await page.goto('/?test'); await waitForApp(page);
  const request = { project: 'A-001', item: 'P', quantity: '4', vendor: '架空仕入先', requestedOn: '2026-09-29', replyKind: 'none' };
  await record(page, 'requestRecord', request); await record(page, 'requestRecord', request);
  await page.evaluate(() => window.fuzzyStockTest?.failMidwayAt(3));
  await record(page, 'receive', lot('shared-partial', 'P', 'S1', 'counted', '8', { label: '架空箱', r1request: 'op1', r1arrived: '4', r1good: '4', r2request: 'op2', r2arrived: '4', r2good: '4' }));
  await expect(page.locator('#save')).toContainText('一部だけ保存した');
  await page.getByRole('button', { name: '記録し直す', exact: true }).click();
  await expect(page.locator('#save')).toContainText('保存した');
  await goTo(page, 'stock'); await expect(row(page, 'shared-partial')).toContainText('8個');
  await page.reload(); await waitForApp(page); await expect(row(page, 'shared-partial')).toContainText('8個');
});

test('FH-SCR-BACKUP-UI: 版2を画面で出力・復元し、未有効の保存先では拒否する', async ({ page, browser }) => {
  await startEmpty(page); await enable(page);
  await recorded(page, 'register', lot('backup-p', 'P', 'S1', 'counted', '12'));
  const backup = await downloadVia(page, backupButton);
  expect(JSON.parse(new TextDecoder().decode(backup.bytes)).version).toBe(2);
  await goTo(page, 'stock'); await recorded(page, 'register', lot('later-p', 'P', 'S1', 'counted', '3'));
  await pickFile(page, backup.path);
  await page.getByRole('button', { name: '復元する', exact: true }).click();
  await expect(page.locator('#management-feedback')).toContainText('復元した');
  await goTo(page, 'stock');
  await expect(row(page, 'backup-p')).toContainText('12個'); await expect(row(page, 'later-p')).toHaveCount(0);
  const legacy = await browser.newContext({ baseURL: 'http://127.0.0.1:4182/' });
  try {
    const other = await legacy.newPage(); await other.goto('/'); await waitForApp(other);
    const before = await other.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
    await pickFile(other, backup.path); await other.getByRole('button', { name: '復元する', exact: true }).click();
    await expect(other.locator('#management-feedback')).toContainText('入力回収を有効にしてください');
    expect(await other.evaluate(() => Object.fromEntries(Object.entries(localStorage)))).toEqual(before);
  } finally { await legacy.close(); }
});

test('FH-SCR-QUOTA: native容量拒否で退避と取下げを未確定のまま保持する', async ({}, testInfo) => {
  const profile = testInfo.outputPath('quota-profile'), origin = 'http://127.0.0.1:4182';
  const launch = () => chromium.launchPersistentContext(profile, { channel: 'msedge', headless: true, baseURL: `${origin}/` });
  let context = await launch();
  let cdp: Awaited<ReturnType<typeof context.newCDPSession>> | null = null;
  try {
    const page = context.pages()[0]!; await page.goto('/'); await waitForApp(page);
    const before = await page.evaluate(async () => {
      const a = '/dist/ui/shared-authority.js', r = '/dist/ui/shared-recovery.js', s = '/dist/ui/storage.js';
      const { SharedAuthority }: typeof import('../../src/ui/shared-authority.ts') = await import(a);
      const { captureShared }: typeof import('../../src/ui/shared-recovery.ts') = await import(r);
      const core: typeof import('../../src/ui/storage.ts') = await import(s);
      const loaded = core.load(localStorage); if (loaded.kind !== 'ok') throw new Error('台帳がない');
      const repo = new SharedAuthority(localStorage, indexedDB, 'FH-SCR-QUOTA'), generation = await repo.enable(loaded.snapshot);
      const draft = { reviewId: 'quota-input', origin: { kind: 'unsent' }, opKey: 'use', opLabel: '使用', actor: 'A', occurredAt: null, baseRevision: 0, baseLastWriter: 'init', detectedAt: '2026-10-25T12:00:00+09:00', detectedReason: '外部更新', fields: [], readEvidence: [], targets: [], unapplied: ['未送信'] };
      await captureShared(repo, JSON.stringify({ format: 'fuzzy-stock-conflict-draft', version: 2, generation, draft }));
      return (await repo.inspectRaw()).authority;
    });
    await context.close(); context = await launch();
    const reopened = context.pages()[0]!;
    cdp = await context.newCDPSession(reopened);
    await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: 1 });
    const quota = await cdp.send('Storage.getUsageAndQuota', { origin }); expect(quota.quota).toBe(1);
    await reopened.goto('/'); await waitForApp(reopened);
    const failed = await reopened.evaluate(async () => {
      const a = '/dist/ui/shared-authority.js', r = '/dist/ui/shared-recovery.js';
      const { SharedAuthority }: typeof import('../../src/ui/shared-authority.ts') = await import(a);
      const { recoveryRows, withdrawShared, captureShared }: typeof import('../../src/ui/shared-recovery.ts') = await import(r);
      const repo = new SharedAuthority(localStorage, indexedDB, 'FH-SCR-QUOTA'), loaded = await repo.read();
      const selected = (await recoveryRows(repo))[0];
      if (loaded.state === null || loaded.loaded.kind !== 'ok' || selected?.kind !== 'valid' || selected.entry.kind !== 'open') throw new Error('退避がない');
      sessionStorage.setItem('source', selected.entry.raw);
      const errors: string[] = [];
      try { await withdrawShared(repo, loaded.loaded.snapshot, selected, true, 'A', '2026-10-25T12:01:00+09:00', loaded.state.generation); } catch (error) { errors.push(error instanceof DOMException ? error.name : String(error)); }
      try { await captureShared(repo, selected.entry.raw.replace('quota-input', 'second-input')); } catch (error) { errors.push(error instanceof DOMException ? error.name : String(error)); }
      return { errors, authority: (await repo.inspectRaw()).authority, rawRetained: sessionStorage.getItem('source') === selected.entry.raw };
    });
    expect(failed.errors).toEqual(['QuotaExceededError', 'QuotaExceededError']);
    expect(failed.authority).toBe(before); expect(failed.rawRetained).toBe(true);
  } finally {
    if (cdp !== null) { await cdp.send('Storage.overrideQuotaForOrigin', { origin }); await cdp.detach(); }
    await context.close();
  }
});

test('FH-SCR-NATIVE: 同時capture・別ID保持・pending拒否・原子terminal・receipt再照会・復元union', async ({ page }) => {
  await page.goto('/'); await waitForApp(page);
  const result = await page.evaluate(async () => {
    const a = '/dist/ui/shared-authority.js', s = '/dist/ui/storage.js', r = '/dist/ui/shared-recovery.js', b = '/dist/ui/shared-backup.js', c = '/dist/ui/shared-archive.js', f = '/dist/ui/conflictrecord.js';
    const { SharedAuthority }: typeof import('../../src/ui/shared-authority.ts') = await import(a);
    const core: typeof import('../../src/ui/storage.ts') = await import(s);
    const recovery: typeof import('../../src/ui/shared-recovery.ts') = await import(r);
    const backup: typeof import('../../src/ui/shared-backup.ts') = await import(b);
    const codec: typeof import('../../src/ui/shared-archive.ts') = await import(c);
    const reviewCodec: typeof import('../../src/ui/conflictrecord.ts') = await import(f);
    const initial = core.load(localStorage);
    if (initial.kind !== 'ok') throw new Error('初期値がない');
    const authority = new SharedAuthority(localStorage, indexedDB, 'FH-SCR-NATIVE');
    const generation = await authority.enable(initial.snapshot), at = '2026-10-25T12:00:00+09:00';
    const draft = (id: string) => reviewCodec.parseConflictDraft({ reviewId: id, origin: { kind: 'unsent' }, opKey: 'use', opLabel: '使用', actor: 'A', occurredAt: null,
      baseRevision: initial.snapshot.revision, baseLastWriter: initial.snapshot.lastWriter, detectedAt: at, detectedReason: '外部更新', fields: [{ kind: 'text', name: 'value', label: '数量', value: ' 2.50' }], readEvidence: [], targets: [], unapplied: ['未送信'] });
    const raw = (id: string) => JSON.stringify({ format: 'fuzzy-stock-conflict-draft', version: 2, draft: draft(id), generation });
    await Promise.all([recovery.captureShared(authority, raw('a')), recovery.captureShared(authority, raw('b'))]);
    await recovery.captureShared(authority, raw('a'));
    const captured = await authority.read();
    if (captured.state === null || captured.loaded.kind !== 'ok') throw new Error('台帳がない');
    const review = reviewCodec.parseConflictReview({ eventId: core.nextOpIdOf(captured.loaded.snapshot), reviewId: 'a', draft: draft('a'), resolution: { outcome: 'dismiss', reason: '架空確認', actor: 'A', at } });
    const op = { opId: review.eventId, opLabel: reviewCodec.reviewOpLabel, fingerprint: await reviewCodec.conflictReviewFingerprint(review), values: reviewCodec.reviewPendingValues(review), actor: 'A', startedAt: at, savingSince: at };
    const unit = { ...captured.loaded.snapshot, conflictReviews: [review], targets: ['競合照合a'] };
    const completions = await recovery.prepareCompletion(authority, review);
    core.faults.loseResponseAt = 1;
    const unknown = await authority.transact((state, store) => {
      const value = core.commit(store, initial.snapshot, op, [unit]); recovery.completeReviews(state, store, completions); return { state, value };
    });
    const during = await recovery.recoveryRows(authority);
    let pendingBlocked = false;
    try { await recovery.captureShared(authority, raw('c')); } catch { pendingBlocked = true; }
    if (unknown.kind !== 'unknown') throw new Error(`unknownのはずが${unknown.kind}`);
    const loaded = await authority.read();
    if (loaded.loaded.kind !== 'ok') throw new Error('台帳がない');
    const settled = await authority.transact((state, store) => {
      const value = core.confirmSaved(store, loaded.loaded.kind === 'ok' ? loaded.loaded.snapshot : initial.snapshot, unknown.pending, 'A', at);
      recovery.completeReviews(state, store, completions); return { state, value };
    });
    const after = await authority.read();
    if (after.state === null || after.loaded.kind !== 'ok') throw new Error('台帳がない');
    const archiveBeforeReset = after.state.archive;
    const contents = { ledger: initial.snapshot.ledger, supply: initial.snapshot.supply };
    const reset = await backup.replaceWithReceipt(authority, after.loaded.snapshot, contents, generation, false, undefined, 'fictional-reset-request');
    const repeated = await backup.replaceWithReceipt(authority, after.loaded.snapshot, contents, generation, false, undefined, 'fictional-reset-request');
    const resetRead = await authority.read();
    if (resetRead.state === null) throw new Error('台帳がない');
    const allBefore = (await authority.inspectRaw()).authority;
    let mismatch = false, collision = false, aborted = false;
    try { await backup.replaceWithReceipt(authority, after.loaded.snapshot, { ...contents, opFloor: 99 }, generation, false, undefined, 'fictional-reset-request'); } catch { mismatch = true; }
    const collisionImport = { generation, archive: {}, receipts: { 'fictional-clash': resetRead.state.receipts['fictional-reset-request']! } };
    try { await backup.replaceWithReceipt(authority, reset.snapshot, contents, reset.generation, false, collisionImport, 'fictional-clash'); } catch { collision = true; }
    const normal = authority.transact.bind(authority);
    authority.transact = body => normal(body, { abortAfterWrite: true });
    try { await backup.replaceWithReceipt(authority, reset.snapshot, contents, reset.generation, false, undefined, 'fictional-abort'); } catch { aborted = true; }
    authority.transact = normal;
    const allBeforeKept = (await authority.inspectRaw()).authority === allBefore;
    const imported = { generation, archive: captured.state.archive, receipts: {} };
    const restored = await backup.replaceWithReceipt(authority, reset.snapshot, contents, reset.generation, false, imported, 'fictional-restore-request');
    const restoredRead = await authority.read();
    if (restoredRead.state === null) throw new Error('台帳がない');
    const rows = await codec.archiveRows(restoredRead.state.archive);
    return { count: Object.keys(captured.state.archive).length, revision: captured.loaded.snapshot.revision === initial.snapshot.revision,
      unknownOpen: during.filter(row => row.kind === 'valid' && row.entry.kind === 'open').length, pendingBlocked, settled: settled.kind,
      sameRetry: core.sameSnapshot(reset.snapshot, repeated.snapshot), mismatch, collision, aborted, allBeforeKept, resetKeeps: JSON.stringify(resetRead.state.archive) === JSON.stringify(archiveBeforeReset),
      restoreIncrementsOnce: restored.snapshot.revision === reset.snapshot.revision + 1,
      open: rows.filter(row => row.kind === 'valid' && row.entry.kind === 'open').length, terminal: rows.filter(row => row.kind === 'valid' && row.entry.kind === 'terminal').length };
  });
  expect(result).toEqual({ count: 2, revision: true, unknownOpen: 2, pendingBlocked: true, settled: 'settled', sameRetry: true, mismatch: true, collision: true, aborted: true, allBeforeKept: true, resetKeeps: true, restoreIncrementsOnce: true, open: 1, terminal: 1 });
});

test('FH-SCR-RESTART: 実ブラウザー終了後の同profileから原文を回収できる', async ({}, testInfo) => {
  const profile = testInfo.outputPath('fictional-profile');
  const launch = () => chromium.launchPersistentContext(profile, { channel: 'msedge', headless: true, baseURL: 'http://127.0.0.1:4182/', locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  let context = await launch();
  try {
    const page = context.pages()[0]!;
    await startEmpty(page); await recorded(page, 'register', lot('p', 'P', 'S1', 'counted', '20')); await enable(page);
    const other = await context.newPage(); await other.goto('/'); await waitForApp(other); await typeUse(other, ' 3.50');
    await recorded(page, 'move', { lot: 'p', location: 'T' });
    await expect(other.locator('#shared-recovery')).toContainText('回収した元入力（1件）');
    const raw = await draftOf(other);
    await context.close();
    context = await launch();
    const reopened = context.pages()[0]!; await reopened.goto('/'); await waitForApp(reopened);
    await expect(reopened.locator('#shared-recovery')).toContainText('回収した元入力（1件）');
    await reopened.locator('#shared-recovery summary').click();
    await expect(reopened.locator('#shared-recovery pre')).toHaveText(raw!);
  } finally { await context.close(); }
});
