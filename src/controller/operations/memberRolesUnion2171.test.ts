/**
 * #2171 (R211, cor:dmo:050:04 "Which roles an App offers"): an App offers the
 * UNION of the member roles of its installed Agents. One reader decides for
 * ensureAppMember, joinApp's self-join role and the installer auto-owner grant.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { ensureAppMember, InvalidRoleError, OrphanAppError } from './ensureAppMember.js';
import { joinApp, SelfJoinNotAllowedError } from './joinApp.js';
import { loadOfferedMemberRoles } from '../../lib/memberRoles.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let orgId: string;
let appId: string;
let seq = 0;

async function mkUser(): Promise<string> {
  seq += 1;
  return (await db.user.create({ data: { id: generateId(), handle: `u2171-${seq}`, githubId: 217100 + seq } })).id;
}

async function mkAgent(policy: Record<string, unknown>, opts: { install?: boolean; createdAt?: Date } = {}): Promise<string> {
  seq += 1;
  const agent = await db.agent.create({
    data: { id: generateId(), organizationId: orgId, urn: `o2171.example:a${seq}`, name: `a${seq}`, installationPolicy: policy as never },
  });
  if (opts.install !== false) {
    await db.appAgent.create({ data: { appId, agentId: agent.id, ...(opts.createdAt ? { createdAt: opts.createdAt } : {}) } });
  }
  return agent.id;
}

const setRoles = (agentId: string, memberRoles: string[], extra: Record<string, unknown> = {}) =>
  db.agent.update({
    where: { id: agentId },
    data: { installationPolicy: { maxMembers: 'unlimited', memberRoles, ...extra } as never },
  });

const t0 = new Date('2026-01-01T00:00:00Z');
const t1 = new Date('2026-01-02T00:00:00Z');

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'o2171', urn: 'o2171.example' } })).id;
  appId = (await db.app.create({ data: { id: generateId(), organizationId: orgId, urn: 'o2171.example:app', name: 'app' } })).id;
});

describe('loadOfferedMemberRoles', () => {
  it('is the deduplicated union, primary agent first, then installs by createdAt', async () => {
    await mkAgent({ maxMembers: 'unlimited', memberRoles: ['owner', 'cook'] }, { createdAt: t0 });
    await mkAgent({ maxMembers: 'unlimited', memberRoles: ['cook', 'eater'] }, { createdAt: t1 });
    expect(await loadOfferedMemberRoles(db, appId)).toEqual({ installed: true, roles: ['owner', 'cook', 'eater'] });
  });

  it('ignores a soft-deleted Agent and an Agent that is not installed here', async () => {
    await mkAgent({ maxMembers: 'unlimited', memberRoles: ['owner'] }, { createdAt: t0 });
    const gone = await mkAgent({ maxMembers: 'unlimited', memberRoles: ['ghost'] }, { createdAt: t1 });
    await db.agent.update({ where: { id: gone }, data: { deletedAt: new Date() } });
    await mkAgent({ maxMembers: 'unlimited', memberRoles: ['elsewhere'] }, { install: false });
    expect((await loadOfferedMemberRoles(db, appId)).roles).toEqual(['owner']);
  });

  it('reports an App with no installed Agent as not installed', async () => {
    expect(await loadOfferedMemberRoles(db, appId)).toEqual({ installed: false, roles: [] });
  });

  it('tolerates a malformed stored policy (no memberRoles array) as offering nothing', async () => {
    const a = await mkAgent({ maxMembers: 'unlimited' });
    expect(await loadOfferedMemberRoles(db, appId)).toEqual({ installed: true, roles: [] });
    await setRoles(a, ['owner']);
    expect((await loadOfferedMemberRoles(db, appId)).roles).toEqual(['owner']);
  });
});

describe('ensureAppMember offers the union', () => {
  it('accepts a role only the SECOND Agent declares, and refuses it after that Agent is uninstalled', async () => {
    await mkAgent({ maxMembers: 'unlimited', memberRoles: ['owner'] }, { createdAt: t0 });
    const second = await mkAgent({ maxMembers: 'unlimited', memberRoles: ['owner', 'reader'] }, { createdAt: t1 });
    const u1 = await mkUser();
    await ensureAppMember(db, appId, u1, 'reader');
    expect((await db.appMember.findUniqueOrThrow({ where: { appId_userId: { appId, userId: u1 } } })).role).toBe('reader');

    await db.appAgent.delete({ where: { appId_agentId: { appId, agentId: second } } });
    const u2 = await mkUser();
    await expect(ensureAppMember(db, appId, u2, 'reader')).rejects.toBeInstanceOf(InvalidRoleError);
    expect(await db.appMember.findUnique({ where: { appId_userId: { appId, userId: u2 } } })).toBeNull();
  });

  it('refuses a role the editor later drops, but leaves the existing member row untouched', async () => {
    const a = await mkAgent({ maxMembers: 'unlimited', memberRoles: ['owner', 'guide'] });
    const u1 = await mkUser();
    await ensureAppMember(db, appId, u1, 'guide');
    await setRoles(a, ['owner']);
    const row = await db.appMember.findUniqueOrThrow({ where: { appId_userId: { appId, userId: u1 } } });
    expect(row.role).toBe('guide');
    await expect(ensureAppMember(db, appId, u1, 'guide')).rejects.toBeInstanceOf(InvalidRoleError);
    expect((await db.appMember.findUniqueOrThrow({ where: { appId_userId: { appId, userId: u1 } } })).role).toBe('guide');
    await ensureAppMember(db, appId, u1, 'owner');
  });

  it('an empty union refuses every role', async () => {
    await mkAgent({ maxMembers: 'unlimited', memberRoles: [] });
    await expect(ensureAppMember(db, appId, await mkUser(), 'owner')).rejects.toBeInstanceOf(InvalidRoleError);
  });

  it('an App with no installed Agent is still an orphan', async () => {
    await expect(ensureAppMember(db, appId, await mkUser(), 'owner')).rejects.toBeInstanceOf(OrphanAppError);
  });

  it('keeps maxMembers governed by the PRIMARY Agent', async () => {
    await mkAgent({ maxMembers: 1, memberRoles: ['owner', 'x'] }, { createdAt: t0 });
    await mkAgent({ maxMembers: 'unlimited', memberRoles: ['owner', 'x'] }, { createdAt: t1 });
    await ensureAppMember(db, appId, await mkUser(), 'x');
    await expect(ensureAppMember(db, appId, await mkUser(), 'x')).rejects.toMatchObject({ name: 'MaxMembersExceededError' });
  });
});

describe('joinApp self-join with a union', () => {
  it("never grants owner even when a sibling Agent offers owner and selfJoinRole is owner", async () => {
    await mkAgent({ maxMembers: 'unlimited', memberRoles: ['member'], selfJoinRole: 'owner' }, { createdAt: t0 });
    await mkAgent({ maxMembers: 'unlimited', memberRoles: ['owner'] }, { createdAt: t1 });
    await expect(joinApp(db, { appId, userId: await mkUser() })).rejects.toBeInstanceOf(SelfJoinNotAllowedError);
  });

  it("accepts the primary's selfJoinRole when it is in the union but only a sibling declares it (pinned: union, not primary-only)", async () => {
    await mkAgent({ maxMembers: 'unlimited', memberRoles: ['owner'], selfJoinRole: 'visitor' }, { createdAt: t0 });
    await mkAgent({ maxMembers: 'unlimited', memberRoles: ['owner', 'visitor'] }, { createdAt: t1 });
    const userId = await mkUser();
    expect(await joinApp(db, { appId, userId })).toMatchObject({ role: 'visitor' });
  });
});

describe('races: the deciding union is read under the install/editor fences', () => {
  it('an editor dropping a role while admissions of it run never leaves a member holding a role outside the committed union', async () => {
    for (let i = 0; i < 8; i += 1) {
      await cleanDb(db);
      orgId = (await db.organization.create({ data: { id: generateId(), name: 'o2171', urn: 'o2171.example' } })).id;
      appId = (await db.app.create({ data: { id: generateId(), organizationId: orgId, urn: 'o2171.example:app', name: 'app' } })).id;
      const a = await mkAgent({ maxMembers: 'unlimited', memberRoles: ['owner', 'guide'] });
      const users = await Promise.all([mkUser(), mkUser(), mkUser()]);
      await Promise.allSettled([
        ...users.map((u) => ensureAppMember(db, appId, u, 'guide')),
        setRoles(a, ['owner']),
      ]);
      const finalRoles = (await loadOfferedMemberRoles(db, appId)).roles;
      expect(finalRoles).toEqual(['owner']);
      // Every admitted 'guide' must have been decided against a union that still held it,
      // i.e. committed BEFORE the editor's write. With the editor committed last, a guide
      // row is legal; what must never happen is a guide row inserted AFTER the drop.
      const dropAt = (await db.agent.findUniqueOrThrow({ where: { id: a } })).updatedAt!;
      const late = await db.appMember.count({ where: { appId, role: 'guide', createdAt: { gt: dropAt } } });
      expect(late).toBe(0);
    }
  });
});
