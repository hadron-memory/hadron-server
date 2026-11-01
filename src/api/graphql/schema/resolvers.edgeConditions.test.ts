/**
 * Integration tests for the GraphQL edge-condition contract: createEdge
 * and updateEdge accept JSONLogic conditions, validate them, and return
 * named error codes for each failure mode. The Prisma client is mocked
 * (no DB needed) so these tests run anywhere.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolvers, type Context } from './resolvers.js';

// #322: createEdge resolves each endpoint through resolveNodeRef (accepts an
// ID-shape PK or a fully-qualified URN). These pure-mock tests use ID-shape
// refs so resolution takes the bare-PK lookup path.
const SRC_ID = 'a'.repeat(32);
const TGT_ID = 'b'.repeat(32);
// #542 Tier 2: updateEdge/deleteEdge resolve edgeRef via resolveEdgeRef, which
// takes an ID-shape ref — use a 32-hex id so the PK path (edge.findFirst) fires.
const EDGE_ID = 'e'.repeat(32);

// Build a minimal mock that mirrors the parts of PrismaClient the
// createEdge / updateEdge resolvers touch.
function mockDb() {
  const client = {
    // Spec 037: createEdge fetches both endpoints to compose/derive the edge
    // loc + denormalize memoryId. #322: resolveNodeRef first does a bare-ID PK
    // lookup (findFirst, `deletedAt: null` filter), then the resolver re-fetches
    // loc/memoryId (findUnique) — one impl returning a superset row serves both,
    // and echoes back the requested id so source/target stay distinct.
    node: {
      findUnique: vi.fn().mockImplementation(async ({ where }: { where: { id?: string } }) => ({
        id: where?.id ?? SRC_ID,
        deletedAt: null,
        loc: 'l',
        memoryId: 'mem-1',
      })),
      findFirst: vi.fn().mockImplementation(async ({ where }: { where: { id?: string } }) => ({
        id: where?.id ?? SRC_ID,
        deletedAt: null,
        loc: 'l',
        memoryId: 'mem-1',
      })),
      findMany: vi.fn().mockImplementation(async ({ where }: { where: { id?: { in?: string[] } } }) =>
        (where.id?.in ?? []).map((id) => ({ id, loc: 'l', memoryId: 'mem-1' }))),
    },
    // #322/PR-348: createEdge now gates on requireMemoryWriteAccess(src) +
    // canReadMemory(tgt). The ADMIN+appId ctx short-circuits the write check
    // before any DB call; canReadMemory still reads the memory row to learn
    // its class, so stub a non-personal memory (ADMIN bypass → read allowed).
    memory: {
      // #2734: this fixture represents ordinary knowledge memory, not an install.
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([{
        id: 'mem-1', class: 'knowledge', userId: null, userMemoryOfAgentId: null,
        appId: 'app-1', ownerUserId: null,
      }]),
      findUnique: vi.fn().mockResolvedValue({
        class: 'knowledge',
        userId: null,
        userMemoryOfAgentId: null,
        appId: 'app-1',
        // spec 047: an org-owned memory has ownerUserId NULL. Prisma returns
        // null (not undefined) for a null column; the canReadMemory user-owned
        // branch keys on `!== null`, so the mock must spell this out.
        ownerUserId: null,
      }),
    },
    // The edge authorization path also checks for Worker-held memory. These
    // condition-validation tests have no Worker casting or org manager.
    orgMember: { findMany: vi.fn().mockResolvedValue([]) },
    worker: { findMany: vi.fn().mockResolvedValue([]) },
    edge: {
      create: vi.fn().mockImplementation(async ({ data }: { data: unknown }) => ({
        id: EDGE_ID,
        ...(data as Record<string, unknown>),
        source: { id: SRC_ID, loc: 'l', memoryId: 'mem-1', ownerRepo: null },
      })),
      update: vi.fn().mockImplementation(async ({ where, data }: { where: { id: string }; data: unknown }) => ({
        id: where.id,
        ...(data as Record<string, unknown>),
        source: { id: SRC_ID, loc: 'l', memoryId: 'mem-1', ownerRepo: null },
      })),
      // #542 Tier 2: resolveEdgeRef's PK path does a findFirst (deletedAt: null +
      // memory-liveness). Echo the requested id so update/delete resolve it.
      findFirst: vi.fn().mockImplementation(async ({ where }: { where: { id?: string } }) => ({
        id: where?.id ?? EDGE_ID,
      })),
      // Codex #554: update/delete now re-read the edge's memoryId to gate on
      // requireMemoryWriteAccess (the ADMIN+appId ctx short-circuits the check).
      findUnique: vi.fn().mockResolvedValue({ memoryId: 'mem-1', source: { memoryId: 'mem-1' } }),
    },
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'mem-1' }]),
    $transaction: vi.fn(),
  };
  client.$transaction.mockImplementation(async (fn: (tx: typeof client) => unknown) => fn(client));
  return client;
}

function ctx(over: Partial<Context> = {}): Context {
  return {
    db: mockDb() as unknown as Context['db'],
    // ADMIN + appId so the PR-348 memory-write gate short-circuits without
    // needing a full org-membership fixture (these tests target condition
    // validation, not access control — that's covered in access-control.test.ts
    // and the real-DB createEdge tests).
    roles: ['ADMIN'],
    appId: 'app-1',
    userId: 'u1',
    // #1300 / PR #1307: the edge mutations now check the NODE-CONTENT read set
    // first (a non-reader gets not-found, so a refusal is no existence oracle).
    // These tests target condition validation, so pre-seed the per-request
    // read cache the check consults rather than mock the whole read-set query.
    memoryReadCache: new Map([['mem-1', Promise.resolve(true)]]),
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
        sourceRef: SRC_ID,
        targetRef: TGT_ID,
        name: 'force-profile',
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
        sourceRef: SRC_ID,
        targetRef: TGT_ID,
        name: 'urgent',
        condition: null,
        priority: 5,
      },
      testCtx,
    );
    const calls = (testCtx.db.edge.create as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].data.priority).toBe(5);
  });

  it('omits priority from the Prisma create when the arg is an explicit null (#263)', async () => {
    // Non-JS clients (the Go CLI) send explicit nulls for unset nullable
    // args. priority is a non-nullable Int @default(0) — forwarding null
    // makes Prisma reject the create with a misleading "Argument source
    // is missing" error.
    await mutations.createEdge(
      null,
      {
        sourceRef: SRC_ID,
        targetRef: TGT_ID,
        name: 'routes-to',
        condition: null,
        priority: null,
        data: null,
      },
      testCtx,
    );
    const calls = (testCtx.db.edge.create as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect('priority' in calls[0][0].data).toBe(false);
  });

  it('updateEdge nulls: priority omitted (unset), condition/data forwarded as clear (#263)', async () => {
    await mutations.updateEdge(
      null,
      { edgeRef: EDGE_ID, name: 'renamed', condition: null, priority: null, data: null },
      testCtx,
    );
    const calls = (testCtx.db.edge.update as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    // priority is a non-nullable Int — null means unset, keep stored.
    expect('priority' in calls[0][0].data).toBe(false);
    // condition/data keep the spec'd null-clears contract.
    expect(calls[0][0].data.condition).toBeNull();
    expect(calls[0][0].data.data).toBeNull();
    expect(calls[0][0].data.name).toBe('renamed');
  });

  it('rejects a disallowed operator with INVALID_EDGE_CONDITION / DISALLOWED_OPERATOR', async () => {
    await expect(
      mutations.createEdge(
        null,
        {
          sourceRef: SRC_ID,
          targetRef: TGT_ID,
          name: 'l',
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
          sourceRef: SRC_ID,
          targetRef: TGT_ID,
          name: 'l',
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
          sourceRef: SRC_ID,
          targetRef: TGT_ID,
          name: 'l',
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
        { sourceRef: SRC_ID, targetRef: TGT_ID, name: 'l', condition: huge },
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
        { sourceRef: SRC_ID, targetRef: TGT_ID, name: 'l', condition: nested },
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
        sourceRef: SRC_ID,
        targetRef: TGT_ID,
        name: 'unconditional',
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
      { edgeRef: EDGE_ID, condition },
      testCtx,
    );
    const calls = (testCtx.db.edge.update as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].data.condition).toEqual(condition);
  });

  it('clears condition when explicit null is supplied', async () => {
    await mutations.updateEdge(
      null,
      { edgeRef: EDGE_ID, condition: null },
      testCtx,
    );
    const calls = (testCtx.db.edge.update as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].data).toHaveProperty('condition', null);
  });

  it('does not touch condition when omitted', async () => {
    await mutations.updateEdge(
      null,
      { edgeRef: EDGE_ID, name: 'new-label' },
      testCtx,
    );
    const calls = (testCtx.db.edge.update as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].data).not.toHaveProperty('condition');
  });

  it('rejects an invalid condition with the same error contract as create', async () => {
    await expect(
      mutations.updateEdge(
        null,
        { edgeRef: EDGE_ID, condition: { map: [[1, 2, 3]] } },
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
