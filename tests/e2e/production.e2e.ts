import { expect, test, type Page } from '@playwright/test';
import { selectOperation, goTo, cell, lot, record, recorded, row, startEmpty, totals } from './helpers.ts';
import { verifyScenarioViews, verifyScn01Case } from './acceptance-views.ts';

const production = (page: Page) => page.getByRole('list', { name: '工程ごとの数' });
const history = (page: Page) => page.locator('#history');

// R30台に作業の開始し、作業終了20台・確認の完了18台まで進める。確認の完了は作業終了と同じ11時で、作業終了でできた保管単位なので包含を聞かれない。
async function startedAndInspected(page: Page, materials: Record<string, string> = {}): Promise<void> {
  await goTo(page, 'stock');
  await recorded(page, 'start', { process: 'R組立', newId: 'R1', item: 'R', project: 'A-001', location: 'T', basis: 'counted', value: '30', ...materials }, '09:15');
  await recorded(page, 'finish', { lot: 'R1', childId: 'R2', basis: 'counted', value: '20' }, '11:00');
  await recorded(page, 'inspect', { lot: 'R2', childId: 'R3', basis: 'counted', value: '18' }, '11:00');
}

test('FH-B01・AT-48: SCN-01を最初から操作し、誤使用の訂正後にP70・Q70・R工程内12・完成（渡す前）8・次工程10を画面と履歴で確かめる', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-14T04:00:00+09:00'));
  await startEmpty(page);
  await recorded(page, 'register', lot('Q1', 'Q', 'S1', 'counted', '100'), '07:00');
  await recorded(page, 'register', lot('PA', 'P', 'S1', 'label', '100'), '08:00');
  await recorded(page, 'register', lot('PB', 'P', 'S2', 'label', '100', { project: 'A-002' }), '08:10');
  await expect(cell(page, 'PA', '記録上の数と根拠')).toHaveText('100個・表示の数（ラベル・パッケージ）・中身未確認');
  await expect(cell(page, 'PB', '案件・用途')).toHaveText('案件・用途A-002');

  await recorded(page, 'recount', { lot: 'PA', value: '100', causeText: '受け取り後の全数確認' }, '09:00');
  await recorded(page, 'splitMove', { lot: 'PA', childId: 'PT', basis: 'counted', value: '30', location: 'T' }, '09:05');
  await expect(cell(page, 'PA', '記録上の数と根拠')).toHaveText('記録上の数70個');
  await expect(cell(page, 'PT', '記録上の数と根拠')).toHaveText('30個・数えた');

  await startedAndInspected(page, { m1lot: 'PT', m1basis: 'counted', m1value: '30', m2lot: 'Q1', m2basis: 'counted', m2value: '30' });
  await expect(cell(page, 'PT', '記録上の数と根拠')).toHaveText('記録上の数0個');
  await expect(cell(page, 'Q1', '記録上の数と根拠')).toHaveText('記録上の数70個');
  await expect(cell(page, 'R1', '作業の状態')).toHaveText('工程R組立・作業中');
  await expect(cell(page, 'R2', '作業の状態')).toHaveText('工程R組立・確認待ち');
  await expect(production(page)).toContainText('工程内 記録上の数12台（作業中 記録上の数10台、確認待ち 記録上の数2台）／完成（渡す前） 18台・数えた／工程完了累計 18台');

  await recorded(page, 'toNext', { lot: 'R3', childId: 'R4', basis: 'counted', value: '10', location: 'N' }, '11:20');
  await expect(cell(page, 'R4', '場所')).toHaveText('N');
  await expect(cell(page, 'R4', '作業の状態')).toHaveText('作業なし');
  await expect(production(page)).toContainText('工程内 記録上の数12台');
  await expect(production(page)).toContainText('完成（渡す前） 記録上の数8台／工程完了累計 18台／やり直し・修理開始累計 0台（現在の現物数には足さない）／引渡済み累計 10台');
  await expect(totals(page)).toContainText('品目R（台）：在庫 記録上の数30台／使用可能 10台・数えた／取り分け 記録上の数0台／製造中・完成（渡す前） 記録上の数20台');

  await recorded(page, 'use', { lot: 'PA', basis: 'counted', value: '10', usedFor: 'R追加（誤り）' }, '17:00');
  await expect(cell(page, 'PA', '記録上の数と根拠')).toHaveText('記録上の数60個');
  await page.locator('#actor').selectOption('架空担当B');
  const form = page.getByRole('form', { name: '操作の入力' });
  await selectOperation(form.locator('[name=op]'), { label: '間違えた記録の取り消し（使用・引渡し）' });
  const mistaken = await form.locator('[name=target] option', { hasText: 'R追加（誤り）' }).getAttribute('value');
  await recorded(page, 'void', { target: mistaken!, reason: '実際は使用していない' }, '17:30');

  await expect(cell(page, 'PA', '記録上の数と根拠')).toHaveText('記録上の数70個');
  await expect(cell(page, 'Q1', '記録上の数と根拠')).toHaveText('記録上の数70個');
  await expect(totals(page)).toContainText('品目P（個）：在庫 記録上の数170個');
  await expect(production(page)).toContainText('工程内 記録上の数12台（作業中 記録上の数10台、確認待ち 記録上の数2台）');
  await expect(production(page)).toContainText('完成（渡す前） 記録上の数8台／工程完了累計 18台／やり直し・修理開始累計 0台（現在の現物数には足さない）／引渡済み累計 10台');
  await goTo(page, 'issues');
  await expect(history(page)).toContainText(`担当 架空担当B　間違えた記録の取り消し：操作${mistaken}（PA）を起きなかったものとして取消、理由「実際は使用していない」、数量を戻した`);
  await expect(history(page)).toContainText(`${mistaken}　発生 2026-09-29 17:00（日本時間）`);
  await expect(history(page)).toContainText(`担当 架空担当A　使用：PAから10個（数えた）、使用先 R追加（誤り）・記録誤りとして取消済み`);
  await expect(history(page)).not.toContainText('登録：PA2');

  // 次工程へ渡したRから、分割元をたどって作業の開始の材料の使用記録へ戻れる（MFG-03a・06）。
  await goTo(page, 'stock');
  await row(page, 'R4').getByRole('button', { name: 'R4' }).click();
  const detail = page.locator('#detail');
  await expect(detail).toContainText('作業の開始に使った材料の使用記録');
  await expect(detail).toContainText('使用：PTから30個（数えた）、使用先 R1の着手（工程R組立）');
  await expect(detail).toContainText('使用：Q1から30個（数えた）、使用先 R1の着手（工程R組立）');
  await verifyScn01Case(page);
  await verifyScenarioViews(page, { id: 'PA', project: 'A-001', current: 70, lastCount: 100 });
});

test('AT-14: 30台に作業の開始し10台完了、5台を次工程へ渡すと、工程内20・完成（渡す前）5・引渡済み5で、材料を再消費しない', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('P1', 'P', 'T', 'counted', '100'), '08:00');
  await recorded(page, 'start', { process: 'R組立', newId: 'R1', item: 'R', project: 'A-001', location: 'T', basis: 'counted', value: '30', m1lot: 'P1', m1basis: 'counted', m1value: '30' }, '09:00');
  await recorded(page, 'finish', { lot: 'R1', childId: 'R2', basis: 'counted', value: '10' }, '10:00');
  await recorded(page, 'inspect', { lot: 'R2', childId: 'R3', basis: 'counted', value: '10' }, '10:30');
  await recorded(page, 'toNext', { lot: 'R3', childId: 'R4', basis: 'counted', value: '5', location: 'N' }, '11:00');
  await expect(production(page)).toContainText('工程内 記録上の数20台（作業中 記録上の数20台、確認待ち 記録上の数0台）／完成（渡す前） 記録上の数5台／工程完了累計 10台／やり直し・修理開始累計 0台（現在の現物数には足さない）／引渡済み累計 5台');
  await expect(cell(page, 'P1', '記録上の数と根拠')).toHaveText('記録上の数70個');
  await goTo(page, 'issues');
  await expect(history(page).locator('li', { hasText: '使用：' })).toHaveCount(1);
});

test('DAT-04: 作業の開始が記録できなければ、同じ入力の材料の使用も台帳に残さず、入力も消さない', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('P1', 'P', 'T', 'counted', '100'), '08:00');
  const failed = await record(page, 'start', { process: 'R組立', newId: 'P1', item: 'R', project: 'A-001', location: 'T', basis: 'counted', value: '30', m1lot: 'P1', m1basis: 'counted', m1value: '30' }, '09:00');
  await expect(failed).toContainText('記録していない：保管単位ID P1 は使用済み');
  // 失敗した入力では一覧を描き直さないので、選び直して今の台帳から描き直させてから確かめる。
  await row(page, 'P1').getByRole('button', { name: 'P1' }).click();
  await expect(cell(page, 'P1', '記録上の数と根拠')).toHaveText('100個・数えた');
  await goTo(page, 'issues');
  await expect(history(page).locator('li')).toHaveCount(1);
  await expect(page.getByRole('form', { name: '操作の入力' }).locator('[name=m1value]')).toHaveValue('30');
});

test('QTY-07・MFG-01b: 同じ品目・工程に単位の違う作業の開始を記録しても、単位ごとに表示し、画面の更新が止まらない', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'start', { process: 'R組立', newId: 'S-hon', item: 'S', unit: '本', project: 'A-001', location: 'T', basis: 'counted', value: '10' }, '09:00');
  await recorded(page, 'start', { process: 'R組立', newId: 'S-box', item: 'S', unit: '箱', project: 'A-001', location: 'T', basis: 'counted', value: '2' }, '09:30');
  await expect(production(page)).toContainText('工程R組立・品目S（本）・案件・用途A-001：工程内 記録上の数10本（作業中 10本・数えた');
  await expect(production(page)).toContainText('工程R組立・品目S（箱）・案件・用途A-001：工程内 記録上の数2箱（作業中 2箱・数えた');
  await goTo(page, 'issues');
  await expect(history(page).locator('li')).toHaveCount(2);
  await expect(page.getByRole('form', { name: '操作の入力' }).locator('[name=newId]')).toHaveValue('');
});

test('MFG-03a・UI-05a: 材料の保管単位を選ばずに根拠や数量だけ入れた行は、記録せず入力を残す', async ({ page }) => {
  await startEmpty(page);
  const failed = await record(page, 'start', { process: 'R組立', newId: 'R-no-material', item: 'R', project: 'A-001', location: 'T', basis: 'counted', value: '30', m1basis: 'counted', m1value: '30' }, '09:00');
  await expect(failed).toContainText('記録していない：材料1の保管単位を選ぶ');
  await goTo(page, 'issues');
  await expect(history(page).locator('li')).toHaveCount(0);
  await expect(page.getByRole('form', { name: '操作の入力' }).locator('[name=m1value]')).toHaveValue('30');
});

test('MFG-08b: 工程内数が中断した数を下回ると、位置の変更は記録して製造の欄に警告を出し、中断した数を直すと消える。確認が必要は作らない', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'start', { process: 'R組立', newId: 'R1', item: 'R', project: 'A-001', location: 'T', basis: 'counted', value: '10' }, '09:00');
  await recorded(page, 'stop', { process: 'R組立', item: 'R', project: 'A-001', reason: '部品不足', affected: '5' }, '09:30');
  await recorded(page, 'stageFix', { lot: 'R1', childId: 'R2', basis: 'counted', value: '8', to: 'awaitingHandover' }, '10:00');
  await expect(production(page)).toContainText('工程内 記録上の数2台');
  await expect(production(page)).toContainText('影響5台（警告：中断した数5が工程内数2を超えている。中断した数を更新する）');
  await goTo(page, 'issues');
  await expect(page.locator('#issues')).toContainText('確認事項はない');
  await goTo(page, 'stock');
  await recorded(page, 'stopUpdate', { stop: 'op2', affected: '2' }, '10:20');
  await expect(production(page)).toContainText('うち 中断op2 影響2台／完成（渡す前）');
  await expect(production(page)).not.toContainText('警告');
});

test('QTY-12b・UI-08a: 位置の変更が負数で保留されたら、製造の欄にも確認が必要を文字で出し、確定した数として断定しない', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'start', { process: 'R組立', newId: 'R1', item: 'R', project: 'A-001', location: 'T', basis: 'counted', value: '5' }, '09:00');
  await recorded(page, 'stageFix', { lot: 'R1', childId: 'R2', basis: 'counted', value: '8', to: 'awaitingHandover' }, '10:00');
  await expect(production(page)).toContainText('確認が必要 1件：この数を確定した製造の数として断定しない');
  await goTo(page, 'issues');
  await expect(page.locator('#issues')).toContainText('負数になるため未反映');
});

test('REC-03b: 作業の開始の材料が複数あり、包含の回答が材料ごとに違っても、材料ごとに答えて記録する', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('P1', 'P', 'T', 'counted', '100'), '09:00');
  await recorded(page, 'register', lot('Q1', 'Q', 'T', 'counted', '100'), '09:00');
  const form = page.getByRole('form', { name: '操作の入力' });
  const failed = await record(page, 'start', { process: 'R組立', newId: 'R1', item: 'R', project: 'A-001', location: 'T', basis: 'counted', value: '30', m1lot: 'P1', m1basis: 'counted', m1value: '30', m2lot: 'Q1', m2basis: 'counted', m2value: '30' }, '08:50');
  await expect(failed).toContainText('回答が必要：材料1');
  await form.locator('[name=m1inclusion]').selectOption('included');
  await form.getByRole('button', { name: '記録する' }).click();
  await expect(page.getByRole('status')).toContainText('回答が必要：材料2');
  await form.locator('[name=m2inclusion]').selectOption('notIncluded');
  await form.getByRole('button', { name: '記録する' }).click();
  await expect(page.getByRole('status')).toContainText('記録した');
  await expect(cell(page, 'P1', '記録上の数と根拠')).toHaveText('100個・数えた');
  await expect(cell(page, 'Q1', '記録上の数と根拠')).toHaveText('記録上の数70個');
});

test('MFG-08a: 不足数の単位を選んで記録し、複数の単位を持つ品目でも取り違えて表示しない', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'stop', { process: 'R組立', item: 'R', project: 'A-001', reason: 'ネジ不足', shortageItem: 'S', shortageUnit: '箱', shortageValue: '2', affectedUnknown: true }, '11:10');
  await expect(page.getByRole('list', { name: '中断の記録' })).toContainText('不足 品目S 2箱');
});

test('MFG-03c・OPS-06a: 製造中・完成（渡す前）保管単位に取り分けた理由を付けても、除外の合計と内訳には数えず、二重に数えない', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'start', { process: 'R組立', newId: 'R1', item: 'R', project: 'A-001', location: 'T', basis: 'counted', value: '10' }, '09:00');
  await recorded(page, 'hold', { lot: 'R1', reason: 'defective' }, '09:30');
  await expect(cell(page, 'R1', '取り分けた理由')).toHaveText('不良');
  await expect(totals(page)).toContainText('取り分け 記録上の数0台／製造中・完成（渡す前） 10台・数えた');
  await expect(totals(page)).not.toContainText('内訳 不良');
});

test('MFG-01b: 完成（渡す前）を工程内へ戻す訂正は、完了累計を変えず、訂正で戻した数として別に示し、現物が動いたようには書かない', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'start', { process: 'R組立', newId: 'R1', item: 'R', project: 'A-001', location: 'T', basis: 'counted', value: '10' }, '09:00');
  await recorded(page, 'finish', { lot: 'R1', childId: 'R2', basis: 'counted', value: '6' }, '10:00');
  await recorded(page, 'inspect', { lot: 'R2', childId: 'R3', basis: 'counted', value: '6' }, '10:30');
  await recorded(page, 'stageFix', { lot: 'R3', childId: 'R4', basis: 'counted', value: '2', to: 'working' }, '11:00');
  await expect(production(page)).toContainText('工程完了累計 6台');
  await expect(production(page)).toContainText('訂正で工程内へ戻した数 2台（完了累計から引かない）');
  await expect(production(page)).not.toContainText('／工程内へ戻した数');
});

test('MFG-06: 作業の開始の作業の場所に次工程Nを選べない（工程に載った物はNに置かない）', async ({ page }) => {
  await startEmpty(page);
  const form = page.getByRole('form', { name: '操作の入力' });
  await selectOperation(form.locator('[name=op]'), { label: '作業の開始（材料の使用とまとめて記録）' });
  await expect(form.locator('[name=location] option')).toHaveText(['選ぶ', '棚S1（S1）', '棚S2（S2）', '作業台T（T）', '対象外の棚O（O）']);
});

test('MFG-06: 次工程への引渡しの渡した先は次工程Nだけで、棚や作業台を選べない', async ({ page }) => {
  await startEmpty(page);
  const form = page.getByRole('form', { name: '操作の入力' });
  await selectOperation(form.locator('[name=op]'), { label: '次の作業へ渡す' });
  await expect(form.locator('[name=location] option')).toHaveText(['選ぶ', '次工程N（N）']);
});

test('AT-29・DAT-04: 材料が足りず使用が保留されても作業の開始は記録し、他の材料は減らし、確認事項が開いたことをその場で知らせる', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('P1', 'P', 'T', 'counted', '100'), '08:00');
  await recorded(page, 'register', lot('Q1', 'Q', 'T', 'counted', '20'), '08:00');
  const status = await record(page, 'start', { process: 'R組立', newId: 'R1', item: 'R', project: 'A-001', location: 'T', basis: 'counted', value: '30', m1lot: 'P1', m1basis: 'counted', m1value: '30', m2lot: 'Q1', m2basis: 'counted', m2value: '30' }, '09:00');
  await expect(status).toContainText('記録した');
  await expect(status).toContainText('確認事項が1件開いた');
  await expect(cell(page, 'P1', '記録上の数と根拠')).toHaveText('記録上の数70個');
  await expect(cell(page, 'Q1', '記録上の数と根拠')).toHaveText('20個・数えた');
  await expect(cell(page, 'Q1', '確認が必要')).toContainText('確認が必要 1件');
  await expect(cell(page, 'R1', '作業の状態')).toHaveText('工程R組立・作業中');
});

test('AT-15: 配膳だけの品目10個を次工程へ移しても品目と部署数量は変わらず、製造・消費を作らない', async ({ page }) => {
  await startEmpty(page);
  await recorded(page, 'register', lot('K', 'P', 'T', 'counted', '10'), '09:00');
  await recorded(page, 'move', { lot: 'K', location: 'N' }, '10:00');
  await expect(cell(page, 'K', '場所')).toHaveText('N');
  await expect(cell(page, 'K', '作業の状態')).toHaveText('作業なし');
  await expect(totals(page)).toHaveText('品目P（個）：在庫 10個・数えた／使用可能 10個・数えた／取り分け 記録上の数0個');
  await goTo(page, 'issues');
  await expect(history(page).locator('li')).toHaveCount(2);
  await goTo(page, 'stock');
  await expect(page.locator('#production')).toContainText('工程内の仕掛品と作業の中断はない');
});

test('AT-40: 工程内12（うち検査待ち2）・完成（渡す前）18で、中断した数を不明で登録して5台へ更新する。工程内数を超える台数は記録しない', async ({ page }) => {
  await startEmpty(page);
  await startedAndInspected(page);
  await expect(production(page)).toContainText('工程内 記録上の数12台（作業中 記録上の数10台、確認待ち 記録上の数2台）／完成（渡す前） 18台・数えた');

  await recorded(page, 'stop', { process: 'R組立', item: 'R', project: 'A-001', reason: '部品不足', shortageItem: 'P', shortageValue: '3', affectedUnknown: true }, '11:10');
  await expect(production(page)).toContainText('工程内 記録上の数12台（作業中 記録上の数10台、確認待ち 記録上の数2台）、うち 中断op');
  await expect(production(page)).toContainText('影響数不明');
  await expect(page.getByRole('list', { name: '中断の記録' })).toContainText('理由「部品不足」、不足 品目P 3個、影響数不明。中断中');

  const form = page.getByRole('form', { name: '操作の入力' });
  await selectOperation(form.locator('[name=op]'), { label: '中断した数の更新' });
  const stop = await form.locator('[name=stop] option', { hasText: '部品不足' }).getAttribute('value');
  await expect(await record(page, 'stopUpdate', { stop: stop!, affected: '13' }, '11:30')).toContainText('影響数13は工程内数12の内数にする');
  await recorded(page, 'stopUpdate', { stop: stop!, affected: '5' }, '11:30');
  await expect(production(page)).toContainText(`うち 中断${stop} 影響5台／完成（渡す前）`);
  await goTo(page, 'issues');
  await expect(history(page)).toContainText(`中断した数の更新：中断${stop}を影響数不明 → 影響5台`);

  await goTo(page, 'stock');
  await recorded(page, 'resume', { stop: stop! }, '13:00');
  await expect(page.getByRole('list', { name: '中断の記録' })).toContainText('作業の再開済み');
  await expect(production(page)).not.toContainText('うち 中断');
});
