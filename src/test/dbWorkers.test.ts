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
import { workerDbUrl, workerDbName, baseDbName, maintenanceUrl } from './dbWorkers.js';

const ORIGINAL = process.env.TEST_DATABASE_URL;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.TEST_DATABASE_URL;
  else process.env.TEST_DATABASE_URL = ORIGINAL;
  vi.resetModules();
});

describe('workerDbUrl', () => {
  it('points at the worker clone AND carries the pool bound', () => {
    process.env.TEST_DATABASE_URL = 'postgresql://holger@localhost:5432/hadron_test';
    const u = new URL(workerDbUrl(3));
    expect(u.pathname).toBe('/hadron_test_3');
    // The assertion that matters: without this param Prisma defaults to
    // `cpus * 2 + 1` PER FORK, which is what oversubscribed Postgres.
    expect(u.searchParams.get('connection_limit')).toBe('5');
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

  it('derives the clone name from the base DB', () => {
    process.env.TEST_DATABASE_URL = 'postgresql://holger@localhost:5432/hadron_test';
    expect(baseDbName()).toBe('hadron_test');
    expect(workerDbName(7)).toBe('hadron_test_7');
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
