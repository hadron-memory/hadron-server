import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const entrypoint = fileURLToPath(new URL('../docker-start.sh', import.meta.url));
const serve = 'postgresql://hadron_app:serve-fixture-password@db/app';
const owner = 'postgresql://hadron:migrate-fixture-password@db/app';
function boot(t, { migrate = owner, fail = '', noise = false, shell = ['sh'], serving = serve } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'docker-start-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'calls');
  writeFileSync(join(dir, 'pnpm'), `#!/bin/sh
printf '%s|%s|%s\\n' "$*" "$DATABASE_URL" "\${MIGRATE_DATABASE_URL-unset}" >> "$CALL_LOG"
if [ "$*" = "$FAIL_STEP" ]; then
  printf '%s\\n' "$DATABASE_URL" >&2
  # The synthetic URL and password share the P1001 line itself: a widened whole-line extraction must leak them.
  printf 'Error: P1001: fixture connection failure %s password=%s\\n' "$DATABASE_URL" serve-fixture-password >&2
  exit 42
fi
if [ "$NOISE" = yes ]; then printf '%s\\n' "$DATABASE_URL"; fi
`, { mode: 0o700 });
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, DATABASE_URL: serve,
    TMPDIR: dir, CALL_LOG: log, FAIL_STEP: fail, NOISE: noise ? 'yes' : 'no' };
  delete env.MIGRATE_DATABASE_URL;
  if (serving === null) delete env.DATABASE_URL; else env.DATABASE_URL = serving;
  if (migrate !== undefined && migrate !== null) env.MIGRATE_DATABASE_URL = migrate;
  const run = spawnSync(shell[0], [...shell.slice(1), entrypoint], { encoding: 'utf8', env });
  assert(!readdirSync(dir).some(name => name.startsWith('hadron-start.')), 'private startup output was not cleaned up');
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
for (const value of [null, '']) test(`missing/empty serving DATABASE_URL refuses before any setup command (${JSON.stringify(value)})`, t => {
  const run = boot(t, { serving: value });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /db\.runtime_role\.database_url_missing/);
  assert.deepEqual(run.calls, []);
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

test('failed migration reports exit status and Prisma code without raw connection output', t => {
  const run = boot(t, { fail: 'prisma migrate deploy' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /db\.runtime_role\.migrate_failed.*exit=42.*prisma=P1001/);
  noSecrets(run);
});

// Catchable termination signals (HUP/INT/QUIT/TERM) must still remove the private raw log, under dash and
// Alpine's busybox ash. The fake pnpm blocks; the whole process group is signalled so the blocked child dies
// and the shell runs its trap. SIGKILL/OOM is uncatchable and out of scope.
const shells = [['dash'], ['busybox', 'sh']].filter(([cmd, ...args]) => spawnSync(cmd, [...args, '-c', 'exit 0']).status === 0);
const signals = { HUP: 129, INT: 130, QUIT: 131, TERM: 143 };
function signalled(t, shell, signal) {
  const dir = mkdtempSync(join(tmpdir(), 'docker-start-signal-'));
  const started = join(dir, 'started');
  writeFileSync(join(dir, 'pnpm'), `#!/bin/sh
if [ "$*" = "prisma migrate deploy" ]; then
  printf '%s\\n' "$DATABASE_URL" >&2
  : > "$STARTED"
  sleep 30
fi
`, { mode: 0o700 });
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, DATABASE_URL: serve, MIGRATE_DATABASE_URL: owner, TMPDIR: dir, STARTED: started };
  const child = spawn(shell[0], [...shell.slice(1), entrypoint], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.on('exit', (code, sig) => resolve({ code, sig })));
  // Bounded cleanup: never leave the blocked child behind, whatever the assertions do.
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } rmSync(dir, { recursive: true, force: true }); });
  return { dir, started, child, exited, signal: () => process.kill(-child.pid, `SIG${signal}`) };
}
async function until(predicate, what) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 25)); }
  assert.fail(`timed out waiting for ${what}`);
}
for (const shell of shells) for (const [signal, status] of Object.entries(signals)) {
  test(`${signal} during setup removes the private raw log and exits ${status} (${shell.join(' ')})`, async t => {
    const run = signalled(t, shell, signal);
    await until(() => readdirSync(run.dir).includes('started'), 'the blocked setup step');
    assert(readdirSync(run.dir).some(name => name.startsWith('hadron-start.')), 'the private raw log should exist while setup runs');
    run.signal();
    const result = await Promise.race([run.exited, new Promise(r => setTimeout(() => r({ timeout: true }), 5000))]);
    assert(!result.timeout, 'entrypoint did not exit after the signal');
    assert.equal(result.code, status);
    assert.deepEqual(readdirSync(run.dir).filter(name => name.startsWith('hadron-start.')), []);
  });
}
