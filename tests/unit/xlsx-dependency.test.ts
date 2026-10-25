import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';

describe('FH-F1A-07・SheetJSの依存（ADR-023）', () => {
  it('公式CDNで固定した0.20.3を使い、脆弱性が修正された版より古い版を入れていない', () => {
    expect(XLSX.version).toBe('0.20.3');
  });

  it('書き出しと読み戻しが動く', () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['a', '0012']]), 's');
    const read = XLSX.read(XLSX.write(book, { type: 'array', bookType: 'xlsx' }), { type: 'array' });
    expect(read.SheetNames).toEqual(['s']);
  });
});
