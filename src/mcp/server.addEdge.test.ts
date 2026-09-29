/**
 * Issue #183 review feedback — direct tests for `addEdge` (the helper
 * backing the hadron_create_edge MCP tool).
 *
 * Pins the contract that the tool surface emits and the auth-gated
 * flow nobody else exercises: source qualification, source-missing
 * messaging, target dispatch through the spec-007 resolver, idempotent
 * upsert, non-destructive coexistence with other outgoing edges, and
 * canonical-`::`-URN target dispatch (the issue-#183 read/write
 * symmetry, here verified end-to-end against the helper rather than
 * just `resolveEdgeRefs`).
 *
 * The cross-memory `canReadMemory` denial path is NOT exercised here
 * because building a multi-Org/App/AgentSubscription fixture that
 * resolves to `false` for one memory but `true` for another is heavy
 * boilerplate. The gate itself is a one-liner that delegates to
 * `canReadMemory`, which has its own coverage in `access-control.test.ts`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { addEdge } from './server.js';
import { deriveEdgeLoc } from '../lib/edgeLoc.js';
import type { AuthContext } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';
import { lockMemoryForChannelChange } from '../lib/channels.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let admin: { id: string };
let memory: { id: string; urn: string };
let source: { id: string; loc: string };
let topLevel: { id: string; loc: string };
let nested: { id: string; loc: string };

function gqlCtx(): Context {
  return { db, roles: ['ADMIN'], userId: admin.id };
}

function adminAuth(): AuthContext {
  // ADMIN role bypasses the per-memory access map in canRead/canWrite,
  // so any memory in the fixture is reachable by this caller.
  return { userId: admin.id, roles: ['ADMIN'], clientId: `user:${admin.id}` };
}

async function waitForChannelMemoryLockWaiter(memoryId: string, timeoutMs = 10_000): Promise<void> {
  const key = `channel-host:${memoryId}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [{ count }] = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND NOT granted
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND classid = (((hashtext(${key})::bigint >> 32) & 4294967295))::oid
        AND objid = ((hashtext(${key})::bigint & 4294967295))::oid
        AND objsubid = 1
    `;
    if (Number(count) > 0) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for Channel memory-lock waiter on ${memoryId}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'addedge-org', urn: 'addedge-org' },
  });
  admin = await db.user.create({
    data: { githubId: 9501, githubUsername: 'addedge-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  memory = await resolvers.Mutation.createMemory(
    {},
    { orgId: org.id, name: 'addedge-mem' },
    gqlCtx(),
  );
  source = await db.node.create({
    data: { id: generateId(), memoryId: memory.id, loc: 'review:db-type-agnostic', name: 'db-type-agnostic' },
  });
  topLevel = await db.node.create({
    data: { id: generateId(), memoryId: memory.id, loc: 'models', name: 'models' },
  });
  nested = await db.node.create({
    data: { id: generateId(), memoryId: memory.id, loc: 'services:db-model-helper', name: 'db-model-helper' },
  });
});

describe('addEdge — happy path', () => {
  it('persists a single edge from source to target with the given name', async () => {
    const result = await addEdge({
      sourceUrn: `urn:node:${memory.urn}:${source.loc}`,
      targetUrn: `urn:node:${memory.urn}:${topLevel.loc}`,
      name: 'use this pattern',
      auth: adminAuth(),
    });

    expect(result).not.toHaveProperty('error');
    expect(await db.edge.count({
      where: { sourceId: source.id, targetId: topLevel.id, name: 'use this pattern' },
    })).toBe(1);
  });

  it('returns canonical-form URNs in the success payload regardless of input form', async () => {
    // Input uses legacy `:` hierarchy; success message should always
    // surface canonical `::` URNs so callers can copy/paste them back.
    const result = await addEdge({
      sourceUrn: `urn:node:${memory.urn}:${source.loc}`,
      targetUrn: `urn:node:${memory.urn}:${topLevel.loc}`,
      name: 'rel',
      auth: adminAuth(),
    });

    if ('error' in result) throw new Error(result.error);
    expect(result.sourceUrn).toMatch(/^hrn:node:addedge-org:addedge-mem:review:db-type-agnostic$/);
    expect(result.targetUrn).toMatch(/^hrn:node:addedge-org:addedge-mem:models$/);
  });

  it('rechecks endpoint liveness after waiting on the Channel reuse lock (#1226)', async () => {
    let release!: () => void;
    let held!: () => void;
    const mayRelease = new Promise<void>((resolve) => { release = resolve; });
    const lockHeld = new Promise<void>((resolve) => { held = resolve; });
    const holder = db.$transaction(async (tx) => {
      await lockMemoryForChannelChange(tx, memory.id);
      held();
      await mayRelease;
    }, { timeout: 20_000 });

    await lockHeld;
    const adding = addEdge({
      sourceUrn: source.id,
      targetUrn: topLevel.id,
      name: 'stale-target',
      auth: adminAuth(),
    });
    try {
      await waitForChannelMemoryLockWaiter(memory.id);
      await db.node.update({
        where: { id: topLevel.id },
        data: { deletedAt: new Date(), deletedBy: admin.id },
      });
      release();
      await holder;
      await expect(adding).resolves.toEqual({
        error: `Edge target not found: "${topLevel.id}"`,
      });
      expect(await db.edge.count({ where: { targetId: topLevel.id, deletedAt: null } })).toBe(0);
    } finally {
      release();
      await holder.catch(() => undefined);
    }
  }, 20_000);
});

describe('addEdge — non-destructive + idempotent', () => {
  it('refuses an occupied edge loc when it belongs to another source (#1469)', async () => {
    const loc = deriveEdgeLoc(source.loc, 'cites', topLevel.loc);
    const original = await db.edge.create({
      data: {
        id: generateId(), memoryId: memory.id, sourceId: nested.id,
        targetId: topLevel.id, loc, name: 'cites',
      },
    });

    const result = await addEdge({
      sourceUrn: source.id, targetUrn: topLevel.id, name: 'cites', auth: adminAuth(),
    });

    expect(result).toEqual({ error: expect.stringMatching(/^\[edge_loc_conflict\]/) });
    expect(await db.edge.count({ where: { sourceId: source.id, targetId: topLevel.id } })).toBe(0);
    expect(await db.edge.findUnique({ where: { id: original.id } })).toMatchObject({
      sourceId: nested.id, targetId: topLevel.id, loc,
    });
  });

  it('is idempotent: re-running with the same (source, target, name) does not duplicate', async () => {
    const args = {
      sourceUrn: `urn:node:${memory.urn}:${source.loc}`,
      targetUrn: `urn:node:${memory.urn}:${topLevel.loc}`,
      name: 'cites',
      auth: adminAuth(),
    };

    await addEdge(args);
    await addEdge(args);
    await addEdge(args);

    expect(await db.edge.count({
      where: { sourceId: source.id, targetId: topLevel.id, name: 'cites' },
    })).toBe(1);
  });

  it('does not call changed edge metadata at the same loc an idempotent save', async () => {
    const loc = 'authored:edge';
    const auth = adminAuth();
    const first = await addEdge({
      sourceUrn: source.id, targetUrn: topLevel.id, loc,
      name: 'cites', description: 'original', auth,
    });
    expect(first).not.toHaveProperty('error');

    const replay = await addEdge({
      sourceUrn: source.id, targetUrn: topLevel.id, loc,
      name: 'cites', description: 'original', auth,
    });
    expect(replay).not.toHaveProperty('error');
    const changed = await addEdge({
      sourceUrn: source.id, targetUrn: topLevel.id, loc,
      name: 'cites', description: 'changed', auth,
    });
    expect(changed).toEqual({ error: expect.stringMatching(/^\[edge_loc_conflict\]/) });
    expect(await db.edge.findUnique({ where: { loc_memoryId: { loc, memoryId: memory.id } } }))
      .toMatchObject({ sourceId: source.id, targetId: topLevel.id, description: 'original' });
  });

  it('does not treat a soft-deleted edge at the same loc as saved', async () => {
    const loc = deriveEdgeLoc(source.loc, 'cites', topLevel.loc);
    await db.edge.create({
      data: { id: generateId(), memoryId: memory.id, sourceId: source.id,
        targetId: topLevel.id, loc, name: 'cites', deletedAt: new Date() },
    });
    const result = await addEdge({
      sourceUrn: source.id, targetUrn: topLevel.id, name: 'cites', auth: adminAuth(),
    });
    expect(result).toEqual({ error: expect.stringMatching(/^\[edge_loc_conflict\]/) });
    expect(await db.edge.count({ where: { sourceId: source.id, deletedAt: null } })).toBe(0);
  });

  it('leaves pre-existing edges on the same source intact (unlike hadron_update_node)', async () => {
    // Seed an unrelated outgoing edge directly via DB (not via the
    // tool, so we're sure the new tool can't influence its existence).
    await db.edge.create({
      data: {
        id: generateId(),
        memoryId: memory.id,
        sourceId: source.id,
        targetId: nested.id,
        loc: deriveEdgeLoc(source.loc, 'preexisting', nested.loc),
        name: 'preexisting',
      },
    });

    await addEdge({
      sourceUrn: `urn:node:${memory.urn}:${source.loc}`,
      targetUrn: `urn:node:${memory.urn}:${topLevel.loc}`,
      name: 'newly-added',
      auth: adminAuth(),
    });

    const edges = await db.edge.findMany({
      where: { sourceId: source.id },
      orderBy: { name: 'asc' },
    });
    expect(edges).toHaveLength(2);
    expect(edges.map(e => e.name)).toEqual(['newly-added', 'preexisting']);
  });

  it('supports multiple names between the same (source, target) pair', async () => {
    // Edge identity is the per-memory `loc`, which deriveEdgeLoc folds
    // the name into — same pair with different names yields distinct
    // locs, a legitimate use case (e.g. `depends-on` AND `documents`).
    await addEdge({
      sourceUrn: `urn:node:${memory.urn}:${source.loc}`,
      targetUrn: `urn:node:${memory.urn}:${topLevel.loc}`,
      name: 'depends-on',
      auth: adminAuth(),
    });
    await addEdge({
      sourceUrn: `urn:node:${memory.urn}:${source.loc}`,
      targetUrn: `urn:node:${memory.urn}:${topLevel.loc}`,
      name: 'documents',
      auth: adminAuth(),
    });

    expect(await db.edge.count({
      where: { sourceId: source.id, targetId: topLevel.id },
    })).toBe(2);
  });
});

describe('addEdge — URN-form dispatch', () => {
  it('accepts a canonical `::` target URN (issue #183 read/write symmetry)', async () => {
    // Same shape `hadron_get_node` emits. The pre-fix tool would have
    // returned `Edge target not found` for this exact input.
    const canonicalTarget = `urn:node:${memory.urn.replace(':', '::')}::${topLevel.loc}`;

    const result = await addEdge({
      sourceUrn: `urn:node:${memory.urn}:${source.loc}`,
      targetUrn: canonicalTarget,
      name: 'cites',
      auth: adminAuth(),
    });

    expect(result).not.toHaveProperty('error');
    expect(await db.edge.count({
      where: { sourceId: source.id, targetId: topLevel.id },
    })).toBe(1);
  });

  it('accepts a bare-ID target (spec-007 dispatch passes through resolveNodeRef)', async () => {
    const result = await addEdge({
      sourceUrn: `urn:node:${memory.urn}:${source.loc}`,
      targetUrn: topLevel.id,
      name: 'cites',
      auth: adminAuth(),
    });

    expect(result).not.toHaveProperty('error');
    expect(await db.edge.count({
      where: { sourceId: source.id, targetId: topLevel.id },
    })).toBe(1);
  });
});

describe('addEdge — canonical-stored Memory.urn (migration window)', () => {
  it('resolves the source memory whether Memory.urn is legacy or canonical', async () => {
    // Build an isolated org+memory whose Memory.urn is stored in
    // canonical `::` form. The source memory dispatch goes through
    // resolveMemoryByUrn — which this PR teaches to OR-match both
    // storage shapes. Without that fix, splitNodeUrn returns the
    // memoryUrn in legacy `:` form, the equality lookup misses the
    // canonical-stored row, and the call short-circuits with
    // "Source memory not found".
    const canonicalOrg = await db.organization.create({
      data: { id: generateId(), name: 'addedge-canon-org', urn: 'addedge-canon-org' },
    });
    await db.orgMember.create({
      data: { organizationId: canonicalOrg.id, userId: admin.id, role: 'ADMIN' },
    });
    const canonicalMem = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: canonicalOrg.id,
        urn: 'addedge-canon-org::canon-mem',
        name: 'addedge-canon-mem',
        class: 'knowledge',
      },
    });
    const canonSource = await db.node.create({
      data: { id: generateId(), memoryId: canonicalMem.id, loc: 'src', name: 'src' },
    });
    const canonTarget = await db.node.create({
      data: { id: generateId(), memoryId: canonicalMem.id, loc: 'tgt', name: 'tgt' },
    });

    const result = await addEdge({
      sourceUrn: `urn:node:addedge-canon-org::canon-mem::src`,
      targetUrn: `urn:node:addedge-canon-org::canon-mem::tgt`,
      name: 'rel',
      auth: adminAuth(),
    });

    expect(result).not.toHaveProperty('error');
    expect(await db.edge.count({
      where: { sourceId: canonSource.id, targetId: canonTarget.id },
    })).toBe(1);
  });
});

describe('addEdge — source by PK (#322)', () => {
  it('accepts a bare-ID (PK) source and persists the edge', async () => {
    // #322: the source may now be an ID-shape PK. PKs are immutable, so an
    // edge created against one survives a later move/rename of the source —
    // the failure mode reported in #322 (a changed URN broke a new edge).
    const result = await addEdge({
      sourceUrn: source.id,
      targetUrn: `urn:node:${memory.urn}:${topLevel.loc}`,
      name: 'cites',
      auth: adminAuth(),
    });

    expect(result).not.toHaveProperty('error');
    expect(await db.edge.count({
      where: { sourceId: source.id, targetId: topLevel.id, name: 'cites' },
    })).toBe(1);
  });

  it('PK source still resolves after the node loc/URN has changed', async () => {
    // The crux of #322: move the source (its loc — hence URN — changes),
    // then reference it by PK. A URN caller holding the old URN would fail;
    // the PK is stable.
    await db.node.update({ where: { id: source.id }, data: { loc: 'review:renamed-after-move' } });

    const result = await addEdge({
      sourceUrn: source.id, // unchanged across the move
      targetUrn: topLevel.id,
      name: 'reply',
      auth: adminAuth(),
    });

    expect(result).not.toHaveProperty('error');
    if ('error' in result) throw new Error(result.error);
    // Success URN reflects the NEW loc, proving the PK resolved to the moved node.
    expect(result.sourceUrn).toMatch(/review:renamed-after-move$/);
    expect(await db.edge.count({
      where: { sourceId: source.id, targetId: topLevel.id, name: 'reply' },
    })).toBe(1);
  });

  it('returns a clear error for a non-existent PK source', async () => {
    const result = await addEdge({
      sourceUrn: generateId(), // ID-shape but no such node
      targetUrn: `urn:node:${memory.urn}:${topLevel.loc}`,
      name: 'cites',
      auth: adminAuth(),
    });

    expect(result).toEqual({ error: expect.stringMatching(/^Source node not found:/) });
    expect(await db.edge.count({ where: { targetId: topLevel.id } })).toBe(0);
  });
});

describe('addEdge — input validation', () => {
  it('rejects a non-fully-qualified source URN', async () => {
    const result = await addEdge({
      sourceUrn: source.loc, // bare loc — missing org+memory
      targetUrn: `urn:node:${memory.urn}:${topLevel.loc}`,
      name: 'cites',
      auth: adminAuth(),
    });

    expect(result).toHaveProperty('error');
    if ('error' in result) {
      expect(result.error).toMatch(/^Source:/);
    }
  });
});

describe('addEdge — not-found errors', () => {
  it('returns a clear error when the source node does not exist', async () => {
    const result = await addEdge({
      sourceUrn: `urn:node:${memory.urn}:does-not-exist`,
      targetUrn: `urn:node:${memory.urn}:${topLevel.loc}`,
      name: 'cites',
      auth: adminAuth(),
    });

    expect(result).toEqual({ error: expect.stringMatching(/^Source node not found:/) });
    expect(await db.edge.count({ where: { sourceId: source.id } })).toBe(0);
  });

  it('returns the "Edge target not found" wording when the target does not exist', async () => {
    const result = await addEdge({
      sourceUrn: `urn:node:${memory.urn}:${source.loc}`,
      targetUrn: `urn:node:${memory.urn}:does-not-exist`,
      name: 'cites',
      auth: adminAuth(),
    });

    expect(result).toEqual({ error: expect.stringMatching(/^Edge target not found:/) });
    expect(await db.edge.count({ where: { sourceId: source.id } })).toBe(0);
  });
});
