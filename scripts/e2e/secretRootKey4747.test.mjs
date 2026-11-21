// #4747: the e2e stack mints SECRET_ROOT_KEY per launch, the HADRON_ENCRYPTION_KEY pattern, so App secrets can be QA'd.
// With it unset every App secret operation refuses SECRET_KEY_UNAVAILABLE (CLAUDE.md, SECRET_ROOT_KEY).
//
// These run the REAL entrypoint.sh and seed-lane.sh with fake psql and pnpm (so no database or Prisma is touched) and the
// REAL node, so the keys are genuinely generated. The last process each script starts records the environment it was
// handed, which is what the server would inherit. Nothing here uses a production value, and no key value is printed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const entrypoint = fileURLToPath(new URL('./entrypoint.sh', import.meta.url));
const seedLane = fileURLToPath(new URL('./seed-lane.sh', import.meta.url));
const HEX64 = /^[0-9a-f]{64}$/;
const KEYS = ['JWT_SECRET', 'HADRON_ENCRYPTION_KEY', 'SECRET_ROOT_KEY'];

/** A fresh directory of fakes: psql answers "empty database", pnpm/node-supervise record the env and exit 0. */
function fakes(t, { recordOn }) {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-4747-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'env.log');
  writeFileSync(log, '');
  const record = `printf 'JWT_SECRET=%s\\nHADRON_ENCRYPTION_KEY=%s\\nSECRET_ROOT_KEY=%s\\n' "\${JWT_SECRET-}" "\${HADRON_ENCRYPTION_KEY-}" "\${SECRET_ROOT_KEY-}" >> '${log}'`;
  writeFileSync(join(dir, 'psql'), `#!/bin/sh\ncase "$*" in *'SELECT EXISTS'*) echo f ;; esac\n`, { mode: 0o700 });
  // node: the supervised server is recorded; every other call (the key generators) is the real node.
  writeFileSync(join(dir, 'node'), `#!/bin/sh\ncase "$*" in *supervise*) ${record}; exit 0 ;; esac\nexec '${process.execPath}' "$@"\n`, { mode: 0o700 });
  writeFileSync(join(dir, 'pnpm'), `#!/bin/sh\ncase "$*" in *'scripts/e2e/seed.ts'*) ${recordOn === 'pnpm-seed' ? record : ':'} ;; esac\nexit 0\n`, { mode: 0o700 });
  return { dir, log };
}

/** The launching shell's environment with SECRET_ROOT_KEY ABSENT, as on a real stack (a variable already exported would stay exported on reassignment and hide a missing `export`). */
const withoutRootKey = (extra) => { const env = { ...process.env, ...extra }; delete env.SECRET_ROOT_KEY; return env; };

const recorded = (log) => Object.fromEntries(readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => l.split(/=(.*)/s).slice(0, 2)));

function runEntrypoint(t) {
  const f = fakes(t, { recordOn: 'node-supervise' });
  const run = spawnSync('sh', [entrypoint], { encoding: 'utf8',
    env: withoutRootKey({ PATH: `${f.dir}:${process.env.PATH}`, DATABASE_URL: 'postgresql://fixture@db/e2e', RATE_LIMIT_KEYRING: '' }) });
  assert.equal(run.status, 0, run.stderr);
  return { run, env: recorded(f.log) };
}

function runSeedLane(t) {
  const f = fakes(t, { recordOn: 'pnpm-seed' });
  const run = spawnSync('bash', [seedLane], { encoding: 'utf8',
    env: withoutRootKey({ PATH: `${f.dir}:${process.env.PATH}`, DATABASE_URL: 'postgresql://fixture@db/e2e',
      ROW_SIGNING: 'false', ROW_REGISTRATION: 'false', ROW_EXPECT: 'pass' }) });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  return { run, env: recorded(f.log) };
}

for (const [label, launch] of [['entrypoint.sh', runEntrypoint], ['seed-lane.sh', runSeedLane]]) {
  test(`${label}: SECRET_ROOT_KEY is exactly 64 lowercase hex and reaches the process it starts`, t => {
    const { env } = launch(t);
    assert.match(env.SECRET_ROOT_KEY ?? '', HEX64, 'SECRET_ROOT_KEY must be 32 CSPRNG bytes as 64 hex, exported to the child');
  });

  test(`${label}: it is a dedicated value, not equal to or derived from the other keys`, t => {
    const { env } = launch(t);
    assert.match(env.SECRET_ROOT_KEY ?? '', HEX64);
    assert.notEqual(env.SECRET_ROOT_KEY, env.HADRON_ENCRYPTION_KEY);
    assert.notEqual(env.SECRET_ROOT_KEY, env.JWT_SECRET);
    assert.equal(new Set(KEYS.map(k => env[k])).size, KEYS.length, 'all three keys are distinct');
  });

  test(`${label}: two launches produce two different keys`, t => {
    const a = launch(t).env.SECRET_ROOT_KEY;
    const b = launch(t).env.SECRET_ROOT_KEY;
    assert.match(a ?? '', HEX64);
    assert.match(b ?? '', HEX64);
    assert.notEqual(a, b);
  });

  test(`${label}: no key value is logged`, t => {
    const { run, env } = launch(t);
    assert.match(env.SECRET_ROOT_KEY ?? '', HEX64);
    for (const k of KEYS) {
      assert(!run.stdout.includes(env[k]), `${k} leaked to stdout`);
      assert(!run.stderr.includes(env[k]), `${k} leaked to stderr`);
    }
  });

  test(`${label}: a value already in the caller's environment is replaced, never reused`, t => {
    // A fresh stack must never inherit a dev, test or production root key from the shell that launched it (R18).
    const f = fakes(t, { recordOn: label === 'entrypoint.sh' ? 'node-supervise' : 'pnpm-seed' });
    const inherited = 'ab'.repeat(32);
    const common = { ...process.env, PATH: `${f.dir}:${process.env.PATH}`, DATABASE_URL: 'postgresql://fixture@db/e2e', SECRET_ROOT_KEY: inherited };
    const run = label === 'entrypoint.sh'
      ? spawnSync('sh', [entrypoint], { encoding: 'utf8', env: { ...common, RATE_LIMIT_KEYRING: '' } })
      : spawnSync('bash', [seedLane], { encoding: 'utf8', env: { ...common, ROW_SIGNING: 'false', ROW_REGISTRATION: 'false', ROW_EXPECT: 'pass' } });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const env = recorded(f.log);
    assert.match(env.SECRET_ROOT_KEY ?? '', HEX64);
    assert.notEqual(env.SECRET_ROOT_KEY, inherited);
  });
}
