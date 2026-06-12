/**
 * Issue #263 — createEdge failed against a real Prisma client when the
 * caller sent explicit nulls for unset nullable args (the Go CLI does
 * this; JS callers send undefined, which is why the mocked-db tests
 * never caught it).
 *
 * Root cause: `priority` is a non-nullable `Int @default(0)`. Forwarding
 * `priority: null` to `edge.create` fails Prisma validation — and the
 * invalid field disqualifies the scalar-FK (unchecked) input variant, so
 * the error surfaces as a baffling "Argument `source` is missing".
 *
 * This test exercises the exact CLI argument shape end-to-end against
 * the real client + Postgres.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';

let nodeA: { id: string };
let nodeB: { id: string };

function adminCtx(): Context {
  return { db, roles: ['ADMIN'] };
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'EdgeNull', urn: 'edge-null-263' },
  });
  const memory = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: 'edge-null-263:kb',
      name: 'kb',
      class: 'knowledge',
    },
  });
  nodeA = await db.node.create({
    data: { id: generateId(), memoryId: memory.id, loc: 'a', name: 'A' },
  });
  nodeB = await db.node.create({
    data: { id: generateId(), memoryId: memory.id, loc: 'b', name: 'B' },
  });
});

describe('createEdge with explicit-null args (CLI shape, #263)', () => {
  it('creates the edge when condition/priority/data are explicit nulls', async () => {
    const edge = await resolvers.Mutation.createEdge(
      {},
      {
        sourceNodeId: nodeA.id,
        targetNodeId: nodeB.id,
        label: 'routes-to',
        condition: null,
        priority: null,
        data: null,
      },
      adminCtx(),
    );
    expect(edge.sourceId).toBe(nodeA.id);
    expect(edge.targetId).toBe(nodeB.id);
    // priority falls back to the schema default.
    const stored = await db.edge.findUniqueOrThrow({ where: { id: edge.id } });
    expect(stored.priority).toBe(0);
  });

  it('updateEdge nulls: priority kept (unset), condition/data cleared (spec contract)', async () => {
    const condition = { '>': [{ var: 'chat.message_count' }, 20] };
    const data = { kind: 'transition' };
    const edge = await resolvers.Mutation.createEdge(
      {},
      {
        sourceNodeId: nodeA.id,
        targetNodeId: nodeB.id,
        label: 'routes-to',
        priority: 7,
        condition,
        data,
      },
      adminCtx(),
    );
    await resolvers.Mutation.updateEdge(
      {},
      { edgeId: edge.id, label: 'renamed', condition: null, priority: null, data: null },
      adminCtx(),
    );
    const stored = await db.edge.findUniqueOrThrow({ where: { id: edge.id } });
    expect(stored.label).toBe('renamed');
    // priority: null = unset — the non-nullable Int keeps its stored value.
    expect(stored.priority).toBe(7);
    // condition/data: null = clear, per the edge-conditions contract
    // ("null condition = always fires"). Clients that mean "unset" must
    // omit the variable (hadron-cli genqlient fix tracked separately).
    expect(stored.condition).toBeNull();
    expect(stored.data).toBeNull();
  });
});
