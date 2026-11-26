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
import { cleanDb, createDbAgentImport, createDbAgentOrgGrant, createDbAppWithKey, createDbAppAgent, createDbAppMember } from '../../../test/helpers.js';
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

const create = (ctx: Context, memoryClass: string, app = appId, agentRef = agentId) =>
  createMemoryInApp(null, { appRef: app, agentRef, memoryClass, name: `n-${memoryClass}-${generateId()}` }, ctx);

/**
 * What the door answers this caller, one class at a time, through every Agent installed in the App or imported by one.
 * Each refusal is kept as `CODE: message`, so a case can say WHY the door refused: a bare "refused" would let a broken
 * fixture agree with the field for the wrong reason.
 */
async function door(ctx: Context, app = appId): Promise<{ admitted: string[]; refusals: string[] }> {
  const rows = await db.appAgent.findMany({ where: { appId: app }, select: { agentId: true } });
  const imported = await db.agentImport.findMany({
    where: { parentAgentId: { in: rows.map((r) => r.agentId) } }, select: { importedAgentId: true },
  });
  const agents = [...new Set([...rows.map((r) => r.agentId), ...imported.map((i) => i.importedAgentId)])];
  // An App with no Agent still has to answer: ask through the seeded one.
  if (agents.length === 0) agents.push(agentId);
  const admitted: string[] = [];
  const refusals: string[] = [];
  for (const klass of CLASSES) {
    for (const agentRef of agents) {
      try {
        await create(ctx, klass, app, agentRef);
        admitted.push(klass);
        break;
      } catch (error) {
        const e = error as { message: string; code?: string; extensions?: { code?: string } };
        refusals.push(`${e.extensions?.code ?? e.code ?? 'ERROR'}: ${e.message}`);
      }
    }
  }
  return { admitted, refusals };
}

/** Read the field FIRST (the door's successes change the answer), then compare with the door. */
async function differential(ctx: Context, expected: readonly string[], app = appId): Promise<string[]> {
  const answer = await field(ctx, app);
  expect(answer).toEqual(expected);
  const { admitted, refusals } = await door(ctx, app);
  expect(admitted).toEqual(answer);
  return refusals;
}

/** Nothing is listed, and the door refuses both classes for the named reason and no other. */
async function refusedBecause(ctx: Context, reason: RegExp, app = appId): Promise<void> {
  const refusals = await differential(ctx, [], app);
  expect(refusals.length).toBeGreaterThanOrEqual(CLASSES.length);
  for (const refusal of refusals) expect(refusal).toMatch(reason);
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
    // The door's creates above now hold both classes.
    await refusedBecause(ctxFor(member), /^APP_USER_MEMORY_ALREADY_EXISTS: /);
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

  const DENIED = /^FORBIDDEN: |denied|not authorized/i;
  const NOT_MEMBER = /must be a member of this App/;
  const NOT_INSTALLED = /^AGENT_NOT_INSTALLED: /;
  const refused: Array<[string, () => Context, RegExp]> = [
    ['a non-member (org ADMIN)', () => ctxFor(outsider), NOT_MEMBER],
    ['a platform admin who is not a member', () => ctxFor(outsider, { roles: ['ADMIN'] }), NOT_MEMBER],
    ['an unauthenticated caller', () => ctxFor(undefined), /^UNAUTHENTICATED: /],
    ['an App key', () => ctxFor(undefined, { appId, appKeyId: 'key5218' }), /^UNAUTHENTICATED: /],
    ['an App key carrying a member', () => ctxFor(member, { appId, appKeyId: 'key5218' }), DENIED],
    ['an impersonation of a member', () => ctxFor(member, { impersonation: { adminUserId: outsider } as never }), DENIED],
    ['a run principal carrying a member', () => ctxFor(member, { appId, clientId: 'run:r5218' }), DENIED],
    ['a worker session of a member', () => ctxFor(member, { sessionId: 'session5218' }), DENIED],
    ['a refused session binding', () => ctxFor(member, { sessionBindingRefused: true }), DENIED],
  ];
  for (const [label, ctx, reason] of refused) {
    it(`${label} reads [] and the door refuses both classes`, async () => {
      await refusedBecause(ctx(), reason);
    });
  }

  // The door's principal check does not consult the request's worker attribution, so neither does the field.
  it('a request naming more than one session reads what the door answers', async () => {
    await requestActorStorage.run(emptyActor(), async () => {
      publishAmbiguousActor(['s1', 's2']);
      await differential(ctxFor(member), ['personal', 'private']);
    });
  });

  it('an uninstalled App lists nothing', async () => {
    await db.app.update({ where: { id: appId }, data: { uninstalledAt: new Date() } });
    await refusedBecause(ctxFor(member), /^APP_UNINSTALLED: /);
  });

  it('an App with no Agent installed lists nothing', async () => {
    await db.appAgent.deleteMany({ where: { appId } });
    await refusedBecause(ctxFor(member), NOT_INSTALLED);
  });

  const foreignOrg = (urn: string) => db.organization.create({ data: { id: generateId(), name: urn, urn } });
  const dead: Array<[string, () => Promise<unknown>, RegExp]> = [
    ['a soft-deleted App', () => db.app.update({ where: { id: appId }, data: { deletedAt: new Date() } }), /^APP_NOT_FOUND: /],
    ['a soft-deleted organization', () => db.organization.update({ where: { id: orgId }, data: { deletedAt: new Date() } }), /^FORBIDDEN: Forbidden$/],
    ['a soft-deleted caller', () => db.user.update({ where: { id: member }, data: { deletedAt: new Date() } }), /^FORBIDDEN: Forbidden$/],
    ['an App whose only Agent is deleted', () => db.agent.update({ where: { id: agentId }, data: { deletedAt: new Date() } }), NOT_INSTALLED],
    // The Agent row stays installed, but another organization's private Agent has no licence here (#1526).
    ['an App whose only Agent is installed but unlicensed', async () => {
      const foreign = await foreignOrg('foreign5218.test');
      await db.agent.update({ where: { id: agentId }, data: { organizationId: foreign.id, visibility: 'PERSONAL' } });
    }, NOT_INSTALLED],
    ['a soft-deleted organization whose App has a PUBLIC Agent of another one', async () => {
      const foreign = await foreignOrg('public5218.test');
      await db.agent.update({ where: { id: agentId }, data: { organizationId: foreign.id, visibility: 'PUBLIC' } });
      await db.agentOrgGrant.create({ data: { orgId, agentId } });
      await db.organization.update({ where: { id: orgId }, data: { deletedAt: new Date() } });
    }, /^FORBIDDEN: Forbidden$/],
  ];
  for (const [label, kill, reason] of dead) {
    it(`${label} lists nothing`, async () => {
      await kill();
      await refusedBecause(ctxFor(member), reason);
    });
  }

  it('one usable Agent beside an unusable one is enough, whichever was installed first', async () => {
    const foreign = await db.organization.create({ data: { id: generateId(), name: 'F', urn: 'foreign5218.test' } });
    await db.agent.update({ where: { id: agentId }, data: { organizationId: foreign.id, visibility: 'PERSONAL' } });
    const usable = await db.agent.create({
      data: { id: generateId(), name: 'usable', urn: 'org5218.test:usable', organizationId: orgId },
    });
    await createDbAppAgent(db, appId, usable.id);
    await differential(ctxFor(member), ['personal', 'private']);
  });

  it('a usable imported (derived) Agent is enough, as at the door', async () => {
    const foreign = await db.organization.create({ data: { id: generateId(), name: 'F', urn: 'foreign5218.test' } });
    await db.agent.update({ where: { id: agentId }, data: { organizationId: foreign.id, visibility: 'PERSONAL' } });
    const child = await db.agent.create({
      data: { id: generateId(), name: 'child', urn: 'org5218.test:child', organizationId: orgId },
    });
    for (const grantee of [orgId, foreign.id]) await createDbAgentOrgGrant(db, grantee, child.id);
    await createDbAgentImport(db, agentId, child.id);
    expect(await db.appAgent.count({ where: { appId, agentId: child.id } })).toBe(0);
    await differential(ctxFor(member), ['personal', 'private']);
  });

  it("a member of a user-owned App gets exactly the door's answer", async () => {
    // The owner's own Agent is licensed there, so the App's ownership is what the door judges.
    await db.agent.update({ where: { id: agentId }, data: { organizationId: null, ownerUserId: userOwner } });
    // Today the door refuses both for this reason; #5186 changes the door and this expectation together.
    await refusedBecause(ctxFor(userOwner), /not yet supported for a user-owned App/, userAppId);
  });
});
