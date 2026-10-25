import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const logs = resolve('.local-logs/server-startup');
mkdirSync(logs, { recursive: true });
const scratch = mkdtempSync(join(logs, 'startup-fixture-'));
const sourcePath = resolve('web/_local-server.ps1');
const source = readFileSync(sourcePath, 'utf8');
const hash = () => createHash('sha256').update(readFileSync(sourcePath)).digest('hex');
const report = { checkedAt: new Date().toISOString(), node: process.version, revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(), sourceBefore: hash(), cases: [] };
const run = (script, port) => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-NoBrowser', '-Port', String(port)], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
const record = (name, result, expectedExit, marker, forbiddenMarker) => {
  const stdout = result.stdout ?? '', stderr = result.stderr ?? '';
  const passed = result.status === expectedExit && stdout.includes(marker) && !stdout.includes(forbiddenMarker) && !result.error;
  report.cases.push({ name, passed, exit: result.status, expectedExit, marker, forbiddenMarker, stdout, stderr, error: result.error ? String(result.error) : null });
};
const blocker = createServer();
try {
  const declaration = '$listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $Port)';
  assert.equal(source.split(declaration).length, 2, 'Listener fixture replaces exactly one declaration');
  for (const [code, expectedExit, marker, forbiddenMarker] of [[10048, 2, 'FS_PORT_IN_USE', 'FS_SERVER_START_FAILED'], [10013, 5, 'FS_SERVER_START_FAILED 10013 AccessDenied', 'FS_PORT_IN_USE'], [10055, 5, 'FS_SERVER_START_FAILED 10055 NoBufferSpaceAvailable', 'FS_PORT_IN_USE']]) {
    const fixture = [
      "Add-Type -TypeDefinition @'",
      'using System.Net.Sockets;',
      'public class FictionalSocketListener {',
      `  public void Start() { throw new SocketException(${code}); }`,
      '  public void Stop() {}',
      '}',
      "'@",
      '$listener = New-Object FictionalSocketListener',
    ].join('\r\n');
    const path = join(scratch, `startup-${code}.ps1`);
    writeFileSync(path, source.replace(declaration, fixture));
    record(`injected-SocketException-${code}`, run(path, 0), expectedExit, marker, forbiddenMarker);
    const output = report.cases.at(-1).stdout;
    assert.equal(output.includes('local-settings.txt'), code === 10048 || code === 10013, `port guidance for ${code}`);
  }
  await new Promise((accept, reject) => { blocker.once('error', reject); blocker.listen(0, '127.0.0.1', accept); });
  record('actual-owned-port-conflict', run(sourcePath, blocker.address().port), 2, 'FS_PORT_IN_USE', 'FS_SERVER_START_FAILED');
  report.sourceAfter = hash();
  assert.equal(report.sourceAfter, report.sourceBefore, 'Source is unchanged by the probe');
  assert.ok(report.cases.every(value => value.passed), report.cases.filter(value => !value.passed).map(value => `${value.name}: exit ${value.exit}, expected ${value.expectedExit}; ${value.stdout}; ${value.stderr}`).join('\n'));
  report.status = 'CHECKS_PASSED';
} catch (error) { report.failure = String(error.stack ?? error); throw error; }
finally {
  const cleanupErrors = [];
  try { if (blocker.listening) await new Promise((accept, reject) => blocker.close(error => error ? reject(error) : accept())); }
  catch (error) { cleanupErrors.push(String(error)); }
  try {
    if (dirname(resolve(scratch)) !== logs || !basename(scratch).startsWith('startup-fixture-')) throw new Error('Unexpected startup fixture path');
    rmSync(scratch, { recursive: true, force: true });
  } catch (error) { cleanupErrors.push(String(error)); }
  report.cleanup = cleanupErrors.length ? { status: 'FAIL', errors: cleanupErrors } : { status: 'complete' };
  report.status = report.status === 'CHECKS_PASSED' && !cleanupErrors.length ? 'PASS' : 'FAIL';
  writeFileSync(join(logs, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, cases: report.cases.map(value => ({ name: value.name, passed: value.passed })), cleanup: report.cleanup }));
  if (cleanupErrors.length && !report.failure) throw new Error(cleanupErrors.join('\n'));
}
