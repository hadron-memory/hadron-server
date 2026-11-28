/**
 * hadron-internal#92: an app-class row is the App's only while it sits in the App's own tenant. A row that carries the App's
 * id under another organization (or, for a user-owned App, under any organization) is not the App's, on every read, list and
 * chat surface. One comparison (`appTenantRowFilter` in src/lib/auth/teamSpace.ts) serves the access fold, the own-memory
 * arm, the chat filters and the team-space classification.
 *
 * Each pin has a same-tenant control that must keep reading.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { canReadMemory, getMemoryAccess, getWorkerMemoryAccess } from '../../../mcp/access-control.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { ensureChannelWithRoot } from '../../../lib/channels.js';
import { chatLocFilter } from '../../../lib/chatLoc.js';
import { appTenantRowFilter, appsTenantRowFilter, isAppTenantRow, isTeamSpaceRow } from '../../../lib/auth/teamSpace.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { findOrCreateAppClassMemory, locateAppClassMemory } from './chat-scope.js';
import { appScopeMemoryIds } from '../../../lib/scopes.js';
import { ownAppMemoryIds } from '../../../lib/appOwnMemory.js';
import type { AuthContext } from '../../../middleware/auth.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;
const TOKEN = 'tenantrow92needle';

type Mem = { id: string; urn: string };
type AppRow = { id: string; ownerUserId: string | null; organizationId: string | null; urn: string };

let org: { id: string; urn: string };
let elsewhere: { id: string; urn: string };
let member: { id: string };
let otto: { id: string; handle: string };
let orgApp: AppRow;
let userApp: AppRow;

const keyAuth = (appId: string): AuthContext => ({ appId, roles: [], clientId: `app:${appId}` } as AuthContext);
const userAuth = (userId: string): AuthContext => ({ userId, roles: ['READER'] } as AuthContext);
const ctxOf = (auth: AuthContext): Context => ({ db, ...auth } as unknown as Context);

async function row(app: AppRow, name: string, organizationId: string | null, ownerUserId: string | null): Promise<Mem> {
  const mem = await db.memory.create({
    data: {
      id: generateId(), name, urn: `${generateId().slice(-8)}:${name}`, class: 'app', appId: app.id, visibility: null,
      organizationId, ownerUserId,
    } as never,
  });
  await db.node.create({ data: { id: generateId(), memoryId: mem.id, loc: 'doc', name: `${TOKEN} ${name}`, content: `secret ${name}` } });
  return mem as Mem;
}

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'tr92', urn: `tr92-${generateId().slice(-6)}` } });
  elsewhere = await db.organization.create({ data: { id: generateId(), name: 'tr92x', urn: `tr92x-${generateId().slice(-6)}` } });
  member = await db.user.create({ data: { id: generateId(), githubId: 92_001, githubUsername: 'tr92m', handle: `m-${generateId().slice(-6)}` } });
  const handle = `otto-${generateId().slice(-6)}`;
  otto = { id: (await db.user.create({ data: { id: generateId(), githubId: 92_002, githubUsername: 'tr92o', handle } })).id, handle };
  orgApp = (await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'OrgApp', urn: `${org.urn}:orgapp` } as never })) as AppRow;
  userApp = (await db.app.create({ data: { id: generateId(), ownerUserId: otto.id, name: 'UserApp', urn: `${handle}:userapp` } as never })) as AppRow;
  await db.appMember.create({ data: { appId: orgApp.id, userId: member.id, role: 'member' } });
  await db.appMember.create({ data: { appId: userApp.id, userId: otto.id, role: 'owner' } });
});

describe('hadron-internal#92 an organization App', () => {
  it('its key reads and lists a row of its own organization, and nothing carrying another', async () => {
    const own = await row(orgApp, 'own', org.id, null);
    const other = await row(orgApp, 'other', elsewhere.id, null);
    const auth = keyAuth(orgApp.id);
    expect(await Q.memory(null, { ref: own.id }, ctxOf(auth)).then((m: any) => m?.id ?? null)).toBe(own.id);
    expect(await Q.memory(null, { ref: other.id }, ctxOf(auth))).toBeNull();
    expect(await Q.node({}, { ref: `hrn:node:${other.urn}:doc` }, ctxOf(auth))).toBeNull();
    expect(await canReadMemory(db as never, auth, other.id)).toBe(false);
    expect((await getMemoryAccess(db as never, auth)).has(other.id)).toBe(false);
    expect((await getMemoryAccess(db as never, auth)).has(own.id)).toBe(true);
    expect((await Q.node({}, { ref: `hrn:node:${own.urn}:doc` }, ctxOf(auth)))?.content).toBe('secret own');
    expect(((await Q.memories(null, { limit: 100 }, ctxOf(auth))).items as { id: string }[]).map((m) => m.id)).toEqual([own.id]);
    const mcp = createTestableMcpServer(auth);
    // The same calls answer for the App's own row, so the refusals below are not error responses read as absence.
    expect(await mcp.callToolText('hadron_list_memories', {})).toContain(own.urn);
    expect(await mcp.callToolText('hadron_get_node', { urn: `hrn:node:${own.urn}:doc` })).toContain('secret own');
    expect(await mcp.callToolText('hadron_list_memories', {})).not.toContain(other.urn);
    expect(await mcp.callToolText('hadron_get_node', { urn: `hrn:node:${other.urn}:doc` })).not.toContain('secret other');
    expect([...(await ownAppMemoryIds(db as never, auth))]).toEqual([own.id]);
  }, 30_000);

  it('a participant (member) gets the same: the row is neither folded nor listed nor found', async () => {
    const own = await row(orgApp, 'own', org.id, null);
    const other = await row(orgApp, 'other', elsewhere.id, null);
    const auth = userAuth(member.id);
    const map = await getMemoryAccess(db as never, auth);
    expect(map.has(own.id)).toBe(true);
    expect(map.has(other.id)).toBe(false);
    expect(await canReadMemory(db as never, auth, other.id)).toBe(false);
    expect(await Q.node({}, { ref: `hrn:node:${other.urn}:doc` }, ctxOf(auth))).toBeNull();
    expect(await Q.memory(null, { ref: other.id }, ctxOf(auth))).toBeNull();
  }, 30_000);

  it('the team-chat locator and the Channel host gate leave the row out', async () => {
    const other = await row(orgApp, 'other', elsewhere.id, null);
    // The row's chat root is the oldest `chats:team` carrying the App's id; the App's own comes after it.
    const strayTeam = await ensureChannelWithRoot(db, { memoryId: other.id, loc: 'chats:team', name: 'team', createdBy: member.id });
    const strayRelease = await ensureChannelWithRoot(db, { memoryId: other.id, loc: 'chats:release', name: 'release', createdBy: member.id });
    const own = await row(orgApp, 'own', org.id, null);
    await ensureChannelWithRoot(db, { memoryId: own.id, loc: 'chats:team', name: 'team', createdBy: member.id, asDefaultOfAppId: orgApp.id });
    const ctx = ctxOf(userAuth(member.id));
    await M.createTeamChatMessage({}, { appRef: orgApp.urn, body: 'team hello' }, ctx);
    expect((await Q.teamChatMessages({}, { appRef: orgApp.urn }, ctx)).items.map((m: any) => m.body)).toEqual(['team hello']);
    // The stray root holds no message and is never the one posted to.
    expect((await db.channel.findUniqueOrThrow({ where: { id: strayTeam.channel.id } })).lastSeq).toBe(0);
    await expect(Q.channelMessages({}, { channelRef: strayRelease.channel.id }, ctx)).rejects.toMatchObject({ extensions: { code: 'CHANNEL_NOT_FOUND' } });
  }, 30_000);

  it('the team-chat locator ignores the row with no default pointer, and when only the row holds a team root', async () => {
    const other = await row(orgApp, 'other', elsewhere.id, null);
    const strayTeam = await ensureChannelWithRoot(db, { memoryId: other.id, loc: 'chats:team', name: 'team', createdBy: member.id });
    const ctx = ctxOf(userAuth(member.id));
    // Only the row holds a team root, and it already holds messages (lastSeq 5): posting to the App must not touch it.
    await db.channel.update({ where: { id: strayTeam.channel.id }, data: { lastSeq: 5 } });
    const strayNodes = await db.node.count({ where: { memoryId: other.id } });
    const outcome = await M.createTeamChatMessage({}, { appRef: orgApp.urn, body: 'x' }, ctx).then(() => 'posted', (e: any) => e?.extensions?.code ?? 'error');
    expect(outcome).toBe('TEAM_AGENT_NOT_FOUND');
    expect((await db.channel.findUniqueOrThrow({ where: { id: strayTeam.channel.id } })).lastSeq).toBe(5);
    expect(await db.node.count({ where: { memoryId: other.id } })).toBe(strayNodes);
    // The App's own root without a default pointer, created after the row's root.
    const own = await row(orgApp, 'own', org.id, null);
    await ensureChannelWithRoot(db, { memoryId: own.id, loc: 'chats:team', name: 'team', createdBy: member.id });
    await M.createTeamChatMessage({}, { appRef: orgApp.urn, body: 'hello' }, ctx);
    expect((await Q.teamChatMessages({}, { appRef: orgApp.urn }, ctx)).items.map((m: any) => m.body)).toEqual(['hello']);
    // The post landed in the App's own channel, and the row's channel did not move.
    expect((await db.channel.findFirstOrThrow({ where: { memoryId: own.id, loc: 'chats:team' } })).lastSeq).toBe(1);
    expect((await db.channel.findUniqueOrThrow({ where: { id: strayTeam.channel.id } })).lastSeq).toBe(5);
  }, 30_000);

  it('the chat-home provisioner refuses a keyed home of another organization, writes and revives nothing', async () => {
    const agent = await db.agent.create({ data: { id: generateId(), name: 'H', urn: `${org.urn}:h92`, organizationId: org.id } });
    await db.appAgent.create({ data: { appId: orgApp.id, agentId: agent.id } });
    const keyed = await row(orgApp, 'keyed', elsewhere.id, null);
    await db.memory.update({ where: { id: keyed.id }, data: { sharedMemoryOfAgentId: agent.id } });
    const args = {
      appId: orgApp.id, appUrn: orgApp.urn, appName: 'OrgApp', agentId: agent.id, agentUrn: agent.urn, agentName: 'H',
      organizationId: org.id, actingUserId: member.id, db: db as never,
    };
    const before = await db.node.count({ where: { memoryId: keyed.id } });
    const refused = async () => findOrCreateAppClassMemory(args).then(() => 'ok', (e: any) => e?.extensions?.code);
    expect(await refused()).toBe('APP_NOT_FOUND');
    expect(await db.node.count({ where: { memoryId: keyed.id } })).toBe(before);
    expect(await db.channel.count({ where: { memoryId: keyed.id } })).toBe(0);
    expect(await locateAppClassMemory({ appId: orgApp.id, agentId: agent.id, agentUrn: agent.urn, organizationId: org.id, db: db as never })).toBeNull();
    // A soft-deleted foreign keyed home is refused too, and not revived.
    await db.memory.update({ where: { id: keyed.id }, data: { deletedAt: new Date() } });
    expect(await refused()).toBe('APP_NOT_FOUND');
    expect((await db.memory.findUniqueOrThrow({ where: { id: keyed.id } })).deletedAt).not.toBeNull();
    // The team-chat door answers its own error first (no Agent hosts a team chat here), and writes nothing either.
    await db.memory.update({ where: { id: keyed.id }, data: { deletedAt: null } });
    await M.createTeamChatMessage({}, { appRef: orgApp.urn, body: 'x' }, ctxOf(userAuth(member.id))).catch(() => undefined);
    expect(await db.channel.count({ where: { memoryId: keyed.id } })).toBe(0);
  }, 30_000);

  it('the provisioner adopts a same-organization legacy home and never a foreign one', async () => {
    const agent = await db.agent.create({ data: { id: generateId(), name: 'H', urn: `${org.urn}:h92`, organizationId: org.id } });
    await db.appAgent.create({ data: { appId: orgApp.id, agentId: agent.id } });
    const legacyUrn = `${org.urn}:orgapp:h92:shared`;
    const args = {
      appId: orgApp.id, appUrn: orgApp.urn, appName: 'OrgApp', agentId: agent.id, agentUrn: agent.urn, agentName: 'H',
      organizationId: org.id, actingUserId: member.id, db: db as never,
    };
    const foreign = await row(orgApp, 'legacy-foreign', elsewhere.id, null);
    await db.memory.update({ where: { id: foreign.id }, data: { urn: legacyUrn } });
    // The foreign legacy row is neither located nor adopted: a fresh home is minted in the App's own organization.
    expect(await locateAppClassMemory({ appId: orgApp.id, agentId: agent.id, agentUrn: agent.urn, organizationId: org.id, db: db as never })).toBeNull();
    const minted = await findOrCreateAppClassMemory(args);
    expect(minted).not.toBe(foreign.id);
    const home = await db.memory.findUniqueOrThrow({ where: { id: minted } });
    expect({ appId: home.appId, organizationId: home.organizationId, agent: home.sharedMemoryOfAgentId }).toEqual({ appId: orgApp.id, organizationId: org.id, agent: agent.id });
    expect((await db.memory.findUniqueOrThrow({ where: { id: foreign.id } })).sharedMemoryOfAgentId).toBeNull();
  }, 30_000);

  it('the same legacy shape under the App\'s own organization IS located and adopted (the control)', async () => {
    const agent = await db.agent.create({ data: { id: generateId(), name: 'H', urn: `${org.urn}:h92`, organizationId: org.id } });
    await db.appAgent.create({ data: { appId: orgApp.id, agentId: agent.id } });
    const legacy = await row(orgApp, 'legacy-own', org.id, null);
    await db.memory.update({ where: { id: legacy.id }, data: { urn: `${org.urn}:orgapp:h92:shared` } });
    expect(await locateAppClassMemory({ appId: orgApp.id, agentId: agent.id, agentUrn: agent.urn, organizationId: org.id, db: db as never })).toBe(legacy.id);
    const adopted = await findOrCreateAppClassMemory({
      appId: orgApp.id, appUrn: orgApp.urn, appName: 'OrgApp', agentId: agent.id, agentUrn: agent.urn, agentName: 'H',
      organizationId: org.id, actingUserId: member.id, db: db as never,
    });
    expect(adopted).toBe(legacy.id);
    expect((await db.memory.findUniqueOrThrow({ where: { id: legacy.id } })).sharedMemoryOfAgentId).toBe(agent.id);
  }, 30_000);

  it('the chat-loc filter admits a chat in the App\'s own row only', async () => {
    const own = await row(orgApp, 'own', org.id, null);
    const other = await row(orgApp, 'other', elsewhere.id, null);
    const loc = 'chats:202611281200-deadbeef-x';
    for (const m of [own, other]) {
      await db.node.create({ data: { id: generateId(), memoryId: m.id, loc, name: 'chat', nodeType: 'chat', content: '', createdBy: generateId() } as never });
    }
    const rows = await db.node.findMany({
      where: await chatLocFilter(db, loc, { userId: member.id, roles: ['READER'] }),
      select: { memoryId: true },
    });
    expect(rows.map((r) => r.memoryId)).toEqual([own.id]);
  }, 30_000);
});

describe('hadron-internal#92 the agent chat list', () => {
  it('lists chats in the App\'s own row and not in one carrying another organization', async () => {
    const agent = await db.agent.create({ data: { id: generateId(), name: 'A', urn: `${org.urn}:a92`, organizationId: org.id } });
    await db.appAgent.create({ data: { appId: orgApp.id, agentId: agent.id } });
    const own = await row(orgApp, 'own', org.id, null);
    const other = await row(orgApp, 'other', elsewhere.id, null);
    for (const [m, id] of [[own, 'own'], [other, 'other']] as const) {
      await db.node.create({ data: { id: generateId(), memoryId: m.id, loc: `chats:c-${id}`, name: 'chat', nodeType: 'chat', content: '' } as never });
    }
    const chats = await Q.myChats({}, { agentRef: agent.id }, ctxOf(userAuth(member.id)));
    expect(chats.map((c: { loc: string }) => c.loc)).toEqual(['chats:c-own']);
  }, 30_000);
});

describe('hadron-internal#92 a user-owned App', () => {
  it('has no organization to compare: a row kept under its pre-transfer organization stays the App\'s', async () => {
    const own = await row(userApp, 'own', null, otto.id);
    const kept = await row(userApp, 'kept', elsewhere.id, null);
    const auth = keyAuth(userApp.id);
    expect(await Q.memory(null, { ref: own.id }, ctxOf(auth)).then((m: any) => m?.id ?? null)).toBe(own.id);
    // The App principal reads the pre-transfer row (the #2441 contract); the strict own-memory arm is unchanged and does not list it.
    expect(await canReadMemory(db as never, auth, kept.id)).toBe(true);
    expect([...(await ownAppMemoryIds(db as never, auth))]).toEqual([own.id]);
    const map = await getMemoryAccess(db as never, userAuth(otto.id));
    expect(map.has(own.id)).toBe(true);
    expect(map.has(kept.id)).toBe(true);
    // Exactly main's levels on the kept row, per principal (the comparison widens nothing beyond main's behaviour).
    const memberUser = await db.user.create({ data: { id: generateId(), githubId: 92_003, githubUsername: 'tr92mm', handle: `mm-${generateId().slice(-6)}` } });
    await db.appMember.create({ data: { appId: userApp.id, userId: memberUser.id, role: 'member' } });
    const levels = async (auth: AuthContext) => (await getMemoryAccess(db as never, auth)).get(kept.id) ?? null;
    expect({ owner: await levels(userAuth(otto.id)), member: await levels(userAuth(memberUser.id)), key: await levels(auth), stranger: await levels(userAuth(member.id)) })
      .toEqual({ owner: 'READ_WRITE', member: 'READ_WRITE', key: 'READ_ONLY', stranger: null });
  }, 30_000);
});

describe('hadron-internal#92 a user-owned App keeps its owner bound', () => {
  it('a row owned by another user that carries the App id is not the App\'s (here with no organization)', async () => {
    const mine = await row(userApp, 'mine', null, otto.id);
    const foreignUser = await row(userApp, 'fu', null, member.id);
    const auth = keyAuth(userApp.id);
    expect(await Q.memory(null, { ref: mine.id }, ctxOf(auth)).then((m: any) => m?.id ?? null)).toBe(mine.id);
    expect(await Q.memory(null, { ref: foreignUser.id }, ctxOf(auth))).toBeNull();
    expect(await canReadMemory(db as never, auth, foreignUser.id)).toBe(false);
    // The key's access map (no caller to fall back on) holds the owner bound itself.
    expect((await getMemoryAccess(db as never, auth)).has(foreignUser.id)).toBe(false);
    expect((await getMemoryAccess(db as never, auth)).has(mine.id)).toBe(true);
    expect([...(await ownAppMemoryIds(db as never, auth))]).toEqual([mine.id]);
    const map = await getMemoryAccess(db as never, userAuth(otto.id));
    expect(map.has(mine.id)).toBe(true);
    // This pins the own-arm owner bound and the owner's map; the access fold's `ownerUserId !== app.ownerUserId` line is
    // masked by the caller-vs-row-owner guard just below it for member callers (and by `admissibleFoldRows` rule 2 for keys), so it is not what fails here.
    expect(map.has(foreignUser.id)).toBe(false);
  }, 30_000);
});

describe('hadron-internal#92 worker memory and the search scope', () => {
  it('a Worker memory and the App search scope follow the App\'s tenant', async () => {
    const agent = await db.agent.create({ data: { id: generateId(), name: 'W', urn: `${org.urn}:w92`, organizationId: org.id } });
    await db.appAgent.create({ data: { appId: orgApp.id, agentId: agent.id } });
    const own = await row(orgApp, 'wown', org.id, null);
    const other = await row(orgApp, 'wother', elsewhere.id, null);
    for (const [m, slug] of [[own, 'wown'], [other, 'wother']] as const) {
      await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: orgApp.id, agentId: agent.id, name: slug, slug, memoryId: m.id, heldByUserId: member.id } as never });
    }
    const ids = await getWorkerMemoryAccess(db as never, { userId: member.id });
    expect(ids).toEqual([own.id]);
    const scope = await appScopeMemoryIds(db as never, orgApp.id);
    expect(scope).toContain(own.id);
    expect(scope).not.toContain(other.id);
  }, 30_000);
});

describe('hadron-internal#92 the shared predicates', () => {
  const shape = { class: 'app', appId: 'a', ownerUserId: null, userMemoryOfAgentId: null, workerOf: [] as unknown[] };
  it('isTeamSpaceRow compares the row\'s organization with the App\'s', () => {
    const opts = { appOwnerUserId: null, impersonating: false };
    expect(isTeamSpaceRow({ ...shape, organizationId: 'o1' }, { ...opts, appOrganizationId: 'o1' })).toBe(true);
    expect(isTeamSpaceRow({ ...shape, organizationId: 'o2' }, { ...opts, appOrganizationId: 'o1' })).toBe(false);
    expect(isTeamSpaceRow({ ...shape, organizationId: 'o1' }, { ...opts, appOrganizationId: null })).toBe(true);
    expect(isTeamSpaceRow({ ...shape, organizationId: null }, { ...opts, appOrganizationId: null })).toBe(true);
    // An organization App rejects a row with no organization; a user-owned App accepts any (it has none to compare).
    expect(isTeamSpaceRow({ ...shape, organizationId: null }, { ...opts, appOrganizationId: 'o1' })).toBe(false);
  });
  it('the row filters carry the App id and its organization', () => {
    expect(appTenantRowFilter({ id: 'a', organizationId: 'o1' })).toEqual({ appId: 'a', organizationId: 'o1' });
    expect(appTenantRowFilter({ id: 'a', organizationId: null })).toEqual({ appId: 'a' });
    expect(appsTenantRowFilter([])).toEqual({ AND: [{ OR: [] }] });
    // An absent organization never drops the bound: only an explicit null means user-owned.
    const absent = { id: 'a' } as unknown as { id: string; organizationId: string | null };
    expect(appTenantRowFilter(absent)).toEqual({ appId: 'a', organizationId: null });
    expect(isAppTenantRow({ organizationId: 'o1' }, absent)).toBe(false);
    expect(isAppTenantRow({ organizationId: null }, absent)).toBe(true);
  });
});
