import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const entrypoint = fileURLToPath(new URL('../docker-start.sh', import.meta.url));
const serve = 'postgresql://hadron_app:serve-fixture-password@db/app';
const owner = 'postgresql://hadron:migrate-fixture-password@db/app';
function boot(t, { migrate = owner, fail = '', noise = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'docker-start-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'calls');
  writeFileSync(join(dir, 'pnpm'), `#!/bin/sh
printf '%s|%s|%s\\n' "$*" "$DATABASE_URL" "\${MIGRATE_DATABASE_URL-unset}" >> "$CALL_LOG"
if [ "$*" = "$FAIL_STEP" ]; then
  printf '%s\\n' "$DATABASE_URL" >&2
  exit 42
fi
if [ "$NOISE" = yes ]; then printf '%s\\n' "$DATABASE_URL"; fi
`, { mode: 0o700 });
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, DATABASE_URL: serve,
    CALL_LOG: log, FAIL_STEP: fail, NOISE: noise ? 'yes' : 'no' };
  delete env.MIGRATE_DATABASE_URL;
  if (migrate !== undefined && migrate !== null) env.MIGRATE_DATABASE_URL = migrate;
  const run = spawnSync('sh', [entrypoint], { encoding: 'utf8', env });
  const calls = (() => { try { return readFileSync(log, 'utf8').trim().split('\n').map(row => row.split('|')); } catch { return []; } })();
  return { ...run, calls };
}
function noSecrets(run) {
  for (const secret of [serve, owner, 'serve-fixture-password', 'migrate-fixture-password']) {
    assert(!`${run.stdout}${run.stderr}`.includes(secret), `startup output disclosed a fixture credential`);
  }
}
test('Docker CMD runs the checked-in entrypoint under Doppler and copies its helpers', () => {
  const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /COPY scripts \.\/scripts\//);
  assert.match(dockerfile, /CMD \["doppler", "run", "--", "sh", "scripts\/docker-start.sh"\]/);
});
test('migrates/revokes/verifies as owner, then execs server as serve without migrator secret', t => {
  const run = boot(t);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.calls.map(row => row[0]), ['prisma generate', 'prisma migrate deploy',
    'tsx scripts/db/revoke-runtime-migrations.ts', 'tsx scripts/db/verify-runtime-role.ts', 'tsx src/index.ts']);
  assert.equal(run.calls[1][1], owner);
  assert.equal(run.calls[2][1], owner);
  assert.equal(run.calls[3][1], owner);
  assert.equal(run.calls[4][1], serve);
  assert.equal(run.calls[4][2], 'unset');
  noSecrets(run);
});
for (const migrate of [null, '']) test(`missing/empty migrator falls back loudly (${JSON.stringify(migrate)})`, t => {
  const run = boot(t, { migrate });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /db\.runtime_role\.owner_serving/);
  assert(run.calls.every(row => row[1] === serve));
  noSecrets(run);
});
for (const step of ['prisma generate', 'prisma migrate deploy', 'tsx scripts/db/revoke-runtime-migrations.ts']) {
  test(`${step} failure stops boot and redacts command output`, t => {
    const run = boot(t, { fail: step });
    assert.notEqual(run.status, 0);
    assert.equal(run.calls.at(-1)?.[0], step);
    assert(!run.calls.some(row => row[0] === 'tsx src/index.ts'));
    noSecrets(run);
  });
}
test('verification is warn-only and follows revoke', t => {
  const run = boot(t, { fail: 'tsx scripts/db/verify-runtime-role.ts' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /db\.runtime_role\.verify_failed/);
  assert.equal(run.calls.at(-1)[0], 'tsx src/index.ts');
  noSecrets(run);
});
test('successful setup command output cannot disclose URLs either', t => {
  // The server is intentionally not noisy: only startup setup output is suppressed.
  const run = boot(t, { noise: true, fail: 'prisma migrate deploy' });
  assert.notEqual(run.status, 0);
  noSecrets(run);
});
