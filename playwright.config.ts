import { defineConfig } from '@playwright/test';

// 起動は利用者と同じ_local-server.ps1を使う。ブラウザーはダウンロードせず、Windowsに入っているEdgeを使う。
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: true,
  // 既存の試験は高度な操作モードの画面を前提にする。簡単操作モードの試験はstorageStateを空にして初回の状態から始める。
  use: { baseURL: 'http://127.0.0.1:4182/', channel: 'msedge', timezoneId: 'Asia/Tokyo', locale: 'ja-JP', storageState: { cookies: [], origins: [{ origin: 'http://127.0.0.1:4182', localStorage: [{ name: 'fuzzy-stock-mode', value: 'advanced' }] }] } },
  webServer: {
    command: 'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File web/_local-server.ps1 -NoBrowser -Port 4182',
    url: 'http://127.0.0.1:4182/',
    reuseExistingServer: false,
  },
});
