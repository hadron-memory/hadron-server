/**
 * #5389 — a MemoryShare on a personal memory made in an App (app_id set, so `chk_memory_personal_agent_id` sets
 * user_memory_of_agent_id) grants its grantee the share's role, as on a free-standing personal memory
 * (cor:dmo:060:20 S6: "unless the therapist shares it"; cor:acl:010:01; R4: the memory is the smallest unit of read).
 *
 * Red on main (bc57843e8): every share arm required user_memory_of_agent_id NULL (granteeShareAccess, the sharedWithMe
 * arm of getAccessibleMemoryIds, the memories(filter: { sharedWithMe }) slice), so the share was accepted and listed
 * on the grantor's side but the grantee could neither open, list, read the nodes of nor write the memory.
 *
 * Kept: the org-membership mirror (an org-set row admits only a current member), the share's role, the refusal of a
 * non-grantee, an App key's arm, free-standing shares.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { getAccessibleMemoryIds } from './resolvers.helpers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;

let org: { id: string; urn: string };
let appId: string, agentId: string;
let owner: string, grantee: string, writer: string, stranger: string, outsider: string;
/** App personal memory as createMemoryInApp makes it today: organizationId NULL, the App and its Agent set. */
let appPersonal: string;
/** An App personal memory carrying the App's org (an older door): the org-membership mirror applies. */
let orgAppPersonal: string;
let freePersonal: string;

const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] });
const user = async (h: string) => (await db.user.create({ data: { id: generateId(), handle: `${h}-${generateId().slice(-6)}` } })).id;
const share = (memoryId: string, granteeId: string, role: 'reader' | 'writer') =>
  db.memoryShare.create({ data: { memoryId, granteeId, grantorId: owner, role } });

async function memory(opts: { app: boolean; organizationId: string | null; name: string }): Promise<string> {
  return (await db.memory.create({ data: {
    id: generateId(), urn: `${org.urn}:${opts.name}-${generateId().slice(-8)}`, name: opts.name, class: 'personal', visibility: null,
    userId: owner, ownerUserId: opts.organizationId ? null : owner, organizationId: opts.organizationId,
    ...(opts.app ? { appId, userMemoryOfAgentId: agentId } : {}),
  }, select: { id: true } })).id;
}

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'p5389', urn: `p5389-${generateId().slice(-8)}.example` } });
  owner = await user('owner'); grantee = await user('grantee'); writer = await user('writer'); stranger = await user('stranger');
  outsider = await user('outsider');
  for (const u of [owner, grantee, writer, stranger]) await db.orgMember.create({ data: { organizationId: org.id, userId: u, role: 'READER' } });
  agentId = (await db.agent.create({ data: { name: 'Tutor', urn: `${org.urn}:tutor`, organizationId: org.id } })).id;
  appId = (await db.app.create({ data: { name: 'Tutor', urn: `${org.urn}:tutor-app`, organizationId: org.id } })).id;
  for (const u of [owner, grantee, writer, stranger, outsider]) await db.appMember.create({ data: { appId, userId: u, role: 'member' } });
  // Nobody holds an AgentSubscription: the share alone admits (Vera's spec read on #5389, answer B; no 'step 3c' licence).
  appPersonal = await memory({ app: true, organizationId: null, name: 'tutor-owner-personal' });
  orgAppPersonal = await memory({ app: true, organizationId: org.id, name: 'tutor-owner-personal-org' });
  freePersonal = await memory({ app: false, organizationId: null, name: 'free-personal' });
  await share(appPersonal, grantee, 'reader');
  await share(appPersonal, writer, 'writer');
  await share(appPersonal, outsider, 'reader');
  await share(orgAppPersonal, grantee, 'reader');
  await share(orgAppPersonal, outsider, 'reader'); // a non-member of the row's org: the mirror keeps it inert
  await share(freePersonal, grantee, 'reader');
  await db.node.create({ data: { id: generateId(), memoryId: appPersonal, loc: 'notes:one', name: 'One', content: 'app personal note' } });
});

const gate = async (c: Context): Promise<string[]> => [...(await getAccessibleMemoryIds(c))];
const listed = async (userId: string) =>
  (await Q.memories(null, { filter: { sharedWithMe: true } }, ctx(userId))).items.map((m: { id: string }) => m.id).sort();

describe('#5389 red: a share on an App personal memory grants its role', () => {
  it('Query.memory: the grantee opens it (org-less row and an org-set row for a member)', async () => {
    expect((await Q.memory(null, { ref: appPersonal }, ctx(grantee)))?.id).toBe(appPersonal);
    expect((await Q.memory(null, { ref: orgAppPersonal }, ctx(grantee)))?.id).toBe(orgAppPersonal);
  });

  it('memories(filter: { sharedWithMe }) lists it to the grantee, in lockstep with Query.memory', async () => {
    expect(await listed(grantee)).toEqual([appPersonal, orgAppPersonal, freePersonal].sort());
  });

  it('the node gate (getAccessibleMemoryIds) holds it, so the grantee reads its nodes', async () => {
    expect((await gate(ctx(grantee))).includes(appPersonal)).toBe(true);
    const node = await Q.node(null, { ref: 'notes:one', memoryRef: appPersonal }, ctx(grantee));
    expect(node?.content).toBe('app personal note');
  });

  it('effectiveAccess agrees: a MEMORY_SHARE grant at the share\'s role, with no subscription (drift tell, CLAUDE.md)', async () => {
    const urn = (await db.memory.findUniqueOrThrow({ where: { id: appPersonal }, select: { urn: true } })).urn;
    const asOwner = ctx(owner);
    const reader = await Q.effectiveAccess(null, { user: grantee, resource: `hrn:memory:${urn}` }, asOwner);
    expect(reader).toMatchObject({ canRead: true, canWrite: false, role: 'reader' });
    expect(reader.grants.map((g: { source: string }) => g.source)).toEqual(['MEMORY_SHARE']);
    const w = await Q.effectiveAccess(null, { user: writer, resource: `hrn:memory:${urn}` }, asOwner);
    expect(w).toMatchObject({ canRead: true, canWrite: true, role: 'writer' });
    const none = await Q.effectiveAccess(null, { user: stranger, resource: `hrn:memory:${urn}` }, asOwner);
    expect(none.canRead).toBe(false);
  });

  it('a WRITER grantee writes a node; a READER grantee may not', async () => {
    const written = await M.createNode(null, { input: { memoryRef: appPersonal, loc: 'notes:by-writer', name: 'w' } }, ctx(writer));
    expect(written?.loc).toBe('notes:by-writer');
    await expect(M.createNode(null, { input: { memoryRef: appPersonal, loc: 'notes:by-reader', name: 'r' } }, ctx(grantee)))
      .rejects.toThrow(/Forbidden|no write access/);
    expect(await db.node.count({ where: { memoryId: appPersonal, loc: 'notes:by-reader' } })).toBe(0);
  });
});

describe('#5389: still refused', () => {
  it('a non-grantee: concealed on Query.memory, absent from the list and the node gate, no write', async () => {
    await expect(Q.memory(null, { ref: appPersonal }, ctx(stranger))).resolves.toBeNull();
    expect(await listed(stranger)).toEqual([]);
    expect((await gate(ctx(stranger))).includes(appPersonal)).toBe(false);
    await expect(M.createNode(null, { input: { memoryRef: appPersonal, loc: 'notes:x', name: 'x' } }, ctx(stranger)))
      .rejects.toThrow(/Forbidden|no write access|MEMORY_NOT_FOUND/);
  });

  it('the org-membership mirror: a grantee who is not a member of the row\'s org gets nothing from that share', async () => {
    await expect(Q.memory(null, { ref: orgAppPersonal }, ctx(outsider))).resolves.toBeNull();
    expect(await listed(outsider)).toEqual([appPersonal]);
    expect((await gate(ctx(outsider))).includes(orgAppPersonal)).toBe(false);
  });

  it('a revoked membership drops the org-set share from every arm; the org-less one stays', async () => {
    await db.orgMember.update({ where: { organizationId_userId: { organizationId: org.id, userId: grantee } }, data: { deletedAt: new Date() } });
    await expect(Q.memory(null, { ref: orgAppPersonal }, ctx(grantee))).resolves.toBeNull();
    expect(await listed(grantee)).toEqual([appPersonal, freePersonal].sort());
    expect((await gate(ctx(grantee))).includes(orgAppPersonal)).toBe(false);
    expect((await Q.memory(null, { ref: appPersonal }, ctx(grantee)))?.id).toBe(appPersonal);
  });

  it('a deleted share grants nothing', async () => {
    await db.memoryShare.delete({ where: { memoryId_granteeId: { memoryId: appPersonal, granteeId: grantee } } });
    await expect(Q.memory(null, { ref: appPersonal }, ctx(grantee))).resolves.toBeNull();
    expect((await gate(ctx(grantee))).includes(appPersonal)).toBe(false);
  });

  it('an admin role adds nothing (R2): an org ADMIN who is not a grantee is refused', async () => {
    await db.orgMember.update({ where: { organizationId_userId: { organizationId: org.id, userId: stranger } }, data: { role: 'ADMIN' } });
    await expect(Q.memory(null, { ref: appPersonal }, ctx(stranger))).resolves.toBeNull();
    expect((await gate(ctx(stranger))).includes(appPersonal)).toBe(false);
  });

  it('an App key gets no share reach: the sharedWithMe slice is empty and the record is concealed', async () => {
    const key: Context = { db, appId, roles: ['READER'] };
    expect((await Q.memories(null, { filter: { sharedWithMe: true } }, key)).items).toEqual([]);
    await expect(Q.memory(null, { ref: appPersonal }, key)).resolves.toBeNull();
  });
});
