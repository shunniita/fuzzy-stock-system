import { describe, expect, test } from 'vitest';
import { anchorOf, bookHtml, slug, toHtml } from '../../scripts/manual-markdown.mjs';
import m0 from '../../manual/README.md?raw';
import m1 from '../../manual/01-getting-started.md?raw';
import m2 from '../../manual/02-guide.md?raw';
import m3 from '../../manual/03-reference.md?raw';
import m4 from '../../manual/04-troubleshooting.md?raw';
import m5 from '../../manual/05-sets.md?raw';

const chapters = Object.entries({ README: m0, '01-getting-started': m1, '02-guide': m2, '03-reference': m3, '04-troubleshooting': m4, '05-sets': m5 }).map(([name, markdown]) => ({ name, markdown }));

describe('マニュアルの冊子用の変換', () => {
  test('見出し・段落・入れ子の箇条書き・表・コード・太字を変換し、章の間のリンクを冊子の中の位置へ置き換える', () => {
    const html = toHtml([
      '# 1. はじめに', '', '[目次](README.md) · 次へ：[ガイド](02-guide.md#セットを使う)', '',
      '本文の1行目', '本文の**2行目**と`<code>`', '',
      '1. 手順A', '   - 補足a', '2. 手順B', '', '- 点', '',
      '| 列1 | 列2 |', '|---|---|', '| `x` | [外](https://example.com/#a) |', '',
      '<a id="receipt"></a>', '', '#### 小見出し・その2', '', '[ガイドへ](02-guide.md)・[同じ章](#receipt)',
    ].join('\n'), '01-getting-started');
    expect(html).toContain(`<h1 id="${anchorOf('01-getting-started', '1-はじめに')}">1. はじめに</h1>`);
    expect(html, '章を渡り歩く行は冊子では出さない').not.toContain('目次');
    expect(html).toContain('<p>本文の1行目\n本文の<strong>2行目</strong>と<code>&lt;code&gt;</code></p>');
    expect(html).toContain('<ol><li>手順A<ul><li>補足a</li></ul></li><li>手順B</li></ol>');
    expect(html).toContain('<ul><li>点</li></ul>');
    expect(html).toContain('<thead><tr><th>列1</th><th>列2</th></tr></thead><tbody><tr><td><code>x</code></td><td><a href="https://example.com/#a">外</a></td></tr></tbody>');
    expect(html).toContain(`<a id="${anchorOf('01-getting-started', 'receipt')}"></a>`);
    expect(html).toContain(`<h4 id="${anchorOf('01-getting-started', '小見出しその2')}">`);
    expect(html).toContain(`<a href="#02-guide">ガイドへ</a>・<a href="#${anchorOf('01-getting-started', 'receipt')}">同じ章</a>`);
  });

  test('GitHubと同じ見出しアンカーにし、PDFの行き先の名前は短い英数字にする', () => {
    expect(slug('必要明細を生成する')).toBe('必要明細を生成する');
    expect(slug('5. 親子のセットを登録する')).toBe('5-親子のセットを登録する');
    expect(anchorOf('02-guide', '閲覧用excel出力のシート構成')).toMatch(/^s[0-9a-f]{8}$/);
    expect(anchorOf('02-guide', 'receipt')).not.toBe(anchorOf('03-reference', 'receipt'));
  });

  test('冊子は表紙・目次・全章を並べ、すべてのリンクが冊子の中の見出しかidへ飛び、idは重ならない', () => {
    const html = bookHtml(chapters, '9.9.9');
    expect(html).toContain('<p class="version">v9.9.9</p>');
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map(m => m[1]);
    expect(new Set(ids).size, 'idが重なる').toBe(ids.length);
    for (const [, target] of html.matchAll(/href="#([^"]+)"/g)) expect(ids, `#${target}`).toContain(target);
    const toc = /<nav class="toc"[\s\S]*?<\/nav>/.exec(html)![0];
    for (const heading of ['1. はじめに', '5. 親子のセットを登録する', 'バックアップを取り復元する']) expect(toc).toContain(`>${heading}</a>`);
    expect(html, '変換されない書式が残る').not.toMatch(/\]\(|^\|/m);
  });
});
