import { test, expect } from '@playwright/test';

test('FH-SCR-CORE: 明示移行・旧原資料保持・native中断・別接続・旧writer検出', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#updated')).toContainText('最終記録更新');
  const observed = await page.evaluate(async () => {
    const authorityPath = '/dist/ui/shared-authority.js', storagePath = '/dist/ui/storage.js';
    const { SharedAuthority, coreValues }: typeof import('../../src/ui/shared-authority.ts') = await import(authorityPath);
    const storage: typeof import('../../src/ui/storage.ts') = await import(storagePath);
    const loaded = storage.load(localStorage);
    if (loaded.kind !== 'ok') throw new Error('架空初期値がない');
    const original = JSON.stringify(coreValues(localStorage));
    const authority = new SharedAuthority(localStorage, indexedDB, 'FH-SCR-CORE');
    const before = await authority.read();
    const generation = await authority.enable(loaded.snapshot);
    const enabled = await authority.read();
    let aborted = false;
    try {
      await authority.transact((state, core) => {
        if (state === null) throw new Error('共有保存がない');
        state.archive['fictional'] = 'original';
        storage.replace(core, loaded.snapshot, { ledger: loaded.snapshot.ledger, supply: loaded.snapshot.supply });
        return { state, value: 'must-not-return-success' };
      }, { abortAfterWrite: true });
    } catch { aborted = true; }
    const afterAbort = await new SharedAuthority(localStorage, indexedDB, 'FH-SCR-CORE').read();
    localStorage.setItem('fuzzy-stock/pending', 'fictional-old-writer');
    let oldWriterBlocked = false;
    try { await authority.read(); } catch { oldWriterBlocked = true; }
    return { initiallyLegacy: before.state === null, generation: enabled.state?.generation === generation,
      originalRetained: JSON.stringify(enabled.state?.legacy) === original,
      unchanged: JSON.stringify(afterAbort) === JSON.stringify(enabled), aborted, oldWriterBlocked };
  });
  expect(observed).toEqual({ initiallyLegacy: true, generation: true, originalRetained: true, unchanged: true, aborted: true, oldWriterBlocked: true });
});
