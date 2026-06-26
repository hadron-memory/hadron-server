/**
 * #391 follow-up: GraphQL deleteNode soft-deletes by default (matching the
 * hadron_delete_node MCP tool), with hard: true for an irreversible row delete.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';

const deleteNode = resolvers.Mutation.deleteNode as (p: unknown, a: unknown, c: Context) => Promise<boolean>;
const Q = resolvers.Query as Record<string, (p: unknown, a: unknown, c: Context) => Promise<unknown>>;

const ADMIN = generateId();
const adminCtx = (): Context => ({ db, roles: ['ADMIN'], userId: ADMIN });

interface Fx { memoryId: string; nodeId: string; loc: string }

async function build(): Promise<Fx> {
  const org = await db.organization.create({ data: { id: generateId(), name: 'DelOrg', urn: 'delorg' } });
  const memory = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: 'delorg:kb', name: 'kb', class: 'knowledge', visibility: 'ORGANIZATION' },
  });
  const node = await db.node.create({
    data: { id: generateId(), memoryId: memory.id, loc: 'doomed', name: 'Doomed', tags: [] },
  });
  return { memoryId: memory.id, nodeId: node.id, loc: node.loc };
}

describe('#391 deleteNode soft-by-default / hard opt-in', () => {
  let fx: Fx;
  beforeEach(async () => {
    await cleanDb(db);
    fx = await build();
  });

  it('soft-deletes by default: row remains with deletedAt/deletedBy, hidden from reads', async () => {
    const ok = await deleteNode(null, { loc: fx.loc, memoryId: fx.memoryId }, adminCtx());
    expect(ok).toBe(true);

    const raw = await db.node.findUnique({ where: { id: fx.nodeId } });
    expect(raw).not.toBeNull();
    expect(raw!.deletedAt).not.toBeNull();
    expect(raw!.deletedBy).toBe(ADMIN);

    // Disappears from the read surfaces (post-#391 filters).
    expect(await Q.nodeById(null, { id: fx.nodeId }, adminCtx())).toBeNull();
    expect(await Q.node(null, { loc: fx.loc, memory: fx.memoryId }, adminCtx())).toBeNull();
  });

  it('hard: true removes the row entirely', async () => {
    const ok = await deleteNode(null, { loc: fx.loc, memoryId: fx.memoryId, hard: true }, adminCtx());
    expect(ok).toBe(true);
    expect(await db.node.findUnique({ where: { id: fx.nodeId } })).toBeNull();
  });

  it('a missing node surfaces NODE_NOT_FOUND, not a raw 500', async () => {
    await expect(
      deleteNode(null, { loc: 'does-not-exist', memoryId: fx.memoryId }, adminCtx()),
    ).rejects.toThrow(/not found/i);
  });
});
