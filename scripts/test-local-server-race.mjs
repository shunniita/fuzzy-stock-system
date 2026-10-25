import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { once } from 'node:events';
import { resolve } from 'node:path';

// 要求の到着をAvailableの読取と切断判定の間に固定する。
const command = `
$script:raceAnnounced = $false
$line = (Select-String -LiteralPath $env:FS_RACE_SERVER -SimpleMatch '$closed =').LineNumber
Set-PSBreakpoint -Script $env:FS_RACE_SERVER -Line $line -Action {
  if (-not $script:raceAnnounced) {
    $script:raceAnnounced = $true
    [Console]::WriteLine('FS_POLL_WINDOW')
    [Threading.Thread]::Sleep(200)
  }
} | Out-Null
& $env:FS_RACE_SERVER -NoBrowser -Port 0
`;
const server = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
  windowsHide: true,
  env: { ...process.env, FS_RACE_SERVER: resolve('web/_local-server.ps1') },
});
let socket;
let deadline;
try {
  await new Promise((resolveResult, reject) => {
    let output = '', response = '', sent = false;
    deadline = setTimeout(() => reject(new Error('poll-boundary response timed out')), 10000);
    server.on('error', reject);
    server.on('exit', code => reject(new Error(`server exited ${code}`)));
    server.stderr.on('data', chunk => reject(new Error(String(chunk))));
    server.stdout.on('data', chunk => {
      output += chunk;
      const ready = output.match(/FS_SERVER_READY http:\/\/127\.0\.0\.1:(\d+)/);
      if (ready && !socket) {
        socket = connect(Number(ready[1]), '127.0.0.1');
        socket.on('error', reject);
        socket.on('data', chunk => { response += chunk; });
        socket.on('end', () => {
          if (response.startsWith('HTTP/1.1 200 ')) resolveResult();
          else reject(new Error(`request lost at poll boundary: ${response.slice(0, 80)}`));
        });
      }
      if (socket && output.includes('FS_POLL_WINDOW') && !sent) {
        sent = true;
        socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n');
      }
    });
  });
  assert.ok(socket);
  console.log('PASS: request arriving during disconnect check receives HTTP 200');
} finally {
  clearTimeout(deadline);
  socket?.destroy();
  if (server.exitCode === null) {
    const exited = once(server, 'exit');
    server.kill();
    await exited;
  }
}
