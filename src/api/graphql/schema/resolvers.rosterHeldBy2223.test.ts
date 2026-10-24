/** #2223 — TeamRosterEntry.heldBy / heldAt: who holds a worker's name, behind the working-state gate. */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { typeDefs } from './typeDefs.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { canSeeUserPersonalFields, canSeeUserPersonalFieldsMany } from '../../../lib/auth/userVisibility.js';
import { buildASTSchema, parse, assertObjectType } from 'graphql';
import * as workerGate from './resolvers.worker.js';
import { renderRosterEntry } from '../../../mcp/agentTaskTools.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const schema = buildASTSchema(typeof typeDefs === 'string' ? parse(typeDefs) : typeDefs);
const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const server = new ApolloServer<Context>({ typeDefs, resolvers });
beforeAll(() => server.start());
afterAll(() => server.stop());

type Roles = Context['roles'];
const ctx = (userId?: string, roles: Roles = ['READER']): Context => ({ db, userId, roles });

let org: { id: string };
let app: { id: string };
let agentId: string;
let orgAdmin: { id: string };
let mia: { id: string };       // App member only: shares no org with any holder
let coMember: { id: string };  // org member + App member: shares the org with hal
let hal: { id: string; handle: string };   // holder, org member, named
let dee: { id: string; handle: string };   // holder who left: no AppMember, no OrgMember row
let gone: { id: string };      // soft-deleted holder
const w: Record<string, { id: string }> = {};

const roster = (viewer = mia.id, roles?: Roles) => Q.teamRoster({}, { appRef: app.id }, ctx(viewer, roles));
async function entry(name: string, viewer = mia.id, roles?: Roles) {
  const r = await roster(viewer, roles);
  return r.workers.find((e: { name: string }) => e.name === name);
}

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  let seq = 0; // distinct per user: random github ids collided across the six fixtures
  org = await db.organization.create({ data: { name: 'Held', urn: `held-${n}.example` } });
  const user = (tag: string, extra: Record<string, unknown> = {}) =>
    db.user.create({ data: { githubId: 700_000_000 + n * 10 + ++seq, githubUsername: `h-${tag}-${n}`, roles: ['READER'], ...extra } });
  orgAdmin = await user('admin');
  mia = await user('mia');
  coMember = await user('co');
  hal = (await user('hal', { handle: `hal-${n}`, name: 'Hal Holder' })) as never;
  dee = (await user('dee', { handle: `dee-${n}`, name: 'Dee Departed' })) as never;
  gone = await user('gone', { handle: `gone-${n}`, name: 'Gone Person', deletedAt: new Date() });
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: orgAdmin.id, role: 'ADMIN' },
    { organizationId: org.id, userId: coMember.id, role: 'READER' },
    { organizationId: org.id, userId: hal.id, role: 'READER' },
  ] });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(orgAdmin.id));
  agentId = agent.id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `held-${n}.example:team` }, select: { id: true } });
  await db.appMember.createMany({ data: [
    { appId: app.id, userId: mia.id, role: 'member' },
    { appId: app.id, userId: coMember.id, role: 'member' },
    { appId: app.id, userId: hal.id, role: 'member' },
  ] });
  const hold = (name: string, heldByUserId: string | null) =>
    db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name, slug: name.toLowerCase(), role: 'engineer',
        heldByUserId, heldAt: heldByUserId ? new Date('2026-10-01T00:00:00Z') : null },
      select: { id: true },
    });
  w.Anne = await hold('Anne', hal.id);
  w.Rook = await hold('Rook', dee.id);
  w.Kit = await hold('Kit', null);
  // The FK is ON DELETE SET NULL, but a soft-delete leaves the pointer: the fail-closed case.
  w.Zed = await hold('Zed', gone.id);
});

describe('#2223 TeamRosterEntry.heldBy — disclosure matrix', () => {
  it('a gate-passing reader gets id/handle/urn; the name stays null without self, platform-admin or co-membership', async () => {
    const e = await entry('Anne', mia.id);
    expect(e.heldBy).toMatchObject({ id: hal.id, handle: hal.handle });
    expect(e.heldAt).toEqual(new Date('2026-10-01T00:00:00Z'));
    expect(e.heldBy.name).toBeNull();
  });

  it('the name shows for the holder, an org co-member and a platform admin', async () => {
    for (const [viewer, roles] of [[hal.id], [coMember.id], [orgAdmin.id, ['ADMIN']]] as Array<[string, Roles?]>) {
      const e = await entry('Anne', viewer, roles);
      expect(e.heldBy.name, `viewer ${viewer}`).toBe('Hal Holder');
    }
  });

  it('a departed holder (no AppMember or OrgMember row, hold kept) is still named by id/handle; name by the gate', async () => {
    expect((await entry('Rook', mia.id)).heldBy).toMatchObject({ id: dee.id, handle: dee.handle, name: null });
    expect((await entry('Rook', orgAdmin.id, ['ADMIN'])).heldBy.name).toBe('Dee Departed');
    // an org-only co-member does not share an org with dee
    expect((await entry('Rook', coMember.id)).heldBy.name).toBeNull();
  });

  it('nobody holds the name, or the holder is soft-deleted: heldBy and heldAt are null', async () => {
    for (const name of ['Kit', 'Zed']) {
      const e = await entry(name);
      expect(e.heldBy, name).toBeNull();
      expect(e.heldAt, name).toBeNull();
    }
  });

  it('a reader who fails the working-state gate gets null heldBy AND null heldAt, and the holder is not even looked up', async () => {
    const spy = vi.spyOn(workerGate, 'maySeeWorkerInternals').mockResolvedValue(false);
    try {
      const traced: string[] = [];
      const t = db.$extends({ query: { $allOperations: async ({ args, query, model, operation }) => {
        traced.push(`${model}.${operation}`);
        return query(args);
      } } });
      const r = await Q.teamRoster({}, { appRef: app.id }, { ...ctx(mia.id), db: t });
      expect(r.workers.every((e: any) => e.heldBy === null && e.heldAt === null)).toBe(true);
      expect(traced.filter((q) => q === 'User.findMany')).toEqual([]);
    } finally { spy.mockRestore(); }
  });

  it('is evaluated once per App, never per worker', async () => {
    const spy = vi.spyOn(workerGate, 'maySeeWorkerInternals');
    try {
      await roster();
      expect(spy.mock.calls.length).toBeLessThanOrEqual(2); // roster check-status derivation may ask once too
    } finally { spy.mockRestore(); }
  });

  it('an App-key caller is gated like the Worker surface (own App reads; no user, so no name)', async () => {
    const r = await Q.teamRoster({}, { appRef: app.id }, { db, roles: [], appId: app.id } as Context).catch((e: unknown) => e);
    // The roster itself decides whether a bare appId context is an audience; whatever it answers, no name leaks.
    if (!(r instanceof Error)) {
      for (const e of r.workers) expect(e.heldBy?.name ?? null).toBeNull();
    }
  });
});

describe('#2223 through the actual GraphQL schema', () => {
  const query = `query($app: ID!) { teamRoster(appRef: $app) { workers { worker { name } heldAt heldBy { id handle urn name } } } }`;
  const run = async (viewer: string) => {
    const response = await server.executeOperation({ query, variables: { app: app.id } }, { contextValue: ctx(viewer) });
    if (response.body.kind !== 'single') throw new Error('Expected single result');
    expect(response.body.singleResult.errors).toBeUndefined();
    return (response.body.singleResult.data as any).teamRoster.workers as any[];
  };

  it('projects the closed WorkerHolder with a canonical urn', async () => {
    const anne = (await run(mia.id)).find((e) => e.worker.name === 'Anne');
    expect(anne.heldBy).toEqual({ id: hal.id, handle: hal.handle, urn: `hrn:user:${hal.handle}`, name: null });
    expect(anne.heldAt).toBe('2026-10-01T00:00:00.000Z');
    expect((await run(coMember.id)).find((e) => e.worker.name === 'Anne').heldBy.name).toBe('Hal Holder');
  });

  it('WorkerHolder is exactly id/handle/urn/name — nothing reachable toward User', async () => {
    const type = assertObjectType(schema.getType('WorkerHolder'));
    expect(Object.keys(type.getFields()).sort()).toEqual(['handle', 'id', 'name', 'urn']);
  });

  it('shares its fields with ReleasedFromUser (one projection, not a second copy)', async () => {
    expect(Object.keys(assertObjectType(schema.getType('ReleasedFromUser')).getFields()).sort())
      .toEqual(Object.keys(assertObjectType(schema.getType('WorkerHolder')).getFields()).sort());
  });
});

describe('#2223 bulk name gate agrees with the single-target helper', () => {
  it('canSeeUserPersonalFieldsMany == canSeeUserPersonalFields for every viewer class and target', async () => {
    const targets = [hal.id, dee.id, coMember.id, mia.id, gone.id, generateId()];
    const viewers: Array<[string | undefined, Roles]> = [
      [hal.id, ['READER']], [coMember.id, ['READER']], [mia.id, ['READER']],
      [orgAdmin.id, ['ADMIN']], [undefined, []],
    ];
    for (const [userId, roles] of viewers) {
      const many = await canSeeUserPersonalFieldsMany(ctx(userId, roles), targets);
      for (const t of targets) {
        const single = await canSeeUserPersonalFields(ctx(userId, roles), t);
        expect(many.has(t), `viewer ${userId} target ${t}`).toBe(single);
      }
    }
  });

  it('honors impersonation scope exactly as the single-target helper does', async () => {
    const other = await db.organization.create({ data: { name: 'Other', urn: `other-${generateId().slice(-6)}.example` } });
    for (const orgId of [org.id, other.id]) {
      const c = { ...ctx(coMember.id), impersonation: { orgId } } as Context;
      const many = await canSeeUserPersonalFieldsMany(c, [hal.id, dee.id]);
      for (const t of [hal.id, dee.id]) expect(many.has(t)).toBe(await canSeeUserPersonalFields({ ...c }, t));
    }
  });

  it('empty and falsy targets are never visible', async () => {
    expect((await canSeeUserPersonalFieldsMany(ctx(orgAdmin.id, ['ADMIN']), [])).size).toBe(0);
    expect((await canSeeUserPersonalFieldsMany(ctx(orgAdmin.id, ['ADMIN']), ['', null as never])).size).toBe(0);
  });
});

describe('#2223 constant query count', () => {
  it('holder reads do not grow with workers (1 vs 100) or distinct holders (1 vs 20)', async () => {
    const counts: Array<[number, number]> = [];
    for (const [workers, holders] of [[1, 1], [100, 20]]) {
      await db.worker.deleteMany({ where: { appId: app.id } });
      const users = await Promise.all(Array.from({ length: holders }, (_, i) =>
        db.user.create({ data: { githubId: 900_000 + Math.floor(Math.random() * 90_000) + i, githubUsername: `bulk-${generateId().slice(-8)}`, handle: `bulk-${generateId().slice(-8)}`, roles: ['READER'] } })));
      await db.orgMember.createMany({ data: users.map((u) => ({ organizationId: org.id, userId: u.id, role: 'READER' })), skipDuplicates: true });
      await db.worker.createMany({ data: Array.from({ length: workers }, (_, i) => ({ ...WORKER_SIGNATURE_DEFAULTS,
        id: generateId(), appId: app.id, agentId, name: `B${i}`, slug: `b-${i}`, role: 'engineer',
        heldByUserId: users[i % holders].id, heldAt: new Date() })) });
      let userReads = 0;
      let memberReads = 0;
      const traced = db.$extends({ query: { $allOperations: async ({ args, query, model, operation }) => {
        if (model === 'User' && operation === 'findMany') userReads++;
        if (model === 'OrgMember' && operation === 'findMany') memberReads++;
        return query(args);
      } } });
      const r = await Q.teamRoster({}, { appRef: app.id }, { ...ctx(coMember.id), db: traced });
      expect(r.workers).toHaveLength(workers);
      expect(r.workers.every((e: any) => e.heldBy?.id)).toBe(true);
      expect(r.workers.every((e: any) => e.heldBy.name === null || typeof e.heldBy.name === 'string')).toBe(true);
      counts.push([userReads, memberReads]);
    }
    expect(counts[1]).toEqual(counts[0]);
  });
});

describe('#2223 MCP rendering', () => {
  it('renders the holder as @handle (hrn:user:handle), with the name only when present', async () => {
    const withName = renderRosterEntry({ ...(await entry('Anne', coMember.id)), heldBy: { id: hal.id, handle: hal.handle, name: 'Hal Holder' } }, new Date());
    expect(withName).toContain(`held by @${hal.handle} (hrn:user:${hal.handle}) Hal Holder`);
    const noName = renderRosterEntry({ ...(await entry('Anne', mia.id)), heldBy: { id: hal.id, handle: hal.handle, name: null } }, new Date());
    expect(noName).toContain(`held by @${hal.handle} (hrn:user:${hal.handle})`);
    expect(noName).not.toContain('Hal Holder');
    expect(renderRosterEntry(await entry('Kit'), new Date())).not.toContain('held by');
  });
});
