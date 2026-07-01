import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import {
  cleanDb,
  createDbOrgAndGraph,
  createDbNode,
  createDbAppWithKey,
  createDbAppAgent,
} from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';

// Prevent git writes
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let orgA: { id: string };
let orgB: { id: string };
let graphA: { id: string };
let graphB: { id: string };
let userA: { id: string };
let userB: { id: string };
let appReader: { id: string };
let appContributor: { id: string };

function ctx(overrides: Partial<Context> = {}): Context {
  return { db, ...overrides };
}

beforeEach(async () => {
  await cleanDb(db);

  // Org A with graph A
  const a = await createDbOrgAndGraph(db, { orgName: 'org-a', graphName: 'org-a/repo', visibility: 'ORGANIZATION' });
  orgA = a.org;
  graphA = a.graph;

  // Org B with graph B
  const b = await createDbOrgAndGraph(db, { orgName: 'org-b', graphName: 'org-b/repo', visibility: 'ORGANIZATION' });
  orgB = b.org;
  graphB = b.graph;

  // User A — member of org A (CONTRIBUTOR)
  userA = await db.user.create({
    data: { githubId: 1001, githubUsername: 'user-a', roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { organizationId: orgA.id, userId: userA.id, role: 'CONTRIBUTOR' },
  });

  // User B — member of org B (READER)
  userB = await db.user.create({
    data: { githubId: 1002, githubUsername: 'user-b', roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { organizationId: orgB.id, userId: userB.id, role: 'READER' },
  });

  // Create two agents in org A, each attached to graph A — one with
  // read-only AgentMemoryItem.role (for the "reader" app), one with
  // read-write (for the "contributor" app). After spec 005, AppAgent
  // doesn't cap per-attached-memory writes; the cap lives on
  // AgentMemoryItem.role, so the two-agent fixture is what produces
  // the observable "one can write, one can't" distinction.
  const readerAgent = await db.agent.create({
    data: { organizationId: orgA.id, urn: 'org-a:reader-agent', name: 'reader-agent' },
  });
  await db.agentMemoryItem.create({
    data: { agentId: readerAgent.id, memoryId: graphA.id, role: 'read' },
  });
  const contribAgent = await db.agent.create({
    data: { organizationId: orgA.id, urn: 'org-a:contrib-agent', name: 'contrib-agent' },
  });
  await db.agentMemoryItem.create({
    data: { agentId: contribAgent.id, memoryId: graphA.id, role: 'read-write' },
  });

  // App wired to the read-only agent
  const readerApp = await createDbAppWithKey(db, 'reader-app', orgA.id);
  appReader = readerApp.app;
  await createDbAppAgent(db, appReader.id, readerAgent.id);

  // App wired to the read-write agent
  const contribApp = await createDbAppWithKey(db, 'contributor-app', orgA.id);
  appContributor = contribApp.app;
  await createDbAppAgent(db, appContributor.id, contribAgent.id);

  // Seed nodes
  await createDbNode(db, { loc: 'org-a.repo.nodeA', memoryId: graphA.id });
  await createDbNode(db, { loc: 'org-b.repo.nodeB', memoryId: graphB.id });
});

// ---------------------------------------------------------------------------
// Query: nodes
// ---------------------------------------------------------------------------

describe('Query.nodes access control', () => {
  it('global ADMIN sees all nodes', async () => {
    const nodes = await resolvers.Query.nodes(
      null, {}, ctx({ clientId: 'github:admin', userId: 'x', roles: ['ADMIN'] }),
    );
    expect(nodes).toHaveLength(2);
  });

  it('user A sees only org A nodes', async () => {
    const nodes = await resolvers.Query.nodes(
      null, {}, ctx({ clientId: `github:${userA.id}`, userId: userA.id, roles: ['READER'] }),
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0].loc).toBe('org-a.repo.nodeA');
  });

  it('user B sees only org B nodes', async () => {
    const nodes = await resolvers.Query.nodes(
      null, {}, ctx({ clientId: `github:${userB.id}`, userId: userB.id, roles: ['READER'] }),
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0].loc).toBe('org-b.repo.nodeB');
  });

  it('App-keyed caller (no session) sees no nodes via GraphQL — Query.nodes is a management-only path; App memory reads go through MCP', async () => {
    const nodes = await resolvers.Query.nodes(
      null, {}, ctx({ appId: appReader.id }),
    );
    expect(nodes).toHaveLength(0);
  });

  it('unauthenticated sees only public memory nodes', async () => {
    await db.memory.update({ where: { id: graphB.id }, data: { visibility: 'PUBLIC' } });
    const nodes = await resolvers.Query.nodes(null, {}, ctx());
    expect(nodes).toHaveLength(1);
    expect(nodes[0].loc).toBe('org-b.repo.nodeB');
  });
});

// ---------------------------------------------------------------------------
// Query: node
// ---------------------------------------------------------------------------

describe('Query.node access control', () => {
  it('returns node for ADMIN', async () => {
    const node = await resolvers.Query.node(
      null, { loc: 'org-a.repo.nodeA' },
      ctx({ roles: ['ADMIN'] }),
    );
    expect(node).not.toBeNull();
    expect(node!.loc).toBe('org-a.repo.nodeA');
  });

  it('returns null for non-existent node', async () => {
    const node = await resolvers.Query.node(
      null, { loc: 'does.not.exist' },
      ctx({ roles: ['ADMIN'] }),
    );
    expect(node).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Query: subtree
// ---------------------------------------------------------------------------

describe('Query.subtree access control', () => {
  it('filters subtree results by accessible memories', async () => {
    const nodes = await resolvers.Query.subtree(
      null, { prefix: 'org-' },
      ctx({ clientId: `github:${userA.id}`, userId: userA.id, roles: ['READER'] }),
    );
    // User A only has access to org A, even though prefix matches both
    expect(nodes).toHaveLength(1);
    expect(nodes[0].loc).toBe('org-a.repo.nodeA');
  });
});

// ---------------------------------------------------------------------------
// Cross-org subscriptions
// ---------------------------------------------------------------------------

describe('cross-org memory subscription access', () => {
  it('user sees nodes from subscribed cross-org memories', async () => {
    // Org B subscribes to graph A
    await db.memorySubscription.create({
      data: { memoryId: graphA.id, organizationId: orgB.id, role: 'READER' },
    });
    const nodes = await resolvers.Query.nodes(
      null, {}, ctx({ clientId: `github:${userB.id}`, userId: userB.id, roles: ['READER'] }),
    );
    // User B sees org B nodes + subscribed graph A nodes
    expect(nodes).toHaveLength(2);
    const locs = nodes.map((n: any) => n.loc).sort();
    expect(locs).toEqual(['org-a.repo.nodeA', 'org-b.repo.nodeB']);
  });
});

// ---------------------------------------------------------------------------
// Mutation: upsertNode
// ---------------------------------------------------------------------------

describe('Mutation.upsertNode access control', () => {
  it('App with READ_WRITE AppAgent can write', async () => {
    const node = await resolvers.Mutation.upsertNode(
      null,
      { input: { memoryId: graphA.id, loc: 'org-a.repo.new', name: 'new' } },
      ctx({ appId: appContributor.id }),
    );
    expect(node.loc).toBe('org-a.repo.new');
  });

  it('App with READ_ONLY AppAgent is rejected', async () => {
    await expect(
      resolvers.Mutation.upsertNode(
        null,
        { input: { memoryId: graphA.id, loc: 'org-a.repo.new2', name: 'new2' } },
        ctx({ appId: appReader.id }),
      ),
    ).rejects.toThrow('Forbidden');
  });

  it('App cannot write to memory outside its AppAgent rows', async () => {
    await expect(
      resolvers.Mutation.upsertNode(
        null,
        { input: { memoryId: graphB.id, loc: 'org-b.repo.hack', name: 'hack' } },
        ctx({ appId: appContributor.id }),
      ),
    ).rejects.toThrow('Forbidden');
  });

  it('user with CONTRIBUTOR org role can write', async () => {
    const node = await resolvers.Mutation.upsertNode(
      null,
      { input: { memoryId: graphA.id, loc: 'org-a.repo.user-node', name: 'un' } },
      ctx({ clientId: `github:user-a`, userId: userA.id, roles: ['READER'] }),
    );
    expect(node.loc).toBe('org-a.repo.user-node');
  });

  it('user with READER org role is rejected', async () => {
    await expect(
      resolvers.Mutation.upsertNode(
        null,
        { input: { memoryId: graphB.id, loc: 'org-b.repo.nope', name: 'nope' } },
        ctx({ clientId: `github:user-b`, userId: userB.id, roles: ['READER'] }),
      ),
    ).rejects.toThrow('Forbidden');
  });
});

// ---------------------------------------------------------------------------
// Mutation: deleteNode
// ---------------------------------------------------------------------------

describe('Mutation.deleteNode access control', () => {
  it('App with write access can delete', async () => {
    const result = await resolvers.Mutation.deleteNode(
      null,
      { loc: 'org-a.repo.nodeA', memoryId: graphA.id },
      ctx({ appId: appContributor.id }),
    );
    expect(result).toBe(true);
  });

  it('App without write access is rejected', async () => {
    await expect(
      resolvers.Mutation.deleteNode(
        null,
        { loc: 'org-a.repo.nodeA', memoryId: graphA.id },
        ctx({ appId: appReader.id }),
      ),
    ).rejects.toThrow('Forbidden');
  });

  it('App cannot delete nodes in inaccessible memories', async () => {
    await expect(
      resolvers.Mutation.deleteNode(
        null,
        { loc: 'org-b.repo.nodeB', memoryId: graphB.id },
        ctx({ appId: appContributor.id }),
      ),
    ).rejects.toThrow('Forbidden');
  });

  // 007-entity-id-or-urn: deleteNode accepts memoryId as ID or URN.
  it('accepts a URN as memoryId input', async () => {
    const memoryRow = await db.memory.findUniqueOrThrow({
      where: { id: graphA.id },
      select: { urn: true },
    });
    const result = await resolvers.Mutation.deleteNode(
      null,
      { loc: 'org-a.repo.nodeA', memoryId: memoryRow.urn },
      ctx({ appId: appContributor.id }),
    );
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Mutation: moveNode
// ---------------------------------------------------------------------------

describe('Mutation.moveNode access control', () => {
  it('App with write access can move', async () => {
    const node = await resolvers.Mutation.moveNode(
      null,
      { from: 'org-a.repo.nodeA', to: 'org-a.repo.movedNode', memoryId: graphA.id },
      ctx({ appId: appContributor.id }),
    );
    expect(node.loc).toBe('org-a.repo.movedNode');
  });

  it('App cannot move nodes in inaccessible memories', async () => {
    await expect(
      resolvers.Mutation.moveNode(
        null,
        { from: 'org-b.repo.nodeB', to: 'org-b.repo.moved', memoryId: graphB.id },
        ctx({ appId: appContributor.id }),
      ),
    ).rejects.toThrow('Forbidden');
  });

  // 007-entity-id-or-urn: moveNode accepts memoryId as ID or URN.
  it('accepts a URN as memoryId input', async () => {
    const memoryRow = await db.memory.findUniqueOrThrow({
      where: { id: graphA.id },
      select: { urn: true },
    });
    const node = await resolvers.Mutation.moveNode(
      null,
      { from: 'org-a.repo.nodeA', to: 'org-a.repo.movedByUrn', memoryId: memoryRow.urn },
      ctx({ appId: appContributor.id }),
    );
    expect(node.loc).toBe('org-a.repo.movedByUrn');
  });

  // #100: Prisma P2025 must be wrapped as a typed NODE_NOT_FOUND error
  // rather than leaking as INTERNAL_SERVER_ERROR with raw ORM message.
  it('throws NODE_NOT_FOUND when source loc does not exist', async () => {
    await expect(
      resolvers.Mutation.moveNode(
        null,
        { from: 'org-a.repo.doesNotExist', to: 'org-a.repo.target', memoryId: graphA.id },
        ctx({ appId: appContributor.id }),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining('not found'),
      extensions: {
        code: 'NODE_NOT_FOUND',
        loc: 'org-a.repo.doesNotExist',
        memoryId: graphA.id,
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Mutation: replaceSubtree
// ---------------------------------------------------------------------------

describe('Mutation.replaceSubtree access control', () => {
  it('App with write access can replace', async () => {
    const count = await resolvers.Mutation.replaceSubtree(
      null,
      {
        ownerRepo: 'org-a/repo',
        memoryId: graphA.id,
        nodes: [
          { memoryId: graphA.id, loc: 'org-a.repo.replaced', name: 'replaced' },
        ],
        edges: [],
      },
      ctx({ appId: appContributor.id }),
    );
    expect(count).toBe(1);
  });

  // 007-entity-id-or-urn: replaceSubtree accepts memoryId as ID or URN.
  // (The nested NodeInput.memoryId is data shape for the new nodes —
  // also used via the same helper internally — but the top-level
  // memoryId is the convention's gating arg.)
  it('accepts a URN as the top-level memoryId input', async () => {
    const memoryRow = await db.memory.findUniqueOrThrow({
      where: { id: graphA.id },
      select: { urn: true },
    });
    const count = await resolvers.Mutation.replaceSubtree(
      null,
      {
        ownerRepo: 'org-a/repo',
        memoryId: memoryRow.urn,
        nodes: [
          { memoryId: graphA.id, loc: 'org-a.repo.replaced-by-urn', name: 'replaced-by-urn' },
        ],
        edges: [],
      },
      ctx({ appId: appContributor.id }),
    );
    expect(count).toBe(1);
  });

  it('App without write access is rejected', async () => {
    await expect(
      resolvers.Mutation.replaceSubtree(
        null,
        {
          ownerRepo: 'org-a/repo',
          memoryId: graphA.id,
          nodes: [],
          edges: [],
        },
        ctx({ appId: appReader.id }),
      ),
    ).rejects.toThrow('Forbidden');
  });

  it('App cannot replace subtree in other memory', async () => {
    await expect(
      resolvers.Mutation.replaceSubtree(
        null,
        {
          ownerRepo: 'org-b/repo',
          memoryId: graphB.id,
          nodes: [],
          edges: [],
        },
        ctx({ appId: appContributor.id }),
      ),
    ).rejects.toThrow('Forbidden');
  });

  // Regression: edge target resolution must be scoped to the memory. `loc` is
  // unique only within a memory, so a same-loc node in another memory must not
  // be picked up as the target.
  it('does not resolve an edge target from a different memory on a loc collision', async () => {
    // A node with this loc exists only in graph B.
    await createDbNode(db, { memoryId: graphB.id, loc: 'collision.loc', name: 'in-b' });

    await resolvers.Mutation.replaceSubtree(
      null,
      {
        ownerRepo: 'org-a/repo',
        memoryId: graphA.id,
        nodes: [{ memoryId: graphA.id, loc: 'collision.src', name: 'src' }],
        // Target loc exists only in graph B — must NOT resolve cross-memory.
        edges: [{ sourceLoc: 'collision.src', targetLoc: 'collision.loc', name: 'rel' }],
      },
      ctx({ appId: appContributor.id }),
    );

    const edges = await db.edge.findMany({ where: { memoryId: graphA.id } });
    expect(edges).toHaveLength(0);
    // And graph B's node must not have gained an incoming edge either.
    const bEdges = await db.edge.findMany({ where: { memoryId: graphB.id } });
    expect(bEdges).toHaveLength(0);
  });

  // Regression: NodeInput carries non-column fields (edges/createOnly/reason)
  // that Prisma would reject if spread into node.create.
  it('strips non-column NodeInput fields before creating nodes', async () => {
    const count = await resolvers.Mutation.replaceSubtree(
      null,
      {
        ownerRepo: 'org-a/repo',
        memoryId: graphA.id,
        nodes: [
          {
            memoryId: graphA.id,
            loc: 'org-a.repo.with-extras',
            name: 'with-extras',
            tags: ['alpha', 'beta'],
            edges: [{ targetId: 'ignored', name: 'x' }],
            createOnly: true,
            reason: 'import',
          },
        ],
        edges: [],
      },
      ctx({ appId: appContributor.id }),
    );
    expect(count).toBe(1);
    const created = await db.node.findFirstOrThrow({
      where: { memoryId: graphA.id, loc: 'org-a.repo.with-extras' },
    });
    expect(created.tags).toEqual(['alpha', 'beta']);
  });
});

// ---------------------------------------------------------------------------
// Global ADMIN bypass
// ---------------------------------------------------------------------------

describe('global ADMIN bypass', () => {
  it('ADMIN can read all nodes', async () => {
    const nodes = await resolvers.Query.nodes(
      null, {}, ctx({ roles: ['ADMIN'] }),
    );
    expect(nodes).toHaveLength(2);
  });

  it('ADMIN can write to any memory', async () => {
    const node = await resolvers.Mutation.upsertNode(
      null,
      { input: { memoryId: graphB.id, loc: 'org-b.repo.admin-node', name: 'admin' } },
      ctx({ clientId: 'github:admin', userId: 'admin-id', roles: ['ADMIN'] }),
    );
    expect(node.loc).toBe('org-b.repo.admin-node');
  });

  it('ADMIN can delete any node', async () => {
    const result = await resolvers.Mutation.deleteNode(
      null,
      { loc: 'org-b.repo.nodeB', memoryId: graphB.id },
      ctx({ clientId: 'github:admin', userId: 'admin-id', roles: ['ADMIN'] }),
    );
    expect(result).toBe(true);
  });
});
