/**
 * Spec 039 Phase 0 (D1–D4) — the createNode / updateNode split contract.
 *
 * What this file pins (the resolver-level selector/mode contract; the write
 * core's field semantics — abstract/tags partial updates, encryption, seq —
 * are pinned by node-abstract.test.ts, node-tags-preserve.test.ts, and
 * resolvers.seqAutoAssign.test.ts):
 *
 *   - createNode is create-only: a live (memoryId, loc) collision rejects
 *     with NodeLocConflictError (D1); `id` is a forced create-PK (D2).
 *   - updateNode identifies the target by `id` (PK or fully-qualified node
 *     URN) XOR (memoryId + loc); both, or neither, is BAD_USER_INPUT (D2).
 *   - updateNode never creates: a missing target is NODE_NOT_FOUND (D3).
 *   - updateNode preserves `name` when omitted (D4).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let orgId: string;
let memoryId: string;
let adminId: string;

// Fully-qualified node-URN prefix (org::memory) — the stored memory urn is
// single-colon; node URNs attach the loc with an explicit `::` (spec 027).
const MEMORY_URN = 'cun-org::cunmem';

function gqlCtx(): Context {
  return { db, roles: ['ADMIN'], userId: adminId, clientId: `user:${adminId}` };
}

async function createNode(input: Record<string, unknown>) {
  return resolvers.Mutation.createNode(
    {},
    { input: { memoryId, ...input } as never },
    gqlCtx(),
  );
}

async function updateNode(input: Record<string, unknown>) {
  return resolvers.Mutation.updateNode({}, { input: input as never }, gqlCtx());
}

async function expectCode(p: Promise<unknown>, code: string) {
  let caught: unknown;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(GraphQLError);
  expect((caught as GraphQLError).extensions?.code).toBe(code);
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'cun-org', urn: 'cun-org' },
  });
  orgId = org.id;
  const admin = await db.user.create({
    data: { githubId: 9971, githubUsername: 'cun-admin', roles: ['ADMIN'] },
  });
  adminId = admin.id;
  await db.orgMember.create({
    data: { organizationId: orgId, userId: adminId, role: 'ADMIN' },
  });
  const memory = await resolvers.Mutation.createMemory(
    {},
    { orgId, name: 'cunmem' },
    gqlCtx(),
  );
  memoryId = memory.id;
});

// ───── createNode (D1/D2) ──────────────────────────────────────────────────

describe('createNode — create-only semantics', () => {
  it('creates a fresh node', async () => {
    const node = await createNode({ loc: 'a', name: 'A', content: 'body' });
    expect(node.loc).toBe('a');
    expect(node.name).toBe('A');
  });

  it('rejects a live (memoryId, loc) collision with NodeLocConflictError', async () => {
    await createNode({ loc: 'a', name: 'A' });
    await expectCode(createNode({ loc: 'a', name: 'A2' }), 'NodeLocConflictError');
  });

  it('honors a forced create-PK id (D2: only ever a create-id)', async () => {
    const forced = generateId();
    const node = await createNode({ id: forced, loc: 'pk', name: 'PK' });
    expect(node.id).toBe(forced);
  });
});

// ───── updateNode selector contract (D2) ───────────────────────────────────

describe('updateNode — selector contract', () => {
  it('updates by PK id', async () => {
    const created = await createNode({ loc: 'u1', name: 'U1', content: 'v1' });
    const updated = await updateNode({ id: created.id, content: 'v2' });
    expect(updated.id).toBe(created.id);
    expect(updated.content).toBe('v2');
  });

  it('updates by fully-qualified node URN', async () => {
    await createNode({ loc: 'u2', name: 'U2', content: 'v1' });
    const updated = await updateNode({
      id: `${MEMORY_URN}::u2`,
      content: 'v2',
    });
    expect(updated.content).toBe('v2');
    expect(updated.loc).toBe('u2');
  });

  it('updates by (memoryId, loc)', async () => {
    await createNode({ loc: 'u3', name: 'U3', content: 'v1' });
    const updated = await updateNode({ memoryId, loc: 'u3', content: 'v2' });
    expect(updated.content).toBe('v2');
  });

  it('rejects id + (memoryId, loc) together with BAD_USER_INPUT', async () => {
    const created = await createNode({ loc: 'u4', name: 'U4' });
    await expectCode(
      updateNode({ id: created.id, memoryId, loc: 'u4', content: 'x' }),
      'BAD_USER_INPUT',
    );
  });

  it('rejects a selector-less input with BAD_USER_INPUT', async () => {
    await expectCode(updateNode({ content: 'x' }), 'BAD_USER_INPUT');
  });

  it('rejects loc without memoryId with BAD_USER_INPUT', async () => {
    await expectCode(updateNode({ loc: 'u5', content: 'x' }), 'BAD_USER_INPUT');
  });
});

// ───── updateNode never creates (D3) ───────────────────────────────────────

describe('updateNode — never creates', () => {
  it('missing PK target → NODE_NOT_FOUND', async () => {
    await expectCode(
      updateNode({ id: generateId(), content: 'x' }),
      'NODE_NOT_FOUND',
    );
  });

  it('missing URN target → NODE_NOT_FOUND', async () => {
    await expectCode(
      updateNode({ id: `${MEMORY_URN}::nope`, content: 'x' }),
      'NODE_NOT_FOUND',
    );
  });

  it('missing (memoryId, loc) target → NODE_NOT_FOUND, and no row appears', async () => {
    await expectCode(
      updateNode({ memoryId, loc: 'ghost', content: 'x' }),
      'NODE_NOT_FOUND',
    );
    const row = await db.node.findFirst({ where: { memoryId, loc: 'ghost' } });
    expect(row).toBeNull();
  });
});

// ───── name preserve-on-omit (D4) ──────────────────────────────────────────

describe('updateNode — name preserve-on-omit (D4)', () => {
  it('omitting name preserves the existing one', async () => {
    const created = await createNode({ loc: 'n1', name: 'Original', content: 'v1' });
    const updated = await updateNode({ id: created.id, content: 'v2' });
    expect(updated.name).toBe('Original');
  });

  it('supplying name replaces it', async () => {
    const created = await createNode({ loc: 'n2', name: 'Original' });
    const updated = await updateNode({ id: created.id, name: 'Renamed' });
    expect(updated.name).toBe('Renamed');
  });
});
