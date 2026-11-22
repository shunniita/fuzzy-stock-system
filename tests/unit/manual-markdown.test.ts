import { describe, expect, test } from 'vitest';
import { slug, toHtml } from '../../scripts/manual-markdown.mjs';
import m0 from '../../manual/README.md?raw';
import m1 from '../../manual/01-getting-started.md?raw';
import m2 from '../../manual/02-guide.md?raw';
import m3 from '../../manual/03-reference.md?raw';
import m4 from '../../manual/04-troubleshooting.md?raw';
import m5 from '../../manual/05-checklist.md?raw';
import m6 from '../../manual/06-sets.md?raw';

describe('マニュアルのPDF用の変換', () => {
  test('見出し・段落・入れ子の箇条書き・表・コード・太字・リンクを変換する', () => {
    const html = toHtml([
      '# 1. はじめに', '', '[目次](README.md) · 次へ：[ガイド](02-guide.md#セットを使う)', '',
      '本文の1行目', '本文の**2行目**と`<code>`', '',
      '1. 手順A', '   - 補足a', '2. 手順B', '', '- 点', '',
      '| 列1 | 列2 |', '|---|---|', '| `x` | [外](https://example.com/#a) |', '',
      '<a id="receipt"></a>', '', '#### 小見出し・その2',
    ].join('\n'));
    expect(html).toContain('<h1 id="1-はじめに">1. はじめに</h1>');
    expect(html).toContain('目次（README.pdf） · 次へ：ガイド（02-guide.pdf）');
    expect(html).not.toContain('href="README');
    expect(html).toContain('<p>本文の1行目\n本文の<strong>2行目</strong>と<code>&lt;code&gt;</code></p>');
    expect(html).toContain('<ol><li>手順A<ul><li>補足a</li></ul></li><li>手順B</li></ol>');
    expect(html).toContain('<ul><li>点</li></ul>');
    expect(html).toContain('<thead><tr><th>列1</th><th>列2</th></tr></thead><tbody><tr><td><code>x</code></td><td><a href="https://example.com/#a">外</a></td></tr></tbody>');
    expect(html).toContain('<a id="receipt"></a>');
    expect(html).toContain('<h4 id="小見出しその2">');
  });

  test('GitHubと同じ見出しアンカーにする', () => {
    expect(slug('必要明細を生成する')).toBe('必要明細を生成する');
    expect(slug('6. 親子のセットを登録する')).toBe('6-親子のセットを登録する');
  });

  test('マニュアルの文書内リンクは、すべてその文書の見出しかidを指す', () => {
    for (const [name, markdown] of Object.entries({ README: m0, '01-getting-started': m1, '02-guide': m2, '03-reference': m3, '04-troubleshooting': m4, '05-checklist': m5, '06-sets': m6 })) {
      const html = toHtml(markdown);
      const ids = new Set([...html.matchAll(/ id="([^"]+)"/g)].map(m => m[1]));
      for (const [, target] of html.matchAll(/href="#([^"]+)"/g)) expect(ids, `${name}.md の #${target}`).toContain(target);
      expect(html, `${name}.md に変換されない書式が残る`).not.toMatch(/\]\(|^\|/m);
    }
  });
});
