import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph, createDbNode } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

// Prevent git writes
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let orgA: { id: string };
let memA1: { id: string; urn: string };
let memA2: { id: string };
let orgB: { id: string };
let memB: { id: string };
let userA: { id: string };

function ctx(overrides: Partial<Context> = {}): Context {
  return { db, ...overrides };
}

function userActx(): Context {
  return ctx({ clientId: 'github:user-a', userId: userA.id, roles: ['READER'] });
}

beforeEach(async () => {
  await cleanDb(db);

  const a = await createDbOrgAndGraph(db, { orgName: 'org-a', graphName: 'org-a/mem-one', visibility: 'ORGANIZATION' });
  orgA = a.org;
  memA1 = a.graph;
  memA2 = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: orgA.id,
      urn: 'org-a:mem-two',
      name: 'mem-two',
      class: 'knowledge',
      visibility: 'ORGANIZATION',
    },
  });

  const b = await createDbOrgAndGraph(db, { orgName: 'org-b', graphName: 'org-b/mem', visibility: 'ORGANIZATION' });
  orgB = b.org;
  memB = b.graph;

  userA = await db.user.create({
    data: { githubId: 2001, githubUsername: 'user-a', roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { organizationId: orgA.id, userId: userA.id, role: 'CONTRIBUTOR' },
  });

  await createDbNode(db, { loc: 'one', memoryId: memA1.id });
  await createDbNode(db, { loc: 'two', memoryId: memA2.id });
  await createDbNode(db, { loc: 'other-org', memoryId: memB.id });
});

describe('Query.nodes memory filter', () => {
  it('scopes to a single memory by ID', async () => {
    const nodes = await resolvers.Query.nodes(null, { memory: memA1.id }, userActx());
    expect(nodes).toHaveLength(1);
    expect(nodes[0].loc).toBe('one');
  });

  it('scopes to a single memory by URN', async () => {
    const nodes = await resolvers.Query.nodes(null, { memory: memA1.urn }, userActx());
    expect(nodes).toHaveLength(1);
    expect(nodes[0].loc).toBe('one');
  });

  it('without the filter returns nodes from all accessible memories', async () => {
    const nodes = await resolvers.Query.nodes(null, {}, userActx());
    expect(nodes).toHaveLength(2);
  });

  it('intersects with the access filter: scoping to an inaccessible memory yields []', async () => {
    const nodes = await resolvers.Query.nodes(null, { memory: memB.id }, userActx());
    expect(nodes).toHaveLength(0);
  });

  it('memory + tags compose without dropping the memory scope', async () => {
    // Regression guard for AND-clause composition: tagsFilter emits
    // { AND: [...] } on SQLite, which would collide with a memory
    // scope expressed as a separate AND key and silently widen the
    // result set back to every accessible memory.
    await createDbNode(db, { loc: 'tagged-one', memoryId: memA1.id, tags: ['t1'] });
    await createDbNode(db, { loc: 'tagged-two', memoryId: memA2.id, tags: ['t1'] });
    const nodes = await resolvers.Query.nodes(
      null, { memory: memA1.id, tags: ['t1'] }, userActx(),
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0].loc).toBe('tagged-one');
  });

  it('unknown memory ref throws', async () => {
    await expect(
      resolvers.Query.nodes(null, { memory: 'org-a:does-not-exist' }, userActx()),
    ).rejects.toThrow();
  });
});

describe('Query.nodes memoryIds (plural) filter — issue #355', () => {
  it('scopes to a SET of memories by id', async () => {
    const nodes = await resolvers.Query.nodes(
      null, { memoryIds: [memA1.id, memA2.id] }, userActx(),
    );
    expect(nodes.map((n) => n.loc).sort()).toEqual(['one', 'two']);
  });

  it('scopes to a subset of the accessible memories', async () => {
    const nodes = await resolvers.Query.nodes(null, { memoryIds: [memA2.id] }, userActx());
    expect(nodes).toHaveLength(1);
    expect(nodes[0].loc).toBe('two');
  });

  it('intersects with the access filter: inaccessible ids are silently dropped', async () => {
    // memB belongs to org-b, which userA cannot read. The whole search must
    // not fail — the inaccessible id is simply dropped from the set.
    const nodes = await resolvers.Query.nodes(
      null, { memoryIds: [memA1.id, memB.id] }, userActx(),
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0].loc).toBe('one');
  });

  it('takes precedence over the singular `memory` arg when both are supplied', async () => {
    const nodes = await resolvers.Query.nodes(
      null, { memory: memA1.id, memoryIds: [memA2.id] }, userActx(),
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0].loc).toBe('two');
  });

  it('an empty memoryIds array falls through to all accessible memories', async () => {
    const nodes = await resolvers.Query.nodes(null, { memoryIds: [] }, userActx());
    expect(nodes).toHaveLength(2);
  });

  it('accepts fully-qualified URNs as well as IDs', async () => {
    const nodes = await resolvers.Query.nodes(
      null, { memoryIds: [memA1.urn, memA2.id] }, userActx(),
    );
    expect(nodes.map((n) => n.loc).sort()).toEqual(['one', 'two']);
  });

  it('silently drops unresolvable refs instead of throwing', async () => {
    const nodes = await resolvers.Query.nodes(
      null, { memoryIds: [memA1.id, 'org-a:does-not-exist'] }, userActx(),
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0].loc).toBe('one');
  });
});

describe('Query.nodes isRunnable filter — cor:api:060', () => {
  beforeEach(async () => {
    await createDbNode(db, { loc: 'task-one', memoryId: memA1.id, isRunnable: true });
    await createDbNode(db, { loc: 'not-runnable', memoryId: memA1.id, isRunnable: false });
  });

  it('isRunnable=true returns only runnable task nodes', async () => {
    const nodes = await resolvers.Query.nodes(
      null, { memory: memA1.id, isRunnable: true }, userActx(),
    );
    expect(nodes.map((n) => n.loc).sort()).toEqual(['task-one']);
  });

  it('isRunnable=false returns only strictly-false nodes (not the NULL majority)', async () => {
    const nodes = await resolvers.Query.nodes(
      null, { memory: memA1.id, isRunnable: false }, userActx(),
    );
    expect(nodes.map((n) => n.loc).sort()).toEqual(['not-runnable']);
  });

  it('omitting the filter returns nodes regardless of runnable status', async () => {
    const nodes = await resolvers.Query.nodes(
      null, { memory: memA1.id }, userActx(),
    );
    // 'one' (from the outer beforeEach, isRunnable NULL) + the two added here.
    expect(nodes.map((n) => n.loc).sort()).toEqual(['not-runnable', 'one', 'task-one']);
  });

  it('composes with memoryIds scope', async () => {
    await createDbNode(db, { loc: 'task-two', memoryId: memA2.id, isRunnable: true });
    const nodes = await resolvers.Query.nodes(
      null, { memoryIds: [memA1.id, memA2.id], isRunnable: true }, userActx(),
    );
    expect(nodes.map((n) => n.loc).sort()).toEqual(['task-one', 'task-two']);
  });
});
