import type * as SheetJS from 'xlsx';

// 外側のモジュールだけを読み直しても、失敗した依存のURLはブラウザーに残る。本体を別のURLで読み直す。
async function loadSheetJs(): Promise<typeof SheetJS> {
  for (let attempt = 0; ; attempt++) {
    try {
      if (attempt === 0) return await import('xlsx');
      const url = new URL('../vendor/xlsx.mjs', import.meta.url);
      url.searchParams.set('retry', `${new URL(import.meta.url).search}-${attempt}`);
      return await import(url.href);
    } catch (error) {
      if (attempt >= 4) throw error;
      await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
}

const XLSX = await loadSheetJs();

export type Sheet = {
  name: string;
  columns: readonly { header: string; width: number }[];
  rows: readonly (readonly string[])[];
};

export const maxCellChars = 32_767;
export const maxRows = 1_048_576;
export const longValueSheetName = '長い値';
const fragmentChars = 30_000;
const invalidSheetName = /[[\]:*?/\\]/;

// 文字の保護による膨張も数え、サロゲートペアを分断しない。
function cutAt(text: string, from: number, limit: number): number {
  let end = from;
  let size = 0;
  while (end < text.length) {
    const width = (text.codePointAt(end) ?? 0) > 0xffff ? 2 : 1;
    const protectedWidth = width + (/^_x[0-9A-Fa-f]{4}_/.test(text.slice(end, end + 7)) || text[end] === '\r' ? 6 : 0);
    if (size + protectedWidth > limit) break;
    size += protectedWidth;
    end += width;
  }
  return end;
}

function check(sheets: readonly Sheet[]): void {
  if (sheets.length === 0) throw new Error('シートが一つもない');
  const seen = new Set<string>();
  for (const { name, columns, rows } of sheets) {
    if (name.length < 1 || name.length > 31 || invalidSheetName.test(name) || name.startsWith("'") || name.endsWith("'")) throw new Error(`シート名が使えない：${name}`);
    if (name === longValueSheetName) throw new Error(`シート名「${longValueSheetName}」は長い値のために予約している`);
    const key = name.toLowerCase();
    if (seen.has(key)) throw new Error(`シート名が重複している：${name}`);
    seen.add(key);
    if (rows.length + 1 > maxRows) throw new Error(`行が多すぎる（${name}：見出しを含めて${rows.length + 1}行、上限${maxRows}行）`);
    for (const [index, row] of rows.entries()) if (row.length !== columns.length) throw new Error(`行の長さが列の数と違う（${name}：${index + 1}行目）`);
    for (const column of columns) if (keepLiteral(column.header).length > maxCellChars) throw new Error(`見出しが長すぎる：${name}`);
  }
}

type Long = { seq: number; sheet: string; row: number; column: string; text: string };

// Excelの1セルの上限を超える値は、元のセルに先頭部分と案内を書き、全文を長い値のシートの断片に持つ。切り捨てると、桁の多いIDなどが失われる。
function cellText(text: string, ctx: { sheet: string; row: number; column: string }, longs: Long[]): string {
  if (keepLiteral(text).length <= maxCellChars) return text;
  const seq = longs.length + 1;
  longs.push({ seq, ...ctx, text });
  return `${text.slice(0, cutAt(text, 0, fragmentChars))}…（続きは『${longValueSheetName}』シートの連番${seq}）`;
}

// Excelは本文の_xHHHH_を文字の指定として読むので、入力にその形があれば_x005F_で守る（SheetJSは制御文字だけを_xHHHH_にする）。
// CRはXMLの改行正規化でLFへ変わるため、文字参照として保持する。既存の文字参照風入力を先に保護する。
const keepLiteral = (text: string): string => text.replace(/_x(?=[0-9A-Fa-f]{4}_)/g, '_x005F_x').replace(/\r/g, '_x000D_');

function worksheetOf(columns: Sheet['columns'], rows: readonly (readonly string[])[]): SheetJS.WorkSheet {
  const ws: SheetJS.WorkSheet = {};
  rows.forEach((row, r) => row.forEach((text, c) => { ws[XLSX.utils.encode_cell({ r, c })] = { t: 's', v: keepLiteral(text), z: '@' }; }));
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(rows.length - 1, 0), c: Math.max(columns.length - 1, 0) } });
  ws['!cols'] = columns.map(column => ({ wch: column.width }));
  return ws;
}

// すべてのセルを文字列にし、数式を持たせない。先頭が0・=・+・-・@の値も、Excelで開いて上書き保存しても変換されない。
export function xlsxOf(sheets: readonly Sheet[]): Uint8Array<ArrayBuffer> {
  check(sheets);
  const longs: Long[] = [];
  const book = XLSX.utils.book_new();
  for (const { name, columns, rows } of sheets) {
    const header = columns.map(column => column.header);
    const body = rows.map((row, r) => row.map((text, c) => cellText(text, { sheet: name, row: r + 2, column: columns[c]?.header ?? '' }, longs)));
    XLSX.utils.book_append_sheet(book, worksheetOf(columns, [header, ...body]), name);
  }
  if (longs.length > 0) {
    const fragments = longs.flatMap(long => {
      const pieces: string[] = [];
      for (let from = 0; from < long.text.length;) { const to = cutAt(long.text, from, fragmentChars); pieces.push(long.text.slice(from, to)); from = to; }
      return pieces.map((piece, index) => [String(long.seq), long.sheet, String(long.row), long.column, String(index + 1), piece]);
    });
    if (fragments.length + 1 > maxRows) throw new Error('行が多すぎる（長い値のシート）');
    const columns = ['連番', '元のシート', '元の行', '元の列', '断片の番号', '断片'].map((header, i) => ({ header, width: i === 5 ? 60 : 14 }));
    XLSX.utils.book_append_sheet(book, worksheetOf(columns, [columns.map(c => c.header), ...fragments]), longValueSheetName);
  }
  const out: unknown = XLSX.write(book, { type: 'array', bookType: 'xlsx', bookSST: true, compression: true });
  if (!(out instanceof ArrayBuffer) && !(out instanceof Uint8Array)) throw new Error('xlsxの書き出しの戻り値が想定と違う');
  return out instanceof ArrayBuffer ? new Uint8Array(out) : Uint8Array.from(out);
}
