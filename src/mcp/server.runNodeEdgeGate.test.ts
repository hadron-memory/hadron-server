/**
 * #1063 — `hadron_run_action` / `hadron_run_task` must not inline the content of
 * an edge target whose memory the caller cannot read.
 *
 * The defect: edges have been cross-memory since #781, and the MCP run path fed
 * `node.outgoingEdges` straight into the renderer, which inlines every target
 * with content. `loadNodeForRun` gates only the RUN NODE's own memory. So a run
 * node in a memory you can read, carrying an edge into one you cannot, returned
 * the foreign node's full content — while the GraphQL preview of the same node
 * correctly omitted it. The two surfaces are meant to be byte-identical (#818);
 * they disagreed in the direction that leaks.
 *
 * Why a read-time gate is needed even though the WRITE is already gated: #755
 * (PR #844) made `resolveEdgeRefs` refuse a target the caller cannot read, so an
 * ungated cross-memory edge is no longer creatable. That is a check at CREATE
 * time, and access is revocable — a membership dropped, a share deleted, a
 * memory narrowed. The edge outlives the access that justified it, so the
 * question has to be asked again when the content is served. The `revoked`
 * cases below are the ones that a create-time gate cannot answer.
 *
 * Deletion is the second half. GraphQL loads edges under
 * `where: { deletedAt: null, target: { deletedAt: null } }`; the MCP path had no
 * such filter, so a soft-deleted node kept being served through a dependency
 * link. Same class, different lifecycle.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';
import { deriveEdgeLoc } from '../lib/edgeLoc.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const SECRET = 'SECRET-CONTENT-FROM-THE-UNREADABLE-MEMORY';
const READABLE = 'ordinary readable dependency text';

interface Fixture {
  ownerId: string;
  outsiderId: string;
  runnerUrn: string;
  openMemId: string;
  closedMemId: string;
  closedNodeId: string;
  openDepId: string;
  runnerNodeId: string;
}
let fx: Fixture;

/** The caller who owns the run node's memory but NOT the edge target's. */
function outsiderAuth(): AuthContext {
  return { userId: fx.outsiderId, roles: [], clientId: `user:${fx.outsiderId}` };
}
/** A caller who can read both memories — the control. */
function ownerAuth(): AuthContext {
  return { userId: fx.ownerId, roles: ['ADMIN'], clientId: `user:${fx.ownerId}` };
}

function nodeUrn(memUrn: string, loc: string): string {
  const i = memUrn.indexOf(':');
  return `${memUrn.slice(0, i)}::${memUrn.slice(i + 1)}::${loc}`;
}

async function mkNode(memoryId: string, loc: string, name: string, content: string, isRunnable = false) {
  return db.node.create({
    data: { id: generateId(), memoryId, loc, name, nodeType: 'info', content, isRunnable, tags: [] },
  });
}

beforeEach(async () => {
  await cleanDb(db);

  const org = await db.organization.create({
    data: { id: generateId(), name: 'edge-gate-org', urn: `eg-${generateId()}` },
  });
  const owner = await db.user.create({
    data: { githubId: 8801, githubUsername: `eg-owner-${generateId()}`, roles: ['ADMIN'] },
  });
  await db.orgMember.create({ data: { organizationId: org.id, userId: owner.id, role: 'ADMIN' } });
  // The outsider is an ordinary MEMBER of the same org — deliberately not a
  // stranger. The interesting caller is one with legitimate access to the run
  // node's memory and none to the target's, because a stranger is already
  // refused at `loadNodeForRun` and never reaches the render.
  const outsider = await db.user.create({
    data: { githubId: 8802, githubUsername: `eg-outsider-${generateId()}`, roles: [] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: outsider.id, role: 'READER' },
  });

  const ctx: Context = { db, roles: ['ADMIN'], userId: owner.id };
  const mkMem = async (name: string, memoryClass?: 'personal') => {
    const created = (await resolvers.Mutation.createMemory(
      {},
      { orgId: org.id, name, ...(memoryClass ? { memoryClass } : {}) },
      ctx,
    )) as { id: string };
    return db.memory.findUniqueOrThrow({
      where: { id: created.id },
      select: { id: true, urn: true },
    });
  };

  // `open` — knowledge-class, ORGANIZATION-visible: every org member reads it.
  // `closed` — PERSONAL to the owner: owner-only by class, so org membership
  // buys nothing. That is the gap the run bundle was bridging.
  const open = await mkMem(`Open-${generateId()}`);
  const closed = await mkMem(`Closed-${generateId()}`, 'personal');

  const runner = await mkNode(open.id, 'tasks:run-me', 'Run me', 'the runnable body', true);
  const openDep = await mkNode(open.id, 'docs:open', 'Open dep', READABLE);
  const closedDep = await mkNode(closed.id, 'docs:closed', 'Closed dep', SECRET);

  // One edge into each memory: the readable one proves the gate does not simply
  // drop every dependency, which a too-broad fix would do and a test asserting
  // only the absence of SECRET would not notice.
  for (const target of [openDep, closedDep]) {
    await db.edge.create({
      data: {
        id: generateId(),
        memoryId: runner.memoryId,
        sourceId: runner.id,
        targetId: target.id,
        loc: deriveEdgeLoc(runner.loc, 'depends-on', target.loc),
        name: 'depends-on',
      },
    });
  }

  fx = {
    ownerId: owner.id,
    outsiderId: outsider.id,
    runnerUrn: nodeUrn(open.urn, runner.loc),
    openMemId: open.id,
    closedMemId: closed.id,
    closedNodeId: closedDep.id,
    openDepId: openDep.id,
    runnerNodeId: runner.id,
  };
});

describe('#1063 — the run bundle honours a per-target memory-read gate', () => {
  it('hadron_run_action omits an edge target in an unreadable memory', async () => {
    const text = await createTestableMcpServer(outsiderAuth()).callToolText('hadron_run_action', {
      urn: fx.runnerUrn,
    });

    // The run node itself still renders — the caller may read ITS memory.
    expect(text).toContain('the runnable body');
    // The readable dependency still inlines.
    expect(text).toContain(READABLE);
    // The foreign one does not.
    expect(text).not.toContain(SECRET);
  });

  it('hadron_run_task omits it too — both tools share the render core', async () => {
    const text = await createTestableMcpServer(outsiderAuth()).callToolText('hadron_run_task', {
      urn: fx.runnerUrn,
    });

    expect(text).toContain('the runnable body');
    expect(text).not.toContain(SECRET);
  });

  it('a caller who CAN read both still gets both — the gate is not a blanket drop', async () => {
    const text = await createTestableMcpServer(ownerAuth()).callToolText('hadron_run_action', {
      urn: fx.runnerUrn,
    });

    expect(text).toContain(READABLE);
    expect(text).toContain(SECRET); // not secret from the owner
  });

  it('MCP and the GraphQL preview agree for the same caller (#818)', async () => {
    // The whole point of the shared renderer: a preview that disagrees with the
    // run is worse than none. Asserted on the SECRET specifically, since that is
    // where they diverged.
    const mcpText = await createTestableMcpServer(outsiderAuth()).callToolText(
      'hadron_run_action',
      { urn: fx.runnerUrn },
    );
    const preview = (await resolvers.Query.renderRunNode(
      {},
      { nodeRef: fx.runnerUrn },
      { db, roles: [], userId: fx.outsiderId } as Context,
    )) as string;

    expect(preview).not.toContain(SECRET);
    expect(mcpText).not.toContain(SECRET);
    // Both still carry the readable dependency, so "they agree" is not two
    // empty bundles agreeing.
    expect(preview).toContain(READABLE);
    expect(mcpText).toContain(READABLE);
  });

  it('access REVOKED after the edge was created stops the inlining', async () => {
    // The case a create-time gate structurally cannot answer. #755 (PR #844)
    // already refuses an edge whose target the caller cannot read, so the edge
    // below is created legitimately — and then the access that justified it is
    // taken away. Only a gate at READ time notices.
    //
    // Revocation is an OrgMember delete rather than a MemoryShare delete
    // because MCP's `canReadMemory` does not consult MemoryShare at all (it is
    // a strict-owner check for personal/private); see the note in the PR.
    const org2 = await db.organization.create({
      data: { id: generateId(), name: 'eg-org2', urn: `eg2-${generateId()}` },
    });
    await db.orgMember.create({
      data: { organizationId: org2.id, userId: fx.ownerId, role: 'ADMIN' },
    });
    const membership = await db.orgMember.create({
      data: { organizationId: org2.id, userId: fx.outsiderId, role: 'READER' },
    });
    const revocable = (await resolvers.Mutation.createMemory(
      {},
      { orgId: org2.id, name: `Revocable-${generateId()}` },
      { db, roles: ['ADMIN'], userId: fx.ownerId } as Context,
    )) as { id: string };
    const dep = await mkNode(revocable.id, 'docs:revocable', 'Revocable dep', 'EXTRA-SECRET');
    await db.edge.create({
      data: {
        id: generateId(),
        memoryId: fx.openMemId,
        sourceId: fx.runnerNodeId,
        targetId: dep.id,
        loc: deriveEdgeLoc('tasks:run-me', 'depends-on', dep.loc),
        name: 'depends-on',
      },
    });

    const before = await createTestableMcpServer(outsiderAuth()).callToolText('hadron_run_action', {
      urn: fx.runnerUrn,
    });
    expect(before, 'precondition: readable while the membership stands').toContain('EXTRA-SECRET');

    await db.orgMember.delete({ where: { id: membership.id } });

    const after = await createTestableMcpServer(outsiderAuth()).callToolText('hadron_run_action', {
      urn: fx.runnerUrn,
    });
    expect(after).not.toContain('EXTRA-SECRET');
    // ...and the rest of the bundle is unaffected: revocation drops one
    // dependency, it does not break the run.
    expect(after).toContain('the runnable body');
    expect(after).toContain(READABLE);
  });

  it('a soft-deleted target is not served through a dependency link', async () => {
    // GraphQL filters `target: { deletedAt: null }`; the MCP path did not, so a
    // deleted node kept being readable through any edge pointing at it.
    await db.node.update({ where: { id: fx.openDepId }, data: { deletedAt: new Date() } });

    const text = await createTestableMcpServer(ownerAuth()).callToolText('hadron_run_action', {
      urn: fx.runnerUrn,
    });

    expect(text).not.toContain(READABLE);
  });

  it('a soft-deleted EDGE stops carrying its target', async () => {
    await db.edge.updateMany({
      where: { sourceId: fx.runnerNodeId, targetId: fx.openDepId },
      data: { deletedAt: new Date() },
    });

    const text = await createTestableMcpServer(ownerAuth()).callToolText('hadron_run_action', {
      urn: fx.runnerUrn,
    });

    expect(text).not.toContain(READABLE);
  });
});
