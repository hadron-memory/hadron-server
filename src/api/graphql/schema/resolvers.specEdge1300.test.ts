/**
 * #1300 — REPRODUCTION FIRST. A customer who is OWNER of her org could create
 * spec nodes through `createSpecNode` but every `createEdge` between them was
 * refused `Forbidden` — `hadron spec new` then left an orphan, and both
 * remedies it suggested (`edge add`, `spec link`) call the same mutation.
 *
 * The caller here is shaped like a real customer account: GLOBAL platform
 * roles at the schema default (`[READER]`), and OWNER of her organisation.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let memoryId: string;
let ownerId: string;

/** Exactly what the server builds for a JWT user: the user row's own roles. */
const ownerCtx = async (): Promise<Context> => {
  const u = await db.user.findUniqueOrThrow({ where: { id: ownerId } });
  return { db, roles: u.roles as Context['roles'], userId: ownerId, clientId: `user:${ownerId}` };
};

const M = resolvers.Mutation as unknown as Record<string, (...a: unknown[]) => Promise<any>>;

beforeEach(async () => {
  await cleanDb(db);
  const t = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  const org = await db.organization.create({ data: { id: generateId(), name: 'cust', urn: `cust-${t}` } });
  // No `roles` given: the schema default, as for every self-signed-up user.
  const owner = await db.user.create({ data: { id: generateId(), githubId: 13000, githubUsername: `cust-${t}` } });
  ownerId = owner.id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: owner.id, role: 'OWNER' } });
  const mem = await M.createMemory({}, { orgId: org.id, name: `specs-${t}` }, await ownerCtx());
  memoryId = mem.id;
});

describe('#1300 — an org OWNER with default platform roles', () => {
  it('has the schema-default global roles (the precondition this reproduction depends on)', async () => {
    expect((await ownerCtx()).roles).toEqual(['READER']);
  });

  it('can create spec nodes through the spec door', async () => {
    const parent = await M.createSpecNode({}, { input: { memoryId, loc: 'app:onb:010', name: 'feature', role: 'spec' } }, await ownerCtx());
    expect(parent.id).toBeTruthy();
  });

  it('REPRODUCED: the generic createEdge refuses her, and the refusal is the GLOBAL role gate', async () => {
    // Not the #1201 spec protection: `createEdge` opens with
    // `requireRole(ctx, 'CONTRIBUTOR')`, a PLATFORM role, before any memory
    // gate runs. Every self-signed-up user holds `[READER]`, so this refuses
    // an edge between ANY two nodes, spec or not, in a memory she owns.
    // Whether that gate should stay is a decision, not this file's to make:
    // it pins today's behaviour so a change to it is a visible act.
    const parent = await M.createSpecNode({}, { input: { memoryId, loc: 'app:onb:010', name: 'feature', role: 'spec' } }, await ownerCtx());
    const child = await M.createSpecNode({}, { input: { memoryId, loc: 'app:onb:010:02', name: 'rule', role: 'spec' } }, await ownerCtx());
    const plainA = await M.createNode({}, { input: { memoryId, loc: 'notes:a', name: 'a' } }, await ownerCtx());
    const plainB = await M.createNode({}, { input: { memoryId, loc: 'notes:b', name: 'b' } }, await ownerCtx());

    await expect(
      M.createEdge({}, { sourceRef: child.id, targetRef: parent.id, name: 'part-of' }, await ownerCtx()),
    ).rejects.toThrow(/^Forbidden$/);
    // Same refusal with no spec node anywhere: the gate is not about specs.
    await expect(
      M.createEdge({}, { sourceRef: plainA.id, targetRef: plainB.id, name: 'rel' }, await ownerCtx()),
    ).rejects.toThrow(/^Forbidden$/);
  });

  it('CAN wire the edge through the spec door itself: createSpecNode with inline edges', async () => {
    const c = await ownerCtx();
    const parent = await M.createSpecNode({}, { input: { memoryId, loc: 'app:onb:010', name: 'feature', role: 'spec' } }, c);
    const child = await M.createSpecNode(
      {},
      { input: { memoryId, loc: 'app:onb:010:02', name: 'rule', role: 'spec', edges: [{ targetId: parent.id, name: 'part-of' }] } },
      c,
    );
    const edges = await db.edge.findMany({ where: { sourceId: child.id, deletedAt: null } });
    expect(edges.map((e) => [e.targetId, e.name])).toEqual([[parent.id, 'part-of']]);
  });

  it('is ATOMIC through the spec door: an edge that cannot be written leaves no node behind', async () => {
    // Requirement 2 of #1300: `spec new` must not commit half its work. The
    // inline path already guarantees it; the CLI's create-then-createEdge
    // sequence is what produced the orphans.
    await expect(
      M.createSpecNode(
        {},
        { input: { memoryId, loc: 'app:onb:010:03', name: 'rule', role: 'spec', edges: [{ targetId: 'app:onb:does-not-exist', name: 'part-of' }] } },
        await ownerCtx(),
      ),
    ).rejects.toThrow(/Edge target not found/);
    expect(await db.node.findFirst({ where: { memoryId, loc: 'app:onb:010:03', deletedAt: null } })).toBeNull();
  });

  it('CAN repair an existing orphan through the spec door: updateSpecNode with edges', async () => {
    // `edges` on an update REPLACES the node's whole outgoing set, so a
    // client adding one edge must send the ones already there as well.
    const c = await ownerCtx();
    const parent = await M.createSpecNode({}, { input: { memoryId, loc: 'app:onb:010', name: 'feature', role: 'spec' } }, c);
    const orphan = await M.createSpecNode({}, { input: { memoryId, loc: 'app:onb:010:02', name: 'rule', role: 'spec' } }, c);

    await M.updateSpecNode({}, { input: { id: orphan.id, edges: [{ targetId: parent.id, name: 'part-of' }] } }, c);

    const edges = await db.edge.findMany({ where: { sourceId: orphan.id, deletedAt: null } });
    expect(edges.map((e) => [e.targetId, e.name])).toEqual([[parent.id, 'part-of']]);
  });
});
