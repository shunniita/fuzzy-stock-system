import { defineConfig } from '@playwright/test';

// 起動は利用者と同じ_local-server.ps1を使う。ブラウザーはダウンロードせず、Windowsに入っているEdgeを使う。
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: true,
  use: { baseURL: 'http://127.0.0.1:4182/', channel: 'msedge', timezoneId: 'Asia/Tokyo', locale: 'ja-JP' },
  webServer: {
    command: 'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File web/_local-server.ps1 -NoBrowser -Port 4182',
    url: 'http://127.0.0.1:4182/',
    reuseExistingServer: false,
  },
});
