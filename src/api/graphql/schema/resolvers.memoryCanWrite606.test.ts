/**
 * #606 — `Memory.canWrite`: the caller's write capability on a Memory, derived from the memory write gate itself.
 *
 * The expected value of every cell is read off the REAL gate (`requireMemoryWriteAccess`), never a hand-written table,
 * so a drift between the flag and a write that would actually be refused fails here. A handful of cells also pin the
 * answer outright, so a gate that changed under both sides at once cannot pass silently.
 */
import { GraphQLError } from 'graphql';
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
        const expected = await gateAllows(mkCtx(), id);
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

describe('#606 query cost of memories(limit: 50)', () => {
  it('stays linear with a small constant per memory and does not repeat for a duplicate', async () => {
    const logged = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL, log: [{ emit: 'event', level: 'query' }] });
    let n = 0;
    (logged as any).$on('query', () => { n += 1; });
    try {
      const ids: string[] = [];
      for (let i = 0; i < 50; i += 1) {
        const m = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `cw-org:bulk-${i}`, name: `bulk-${i}`, class: 'knowledge' } });
        ids.push(m.id);
      }
      const c = { db: logged, userId: u.contributor.id, roles: ['READER'] } as unknown as Context;
      n = 0;
      const answers = await Promise.all([...ids, ...ids].map((id) => M.canWrite({ id }, {}, c)));
      const total = n;
      expect(answers.every(Boolean)).toBe(true);
      // One gate run per DISTINCT memory (the 50 repeats add nothing); never 100 x the gate's queries.
      const c2 = { db: logged, userId: u.contributor.id, roles: ['READER'] } as unknown as Context;
      n = 0;
      await M.canWrite({ id: ids[0] }, {}, c2);
      const perMemory = n;
      expect(perMemory).toBeGreaterThan(0); // the logging client really saw the gate's queries (not a vacuous 0 <= 0)
      expect(total).toBeGreaterThan(0);
      expect(total).toBeLessThanOrEqual(perMemory * 50);
      expect(perMemory).toBeLessThanOrEqual(12); // absolute ceiling per distinct memory
    } finally {
      await logged.$disconnect();
    }
  });
});
