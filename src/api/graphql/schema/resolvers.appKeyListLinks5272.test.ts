/**
 * #5272 (hrn:node:hadronmemory.com:specs:cor:api:120:03, App-key line, Proposed 2026-11-26): GraphQL `memories` for a pure
 * App key lists, besides its installed Agents' memory items, every memory the App's links let the key read, judged at use by
 * the same judge as the reads (`linkedReachFor`, #5185). MCP `hadron_list_memories` already lists them (`buildAccessMap`), so
 * the two list surfaces agree.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { getMemoryAccess } from '../../../mcp/access-control.js';
import { linkedReachFor } from '../../../lib/appMemoryLinks.js';
import type { Prisma } from '../../../generated/prisma/index.js';
import type { AuthContext } from '../../../middleware/auth.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

// The two resolvers under test, reached through ONE explicit cast seam to a small typed shape: it gives these pins typed call
// sites and results. It is NOT compared against the resolver map (the cast goes through `unknown`), so a renamed resolver
// argument fails these pins at run time, not at compile time; the fixtures below are the compile-checked part
// (`satisfies Prisma.*UncheckedCreateInput`). #5361 item 4; blind review F1.
type MemoriesArgs = { limit?: number; offset?: number; filter?: { memoryClasses?: string[]; visibility?: string } };
type MemoryPage = { items: Array<{ id: string }>; total: number };
const M = resolvers.Mutation as unknown as {
  attachMemoryToApp: (parent: null, args: { memoryRef: string; appRef: string }, ctx: Context) => Promise<unknown>;
};
const Q = resolvers.Query as unknown as {
  memories: (parent: null, args: MemoriesArgs, ctx: Context) => Promise<MemoryPage>;
  memory: (parent: null, args: { ref: string }, ctx: Context) => Promise<{ id: string } | null>;
};

let org: { id: string; urn: string };
let alice: string; // org READER and App member: the attacher
let otto: string; // owner of a user-owned App (personal links)
let app: { id: string }; // the org's App, with the org's Agent installed
let userApp: { id: string }; // otto's App, no Agent installed
let agentMemory: { id: string }; // the installed Agent's memory item
let linked: { id: string }; // org knowledge, linked to the App by alice
let unlinked: { id: string }; // org knowledge alice reads, not linked

const asUser = (userId: string): Context => ({ db, userId, roles: [] }) as Partial<Context> as Context;
const keyAuth = (appId: string): AuthContext => ({ appId, roles: [], clientId: `app:${appId}` }) as Partial<AuthContext> as AuthContext;
const keyCtx = (appId: string): Context => ({ db, ...keyAuth(appId) }) as Partial<Context> as Context;
const attach = (c: Context, memoryRef: string, appRef: string) => M.attachMemoryToApp(null, { memoryRef, appRef }, c);
const list = async (c: Context, args: MemoriesArgs = {}) => {
  const page = await Q.memories(null, { limit: 100, ...args }, c);
  return { ids: page.items.map((m) => m.id).sort(), total: page.total };
};
const mcpList = async (appId: string) => [...(await getMemoryAccess(db, keyAuth(appId))).keys()].sort();
const sorted = (...ids: string[]) => [...ids].sort();
const setMembership = (userId: string, live: boolean) =>
  db.orgMember.updateMany({ where: { organizationId: org.id, userId }, data: { deletedAt: live ? null : new Date() } });

async function personal(userId: string) {
  return db.memory.create({
    data: { id: generateId(), name: `p-${generateId().slice(-6)}`, urn: `hrn-test-${generateId().slice(-8)}`, class: 'personal', userId, ownerUserId: userId, organizationId: null, visibility: null } satisfies Prisma.MemoryUncheckedCreateInput,
  });
}
async function orgKnowledge(name: string, visibility: 'ORGANIZATION' | 'PUBLIC' = 'ORGANIZATION') {
  return db.memory.create({
    data: { id: generateId(), name, urn: `${org.urn}:${name}-${generateId().slice(-6)}`, class: 'knowledge', visibility, organizationId: org.id } satisfies Prisma.MemoryUncheckedCreateInput,
  });
}

beforeEach(async () => {
  await cleanDb(db);
  org = (await createDbOrgAndGraph(db, { orgName: 'list5272', graphName: 'base' })).org;
  const person = async (n: number, h: string) =>
    (await db.user.create({ data: { id: generateId(), githubId: 5_272_000 + n, githubUsername: h, handle: `${h}-${generateId().slice(-6)}` } })).id;
  [alice, otto] = [await person(1, 'alice'), await person(2, 'otto')];
  await db.orgMember.create({ data: { organizationId: org.id, userId: alice, role: 'READER' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'OrgApp', urn: `${org.urn}:orgapp` } satisfies Prisma.AppUncheckedCreateInput });
  await db.appMember.create({ data: { appId: app.id, userId: alice, role: 'member' } });
  const agent = await db.agent.create({ data: { id: generateId(), name: 'OrgAgent', urn: `${org.urn}:agent`, organizationId: org.id } satisfies Prisma.AgentUncheckedCreateInput });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  // A pure App key is credential-only (#1376): it folds an Agent's PUBLIC knowledge items.
  agentMemory = await orgKnowledge('agentmem', 'PUBLIC');
  await db.agentMemoryItem.create({ data: { agentId: agent.id, memoryId: agentMemory.id, role: 'read' } });
  linked = await orgKnowledge('linked');
  unlinked = await orgKnowledge('unlinked');
  await attach(asUser(alice), linked.id, app.id);
  userApp = await db.app.create({ data: { id: generateId(), ownerUserId: otto, name: 'UserApp', urn: `otto-${generateId().slice(-6)}:userapp` } satisfies Prisma.AppUncheckedCreateInput });
  await db.appMember.create({ data: { appId: userApp.id, userId: otto, role: 'owner' } });
});

describe('#5272 GraphQL memories for a pure App key lists what its links let it read', () => {
  it('lists the Agent memory and the linked memory, not the unlinked one; total counts both', async () => {
    const out = await list(keyCtx(app.id));
    expect(out.ids).toEqual(sorted(agentMemory.id, linked.id));
    expect(out.total).toBe(2);
    expect(out.ids).not.toContain(unlinked.id);
  });

  it('agrees with MCP hadron_list_memories for the same key (parity)', async () => {
    expect(await mcpList(app.id)).toEqual(sorted(agentMemory.id, linked.id));
    expect((await list(keyCtx(app.id))).ids).toEqual(await mcpList(app.id));
  });

  it('a link that lapses (the attacher loses read) drops out of the list at once, and comes back with the read', async () => {
    expect((await list(keyCtx(app.id))).ids).toContain(linked.id);
    await setMembership(alice, false);
    const lapsed = await list(keyCtx(app.id));
    expect(lapsed).toEqual({ ids: [agentMemory.id], total: 1 });
    expect(lapsed.ids).toEqual(await mcpList(app.id));
    await setMembership(alice, true);
    expect((await list(keyCtx(app.id))).ids).toContain(linked.id);
  });

  it('an App with links and no installed Agent lists its links, as MCP does (a personal memory its owner linked)', async () => {
    const own = await personal(otto);
    const other = await personal(otto);
    await attach(asUser(otto), own.id, userApp.id);
    const out = await list(keyCtx(userApp.id));
    expect(out).toEqual({ ids: [own.id], total: 1 });
    expect(out.ids).not.toContain(other.id);
    expect(out.ids).toEqual(await mcpList(userApp.id));
  });

  it('dedupes a memory that is both an Agent item and linked; pages and counts the union', async () => {
    await attach(asUser(alice), agentMemory.id, app.id);
    const all = await list(keyCtx(app.id));
    expect(all.ids).toEqual(sorted(agentMemory.id, linked.id));
    expect(all.total).toBe(2);
    const p1 = await Q.memories(null, { limit: 1, offset: 1 }, keyCtx(app.id));
    expect(p1.total).toBe(2);
    expect(p1.items).toHaveLength(1);
    const count = await Q.memories(null, { limit: 0 }, keyCtx(app.id));
    expect(count).toMatchObject({ items: [], total: 2 });
  });

  it('applies the class and visibility filters to linked memories like to the Agent items', async () => {
    const own = await personal(otto);
    await attach(asUser(otto), own.id, userApp.id);
    expect((await list(keyCtx(app.id), { filter: { memoryClasses: ['knowledge'] } })).ids).toEqual(sorted(agentMemory.id, linked.id));
    expect((await list(keyCtx(app.id), { filter: { memoryClasses: ['group'] } })).ids).toEqual([]);
    // (PUBLIC is the marketplace slice, answered before the App-key branch.) A visibility the linked memory lacks drops it.
    expect((await list(keyCtx(app.id), { filter: { visibility: 'GROUP' } })).ids).toEqual([]);
    expect((await list(keyCtx(app.id), { filter: { visibility: 'ORGANIZATION' } })).ids).toEqual([linked.id]);
    expect((await list(keyCtx(userApp.id), { filter: { memoryClasses: ['knowledge'] } })).ids).toEqual([]);
    expect((await list(keyCtx(userApp.id), { filter: { memoryClasses: ['personal'] } })).ids).toEqual([own.id]);
  });

  it('a user with the App selected, a session-bound key and a deleted App get no link reach in the list', async () => {
    const outsider = (await db.user.create({ data: { id: generateId(), githubId: 5_272_009, githubUsername: 'x', handle: `x-${generateId().slice(-6)}` } })).id;
    expect((await list({ db, userId: outsider, appId: app.id, roles: [] } as Partial<Context> as Context)).ids).not.toContain(linked.id);
    expect((await list({ ...keyCtx(app.id), sessionId: generateId() } as Partial<Context> as Context)).ids).not.toContain(linked.id);
    await db.app.update({ where: { id: app.id }, data: { deletedAt: new Date() } });
    expect(await list(keyCtx(app.id))).toEqual({ ids: [], total: 0 });
  });
  it('the record gate still applies to a linked memory: the list never shows one `memory(ref:)` refuses the key', async () => {
    const userKnowledge = await db.memory.create({
      data: { id: generateId(), name: 'uk', urn: `hrn-test-${generateId().slice(-8)}`, class: 'knowledge', visibility: 'ORGANIZATION', ownerUserId: otto, organizationId: null } satisfies Prisma.MemoryUncheckedCreateInput,
    });
    await attach(asUser(otto), userKnowledge.id, userApp.id);
    const judged = await linkedReachFor(db, keyAuth(userApp.id));
    // The gate's refusal is a NULL answer, not a thrown error: asserting exactly that (and not mapping any rejection to
    // false) means a resolver that starts throwing, or one that starts answering the record, fails this pin (#5361 item 2).
    await expect(Q.memory(null, { ref: userKnowledge.id }, keyCtx(userApp.id))).resolves.toBeNull();
    const listed = (await list(keyCtx(userApp.id))).ids.includes(userKnowledge.id);
    // The judge admits it, but GraphQL's record gate refuses a user-owned non-personal memory to a key with no user
    // (`canReadMemoryRecord`'s ownerUserId branch), so the list follows the record read, never the other way.
    expect(judged.has(userKnowledge.id)).toBe(true);
    expect(listed).toBe(false);
  });
  // #5361 item 1: an ORGANIZATION-owned App with attachments and no installed Agent. The #5272 change removed an early return,
  // so the #758 block (the foreign-user-owned and licence checks) is now reachable with zero installs; it must add nothing
  // there (`activeAgentInstallLicenseIds` answers an empty set for an empty Agent list and the item loop runs zero times).
  it('an organization-owned App with links and no installed Agent lists exactly its links, as MCP does', async () => {
    const bare = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'BareOrgApp', urn: `${org.urn}:bareorgapp` } satisfies Prisma.AppUncheckedCreateInput });
    await db.appMember.create({ data: { appId: bare.id, userId: alice, role: 'member' } });
    const own = await orgKnowledge('bare-linked');
    await attach(asUser(alice), own.id, bare.id);
    expect(await db.appAgent.count({ where: { appId: bare.id } })).toBe(0);
    const out = await list(keyCtx(bare.id));
    expect(out).toEqual({ ids: [own.id], total: 1 });
    // (the exact list above already implies these three; they name what the failure would look like)
    // not the other App's Agent memory, link or the unlinked memory: nothing but what its own link lets it read
    expect(out.ids).not.toContain(agentMemory.id);
    expect(out.ids).not.toContain(linked.id);
    expect(out.ids).not.toContain(unlinked.id);
    expect(out.ids).toEqual(await mcpList(bare.id));
  });

  // #5361 item 3a: `filter.visibility: PUBLIC` is the marketplace slice, answered before the App-key branch, so a linked PUBLIC
  // memory is listed by that slice and not by the link: pin that the slice answers (and what it leaves out).
  it('a linked PUBLIC memory under filter.visibility PUBLIC is answered by the marketplace slice', async () => {
    const publicLinked = await orgKnowledge('public-linked', 'PUBLIC');
    const publicOther = await orgKnowledge('public-other', 'PUBLIC'); // neither linked nor an Agent item
    await attach(asUser(alice), publicLinked.id, app.id);
    const out = await list(keyCtx(app.id), { filter: { visibility: 'PUBLIC' } });
    expect(out.ids).toContain(publicLinked.id);
    // the slice lists every PUBLIC memory, which only the marketplace slice (not the key's link reach) does
    expect(out.ids).toContain(publicOther.id);
    expect(out.ids).toContain(agentMemory.id); // the installed Agent's PUBLIC memory is in the marketplace too
    expect(out.ids).not.toContain(linked.id); // an ORGANIZATION memory is not PUBLIC
    expect(out.ids).not.toContain(unlinked.id);
    // without the filter the key's own list carries the linked one but not the unrelated PUBLIC one: the link is what makes it the key's
    const keyList = (await list(keyCtx(app.id))).ids;
    expect(keyList).toContain(publicLinked.id);
    expect(keyList).not.toContain(publicOther.id);
  });

  // #5361 item 3b: a positive parity check: every id the list returns is readable through `memory(ref:)` by the same key,
  // so the list never shows what the key cannot open. Fixtures: an org App's Agent item and link, and a personal memory the
  // owner linked to a user-owned App (not an `app`-class memory: #5398 changes what a key reads of its own App's app-class memories).
  it('every id the list returns is readable through memory(ref:) by the same key', async () => {
    const own = await personal(otto);
    await attach(asUser(otto), own.id, userApp.id);
    // a user-owned non-personal memory linked to the same App is refused by the record gate, so it is neither listed nor readable
    const refused = await db.memory.create({
      data: { id: generateId(), name: 'parity-uk', urn: `hrn-test-${generateId().slice(-8)}`, class: 'knowledge', visibility: 'ORGANIZATION', ownerUserId: otto, organizationId: null } satisfies Prisma.MemoryUncheckedCreateInput,
    });
    await attach(asUser(otto), refused.id, userApp.id);
    expect((await list(keyCtx(userApp.id))).ids).not.toContain(refused.id);
    // the zero-install organization App of item 1 is part of the invariant too
    const bare = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'ParityBareApp', urn: `${org.urn}:paritybare` } satisfies Prisma.AppUncheckedCreateInput });
    await db.appMember.create({ data: { appId: bare.id, userId: alice, role: 'member' } });
    await attach(asUser(alice), (await orgKnowledge('parity-bare-linked')).id, bare.id);
    for (const keyApp of [app.id, userApp.id, bare.id]) {
      const { ids } = await list(keyCtx(keyApp));
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) {
        const record = await Q.memory(null, { ref: id }, keyCtx(keyApp));
        expect(record, `memory(ref: ${id}) for the key of ${keyApp}`).not.toBeNull();
        expect(record!.id).toBe(id);
      }
    }
    // and the marketplace slice of item 3a: whatever it lists for the key, the key can read
    for (const id of (await list(keyCtx(app.id), { filter: { visibility: 'PUBLIC' } })).ids) {
      expect(await Q.memory(null, { ref: id }, keyCtx(app.id)), `PUBLIC slice id ${id}`).not.toBeNull();
    }
  });
});
