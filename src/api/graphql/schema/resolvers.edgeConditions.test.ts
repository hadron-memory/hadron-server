/**
 * Integration tests for the GraphQL edge-condition contract: createEdge
 * and updateEdge accept JSONLogic conditions, validate them, and return
 * named error codes for each failure mode. The Prisma client is mocked
 * (no DB needed) so these tests run anywhere.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolvers, type Context } from './resolvers.js';

// Build a minimal mock that mirrors the parts of PrismaClient the
// createEdge / updateEdge resolvers touch.
function mockDb() {
  return {
    edge: {
      create: vi.fn().mockImplementation(async ({ data }: { data: unknown }) => ({
        id: 'edge-1',
        ...(data as Record<string, unknown>),
      })),
      update: vi.fn().mockImplementation(async ({ where, data }: { where: { id: string }; data: unknown }) => ({
        id: where.id,
        ...(data as Record<string, unknown>),
      })),
    },
  };
}

function ctx(over: Partial<Context> = {}): Context {
  return {
    db: mockDb() as unknown as Context['db'],
    roles: ['CONTRIBUTOR'],
    ...over,
  };
}

const mutations = resolvers.Mutation as Record<string, (...args: unknown[]) => Promise<unknown>>;

describe('GraphQL Mutation.createEdge — condition validation', () => {
  let testCtx: Context;
  beforeEach(() => {
    testCtx = ctx();
  });

  it('persists a valid JSONLogic condition (no validation error)', async () => {
    const condition = {
      and: [
        { missing: ['memory.business_type'] },
        { '>': [{ var: 'chat.message_count' }, 20] },
      ],
    };
    await mutations.createEdge(
      null,
      {
        sourceNodeId: 'node-source',
        targetNodeId: 'node-target',
        label: 'force-profile',
        condition,
      },
      testCtx,
    );
    const calls = (testCtx.db.edge.create as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0].data.condition).toEqual(condition);
  });

  it('persists priority when supplied', async () => {
    await mutations.createEdge(
      null,
      {
        sourceNodeId: 'node-source',
        targetNodeId: 'node-target',
        label: 'urgent',
        condition: null,
        priority: 5,
      },
      testCtx,
    );
    const calls = (testCtx.db.edge.create as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].data.priority).toBe(5);
  });

  it('rejects a disallowed operator with INVALID_EDGE_CONDITION / DISALLOWED_OPERATOR', async () => {
    await expect(
      mutations.createEdge(
        null,
        {
          sourceNodeId: 'a',
          targetNodeId: 'b',
          label: 'l',
          condition: { cat: ['x', 'y'] },
        },
        testCtx,
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("operator 'cat'"),
      extensions: {
        code: 'INVALID_EDGE_CONDITION',
        reason: 'DISALLOWED_OPERATOR',
        detail: { operator: 'cat' },
      },
    });
  });

  it('rejects an unknown scope with UNKNOWN_SCOPE', async () => {
    await expect(
      mutations.createEdge(
        null,
        {
          sourceNodeId: 'a',
          targetNodeId: 'b',
          label: 'l',
          condition: { var: 'session.foo' },
        },
        testCtx,
      ),
    ).rejects.toMatchObject({
      extensions: {
        code: 'INVALID_EDGE_CONDITION',
        reason: 'UNKNOWN_SCOPE',
        detail: { field: 'session.foo' },
      },
    });
  });

  it('rejects a reserved name with RESERVED_NAME', async () => {
    await expect(
      mutations.createEdge(
        null,
        {
          sourceNodeId: 'a',
          targetNodeId: 'b',
          label: 'l',
          condition: { var: 'message.data.exception' },
        },
        testCtx,
      ),
    ).rejects.toMatchObject({
      extensions: {
        code: 'INVALID_EDGE_CONDITION',
        reason: 'RESERVED_NAME',
        detail: { field: 'message.data.exception' },
      },
    });
  });

  it('rejects an oversized condition with AST_TOO_LARGE', async () => {
    const huge = { '==': [{ var: 'memory.x' }, 'a'.repeat(9000)] };
    await expect(
      mutations.createEdge(
        null,
        { sourceNodeId: 'a', targetNodeId: 'b', label: 'l', condition: huge },
        testCtx,
      ),
    ).rejects.toMatchObject({
      extensions: {
        code: 'INVALID_EDGE_CONDITION',
        reason: 'AST_TOO_LARGE',
      },
    });
  });

  it('rejects a too-deeply-nested condition with AST_TOO_DEEP', async () => {
    let nested: unknown = { var: 'memory.x' };
    for (let i = 0; i < 12; i++) nested = { '!': nested };
    await expect(
      mutations.createEdge(
        null,
        { sourceNodeId: 'a', targetNodeId: 'b', label: 'l', condition: nested },
        testCtx,
      ),
    ).rejects.toMatchObject({
      extensions: {
        code: 'INVALID_EDGE_CONDITION',
        reason: 'AST_TOO_DEEP',
      },
    });
  });

  it('accepts null condition (always-fires edge)', async () => {
    await mutations.createEdge(
      null,
      {
        sourceNodeId: 'a',
        targetNodeId: 'b',
        label: 'unconditional',
        condition: null,
      },
      testCtx,
    );
    const calls = (testCtx.db.edge.create as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].data.condition).toBeNull();
  });
});

describe('GraphQL Mutation.updateEdge — condition validation', () => {
  let testCtx: Context;
  beforeEach(() => {
    testCtx = ctx();
  });

  it('updates condition when supplied', async () => {
    const condition = { '==': [{ var: 'memory.stage' }, 'growth'] };
    await mutations.updateEdge(
      null,
      { edgeId: 'edge-1', condition },
      testCtx,
    );
    const calls = (testCtx.db.edge.update as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].data.condition).toEqual(condition);
  });

  it('clears condition when explicit null is supplied', async () => {
    await mutations.updateEdge(
      null,
      { edgeId: 'edge-1', condition: null },
      testCtx,
    );
    const calls = (testCtx.db.edge.update as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].data).toHaveProperty('condition', null);
  });

  it('does not touch condition when omitted', async () => {
    await mutations.updateEdge(
      null,
      { edgeId: 'edge-1', label: 'new-label' },
      testCtx,
    );
    const calls = (testCtx.db.edge.update as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].data).not.toHaveProperty('condition');
  });

  it('rejects an invalid condition with the same error contract as create', async () => {
    await expect(
      mutations.updateEdge(
        null,
        { edgeId: 'edge-1', condition: { map: [[1, 2, 3]] } },
        testCtx,
      ),
    ).rejects.toMatchObject({
      extensions: {
        code: 'INVALID_EDGE_CONDITION',
        reason: 'DISALLOWED_OPERATOR',
        detail: { operator: 'map' },
      },
    });
  });
});
