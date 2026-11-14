/**
 * #4181 — Query.memories(orgId: A, memoryClasses: [system]) must not list an
 * App install memory that belongs to another org (cor:api:100, cor:api:100:01,
 * cor:api:120:03, cor:acl:010:01). The install clause once ignored `orgId`.
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
const ctxOf = (userId: string, roles: string[] = []) =>
  ({ db, userId, roles, clientId: `user:${userId}` }) as unknown as Context;

async function installMemoryOf(orgId: string, tag: string) {
  const agent = await db.agent.create({ data: { id: generateId(), name: `Agent ${tag}`, urn: `${orgId}:agent-${tag}`, organizationId: orgId } });
  const { app } = await createDbAppWithKey(db, `app-${tag}`, orgId);
  const mem = await db.memory.create({
    data: {
      id: generateId(), class: 'system', name: `install-${tag}`, urn: `${orgId}:install-${tag}`,
      organizationId: orgId, appId: app.id, isInstallMemory: true, installOfAgentId: agent.id,
    },
  });
  return { app, mem };
}

let orgA: string;
let orgB: string;
let a: Awaited<ReturnType<typeof installMemoryOf>>;
let b: Awaited<ReturnType<typeof installMemoryOf>>;

beforeEach(async () => {
  await cleanDb(db);
  orgA = (await db.organization.create({ data: { id: generateId(), name: 'org-a', urn: 'org-a' } })).id;
  orgB = (await db.organization.create({ data: { id: generateId(), name: 'org-b', urn: 'org-b' } })).id;
  a = await installMemoryOf(orgA, 'a');
  b = await installMemoryOf(orgB, 'b');
});

const user = (name: string) => db.user.create({ data: { id: generateId(), name } });
const idsFor = async (ctx: Context, org?: string, classes: string[] | null = ['system']) =>
  ((await Q.memories({}, { ...(classes ? { filter: { memoryClasses: classes } } : {}), ...(org ? { orgId: org } : {}), limit: 100 }, ctx)).items as Array<{ id: string }>).map((m) => m.id);

describe('#4181 memories(orgId) install-memory clause is org-scoped', () => {
  it('(a) an admin of both orgs: orgId=A lists A\'s install memory, not B\'s; orgId=B the reverse', async () => {
    const u = await user('both-admin');
    for (const o of [orgA, orgB]) await db.orgMember.create({ data: { organizationId: o, userId: u.id, role: 'ADMIN' } });
    const inA = await idsFor(ctxOf(u.id), orgA);
    expect(inA).toContain(a.mem.id);
    expect(inA).not.toContain(b.mem.id);
    const inB = await idsFor(ctxOf(u.id), orgB);
    expect(inB).toContain(b.mem.id);
    expect(inB).not.toContain(a.mem.id);
  });

  it('(b) a member of A who owns an App in B: orgId=A omits B\'s install memory', async () => {
    const u = await user('b-owner');
    await db.orgMember.create({ data: { organizationId: orgA, userId: u.id, role: 'CONTRIBUTOR' } });
    await db.appMember.create({ data: { appId: b.app.id, userId: u.id, role: 'owner' } });
    expect(await idsFor(ctxOf(u.id), orgA)).not.toContain(b.mem.id);
    // The unscoped default is unchanged: the owner's install memory still lists.
    expect(await idsFor(ctxOf(u.id))).toContain(b.mem.id);
  });

  it('(c) a platform admin with orgId=A sees only A\'s install memory', async () => {
    const u = await user('platform-admin');
    await db.orgMember.create({ data: { organizationId: orgA, userId: u.id, role: 'CONTRIBUTOR' } });
    const ids = await idsFor(ctxOf(u.id, ['ADMIN']), orgA);
    expect(ids).toContain(a.mem.id);
    expect(ids).not.toContain(b.mem.id);
    // Unscoped, the platform admin's wider install reach is untouched (out of scope here).
    expect(await idsFor(ctxOf(u.id, ['ADMIN']))).toContain(b.mem.id);
  });

  it('#2044 no regression: A\'s install memory still lists to its audience under orgId=A, and to a non-manager participant not at all', async () => {
    const admin = await user('a-admin');
    await db.orgMember.create({ data: { organizationId: orgA, userId: admin.id, role: 'ADMIN' } });
    expect(await idsFor(ctxOf(admin.id), orgA)).toContain(a.mem.id);
    const reader = await user('a-reader');
    await db.orgMember.create({ data: { organizationId: orgA, userId: reader.id, role: 'READER' } });
    expect(await idsFor(ctxOf(reader.id), orgA)).not.toContain(a.mem.id);
  });

  it('unchanged: the caller\'s own user-owned memories list in every org context', async () => {
    const u = await user('owner');
    for (const o of [orgA, orgB]) await db.orgMember.create({ data: { organizationId: o, userId: u.id, role: 'ADMIN' } });
    const own = await db.memory.create({ data: { id: generateId(), class: 'knowledge', name: 'mine', urn: `u-${u.id}:mine`, ownerUserId: u.id } });
    expect(await idsFor(ctxOf(u.id), orgA, null)).toContain(own.id);
    expect(await idsFor(ctxOf(u.id), orgB, null)).toContain(own.id);
  });
});
