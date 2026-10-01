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
import { requireMemoryWriteAccess } from './resolvers.helpers.js';
import { reassertManage } from './resolvers.memoryConfig.js';

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
let orgAdmin: { id: string }; // org ADMIN, not the strict owner

beforeEach(async () => {
  await cleanDb(db);
  const a = await createDbOrgAndGraph(db, { orgName: 'micromentor', graphName: 'micromentor/repo', visibility: 'ORGANIZATION' });
  org = a.org;
  owner = await db.user.create({ data: { githubId: 5001, githubUsername: 'harneet', roles: ['READER'] } });
  other = await db.user.create({ data: { githubId: 5002, githubUsername: 'other', roles: ['READER'] } });
  admin = await db.user.create({ data: { githubId: 5003, githubUsername: 'operator', roles: ['OWNER'] } });
  orgAdmin = await db.user.create({ data: { githubId: 5005, githubUsername: 'org-admin', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: owner.id, role: 'READER' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: other.id, role: 'READER' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: orgAdmin.id, role: 'ADMIN' } });
});

const asOwner = () => ctx({ userId: owner.id, roles: ['READER'] });
const asOther = () => ctx({ userId: other.id, roles: ['READER'] });
const asAdmin = () => ctx({ userId: admin.id, roles: ['OWNER'] });
const asOrgAdmin = () => ctx({ userId: orgAdmin.id, roles: ['READER'] });

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
  it.each(['private', 'personal'] as const)('updateMemory manages an org-anchored %s memory only for its strict owner', async (memoryClass) => {
    const mem = await resolvers.Mutation.createMemory(
      null, { orgId: org.id, name: `${memoryClass}-settings`, memoryClass } as any, asOwner(),
    );
    await db.memory.update({
      where: { id: mem.id },
      data: { shortDescription: 'private sentinel', data: { secret: 'private sentinel' } },
    });

    expect((await resolvers.Mutation.updateMemory(null, { id: mem.id, description: 'owner edit' }, asOwner())).description)
      .toBe('owner edit');
    expect(await resolvers.Query.memory(null, { ref: mem.id }, asOrgAdmin())).toBeNull();
    await expect(resolvers.Mutation.updateMemory(null, { id: mem.id }, asOrgAdmin()))
      .rejects.toThrow('MEMORY_NOT_FOUND');
    await expect(resolvers.Mutation.updateMemory(null, { id: mem.id, description: 'admin edit' }, asOrgAdmin()))
      .rejects.toThrow('MEMORY_NOT_FOUND');
    await expect(resolvers.Mutation.updateMemory(null, { id: mem.id }, asAdmin()))
      .rejects.toThrow('MEMORY_NOT_FOUND');
    expect((await db.memory.findUniqueOrThrow({ where: { id: mem.id } })).description).toBe('owner edit');
  });

  it('rechecks the locked owner before updateMemory writes', async () => {
    const mem = await createPrivate('owner-race');
    const transaction = db.$transaction.bind(db);
    const raceDb = new Proxy(db, {
      get(target, key) {
        if (key === '$transaction') {
          return async (work: Parameters<typeof transaction>[0]) => {
            await db.memory.update({ where: { id: mem.id }, data: { userId: other.id } });
            return transaction(work as any);
          };
        }
        return Reflect.get(target, key);
      },
    });

    await expect(resolvers.Mutation.updateMemory(null, { id: mem.id, description: 'stale owner edit' }, ctx({
      userId: owner.id, roles: ['READER'], db: raceDb,
    }))).rejects.toThrow('MEMORY_NOT_FOUND');
    const after = await db.memory.findUniqueOrThrow({ where: { id: mem.id } });
    expect(after.userId).toBe(other.id);
    expect(after.description).not.toBe('stale owner edit');
  });

  it('does not let an old org admin write after a concurrent ownership transfer', async () => {
    const mem = await resolvers.Mutation.createMemory(
      null, { orgId: org.id, name: 'transferring-memory' }, asOrgAdmin(),
    );
    const destination = await db.organization.create({
      data: { id: generateId(), name: 'destination', urn: 'destination' },
    });
    const transaction = db.$transaction.bind(db);
    const raceDb = new Proxy(db, {
      get(target, key) {
        if (key === '$transaction') {
          return async (work: Parameters<typeof transaction>[0]) => {
            await db.memory.update({ where: { id: mem.id }, data: { organizationId: destination.id } });
            return transaction(work as any);
          };
        }
        return Reflect.get(target, key);
      },
    });

    await expect(resolvers.Mutation.updateMemory(null, { id: mem.id, description: 'old admin edit' }, ctx({
      userId: orgAdmin.id, roles: ['READER'], db: raceDb,
    }))).rejects.toThrow('MEMORY_NOT_FOUND');
    const after = await db.memory.findUniqueOrThrow({ where: { id: mem.id } });
    expect(after.organizationId).toBe(destination.id);
    expect(after.description).not.toBe('old admin edit');
  });

  it('asks a manager of both orgs to retry after a concurrent transfer', async () => {
    const mem = await resolvers.Mutation.createMemory(
      null, { orgId: org.id, name: 'transfer-retry' }, asOrgAdmin(),
    );
    const destination = await db.organization.create({
      data: { id: generateId(), name: 'managed-destination', urn: 'managed-destination' },
    });
    await db.orgMember.create({ data: { organizationId: destination.id, userId: orgAdmin.id, role: 'ADMIN' } });
    const transaction = db.$transaction.bind(db);
    const raceDb = new Proxy(db, {
      get(target, key) {
        if (key === '$transaction') {
          return async (work: Parameters<typeof transaction>[0]) => {
            await db.memory.update({ where: { id: mem.id }, data: { organizationId: destination.id } });
            return transaction(work as any);
          };
        }
        return Reflect.get(target, key);
      },
    });

    await expect(resolvers.Mutation.updateMemory(null, { id: mem.id, description: 'stale calculation' }, ctx({
      userId: orgAdmin.id, roles: ['READER'], db: raceDb,
    }))).rejects.toMatchObject({ extensions: { code: 'CONFLICT' } });
    expect((await db.memory.findUniqueOrThrow({ where: { id: mem.id } })).description).not.toBe('stale calculation');
  });

  it('does not let a former strict owner set the source token after an owner change', async () => {
    const mem = await createPrivate('token-race');
    const transaction = db.$transaction.bind(db);
    const raceDb = new Proxy(db, {
      get(target, key) {
        if (key === '$transaction') {
          return async (work: Parameters<typeof transaction>[0]) => {
            await db.memory.update({ where: { id: mem.id }, data: { userId: other.id } });
            return transaction(work as any);
          };
        }
        return Reflect.get(target, key);
      },
    });

    await expect(resolvers.Mutation.setMemorySourceToken(null, {
      id: mem.id, token: 'former-owner-token',
    }, ctx({ userId: owner.id, roles: ['READER'], db: raceDb }))).rejects.toThrow('MEMORY_NOT_FOUND');
    expect((await db.memory.findUniqueOrThrow({ where: { id: mem.id } })).sourceTokenEncrypted).toBeNull();
  });

  it('does not let a former manager restamp failed embeddings after an org transfer', async () => {
    const mem = await resolvers.Mutation.createMemory(
      null, { orgId: org.id, name: 'embedding-race' }, asOrgAdmin(),
    );
    const node = await db.node.create({
      data: { id: generateId(), memoryId: mem.id, loc: 'failed-embedding', name: 'failed-embedding' },
    });
    const failedAt = new Date('2026-09-01T00:00:00.000Z');
    await db.memory.update({ where: { id: mem.id }, data: { vectorIndexEnabled: true } });
    await db.$executeRaw`
      UPDATE nodes SET embedding_failed_at = ${failedAt}, embedding_pending_at = NULL
      WHERE id = ${node.id}
    `;
    const storedFailedAt = (await db.node.findUniqueOrThrow({ where: { id: node.id } })).embeddingFailedAt;
    expect(storedFailedAt).not.toBeNull();
    const destination = await db.organization.create({
      data: { id: generateId(), name: 'embedding-destination', urn: 'embedding-destination' },
    });
    const transaction = db.$transaction.bind(db);
    const raceDb = new Proxy(db, {
      get(target, key) {
        if (key === '$transaction') {
          return async (work: Parameters<typeof transaction>[0]) => {
            await db.memory.update({ where: { id: mem.id }, data: { organizationId: destination.id } });
            return transaction(work as any);
          };
        }
        return Reflect.get(target, key);
      },
    });

    await expect(resolvers.Mutation.retryFailedEmbeddings(null, { memoryRef: mem.id }, ctx({
      userId: orgAdmin.id, roles: ['READER'], db: raceDb,
    }))).rejects.toThrow('MEMORY_NOT_FOUND');
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).embeddingFailedAt).toEqual(storedFailedAt);
  });

  it('holds memory-config management authority through the write transaction', async () => {
    const mem = await createPrivate('config-transfer-race');
    let gateReached!: () => void;
    let releaseWriter!: () => void;
    const atGate = new Promise<void>((resolve) => { gateReached = resolve; });
    const release = new Promise<void>((resolve) => { releaseWriter = resolve; });
    const writer = db.$transaction(async (tx) => {
      await reassertManage(asOwner(), tx, mem.id, () => new Error('Forbidden'));
      gateReached();
      await release;
    });
    await atGate;
    let transferCommitted = false;
    const transfer = db.memory.update({ where: { id: mem.id }, data: { userId: other.id } })
      .then(() => { transferCommitted = true; });
    try {
      // The transfer has its own DB connection and must wait for the writer's
      // Memory row lock, even after the access check has already returned.
      await db.$executeRaw`SELECT pg_sleep(0.05)`;
      expect(transferCommitted).toBe(false);
    } finally {
      releaseWriter();
      await writer;
      await transfer;
    }
    expect((await db.memory.findUniqueOrThrow({ where: { id: mem.id } })).userId).toBe(other.id);
  });

  it.each(['private', 'personal'] as const)('other management mutations conceal an org-anchored %s memory from its admin', async (memoryClass) => {
    const mem = await resolvers.Mutation.createMemory(
      null, { orgId: org.id, name: `${memoryClass}-controls`, memoryClass } as any, asOwner(),
    );
    const controls = [
      () => resolvers.Mutation.retryFailedEmbeddings(null, { memoryRef: mem.id }, asOrgAdmin()),
      () => resolvers.Mutation.setMemorySourceToken(null, { id: mem.id, token: 'synthetic-token' }, asOrgAdmin()),
      () => resolvers.Mutation.syncMemory(null, { id: mem.id }, asOrgAdmin()),
      () => resolvers.Mutation.pushMemoryToGit(null, { id: mem.id }, asOrgAdmin()),
      () => resolvers.Mutation.updateMemorySubscription(
        null, { memoryRef: mem.id, orgRef: org.id, role: 'READER' }, asOrgAdmin(),
      ),
    ];
    for (const control of controls) {
      await expect(control()).rejects.toThrow(/MEMORY_NOT_FOUND|not found|No match for memoryRef/i);
    }

    expect(await resolvers.Mutation.retryFailedEmbeddings(null, { memoryRef: mem.id }, asOwner())).toBe(0);
    await resolvers.Mutation.setMemorySourceToken(null, { id: mem.id, token: 'owner-token' }, asOwner());
    expect((await db.memory.findUniqueOrThrow({ where: { id: mem.id } })).sourceTokenEncrypted).toBeTruthy();
    await expect(resolvers.Mutation.syncMemory(null, { id: mem.id }, asOwner())).resolves.toBeTruthy();
  });

  it('the owner can read, list, and write their private memory', async () => {
    const mem = await createPrivate();
    // read via memory(id)
    expect((await resolvers.Query.memory(null, { ref: mem.id }, asOwner()))?.id).toBe(mem.id);
    // appears in myMemories
    const mine = (await resolvers.Query.memories(null, {}, asOwner())).items;
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
    await expect(resolvers.Query.memory(null, { ref: mem.id }, asOther())).resolves.toBeNull();
    const mine = (await resolvers.Query.memories(null, {}, asOther())).items;
    expect(mine.map((m: any) => m.id)).not.toContain(mem.id);
    const nodes = await listNodes({}, asOther());
    expect(nodes.some((n: any) => n.memoryId === mem.id)).toBe(false);
    await expect(
      resolvers.Mutation.createNode(null, { input: { memoryId: mem.id, loc: 'micromentor.repo.hack', name: 'h' } } as any, asOther()),
    ).rejects.toThrow('MEMORY_NOT_FOUND');
  });

  it('a platform OWNER/ADMIN cannot read or write it (no role bypass)', async () => {
    const mem = await createPrivate();
    await expect(resolvers.Query.memory(null, { ref: mem.id }, asAdmin())).resolves.toBeNull();
    await expect(
      resolvers.Mutation.createNode(null, { input: { memoryId: mem.id, loc: 'micromentor.repo.adminedit', name: 'x' } } as any, asAdmin()),
    ).rejects.toThrow('MEMORY_NOT_FOUND');
  });

  it.each(['private', 'personal'] as const)(
    'an App-selected platform admin cannot replace text in another user\'s %s memory',
    async (memoryClass) => {
      const mem = await resolvers.Mutation.createMemory(
        null, { orgId: org.id, name: `${memoryClass}-replace`, memoryClass } as any, asOwner(),
      );
      const node = await db.node.create({
        data: { id: generateId(), memoryId: mem.id, loc: 'sentinel', name: 'sentinel', content: 'cat sentinel' },
      });
      const app = await db.app.create({
        data: { id: generateId(), organizationId: org.id, urn: `micromentor:${memoryClass}-app`, name: `${memoryClass}-app` },
      });
      const input = { oldText: 'cat', newText: 'dog', nodeIds: [node.id], fields: ['content'] };
      await expect(resolvers.Mutation.searchReplaceInNodes(
        {}, { input } as never, ctx({ userId: admin.id, roles: ['OWNER'], appId: app.id }),
      )).rejects.toThrow();
      expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).content).toBe('cat sentinel');

      const result = await resolvers.Mutation.searchReplaceInNodes(
        {}, { input } as never, asOwner(),
      );
      expect(result.nodesChanged).toBe(1);
      expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).content).toBe('dog sentinel');
    },
  );

  it.each(['private', 'personal'] as const)('an App selection admits the subscribed %s owner, not a pure App key or a platform OWNER', async (memoryClass) => {
    const mem = await resolvers.Mutation.createMemory(
      null, { orgId: org.id, name: `${memoryClass}-selected`, memoryClass } as any, asOwner(),
    );
    const app = await db.app.create({
      data: { id: generateId(), organizationId: org.id, urn: `micromentor:${memoryClass}-selected-app`, name: 'selected-app' },
    });
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: `micromentor:${memoryClass}-selected-agent`,
        name: 'selected-agent', type: 'CHATBOT', surfaces: ['api'] },
    });
    await db.memory.update({ where: { id: mem.id }, data: { appId: app.id, userMemoryOfAgentId: agent.id } });
    // #1503 (Holger's ruling (c), 2026-10-01): under App selection the owner is
    // judged by the shared gate, the same as MCP, so FR-019 applies. With no
    // AgentSubscription the write is refused (#1500's inline shortcut used to
    // skip it, so GraphQL and MCP disagreed); with an active one it succeeds.
    const asSelectingOwner = ctx({ appId: app.id, userId: owner.id, roles: ['READER'] });
    await expect(requireMemoryWriteAccess(asSelectingOwner, mem.id)).rejects.toThrow('Forbidden');
    await db.agentSubscription.create({ data: { userId: owner.id, agentId: agent.id, activatedAt: new Date() } });
    await expect(requireMemoryWriteAccess(asSelectingOwner, mem.id)).resolves.toBeUndefined();
    await expect(requireMemoryWriteAccess(ctx({ appId: app.id }), mem.id))
      .rejects.toThrow('Forbidden');
    await expect(requireMemoryWriteAccess(ctx({ appId: app.id, userId: admin.id, roles: ['OWNER'] }), mem.id))
      .rejects.toThrow('Forbidden');
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

describe('myMemories — active-org scope (#463)', () => {
  it('shows the caller own personal memories regardless of the active org (category 1)', async () => {
    // Owner's personal memory in org A (the beforeEach org).
    const personalA = await resolvers.Mutation.createMemory(
      null, { orgId: org.id, name: 'personal-a', memoryClass: 'personal' } as any, asOwner(),
    );
    // A second org the owner also belongs to, with their own personal memory.
    const orgB = await db.organization.create({
      data: { id: generateId(), name: 'org-b', urn: `org-b-${generateId()}` },
    });
    await db.orgMember.create({ data: { organizationId: orgB.id, userId: owner.id, role: 'READER' } });
    const personalB = await resolvers.Mutation.createMemory(
      null, { orgId: orgB.id, name: 'personal-b', memoryClass: 'personal' } as any, asOwner(),
    );

    // Unscoped: both personal memories present (cross-org union).
    const all = (await resolvers.Query.memories(null, {}, asOwner())).items.map((m: any) => m.id);
    expect(all).toEqual(expect.arrayContaining([personalA.id, personalB.id]));

    // Active org A: category (1) — the caller's OWN personal memories always
    // show, independent of the active org. So BOTH personalA and the org-B
    // personalB appear (they're user-owned, not org-owned).
    const scoped = (await resolvers.Query.memories(null, { orgId: org.id }, asOwner())).items.map((m: any) => m.id);
    expect(scoped).toContain(personalA.id);
    expect(scoped).toContain(personalB.id);

    // Non-member org → empty, no existence disclosure.
    const strangerOrg = await db.organization.create({
      data: { id: generateId(), name: 'stranger', urn: `stranger-${generateId()}` },
    });
    expect(await resolvers.Query.memories(null, { orgId: strangerOrg.id }, asOwner())).toEqual({ items: [], total: 0 });
  });

  it('active org shows the org own + subscribed memories, but not another member org own memory', async () => {
    // Org A owns a knowledge memory; owner is a member of A.
    const aKnowledge = await createDbOrgAndGraph(db, { orgName: 'a-owner', graphName: 'a/know', visibility: 'ORGANIZATION' });
    await db.orgMember.create({ data: { organizationId: aKnowledge.org.id, userId: owner.id, role: 'READER' } });
    // Another member org B with its own knowledge memory.
    const bKnowledge = await createDbOrgAndGraph(db, { orgName: 'b-owner', graphName: 'b/know', visibility: 'ORGANIZATION' });
    await db.orgMember.create({ data: { organizationId: bKnowledge.org.id, userId: owner.id, role: 'READER' } });

    // Active org = A: A's own memory (2) is in; B's own memory is NOT.
    const scoped = (await resolvers.Query.memories(null, { orgId: aKnowledge.org.id }, asOwner())).items.map((m: any) => m.id);
    expect(scoped).toContain(aKnowledge.graph.id);
    expect(scoped).not.toContain(bKnowledge.graph.id);
  });
});
