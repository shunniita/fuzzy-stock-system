import { expect, test, type Page } from '@playwright/test';
import { goTo, answer, cell, lot, record, recorded, startEmpty, totals } from './helpers.ts';

test.beforeEach(async ({ page }) => startEmpty(page));

const issueRow = (page: Page, id: string) => page.locator(`#issues tr[data-issue="${id}"]`);

// 9時に実数52。後から8時50分の使用5を入力する。
async function lateUse(page: Page) {
  await goTo(page, 'stock');
  await recorded(page, 'register', lot('X', 'P', 'S1', 'counted', '52'), '09:00');
  await expect(page.getByRole('form', { name: '操作の入力' }).locator('[name=inclusion]')).toBeHidden();
  await expect(await record(page, 'use', { lot: 'X', basis: 'counted', value: '5', usedFor: 'A-001 架空作業W1' }, '08:50')).toContainText('回答が必要');
  // 回答するまでは何も記録していない。
  await goTo(page, 'issues');
  await expect(page.locator('#history').getByRole('listitem')).toHaveCount(1);
}

test('AT-22: 後入力の使用は9時の確認に含まれていたかを尋ね、反映済みなら47に減らさず使用を履歴に残す', async ({ page }) => {
  await lateUse(page);
  await goTo(page, 'stock');
  await answer(page, 'included');
  await expect(cell(page, 'X', '記録上の数と根拠')).toHaveText('52個・数えた');
  await goTo(page, 'issues');
  await expect(page.locator('#history')).toContainText('使用：Xから5個（数えた）、使用先 A-001 架空作業W1・親から減らしていない（未適用）・確認に含まれていた');
});

test('AT-22・PR2-1: 回答欄を選ばずにもう一度記録しても、含まれていたとは扱わず記録しない', async ({ page }) => {
  await lateUse(page);
  await page.getByRole('form', { name: '操作の入力' }).getByRole('button', { name: '記録する' }).click();
  await expect(page.getByRole('status')).toContainText('回答が必要');
  await goTo(page, 'issues');
  await expect(page.locator('#history').getByRole('listitem')).toHaveCount(1);
  await goTo(page, 'stock');
  await answer(page, 'unknown');
  await expect(cell(page, 'X', '確認が必要')).toHaveText('確認が必要 1件');
});

test('AT-22: 回答の前に詳細や確認事項を見に行っても、入力と回答欄は残る', async ({ page }) => {
  await lateUse(page);
  await goTo(page, 'stock');
  await page.locator('#list').getByRole('button', { name: 'X', exact: true }).click();
  await expect(page.locator('#detail')).toContainText('最後に数えた数52個');
  await page.locator('[name=f-location]').selectOption('S1');
  await answer(page, 'notIncluded');
  await expect(cell(page, 'X', '記録上の数と根拠')).toHaveText('記録上の数47個');
});

test('AT-22: 含まれていなかったなら47にする', async ({ page }) => {
  await lateUse(page);
  await goTo(page, 'stock');
  await answer(page, 'notIncluded');
  await expect(cell(page, 'X', '記録上の数と根拠')).toHaveText('記録上の数47個');
});

test('AT-22: 分からなければ確認が必要として入力を残し、数え直して閉じられる', async ({ page }) => {
  await lateUse(page);
  await goTo(page, 'stock');
  await answer(page, 'unknown');
  await expect(cell(page, 'X', '記録上の数と根拠')).toHaveText('52個・数えた');
  await expect(cell(page, 'X', '確認が必要')).toHaveText('確認が必要 1件');
  await goTo(page, 'issues');
  await expect(issueRow(page, 'op2')).toContainText('確認が必要（未解決）後入力の包含が未確認');
  await goTo(page, 'stock');
  await recorded(page, 'recount', { lot: 'X', value: '47', causeUnknown: true }, '13:00');
  await recorded(page, 'resolve', { issue: 'op2', outcome: 'close' }, '13:05');
  await goTo(page, 'issues');
  await expect(issueRow(page, 'op2')).toContainText('解消済み');
  await expect(issueRow(page, 'op2')).toContainText('閉じた（架空担当A、2026-09-29 13:05（日本時間）、操作op4）');
  await goTo(page, 'stock');
  await expect(cell(page, 'X', '確認が必要')).toHaveText('なし');
});

test('AT-29: 台帳不足で負数になる使用は未反映の確認が必要として残し、他案件・用途は使え、数え直しのあと適用して解消できる', async ({ page }) => {
  await goTo(page, 'stock');
  await recorded(page, 'register', lot('X', 'P', 'S1', 'label', '10'), '09:00');
  await recorded(page, 'register', lot('Y', 'P', 'S2', 'counted', '50', { project: 'A-002' }), '09:00');
  await recorded(page, 'use', { lot: 'X', basis: 'counted', value: '15', usedFor: 'A-001 架空作業W1' }, '10:00');
  await expect(cell(page, 'X', '記録上の数と根拠')).toHaveText('10個・表示の数（ラベル・パッケージ）・中身未確認');
  await expect(cell(page, 'X', '確認が必要')).toHaveText('確認が必要 1件');
  await goTo(page, 'issues');
  await expect(issueRow(page, 'op3')).toContainText('負数になるため未反映');
  await expect(issueRow(page, 'op3')).toContainText('使用：Xから15個（数えた）、使用先 A-001 架空作業W1・親から減らしていない（未適用）');
  await goTo(page, 'stock');
  await expect(totals(page)).toContainText('確認が必要 1件：使用可能数として断定しない');

  await recorded(page, 'use', { lot: 'Y', basis: 'counted', value: '20', usedFor: 'A-002 架空作業W2' }, '10:10');
  await expect(cell(page, 'Y', '記録上の数と根拠')).toHaveText('記録上の数30個');

  // 使用より前の9時30分に数えて20だったと後から分かった。使用はその確認に含まれていない。
  await recorded(page, 'recount', { lot: 'X', value: '20', causeUnknown: true }, '09:30');
  await expect(await record(page, 'resolve', { issue: 'op3', outcome: 'apply' }, '12:00')).toContainText('記録した');
  await expect(cell(page, 'X', '記録上の数と根拠')).toHaveText('記録上の数5個');
  await goTo(page, 'issues');
  await expect(issueRow(page, 'op3')).toContainText('適用（架空担当A');
});

test('AT-29・PR2-3: 確認事項を片付けるは、事項と解消の仕方を選ばないと記録しない', async ({ page }) => {
  await goTo(page, 'stock');
  await recorded(page, 'register', lot('X', 'P', 'S1', 'label', '10'), '09:00');
  await recorded(page, 'use', { lot: 'X', basis: 'counted', value: '15', usedFor: 'A-001 架空作業W1' }, '10:00');
  await expect(await record(page, 'resolve', {}, '11:00')).toContainText('記録していない：確認事項を選ぶ');
  await expect(await record(page, 'resolve', { issue: 'op2' }, '11:00')).toContainText('記録していない：解消の仕方を選ぶ');
  await goTo(page, 'issues');
  await expect(issueRow(page, 'op2')).toContainText('確認が必要（未解決）');
  await goTo(page, 'stock');
  await expect(cell(page, 'X', '確認が必要')).toHaveText('確認が必要 1件');
});

test('AT-29・R-2: 保留した使用より後に数え直したなら、適用は包含を尋ね、含まれていたなら閉じるよう案内する', async ({ page }) => {
  await goTo(page, 'stock');
  await recorded(page, 'register', lot('X', 'P', 'S1', 'label', '10'), '09:00');
  await recorded(page, 'use', { lot: 'X', basis: 'counted', value: '15', usedFor: 'A-001 架空作業W1' }, '10:00');
  await recorded(page, 'recount', { lot: 'X', value: '20', causeUnknown: true }, '12:00');
  await expect(await record(page, 'resolve', { issue: 'op2', outcome: 'apply' }, '12:05')).toContainText('回答が必要');
  const form = page.getByRole('form', { name: '操作の入力' });
  await form.locator('[name=inclusion]').selectOption('included');
  await form.getByRole('button', { name: '記録する' }).click();
  await expect(page.getByRole('status')).toContainText('記録していない：確認に含まれていたなら、適用せずに閉じる');
  await expect(cell(page, 'X', '記録上の数と根拠')).toHaveText('20個・数えた');
});

test('AT-51: 実際の日時不明を入力した日時で埋めず、日本時間で表示し、訂正履歴を残す', async ({ page }) => {
  await goTo(page, 'stock');
  await recorded(page, 'register', lot('X', 'P', 'S1', 'counted', '52'), null);
  await recorded(page, 'register', lot('L', 'P', 'S1', 'label', '30'), '08:30');
  const history = page.locator('#history');
  await goTo(page, 'issues');
  await expect(history).toContainText(/op1　発生 日時不明　記録 \d{4}-\d{2}-\d{2} \d{2}:\d{2}（日本時間）/);
  await expect(history).toContainText('op2　発生 2026-09-29 08:30（日本時間）');
  await goTo(page, 'stock');
  await expect(cell(page, 'X', '最後に数えた数')).toHaveText('52個（日時不明、操作op1）');
  await expect(cell(page, 'L', '最後に数えた数')).toHaveText('数えた記録なし');

  await page.locator('#actor').selectOption('架空担当B');
  await recorded(page, 'correctTime', { target: 'op1', corrected: '2026-09-29T09:00' }, '12:00');
  await expect(cell(page, 'X', '最後に数えた数')).toHaveText('52個（2026-09-29 09:00（日本時間）、操作op1）');
  await goTo(page, 'issues');
  await expect(history).toContainText('op1　発生 2026-09-29 09:00（日本時間）（訂正前 日時不明）');
  await expect(history).toContainText('担当 架空担当B　実際の日時の訂正：操作op1を 日時不明 → 2026-09-29 09:00（日本時間）');
  await expect(history).toContainText('担当 架空担当A　登録：X');
});

test('FH-A02: 負数・包含不明・差異申告・適用対象不明を別々の確認事項にし、ラベル等だけでは作らず、該当するものだけ解消する', async ({ page }) => {
  await goTo(page, 'stock');
  await recorded(page, 'register', lot('N1', 'P', 'S1', 'counted', '10'), '09:00');
  await recorded(page, 'register', lot('L1', 'P', 'S1', 'counted', '52'), '09:00');
  await recorded(page, 'register', lot('D1', 'P', 'S2', 'counted', '30'), '09:00');
  await recorded(page, 'register', lot('Q1', 'Q', 'S1', 'label', '100'), '09:00');
  await recorded(page, 'register', lot('Q2', 'Q', 'S1', 'approximate', '100'), '09:00');
  await recorded(page, 'register', lot('Q3', 'Q', 'S1', 'unknown', ''), '09:00');
  await goTo(page, 'issues');
  await expect(page.locator('#issues')).toContainText('確認事項はない');

  await goTo(page, 'stock');
  await recorded(page, 'use', { lot: 'N1', basis: 'counted', value: '15', usedFor: 'A-001 架空作業W1' }, '10:00');
  await record(page, 'use', { lot: 'L1', basis: 'counted', value: '5', usedFor: 'A-001 架空作業W1' }, '08:50');
  await answer(page, 'unknown');
  await recorded(page, 'declare', { lot: 'D1', note: '棚に30より多く見える（架空）' }, '10:00');
  await recorded(page, 'provisional', { direction: 'found', item: '', location: 'T', basis: 'unknown', note: '品目不明の箱（架空の読取文字列 0012-AB）' }, '10:00');
  await goTo(page, 'issues');
  await expect(page.locator('#issues tbody tr')).toHaveText([
    /op7.*確認が必要（未解決）.*負数になるため未反映.*N1/,
    /op8.*確認が必要（未解決）.*後入力の包含が未確認.*L1/,
    /op9.*確認が必要（未解決）.*数の食い違いのメモ.*D1/,
    /op10.*確認が必要（未解決）.*適用対象不明（仮の記録）.*対象なし（仮の記録）/,
  ]);

  await goTo(page, 'stock');
  await recorded(page, 'recount', { lot: 'D1', value: '33', causeUnknown: true }, '11:00');
  await recorded(page, 'resolve', { issue: 'op9', outcome: 'close' }, '11:05');
  await goTo(page, 'issues');
  await expect(page.locator('#issues tbody tr').filter({ hasText: '確認が必要（未解決）' })).toHaveCount(3);
  await expect(issueRow(page, 'op9')).toContainText('解消済み');
});
