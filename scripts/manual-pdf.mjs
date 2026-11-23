import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { bookHtml } from './manual-markdown.mjs';
import { guidePdf, manualNames } from './package-release.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'web/dist/manual');
const style = `
  @page { size: A4; }
  body { font-family: "Yu Gothic UI", "Meiryo", sans-serif; font-size: 10.5pt; line-height: 1.75; color: #111; margin: 0; }
  .cover { height: 230mm; display: flex; flex-direction: column; justify-content: center; break-after: page; }
  .cover .title { font-size: 26pt; font-weight: 700; margin: 0; border-bottom: 3px solid #1f3a68; padding-bottom: 8px; }
  .cover .version { font-size: 14pt; color: #444; margin: 12px 0 0; }
  .toc { break-after: page; }
  .toc ol { list-style: none; padding-left: 0; margin: 0; }
  .toc > ol > li { margin-top: 10px; font-weight: 700; }
  .toc ol ol { padding-left: 1.5em; font-weight: 400; }
  .toc ol ol li { margin-top: 2px; }
  .toc a { color: #111; text-decoration: none; }
  .chapter { break-before: page; }
  h1 { font-size: 18pt; color: #1f3a68; border-bottom: 2px solid #1f3a68; padding-bottom: 4px; margin: 0 0 0.8em; }
  h2 { font-size: 14pt; border-bottom: 1px solid #999; margin-top: 1.6em; break-after: avoid; }
  h3, h4 { font-size: 12pt; margin-top: 1.3em; break-after: avoid; }
  p, li { orphans: 2; widows: 2; }
  table { border-collapse: collapse; width: 100%; margin: 0.6em 0; font-size: 9.5pt; }
  thead { display: table-header-group; }
  th, td { border: 1px solid #888; padding: 3px 6px; vertical-align: top; text-align: left; }
  th { background: #eee; }
  tr { break-inside: avoid; }
  code { font-family: Consolas, "MS Gothic", monospace; background: #f2f2f2; padding: 0 2px; }
  a { color: #0645ad; }
`;
const footer = `<div style="width:100%;font-size:8pt;color:#555;text-align:center;font-family:'Yu Gothic UI',sans-serif"><span class="pageNumber"></span> / <span class="totalPages"></span></div>`;

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const chapters = manualNames.map(name => ({ name, markdown: readFileSync(join(root, 'manual', `${name}.md`), 'utf8') }));
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge' });
try {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>fuzzy-stock-system ユーザーガイド v${version}</title><style>${style}</style></head><body>${bookHtml(chapters, version)}</body></html>`);
  const pdf = await page.pdf({
    format: 'A4', printBackground: true, outline: true, tagged: true,
    displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: footer,
    margin: { top: '18mm', bottom: '20mm', left: '18mm', right: '18mm' },
  });
  // 同じ版から作り直しても同じバイト列にするため、作成日時の14桁を固定する。長さを変えるとPDFの相互参照表がずれる。
  const fixed = Buffer.from(pdf.toString('latin1').replace(/\/(CreationDate|ModDate) \(D:\d{14}/g, '/$1 (D:20000101000000'), 'latin1');
  writeFileSync(join(output, guidePdf), fixed);
} finally {
  await browser.close();
}
