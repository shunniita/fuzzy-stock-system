import { copyFileSync, mkdirSync } from 'node:fs';

// 出力時に遅延取得するSheetJSは無改変で配信する。LICENSEは再配布の表示の義務のため一緒に写す。
const out = new URL('../web/dist/vendor/', import.meta.url);
mkdirSync(out, { recursive: true });
for (const file of ['xlsx.mjs', 'LICENSE']) {
  copyFileSync(new URL(`../node_modules/xlsx/${file}`, import.meta.url), new URL(file === 'LICENSE' ? 'xlsx-LICENSE.txt' : file, out));
}
