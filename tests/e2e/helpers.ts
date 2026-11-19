import { chromium, expect, type Dialog, type Download, type Locator, type Page } from '@playwright/test';

// 設定のstorageStateが届かない専用profileでも、既存の試験は高度な操作モードの画面で動かす。利用者が選んだモードは上書きしない。
export async function launchAdvanced(...args: Parameters<typeof chromium.launchPersistentContext>) {
  const context = await chromium.launchPersistentContext(...args);
  await context.addInitScript(() => { if (localStorage.getItem('fuzzy-stock-mode') === null) localStorage.setItem('fuzzy-stock-mode', 'advanced'); });
  return context;
}
import type { Destination } from '../../src/ui/navigation.ts';
import { operationGroups } from '../../src/ui/operation-picker.ts';

export const opLabels = {
  register: '現物の登録',
  use: '使用',
  handover: '外へ出す',
  move: '移動',
  splitMove: '一部を分けて移動',
  split: '分割',
  merge: '統合',
  recount: '数えて確認・訂正',
  hold: '取り分ける',
  release: '取り分けを戻す',
  declare: '数の食い違いをメモする',
  provisional: '仮の記録',
  correctTime: '実際の日時の訂正',
  resolve: '確認事項を片付ける',
  start: '作業の開始',
  recipeStart: 'セットで作業を開始',
  finish: '作業終了',
  inspect: '確認の完了',
  toNext: '次の作業へ渡す',
  stageFix: '作業の状態の訂正',
  stop: '作業の中断',
  stopUpdate: '中断した数の更新',
  resume: '作業の再開',
  void: '間違えた記録の取り消し',
  needRegister: '必要な数の登録',
  needRevise: '必要な数の改訂',
  declareShortage: '足りない分の記録',
  linkDeclaration: '足りない分の記録の対応付け',
  requestRecord: '注文・購入予定の記録',
  orderConfirm: '注文の確定',
  replyRecord: '返事・届く予定日の更新',
  requestCancel: '依頼の取消',
  receive: '受け取り',
  templateNeedGenerate: 'セットから必要明細を生成',
  templateNeedEdit: '生成した必要明細の変更',
  templateSave: 'セットの登録・変更',
  templateDelete: 'セットの削除',
  templateReceive: 'セットからまとめて受け取り',
  allocate: '受け取った現物への割り当て',
  receiptRevise: '実際に受け取った数の訂正',
  arrivalRevise: '割り当ての訂正',
  surplusAllocate: '余った分の振り分け',
  spareSwap: '予備から案件・用途向けへ',
  returnAck: '返品の受付確認',
  remainder: '開けた物の残り具合',
  masterItem: '品目の登録',
  masterLocation: '場所の登録',
  masterCase: '案件・用途の登録',
  masterActor: '担当者の登録',
  masterRename: '名称の変更',
  masterDeactivate: '利用停止',
  masterReactivate: '利用の再開',
  masterCode: '品番・コードの変更・付与',
  masterSource: '元の資料の更新',
  masterPerBox: '包装・入り数の設定',
  masterConsumable: '共通消耗品・補充基準の設定',
  masterScope: '記録の対象の変更',
  masterProcess: '工程の登録',
  masterProcessCriterion: '工程の完了基準の変更',
  masterNextProcess: '次工程の場所の指定・解除',
  identify: '仮の記録を既存の保管単位に対応付ける',
  adopt: '仮の記録を新しい保管単位にする',
  assignProject: '所属が不明な保管単位の結び付け',
  transfer: '案件・用途の付け替え',
  reworkBegin: 'やり直し・修理を開始',
  reworkReplace: 'やり直し・修理の交換部品を使用',
  reworkDiscard: 'やり直し・修理で取り外した部品を廃棄',
  reworkRecover: 'やり直し・修理で取り外した部品を回収',
  returnRecord: '返ってきた物の仮の記録',
  returnAssign: '返ってきた物の仮の記録の割り当て',
  returnRework: '返ってきた物のやり直し・修理を開始',
  needImportResolve: '必要明細取込の照合',
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

// 架空の登録情報がある練習用台帳から始め、別試験の数値を継ぎ足さない。
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
  const discard = (dialog: Dialog) => dialog.message() === '未保存の入力を破棄して、操作を切り替えますか。' ? dialog.accept() : dialog.dismiss();
  control.page().once('dialog', discard);
  try { await control.selectOption(selection); }
  finally { control.page().removeListener('dialog', discard); }
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

// 登録情報は種類ごとのサブメニューで切り替える。絞り込み中は名前に件数が付くので前方一致で探す。
export async function openMasterKind(page: Page, kind: '品目' | '場所' | '案件・用途' | '担当者' | '工程'): Promise<void> {
  const button = page.locator('#masters').getByRole('group', { name: '登録情報の種類' }).getByRole('button', { name: new RegExp(`^${kind}(（|$)`) });
  await button.click();
  await expect(button).toHaveAttribute('aria-current', 'true');
}
