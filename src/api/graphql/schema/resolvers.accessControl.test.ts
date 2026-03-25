import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph, createDbNode } from '../../../test/helpers.js';
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
let stationReader: { id: string };
let stationContributor: { id: string };

function ctx(overrides: Partial<Context> = {}): Context {
  return { db, ...overrides };
}

beforeEach(async () => {
  await cleanDb(db);

  // Org A with graph A
  const a = await createDbOrgAndGraph(db, { orgName: 'org-a', graphName: 'org-a/repo' });
  orgA = a.org;
  graphA = a.graph;

  // Org B with graph B
  const b = await createDbOrgAndGraph(db, { orgName: 'org-b', graphName: 'org-b/repo' });
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

  // Create an agent in org A and add graph A
  const agent = await db.agent.create({
    data: { organizationId: orgA.id, urn: 'org-a:default-agent', name: 'default-agent' },
  });
  await db.agentMemoryItem.create({
    data: { agentId: agent.id, memoryId: graphA.id },
  });

  // Station with READER role subscribed to agent (READ_ONLY)
  stationReader = await db.station.create({
    data: {
      name: 'reader-station',
      urn: 'org-a:reader-station',
      keyHash: 'not-used-in-resolver-tests',
      role: 'READER',
      stationType: 'WORKSTATION',
      organizationId: orgA.id,
    },
  });
  await db.stationAgentSubscription.create({
    data: { stationId: stationReader.id, agentId: agent.id, subscriptionType: 'READ_ONLY' },
  });

  // Station with CONTRIBUTOR role subscribed to agent (READ_WRITE)
  stationContributor = await db.station.create({
    data: {
      name: 'contributor-station',
      urn: 'org-a:contributor-station',
      keyHash: 'not-used-in-resolver-tests',
      role: 'CONTRIBUTOR',
      stationType: 'AGENT',
      organizationId: orgA.id,
    },
  });
  await db.stationAgentSubscription.create({
    data: { stationId: stationContributor.id, agentId: agent.id, subscriptionType: 'READ_WRITE' },
  });

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

  it('station with agent subscription sees only subscribed graphs', async () => {
    const nodes = await resolvers.Query.nodes(
      null, {}, ctx({ clientId: stationReader.id, roles: ['READER'] }),
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0].loc).toBe('org-a.repo.nodeA');
  });

  it('station with no subscriptions sees nothing', async () => {
    const noSubStation = await db.station.create({
      data: {
        name: 'no-sub-station',
        urn: 'no-sub-station',
        keyHash: 'not-used',
        role: 'READER',
        stationType: 'WORKSTATION',
      },
    });
    const nodes = await resolvers.Query.nodes(
      null, {}, ctx({ clientId: noSubStation.id, roles: ['READER'] }),
    );
    expect(nodes).toHaveLength(0);
  });

  it('unauthenticated sees only public graph nodes', async () => {
    // Make graph B public
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
  it('returns node when caller has access', async () => {
    const node = await resolvers.Query.node(
      null, { loc: 'org-a.repo.nodeA' },
      ctx({ clientId: stationReader.id, roles: ['READER'] }),
    );
    expect(node).not.toBeNull();
    expect(node!.loc).toBe('org-a.repo.nodeA');
  });

  it('returns null when caller lacks access', async () => {
    const node = await resolvers.Query.node(
      null, { loc: 'org-b.repo.nodeB' },
      ctx({ clientId: stationReader.id, roles: ['READER'] }),
    );
    expect(node).toBeNull();
  });

  it('returns null for non-existent node', async () => {
    const node = await resolvers.Query.node(
      null, { loc: 'does.not.exist' },
      ctx({ clientId: stationReader.id, roles: ['READER'] }),
    );
    expect(node).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Query: subtree
// ---------------------------------------------------------------------------

describe('Query.subtree access control', () => {
  it('filters subtree results by accessible graphs', async () => {
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

describe('cross-org graph subscription access', () => {
  it('user sees nodes from subscribed cross-org graphs', async () => {
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
  it('station with READ_WRITE subscription can write', async () => {
    const node = await resolvers.Mutation.upsertNode(
      null,
      { input: { memoryId: graphA.id, loc: 'org-a.repo.new', name: 'new' } },
      ctx({ clientId: stationContributor.id, roles: ['CONTRIBUTOR'] }),
    );
    expect(node.loc).toBe('org-a.repo.new');
  });

  it('station with READ_ONLY subscription is rejected', async () => {
    await expect(
      resolvers.Mutation.upsertNode(
        null,
        { input: { memoryId: graphA.id, loc: 'org-a.repo.new2', name: 'new2' } },
        ctx({ clientId: stationReader.id, roles: ['CONTRIBUTOR'] }),
      ),
    ).rejects.toThrow('Forbidden');
  });

  it('station with READER role is rejected even with READ_WRITE subscription', async () => {
    // Create a READER station with READ_WRITE agent subscription
    const agent = await db.agent.findFirst({ where: { organizationId: orgA.id } });
    const readerStation = await db.station.create({
      data: { name: 'reader-rw', urn: 'reader-rw', keyHash: 'x', role: 'READER', stationType: 'WORKSTATION' },
    });
    await db.stationAgentSubscription.create({
      data: { stationId: readerStation.id, agentId: agent!.id, subscriptionType: 'READ_WRITE' },
    });
    await expect(
      resolvers.Mutation.upsertNode(
        null,
        { input: { memoryId: graphA.id, loc: 'org-a.repo.rdr', name: 'rdr' } },
        ctx({ clientId: readerStation.id, roles: ['READER'] }),
      ),
    ).rejects.toThrow('Forbidden');
  });

  it('station cannot write to graph outside its subscriptions', async () => {
    await expect(
      resolvers.Mutation.upsertNode(
        null,
        { input: { memoryId: graphB.id, loc: 'org-b.repo.hack', name: 'hack' } },
        ctx({ clientId: stationContributor.id, roles: ['CONTRIBUTOR'] }),
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
  it('station with write access can delete', async () => {
    const result = await resolvers.Mutation.deleteNode(
      null,
      { loc: 'org-a.repo.nodeA', memoryId: graphA.id },
      ctx({ clientId: stationContributor.id, roles: ['CONTRIBUTOR'] }),
    );
    expect(result).toBe(true);
  });

  it('station without write access is rejected', async () => {
    await expect(
      resolvers.Mutation.deleteNode(
        null,
        { loc: 'org-a.repo.nodeA', memoryId: graphA.id },
        ctx({ clientId: stationReader.id, roles: ['CONTRIBUTOR'] }),
      ),
    ).rejects.toThrow('Forbidden');
  });

  it('station cannot delete nodes in other graphs', async () => {
    await expect(
      resolvers.Mutation.deleteNode(
        null,
        { loc: 'org-b.repo.nodeB', memoryId: graphB.id },
        ctx({ clientId: stationContributor.id, roles: ['CONTRIBUTOR'] }),
      ),
    ).rejects.toThrow('Forbidden');
  });
});

// ---------------------------------------------------------------------------
// Mutation: moveNode
// ---------------------------------------------------------------------------

describe('Mutation.moveNode access control', () => {
  it('station with write access can move', async () => {
    const node = await resolvers.Mutation.moveNode(
      null,
      { from: 'org-a.repo.nodeA', to: 'org-a.repo.movedNode', memoryId: graphA.id },
      ctx({ clientId: stationContributor.id, roles: ['CONTRIBUTOR'] }),
    );
    expect(node.loc).toBe('org-a.repo.movedNode');
  });

  it('station cannot move nodes in inaccessible graphs', async () => {
    await expect(
      resolvers.Mutation.moveNode(
        null,
        { from: 'org-b.repo.nodeB', to: 'org-b.repo.moved', memoryId: graphB.id },
        ctx({ clientId: stationContributor.id, roles: ['CONTRIBUTOR'] }),
      ),
    ).rejects.toThrow('Forbidden');
  });

});

// ---------------------------------------------------------------------------
// Mutation: replaceSubtree
// ---------------------------------------------------------------------------

describe('Mutation.replaceSubtree access control', () => {
  it('station with write access can replace', async () => {
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
      ctx({ clientId: stationContributor.id, roles: ['CONTRIBUTOR'] }),
    );
    expect(count).toBe(1);
  });

  it('station without write access is rejected', async () => {
    await expect(
      resolvers.Mutation.replaceSubtree(
        null,
        {
          ownerRepo: 'org-a/repo',
          memoryId: graphA.id,
          nodes: [],
          edges: [],
        },
        ctx({ clientId: stationReader.id, roles: ['CONTRIBUTOR'] }),
      ),
    ).rejects.toThrow('Forbidden');
  });

  it('station cannot replace subtree in other graph', async () => {
    await expect(
      resolvers.Mutation.replaceSubtree(
        null,
        {
          ownerRepo: 'org-b/repo',
          memoryId: graphB.id,
          nodes: [],
          edges: [],
        },
        ctx({ clientId: stationContributor.id, roles: ['CONTRIBUTOR'] }),
      ),
    ).rejects.toThrow('Forbidden');
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

  it('ADMIN can write to any graph', async () => {
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
