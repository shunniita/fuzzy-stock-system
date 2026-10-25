import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// 実行用Nodeのファイル操作をここへ閉じ、製品のブラウザー型設定と依存を変えない。
export async function browserZoomProfile(directory, factor) {
  const root = resolve(directory);
  await mkdir(root, { recursive: true });
  const profile = await mkdtemp(join(root, 'zoom-profile-'));
  await mkdir(join(profile, 'Default'));
  const level = Math.log(factor) / Math.log(1.2);
  // Chromiumの通常partitionキーは版により0/x。ユーザーの通常profileは使わない。
  await writeFile(join(profile, 'Default', 'Preferences'), JSON.stringify({
    partition: { default_zoom_level: { '0': level, x: level } },
  }));
  return profile;
}

export async function saveBrowserCapture(path, data) {
  await writeFile(path, Buffer.from(data, 'base64'));
}
