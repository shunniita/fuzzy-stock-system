import { expect, test, type Page } from '@playwright/test';
import { allOperationLabels, selectOperation, goTo, cell, record, recorded, startEmpty } from './helpers.ts';

const supplyLog = (page: Page) => page.locator('#supply');

const need = { project: 'B-001', item: 'P', unit: '個', basis: 'counted', value: '100', dueDate: '2026-10-10', source: '架空の必要部品一覧', revision: '初版' };
const request = { project: 'B-001', item: 'P', unit: '個', quantity: '5', vendor: '架空の仕入先X', requestedOn: '2026-10-02', replyKind: 'none', replyDate: '' };

test('6.2: 必要明細・依頼・注文の確定・回答・取消・申告・対応付けを画面から記録でき、履歴に何が起きたか読める。台帳には触れない', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'needRegister', need);
  await goTo(page, 'supply');
  await expect(supplyLog(page)).toContainText('必要明細の登録：案件・用途B-001・品目P「架空部品P」・必要な数100個（数えた）、必要日2026-10-10、元の資料「架空の必要部品一覧」・初版');

  await recorded(page, 'requestRecord', request);
  await expect(supplyLog(page)).toContainText('注文・購入予定の記録：案件・用途B-001・品目P「架空部品P」・5個、依頼先「架空の仕入先X」、依頼日2026-10-02、未回答（依頼しただけで、在庫には数えない）');
  // 依頼しただけでは、在庫・注文の確定・受け取りは作られない。
  await goTo(page, 'stock');
  await expect(page.locator('#list')).toContainText('該当する保管単位はない');
  await goTo(page, 'supply');
  await expect(supplyLog(page)).not.toContainText('注文の確定：');

  await recorded(page, 'replyRecord', { request: 'op2', replyKind: 'estimated', replyDate: '2026-10-08' });
  await expect(supplyLog(page)).toContainText('回答の更新：依頼op2、未回答→推定の予定日2026-10-08');
  await recorded(page, 'orderConfirm', { request: 'op2' });
  await expect(supplyLog(page)).toContainText('注文の確定：依頼op2（依頼とは別の記録）');

  await recorded(page, 'declareShortage', { project: 'B-001', item: 'P', unit: '個', value: '', valueUnknown: true, reason: '数は不明だが足りない' });
  await expect(supplyLog(page)).toContainText('足りない分の記録：案件・用途B-001・品目P「架空部品P」・数が不明、理由「数は不明だが足りない」');

  await recorded(page, 'needRevise', { need: 'op1', basis: 'counted', value: '80', dueDate: '', source: '架空の必要部品一覧', revision: '改訂2' });
  await expect(supplyLog(page)).toContainText('必要明細の改訂：案件・用途B-001・品目P「架空部品P」・必要な数100個（数えた）→80個（数えた）、必要日2026-10-10→なし、元の資料「架空の必要部品一覧」、初版→改訂2');

  await recorded(page, 'linkDeclaration', { declaration: 'op5', link: 'yes' });
  await expect(supplyLog(page)).toContainText('足りない分の記録op5を自動の不足候補に対応付け');

  await recorded(page, 'requestCancel', { request: 'op2', reason: '現物が見つかった' });
  await expect(supplyLog(page)).toContainText('依頼の取消：依頼op2、理由「現物が見つかった」（元の依頼は残る）');
  await goTo(page, 'stock');
  await expect(page.locator('#list')).toContainText('該当する保管単位はない');
});

test('NFR-08a: 供給の履歴は、実際の日時と入力した日時を別に示す。実際の日時が不明なら、入力した日時で埋めず「日時不明」と示す', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'needRegister', need, '07:00');
  await recorded(page, 'requestRecord', request, null);
  const items = page.locator('#supply ol[aria-label="供給の記録の履歴"] li');
  await goTo(page, 'supply');
  await expect(items.nth(0)).toContainText('発生 2026-09-29 07:00（日本時間）');
  await expect(items.nth(0)).toContainText('記録 ');
  await expect(items.nth(1)).toContainText('発生 日時不明');
  await expect(items.nth(1)).toContainText('注文・購入予定の記録');
});

test('UI-07: 供給の記録だけを更新しても、最終記録更新に反映される（台帳が空でも「なし」のままにしない）', async ({ page }) => {
  await startEmpty(page);
  await expect(page.locator('#updated')).toContainText('最終記録更新：なし');
  await recorded(page, 'needRegister', need, '07:00');
  await expect(page.locator('#updated')).not.toContainText('なし');
  await expect(page.locator('#updated')).toContainText('最終記録更新：20');
});

test('6.2: 入力の誤りは理由つきで拒否され、何も記録されない。空欄を黙って不明や0にしない', async ({ page }) => {
  await startEmpty(page);
  await expect(await record(page, 'declareShortage', { project: 'B-001', item: 'P', unit: '個', value: '', reason: '足りない' })).toContainText('不足数を入力するか、不明を選ぶ');
  await expect(await record(page, 'requestRecord', { ...request, quantity: '0' })).toContainText('記録していない：依頼の数量は1以上');
  await expect(await record(page, 'requestRecord', { ...request, requestedOn: '' })).toContainText('依頼日を入力する');
  await expect(await record(page, 'requestRecord', { ...request, replyKind: 'estimated', replyDate: '' })).toContainText('予定日を入力する');
  await expect(await record(page, 'requestRecord', { ...request, replyKind: 'none', replyDate: '2026-10-08' })).toContainText('未回答のときは予定日を入れない');
  await goTo(page, 'supply');
  await expect(supplyLog(page)).toContainText('必要な数・足りない分の記録・注文・購入予定の記録はまだない');
  // 同じ必要明細の二重登録は、改訂を案内して拒否する。
  await recorded(page, 'needRegister', need);
  await expect(await record(page, 'needRegister', need)).toContainText('改訂');
});

test('F0-B2 12.2・F1-C: 振替と架空必要明細取込だけを公開し、依頼の自動作成や個別の保存は置かない', async ({ page }) => {
  await startEmpty(page);
  const labels = await allOperationLabels(page);
  expect(labels.filter(t => t.includes('付け替え'))).toEqual(['案件・用途の付け替え（場所は変えない）']);
  expect(labels.filter(t => t.includes('取込'))).toEqual(['必要明細取込の照合（保留の適用・見送り）']);
  expect(labels.some((t) => /自動作成|保存/.test(t))).toBe(false);
});

const askFor100 = { project: 'B-001', item: 'P', unit: '個', quantity: '100', vendor: '架空の仕入先X', requestedOn: '2026-10-02', replyKind: 'none', replyDate: '' };
const receipt = { newId: 'R1', item: 'P', unit: '個', project: 'B-001', location: 'S1', basis: 'counted', value: '10' };

test('5.2・5.3・FH-B04: 受け取りを依頼ごとの行で割り当てし、上限を超える行は拒否されても受け取りは残り、通った行までが記録される。受け入れた現物への再割り当ては上限で拒否される', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'requestRecord', askFor100);
  const status = await record(page, 'receive', { ...receipt, r1request: 'op1', r1arrived: '8', r1good: '8', r2request: 'op1', r2arrived: '5', r2good: '5' });
  await expect(status).toContainText('記録した');
  await expect(status).toContainText('受け取りは記録した。割り当ては拒否した（2行目：');
  await expect(status).toContainText('1行目までを記録した');
  await expect(page.locator('#list tr[data-lot="R1"]')).toContainText('10個・数えた');
  await goTo(page, 'supply');
  await expect(page.locator('#supply')).toContainText('実際に受け取った数の記録：保管単位R1、届いた数10');
  await expect(page.locator('#supply')).toContainText('割り当て：依頼op1へ、保管単位R1から到着8・良品8');
  await expect(page.locator('#supply')).not.toContainText('到着5');

  await recorded(page, 'allocate', { receipt: 'R1', request: 'op1', arrived: '2', good: '1' });
  await expect(await record(page, 'allocate', { receipt: 'R1', request: 'op1', arrived: '1', good: '1' })).toContainText('実際に受け取った数10を超える');
  await recorded(page, 'receiptRevise', { receipt: 'R1', received: '9', reason: '実際は9個だった' });
  await expect(page.locator('#supply')).toContainText('実際に受け取った数の訂正：保管単位R1、10→9、理由「実際は9個だった」');
  await recorded(page, 'arrivalRevise', { arrival: 'op1/op2-a1', arrived: '7', good: '7' });
  await expect(page.locator('#supply')).toContainText('割り当ての訂正：依頼op1、到着8→7・良品8→7');
});

test('表示の数（ラベル・パッケージ）の受け取りは仮の実際に受け取った数で割り当てでき、「仮の割当」と示す。使い切ると確定し、あとで見つかった残りから逆算して余りを予備にできる。数が不明の受け取りも、残りを数えて逆算できる', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'requestRecord', askFor100, '07:00');
  await recorded(page, 'receive', { ...receipt, basis: 'label', value: '100', r1request: 'op1', r1arrived: '100', r1good: '100' }, '08:00');
  await goTo(page, 'supply');
  await expect(page.locator('#supply')).toContainText('実際に受け取った数の記録：保管単位R1、届いた数100（仮');
  await expect(page.locator('#supply')).toContainText('仮の割当：保管単位R1');
  await recorded(page, 'use', { lot: 'R1', basis: 'counted', value: '100', usedFor: 'B-001 組付け' }, '09:00');
  await expect(page.locator('#supply')).not.toContainText('仮の割当：保管単位R1');
  // 使い切ったはずの箱に5個残っていた（ラベルより多く入っていた）。残りから逆算して、余りを予備にする。
  await recorded(page, 'recount', { lot: 'R1', value: '5', receiptEffect: 'derive', causeText: '使い切ったはずの箱に残っていた' }, '09:30');
  await expect(page.locator('#supply')).toContainText('実際に受け取った数の訂正：保管単位R1、100→105（仮：残りから逆算）');
  await recorded(page, 'surplusAllocate', { lot: 'R1', childId: 'R1-sp', basis: 'counted', value: '5', destination: 'spare' }, '09:40');
  await goTo(page, 'stock');
  await expect(cell(page, 'R1-sp', '取り分けた理由')).toContainText('予備');

  await recorded(page, 'receive', { ...receipt, newId: 'U1', basis: 'unknown', value: '' }, '10:00');
  await recorded(page, 'use', { lot: 'U1', basis: 'counted', value: '30', usedFor: 'B-001 組付け' }, '11:00');
  await recorded(page, 'recount', { lot: 'U1', value: '20', receiptEffect: 'derive', causeText: '残りを数えた' }, '12:00');
  await goTo(page, 'supply');
  await expect(page.locator('#supply')).toContainText('実際に受け取った数の訂正：保管単位U1、未確認→50（仮：残りから逆算）');
});

test('5.3: 受け入れた現物の数え直しでは、実際に受け取った数の扱いを選ぶまで記録されない。訂正するを選ぶと実際に受け取った数も直り、以後は数えた数を超える割り当てが拒否される。初期登録の現物には選択が出ない', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'requestRecord', askFor100, '07:00');
  await recorded(page, 'receive', { ...receipt, basis: 'label', value: '100' }, '08:00');
  await recorded(page, 'register', { newId: 'INIT', item: 'P', location: 'S2', project: 'B-001', basis: 'counted', value: '50' }, '08:00');

  const form = page.getByRole('form', { name: '操作の入力' });
  const choice = form.locator('[name=receiptEffect]');
  // 初期登録の現物（実際に受け取った数の記録がない）には選択が出ない。
  await selectOperation(form.locator('[name=op]'), { label: '数えて確認・訂正（原因不明でもよい）' });
  await form.locator('[name=lot]').selectOption('INIT');
  await expect(choice).toBeHidden();
  await form.locator('[name=lot]').selectOption('R1');
  await expect(choice).toBeVisible();

  const status = await record(page, 'recount', { lot: 'R1', value: '98' }, '09:00');
  await expect(status).toContainText('実際に受け取った数の扱いを選ぶ');
  await goTo(page, 'supply');
  await expect(page.locator('#supply')).not.toContainText('実際に受け取った数の訂正');
  await goTo(page, 'stock');
  await expect(page.locator('#list tr[data-lot="R1"]')).toContainText('100個・表示の数（ラベル・パッケージ）');

  await recorded(page, 'recount', { lot: 'R1', value: '98', receiptEffect: 'revise' }, '09:00');
  await goTo(page, 'supply');
  await expect(page.locator('#supply')).toContainText('実際に受け取った数の訂正：保管単位R1、100→98、理由「原因不明」');
  await expect(await record(page, 'allocate', { receipt: 'R1', request: 'op1', arrived: '99', good: '99' })).toContainText('実際に受け取った数98を超える');
  await recorded(page, 'allocate', { receipt: 'R1', request: 'op1', arrived: '98', good: '98' });
});

test('10.1・10.4・10.8・8.6: 余剰を予備と返却待ちに割り当て、予備を理由つきで案件・用途用へ移し、返品の受付確認を記録しても在庫は減らさず、数が不明の開封分に残量区分を記録できる', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'receive', { ...receipt, value: '106' }, '08:00');
  await recorded(page, 'surplusAllocate', { lot: 'R1', childId: 'R1-sp', basis: 'counted', value: '2', destination: 'spare', note: '作業中の破損への備え' }, '09:00');
  await recorded(page, 'surplusAllocate', { lot: 'R1', childId: 'R1-ret', basis: 'counted', value: '4', destination: 'returnPending' }, '09:10');
  await expect(page.locator('#list tr[data-lot="R1-sp"]')).toContainText('予備（交換用）');
  await expect(page.locator('#list tr[data-lot="R1-ret"]')).toContainText('返却待ち');
  await goTo(page, 'issues');
  await expect(page.locator('#history')).toContainText('メモ「作業中の破損への備え」');
  // 予備のまま使うと、先に交換として案件・用途用へ移す案内つきで拒否される。
  await expect(await record(page, 'use', { lot: 'R1-sp', basis: 'counted', value: '1', usedFor: 'B-001 作業' }, '10:00')).toContainText('案件・用途用へ移す');

  // 予備を案件・用途用へ移す（交換）には理由が要る。
  await expect(await record(page, 'spareSwap', { lot: 'R1-sp', value: '1', childId: 'R1-sw', note: '' }, '10:00')).toContainText('理由');
  await recorded(page, 'spareSwap', { lot: 'R1-sp', value: '1', childId: 'R1-sw', note: '1個破損したので交換' }, '10:00');
  await goTo(page, 'stock');
  await expect(page.locator('#list tr[data-lot="R1-sw"]')).toContainText('なし');
  await expect(page.locator('#list tr[data-lot="R1-sp"]')).toContainText('予備（交換用）');
  await goTo(page, 'issues');
  await expect(page.locator('#history')).toContainText('メモ「1個破損したので交換」');

  // 返却待ち4を実際に返す。受領確認は別の記録で、在庫は減らさない。
  await recorded(page, 'handover', { lot: 'R1-ret', basis: 'counted', value: '4', counterpart: '架空の返却先' }, '11:00');
  await goTo(page, 'stock');
  await expect(page.getByRole('list', { name: '絞り込んだ範囲の集計' })).toContainText('在庫 記録上の数102個');
  await recorded(page, 'returnAck', { handover: 'op9' }, '12:00');
  await goTo(page, 'supply');
  await expect(page.locator('#supply')).toContainText('返品の受付確認：引渡し');
  await goTo(page, 'stock');
  await expect(page.getByRole('list', { name: '絞り込んだ範囲の集計' })).toContainText('在庫 記録上の数102個');

  // 数が不明の開封分に残量区分を記録する。数量へは換算しない。
  await recorded(page, 'receive', { newId: 'V1', item: 'V', unit: '本', project: 'common', location: 'S1', basis: 'unknown', value: '' }, '13:00');
  await recorded(page, 'remainder', { lot: 'V1', level: 'few' }, '13:10');
  await goTo(page, 'supply');
  await expect(page.locator('#supply')).toContainText('残量区分：保管単位V1、少ない（数量へは換算しない）');
  await goTo(page, 'stock');
  await expect(page.locator('#list tr[data-lot="V1"]')).toContainText('数が不明');
});

const group = (page: Page, id: string) => page.locator(`#supply article[data-group="${id}"]`);

test('6.5・2.1・2.4・2.7・4.4・4.5・7.1: 不足・手配対象数・依頼済み・未着・納期・三つの状態を別々の文で表示する。受け取りのない必要品目も、判定不能も文字で読める', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'needRegister', { ...need, dueDate: '2026-10-01' }, '07:00');
  // 受け取りのない必要品目は、在庫0と区別できる。
  await goTo(page, 'supply');
  await expect(group(page, 'B-001/P/個')).toContainText('必要明細 op1：必要な数 100個（数えた）、必要日 2026-10-01');
  await expect(group(page, 'B-001/P/個')).toContainText('在庫（未使用の総数） 0個');
  await expect(group(page, 'B-001/P/個')).toContainText('不足 100個（帳簿上の不足）');

  // SCN-02: ラベル100を実数98に訂正して不足2、3個の不良を隔離して不足5。
  await recorded(page, 'register', { newId: 'PB', item: 'P', location: 'S1', project: 'B-001', basis: 'label', value: '100' }, '08:00');
  await recorded(page, 'recount', { lot: 'PB', value: '98' }, '09:00');
  await expect(group(page, 'B-001/P/個')).toContainText('不足 2個（帳簿上の不足）');
  await recorded(page, 'split', { lot: 'PB', childId: 'PB-bad', basis: 'counted', value: '3' }, '10:00');
  await recorded(page, 'hold', { lot: 'PB-bad', reason: 'defective' }, '10:00');
  const g = group(page, 'B-001/P/個');
  await expect(g).toContainText('在庫（未使用の総数） 98個');
  await expect(g).toContainText('使用可能 95個');
  await expect(g).toContainText('不足 5個（帳簿上の不足）');
  await expect(g).toContainText('内訳：数量不足 2個・除外による不足 3個（除外中：不良 3個・数えた）');

  // 依頼5を記録する。不足5・依頼済み5・未着5・手配対象数0を別々に示し、納期未回答と判定日に応じた遅れを示す。
  await recorded(page, 'requestRecord', { project: 'B-001', item: 'P', unit: '個', quantity: '5', vendor: '架空の仕入先X', requestedOn: '2026-10-01', replyKind: 'none', replyDate: '' }, '11:00');
  await expect(g).toContainText('手配対象数 0個／依頼済み 5個／依頼の未着 5個');
  await expect(g).toContainText('到着 0個（不足の解消に充てた良品 0個）');
  await expect(g).toContainText('納期：納期未回答');
  await recorded(page, 'replyRecord', { request: 'op6', replyKind: 'estimated', replyDate: '2026-10-03' }, '11:10');
  await page.locator('#supply [name=asOf]').fill('2026-10-02');
  await expect(g).toContainText('納期：必要日に間に合わない');
  await expect(g).not.toContainText('到着予定超過');
  await page.locator('#supply [name=asOf]').fill('2026-10-04');
  await expect(g).toContainText('納期：到着予定超過・必要日に間に合わない');

  // 不足の解消・依頼の未着の解消・作業の再開は、別々の三つの文。
  await expect(g).toContainText('不足の解消：未解消（不足5個）');
  await expect(g).toContainText('依頼の未着の解消：未着5個');
  await expect(g).toContainText('作業の再開：未再開の中断なし');
});

test('2.4・3.3: 必要な数が未登録の群（申告だけ）は判定不能と理由を文字で示し、手配対象数は0でなく保留と書く。対応付けない申告は別の不足として示す', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'declareShortage', { project: 'common', item: 'S', unit: '本', value: '', valueUnknown: true, reason: '数は不明だが足りない' });
  await recorded(page, 'requestRecord', { project: 'common', item: 'S', unit: '本', quantity: '1000', vendor: '架空の仕入先X', requestedOn: '2026-10-01', replyKind: 'none', replyDate: '' });
  const g = group(page, 'common/S/本');
  await goTo(page, 'supply');
  await expect(g).toContainText('必要明細は未登録');
  await expect(g).toContainText('不足 判定不能：必要な数が未登録');
  await expect(g).toContainText('手配対象数 保留（不足が不明のため。0ではない）');
  await expect(g).toContainText('足りない分の記録 op1：数が不明（数は不明だが足りない）、対応付けなし（別の不足として数える）');
  await expect(g.locator('li.warn').first()).toBeVisible();
});

const stock = (page: Page, item: string) => page.locator(`#consumables article[data-stock="${item}"]`);

test('6.6・AT-42・AT-20・9.2〜9.5: ネジは未開封の箱と開封済みを分け、約2200本・未確認部分ありと補充確認を、既存の依頼1箱と並べて示す。依頼は自動で作らず、区分は本数にしない', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', { newId: 'S-BOX', item: 'S', unit: '箱', project: 'common', location: 'S1', basis: 'counted', value: '2' }, '08:00');
  await recorded(page, 'register', { newId: 'S-OPEN', item: 'S', unit: '本', project: 'common', location: 'S1', basis: 'approximate', value: '200' }, '08:05');
  const s = stock(page, 'S');
  await goTo(page, 'supply');
  await expect(s).toContainText('未開封の箱：S-BOX 2箱・数えた');
  await expect(s).toContainText('開封済み・バラの数量（本）：S-OPEN');
  await expect(s).toContainText('約2200本');
  await expect(s).toContainText('中身未確認部分あり');
  await expect(s).toContainText('箱は1箱あたり1000本の表示で換算（現物を数えた値ではない）');
  await expect(s).toContainText('補充確認：数量の数値部分が補充基準3000本を下回る（標準依頼数量1箱）');
  await expect(s).toContainText('確定した判定ではない。依頼は自動では作らない');
  await expect(s).toContainText('既存の依頼はない');
  // 補充確認から依頼は自動で作られない。依頼は人が判断して、別の入力で記録する。
  await goTo(page, 'supply');
  await expect(page.locator('#supply')).toContainText('必要な数・足りない分の記録・注文・購入予定の記録はまだない');

  await recorded(page, 'requestRecord', { project: 'common', item: 'S', unit: '箱', quantity: '1', vendor: '架空の仕入先X', requestedOn: '2026-10-01', replyKind: 'none', replyDate: '' }, '09:00');
  await expect(s).toContainText('既存の依頼 op3：1箱・架空の仕入先X・未回答・注文の確定なし・到着0箱・未着1箱');

  // 別品目の開封分は残量区分だけ。本数に変換せず、補充確認の行も出さない。
  await recorded(page, 'register', { newId: 'V-1', item: 'V', unit: '本', project: 'common', location: 'S1', basis: 'unknown', value: '' }, '10:00');
  await recorded(page, 'remainder', { lot: 'V-1', level: 'few' }, '10:10');
  const v = stock(page, 'V');
  await expect(v).toContainText('残量区分のみ（数量へは換算しない）：V-1 少ない');
  await expect(v).toContainText('数量合計（本） 数値なし');
  await expect(v).not.toContainText('補充確認：');

  // 数が不明で区分のないネジの開封分は、不明の部分として本数に足す（区分があれば足さない）。
  await recorded(page, 'register', { newId: 'S-UNK', item: 'S', unit: '本', project: 'common', location: 'S2', basis: 'unknown', value: '' }, '11:00');
  await expect(s).toContainText('ほかに数が不明1件');
  await recorded(page, 'remainder', { lot: 'S-UNK', level: 'nearEmpty' }, '11:10');
  await expect(s).toContainText('残量区分のみ（数量へは換算しない）：S-UNK ほぼ空');
  await expect(s).not.toContainText('ほかに数が不明');
});

test('8.5・9.4: 1箱あたりの数が分からない包装・だいたいの箱は合算せず別に書き、数えたの本数が基準以上なら補充確認は出ない。ラベル換算の本数は基準以上に見えても確認を残す', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', { newId: 'S-BAG', item: 'S', unit: '箱', project: 'common', location: 'S1', basis: 'approximate', value: '2' }, '08:00');
  const s = stock(page, 'S');
  await goTo(page, 'supply');
  await expect(s).toContainText('合算していない分（1箱あたりの数が分からない包装・だいたいや数が不明の箱）：S-BAG');
  await expect(s).toContainText('数量合計（本） 数値なし');
  await recorded(page, 'register', { newId: 'S-BOX', item: 'S', unit: '箱', project: 'common', location: 'S1', basis: 'counted', value: '4' }, '08:10');
  await expect(s).toContainText('補充確認：数量の数値部分は補充基準3000本以上に見えるが、だいたい・中身未確認を含むので、補充の要否を断定できない');
  await recorded(page, 'register', { newId: 'S-OPEN', item: 'S', unit: '本', project: 'common', location: 'S1', basis: 'counted', value: '4000' }, '08:20');
  await expect(s).toContainText('補充確認：数量の数値部分は補充基準3000本以上に見えるが、だいたい・中身未確認を含むので、補充の要否を断定できない');
});

test('11.1・12.1: SCN-02の初期データで初期化でき、必要な数100・ラベル100個・既存の依頼1箱が入る。初期化後の状態と記録は再読込でも残る', async ({ page }) => {
  await page.goto('/');
  await goTo(page, 'management');
  await page.getByRole('button', { name: '不足・補充サンプルデータで初期化' }).click();
  await page.getByRole('button', { name: '初期化する', exact: true }).click();
  await goTo(page, 'stock');
  await expect(page.locator('#list tr[data-lot="P-B01"]')).toContainText('100個・表示の数（ラベル・パッケージ）・中身未確認');
  await goTo(page, 'supply');
  await expect(group(page, 'B-001/P/個')).toContainText('必要明細 sc-n1：必要な数 100個（数えた）、必要日 2026-10-10');
  await expect(group(page, 'B-001/P/個')).toContainText('不足 0個（中身未確認（表示の数（ラベル・パッケージ）を含む））');
  await expect(stock(page, 'S')).toContainText('既存の依頼 sc-q1：1箱・架空の仕入先X・未回答・注文の確定なし・到着0箱・未着1箱');
  await expect(page.locator('#supply')).toContainText('必要明細の登録：案件・用途B-001・品目P「架空部品P」・必要な数100個（数えた）');
  // 以降の記録の操作IDは、台帳と供給の履歴の件数の和から付く。初期データのIDと重ならない。
  await recorded(page, 'recount', { lot: 'P-B01', value: '98' }, '09:00');
  await goTo(page, 'issues');
  await expect(page.locator('#history')).toContainText('op4');
  await expect(page.locator('#history')).toContainText('数えて確認：P-B01 98個を数えた');
  await page.reload();
  await expect(page.locator('#list tr[data-lot="P-B01"]')).toContainText('98個・数えた');
  await goTo(page, 'issues');
  await expect(page.locator('#history')).toContainText('数えて確認：P-B01 98個を数えた');

  // 既存の初期データ（F0-A）は、供給の記録を持たない。
  await goTo(page, 'management');
  await page.getByRole('button', { name: '標準サンプルデータで初期化' }).click();
  await page.getByRole('button', { name: '初期化する', exact: true }).click();
  await goTo(page, 'supply');
  await expect(page.locator('#supply')).toContainText('必要な数・足りない分の記録・注文・購入予定の記録はまだない');
  await goTo(page, 'management');
  await expect(page.locator('#about').getByRole('note')).toContainText('この端末のブラウザーにだけ保存');
  await expect(page.locator('#about').getByRole('note')).toContainText('案件・用途の付け替えは、数量の分かる未使用の案件・用途を指定した物に限る');
  await expect(page.locator('#about').getByRole('note')).toContainText('コード入力は専用形式に対応。読取機器との連携・帳票からの取込・依頼の自動作成には対応していない');
  await expect(page.locator('#about').getByRole('note')).toContainText('バックアップと復元ができる');
  await page.reload();
  await goTo(page, 'supply');
  await expect(page.locator('#supply')).toContainText('必要な数・足りない分の記録・注文・購入予定の記録はまだない');
});
