/**
 * #391 follow-up: GraphQL deleteNode soft-deletes by default (matching the
 * hadron_delete_node MCP tool), with hard: true for an irreversible row delete.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { composeNodeUrn } from '../../lib/urn.js';

const deleteNode = resolvers.Mutation.deleteNode as (p: unknown, a: unknown, c: Context) => Promise<boolean>;
const Q = resolvers.Query as Record<string, (p: unknown, a: unknown, c: Context) => Promise<unknown>>;

const ADMIN = generateId();
const adminCtx = (): Context => ({ db, roles: ['ADMIN'], userId: ADMIN });

interface Fx { memoryId: string; memoryUrn: string; nodeId: string; loc: string }

async function build(): Promise<Fx> {
  const org = await db.organization.create({ data: { id: generateId(), name: 'DelOrg', urn: 'delorg' } });
  const memory = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: 'delorg:kb', name: 'kb', class: 'knowledge', visibility: 'ORGANIZATION' },
  });
  const node = await db.node.create({
    data: { id: generateId(), memoryId: memory.id, loc: 'doomed', name: 'Doomed', tags: [] },
  });
  return { memoryId: memory.id, memoryUrn: memory.urn, nodeId: node.id, loc: node.loc };
}

describe('#391 deleteNode soft-by-default / hard opt-in', () => {
  let fx: Fx;
  beforeEach(async () => {
    await cleanDb(db);
    await db.user.create({ data: { id: ADMIN, roles: ['ADMIN'] } });
    fx = await build();
  });

  it('soft-deletes by default: row remains with deletedAt/deletedBy, hidden from reads', async () => {
    const ok = await deleteNode(null, { nodeRef: fx.nodeId }, adminCtx());
    expect(ok).toBe(true);

    const raw = await db.node.findUnique({ where: { id: fx.nodeId } });
    expect(raw).not.toBeNull();
    expect(raw!.deletedAt).not.toBeNull();
    expect(raw!.deletedBy).toBe(ADMIN);

    // Disappears from the read surfaces (post-#391 filters).
    expect(await Q.node(null, { ref: fx.nodeId }, adminCtx())).toBeNull();
    expect(await Q.node(null, { ref: fx.loc, memoryRef: fx.memoryId }, adminCtx())).toBeNull();
  });

  it('hard: true removes the row entirely', async () => {
    const ok = await deleteNode(null, { nodeRef: fx.nodeId, hard: true }, adminCtx());
    expect(ok).toBe(true);
    expect(await db.node.findUnique({ where: { id: fx.nodeId } })).toBeNull();
  });

  it('a missing node surfaces NODE_NOT_FOUND, not a raw 500', async () => {
    await expect(
      deleteNode(null, { nodeRef: composeNodeUrn(fx.memoryUrn, 'does-not-exist') }, adminCtx()),
    ).rejects.toThrow(/not found/i);
  });
});

describe('deleteNode recursive: deletes the whole loc-subtree', () => {
  let memoryId: string;
  const idOf: Record<string, string> = {};

  beforeEach(async () => {
    await cleanDb(db);
    await db.user.create({ data: { id: ADMIN, roles: ['ADMIN'] } });
    const org = await db.organization.create({ data: { id: generateId(), name: 'TreeOrg', urn: 'treeorg' } });
    const memory = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: 'treeorg:kb', name: 'kb', class: 'knowledge', visibility: 'ORGANIZATION' },
    });
    memoryId = memory.id;
    // parent + subtree, a ':' boundary sibling (parentx), and an unrelated node.
    for (const loc of ['parent', 'parent:a', 'parent:a:x', 'parent:b', 'parentx', 'other']) {
      const n = await db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, tags: [] } });
      idOf[loc] = n.id;
    }
  });

  const live = async (loc: string) => {
    const r = await db.node.findUnique({ where: { id: idOf[loc] } });
    return r != null && r.deletedAt == null;
  };

  it('soft-deletes the node and every descendant, on ":" boundaries', async () => {
    const ok = await deleteNode(null, { nodeRef: idOf['parent'], recursive: true }, adminCtx());
    expect(ok).toBe(true);

    // parent + descendants gone…
    for (const loc of ['parent', 'parent:a', 'parent:a:x', 'parent:b']) {
      expect(await live(loc), loc).toBe(false);
      // rows still present (soft delete) with attribution
      expect((await db.node.findUnique({ where: { id: idOf[loc] } }))!.deletedBy).toBe(ADMIN);
    }
    // …the ':' boundary sibling and the unrelated node survive.
    expect(await live('parentx')).toBe(true);
    expect(await live('other')).toBe(true);
  });

  it('hard: true removes the whole subtree rows', async () => {
    const ok = await deleteNode(null, { nodeRef: idOf['parent'], hard: true, recursive: true }, adminCtx());
    expect(ok).toBe(true);
    for (const loc of ['parent', 'parent:a', 'parent:a:x', 'parent:b']) {
      expect(await db.node.findUnique({ where: { id: idOf[loc] } }), loc).toBeNull();
    }
    expect(await db.node.findUnique({ where: { id: idOf['parentx'] } })).not.toBeNull();
    expect(await db.node.findUnique({ where: { id: idOf['other'] } })).not.toBeNull();
  });

  it('without recursive, refuses a node with descendants (NODE_HAS_DESCENDANTS) and changes nothing', async () => {
    await expect(
      deleteNode(null, { nodeRef: idOf['parent'] }, adminCtx()).catch((e) => {
        throw new Error((e as { extensions?: { code?: string } }).extensions?.code);
      }),
    ).rejects.toThrow('NODE_HAS_DESCENDANTS');
    // Nothing deleted — the parent and every descendant remain live.
    for (const loc of ['parent', 'parent:a', 'parent:a:x', 'parent:b']) {
      expect(await live(loc), loc).toBe(true);
    }
  });

  it('recursive on a leaf deletes just that node', async () => {
    await deleteNode(null, { nodeRef: idOf['parent:a:x'], recursive: true }, adminCtx());
    expect(await live('parent:a:x')).toBe(false);
    expect(await live('parent:a')).toBe(true);
    expect(await live('parent')).toBe(true);
  });
});

describe('deleteNode: idempotency + hard-delete safeguards (parity with hadron_delete_node)', () => {
  const codeOf = (e: unknown) => (e as { extensions?: { code?: string } }).extensions?.code;
  let memAId: string;
  const idOf: Record<string, string> = {};

  beforeEach(async () => {
    await cleanDb(db);
    await db.user.create({ data: { id: ADMIN, roles: ['ADMIN'] } });
    const org = await db.organization.create({ data: { id: generateId(), name: 'SafeOrg', urn: 'safeorg' } });
    const memA = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: 'safeorg:a', name: 'a', class: 'knowledge', visibility: 'ORGANIZATION' },
    });
    const memB = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: 'safeorg:b', name: 'b', class: 'knowledge', visibility: 'ORGANIZATION' },
    });
    memAId = memA.id;
    for (const [loc, mem] of [['parent', memA.id], ['parent:child', memA.id], ['extnode', memB.id]] as const) {
      const n = await db.node.create({ data: { id: generateId(), memoryId: mem, loc, name: loc, tags: [] } });
      idOf[loc] = n.id;
    }
  });

  it('soft re-delete is an idempotent no-op that preserves the original audit stamp', async () => {
    await deleteNode(null, { nodeRef: idOf['extnode'] }, adminCtx()); // leaf, no descendants
    const first = await db.node.findUnique({ where: { id: idOf['extnode'] } });
    await new Promise((r) => setTimeout(r, 5)); // ensure a re-stamp would differ
    const ok = await deleteNode(null, { nodeRef: idOf['extnode'] }, adminCtx());
    expect(ok).toBe(true);
    const second = await db.node.findUnique({ where: { id: idOf['extnode'] } });
    expect(second!.deletedAt!.getTime()).toBe(first!.deletedAt!.getTime());
    expect(second!.deletedBy).toBe(first!.deletedBy);
  });

  it('hard-delete refuses a cross-memory edge unless cascadeCrossMemoryEdges', async () => {
    // Edge parent:child (memory A) -> extnode (memory B) bridges A to B.
    await db.edge.create({
      data: { id: generateId(), memoryId: memAId, sourceId: idOf['parent:child'], targetId: idOf['extnode'], loc: 'bridge', name: 'bridge' },
    });
    // A recursive hard-delete of parent(A) whose descendant is on the bridging edge refuses.
    await expect(
      deleteNode(null, { nodeRef: idOf['parent'], hard: true, recursive: true }, adminCtx()).catch((e) => {
        throw new Error(codeOf(e));
      }),
    ).rejects.toThrow('CROSS_MEMORY_EDGES');
    expect(await db.node.findUnique({ where: { id: idOf['parent'] } })).not.toBeNull(); // nothing deleted

    // With the flag it proceeds: the subtree is gone and the bridging edge cascaded away…
    const ok = await deleteNode(
      null,
      { nodeRef: idOf['parent'], hard: true, recursive: true, cascadeCrossMemoryEdges: true },
      adminCtx(),
    );
    expect(ok).toBe(true);
    expect(await db.node.findUnique({ where: { id: idOf['parent'] } })).toBeNull();
    expect(await db.node.findUnique({ where: { id: idOf['parent:child'] } })).toBeNull();
    expect(await db.edge.findFirst({ where: { loc: 'bridge', memoryId: memAId } })).toBeNull();
    // …but the node in memory B survives — only the edge left its view.
    expect(await db.node.findUnique({ where: { id: idOf['extnode'] } })).not.toBeNull();
  });
});
