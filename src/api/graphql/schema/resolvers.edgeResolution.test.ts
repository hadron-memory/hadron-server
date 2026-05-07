/**
 * Issue #105 regression: `upsertNode` must accept any reference shape
 * for `edges[].targetId` (ID, prefixed URN, full memory-prefixed loc,
 * short loc) and persist a real edge — and surface a typed error,
 * not silently swallow the call into `pending_edges`, when the ref
 * does not name a live node.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let org: { id: string; urn: string };
let admin: { id: string };
let memory: { id: string; urn: string };
let target: { id: string; loc: string };

function ctx(): Context {
  return { db, roles: ['ADMIN'], userId: admin.id };
}

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({
    data: { id: generateId(), name: 'er-org', urn: 'er-org' },
  });
  admin = await db.user.create({
    data: { githubId: 9201, githubUsername: 'er-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  memory = await resolvers.Mutation.createMemory(
    {},
    { orgId: org.id, name: 'er-mem' },
    ctx(),
  );
  // Seed the edge target. Use the `node` table directly so we don't
  // recursively exercise the resolver under test.
  target = await db.node.create({
    data: {
      id: generateId(),
      memoryId: memory.id,
      loc: 'services:db-model-helper',
      name: 'db-model-helper',
    },
  });
});

async function upsertSourceWithTarget(targetRef: string) {
  return resolvers.Mutation.upsertNode(
    {},
    {
      input: {
        loc: 'review:db-type-agnostic',
        name: 'db-type-agnostic',
        memoryId: memory.id,
        edges: [{ targetId: targetRef, label: 'use this pattern' }],
      },
    },
    ctx(),
  );
}

async function edgeCount(sourceId: string) {
  return db.edge.count({ where: { sourceId } });
}

async function pendingEdgeCount(sourceId: string) {
  return db.pendingEdge.count({ where: { sourceId } });
}

describe('upsertNode — edge target resolution (issue #105)', () => {
  it('persists a real edge when targetId is the bare node ID', async () => {
    const node = await upsertSourceWithTarget(target.id);
    expect(await edgeCount(node.id)).toBe(1);
    expect(await pendingEdgeCount(node.id)).toBe(0);
  });

  it('persists a real edge when targetId is a `urn:node:<memory-urn>:<loc>`', async () => {
    const node = await upsertSourceWithTarget(`urn:node:${memory.urn}:${target.loc}`);
    expect(await edgeCount(node.id)).toBe(1);
    expect(await pendingEdgeCount(node.id)).toBe(0);
  });

  it('persists a real edge when targetId is a bare `<memory-urn>:<loc>`', async () => {
    const node = await upsertSourceWithTarget(`${memory.urn}:${target.loc}`);
    expect(await edgeCount(node.id)).toBe(1);
    expect(await pendingEdgeCount(node.id)).toBe(0);
  });

  it('persists a real edge when targetId is a short loc (resolved within source memory)', async () => {
    const node = await upsertSourceWithTarget(target.loc);
    expect(await edgeCount(node.id)).toBe(1);
    expect(await pendingEdgeCount(node.id)).toBe(0);
  });

  it('throws NodeNotFoundError for an unresolvable short loc — no silent pending_edge fallback', async () => {
    await expect(upsertSourceWithTarget('services:does-not-exist')).rejects.toMatchObject({
      extensions: { code: 'NodeNotFoundError' },
    });
    // The mutation must not have written either a real edge or a
    // pending_edge — `cleanDb` has wiped both tables in the beforeEach,
    // and the failing call must not have repopulated them.
    expect(await db.pendingEdge.count()).toBe(0);
    expect(await db.edge.count()).toBe(0);
  });

  it('throws NodeNotFoundError for an unresolvable full URN', async () => {
    await expect(
      upsertSourceWithTarget(`urn:node:${memory.urn}:services:does-not-exist`),
    ).rejects.toMatchObject({
      extensions: { code: 'NodeNotFoundError' },
    });
  });

  it('does not create the source node when an edge target fails to resolve', async () => {
    // Partial-apply concern raised on PR #106: edge resolution must
    // happen before the source upsert so that a bad target rolls back
    // cleanly. The source node should not exist after the failed call.
    await expect(upsertSourceWithTarget('services:does-not-exist')).rejects.toMatchObject({
      extensions: { code: 'NodeNotFoundError' },
    });
    const source = await db.node.findUnique({
      where: { loc_memoryId: { loc: 'review:db-type-agnostic', memoryId: memory.id } },
    });
    expect(source).toBeNull();
  });

  it('persists multiple edges in one createMany roundtrip', async () => {
    const second = await db.node.create({
      data: {
        id: generateId(),
        memoryId: memory.id,
        loc: 'services:other-helper',
        name: 'other-helper',
      },
    });
    const node = await resolvers.Mutation.upsertNode(
      {},
      {
        input: {
          loc: 'review:db-type-agnostic',
          name: 'db-type-agnostic',
          memoryId: memory.id,
          edges: [
            { targetId: target.id, label: 'a' },
            { targetId: second.id, label: 'b' },
          ],
        },
      },
      ctx(),
    );
    expect(await edgeCount(node.id)).toBe(2);
  });
});
