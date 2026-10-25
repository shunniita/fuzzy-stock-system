import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { readCode } from '../../src/domain/code.ts';
import { practiceLedger } from '../../src/domain/ledger.ts';
import { fixedMasters } from '../../src/domain/masters.ts';
import { emptySupply, receiveLot } from '../../src/domain/supply.ts';
import { eventText } from '../../src/ui/format.ts';
import { supplyEventText } from '../../src/ui/supply-format.ts';
import { viewSheetsOf } from '../../src/ui/viewsheets.ts';
import { xlsxOf } from '../../src/ui/xlsx.ts';

const at = '2026-10-13T09:00:00+09:00';
const recorded = (raw: string) => receiveLot(practiceLedger, emptySupply, { eventId: 'scan', actor: '架空担当A', occurredAt: at, recordedAt: at, scan: readCode(raw, fixedMasters) }, { id: 'box', item: 'Q', unit: '個', project: { kind: 'case', id: 'A-002' }, location: 'S1' }, 'counted', 5);

describe('FH-C03 読取証拠と最終対象の表示', () => {
  it('台帳と供給の履歴に原文・形式・当時の解釈を残し、最終対象と混同しない', () => {
    const raw = ' LABA|A-001|P\t\r\n'; const s = recorded(raw);
    const ledgerEvent = s.ledger.history[0]; const supplyEvent = s.supply.log[0];
    if (!ledgerEvent || !supplyEvent) throw Error('fixture');
    for (const text of [eventText(s.ledger, ledgerEvent), supplyEventText(s.ledger.masters, supplyEvent)]) {
      expect(text).toContain(JSON.stringify(raw));
      expect(text).toContain('ラベルA');
      expect(text).toContain('架空部品P');
    }
    expect(eventText(s.ledger, ledgerEvent)).toContain('Q');
  });
  it.each([' LABA|A-001|P\t\r\n', '=1+2', '<script>bad()</script>'])('Excel原文を文字列セルとして出す %j', raw => {
    const sheets = viewSheetsOf(recorded(raw), at);
    const workbook = XLSX.read(xlsxOf(sheets), { type: 'array', bookFiles: true });
    // SheetJSのreader自身がCRLFをLFへ正規化する。原文のCRはxlsx内の文字指定を直接検査する。
    if (raw.includes('\r')) {
      const files: unknown = Reflect.get(workbook, 'files');
      if (typeof files !== 'object' || files === null) throw Error('xlsxの内部ファイルがない');
      const entry: unknown = Reflect.get(files, 'xl/sharedStrings.xml');
      if (typeof entry !== 'object' || entry === null) throw Error('共有文字列がない');
      const content: unknown = Reflect.get(entry, 'content');
      if (!(content instanceof Uint8Array)) throw Error('共有文字列を読めない');
      expect(new TextDecoder().decode(content)).toContain('<t xml:space="preserve"> LABA|A-001|P\t_x000D_\n</t>');
    }
    for (const name of ['台帳の履歴', '供給の履歴']) {
      const sheet = sheets.find(s => s.name === name);
      const index = sheet?.columns.findIndex(c => c.header === '読取原文') ?? -1;
      expect(index).toBeGreaterThanOrEqual(0);
      const cell: unknown = workbook.Sheets[name]?.[XLSX.utils.encode_cell({ r: 1, c: index })];
      expect(cell).toMatchObject({ t: 's', v: raw.replace(/\r\n/g, '\n') });
      expect(cell).not.toHaveProperty('f');
    }
  });
  it('長い原文のCRと文字指定風の文字列を、長い値シートから欠落なく回収する', () => {
    const raw = '_x000D_\rZ'.repeat(5000);
    const state = recorded(raw);
    const book = XLSX.read(xlsxOf(viewSheetsOf(state, at)), { type: 'array' });
    const long = book.Sheets['長い値'];
    if (!long) throw Error('長文の断片がない');
    const rows = XLSX.utils.sheet_to_json<string[]>(long, { header: 1, raw: true });
    for (const name of ['台帳の履歴', '供給の履歴']) {
      const fragments = rows.filter(r => r[1] === name && r[3] === '読取原文');
      expect(fragments.length).toBeGreaterThan(1);
      expect(fragments.map(r => r[5]).join('')).toBe(raw);
    }
    const event = state.ledger.history[0];
    if (!event) throw Error('履歴なし');
    expect(eventText(state.ledger, event)).toContain(JSON.stringify(raw));
  });
});
