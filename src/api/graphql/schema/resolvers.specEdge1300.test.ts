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

  it('FIXED (Q1, Holger 2026-09-24): createEdge / updateEdge / deleteEdge work for her, spec or plain nodes', async () => {
    const c = await ownerCtx();
    const parent = await M.createSpecNode({}, { input: { memoryId, loc: 'app:onb:010', name: 'feature', role: 'spec' } }, c);
    const child = await M.createSpecNode({}, { input: { memoryId, loc: 'app:onb:010:02', name: 'rule', role: 'spec' } }, c);
    const plainA = await M.createNode({}, { input: { memoryId, loc: 'notes:a', name: 'a' } }, c);
    const plainB = await M.createNode({}, { input: { memoryId, loc: 'notes:b', name: 'b' } }, c);

    const specEdge = await M.createEdge({}, { sourceRef: child.id, targetRef: parent.id, name: 'part-of' }, c);
    expect(specEdge).toMatchObject({ sourceId: child.id, targetId: parent.id });
    const plainEdge = await M.createEdge({}, { sourceRef: plainA.id, targetRef: plainB.id, name: 'rel' }, c);

    const updated = await M.updateEdge({}, { edgeRef: plainEdge.id, description: 'why' }, c);
    expect(updated.description).toBe('why');
    expect(await M.deleteEdge({}, { edgeRef: plainEdge.id }, c)).toBe(true);
    expect(await db.edge.findUnique({ where: { id: plainEdge.id } })).toBeNull();
  });

  describe('DENIAL CONTROLS: the memory gate alone still refuses everyone who cannot write (@Bo, #1306)', () => {
    // The platform gate was never the thing keeping these out; the memory gate
    // was, on all three mutations, delete included. Pinned per mutation.
    let edgeId: string;
    let srcId: string;
    let tgtId: string;
    beforeEach(async () => {
      const c = await ownerCtx();
      srcId = (await M.createNode({}, { input: { memoryId, loc: 'n:src', name: 's' } }, c)).id;
      tgtId = (await M.createNode({}, { input: { memoryId, loc: 'n:tgt', name: 't' } }, c)).id;
      edgeId = (await M.createEdge({}, { sourceRef: srcId, targetRef: tgtId, name: 'rel' }, c)).id;
    });

    const denied = async (who: Context) => {
      const results = await Promise.all([
        M.createEdge({}, { sourceRef: srcId, targetRef: tgtId, name: 'again' }, who).then(() => 'OK', () => 'REFUSED'),
        M.updateEdge({}, { edgeRef: edgeId, description: 'x' }, who).then(() => 'OK', () => 'REFUSED'),
        M.deleteEdge({}, { edgeRef: edgeId }, who).then(() => 'OK', () => 'REFUSED'),
      ]);
      expect(results).toEqual(['REFUSED', 'REFUSED', 'REFUSED']);
      // …and nothing changed: the edge is still there, unedited, with no twin.
      const edges = await db.edge.findMany({ where: { sourceId: srcId } });
      expect(edges.map((e) => [e.id, e.description])).toEqual([[edgeId, null]]);
    };

    it('a READER member of the same org', async () => {
      const t = `${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
      const reader = await db.user.create({ data: { id: generateId(), githubId: 13001, githubUsername: `rd-${t}` } });
      const mem = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
      await db.orgMember.create({ data: { organizationId: mem.organizationId!, userId: reader.id, role: 'READER' } });
      await denied({ db, roles: ['READER'], userId: reader.id, clientId: `user:${reader.id}` } as Context);
    });

    it('a user of another organisation', async () => {
      const t = `${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
      const stranger = await db.user.create({ data: { id: generateId(), githubId: 13002, githubUsername: `st-${t}` } });
      await denied({ db, roles: ['READER'], userId: stranger.id, clientId: `user:${stranger.id}` } as Context);
    });

    it('an unauthenticated caller', async () => {
      await denied({ db, roles: [] } as unknown as Context);
    });

    // @codex P2 on PR #1307: with no platform gate in front, a denial must not
    // tell a caller who cannot READ the memory whether a ref exists.
    const code = (p: Promise<unknown>) =>
      p.then(() => 'OK', (e: { extensions?: { code?: string }; message?: string }) => e.extensions?.code ?? e.message ?? 'ERR');

    it('NO EXISTENCE ORACLE: an outsider and an anonymous caller get the same answer for an existing ref as for a missing one', async () => {
      const t = `${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
      const stranger = await db.user.create({ data: { id: generateId(), githubId: 13003, githubUsername: `or-${t}` } });
      const mem = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
      const missingNode = `hrn:node:${mem.urn.replace(/^hrn:mem:/, '')}:n:nope`;
      const missingEdge = 'hrn:edge:nowhere.example:m:n:rel:n';
      for (const who of [
        { db, roles: ['READER'], userId: stranger.id, clientId: `user:${stranger.id}` } as Context,
        { db, roles: [] } as unknown as Context,
      ]) {
        expect(await code(M.createEdge({}, { sourceRef: srcId, targetRef: tgtId, name: 'x' }, who)))
          .toBe(await code(M.createEdge({}, { sourceRef: missingNode, targetRef: tgtId, name: 'x' }, who)));
        expect(await code(M.updateEdge({}, { edgeRef: edgeId, description: 'x' }, who)))
          .toBe(await code(M.updateEdge({}, { edgeRef: missingEdge, description: 'x' }, who)));
        expect(await code(M.deleteEdge({}, { edgeRef: edgeId }, who)))
          .toBe(await code(M.deleteEdge({}, { edgeRef: missingEdge }, who)));
      }
    });

    it('CONTROL: a READER member (who can see the edge) is told Forbidden, not not-found', async () => {
      const t = `${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
      const reader = await db.user.create({ data: { id: generateId(), githubId: 13004, githubUsername: `rc-${t}` } });
      const m = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
      await db.orgMember.create({ data: { organizationId: m.organizationId!, userId: reader.id, role: 'READER' } });
      const who = { db, roles: ['READER'], userId: reader.id, clientId: `user:${reader.id}` } as Context;
      expect(await code(M.deleteEdge({}, { edgeRef: edgeId }, who))).not.toBe('EDGE_NOT_FOUND');
    });
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
