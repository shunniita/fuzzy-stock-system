import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const options = { cwd: root, windowsHide: true, stdio: 'inherit' };
execFileSync(process.execPath, [fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)), '-p', 'tsconfig.build.json'], options);
for (const script of ['vendor.mjs', 'bundle.mjs']) {
  execFileSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url))], options);
}
