/**
 * #606 — `Memory.canWrite`: the caller's write capability on a Memory, derived from the memory write gate itself.
 *
 * The expected value of every cell is read off the REAL gate (`requireMemoryWriteAccess`), never a hand-written table,
 * so a drift between the flag and a write that would actually be refused fails here. A handful of cells also pin the
 * answer outright, so a gate that changed under both sides at once cannot pass silently.
 */
import { GraphQLError } from 'graphql';
import { isReadOnlyImpersonation, impersonationReadOnlyPlugin } from '../impersonationReadOnlyPlugin.js';
import { parse } from 'graphql';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PrismaClient } from '../../../generated/prisma/index.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { requireMemoryWriteAccess, canWriteMemoryRecord, isMemoryWriteRefusal, memoryWriteForbidden } from './resolvers.helpers.js';

const M = resolvers.Memory as unknown as { canWrite: (m: { id: string }, a: unknown, c: Context) => Promise<boolean | null> };
const ctxOf = (o: Partial<Context>): Context => ({ db, ...o }) as Context;

let org: { id: string };
let shared: { id: string }; // org knowledge memory
let privOwnedByOwner: { id: string };
let personalOwnedByOwner: { id: string };
const u: Record<string, { id: string }> = {};

async function mkUser(key: string, roles: string[], n: number) {
  u[key] = await db.user.create({ data: { githubId: 6000 + n, githubUsername: `cw-${key}`, roles: roles as any } });
}

beforeEach(async () => {
  await cleanDb(db);
  const made = await createDbOrgAndGraph(db, { orgName: 'cw-org', graphName: 'cw-shared', visibility: 'ORGANIZATION' });
  org = made.org;
  shared = made.graph;
  await mkUser('owner', ['READER'], 1);
  await mkUser('reader', ['READER'], 2);
  await mkUser('contributor', ['READER'], 3);
  await mkUser('orgAdmin', ['READER'], 4);
  await mkUser('platform', ['OWNER'], 5);
  await mkUser('revoked', ['READER'], 6);
  await mkUser('stranger', ['READER'], 7);
  for (const [k, role] of [['owner', 'READER'], ['reader', 'READER'], ['contributor', 'CONTRIBUTOR'], ['orgAdmin', 'ADMIN']] as const) {
    await db.orgMember.create({ data: { organizationId: org.id, userId: u[k].id, role } });
  }
  await db.orgMember.create({ data: { organizationId: org.id, userId: u.revoked.id, role: 'CONTRIBUTOR', deletedAt: new Date() } });
  const mk = (name: string, cls: 'private' | 'personal') => db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `cw-org:${name}`, name, class: cls, userId: u.owner.id },
  });
  privOwnedByOwner = await mk('cw-private', 'private');
  personalOwnedByOwner = await mk('cw-personal', 'personal');
});

async function gateAllows(ctx: Context, id: string): Promise<boolean> {
  try { await requireMemoryWriteAccess(ctx, id); return true; } catch (e: any) {
    if (isMemoryWriteRefusal(e)) return false; // the same predicate the field uses
    throw e;
  }
}

const principals: Array<[string, () => Context]> = [
  ['org owner-member (reader role)', () => ctxOf({ userId: u.owner.id, roles: ['READER'] })],
  ['org reader', () => ctxOf({ userId: u.reader.id, roles: ['READER'] })],
  ['org contributor', () => ctxOf({ userId: u.contributor.id, roles: ['READER'] })],
  ['org admin', () => ctxOf({ userId: u.orgAdmin.id, roles: ['READER'] })],
  ['platform OWNER', () => ctxOf({ userId: u.platform.id, roles: ['OWNER'] })],
  ['revoked contributor', () => ctxOf({ userId: u.revoked.id, roles: ['READER'] })],
  ['stranger', () => ctxOf({ userId: u.stranger.id, roles: ['READER'] })],
  ['impersonating contributor', () => ctxOf({ userId: u.contributor.id, roles: ['READER'], impersonation: { actorUserId: u.platform.id } } as any)],
  ['unauthenticated', () => ctxOf({})],
];

describe('#606 Memory.canWrite equals the write gate (matrix)', () => {
  for (const [label, mkCtx] of principals) {
    for (const which of ['shared', 'private', 'personal'] as const) {
      it(`${label} × ${which}`, async () => {
        const id = { shared: shared.id, private: privOwnedByOwner.id, personal: personalOwnedByOwner.id }[which];
        const c0 = mkCtx();
        // The gate's answer, except that a read-only impersonation session can write nothing at all.
        const expected = isReadOnlyImpersonation(c0) ? false : await gateAllows(c0, id);
        expect(await M.canWrite({ id }, {}, mkCtx())).toBe(expected);
      });
    }
  }

  it('pins the answers outright, not only against the gate', async () => {
    const at = (key: string, roles: string[], id: string) => M.canWrite({ id }, {}, ctxOf({ userId: u[key].id, roles: roles as any }));
    expect(await at('reader', ['READER'], shared.id)).toBe(false);
    expect(await at('contributor', ['READER'], shared.id)).toBe(true);
    expect(await at('revoked', ['READER'], shared.id)).toBe(false);
    expect(await at('stranger', ['READER'], shared.id)).toBe(false);
    expect(await at('owner', ['READER'], privOwnedByOwner.id)).toBe(true);
    // another user's personal/private memory: false even for a platform OWNER and an org admin
    expect(await at('platform', ['OWNER'], privOwnedByOwner.id)).toBe(false);
    expect(await at('orgAdmin', ['READER'], personalOwnedByOwner.id)).toBe(false);
    expect(await M.canWrite({ id: shared.id }, {}, ctxOf({}))).toBe(false);
  });

  it('is false for every memory under read-only impersonation, even where the gate alone allows the target', async () => {
    const c = ctxOf({ userId: u.contributor.id, roles: ['READER'], impersonation: { actorUserId: u.platform.id } } as any);
    expect(await gateAllows(c, shared.id)).toBe(true); // the gate by itself would say yes
    expect(await M.canWrite({ id: shared.id }, {}, c)).toBe(false);
  });

  it('the mutation plugin and the field agree on what a read-only impersonation session is (they cannot diverge)', async () => {
    const mutation = parse('mutation { createNode(urn: "x") { id } }');
    const op = mutation.definitions[0] as any;
    const shapes: Array<[string, Record<string, unknown>]> = [
      ['no impersonation', {}],
      ['impersonation object', { impersonation: { actorUserId: u.platform.id } }],
      ['impersonation without actor field', { impersonation: { orgId: 'some-org' } }],
      ['impersonation undefined', { impersonation: undefined }],
      ['impersonation null', { impersonation: null }],
    ];
    for (const [label, extra] of shapes) {
      const c = ctxOf({ userId: u.contributor.id, roles: ['READER'], ...extra } as any);
      const hooks: any = await (impersonationReadOnlyPlugin as any).requestDidStart();
      let refused = false;
      try { await hooks.didResolveOperation({ operation: op, document: mutation, contextValue: c }); } catch (e: any) {
        refused = e?.extensions?.code === 'IMPERSONATION_READ_ONLY';
      }
      // plugin refuses  <=>  the field says false for a target the gate alone allows
      expect([label, refused]).toEqual([label, isReadOnlyImpersonation(c)]);
      expect([label, await M.canWrite({ id: shared.id }, {}, c)]).toEqual([label, !refused]);
    }
  });

  it('an App key with no user answers as the gate does (canWriteToMemory)', async () => {
    const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'cw-app', urn: 'cw-org::cw-app' } });
    const c = ctxOf({ appId: app.id } as any);
    const expected = await gateAllows(c, shared.id);
    expect(await M.canWrite({ id: shared.id }, {}, c)).toBe(expected);
    expect(expected).toBe(false); // pinned: a bare App key with no membership cannot write an org memory
  });

  it('a gate failure that is not a refusal answers null (unknown), never false, and does not throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const c = ctxOf({ userId: u.contributor.id, roles: ['READER'] });
      await expect(canWriteMemoryRecord(c, 'no-such-memory')).rejects.toThrow(); // the helper still propagates
      expect(await M.canWrite({ id: 'no-such-memory' }, {}, c)).toBeNull();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('classifies a refusal by identity, not by its message text', async () => {
    expect(isMemoryWriteRefusal(memoryWriteForbidden())).toBe(true);
    // same words and code, but not made by memoryWriteForbidden(): a different failure
    const lookalike = new GraphQLError(memoryWriteForbidden().message, { extensions: { code: 'FORBIDDEN' } });
    expect(isMemoryWriteRefusal(lookalike)).toBe(false);
    // a reworded refusal made by the gate's own constructor still counts
    expect(isMemoryWriteRefusal(Object.assign(memoryWriteForbidden(), { message: 'reworded' }))).toBe(true);
  });

  it('is memoised per request context only', async () => {
    const c = ctxOf({ userId: u.contributor.id, roles: ['READER'] });
    const first = canWriteMemoryRecord(c, shared.id);
    expect(canWriteMemoryRecord(c, shared.id)).toBe(first);
    const other = canWriteMemoryRecord(ctxOf({ userId: u.contributor.id, roles: ['READER'] }), shared.id);
    expect(other).not.toBe(first);
    await Promise.all([first, other]);
  });
});

// Prisma delivers 'query' events asynchronously, after the statement resolves: wait for them before reading a count,
// or a late event lands in the next run's window.
const flushQueryEvents = () => new Promise<void>((r) => setTimeout(r, 400));

describe('#606 query cost of memories(limit: 50)', () => {
  it('runs the gate a small constant number of queries per distinct memory and not again for a duplicate', async () => {
    const logged = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL, log: [{ emit: 'event', level: 'query' }] });
    // Count the gate's queries PER MEMORY (a query counts for a memory when its bound parameters carry that id), not
    // the database total: the total jitters with pool/connection housekeeping, a per-memory count does not.
    let perId = new Map<string, number>();
    let total = 0;
    let watched: string[] = [];
    (logged as any).$on('query', (e: { params: string }) => {
      total += 1;
      for (const id of watched) if (e.params.includes(id)) perId.set(id, (perId.get(id) ?? 0) + 1);
    });
    try {
      const ids: string[] = [];
      for (let i = 0; i < 50; i += 1) {
        const m = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `cw-org:bulk-${i}`, name: `bulk-${i}`, class: 'knowledge' } });
        ids.push(m.id);
      }
      watched = ids;
      const fresh = () => ({ db: logged, userId: u.contributor.id, roles: ['READER'] }) as unknown as Context;
      // A: each distinct memory once. B: every memory twice, on one fresh request context.
      perId = new Map();
      total = 0;
      const once = await Promise.all(ids.map((id) => M.canWrite({ id }, {}, fresh())));
      await flushQueryEvents();
      const countsA = perId;
      const totalA = total;
      total = 0;
      perId = new Map();
      const cB = fresh();
      const twice = await Promise.all([...ids, ...ids].map((id) => M.canWrite({ id }, {}, cB)));
      await flushQueryEvents();
      const countsB = perId;
      const totalB = total;
      // Window totals catch what the per-memory count cannot see: a lookup keyed by user or org, repeated per memory.
      expect(totalA).toBeLessThanOrEqual(50 * 12);
      expect(totalB).toBeLessThanOrEqual(50 * 12);
      expect(once.every(Boolean)).toBe(true);
      expect(twice.every(Boolean)).toBe(true);
      for (const id of ids) {
        const one = countsA.get(id) ?? 0;
        expect(one).toBeGreaterThan(0); // the logging client really saw the gate's queries for this memory (not vacuous)
        expect(one).toBeLessThanOrEqual(12); // a small constant per distinct memory
        expect(countsB.get(id)).toBe(one); // the duplicate asked the gate nothing more: exactly the same queries
      }
    } finally {
      await logged.$disconnect();
    }
  });
});
