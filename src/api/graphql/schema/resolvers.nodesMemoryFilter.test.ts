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

  it('unknown memory ref throws', async () => {
    await expect(
      resolvers.Query.nodes(null, { memory: 'org-a:does-not-exist' }, userActx()),
    ).rejects.toThrow();
  });
});
