/**
 * Spec 034 (leaner MVP) — owner-only personal/private memories.
 *
 * A user can create a `private` (or `personal`) memory they own — including the
 * free-standing shape (no app, no agent), with the org only as a container.
 * Access is owner-only: no other org member, and no platform ADMIN/OWNER, can
 * read or write it. This is the fix for the first-customer incident (a portal
 * user wanting a truly private memory).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

function ctx(overrides: Partial<Context> = {}): Context {
  return { db, ...overrides };
}

// PR3: Query.nodes was replaced by Query.findNodes. This helper preserves the
// old list-of-nodes shape so the owner-only access assertions are unchanged.
async function listNodes(args: any, c: any) {
  const res = await resolvers.Query.findNodes(null, args, c);
  return res.hits.map((h) => h.node);
}

let org: { id: string };
let owner: { id: string }; // org READER who creates + owns the memory
let other: { id: string }; // another org READER
let admin: { id: string }; // global OWNER (platform operator)

beforeEach(async () => {
  await cleanDb(db);
  const a = await createDbOrgAndGraph(db, { orgName: 'micromentor', graphName: 'micromentor/repo', visibility: 'ORGANIZATION' });
  org = a.org;
  owner = await db.user.create({ data: { githubId: 5001, githubUsername: 'harneet', roles: ['READER'] } });
  other = await db.user.create({ data: { githubId: 5002, githubUsername: 'other', roles: ['READER'] } });
  admin = await db.user.create({ data: { githubId: 5003, githubUsername: 'operator', roles: ['OWNER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: owner.id, role: 'READER' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: other.id, role: 'READER' } });
});

const asOwner = () => ctx({ userId: owner.id, roles: ['READER'] });
const asOther = () => ctx({ userId: other.id, roles: ['READER'] });
const asAdmin = () => ctx({ userId: admin.id, roles: ['OWNER'] });

async function createPrivate(name = 'my-private') {
  return resolvers.Mutation.createMemory(null, { orgId: org.id, name, memoryClass: 'private' } as any, asOwner());
}

describe('createMemory — owner-owned classes', () => {
  it('a READER member can create a private memory they own (free-standing: no app/agent)', async () => {
    const mem = await createPrivate();
    expect(mem.class).toBe('private');
    expect(mem.visibility).toBeNull();
    expect(mem.userId).toBe(owner.id);
    expect(mem.appId).toBeNull();
    expect(mem.userMemoryOfAgentId).toBeNull();
    expect(mem.organizationId).toBe(org.id); // org is the container
  });

  it('a READER member can create a personal memory they own', async () => {
    const mem = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'my-personal', memoryClass: 'personal' } as any, asOwner());
    expect(mem.class).toBe('personal');
    expect(mem.visibility).toBeNull();
    expect(mem.userId).toBe(owner.id);
  });

  it('a non-member cannot create a personal/private memory in the org', async () => {
    const stranger = await db.user.create({ data: { githubId: 5004, githubUsername: 'stranger', roles: ['READER'] } });
    await expect(
      resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'nope', memoryClass: 'private' } as any, ctx({ userId: stranger.id, roles: ['READER'] })),
    ).rejects.toThrow();
  });

  it('an unauthenticated / app-key caller cannot create a personal/private memory', async () => {
    await expect(
      resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'nope2', memoryClass: 'private' } as any, ctx({ appId: 'some-app' })),
    ).rejects.toThrow();
  });
});

describe('private/personal access is owner-only', () => {
  it('the owner can read, list, and write their private memory', async () => {
    const mem = await createPrivate();
    // read via memory(id)
    expect((await resolvers.Query.memory(null, { id: mem.id }, asOwner()))?.id).toBe(mem.id);
    // appears in myMemories
    const mine = await resolvers.Query.myMemories(null, {}, asOwner());
    expect(mine.map((m: any) => m.id)).toContain(mem.id);
    // owner can write a node (READER role notwithstanding — it's their memory)
    const node = await resolvers.Mutation.createNode(null, { input: { memoryId: mem.id, loc: 'micromentor.repo.note', name: 'note' } } as any, asOwner());
    expect(node.loc).toBe('micromentor.repo.note');
    // owner sees its nodes
    const nodes = await listNodes({}, asOwner());
    expect(nodes.some((n: any) => n.memoryId === mem.id)).toBe(true);
  });

  it('another org member cannot read, list, open, or write it', async () => {
    const mem = await createPrivate();
    await expect(resolvers.Query.memory(null, { id: mem.id }, asOther())).rejects.toThrow('Forbidden');
    const mine = await resolvers.Query.myMemories(null, {}, asOther());
    expect(mine.map((m: any) => m.id)).not.toContain(mem.id);
    const nodes = await listNodes({}, asOther());
    expect(nodes.some((n: any) => n.memoryId === mem.id)).toBe(false);
    await expect(
      resolvers.Mutation.createNode(null, { input: { memoryId: mem.id, loc: 'micromentor.repo.hack', name: 'h' } } as any, asOther()),
    ).rejects.toThrow('Forbidden');
  });

  it('a platform OWNER/ADMIN cannot read or write it (no role bypass)', async () => {
    const mem = await createPrivate();
    await expect(resolvers.Query.memory(null, { id: mem.id }, asAdmin())).rejects.toThrow('Forbidden');
    await expect(
      resolvers.Mutation.createNode(null, { input: { memoryId: mem.id, loc: 'micromentor.repo.adminedit', name: 'x' } } as any, asAdmin()),
    ).rejects.toThrow('Forbidden');
  });
});

describe('MemoryShare boundary (U8)', () => {
  it('a personal memory can be shared; a private memory cannot', async () => {
    const personal = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'sharable', memoryClass: 'personal' } as any, asOwner());
    // personal: share accepted
    const share = await resolvers.Mutation.createMemoryShare(null, { memoryId: personal.id, granteeId: other.id, role: 'writer' } as any, asOwner());
    expect(share).toBeTruthy();
    // private: share rejected (class-not-shareable)
    const priv = await createPrivate('locked');
    await expect(
      resolvers.Mutation.createMemoryShare(null, { memoryId: priv.id, granteeId: other.id, role: 'writer' } as any, asOwner()),
    ).rejects.toThrow();
  });
});
