import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const releaseFiles = [
  { source: 'LICENSE', path: 'LICENSE', eol: 'crlf' },
  { source: 'start-local.cmd', path: 'start-local.cmd', eol: 'crlf' },
  { source: 'manual/RELEASE_README.md', path: 'README.md', eol: 'lf' },
  ...['README', '01-getting-started', '02-guide', '03-reference', '04-troubleshooting', '05-checklist', '06-sets'].map(name => ({ source: `manual/${name}.md`, path: `manual/${name}.md`, eol: 'lf' })),
  { source: 'web/help.html', path: 'web/help.html', eol: 'lf' },
  { source: 'web/index.html', path: 'web/index.html', eol: 'lf' },
  { source: 'web/style.css', path: 'web/style.css', eol: 'lf' },
  { source: 'web/_local-server.ps1', path: 'web/_local-server.ps1', eol: 'crlf' },
  { source: 'web/dist/ui/main.js', path: 'web/dist/ui/main.js' },
  { source: 'web/dist/ui/viewsheets.js', path: 'web/dist/ui/viewsheets.js' },
  { source: 'web/dist/ui/xlsx.js', path: 'web/dist/ui/xlsx.js' },
  { source: 'web/dist/vendor/xlsx.mjs', path: 'web/dist/vendor/xlsx.mjs' },
  { source: 'web/dist/vendor/xlsx-LICENSE.txt', path: 'web/dist/vendor/xlsx-LICENSE.txt' },
];

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function createRelease(root, revision, outputRoot = root) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('完全なGitリビジョンが必要です');
  const name = `fuzzy-stock-${revision.slice(0, 12)}`;
  const output = resolve(outputRoot, 'dist/release');
  const directory = join(output, name);
  const archiveName = `${name}.zip`;
  const paths = { directory, archive: join(directory, archiveName), manifest: join(directory, 'release-manifest.json'), checksum: join(directory, `${archiveName}.sha256`) };
  const inputs = releaseFiles.map(({ source, path }) => ({ path, bytes: readFileSync(join(root, source)) }));
  const manifest = JSON.stringify({ format: 'fuzzy-stock-release-candidate', version: 1, revision, kind: 'preview', files: inputs.map(file => ({ path: file.path, bytes: file.bytes.length, sha256: digest(file.bytes) })) }, null, 2) + '\n';
  if (existsSync(directory)) {
    if (readFileSync(paths.manifest, 'utf8') !== manifest) throw new Error('既存の候補と内容が異なるため上書きしません');
    if (readFileSync(paths.checksum, 'utf8') !== `${digest(readFileSync(paths.archive))}  ${archiveName}\n`) throw new Error('既存ZIPのSHA-256が一致しません');
    return paths;
  }
  mkdirSync(output, { recursive: true });
  const staging = mkdtempSync(join(output, '.package-'));
  try {
    const payload = join(staging, name);
    for (const file of inputs) {
      const target = join(payload, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.bytes);
    }
    writeFileSync(join(payload, 'release-manifest.json'), manifest);
    const zip = join(staging, archiveName);
    execFileSync('powershell.exe', ['-NoProfile', '-Command', "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:FS_RELEASE_PAYLOAD, $env:FS_RELEASE_ZIP, [IO.Compression.CompressionLevel]::Optimal, $true)"], { cwd: process.env.SystemRoot, windowsHide: true, env: { ...process.env, FS_RELEASE_PAYLOAD: payload, FS_RELEASE_ZIP: zip } });
    writeFileSync(join(staging, 'release-manifest.json'), manifest);
    writeFileSync(join(staging, `${archiveName}.sha256`), `${digest(readFileSync(zip))}  ${archiveName}\n`);
    if (dirname(resolve(payload)) !== resolve(staging)) throw new Error('配布内容の削除先が作業用フォルダー外です');
    rmSync(payload, { recursive: true });
    renameSync(staging, directory);
    return paths;
  } finally {
    if (dirname(resolve(staging)) !== output || !basename(staging).startsWith('.package-')) throw new Error('配布作業フォルダーの削除先が不正です');
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const options = { cwd: root, encoding: 'utf8', windowsHide: true };
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], options).trim();
  const inputs = ['.gitattributes', '.gitignore', 'src', 'scripts', 'web', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'start-local.cmd', 'LICENSE', 'manual'];
  const changed = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', ...inputs], options).trim();
  if (changed) throw new Error(`配布に使う入力を先にコミットしてください。\n${changed}`);
  const rawSources = releaseFiles.map(({ source }) => source).filter(source => !source.startsWith('web/dist/'));
  const expectedEndings = new Map(releaseFiles.map(({ source, eol }) => [source, eol]));
  const checkRawInputs = (directory = root) => {
    const attributes = execFileSync('git', ['check-attr', '-z', 'eol', '--', ...rawSources], { ...options, cwd: directory }).split('\0');
    for (let index = 0; index < attributes.length - 1; index += 3) {
      const [source, , eol] = attributes.slice(index, index + 3);
      if (eol !== 'lf' && eol !== 'crlf') throw new Error(`配布入力の改行規則を明示してください: ${source}`);
      if (eol !== expectedEndings.get(source)) throw new Error(`配布入力の改行規則が固定契約と一致しない: ${source} (${eol})`);
      const text = readFileSync(join(directory, source), 'utf8');
      if (eol === 'lf' ? text.includes('\r') : /(?<!\r)\n|\r(?!\n)/.test(text)) throw new Error(`配布入力の改行が規則と一致しない: ${source} (${eol})`);
      if (source.endsWith('.ps1') && !text.startsWith('\uFEFF')) throw new Error(`Windows PowerShell用の配布入力にはUTF-8 BOMが必要です: ${source}`);
    }
  };
  checkRawInputs();
  const checkCommittedInputs = (directory) => {
    const gitOptions = { ...options, cwd: directory };
    const tracked = execFileSync('git', ['ls-files', '-z', '--', ...inputs], gitOptions).split('\0').filter(Boolean);
    for (const source of tracked) {
      const actual = execFileSync('git', ['hash-object', `--path=${source}`, '--', source], gitOptions).trim();
      const expected = execFileSync('git', ['rev-parse', `${revision}:${source}`], gitOptions).trim();
      if (actual !== expected) throw new Error(`コミットと配布入力が一致しない: ${source}`);
    }
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-per-directory=.gitignore', '-z', '--', ...inputs], gitOptions).split('\0').filter(Boolean);
    if (untracked.length) throw new Error(`未コミットの配布入力があります: ${untracked.join(', ')}`);
  };
  checkCommittedInputs(root);
  const temporaryRoot = resolve(tmpdir());
  const temporary = mkdtempSync(join(temporaryRoot, 'fuzzy-stock-release-build-'));
  try {
    const checkout = join(temporary, 'checkout');
    execFileSync('git', ['clone', '--no-local', '--no-checkout', '--', root, checkout], { windowsHide: true, stdio: ['ignore', 2, 2] });
    execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', revision], { ...options, cwd: checkout, stdio: ['ignore', 2, 2] });
    checkRawInputs(checkout);
    const npm = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    execFileSync(process.execPath, [npm, 'ci', '--allow-remote=all', '--prefer-offline', '--no-audit', '--no-fund'], { cwd: checkout, windowsHide: true, stdio: ['ignore', 2, 2] });
    execFileSync(process.execPath, [join(checkout, 'scripts/build.mjs')], { cwd: checkout, windowsHide: true, stdio: ['ignore', 2, 2] });
    if (execFileSync('git', ['rev-parse', 'HEAD'], { ...options, cwd: checkout }).trim() !== revision || execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', ...inputs], { ...options, cwd: checkout }).trim()) throw new Error('ビルド中に配布入力が変わったため作成しません。');
    checkRawInputs(checkout);
    checkCommittedInputs(checkout);
    const afterRevision = execFileSync('git', ['rev-parse', 'HEAD'], options).trim();
    const afterChanged = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', ...inputs], options).trim();
    if (afterRevision !== revision || afterChanged) throw new Error(`ビルド中に配布入力が変わったため作成しません。\n${afterChanged}`);
    checkRawInputs();
    checkCommittedInputs(root);
    console.log(JSON.stringify(createRelease(checkout, revision, root), null, 2));
  } finally {
    if (dirname(resolve(temporary)) !== temporaryRoot || !basename(temporary).startsWith('fuzzy-stock-release-build-')) throw new Error('ビルド作業フォルダーの削除先が不正です');
    rmSync(temporary, { recursive: true, force: true });
  }
}
