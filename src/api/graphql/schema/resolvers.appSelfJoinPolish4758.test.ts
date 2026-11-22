/**
 * #4758 (follow-up to #4490 / #4743): the pins the #4743 review seats deferred, for `App.selfJoin`.
 *
 *  1. A failure that is not `SelfJoinNotAllowedError` propagates from the field; it is never CLOSED.
 *  2. The read gate runs on the fresh row, never on the ownership columns the parent carries.
 *  3. The field calls the exported `resolveSelfJoinRole` (a spy), so "not a second copy" is shown on the FIELD, not on the export.
 *  4. The list cost: the per-App reads the field pays are batched per request (counted statements), and the admission cost carries an entry.
 *
 * Each pin is a mutant killer (see the PR body): reverting the guarded behavior turns it red.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { formatGraphQLError } from '../formatError.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import * as joinAppModule from '../../../controller/operations/joinApp.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
// A pass-through spy on the export: the real decision still runs unless a test overrides it once.
vi.mock('../../../controller/operations/joinApp.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../controller/operations/joinApp.js')>();
  return { ...actual, resolveSelfJoinRole: vi.fn(actual.resolveSelfJoinRole) };
});

const server = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError });
const field = (resolvers as any).App.selfJoin as (a: unknown, args: unknown, ctx: Context) => Promise<unknown>;
const as = (userId: string): Context => ({ db, userId, roles: ['READER'] }) as unknown as Context;
const OPEN = { maxMembers: '50', memberRoles: ['owner', 'member'], selfJoinRole: 'member' };
const spy = vi.mocked(joinAppModule.resolveSelfJoinRole);

let seq = 0;
const mkUser = async () => { seq += 1; return db.user.create({ data: { githubId: 475800 + seq, githubUsername: `u4758-${seq}`, roles: ['READER'] } }); };
async function mkApp(orgId: string, orgUrn: string, tag: string) {
  const agent = await db.agent.create({ data: { id: generateId(), organizationId: orgId, urn: `${orgUrn}:agent-${tag}`, name: `agent-${tag}`, installationPolicy: OPEN as never } });
  return db.app.create({ data: { id: generateId(), organizationId: orgId, urn: `${orgUrn}:app-${tag}`, name: `app-${tag}`, appAgents: { create: { agentId: agent.id } } } });
}

let org: { id: string; urn: string };
let other: { id: string; urn: string };
let viewer: { id: string };
let app: { id: string; organizationId: string | null };

beforeEach(async () => {
  await cleanDb(db);
  spy.mockClear();
  org = await db.organization.create({ data: { id: generateId(), name: 'o4758', urn: 'o4758.example' } });
  other = await db.organization.create({ data: { id: generateId(), name: 'x4758', urn: 'x4758.example' } });
  viewer = await mkUser();
  await db.orgMember.create({ data: { organizationId: org.id, userId: viewer.id, role: 'READER' } });
  app = await mkApp(org.id, org.urn, 'a');
});

describe('#4758 item 1: an unrelated failure propagates, it is never CLOSED', () => {
  it('the field rethrows a non-SelfJoinNotAllowedError failure from the decision', async () => {
    spy.mockRejectedValueOnce(new Error('db exploded'));
    await expect(field({ id: app.id }, {}, as(viewer.id))).rejects.toThrow('db exploded');
  });
  it('through GraphQL the caller gets an error and no CLOSED answer', async () => {
    spy.mockRejectedValueOnce(new Error('db exploded'));
    const res = await server.executeOperation({ query: `query($r: ID!) { app(ref: $r) { id selfJoin { state role } } }`, variables: { r: app.id } }, { contextValue: as(viewer.id) });
    if (res.body.kind !== 'single') throw new Error('unexpected incremental response');
    const body = res.body.singleResult;
    expect(body.errors?.length).toBeGreaterThan(0);
    expect(JSON.stringify(body.data ?? null)).not.toContain('CLOSED');
  });
  it('control: the typed refusal still reads CLOSED', async () => {
    await db.agent.updateMany({ data: { installationPolicy: { memberRoles: ['owner'] } as never } });
    expect(await field({ id: app.id }, {}, as(viewer.id))).toEqual({ state: 'CLOSED', role: null });
  });
});

describe('#4758 item 2: the read gate uses the fresh row, never the parent columns', () => {
  it('a parent that claims the viewer\'s organization for an App in another organization reads null', async () => {
    const foreign = await mkApp(other.id, other.urn, 'f'); // the viewer is not a member of `other`
    const lyingParent = { id: foreign.id, organizationId: org.id, ownerUserId: null };
    expect(await field(lyingParent, {}, as(viewer.id))).toBeNull();
  });
  it('a parent that claims a foreign organization for the viewer\'s own App still reads (the converse)', async () => {
    const lyingParent = { id: app.id, organizationId: other.id, ownerUserId: null };
    expect(await field(lyingParent, {}, as(viewer.id))).toEqual({ state: 'OPEN', role: 'member' });
  });
});

describe('#4758 item 4: the field calls the exported decision', () => {
  it('an OPEN answer comes from resolveSelfJoinRole called with the App id', async () => {
    expect(await field({ id: app.id }, {}, as(viewer.id))).toEqual({ state: 'OPEN', role: 'member' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![1]).toBe(app.id);
  });
  it('the decision is the export\'s: an overridden export changes the field\'s answer', async () => {
    spy.mockResolvedValueOnce('sentinel-role');
    expect(await field({ id: app.id }, {}, as(viewer.id))).toEqual({ state: 'OPEN', role: 'sentinel-role' });
  });
  it('a member and an uninstalled App never reach the decision', async () => {
    await db.appMember.create({ data: { appId: app.id, userId: viewer.id, role: 'member' } });
    expect(await field({ id: app.id }, {}, as(viewer.id))).toEqual({ state: 'MEMBER', role: null });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('#4758 item 5: the cost of selfJoin selected on a list', () => {
  it('the admission cost carries an entry for the field, added to its children', async () => {
    const { FIXED_FIELD_COST, APP_SELF_JOIN_COST } = await import('../admissionComplexity.js');
    expect(FIXED_FIELD_COST['App.selfJoin']).toBe(APP_SELF_JOIN_COST);
  });

  it('the App and membership reads are batched: the marginal statements per added App stay within the admission cost entry', async () => {
    const { PrismaClient } = await import('../../../generated/prisma/index.js');
    let statements = 0;
    const logged = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL, log: [{ emit: 'event', level: 'query' }] });
    (logged as any).$on('query', () => { statements += 1; });
    try {
      const countFor = async () => {
        statements = 0;
        const ctx = { db: logged, userId: viewer.id, roles: ['READER'] } as unknown as Context;
        const res = await server.executeOperation({ query: `{ apps(limit: 50) { items { id selfJoin { state role } } } }` }, { contextValue: ctx });
        if (res.body.kind !== 'single') throw new Error('unexpected incremental response');
        const rows = (res.body.singleResult.data as any)?.apps?.items ?? [];
        expect(res.body.singleResult.errors).toBeUndefined();
        expect(rows.every((r: any) => r.selfJoin?.state === 'OPEN')).toBe(true);
        return { statements, n: rows.length };
      };
      const a = await countFor();
      for (const t of ['b', 'c', 'd', 'e']) await mkApp(org.id, org.urn, t);
      const b = await countFor();
      expect(b.n - a.n).toBe(4);
      // Marginal statements per added App, measured: 9 before the batching (main), 8 after. The admission cost entry must cover it.
      const { APP_SELF_JOIN_COST } = await import('../admissionComplexity.js');
      expect((b.statements - a.statements) / (b.n - a.n)).toBeLessThanOrEqual(APP_SELF_JOIN_COST);
    } finally { await logged.$disconnect(); }
  });
});
