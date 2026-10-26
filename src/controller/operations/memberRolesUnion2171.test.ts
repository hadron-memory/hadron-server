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
import { loadOfferedMemberRoles, lockOfferedMemberRoleRows } from '../../lib/memberRoles.js';

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

describe('serialization: the deciding union is exactly the locked rows', () => {
  it('an install committed AFTER the lock does not contribute to the deciding union (BLIND P2)', async () => {
    await mkAgent({ maxMembers: 'unlimited', memberRoles: ['owner'] }, { createdAt: t0 });
    await db.$transaction(async (tx) => {
      const locked = await lockOfferedMemberRoleRows(tx, appId);
      // A concurrent install commits on another connection between the lock and the read.
      await mkAgent({ maxMembers: 'unlimited', memberRoles: ['owner', 'late'] }, { createdAt: t1 });
      expect((await loadOfferedMemberRoles(tx, appId, locked)).roles).toEqual(['owner']);
      expect((await loadOfferedMemberRoles(db, appId)).roles).toEqual(['owner', 'late']);
    });
  });

  it('the role editor stays blocked until an admission holding the fences commits, then wins', async () => {
    const a = await mkAgent({ maxMembers: 'unlimited', memberRoles: ['owner', 'guide'] });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const haveLocks = new Promise<void>((r) => { locked = r; });
    const admission = db.$transaction(async (tx) => {
      await lockOfferedMemberRoleRows(tx, appId);
      locked();
      await gate;
    });
    await haveLocks;
    let editorDone = false;
    const editor = setRoles(a, ['owner']).then(() => { editorDone = true; });
    await new Promise((r) => setTimeout(r, 400));
    expect(editorDone).toBe(false);
    release();
    await admission;
    await editor;
    expect(editorDone).toBe(true);
    expect((await loadOfferedMemberRoles(db, appId)).roles).toEqual(['owner']);
  });

  it('an uninstall stays blocked until an admission holding the fences commits', async () => {
    const a = await mkAgent({ maxMembers: 'unlimited', memberRoles: ['owner', 'guide'] });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const haveLocks = new Promise<void>((r) => { locked = r; });
    const admission = db.$transaction(async (tx) => {
      await lockOfferedMemberRoleRows(tx, appId);
      locked();
      await gate;
    });
    await haveLocks;
    let done = false;
    const uninstall = db.appAgent.delete({ where: { appId_agentId: { appId, agentId: a } } }).then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 400));
    expect(done).toBe(false);
    release();
    await admission;
    await uninstall;
    expect(done).toBe(true);
  });

  it('ensureAppMember itself waits for an in-flight role editor on the Agent row, then decides on the committed roles', async () => {
    const a = await mkAgent({ maxMembers: 'unlimited', memberRoles: ['owner', 'guide'] });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const haveLock = new Promise<void>((r) => { locked = r; });
    // Stand-in for updateAgent mid-transaction: the Agent row FOR UPDATE, roles dropped, not yet committed.
    const editor = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM agents WHERE id = ${a} FOR UPDATE`;
      await tx.agent.update({ where: { id: a }, data: { installationPolicy: { maxMembers: 'unlimited', memberRoles: ['owner'] } as never } });
      locked();
      await gate;
    });
    await haveLock;
    const u = await mkUser();
    let settled = false;
    const admission = ensureAppMember(db, appId, u, 'guide').then(() => 'admitted', (e) => e).finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 400));
    expect(settled).toBe(false);
    release();
    await editor;
    expect(await admission).toBeInstanceOf(InvalidRoleError);
    expect(await db.appMember.findUnique({ where: { appId_userId: { appId, userId: u } } })).toBeNull();
  });

  it('concurrent editor and admissions: every settled result is inspected and no admission follows the drop', async () => {
    for (let i = 0; i < 6; i += 1) {
      await cleanDb(db);
      orgId = (await db.organization.create({ data: { id: generateId(), name: 'o2171', urn: 'o2171.example' } })).id;
      appId = (await db.app.create({ data: { id: generateId(), organizationId: orgId, urn: 'o2171.example:app', name: 'app' } })).id;
      const a = await mkAgent({ maxMembers: 'unlimited', memberRoles: ['owner', 'guide'] });
      const users = await Promise.all([mkUser(), mkUser(), mkUser()]);
      const results = await Promise.allSettled([
        ...users.map((u) => ensureAppMember(db, appId, u, 'guide')),
        setRoles(a, ['owner']),
      ]);
      // The editor must succeed; an admission may only fail by being refused the dropped role.
      expect(results[3]!.status).toBe('fulfilled');
      for (const r of results.slice(0, 3)) {
        if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(InvalidRoleError);
      }
      // Admissions decided before the drop may keep 'guide'; none may be admitted after it, so
      // re-running one now is refused.
      await expect(ensureAppMember(db, appId, await mkUser(), 'guide')).rejects.toBeInstanceOf(InvalidRoleError);
    }
  });
});
