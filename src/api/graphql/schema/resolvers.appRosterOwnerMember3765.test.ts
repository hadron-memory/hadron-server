/**
 * #3765 (ruling 0260, cor:dmo:050:12): an owner-role member of a USER-owned App reads the App's roster as the owner does.
 *
 * Before: #2089 withheld `members`, `memberCount`, `appAgents`, `agents`, `agentId`, `agent` and `installedAgentUrn` (null) from that
 * member while `Agent.apps` / `Agent.appAgents` returned the same install facts: two surfaces disagreeing about one fact. Holger ruled
 * "admit the rosters" (0260). The App's AI configuration stays with the owning user (the carve-out cor:dmo:050:12 states): `hasAiApiKey`,
 * `aiProvider`, `aiModel` stay null for the owner-role member.
 *
 * Fixture: user-owned App `papp` owned by `owner`; `boss` an owner-role AppMember; `cook` a plain member; `stranger` owns a second
 * user-owned App that installs the same PUBLIC Agent. Resolvers are called directly (the convention of resolvers.appOwnerRoleRead2089).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppAgent, createDbAppMember } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { APP_INCLUDE } from './resolvers.helpers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const R = resolvers as any;
const Q = R.Query;
const App = R.App;

const as = (userId: string, over: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...over }) as Context;

let owner: { id: string };
let boss: { id: string }; // owner-role member
let cook: { id: string }; // plain member
let stranger: { id: string }; // owns the other App
let app: { id: string; urn: string };
let emptyApp: { id: string };
let otherApp: { id: string };
let agentId: string;

const mkUser = (handle: string) => db.user.create({ data: { id: generateId(), name: handle, email: `${handle}@example.test`, handle, roles: ['READER'] } });
const userOwnedApp = (handle: string, ownerUserId: string) =>
  db.app.create({ data: { id: generateId(), name: handle, urn: `${handle}-${generateId().slice(-6)}:papp`, ownerUserId } });

beforeEach(async () => {
  await cleanDb(db);
  owner = await mkUser('rosterowner');
  boss = await mkUser('rosterboss');
  cook = await mkUser('rostercook');
  stranger = await mkUser('rosterstranger');
  app = await userOwnedApp('papp', owner.id);
  emptyApp = await userOwnedApp('emptyapp', owner.id);
  otherApp = await userOwnedApp('otherapp', stranger.id);
  await createDbAppMember(db, app.id, owner.id, 'owner');
  await createDbAppMember(db, app.id, boss.id, 'owner');
  await createDbAppMember(db, app.id, cook.id, 'cook');
  const publisher = await db.organization.create({ data: { id: generateId(), name: 'Pub', urn: `pub-${generateId().slice(-6)}` } });
  const sys = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'Sys', urn: `${publisher.urn}:sys`, organizationId: publisher.id, acceptsUploads: false } });
  const agent = await db.agent.create({ data: { id: generateId(), name: 'Agent', urn: `${publisher.urn}:agent`, organizationId: publisher.id, visibility: 'PUBLIC', systemMemoryId: sys.id } });
  agentId = agent.id;
  await createDbAppAgent(db, app.id, agent.id);
  await createDbAppAgent(db, otherApp.id, agent.id);
  await db.aiServiceConfig.create({ data: { id: generateId(), name: 'default', appId: app.id, provider: 'anthropic', model: 'claude-x', apiKeyEncrypted: 'ciphertext-not-a-real-key' } });
});

const eagerRow = (id = app.id) => db.app.findUniqueOrThrow({ where: { id }, include: APP_INCLUDE });
const lazyRow = (id = app.id) => db.app.findUniqueOrThrow({ where: { id } });

/** Every roster field the ruling admits, resolved for `ctx` and reduced to plain comparable values. */
async function roster(parent: any, ctx: Context) {
  const members = await App.members(parent, {}, ctx);
  const appAgents = await App.appAgents(parent, {}, ctx);
  const agents = await App.agents(parent, {}, ctx);
  const agent = await App.agent(parent, {}, ctx);
  return {
    members: members === null ? null : members.map((m: any) => ({ userId: m.userId, role: m.role })).sort((a: any, b: any) => a.userId.localeCompare(b.userId)),
    memberCount: await App.memberCount(parent, {}, ctx),
    appAgents: appAgents === null ? null : await Promise.all(appAgents.map(async (r: any) => ({
      appId: r.appId, agentId: r.agentId,
      installMethod: await R.AppAgent.installMethod(r, {}, ctx),
      createdAt: String(await R.AppAgent.createdAt(r, {}, ctx)),
      createdBy: await R.AppAgent.createdBy(r, {}, ctx),
      agent: (await R.AppAgent.agent(r, {}, ctx))?.id ?? null,
    }))),
    agents: agents === null ? null : agents.map((a: any) => a.id),
    agentId: await App.agentId(parent, {}, ctx),
    agent: agent === null ? null : agent.id,
    installedAgentUrn: await App.installedAgentUrn(parent, {}, ctx),
  };
}
const AI = ['hasAiApiKey', 'aiProvider', 'aiModel'] as const;
const aiFields = async (parent: any, ctx: Context) => Object.fromEntries(await Promise.all(AI.map(async (f) => [f, await App[f](parent, {}, ctx)])));

describe('#3765 the owner-role member reads exactly what the true owner reads (red on main: every roster field is null)', () => {
  it('eager and lazy parents: members, memberCount, appAgents (with their audit fields), agents, agentId, agent, installedAgentUrn', async () => {
    for (const parent of [await eagerRow(), await lazyRow()]) {
      const asOwner = await roster(parent, as(owner.id));
      const asBoss = await roster(parent, as(boss.id));
      expect(asOwner.members).toHaveLength(3);
      expect(asOwner.memberCount).toBe(3);
      expect(asOwner.appAgents).toHaveLength(1);
      expect(asOwner.agentId).toBe(agentId);
      expect(asBoss).toEqual(asOwner);
    }
  });

  it('through Query.app, as the real entry point', async () => {
    const parent = await Q.app({}, { ref: app.id }, as(boss.id));
    expect(parent?.id).toBe(app.id);
    expect(await roster(parent, as(boss.id))).toEqual(await roster(await Q.app({}, { ref: app.id }, as(owner.id)), as(owner.id)));
  });

  it('an App with no extra members and no installs: a REAL empty list and a REAL 0, never null', async () => {
    for (const parent of [await eagerRow(emptyApp.id), await lazyRow(emptyApp.id)]) {
      // boss is no member of emptyApp: add him as owner-role so the reader is admitted
      await db.appMember.upsert({ where: { appId_userId: { appId: emptyApp.id, userId: boss.id } }, create: { appId: emptyApp.id, userId: boss.id, role: 'owner' }, update: { role: 'owner' } });
      const c = as(boss.id);
      expect(await App.appAgents(parent, {}, c)).toEqual([]);
      expect(await App.agents(parent, {}, c)).toEqual([]);
      expect(await App.agentId(parent, {}, c)).toBeNull(); // no install: the real "none", same as the owner's answer
      expect(await App.memberCount(parent, {}, c)).toBe(1);
      expect((await App.members(parent, {}, c)).map((m: any) => m.userId)).toEqual([boss.id]);
    }
  });
});

describe('#3765 what stays withheld or unchanged', () => {
  it('the AI configuration stays null for the owner-role member (the carve-out), real values for the owner', async () => {
    for (const parent of [await eagerRow(), await lazyRow()]) {
      expect(await aiFields(parent, as(boss.id))).toEqual({ hasAiApiKey: null, aiProvider: null, aiModel: null });
      expect(await aiFields(parent, as(owner.id))).toEqual({ hasAiApiKey: true, aiProvider: 'anthropic', aiModel: 'claude-x' });
    }
  });

  it('a plain member and a stranger reaching the App record by an outer-object path still get null for every roster field', async () => {
    const parent = await R.AppGrant.app({ appId: app.id }, {}, as(cook.id));
    for (const who of [cook, stranger]) {
      const got = await roster(parent, as(who.id));
      for (const v of Object.values(got)) expect(v).toBeNull();
    }
  });

  it('an impersonated owner-role member and an impersonated owner get null for the roster', async () => {
    for (const who of [boss, owner]) {
      const got = await roster(await lazyRow(), as(who.id, { impersonation: { orgId: 'any-org' } as never }));
      for (const v of Object.values(got)) expect(v).toBeNull();
    }
  });

  it('a pure App key is unchanged: its own App is not withheld (the same answers as on main), another App\'s key is withheld', async () => {
    const keyCtx = (appId: string) => ({ db, appId, roles: [] }) as unknown as Context;
    const own = await roster(await lazyRow(), keyCtx(app.id));
    expect(own.appAgents).not.toBeNull();
    expect(own.agents).not.toBeNull();
    expect(own.members).not.toBeNull();
    const other = await roster(await lazyRow(), keyCtx(otherApp.id));
    for (const v of Object.values(other)) expect(v).toBeNull();
  });

  it('the true owner is unchanged', async () => {
    const c = as(owner.id);
    expect((await roster(await lazyRow(), c)).memberCount).toBe(3);
    expect((await roster(await eagerRow(), c)).agentId).toBe(agentId);
  });
});

describe('#3765 membership is read at the deciding statement: a demotion or removal committed before the read withholds again', () => {
  it('demoted to a plain role, then restored, then removed', async () => {
    const parent = await lazyRow();
    expect((await roster(parent, as(boss.id))).memberCount).toBe(3);
    await db.appMember.update({ where: { appId_userId: { appId: app.id, userId: boss.id } }, data: { role: 'cook' } });
    for (const v of Object.values(await roster(parent, as(boss.id)))) expect(v).toBeNull();
    await db.appMember.update({ where: { appId_userId: { appId: app.id, userId: boss.id } }, data: { role: 'owner' } });
    expect((await roster(parent, as(boss.id))).memberCount).toBe(3);
    await db.appMember.delete({ where: { appId_userId: { appId: app.id, userId: boss.id } } });
    for (const v of Object.values(await roster(parent, as(boss.id)))) expect(v).toBeNull();
  });

  it('a soft-deleted App answers the roster to nobody it did not before', async () => {
    const parent = await lazyRow();
    await db.app.update({ where: { id: app.id }, data: { deletedAt: new Date() } });
    const got = await roster(parent, as(boss.id));
    expect(got.memberCount === 0 || got.memberCount === null).toBe(true);
    expect(got.members === null || (got.members as unknown[]).length === 0).toBe(true);
  });
});

describe('#3765 the fields the admitted reader can now reach through the rosters stay gated', () => {
  it('AppMember.user: identity is listed, but another member\'s name, email, roles and linkage stay null for the owner-role member', async () => {
    const members = await App.members(await lazyRow(), {}, as(boss.id));
    const c = as(boss.id);
    for (const m of members) {
      const user = await R.AppMember.user(m, {}, c);
      expect(user.id).toBe(m.userId);
      if (m.userId === boss.id) continue; // his own record is his own
      expect(await R.User.email(user, {}, c), `email of ${m.userId}`).toBeNull();
      expect(await R.User.name(user, {}, c), `name of ${m.userId}`).toBeNull();
      expect(await R.User.roles(user, {}, c)).toEqual([]);
      expect(await R.User.identityProvider(user, {}, c)).toBeNull();
    }
  });

  it('App.keys: still the independent key-manager gate (#2080): the owner-role member lists, a plain member does not', async () => {
    await db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: `h-${generateId()}`, keyPreview: 'abcd' } });
    const parent = await Q.app({}, { ref: app.id }, as(boss.id));
    expect(await App.keys(parent, {}, as(boss.id))).toHaveLength(1);
    await expect(App.keys(parent, {}, as(cook.id))).rejects.toBeDefined();
  });

  it('no stored AI key material reaches any roster field', async () => {
    const out = JSON.stringify(await roster(await eagerRow(), as(boss.id)));
    expect(out).not.toContain('ciphertext-not-a-real-key');
  });
});

describe('#3765 reverse-side parity: Agent.apps / Agent.appAgents agree with App.appAgents for the same caller', () => {
  it('as the owner-role member, the reverse rows for this App are exactly the forward rows, and another user\'s App with the same Agent is not returned', async () => {
    const agent = await db.agent.findUniqueOrThrow({ where: { id: agentId } });
    const c = as(boss.id);
    const apps = await R.Agent.apps(agent, {}, c);
    expect(apps.map((a: { id: string }) => a.id)).toEqual([app.id]);
    const reverse = (await R.Agent.appAgents(agent, {}, c)).filter((r: { appId: string }) => r.appId === app.id);
    const forward = await App.appAgents(await lazyRow(), {}, c);
    expect(reverse).toHaveLength(1);
    expect(forward).toHaveLength(1);
    // The same install fact, with no extra field on the reverse row that the forward row lacks (the issue's open check).
    const keys = (row: object) => Object.keys(row).filter((k) => !k.startsWith('_') && !['app', 'agent', 'exposedInstallMethod', 'exposedImporter'].includes(k)).sort();
    expect(keys(reverse[0])).toEqual(keys(forward[0]));
    expect(reverse[0].agentId).toBe(forward[0].agentId);
    expect(await R.AppAgent.installMethod(reverse[0], {}, c)).toBe(await R.AppAgent.installMethod(forward[0], {}, c));
    expect(apps.map((a: { id: string }) => a.id)).not.toContain(otherApp.id);
  });
});
