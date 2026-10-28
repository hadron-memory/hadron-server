import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stopCapturedChild } from './captured-pid.mjs';
const script = fileURLToPath(new URL('./stack.sh', import.meta.url));
for (const scenario of ['stopped', 'absent', 'unmarked', 'daemon-failure', 'half-created']) {
  test(`recorded Incus teardown: ${scenario}, even with Docker newly available`, t => {
    const root = mkdtempSync(join(tmpdir(), 'hadron-e2e-test-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const bin = join(root, 'bin'); mkdirSync(bin);
    const dir = join(root, 'hadron-e2e', 'hadron-e2e-test-fixture'); if (scenario !== 'half-created') mkdirSync(dir, { recursive: true });
    const state = { backend: 'incus', 'api-port': '18400', 'portal-port': '18500',
      'proxy.pid': '999999999', 'proxy-script': '/synthetic/proxy.mjs', 'proxy-address': '192.0.2.1' };
    for (const [name, value] of Object.entries(scenario === 'half-created' ? {} : state)) writeFileSync(join(dir, name), `${value}\n`);
    const log = join(root, 'calls');
    writeFileSync(join(bin, 'docker'), '#!/bin/sh\necho unexpected-Docker >&2\nexit 99\n', { mode: 0o700 });
    writeFileSync(join(bin, 'incus'), `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$1" in
info) exit 1 ;;
launch) exit 1 ;;
list) ${scenario === 'daemon-failure' ? 'exit 42' : scenario === 'absent' ? 'exit 0' : 'echo hadron-e2e-test-fixture'} ;;
config) echo ${scenario === 'unmarked' ? 'foreign' : 'hadron-e2e-test-fixture'} ;;
delete) exit 0 ;;
*) echo unexpected-exec >&2; exit 98 ;;
esac
`, { mode: 0o700 });
    if (scenario === 'half-created') {
      const up = spawnSync('bash', [script, 'up', 'test-fixture'], {
        encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_STATE_HOME: root, E2E_BACKEND: 'incus' },
      });
      assert.notEqual(up.status, 0);
      assert(readFileSync(log, 'utf8').includes('launch qa-docker hadron-e2e-test-fixture -c security.nesting=true -c user.hadron-e2e=hadron-e2e-test-fixture'));
    }
    const result = spawnSync('bash', [script, 'down', 'test-fixture'], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_STATE_HOME: root, E2E_BACKEND: 'auto' },
    });
    const success = scenario === 'stopped' || scenario === 'absent' || scenario === 'half-created';
    assert.equal(result.status === 0, success, result.stderr);
    assert.equal(existsSync(dir), !success);
    const calls = readFileSync(log, 'utf8');
    assert.equal(calls.includes('delete '), scenario === 'stopped' || scenario === 'half-created');
    assert(!calls.includes('exec '));
    assert(!result.stderr.includes('unexpected-Docker'));
  });
}


test('symlinked checkout records actual forwarder argv and down stops it', { skip: process.platform !== 'linux' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'e2e-symlink-test-'));
  let pid;
  t.after(() => {
    if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    rmSync(root, { recursive: true, force: true });
  });
  const checkout = join(root, 'checkout');
  symlinkSync(fileURLToPath(new URL('../../', import.meta.url)), checkout);
  const probe = createServer().listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = String(probe.address().port);
  await new Promise(resolve => probe.close(resolve));
  const dir = join(root, 'hadron-e2e', 'hadron-e2e-symlink'); mkdirSync(dir, { recursive: true });
  for (const [key, value] of Object.entries({ backend: 'incus', 'api-port': port, 'portal-port': port === '18500' ? '18501' : '18500', 'proxy-address': '192.0.2.1' })) {
    writeFileSync(join(dir, key), `${value}\n`);
  }
  const launch = spawnSync('node', [join(checkout, 'scripts/e2e/start-forwarder.mjs'), dir, port, '192.0.2.1'], { encoding: 'utf8' });
  assert.equal(launch.status, 0, launch.stderr);
  pid = Number(readFileSync(join(dir, 'proxy.pid'), 'utf8'));
  const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
  assert.equal(readFileSync(join(dir, 'proxy-script'), 'utf8').trim(), args[1]);
  assert.notEqual(args[1], join(checkout, 'scripts/e2e/host-proxy.mjs'));
  const bin = join(root, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'incus'), '#!/bin/sh\ncase "$1" in list|config) echo hadron-e2e-symlink ;; delete) exit 0 ;; *) exit 98 ;; esac\n', { mode: 0o700 });
  const down = spawnSync('bash', [join(checkout, 'scripts/e2e/stack.sh'), 'down', 'symlink'], {
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_STATE_HOME: root, E2E_BACKEND: 'incus' },
  });
  assert.equal(down.status, 0, down.stderr);
  assert(!existsSync(dir));
  for (let attempt = 0; attempt < 40; attempt++) {
    if (!existsSync(`/proc/${pid}/stat`) || readFileSync(`/proc/${pid}/stat`, 'utf8').includes(') Z ')) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('down left its symlink-launched forwarder running');
});

test('failed ownership write terminates its detached forwarder', async t => {
  const root = mkdtempSync(join(tmpdir(), 'e2e-state-failure-'));
  const captured = join(root, 'child.pid');
  t.after(() => {
    if (existsSync(captured)) {
      try { stopCapturedChild(readFileSync(captured, 'utf8'), process.kill); } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  });
  const probe = createServer().listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = String(probe.address().port);
  await new Promise(resolve => probe.close(resolve));
  const state = join(root, 'state'); mkdirSync(state);
  // EISDIR is deterministic even for a privileged test runner.
  mkdirSync(join(state, 'proxy.pid'));
  const bin = join(root, 'bin'); mkdirSync(bin);
  // Capture only this test's child so even a kill-removed mutant is cleaned up.
  writeFileSync(join(bin, 'node'), `#!/bin/sh\necho $$ > '${captured}'\nexec '${process.execPath}' "$@"\n`, { mode: 0o700 });
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./start-forwarder.mjs', import.meta.url)), state, port, '192.0.2.1'], {
    encoding: 'utf8', timeout: 2000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /EISDIR/);
  const { connect } = await import('node:net');
  const listening = await new Promise(resolve => {
    const socket = connect(Number(port), '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
  assert.equal(listening, false, 'failed persistence left an untracked listener');
});
