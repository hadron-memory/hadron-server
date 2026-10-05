import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
test('initialized DB refuses before Prisma, SQL mutation, or key generation', t => {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-startup-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'calls');
  writeFileSync(join(dir, 'psql'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\necho t\n`, { mode: 0o700 });
  for (const cmd of ['node', 'pnpm']) writeFileSync(join(dir, cmd), '#!/bin/sh\necho unexpected-work >&2\nexit 99\n', { mode: 0o700 });
  const run = spawnSync('sh', [fileURLToPath(new URL('./entrypoint.sh', import.meta.url))], {
    encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DATABASE_URL: 'postgresql://fixture@db/e2e' },
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /already initialized; reset with scoped stack.sh down, then up/);
  assert(!run.stderr.includes('unexpected-work'));
  const calls = readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(calls.length, 1);
  assert(calls[0].includes('SELECT EXISTS'));
  assert(!calls[0].includes(' -f '));
});
