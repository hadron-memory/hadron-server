/**
 * hadron-server#5022 (Billing A9): the default monthly grant, at the library (hrn:node:hadronmemory.com:specs:cor:dmo:170:12).
 *
 * One grant per owner and UTC calendar month, of the deployment's amount (`OWNER_DEFAULT_MONTHLY_GRANT`), written through
 * the ledger's `grantCredits` with source type `period-grant` and an opaque source id (cor:dmo:170:08), expiring at the
 * first instant of the next UTC month so A4's settlement removes what is left (cor:dmo:170:10).
 *
 * Red on main: `./periodGrant.js` does not exist, so every pin fails at import. The unset/zero guard (G7) states what main
 * already does (no row), and the parser pins (G8) are the boot refusal's contract.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { creditBalance, debitCredits, grantCredits } from './index.js';
import { settleExpiredGrants } from './settleExpiredGrants.js';
import {
  OWNER_DEFAULT_MONTHLY_GRANT_ERROR,
  PERIOD_GRANT_SOURCE_TYPE,
  ensurePeriodGrant,
  ownerDefaultMonthlyGrant,
  parseOwnerDefaultMonthlyGrant,
  periodGrantCacheKeysForTests,
  periodGrantDue,
  periodGrantSourceId,
  reloadOwnerDefaultMonthlyGrantForTests,
  resetPeriodGrantStateForTests,
  setPeriodGrantWriterForTests,
} from './periodGrant.js';

const MID_NOV = new Date('2026-11-15T12:00:00.000Z');
const DEC_1 = new Date('2026-12-01T00:00:00.000Z');
const MID_DEC = new Date('2026-12-15T12:00:00.000Z');
const JAN_1 = new Date('2027-01-01T00:00:00.000Z');

let p: string;
let q: string;
let orgId: string;
const grants = (where: Record<string, unknown> = {}) =>
  db.creditLedgerEntry.findMany({ where: { sourceType: PERIOD_GRANT_SOURCE_TYPE, ...where }, orderBy: { createdAt: 'asc' } });

beforeEach(async () => {
  await cleanDb(db);
  resetPeriodGrantStateForTests();
  setPeriodGrantWriterForTests(null);
  p = (await db.user.create({ data: { id: generateId(), githubId: 50_220_001, githubUsername: 'pg-p', handle: 'pg-p', roles: ['READER'] } })).id;
  q = (await db.user.create({ data: { id: generateId(), githubId: 50_220_002, githubUsername: 'pg-q', handle: 'pg-q', roles: ['READER'] } })).id;
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'pg-org', urn: 'pg-org' } })).id;
});

afterEach(() => {
  reloadOwnerDefaultMonthlyGrantForTests({});
  setPeriodGrantWriterForTests(null);
  vi.restoreAllMocks();
});

describe('G1: the first ensure of a month writes the month\'s grant', () => {
  it('one grant of the amount, kind grant, period-grant, expiring at the next UTC month, by system:period-grant', async () => {
    reloadOwnerDefaultMonthlyGrantForTests({ OWNER_DEFAULT_MONTHLY_GRANT: '{"user":"1234"}' });
    await ensurePeriodGrant(db, { userId: p }, MID_NOV);
    const rows = await grants();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ownerUserId: p, organizationId: null, kind: 'grant', amountMicroCents: 1234n,
      sourceType: 'period-grant', createdBy: 'system:period-grant', note: null,
    });
    expect(rows[0]!.expiresAt!.toISOString()).toBe(DEC_1.toISOString());
    expect(await creditBalance(db, { userId: p })).toBe(1234n);
  });

  it('the last instant of a month still belongs to it (UTC, not local time)', async () => {
    reloadOwnerDefaultMonthlyGrantForTests({ OWNER_DEFAULT_MONTHLY_GRANT: '{"user":"5"}' });
    await ensurePeriodGrant(db, { userId: p }, new Date('2026-11-30T23:59:59.999Z'));
    const [row] = await grants();
    expect(row!.expiresAt!.toISOString()).toBe(DEC_1.toISOString());
    expect(row!.sourceId).toBe(periodGrantSourceId({ userId: p }, MID_NOV));
  });
});

describe('G2: concurrent ensures write one grant and neither fails', () => {
  it('two at once in a fresh process state', async () => {
    reloadOwnerDefaultMonthlyGrantForTests({ OWNER_DEFAULT_MONTHLY_GRANT: '{"user":"1234"}' });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await Promise.all([ensurePeriodGrant(db, { userId: p }, MID_NOV), ensurePeriodGrant(db, { userId: p }, MID_NOV)]);
    expect(await grants()).toHaveLength(1);
    expect(err).not.toHaveBeenCalled();
  });
});

describe('G3: once a month', () => {
  it('a second ensure in the month writes nothing; the next month writes the next grant under another source id', async () => {
    reloadOwnerDefaultMonthlyGrantForTests({ OWNER_DEFAULT_MONTHLY_GRANT: '{"user":"1234"}' });
    await ensurePeriodGrant(db, { userId: p }, MID_NOV);
    resetPeriodGrantStateForTests(); // another process: only the ledger can say it is done
    await ensurePeriodGrant(db, { userId: p }, new Date('2026-11-29T00:00:00.000Z'));
    expect(await grants()).toHaveLength(1);
    await ensurePeriodGrant(db, { userId: p }, MID_DEC);
    const rows = await grants();
    expect(rows).toHaveLength(2);
    expect(rows[1]!.expiresAt!.toISOString()).toBe(JAN_1.toISOString());
    expect(rows[1]!.sourceId).not.toBe(rows[0]!.sourceId);
  });
});

describe('G4: the source id is opaque and the same in every process', () => {
  it('64 hex characters; neither the owner id nor the month in clear; the digest of type, id and month', async () => {
    const id = periodGrantSourceId({ userId: p }, MID_NOV);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).not.toContain(p);
    expect(id).not.toContain('2026-11');
    expect(id).toBe(createHash('sha256').update(`period-grant:user:${p}:2026-11`).digest('hex'));
    expect(periodGrantSourceId({ organizationId: p }, MID_NOV)).not.toBe(id);
    vi.resetModules();
    const fresh = await import('./periodGrant.js');
    expect(fresh.periodGrantSourceId({ userId: p }, MID_NOV)).toBe(id);
  });
});

describe('G5: the grant expires through A4', () => {
  it('after the month, what is left is removed by one settlement and the balance drops by that much', async () => {
    reloadOwnerDefaultMonthlyGrantForTests({ OWNER_DEFAULT_MONTHLY_GRANT: '{"user":"1234"}' });
    const now = new Date();
    await ensurePeriodGrant(db, { userId: p }, now);
    await debitCredits(db, { owner: { userId: p }, amountMicroCents: 234n, sourceType: 'usage-event', sourceId: generateId() });
    expect(await creditBalance(db, { userId: p })).toBe(1000n);
    const [grant] = await grants();
    const settled = await settleExpiredGrants(db, { userId: p }, { now: new Date(grant!.expiresAt!.getTime() + 120_000) });
    expect(settled).toHaveLength(1);
    expect(await creditBalance(db, { userId: p })).toBe(0n);
  });
});

describe('G7: no amount, no grant', () => {
  it('unset, empty and zero write nothing and log nothing', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const env of [{}, { OWNER_DEFAULT_MONTHLY_GRANT: '' }, { OWNER_DEFAULT_MONTHLY_GRANT: '{"user":"0","organization":"0"}' }]) {
      reloadOwnerDefaultMonthlyGrantForTests(env);
      resetPeriodGrantStateForTests();
      await ensurePeriodGrant(db, { userId: p }, MID_NOV);
      await ensurePeriodGrant(db, { organizationId: orgId }, MID_NOV);
      expect(await periodGrantDue(db, { userId: p }, MID_NOV)).toBe(0n);
    }
    expect(await grants()).toHaveLength(0);
    expect(err).not.toHaveBeenCalled();
  });

  it('a missing owner type is zero', async () => {
    reloadOwnerDefaultMonthlyGrantForTests({ OWNER_DEFAULT_MONTHLY_GRANT: '{"user":"9"}' });
    await ensurePeriodGrant(db, { organizationId: orgId }, MID_NOV);
    expect(await grants()).toHaveLength(0);
  });
});

describe('G8: a malformed setting refuses, in one fixed sentence that echoes nothing', () => {
  const MARKER = 'q9Zmarker';
  const bad = [
    '{', '[]', '"1"', 'null', `{"team":"1"}`, `{"${MARKER}":"1"}`, '{"user":"-1"}', '{"user":"1.5"}', '{"user":"x"}',
    `{"user":"${MARKER}"}`, '{"user":1}', '{"user":null}', '{"user":"01"}', '{"user":" 1"}', '{"user":"1e3"}', '{"user":"0x10"}',
    '{"user":"9223372036854775808"}', `{"user":"1","organization":"${MARKER}"}`,
    '{"organization":"1"}', '{"user":"5","organization":"777"}', '{"organization":"9223372036854775807"}',
  ];
  for (const raw of bad) {
    it(`refuses ${raw}`, () => {
      let thrown: unknown;
      try { parseOwnerDefaultMonthlyGrant(raw); } catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe(OWNER_DEFAULT_MONTHLY_GRANT_ERROR);
      expect((thrown as Error).message).toContain('OWNER_DEFAULT_MONTHLY_GRANT');
      expect(String((thrown as Error).message)).not.toContain(MARKER);
      expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();
    });
  }

  it('accepts the 64-bit maximum, zero, and both owner types', () => {
    expect(parseOwnerDefaultMonthlyGrant('{"user":"9223372036854775807","organization":"0"}'))
      .toEqual({ user: 9223372036854775807n });
    expect(parseOwnerDefaultMonthlyGrant('{"organization":"0"}')).toEqual({ user: 0n });
    expect(parseOwnerDefaultMonthlyGrant(undefined)).toEqual({ user: 0n });
    expect(parseOwnerDefaultMonthlyGrant('  ')).toEqual({ user: 0n });
  });
});

describe('G10: an amount changed in the middle of a month', () => {
  it('no second grant, one conflict line, and no further write or line on the next ensure', async () => {
    reloadOwnerDefaultMonthlyGrantForTests({ OWNER_DEFAULT_MONTHLY_GRANT: '{"user":"1234"}' });
    await ensurePeriodGrant(db, { userId: p }, MID_NOV);
    resetPeriodGrantStateForTests();
    reloadOwnerDefaultMonthlyGrantForTests({ OWNER_DEFAULT_MONTHLY_GRANT: '{"user":"4321"}' });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const writer = vi.fn(grantCredits);
    setPeriodGrantWriterForTests(writer);
    await ensurePeriodGrant(db, { userId: p }, MID_NOV);
    await ensurePeriodGrant(db, { userId: p }, MID_NOV);
    expect(await grants()).toHaveLength(1);
    expect((await grants())[0]!.amountMicroCents).toBe(1234n);
    const lines = err.mock.calls.filter((c) => c[0] === 'period_grant.conflict');
    expect(lines).toHaveLength(1);
    expect(JSON.stringify(lines[0])).not.toMatch(/1234|4321/);
    expect(writer.mock.calls.length).toBeLessThanOrEqual(1);
    // The figure a no-write path answers agrees with the writing path: nothing more is due this month.
    expect(await periodGrantDue(db, { userId: p }, MID_NOV)).toBe(0n);
  });

  it('a conflict on the write itself (a race with another amount) is cached the same way', async () => {
    reloadOwnerDefaultMonthlyGrantForTests({ OWNER_DEFAULT_MONTHLY_GRANT: '{"user":"4321"}' });
    // Another process granted the old amount between this process's look-up and its insert.
    const writer = vi.fn(async (d: typeof db, params: Parameters<typeof grantCredits>[1]) => {
      await grantCredits(d, { ...params, amountMicroCents: 1234n });
      return grantCredits(d, params);
    });
    setPeriodGrantWriterForTests(writer);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await ensurePeriodGrant(db, { userId: p }, MID_NOV);
    await ensurePeriodGrant(db, { userId: p }, MID_NOV);
    expect(writer).toHaveBeenCalledTimes(1);
    expect(err.mock.calls.filter((c) => c[0] === 'period_grant.conflict')).toHaveLength(1);
    expect(err.mock.calls.filter((c) => c[0] === 'period_grant.failed')).toHaveLength(0);
  });
});

describe('G11: any other failure is logged, never thrown, and retried next time', () => {
  it('logs owner id and code only, returns normally, and the next ensure writes', async () => {
    reloadOwnerDefaultMonthlyGrantForTests({ OWNER_DEFAULT_MONTHLY_GRANT: '{"user":"1234"}' });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    setPeriodGrantWriterForTests(async () => { throw Object.assign(new Error('boom secret-ish detail'), { code: 'P1001' }); });
    await expect(ensurePeriodGrant(db, { userId: p }, MID_NOV)).resolves.toBeUndefined();
    expect(await grants()).toHaveLength(0);
    const lines = err.mock.calls.filter((c) => c[0] === 'period_grant.failed');
    expect(lines).toHaveLength(1);
    expect(lines[0]![1]).toEqual({ ownerUserId: p, code: 'P1001' });
    setPeriodGrantWriterForTests(null);
    await ensurePeriodGrant(db, { userId: p }, MID_NOV);
    expect(await grants()).toHaveLength(1);
  });
});

describe('G12: an organization', () => {
  it('gets no grant entry with a user grant configured, and is owed none (cor:dmo:170:12)', async () => {
    reloadOwnerDefaultMonthlyGrantForTests({ OWNER_DEFAULT_MONTHLY_GRANT: '{"user":"777","organization":"0"}' });
    await ensurePeriodGrant(db, { organizationId: orgId }, MID_NOV);
    expect(await periodGrantDue(db, { organizationId: orgId }, MID_NOV)).toBe(0n);
    expect(await grants()).toHaveLength(0);
    await ensurePeriodGrant(db, { userId: p }, MID_NOV);
    const rows = await grants();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ organizationId: null, ownerUserId: p, amountMicroCents: 777n });
  });

  it('a non-zero organization amount refuses boot and never reaches the kept amounts', () => {
    reloadOwnerDefaultMonthlyGrantForTests({ OWNER_DEFAULT_MONTHLY_GRANT: '{"user":"5"}' });
    expect(() => reloadOwnerDefaultMonthlyGrantForTests({ OWNER_DEFAULT_MONTHLY_GRANT: '{"user":"9","organization":"1"}' }))
      .toThrow(OWNER_DEFAULT_MONTHLY_GRANT_ERROR);
    expect(ownerDefaultMonthlyGrant()).toEqual({ user: 5n });
  });
});

describe('G13: the per-process set holds only the current month', () => {
  it('after ensures in two months only the second month\'s keys remain', async () => {
    reloadOwnerDefaultMonthlyGrantForTests({ OWNER_DEFAULT_MONTHLY_GRANT: '{"user":"1"}' });
    await ensurePeriodGrant(db, { userId: p }, MID_NOV);
    await ensurePeriodGrant(db, { userId: q }, MID_NOV);
    expect(periodGrantCacheKeysForTests()).toHaveLength(2);
    await ensurePeriodGrant(db, { userId: p }, MID_DEC);
    const keys = periodGrantCacheKeysForTests();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain('2026-12');
  });
});

describe('ruling 9a: periodGrantDue, the read-only figure', () => {
  it('the amount while the month\'s grant is absent, zero once written, and it never writes', async () => {
    reloadOwnerDefaultMonthlyGrantForTests({ OWNER_DEFAULT_MONTHLY_GRANT: '{"user":"1234"}' });
    expect(await periodGrantDue(db, { userId: p }, MID_NOV)).toBe(1234n);
    expect(await grants()).toHaveLength(0);
    await ensurePeriodGrant(db, { userId: p }, MID_NOV);
    expect(await periodGrantDue(db, { userId: p }, MID_NOV)).toBe(0n);
    expect(await periodGrantDue(db, { userId: p }, MID_DEC)).toBe(1234n);
  });
});
