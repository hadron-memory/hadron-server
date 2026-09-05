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
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  workerDbUrl,
  workerDbName,
  baseDbName,
  maintenanceUrl,
  testRunId,
  runTemplateDbName,
  parseWorkerDbName,
  isRunAlive,
  templateLockKey,
  WORKER_CONNECTION_LIMIT,
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
    expect(u.pathname).toBe('/hadron_test_r4242_3');
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
    expect(workerDbName(7, 'hadron_test', '99')).toBe('hadron_test_r99_7');
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
    expect(runTemplateDbName('100', 'hadron_test')).toBe('hadron_test_r100_tpl');
    expect(runTemplateDbName('100', 'hadron_test')).not.toBe(
      runTemplateDbName('200', 'hadron_test'),
    );
  });

  it('never collides a run template with a worker clone of the same run', () => {
    expect(runTemplateDbName('100', 'hadron_test')).not.toBe(
      workerDbName(1, 'hadron_test', '100'),
    );
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
    });
  });

  it('still recognizes a LEGACY unscoped clone', () => {
    // A checkout from before this change still creates these, and a machine
    // running both will have both — cleanup has to be able to see the old ones.
    expect(parseWorkerDbName('hadron_test_3', 'hadron_test')).toEqual({
      datname: 'hadron_test_3',
      runId: null,
      poolId: '3',
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
    // 2^22 is above every default pid_max on the platforms this runs on, so it
    // cannot be a live process.
    expect(isRunAlive(String(2 ** 22))).toBe(false);
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
