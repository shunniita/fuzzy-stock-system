// shortcut: manual/*.md で使う書式（見出し・段落・1段の入れ子の箇条書き・表・コード・太字・リンク・<a id>行）だけを扱う。
// 引用・コードブロック・画像などを使うときは、この変換を広げるか Markdown のライブラリへ移す。

const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// GitHub の見出しアンカーと同じ形にし、文書内の `#見出し` リンクを PDF でも飛べるようにする。
export const slug = text => text.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');

// PDF の相対リンクは about:blank から印刷するため隣のファイルへ解決されない。別文書へは飛べないので、ファイル名を文字で示す。
const link = (label, target) => {
  const other = /^([^#:]+)\.md(?:#|$)/.exec(target);
  if (other) return `${label}（${other[1]}.pdf）`;
  return `<a href="${target}">${label}</a>`;
};

export function inline(text) {
  const parts = text.split(/(`[^`]*`)/);
  return parts.map(part => {
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) return `<code>${escape(part.slice(1, -1))}</code>`;
    return escape(part)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, target) => link(label, target));
  }).join('');
}

const cells = line => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());

export function toHtml(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let index = 0;
  const isBlockStart = line => /^(#{1,6} |\||<a id=|- |\d+\. )/.test(line) || line.trim() === '';
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === '') { index++; continue; }
    const heading = /^(#{1,6}) (.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level} id="${escape(slug(heading[2]))}">${inline(heading[2])}</h${level}>`);
      index++;
      continue;
    }
    const anchor = /^<a id="([^"]+)"><\/a>$/.exec(line.trim());
    if (anchor) { out.push(`<a id="${escape(anchor[1])}"></a>`); index++; continue; }
    if (line.startsWith('|')) {
      const header = cells(line);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].startsWith('|')) rows.push(cells(lines[index++]));
      out.push(`<table><thead><tr>${header.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    const item = /^(- |\d+\. )/.exec(line);
    if (item) {
      const tag = item[1] === '- ' ? 'ul' : 'ol';
      const items = [];
      while (index < lines.length && /^(- |\d+\. )/.test(lines[index]) && (lines[index].startsWith('- ') === (tag === 'ul'))) {
        let html = inline(lines[index].replace(/^(- |\d+\. )/, ''));
        index++;
        const children = [];
        while (index < lines.length && /^ {2,}- /.test(lines[index])) children.push(`<li>${inline(lines[index++].replace(/^ +- /, ''))}</li>`);
        if (children.length) html += `<ul>${children.join('')}</ul>`;
        items.push(`<li>${html}</li>`);
      }
      out.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }
    const paragraph = [];
    while (index < lines.length && !isBlockStart(lines[index])) paragraph.push(lines[index++]);
    if (paragraph.length === 0) paragraph.push(lines[index++]);
    out.push(`<p>${inline(paragraph.join('\n'))}</p>`);
  }
  return out.join('\n');
}
