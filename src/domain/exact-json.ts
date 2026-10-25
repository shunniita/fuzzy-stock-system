import { parseSignedScalar } from './scalar.ts';

export function parseExactJson(raw: string): unknown {
  return JSON.parse(raw, (_key: string, value: unknown, context?: unknown): unknown => {
    if (typeof value !== 'number') return value;
    if (typeof context !== 'object' || context === null || !('source' in context) || typeof context.source !== 'string') {
      throw new Error('このブラウザーは数値の原文を検査できない。対応するブラウザーで開く');
    }
    const exact = parseSignedScalar(context.source, Number.isInteger(value) ? 1 : 0.1);
    if (exact !== value) throw new Error('JSONの数値は丸めずに保持できる値にする');
    return value;
  });
}
