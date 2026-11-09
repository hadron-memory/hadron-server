import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const entrypoint = fileURLToPath(new URL('../docker-start.sh', import.meta.url));
const serve = 'postgresql://hadron_app:serve-fixture-password@db/app';
const owner = 'postgresql://hadron:migrate-fixture-password@db/app';
function boot(t, { migrate = owner, fail = '', noise = false, serving = serve, shell = 'sh', failLine = '', failCode = 'P1001', helperOut = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'docker-start-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'calls');
  writeFileSync(join(dir, 'pnpm'), `#!/bin/sh
printf '%s|%s|%s|%s\\n' "$*" "$DATABASE_URL" "\${MIGRATE_DATABASE_URL-unset}" "\${HADRON_MIGRATIONS_REFUSED-unset}" >> "$CALL_LOG"
if [ "$*" = "tsx scripts/db/resolve-refused-migrations.ts" ] && [ -n "$HELPER_OUT" ]; then printf '%s\\n' "$HELPER_OUT"; exit 0; fi
if [ "$*" = "$FAIL_STEP" ]; then
  printf '%s\\n' "$DATABASE_URL" >&2
  printf '%s\\n' "Error: \${FAIL_CODE}: \${FAIL_LINE:-fixture connection failure}" >&2
  exit 42
fi
if [ "$NOISE" = yes ]; then printf '%s\\n' "$DATABASE_URL"; fi
`, { mode: 0o700 });
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, DATABASE_URL: serving,
    TMPDIR: dir, CALL_LOG: log, FAIL_STEP: fail, FAIL_LINE: failLine, FAIL_CODE: failCode, HELPER_OUT: helperOut, NOISE: noise ? 'yes' : 'no' };
  delete env.MIGRATE_DATABASE_URL;
  if (serving === null) delete env.DATABASE_URL;
  if (migrate !== undefined && migrate !== null) env.MIGRATE_DATABASE_URL = migrate;
  const run = spawnSync(shell, [entrypoint], { encoding: 'utf8', env });
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
    'tsx scripts/db/revoke-runtime-migrations.ts', 'tsx scripts/db/upsert-actions.ts', 'tsx scripts/db/verify-runtime-role.ts', 'tsx src/index.ts']);
  assert.equal(run.calls[1][1], owner);
  assert.equal(run.calls[2][1], owner);
  // #3668: the platform's actions are written ONLY by this step, as the owner, never by the running server.
  assert.equal(run.calls[3][1], owner);
  assert.equal(run.calls[4][1], owner);
  assert.equal(run.calls[5][1], serve);
  assert.equal(run.calls[5][2], 'unset');
  noSecrets(run);
});
for (const migrate of [null, '']) test(`missing/empty migrator falls back loudly (${JSON.stringify(migrate)})`, t => {
  const run = boot(t, { migrate });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /db\.runtime_role\.owner_serving/);
  assert(run.calls.every(row => row[1] === serve));
  noSecrets(run);
});
for (const step of ['prisma generate', 'prisma migrate deploy', 'tsx scripts/db/revoke-runtime-migrations.ts', 'tsx scripts/db/upsert-actions.ts']) {
  test(`${step} failure stops boot and redacts command output`, t => {
    const run = boot(t, { fail: step });
    assert.notEqual(run.status, 0);
    assert.equal(run.calls.at(-1)?.[0], step);
    assert(!run.calls.some(row => row[0] === 'tsx src/index.ts'));
    noSecrets(run);
  });
}
// #3770: a migration whose preflight refuses on data must not stop boot; everything else still does.
const refusedName = '20261027193000_team_chat_seq_unique';
test('#3770: a refused preflight (P3018) is rolled back as owner, alarmed once, and the server starts', t => {
  const run = boot(t, { fail: 'prisma migrate deploy', failCode: 'P3018', helperOut: refusedName });
  assert.equal(run.status, 0, run.stderr);
  const rows = run.calls.map(row => row[0]);
  assert(rows.includes(`prisma migrate resolve --rolled-back ${refusedName}`));
  assert.equal(rows.filter(row => row === 'prisma migrate deploy').length, 1, 'a refusal is not retried in the same boot');
  assert.equal(run.calls.find(row => row[0].startsWith('prisma migrate resolve'))[1], owner);
  assert.equal(run.calls.at(-1)[0], 'tsx src/index.ts');
  assert.equal(run.calls.at(-1)[3], refusedName, 'the server is told which migration was refused');
  assert.equal(run.stderr.match(/^db\.migration\.refused_preflight migration=\S+/gm).length, 1);
  assert.match(run.stderr, new RegExp(`db\\.migration\\.refused_preflight migration=${refusedName} `));
  noSecrets(run);
});
test('#3770: a clean boot passes no refusal to the server, whatever the outside environment says', t => {
  process.env.HADRON_MIGRATIONS_REFUSED = '20260101000000_outside';
  t.after(() => { delete process.env.HADRON_MIGRATIONS_REFUSED; });
  const run = boot(t);
  assert.equal(run.calls.at(-1)[3], 'unset');
});
test('#3770: a failure other than P3018/P3009 stops boot even if the ledger names a refused migration', t => {
  const run = boot(t, { fail: 'prisma migrate deploy', failCode: 'P1001', helperOut: refusedName });
  assert.notEqual(run.status, 0);
  assert(!run.calls.some(row => row[0].startsWith('prisma migrate resolve') || row[0] === 'tsx src/index.ts'));
  noSecrets(run);
});
test('#3770: a P3018 the ledger does not classify as a refusal (helper prints nothing) stops boot', t => {
  const run = boot(t, { fail: 'prisma migrate deploy', failCode: 'P3018' });
  assert.notEqual(run.status, 0);
  assert(!run.calls.some(row => row[0].startsWith('prisma migrate resolve') || row[0] === 'tsx src/index.ts'));
  noSecrets(run);
});
for (const bad of ['x; rm -rf /', '$(id)', '2026_short', '20261027193000_ok\n../../etc']) {
  test(`#3770: a helper line that is not a migration name stops boot (${JSON.stringify(bad)})`, t => {
    const run = boot(t, { fail: 'prisma migrate deploy', failCode: 'P3018', helperOut: bad });
    assert.notEqual(run.status, 0);
    assert(!run.calls.some(row => row[0].startsWith('prisma migrate resolve') || row[0] === 'tsx src/index.ts'));
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

for (const serving of [null, '']) test(`missing/empty serving DATABASE_URL refuses before any setup (${JSON.stringify(serving)})`, t => {
  const run = boot(t, { serving });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /db\.runtime_role\.database_url_missing/);
  assert.deepEqual(run.calls, []);
  noSecrets(run);
});
test('a P1001 line carrying the URL and password reports only the code', t => {
  const run = boot(t, { fail: 'prisma migrate deploy', failLine: `Can't reach database server at ${owner} (migrate-fixture-password)` });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /^db\.runtime_role\.migrate_failed exit=42 prisma=P1001$/m);
  noSecrets(run);
});

// HUP/QUIT are catchable: an untrapped one kills the shell before the EXIT trap
// runs and leaves the private raw log behind. Deliver each signal to the shell
// while a setup command is mid-flight, release the child, and require the
// conventional status and no leftover startup output. Both dash and the Alpine
// busybox ash are exercised; a shell that is not installed is skipped loudly.
const shells = [['dash', ['dash']], ['busybox-ash', ['busybox', 'sh']]]
  .filter(([, cmd]) => spawnSync('sh', ['-c', `command -v ${cmd[0]}`]).status === 0);
for (const [name, cmd] of shells) {
  for (const [signal, status] of [['HUP', 129], ['QUIT', 131], ['INT', 130], ['TERM', 143]]) {
    test(`${name}: ${signal} during setup exits ${status} and removes the private log`, async t => {
      const dir = mkdtempSync(join(tmpdir(), 'docker-start-signal-'));
      const ready = join(dir, 'ready'), release = join(dir, 'release'), calls = join(dir, 'calls');
      writeFileSync(join(dir, 'pnpm'), `#!/bin/sh
printf '%s\\n' "$*" >> "$CALL_LOG"
printf '%s\\n' "$DATABASE_URL"
: > "$READY"
n=0
while [ ! -e "$RELEASE" ] && [ "$n" -lt 400 ]; do sleep 0.05; n=$((n + 1)); done
`, { mode: 0o700 });
      const child = spawn(cmd[0], [...cmd.slice(1), entrypoint], { stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DATABASE_URL: serve, MIGRATE_DATABASE_URL: owner,
          TMPDIR: dir, CALL_LOG: calls, READY: ready, RELEASE: release } });
      // Bounded cleanup: never leave the shell or its fake setup command running.
      t.after(() => { child.kill('SIGKILL'); writeFileSync(release, ''); rmSync(dir, { recursive: true, force: true }); });
      let output = '';
      child.stdout.on('data', d => { output += d; });
      child.stderr.on('data', d => { output += d; });
      const exited = new Promise(resolve => child.on('exit', (code, sig) => resolve({ code, sig })));
      for (let i = 0; i < 200 && !existsSync(ready); i++) await new Promise(r => setTimeout(r, 25));
      assert(existsSync(ready), 'setup command never started');
      assert(readdirSync(dir).some(n => n.startsWith('hadron-start.')), 'private log should exist mid-setup');
      child.kill(`SIG${signal}`);
      writeFileSync(release, '');
      const { code, sig } = await Promise.race([exited, new Promise((_, rej) => setTimeout(() => rej(new Error('shell did not exit')), 10000))]);
      assert.equal(sig, null, `shell died on the signal instead of trapping it`);
      assert.equal(code, status);
      assert(!readdirSync(dir).some(n => n.startsWith('hadron-start.')), 'private startup output was not cleaned up');
      assert(!output.includes('fixture-password'), 'startup output disclosed a fixture credential');
      assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, 1, 'boot continued after the signal');
    });
  }
}
test('the signal lifecycle tests ran under at least dash', () => {
  assert(shells.some(([name]) => name === 'dash'), 'dash is required for the entrypoint shell checks');
});
