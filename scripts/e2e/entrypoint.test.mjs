import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const entrypoint = fileURLToPath(new URL('./entrypoint.sh', import.meta.url));
for (const [label, output, exitCode] of [['initialized', 't', 0], ['empty reply', '', 0], ['unexpected reply', 'NULL', 0], ['query failure', '', 42]]) {
  test(`${label}: refuses before Prisma, SQL mutation, or key generation`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-startup-test-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const log = join(dir, 'calls');
    writeFileSync(join(dir, 'psql'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nprintf '%s\\n' '${output}'\nexit ${exitCode}\n`, { mode: 0o700 });
    for (const cmd of ['node', 'pnpm']) writeFileSync(join(dir, cmd), '#!/bin/sh\necho unexpected-work >&2\nexit 99\n', { mode: 0o700 });
    const run = spawnSync('sh', [entrypoint], { encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DATABASE_URL: 'postgresql://fixture@db/e2e', RATE_LIMIT_KEYRING: '' } });
    assert.equal(run.status, exitCode || 1);
    if (!exitCode) assert.match(run.stderr, /already initialized; reset with scoped stack.sh down, then up/);
    assert(!run.stderr.includes('unexpected-work'));
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(calls.length, 1);
    assert(calls[0].includes('SELECT EXISTS'));
    assert(!calls[0].includes(' -f '));
  });
}
test('fresh public schema proceeds through setup, seed and supervised server', t => {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-fresh-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'calls');
  writeFileSync(join(dir, 'psql'), `#!/bin/sh\nprintf 'psql %s\\n' "$*" >> '${log}'\ncase "$*" in *'SELECT EXISTS'*) echo f ;; esac\n`, { mode: 0o700 });
  writeFileSync(join(dir, 'node'), `#!/bin/sh\nprintf 'node %s\\n' "$*" >> '${log}'\necho synthetic-key\n`, { mode: 0o700 });
  writeFileSync(join(dir, 'pnpm'), `#!/bin/sh\nprintf 'pnpm %s\\n' "$*" >> '${log}'\n`, { mode: 0o700 });
  const run = spawnSync('sh', [entrypoint], { encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DATABASE_URL: 'postgresql://fixture@db/e2e', RATE_LIMIT_KEYRING: '' } });
  assert.equal(run.status, 0, run.stderr);
  const calls = readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(calls.length, 9);
  assert(calls[0].includes('SELECT EXISTS'));
  assert(calls[3].includes("current:'e2e'"));
  assert(calls[4].endsWith('-f prisma/pre-push.sql'));
  assert.equal(calls[5], 'pnpm prisma db push --skip-generate');
  assert(calls[6].endsWith('-f prisma/post-push.sql'));
  assert.equal(calls[7], 'pnpm tsx scripts/e2e/seed.ts');
  assert.equal(calls[8], 'node scripts/e2e/supervise.mjs');
});
