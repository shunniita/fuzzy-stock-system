import { h } from './dom.ts';
import type { ArchiveRow } from './shared-archive.ts';

export function sharedRecoveryPanel(rows: ArchiveRow[], generation: string, handlers: {
  select(row: ArchiveRow): void; export(row: ArchiveRow): void; withdraw(row: ArchiveRow, copied: boolean): void;
}): HTMLElement {
  const open = rows.filter(row => row.kind === 'broken' || row.entry.kind === 'open');
  const root = h('section', { id: 'shared-recovery', 'aria-label': '回収した元入力' }, h('h2', {}, `回収した元入力（${open.length}件）`));
  if (open.length === 0) root.append(h('p', {}, '未解消の元入力はありません。'));
  for (const row of open) {
    const item = h('details', { 'data-archive-key': row.key });
    const title = row.kind === 'broken' ? `読めない退避：${row.reason}` : `${row.draft?.opLabel ?? ''}・${row.draft?.actor ?? ''}・${row.draft?.detectedAt ?? ''}`;
    const copy = h('button', { type: 'button' }, '原文を控える');
    copy.addEventListener('click', () => handlers.export(row));
    item.append(h('summary', {}, title), copy);
    if (row.kind === 'broken') item.append(h('pre', {}, row.encoded));
    else if (row.entry.kind === 'open') {
      const duplicates = rows.filter(other => other.kind === 'valid' && other.entry.reviewId === row.entry.reviewId && other.entry.hash !== row.entry.hash).length;
      item.append(h('p', {}, `元の台帳世代：${row.entry.generation}${row.entry.generation === generation ? '' : '（現在と異なる世代。参照用）'}`));
      if (duplicates > 0) item.append(h('p', { class: 'error' }, '同じ識別子で内容が異なる元入力があります。別件として保持しています。'));
      item.append(h('pre', {}, row.entry.raw));
      const select = h('button', { type: 'button' }, 'この元入力を照合する');
      select.addEventListener('click', () => handlers.select(row));
      const ack = h('input', { type: 'checkbox' });
      const withdraw = h('button', { type: 'button', disabled: '' }, '本文を残さず取り下げる');
      ack.addEventListener('change', () => { withdraw.disabled = !ack.checked; });
      withdraw.addEventListener('click', () => handlers.withdraw(row, ack.checked));
      item.append(select, h('label', { class: 'check' }, ack, '原文を控えた。照合済みとせず、再表示を防ぐ取下げ記録だけを残す'), withdraw);
    }
    root.append(item);
  }
  root.append(h('p', {}, `解消・取下げ済み：${rows.length - open.length}件。記録は自動削除しません。`));
  return root;
}
