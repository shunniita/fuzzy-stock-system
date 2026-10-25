import { expect, test, type Page } from '@playwright/test';
import * as XLSX from 'xlsx';
import { decodeSnapshot } from '../../src/ui/storageparse.ts';
import { selectOperation, goTo, backupButton, cell, downloadVia, exportButton, lot, opLabels, pickFile, record, recorded, row, set, startEmpty, storageBytes } from './helpers.ts';

test.use({ trace: 'retain-on-failure' });

test('AT-35・AT-52・QTY-05b: 精度上限を超える1箱あたりの数の換算でも、記録・再読込・閲覧出力を続けられる', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await startEmpty(page);
  await recorded(page, 'register', lot('S-large', 'S', 'S1', 'counted', '2', { unit: '箱', project: 'common' }), '11:00');
  await recorded(page, 'masterPerBox', { target: 'item:S', perBox: '9007199254740991', reason: '架空の精度境界試験' }, '10:00');
  const screws = page.locator('#consumables article[data-stock="S"]');
  await goTo(page, 'supply');
  await expect(screws).toContainText('合算していない分（整数の精度を保てる上限を超える）：S-large 2箱');
  await expect(screws).toContainText('補充の要否を断定できない');
  await expect(screws).not.toContainText('合算していない分（1箱あたりの数が分からない');
  await goTo(page, 'stock');
  await expect(cell(page, 'S-large', '記録上の数と根拠')).toContainText('2箱・数えた');
  await page.reload();
  await goTo(page, 'supply');
  await expect(screws).toContainText('整数の精度を保てる上限を超える');
  await recorded(page, 'register', lot('S-safe', 'S', 'S2', 'counted', '1', { unit: '箱', project: 'common' }), '12:00');
  await expect(screws).toContainText('数量の数値部分の小計');
  await expect(screws).toContainText('9007199254740991本');
  const view = await downloadVia(page, exportButton);
  const book = XLSX.read(view.bytes, { type: 'array' });
  const rows = XLSX.utils.sheet_to_json<string[]>(book.Sheets['保管単位']!, { header: 1, raw: true });
  expect(rows.find((r) => r[0] === 'S-large')?.join(' ')).toContain('2箱');
  expect(errors).toEqual([]);
});

test('AT-35・要件7.9: 再開後への出発日時訂正は断り、保存内容と再開後の通常移動を保つ', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('P-1', 'P', 'S1', 'counted', '2'), '09:00');
  await recorded(page, 'move', { lot: 'P-1', location: 'S2' }, '09:30');
  await recorded(page, 'masterScope', { target: 'location:S1', inScope: 'false', reason: '移管' }, '10:00');
  await recorded(page, 'masterScope', { target: 'location:S1', inScope: 'true', reason: '再開' }, '11:00');
  const before = await storageBytes(page);
  for (const time of ['11:00', '11:30']) {
    await expect(await record(page, 'correctTime', { target: 'op2', corrected: `2026-09-29T${time}` }, '12:00')).toContainText('より後まで物が置かれていた');
    expect(await storageBytes(page)).toEqual(before);
  }
  await recorded(page, 'correctTime', { target: 'op2', corrected: '2026-09-29T10:00' }, '12:00');
  await recorded(page, 'move', { lot: 'P-1', location: 'S1' }, '11:30');
  await goTo(page, 'stock');
  await expect(cell(page, 'P-1', '場所')).toContainText('S1');
  await page.reload();
  await expect(cell(page, 'P-1', '場所')).toContainText('S1');
});

test('AT-35・要件7.9: 2回の使用で0になった物でも、先の使用を再開後へ訂正して対象外期間の物を消さない', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('P-1', 'P', 'S1', 'counted', '2'), '09:00');
  await recorded(page, 'use', { lot: 'P-1', basis: 'counted', value: '1', usedFor: '架空作業' }, '09:15');
  await recorded(page, 'use', { lot: 'P-1', basis: 'counted', value: '1', usedFor: '架空作業' }, '09:30');
  await recorded(page, 'masterScope', { target: 'location:S1', inScope: 'false', reason: '移管' }, '10:00');
  await recorded(page, 'masterScope', { target: 'location:S1', inScope: 'true', reason: '再開' }, '11:00');
  const before = await storageBytes(page);
  await expect(await record(page, 'correctTime', { target: 'op2', corrected: '2026-09-29T11:30' }, '12:00')).toContainText('より後まで物が置かれていた');
  expect(await storageBytes(page)).toEqual(before);
  await recorded(page, 'correctTime', { target: 'op2', corrected: '2026-09-29T09:45' }, '12:00');
  await expect(cell(page, 'P-1', '記録上の数と根拠')).toContainText('記録上の数0個');
  await page.reload();
  await expect(cell(page, 'P-1', '記録上の数と根拠')).toContainText('記録上の数0個');
});

test('AT-35・要件7.9: 使用の間で統合しても、先の使用日時の訂正で対象外期間の物を消さない', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('P-a', 'P', 'S1', 'counted', '2'), '09:00');
  await recorded(page, 'use', { lot: 'P-a', basis: 'counted', value: '1', usedFor: '架空作業' }, '09:15');
  await recorded(page, 'register', lot('P-b', 'P', 'S1', 'counted', '0'), '09:00');
  await recorded(page, 'merge', { lot: 'P-a', target: 'P-b' }, '09:30');
  await recorded(page, 'use', { lot: 'P-b', basis: 'counted', value: '1', usedFor: '架空作業' }, '09:45');
  await recorded(page, 'masterScope', { target: 'location:S1', inScope: 'false', reason: '移管' }, '10:00');
  await recorded(page, 'masterScope', { target: 'location:S1', inScope: 'true', reason: '再開' }, '11:00');
  const before = await storageBytes(page);
  await expect(await record(page, 'correctTime', { target: 'op2', corrected: '2026-09-29T11:30' }, '12:00')).toContainText('より後まで物が置かれていた');
  expect(await storageBytes(page)).toEqual(before);
  await recorded(page, 'correctTime', { target: 'op2', corrected: '2026-09-29T09:50' }, '12:00');
  await expect(cell(page, 'P-b', '記録上の数と根拠')).toContainText('記録上の数0個');
  await page.reload();
  await expect(cell(page, 'P-b', '記録上の数と根拠')).toContainText('記録上の数0個');
});

test('AT-52・QTY-05b: 箱ごとの換算が安全でも合計が精度上限を超える場合は、小計と未合算部分を表示する', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await startEmpty(page);
  await recorded(page, 'masterPerBox', { target: 'item:S', perBox: '4503599627370496', reason: '架空の精度境界試験' }, '10:00');
  for (const id of ['S-a', 'S-b']) {
    await recorded(page, 'register', lot(id, 'S', 'S1', 'counted', '1', { unit: '箱', project: 'common' }), '11:00');
  }
  const screws = page.locator('#consumables article[data-stock="S"]');
  await goTo(page, 'supply');
  await expect(screws).toContainText('数量の数値部分の小計（本） 4503599627370496本');
  await expect(screws).toContainText('合算していない分（整数の精度を保てる上限を超える）：S-b 1箱');
  await page.reload();
  await goTo(page, 'supply');
  await expect(screws).toContainText('補充の要否を断定できない');
  expect(errors).toEqual([]);
});

const form = (page: Page) => page.getByRole('form', { name: '操作の入力' });
const masters = (page: Page, label: string) => page.getByRole('table', { name: label });
const historyOf = async (page: Page, master: string) => {
  await goTo(page, 'masters');
  await page.locator('#masters [name=master-history]').selectOption({ label: master });
  return masters(page, '登録情報の変更の履歴');
};
const firstOption = async (page: Page, op: keyof typeof opLabels, name: string): Promise<string> => {
  await selectOperation(form(page).locator('[name=op]'), { label: opLabels[op] });
  return (await form(page).locator(`[name=${name}] option`).nth(1).getAttribute('value'))!;
};

// 確認を求められたら何も保存していないことを確かめ、「確認した」に印を付けて同じ入力を再送する。
async function confirmAndRecord(page: Page, expected: RegExp | string): Promise<void> {
  const before = await storageBytes(page);
  await expect(page.getByRole('status')).toContainText('確認が必要');
  await expect(page.getByRole('status')).toContainText(expected);
  expect(await storageBytes(page)).toEqual(before);
  await form(page).locator('[name=confirmed]').check();
  await form(page).getByRole('button', { name: '記録する' }).click();
  await expect(page.getByRole('status')).toContainText('記録した');
}

test('AT-35: 登録・名称の変更・利用停止、ネジSの1箱あたりの数の変更、記録の対象の変更と履歴の注記を画面から通す', async ({ page }) => {
  await startEmpty(page);

  // 1.1・2.1・2.2: 品目を登録し、名称を変える。同じ登録情報のまま、変更の履歴に前後・担当者・理由が残る
  await recorded(page, 'masterItem', { code: 'P9', name: '架空部品P9', units: '個' }, '08:00');
  await goTo(page, 'masters');
  await expect(masters(page, '品目の登録情報').locator('tr', { hasText: '架空部品P9' })).toContainText('利用中');
  await recorded(page, 'register', lot('P9-1', 'P9', 'S1', 'counted', '5'), '08:10');
  await recorded(page, 'masterRename', { target: 'item:P9', name: '架空部品P9改', reason: '型番の変更' }, '08:20');
  const renamed = await historyOf(page, '品目P9「架空部品P9改」');
  await expect(renamed).toContainText('品目P9の名称「架空部品P9」→「架空部品P9改」');
  await expect(renamed).toContainText('理由「型番の変更」');
  await expect(renamed).toContainText('架空担当A');
  await goTo(page, 'stock');
  await expect(cell(page, 'P9-1', '品目')).toHaveText('P9');

  // 3.1・3.2・3.3: 利用停止で新しい記録の選択肢から消え、既存の保管単位は印付きで表示・訂正できる
  await recorded(page, 'masterDeactivate', { target: 'item:P9', reason: '廃番' }, '08:30');
  await selectOperation(form(page).locator('[name=op]'), { label: opLabels.register });
  await expect(form(page).locator('[name=item] option[value="P9"]')).toHaveCount(0);
  await expect(page.locator('#list [name=f-item] option', { hasText: '架空部品P9改（利用停止）' })).toHaveCount(1);
  await expect(cell(page, 'P9-1', '品目')).toHaveText('P9（利用停止）');
  await recorded(page, 'recount', { lot: 'P9-1', value: '4', causeUnknown: true }, '08:40');
  await expect(cell(page, 'P9-1', '記録上の数と根拠')).toContainText('4個');

  // 6.2・6.3: 1箱あたりの数の変更の前に受け入れた箱は1000本のまま、変更の後の箱は800本で換算する
  await recorded(page, 'register', lot('S-old', 'S', 'S1', 'counted', '2', { unit: '箱', project: 'common' }), '10:00');
  await recorded(page, 'masterPerBox', { target: 'item:S', perBox: '800', reason: '仕入先の包装の変更' }, '11:00');
  await recorded(page, 'register', lot('S-new', 'S', 'S1', 'counted', '1', { unit: '箱', project: 'common' }), '12:00');
  const screws = page.locator('#consumables article[data-stock="S"]');
  await goTo(page, 'supply');
  await expect(screws).toContainText(/S-old 2箱.*（1箱あたりの数1000本）/);
  await expect(screws).toContainText(/S-new 1箱.*（1箱あたりの数800本）/);
  await expect(screws).toContainText('2026-09-29 11:00（日本時間）以後の受け取りは800本');
  await goTo(page, 'masters');
  await expect(masters(page, '品目の登録情報').locator('tr', { hasText: '架空共通ネジS' })).toContainText('最初から1000本、2026-09-29 11:00（日本時間）から800本');

  // 7.1・7.6: 物が残っていない場所を記録の対象外にすると、新しい置き場所から消え、過去の配置には記録の時点では範囲内と注記する
  await recorded(page, 'register', lot('T-1', 'Q', 'S2', 'counted', '2'), '13:00');
  await recorded(page, 'move', { lot: 'T-1', location: 'T' }, '13:10');
  await recorded(page, 'masterScope', { target: 'location:S2', inScope: 'false', reason: '棚の撤去' }, '13:20');
  await selectOperation(form(page).locator('[name=op]'), { label: opLabels.register });
  // 7.3・7.4: 選べるかは入力中の実際の日時で決まる。適用時点より前の日時なら過去の置き場所として選べ、以後の日時や日時不明（今）なら選べない
  const place = form(page).locator('[name=location] option[value="S2"]');
  const occurred = form(page).locator('[name=occurredAt]');
  await occurred.fill('2026-09-29T13:10');
  await expect(place).toHaveJSProperty('disabled', false);
  await form(page).locator('[name=location]').selectOption('S2');
  await occurred.fill('2026-09-29T13:30');
  await expect(place).toHaveJSProperty('disabled', true);
  await expect(form(page).locator('[name=location]')).toHaveValue('');
  await occurred.fill('2026-09-29T13:10');
  await form(page).locator('[name=occurredUnknown]').check();
  await expect(place).toHaveJSProperty('disabled', true);
  await goTo(page, 'issues');
  await expect(page.locator('#history')).toContainText('（記録の時点では記録の対象。場所S2は2026-09-29 13:20（日本時間）から記録の対象外）');
  await goTo(page, 'masters');
  await expect(masters(page, '場所の登録情報').locator('tr', { hasText: '棚S2' })).toContainText('最初から記録の対象、2026-09-29 13:20（日本時間）から記録の対象外');
});

test('AT-36: 品番・コードの重複・付替えの衝突・元の資料の食い違い・仮の記録と案件・用途の結び付けを、確認を経て画面から通す', async ({ page }) => {
  await startEmpty(page);

  // 1.5: 同じ品番・コードの再登録は断り、何も保存しない
  const before = await storageBytes(page);
  await expect(await record(page, 'masterItem', { code: 'P', name: '別の部品', units: '個' }, '08:00')).toContainText(/記録していない：品番・コード P は品目P「架空部品P」/);
  expect(await storageBytes(page)).toEqual(before);

  // 4.4・4.5: 仮の品目を別の品目の品番・コードへ付け替えると衝突を示し、確認すると相手は仮になり、両方の履歴に確認した担当者が残る
  await recorded(page, 'masterItem', { codeNone: true, name: '品目不明の試作部品', units: '個' }, '08:10');
  await record(page, 'masterCode', { target: '品目（仮）品目不明の試作部品「品目不明の試作部品」', code: 'Q', reason: '正式IDの判明' }, '08:20');
  await expect(form(page).locator('[name=confirmed]')).toBeVisible();
  // 確認のあとに入力を変えたら、確認をやり直させる
  await form(page).locator('[name=reason]').fill('正式IDの判明（再確認）');
  await expect(form(page).locator('[name=confirmed]')).toBeHidden();
  await form(page).getByRole('button', { name: '記録する' }).click();
  await confirmAndRecord(page, '品番・コード Q は品目Q「架空部品Q」（利用中）が使っている');
  await goTo(page, 'masters');
  await expect(masters(page, '品目の登録情報').locator('tr', { hasText: '架空部品Q' })).toContainText('仮');
  await expect(masters(page, '品目の登録情報').locator('tr', { hasText: '架空部品Q' }).locator('td').first()).toHaveText('品番・コードなし（仮）');
  await expect(masters(page, '品目の登録情報').locator('tr', { hasText: '品目不明の試作部品' }).locator('td').first()).toHaveText('Q');
  for (const master of ['品目（仮）架空部品Q「架空部品Q」', '品目Q「品目不明の試作部品」']) {
    const history = await historyOf(page, master);
    await expect(history).toContainText('確認して記録');
    await expect(history).toContainText('架空担当A');
  }

  // 5.2・5.3・5.5: 元の資料の更新は呼び名との食い違いを示し、確認後は元の資料だけ変わる
  await record(page, 'masterSource', { type: 'item', code: 'P', sourceName: '架空部品P（元の資料の名称）', sourceRevision: '2' }, '08:30');
  await confirmAndRecord(page, '呼び名「架空部品P」と食い違う');
  await goTo(page, 'masters');
  await expect(masters(page, '品目の登録情報').locator('tr', { hasText: '架空部品P（元の資料の名称）（版2）' })).toContainText('架空部品P');

  // 8.1: 見つかった物の仮の記録を既存の保管単位と同じ現物とすると、数量は増えない
  await recorded(page, 'register', lot('P-1', 'P', 'S1', 'counted', '5'), '09:00');
  await recorded(page, 'provisional', { direction: 'found', item: 'P', location: 'S1', basis: 'counted', value: '3', note: '棚の奥' }, '09:10');
  await recorded(page, 'identify', { issue: await firstOption(page, 'identify', 'issue'), lot: 'P-1', reason: '同じ箱だった' }, '09:20');
  await goTo(page, 'stock');
  await expect(cell(page, 'P-1', '記録上の数と根拠')).toContainText('5個');

  // 8.2: 新しい保管単位として登録するときは重複の候補を示し、確認してから登録する
  await recorded(page, 'provisional', { direction: 'found', item: 'P', location: 'S1', basis: 'counted', value: '2', note: '作業台の下' }, '09:30');
  await record(page, 'adopt', { issue: await firstOption(page, 'adopt', 'issue'), newId: 'P-2', item: 'P', project: 'A-001', location: 'S1' }, '09:40');
  await confirmAndRecord(page, 'P-1');
  await expect(cell(page, 'P-2', '記録上の数と根拠')).toContainText('2個');

  // 8.4・8.5: 案件・用途が不明な保管単位を案件・用途へ結び付ける。結び付け先に同じ品目の保管単位があれば、確認してから結び付ける
  await recorded(page, 'register', lot('R-2', 'R', 'S2', 'counted', '1', { project: 'A-002' }), '09:50');
  await recorded(page, 'register', lot('U-1', 'R', 'S1', 'counted', '1', { project: 'unassigned' }), '10:00');
  await record(page, 'assignProject', { lot: 'U-1', project: 'A-002', reason: '指示書で判明' }, '10:10');
  await confirmAndRecord(page, /結び付け先に品目Rの現存する保管単位がある（R-2：場所S2）.*R-2は1台.*数えた.*案件・用途.*A-002/);
  await expect(row(page, 'U-1')).toContainText('案件・用途A-002');
});

async function storedLedger(page: Page) {
  const bytes = await storageBytes(page);
  const slot = bytes[`fuzzy-stock/slot-${bytes['fuzzy-stock/head']}`];
  if (typeof slot !== 'string') throw new Error('保存された写しがない');
  return decodeSnapshot(JSON.parse(slot)).ledger;
}

test('AT-28・AT-44の回帰: 登録情報を変えた記録は、バックアップから戻すと登録情報と変更の履歴も戻り、閲覧用の出力は現在の品番・コードと名称を示す', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'masterCode', { target: 'item:P', code: '0012', reason: '正式IDの付与' }, '08:00');
  await recorded(page, 'register', lot('M-1', 'P', 'S1', 'counted', '4'), '08:10');
  await recorded(page, 'masterItem', { codeNone: true, name: '品目不明の試作部品', units: '個' }, '08:20');
  const backup = await downloadVia(page, backupButton);
  const original = await storedLedger(page);

  await goTo(page, 'stock');
  await recorded(page, 'masterRename', { target: 'item:P', name: '架空部品P改', reason: '戻す前の変更' }, '08:30');
  await pickFile(page, backup.path);
  await page.getByRole('region', { name: '復元の確認' }).getByRole('button', { name: '復元する', exact: true }).click();
  await goTo(page, 'masters');
  await expect(masters(page, '品目の登録情報').locator('tr', { hasText: '架空部品P' }).locator('td').first()).toHaveText('0012');
  await expect(masters(page, '品目の登録情報')).not.toContainText('架空部品P改');
  await expect(masters(page, '品目の登録情報')).toContainText('品目不明の試作部品');
  await goTo(page, 'stock');
  await expect(cell(page, 'M-1', '品目')).toHaveText('0012');
  expect(await storedLedger(page)).toEqual(original);
  await expect(await historyOf(page, '品目0012「架空部品P」')).toContainText('品番・コード P → 0012');

  const view = await downloadVia(page, exportButton);
  const book = XLSX.read(view.bytes, { type: 'array' });
  const rows = (name: string): string[][] => XLSX.utils.sheet_to_json<string[]>(book.Sheets[name]!, { header: 1, raw: true });
  expect(rows('保管単位').find((r) => r[0] === 'M-1')?.slice(0, 3)).toEqual(['M-1', '0012', '架空部品P']);
  expect(rows('台帳の履歴').some((r) => r.some((c) => String(c).includes('品番・コード P → 0012')))).toBe(true);
});

// 7.3・7.4: 場所を絞る時点は、記録する欄の実際の日時。不明を選べる仮の記録の欄は黙って不明にせず台帳に断らせ、仮の記録からの登録は仮の記録の時点で台帳が判断するので絞らない
test('場所の絞り込み: 仮の記録の欄は選んだ場所を不明にしない。仮の記録からの登録の欄は実際の日時で絞らず、台帳が断る', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'masterScope', { target: 'location:S2', inScope: 'false', reason: '棚の撤去' }, '13:20');
  const choose = form(page).locator('[name=location]');
  const occurred = form(page).locator('[name=occurredAt]');

  await selectOperation(form(page).locator('[name=op]'), { label: opLabels.provisional });
  await occurred.fill('2026-09-29T13:10');
  await choose.selectOption('S2');
  for (const [name, value] of Object.entries({ direction: 'found', item: 'P', basis: 'counted', value: '3', note: '棚の奥' })) await set(form(page).locator(`[name=${name}]`), value);
  await occurred.fill('2026-09-29T13:30');
  await expect(choose).toHaveValue('S2');
  await form(page).getByRole('button', { name: '記録する' }).click();
  await expect(page.getByRole('status')).toContainText('記録の対象外');

  await occurred.fill('2026-09-29T13:10');
  await form(page).getByRole('button', { name: '記録する' }).click();
  await expect(page.getByRole('status')).toContainText('記録した');

  await selectOperation(form(page).locator('[name=op]'), { label: opLabels.adopt });
  await expect(choose.locator('option[value="S2"]')).toHaveJSProperty('disabled', false);
  await set(form(page).locator('[name=issue]'), await form(page).locator('[name=issue] option').nth(1).getAttribute('value') ?? '');
  for (const [name, value] of Object.entries({ newId: 'P-9', item: 'P', project: 'common' })) await set(form(page).locator(`[name=${name}]`), value);
  await choose.selectOption('S2');
  await occurred.fill('2026-09-29T13:40');
  await form(page).getByRole('button', { name: '記録する' }).click();
  // 外れた場所には物を残せない。絞り込みは入力欄の日時では行わず、台帳が断る
  await expect(page.getByRole('status')).toContainText('記録の対象外になったあとも物が残る');
});
