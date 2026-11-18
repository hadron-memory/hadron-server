// #4448: run.sh bakes DIAG_SESSION_CAP into the staged compose as a literal (stack.sh forwards only
// E2E_* across the Incus boundary, so ${DIAG_SESSION_CAP:-25} would interpolate to the default) and
// runs the load generator inside the app container, never on the shared host. Real run.sh, synthetic
// boundary adapters (fake git/incus/node on PATH) — the runner2619 pattern; no stack or container.
import { test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const LOAD_LINE = '{"kind":"load","workload":"held","cap":100,"startAt":0,"endAt":0,"ok":101,"probe":{"method":"tools/list","requests":7,"errors":0,"minMs":1,"p50Ms":1,"p95Ms":1,"p99Ms":1,"maxMs":1}}';

function fixture(mode) {
  const dir = mkdtempSync(join(tmpdir(), 'gloria-run4448-'));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  const put = (name, body) => writeFileSync(join(bin, name), '#!/bin/bash\nset -eu\n' + body, { mode: 0o755 });
  // The compose fixture carries exactly what compose.patch would leave in the staged compose;
  // the 'missing' variant omits the MCP line to prove the run refuses rather than measuring 25.
  const compose = '      GRAPHS_PATH: /private\n' + (mode === 'missing' ? '' : '      MCP_MAX_SESSIONS_PER_PRINCIPAL: ${DIAG_SESSION_CAP:-25}\n');
  writeFileSync(join(dir, 'compose.fixture'), compose);
  put('git', `if [ "\${1:-}" = -C ]; then shift 2; fi
case "$1" in
 rev-parse) echo "$FIXTURE";;
 worktree) if [ "$2" = add ]; then mkdir -p "$4/scripts/e2e"; cp "$FIXTURE/stack.sh" "$4/scripts/e2e/stack.sh"; cp "$FIXTURE/compose.fixture" "$4/scripts/e2e/compose.yaml"; fi;;
 apply|add) :;;
 *) exit 8;;
esac\n`);
  // A recording sleep: the settle gate is observable as the number of sleeps of the settle length.
  put('sleep', `printf '%s\\n' "$1" >> "$FIXTURE/sleeps"\n`);
  put('node', `exec '${process.execPath}' "$@"\n`);
  put('incus', `case "$1" in
 list) [ ! -e "$FIXTURE/instance" ] || echo hadron-e2e-fixture;;
 config) cat "$FIXTURE/instance";;
 exec)
  case "$*" in
   *snapshot.mjs*) printf '%s\\n' '{"totals":{"nodes":1,"selfSize":1,"rowsOmitted":0},"rows":[]}';;
   *"command -v timeout"*) [ "$MODE" != notimeout ] || exit 1;;
   *load.mjs*) printf '%s\\n' "$*" > "$FIXTURE/load-invocation"
    case "$MODE" in
     timeout) exit 124;;
     empty) exit 0;;
    esac
    printf '%s\\n' '${LOAD_LINE}'; [ "$MODE" != fail ] || exit 5;;
   *memory.max*) echo 6442450944;;
   *diagnose-samples.jsonl*) printf '{"kind":"sample","at":%s}\\n' "$(date +%s%3N)";;
   *credentials.json*) echo synthetic-private-key;;
   *pg_stat_activity*) echo 2;;
   *health*) while [ "$1" != app ]; do shift; done; shift; NODE_OPTIONS="--import $FIXTURE/health.mjs" "$@";;
  esac;;
 *) exit 8;;
esac\n`);
  writeFileSync(join(dir, 'stack.sh'), `#!/bin/bash
set -eu
state="$XDG_STATE_HOME/hadron-e2e/hadron-e2e-fixture"
case "$1" in
 up) mkdir "$state"; echo incus > "$state/backend"; cp "$(dirname "$0")/compose.yaml" "$FIXTURE/staged-compose.yaml";
     printf '%s\\n' "$DIAG_RUN_TOKEN" > "$state/diagnose-owner"; printf '%s\\n' "$DIAG_RUN_TOKEN" > "$FIXTURE/instance";;
 down) echo down >> "$FIXTURE/down"; rm -rf "$state"; rm "$FIXTURE/instance";;
 logs) echo private-log;;
esac\n`, { mode: 0o755 });
  writeFileSync(join(dir, 'health.mjs'), "globalThis.fetch=async()=>({ok:true});\n");
  const env = { ...process.env, FIXTURE: dir, MODE: mode, PATH: bin + ':' + process.env.PATH,
    TMPDIR: dir, XDG_STATE_HOME: join(dir, 'state'), DIAG_OUT: join(dir, 'samples'), DIAG_IDLE_S: '0.01', DIAG_SETTLE_S: '0.01', E2E_BACKEND: 'incus',
    DIAG_SESSION_CAP: mode === 'range' ? '1001' : '100', DIAG_PROBE_N: '7' };
  const args = [join(here, 'run.sh'), 'fixture', '41001', '41002', 'held', '1'];
  return { dir, env, args, run: () => spawnSync('bash', args, { env, encoding: 'utf8', timeout: 20_000 }), clean: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a requested cap is baked into the staged compose as a literal and reaches the run record', () => {
  const f = fixture('cap');
  try {
    const r = f.run();
    expect(r.status, r.stderr).toBe(0);
    // stack.sh forwards only E2E_* across the Incus boundary: the literal, not ${DIAG_SESSION_CAP:-25}.
    expect(readFileSync(join(f.dir, 'staged-compose.yaml'), 'utf8')).toContain("MCP_MAX_SESSIONS_PER_PRINCIPAL: '100'");
    const out = readFileSync(join(f.dir, 'samples'), 'utf8');
    expect(out).toContain('"kind":"load"');
    expect(out).toContain('"kind":"perSession"');
    expect(out).toContain('pg_activity');
    expect(readFileSync(join(f.dir, 'down'), 'utf8')).toBe('down\n');
  } finally { f.clean(); }
});

test('the load generator runs inside the app container with only non-secret arguments', () => {
  const f = fixture('cap');
  try {
    expect(f.run().status).toBe(0);
    const inv = readFileSync(join(f.dir, 'load-invocation'), 'utf8');
    expect(inv).toContain('/app/scripts/e2e/diagnose/load.mjs');      // the staged overlay copy, in-container
    expect(inv).toContain('http://127.0.0.1:4000');                    // the app container's loopback server
    expect(inv).not.toContain(':41001');                               // never the host-published api port
    expect(inv).toContain('timeout "$6"');                             // the wall guard runs in-container
    expect(inv).toContain(' 100 7 held 1 301');                        // cap, probe, workload, duration, budget as sh args
    expect(inv).toContain('/fixtures/credentials.json');               // the key is read in-container, not exported
  } finally { f.clean(); }
});

test('a staged compose without the cap line refuses loudly instead of silently measuring 25', () => {
  const f = fixture('missing');
  try {
    const r = f.run();
    expect(r.status).toBe(4);
    expect(r.stderr).toContain('substitution failed');
    expect(existsSync(join(f.dir, 'instance'))).toBe(false);   // no stack came up
    expect(existsSync(join(f.dir, 'staged-compose.yaml'))).toBe(false);
    expect(existsSync(join(f.dir, 'down'))).toBe(false);       // nothing to tear down
  } finally { f.clean(); }
});

test.each(['0', '1001', '-5', 'abc'])('a cap of %j is refused before any reservation or staging', (cap) => {
  const f = fixture('range');
  try {
    f.env.DIAG_SESSION_CAP = cap;
    const r = spawnSync('bash', f.args, { env: f.env, encoding: 'utf8', timeout: 20_000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('DIAG_SESSION_CAP must be an integer 1..1000');
    expect(existsSync(join(f.dir, 'state'))).toBe(false);
    expect(existsSync(join(f.dir, 'load-invocation'))).toBe(false);
  } finally { f.clean(); }
});

// #4453 BLIND P3: 0100 is decimal 100, not an octal-looking literal baked into the compose.
test('a zero-padded cap is normalised to decimal before it is baked', () => {
  const f = fixture('cap');
  try {
    f.env.DIAG_SESSION_CAP = '0100';
    expect(f.run().status).toBe(0);
    expect(readFileSync(join(f.dir, 'staged-compose.yaml'), 'utf8')).toContain("MCP_MAX_SESSIONS_PER_PRINCIPAL: '100'");
    expect(readFileSync(join(f.dir, 'load-invocation'), 'utf8')).toContain(' 100 7 held 1 301');
  } finally { f.clean(); }
});

// #4453 BLIND P2: under set -e the load-line assignment used to abort before anything was echoed or
// persisted — the counts that explain an invalid run (here: acceptance exit 5) were lost.
test('a failed load generator propagates its exit AND keeps the line that explains it', () => {
  const f = fixture('fail');
  try {
    const r = f.run();
    expect(r.status).toBe(5);
    expect(r.stderr).toContain('load generator exited 5');
    expect(r.stderr).toContain('"kind":"load"');          // echoed before the exit
    expect(r.stderr).toContain('failure logs kept privately');   // the trap kept raw logs
    const out = readFileSync(join(f.dir, 'samples'), 'utf8');   // preserved samples + the re-appended line
    expect(out).toContain('"kind":"sample"');
    expect(out).toContain('"kind":"load"');
    expect(readFileSync(join(f.dir, 'down'), 'utf8')).toBe('down\n');   // teardown still ran
  } finally { f.clean(); }
});

test('a failed run does not duplicate a load line already in the preserved samples', () => {
  const f = fixture('fail');
  try {
    f.run();
    const out = readFileSync(join(f.dir, 'samples'), 'utf8');
    expect(out.split('\n').filter((l) => l.includes('"kind":"load"')).length).toBe(1);
  } finally { f.clean(); }
});

// #4453 N3: no line means no counts; the message must not claim the counts above explain it.
test('a wall-budget timeout (124) with no line says there are no counts', () => {
  const f = fixture('timeout');
  try {
    const r = f.run();
    expect(r.status).toBe(124);
    expect(r.stderr).toContain('wall-clock budget (exit 124)');
    expect(r.stderr).not.toContain('counts above');
  } finally { f.clean(); }
});

// #4453 N4: exit 0 with an empty line must not reach report.mjs with nothing to read.
test('exit 0 with no load line is an invalid run, not a pass', () => {
  const f = fixture('empty');
  try {
    const r = f.run();
    expect(r.status).toBe(5);
    expect(r.stderr).toContain('printed no load line');
    expect(readFileSync(join(f.dir, 'down'), 'utf8')).toBe('down\n');
  } finally { f.clean(); }
});

// #4453 P3 #15: the in-container prerequisites are checked before the settle window, not after.
test('a missing timeout(1) or staged load.mjs refuses before any settling', () => {
  const f = fixture('notimeout');
  try {
    const r = f.run();
    expect(r.status).toBe(4);
    expect(r.stderr).toContain('lacks timeout(1)');
    expect(existsSync(join(f.dir, 'load-invocation'))).toBe(false);
    expect(existsSync(join(f.dir, 'sleeps'))).toBe(false);
    expect(readFileSync(join(f.dir, 'down'), 'utf8')).toBe('down\n');
  } finally { f.clean(); }
});

// Bronwyn's survivor: the extra pre-settle sleep is gated on DIAG_SNAPSHOTS=1 / DIAG_W2=1.
test('the pre-settle idle runs only when snapshots or W2 perturb the stack', () => {
  const settles = (extra) => {
    const f = fixture('cap');
    try {
      Object.assign(f.env, { DIAG_SETTLE_S: '7' }, extra);
      const r = f.run();
      expect(r.status, r.stderr).toBe(0);
      return readFileSync(join(f.dir, 'sleeps'), 'utf8').split('\n').filter((x) => x === '7').length;
    } finally { f.clean(); }
  };
  expect(settles({})).toBe(1);                         // the settle window before the load only
  expect(settles({ DIAG_SNAPSHOTS: '1' })).toBe(2);    // plus the idle past the snapshot
});
