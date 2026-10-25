import * as XLSX from 'xlsx';
import { describe, expect, test } from 'vitest';
import { longValueSheetName, maxCellChars, xlsxOf, type Sheet } from '../../src/ui/xlsx.ts';

// SheetJSは、自分が書いたファイルを読み戻す試験にだけ使う（画面では外部のファイルを読まない）。
function read(bytes: Uint8Array): XLSX.WorkBook {
  return XLSX.read(bytes, { type: 'array', bookFiles: true, cellText: false, cellDates: false });
}

function cellsOf(book: XLSX.WorkBook, sheetName: string): (XLSX.CellObject | undefined)[][] {
  const sheet = book.Sheets[sheetName];
  if (!sheet) throw new Error(`シート${sheetName}がない`);
  const ref = XLSX.utils.decode_range(sheet['!ref'] ?? 'A1');
  const rows: (XLSX.CellObject | undefined)[][] = [];
  for (let r = ref.s.r; r <= ref.e.r; r++) {
    const row: (XLSX.CellObject | undefined)[] = [];
    for (let c = ref.s.c; c <= ref.e.c; c++) row.push(sheet[XLSX.utils.encode_cell({ r, c })]);
    rows.push(row);
  }
  return rows;
}

const textsOf = (book: XLSX.WorkBook, sheetName: string): string[][] => cellsOf(book, sheetName).map(row => row.map(cell => String(cell?.v)));

// 読み戻したブックの部品（パス→中身）。SheetJSの型には出ていないので、形を確かめて取り出す。
function filesOf(book: XLSX.WorkBook): Record<string, Uint8Array> {
  const files: unknown = Reflect.get(book, 'files');
  if (typeof files !== 'object' || files === null) throw new Error('部品を読めていない');
  const parts: Record<string, Uint8Array> = {};
  for (const [name, entry] of Object.entries(files)) {
    const content: unknown = typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'content') : undefined;
    if (content instanceof Uint8Array) parts[name] = content;
  }
  return parts;
}

const sheet = (name: string, header: string[], rows: string[][]): Sheet => ({ name, columns: header.map(h => ({ header: h, width: 12 })), rows });

const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const tricky = ['0012', '000000000000000000000001', '=1+1', '+1', '-1', '@A', '=HYPERLINK("http://example.invalid","x")', '不明', '日本語', '１２３（全角）', 'a\u0001b\u0008c', '_x0041_', '_x005F_x0041_', ' 先頭の空白', '末尾の空白 ', 'a&b<c>"d\'e', '改\n行', 'タブ\tあり'];

describe('FH-F1A-04・F1-A 4.1・4.3・4.5・4.8・4.9・4.11: すべてのセルが文字列で、数式を持たない', () => {
  const book = read(xlsxOf([sheet('試験', ['値'], tricky.map(v => [v]))]));

  test('読み戻すと、どの値も入力のまま戻る（先頭の0、数式に見える文字、不明、全角、制御文字、_xHHHH_、前後の空白、改行）', () => {
    expect(textsOf(book, '試験')).toEqual([['値'], ...tricky.map(v => [v])]);
  });

  test('すべてのセルが文字列の型で、数値や数式のセルがない', () => {
    for (const row of cellsOf(book, '試験')) for (const cell of row) { expect(cell?.t).toBe('s'); expect(cell?.f).toBeUndefined(); }
  });

  test('シートのXMLに数式（<f>）がなく、すべてのセルが文字列の型（共有文字列）で、文字列の書式を使う', () => {
    const files = filesOf(book);
    const worksheet = Object.entries(files).find(([name]) => name.includes('worksheets/sheet1'));
    if (!worksheet) throw new Error('シートの部品がない');
    const xml = new TextDecoder().decode(worksheet[1]);
    expect(xml).not.toMatch(/<f[ >]/);
    const cells = xml.match(/<c [^>]*>/g) ?? [];
    expect(cells.length).toBe(tricky.length + 1);
    for (const tag of cells) expect(tag).toContain('t="s"');
    const styles = Object.entries(files).find(([name]) => name.endsWith('styles.xml'));
    expect(new TextDecoder().decode(styles?.[1])).toContain('numFmtId="49"');
  });

  test('列幅が書かれる', () => {
    const worksheet = Object.entries(filesOf(book)).find(([name]) => name.includes('worksheets/sheet1'));
    expect(new TextDecoder().decode(worksheet?.[1])).toMatch(/<cols><col [^>]*width="1[2-3]\.[0-9]+"/);
  });

  test('複数のシートを書き、名前と順序が保たれる', () => {
    const two = read(xlsxOf([sheet('説明', ['項目', '内容'], [['a', 'b']]), sheet('保管単位', ['ID'], [['0007']])]));
    expect(two.SheetNames).toEqual(['説明', '保管単位']);
    expect(textsOf(two, '保管単位')).toEqual([['ID'], ['0007']]);
  });

  test('長い値がなければ、長い値のシートを作らない', () => {
    expect(book.SheetNames).toEqual(['試験']);
  });
});

describe('FH-F1A-04・F1-A 4.13: 1セルの上限を超える値は、切り捨てずに長い値のシートへ送る', () => {
  const recombine = (book: XLSX.WorkBook): Map<string, string> => {
    const rows = textsOf(book, longValueSheetName).slice(1);
    const joined = new Map<string, { fragment: number; text: string }[]>();
    for (const [seq, , , , fragment, text] of rows) {
      const list = joined.get(String(seq)) ?? [];
      list.push({ fragment: Number(fragment), text: String(text) });
      joined.set(String(seq), list);
    }
    return new Map([...joined].map(([seq, list]) => [seq, list.sort((a, b) => a.fragment - b.fragment).map(f => f.text).join('')]));
  };

  test.each([3000, 5000])('FH-F1A-04: _x0041_を%i回含む値も、文字の保護で上限を超えず全文が戻る', count => {
    const value = '_x0041_'.repeat(count);
    const book = read(xlsxOf([sheet('s', ['v'], [[value]])]));
    expect(book.SheetNames).toContain(longValueSheetName);
    expect(recombine(book).get('1')).toBe(value);
    for (const name of book.SheetNames) for (const row of textsOf(book, name)) for (const text of row) expect(text.length).toBeLessThanOrEqual(maxCellChars);
  });

  test('32,768桁のIDも全桁が残り、元のセルは先頭の30,000文字と案内になる', () => {
    const id = `0${'1234567890'.repeat(3276)}1234567`;
    expect(id.length).toBe(32_768);
    const book = read(xlsxOf([sheet('保管単位', ['保管単位ID', '品目'], [[id, 'P']])]));
    const [, row] = textsOf(book, '保管単位');
    expect(row?.[1]).toBe('P');
    expect(row?.[0]?.length).toBeLessThanOrEqual(maxCellChars);
    expect(row?.[0]?.startsWith(id.slice(0, 30_000))).toBe(true);
    expect(row?.[0]).toContain(`『${longValueSheetName}』シートの連番1`);
    const whole = recombine(book);
    expect(whole.get('1')).toBe(id);
    const [, first] = textsOf(book, longValueSheetName);
    expect(first?.slice(0, 5)).toEqual(['1', '保管単位', '2', '保管単位ID', '1']);
  });

  test('ちょうど上限の値は、そのままセルに残り、長い値のシートを作らない', () => {
    const exact = 'a'.repeat(maxCellChars);
    const book = read(xlsxOf([sheet('s', ['v'], [[exact]])]));
    expect(textsOf(book, 's')[1]?.[0]).toBe(exact);
    expect(book.SheetNames).toEqual(['s']);
  });

  test('上限を1文字超えると送られる', () => {
    const book = read(xlsxOf([sheet('s', ['v'], [['a'.repeat(maxCellChars + 1)]])]));
    expect(book.SheetNames).toEqual(['s', longValueSheetName]);
    expect(recombine(book).get('1')).toBe('a'.repeat(maxCellChars + 1));
  });

  test('区切りの位置にサロゲートペアがあっても、孤立サロゲートを作らず、全文が戻る', () => {
    const value = `${'あ'.repeat(29_999)}😀${'x'.repeat(5_000)}`;
    const book = read(xlsxOf([sheet('s', ['v'], [[value]])]));
    for (const name of book.SheetNames) for (const row of textsOf(book, name)) for (const text of row) expect(lone.test(text)).toBe(false);
    expect(recombine(book).get('1')).toBe(value);
  });

  test('複数の長い値は、連番・元のシート・元の行・元の列の見出しで見分けられ、断片は30,000文字以下', () => {
    const a = 'A'.repeat(70_000);
    const b = 'B'.repeat(40_000);
    const book = read(xlsxOf([sheet('一', ['x', 'y'], [['ok', a]]), sheet('二', ['z'], [['短い'], [b]])]));
    const rows = textsOf(book, longValueSheetName).slice(1);
    expect(rows.map(r => r.slice(0, 4))).toEqual([['1', '一', '2', 'y'], ['1', '一', '2', 'y'], ['1', '一', '2', 'y'], ['2', '二', '3', 'z'], ['2', '二', '3', 'z']]);
    for (const row of rows) expect(String(row[5]).length).toBeLessThanOrEqual(30_000);
    const whole = recombine(book);
    expect(whole.get('1')).toBe(a);
    expect(whole.get('2')).toBe(b);
  });
});

describe('FH-F1A-04・F1-A 4.1: 入力の検査', () => {
  test('シートが一つもなければ例外', () => {
    expect(() => xlsxOf([])).toThrow();
  });

  test.each([
    ['空', ''], ['32文字', 'a'.repeat(32)], ['[', 'a[b'], [']', 'a]b'], [':', 'a:b'], ['*', 'a*b'], ['?', 'a?b'], ['/', 'a/b'], ['\\', 'a\\b'],
    ['先頭の\'', '\'a'], ['末尾の\'', 'a\''], ['予約名', longValueSheetName],
  ])('不正なシート名（%s）は例外', (_label, name) => {
    expect(() => xlsxOf([sheet(name, ['v'], [])])).toThrow();
  });

  test('31文字のシート名と日本語のシート名は書ける', () => {
    expect(read(xlsxOf([sheet('a'.repeat(31), ['v'], [])])).SheetNames).toEqual(['a'.repeat(31)]);
  });

  test('大文字小文字だけが違うシート名の重複は例外', () => {
    expect(() => xlsxOf([sheet('Abc', ['v'], []), sheet('aBC', ['v'], [])])).toThrow();
  });

  test('行の長さが列の数と違えば例外', () => {
    expect(() => xlsxOf([sheet('s', ['a', 'b'], [['1']])])).toThrow();
    expect(() => xlsxOf([sheet('s', ['a'], [['1', '2']])])).toThrow();
  });

  test('見出しを含めて1,048,576行を超えると例外（入力が大きすぎる）', () => {
    expect(() => xlsxOf([sheet('s', ['v'], Array.from({ length: 1_048_576 }, () => ['a']))])).toThrow('行');
  });
});
