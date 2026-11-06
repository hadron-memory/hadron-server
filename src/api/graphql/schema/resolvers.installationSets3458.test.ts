/** #3458: reverse rows promise membership, not order; computed scopes are sets.
 * The test-local seam permutes only unordered outer query results, never the
 * nested physical createdAt/agentId ordering which owns legacy primary identity.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAgentImport, createDbAgentOrgGrant } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { appScopeMemoryIds, resolveSearchScope } from '../../../lib/scopes.js';
import { resolvers, type Context } from './resolvers.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
let orgId: string, userId: string, appId: string, otherAppId: string;
let physical: any, derived: any, foreign: any;
let shared: string, firstOnly: string, secondOnly: string, own: string, alien: string, unreadable: string;
const ctx = (): Context => ({ db, userId, roles: ['READER'] });
const members = (ids: string[]) => {
  expect(ids.length).toBe(new Set(ids).size); // don't hide duplicate returns behind set equality
  return new Set(ids);
};
beforeEach(async () => {
  await cleanDb(db);
  const suffix = generateId().toLowerCase();
  const org = await db.organization.create({ data: { name: 'Sets', urn: `sets-${suffix}.example` } });
  orgId = org.id;
  const external = await db.organization.create({ data: { name: 'Foreign', urn: `foreign-${suffix}.example` } });
  const user = await db.user.create({ data: { handle: `sets-${suffix}`, roles: ['READER'] } });
  userId = user.id;
  await db.orgMember.create({ data: { organizationId: orgId, userId, role: 'ADMIN' } });
  physical = await M.createAgent({}, { orgId, name: 'Physical', personaRole: 'writer' }, ctx());
  derived = await M.createAgent({}, { orgId, name: 'Derived', personaRole: 'reader' }, ctx());
  foreign = await db.agent.create({ data: { name: 'Unlicensed', urn: `${external.urn}:agent`, organizationId: external.id, visibility: 'ORGANIZATION' } });
  const app = async (name: string, day: number) => db.app.create({ data: { name, urn: `${org.urn}:${name}`, organizationId: orgId, createdAt: new Date(`2026-01-0${day}`) } });
  appId = (await app('older', 1)).id;
  otherAppId = (await app('newer', 2)).id;
  // App chronology opposes physical installation chronology. Derived in one,
  // physical in the other: neither date nor kind is a reverse-list contract.
  await db.appAgent.create({ data: { appId, agentId: physical.id, createdAt: new Date('2026-01-09') } });
  await db.appAgent.create({ data: { appId: otherAppId, agentId: derived.id, createdAt: new Date('2026-01-03') } });
  const hiddenApp = await db.app.create({ data: { name: 'Not readable', urn: `${external.urn}:app`, organizationId: external.id } });
  await db.appAgent.create({ data: { appId: hiddenApp.id, agentId: derived.id } });
  await createDbAgentOrgGrant(db, orgId, derived.id);
  await createDbAgentImport(db, physical.id, derived.id);
  await db.appAgent.create({ data: { appId, agentId: foreign.id } });
  const memory = async (name: string, data: Record<string, unknown> = {}) => (await db.memory.create({ data: {
    name, urn: `${org.urn}:${name}`, class: 'knowledge', organizationId: orgId, visibility: 'ORGANIZATION', ...data,
  } as any })).id;
  shared = await memory('shared'); firstOnly = await memory('first'); secondOnly = await memory('second');
  own = await memory('own', { class: 'app', appId, visibility: null });
  alien = await memory('other-app', { class: 'app', appId: otherAppId, visibility: null });
  unreadable = await memory('foreign-only', { organizationId: external.id });
  for (const [agentId, ids] of [[physical.id, [shared, firstOnly, alien]], [derived.id, [shared, secondOnly]], [foreign.id, [unreadable]]] as Array<[string, string[]]>)
    for (const memoryId of ids) await db.agentMemoryItem.create({ data: { agentId, memoryId, role: 'read' } });
});
afterEach(() => vi.restoreAllMocks());

function permuteUnorderedQueries() {
  // These reads are awaited individually, never passed to a Prisma transaction;
  // the spy unwraps PrismaPromise solely to permute the real result rows.
  const apps = db.app.findMany.bind(db.app);
  const agents = db.agent.findMany.bind(db.agent);
  const appSpy = vi.spyOn(db.app as any, 'findMany').mockImplementation(async (args: any) => {
    const rows = await apps(args);
    return args?.orderBy ? rows : [...rows].reverse();
  });
  const agentSpy = vi.spyOn(db.agent as any, 'findMany').mockImplementation(async (args: any) => {
    const rows = await agents(args);
    return args?.orderBy ? rows : [...rows].reverse();
  });
  return { appSpy, agentSpy };
}

describe('#3458 reverse NO-order / scope SET disposition', () => {
  it('reverse physical and derived installations retain the same membership under outer App permutations', async () => {
    const reverse = () => (resolvers.Agent as any).appAgents(derived, {}, ctx());
    const before = await reverse();
    expect(members(before.map((r: any) => r.appId))).toEqual(new Set([appId, otherAppId]));
    expect(new Set(before.map((r: any) => r.installationKind))).toEqual(new Set(['ROW', 'DERIVED']));
    const { appSpy } = permuteUnorderedQueries();
    const after = await reverse();
    expect(appSpy.mock.calls.some(([args]: any) => !args.orderBy && args.select?.appAgents)).toBe(true);
    expect(members(after.map((r: any) => r.appId))).toEqual(new Set([appId, otherAppId]));
    // Intentionally no equality assertion on array positions or install dates.
  });

  it('scope membership deduplicates linked memories and excludes other-App/unlicensed rows regardless of Agent return order', async () => {
    const expected = new Set([shared, firstOnly, secondOnly, own]);
    const before = await appScopeMemoryIds(db, appId);
    expect(members(before)).toEqual(expected);
    const { agentSpy } = permuteUnorderedQueries();
    const after = await appScopeMemoryIds(db, appId);
    expect(agentSpy.mock.calls.some(([args]: any) => !args.orderBy && args.select?.memoryItems)).toBe(true);
    expect(members(after)).toEqual(expected);
    expect(after).not.toContain(alien); expect(after).not.toContain(unreadable);
  });

  it('ordinary app search-scope admission and selected node results do not depend on outer Agent order', async () => {
    for (const id of [shared, firstOnly, secondOnly, own, alien, unreadable])
      await db.node.create({ data: { memoryId: id, loc: 'notes', name: 'Notes', content: id } });
    const select = async () => {
      const scope = await resolveSearchScope(ctx(), { scopeArg: 'app', appId, ambient: false });
      expect(scope?.kind).toBe('app');
      const ids = scope!.memoryIds!;
      expect(members(ids)).toEqual(new Set([shared, firstOnly, secondOnly, own]));
      const result = await (resolvers.Query as any).findNodes({}, { scope: 'app', appRef: appId }, ctx());
      expect(result.scope).toMatchObject({ kind: 'app', droppedCount: 0 });
      expect(members(result.hits.map((hit: any) => hit.node.memoryId))).toEqual(new Set([shared, firstOnly, secondOnly, own]));
      return result.hits.map((hit: any) => hit.node.id);
    };
    const ordinaryResults = await select();
    permuteUnorderedQueries();
    expect(await select()).toEqual(ordinaryResults); // ordinary search ordering, not scope ordering
  });
});
