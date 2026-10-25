import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// 再試行でURLを変える各入口に静的依存を閉じ込め、失敗した依存のURLを残さない。
await build({
  absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
  entryPoints: ['src/ui/main.ts', 'src/ui/viewsheets.ts', 'src/ui/xlsx.ts'],
  outdir: 'web/dist/ui',
  bundle: true,
  splitting: false,
  format: 'esm',
  platform: 'browser',
  target: 'es2023',
  charset: 'utf8',
  external: ['xlsx'],
  logLevel: 'info',
});
