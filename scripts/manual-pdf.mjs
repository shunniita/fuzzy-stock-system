import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { toHtml } from './manual-markdown.mjs';
import { manualNames } from './package-release.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'web/dist/manual');
const style = `
  body { font-family: "Yu Gothic UI", "Meiryo", sans-serif; font-size: 10.5pt; line-height: 1.7; color: #111; }
  h1 { font-size: 18pt; border-bottom: 2px solid #333; padding-bottom: 4px; }
  h2 { font-size: 14pt; border-bottom: 1px solid #999; margin-top: 1.6em; break-after: avoid; }
  h3, h4 { font-size: 12pt; break-after: avoid; }
  table { border-collapse: collapse; width: 100%; margin: 0.6em 0; font-size: 9.5pt; }
  th, td { border: 1px solid #888; padding: 3px 6px; vertical-align: top; text-align: left; }
  th { background: #eee; }
  tr { break-inside: avoid; }
  code { font-family: Consolas, "MS Gothic", monospace; background: #f2f2f2; padding: 0 2px; }
  a { color: #0645ad; }
`;

mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge' });
try {
  const page = await browser.newPage();
  for (const name of manualNames) {
    const markdown = readFileSync(join(root, 'manual', `${name}.md`), 'utf8');
    const title = markdown.match(/^# (.*)$/m)?.[1] ?? name;
    await page.setContent(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title><style>${style}</style></head><body>${toHtml(markdown)}</body></html>`);
    const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '18mm', bottom: '18mm', left: '16mm', right: '16mm' } });
    // 同じ版から作り直しても同じバイト列にするため、作成日時の14桁を固定する。長さを変えるとPDFの相互参照表がずれる。
    const fixed = Buffer.from(pdf.toString('latin1').replace(/\/(CreationDate|ModDate) \(D:\d{14}/g, '/$1 (D:20000101000000'), 'latin1');
    writeFileSync(join(output, `${name}.pdf`), fixed);
  }
} finally {
  await browser.close();
}
