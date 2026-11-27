/**
 * #5026 — the default `memories()` list includes a person's own per-user Agent
 * memory (their App-member memory, hrn:node:hadronmemory.com:specs:cor:cht:010:02),
 * for its owner only (hrn:node:hadronmemory.com:specs:cor:api:120:03, amended
 * 2026-11-24: "own user-owned memories always included for their owner, whatever
 * their class"). Built to Vera's deltas 1-5 on the issue (issuecomment-7138645338).
 *
 * Three per-user shapes are seeded, the ones the code creates:
 *   - ORG: the evidence memory's shape — class personal, `userId` = owner,
 *     org-owned (`ownerUserId` null), `appId` and `userMemoryOfAgentId` set
 *     (`startAgentSession` USER_ID mode, `startChat` with a licensed App);
 *   - USER: the same with the other owner column — org-less, `ownerUserId` = owner
 *     (the owner XOR forbids both owner columns, so these two cover "with and
 *     without ownerUserId");
 *   - HOLDING: the creator-only no-App holding `startChat` provisions — class
 *     knowledge, `userId` null, `appId` null, org-owned, `createdBy` = owner
 *     (read by its creator alone, #3519).
 *
 * Red on main (f2d09486): (a), (d) and the USER `ownedByMe` pin fail because the
 * list carries `userMemoryOfAgentId: null` on every arm. (b) passes on main. It
 * guards the per-arm exclusion: if a shared arm (the org arm above all) loses
 * its `userMemoryOfAgentId: null` clause, HOLDING (class knowledge, org-owned)
 * lists to every member of its org, and (b) goes red.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers } from './resolvers.js';
import type { Context } from './resolvers.helpers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const Q = resolvers.Query as any;
const ctxOf = (userId: string, extra: Partial<Context> = {}) =>
  ({ db, userId, roles: [], clientId: `user:${userId}`, ...extra }) as unknown as Context;
const appKeyCtx = (appId: string) => ({ db, appId, roles: [], clientId: `app:${appId}` }) as unknown as Context;

type Page = { items: Array<{ id: string }>; total: number };
const list = async (ctx: Context, args: Record<string, unknown> = {}): Promise<Page> =>
  Q.memories({}, { limit: 100, ...args }, ctx);
const ids = (p: Page) => p.items.map((m) => m.id).sort();

let orgId: string;
let otherOrgId: string;
let owner: string;
let member: string;
let admin: string;
let grantee: string;
let appId: string;
let agentId: string;

const user = async (name: string) => (await db.user.create({ data: { id: generateId(), name } })).id;

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'org', urn: 'org-5026' } })).id;
  otherOrgId = (await db.organization.create({ data: { id: generateId(), name: 'other', urn: 'other-5026' } })).id;
  owner = await user('owner');
  member = await user('member');
  admin = await user('platform-admin');
  grantee = await user('grantee');
  for (const u of [owner, member, grantee]) {
    await db.orgMember.create({ data: { organizationId: orgId, userId: u, role: 'CONTRIBUTOR' } });
  }
  // The platform admin belongs to another org only: no relation to any row here.
  await db.orgMember.create({ data: { organizationId: otherOrgId, userId: admin, role: 'ADMIN' } });
  agentId = (await db.agent.create({ data: { id: generateId(), name: 'Juno', urn: 'org-5026:juno', organizationId: orgId } })).id;
  appId = (await createDbAppWithKey(db, 'chat-app', orgId)).app.id;
  // Baseline rows every caller can already see, so "absent" is not "empty".
  await db.memory.create({ data: { id: generateId(), class: 'knowledge', name: 'org-notes', urn: 'org-5026:notes', organizationId: orgId } });
});

async function seedPerUser() {
  const org = await db.memory.create({
    data: {
      id: generateId(), class: 'personal', name: 'Juno — owner (org)', urn: 'org-5026:per-user-org',
      organizationId: orgId, userId: owner, appId, userMemoryOfAgentId: agentId, createdBy: owner,
    },
  });
  const userOwned = await db.memory.create({
    data: {
      id: generateId(), class: 'personal', name: 'Juno — owner (user)', urn: `u-${owner}:per-user-user`,
      ownerUserId: owner, userId: owner, appId, userMemoryOfAgentId: agentId, createdBy: owner,
    },
  });
  const holding = await db.memory.create({
    data: {
      id: generateId(), class: 'knowledge', name: 'Juno — owner (holding)', urn: 'org-5026:per-user-holding',
      organizationId: orgId, visibility: 'ORGANIZATION', userMemoryOfAgentId: agentId, createdBy: owner,
    },
  });
  return { org: org.id, user: userOwned.id, holding: holding.id };
}

describe('#5026 memories() lists the owner\'s per-user Agent memories', () => {
  it('(a) the owner\'s unfiltered list returns all three shapes (red on main: absent)', async () => {
    const m = await seedPerUser();
    const page = await list(ctxOf(owner));
    expect(ids(page)).toEqual(expect.arrayContaining([m.org, m.user, m.holding]));
  });

  it('(a) the owner\'s memories(orgRef, memoryClasses:[personal]) returns the org-owned evidence shape (red on main)', async () => {
    const m = await seedPerUser();
    const page = await list(ctxOf(owner), { orgRef: orgId, filter: { memoryClasses: ['personal'] } });
    expect(ids(page)).toContain(m.org);
    // Own user-owned rows list in every org context (cor:api:120:03).
    expect(ids(page)).toContain(m.user);
    expect(ids(page)).not.toContain(m.holding); // knowledge, filtered out by class
  });

  it('(a) memoryClasses:[knowledge] returns the owner\'s no-App holding (red on main)', async () => {
    const m = await seedPerUser();
    expect(ids(await list(ctxOf(owner), { filter: { memoryClasses: ['knowledge'] } }))).toContain(m.holding);
  });

  it('(b) nobody else gets them: list and total equal the page without the rows', async () => {
    const callers: Array<[string, Context, Record<string, unknown>]> = [
      ['another member of the org', ctxOf(member), {}],
      ['another member, orgRef', ctxOf(member), { orgRef: orgId }],
      ['a platform admin with no relation', ctxOf(admin, { roles: ['ADMIN'] } as Partial<Context>), {}],
      ['an impersonated session of the owner', ctxOf(owner, {
        impersonation: { orgId, sessionId: generateId(), actorUserId: admin, expiresAt: new Date(Date.now() + 60_000) },
      } as unknown as Partial<Context>), {}],
      ['a share grantee, default list', ctxOf(grantee), {}],
      ['an App key of the memory\'s App', appKeyCtx(appId), {}],
    ];
    const before = new Map<string, Page>();
    for (const [label, ctx, args] of callers) before.set(label, await list(ctx, args));

    const m = await seedPerUser();
    await db.memoryShare.create({ data: { memoryId: m.org, granteeId: grantee, grantorId: owner, role: 'reader' } });

    for (const [label, ctx, args] of callers) {
      const after = await list(ctx, args);
      const was = before.get(label)!;
      expect({ label, ids: ids(after), total: after.total }).toEqual({ label, ids: ids(was), total: was.total });
      for (const id of [m.org, m.user, m.holding]) expect(ids(after)).not.toContain(id);
    }
  });

  it('(b) an org ADMIN who is not the owner does not get the holding through the org arm', async () => {
    await db.orgMember.updateMany({ where: { organizationId: orgId, userId: member }, data: { role: 'ADMIN' } });
    const m = await seedPerUser();
    const page = await list(ctxOf(member));
    expect(ids(page)).not.toContain(m.holding);
    expect(ids(page)).not.toContain(m.org);
  });

  // #5389 (specs engineer's read: cor:dmo:060:20 S6, cor:api:120:03): a share on a per-user personal memory lists like any
  // other share; before #5389 the slice omitted it.
  it('(c) sharedWithMe: a plain shared personal memory lists, and so does a shared per-user one (#5389)', async () => {
    const m = await seedPerUser();
    const plain = await db.memory.create({
      data: { id: generateId(), class: 'personal', name: 'plain', urn: 'org-5026:plain', organizationId: orgId, userId: owner },
    });
    await db.memoryShare.create({ data: { memoryId: plain.id, granteeId: grantee, grantorId: owner, role: 'reader' } });
    await db.memoryShare.create({ data: { memoryId: m.org, granteeId: grantee, grantorId: owner, role: 'reader' } });
    const page = await list(ctxOf(grantee), { filter: { sharedWithMe: true } });
    expect(ids(page)).toEqual([plain.id, m.org].sort());
    expect(page.total).toBe(2);
  });

  it('(d) total equals the items across pages when the limit is smaller than the result', async () => {
    const m = await seedPerUser();
    const full = await list(ctxOf(owner));
    expect(full.total).toBe(full.items.length);
    const seen: string[] = [];
    for (let offset = 0; offset < full.total + 2; offset += 1) {
      const p = await list(ctxOf(owner), { limit: 1, offset });
      expect(p.total).toBe(full.total);
      seen.push(...p.items.map((i) => i.id));
    }
    expect(seen.sort()).toEqual(ids(full));
    expect(seen).toEqual(expect.arrayContaining([m.org, m.user, m.holding]));
    // And for a caller who gets none of them.
    const other = await list(ctxOf(member));
    expect(other.total).toBe(other.items.length);
  });

  it('(e) ownedByMe: the org-less per-user memory lists, the org-owned shapes stay out (by organizationId)', async () => {
    const m = await seedPerUser();
    const page = await list(ctxOf(owner), { filter: { ownedByMe: true } });
    expect(ids(page)).toContain(m.user); // red on main: the slice hid it
    expect(ids(page)).not.toContain(m.org);
    expect(ids(page)).not.toContain(m.holding);
    expect(page.total).toBe(page.items.length);
    expect((await list(ctxOf(member), { filter: { ownedByMe: true } })).items).toEqual([]);
  });

  it('(e) memory(ref) is unchanged: the owner reads all three; another member is refused the personal ones', async () => {
    const m = await seedPerUser();
    for (const id of [m.org, m.user, m.holding]) {
      expect((await Q.memory({}, { ref: id }, ctxOf(owner)))?.id).toBe(id);
    }
    for (const id of [m.org, m.user]) {
      await expect(Q.memory({}, { ref: id }, ctxOf(member))).resolves.toBeNull();
    }
  });

  it('keeps out: the anonymous session memory of the App (class app, createdBy an App id)', async () => {
    const anon = await db.memory.create({
      data: {
        id: generateId(), class: 'app', name: 'Anonymous session', urn: 'org-5026:anon',
        organizationId: orgId, appId, userMemoryOfAgentId: agentId, createdBy: appId,
        anonymousExpiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    for (const u of [owner, member]) expect(ids(await list(ctxOf(u)))).not.toContain(anon.id);
  });

  it('keeps out (subscription arm): a member of an org that subscribes to the holding does not get it', async () => {
    const m = await seedPerUser();
    const subscriber = await user('subscriber');
    await db.orgMember.create({ data: { organizationId: otherOrgId, userId: subscriber, role: 'ADMIN' } });
    await db.memorySubscription.create({ data: { id: generateId(), memoryId: m.holding, organizationId: otherOrgId, role: 'READER' } });
    expect(ids(await list(ctxOf(subscriber)))).not.toContain(m.holding);
  });

  it('keeps out (app arm): an App member does not get the App\'s anonymous session memory', async () => {
    const anon = await db.memory.create({
      data: {
        id: generateId(), class: 'app', name: 'Anonymous session', urn: 'org-5026:anon-app-arm',
        organizationId: orgId, appId, userMemoryOfAgentId: agentId, createdBy: appId,
        anonymousExpiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await db.appMember.create({ data: { appId, userId: member, role: 'owner' } });
    await db.orgMember.updateMany({ where: { organizationId: orgId, userId: member }, data: { role: 'ADMIN' } });
    expect(ids(await list(ctxOf(member)))).not.toContain(anon.id);
  });

  it('keeps out (install arm): an install memory that carries the per-user marker does not list to the org admin', async () => {
    // No door writes this shape; the CHECK does not forbid it, so the arm keeps its clause.
    const agent2 = (await db.agent.create({ data: { id: generateId(), name: 'Juno2', urn: 'org-5026:juno2', organizationId: orgId } })).id;
    const marked = await db.memory.create({
      data: {
        id: generateId(), class: 'system', name: 'install-marked', urn: 'org-5026:install-marked',
        organizationId: orgId, appId, isInstallMemory: true, installOfAgentId: agent2, userMemoryOfAgentId: agent2,
      },
    });
    const plain = await db.memory.create({
      data: {
        id: generateId(), class: 'system', name: 'install-plain', urn: 'org-5026:install-plain',
        organizationId: orgId, appId, isInstallMemory: true, installOfAgentId: agentId,
      },
    });
    await db.orgMember.updateMany({ where: { organizationId: orgId, userId: member }, data: { role: 'ADMIN' } });
    const listed = ids(await list(ctxOf(member), { filter: { memoryClasses: ['system'] } }));
    expect(listed).toContain(plain.id); // positive control: the arm is live for this caller
    expect(listed).not.toContain(marked.id);
  });

  it('keeps out (creator arm): a knowledge memory the caller created that is NOT a per-user holding', async () => {
    // The owner created it in an org they do not belong to; only the holding
    // marker (`userMemoryOfAgentId`) makes a creator its reader.
    const foreign = await db.memory.create({
      data: { id: generateId(), class: 'knowledge', name: 'left-behind', urn: 'other-5026:left', organizationId: otherOrgId, createdBy: owner },
    });
    expect(ids(await list(ctxOf(owner)))).not.toContain(foreign.id);
  });

  it('keeps out: another user\'s holding never lists to the owner of a different one', async () => {
    const m = await seedPerUser();
    const theirs = await db.memory.create({
      data: {
        id: generateId(), class: 'knowledge', name: 'Juno — member (holding)', urn: 'org-5026:member-holding',
        organizationId: orgId, visibility: 'ORGANIZATION', userMemoryOfAgentId: agentId, createdBy: member,
      },
    });
    const page = await list(ctxOf(owner));
    expect(ids(page)).toContain(m.holding);
    expect(ids(page)).not.toContain(theirs.id);
  });
});
