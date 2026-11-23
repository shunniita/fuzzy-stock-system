// shortcut: manual/*.md で使う書式（見出し・段落・1段の入れ子の箇条書き・表・コード・太字・リンク・<a id>行）だけを扱う。
// 引用・コードブロック・画像などを使うときは、この変換を広げるか Markdown のライブラリへ移す。

const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// GitHub の見出しアンカーと同じ形にし、Markdown の `#見出し` リンクをそのまま冊子の中でも使えるようにする。
export const slug = text => text.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');

// 章をまたぐと同じ見出しが重なるので章と組にする。PDFの名前付きの行き先は127バイトまでなので、日本語の見出しをそのまま使わず短いハッシュにする。
export const anchorOf = (chapter, id) => {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(`${chapter}#${id}`)) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return `s${hash.toString(16).padStart(8, '0')}`;
};

// 章同士の `02-guide.md#節` を冊子の中の位置へ置き換える。外部のURLはそのまま。
function link(label, target, chapter) {
  if (/^[a-z]+:/i.test(target)) return `<a href="${escape(target)}">${label}</a>`;
  const parts = /^(?:([^#]+)\.md)?(?:#(.+))?$/.exec(target);
  if (!parts || (!parts[1] && !parts[2])) throw new Error(`${chapter}.md：冊子の中へ置き換えられないリンク ${target}`);
  const to = parts[1] ?? chapter;
  return `<a href="#${escape(parts[2] ? anchorOf(to, parts[2]) : to)}">${label}</a>`;
}

export function inline(text, chapter) {
  const parts = text.split(/(`[^`]*`)/);
  return parts.map(part => {
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) return `<code>${escape(part.slice(1, -1))}</code>`;
    return escape(part)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, target) => link(label, target, chapter));
  }).join('');
}

const cells = line => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
// 各章の3行目の「目次 · 前へ · 次へ」は別ファイルを渡り歩くための行で、冊子では目次としおりが代わる。
const isChapterNav = line => /^\[目次\]\(README\.md\)/.test(line);

export function toHtml(markdown, chapter) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let index = 0;
  const isBlockStart = line => /^(#{1,6} |\||<a id=|- |\d+\. )/.test(line) || line.trim() === '';
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === '' || isChapterNav(line)) { index++; continue; }
    const heading = /^(#{1,6}) (.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level} id="${escape(anchorOf(chapter, slug(heading[2])))}">${inline(heading[2], chapter)}</h${level}>`);
      index++;
      continue;
    }
    const anchor = /^<a id="([^"]+)"><\/a>$/.exec(line.trim());
    if (anchor) { out.push(`<a id="${escape(anchorOf(chapter, anchor[1]))}"></a>`); index++; continue; }
    if (line.startsWith('|')) {
      const header = cells(line);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].startsWith('|')) rows.push(cells(lines[index++]));
      out.push(`<table><thead><tr>${header.map(c => `<th>${inline(c, chapter)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${inline(c, chapter)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    const item = /^(- |\d+\. )/.exec(line);
    if (item) {
      const tag = item[1] === '- ' ? 'ul' : 'ol';
      const items = [];
      while (index < lines.length && /^(- |\d+\. )/.test(lines[index]) && (lines[index].startsWith('- ') === (tag === 'ul'))) {
        let html = inline(lines[index].replace(/^(- |\d+\. )/, ''), chapter);
        index++;
        const children = [];
        while (index < lines.length && /^ {2,}- /.test(lines[index])) children.push(`<li>${inline(lines[index++].replace(/^ +- /, ''), chapter)}</li>`);
        if (children.length) html += `<ul>${children.join('')}</ul>`;
        items.push(`<li>${html}</li>`);
      }
      out.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }
    const paragraph = [];
    while (index < lines.length && !isBlockStart(lines[index])) paragraph.push(lines[index++]);
    if (paragraph.length === 0) paragraph.push(lines[index++]);
    out.push(`<p>${inline(paragraph.join('\n'), chapter)}</p>`);
  }
  return out.join('\n');
}

const headingsOf = (markdown, level) => markdown.replace(/\r\n/g, '\n').split('\n').flatMap(line => {
  const heading = /^(#{1,6}) (.*)$/.exec(line);
  return heading && heading[1].length === level ? [heading[2]] : [];
});
const plain = text => escape(text.replace(/\*\*|`/g, ''));

// 先頭の章（README）の見出し1を表紙の題にし、その本文は目次の後の「このガイドについて」として置く。
export function bookHtml(chapters, version) {
  const [front, ...rest] = chapters;
  const title = headingsOf(front.markdown, 1)[0] ?? 'ユーザーガイド';
  const frontId = anchorOf(front.name, slug(title));
  const tocEntry = (chapter, text) => `<a href="#${escape(anchorOf(chapter, slug(text)))}">${plain(text)}</a>`;
  const toc = [
    `<li><a href="#${escape(frontId)}">このガイドについて</a></li>`,
    ...rest.map(({ name, markdown }) => {
      const sections = headingsOf(markdown, 2).map(text => `<li>${tocEntry(name, text)}</li>`).join('');
      return `<li>${tocEntry(name, headingsOf(markdown, 1)[0] ?? name)}${sections ? `<ol>${sections}</ol>` : ''}</li>`;
    }),
  ].join('');
  const frontBody = toHtml(front.markdown, front.name).replace(/<h1 [^>]*>.*?<\/h1>/, `<h1 id="${escape(frontId)}">このガイドについて</h1>`);
  return [
    `<section class="cover"><p class="title">${plain(title)}</p><p class="version">v${escape(version)}</p></section>`,
    `<nav class="toc" aria-label="目次"><h1>目次</h1><ol>${toc}</ol></nav>`,
    `<section class="chapter" id="${escape(front.name)}">${frontBody}</section>`,
    ...rest.map(({ name, markdown }) => `<section class="chapter" id="${escape(name)}">${toHtml(markdown, name)}</section>`),
  ].join('\n');
}
