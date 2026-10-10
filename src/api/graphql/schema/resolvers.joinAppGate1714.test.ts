/**
 * #1714: self-service App join is closed by default (Holger's ruling, option D).
 *
 * Before, joinApp granted `memberRoles[0]`, and the schema-default policy is
 * `memberRoles: ['owner']`, so any authenticated stranger who knew an App's URN
 * could make themselves an owner-role AppMember, and so an App member manager.
 * Now self-join needs an explicit `installation_policy.selfJoinRole` that is a
 * declared member role and never `owner`. Promotion to owner stays with the
 * App's managers through `ensureAppMember` (Holger: "the app owner must be
 * able to promote").
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as any;

let org: { id: string; urn: string };
let orgAdmin: { id: string };
let stranger: { id: string };
let agent: { id: string };
let app: { id: string; urn: string };

const ctxFor = (userId: string, roles: string[] = ['READER']): Context =>
  ({ db, userId, roles }) as unknown as Context;

let seq = 0;
async function mkUser(roles: string[] = ['READER']) {
  seq += 1;
  return db.user.create({ data: { githubId: 171400 + seq, githubUsername: `u1714-${seq}`, roles: roles as never } });
}

const member = (userId: string) =>
  db.appMember.findUnique({ where: { appId_userId: { appId: app.id, userId } } });

async function setPolicy(policy: Record<string, unknown>) {
  await db.agent.update({ where: { id: agent.id }, data: { installationPolicy: policy as never } });
}

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'o1714', urn: 'o1714.example' } });
  orgAdmin = await mkUser();
  await db.orgMember.create({ data: { organizationId: org.id, userId: orgAdmin.id, role: 'ADMIN' } });
  stranger = await mkUser();
  // No installationPolicy: the schema default, `{"maxMembers":"unlimited","memberRoles":["owner"]}`,
  // which is what every API-created Agent carries.
  agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:agent`, name: 'agent' } });
  app = await db.app.create({ data: {
    id: generateId(), organizationId: org.id, urn: `${org.urn}:app`, name: 'app',
    appAgents: { create: { agentId: agent.id } },
  } });
});

describe('#1714: self-join is closed by default', () => {
  it("a stranger's join to a schema-default (owner-first) App is refused and creates no row", async () => {
    const policy = (await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).installationPolicy;
    expect(policy).toMatchObject({ memberRoles: ['owner'] });
    for (const ref of [app.id, app.urn]) {
      await expect(M.joinApp(null, { appId: ref }, ctxFor(stranger.id)))
        .rejects.toMatchObject({ extensions: { code: 'SelfJoinNotAllowedError' } });
    }
    expect(await member(stranger.id)).toBeNull();
    expect(await db.appMember.count({ where: { appId: app.id } })).toBe(0);
  });

  it.each([
    ['names owner', { maxMembers: 'unlimited', memberRoles: ['owner', 'member'], selfJoinRole: 'owner' }],
    ['is not a declared member role', { maxMembers: 'unlimited', memberRoles: ['owner', 'member'], selfJoinRole: 'guest' }],
    ['is not a string', { maxMembers: 'unlimited', memberRoles: ['member'], selfJoinRole: ['member'] }],
    ['has no member roles to match', { maxMembers: 'unlimited', memberRoles: [], selfJoinRole: 'member' }],
  ])('refuses when selfJoinRole %s', async (_label, policy) => {
    await setPolicy(policy);
    await expect(M.joinApp(null, { appId: app.id }, ctxFor(stranger.id)))
      .rejects.toMatchObject({ extensions: { code: 'SelfJoinNotAllowedError' } });
    expect(await member(stranger.id)).toBeNull();
  });

  it('refuses before capacity: a full App answers the gate, not MaxMembersExceededError', async () => {
    await setPolicy({ maxMembers: 1, memberRoles: ['member'] });
    await db.appMember.create({ data: { appId: app.id, userId: orgAdmin.id, role: 'member' } });
    await expect(M.joinApp(null, { appId: app.id }, ctxFor(stranger.id)))
      .rejects.toMatchObject({ extensions: { code: 'SelfJoinNotAllowedError' } });
  });

  it('refuses an App with no installed Agent with the gate, not OrphanAppError', async () => {
    await db.appAgent.deleteMany({ where: { appId: app.id } });
    await expect(M.joinApp(null, { appId: app.id }, ctxFor(stranger.id)))
      .rejects.toMatchObject({ extensions: { code: 'SelfJoinNotAllowedError' } });
  });

  it('an existing member re-joining a closed App is still a no-op that returns their row', async () => {
    await db.appMember.create({ data: { appId: app.id, userId: stranger.id, role: 'owner' } });
    const out = await M.joinApp(null, { appId: app.id }, ctxFor(stranger.id));
    expect(out.appMember.role).toBe('owner');
  });
});

describe('#1714: an opted-in App admits self-join at its declared role, and only a manager promotes', () => {
  beforeEach(async () => {
    await setPolicy({ maxMembers: 'unlimited', memberRoles: ['owner', 'member'], selfJoinRole: 'member' });
  });

  it('a stranger joins at selfJoinRole, not memberRoles[0]', async () => {
    const out = await M.joinApp(null, { appId: app.id }, ctxFor(stranger.id));
    expect(out.appMember.role).toBe('member');
    expect((await member(stranger.id))?.role).toBe('member');
  });

  it('a self-joiner cannot self-grant owner, by re-joining or through ensureAppMember', async () => {
    await M.joinApp(null, { appId: app.id }, ctxFor(stranger.id));
    await expect(M.ensureAppMember(null, { appRef: app.id, userRef: stranger.id, role: 'owner' }, ctxFor(stranger.id)))
      .rejects.toThrow(/Forbidden/);
    await setPolicy({ maxMembers: 'unlimited', memberRoles: ['owner', 'member'], selfJoinRole: 'owner' });
    await M.joinApp(null, { appId: app.id }, ctxFor(stranger.id));
    expect((await member(stranger.id))?.role).toBe('member');
  });

  it('an org ADMIN manager CAN promote the self-joiner to owner', async () => {
    await M.joinApp(null, { appId: app.id }, ctxFor(stranger.id));
    const promoted = await M.ensureAppMember(null, { appRef: app.id, userRef: stranger.id, role: 'owner' }, ctxFor(orgAdmin.id));
    expect(promoted.role).toBe('owner');
    expect((await member(stranger.id))?.role).toBe('owner');
  });

  it('the user-owner of a user-owned App CAN promote the self-joiner to owner', async () => {
    const owner = await mkUser();
    const userApp = await db.app.create({ data: {
      id: generateId(), ownerUserId: owner.id, urn: `u1714-owner:app`, name: 'user app',
      appAgents: { create: { agentId: agent.id } },
    } });
    await M.joinApp(null, { appId: userApp.id }, ctxFor(stranger.id));
    await expect(M.ensureAppMember(null, { appRef: userApp.id, userRef: stranger.id, role: 'owner' }, ctxFor(stranger.id)))
      .rejects.toThrow(/Forbidden/);
    const promoted = await M.ensureAppMember(null, { appRef: userApp.id, userRef: stranger.id, role: 'owner' }, ctxFor(owner.id));
    expect(promoted.role).toBe('owner');
  });
});

// Holger's ruling on #1718 (team chat #7790, replacing the strict ruling): an
// owner-role AppMember has the same rights as the App's user-owner, and a
// platform admin may manage an org App. Admitting owner-role members is safe
// only while self-join can never produce one (Rook #7794).
describe('#1718: who manages members (callerManagesAppMembers)', () => {
  beforeEach(async () => {
    await setPolicy({ maxMembers: 'unlimited', memberRoles: ['owner', 'member'], selfJoinRole: 'member' });
    await M.joinApp(null, { appId: app.id }, ctxFor(stranger.id));
  });

  it('an owner-role AppMember CAN promote to owner and add a new member', async () => {
    const coOwner = await mkUser();
    await db.appMember.create({ data: { appId: app.id, userId: coOwner.id, role: 'owner' } });
    const newcomer = await mkUser();
    const promoted = await M.ensureAppMember(null, { appRef: app.id, userRef: stranger.id, role: 'owner' }, ctxFor(coOwner.id));
    expect(promoted.role).toBe('owner');
    const added = await M.ensureAppMember(null, { appRef: app.id, userRef: newcomer.id, role: 'member' }, ctxFor(coOwner.id));
    expect(added.role).toBe('member');
    expect((await member(newcomer.id))?.role).toBe('member');
  });

  it('a platform admin who is not an org member CAN promote to owner on an org App', async () => {
    const platformAdmin = await mkUser(['ADMIN']);
    const promoted = await M.ensureAppMember(null, { appRef: app.id, userRef: stranger.id, role: 'owner' }, ctxFor(platformAdmin.id, ['ADMIN']));
    expect(promoted.role).toBe('owner');
  });

  it('a member-role AppMember is refused', async () => {
    const newcomer = await mkUser();
    await expect(M.ensureAppMember(null, { appRef: app.id, userRef: newcomer.id, role: 'member' }, ctxFor(stranger.id)))
      .rejects.toThrow(/Forbidden/);
    expect(await member(newcomer.id)).toBeNull();
  });

  // The invariant the ruling rests on: no self-join path yields an owner row,
  // so no stranger becomes a member manager by joining.
  it('self-join never grants owner, so a self-joiner never manages members', async () => {
    for (const policy of [
      { maxMembers: 'unlimited', memberRoles: ['owner'] },
      { maxMembers: 'unlimited', memberRoles: ['owner', 'member'], selfJoinRole: 'owner' },
      { maxMembers: 'unlimited', memberRoles: ['owner', 'member'] },
    ]) {
      await setPolicy(policy);
      const joiner = await mkUser();
      await M.joinApp(null, { appId: app.id }, ctxFor(joiner.id)).catch(() => undefined);
      expect((await member(joiner.id))?.role ?? null).not.toBe('owner');
      const victim = await mkUser();
      await expect(M.ensureAppMember(null, { appRef: app.id, userRef: victim.id, role: 'owner' }, ctxFor(joiner.id)))
        .rejects.toThrow(/Forbidden/);
      expect(await member(victim.id)).toBeNull();
    }
    expect(await db.appMember.count({ where: { appId: app.id, role: 'owner' } })).toBe(0);
  });
});
