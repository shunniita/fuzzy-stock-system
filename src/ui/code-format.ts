import type { CodeReference, Scan } from '../domain/code.ts';

export const codeFormat: Record<Scan['format'], string> = {
  labelA: 'ラベルA', labelB: 'ラベルB', document: '帳票', itemId: '品目ID手入力', unreadable: '読取不能',
};

export function codeReferenceText(ref: CodeReference): string {
  if (ref.kind === 'missing') return `${ref.code}（未登録）`;
  return `${ref.name ?? ref.code}（${ref.code}）${ref.active ? '' : '・利用停止中'}`;
}

export function interpretationText(scan: Scan): string {
  const value = scan.interpreted;
  switch (value.kind) {
    case 'label': return `品目${codeReferenceText(value.item)}・案件・用途${codeReferenceText(value.project)}`;
    case 'item': return `品目${codeReferenceText(value.item)}`;
    case 'document': return `元の資料${value.source}・改訂${value.revision}・明細${value.line}。帳票は受け取りの記録にならない。必要明細の参照・登録は後続の範囲`;
    case 'unreadable': return `${value.reason}。品名・品番・コードの検索か手入力で対象を選ぶ`;
    default: { const exhaustive: never = value; return exhaustive; }
  }
}

export function scanText(scan: Scan | undefined): string {
  return scan === undefined ? '' : `；読取原文${JSON.stringify(scan.raw)}・${codeFormat[scan.format]}・当時の解釈：${interpretationText(scan)}（照合で除いた先頭${JSON.stringify(scan.interpreted.leading)}・末尾${JSON.stringify(scan.interpreted.trailing)}）`;
}

export function scanCells(scan: Scan | undefined): string[] {
  return scan === undefined ? ['なし', 'なし', 'なし'] : [scan.raw, codeFormat[scan.format], JSON.stringify(scan.interpreted)];
}
