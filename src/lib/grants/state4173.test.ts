/**
 * #4173 — the seven derived grant states (cor:acl:140:03, :01, :05; contract r5 D1-D9). One derivation in two spellings
 * ({@link deriveGrantState}, {@link grantStateSql}) pinned against each other on a grid; the one writer ({@link endGrant}) keeps the
 * first end (no stamp, no event on an expired or spent row) and records a withdrawal as its own fact and event; the guard
 * trigger lets `withdrawn_at` be set once, with the revoke stamp, on a never-activated row only. `allows` is unchanged.
 */
import { Prisma } from '../../generated/prisma/index.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { DB_NOW, dropTestActions, grantValues, insertGrant, insertGrantUnguarded, raw, seedWorld, type World } from './grantFixtures3668.js';
import { grantLiveSql, isGrantLive } from './live.js';
import { endGrant, GrantManageRefusal } from './manage.js';
import { getGrantForManager, getGrantForWorker, listGrantsForManager, listGrantsForPerson, listGrantsForWorker } from './read.js';
import { deriveGrantState, grantStateSql, type GrantState, type GrantStateFields } from './state.js';

let w: World;
beforeEach(async () => { await cleanDb(db); w = await seedWorld(); });
afterAll(async () => { await cleanDb(db); await dropTestActions(); });

const NOW = new Date('2026-06-15T12:00:00.000Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);
const iso = (d: Date) => d.toISOString().replace('Z', '');
const ts = (d: Date | null) => (d ? raw(`'${iso(d)}'::timestamp`) : null);
const ACT = at(-86_400_000);

const full = (row: Partial<GrantStateFields>): GrantStateFields => ({
  activatedAt: null, revokedAt: null, withdrawnAt: null, holderDepartedAt: null, appDeletedAt: null, startsAt: null, expiresAt: null, maxUses: null, useCount: 0, actionMaxUses: null, actionLifetimeSeconds: null, ...row,
});

type Case = { name: string; state: GrantState; row: Partial<GrantStateFields> };
const CASES: Case[] = [
  { name: 'A1 pending, no end', state: 'PENDING', row: {} },
  { name: 'A2 activated, future start: ACTIVE (allows false)', state: 'ACTIVE', row: { activatedAt: ACT, startsAt: at(1000) } },
  { name: 'A3 activated, started', state: 'ACTIVE', row: { activatedAt: ACT, startsAt: at(-1000) } },
  { name: 'A4 count reached', state: 'SPENT', row: { activatedAt: ACT, maxUses: 3, useCount: 3 } },
  { name: 'A5 expiry passed (active)', state: 'EXPIRED', row: { activatedAt: ACT, expiresAt: at(-1) } },
  { name: 'A6 expiry equals now', state: 'EXPIRED', row: { activatedAt: ACT, expiresAt: at(0) } },
  { name: 'A6b expiry equals the revoke stamp: expired first', state: 'EXPIRED', row: { activatedAt: ACT, expiresAt: at(-500), revokedAt: at(-500) } },
  { name: 'A7 revoked active', state: 'REVOKED', row: { activatedAt: ACT, revokedAt: at(-1000) } },
  { name: 'A8 revoked pending by a manager (no withdrawn marker)', state: 'REVOKED', row: { revokedAt: at(-1000) } },
  { name: 'A9 pending past expiry', state: 'EXPIRED', row: { expiresAt: at(-1) } },
  { name: 'A10 pending, expired, then withdrawn (historical stamp after E)', state: 'EXPIRED', row: { expiresAt: at(-2000), revokedAt: at(-1000), withdrawnAt: at(-1000) } },
  { name: 'A11 pending, expired, then the holder went', state: 'EXPIRED', row: { expiresAt: at(-2000), holderDepartedAt: at(-1000) } },
  { name: 'A12 pending withdrawn before expiry', state: 'WITHDRAWN', row: { expiresAt: at(5000), revokedAt: at(-1000), withdrawnAt: at(-1000) } },
  { name: 'A13 active, expired, then revoked (historical)', state: 'EXPIRED', row: { activatedAt: ACT, expiresAt: at(-2000), revokedAt: at(-1000) } },
  { name: 'A14 spent then revoked (historical)', state: 'SPENT', row: { activatedAt: ACT, maxUses: 1, useCount: 1, revokedAt: at(-1000) } },
  { name: 'A15 revoked before expiry, then expiry passes', state: 'REVOKED', row: { activatedAt: ACT, revokedAt: at(-2000), expiresAt: at(-1000) } },
  { name: 'A16 holder departed (active)', state: 'HOLDER_GONE', row: { activatedAt: ACT, holderDepartedAt: at(-1000) } },
  { name: 'A16b holder departed, then expiry passes', state: 'HOLDER_GONE', row: { activatedAt: ACT, holderDepartedAt: at(-2000), expiresAt: at(-1000) } },
  { name: 'A17 spent and raw-stamped departed: spent', state: 'SPENT', row: { activatedAt: ACT, maxUses: 1, useCount: 1, holderDepartedAt: at(-1000) } },
  { name: 'A18 pre-change withdrawal (revoked, pending, no marker)', state: 'REVOKED', row: { revokedAt: at(-1000), withdrawnAt: null } },
  { name: 'future-start grant revoked shows its end', state: 'REVOKED', row: { activatedAt: ACT, startsAt: at(9000), revokedAt: at(-1000) } },
  // #4163 (gate: when action limits land, SPENT and EXPIRED read them in the same change as grantLiveSql, with these pins).
  { name: 'A19 used up to the ACTION cap: SPENT (the grant has no cap of its own)', state: 'SPENT', row: { activatedAt: ACT, actionMaxUses: 1, useCount: 1 } },
  { name: 'A20 past the ACTION lifetime from activation: EXPIRED', state: 'EXPIRED', row: { activatedAt: at(-3_700_000), actionLifetimeSeconds: 3600 } },
  { name: 'A20b inside the action lifetime: ACTIVE', state: 'ACTIVE', row: { activatedAt: at(-1_000_000), actionLifetimeSeconds: 3600 } },
  { name: 'A20c action lifetime ended, then revoked (historical): EXPIRED; revoked first: REVOKED', state: 'EXPIRED', row: { activatedAt: at(-3_700_000), actionLifetimeSeconds: 3600, revokedAt: at(-1000) } },
  { name: 'A20d revoked before the action lifetime ended: REVOKED', state: 'REVOKED', row: { activatedAt: at(-3_700_000), actionLifetimeSeconds: 3600, revokedAt: at(-3_650_000) } },
  { name: 'A20e a pending grant has no action lifetime yet: PENDING', state: 'PENDING', row: { actionLifetimeSeconds: 1, actionMaxUses: 1, useCount: 1 } },
  { name: 'pending with a cap and use_count (never activated): not spent', state: 'PENDING', row: { maxUses: 1, useCount: 1 } },
];

describe('deriveGrantState (the function)', () => {
  for (const c of CASES) it(c.name, () => expect(deriveGrantState(full(c.row), NOW), c.name).toBe(c.state));
});

describe('grantStateSql (the fragment) agrees with the function, and allows is unchanged', () => {
  it('differential over the named cases and a full grid of the nullable columns', async () => {
    // The action-limit cases need a registered action WITH limits: they run in their own test below, on one that has them.
    const rows: Array<{ name: string; row: GrantStateFields }> = CASES.filter((c) => c.row.actionMaxUses === undefined && c.row.actionLifetimeSeconds === undefined).map((c) => ({ name: c.name, row: full(c.row) }));
    let n = 0;
    for (const activatedAt of [null, ACT]) for (const revokedAt of [null, at(-3000), at(3000 * 0 - 1000)]) for (const departed of [null, at(-1500)])
      for (const expiresAt of [null, at(-3000), at(-1000), at(0), at(-500), at(4000)]) for (const [maxUses, useCount] of [[null, 0], [2, 1], [2, 2]] as const)
        for (const startsAt of [null, at(2000)]) for (const withdrawn of [false, true]) {
          if (withdrawn && (revokedAt === null || activatedAt !== null)) continue;
          if (startsAt !== null && expiresAt !== null && startsAt.getTime() >= expiresAt.getTime()) continue; // chk_grants_shape
          rows.push({ name: `grid ${n++}`, row: full({ activatedAt, revokedAt, withdrawnAt: withdrawn ? revokedAt : null, holderDepartedAt: departed, expiresAt, maxUses, useCount, startsAt }) });
        }
    const ids = new Map<string, { name: string; row: GrantStateFields }>();
    for (const r of rows) {
      const id = await insertGrantUnguarded(w, {
        activated_at: ts(r.row.activatedAt), revoked_at: ts(r.row.revokedAt), revoked_by: r.row.revokedAt ? w.userId : null, withdrawn_at: ts(r.row.withdrawnAt),
        holder_departed_at: ts(r.row.holderDepartedAt), starts_at: ts(r.row.startsAt), expires_at: ts(r.row.expiresAt), max_uses: r.row.maxUses, use_count: r.row.useCount,
      });
      ids.set(id, r);
    }
    const out = await db.$queryRaw<Array<{ id: string; state: string; live: boolean }>>(
      Prisma.sql`SELECT g.id, (${grantStateSql('g', Prisma.sql`${iso(NOW)}::timestamp`)}) AS state, (${grantLiveSql('g', Prisma.sql`${iso(NOW)}::timestamp`)}) AS live FROM grants g`);
    expect(out).toHaveLength(rows.length);
    for (const o of out) {
      const r = ids.get(o.id)!;
      expect(o.state, r.name).toBe(deriveGrantState(r.row, NOW));
      // allows is exactly "state ACTIVE and started", and still the one live function.
      expect(o.live, r.name).toBe(isGrantLive(r.row, NOW));
      expect(o.live, r.name).toBe(o.state === 'ACTIVE' && (r.row.startsAt === null || r.row.startsAt.getTime() <= NOW.getTime()));
    }
  }, 120_000);
});

describe('#4163: the SQL fragment reads the action\'s limits exactly as the function does, and allows still equals state ACTIVE', () => {
  it('a registered action with a use cap and a lifetime: SPENT, EXPIRED, ACTIVE, and the historical-end ties, row against function', async () => {
    const action = grantValues(w).action as string;
    await db.$executeRawUnsafe(`UPDATE actions SET max_uses = 2, lifetime_seconds = 3600 WHERE name = $1`, action);
    try {
    const mk = (over: Partial<GrantStateFields>) => full({ actionMaxUses: 2, actionLifetimeSeconds: 3600, ...over });
    const rows: Array<{ name: string; row: GrantStateFields }> = [
      { name: 'under both', row: mk({ activatedAt: at(-1_000_000), useCount: 1 }) },
      { name: 'at the action cap', row: mk({ activatedAt: at(-1_000_000), useCount: 2 }) },
      { name: 'past the lifetime', row: mk({ activatedAt: at(-3_700_000), useCount: 0 }) },
      { name: 'exactly at the lifetime end (equality is the end)', row: mk({ activatedAt: at(-3_600_000), useCount: 0 }) },
      { name: 'cap reached and past the lifetime: spent first', row: mk({ activatedAt: at(-3_700_000), useCount: 2 }) },
      { name: 'past the lifetime, then revoked', row: mk({ activatedAt: at(-3_700_000), revokedAt: at(-1000) }) },
      { name: 'revoked before the lifetime ended', row: mk({ activatedAt: at(-3_700_000), revokedAt: at(-3_650_000) }) },
      { name: 'past the lifetime, then the holder went', row: mk({ activatedAt: at(-3_700_000), holderDepartedAt: at(-1000) }) },
      { name: 'own expiry earlier than the lifetime', row: mk({ activatedAt: at(-1_000_000), expiresAt: at(-500) }) },
      { name: 'pending', row: mk({ useCount: 2 }) },
      { name: 'the holder went inside the lifetime', row: mk({ activatedAt: at(-1_000_000), holderDepartedAt: at(-1000) }) },
    ];
    const ids = new Map<string, { name: string; row: GrantStateFields }>();
    for (const r of rows) {
      const id = await insertGrantUnguarded(w, {
        activated_at: ts(r.row.activatedAt), revoked_at: ts(r.row.revokedAt), revoked_by: r.row.revokedAt ? w.userId : null,
        holder_departed_at: ts(r.row.holderDepartedAt), expires_at: ts(r.row.expiresAt), use_count: r.row.useCount,
      });
      ids.set(id, r);
    }
    const out = await db.$queryRaw<Array<{ id: string; state: string; live: boolean }>>(
      Prisma.sql`SELECT g.id, (${grantStateSql('g', Prisma.sql`${iso(NOW)}::timestamp`)}) AS state, (${grantLiveSql('g', Prisma.sql`${iso(NOW)}::timestamp`)}) AS live FROM grants g`);
    expect(out).toHaveLength(rows.length);
    for (const o of out) {
      const r = ids.get(o.id)!;
      expect(o.state, r.name).toBe(deriveGrantState(r.row, NOW));
      expect(o.live, r.name).toBe(isGrantLive(r.row, NOW));
      expect(o.live, r.name).toBe(o.state === 'ACTIVE');
    }
    expect(new Set(out.map((o) => o.state))).toEqual(new Set(['ACTIVE', 'SPENT', 'EXPIRED', 'REVOKED', 'HOLDER_GONE', 'PENDING']));
    } finally {
      await db.$executeRawUnsafe(`UPDATE actions SET max_uses = NULL, lifetime_seconds = NULL WHERE name = $1`, action);
    }
  });
});

const ender = () => ({ userId: w.userId, workerId: null, sessionId: null });
const events = async (id: string) => (await db.$queryRaw<Array<{ action: string }>>`SELECT action FROM grant_events WHERE grant_id = ${id} ORDER BY at`).map((e) => e.action);
const stored = async (id: string) => (await db.$queryRaw<Array<{ revoked_at: Date | null; withdrawn_at: Date | null; updated_at: Date; state: string }>>(
  Prisma.sql`SELECT revoked_at, withdrawn_at, updated_at, (${grantStateSql('g')}) AS state FROM grants g WHERE id = ${id}`))[0];
const end = (id: string, pendingOnly = false) => db.$transaction((tx) => endGrant(tx, id, ender(), { authorize: () => undefined, pendingOnly, ...(pendingOnly ? { kind: 'withdraw' as const } : { kind: 'revoke' as const }) }));
const PAST = raw(`${DB_NOW} - interval '1 hour'`);
const FUTURE = raw(`${DB_NOW} + interval '1 hour'`);

describe('endGrant: a withdrawal is its own fact and event; the first end stands (D8)', () => {
  it('A12/A26 withdraw of a live pending grant: stamps, withdrawn_at = revoked_at, exactly one WITHDRAW event, state WITHDRAWN', async () => {
    const id = await insertGrant(w, { expires_at: FUTURE });
    expect(await end(id, true)).toEqual({ changed: true });
    const s = await stored(id);
    expect(s.withdrawn_at).not.toBeNull();
    expect(s.withdrawn_at!.getTime()).toBe(s.revoked_at!.getTime());
    expect(s.state).toBe('WITHDRAWN');
    expect(await events(id)).toEqual(['WITHDRAW']);
  });
  it('A26 revoke of a live pending or active grant: one REVOKE event, no withdrawn_at, state REVOKED', async () => {
    const pending = await insertGrant(w);
    const active = await insertGrantUnguarded(w, { activated_at: PAST });
    for (const id of [pending, active]) {
      expect(await end(id)).toEqual({ changed: true });
      expect((await stored(id)).withdrawn_at).toBeNull();
      expect((await stored(id)).state).toBe('REVOKED');
      expect(await events(id)).toEqual(['REVOKE']);
    }
  });
  it('A10\' withdraw of a pending grant past its expiry: changed false, no stamp, no event, no updated_at bump, state EXPIRED', async () => {
    const id = await insertGrantUnguarded(w, { expires_at: PAST });
    const before = await stored(id);
    expect(await end(id, true)).toEqual({ changed: false });
    const after = await stored(id);
    expect(after.revoked_at).toBeNull(); expect(after.withdrawn_at).toBeNull();
    expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());
    expect(after.state).toBe('EXPIRED');
    expect(await events(id)).toEqual([]);
  });
  it('A13\' revoke of an active grant past its expiry: changed false, no event, state EXPIRED', async () => {
    const id = await insertGrantUnguarded(w, { activated_at: raw(`${DB_NOW} - interval '2 hours'`), expires_at: PAST });
    expect(await end(id)).toEqual({ changed: false });
    expect((await stored(id)).revoked_at).toBeNull();
    expect((await stored(id)).state).toBe('EXPIRED');
    expect(await events(id)).toEqual([]);
  });
  it('A14\' revoke of a spent grant: changed false, no event, state SPENT', async () => {
    const id = await insertGrantUnguarded(w, { activated_at: PAST, max_uses: 2, use_count: 2 });
    expect(await end(id)).toEqual({ changed: false });
    expect((await stored(id)).state).toBe('SPENT');
    expect(await events(id)).toEqual([]);
  });
  it('A19b\' an expiry equal to the call instant counts as expired (the boundary is <=)', async () => {
    const id = await insertGrantUnguarded(w, { activated_at: raw(`${DB_NOW} - interval '2 hours'`), expires_at: raw(`${DB_NOW}`) });
    expect(await end(id)).toEqual({ changed: false });
  });
  it('A19 a repeat end on an ended row: no second stamp, no second event', async () => {
    const id = await insertGrant(w, { expires_at: FUTURE });
    expect(await end(id, true)).toEqual({ changed: true });
    const first = await stored(id);
    expect(await end(id, true)).toEqual({ changed: false });
    expect(await end(id)).toEqual({ changed: false });
    expect((await stored(id)).revoked_at!.getTime()).toBe(first.revoked_at!.getTime());
    expect(await events(id)).toEqual(['WITHDRAW']);
  });
  it('A27 withdraw of an activated and expired row is GRANT_NOT_PENDING (the kind is judged before the time no-op)', async () => {
    const id = await insertGrantUnguarded(w, { activated_at: raw(`${DB_NOW} - interval '2 hours'`), expires_at: PAST });
    await expect(end(id, true)).rejects.toBeInstanceOf(GrantManageRefusal);
  });
  it('A28 pre-change stamped expired and spent rows still derive EXPIRED and SPENT, and a repeat end is a no-op', async () => {
    const exp = await insertGrantUnguarded(w, { activated_at: raw(`${DB_NOW} - interval '3 hours'`), expires_at: raw(`${DB_NOW} - interval '2 hours'`), revoked_at: PAST, revoked_by: w.userId });
    const spent = await insertGrantUnguarded(w, { activated_at: raw(`${DB_NOW} - interval '3 hours'`), max_uses: 1, use_count: 1, revoked_at: PAST, revoked_by: w.userId });
    expect((await stored(exp)).state).toBe('EXPIRED');
    expect((await stored(spent)).state).toBe('SPENT');
    expect(await end(exp)).toEqual({ changed: false });
    expect(await end(spent)).toEqual({ changed: false });
  });
});

describe('the guard trigger and the events CHECK (A24)', () => {
  const sql = (q: string, ...p: unknown[]) => db.$executeRawUnsafe(q, ...p);
  // One statement-wide instant: both columns read the same value, which clock_timestamp() would not give.
  const STMT = "(statement_timestamp() AT TIME ZONE 'UTC')";
  const refused = (q: string, ...p: unknown[]) => expect(sql(q, ...p)).rejects.toThrow(/grants are append-only/);
  const withdrawnOf = async (id: string) => (await db.$queryRawUnsafe<Array<{ withdrawn_at: Date | null; revoked_at: Date | null }>>('SELECT withdrawn_at, revoked_at FROM grants WHERE id = $1', id))[0];
  it('withdrawn_at is set once, equal to revoked_at, on a never-activated row, in the revoke statement', async () => {
    const id = await insertGrant(w);
    await refused(`UPDATE grants SET withdrawn_at = ${STMT} WHERE id = $1`, id); // not revoked
    await refused(`UPDATE grants SET revoked_at = ${STMT}, revoked_by = $2, withdrawn_at = ${STMT} + interval '1 second' WHERE id = $1`, id, w.userId); // differs
    // the legal path must succeed (no swallowed failure) and leave the two stamps equal
    await sql(`UPDATE grants SET revoked_at = ${STMT}, revoked_by = $2, withdrawn_at = ${STMT} WHERE id = $1`, id, w.userId);
    const row = await withdrawnOf(id);
    expect(row.withdrawn_at).not.toBeNull();
    expect(row.withdrawn_at!.getTime()).toBe(row.revoked_at!.getTime());
    const ok = await insertGrant(w);
    await sql(`UPDATE grants SET revoked_at = ${STMT}, revoked_by = $2 WHERE id = $1`, ok, w.userId);
    await refused(`UPDATE grants SET withdrawn_at = revoked_at WHERE id = $1`, ok); // marker after the revoke stamp
  });
  it('not on an activated row, never cleared, never moved, never at INSERT', async () => {
    const act = await insertGrantUnguarded(w, { activated_at: PAST });
    await refused(`UPDATE grants SET revoked_at = ${STMT}, revoked_by = $2, withdrawn_at = ${STMT} WHERE id = $1`, act, w.userId);
    const wd = await insertGrant(w);
    await sql(`UPDATE grants SET revoked_at = ${STMT}, revoked_by = $2, withdrawn_at = ${STMT} WHERE id = $1`, wd, w.userId);
    expect((await withdrawnOf(wd)).withdrawn_at).not.toBeNull(); // setup really withdrew it
    await refused(`UPDATE grants SET withdrawn_at = NULL WHERE id = $1`, wd); // cleared
    await refused(`UPDATE grants SET withdrawn_at = withdrawn_at + interval '1 second' WHERE id = $1`, wd); // moved
    await expect(insertGrant(w, { revoked_at: raw(DB_NOW), revoked_by: w.userId, withdrawn_at: raw(DB_NOW) })).rejects.toThrow(); // at INSERT
  });
  it('WITHDRAW is an accepted event action; others are still refused', async () => {
    const id = await insertGrant(w);
    await sql(`INSERT INTO grant_events (id, grant_id, app_id, action, at) VALUES ('ev-w', $1, $2, 'WITHDRAW', ${DB_NOW})`, id, w.appId);
    await expect(sql(`INSERT INTO grant_events (id, grant_id, app_id, action, at) VALUES ('ev-x', $1, $2, 'BOGUS', ${DB_NOW})`, id, w.appId)).rejects.toThrow();
  });
});

describe('A22/A23 one row, one state on every read surface; the worker scope is unchanged', () => {
  it('manager list, manager get, person list and worker get/list agree; a withdrawn row requested by this worker (held by another) stays absent', async () => {
    const held = await insertGrant(w, { user_id: null, worker_id: w.workerId, requested_by_worker_id: w.workerId, expires_at: FUTURE });
    await db.$transaction((tx) => endGrant(tx, held, ender(), { kind: 'withdraw', pendingOnly: true, authorize: () => undefined }));
    const asked = await insertGrant(w, { requested_by_worker_id: w.workerId, expires_at: FUTURE }); // held by a person, asked by this worker
    await db.$transaction((tx) => endGrant(tx, asked, ender(), { kind: 'withdraw', pendingOnly: true, authorize: () => undefined }));
    const reader = { appId: w.appId, workerId: w.workerId };
    expect((await getGrantForWorker(db, reader, held))!.state).toBe('WITHDRAWN');
    expect((await getGrantForManager(db, w.appId, held, true))!.state).toBe('WITHDRAWN');
    expect((await listGrantsForManager(db, w.appId, {})).items.map((g) => g.state).sort()).toEqual(['WITHDRAWN', 'WITHDRAWN']);
    expect((await listGrantsForWorker(db, reader, {})).items.map((g) => g.id)).toEqual([held]); // A23: the requester-only arm needs revoked_at IS NULL
    expect((await listGrantsForPerson(db, w.userId, {})).items.map((g) => g.state)).toEqual(['WITHDRAWN']);
  });
});
