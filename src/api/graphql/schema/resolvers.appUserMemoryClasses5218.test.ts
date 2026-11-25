/**
 * #5218 (Billing A6 of #5182) — `App.viewerAppUserMemoryClasses`: which of
 * `personal` / `private` the signed-in viewer may still create in this App.
 * Proposed clause of hrn:node:hadronmemory.com:specs:cor:dmo:060:20, "Asking
 * which classes one may still create".
 *
 * The load-bearing pin is differential: for every case, the field's answer is
 * exactly the set of classes `createMemoryInApp` does not refuse for that same
 * caller. Nothing here restates the door's rules.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey, createDbAppAgent, createDbAppMember } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { requestActorStorage, emptyActor, publishAmbiguousActor } from '../../../lib/requestActor.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const server = new ApolloServer({ typeDefs, resolvers });
const createMemoryInApp = resolvers.Mutation.createMemoryInApp as (
  _: unknown, args: Record<string, unknown>, ctx: Context,
) => Promise<{ id: string }>;

const CLASSES = ['personal', 'private'] as const;
const QUERY = 'query ($ref: ID!) { app(ref: $ref) { viewerAppUserMemoryClasses } }';

let orgId: string;
let agentId: string;
let appId: string;
let userAppId: string; // user-owned
let member: string;
let other: string; // second member
let outsider: string; // org ADMIN, not an App member
let userOwner: string;

const ctxFor = (userId: string | undefined, over: Partial<Context> = {}): Context =>
  ({ db, userId, roles: ['READER'], ...over }) as Context;

/** The field as GraphQL serves it to a caller who can read the App. */
async function served(ctx: Context, ref = appId): Promise<string[]> {
  const result = await server.executeOperation({ query: QUERY, variables: { ref } }, { contextValue: ctx });
  const body = (result.body as { singleResult: { data?: any; errors?: Array<{ message: string }> } }).singleResult;
  expect(body.errors).toBeUndefined();
  return body.data.app.viewerAppUserMemoryClasses;
}

/** The field resolver itself, for callers the App read gate may stop earlier. */
async function field(ctx: Context, id = appId): Promise<string[]> {
  const resolve = (resolvers.App as Record<string, any>).viewerAppUserMemoryClasses;
  expect(resolve, 'App.viewerAppUserMemoryClasses has a resolver').toBeTypeOf('function');
  return resolve({ id }, {}, ctx);
}

const create = (ctx: Context, memoryClass: string, app = appId) =>
  createMemoryInApp(null, { appRef: app, agentRef: agentId, memoryClass, name: `n-${memoryClass}-${generateId()}` }, ctx);

/** What the door admits for this caller, asked one class at a time. */
async function doorAdmits(ctx: Context, app = appId): Promise<string[]> {
  const admitted: string[] = [];
  for (const klass of CLASSES) {
    try {
      await create(ctx, klass, app);
      admitted.push(klass);
    } catch {
      // refused
    }
  }
  return admitted;
}

/** Read the field FIRST (the door's successes change the answer), then compare with the door. */
async function differential(ctx: Context, expected: readonly string[], app = appId): Promise<void> {
  const answer = await field(ctx, app);
  expect(answer).toEqual(expected);
  expect(await doorAdmits(ctx, app)).toEqual(answer);
}

beforeEach(async () => {
  await cleanDb(db);
  const mkUser = async (handle: string) =>
    (await db.user.create({ data: { id: generateId(), handle, name: handle, roles: ['READER'] } })).id;
  member = await mkUser('mia5218');
  other = await mkUser('noor5218');
  outsider = await mkUser('olu5218');
  userOwner = await mkUser('uma5218');
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'Org', urn: 'org5218.test' } })).id;
  for (const [userId, role] of [[member, 'READER'], [other, 'READER'], [outsider, 'ADMIN']] as const) {
    await db.orgMember.create({ data: { organizationId: orgId, userId, role } });
  }
  agentId = (await db.agent.create({
    data: { id: generateId(), name: 'coach', urn: 'org5218.test:coach', organizationId: orgId },
  })).id;
  appId = (await createDbAppWithKey(db, 'tutor5218', orgId)).app.id;
  await createDbAppAgent(db, appId, agentId);
  await createDbAppMember(db, appId, member, 'eater');
  await createDbAppMember(db, appId, other, 'eater');
  userAppId = generateId();
  await db.app.create({ data: { id: userAppId, name: 'Own', urn: '@uma5218:own', ownerUserId: userOwner } });
  await createDbAppAgent(db, userAppId, agentId);
  await createDbAppMember(db, userAppId, userOwner, 'owner');
});

describe('#5218 App.viewerAppUserMemoryClasses', () => {
  it('lists both for a member with neither, then only what is left', async () => {
    expect(await served(ctxFor(member))).toEqual(['personal', 'private']);
    await create(ctxFor(member), 'private');
    expect(await served(ctxFor(member))).toEqual(['personal']);
    await create(ctxFor(member), 'personal');
    expect(await served(ctxFor(member))).toEqual([]);
  });

  it('a member with neither: the door admits exactly what is listed', async () => {
    await differential(ctxFor(member), ['personal', 'private']);
    expect(await field(ctxFor(member))).toEqual([]);
  });

  it('a soft-deleted memory frees its class (R6)', async () => {
    const mem = await create(ctxFor(member), 'private');
    await db.memory.update({ where: { id: mem.id }, data: { deletedAt: new Date() } });
    await differential(ctxFor(member), ['personal', 'private']);
  });

  it('a memory made before the rule, unmarked, does not count (R4)', async () => {
    for (const klass of CLASSES) {
      await db.memory.create({ data: {
        id: generateId(), organizationId: orgId, urn: `org5218.test:old-${klass}`, name: `old ${klass}`,
        class: klass, appId, userId: member, userMemoryOfAgentId: agentId, visibility: null,
      } });
    }
    await differential(ctxFor(member), ['personal', 'private']);
  });

  it('a marked memory in another App does not count here', async () => {
    const second = (await createDbAppWithKey(db, 'second5218', orgId)).app.id;
    await createDbAppAgent(db, second, agentId);
    await createDbAppMember(db, second, member, 'eater');
    await create(ctxFor(member), 'private', second);
    await differential(ctxFor(member), ['personal', 'private']);
  });

  it("another member's memories never change the answer, byte for byte", async () => {
    const read = async () => JSON.stringify(await served(ctxFor(member)));
    const before = await read();
    for (const klass of CLASSES) await create(ctxFor(other), klass);
    expect(await read()).toBe(before);
    await db.memory.updateMany({ where: { userId: other }, data: { deletedAt: new Date() } });
    expect(await read()).toBe(before);
  });

  const refused: Array<[string, () => Context]> = [
    ['a non-member (org ADMIN)', () => ctxFor(outsider)],
    ['a platform admin who is not a member', () => ctxFor(outsider, { roles: ['ADMIN'] })],
    ['an unauthenticated caller', () => ctxFor(undefined)],
    ['an App key', () => ctxFor(undefined, { appId, appKeyId: 'key5218' })],
    ['an App key carrying a member', () => ctxFor(member, { appId, appKeyId: 'key5218' })],
    ['an impersonation of a member', () => ctxFor(member, { impersonation: { adminUserId: outsider } as never })],
    ['a run principal carrying a member', () => ctxFor(member, { appId, clientId: 'run:r5218' })],
    ['a worker session of a member', () => ctxFor(member, { sessionId: 'session5218' })],
    ['a refused session binding', () => ctxFor(member, { sessionBindingRefused: true as never })],
  ];
  for (const [label, ctx] of refused) {
    it(`${label} reads [] and the door refuses both classes`, async () => {
      await differential(ctx(), []);
    });
  }

  it('a request naming more than one session reads what the door answers', async () => {
    await requestActorStorage.run(emptyActor(), async () => {
      publishAmbiguousActor(['s1', 's2']);
      const answer = await field(ctxFor(member));
      expect(await doorAdmits(ctxFor(member))).toEqual(answer);
    });
  });

  it('an uninstalled App lists nothing', async () => {
    await db.app.update({ where: { id: appId }, data: { uninstalledAt: new Date() } });
    await differential(ctxFor(member), []);
  });

  it('an App with no Agent installed lists nothing', async () => {
    await db.appAgent.deleteMany({ where: { appId } });
    await differential(ctxFor(member), []);
  });

  it("a member of a user-owned App gets exactly the door's answer", async () => {
    const answer = await field(ctxFor(userOwner), userAppId);
    expect(await doorAdmits(ctxFor(userOwner), userAppId)).toEqual(answer);
  });
});
