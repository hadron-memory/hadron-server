/**
 * #2171 (R211): Agent managers set an Agent's member roles in createAgent /
 * updateAgent; new Agents default to ["owner","member"]; existing Agents keep
 * what they have; App.availableMemberRoles is the union the App offers.
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
const AppT = resolvers.App as any;

const ctxFor = (userId: string): Context => ({ db, userId, roles: ['READER'] }) as unknown as Context;

let org: { id: string; urn: string };
let admin: { id: string };
let reader: { id: string };
let outsider: { id: string };
let seq = 0;

async function mkUser() {
  seq += 1;
  return db.user.create({ data: { id: generateId(), githubId: 217200 + seq, githubUsername: `u2171g-${seq}`, roles: ['READER'] } });
}
const policyOf = async (id: string) => (await db.agent.findUniqueOrThrow({ where: { id } })).installationPolicy as any;

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'o2171g', urn: 'o2171g.example' } });
  admin = await mkUser();
  reader = await mkUser();
  outsider = await mkUser();
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: reader.id, role: 'READER' } });
});

describe('createAgent default roles', () => {
  it('a new Agent offers owner and member; omitted memberRoles is the default', async () => {
    const a = await M.createAgent({}, { orgId: org.id, name: 'Fresh' }, ctxFor(admin.id));
    expect(await policyOf(a.id)).toEqual({ maxMembers: 'unlimited', memberRoles: ['owner', 'member'] });
  });

  it('honors an explicit list, and keeps maxMembers unlimited', async () => {
    const a = await M.createAgent({}, { orgId: org.id, name: 'Cook', memberRoles: ['owner', 'cook', 'eater'] }, ctxFor(admin.id));
    expect(await policyOf(a.id)).toEqual({ maxMembers: 'unlimited', memberRoles: ['owner', 'cook', 'eater'] });
  });

  it('does not backfill: an Agent stored with the old default keeps ["owner"]', async () => {
    const old = await db.agent.create({ data: { id: generateId(), organizationId: org.id, urn: 'o2171g.example:old', name: 'old' } });
    await M.createAgent({}, { orgId: org.id, name: 'Another' }, ctxFor(admin.id));
    expect((await policyOf(old.id)).memberRoles).toEqual(['owner']);
  });
});

describe('updateAgent memberRoles', () => {
  let agentId: string;
  beforeEach(async () => {
    agentId = (await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: 'o2171g.example:a', name: 'a',
        installationPolicy: { maxMembers: 5, memberRoles: ['owner'], selfJoinRole: 'member' } as never },
    })).id;
  });

  it('replaces memberRoles only, merging into the stored policy', async () => {
    await M.updateAgent({}, { ref: agentId, memberRoles: ['owner', 'member', 'reader'] }, ctxFor(admin.id));
    expect(await policyOf(agentId)).toEqual({ maxMembers: 5, memberRoles: ['owner', 'member', 'reader'], selfJoinRole: 'member' });
  });

  it.each([['omitted', undefined], ['null', null]])('%s leaves roles unchanged', async (_l, v) => {
    await M.updateAgent({}, { ref: agentId, description: 'x', ...(v === undefined ? {} : { memberRoles: v }) }, ctxFor(admin.id));
    expect((await policyOf(agentId)).memberRoles).toEqual(['owner']);
  });

  it.each([
    ['empty list', []],
    ['blank entry', ['owner', '  ']],
    ['uppercase', ['Owner']],
    ['bad charset', ['own er']],
    ['too long an entry', ['a'.repeat(33)]],
    ['more than 20 entries', Array.from({ length: 21 }, (_, i) => `r${i}`)],
  ])('refuses %s as BAD_USER_INPUT and writes nothing', async (_l, roles) => {
    await expect(M.updateAgent({}, { ref: agentId, memberRoles: roles }, ctxFor(admin.id)))
      .rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect((await policyOf(agentId)).memberRoles).toEqual(['owner']);
  });

  it('collapses exact duplicates keeping first order, and trims', async () => {
    await M.updateAgent({}, { ref: agentId, memberRoles: [' member', 'owner', 'member'] }, ctxFor(admin.id));
    expect((await policyOf(agentId)).memberRoles).toEqual(['member', 'owner']);
  });

  it('an owner-less list is legal and only removes the installer owner grant', async () => {
    await M.updateAgent({}, { ref: agentId, memberRoles: ['member'] }, ctxFor(admin.id));
    expect((await policyOf(agentId)).memberRoles).toEqual(['member']);
  });

  it('is refused for a non-manager, an org reader and an outsider, writing nothing', async () => {
    for (const u of [reader.id, outsider.id]) {
      await expect(M.updateAgent({}, { ref: agentId, memberRoles: ['owner', 'x'] }, ctxFor(u))).rejects.toBeTruthy();
    }
    expect((await policyOf(agentId)).memberRoles).toEqual(['owner']);
  });

  it('is refused once the writer\'s admin access is revoked', async () => {
    await db.orgMember.updateMany({ where: { organizationId: org.id, userId: admin.id }, data: { deletedAt: new Date() } });
    await expect(M.updateAgent({}, { ref: agentId, memberRoles: ['owner', 'x'] }, ctxFor(admin.id))).rejects.toBeTruthy();
    expect((await policyOf(agentId)).memberRoles).toEqual(['owner']);
  });

  it('concurrent updates of different fields do not lose the roles edit', async () => {
    await Promise.all([
      M.updateAgent({}, { ref: agentId, memberRoles: ['owner', 'x'] }, ctxFor(admin.id)),
      M.updateAgent({}, { ref: agentId, description: 'd' }, ctxFor(admin.id)),
    ]);
    expect((await policyOf(agentId)).memberRoles).toEqual(['owner', 'x']);
  });
});

describe('App.availableMemberRoles', () => {
  it('is the union across installed Agents, primary first', async () => {
    const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, urn: 'o2171g.example:app', name: 'app' } });
    const a1 = await db.agent.create({ data: { id: generateId(), organizationId: org.id, urn: 'o2171g.example:a1', name: 'a1', installationPolicy: { maxMembers: 'unlimited', memberRoles: ['owner', 'cook'] } as never } });
    const a2 = await db.agent.create({ data: { id: generateId(), organizationId: org.id, urn: 'o2171g.example:a2', name: 'a2', installationPolicy: { maxMembers: 'unlimited', memberRoles: ['cook', 'eater'] } as never } });
    await db.appAgent.create({ data: { appId: app.id, agentId: a1.id, createdAt: new Date('2026-01-01') } });
    await db.appAgent.create({ data: { appId: app.id, agentId: a2.id, createdAt: new Date('2026-01-02') } });
    expect(await AppT.availableMemberRoles({ id: app.id }, {}, ctxFor(admin.id))).toEqual(['owner', 'cook', 'eater']);
  });
});

describe('createApp installer grant uses the union reader', () => {
  it('auto-adds the installer as owner only when owner is offered', async () => {
    const withOwner = await M.createAgent({}, { orgId: org.id, name: 'WithOwner' }, ctxFor(admin.id));
    const noOwner = await M.createAgent({}, { orgId: org.id, name: 'NoOwner', memberRoles: ['member'] }, ctxFor(admin.id));
    const a1 = await M.createApp({}, { orgRef: org.id, name: 'app-one', agentRef: withOwner.id }, ctxFor(admin.id));
    const a2 = await M.createApp({}, { orgRef: org.id, name: 'app-two', agentRef: noOwner.id }, ctxFor(admin.id));
    expect(await db.appMember.count({ where: { appId: a1.id, userId: admin.id, role: 'owner' } })).toBe(1);
    expect(await db.appMember.count({ where: { appId: a2.id } })).toBe(0);
  });
});
