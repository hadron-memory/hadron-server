/**
 * #4875 (F8 of #4814): `secret_events` rows written in one transaction have no recoverable order when their `at` ties.
 * `at` is `clock_timestamp()` stored as timestamp(3) (milliseconds) and `id` is a UUIDv7 whose bits are random inside one millisecond, so
 * `(at, id)` mis-orders a tie. A monotonic per-row `seq` (a bigserial the DDL fills) is the tiebreak: reads order
 * `(at, seq)`, `at` stays first for clients.
 *
 * Spec FIT (AT0.9936): no spec governs the order (cor:sec:010:05 fixes content, visibility and retention); the one
 * constraint is that `seq` is as immutable as every other field (the append-only trigger covers the row), and nothing
 * claims to recover the order of ties that predate the column.
 *
 * Every pin is red on main: the list resolver orders `[{at desc},{id desc}]`, and `seq` does not exist.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { upsertPlatformActions } from '../grants/actions.js';

let userId: string, appId: string, secretId: string;
const ctx = (): Context => ({ db, userId, roles: [] } as unknown as Context);
const KINDS = ['METADATA', 'PROTECT', 'UNPROTECT', 'REVEAL'] as const;

/** `secret_events.id` is TEXT (any string, `generateId()` is a UUIDv7 in production), so the fabricated ids below are valid. Write the kinds in order, in ONE transaction, all with the SAME `at`, under ids whose order is the REVERSE of insertion. */
async function writeTied(kinds: readonly string[]): Promise<void> {
  const at = new Date('2026-11-22T10:00:00.000Z');
  const ids = kinds.map((_, i) => `0000-${String(kinds.length - i).padStart(4, '0')}-${generateId()}`);
  await db.$transaction(
    kinds.map((kind, i) =>
      db.secretEvent.create({
        data: { id: ids[i], ownerType: 'app', ownerId: appId, secretId, secretName: 'canary', kind, outcome: 'OK', actorUserId: userId, at },
      }),
    ),
  );
}

afterEach(() => { vi.unstubAllEnvs(); });
beforeEach(async () => {
  vi.stubEnv('SECRET_ROOT_KEY', '33'.repeat(32));
  await cleanDb(db); await upsertPlatformActions(db);
  userId = (await db.user.create({ data: { email: `${generateId()}@s4.test` } })).id;
  appId = (await db.app.create({ data: { ownerUserId: userId, name: 'S4 seq', urn: `${generateId().toLowerCase()}:s4q` } })).id;
  secretId = (await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name: 'canary', kind: 'generic', value: 'v' }, ctx())).id;
});

describe('#4875 secret_events: (at, seq) is the order of events written in one transaction', () => {
  it('seq is strictly increasing in insertion order, even with one `at` and reversed ids', async () => {
    await writeTied(KINDS);
    const rows = await db.secretEvent.findMany({ where: { secretId, kind: { in: [...KINDS] } }, orderBy: [{ at: 'asc' }, { seq: 'asc' }] });
    expect(rows.map((r) => r.kind)).toEqual([...KINDS]);
    for (let i = 1; i < rows.length; i++) expect(rows[i].seq > rows[i - 1].seq).toBe(true);
  });

  it('the (at, id) order of a tie is NOT insertion order (why id cannot be the tiebreak)', async () => {
    await writeTied(KINDS);
    const byId = await db.secretEvent.findMany({ where: { secretId, kind: { in: [...KINDS] } }, orderBy: [{ at: 'asc' }, { id: 'asc' }] });
    expect(byId.map((r) => r.kind)).toEqual([...KINDS].reverse());
  });

  it('the events list answers newest first by (at, seq): a tie lists the later write first', async () => {
    await writeTied(KINDS);
    const page = (await resolvers.Query.secretEvents({}, { ref: secretId, limit: 50 }, ctx())) as { items: Array<{ kind: string }> };
    const tied = page.items.filter((e) => (KINDS as readonly string[]).includes(e.kind)).map((e) => e.kind);
    expect(tied).toEqual([...KINDS].reverse());
  });

  it('`at` still leads the list: an earlier `at` with a HIGHER seq never outranks a later `at` (guard against seq-first; green on main by design)', async () => {
    await db.secretEvent.create({ data: { ownerType: 'app', ownerId: appId, secretId, secretName: 'canary', kind: 'REVEAL', outcome: 'OK', at: new Date('2026-11-22T09:00:00Z') } });
    await db.secretEvent.create({ data: { ownerType: 'app', ownerId: appId, secretId, secretName: 'canary', kind: 'PROTECT', outcome: 'OK', at: new Date('2026-11-22T08:00:00Z') } });
    const page = (await resolvers.Query.secretEvents({}, { ref: secretId, limit: 50 }, ctx())) as { items: Array<{ kind: string }> };
    const kinds = page.items.map((e) => e.kind);
    // REVEAL (09:00) was written first, so its seq is LOWER than PROTECT's (08:00); `at` leads, so it still comes first.
    expect(kinds.indexOf('REVEAL')).toBeLessThan(kinds.indexOf('PROTECT'));
  });

  it('seq is as immutable as every other field: an UPDATE of it is refused by the append-only trigger', async () => {
    await writeTied(['METADATA']);
    await expect(db.$executeRaw`UPDATE secret_events SET seq = seq + 1000 WHERE secret_id = ${secretId}`).rejects.toThrow(/append-only/);
  });

  it('a real updateSecret metadata change is the LAST event by (at, seq) (the METADATA-then-PROTECT pair is pinned by secretChangeFollowups4717 through the same order)', async () => {
    const before = await db.secretEvent.count({ where: { secretId } });
    await resolvers.Mutation.updateSecret({}, { ref: secretId, metadata: { note: 'x' } }, ctx());
    const rows = await db.secretEvent.findMany({ where: { secretId }, orderBy: [{ at: 'asc' }, { seq: 'asc' }] });
    expect(rows.length).toBeGreaterThan(before);
    expect(rows[rows.length - 1].kind).toBe('METADATA');
  });
});
