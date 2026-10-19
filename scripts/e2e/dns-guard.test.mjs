import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const guard = fileURLToPath(new URL('./dns-guard.sh', import.meta.url));

// A fake `incus exec`: getent answers only from the Nth probe on (the instance
// "boots"), and the resolver write fails with the exact boot-race text until
// the instance is up: /etc/resolv.conf is a symlink into /run, which does not
// exist for the first second.
function run(t, { upAfterProbes, seedFailsUntilUp = true, env = {} }) {
  const root = mkdtempSync(join(tmpdir(), 'hadron-dns-guard-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'); mkdirSync(bin);
  const counter = join(root, 'probes');
  writeFileSync(counter, '0');
  writeFileSync(join(bin, 'incus'), `#!/bin/sh
# usage: incus exec NAME -- CMD...
shift 3
n=$(cat "${counter}")
case "$1" in
  getent) n=$((n+1)); echo "$n" > "${counter}"; [ "$n" -ge ${upAfterProbes} ] && exit 0; exit 2 ;;
  sh) n=$(cat "${counter}"); if [ "$n" -lt ${upAfterProbes} ] && [ "${seedFailsUntilUp}" = true ]; then
        echo 'sh: 1: cannot create /etc/resolv.conf: Directory nonexistent' >&2; exit 2; fi
      echo seeded >> "${root}/seeded"; exit 0 ;;
esac
exit 99
`, { mode: 0o700 });
  const r = spawnSync('bash', ['-c', `set -euo pipefail; . "${guard}"; e2e_dns_guard fixture`], {
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, E2E_DNS_POLL_SECONDS: '0', E2E_DNS_SEED_AFTER: '3', E2E_DNS_WAIT_PROBES: '12', ...env },
  });
  return { r, probes: Number(readFileSync(counter, 'utf8')) };
}

test('DNS guard survives the first-second boot race (seed fails before the instance is up)', t => {
  const { r } = run(t, { upAfterProbes: 5 });
  assert.equal(r.status, 0, `guard exited ${r.status}: ${r.stderr}`);
});

test('DNS guard does not need to seed when the resolver comes up by itself', t => {
  const { r } = run(t, { upAfterProbes: 2 });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /seeding 1\.1\.1\.1/);
});

test('DNS guard fails loud when DNS never answers', t => {
  const { r } = run(t, { upAfterProbes: 9999 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /DNS not answering/);
});
