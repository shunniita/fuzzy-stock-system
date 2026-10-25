import { expect, test, type Page } from '@playwright/test';
import { selectOperation, goTo, opLabels, record, recorded, startEmpty, totals, cell } from './helpers.ts';
import { verifyScenarioViews } from './acceptance-views.ts';

const group = (page: Page, id: string) => page.locator(`#supply article[data-group="${id}"]`);
const stock = (page: Page, item: string) => page.locator(`#consumables article[data-stock="${item}"]`);
const lotRow = (page: Page, id: string) => page.locator(`#list tr[data-lot="${id}"]`);

test('FH-B02・SCN-02: 在庫98→101→103→返却後100、使用可能95→98→100、不足5→2→0を追い、ネジ約2200本・中身未確認部分ありと既存の依頼を示す。作業の再開は別の記録', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-14T04:00:00+09:00'));
  await page.goto('/');
  await goTo(page, 'management');
  await page.getByRole('button', { name: '不足・補充サンプルデータで初期化' }).click();
  await page.getByRole('button', { name: '初期化する', exact: true }).click();
  const g = group(page, 'B-001/P/個');
  await goTo(page, 'stock');
  await expect(lotRow(page, 'P-B01')).toContainText('100個・表示の数（ラベル・パッケージ）・中身未確認');

  // 作業担当が実数98個を登録。原因不明で訂正。ラベル100個との差異−2が履歴に残り、不足2が残る。
  await recorded(page, 'recount', { lot: 'P-B01', value: '98' }, '09:00');
  await goTo(page, 'issues');
  await expect(page.locator('#history')).toContainText('それまでの100個・表示の数（ラベル・パッケージ）・中身未確認との差異－2個）、原因不明');
  await goTo(page, 'supply');
  await expect(g).toContainText('在庫（未使用の総数） 98個');
  await expect(g).toContainText('不足 2個（帳簿上の不足）');

  // 98個のうち3個の不良を隔離。在庫98・使用可能95・不良3・不足5。数量不足2と不良3の理由を区別する。
  await recorded(page, 'split', { lot: 'P-B01', childId: 'PB-bad', basis: 'counted', value: '3' }, '10:00');
  await recorded(page, 'hold', { lot: 'PB-bad', reason: 'defective' }, '10:00');
  await expect(g).toContainText('在庫（未使用の総数） 98個');
  await expect(g).toContainText('使用可能 95個');
  await expect(g).toContainText('不足 5個（帳簿上の不足）');
  await expect(g).toContainText('内訳：数量不足 2個・除外による不足 3個（除外中：不良 3個・数えた）');

  // 部品の不足で作業が止まっている。不足・依頼・受け取りでは、この中断は再開されない。
  await recorded(page, 'stop', { process: 'R組立', item: 'R', project: 'B-001', reason: '部品Pの不足', shortageItem: 'P', shortageValue: '5', affectedUnknown: true }, '10:10');
  await expect(g).toContainText('中断 ');
  await expect(g).toContainText('作業の再開：未再開の中断が1件（再開は別の記録）');

  // 記録担当が5個の追加を依頼。不足5・依頼済み5・未着5。依頼しただけでは、注文の確定も入荷も作らない。
  await recorded(page, 'requestRecord', { project: 'B-001', item: 'P', unit: '個', quantity: '5', vendor: '架空の仕入先X', requestedOn: '2026-09-29', replyKind: 'none', replyDate: '' }, '10:30');
  await expect(g).toContainText('手配対象数 0個／依頼済み 5個／依頼の未着 5個');
  await expect(g).toContainText('注文の確定なし');
  await expect(g).toContainText('不足 5個');

  // 交換品3個を受け取り、良品と確認して依頼へ割り当て。在庫101・使用可能98・不良3・不足2・依頼の未着2。
  await recorded(page, 'receive', { newId: 'PR-1', item: 'P', unit: '個', project: 'B-001', location: 'S1', basis: 'counted', value: '3', r1request: 'op8', r1arrived: '3', r1good: '3' }, '11:00');
  await expect(g).toContainText('在庫（未使用の総数） 101個');
  await expect(g).toContainText('使用可能 98個');
  await expect(g).toContainText('不足 2個');
  await expect(g).toContainText('依頼の未着 2個');
  await expect(g).toContainText('到着 3個（不足の解消に充てた良品 3個）');
  await expect(g).toContainText('除外による不足 2個（除外中：不良 3個');

  // 後日、残り2個を良品として受け取り。在庫103・使用可能100・不足0。依頼の未着もなくなるが、作業の再開は別の記録のまま。
  await recorded(page, 'receive', { newId: 'PR-2', item: 'P', unit: '個', project: 'B-001', location: 'S1', basis: 'counted', value: '2', r1request: 'op8', r1arrived: '2', r1good: '2' }, '12:00');
  await expect(g).toContainText('在庫（未使用の総数） 103個');
  await expect(g).toContainText('使用可能 100個');
  await expect(g).toContainText('不足 0個（帳簿上の不足）');
  await expect(g).toContainText('不足の解消：解消（不足0）');
  await expect(g).toContainText('依頼の未着の解消：未着なし');
  await expect(g).toContainText('作業の再開：未再開の中断が1件（再開は別の記録）');

  // 不良3個を実返却。返却前は在庫103・使用可能100・不良3、返却後は在庫100。
  await recorded(page, 'handover', { lot: 'PB-bad', basis: 'counted', value: '3', counterpart: '架空の返却先' }, '13:00');
  await expect(g).toContainText('在庫（未使用の総数） 100個');
  await expect(g).toContainText('使用可能 100個');
  await expect(g).toContainText('不足 0個');
  await goTo(page, 'stock');
  await expect(totals(page)).toContainText('在庫 記録上の数100個');

  // 作業の再開は、材料の受け取りや不足の解消とは別に記録して、はじめて再開済みになる。
  const form = page.getByRole('form', { name: '操作の入力' });
  await selectOperation(form.locator('[name=op]'), { label: opLabels.resume });
  const stopId = await form.locator('[name=stop] option').nth(1).getAttribute('value');
  await recorded(page, 'resume', { stop: stopId! }, '14:00');
  await goTo(page, 'supply');
  await expect(g).toContainText('作業の再開：未再開の中断なし');

  // 別途、共通ネジを未開封2箱と開封済み約200本として記録。約2200本・中身未確認部分あり。既存の補充依頼も同時に表示する。
  await recorded(page, 'register', { newId: 'S-BOX', item: 'S', unit: '箱', project: 'common', location: 'S1', basis: 'counted', value: '2' }, '15:00');
  await recorded(page, 'register', { newId: 'S-OPEN', item: 'S', unit: '本', project: 'common', location: 'S1', basis: 'approximate', value: '200' }, '15:05');
  const s = stock(page, 'S');
  await expect(s).toContainText('約2200本');
  await expect(s).toContainText('中身未確認部分あり');
  await expect(s).toContainText('既存の依頼 sc-q1：1箱');
  await expect(s).toContainText('補充確認：数量の数値部分が補充基準3000本を下回る');
  // 補充確認が出ても、追加の依頼は自動では作られず、既存の依頼は1件のまま。
  await expect(s.getByText('既存の依頼 ')).toHaveCount(1);
  await verifyScenarioViews(page, { id: 'P-B01', project: 'B-001', current: 95, lastCount: 98 });
});

test('FH-B04: 予定100に実受け取り106、予備2・返却待ち4、返却で102。受領確認で減らさず、不良2を含む返却待ちの取消で不良2が残る。依頼の取消と納期未回答も確かめる', async ({ page }) => {
  await startEmpty(page);
  const g = group(page, 'B-001/P/個');
  await recorded(page, 'needRegister', { project: 'B-001', item: 'P', unit: '個', basis: 'counted', value: '100', dueDate: '2026-10-10', source: '架空の必要部品一覧', revision: '初版' }, '07:00');
  await recorded(page, 'requestRecord', { project: 'B-001', item: 'P', unit: '個', quantity: '100', vendor: '架空の仕入先X', requestedOn: '2026-09-29', replyKind: 'none', replyDate: '' }, '07:30');
  await goTo(page, 'supply');
  await expect(g).toContainText('納期：納期未回答');

  // 予定100個に106個受け取り。依頼へは100個を割り当てし、超過6個のうち2個を予備、4個を返却待ちにする。
  await recorded(page, 'receive', { newId: 'R1', item: 'P', unit: '個', project: 'B-001', location: 'S1', basis: 'counted', value: '106', r1request: 'op2', r1arrived: '100', r1good: '100' }, '08:00');
  await recorded(page, 'surplusAllocate', { lot: 'R1', childId: 'R1-sp', basis: 'counted', value: '2', destination: 'spare', note: '作業中の破損への備え' }, '09:00');
  await recorded(page, 'surplusAllocate', { lot: 'R1', childId: 'R1-rt', basis: 'counted', value: '4', destination: 'returnPending' }, '09:10');
  await goTo(page, 'stock');
  await expect(cell(page, 'R1-rt', '記録上の数と根拠')).toHaveText('4個・数えた');
  await expect(cell(page, 'R1-rt', '取り分けた理由')).toHaveText('返却待ち');
  await expect(totals(page)).toContainText('在庫 記録上の数106個');
  await expect(totals(page)).toContainText('使用可能 記録上の数100個');
  await goTo(page, 'supply');
  await expect(g).toContainText('在庫（未使用の総数） 106個');
  await expect(g).toContainText('使用可能 100個');
  await expect(g).toContainText('予備 2個・数えた／予備で賄える数 0個');
  await expect(g).toContainText('不足 0個');

  // 返却待ち4個を実際に返す。在庫102。受領確認を記録しても、再度は減らさない。
  await recorded(page, 'handover', { lot: 'R1-rt', basis: 'counted', value: '4', counterpart: '架空の返却先' }, '10:00');
  await goTo(page, 'stock');
  await expect(totals(page)).toContainText('在庫 記録上の数102個');
  await recorded(page, 'returnAck', { handover: 'op10' }, '11:00');
  await expect(totals(page)).toContainText('在庫 記録上の数102個');
  await goTo(page, 'supply');
  await expect(page.locator('#supply')).toContainText('返品の受付確認：引渡しop10（在庫は減らさない）');

  // 受け取り量を超える割り当ては拒否され、受け取り自体は失われない。
  await expect(await record(page, 'allocate', { receipt: 'R1', request: 'op2', arrived: '7', good: '7' }, '12:00')).toContainText('実際に受け取った数106を超える');
  await goTo(page, 'stock');
  await expect(lotRow(page, 'R1')).toBeVisible();
  await goTo(page, 'supply');
  await expect(page.locator('#supply')).toContainText('実際に受け取った数の記録：保管単位R1、届いた数106');

  // 返却待ち4個のうち2個は不良でもある。返却予定を取消すと、返却待ちだけが外れ、不良2個は使用できないまま。
  await recorded(page, 'register', { newId: 'X', item: 'P', location: 'S2', project: 'B-001', basis: 'counted', value: '4' }, '08:00');
  await recorded(page, 'hold', { lot: 'X', reason: 'returnPending' }, '12:30');
  await recorded(page, 'split', { lot: 'X', childId: 'X-bad', basis: 'counted', value: '2' }, '12:40');
  await recorded(page, 'hold', { lot: 'X-bad', reason: 'defective' }, '12:45');
  await goTo(page, 'stock');
  await expect(lotRow(page, 'X-bad')).toContainText('不良・返却待ち');
  await recorded(page, 'release', { lot: 'X', reason: 'returnPending' }, '13:00');
  await recorded(page, 'release', { lot: 'X-bad', reason: 'returnPending' }, '13:05');
  await expect(lotRow(page, 'X-bad')).toContainText('不良');
  await expect(lotRow(page, 'X-bad')).not.toContainText('返却待ち');
  await expect(lotRow(page, 'X')).not.toContainText('不良');

  // 手動の依頼取消。元の依頼は残り、未着から外れる。
  await recorded(page, 'requestCancel', { request: 'op2', reason: '不要になった' }, '14:00');
  await goTo(page, 'supply');
  await expect(g).toContainText('依頼 op2：取消済み（理由「不要になった」）');
});
