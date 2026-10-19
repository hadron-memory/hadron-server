/**
 * #2089 — an owner-role member of a USER-owned App reads the App record, and
 * is withheld its child projections.
 *
 * Before: `Query.app` treated a user-owned App as owner-only, so user B (an
 * `owner`-role AppMember of A's App) could list its keys through `appKeys` but
 * `app(ref:)` answered FORBIDDEN (cor:dmo:050:12, cor:acl:010:01).
 *
 * After: a real, non-impersonated user holding a CURRENT `owner` AppMember row
 * on a live user-owned App is admitted by every direct / list / URN / nested
 * App read, with ONE new arm. The admitted parent is NOT a child grant: the five
 * outer-nullable fields (`members`, `memberCount`, `appAgents`, `agents`,
 * `hasAiApiKey`) and the already-nullable agent/AI fields answer `null` =
 * "withheld from this caller", never zero / empty / false, on the eager
 * (prefetched) and lazy paths alike. The true owner keeps real values,
 * including known-empty `[]` / `0` / `false`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppAgent, createDbAppMember } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { APP_INCLUDE, canReadApp, requireAppRead } from './resolvers.helpers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const Q = resolvers.Query as any;
const App = (resolvers as any).App;

function as(userId: string, over: Partial<Context> = {}): Context {
  return { db, userId, roles: ['READER'], ...over } as Context;
}

let owner: { id: string };
let boss: { id: string }; // owner-role member
let cook: { id: string }; // ordinary member
let stranger: { id: string };
let admin: { id: string }; // platform ADMIN, no membership
let adminBoss: { id: string }; // platform ADMIN who IS an owner-role member
let app: { id: string; urn: string };
let emptyApp: { id: string; urn: string };
let agentId: string;

async function user(handle: string, roles: string[] = ['READER']) {
  return db.user.create({ data: { id: generateId(), name: handle, handle, roles: roles as never } });
}

async function userOwnedApp(handle: string, ownerUserId: string) {
  return db.app.create({
    data: { id: generateId(), name: handle, urn: `${handle}-${generateId().slice(-6)}:papp`, ownerUserId },
  });
}

beforeEach(async () => {
  await cleanDb(db);
  owner = await user('appowner');
  boss = await user('appboss');
  cook = await user('appcook');
  stranger = await user('stranger');
  admin = await user('padmin', ['ADMIN']);
  adminBoss = await user('adminboss', ['ADMIN']);

  app = await userOwnedApp('papp', owner.id);
  emptyApp = await userOwnedApp('emptyapp', owner.id);
  await createDbAppMember(db, app.id, owner.id, 'owner');
  await createDbAppMember(db, app.id, boss.id, 'owner');
  await createDbAppMember(db, app.id, cook.id, 'cook');
  await createDbAppMember(db, app.id, adminBoss.id, 'owner');

  const publisher = await db.organization.create({
    data: { id: generateId(), name: 'Pub', urn: `pub-${generateId().slice(-6)}` },
  });
  const sys = await db.memory.create({
    data: { id: generateId(), class: 'system', name: 'Sys', urn: `${publisher.urn}:sys`, organizationId: publisher.id, acceptsUploads: false },
  });
  const agent = await db.agent.create({
    data: { id: generateId(), name: 'Agent', urn: `${publisher.urn}:agent`, organizationId: publisher.id, visibility: 'PUBLIC', systemMemoryId: sys.id },
  });
  agentId = agent.id;
  await createDbAppAgent(db, app.id, agent.id);
  await db.aiServiceConfig.create({
    data: { id: generateId(), name: 'default', appId: app.id, provider: 'anthropic', model: 'claude-x', apiKeyEncrypted: 'ciphertext-not-a-real-key' },
  });
});

async function eager(ctx: Context, id = app.id) {
  return Q.app({}, { ref: id }, ctx);
}
async function lazy(id = app.id) {
  return db.app.findUniqueOrThrow({ where: { id } }); // no APP_INCLUDE: children fall back to their own loads
}
async function eagerRow(id = app.id) {
  return db.app.findUniqueOrThrow({ where: { id }, include: APP_INCLUDE });
}

const WITHHELD = ['members', 'memberCount', 'appAgents', 'agents', 'hasAiApiKey', 'aiProvider', 'aiModel', 'agentId', 'agent', 'installedAgentUrn'] as const;

async function readChildren(parent: any, ctx: Context) {
  const out: Record<string, unknown> = {};
  for (const f of WITHHELD) out[f] = await App[f](parent, {}, ctx);
  return out;
}

describe('#2089 parent admission — Query.app', () => {
  it('admits a current owner-role member of a user-owned App', async () => {
    const got = await eager(as(boss.id));
    expect(got?.id).toBe(app.id);
  });

  it('keeps the owner admitted and refuses everyone else who is not an owner-role member', async () => {
    expect((await eager(as(owner.id)))?.id).toBe(app.id);
    for (const who of [cook, stranger, admin]) {
      await expect(eager(as(who.id, who === admin ? { roles: ['ADMIN'] } : {}))).rejects.toMatchObject({
        extensions: { code: 'FORBIDDEN' },
      });
    }
  });

  it('admits a platform admin ONLY through a real owner-role membership, never the admin bypass (#1734 stays out)', async () => {
    expect((await eager(as(adminBoss.id, { roles: ['ADMIN'] })))?.id).toBe(app.id);
    await expect(eager(as(admin.id, { roles: ['ADMIN'] }))).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });

  it('refuses impersonation, including as the owner-role member', async () => {
    await expect(
      eager(as(boss.id, { impersonation: { orgId: 'any-org' } as never })),
    ).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });

  it('refuses a pure App key (no new arm for credentials)', async () => {
    await expect(eager({ db, appId: app.id, roles: [] } as Context)).rejects.toMatchObject({
      extensions: { code: 'FORBIDDEN' },
    });
  });

  it('uses CURRENT membership: a demoted or removed owner-role member is refused on the very next read', async () => {
    expect((await eager(as(boss.id)))?.id).toBe(app.id);
    await db.appMember.update({ where: { appId_userId: { appId: app.id, userId: boss.id } }, data: { role: 'cook' } });
    await expect(eager(as(boss.id))).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    await db.appMember.update({ where: { appId_userId: { appId: app.id, userId: boss.id } }, data: { role: 'owner' } });
    expect((await eager(as(boss.id)))?.id).toBe(app.id);
    await db.appMember.delete({ where: { appId_userId: { appId: app.id, userId: boss.id } } });
    await expect(eager(as(boss.id))).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });

  it('decides live-App and current-membership in ONE statement: an App deleted after the caller loaded it is refused (Anne P2)', async () => {
    // The deterministic scheduling probe: the caller holds a row that WAS live,
    // deleteApp commits, and only then does the membership predicate run. A
    // predicate that trusts the earlier liveness and reads only AppMember
    // would still admit the owner-role member.
    const stale = await db.app.findUniqueOrThrow({ where: { id: app.id } });
    expect(stale.deletedAt).toBeNull();
    await db.app.update({ where: { id: app.id }, data: { deletedAt: new Date() } });
    await expect(requireAppRead(as(boss.id), stale)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(await canReadApp(as(boss.id), stale)).toBe(false);
  });

  it('does not admit a soft-deleted App', async () => {
    await db.app.update({ where: { id: app.id }, data: { deletedAt: new Date() } });
    expect(await eager(as(boss.id))).toBeNull();
  });

  it('reads an ID, URN and alias reference identically', async () => {
    const byUrn = await Q.app({}, { ref: app.urn }, as(boss.id));
    expect(byUrn?.id).toBe(app.id);
  });
});

describe('#2089 list admission — Query.apps', () => {
  it('lists the App for an owner-role member in the default view, counted and paged on the qualified set', async () => {
    const extra = await userOwnedApp('boss2', boss.id);
    const page = await Q.apps({}, { limit: 1, offset: 0 }, as(boss.id));
    expect(page.total).toBe(2); // own App + the one he is owner-role member of
    expect(page.items).toHaveLength(1);
    const all = await Q.apps({}, { limit: 10, offset: 0 }, as(boss.id));
    expect(all.items.map((a: { id: string }) => a.id).sort()).toEqual([app.id, extra.id].sort());
  });

  it('does not list it for an ordinary member, a stranger, or a demoted member', async () => {
    for (const who of [cook, stranger]) {
      expect((await Q.apps({}, {}, as(who.id))).items.map((a: { id: string }) => a.id)).not.toContain(app.id);
    }
    await db.appMember.update({ where: { appId_userId: { appId: app.id, userId: boss.id } }, data: { role: 'cook' } });
    expect((await Q.apps({}, {}, as(boss.id))).items.map((a: { id: string }) => a.id)).not.toContain(app.id);
  });

  it('keeps ownedByMe literal: an owner-role member does not "own" it', async () => {
    const page = await Q.apps({}, { filter: { ownedByMe: true } }, as(boss.id));
    expect(page.items.map((a: { id: string }) => a.id)).not.toContain(app.id);
  });

  it('adds the arm for a platform admin only through membership', async () => {
    const mine = await Q.apps({}, {}, as(adminBoss.id, { roles: ['ADMIN'] }));
    expect(mine.items.map((a: { id: string }) => a.id)).toContain(app.id);
    const notMine = await Q.apps({}, {}, as(admin.id, { roles: ['ADMIN'] }));
    expect(notMine.items.map((a: { id: string }) => a.id)).not.toContain(app.id);
  });
});

describe('#2089 URN resolution', () => {
  it('resolves the App for the owner-role member and answers null otherwise', async () => {
    expect(await Q.resolveUrn(null, { urn: `hrn:app:${app.urn}` }, as(boss.id))).toMatchObject({ kind: 'app', id: app.id });
    expect(await Q.resolveUrn(null, { urn: `hrn:app:${app.urn}` }, as(cook.id))).toBeNull();
    expect(await Q.resolveUrn(null, { urn: `hrn:app:${app.urn}` }, as(stranger.id))).toBeNull();
  });
});

describe('#2089 nested App-returning surfaces', () => {
  it('AppMember.app, AppAgent.app resolve for the owner-role member and not for a stranger', async () => {
    const row = await db.appMember.findUniqueOrThrow({ where: { appId_userId: { appId: app.id, userId: boss.id } } });
    expect((await (resolvers as any).AppMember.app(row, {}, as(boss.id)))?.id).toBe(app.id);
    expect(await (resolvers as any).AppMember.app(row, {}, as(stranger.id))).toBeNull();
    const aa = await db.appAgent.findFirstOrThrow({ where: { appId: app.id } });
    expect((await (resolvers as any).AppAgent.app(aa, {}, as(boss.id)))?.id).toBe(app.id);
    expect(await (resolvers as any).AppAgent.app(aa, {}, as(stranger.id))).toBeNull();
  });

  it('Worker.app resolves the App for the owner-role member (parity with Query.app), null otherwise, children still withheld (Atilla P2)', async () => {
    const W = (resolvers as any).Worker;
    const got = await W.app({ appId: app.id }, {}, as(boss.id));
    expect(got?.id).toBe(app.id);
    expect(await App.members(got, {}, as(boss.id))).toBeNull();
    expect(await App.hasAiApiKey(got, {}, as(boss.id))).toBeNull();
    expect((await W.app({ appId: app.id }, {}, as(owner.id)))?.id).toBe(app.id);
    for (const who of [cook, stranger]) expect(await W.app({ appId: app.id }, {}, as(who.id))).toBeNull();
    expect(await W.app({ appId: app.id }, {}, as(boss.id, { impersonation: { orgId: 'any-org' } as never }))).toBeNull();
    await db.appMember.update({ where: { appId_userId: { appId: app.id, userId: boss.id } }, data: { role: 'cook' } });
    expect(await W.app({ appId: app.id }, {}, as(boss.id))).toBeNull();
    await db.appMember.update({ where: { appId_userId: { appId: app.id, userId: boss.id } }, data: { role: 'owner' } });
    await db.app.update({ where: { id: app.id }, data: { deletedAt: new Date() } });
    expect(await W.app({ appId: app.id }, {}, as(boss.id))).toBeNull();
  });

  it('Agent.apps / Agent.appAgents include the App for the owner-role member only', async () => {
    const agent = await db.agent.findUniqueOrThrow({ where: { id: agentId } });
    const ids = async (ctx: Context) =>
      (await (resolvers as any).Agent.apps(agent, {}, ctx)).map((a: { id: string }) => a.id);
    expect(await ids(as(boss.id))).toContain(app.id);
    expect(await ids(as(stranger.id))).not.toContain(app.id);
    const links = await (resolvers as any).Agent.appAgents(agent, {}, as(boss.id));
    expect(links.map((r: { appId: string }) => r.appId)).toContain(app.id);
  });
});

describe('#2089 child withholding for the newly admitted reader', () => {
  it('answers null (withheld) for every roster / AI / install field on the EAGER path', async () => {
    const parent = await eager(as(boss.id));
    expect(parent.appAgents).toBeDefined(); // prefetched — must not override the guard
    const out = await readChildren(parent, as(boss.id));
    for (const f of WITHHELD) expect(out[f], f).toBeNull();
  });

  it('answers null for the same fields on the LAZY path', async () => {
    const out = await readChildren(await lazy(), as(boss.id));
    for (const f of WITHHELD) expect(out[f], f).toBeNull();
  });

  it('answers null even if the parent object carries prefetched relations and counts', async () => {
    const row = { ...(await eagerRow()), _count: { members: 3 }, members: [{ userId: owner.id }] };
    const out = await readChildren(row, as(boss.id));
    for (const f of WITHHELD) expect(out[f], f).toBeNull();
  });

  it('gives the true owner real values on both paths', async () => {
    for (const parent of [await eagerRow(), await lazy()]) {
      const c = as(owner.id);
      expect((await App.members(parent, {}, c)).map((m: { userId: string }) => m.userId).sort()).toEqual(
        [owner.id, boss.id, cook.id, adminBoss.id].sort(),
      );
      expect(await App.memberCount(parent, {}, c)).toBe(4);
      expect(await App.appAgents(parent, {}, c)).toHaveLength(1);
      expect(await App.agents(parent, {}, c)).toHaveLength(1);
      expect(await App.hasAiApiKey(parent, {}, c)).toBe(true);
      expect(await App.aiProvider(parent, {}, c)).toBe('anthropic');
      expect(await App.aiModel(parent, {}, c)).toBe('claude-x');
      expect(await App.agentId(parent, {}, c)).toBe(agentId);
    }
  });

  it('keeps known-empty values REAL for the true owner (0 / [] / false, not null)', async () => {
    for (const parent of [
      await db.app.findUniqueOrThrow({ where: { id: emptyApp.id }, include: APP_INCLUDE }),
      await db.app.findUniqueOrThrow({ where: { id: emptyApp.id } }),
    ]) {
      const c = as(owner.id);
      expect(await App.members(parent, {}, c)).toEqual([]);
      expect(await App.memberCount(parent, {}, c)).toBe(0);
      expect(await App.appAgents(parent, {}, c)).toEqual([]);
      expect(await App.agents(parent, {}, c)).toEqual([]);
      expect(await App.hasAiApiKey(parent, {}, c)).toBe(false);
      expect(await App.agentId(parent, {}, c)).toBeNull();
    }
  });

  it('withholds the children from any non-owner who reaches the App by an outer-object path (Ticker.app, AppGrant.app, Worker.app)', async () => {
    // These resolvers hand the App over on the strength of the OUTER object's
    // admission and are deliberately not widened by #2089; the child guard is
    // what keeps a participant who gets the App this way from its roster.
    const R = resolvers as any;
    for (const reach of [
      () => R.Ticker.app({ appId: app.id }, {}, as(cook.id)),
      () => R.AppGrant.app({ appId: app.id }, {}, as(cook.id)),
    ]) {
      const got = await reach();
      expect(got?.id).toBe(app.id);
      for (const f of WITHHELD) expect(await App[f](got, {}, as(cook.id)), f).toBeNull();
    }
  });

  it('keeps #2080\'s independent key-manager gate: the owner-role member (a manager) lists keys, a participant does not', async () => {
    await db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: `h-${generateId()}`, keyPreview: 'abcd' } });
    const parent = await eager(as(boss.id));
    expect(await App.keys(parent, {}, as(boss.id))).toHaveLength(1);
    await expect(App.keys(parent, {}, as(cook.id))).rejects.toBeDefined();
  });

  it('never exposes the stored key material through any field the admitted reader can call', async () => {
    const out = JSON.stringify(await readChildren(await eager(as(boss.id)), as(boss.id)));
    expect(out).not.toContain('ciphertext-not-a-real-key');
  });
});

describe('#2089 org-owned Apps are unchanged', () => {
  it('an org member still reads real roster values', async () => {
    const org = await db.organization.create({ data: { id: generateId(), name: 'Co', urn: `co-${generateId().slice(-6)}` } });
    const member = await user('orgmember');
    await db.orgMember.create({ data: { organizationId: org.id, userId: member.id, role: 'READER' } });
    const orgApp = await db.app.create({ data: { id: generateId(), name: 'orgapp', urn: `${org.urn}:orgapp`, organizationId: org.id } });
    await createDbAppMember(db, orgApp.id, member.id, 'cook');
    const c = as(member.id);
    expect(await App.memberCount({ id: orgApp.id }, {}, c)).toBe(1);
    expect(await App.members({ id: orgApp.id }, {}, c)).toHaveLength(1);
    expect(await App.hasAiApiKey({ id: orgApp.id }, {}, c)).toBe(false);
    expect(await App.appAgents({ id: orgApp.id }, {}, c)).toEqual([]);
  });
});
