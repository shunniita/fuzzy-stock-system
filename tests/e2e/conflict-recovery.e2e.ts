import { expect, test, type Page } from '@playwright/test';
import { selectOperation, goTo, backupButton, cell, downloadVia, filePayload, lot, opLabels, pickFile, recorded, startEmpty, waitForApp } from './helpers.ts';
import { installLegacyFileDraft } from './legacy-compat.ts';
import { parseConflictDraft } from '../../src/ui/conflictrecord.ts';
import { draftKey, draftOf, openWithHooks, oversizedConflict, readyToSave, sharedKeys, snapshotOf, twoPages, typeUse, withdrawButton } from './conflict-helpers.ts';

test('更新競合：未送信の入力を退避し、再読込後に最新記録と別に示し、照合結果を保存しても数量は変わらない', async ({ page, context }) => {
  const other = await twoPages(page, context);
  await typeUse(other);
  await recorded(page, 'move', { lot: 'p', location: 'T' }, '09:00');
  const panel = other.locator('#conflict');
  await expect(panel).toContainText('未解消');
  await expect(panel).toContainText('状態：未送信');
  await expect(panel).toContainText(/数量（.*）：" 2\.5"/);
  await expect(panel).toContainText('この元入力は数量・台帳へ反映されていません');
  await expect(other.locator('#input')).toContainText('新しい入力は作りません');
  expect(await draftOf(other)).toContain('fuzzy-stock-conflict-draft');
  const before = await sharedKeys(page);
  await goTo(page, 'stock');
  const quantity = await cell(page, 'p', '記録上の数と根拠').textContent();

  await other.reload();
  await waitForApp(other);
  await expect(panel).toContainText('未解消');
  await expect(panel).toContainText(/数量（.*）：" 2\.5"/);
  await expect(panel).toContainText('現在の記録（最新）');
  expect(await sharedKeys(other)).toEqual(before);

  await panel.getByLabel('元入力を控えた').check();
  await expect(panel.getByRole('button', { name: /保存する/ })).toBeDisabled();
  await panel.getByLabel('最新記録から入力し直す').check();
  await panel.getByLabel('理由').fill('最新記録を確認した');
  await panel.getByLabel('最新の記録を確認した').check();
  await expect(panel.getByRole('button', { name: '「最新記録から入力し直す」で保存する' })).toBeEnabled();
  // 確認したあとに理由を変えると、確認は失効して保存できなくなる。
  await panel.getByLabel('理由').fill('最新記録を確認した（修正）');
  await expect(panel.getByLabel('最新の記録を確認した')).not.toBeChecked();
  await expect(panel.getByRole('button', { name: '「最新記録から入力し直す」で保存する' })).toBeDisabled();
  await panel.getByLabel('最新の記録を確認した').check();
  await panel.getByRole('button', { name: '「最新記録から入力し直す」で保存する' }).click();
  await expect(panel).toContainText('確定済み：最新記録から入力し直す');
  await expect(panel).toContainText('確認者：');
  await expect(panel).toContainText('登録したことにはなりません');
  await expect(other.getByRole('form', { name: '操作の入力' })).toBeVisible();
  // 照合後の通常フォームは最新の状態から作り直す。元入力の値も確認済みの状態も持ち込まない。
  const fresh = other.getByRole('form', { name: '操作の入力' });
  await expect(fresh.locator('[name=op]')).toHaveValue('register');
  await expect(fresh.locator('[name=confirmed]')).not.toBeChecked();
  await expect(fresh.locator('[name=inclusion]')).toHaveValue('');
  await expect(codeArea(other).getByLabel('読取原文・品目ID')).toHaveValue('');
  await selectOperation(fresh.locator('[name=op]'), { label: opLabels.use });
  await expect(fresh.locator('[name=value]')).toHaveValue('');
  await expect(fresh.locator('[name=usedFor]')).toHaveValue('');
  expect(await draftOf(other)).toBeNull();

  const saved = await snapshotOf(other);
  expect(saved.conflictReviews).toHaveLength(1);
  expect(saved.conflictReviews[0]).toMatchObject({ resolution: { outcome: 'reenter', reason: '最新記録を確認した（修正）' }, draft: { origin: { kind: 'unsent' }, opLabel: '使用' } });
  expect(saved.conflictReviews[0]?.draft.fields.some(f => f.kind === 'text' && f.value === ' 2.5')).toBe(true);
  await page.reload();
  await waitForApp(page);
  expect(await cell(page, 'p', '記録上の数と根拠').textContent()).toBe(quantity);
  expect((await snapshotOf(page)).ledger.history.map(e => e.kind)).toEqual((await snapshotOf(other)).ledger.history.map(e => e.kind));
  expect((await snapshotOf(page)).ledger.history.some(e => e.kind === 'use')).toBe(false);
  await other.reload();
  await waitForApp(other);
  // 未解消の入力はもう無いが、確定した照合記録は業務操作の履歴とは別に参照できる。
  await expect(other.locator('#conflict')).toContainText('確定した照合記録（1件');
  await expect(other.locator('#conflict')).not.toContainText('未解消：更新競合');
  await expect(other.locator('#conflict')).toContainText('確認者：');
  await other.close();
});

test('更新競合：既定のまま変更のない入力は退避せず、再読込の案内だけを出す', async ({ page, context }) => {
  const other = await twoPages(page, context);
  await recorded(page, 'move', { lot: 'p', location: 'T' }, '09:00');
  await expect(other.locator('#input')).toContainText('別の画面で記録が保存された');
  await expect(other.locator('#conflict')).toBeHidden();
  expect(await draftOf(other)).toBeNull();
  await other.close();
});

test('更新競合：通知なしの操作ID衝突は再読込まで照合を止め、最新の操作IDで一度だけ確定する', async ({ page, context }) => {
  const other = await twoPages(page, context, true);
  await typeUse(other, '3');
  await recorded(page, 'move', { lot: 'p', location: 'T' }, '09:00');
  const bytes = await sharedKeys(page);
  await other.getByRole('form', { name: '操作の入力' }).getByRole('button', { name: '記録する' }).click();
  const panel = other.locator('#conflict');
  await expect(panel).toContainText('この送信では書込前に拒否');
  await expect(panel).toContainText(/数量（.*）："3"/);
  expect(await sharedKeys(page)).toEqual(bytes);
  expect(await draftOf(other)).toContain('"kind":"rejected"');
  await expect.poll(() => draftOf(other)).toContain('"reason":"identityCollision"');
  await expect(panel).toContainText('再読込してから照合してください');
  await expect(panel).not.toContainText('現在の記録（最新）');
  await panel.getByLabel('元入力を控えた').check();
  await panel.getByLabel('この入力を取り下げる').check();
  await panel.getByLabel('理由').fill('他画面の移動を確認');
  await panel.getByLabel('最新の記録を確認した').check();
  await expect(panel.getByRole('button', { name: /で保存する/ })).toBeDisabled();
  expect(await sharedKeys(page)).toEqual(bytes);
  const latest = await snapshotOf(page);
  await other.locator('#save').getByRole('button', { name: '再読込する' }).click();
  await waitForApp(other);
  await expect(panel).toContainText(`記録の版：${latest.revision}`);
  await expect(panel).toContainText('現在の記録（最新）');
  await panel.getByLabel('元入力を控えた').check();
  await panel.getByLabel('この入力を取り下げる').check();
  await panel.getByLabel('理由').fill('他画面の移動を確認');
  await panel.getByLabel('最新の記録を確認した').check();
  await panel.getByRole('button', { name: /で保存する/ }).click();
  await expect(panel).toContainText('確定済み：この入力を取り下げる');
  const saved = await snapshotOf(other);
  expect(saved.conflictReviews).toHaveLength(1);
  expect(saved.conflictReviews[0]?.eventId).not.toBe(latest.lastWriter);
  expect(saved.ledger).toEqual(latest.ledger);
  expect(saved.supply).toEqual(latest.supply);
  expect(await draftOf(other)).toBeNull();
  await other.close();
});

test('更新競合：版番号が同じでも写しの内容が違う操作ID衝突を中断する', async ({ page, context }) => {
  const other = await twoPages(page, context, true);
  const originalRevision = (await snapshotOf(other)).revision;
  await typeUse(other, '3');
  await recorded(page, 'move', { lot: 'p', location: 'T' }, '09:00');
  // 復元等で版番号が一致しても、操作索引と記録が別内容の写しを検査する。
  await page.evaluate(revision => {
    const key = `fuzzy-stock/slot-${localStorage.getItem('fuzzy-stock/head')}`;
    const stored = JSON.parse(localStorage.getItem(key)!);
    stored.revision = revision;
    localStorage.setItem(key, JSON.stringify(stored));
  }, originalRevision);
  expect((await snapshotOf(page)).revision).toBe(originalRevision);
  const before = await sharedKeys(page);
  await other.getByRole('form', { name: '操作の入力' }).getByRole('button', { name: '記録する' }).click();
  await expect.poll(() => draftOf(other)).toContain('"reason":"identityCollision"');
  await expect(other.locator('#conflict')).toContainText('再読込してから照合してください');
  await expect(other.locator('#conflict')).not.toContainText('現在の記録（最新）');
  expect(await sharedKeys(page)).toEqual(before);
  await other.close();
});

test('更新競合：照合保存そのものの操作IDが他画面に使われても、元入力を保全して再読込を求める', async ({ page, context }) => {
  const other = await twoPages(page, context, true);
  await typeUse(other, '3');
  await recorded(page, 'move', { lot: 'p', location: 'T' }, '09:00');
  await other.getByRole('form', { name: '操作の入力' }).getByRole('button', { name: '記録する' }).click();
  await expect(other.locator('#conflict')).toContainText('操作IDの内容不一致');
  await other.reload();
  await waitForApp(other);
  const panel = other.locator('#conflict');
  await panel.getByLabel('元入力を控えた').check();
  await panel.getByLabel('この入力を取り下げる').check();
  await panel.getByLabel('理由').fill('最新記録を確認した');
  await panel.getByLabel('最新の記録を確認した').check();
  await recorded(page, 'move', { lot: 'p', location: 'S1' }, '10:00');
  const before = await sharedKeys(page);
  const draft = await draftOf(other);
  await panel.getByRole('button', { name: /で保存する/ }).click();
  await expect(panel).toContainText('再読込してから照合してください');
  await expect(panel).not.toContainText('現在の記録（最新）');
  await expect(panel.getByRole('button', { name: /で保存する/ })).toBeDisabled();
  expect(await sharedKeys(page)).toEqual(before);
  expect(await draftOf(other)).toBe(draft);
  expect((await snapshotOf(page)).conflictReviews).toHaveLength(0);
  await other.close();
});

test('更新競合：退避できないときは入力をこの画面に残し、転記用に示して再読込を止める', async ({ page, context }) => {
  const other = await twoPages(page, context);
  await typeUse(other, '4');
  await other.evaluate(key => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name: string, value: string) { if (name === key) throw new Error('架空の退避先の容量不足'); return original.call(this, name, value); };
  }, draftKey);
  const before = await sharedKeys(page);
  await recorded(page, 'move', { lot: 'p', location: 'T' }, '09:00');
  const panel = other.locator('#conflict');
  await expect(panel).toContainText('退避に失敗');
  await expect(panel).toContainText('架空の退避先の容量不足');
  await expect(panel).toContainText(/数量（.*）："4"/);
  await expect(other.getByRole('form', { name: '操作の入力' }).locator('[name=value]')).toHaveValue('4');
  await expect(other.getByRole('form', { name: '操作の入力' }).locator('[name=value]')).toBeDisabled();
  await expect(panel.getByRole('button', { name: '再読込する' })).toBeDisabled();
  // 保存の状態の欄の「再読込する」も、退避できていない入力を消す再読込にはしない。
  await other.locator('#save').getByRole('button', { name: '再読込する' }).click();
  await expect(other.getByRole('form', { name: '操作の入力' }).locator('[name=value]')).toHaveValue('4');
  await expect(panel).toContainText('再読込すると入力が消えます');
  // 退避できない入力が画面にあるあいだは、初期化の確認も作らない（外部更新を検出済みの画面なので、再読込の案内で止まる）。
  await goTo(other, 'management');
  await other.getByRole('button', { name: '練習用の台帳で初期化' }).click();
  await goTo(other, 'management');
  await expect(other.getByRole('button', { name: '初期化する', exact: true })).toHaveCount(0);
  await goTo(other, 'stock');
  await expect(other.getByRole('form', { name: '操作の入力' }).locator('[name=value]')).toHaveValue('4');
  expect(await draftOf(other)).toBeNull();
  expect(Object.keys(await sharedKeys(page)).sort()).toEqual(Object.keys(before).sort());
  await other.close();
});

test('更新競合：読めない退避は原文のまま残し、控えの確認後にだけ取り下げられる', async ({ page }) => {
  await startEmpty(page);
  await page.evaluate(key => sessionStorage.setItem(key, '壊れた<b>退避</b>\r\n'), draftKey);
  const before = await sharedKeys(page);
  await page.reload();
  await waitForApp(page);
  const panel = page.locator('#conflict');
  await expect(panel).toContainText('読めない退避があります');
  await expect(panel).toContainText(JSON.stringify('壊れた<b>退避</b>\r\n'));
  await expect(panel.locator('b')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '読めない退避だけを取り下げる' })).toBeDisabled();
  await goTo(page, 'management');
  await page.getByRole('button', { name: '練習用の台帳で初期化' }).click();
  await expect(page.locator('#management-feedback')).toContainText('読めない退避の原文を控えて取り下げてから');
  await panel.getByLabel('原文を控えた').check();
  await panel.getByRole('button', { name: '読めない退避だけを取り下げる' }).click();
  await expect(panel).toBeHidden();
  expect(await draftOf(page)).toBeNull();
  expect(await sharedKeys(page)).toEqual(before);
});

test('更新競合：二度目の外部更新の通知で、未解消の元入力を上書きしない', async ({ page, context }) => {
  const other = await twoPages(page, context);
  await typeUse(other, '5');
  await recorded(page, 'move', { lot: 'p', location: 'T' }, '09:00');
  await expect(other.locator('#conflict')).toContainText('未解消');
  const first = await draftOf(other);
  await recorded(page, 'move', { lot: 'p', location: 'S1' }, '10:00');
  await other.waitForTimeout(300);
  expect(await draftOf(other)).toBe(first);
  await other.close();
});

test('更新競合：全体が置き換わった後の送信（保存前検査の競合）も、元入力を退避して保存先を変えない', async ({ page, context }) => {
  const other = await twoPages(page, context, true);
  await typeUse(other, '6');
  await goTo(page, 'management');
  await page.getByRole('button', { name: '練習用の台帳で初期化' }).click();
  await page.getByRole('button', { name: '初期化する', exact: true }).click();
  await expect.poll(async () => (await snapshotOf(page)).ledger.history.length).toBe(0);
  const bytes = await sharedKeys(page);
  await other.getByRole('form', { name: '操作の入力' }).getByRole('button', { name: '記録する' }).click();
  const panel = other.locator('#conflict');
  await expect(panel).toContainText('この送信では書込前に拒否');
  await expect(panel).toContainText('版の相違');
  expect(await sharedKeys(page)).toEqual(bytes);
  await other.close();
});

test('更新競合：退避した元入力と内容の違う照合結果がすでにあるときは、退避を削除せず未解消のまま示す', async ({ page, context }) => {
  const other = await twoPages(page, context);
  await typeUse(other, ' 2.5');
  await recorded(page, 'move', { lot: 'p', location: 'T' }, '09:00');
  await other.reload();
  await waitForApp(other);
  const panel = other.locator('#conflict');
  const raw = await draftOf(other);
  await panel.getByLabel('元入力を控えた').check();
  await panel.getByLabel('この入力を取り下げる').check();
  await panel.getByLabel('理由').fill('取り下げる');
  await panel.getByLabel('最新の記録を確認した').check();
  await panel.getByRole('button', { name: /で保存する/ }).click();
  await expect(panel).toContainText('確定済み：この入力を取り下げる');
  // 同じ識別子で内容の違う退避が残っている状態を作って読み戻す。
  await other.evaluate(([key, value]) => sessionStorage.setItem(key!, value!), [draftKey, raw!.replace('" 2.5"', '" 9.9"')]);
  await other.reload();
  await waitForApp(other);
  await expect(panel).toContainText('未解消');
  await expect(panel).toContainText('内容の違う照合結果がすでに保存されています');
  // 同じ元入力の結果が保存済みなら、別の結果を確認しても保存できない。
  await panel.getByLabel('元入力を控えた').check();
  await panel.getByLabel('最新記録から入力し直す').check();
  await panel.getByLabel('理由').fill('別の結果');
  await panel.getByLabel('最新の記録を確認した').check();
  await expect(panel.getByRole('button', { name: /で保存する/ })).toBeDisabled();
  await expect(panel).toContainText('同じ元入力の照合結果がすでに保存されています。別の結果では保存しません');
  expect(await draftOf(other)).toContain('9.9');
  await other.close();
});

test('更新競合：照合結果の署名を計算している間に結果を変えると、古い決定を保存しない', async ({ page, context }) => {
  const other = await twoPages(page, context);
  await typeUse(other, ' 2.5');
  await recorded(page, 'move', { lot: 'p', location: 'T' }, '09:00');
  await other.reload();
  await waitForApp(other);
  await other.evaluate(() => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = async (...args: Parameters<typeof digest>) => { await new Promise(resolve => setTimeout(resolve, 600)); return digest(...args); };
  });
  const panel = other.locator('#conflict');
  await panel.getByLabel('元入力を控えた').check();
  await panel.getByLabel('最新記録から入力し直す').check();
  await panel.getByLabel('理由').fill('理由');
  await panel.getByLabel('最新の記録を確認した').check();
  const before = await sharedKeys(other);
  await panel.getByRole('button', { name: '「最新記録から入力し直す」で保存する' }).click();
  expect(await other.locator('#app').evaluate(node => node instanceof HTMLElement && node.inert)).toBe(true);
  await panel.getByLabel('この入力を取り下げる').evaluate(node => {
    if (!(node instanceof HTMLInputElement)) throw new Error('選択欄がない');
    node.checked = true; node.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(panel).toContainText('計算中に記録または入力が変わった');
  expect(await sharedKeys(other)).toEqual(before);
  expect((await snapshotOf(other)).conflictReviews).toHaveLength(0);
  await other.close();
});

async function resolveFirst(panel: import('@playwright/test').Locator): Promise<void> {
  await panel.getByLabel('元入力を控えた').check();
  await panel.getByLabel('最新記録から入力し直す').check();
  await panel.getByLabel('理由').fill('最新記録を確認した');
  await panel.getByLabel('最新の記録を確認した').check();
  await panel.getByRole('button', { name: '「最新記録から入力し直す」で保存する' }).click();
  await expect(panel).toContainText('確定済み');
}

test('更新競合：照合を確定した後の新しい入力も、続く別画面の更新で元入力として退避する', async ({ page, context }) => {
  const other = await twoPages(page, context);
  await typeUse(other, '7');
  await recorded(page, 'move', { lot: 'p', location: 'T' }, '09:00');
  await other.reload();
  await waitForApp(other);
  const panel = other.locator('#conflict');
  await resolveFirst(panel);
  // 確定済みの欄に出している記録は、一覧に二重に出さない。
  await expect(panel).toContainText('うち1件は上に表示中');
  await expect(panel.getByText('確定済み：', { exact: false })).toHaveCount(1);
  await typeUse(other, '8');
  // 照合結果の保存は共有の保存先を更新するので、最初の画面も再読込してから次の更新を行う。
  await page.reload();
  await waitForApp(page);
  await recorded(page, 'move', { lot: 'p', location: 'S1' }, '10:00');
  await expect(panel).toContainText('未解消');
  await expect(panel).toContainText(/数量（.*）："8"/);
  expect(await draftOf(other)).toContain('"8"');
  await other.close();
});

const codeArea = (page: Page) => page.getByRole('region', { name: 'コード入力補助' });
async function adoptCode(page: Page): Promise<void> {
  const form = page.getByRole('form', { name: '操作の入力' });
  await selectOperation(form.locator('[name=op]'), { label: opLabels.register });
  await codeArea(page).getByLabel('読取原文・品目ID').fill('LABA|B-001|P');
  await codeArea(page).getByRole('button', { name: '解釈', exact: true }).click();
  await codeArea(page).getByLabel('コードの入力先').selectOption('item');
  await codeArea(page).locator('[data-code-options]').getByRole('button', { name: /架空部品P/ }).click();
}

test('更新競合：コードを採用して対象を確認する前に外部更新を受けても、例外にせず元入力として退避する', async ({ page, context }) => {
  const other = await twoPages(page, context);
  await adoptCode(other);
  await recorded(page, 'move', { lot: 'p', location: 'T' }, '09:00');
  const panel = other.locator('#conflict');
  await expect(panel).toContainText('未解消');
  await expect(panel).toContainText('LABA|B-001|P');
  await expect(other.locator('#input')).toContainText('別の画面で記録が保存された');
  expect(await draftOf(other)).toContain('LABA');
  await other.close();
});

test('更新競合：コード入力補助の読取原文だけを入れた状態も、変更ありとして元入力に含める', async ({ page, context }) => {
  const other = await twoPages(page, context);
  await selectOperation(other.getByRole('form', { name: '操作の入力' }).locator('[name=op]'), { label: opLabels.register });
  await codeArea(other).getByLabel('読取原文・品目ID').fill('LABA|B-001|P');
  await recorded(page, 'move', { lot: 'p', location: 'T' }, '09:00');
  await expect(other.locator('#conflict')).toContainText('コード入力補助の読取原文');
  await expect(other.locator('#conflict')).toContainText('LABA|B-001|P');
  await other.close();
});

test('旧競合退避：読み取れなかったファイルは、読取中ではなく読取失敗として表示する', async ({ page, context }) => {
  const other = await twoPages(page, context);
  await installLegacyFileDraft(other, 'failed', '', '壊れた文書.json');
  await expect(other.locator('#conflict')).toContainText('読取失敗');
  await expect(other.locator('#conflict')).not.toContainText('読取中（読み終えていない）');
  await other.close();
});

test('更新競合：署名の計算中に「元入力を控えた」を外すと、保存しない', async ({ page, context }) => {
  const other = await twoPages(page, context);
  await typeUse(other, ' 2.5');
  await recorded(page, 'move', { lot: 'p', location: 'T' }, '09:00');
  await other.reload();
  await waitForApp(other);
  await other.evaluate(() => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = async (...args: Parameters<typeof digest>) => { await new Promise(resolve => setTimeout(resolve, 600)); return digest(...args); };
  });
  const panel = other.locator('#conflict');
  await panel.getByLabel('元入力を控えた').check();
  await panel.getByLabel('最新記録から入力し直す').check();
  await panel.getByLabel('理由').fill('理由');
  await panel.getByLabel('最新の記録を確認した').check();
  await panel.getByRole('button', { name: '「最新記録から入力し直す」で保存する' }).click();
  expect(await other.locator('#app').evaluate(node => node instanceof HTMLElement && node.inert)).toBe(true);
  await panel.getByLabel('元入力を控えた').evaluate(node => {
    if (!(node instanceof HTMLInputElement)) throw new Error('確認欄がない');
    node.checked = false; node.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(panel).toContainText('計算中に記録または入力が変わった');
  expect((await snapshotOf(other)).conflictReviews).toHaveLength(0);
  await other.close();
});

test('更新競合：コード入力補助の検索語だけを入れた状態も、変更ありとして元入力に含める', async ({ page, context }) => {
  const other = await twoPages(page, context);
  await selectOperation(other.getByRole('form', { name: '操作の入力' }).locator('[name=op]'), { label: opLabels.register });
  await codeArea(other).getByLabel('名称・品番・コードで検索').fill('架空部品');
  await recorded(page, 'move', { lot: 'p', location: 'T' }, '09:00');
  await expect(other.locator('#conflict')).toContainText('コード入力補助の検索語');
  await expect(other.locator('#conflict')).toContainText('架空部品');
  expect(await draftOf(other)).toContain('架空部品');
  await other.close();
});

test('更新競合：コード入力補助の入力先だけを選んだ状態も、変更ありとして元入力に含める', async ({ page, context }) => {
  const other = await twoPages(page, context);
  await selectOperation(other.getByRole('form', { name: '操作の入力' }).locator('[name=op]'), { label: opLabels.register });
  await codeArea(other).getByLabel('コードの入力先').selectOption('item');
  await recorded(page, 'move', { lot: 'p', location: 'T' }, '09:00');
  await expect(other.locator('#conflict')).toContainText('コード入力補助の入力先の選択');
  expect(await draftOf(other)).toContain('"item"');
  await other.close();
});

test('更新競合：通知が届かないまま「復元用バックアップを保存」で外部の更新を検出しても、編集中の入力を元入力として退避する', async ({ page, context }) => {
  const other = await twoPages(page, context, true);
  await typeUse(other, '9');
  await recorded(page, 'move', { lot: 'p', location: 'T' }, '09:00');
  const bytes = await sharedKeys(page);
  await goTo(other, 'management');
  await other.getByRole('button', { name: '復元用バックアップを保存' }).click();
  const panel = other.locator('#conflict');
  await expect(panel).toContainText('未解消');
  await expect(panel).toContainText(/数量（.*）："9"/);
  expect(await sharedKeys(page)).toEqual(bytes);
  await other.close();
});

test('更新競合：未解消の元入力があるあいだ、通常の初期化と復元の入口で止め、保存先も退避も変えない', async ({ page, context }) => {
  const other = await twoPages(page, context);
  await typeUse(other, ' 2.5');
  await recorded(page, 'move', { lot: 'p', location: 'T' }, '09:00');
  await other.reload();
  await waitForApp(other);
  await expect(other.locator('#conflict')).toContainText('未解消');
  const shared = await sharedKeys(other);
  const draft = await draftOf(other);
  await goTo(other, 'management');
  for (const name of ['練習用の台帳で初期化', '標準サンプルデータで初期化']) {
    await other.getByRole('button', { name }).click();
    await expect(other.locator('#management-feedback')).toContainText('未解消の更新競合の入力があるため、初期化・復元はしません');
    await goTo(other, 'management');
    await expect(other.getByRole('button', { name: '初期化する', exact: true })).toHaveCount(0);
  }
  let chooser = false;
  other.on('filechooser', () => { chooser = true; });
  await other.getByRole('button', { name: 'バックアップから復元' }).click();
  await expect(other.locator('#management-feedback')).toContainText('初期化・復元はしません');
  await other.waitForTimeout(300);
  expect(chooser).toBe(false);
  expect(await sharedKeys(other)).toEqual(shared);
  expect(await draftOf(other)).toBe(draft);
  await other.close();
});

test('更新競合：保存先を読めない状態からの明示復元は退避を保持して通し、復元後に照合を再開できる', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('p', 'P', 'S1', 'counted', '20'), '08:00');
  const backup = await downloadVia(page, backupButton);
  const draft = parseConflictDraft({ reviewId: 'review-e2e', origin: { kind: 'unsent' }, opKey: 'use', opLabel: '使用', actor: '架空担当A', occurredAt: null, baseRevision: 2, baseLastWriter: 'op1',
    detectedAt: '2026-10-17T04:00:00+09:00', detectedReason: '別画面の更新', fields: [{ kind: 'text', name: 'value', label: '数量', value: ' 4.5' }], readEvidence: [], targets: [], unapplied: ['未送信・数量へ未反映'] });
  const raw = JSON.stringify({ format: 'fuzzy-stock-conflict-draft', version: 1, draft });
  await page.evaluate(([key, value]) => sessionStorage.setItem(key!, value!), [draftKey, raw]);
  await page.evaluate(() => localStorage.setItem('fuzzy-stock/head', '壊れた値'));
  await page.reload();
  await expect(page.locator('#save')).toContainText('保存された記録を読み込めない');
  expect(await draftOf(page)).toBe(raw);
  await pickFile(page, backup.path, 'バックアップから復元する');
  await page.getByRole('button', { name: '復元する', exact: true }).click();
  const panel = page.locator('#conflict');
  await expect(panel).toContainText('未解消');
  await expect(panel).toContainText(/数量.*" 4\.5"/);
  expect(await draftOf(page)).toBe(raw);
  await page.reload();
  await waitForApp(page);
  await expect(panel).toContainText('未解消');
  expect((await snapshotOf(page)).conflictReviews).toHaveLength(0);
  // 復元の後に、退避した元入力の照合を再開して保存できる。
  await resolveFirst(panel);
  expect((await snapshotOf(page)).conflictReviews).toHaveLength(1);
  expect(await draftOf(page)).toBeNull();
});

test('更新競合：読めない退避を取り下げても、保存中・結果不明の操作の保留は解除しない', async ({ page }) => {
  await startEmpty(page);
  await page.evaluate(key => sessionStorage.setItem(key, '壊れた退避'), draftKey);
  // 応答喪失の試験用フックは、URLに?testを付けたときだけ使える。
  await page.goto('/?test');
  await waitForApp(page);
  await expect(page.locator('#conflict')).toContainText('読めない退避があります');
  await page.evaluate(() => window.fuzzyStockTest?.loseResponseAt(1));
  // 退避が読めないあいだは新しいフォームが無いので、保存中の操作は退避を取り下げた後に作る。
  await page.locator('#conflict').getByLabel('原文を控えた').check();
  await page.locator('#conflict').getByRole('button', { name: '読めない退避だけを取り下げる' }).click();
  await expect(page.locator('#conflict')).toBeHidden();
  await recorded(page, 'register', lot('p', 'P', 'S1', 'counted', '3'), '08:00').catch(() => undefined);
  await expect(page.locator('#save')).toContainText('保存結果不明');
  // 保存中の操作があるあいだ、照合もバックアップも新しい入力も止まる。ここで読めない退避を再び置いても保留は変わらない。
  await page.evaluate(key => sessionStorage.setItem(key, '再び壊れた退避'), draftKey);
  await page.reload();
  await waitForApp(page);
  await expect(page.locator('#conflict')).toContainText('読めない退避があります');
  await expect(page.locator('#save')).toContainText('保存結果不明');
  await page.locator('#conflict').getByLabel('原文を控えた').check();
  await page.locator('#conflict').getByRole('button', { name: '読めない退避だけを取り下げる' }).click();
  await expect(page.locator('#conflict')).toBeHidden();
  await expect(page.locator('#save')).toContainText('保存結果不明');
  await expect(page.locator('#input')).toContainText('確かめてから');
  await expect(page.getByRole('form', { name: '操作の入力' })).toHaveCount(0);
});

test('更新競合：初期化で消えた確定済みの照合記録の表示を残さず、バックアップから復元すると元入力・結果・確認者・日時を参照できる', async ({ page, context }) => {
  const other = await twoPages(page, context);
  await typeUse(other, ' 2.5');
  await recorded(page, 'move', { lot: 'p', location: 'T' }, '09:00');
  await other.reload();
  await waitForApp(other);
  const panel = other.locator('#conflict');
  await resolveFirst(panel);
  const backup = await downloadVia(other, backupButton);
  await goTo(other, 'management');
  await other.getByRole('button', { name: '練習用の台帳で初期化' }).click();
  await goTo(other, 'management');
  await other.getByRole('button', { name: '初期化する', exact: true }).click();
  await expect(panel).toBeHidden();
  await pickFile(other, backup.path);
  await other.getByRole('button', { name: '復元する', exact: true }).click();
  await expect(panel).toContainText('確定した照合記録（1件');
  await expect(panel).toContainText(/数量（.*）：" 2\.5"/);
  await expect(panel).toContainText('理由："最新記録を確認した"');
  await expect(panel).toContainText('確認者：');
  await expect(panel).toContainText('確認日時：');
  expect((await snapshotOf(other)).conflictReviews).toHaveLength(1);
  await other.close();
});

test('更新競合：通知なしの送信で退避に失敗したら、初期化の確認を作らず転記を案内する', async ({ page, context }) => {
  const other = await twoPages(page, context, true);
  await typeUse(other, '4');
  await other.evaluate(key => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name: string, value: string) { if (name === key) throw new Error('架空の退避先の容量不足'); return original.call(this, name, value); };
  }, draftKey);
  await recorded(page, 'move', { lot: 'p', location: 'T' }, '09:00');
  await other.getByRole('form', { name: '操作の入力' }).getByRole('button', { name: '記録する' }).click();
  await expect(other.locator('#conflict')).toContainText('退避に失敗');
  await goTo(other, 'management');
  await other.getByRole('button', { name: '練習用の台帳で初期化' }).click();
  await expect(other.locator('#management-feedback')).toContainText('初期化・復元はしません');
  await expect(other.locator('#management-feedback')).toContainText('元入力を転記し');
  await goTo(other, 'management');
  await expect(other.getByRole('button', { name: '初期化する', exact: true })).toHaveCount(0);
  await other.close();
});

test('更新競合：復元したバックアップに、退避と同じ元入力の確定済みの照合記録があれば、退避を削除して確定済みにする', async ({ page, context }) => {
  const other = await twoPages(page, context);
  await typeUse(other, ' 2.5');
  await recorded(page, 'move', { lot: 'p', location: 'T' }, '09:00');
  await other.reload();
  await waitForApp(other);
  const raw = await draftOf(other);
  const panel = other.locator('#conflict');
  await resolveFirst(panel);
  const backup = await downloadVia(other, backupButton);
  await goTo(other, 'management');
  await other.getByRole('button', { name: '練習用の台帳で初期化' }).click();
  await goTo(other, 'management');
  await other.getByRole('button', { name: '初期化する', exact: true }).click();
  await expect(panel).toBeHidden();
  await other.evaluate(([key, value]) => sessionStorage.setItem(key!, value!), [draftKey, raw!]);
  await other.evaluate(() => localStorage.setItem('fuzzy-stock/head', '壊れた値'));
  await other.reload();
  await expect(other.locator('#save')).toContainText('保存された記録を読み込めない');
  await pickFile(other, backup.path, 'バックアップから復元する');
  await other.getByRole('button', { name: '復元する', exact: true }).click();
  await expect(panel).toContainText('確定済み');
  expect(await draftOf(other)).toBeNull();
  expect((await snapshotOf(other)).conflictReviews).toHaveLength(1);
  await other.close();
});

test('更新競合：照合結果の保存で応答を失うと候補を固定し、元入力を保存結果不明と示さず、再試行で同じ候補を一度だけ確定する', async ({ page, context }) => {
  const other = await twoPages(page, context);
  await typeUse(other, ' 2.5');
  await recorded(page, 'move', { lot: 'p', location: 'T' }, '09:00');
  const panel = await openWithHooks(other);
  const raw = await draftOf(other);
  const before = await snapshotOf(other);
  await readyToSave(panel, '応答喪失の確認');
  await other.evaluate(() => window.fuzzyStockTest!.loseResponseAt(1));
  await panel.getByRole('button', { name: /で保存する/ }).click();
  const save = other.locator('#save');
  await expect(save).toContainText('保存結果不明');
  await expect(save).toContainText('更新競合の照合結果');
  await expect(panel).toContainText('照会・再試行・取りやめを選んでください');
  // 元入力そのものは未送信のまま。照合結果を保存する操作だけが結果不明になる。
  await expect(panel).toContainText('未解消');
  await expect(panel).toContainText('状態：未送信');
  await expect(panel).not.toContainText('状態：保存結果不明');
  expect(await draftOf(other)).toBe(raw);
  const landed = await snapshotOf(other);
  expect(landed.conflictReviews).toHaveLength(1);
  const fixed = landed.conflictReviews[0]!;
  // 写しには書けていても、結果を確かめるまで確定済みとは示さない。
  await expect(panel).not.toContainText('確定済み');
  await expect(panel).not.toContainText('確定した照合記録');
  await expect(panel).toContainText('照合記録1件（うち保存結果を確認中の1件）');
  await expect(panel.getByRole('button', { name: '記録せずにこのタブの退避を取り下げる' })).toHaveCount(0);
  // 結果不明のあいだは、確認し直しても新しい操作IDの候補へ移らない。
  const held = await sharedKeys(other);
  await panel.getByLabel('最新の記録を確認した').check();
  await expect(panel.getByRole('button', { name: /で保存する/ })).toBeDisabled();
  await expect(panel).toContainText('保存中・結果不明の操作を、照会・再試行・取りやめで確かめてから照合してください');
  expect(await sharedKeys(other)).toEqual(held);
  await other.reload();
  await waitForApp(other);
  await expect(save).toContainText('保存結果不明');
  // 再読込で照合フォームは空に戻っても、再試行・確定する固定候補の理由・確認者・確認日時は保存中の単位から読める。
  await expect(save).toContainText('保存結果を確認中の照合結果（固定した候補');
  await expect(save).toContainText(`理由：${JSON.stringify(fixed.resolution.reason)}`);
  await expect(save).toContainText(`確認者：${fixed.resolution.actor}`);
  await expect(save).toContainText(`確認日時：${fixed.resolution.at}`);
  await expect(panel).toContainText('未解消');
  await readyToSave(panel, '応答喪失の確認');
  await expect(panel.getByRole('button', { name: /で保存する/ })).toBeDisabled();
  expect(await draftOf(other)).toBe(raw);
  await save.getByRole('button', { name: '再試行する', exact: true }).click();
  await expect(panel).toContainText('確定済み：この入力を取り下げる');
  const after = await snapshotOf(other);
  expect(after.conflictReviews).toEqual([fixed]);
  expect(after.ledger).toEqual(before.ledger);
  expect(after.supply).toEqual(before.supply);
  expect(await draftOf(other)).toBeNull();
  await other.close();
});

test('更新競合：結果不明の照合結果を未保存と照会して取りやめると、明示の再確認で最新の操作IDと確認日時の候補を一度だけ確定する', async ({ page, context }) => {
  const other = await twoPages(page, context);
  await typeUse(other, ' 2.5');
  await recorded(page, 'move', { lot: 'p', location: 'T' }, '09:00');
  const panel = await openWithHooks(other);
  const raw = await draftOf(other);
  const before = await snapshotOf(other);
  await readyToSave(panel, '一回目');
  // 写しの書込に失敗し、見出しも読めない：書けたかどうか分からない。
  await other.evaluate(() => {
    const write = Storage.prototype.setItem, read = Storage.prototype.getItem;
    let failed = false;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('fuzzy-stock/slot-')) { failed = true; Storage.prototype.setItem = write; throw new Error('架空の保存失敗'); }
      write.call(this, key, value);
    };
    Storage.prototype.getItem = function (key) {
      if (failed && key === 'fuzzy-stock/head') { Storage.prototype.getItem = read; throw new Error('架空の読込失敗'); }
      return read.call(this, key);
    };
  });
  await panel.getByRole('button', { name: /で保存する/ }).click();
  const save = other.locator('#save');
  await expect(save).toContainText('保存結果不明');
  await save.getByRole('button', { name: '照会する', exact: true }).click();
  await expect(save).toContainText('1単位中0単位が保存済み');
  await save.getByRole('button', { name: '取りやめる', exact: true }).click();
  await expect(save).toContainText('未保存のまま取りやめた');
  // 取りやめても元入力は未解消のまま残り、古い確認では保存できない。
  await expect(panel).toContainText('未解消');
  expect(await draftOf(other)).toBe(raw);
  await expect(panel.getByLabel('最新の記録を確認した')).not.toBeChecked();
  await expect(panel.getByRole('button', { name: /で保存する/ })).toBeDisabled();
  const abandoned = await snapshotOf(other);
  expect(abandoned.conflictReviews).toHaveLength(0);
  expect(abandoned.saveChecks.map(check => [check.opLabel, check.resolution.outcome])).toEqual([['更新競合の照合結果', 'abandoned']]);
  const first = abandoned.saveChecks[0]!;
  await panel.getByLabel('理由').fill('二回目');
  await panel.getByLabel('最新の記録を確認した').check();
  await panel.getByRole('button', { name: /で保存する/ }).click();
  await expect(panel).toContainText('確定済み：この入力を取り下げる');
  const after = await snapshotOf(other);
  expect(after.conflictReviews).toHaveLength(1);
  expect(after.conflictReviews[0]!.eventId).not.toBe(first.opId);
  expect(after.conflictReviews[0]!.resolution.reason).toBe('二回目');
  expect(after.ledger).toEqual(before.ledger);
  expect(after.supply).toEqual(before.supply);
  expect(await draftOf(other)).toBeNull();
  await other.close();
});

test('更新競合：書込前に失敗した照合候補の操作IDを別画面が使っても、再読込後の再確認で新しい操作IDにより一度だけ確定する', async ({ page, context }) => {
  const other = await twoPages(page, context);
  await typeUse(other, ' 2.5');
  await recorded(page, 'move', { lot: 'p', location: 'T' }, '09:00');
  const panel = await openWithHooks(other);
  const raw = await draftOf(other);
  await readyToSave(panel, '一回目');
  const attempted = await snapshotOf(other);
  await other.evaluate(() => window.fuzzyStockTest!.failMidwayAt(1));
  await panel.getByRole('button', { name: /で保存する/ }).click();
  await expect(panel).toContainText('照合結果を保存できませんでした（元入力は残しています）');
  // 未保存と分かった候補は失効する。同じ確認のまま別の候補を作らない。
  await expect(panel.getByLabel('最新の記録を確認した')).not.toBeChecked();
  await expect(panel.getByRole('button', { name: /で保存する/ })).toBeDisabled();
  expect(await snapshotOf(other)).toEqual(attempted);
  expect(await draftOf(other)).toBe(raw);
  // 別画面が、未保存だった候補と同じ次の操作IDで記録する（失敗した書込の通知で止まっているので読み直す）。
  await page.reload();
  await waitForApp(page);
  await recorded(page, 'move', { lot: 'p', location: 'S1' }, '10:00');
  const taken = await snapshotOf(page);
  expect(taken.revision).toBe(attempted.revision + 1);
  // 失敗した照合候補が使うはずだった操作IDを、別画面の記録が使ったことを固定する。
  expect(taken.lastWriter).toBe(`op${Math.max(attempted.ledger.history.length + attempted.supply.log.length + 1, attempted.opFloor)}`);
  await expect(panel).toContainText('再読込してから照合してください');
  await other.locator('#save').getByRole('button', { name: '再読込する' }).click();
  await waitForApp(other);
  await readyToSave(panel, '二回目');
  await panel.getByRole('button', { name: /で保存する/ }).click();
  await expect(panel).toContainText('確定済み：この入力を取り下げる');
  const after = await snapshotOf(other);
  expect(after.conflictReviews).toHaveLength(1);
  expect(after.conflictReviews[0]!.eventId).not.toBe(taken.lastWriter);
  expect(after.conflictReviews[0]!.resolution.reason).toBe('二回目');
  expect(after.ledger).toEqual(taken.ledger);
  expect(await draftOf(other)).toBeNull();
  await other.close();
});

test('更新競合：照合記録が容量の上限を超えると確定を止め、控えと明示の確認の後にだけ記録せずにこのタブの退避を取り下げる', async ({ page, context }) => {
  const { other, panel } = await oversizedConflict(page, context);
  await readyToSave(panel, '容量の確認');
  await expect(panel).toContainText(/この照合記録：\d+ bytes／上限65536 bytes/);
  await expect(panel).toContainText('容量の上限を超えるため、この照合結果は確定できません');
  await expect(panel).toContainText('「復元用バックアップを保存」');
  await expect(panel.getByRole('button', { name: /で保存する/ })).toBeDisabled();
  await expect(panel).toContainText('照合記録の容量の上限を超えるため保存できません');
  await expect(panel).toContainText('共有の照合記録・確認者・解消結果は残りません');
  const before = await sharedKeys(other);
  const raw = await draftOf(other);
  await expect(withdrawButton(panel)).toBeDisabled();
  await panel.getByLabel('共有の照合記録を残さずに取り下げることを確認した').check();
  // 削除に失敗しても退避と元入力を残し、成功と推測しない。
  await other.evaluate(key => {
    const remove = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (name: string) { if (name === key) { Storage.prototype.removeItem = remove; throw new Error('架空の削除失敗'); } return remove.call(this, name); };
  }, draftKey);
  await withdrawButton(panel).click();
  await expect(panel).toContainText('退避を取り下げられませんでした（元入力は残しています）：架空の削除失敗');
  expect(await draftOf(other)).toBe(raw);
  await expect(panel).toContainText('未解消');
  await withdrawButton(panel).click();
  await expect(panel).toContainText('このタブの退避を記録せずに取り下げました。照合済みではありません。');
  await expect(panel).not.toContainText('確定済み');
  expect(await draftOf(other)).toBeNull();
  expect(await sharedKeys(other)).toEqual(before);
  // 最新の状態から新しい通常入力を作り、元入力の値や確認を持ち込まない。
  const fresh = other.getByRole('form', { name: '操作の入力' });
  await expect(fresh).toBeVisible();
  await expect(fresh.locator('[name=confirmed]')).not.toBeChecked();
  await selectOperation(fresh.locator('[name=op]'), { label: opLabels.use });
  await expect(fresh.locator('[name=usedFor]')).toHaveValue('');
  await other.close();
});

test('更新競合：理由だけが長くて容量の上限を超えるときは、記録なしの取下げを示さず、理由を短くすれば保存できる', async ({ page, context }) => {
  const other = await twoPages(page, context);
  await typeUse(other, ' 2.5');
  await recorded(page, 'move', { lot: 'p', location: 'T' }, '09:00');
  await other.reload();
  await waitForApp(other);
  const panel = other.locator('#conflict');
  await readyToSave(panel, '理'.repeat(25000));
  await expect(panel).toContainText('容量の上限を超えるため、この照合結果は確定できません');
  await expect(panel).toContainText('理由を短くすれば上限内に収まり、保存できます。');
  await expect(panel.getByRole('button', { name: /で保存する/ })).toBeDisabled();
  await expect(withdrawButton(panel)).toHaveCount(0);
  await panel.getByLabel('理由').fill('短い理由');
  await panel.getByLabel('最新の記録を確認した').check();
  await panel.getByRole('button', { name: /で保存する/ }).click();
  await expect(panel).toContainText('確定済み：この入力を取り下げる');
  expect((await snapshotOf(other)).conflictReviews).toHaveLength(1);
  await other.close();
});

test('更新競合：記録なし取下げを確認した後に別画面の更新があれば取り下げず、再読込後も古い確認を戻さない', async ({ page, context }) => {
  const { other, panel } = await oversizedConflict(page, context);
  await readyToSave(panel, '容量の確認');
  await panel.getByLabel('共有の照合記録を残さずに取り下げることを確認した').check();
  const raw = await draftOf(other);
  await recorded(page, 'move', { lot: 'p', location: 'S1' }, '10:00');
  await expect(panel).toContainText('再読込してから照合してください');
  await expect(withdrawButton(panel)).toHaveCount(0);
  expect(await draftOf(other)).toBe(raw);
  await other.locator('#save').getByRole('button', { name: '再読込する' }).click();
  await waitForApp(other);
  await expect(panel).toContainText('容量の上限を超える');
  await expect(panel.getByLabel('共有の照合記録を残さずに取り下げることを確認した')).not.toBeChecked();
  await expect(withdrawButton(panel)).toBeDisabled();
  expect(await draftOf(other)).toBe(raw);
  await other.close();
});

test('更新競合：通知が届かないまま別画面が記録しても、記録なし取下げの実行時に保存先を読み直して取り下げない', async ({ page, context }) => {
  const { other, panel } = await oversizedConflict(page, context);
  // 画面のstorageイベントの受け手を、試験から止められるようにして開き直す（退避は同じタブなので残る）。
  await other.addInitScript(() => {
    const add = window.addEventListener.bind(window);
    window.addEventListener = ((type: string, listener: EventListener, ...rest: unknown[]) => add(type, type === 'storage'
      ? (event: Event) => { if (!(window as unknown as { blockStorage?: boolean }).blockStorage) listener(event); } : listener, ...(rest as []))) as typeof window.addEventListener;
  });
  await other.reload();
  await waitForApp(other);
  await readyToSave(panel, '容量の確認');
  await panel.getByLabel('共有の照合記録を残さずに取り下げることを確認した').check();
  // ここからこの画面には別画面の更新の通知(storageイベント)を届けない。
  await other.evaluate(() => { (window as unknown as { blockStorage?: boolean }).blockStorage = true; });
  const raw = await draftOf(other);
  await recorded(page, 'move', { lot: 'p', location: 'S1' }, '10:00');
  const after = await sharedKeys(page);
  await expect(withdrawButton(panel)).toBeEnabled();
  await withdrawButton(panel).click();
  await expect(panel).toContainText('保存先が変わった、または保存中の操作があるため、取り下げませんでした');
  expect(await draftOf(other)).toBe(raw);
  expect(await sharedKeys(other)).toEqual(after);
  await other.close();
});

test('更新競合：照合結果の保存が保存先の容量不足で失敗したら上限超過と区別し、同じ候補のときだけ記録なしの取下げを示す', async ({ page, context }) => {
  const other = await twoPages(page, context);
  await typeUse(other, ' 2.5');
  await recorded(page, 'move', { lot: 'p', location: 'T' }, '09:00');
  await other.reload();
  await waitForApp(other);
  const panel = other.locator('#conflict');
  await readyToSave(panel, '容量不足の確認');
  // 容量に問題がなければ、記録なしの取下げは示さない。
  await expect(withdrawButton(panel)).toHaveCount(0);
  const before = await sharedKeys(other);
  await other.evaluate(() => {
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.startsWith('fuzzy-stock/slot-')) { Storage.prototype.setItem = write; throw new DOMException('架空の保存先の容量不足', 'QuotaExceededError'); }
      return write.call(this, key, value);
    };
  });
  await panel.getByRole('button', { name: /で保存する/ }).click();
  await expect(panel).toContainText('保存先の容量が不足して照合結果を保存できませんでした（容量の上限の超過ではありません。未保存です）');
  await expect(panel).toContainText('保存先の容量不足で失敗し、未保存と確認しました');
  await expect(panel).not.toContainText('容量の上限を超えるため、この照合結果は確定できません');
  expect(await sharedKeys(other)).toEqual(before);
  // 結果を変えると別の候補になり、古い容量不足を根拠にしない。
  await panel.getByLabel('最新記録から入力し直す').check();
  await expect(withdrawButton(panel)).toHaveCount(0);
  await panel.getByLabel('この入力を取り下げる').check();
  await panel.getByLabel('共有の照合記録を残さずに取り下げることを確認した').check();
  await withdrawButton(panel).click();
  await expect(panel).toContainText('このタブの退避を記録せずに取り下げました');
  expect(await draftOf(other)).toBeNull();
  expect(await sharedKeys(other)).toEqual(before);
  await other.close();
});
