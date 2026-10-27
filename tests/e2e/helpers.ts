import { expect, type Download, type Locator, type Page } from '@playwright/test';
import type { Destination } from '../../src/ui/navigation.ts';
import { operationGroups } from '../../src/ui/operation-picker.ts';

export const opLabels = {
  register: '登録（開始時点の現物・既にある物。依頼への受け取りは「受け取り」を使う）',
  use: '使用',
  handover: '外へ出す（譲渡・持ち出し）',
  move: '移動（保管単位全部）',
  splitMove: '一部を分けて移動',
  split: '分割（同じ場所で分ける）',
  merge: '統合',
  recount: '数えて確認・訂正（原因不明でもよい）',
  hold: '取り分ける（不良・使用可否確認待ち・返却待ち・予備）',
  release: '取り分けを戻す',
  declare: '数の食い違いをメモする（数量は変えない）',
  provisional: '仮の記録（適用先の保管単位が分からない）',
  correctTime: '実際の日時の訂正',
  resolve: '確認事項を片付ける',
  start: '作業の開始（材料の使用とまとめて記録）',
  recipeStart: 'セットで作業を開始（材料の使用を推計）',
  finish: '作業終了',
  inspect: '確認の完了',
  toNext: '次の作業へ渡す',
  stageFix: '作業の状態の訂正',
  stop: '作業の中断',
  stopUpdate: '中断した数の更新',
  resume: '作業の再開（材料の受け取りとは別に記録）',
  void: '間違えた記録の取り消し（使用・引渡し）',
  needRegister: '必要な数の登録（案件・用途ごとの必要品目・必要な数）',
  needRevise: '必要な数の改訂（改訂前後を履歴に残す）',
  declareShortage: '足りない分の記録（手動。確認事項は作らない）',
  linkDeclaration: '足りない分の記録の対応付け（自動の不足候補と同じ不足）',
  requestRecord: '注文・購入予定の記録（依頼しただけでは在庫に数えない）',
  orderConfirm: '注文の確定（依頼とは別の記録）',
  replyRecord: '返事・届く予定日の更新',
  requestCancel: '依頼の取消（元の依頼は残る）',
  receive: '受け取り（届いた数を記録。依頼への割り当てつき）',
  templateSave: 'セットの登録・変更',
  templateDelete: 'セットの削除',
  templateReceive: 'セットからまとめて受け取り（欠品の入力）',
  allocate: '受け取った現物への割り当て（拒否のあとの再割り当てなど）',
  receiptRevise: '実際に受け取った数の訂正（届いた数の訂正。理由が必要）',
  arrivalRevise: '割り当ての訂正（届いた数・使える数。取消済みの依頼の割り当ても）',
  surplusAllocate: '余った分の振り分け（受け取りの一部を予備・返却待ちにする）',
  spareSwap: '予備から案件・用途向けへ（交換。理由が必要）',
  returnAck: '返品の受付確認（実返却とは別の記録。在庫は減らさない）',
  remainder: '開けた物の残り具合（数が不明な開封分。数量へは換算しない）',
  masterItem: '登録情報：品目の登録',
  masterLocation: '登録情報：場所の登録',
  masterCase: '登録情報：案件・用途の登録',
  masterActor: '登録情報：担当者の登録',
  masterRename: '登録情報：名称の変更',
  masterDeactivate: '登録情報：利用停止（過去の記録は消さない）',
  masterReactivate: '登録情報：利用の再開',
  masterCode: '登録情報：品番・コードの変更・付与（仮の正式化を含む）',
  masterSource: '登録情報：元の資料の更新（呼び名は変えない）',
  masterPerBox: '登録情報：包装・入り数の設定（実際の日時を適用時点にする）',
  masterConsumable: '登録情報：共通消耗品・補充基準の設定',
  masterScope: '登録情報：記録の対象の変更（実際の日時を適用時点にする）',
  masterProcess: '登録情報：工程の登録',
  masterProcessCriterion: '登録情報：工程の完了基準の変更（作業や中断を記録していない工程だけ）',
  masterNextProcess: '登録情報：次工程の場所の指定・解除',
  identify: '仮の記録を既存の保管単位と同じ現物として対応付ける（数量は足さない）',
  adopt: '仮の記録を新しい保管単位として登録する（数量は仮の記録のまま）',
  assignProject: '案件・用途が不明な保管単位を案件・用途・共通在庫へ結び付ける',
  transfer: '案件・用途の付け替え（場所は変えない）',
  reworkBegin: 'やり直し・修理を開始（同じ現物を工程へ戻す）',
  reworkReplace: 'やり直し・修理の交換部品を使用',
  reworkDiscard: 'やり直し・修理で取り外した部品を廃棄',
  reworkRecover: 'やり直し・修理で取り外した部品を回収',
  returnRecord: '返ってきた物を仮の記録に残す（まだ数量へ反映しない）',
  returnAssign: '返ってきた物の仮の記録を割り当てる（現在数量への包含を確認）',
  returnRework: '返ってきた物のやり直し・修理を開始',
  needImportResolve: '必要明細取込の照合（保留の適用・見送り）',
} as const;

export async function waitForApp(page: Page): Promise<void> {
  await expect(page.locator('#app')).toHaveJSProperty('inert', false);
  await expect(page.locator('#boot')).toBeHidden();
}

export async function goTo(page: Page, destination: Destination): Promise<void> {
  await waitForApp(page);
  const button = page.locator(`#nav-${destination}`);
  await button.click();
  await expect(button).toHaveAttribute('aria-current', 'page');
}

// 各試験は空の台帳から始め、別試験の数値を継ぎ足さない（F0_SCOPE）。
export async function startEmpty(page: Page): Promise<void> {
  await page.goto('/');
  await usePractice(page);
}

// 起動直後の表示を確かめた後で、架空の登録情報が要る操作へ進むときに使う。
export async function usePractice(page: Page): Promise<void> {
  await goTo(page, 'management');
  await page.getByRole('button', { name: '練習用の台帳で初期化' }).click();
  await page.getByRole('button', { name: '初期化する', exact: true }).click();
  await goTo(page, 'stock');
}

// 初回起動は空の台帳なので、固定の架空データを前提にする試験は明示して読み込む。
export async function startSample(page: Page, path = '/'): Promise<void> {
  await page.goto(path);
  await waitForApp(page);
  await goTo(page, 'management');
  await page.getByRole('button', { name: '標準サンプルデータで初期化' }).click();
  await page.getByRole('button', { name: '初期化する', exact: true }).click();
  await goTo(page, 'stock');
}

// 値の型でフォームの部品を操作する。文字列はselectなら選択、inputなら入力。真偽値はチェック。
// at は日本時間の 'HH:MM'。null は実際の日時不明。
export async function selectOperation(control: Locator, selection: string | { label: string }): Promise<void> {
  const key = typeof selection === 'string' ? selection : Object.entries(opLabels).find(([, label]) => label === selection.label)?.[0];
  const group = operationGroups.find(item => key !== undefined && item.keys.includes(key));
  if (group === undefined) throw new Error(`操作の分類が見つかりません：${JSON.stringify(selection)}`);
  await control.page().getByLabel('作業の種類', { exact: true }).selectOption(group.id);
  await control.selectOption(selection);
}

export async function allOperationLabels(page: Page): Promise<string[]> {
  const category = page.getByLabel('作業の種類', { exact: true });
  const original = await category.inputValue();
  const groups = await category.locator('option').evaluateAll(nodes => nodes.map(node => node.getAttribute('value')!));
  const labels: string[] = [];
  for (const group of groups) {
    await category.selectOption(group);
    labels.push(...await page.locator('[name=op] optgroup[data-operation-group] option').allTextContents());
  }
  await category.selectOption(original);
  return labels;
}

export async function record(
  page: Page,
  op: keyof typeof opLabels,
  values: Record<string, string | boolean>,
  at: string | null = '12:00',
): Promise<Locator> {
  const form = page.getByRole('form', { name: '操作の入力' });
  await selectOperation(form.locator('[name=op]'), { label: opLabels[op] });
  for (const [name, value] of Object.entries(values)) await set(form.locator(`[name=${name}]`), value);
  if (at === null) await form.locator('[name=occurredUnknown]').check();
  else await form.locator('[name=occurredAt]').fill(`2026-09-29T${at}`);
  await form.getByRole('button', { name: '記録する' }).click();
  await waitForPersistence(page);
  return page.getByRole('status');
}

export async function waitForPersistence(page: Page): Promise<void> {
  await expect(page.locator('#app')).toHaveJSProperty('inert', false);
}

export async function set(control: Locator, value: string | boolean): Promise<void> {
  if (typeof value === 'boolean') return value ? control.check() : control.uncheck();
  const tag = await control.evaluate((node) => node.tagName);
  if (tag === 'SELECT') await control.selectOption(value);
  else await control.fill(value);
}

// 回答欄が出たら選んで同じ入力を再送する。
export async function answer(page: Page, inclusion: 'included' | 'notIncluded' | 'unknown'): Promise<void> {
  const form = page.getByRole('form', { name: '操作の入力' });
  await expect(page.getByRole('status')).toContainText('回答が必要');
  await form.locator('[name=inclusion]').selectOption(inclusion);
  await form.getByRole('button', { name: '記録する' }).click();
  await waitForPersistence(page);
  await expect(page.getByRole('status')).toContainText('記録した');
}

export async function recorded(page: Page, op: keyof typeof opLabels, values: Record<string, string | boolean>, at: string | null = '12:00'): Promise<void> {
  await expect(await record(page, op, values, at)).toContainText('記録した');
}

export function row(page: Page, lotId: string): Locator {
  return page.locator(`#list tr[data-lot="${lotId}"]`);
}

const columns = ['ID', '品目', '案件・用途', '場所', '記録上の数と根拠', '取り分けた理由', '作業の状態', '最後に数えた数', '最終記録更新', '確認が必要'] as const;

export function cell(page: Page, lotId: string, column: (typeof columns)[number]): Locator {
  return row(page, lotId).locator('td').nth(columns.indexOf(column));
}

export const totals = (page: Page) => page.getByRole('list', { name: '絞り込んだ範囲の集計' });

export const lot = (id: string, item: string, location: string, basis: string, value: string, extra: Record<string, string> = {}) => ({
  newId: id,
  item,
  location,
  project: 'A-001',
  basis,
  value,
  ...extra,
});

// 画面の説明文（F1-A 5.4）：記録がこの端末にだけあること、架空データ、バックアップは各自で保管すること、権限がないこと。
export const bannerText = 'この端末のブラウザーにだけ保存（別の端末へは移らない）。復元用バックアップはファイルとして各自で保管する。権限による制限はまだなく、画面を使える人は誰でも登録情報の変更と、バックアップと復元ができる。案件・用途の付け替えは、数量の分かる未使用の案件・用途を指定した物に限る。コード入力は専用形式に対応。読取機器との連携・帳票からの取込・依頼の自動作成には対応していない。';

export async function storageBytes(page: Page): Promise<Record<string, string | null>> {
  return page.evaluate(() => Object.fromEntries(Object.keys(localStorage).sort().map(key => [key, localStorage.getItem(key)])));
}

async function bytesOf(download: Download): Promise<Uint8Array> {
  const stream = await download.createReadStream();
  const parts: Uint8Array[] = [];
  for await (const chunk of stream as AsyncIterable<Uint8Array>) parts.push(chunk);
  const bytes = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) { bytes.set(part, at); at += part.length; }
  return bytes;
}

// ボタンを押してダウンロードされたファイルの名前・中身・保存先のパスを返す。
export async function downloadVia(page: Page, buttonName: string): Promise<{ name: string; bytes: Uint8Array; path: string }> {
  if (buttonName === backupButton || buttonName === exportButton) await goTo(page, 'management');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: buttonName, exact: true }).click()]);
  return { name: download.suggestedFilename(), bytes: await bytesOf(download), path: await download.path() };
}

export const backupButton = '復元用バックアップを保存';
export const restoreButton = 'バックアップから復元';
export const exportButton = '閲覧用に出力（Excel・復元には使えない）';

// 復元に使うファイルを選ぶ。ファイル選択は隠したinputで、読み込めない記録の画面では専用の操作から開く。
export async function pickFile(page: Page, file: string | FilePayload, buttonName = restoreButton): Promise<void> {
  if (buttonName === restoreButton) await goTo(page, 'management');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: buttonName, exact: true }).click()]);
  await chooser.setFiles(file);
}

// 試験にNodeの型（@types/node）は入れていないので、Playwrightの引数の型からBufferの型を取り出す。
type FilePayload = Exclude<Parameters<Locator['setInputFiles']>[0], string | readonly string[]> extends infer P ? Extract<P, { name: string }> : never;
type NodeBuffer = FilePayload['buffer'];

export function filePayload(name: string, mimeType: string, bytes: Uint8Array): FilePayload {
  // PlaywrightはNodeのBufferを要る。型は入れていないので、実行時のBufferを取り出して使う。
  const factory: { from(source: Uint8Array): NodeBuffer } = Reflect.get(globalThis, 'Buffer');
  return { name, mimeType, buffer: factory.from(bytes) };
}

export const jsonFile = (name: string, text: string): FilePayload => filePayload(name, 'application/json', new TextEncoder().encode(text));
