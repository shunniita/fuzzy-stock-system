import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { once } from 'node:events';

const server = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'web/_local-server.ps1', '-NoBrowser', '-Port', '0'], { windowsHide: true });
const sockets = [];
try {
  const url = await new Promise((resolve, reject) => {
    let output = '';
    server.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/FS_SERVER_READY http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) resolve(Number(match[1]));
    });
    server.on('error', reject);
    server.on('exit', code => reject(new Error(`server exited ${code}`)));
  });
  const open = async () => {
    const socket = connect(url, '127.0.0.1');
    sockets.push(socket);
    socket.on('error', () => {});
    await once(socket, 'connect');
    return socket;
  };
  const request = async (path, expected) => {
    const socket = await open();
    let response = '';
    socket.on('data', chunk => { response += chunk; });
    const ended = once(socket, 'end');
    const deadline = setTimeout(() => socket.destroy(new Error('request blocked by incomplete connection')), 1500);
    try {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\n\r\n`);
      await ended;
      assert.ok(response.startsWith(`HTTP/1.1 ${expected} `), response.slice(0, 100));
    } finally { clearTimeout(deadline); }
  };
  for (let i = 0; i < 3; i++) await open();
  await request('/', 200);
  const partial = await open();
  let partialResponse = '';
  partial.on('data', chunk => { partialResponse += chunk; });
  const partialEnded = once(partial, 'end');
  partial.write('GET / HTTP/1.1\r\nHost:');
  await request('/style.css', 200);
  partial.write(' localhost\r\n\r\n');
  await partialEnded;
  assert.ok(partialResponse.startsWith('HTTP/1.1 200 '));
  await request('/%2e%2e/package.json', 403);
  await request('/_local-server.ps1', 415);
  await request('/missing-file', 404);
  console.log('PASS: idle and partial connections do not block; path and MIME guards preserved');
} finally {
  for (const socket of sockets) socket.destroy();
  if (server.exitCode === null) {
    const exited = once(server, 'exit');
    server.kill();
    await exited;
  }
}
