// #2923: an explicit, opt-in private env file for the Incus backend. The file is
// credential-adjacent: copied mode 600 into the owned instance, passed as
// --env-file to every inner Compose call, validated with `config --quiet`
// before `up`, never echoed, and gone with the instance on `down`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./stack.sh', import.meta.url));
const SECRET = 'SYNTHETIC-SENTINEL-8f3a91c2';
const PRIVATE_DIR = '/opt/hadron-private';
const PRIVATE_FILE = `${PRIVATE_DIR}/env`;

/**
 * A fake incus that logs every call. `compose config` (what a real Compose
 * would print as the resolved configuration) echoes the secret on stdout and
 * stderr, so any leak through the harness shows up in the captured output.
 * `compose up` fails, which stops `stack.sh up` before the forwarder starts.
 */
function setup(t, { backend = 'incus' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hadron-e2e-2923-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'); mkdirSync(bin);
  const log = join(root, 'calls');
  writeFileSync(log, '');
  const envFile = join(root, 'mock.env');
  writeFileSync(envFile, `MOCK_TOOL_TOKEN=${SECRET}\n`, { mode: 0o600 });
  writeFileSync(join(bin, 'docker'), `#!/bin/sh
printf 'docker %s\\n' "$*" >> '${log}'
case "$1" in info) exit 1 ;; *) exit 99 ;; esac
`, { mode: 0o700 });
  writeFileSync(join(bin, 'incus'), `#!/bin/sh
printf 'incus %s\\n' "$*" >> '${log}'
case "$1" in
info) exit 1 ;;
list) echo hadron-e2e-priv ;;
config) echo hadron-e2e-priv ;;
delete) exit 0 ;;
exec)
  case "$*" in
    *"compose"*" config "*) echo "resolved: ${SECRET}"; echo "resolved: ${SECRET}" >&2; exit 0 ;;
    *"compose"*" up "*) echo "up-failed" >&2; exit 1 ;;
  esac
  exit 0 ;;
*) exit 0 ;;
esac
`, { mode: 0o700 });
  const env = (extra = {}) => ({
    ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_STATE_HOME: root,
    E2E_BACKEND: backend, ...extra,
  });
  const run = (...args) => {
    const extra = typeof args.at(-1) === 'object' ? args.pop() : {};
    return spawnSync('bash', [script, ...args], { encoding: 'utf8', env: env(extra) });
  };
  const calls = () => readFileSync(log, 'utf8').split('\n').filter(Boolean);
  const stateDir = join(root, 'hadron-e2e', 'hadron-e2e-priv');
  return { root, envFile, run, calls, stateDir };
}

const composeCalls = calls => calls.filter(c => c.startsWith('incus exec') && c.includes(' docker compose '));

test('with the option, the file is pushed mode 600 into a private dir inside the owned instance', t => {
  const s = setup(t);
  const up = s.run('up', 'priv', { E2E_PRIVATE_ENV_FILE: s.envFile });
  assert.notEqual(up.status, 0); // fake `compose up` fails on purpose
  const push = s.calls().find(c => c.startsWith('incus file push') && c.includes(s.envFile));
  assert(push, 'expected the env file to be pushed');
  assert.match(push, /--mode[ =]0?600/);
  assert(push.endsWith(`hadron-e2e-priv${PRIVATE_FILE}`), push);
  assert(s.calls().some(c => c.startsWith('incus exec hadron-e2e-priv') && c.includes(PRIVATE_DIR) && /700/.test(c)),
    'private dir must be created mode 700');
});

test('every inner Compose call carries --env-file, and config --quiet runs before up', t => {
  const s = setup(t);
  s.run('up', 'priv', { E2E_PRIVATE_ENV_FILE: s.envFile });
  const compose = composeCalls(s.calls());
  assert(compose.length >= 2, compose.join('\n'));
  for (const c of compose) assert(c.includes(`--env-file ${PRIVATE_FILE}`), c);
  const config = compose.findIndex(c => / config --quiet/.test(c));
  const upIndex = compose.findIndex(c => / up /.test(c));
  assert(config >= 0, 'expected a config --quiet call');
  assert(upIndex > config, 'config --quiet must run before up');
  // later subcommands of the same stack keep passing it (recorded in state)
  const logs = s.run('logs', 'priv');
  void logs;
  const later = composeCalls(s.calls()).filter(c => / logs /.test(c));
  for (const c of later) assert(c.includes(`--env-file ${PRIVATE_FILE}`), c);
});

test('the file contents and the resolved configuration never reach harness output or call arguments', t => {
  const s = setup(t);
  const up = s.run('up', 'priv', { E2E_PRIVATE_ENV_FILE: s.envFile });
  assert(!up.stdout.includes(SECRET), 'stdout leaked the value');
  assert(!up.stderr.includes(SECRET), 'stderr leaked the value');
  assert(!s.calls().join('\n').includes(SECRET), 'a call argument carried the value');
  assert(!/resolved:/.test(up.stdout + up.stderr), 'resolved configuration was echoed');
});

test('a failed validation refuses before up, with a generic message', t => {
  const s = setup(t);
  writeFileSync(join(s.root, 'bin', 'incus'), `#!/bin/sh
printf 'incus %s\\n' "$*" >> '${join(s.root, 'calls')}'
case "$1" in
info) exit 1 ;;
exec) case "$*" in *"config --quiet"*) echo "bad ${SECRET}" >&2; exit 1 ;; esac; exit 0 ;;
*) exit 0 ;;
esac
`, { mode: 0o700 });
  const up = s.run('up', 'priv', { E2E_PRIVATE_ENV_FILE: s.envFile });
  assert.notEqual(up.status, 0);
  assert(!(up.stdout + up.stderr).includes(SECRET));
  assert.match(up.stderr, /private env file/i);
  assert(!composeCalls(s.calls()).some(c => / up /.test(c)), 'up must not run after a failed config');
});

test('without the option, no private-env call is made and Compose args are unchanged', t => {
  const s = setup(t);
  s.run('up', 'priv');
  const all = s.calls().join('\n');
  assert(!all.includes('--env-file'));
  assert(!all.includes('hadron-private'));
  assert(!all.includes('config --quiet'));
  assert(!existsSync(join(s.stateDir, 'private-env')));
});

test('down removes the instance and the recorded private-env state, and only this stack', t => {
  const s = setup(t);
  s.run('up', 'priv', { E2E_PRIVATE_ENV_FILE: s.envFile });
  assert(existsSync(join(s.stateDir, 'private-env')), 'private-env must be recorded in state');
  const other = join(s.root, 'hadron-e2e', 'hadron-e2e-other');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'private-env'), '1\n');
  const down = s.run('down', 'priv');
  assert.equal(down.status, 0, down.stderr);
  assert(!existsSync(s.stateDir), 'state dir must be gone');
  assert(existsSync(join(other, 'private-env')), 'another stack must be untouched');
  assert.deepEqual(readdirSync(other), ['private-env']);
  const deletes = s.calls().filter(c => c.startsWith('incus delete'));
  assert.deepEqual(deletes, ['incus delete hadron-e2e-priv --force']);
});

test('the docker backend refuses the option clearly, before creating any state', t => {
  const s = setup(t, { backend: 'docker' });
  const up = s.run('up', 'priv', { E2E_PRIVATE_ENV_FILE: s.envFile });
  assert.notEqual(up.status, 0);
  assert.match(up.stderr, /E2E_PRIVATE_ENV_FILE.*Incus|Incus.*E2E_PRIVATE_ENV_FILE/s);
  assert(!existsSync(s.stateDir));
  assert(!s.calls().some(c => c.startsWith('docker compose')));
});

for (const [name, make] of [
  ['missing', root => join(root, 'nope.env')],
  ['a directory', root => { const d = join(root, 'dir.env'); mkdirSync(d); return d; }],
]) {
  test(`an env file that is ${name} is refused before any instance is launched`, t => {
    const s = setup(t);
    const up = s.run('up', 'priv', { E2E_PRIVATE_ENV_FILE: make(s.root) });
    assert.notEqual(up.status, 0);
    assert(!s.calls().some(c => c.startsWith('incus launch')), 'must refuse before launch');
    assert(!existsSync(s.stateDir));
  });
}
