import { transportRateIdentity } from '../../../lib/rateLimit/identity.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import {
  cleanDb,
  createDbOrgAndGraph,
  createDbNode,
  createDbAppWithKey,
  createDbAppAgent,
  createDbAppMember,
} from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { buildSchema } from 'graphql';
import { typeDefs } from './typeDefs.js';

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
// #1376: an App key with no user behind it is not admitted by its Agent's item; writes and the
// item's cap are proven through an App member (a user behind the request).
let appMember: { id: string };

function ctx(overrides: Partial<Context> = {}): Context {
  // #1793: these direct resolver fixtures represent an anonymous/authenticated HTTP caller, not an empty internal context.
  return { db, limiterIdentity: transportRateIdentity(overrides, '192.0.2.10'), ...overrides };
}

// findNodes replaced the deleted Query.nodes. It returns a hit envelope; the
// access-scoping (getAccessibleMemoryIds) is identical, so this helper adapts
// the result shape back to a plain Node[] for the assertions below.
async function listNodes(args: any, ctx: any) {
  const res = await resolvers.Query.findNodes(null, args, ctx);
  return res.hits.map((h) => h.node);
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

  appMember = await db.user.create({
    data: { githubId: 1003, githubUsername: 'app-member', roles: ['READER'] },
  });
  await createDbAppMember(db, appReader.id, appMember.id);
  await createDbAppMember(db, appContributor.id, appMember.id);

  // Seed nodes
  await createDbNode(db, { loc: 'org-a.repo.nodeA', memoryId: graphA.id });
  await createDbNode(db, { loc: 'org-b.repo.nodeB', memoryId: graphB.id });
});

// ---------------------------------------------------------------------------
// Query: nodes
// ---------------------------------------------------------------------------

describe('findNodes access control', () => {
  it('global ADMIN sees all nodes', async () => {
    const nodes = await listNodes(
      {}, ctx({ clientId: 'github:admin', userId: 'x', roles: ['ADMIN'] }),
    );
    expect(nodes).toHaveLength(2);
  });

  it('user A sees only org A nodes', async () => {
    const nodes = await listNodes(
      {}, ctx({ clientId: `github:${userA.id}`, userId: userA.id, roles: ['READER'] }),
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0].loc).toBe('org-a.repo.nodeA');
  });

  it('user B sees only org B nodes', async () => {
    const nodes = await listNodes(
      {}, ctx({ clientId: `github:${userB.id}`, userId: userB.id, roles: ['READER'] }),
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0].loc).toBe('org-b.repo.nodeB');
  });

  it('App-keyed caller (no session, no user) does NOT see its agent-linked org memory — an item is a limit, never a grant (#1376)', async () => {
    const nodes = await listNodes(
      {}, ctx({ appId: appReader.id }),
    );
    expect(nodes).toHaveLength(0);
  });

  it('App member (user behind the App key) sees its agent-linked memories — same getAppMemoryAccess reach as the MCP read gates (the pre-fix [] made every MCP find_nodes delegation return empty)', async () => {
    const nodes = await listNodes(
      {}, ctx({ appId: appReader.id, userId: appMember.id }),
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0].loc).toBe('org-a.repo.nodeA');
  });

  it('App-keyed caller (no session) never reaches another org\'s memories', async () => {
    const nodes = await listNodes(
      { filter: { memoryIds: [graphB.id] } }, ctx({ appId: appReader.id }),
    );
    expect(nodes).toHaveLength(0);
  });

  it('unauthenticated sees only public memory nodes', async () => {
    await db.memory.update({ where: { id: graphB.id }, data: { visibility: 'PUBLIC' } });
    const nodes = await listNodes({}, ctx());
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
      null, { ref: 'org-a.repo.nodeA' },
      ctx({ roles: ['ADMIN'] }),
    );
    expect(node).not.toBeNull();
    expect(node!.loc).toBe('org-a.repo.nodeA');
  });

  it('returns null for non-existent node', async () => {
    const node = await resolvers.Query.node(
      null, { ref: 'does.not.exist' },
      ctx({ roles: ['ADMIN'] }),
    );
    expect(node).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Query: subtree
// ---------------------------------------------------------------------------

describe('findNodes locPrefix access control (the former subtree query)', () => {
  it('filters prefix results by accessible memories', async () => {
    const result = await resolvers.Query.findNodes(
      null, { filter: { locPrefix: 'org-' } },
      ctx({ clientId: `github:${userA.id}`, userId: userA.id, roles: ['READER'] }),
    );
    // User A only has access to org A, even though prefix matches both
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].node.loc).toBe('org-a.repo.nodeA');
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
    const nodes = await listNodes(
      {}, ctx({ clientId: `github:${userB.id}`, userId: userB.id, roles: ['READER'] }),
    );
    // User B sees org B nodes + subscribed graph A nodes
    expect(nodes).toHaveLength(2);
    const locs = nodes.map((n: any) => n.loc).sort();
    expect(locs).toEqual(['org-a.repo.nodeA', 'org-b.repo.nodeB']);
  });
});

// ---------------------------------------------------------------------------
// Mutation: createNode
// ---------------------------------------------------------------------------

describe('Mutation.createNode access control', () => {
  it('App with READ_WRITE AppAgent can write', async () => {
    const node = await resolvers.Mutation.createNode(
      null,
      { input: { memoryId: graphA.id, loc: 'org-a.repo.new', name: 'new' } },
      ctx({ appId: appContributor.id, userId: appMember.id }),
    );
    expect(node.loc).toBe('org-a.repo.new');
  });

  it('App with READ_ONLY AppAgent is rejected', async () => {
    await expect(
      resolvers.Mutation.createNode(
        null,
        { input: { memoryId: graphA.id, loc: 'org-a.repo.new2', name: 'new2' } },
        ctx({ appId: appReader.id, userId: appMember.id }),
      ),
    ).rejects.toThrow('Forbidden');
  });

  it('conceals a memory outside the App\'s readable AppAgent rows', async () => {
    await expect(
      resolvers.Mutation.createNode(
        null,
        { input: { memoryId: graphB.id, loc: 'org-b.repo.hack', name: 'hack' } },
        ctx({ appId: appContributor.id }),
      ),
    ).rejects.toThrow('MEMORY_NOT_FOUND');
  });

  it('user with CONTRIBUTOR org role can write', async () => {
    const node = await resolvers.Mutation.createNode(
      null,
      { input: { memoryId: graphA.id, loc: 'org-a.repo.user-node', name: 'un' } },
      ctx({ clientId: `github:user-a`, userId: userA.id, roles: ['READER'] }),
    );
    expect(node.loc).toBe('org-a.repo.user-node');
  });

  it('user with READER org role is rejected', async () => {
    await expect(
      resolvers.Mutation.createNode(
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
    const target = await db.node.findFirstOrThrow({
      where: { loc: 'org-a.repo.nodeA', memoryId: graphA.id },
    });
    const result = await resolvers.Mutation.deleteNode(
      null,
      { nodeRef: target.id },
      ctx({ appId: appContributor.id, userId: appMember.id }),
    );
    expect(result).toBe(true);
  });

  it('App without write access is rejected', async () => {
    const target = await db.node.findFirstOrThrow({
      where: { loc: 'org-a.repo.nodeA', memoryId: graphA.id },
    });
    await expect(
      resolvers.Mutation.deleteNode(
        null,
        { nodeRef: target.id },
        ctx({ appId: appReader.id, userId: appMember.id }),
      ),
    ).rejects.toThrow('Forbidden');
  });

  it('App cannot delete nodes in inaccessible memories', async () => {
    const target = await db.node.findFirstOrThrow({
      where: { loc: 'org-b.repo.nodeB', memoryId: graphB.id },
    });
    // #1316: the App cannot read this memory, so the denial answers exactly as
    // a missing node does. It used to be `Forbidden`, which confirmed the node
    // existed to a caller who could not read it.
    await expect(
      resolvers.Mutation.deleteNode(
        null,
        { nodeRef: target.id },
        ctx({ appId: appContributor.id }),
      ),
    ).rejects.toThrow(`Node not found: "${target.id}"`);
    expect(await db.node.findUnique({ where: { id: target.id }, select: { deletedAt: true } })).toEqual({
      deletedAt: null,
    });
  });

  // 007-entity-id-or-urn (#542): deleteNode's nodeRef also accepts a
  // fully-qualified node URN (`<memory-urn>:<loc>`), not just a bare ID.
  it('accepts a node URN as nodeRef input', async () => {
    const memoryRow = await db.memory.findUniqueOrThrow({
      where: { id: graphA.id },
      select: { urn: true },
    });
    const result = await resolvers.Mutation.deleteNode(
      null,
      { nodeRef: `${memoryRow.urn}:org-a.repo.nodeA` },
      ctx({ appId: appContributor.id, userId: appMember.id }),
    );
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Mutation: moveNode
// ---------------------------------------------------------------------------

describe('Mutation.moveNode access control (#564 sourceRef/targetUrn)', () => {
  // targetUrn is the full destination node URN: <memoryUrn>:<loc>. graphA's
  // stored urn is `org-a:org-a/repo`, graphB's `org-b:org-b/repo`.
  const targetInA = (loc: string) => `org-a:org-a/repo:${loc}`;
  const targetInB = (loc: string) => `org-b:org-b/repo:${loc}`;
  const nodeAId = () =>
    db.node.findFirstOrThrow({ where: { loc: 'org-a.repo.nodeA', memoryId: graphA.id }, select: { id: true } }).then((n) => n.id);
  const nodeBId = () =>
    db.node.findFirstOrThrow({ where: { loc: 'org-b.repo.nodeB', memoryId: graphB.id }, select: { id: true } }).then((n) => n.id);

  it('App with write access can move (by node id)', async () => {
    const node = await resolvers.Mutation.moveNode(
      null,
      { sourceRef: await nodeAId(), targetUrn: targetInA('org-a.repo.movedNode') },
      ctx({ appId: appContributor.id, userId: appMember.id }),
    );
    expect(node.loc).toBe('org-a.repo.movedNode');
  });

  it('App cannot move nodes in inaccessible memories', async () => {
    // #1381: the App can neither write nor read this memory, so its node
    // answers as a missing one — `Forbidden` confirmed that it exists.
    const sourceRef = await nodeBId();
    await expect(
      resolvers.Mutation.moveNode(
        null,
        { sourceRef, targetUrn: targetInB('org-b.repo.moved') },
        ctx({ appId: appContributor.id }),
      ),
    ).rejects.toThrow(`Node not found: "${sourceRef}"`);
  });

  // 007-entity-id-or-urn: sourceRef accepts a fully-qualified URN, not just a PK.
  it('accepts a URN as sourceRef input', async () => {
    const node = await resolvers.Mutation.moveNode(
      null,
      { sourceRef: 'org-a:org-a/repo:org-a.repo.nodeA', targetUrn: targetInA('org-a.repo.movedByUrn') },
      ctx({ appId: appContributor.id, userId: appMember.id }),
    );
    expect(node.loc).toBe('org-a.repo.movedByUrn');
  });

  it('throws NODE_NOT_FOUND when the source node does not exist', async () => {
    await expect(
      resolvers.Mutation.moveNode(
        null,
        { sourceRef: 'org-a:org-a/repo:org-a.repo.doesNotExist', targetUrn: targetInA('org-a.repo.target') },
        ctx({ appId: appContributor.id }),
      ),
    ).rejects.toMatchObject({
      extensions: { code: 'NODE_NOT_FOUND' },
    });
  });
});

// ---------------------------------------------------------------------------
// Mutation: replaceSubtree
// ---------------------------------------------------------------------------

describe('Mutation.replaceSubtree retirement (#454)', () => {
  it('advertises the retirement to introspection and codegen via @deprecated', () => {
    // The field is kept so old clients get a typed refusal rather than an
    // unknown-field error; @deprecated is what tells codegen and GraphQL
    // tooling not to build new callers against it.
    const field = buildSchema(typeDefs).getMutationType()!.getFields().replaceSubtree;
    expect(field).toBeDefined();
    expect(field.deprecationReason).toContain('REPLACE_SUBTREE_RETIRED');
  });

  it('refuses authorized ID and URN calls before any node, edge, or history change', async () => {
    const ownerRepo = 'org-a/repo';
    const ordinary = await createDbNode(db, {
      memoryId: graphA.id, loc: 'bulk.ordinary', name: 'ordinary', ownerRepo, content: 'original',
    });
    const runnable = await createDbNode(db, {
      memoryId: graphA.id, loc: 'bulk.runnable', name: 'runnable', ownerRepo, isRunnable: true,
    });
    const governed = await createDbNode(db, {
      memoryId: graphA.id, loc: 'bulk.governed', name: 'governed', ownerRepo,
    });
    await db.node.update({ where: { id: governed.id }, data: { role: 'task' } });
    const edge = await db.edge.create({
      data: {
        memoryId: graphA.id, sourceId: ordinary.id, targetId: runnable.id,
        loc: 'bulk.ordinary:rel:bulk.runnable', name: 'rel',
      },
    });
    const history = await db.nodeRevision.create({
      data: {
        nodeId: ordinary.id, memoryId: graphA.id, loc: ordinary.loc, name: ordinary.name,
        tags: [], changes: [], revNo: 1, content: 'original',
      },
    });
    const before = await db.node.findMany({ where: { memoryId: graphA.id }, orderBy: { loc: 'asc' } });
    const { urn } = await db.memory.findUniqueOrThrow({ where: { id: graphA.id }, select: { urn: true } });

    for (const memoryId of [graphA.id, urn]) {
      await expect(resolvers.Mutation.replaceSubtree(
        null,
        {
          ownerRepo, memoryId,
          nodes: [
            { memoryId: graphA.id, loc: 'bulk.new', name: 'new', content: 'replacement' },
            { memoryId: graphA.id, loc: 'bulk.new-runnable', name: 'new-runnable', isRunnable: true },
            { memoryId: graphA.id, loc: 'bulk.new-governed', name: 'new-governed', role: 'task' },
          ],
          edges: [{ sourceLoc: 'bulk.new', targetLoc: 'bulk.new-runnable', name: 'rel' }],
        },
        ctx({ appId: appContributor.id, userId: appMember.id }),
      )).rejects.toMatchObject({ extensions: { code: 'REPLACE_SUBTREE_RETIRED' } });
    }

    expect(await db.node.findMany({ where: { memoryId: graphA.id }, orderBy: { loc: 'asc' } })).toEqual(before);
    expect(await db.nodeRevision.findUnique({ where: { id: history.id } })).toMatchObject({ content: 'original' });
    expect(await db.nodeRevision.count({ where: { nodeId: ordinary.id } })).toBe(1);
    expect(await db.edge.findUnique({ where: { id: edge.id } })).toMatchObject({ sourceId: ordinary.id, targetId: runnable.id });
    expect(await db.node.findUnique({ where: { id: governed.id } })).toMatchObject({ role: 'task' });
  });

  it('preserves write authorization and concealed-memory errors', async () => {
    await expect(resolvers.Mutation.replaceSubtree(
      null, { ownerRepo: 'org-a/repo', memoryId: graphA.id, nodes: [], edges: [] },
      ctx({ appId: appReader.id, userId: appMember.id }),
    )).rejects.toThrow('Forbidden');
    await expect(resolvers.Mutation.replaceSubtree(
      null, { ownerRepo: 'org-b/repo', memoryId: graphB.id, nodes: [], edges: [] },
      ctx({ appId: appContributor.id, userId: appMember.id }),
    )).rejects.toThrow(`MEMORY_NOT_FOUND: ${graphB.id}`);
  });
});

// ---------------------------------------------------------------------------
// Global ADMIN bypass
// ---------------------------------------------------------------------------

describe('global ADMIN bypass', () => {
  it('ADMIN can read all nodes', async () => {
    const nodes = await listNodes(
      {}, ctx({ roles: ['ADMIN'] }),
    );
    expect(nodes).toHaveLength(2);
  });

  it('ADMIN can write to any memory', async () => {
    const node = await resolvers.Mutation.createNode(
      null,
      { input: { memoryId: graphB.id, loc: 'org-b.repo.admin-node', name: 'admin' } },
      ctx({ clientId: 'github:admin', userId: 'admin-id', roles: ['ADMIN'] }),
    );
    expect(node.loc).toBe('org-b.repo.admin-node');
  });

  it('ADMIN can delete any node', async () => {
    const target = await db.node.findFirstOrThrow({
      where: { loc: 'org-b.repo.nodeB', memoryId: graphB.id },
    });
    const result = await resolvers.Mutation.deleteNode(
      null,
      { nodeRef: target.id },
      ctx({ clientId: 'github:admin', userId: 'admin-id', roles: ['ADMIN'] }),
    );
    expect(result).toBe(true);
  });
});
