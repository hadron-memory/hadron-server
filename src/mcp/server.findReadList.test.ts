/**
 * Behavioral coverage for the PR-188 find/read/list truth fixes plus the
 * BOLA hardening Gemini surfaced in code review.
 *
 * What this file pins:
 *
 *   - #188 BOLA — hadron_find_nodes / hadron_list_nodes route through canReadMemory
 *     for both the `memoryUrn` branch and the `parentRel` branch. Before
 *     the fix, `where.memoryId = mem.id` overrode the access-scoped filter,
 *     letting any authenticated caller search/browse any memory by URN.
 *
 *   - #180 Bug 2 — soft-deleted nodes excluded from hadron_find_nodes,
 *     hadron_get_node, hadron_get_next_node, hadron_list_nodes. Edge includes on those
 *     paths additionally hide edges whose other-end node is tombstoned
 *     (so `Related:` and `Referenced by:` don't leak dangling refs).
 *
 *   - #186 — hadron_get_node + hadron_get_next_node emit a `Type: <nodeType>` line
 *     so portal-render / tool-dispatch nodeType drift is detectable.
 *
 *   - #185 Friction 4 — hadron_list_nodes at depth=1 synthesizes implicit
 *     depth-1 parents whose only children sit at depth ≥ 2. Before the
 *     fix the walk-up loop early-exited any node beyond `maxDepth`, so
 *     deeply-nested orphans rendered as missing branches.
 *
 *   - #170 — hadron_find_nodes `query: "*"` survey-mode smoke (the matchesQuery
 *     unit covers branch logic; this is the end-to-end version that
 *     exercises the soft-delete + access-scope plumbing as well).
 *
 * Test harness: `createTestableMcpServer` exposes the registered tool
 * callbacks so we drive the real production closure (including auth +
 * canReadMemory + nodeUrn rendering) without an HTTP transport.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';
import { deriveEdgeLoc } from '../lib/edgeLoc.js';

// The MCP tools don't write to git in this surface, but other parts of the
// codebase do — pin to a no-op so the test doesn't try to push.
vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

interface Fixture {
  admin: { id: string };
  viewer: { id: string };
  memory: { id: string; urn: string };
  nodes: {
    archive: { id: string; loc: string };
    archiveOldTombstoned: { id: string; loc: string };
    findingsDeep: { id: string; loc: string };
    projectDeep: { id: string; loc: string };
    edgeSource: { id: string; loc: string };
    liveTarget: { id: string; loc: string };
    tombstonedTarget: { id: string; loc: string };
    witness: { id: string; loc: string };
    liveIncomingSource: { id: string; loc: string };
    tombstonedIncomingSource: { id: string; loc: string };
  };
}

let fx: Fixture;

function adminAuth(): AuthContext {
  return { userId: fx.admin.id, roles: ['ADMIN'], clientId: `user:${fx.admin.id}` };
}

function viewerAuth(): AuthContext {
  // Non-admin, no AppMember, no roles. resolveUserApps returns []; the
  // memory-access map is empty; canReadMemory returns false for any
  // non-personal memory; the BOLA gate must fire.
  return { userId: fx.viewer.id, roles: [], clientId: `user:${fx.viewer.id}` };
}

beforeEach(async () => {
  await cleanDb(db);

  const org = await db.organization.create({
    data: { id: generateId(), name: 'truth-org', urn: 'truth-org' },
  });
  const admin = await db.user.create({
    data: { githubId: 9601, githubUsername: 'truth-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  const viewer = await db.user.create({
    data: { githubId: 9602, githubUsername: 'truth-viewer', roles: [] },
  });

  const localGqlCtx: Context = { db, roles: ['ADMIN'], userId: admin.id };
  const memory = await resolvers.Mutation.createMemory(
    {},
    { orgId: org.id, name: 'trees' },
    localGqlCtx,
  );

  // Nodes — all the live ones first, then tombstoned ones via a follow-up
  // update so the CHECK constraints don't trip on partial state.
  const mk = async (
    loc: string,
    name: string,
    overrides: Partial<{
      nodeType: string;
      description: string;
      content: string;
      tags: string[];
      seq: number;
    }> = {},
  ) =>
    db.node.create({
      data: {
        id: generateId(),
        memoryId: memory.id,
        loc,
        name,
        nodeType: overrides.nodeType ?? 'info',
        description: overrides.description ?? null,
        content: overrides.content ?? null,
        tags: overrides.tags ?? [],
        seq: overrides.seq ?? null,
      },
    });

  const archive = await mk('archive', 'Archive', { nodeType: 'parent' });
  const archiveOld = await mk('archive:old', 'Old item', {
    description: 'an old archived note',
  });
  // F4 fixture — depth-3 node whose direct parents (`findings`,
  // `findings:foo`) don't exist as real rows. At maxDepth=1, the
  // synthesize-parent walk must produce a row for `findings`.
  const findingsDeep = await mk('findings:foo:bar', 'Deep finding', {
    description: 'bottom of a 3-level subtree with no materialized parents',
  });
  // Second F4 fixture — different depth-1 implicit parent.
  const projectDeep = await mk('project:notes', 'Project notes', {
    description: 'a depth-2 orphan whose `project` parent is implicit',
  });

  const edgeSource = await mk('with-edges', 'edge source', {
    nodeType: 'info',
  });
  const liveTarget = await mk('live-target', 'live target');
  const tombstonedTarget = await mk('tombstoned-target', 'tombstoned target');
  const witness = await mk('witness', 'witness', {
    description: 'incoming-edge witness for the soft-delete leak test',
  });
  const liveIncomingSource = await mk('live-incoming-source', 'live source');
  const tombstonedIncomingSource = await mk(
    'tombstoned-incoming-source',
    'tombstoned source',
  );

  // Edges: edgeSource → liveTarget (live), edgeSource → tombstonedTarget
  // (target soft-deleted below). liveIncomingSource → witness (live),
  // tombstonedIncomingSource → witness (source soft-deleted below).
  await db.edge.createMany({
    data: [
      {
        id: generateId(),
        memoryId: edgeSource.memoryId,
        sourceId: edgeSource.id,
        targetId: liveTarget.id,
        loc: deriveEdgeLoc(edgeSource.loc, 'cites', liveTarget.loc),
        name: 'cites',
      },
      {
        id: generateId(),
        memoryId: edgeSource.memoryId,
        sourceId: edgeSource.id,
        targetId: tombstonedTarget.id,
        loc: deriveEdgeLoc(edgeSource.loc, 'cites', tombstonedTarget.loc),
        name: 'cites',
      },
      {
        id: generateId(),
        memoryId: liveIncomingSource.memoryId,
        sourceId: liveIncomingSource.id,
        targetId: witness.id,
        loc: deriveEdgeLoc(liveIncomingSource.loc, 'depends-on', witness.loc),
        name: 'depends-on',
      },
      {
        id: generateId(),
        memoryId: tombstonedIncomingSource.memoryId,
        sourceId: tombstonedIncomingSource.id,
        targetId: witness.id,
        loc: deriveEdgeLoc(tombstonedIncomingSource.loc, 'depends-on', witness.loc),
        name: 'depends-on',
      },
    ],
  });

  // Soft-delete the three nodes that should disappear from the
  // agent-facing surface. (Direct UPDATE — the MCP delete tool is PR-B.)
  const now = new Date();
  await db.node.updateMany({
    where: {
      id: {
        in: [archiveOld.id, tombstonedTarget.id, tombstonedIncomingSource.id],
      },
    },
    data: { deletedAt: now },
  });

  fx = {
    admin,
    viewer,
    memory,
    nodes: {
      archive,
      archiveOldTombstoned: archiveOld,
      findingsDeep,
      projectDeep,
      edgeSource,
      liveTarget,
      tombstonedTarget,
      witness,
      liveIncomingSource,
      tombstonedIncomingSource,
    },
  };
});

// ---------------------------------------------------------------------------
// #188 — BOLA regression
// ---------------------------------------------------------------------------

describe('#188 BOLA — hadron_find_nodes scope override is gated by canReadMemory', () => {
  it('returns "Memory not found" when a non-admin without access passes the memory URN', async () => {
    const srv = createTestableMcpServer(viewerAuth());
    const text = await srv.callToolText('hadron_find_nodes', {
      query: '*',
      memoryUrn: fx.memory.urn,
    });
    // Same envelope as a genuinely-missing memory — no existence leak.
    expect(text).toContain('Memory not found or invalid');
    // And specifically NOT a list of the memory's contents.
    expect(text).not.toContain(fx.nodes.witness.loc);
    expect(text).not.toContain(fx.nodes.archive.loc);
  });

  it('returns the data for an admin caller passing the same URN (control)', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_find_nodes', {
      query: '*',
      memoryUrn: fx.memory.urn,
    });
    expect(text).not.toContain('Memory not found');
    expect(text).toContain(fx.nodes.witness.loc);
  });

  it('returns no nodes when a non-admin passes a parentRel that resolves to an inaccessible memory', async () => {
    // For a non-admin caller, `resolveLocFromUrn` filters the URN-typed
    // resolve path against the caller's accessible memory IDs (empty here)
    // and falls through to a legacy best-effort lookup that ALSO filters
    // by the accessible set. memoryId comes back undefined, the find runs
    // against `where.memoryId = { in: [] }`, and the response is the
    // ordinary "no match" envelope. No memory-existence leak; the agent's
    // search just returns empty.
    const srv = createTestableMcpServer(viewerAuth());
    const text = await srv.callToolText('hadron_find_nodes', {
      query: '*',
      parentRel: `urn:node:${fx.memory.urn}:archive`,
    });
    expect(text).toMatch(/No nodes found/i);
    expect(text).not.toContain('archive ');
  });
});

describe('#188 BOLA — hadron_list_nodes scope override is gated by canReadMemory', () => {
  it('returns "Memory not found" when a non-admin without access passes the memory URN', async () => {
    const srv = createTestableMcpServer(viewerAuth());
    const text = await srv.callToolText('hadron_list_nodes', {
      memoryUrn: fx.memory.urn,
      depth: 2,
    });
    expect(text).toContain('Memory not found or invalid');
    expect(text).not.toContain(fx.nodes.archive.loc);
  });

  it('returns the tree for an admin caller passing the same URN (control)', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_list_nodes', {
      memoryUrn: fx.memory.urn,
      depth: 2,
    });
    expect(text).not.toContain('Memory not found');
    expect(text).toContain(fx.nodes.archive.loc);
  });

  it('returns the explicit not-found refusal (no leak) when a non-admin names an inaccessible parent memory', async () => {
    // #2512: explicit references resolve independently of discovery, then
    // canReadMemory returns the existing not-found refusal for an unreadable
    // parent. No child metadata is rendered.
    const srv = createTestableMcpServer(viewerAuth());
    const text = await srv.callToolText('hadron_list_nodes', {
      parentRel: `urn:node:${fx.memory.urn}:archive`,
      depth: 1,
    });
    expect(text).toMatch(/Node .* not found/i);
    // No actual data from the inaccessible memory leaks into the response.
    expect(text).not.toContain('Old item');
  });
});

// ---------------------------------------------------------------------------
// #180 Bug 2 — soft-deleted nodes excluded from find / read / list / next
// ---------------------------------------------------------------------------

describe('#180 Bug 2 — hadron_find_nodes excludes soft-deleted nodes', () => {
  it('does not surface a tombstoned node in keyword results', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_find_nodes', {
      query: 'archived',
      memoryUrn: fx.memory.urn,
    });
    expect(text).not.toContain(fx.nodes.archiveOldTombstoned.loc);
  });

  it('does not surface a tombstoned node in wildcard survey', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_find_nodes', {
      query: '*',
      memoryUrn: fx.memory.urn,
    });
    expect(text).not.toContain(fx.nodes.archiveOldTombstoned.loc);
    // sanity: live siblings still present
    expect(text).toContain(fx.nodes.archive.loc);
  });
});

describe('#180 Bug 2 — hadron_get_node treats soft-deleted nodes as not found', () => {
  it('returns "not found" for a tombstoned URN (no last-content leak)', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_get_node', {
      urn: `urn:node:${fx.memory.urn}:${fx.nodes.archiveOldTombstoned.loc}`,
    });
    expect(text).toMatch(/not found/i);
    expect(text).not.toContain('an old archived note');
  });

  it('still reads a live node normally (control)', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_get_node', {
      urn: `urn:node:${fx.memory.urn}:${fx.nodes.archive.loc}`,
    });
    expect(text).toContain(fx.nodes.archive.loc);
  });
});

describe('#180 Bug 2 — hadron_list_nodes omits soft-deleted nodes', () => {
  it('does not include tombstoned children in the tree', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_list_nodes', {
      memoryUrn: fx.memory.urn,
      depth: 3,
    });
    expect(text).not.toContain('archive:old');
    expect(text).toContain('archive');
  });
});

describe('#180 Bug 2 — hadron_get_next_node skips soft-deleted siblings', () => {
  beforeEach(async () => {
    // Add a parent + ordered live siblings + one tombstoned sibling to
    // exercise the next-by-seq walk.
    await db.node.create({
      data: {
        id: generateId(),
        memoryId: fx.memory.id,
        loc: 'walk',
        name: 'walk parent',
        nodeType: 'parent',
      },
    });
    await db.node.create({
      data: {
        id: generateId(),
        memoryId: fx.memory.id,
        loc: 'walk:a',
        name: 'a',
        seq: 1,
      },
    });
    const dead = await db.node.create({
      data: {
        id: generateId(),
        memoryId: fx.memory.id,
        loc: 'walk:b-dead',
        name: 'b-dead',
        seq: 2,
      },
    });
    await db.node.create({
      data: {
        id: generateId(),
        memoryId: fx.memory.id,
        loc: 'walk:c',
        name: 'c',
        seq: 3,
      },
    });
    await db.node.update({
      where: { id: dead.id },
      data: { deletedAt: new Date() },
    });
  });

  it('next-after-a returns c, not the tombstoned b-dead', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_get_next_node', {
      parent: `urn:node:${fx.memory.urn}:walk`,
      current: `urn:node:${fx.memory.urn}:walk:a`,
    });
    expect(text).toContain('walk:c');
    expect(text).not.toContain('walk:b-dead');
    // #322: get_next_node surfaces the stable PK meta line too.
    expect(text).toMatch(/^ID: [a-z0-9]+$/m);
  });
});

describe('#180 Bug 2 — edge includes filter tombstoned target/source', () => {
  it('hadron_get_node Related section hides edges to a tombstoned target', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_get_node', {
      urn: `urn:node:${fx.memory.urn}:${fx.nodes.edgeSource.loc}`,
    });
    // Edge to liveTarget is shown.
    expect(text).toContain(fx.nodes.liveTarget.loc);
    // Edge to tombstonedTarget is not.
    expect(text).not.toContain(fx.nodes.tombstonedTarget.loc);
  });

  it('hadron_get_node Referenced-by section hides edges from a tombstoned source', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_get_node', {
      urn: `urn:node:${fx.memory.urn}:${fx.nodes.witness.loc}`,
    });
    expect(text).toContain(fx.nodes.liveIncomingSource.loc);
    expect(text).not.toContain(fx.nodes.tombstonedIncomingSource.loc);
  });

  it('hadron_find_nodes brief mode hides edges to tombstoned targets', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_find_nodes', {
      query: 'edge source',
      memoryUrn: fx.memory.urn,
      brief: true,
    });
    expect(text).toContain(fx.nodes.edgeSource.loc);
    expect(text).toContain(fx.nodes.liveTarget.loc);
    expect(text).not.toContain(fx.nodes.tombstonedTarget.loc);
  });
});

// ---------------------------------------------------------------------------
// #322 — surface the stable PK so callers can reference nodes by id
// ---------------------------------------------------------------------------

describe('#322 — read tools surface the node PK', () => {
  it('hadron_get_node emits an `ID: <pk>` meta line', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_get_node', {
      urn: `urn:node:${fx.memory.urn}:${fx.nodes.witness.loc}`,
    });
    expect(text).toMatch(new RegExp(`^ID: ${fx.nodes.witness.id}$`, 'm'));
  });

  it('hadron_get_node surfaces the target PK on Related edge lines', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_get_node', {
      urn: `urn:node:${fx.memory.urn}:${fx.nodes.edgeSource.loc}`,
    });
    // The live target's id appears so a caller can reference it by PK.
    expect(text).toContain(`id: ${fx.nodes.liveTarget.id}`);
  });

  it('hadron_find_nodes surfaces the PK on each result line', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_find_nodes', {
      query: 'edge source',
      memoryUrn: fx.memory.urn,
    });
    expect(text).toContain(`(id: ${fx.nodes.edgeSource.id})`);
  });
});

describe('#1323 — read tools surface and reconcile the current revision', () => {
  it('emits revision 1 for a new node', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_get_node', {
      urn: `urn:node:${fx.memory.urn}:${fx.nodes.witness.loc}`,
    });
    expect(text).toMatch(/^Revision: 1$/m);
  });

  it('takes exactly one revision when content bypassed a revisioned writer', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const urn = `urn:node:${fx.memory.urn}:${fx.nodes.witness.loc}`;
    await srv.callToolText('hadron_get_node', { urn }); // establish the compatibility baseline
    await db.node.update({
      where: { id: fx.nodes.witness.id },
      data: { content: 'off-road content' },
    });

    const first = await srv.callToolText('hadron_get_node', { urn });
    const second = await srv.callToolText('hadron_get_node', { urn });
    expect(first).toMatch(/^Revision: 2$/m);
    expect(first).toContain('off-road content');
    expect(second).toMatch(/^Revision: 2$/m);
    expect(await db.nodeRevision.count({ where: { nodeId: fx.nodes.witness.id } })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// #186 — Type: meta line in read tools
// ---------------------------------------------------------------------------

describe('#186 — hadron_get_node surfaces nodeType in formatted output', () => {
  it('renders Type: parent for a parent-type node', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_get_node', {
      urn: `urn:node:${fx.memory.urn}:${fx.nodes.archive.loc}`,
    });
    expect(text).toMatch(/^Type: parent$/m);
  });

  it('renders Type: info for the default nodeType', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_get_node', {
      urn: `urn:node:${fx.memory.urn}:${fx.nodes.witness.loc}`,
    });
    expect(text).toMatch(/^Type: info$/m);
  });
});

// ---------------------------------------------------------------------------
// #185 Friction 4 — implicit parents at depth=1
// ---------------------------------------------------------------------------

describe('#185 F4 — hadron_list_nodes synthesizes implicit parents at depth=1', () => {
  it('shows a depth-1 (missing) row for a depth-3 orphan even at maxDepth=1', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_list_nodes', {
      memoryUrn: fx.memory.urn,
      depth: 1,
    });
    // The deep node's depth-1 ancestor is `findings`; its full URN form
    // should appear with the synthesize-parent hint and the 1-child
    // count (its only direct child is `findings:foo`, which IS a real
    // child even though that one is also implicit downstream).
    expect(text).toContain('findings');
    expect(text).toMatch(/findings.*missing.*use hadron_create_parent_node/);
    // Other depth-1 implicit parent for `project:notes`.
    expect(text).toContain('project');
    expect(text).toMatch(/project.*missing.*use hadron_create_parent_node/);
  });
});

// ---------------------------------------------------------------------------
// #170 — wildcard end-to-end smoke
// ---------------------------------------------------------------------------

describe('#170 — hadron_find_nodes wildcard survey end-to-end', () => {
  it('query="*" returns every live node in the scoped memory', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_find_nodes', {
      query: '*',
      memoryUrn: fx.memory.urn,
    });
    // Live nodes present.
    expect(text).toContain(fx.nodes.archive.loc);
    expect(text).toContain(fx.nodes.witness.loc);
    expect(text).toContain(fx.nodes.findingsDeep.loc);
    // Tombstoned nodes absent (composed with the soft-delete fix).
    expect(text).not.toContain(fx.nodes.archiveOldTombstoned.loc);
    expect(text).not.toContain(fx.nodes.tombstonedTarget.loc);
    expect(text).not.toContain(fx.nodes.tombstonedIncomingSource.loc);
  });
});

// ---------------------------------------------------------------------------
// Spec 031 US2 — hadron_find_nodes preview surfaces the abstract
// ---------------------------------------------------------------------------

describe('spec 031 US2 — hadron_find_nodes preview includes the abstract', () => {
  const SHORT_ABSTRACT =
    'Paragraph-length summary that should appear in the preview as an indented block beneath the description line.';
  const MULTI_LINE_ABSTRACT = 'First paragraph.\n\nSecond paragraph.';

  it('US2.1 — preview emits the abstract as a two-space-indented block beneath the description (no `>` prefix)', async () => {
    await db.node.update({
      where: { id: fx.nodes.findingsDeep.id },
      data: { abstract: SHORT_ABSTRACT },
    });

    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_find_nodes', {
      query: 'finding',
      memoryUrn: fx.memory.urn,
    });

    // Description line preserved (two-space indent, no `>` prefix).
    expect(text).toContain('  bottom of a 3-level subtree with no materialized parents');
    // Abstract line emitted with the same two-space indent (no prefix).
    expect(text).toContain(`  ${SHORT_ABSTRACT}`);
    // The abstract must follow the description in the preview block (the
    // hit's description appears before its abstract line).
    const descPos = text.indexOf('  bottom of a 3-level');
    const absPos = text.indexOf(`  ${SHORT_ABSTRACT}`);
    expect(descPos).toBeGreaterThan(-1);
    expect(absPos).toBeGreaterThan(descPos);
  });

  it('US2.2 — node without abstract renders byte-identically to pre-spec preview', async () => {
    // archive node — no abstract by default; description set in the fixture.
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_find_nodes', {
      query: 'archive',
      memoryUrn: fx.memory.urn,
    });

    // The archive node has only `nodeType: 'parent'` (no description, no
    // abstract). Preview must contain its urn + name only — no extra
    // body lines from this hit.
    expect(text).toContain(fx.nodes.archive.loc);
    expect(text).toContain('Archive');
    // No bare-quoted abstract markers anywhere (would be a false-emit bug).
    expect(text).not.toContain('Source: abstract-fallback');
  });

  it('US2.3 — multi-line abstract gets the two-space indent on every line', async () => {
    await db.node.update({
      where: { id: fx.nodes.witness.id },
      data: { abstract: MULTI_LINE_ABSTRACT },
    });

    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_find_nodes', {
      query: 'witness',
      memoryUrn: fx.memory.urn,
    });

    // Each line of the multi-paragraph abstract gets the two-space prefix.
    expect(text).toContain('  First paragraph.');
    expect(text).toContain('  Second paragraph.');
  });

  it('US2.3b — CRLF line endings split cleanly (no trailing \\r mid-output)', async () => {
    // Windows clients / certain text areas submit CRLF; the renderer must
    // strip the `\r` so it doesn't print as a carriage return mid-line.
    // PR-202 review.
    await db.node.update({
      where: { id: fx.nodes.witness.id },
      data: { abstract: 'Windows-line.\r\nSecond windows-line.' },
    });

    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_find_nodes', {
      query: 'witness',
      memoryUrn: fx.memory.urn,
    });

    expect(text).toContain('  Windows-line.');
    expect(text).toContain('  Second windows-line.');
    // No stray \r characters anywhere in the rendered output.
    expect(text).not.toContain('\r');
  });

  it('US2.4 — `brief: true` excludes the abstract from the response (preserves the brief contract)', async () => {
    await db.node.update({
      where: { id: fx.nodes.findingsDeep.id },
      data: { abstract: SHORT_ABSTRACT },
    });

    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_find_nodes', {
      query: 'finding',
      brief: true,
      memoryUrn: fx.memory.urn,
    });

    // The hit is present.
    expect(text).toContain(fx.nodes.findingsDeep.loc);
    // BUT the abstract is excluded from the brief response.
    expect(text).not.toContain(SHORT_ABSTRACT);
  });

  it('US2 (PR2 #403) — a term appearing only in the abstract NOW matches (FTS indexes name/loc/tags/description/abstract/body)', async () => {
    const UNIQUE_TERM = 'flibbertigibbet'; // appears nowhere else
    await db.node.update({
      where: { id: fx.nodes.witness.id },
      data: { abstract: `${UNIQUE_TERM} text only in the abstract` },
    });

    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_find_nodes', {
      query: UNIQUE_TERM,
      memoryUrn: fx.memory.urn,
    });

    // #403 delegated hadron_find_nodes to the findNodes FTS engine, which
    // indexes the abstract (weight C). The old substring haystack excluded
    // it; this is the intended, user-visible semantics change.
    expect(text).toContain(fx.nodes.witness.loc);
    expect(text).toContain(UNIQUE_TERM);
  });
});

// ---------------------------------------------------------------------------
// cor:api:060 — isRunnable filter on hadron_find_nodes / hadron_list_nodes
// ---------------------------------------------------------------------------

describe('cor:api:060 — isRunnable filter (find/list)', () => {
  let runnableLoc: string;
  let notRunnableLoc: string;

  beforeEach(async () => {
    // A runnable task node and an explicitly-non-runnable node alongside the
    // fixture's isRunnable=NULL majority.
    const task = await db.node.create({
      data: {
        id: generateId(),
        memoryId: fx.memory.id,
        loc: 'runnable-task',
        name: 'Runnable task',
        isRunnable: true,
      },
    });
    const notTask = await db.node.create({
      data: {
        id: generateId(),
        memoryId: fx.memory.id,
        loc: 'explicitly-not-runnable',
        name: 'Not runnable',
        isRunnable: false,
      },
    });
    runnableLoc = task.loc;
    notRunnableLoc = notTask.loc;
  });

  it('hadron_find_nodes isRunnable=true returns only the runnable node', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_find_nodes', {
      query: '*',
      memoryUrn: fx.memory.urn,
      isRunnable: true,
    });
    expect(text).toContain(runnableLoc);
    expect(text).not.toContain(notRunnableLoc);
    // NULL-runnable fixture node must not surface under isRunnable=true.
    expect(text).not.toContain(fx.nodes.archive.loc);
  });

  it('hadron_find_nodes without the filter still surfaces NULL-runnable nodes', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_find_nodes', {
      query: '*',
      memoryUrn: fx.memory.urn,
    });
    expect(text).toContain(runnableLoc);
    expect(text).toContain(fx.nodes.archive.loc);
  });

  it('hadron_list_nodes isRunnable=true prunes the tree to task nodes', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_list_nodes', {
      memoryUrn: fx.memory.urn,
      depth: 2,
      isRunnable: true,
    });
    expect(text).toContain(runnableLoc);
    expect(text).not.toContain(notRunnableLoc);
    expect(text).not.toContain(fx.nodes.archive.loc);
  });

  it('hadron_list_nodes isRunnable=false returns only the explicitly-non-runnable node', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_list_nodes', {
      memoryUrn: fx.memory.urn,
      depth: 2,
      isRunnable: false,
    });
    expect(text).toContain(notRunnableLoc);
    expect(text).not.toContain(runnableLoc);
  });

  it('hadron_list_nodes renders a real non-runnable PARENT of a runnable child, not "(missing)"', async () => {
    // Regression (PR #359 review): the runnable filter must not be pushed into
    // the DB query — a real parent node (typically isRunnable=NULL) would then
    // be absent from the result set and the synthesize-parent walk would label
    // it "(missing — use hadron_create_parent_node to materialize)" even though
    // it exists. The filter is applied to the VISIBLE set, with realByKey kept
    // over the full set so genuine ancestors still resolve.
    await db.node.create({
      data: { id: generateId(), memoryId: fx.memory.id, loc: 'taskgroup', name: 'Task group' },
    }); // isRunnable = NULL
    await db.node.create({
      data: {
        id: generateId(),
        memoryId: fx.memory.id,
        loc: 'taskgroup:deploy',
        name: 'Deploy',
        isRunnable: true,
      },
    });

    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_list_nodes', {
      memoryUrn: fx.memory.urn,
      depth: 2,
      isRunnable: true,
    });
    // The runnable child surfaces, and its real parent renders by name — never
    // as a synthesized "(missing)" gap.
    expect(text).toContain('taskgroup:deploy');
    expect(text).toContain('Task group');
    expect(text).not.toContain('(missing');
  });
});

// ---------------------------------------------------------------------------
// PR-482 — literal fallback + multi-flag degraded notes on the MCP surface
// ---------------------------------------------------------------------------

describe('PR-482 — hadron_find_nodes literal fallback notes', () => {
  it('malformed keyword query degrades with a [degraded:literal_fallback] note, not an error', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_find_nodes', {
      query: '(unbalanced',
      mode: 'keyword',
      memoryUrn: fx.memory.urn,
    });
    expect(text).toContain('[degraded:literal_fallback]');
    expect(text).not.toContain('BAD_USER_INPUT');
  });

  it('malformed hybrid query on a non-indexed memory renders BOTH notes (flags are a comma-set)', async () => {
    // The envelope carries 'no_vector_index,literal_fallback'; the renderer
    // must parse the set — an exact-match would silently drop the vector
    // warning (Codex P3).
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_find_nodes', {
      query: '(unbalanced',
      mode: 'hybrid',
      memoryUrn: fx.memory.urn,
    });
    // Which vector flag fires depends on the fixture (index disabled →
    // no_vector_index; index on but no embedding endpoint →
    // embedding_unavailable) — either way the vector warning must survive
    // alongside the fallback note.
    expect(text).toMatch(/\[degraded:(no_vector_index|embedding_unavailable)\]/);
    expect(text).toContain('[degraded:literal_fallback]');
  });
});

// #498 — explicit multi-memory scope on hadron_find_nodes: memoryUrns (a set)
// and allMemories (everything accessible), so the stemmed cross-memory
// "does anyone know about X?" probe has an unambiguous surface.
describe('#498 — hadron_find_nodes multi-memory scope', () => {
  async function twoMemoriesWithKeyword() {
    const org = await db.organization.findFirstOrThrow({ where: { urn: 'truth-org' } });
    const ctx: Context = { db, roles: ['ADMIN'], userId: fx.admin.id };
    const a = await resolvers.Mutation.createMemory({}, { orgId: org.id, name: 'alpha' }, ctx);
    const b = await resolvers.Mutation.createMemory({}, { orgId: org.id, name: 'beta' }, ctx);
    await db.node.create({
      data: { id: generateId(), memoryId: a.id, loc: 'zeb:a', name: 'Zebraxyz in alpha', tags: [] },
    });
    await db.node.create({
      data: { id: generateId(), memoryId: b.id, loc: 'zeb:b', name: 'Zebraxyz in beta', tags: [] },
    });
    return { a, b };
  }

  it('allMemories: true finds keyword hits across every accessible memory', async () => {
    const { a, b } = await twoMemoriesWithKeyword();
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_find_nodes', { query: 'zebraxyz', allMemories: true });
    expect(text).toContain('zeb:a');
    expect(text).toContain('zeb:b');
    expect(a.id && b.id).toBeTruthy();
  });

  it('memoryUrns scopes to the given set (both), excluding others', async () => {
    const { a, b } = await twoMemoriesWithKeyword();
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_find_nodes', {
      query: 'zebraxyz',
      memoryUrns: [a.urn, b.urn],
    });
    expect(text).toContain('zeb:a');
    expect(text).toContain('zeb:b');
  });

  it('memoryUrn (single) scopes to just that memory', async () => {
    const { a } = await twoMemoriesWithKeyword();
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_find_nodes', { query: 'zebraxyz', memoryUrn: a.urn });
    expect(text).toContain('zeb:a');
    expect(text).not.toContain('zeb:b');
  });

  it('rejects combining memory selectors (memoryUrn + allMemories)', async () => {
    const { a } = await twoMemoriesWithKeyword();
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_find_nodes', {
      query: 'zebraxyz',
      memoryUrn: a.urn,
      allMemories: true,
    });
    expect(text).toMatch(/only one memory scope/i);
    expect(text).not.toContain('zeb:a');
  });

  it('allMemories includes system-class memories (explicit ids bypass the broad class filter)', async () => {
    // #567 review (Codex): a scope-less broad findNodes hides class='system';
    // allMemories must materialize the readable set so the agent's own system
    // memory is not silently dropped from an "everything you can read" probe.
    const org = await db.organization.findFirstOrThrow({ where: { urn: 'truth-org' } });
    const sysMem = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: 'truth-org::sys', name: 'sys', class: 'system' },
    });
    await db.node.create({
      data: { id: generateId(), memoryId: sysMem.id, loc: 'sys:z', name: 'Zebraxyz system node', tags: [] },
    });
    const srv = createTestableMcpServer(adminAuth());
    const withAll = await srv.callToolText('hadron_find_nodes', { query: 'zebraxyz', allMemories: true });
    expect(withAll).toContain('sys:z');
    // A scope-less broad search (no allMemories) excludes the system memory.
    const broad = await srv.callToolText('hadron_find_nodes', { query: 'zebraxyz' });
    expect(broad).not.toContain('sys:z');
  });

  it('memoryUrns gates each entry by read access (denied set member → not found)', async () => {
    const { a } = await twoMemoriesWithKeyword();
    // A second org's memory the viewer can't read.
    const org2 = await db.organization.create({ data: { id: generateId(), name: 'other-org', urn: 'other-org' } });
    const foreign = await db.memory.create({
      data: { id: generateId(), organizationId: org2.id, urn: 'other-org::secret', name: 'secret', class: 'knowledge' },
    });
    const srv = createTestableMcpServer(viewerAuth());
    const text = await srv.callToolText('hadron_find_nodes', {
      query: 'zebraxyz',
      memoryUrns: [a.urn, foreign.urn],
    });
    expect(text).toMatch(/not found or invalid/i);
  });
});
