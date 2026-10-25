import { expect, test, type Page } from '@playwright/test';
import { parse } from '../../src/ui/storage.ts';
import { allOperationLabels, selectOperation, goTo, cell, lot, opLabels, recorded, row, set, startEmpty, bannerText } from './helpers.ts';

test.use({ trace: 'retain-on-failure' });

function pageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  return errors;
}

async function snapshot(page: Page) {
  const text = await page.evaluate(() => {
    const head = localStorage.getItem('fuzzy-stock/head');
    if (head !== 'A' && head !== 'B') throw new Error('保存した見出しが必要');
    return localStorage.getItem(`fuzzy-stock/slot-${head}`);
  });
  if (text === null) throw new Error('保存した写しが必要');
  return parse(text);
}

async function selectCase(page: Page, id: string): Promise<void> {
  await goTo(page, 'supply');
  await page.locator('[name=case-project]').selectOption(id);
}

const caseGroup = (page: Page, item: string) => page.locator(`#case article[data-item="${item}"]`);
const followup = (page: Page, project: string, item: string) => page.locator(`#followup tr[data-item="${item}"]`).filter({ hasText: `案件・用途${project}` });

test('FH-B03・6.1/6.4・9.1: SCN-02の数量を保ち、案件・用途詳細と対応一覧で元記録・所在・中断を別々に参照する', async ({ page }, testInfo) => {
  const errors = pageErrors(page);
  await page.goto('/');
  await goTo(page, 'management');
  await page.getByRole('button', { name: '不足・補充サンプルデータで初期化' }).click();
  await page.getByRole('button', { name: '初期化する', exact: true }).click();
  await selectCase(page, 'B-001');
  await goTo(page, 'supply');
  await expect(caseGroup(page, 'P')).toContainText('100個・表示の数（ラベル・パッケージ）・中身未確認');
  await recorded(page, 'recount', { lot: 'P-B01', value: '98' }, '09:00');
  await recorded(page, 'split', { lot: 'P-B01', childId: 'PB-bad', basis: 'counted', value: '3' }, '10:00');
  await recorded(page, 'hold', { lot: 'PB-bad', reason: 'defective' }, '10:00');
  await recorded(page, 'stop', { process: 'R組立', item: 'R', project: 'B-001', reason: '部品Pの不足', shortageItem: 'P', shortageValue: '5', affectedUnknown: true }, '10:10');
  await recorded(page, 'requestRecord', { project: 'B-001', item: 'P', quantity: '5', vendor: '架空の仕入先X', requestedOn: '2026-09-29', replyKind: 'none' }, '10:30');
  const details = caseGroup(page, 'P');
  await expect(details).toContainText('必要な数 100個');
  await expect(details).toContainText('依頼 op8：5個');
  await expect(details).toContainText('未着5個');
  await expect(details).toContainText('在庫（未使用の総数） 98個');
  await expect(details).toContainText('使用可能 95個');
  await expect(details).toContainText('不足 5個');
  await expect(details).toContainText('保管単位P-B01・所在S1');
  await expect(details).toContainText('保管単位PB-bad・所在S1');
  await expect(details).toContainText('中断 op7');
  await expect(details).toContainText('影響数不明');
  const pending = followup(page, 'B-001', 'P');
  await expect(pending.locator('td').nth(2)).toContainText('依頼 op8');
  await expect(pending.locator('td').nth(3)).toContainText('依頼済み・納期未回答');
  await expect(pending.locator('td').nth(3)).not.toContainText('中断');
  await expect(pending.locator('td').nth(4)).toContainText('中断 op7');
  await details.locator('button[data-lot="P-B01"]').click();
  await expect(page.locator('#detail')).toContainText('P-B01');
  await expect(page.locator('#detail')).toContainText('95個');

  await page.screenshot({ path: testInfo.outputPath('overview.png'), fullPage: true });
  await goTo(page, 'supply');
  await page.locator('#case').screenshot({ path: testInfo.outputPath('case.png') });
  await page.locator('#followup').screenshot({ path: testInfo.outputPath('followup.png') });
  const form = page.getByRole('form', { name: '操作の入力' });
  await selectOperation(form.locator('[name=op]'), { label: opLabels.receive });
  await expect(form.locator('[name=r3request]')).toBeVisible();
  await expect(form.locator('[name=r3request]')).toHaveValue('');
  await recorded(page, 'receive', lot('PR-1', 'P', 'S1', 'counted', '3', { project: 'B-001', r1request: 'op8', r1arrived: '3', r1good: '3' }), '11:00');
  await expect(details).toContainText('在庫（未使用の総数） 101個');
  await expect(details).toContainText('不足 2個');
  await expect(details).toContainText('未着2個');
  await expect(page.locator('#input [name=r1request]')).toHaveValue('');
  await recorded(page, 'receive', lot('PR-2', 'P', 'S1', 'counted', '2', { project: 'B-001', r1request: 'op8', r1arrived: '2', r1good: '2' }), '12:00');
  await expect(details).toContainText('在庫（未使用の総数） 103個');
  await expect(details).toContainText('使用可能 100個');
  await expect(details).toContainText('不足 0個');
  await expect(details).toContainText('中断 op7');
  await recorded(page, 'handover', { lot: 'PB-bad', basis: 'counted', value: '3', counterpart: '架空の返却先' }, '13:00');
  await expect(details).toContainText('在庫（未使用の総数） 100個');
  await expect(pending.locator('td').nth(4)).toContainText('中断 op7');
  await recorded(page, 'resume', { stop: 'op7' }, '14:00');
  await expect(details).not.toContainText('中断 op7');
  const saved = await snapshot(page);
  await page.reload();
  await selectCase(page, 'B-001');
  expect(await snapshot(page)).toEqual(saved);
  await goTo(page, 'supply');
  await expect(details).toContainText('在庫（未使用の総数） 100個');
  expect(errors).toEqual([]);
});

test('7.1〜7.3・7.6・9.2: 五つの状態を同じ行に文字で示し、中断と未回答・相手の回答日を別々に示す', async ({ page }) => {
  const errors = pageErrors(page);
  await startEmpty(page);
  await recorded(page, 'needRegister', { project: 'A-001', item: 'P', basis: 'counted', value: '20', source: '架空必要表', revision: '1' }, '07:00');
  await recorded(page, 'register', lot('available', 'P', 'S1', 'counted', '8'), '08:00');
  await recorded(page, 'register', lot('returns', 'P', 'S2', 'counted', '2'), '08:00');
  await recorded(page, 'hold', { lot: 'returns', reason: 'returnPending' }, '09:00');
  await recorded(page, 'requestRecord', { project: 'A-001', item: 'P', quantity: '4', vendor: '架空仕入先甲', requestedOn: '2026-09-25', replyKind: 'none' }, '10:00');
  await recorded(page, 'requestRecord', { project: 'A-001', item: 'P', quantity: '2', vendor: '架空仕入先乙', requestedOn: '2026-09-25', replyKind: 'answered', replyDate: '2026-09-26' }, '10:05');
  await recorded(page, 'stop', { process: 'R組立', item: 'R', project: 'A-001', reason: '架空部品P待ち', shortageItem: 'P', shortageValue: '1', affectedUnknown: true }, '11:00');
  await goTo(page, 'supply');
  await page.locator('[name=asOf]').fill('2026-09-29');
  await page.locator('[name=asOf]').dispatchEvent('change');
  const entry = followup(page, 'A-001', 'P');
  await goTo(page, 'supply');
  await expect(entry.locator('td').nth(3)).toContainText('未手配・依頼済み・納期未回答・入荷遅れ・返却待ち');
  await expect(entry.locator('td').nth(2)).toContainText('納期未回答');
  await expect(entry.locator('td').nth(2)).toContainText('相手が回答した予定日2026-09-26');
  await expect(entry.locator('td').nth(4)).toContainText('中断 op7');
  await expect(entry.locator('td').nth(3)).not.toContainText('中断 op7');
  expect(errors).toEqual([]);
});

test('FH-B05・8.1〜8.3・6.2/6.3: 工程内と各数量根拠の開始時点を登録し、作業の開始・使用を捏造せず案件・用途を分離する', async ({ page }) => {
  const errors = pageErrors(page);
  await startEmpty(page);
  const input = page.getByRole('form', { name: '操作の入力' });
  await expect(input.locator('[name=process]')).toBeVisible();
  await expect(input.locator('[name=process]').locator('..')).toContainText('工程（作業なしでは不要）');
  await expect(input.locator('[name=stage]')).toHaveValue('none');
  for (const entry of [
    ['initial-work', 'working', 'counted', '4'],
    ['initial-inspect', 'inspecting', 'label', '5'],
    ['initial-done', 'awaitingHandover', 'unknown', ''],
  ]) {
    const [id, stage, basis, value] = entry;
    if (!id || !stage || !basis || value === undefined) throw new Error('初期位置fixtureが必要');
    await recorded(page, 'register', lot(id, 'R', 'T', basis, value, { stage, process: 'R組立' }), '08:00');
  }
  await recorded(page, 'register', lot('approximate-p', 'P', 'S1', 'approximate', '2'), '08:00');
  await recorded(page, 'register', lot('defective-p', 'P', 'S2', 'counted', '1'), '08:00');
  await recorded(page, 'hold', { lot: 'defective-p', reason: 'defective' }, '09:00');
  await recorded(page, 'register', lot('label-zero', 'P', 'S2', 'label', '0'), '08:00');
  await recorded(page, 'hold', { lot: 'label-zero', reason: 'returnPending' }, '09:00');
  await recorded(page, 'register', lot('other-case', 'P', 'S1', 'counted', '99', { project: 'A-002' }), '08:00');
  await recorded(page, 'register', lot('common-p', 'P', 'S1', 'counted', '88', { project: 'common' }), '08:00');
  await recorded(page, 'register', lot('unassigned-p', 'P', 'S1', 'counted', '77', { project: 'unassigned' }), '08:00');
  await recorded(page, 'requestRecord', { project: 'A-001', item: 'Q', quantity: '6', vendor: '架空の初期依頼先', requestedOn: '2026-09-28', replyKind: 'none' }, '10:00');
  await goTo(page, 'stock');
  await expect(row(page, 'initial-work')).toContainText('作業中');
  await expect(row(page, 'initial-inspect')).toContainText('確認待ち');
  await expect(row(page, 'initial-done')).toContainText('完成（渡す前）');
  await expect(row(page, 'initial-done')).toContainText('数が不明');
  await expect(row(page, 'approximate-p')).toContainText('約2個');
  await expect(row(page, 'defective-p')).toContainText('不良');
  await expect(row(page, 'label-zero')).toContainText('0個・表示の数（ラベル・パッケージ）・中身未確認');
  const saved = await snapshot(page);
  expect(saved.ledger.history.every(event => event.kind === 'register' || event.kind === 'hold')).toBe(true);
  expect(Object.values(saved.ledger.lots).some(value => value.item === 'Q')).toBe(false);
  await selectCase(page, 'A-001');
  await goTo(page, 'supply');
  await expect(caseGroup(page, 'R')).toContainText('保管単位initial-work・所在T');
  await expect(caseGroup(page, 'R')).toContainText('4台・数えた');
  await expect(caseGroup(page, 'R')).toContainText('5台・表示の数（ラベル・パッケージ）・中身未確認');
  await expect(caseGroup(page, 'R')).toContainText('数が不明');
  await expect(page.locator('#case')).not.toContainText('other-case');
  await expect(page.locator('#case')).not.toContainText('common-p');
  await expect(page.locator('#case')).not.toContainText('unassigned-p');
  await expect(caseGroup(page, 'Q')).toContainText('未着6個');
  await expect(followup(page, 'A-001', 'P')).toContainText('返却待ち：保管単位label-zero・0個・表示の数（ラベル・パッケージ）・中身未確認');
  expect(errors).toEqual([]);
});

test('6.2・7.4/7.5: 数が不明・仮割当・食い違いを理由付きで示し、正常な同群依頼の納期状態を残す', async ({ page }) => {
  const errors = pageErrors(page);
  await startEmpty(page);
  await recorded(page, 'needRegister', { project: 'A-001', item: 'P', basis: 'counted', value: '10', source: '架空必要表', revision: '1' }, '07:00');
  await recorded(page, 'requestRecord', { project: 'A-001', item: 'P', quantity: '5', vendor: '架空仕入先甲', requestedOn: '2026-09-25', replyKind: 'none' }, '07:30');
  await recorded(page, 'receive', lot('provisional-p', 'P', 'S1', 'label', '3', { r1request: 'op2', r1arrived: '3', r1good: '3' }), '08:00');
  await goTo(page, 'supply');
  await expect(followup(page, 'A-001', 'P')).toContainText('仮の割当を含む');
  await expect(caseGroup(page, 'P')).toContainText('3個・表示の数（ラベル・パッケージ）・中身未確認');
  await recorded(page, 'receiptRevise', { receipt: 'provisional-p', received: '2', reason: '架空実受入数の訂正' }, '09:00');
  await recorded(page, 'requestRecord', { project: 'A-001', item: 'P', quantity: '1', vendor: '架空の正常未回答先', requestedOn: '2026-09-25', replyKind: 'none' }, '09:10');
  await recorded(page, 'requestRecord', { project: 'A-001', item: 'P', quantity: '1', vendor: '架空の正常回答先', requestedOn: '2026-09-25', replyKind: 'answered', replyDate: '2026-09-26' }, '09:20');
  const p = followup(page, 'A-001', 'P');
  await expect(p.locator('td').nth(3)).toContainText('過剰割り当て：保管単位provisional-p');
  await expect(p.locator('td').nth(3)).toContainText('依頼 op2の納期は確認待ち');
  await expect(p.locator('td').nth(3)).toContainText('納期未回答・入荷遅れ');
  await recorded(page, 'register', lot('unknown-q', 'Q', 'S2', 'unknown', ''), '08:00');
  await recorded(page, 'needRegister', { project: 'A-001', item: 'Q', basis: 'counted', value: '5', source: '架空必要表Q', revision: '1' }, '10:00');
  await expect(caseGroup(page, 'Q')).toContainText('数が不明');
  await expect(caseGroup(page, 'Q')).toContainText('判定不能');
  await expect(followup(page, 'A-001', 'Q').locator('td').nth(3)).toContainText('手配対象数は判定不能：不足が不明（0ではない）');
  await expect(followup(page, 'A-001', 'Q').locator('td').nth(3)).not.toContainText('該当する状態なし');
  expect(errors).toEqual([]);
});

test('9.3・10.1/10.2: 品目X・場所Oの対象外と外OUTを分け、架空試作と未実装を明示する', async ({ page }) => {
  const errors = pageErrors(page);
  await startEmpty(page);
  await recorded(page, 'register', lot('trial-in', 'P', 'S1', 'counted', '1'), '08:00');
  await recorded(page, 'register', lot('trial-item-out', 'X', 'S1', 'counted', '1'), '08:00');
  await recorded(page, 'register', lot('trial-location-out', 'P', 'O', 'counted', '1'), '08:00');
  await expect(row(page, 'trial-in')).toBeVisible();
  await expect(row(page, 'trial-item-out')).toBeVisible();
  await expect(row(page, 'trial-location-out')).toBeVisible();
  const form = page.getByRole('form', { name: '操作の入力' });
  expect(await form.locator('[name=location] option').evaluateAll(nodes => nodes.map(node => node.getAttribute('value')))).not.toContain('OUT');
  await form.locator('[name=location]').evaluate(node => node.append(new Option('架空外OUT', 'OUT')));
  for (const [name, value] of Object.entries(lot('invalid-out', 'P', 'OUT', 'counted', '1'))) await set(form.locator(`[name=${name}]`), value);
  const before = await snapshot(page);
  await form.getByRole('button', { name: '記録する' }).click();
  await expect(page.getByRole('status')).toContainText('手元');
  expect(await snapshot(page)).toEqual(before);
  expect(await page.evaluate(() => typeof window.fuzzyStockTest)).toBe('undefined');
  await goTo(page, 'management');
  await expect(page.locator('#about').getByRole('note')).toHaveText(bannerText);
  await goTo(page, 'stock');
  const choices = await allOperationLabels(page);
  expect(choices.filter(text => text.includes('取込'))).toEqual([opLabels.needImportResolve]);
  expect(choices.some(text => /バックアップ|復元|権限|バーコード|共有/.test(text))).toBe(false);
  expect(errors).toEqual([]);
});
