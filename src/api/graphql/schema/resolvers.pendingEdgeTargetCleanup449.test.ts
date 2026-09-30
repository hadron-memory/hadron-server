/**
 * #449 — a hard delete removes the PendingEdges aimed at the nodes it erases.
 *
 * `PendingEdge.targetId` is not a foreign key, so the row cascade never
 * reaches a row aimed at an erased node. A node-keyed row names its target in
 * one of two forms: the raw node id (git sync parks an unresolved frontmatter
 * id) or the stable `@node-id:` key (clone, promotion retries). Every
 * node-level hard delete removes both, and reconciles the affected source
 * memories' `pendingEdgeCount`. A loc-keyed row waits for an ADDRESS, not for
 * the erased node, so it survives.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import type { AuthContext } from '../../../middleware/auth.js';
import { generateId } from '../../../lib/id.js';
import { pendingEdgeStableTargetKey, reconcilePendingEdgeCount } from '../../../lib/pendingEdgePromotion.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let org: { id: string; urn: string };
let admin: { id: string };
let mem: { id: string; urn: string };
/** The memory the pending rows' SOURCE lives in: its count must be reconciled. */
let sourceMem: { id: string; urn: string };

const ctx = (): Context => ({ db, roles: ['ADMIN'], userId: admin.id }) as Context;
const auth = (): AuthContext => ({ userId: admin.id, roles: ['ADMIN'], clientId: `user:${admin.id}` });

async function memory(name: string) {
  return db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:${name}`, name, class: 'knowledge' },
    select: { id: true, urn: true },
  });
}
const node = (memoryId: string, loc: string) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc } });

/** Three pending rows from `source`: raw id, stable key, and loc-keyed at `target.loc`. */
async function pendingAimedAt(target: { id: string; loc: string }) {
  const source = await node(sourceMem.id, `src-${generateId().slice(0, 8)}`);
  const rows = {
    raw: target.id,
    stable: pendingEdgeStableTargetKey(target.id),
    loc: target.loc,
  };
  for (const targetId of Object.values(rows)) {
    await db.pendingEdge.create({ data: { id: generateId(), sourceId: source.id, targetId, name: 'cites' } });
  }
  await reconcilePendingEdgeCount(db, sourceMem.id);
  return rows;
}

const remainingTargets = async () =>
  (await db.pendingEdge.findMany({ select: { targetId: true } })).map((p) => p.targetId).sort();
const sourceCount = async () =>
  (await db.memory.findUniqueOrThrow({ where: { id: sourceMem.id } })).pendingEdgeCount;

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'pe-org', urn: 'pe-org' } });
  admin = await db.user.create({ data: { githubId: 14490, githubUsername: 'pe-admin', handle: 'pe-admin', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  mem = await memory('target-mem');
  sourceMem = await memory('source-mem');
});

describe('#449 — node-level hard deletes remove PendingEdges aimed at the erased nodes', () => {
  it('GraphQL deleteNode(hard): both node-keyed forms go, the loc-keyed row stays, and the count follows', async () => {
    const target = await node(mem.id, 'pas:010');
    const rows = await pendingAimedAt(target);
    expect(await sourceCount()).toBe(3);

    await resolvers.Mutation.deleteNode({}, { nodeRef: target.id, hard: true }, ctx());
    expect(await remainingTargets()).toEqual([rows.loc]);
    expect(await sourceCount()).toBe(1);
  });

  it('GraphQL deleteNode(hard, recursive) covers every erased descendant', async () => {
    await node(mem.id, 'pas');
    const child = await node(mem.id, 'pas:020');
    const rows = await pendingAimedAt(child);
    const parent = await db.node.findFirstOrThrow({ where: { memoryId: mem.id, loc: 'pas' } });

    await resolvers.Mutation.deleteNode({}, { nodeRef: parent.id, hard: true, recursive: true }, ctx());
    expect(await remainingTargets()).toEqual([rows.loc]);
  });

  it('MCP hadron_delete_node(hard) removes both forms too', async () => {
    const target = await node(mem.id, 'pas:030');
    const rows = await pendingAimedAt(target);

    const text = await createTestableMcpServer(auth()).callToolText('hadron_delete_node', {
      urn: `hrn:node:${mem.urn}:pas:030`, hard: true,
    });
    expect(text).not.toMatch(/refused|not found/i);
    expect(await remainingTargets()).toEqual([rows.loc]);
    expect(await sourceCount()).toBe(1);
  });

  it('mergeNodes(deleteSource) removes the rows aimed at the merged-away source', async () => {
    const source = await node(mem.id, 'pas:040');
    const target = await node(mem.id, 'pas:041');
    const rows = await pendingAimedAt(source);

    await resolvers.Mutation.mergeNodes({}, {
      input: { source: source.id, target: target.id, include: ['CONTENT'], deleteSource: true },
    } as never, ctx());
    expect(await db.node.findUnique({ where: { id: source.id } })).toBeNull();
    expect(await remainingTargets()).toEqual([rows.loc]);
    expect(await sourceCount()).toBe(1);
  });

  it('control: mergeNodes without deleteSource leaves them', async () => {
    const source = await node(mem.id, 'pas:050');
    const target = await node(mem.id, 'pas:051');
    const rows = await pendingAimedAt(source);

    await resolvers.Mutation.mergeNodes({}, {
      input: { source: source.id, target: target.id, include: ['CONTENT'], deleteSource: false },
    } as never, ctx());
    expect(await remainingTargets()).toEqual(Object.values(rows).sort());
  });

  it('mergeMemories: a folded (colliding) source row takes its aimed rows with it', async () => {
    const from = await memory('merge-from');
    const folded = await node(from.id, 'shared');
    await node(mem.id, 'shared'); // the collision: `shared` folds into the target memory's row
    const rows = await pendingAimedAt(folded);

    await resolvers.Mutation.mergeMemories({}, { input: { source: from.id, target: mem.id } } as never, ctx());
    expect(await db.node.findUnique({ where: { id: folded.id } })).toBeNull();
    expect(await remainingTargets()).toEqual([rows.loc]);
    expect(await sourceCount()).toBe(1);
  });

  it('control: a soft delete keeps every row (the node can still come back)', async () => {
    const target = await node(mem.id, 'pas:060');
    const rows = await pendingAimedAt(target);

    await resolvers.Mutation.deleteNode({}, { nodeRef: target.id }, ctx());
    expect(await remainingTargets()).toEqual(Object.values(rows).sort());
  });
});
