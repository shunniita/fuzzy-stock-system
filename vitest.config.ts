import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 実時間の性能回帰を、他ファイルのCPU競合で失敗させない。
  test: { include: ['tests/unit/**/*.test.ts'], maxWorkers: 1 },
});
