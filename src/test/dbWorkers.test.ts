/**
 * #1091 — the per-worker DB URL, and specifically the connection-pool bound.
 *
 * This is test plumbing testing test plumbing, which is worth justifying. The
 * bound is invisible when it works: nothing fails, no output mentions it, and
 * its only observable effect is a flake that DOESN'T happen. That is exactly
 * the kind of thing a later "this query param looks unnecessary" cleanup
 * removes — and the symptom would come back as somebody else's timeout, in a
 * different test, weeks later. Pin it where the reason is written down.
 */
import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { Client as PgClient } from 'pg';
import { spawnSync } from 'node:child_process';
import {
  workerDbUrl,
  workerDbName,
  baseDbName,
  maintenanceUrl,
  testRunId,
  testRunScope,
  runTemplateDbName,
  parseWorkerDbName,
  isRunAlive,
  templateLockKey,
  createDatabaseFromTemplate,
  quoteDbIdent,
  isLocalDbHost,
  runTemplateUrl,
  PARALLEL_DBS,
  WORKER_CONNECTION_LIMIT,
  testMaxWorkers,
} from './dbWorkers.js';

const ORIGINAL = process.env.TEST_DATABASE_URL;
const ORIGINAL_RUN = process.env.HADRON_TEST_RUN_ID;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.TEST_DATABASE_URL;
  else process.env.TEST_DATABASE_URL = ORIGINAL;
  // workerDbUrl reads the run id, so a case that pins a name must be able to
  // set one without leaking it into the next.
  if (ORIGINAL_RUN === undefined) delete process.env.HADRON_TEST_RUN_ID;
  else process.env.HADRON_TEST_RUN_ID = ORIGINAL_RUN;
  vi.resetModules();
});

describe('workerDbUrl', () => {
  it('points at the worker clone AND carries the pool bound', () => {
    process.env.TEST_DATABASE_URL = 'postgresql://holger@localhost:5432/hadron_test';
    process.env.HADRON_TEST_RUN_ID = '4242';
    const u = new URL(workerDbUrl(3));
    expect(u.pathname).toBe(`/hadron_test_r${testRunScope()}_p4242_3`);
    // Asserted against the imported constant, NOT a hard-coded 5 (PR #1125
    // review, Codex P2). Hard-coding it would make `HADRON_TEST_CONNECTION_LIMIT=9
    // pnpm test` fail this test — so the override this PR advertises could not
    // be used for a full run, which is the only run anyone would want it for.
    // A test that forbids a documented knob is worse than no test.
    expect(u.searchParams.get('connection_limit')).toBe(String(WORKER_CONNECTION_LIMIT));
  });

  it('treats a BLANK connection_limit as absent, not as an operator choice', () => {
    // `?connection_limit=$VAR` with $VAR unset — how it actually arrives from a
    // script. `has()` is true and the value means nothing; deferring to it hands
    // the pool back to Prisma's unbounded default and reintroduces the flake.
    process.env.TEST_DATABASE_URL =
      'postgresql://holger@localhost:5432/hadron_test?connection_limit=';
    expect(new URL(workerDbUrl(1)).searchParams.get('connection_limit')).toBe(
      String(WORKER_CONNECTION_LIMIT),
    );
  });

  it('does NOT override a connection_limit the operator set explicitly', () => {
    // A knob that silently ignores what you set is not a knob. Someone
    // debugging pool behaviour must be able to pin it from the environment.
    process.env.TEST_DATABASE_URL =
      'postgresql://holger@localhost:5432/hadron_test?connection_limit=17';
    expect(new URL(workerDbUrl(1)).searchParams.get('connection_limit')).toBe('17');
  });

  it('leaves the maintenance URL unpooled — it is a bare pg.Client', () => {
    process.env.TEST_DATABASE_URL = 'postgresql://holger@localhost:5432/hadron_test';
    const u = new URL(maintenanceUrl());
    expect(u.pathname).toBe('/postgres');
    expect(u.searchParams.has('connection_limit')).toBe(false);
  });

  it('STRIPS an inherited connection_limit from the maintenance URL', () => {
    // The previous test passes trivially when the base URL never had one; this
    // is the case that actually exercises the strip.
    process.env.TEST_DATABASE_URL =
      'postgresql://holger@localhost:5432/hadron_test?connection_limit=17';
    expect(new URL(maintenanceUrl()).searchParams.has('connection_limit')).toBe(false);
  });

  it('derives the clone name from the base DB', () => {
    process.env.TEST_DATABASE_URL = 'postgresql://holger@localhost:5432/hadron_test';
    expect(baseDbName()).toBe('hadron_test');
    expect(workerDbName(7, 'hadron_test', '99')).toBe(`hadron_test_r${testRunScope()}_p99_7`);
  });
});

/**
 * #1091 — the run scope. These pin the property the old name did NOT have:
 * that two runs cannot land on the same database. The old name was
 * `<base>_<VITEST_POOL_ID>`, and a pool id restarts at 1 every run, so two
 * suites on one machine deleted from each other's tables mid-test while the
 * loser's failure pointed at `cleanDb` and read as somebody's diff.
 */
describe('run scoping', () => {
  const ORIGINAL_RUN_ID = process.env.HADRON_TEST_RUN_ID;
  afterEach(() => {
    if (ORIGINAL_RUN_ID === undefined) delete process.env.HADRON_TEST_RUN_ID;
    else process.env.HADRON_TEST_RUN_ID = ORIGINAL_RUN_ID;
  });

  it('gives two runs different databases for the SAME pool id', () => {
    expect(workerDbName(1, 'hadron_test', '100')).not.toBe(
      workerDbName(1, 'hadron_test', '200'),
    );
  });

  it('gives two runs different TEMPLATES, not just different clone names', () => {
    // Run-scoped names alone left the base template shared, so a suite from
    // another checkout could rewrite the constraints between our DDL and our
    // first worker clone — and the bad outcome is not a crash, it is passing
    // against a schema this branch never wrote (#1136 review, Codex P1).
    expect(runTemplateDbName('100', 'hadron_test')).toBe(`hadron_test_r${testRunScope()}_p100_tpl`);
    expect(runTemplateDbName('100', 'hadron_test')).not.toBe(
      runTemplateDbName('200', 'hadron_test'),
    );
  });

  it('never collides a run template with a worker clone of the same run', () => {
    expect(runTemplateDbName('100', 'hadron_test')).not.toBe(
      workerDbName(1, 'hadron_test', '100'),
    );
  });

  it('refuses a non-numeric pool id, which could BUILD the template name', () => {
    // `tpl` is a legal string and would produce this run's template name,
    // handing the worker the database every other worker clones from — the
    // isolation loss this change exists to prevent, in its quietest form
    // (@copilot, #1136). Second collision path between the two name-spaces
    // after truncation; both are silent, so both are guarded.
    expect(() => workerDbName('tpl', 'hadron_test', '100')).toThrow(/must be numeric/);
    expect(() => workerDbName('1a', 'hadron_test', '100')).toThrow(/must be numeric/);
    expect(workerDbName('2', 'hadron_test', '100')).toBe(`hadron_test_r${testRunScope()}_p100_2`);
  });

  it('refuses a name Postgres would silently TRUNCATE', () => {
    // Verified against a real server: `CREATE DATABASE "<64+ bytes>"` emits a
    // NOTICE and creates the 63-byte prefix. With a long enough base,
    // `…_r<runId>_1` and `…_r<runId>_tpl` truncate to the SAME identifier — the
    // worker's CREATE then fails 42P04, perWorkerDb reads that as a benign
    // create race, and the worker silently shares the run template with every
    // other worker. Loud beats a fallback (#1136 review, Codex P2).
    const tooLong = 'z'.repeat(60);
    expect(() => workerDbName(1, tooLong, '99999')).toThrow(/63-byte limit/);
    expect(() => runTemplateDbName('99999', tooLong)).toThrow(/63-byte limit/);
  });

  it('counts BYTES, not characters', () => {
    // The limit is NAMEDATALEN. A name of 40 multi-byte characters fits the
    // character count and not the byte count.
    const multibyte = 'é'.repeat(40);
    expect(Buffer.byteLength(multibyte, 'utf8')).toBeGreaterThan(63);
    expect(() => workerDbName(1, multibyte, '1')).toThrow(/63-byte limit/);
  });

  it('accepts a name that exactly fits', () => {
    // 63 bytes is legal; the guard must not be off by one and reject a working
    // configuration.
    const base = 'b'.repeat(63 - `_r${testRunScope()}_p7_1`.length);
    expect(workerDbName(1, base, '7')).toHaveLength(63);
  });

  it.each([undefined, '', 'abc', '12x'])(
    'throws rather than falling back when the run id is %s',
    (bad) => {
      // A fallback would silently rebuild the shared name-space this exists to
      // remove, and it would present as the original flake rather than as a
      // configuration error.
      if (bad === undefined) delete process.env.HADRON_TEST_RUN_ID;
      else process.env.HADRON_TEST_RUN_ID = bad;
      expect(() => testRunId()).toThrow(/HADRON_TEST_RUN_ID/);
    },
  );
});

describe('parseWorkerDbName', () => {
  it('reads a run-scoped clone', () => {
    expect(parseWorkerDbName('hadron_test_r512_3', 'hadron_test')).toEqual({
      datname: 'hadron_test_r512_3',
      runId: '512',
      poolId: '3',
      scope: null, runToken: null,
    });
  });

  it('reads a run TEMPLATE, so the same orphan sweep collects it', () => {
    // The run template is garbage after a crash in exactly the way a worker
    // clone is; giving it its own shape would have meant a second sweep, and a
    // second sweep is a second thing to forget.
    expect(parseWorkerDbName('hadron_test_r512_tpl', 'hadron_test')).toEqual({
      datname: 'hadron_test_r512_tpl',
      runId: '512',
      poolId: 'tpl',
      scope: null, runToken: null,
    });
  });

  it('still recognizes a LEGACY unscoped clone', () => {
    // A checkout from before this change still creates these, and a machine
    // running both will have both — cleanup has to be able to see the old ones.
    expect(parseWorkerDbName('hadron_test_3', 'hadron_test')).toEqual({
      datname: 'hadron_test_3',
      runId: null,
      poolId: '3',
      scope: null, runToken: null,
    });
  });

  it.each([
    'hadron_test', // the template itself
    'hadron_test_objtype', // a real hand-made DB on this box
    'hadron_test_a',
    'hadron_test_r512', // scoped prefix, no pool id
    'hadron_test_rx_1',
    'hadron_testX_1', // prefix is `<base>_`, not `<base>`
    'other_test_1',
  ])('refuses to claim %s', (name) => {
    expect(parseWorkerDbName(name, 'hadron_test')).toBeNull();
  });

  it('cannot over-match a base name carrying regex metacharacters', () => {
    // Matching happens in JS, not a SQL regex, precisely so `.` stays a literal
    // — the alternative drops an unrelated database.
    expect(parseWorkerDbName('haXron_test_r1_1', 'ha.ron_test')).toBeNull();
  });
});

describe('isRunAlive', () => {
  it('reports THIS process as alive', () => {
    expect(isRunAlive(String(process.pid))).toBe(true);
  });

  it('reports an unassignable pid as dead', () => {
    // pid 0 is not a process you can address; `kill(0, 0)` addresses the
    // process GROUP, which would answer "alive" and make every orphan sweep a
    // no-op — so it is rejected before it reaches process.kill.
    expect(isRunAlive('0')).toBe(false);
    expect(isRunAlive('-1')).toBe(false);
    expect(isRunAlive('nope')).toBe(false);
  });

  it('reports a dead pid as dead', () => {
    // A pid observed to have EXITED, not a large number assumed to be unused
    // (@copilot, #1136). The first version used 2^22 as "above every default
    // pid_max" — true on macOS (99999), false on Linux, whose default pid_max
    // IS 4194304. So on CI it could name a live process and this would flake,
    // in the test whose job is proving the orphan sweep can tell dead from
    // alive. Spawning and reaping a child gives a pid that is dead by
    // construction on every platform.
    const child = spawnSync(process.execPath, ['-e', '']);
    expect(child.pid).toBeGreaterThan(0);
    expect(isRunAlive(String(child.pid))).toBe(false);
  });
});

describe('isLocalDbHost', () => {
  it.each([
    'postgresql://holger@localhost:5432/hadron_test',
    'postgresql://holger@127.0.0.1:5432/hadron_test',
    'postgresql://holger@db.localhost:5432/hadron_test',
  ])('accepts %s', (url) => {
    expect(isLocalDbHost(url)).toBe(true);
  });

  it.each([
    'postgresql://holger@db.internal:5432/hadron_test',
    'postgresql://holger@10.0.0.5:5432/hadron_test',
  ])('rejects %s', (url) => {
    // A run id is this machine's pid, and cleanup DROPs on the strength of one.
    // Two containers on a shared server both run as pid 1 and claim the same
    // clone names; a foreign pid reads as dead and would be force-dropped under
    // a live run (@codex, #1136). Parallel mode refuses rather than guessing.
    expect(isLocalDbHost(url)).toBe(false);
  });
});

describe('runTemplateUrl', () => {
  it('points at the run template and carries no pool bound', () => {
    // The template is provisioned over ONE short-lived connection, so a
    // connection_limit inherited from TEST_DATABASE_URL would be noise in a
    // connection string somebody later debugs — same reasoning as maintenanceUrl.
    process.env.TEST_DATABASE_URL =
      'postgresql://holger@localhost:5432/hadron_test?connection_limit=17';
    const u = new URL(runTemplateUrl('77'));
    expect(u.pathname).toBe(`/hadron_test_r${testRunScope()}_p77_tpl`);
    expect(u.searchParams.has('connection_limit')).toBe(false);
  });
});

describe('quoteDbIdent', () => {
  it('doubles an embedded quote instead of breaking the statement', () => {
    // CREATE/DROP DATABASE cannot take a bind parameter, so the name is
    // interpolated. The run and pool halves are code-derived; the BASE comes
    // from TEST_DATABASE_URL, which the old "identifier is code-derived"
    // comments waved away (@copilot, #1136).
    expect(quoteDbIdent('hadron_test')).toBe('"hadron_test"');
    expect(quoteDbIdent('we"ird')).toBe('"we""ird"');
  });
});

describe('templateLockKey', () => {
  it('is a stable positive integer a pg bigint accepts', () => {
    const k = templateLockKey('hadron_test');
    expect(k).toBe(templateLockKey('hadron_test'));
    expect(Number.isInteger(k)).toBe(true);
    expect(k).toBeGreaterThanOrEqual(0);
    expect(k).toBeLessThanOrEqual(0x7fffffff);
  });

  it('differs per template, so a private TEST_DATABASE_URL never waits on the shared one', () => {
    expect(templateLockKey('hadron_test')).not.toBe(templateLockKey('hadron_test_mine'));
  });
});

describe('HADRON_TEST_CONNECTION_LIMIT', () => {
  const withLimit = async (value: string | undefined) => {
    vi.resetModules();
    if (value === undefined) delete process.env.HADRON_TEST_CONNECTION_LIMIT;
    else process.env.HADRON_TEST_CONNECTION_LIMIT = value;
    return import('./dbWorkers.js');
  };

  afterEach(() => {
    delete process.env.HADRON_TEST_CONNECTION_LIMIT;
  });

  it('defaults to 5', async () => {
    const m = await withLimit(undefined);
    expect(m.WORKER_CONNECTION_LIMIT).toBe(5);
  });

  it('honours a valid override', async () => {
    const m = await withLimit('9');
    expect(m.WORKER_CONNECTION_LIMIT).toBe(9);
  });

  it.each(['0', '-1', 'five', '2.5'])('throws on %s rather than falling back', async (bad) => {
    // Loud, not lenient. A silent fallback here restores the unbounded default
    // and presents as an unrelated test timing out — the failure this whole
    // change exists to remove, wearing a typo as a disguise.
    await expect(withLimit(bad)).rejects.toThrow(/positive integer/);
  });
});

/**
 * #1136 review (Codex P2): a developer's psql or GUI session against the test
 * database blocks `CREATE DATABASE ... TEMPLATE`. The handling used to live at
 * the worker-clone site only, so globalSetup's snapshot aborted setup outright.
 *
 * These touch a real server because the behaviour under test IS the server's:
 * Postgres does not fail a busy-source clone immediately, it blocks ~8s first,
 * which is what made an attempt-counted budget report a fabricated elapsed time.
 */
// Skipped under HADRON_TEST_PARALLEL=0: this exercises the PARALLEL path's
// plumbing, and serial mode creates no run template to source a private probe
// from. It cannot fall back to the base database either — in serial mode the
// suite IS connected to the base, so cloning from it would block forever, which
// is the 55006 case these very tests cover.
describe.skipIf(!PARALLEL_DBS)('createDatabaseFromTemplate (live pg)', () => {
  const url = maintenanceUrl();
  const made: string[] = [];
  let admin: PgClient | undefined;
  // A template PRIVATE to this test, not the shared `hadron_test` (@copilot,
  // #1136). The busy-source case below deliberately holds a session on the
  // template for the duration — against the shared base that would block a
  // concurrent run's snapshot for ~8s, which is precisely the cross-run
  // contention this PR removes. A test that reintroduces the hazard it is
  // testing the fix for is worse than no test.
  //
  // Sourced from THIS RUN's template, and named outside the worker-clone shape
  // so no orphan sweep can claim it.
  const template = `hadron_test_probesrc_${process.pid}`;

  beforeAll(async () => {
    const c = new PgClient({ connectionString: url });
    await c.connect();
    admin = c;
    made.push(template);
    await c.query(`DROP DATABASE IF EXISTS ${quoteDbIdent(template)} WITH (FORCE)`);
    await createDatabaseFromTemplate(c, template, runTemplateDbName(testRunId()));
  }, 60_000);

  afterAll(async () => {
    // If beforeAll failed early (no local Postgres, auth error), `admin` is
    // undefined and cleaning up would throw a SECOND error that buries the real
    // one (@copilot, #1136).
    if (!admin) return;
    for (const d of made)
      await admin.query(`DROP DATABASE IF EXISTS ${quoteDbIdent(d)} WITH (FORCE)`).catch(() => {});
    await admin.end();
  });

  it('clones a free template, and reports a second call as EXISTS rather than created', async () => {
    const name = `hadron_test_probe_${process.pid}`;
    made.push(name);
    await admin!.query(`DROP DATABASE IF EXISTS ${quoteDbIdent(name)} WITH (FORCE)`);

    expect(await createDatabaseFromTemplate(admin!, name, template)).toBe('created');
    // 42P04 is reported, not swallowed as creation — a caller that needs a FRESH
    // database cannot tell the two apart otherwise, and that is precisely how a
    // truncated name let two workers share one database.
    expect(await createDatabaseFromTemplate(admin!, name, template)).toBe('exists');
  }, 60_000);

  it('names the blocking session instead of hanging or reporting a made-up wait', async () => {
    const holder = new PgClient({ connectionString: withDbNameForTest(url, template) });
    await holder.connect();
    try {
      const name = `hadron_test_probe_busy_${process.pid}`;
      made.push(name);
      const started = Date.now();
      // timeoutMs 0 — give up on the FIRST refusal, so the test does not pay
      // Postgres's ~8s busy-source wait more than once.
      const err = await createDatabaseFromTemplate(admin!, name, template, {
        timeoutMs: 0,
      }).then(
        () => null,
        (e: Error) => e,
      );

      expect(err?.message).toMatch(/has been in use for \d+s.*Holding it: pid \d+/s);

      // The reported wait must MATCH real elapsed time, not merely be bounded by
      // it (PR #1136 review, Copilot). The bug this pins reported
      // `attempts * delayMs` — a constant, independent of how long anything
      // actually took — and a one-sided `>= 0` or `<= elapsed` assertion passes
      // against a constant just as happily as against a measurement. Only a
      // two-sided band around the observed time can tell them apart: Postgres
      // blocks ~8s on a busy source, so the old constant 5 lands outside it.
      const elapsedS = (Date.now() - started) / 1000;
      const reportedS = Number(/in use for (\d+)s/.exec(err!.message)![1]);
      expect(Math.abs(reportedS - elapsedS)).toBeLessThanOrEqual(2);
    } finally {
      await holder.end();
    }
  }, 60_000);
});

/** Local helper: swap the database name in a connection string (test-only). */
function withDbNameForTest(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

describe('testMaxWorkers (HADRON_TEST_MAX_WORKERS)', () => {
  it('a positive integer caps the forks; unset, empty or invalid keeps vitest\'s default', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(testMaxWorkers('4')).toBe(4);
    expect(testMaxWorkers(' 12 ')).toBe(12);
    expect(testMaxWorkers(undefined)).toBeUndefined();
    expect(testMaxWorkers('')).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    for (const bad of ['0', '-2', '2.5', 'four', '50%']) expect(testMaxWorkers(bad)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(5);
    warn.mockRestore();
  });
});
