import { expect, test, type Page } from '@playwright/test';
import { decodeSnapshot } from '../../src/ui/storageparse.ts';
import { selectOperation, goTo, cell, lot, opLabels, record, recorded, set, startEmpty, storageBytes, waitForApp } from './helpers.ts';

// 部分確認ATの照合（PARTIAL_AT_CONDITION_AUDIT_20261016）で「未実施」だった条件を、既存の機能に対して確かめる。
test.use({ trace: 'retain-on-failure' });
const form = (page: Page) => page.getByRole('form', { name: '操作の入力' });
async function snapshot(page: Page) {
  const raw = await page.evaluate(() => localStorage.getItem(`fuzzy-stock/slot-${localStorage.getItem('fuzzy-stock/head')}`));
  if (!raw) throw new Error('保存済みの台帳がない');
  return decodeSnapshot(JSON.parse(raw));
}

test('AT-33の追補: 最後に数えた数が古いだけでは、時間が経って再読込しても確認が必要を作らない', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-17T09:00:00+09:00'));
  await startEmpty(page);
  await selectOperation(form(page).locator('[name=op]'), { label: opLabels.register });
  for (const [name, value] of Object.entries(lot('OLD', 'P', 'S1', 'counted', '100'))) await set(form(page).locator(`[name=${name}]`), value);
  await form(page).locator('[name=occurredAt]').fill('2025-03-01T09:00');
  await form(page).getByRole('button', { name: '記録する' }).click();
  await expect(page.getByRole('status')).toContainText('記録した');
  const check = async () => {
    await goTo(page, 'stock');
    await expect(cell(page, 'OLD', '記録上の数と根拠')).toHaveText('100個・数えた');
    await expect(cell(page, 'OLD', '最後に数えた数')).toContainText('2025-03-01');
    await expect(cell(page, 'OLD', '確認が必要')).not.toContainText('確認が必要');
    await goTo(page, 'issues');
    await expect(page.locator('#issues')).toContainText('確認事項はない');
  };
  await check();
  expect((await snapshot(page)).ledger.issues).toEqual({});
  // 一年後に開き直しても、古い確認日を理由に確認事項を作らず、保存先も書き換えない。
  const bytes = await storageBytes(page);
  await page.clock.setFixedTime(new Date('2027-10-17T09:00:00+09:00'));
  await page.reload(); await waitForApp(page);
  await check();
  expect(await storageBytes(page)).toEqual(bytes);
});

test('AT-33の追補: 登録情報の品番・コードの衝突は、確認後に両方の登録情報で対象・理由・前後の値・担当・時刻を参照できる', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'masterItem', { codeNone: true, name: '品目不明の試作部品', units: '個' }, '08:10');
  await record(page, 'masterCode', { target: '品目（仮）品目不明の試作部品「品目不明の試作部品」', code: 'Q', reason: '架空の正式ID判明' }, '08:20');
  await expect(page.getByRole('status')).toContainText('確認が必要');
  await expect(page.getByRole('status')).toContainText('品番・コード Q は品目Q「架空部品Q」（利用中）が使っている');
  await form(page).locator('[name=confirmed]').check();
  await form(page).getByRole('button', { name: '記録する' }).click();
  await expect(page.getByRole('status')).toContainText('記録した');
  const historyOf = async (master: string) => {
    await goTo(page, 'masters');
    await page.locator('#masters [name=master-history]').selectOption({ label: master });
    return page.getByRole('table', { name: '登録情報の変更の履歴' });
  };
  // 対象の両登録情報・前後の値・理由・確認・発生時刻・記録時刻・担当が、どちらの登録情報の履歴からも同じ一行で読める。再読込後も同じ。
  const verify = async () => {
    for (const master of ['品目Q「品目不明の試作部品」', '品目（仮）架空部品Q「架空部品Q」']) {
      const entry = (await historyOf(master)).locator('tr', { hasText: 'op2' });
      await expect(entry).toContainText('品目「架空部品Q」の品番・コード Q → 品番・コードなし（仮）');
      await expect(entry).toContainText('品目「品目不明の試作部品」の品番・コード 品番・コードなし（仮） → Q');
      await expect(entry).toContainText('理由「架空の正式ID判明」');
      await expect(entry).toContainText('確認して記録');
      await expect(entry).toContainText(/2026-09-29 08:20（日本時間）\s*\d{4}-\d{2}-\d{2} \d{2}:\d{2}（日本時間）\s*架空担当A/);
    }
  };
  await verify();
  await page.reload(); await waitForApp(page);
  await verify();
});

test('AT-50の追補: 数え直し・やり直し・修理の実回収という物理の確認と、誤使用の取消という記録訂正を重ねても、同じ差異を二度反映しない', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('parts', 'P', 'S1', 'counted', '100'), '08:00');
  await recorded(page, 'start', { newId: 'work', item: 'R', project: 'A-001', location: 'T', process: 'R組立', basis: 'counted', value: '20', m1lot: 'parts', m1basis: 'counted', m1value: '20' }, '09:00');
  await recorded(page, 'finish', { lot: 'work', childId: 'inspect', basis: 'counted', value: '20' }, '10:00');
  await recorded(page, 'inspect', { lot: 'inspect', childId: 'finished', basis: 'counted', value: '20' }, '11:00');
  await recorded(page, 'reworkBegin', { lot: 'finished', childId: 'repair', basis: 'counted', value: '2', reason: '架空の手直し' }, '11:30');
  await goTo(page, 'issues');
  const reworkId = (await snapshot(page)).ledger.history.find(e => e.kind === 'rework')?.eventId;
  if (reworkId === undefined) throw new Error('やり直し・修理の記録がない');
  await goTo(page, 'stock');
  await expect(cell(page, 'parts', '記録上の数と根拠')).toHaveText('記録上の数80個');

  // 記録の誤り：部品2を使ったと記録したが、実際には使っていない。
  await recorded(page, 'use', { lot: 'parts', basis: 'counted', value: '2', usedFor: '架空の誤使用' }, '12:00');
  await expect(cell(page, 'parts', '記録上の数と根拠')).toHaveText('記録上の数78個');
  await goTo(page, 'issues');
  const mistaken = (await snapshot(page)).ledger.history.findLast(e => e.kind === 'use');
  if (mistaken === undefined) throw new Error('取消対象の使用記録がない');
  // 物理の確認：棚で80個を数えた（原因はまだ分からない）。
  await recorded(page, 'recount', { lot: 'parts', value: '80', causeUnknown: true }, '12:30');
  await goTo(page, 'stock');
  await expect(cell(page, 'parts', '記録上の数と根拠')).toHaveText('80個・数えた');
  // 記録訂正：誤使用を取り消しても、数え直しで現物に合わせた差異を足し戻さない。
  await recorded(page, 'void', { target: mistaken.eventId, reason: '実際は使っていない。数量は数え直し済み' }, '13:00');
  await expect(cell(page, 'parts', '記録上の数と根拠')).toHaveText('80個・数えた');
  await goTo(page, 'issues');
  expect((await snapshot(page)).ledger.history.at(-1)).toMatchObject({ kind: 'void', targetEventId: mistaken.eventId, applied: false, changes: [] });
  // 物理の回収：やり直し・修理で外した部品2は別の保管単位として使用可否の確認待ちにし、元の部品の数量へ足さない。
  await recorded(page, 'reworkRecover', { reworkId, subjectLotId: 'repair', newId: 'recovered', item: 'P', location: 'S1', value: '2', reason: '架空回収' }, '13:30');
  await goTo(page, 'stock');
  await expect(cell(page, 'parts', '記録上の数と根拠')).toHaveText('80個・数えた');
  await expect(cell(page, 'recovered', '記録上の数と根拠')).toHaveText('2個・数えた');
  await expect(cell(page, 'recovered', '取り分けた理由')).toContainText('使用可否確認待ち');

  const saved = await snapshot(page), bytes = await storageBytes(page);
  // 取り消した誤使用は消さずに一件だけ残る（作業の開始による材料の使用は別の記録）。
  expect(saved.ledger.history.filter(e => e.kind === 'use' && e.usedFor === '架空の誤使用')).toHaveLength(1);
  expect(saved.ledger.history.filter(e => e.kind === 'reworkPart' && e.action === 'recover')).toHaveLength(1);
  expect(saved.ledger.lots['parts']?.quantity).toMatchObject({ numeric: { value: 80 } });
  expect(saved.ledger.lots['recovered']?.quantity).toMatchObject({ numeric: { value: 2 } });
  const history = page.locator('#history');
  await goTo(page, 'issues');
  await expect(history).toContainText('使用先 架空の誤使用・記録誤りとして取消済み');
  await expect(history).toContainText('今の数量に反映されていないため数量は変えていない');
  await page.reload(); await waitForApp(page);
  await expect(cell(page, 'parts', '記録上の数と根拠')).toHaveText('80個・数えた');
  await expect(cell(page, 'recovered', '取り分けた理由')).toContainText('使用可否確認待ち');
  expect(await snapshot(page)).toEqual(saved);
  expect(await storageBytes(page)).toEqual(bytes);
});
