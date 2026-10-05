import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
