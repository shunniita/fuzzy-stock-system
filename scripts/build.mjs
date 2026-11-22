import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const options = { cwd: root, windowsHide: true, stdio: 'inherit' };
execFileSync(process.execPath, [fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)), '-p', 'tsconfig.build.json'], options);
// --release は配布用：開発用の画面要素を外し、マニュアルのPDFも作る。
const release = process.argv.includes('--release');
for (const script of ['vendor.mjs', 'bundle.mjs', ...release ? ['manual-pdf.mjs'] : []]) {
  execFileSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), ...release ? ['--release'] : []], options);
}
