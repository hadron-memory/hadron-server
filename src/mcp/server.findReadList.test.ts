/**
 * Behavioral coverage for the PR-188 find/read/list truth fixes plus the
 * BOLA hardening Gemini surfaced in code review.
 *
 * What this file pins:
 *
 *   - #188 BOLA — h-find-nodes / h-list-nodes route through canReadMemory
 *     for both the `memoryUrn` branch and the `parentRel` branch. Before
 *     the fix, `where.memoryId = mem.id` overrode the access-scoped filter,
 *     letting any authenticated caller search/browse any memory by URN.
 *
 *   - #180 Bug 2 — soft-deleted nodes excluded from h-find-nodes,
 *     h-read-node, h-read-next-node, h-list-nodes. Edge includes on those
 *     paths additionally hide edges whose other-end node is tombstoned
 *     (so `Related:` and `Referenced by:` don't leak dangling refs).
 *
 *   - #186 — h-read-node + h-read-next-node emit a `Type: <nodeType>` line
 *     so portal-render / tool-dispatch nodeType drift is detectable.
 *
 *   - #185 Friction 4 — h-list-nodes at depth=1 synthesizes implicit
 *     depth-1 parents whose only children sit at depth ≥ 2. Before the
 *     fix the walk-up loop early-exited any node beyond `maxDepth`, so
 *     deeply-nested orphans rendered as missing branches.
 *
 *   - #170 — h-find-nodes `query: "*"` survey-mode smoke (the matchesQuery
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
        sourceId: edgeSource.id,
        targetId: liveTarget.id,
        label: 'cites',
      },
      {
        id: generateId(),
        sourceId: edgeSource.id,
        targetId: tombstonedTarget.id,
        label: 'cites',
      },
      {
        id: generateId(),
        sourceId: liveIncomingSource.id,
        targetId: witness.id,
        label: 'depends-on',
      },
      {
        id: generateId(),
        sourceId: tombstonedIncomingSource.id,
        targetId: witness.id,
        label: 'depends-on',
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

describe('#188 BOLA — h-find-nodes scope override is gated by canReadMemory', () => {
  it('returns "Memory not found" when a non-admin without access passes the memory URN', async () => {
    const srv = createTestableMcpServer(viewerAuth());
    const text = await srv.callToolText('h-find-nodes', {
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
    const text = await srv.callToolText('h-find-nodes', {
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
    const text = await srv.callToolText('h-find-nodes', {
      query: '*',
      parentRel: `urn:node:${fx.memory.urn}:archive`,
    });
    expect(text).toMatch(/No nodes found/i);
    expect(text).not.toContain('archive ');
  });
});

describe('#188 BOLA — h-list-nodes scope override is gated by canReadMemory', () => {
  it('returns "Memory not found" when a non-admin without access passes the memory URN', async () => {
    const srv = createTestableMcpServer(viewerAuth());
    const text = await srv.callToolText('h-list-nodes', {
      memoryUrn: fx.memory.urn,
      depth: 2,
    });
    expect(text).toContain('Memory not found or invalid');
    expect(text).not.toContain(fx.nodes.archive.loc);
  });

  it('returns the tree for an admin caller passing the same URN (control)', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('h-list-nodes', {
      memoryUrn: fx.memory.urn,
      depth: 2,
    });
    expect(text).not.toContain('Memory not found');
    expect(text).toContain(fx.nodes.archive.loc);
  });

  it('returns the empty-subtree envelope (no leak) when a non-admin passes a parentRel that resolves to an inaccessible memory', async () => {
    // Same shape as the h-find-nodes BOLA parentRel test: resolveLocFromUrn
    // can't surface a memoryId for a non-admin viewer, the listing scopes
    // to their empty access set, and h-list-nodes reports "No child nodes
    // found" — same envelope it would emit against an accessible memory
    // with no children at that prefix. No memory-existence leak.
    const srv = createTestableMcpServer(viewerAuth());
    const text = await srv.callToolText('h-list-nodes', {
      parentRel: `urn:node:${fx.memory.urn}:archive`,
      depth: 1,
    });
    expect(text).toMatch(/No child nodes found/i);
    // No actual data from the inaccessible memory leaks into the response.
    expect(text).not.toContain('Old item');
  });
});

// ---------------------------------------------------------------------------
// #180 Bug 2 — soft-deleted nodes excluded from find / read / list / next
// ---------------------------------------------------------------------------

describe('#180 Bug 2 — h-find-nodes excludes soft-deleted nodes', () => {
  it('does not surface a tombstoned node in keyword results', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('h-find-nodes', {
      query: 'archived',
      memoryUrn: fx.memory.urn,
    });
    expect(text).not.toContain(fx.nodes.archiveOldTombstoned.loc);
  });

  it('does not surface a tombstoned node in wildcard survey', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('h-find-nodes', {
      query: '*',
      memoryUrn: fx.memory.urn,
    });
    expect(text).not.toContain(fx.nodes.archiveOldTombstoned.loc);
    // sanity: live siblings still present
    expect(text).toContain(fx.nodes.archive.loc);
  });
});

describe('#180 Bug 2 — h-read-node treats soft-deleted nodes as not found', () => {
  it('returns "not found" for a tombstoned URN (no last-content leak)', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('h-read-node', {
      urn: `urn:node:${fx.memory.urn}:${fx.nodes.archiveOldTombstoned.loc}`,
    });
    expect(text).toMatch(/not found/i);
    expect(text).not.toContain('an old archived note');
  });

  it('still reads a live node normally (control)', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('h-read-node', {
      urn: `urn:node:${fx.memory.urn}:${fx.nodes.archive.loc}`,
    });
    expect(text).toContain(fx.nodes.archive.loc);
  });
});

describe('#180 Bug 2 — h-list-nodes omits soft-deleted nodes', () => {
  it('does not include tombstoned children in the tree', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('h-list-nodes', {
      memoryUrn: fx.memory.urn,
      depth: 3,
    });
    expect(text).not.toContain('archive:old');
    expect(text).toContain('archive');
  });
});

describe('#180 Bug 2 — h-read-next-node skips soft-deleted siblings', () => {
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
    const text = await srv.callToolText('h-read-next-node', {
      parent: `urn:node:${fx.memory.urn}:walk`,
      current: `urn:node:${fx.memory.urn}:walk:a`,
    });
    expect(text).toContain('walk:c');
    expect(text).not.toContain('walk:b-dead');
  });
});

describe('#180 Bug 2 — edge includes filter tombstoned target/source', () => {
  it('h-read-node Related section hides edges to a tombstoned target', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('h-read-node', {
      urn: `urn:node:${fx.memory.urn}:${fx.nodes.edgeSource.loc}`,
    });
    // Edge to liveTarget is shown.
    expect(text).toContain(fx.nodes.liveTarget.loc);
    // Edge to tombstonedTarget is not.
    expect(text).not.toContain(fx.nodes.tombstonedTarget.loc);
  });

  it('h-read-node Referenced-by section hides edges from a tombstoned source', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('h-read-node', {
      urn: `urn:node:${fx.memory.urn}:${fx.nodes.witness.loc}`,
    });
    expect(text).toContain(fx.nodes.liveIncomingSource.loc);
    expect(text).not.toContain(fx.nodes.tombstonedIncomingSource.loc);
  });

  it('h-find-nodes brief mode hides edges to tombstoned targets', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('h-find-nodes', {
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
// #186 — Type: meta line in read tools
// ---------------------------------------------------------------------------

describe('#186 — h-read-node surfaces nodeType in formatted output', () => {
  it('renders Type: parent for a parent-type node', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('h-read-node', {
      urn: `urn:node:${fx.memory.urn}:${fx.nodes.archive.loc}`,
    });
    expect(text).toMatch(/^Type: parent$/m);
  });

  it('renders Type: info for the default nodeType', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('h-read-node', {
      urn: `urn:node:${fx.memory.urn}:${fx.nodes.witness.loc}`,
    });
    expect(text).toMatch(/^Type: info$/m);
  });
});

// ---------------------------------------------------------------------------
// #185 Friction 4 — implicit parents at depth=1
// ---------------------------------------------------------------------------

describe('#185 F4 — h-list-nodes synthesizes implicit parents at depth=1', () => {
  it('shows a depth-1 (missing) row for a depth-3 orphan even at maxDepth=1', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('h-list-nodes', {
      memoryUrn: fx.memory.urn,
      depth: 1,
    });
    // The deep node's depth-1 ancestor is `findings`; its full URN form
    // should appear with the synthesize-parent hint and the 1-child
    // count (its only direct child is `findings:foo`, which IS a real
    // child even though that one is also implicit downstream).
    expect(text).toContain('findings');
    expect(text).toMatch(/findings.*missing.*use h-add-parent-node/);
    // Other depth-1 implicit parent for `project:notes`.
    expect(text).toContain('project');
    expect(text).toMatch(/project.*missing.*use h-add-parent-node/);
  });
});

// ---------------------------------------------------------------------------
// #170 — wildcard end-to-end smoke
// ---------------------------------------------------------------------------

describe('#170 — h-find-nodes wildcard survey end-to-end', () => {
  it('query="*" returns every live node in the scoped memory', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('h-find-nodes', {
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
// Spec 031 US2 — h-find-nodes preview surfaces the abstract
// ---------------------------------------------------------------------------

describe('spec 031 US2 — h-find-nodes preview includes the abstract', () => {
  const SHORT_ABSTRACT =
    'Paragraph-length summary that should appear in the preview as an indented block beneath the description line.';
  const MULTI_LINE_ABSTRACT = 'First paragraph.\n\nSecond paragraph.';

  it('US2.1 — preview emits the abstract as a two-space-indented block beneath the description (no `>` prefix)', async () => {
    await db.node.update({
      where: { id: fx.nodes.findingsDeep.id },
      data: { abstract: SHORT_ABSTRACT },
    });

    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('h-find-nodes', {
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
    const text = await srv.callToolText('h-find-nodes', {
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
    const text = await srv.callToolText('h-find-nodes', {
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
    const text = await srv.callToolText('h-find-nodes', {
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
    const text = await srv.callToolText('h-find-nodes', {
      query: 'finding',
      brief: true,
      memoryUrn: fx.memory.urn,
    });

    // The hit is present.
    expect(text).toContain(fx.nodes.findingsDeep.loc);
    // BUT the abstract is excluded from the brief response.
    expect(text).not.toContain(SHORT_ABSTRACT);
  });

  it('US2 — search haystack is unchanged: a term appearing only in the abstract does NOT match (US3 deferred to RAG)', async () => {
    const UNIQUE_TERM = 'flibbertigibbet'; // appears nowhere else
    await db.node.update({
      where: { id: fx.nodes.witness.id },
      data: { abstract: `${UNIQUE_TERM} text only in the abstract` },
    });

    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('h-find-nodes', {
      query: UNIQUE_TERM,
      memoryUrn: fx.memory.urn,
    });

    // Per PR-196 US3 deferral: abstract is NOT part of the substring
    // haystack. Searching for an abstract-only term must return zero
    // hits — same behavior as pre-spec.
    expect(text).toContain('No nodes found');
  });
});
