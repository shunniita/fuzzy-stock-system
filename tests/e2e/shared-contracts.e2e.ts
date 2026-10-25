import { expect, test } from '@playwright/test';
import { downloadVia, goTo, lot, recorded, startEmpty, waitForApp } from './helpers.ts';
import { readyToSave } from './conflict-helpers.ts';

for (const source of ['foreign', 'legacy'] as const) test(`FH-SCR-GENERATION: ${source}は原文を控えて取下げ、現在台帳へ照合を記録しない`, async ({ page }) => {
  await startEmpty(page); await goTo(page, 'management');
  page.once('dialog', dialog => { void dialog.accept(); });
  await page.getByRole('button', { name: 'タブ終了後の入力回収を有効にする' }).click();
  await expect(page.locator('#shared-status')).toContainText('：有効'); await waitForApp(page);
  const fixture = await page.evaluate(async source => {
    const a = '/dist/ui/shared-authority.js', r = '/dist/ui/shared-recovery.js', s = '/dist/ui/storage.js';
    const { SharedAuthority }: typeof import('../../src/ui/shared-authority.ts') = await import(a);
    const { captureShared }: typeof import('../../src/ui/shared-recovery.ts') = await import(r);
    const { serialize }: typeof import('../../src/ui/storage.ts') = await import(s);
    const repo = new SharedAuthority(localStorage, indexedDB), current = await repo.read();
    if (current.state === null || current.loaded.kind !== 'ok') throw new Error('共有台帳がない');
    const draft = { reviewId: source, origin: { kind: 'unsent' }, opKey: 'use', opLabel: '架空の使用', actor: '架空担当A', occurredAt: null,
      baseRevision: current.loaded.snapshot.revision, baseLastWriter: current.loaded.snapshot.lastWriter, detectedAt: '2026-10-25T12:00:00+09:00', detectedReason: '外部更新', fields: [], readEvidence: [], targets: [], unapplied: ['未送信'] };
    const raw = JSON.stringify({ format: 'fuzzy-stock-conflict-draft', version: source === 'legacy' ? 1 : 2, draft, ...(source === 'legacy' ? {} : { generation: 'fictional-old-generation' }) });
    await captureShared(repo, raw); return { raw, snapshot: serialize(current.loaded.snapshot) };
  }, source);
  await page.reload(); await waitForApp(page);
  const row = page.locator('#shared-recovery details'); await row.locator('summary').click();
  await expect(row).toContainText('現在と異なる世代。参照用');
  const downloaded = await downloadVia(page, '原文を控える');
  expect(new TextDecoder().decode(downloaded.bytes)).toBe(fixture.raw);
  await row.getByRole('button', { name: 'この元入力を照合する' }).click();
  await readyToSave(page.locator('#conflict'), '架空の確認');
  await expect(page.locator('#conflict').getByRole('button', { name: /で保存する/ })).toBeDisabled();
  await expect(page.locator('#conflict')).toContainText('世代');
  await row.locator('summary').click();
  await expect(row.getByRole('button', { name: '本文を残さず取り下げる' })).toBeDisabled();
  await row.getByRole('checkbox').check(); await row.getByRole('button', { name: '本文を残さず取り下げる' }).click();
  await expect(page.locator('#shared-recovery')).toContainText('回収した元入力（0件）');
  await page.reload(); await waitForApp(page);
  await expect(page.locator('#shared-recovery')).toContainText('解消・取下げ済み：1件');
  const after = await page.evaluate(async () => {
    const a = '/dist/ui/shared-authority.js', s = '/dist/ui/storage.js';
    const { SharedAuthority }: typeof import('../../src/ui/shared-authority.ts') = await import(a);
    const { serialize }: typeof import('../../src/ui/storage.ts') = await import(s);
    const current = await new SharedAuthority(localStorage, indexedDB).read();
    if (current.loaded.kind !== 'ok') throw new Error('台帳がない'); return serialize(current.loaded.snapshot);
  });
  expect(after).toBe(fixture.snapshot);
});

test('FH-SCR-WRITERS: native IDBの照会・確定・取りやめと元Pending世代・全文の拒否', async ({ page }) => {
  await startEmpty(page); await recorded(page, 'register', lot('p', 'P', 'S1', 'counted', '20'));
  const result = await page.evaluate(async () => {
    const a = '/dist/ui/shared-authority.js', r = '/dist/ui/browser-repository.js', s = '/dist/ui/storage.js', d = '/dist/domain/ledger.js';
    const { SharedAuthority }: typeof import('../../src/ui/shared-authority.ts') = await import(a);
    const repo: typeof import('../../src/ui/browser-repository.ts') = await import(r);
    const core: typeof import('../../src/ui/storage.ts') = await import(s);
    const { move }: typeof import('../../src/domain/ledger.ts') = await import(d);
    const legacy = core.load(localStorage); if (legacy.kind !== 'ok') throw new Error('初期値がない');
    const authority = new SharedAuthority(localStorage, indexedDB); await authority.enable(legacy.snapshot);
    const loaded = await repo.load(core.browserStore); if (loaded.kind !== 'ok') throw new Error('共有台帳がない');
    const at = '2026-10-25T12:00:00+09:00', actor = '架空担当A', opId = core.nextOpIdOf(loaded.snapshot);
    core.faults.loseResponseAt = 1;
    const saved = await repo.commit(core.browserStore, loaded.snapshot, { opId, opLabel: '移動', fingerprint: 'fictional-move', values: {}, actor, startedAt: at, savingSince: at },
      [{ ledger: move(loaded.snapshot.ledger, { eventId: opId, actor, recordedAt: at, occurredAt: at }, 'p', 'T'), supply: loaded.snapshot.supply, conflictReviews: [], targets: ['まとまりp'] }]);
    if (saved.kind !== 'unknown') throw new Error('応答喪失にならない');
    const pending = saved.pending, beforeInquiry = (await authority.inspectRaw()).authority;
    const inquiry = await repo.inquire(core.browserStore, pending);
    const inquiryUnchanged = beforeInquiry === (await authority.inspectRaw()).authority;
    const confirmed = await repo.confirmSaved(core.browserStore, inquiry.snapshot, pending, actor, at);
    if (confirmed.kind !== 'settled') throw new Error('確定できない');
    const beforeSettledInquiry = (await authority.inspectRaw()).authority;
    const settledInquiry = await repo.inquire(core.browserStore, pending);
    const settledInquiryUnchanged = beforeSettledInquiry === (await authority.inspectRaw()).authority;
    const sameGeneration = await repo.abandon(core.browserStore, confirmed.snapshot, pending, actor, at);
    const replacement = await repo.replace(core.browserStore, confirmed.snapshot, confirmed.snapshot);
    const beforeOld = (await authority.inspectRaw()).authority;
    const oldRejected: boolean[] = [];
    for (const call of [() => repo.inquire(core.browserStore, pending), ...[repo.retry, repo.abandon, repo.confirmSaved].map(action => () => action(core.browserStore, replacement, pending, actor, at))]) {
      try { await call(); oldRejected.push(false); } catch { oldRejected.push(true); }
    }
    const staleOp = core.nextOpIdOf(confirmed.snapshot);
    const staleCommit = (await repo.commit(core.browserStore, confirmed.snapshot, { opId: staleOp, opLabel: '移動', fingerprint: 'fictional-stale', values: {}, actor, startedAt: at, savingSince: at },
      [{ ledger: move(confirmed.snapshot.ledger, { eventId: staleOp, actor, recordedAt: at, occurredAt: at }, 'p', 'S2'), supply: confirmed.snapshot.supply, conflictReviews: [], targets: ['まとまりp'] }])).kind;
    const oldUnchanged = beforeOld === (await authority.inspectRaw()).authority;
    const op2 = core.nextOpIdOf(replacement); core.faults.loseResponseAt = 1;
    const again = await repo.commit(core.browserStore, replacement, { opId: op2, opLabel: '移動', fingerprint: 'fictional-again', values: {}, actor, startedAt: at, savingSince: at },
      [{ ledger: move(replacement.ledger, { eventId: op2, actor, recordedAt: at, occurredAt: at }, 'p', 'S1'), supply: replacement.supply, conflictReviews: [], targets: ['まとまりp'] }]);
    if (again.kind !== 'unknown') throw new Error('二度目の応答喪失がない');
    const current = await repo.load(core.browserStore); if (current.kind !== 'ok') throw new Error('写しがない');
    await authority.transact((state, store) => {
      store.setItem('fuzzy-stock/pending', core.serializePending({ ...again.pending, values: { changed: '別の全文' } })); return { state, value: undefined };
    });
    const beforeMismatch = (await authority.inspectRaw()).authority, mismatchRejected: boolean[] = [];
    try { await repo.inquire(core.browserStore, again.pending); mismatchRejected.push(false); } catch { mismatchRejected.push(true); }
    for (const action of [repo.retry, repo.abandon, repo.confirmSaved]) {
      const result = await action(core.browserStore, current.snapshot, again.pending, actor, at); mismatchRejected.push(result.kind === 'conflict');
    }
    const mismatchUnchanged = beforeMismatch === (await authority.inspectRaw()).authority;
    await authority.transact((state, store) => { store.setItem('fuzzy-stock/pending', core.serializePending(again.pending)); return { state, value: undefined }; });
    const abandoned = await repo.abandon(core.browserStore, current.snapshot, again.pending, actor, at);
    const final = await repo.load(core.browserStore);
    if (final.kind !== 'ok') throw new Error('確定後の台帳がない');
    const op3 = core.nextOpIdOf(final.snapshot), moveOne = move(final.snapshot.ledger, { eventId: op3, actor, recordedAt: at, occurredAt: at }, 'p', 'T');
    const moveTwo = move(moveOne, { eventId: `${op3}-2`, actor, recordedAt: at, occurredAt: at }, 'p', 'S2');
    core.faults.failMidwayAt = 2;
    const partial = await repo.commit(core.browserStore, final.snapshot, { opId: op3, opLabel: '二段移動', fingerprint: 'fictional-two', values: {}, actor, startedAt: at, savingSince: at },
      [moveOne, moveTwo].map((ledger, index) => ({ ledger, supply: final.snapshot.supply, conflictReviews: [], targets: [`移動${index + 1}`] })));
    if (partial.kind !== 'partial') throw new Error('一部保存にならない');
    const stopped = await repo.abandon(core.browserStore, partial.snapshot, partial.pending, actor, at);
    const afterStop = await repo.load(core.browserStore);
    return { inquiry: [inquiry.savedUnits, inquiry.total], inquiryUnchanged, confirmed: confirmed.kind, sameGeneration: sameGeneration.kind,
      settledInquiry: [settledInquiry.savedUnits, settledInquiry.total], settledInquiryUnchanged,
      oldRejected, staleCommit, oldUnchanged, mismatchRejected, mismatchUnchanged, abandoned: abandoned.kind, pendingCleared: final.pending === null,
      stopped: stopped.kind,
      stopOutcome: stopped.kind === 'settled' ? stopped.outcome : undefined,
      partialSaved: [partial.saved, partial.total],
      location: afterStop.kind === 'ok' ? afterStop.snapshot.ledger.lots['p']?.location : null,
      remainderCleared: afterStop.kind === 'ok' && afterStop.pending === null };
  });
  expect(result).toEqual({ inquiry: [1, 1], inquiryUnchanged: true, confirmed: 'settled', sameGeneration: 'recovered',
    settledInquiry: [1, 1], settledInquiryUnchanged: true,
    oldRejected: [true, true, true, true], staleCommit: 'conflict', oldUnchanged: true, mismatchRejected: [true, true, true, true], mismatchUnchanged: true, abandoned: 'settled', pendingCleared: true,
    stopped: 'settled', stopOutcome: null, partialSaved: [1, 2], location: 'T', remainderCleared: true });
});
