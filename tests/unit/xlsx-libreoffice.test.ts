import * as XLSX from 'xlsx';
import { describe, expect, test } from 'vitest';
import { emptySupply } from '../../src/domain/supply.ts';
import { seedLedger } from '../../src/ui/seed.ts';
import { viewSheetsOf } from '../../src/ui/viewsheets.ts';
import { xlsxOf, type Sheet } from '../../src/ui/xlsx.ts';

// 補助確認（FH）。この端末にExcelはないので、LibreOfficeで閲覧用の出力を開いて保存し直し、全セルの文字列が同じことを確かめる。
// LibreOfficeはExcelより読み込みが寛容なので、これが通ってもExcelでの合格とは数えない（要件4.5・4.8・4.9・4.11のExcelでの確認は、利用者の環境で行う）。
// 試験にNodeの型（@types/node）を入れていないので、必要な部分だけ型を書いて実行時のモジュールを取り出す。
type Fs = { existsSync(path: string): boolean; mkdtempSync(prefix: string): string; writeFileSync(path: string, data: Uint8Array): void; readFileSync(path: string): Uint8Array };
type ChildProcess = { execFileSync(file: string, args: string[], options: { timeout: number; stdio: 'ignore' }): unknown };
type Os = { tmpdir(): string };
const load = async <T>(name: string): Promise<T> => (await import(/* @vite-ignore */ `node:${name}`)) as T;

const soffice = 'C:\\Program Files\\LibreOffice\\program\\soffice.exe';
const fs = await load<Fs>('fs');
const available = fs.existsSync(soffice);

const tricky = ['0012', '000000000000000000000001', '=1+1', '+1', '-1', '@A', '=HYPERLINK("http://example.invalid","x")', '不明', '日本語', '１２３（全角）', '_x0041_', ' 先頭の空白', '末尾の空白 ', "a&b<c>\"d'e", '改\n行', '1E5', '2026-10-07', '1/2', 'TRUE', '0.50'];

function texts(book: XLSX.WorkBook): Record<string, string[][]> {
  return Object.fromEntries(book.SheetNames.map(name => {
    const sheet = book.Sheets[name];
    if (!sheet) throw new Error(`シートがない：${name}`);
    const ref = XLSX.utils.decode_range(sheet['!ref'] ?? 'A1');
    const rows: string[][] = [];
    for (let r = ref.s.r; r <= ref.e.r; r++) {
      const row: string[] = [];
      for (let c = ref.s.c; c <= ref.e.c; c++) {
        const cell = sheet[XLSX.utils.encode_cell({ r, c })];
        row.push(cell === undefined ? '（セルなし）' : `${cell.t}:${String(cell.v)}`);
      }
      rows.push(row);
    }
    return [name, rows];
  }));
}

describe.skipIf(!available)('FH-F1A-01（補助確認、Excelでの合格には数えない）: LibreOfficeで開いて保存し直しても、全セルが同じ文字列のまま', () => {
  test('閲覧用の出力と、変換されやすい値・長い値を並べたシートを、保存し直しても全セルの型と値が同じ', async () => {
    const os = await load<Os>('os');
    const cp = await load<ChildProcess>('child_process');
    const dir = fs.mkdtempSync(`${os.tmpdir()}\\fz-lo-`);
    const long = `0${'1234567890'.repeat(3276)}1234567`;
    const sheets: Sheet[] = [
      ...viewSheetsOf({ ledger: seedLedger(), supply: emptySupply }, '2026-10-07T15:30:00+09:00'),
      { name: '変換されやすい値', columns: [{ header: '値', width: 20 }], rows: [...tricky.map(v => [v]), [long]] },
    ];
    const input = `${dir}\\in.xlsx`;
    fs.writeFileSync(input, xlsxOf(sheets));
    cp.execFileSync(soffice, ['--headless', '--norestore', `-env:UserInstallation=file:///${dir.replaceAll('\\', '/')}/profile`, '--convert-to', 'xlsx:Calc MS Excel 2007 XML', '--outdir', `${dir}\\out`, input], { timeout: 180_000, stdio: 'ignore' });
    const before = texts(XLSX.read(fs.readFileSync(input), { type: 'array' }));
    const after = texts(XLSX.read(fs.readFileSync(`${dir}\\out\\in.xlsx`), { type: 'array' }));
    expect(Object.keys(after)).toEqual(Object.keys(before));
    // 空の比較で通らないよう、比べたセルの数も確かめる。
    expect(Object.values(before).flat(2).length).toBeGreaterThan(500);
    expect(after['変換されやすい値']?.length).toBe(tricky.length + 2);
    for (const name of Object.keys(before)) expect(after[name], name).toEqual(before[name]);
  }, 240_000);
});
