import { codeOwner, deepFreeze, type Masters } from './masters.ts';

export type CodeReference =
  | { readonly kind: 'missing'; readonly code: string }
  | { readonly kind: 'found'; readonly code: string; readonly id: string; readonly name: string | null; readonly active: boolean };

type MatchedText = { readonly matching: string; readonly leading: string; readonly trailing: string };
export type Scan =
  | { readonly raw: string; readonly format: 'labelA' | 'labelB'; readonly interpreted: MatchedText & { readonly kind: 'label'; readonly item: CodeReference; readonly project: CodeReference } }
  | { readonly raw: string; readonly format: 'itemId'; readonly interpreted: MatchedText & { readonly kind: 'item'; readonly item: CodeReference } }
  | { readonly raw: string; readonly format: 'document'; readonly interpreted: MatchedText & { readonly kind: 'document'; readonly source: string; readonly revision: string; readonly line: string } }
  | { readonly raw: string; readonly format: 'unreadable'; readonly interpreted: MatchedText & { readonly kind: 'unreadable'; readonly reason: string } };

function resolve(masters: Masters, type: 'item' | 'case', code: string): CodeReference {
  const master = codeOwner(masters, type, code);
  if (master?.type !== type) return { kind: 'missing', code };
  return { kind: 'found', code, id: master.id, name: master.name, active: master.active };
}

const fieldPattern = /^[A-Za-z0-9_-]+$/;

export function readCode(raw: string, masters: Masters): Scan {
  const leading = /^[ \t\r\n]*/.exec(raw)?.[0] ?? '';
  const rest = raw.slice(leading.length);
  const trailing = /[ \t\r\n]*$/.exec(rest)?.[0] ?? '';
  const matching = rest.slice(0, rest.length - trailing.length);
  const text = { matching, leading, trailing };
  const unreadable = (reason: string): Scan => deepFreeze({ raw, format: 'unreadable', interpreted: { ...text, kind: 'unreadable', reason } });
  if (matching === '') return unreadable('入力が空欄');
  if (matching.startsWith('LABA|') || matching.includes('~')) {
    const isA = matching.startsWith('LABA|');
    const parts = matching.split(isA ? '|' : '~');
    const project = parts[1]; const item = parts[isA ? 2 : 0];
    if (parts.length !== 3 || (!isA && parts[2] !== 'LABB')) return unreadable('ラベルの形式または区切りが不正');
    if (!item || !project) return unreadable('ラベルの品目または案件・用途が空欄');
    if (!fieldPattern.test(item) || !fieldPattern.test(project)) return unreadable('ラベルの使用可能文字は半角英数字・_・-');
    return deepFreeze({ raw, format: isA ? 'labelA' : 'labelB', interpreted: { ...text, kind: 'label', item: resolve(masters, 'item', item), project: resolve(masters, 'case', project) } });
  }
  if (matching.startsWith('DOC:')) {
    const parts = matching.split(':');
    const source = parts[1]; const revision = parts[2]; const line = parts[3];
    if (parts.length !== 4) return unreadable('帳票の区切りが不正');
    if (!source || !revision || !line) return unreadable('帳票の元の資料・改訂・明細に空欄がある');
    if (![source, revision, line].every(value => fieldPattern.test(value))) return unreadable('帳票の使用可能文字は半角英数字・_・-');
    return deepFreeze({ raw, format: 'document', interpreted: { ...text, kind: 'document', source, revision, line } });
  }
  if (fieldPattern.test(matching)) return deepFreeze({ raw, format: 'itemId', interpreted: { ...text, kind: 'item', item: resolve(masters, 'item', matching) } });
  return unreadable('形式・区切り・使用可能文字（半角英数字・_・-）を確認する');
}
