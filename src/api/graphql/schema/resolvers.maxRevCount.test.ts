/**
 * Integration tests for Memory.maxRevCount (#621) — the per-node cap on
 * retained NodeRevision rows. Every node update snapshots the pre-edit state;
 * createNodeRevision prunes the oldest overflow beyond the memory's
 * maxRevCount (default 10).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let org: { id: string; urn: string };
let admin: { id: string };
let memory: { id: string; urn: string };

function ctx(overrides: Partial<Context> = {}): Context {
  return { db, roles: ['ADMIN'], userId: admin.id, ...overrides };
}

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({
    data: { id: generateId(), name: 'mrc-org', urn: 'mrc-org' },
  });
  admin = await db.user.create({
    data: { githubId: 6210, githubUsername: 'mrc-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  memory = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:mem`, name: 'mem', class: 'knowledge' },
  });
});

async function makeNode(loc: string) {
  return db.node.create({
    data: { id: generateId(), memoryId: memory.id, loc, name: loc, nodeType: 'info', content: 'c0' },
  });
}

async function updateContent(id: string, content: string) {
  await resolvers.Mutation.updateNode({}, { input: { id, content } } as never, ctx());
}

describe('Memory.maxRevCount default + column', () => {
  it('a created memory defaults to maxRevCount 10', async () => {
    const m = await resolvers.Mutation.createMemory(
      {}, { orgId: org.id, name: 'defcap' }, ctx(),
    );
    expect(m.maxRevCount).toBe(10);
  });

  it('createMemory accepts an explicit maxRevCount', async () => {
    const m = await resolvers.Mutation.createMemory(
      {}, { orgId: org.id, name: 'capped', maxRevCount: 5 }, ctx(),
    );
    expect(m.maxRevCount).toBe(5);
  });
});

describe('NodeRevision pruning (#621)', () => {
  it('caps history at the default (10), pruning the oldest', async () => {
    const n = await makeNode('guide');
    // 12 updates → 12 pre-edit snapshots (c0..c11), pruned to the newest 10.
    for (let i = 1; i <= 12; i++) await updateContent(n.id, `c${i}`);

    const revs = await db.nodeRevision.findMany({ where: { nodeId: n.id } });
    expect(revs).toHaveLength(10);
    const contents = revs.map((r) => r.content);
    // The two oldest snapshots were pruned.
    expect(contents).not.toContain('c0');
    expect(contents).not.toContain('c1');
    // A recent snapshot is retained.
    expect(contents).toContain('c11');
  });

  it('honors a lower cap set via updateMemory', async () => {
    await resolvers.Mutation.updateMemory({}, { id: memory.id, maxRevCount: 3 }, ctx());
    const n = await makeNode('small');
    for (let i = 1; i <= 5; i++) await updateContent(n.id, `c${i}`);

    expect(await db.nodeRevision.count({ where: { nodeId: n.id } })).toBe(3);
  });

  it('prunes pre-existing overflow when the cap is lowered, on the next write', async () => {
    const n = await makeNode('shrink');
    // Build up 10 revisions at the default cap.
    for (let i = 1; i <= 10; i++) await updateContent(n.id, `c${i}`);
    expect(await db.nodeRevision.count({ where: { nodeId: n.id } })).toBe(10);

    // Lower the cap, then a single further write prunes the whole overflow.
    await resolvers.Mutation.updateMemory({}, { id: memory.id, maxRevCount: 2 }, ctx());
    await updateContent(n.id, 'c11');
    expect(await db.nodeRevision.count({ where: { nodeId: n.id } })).toBe(2);
  });

  it('does not prune below the cap for a low-churn node', async () => {
    const n = await makeNode('quiet');
    for (let i = 1; i <= 3; i++) await updateContent(n.id, `c${i}`);
    expect(await db.nodeRevision.count({ where: { nodeId: n.id } })).toBe(3);
  });
});

describe('maxRevCount validation', () => {
  it('rejects maxRevCount < 1 on updateMemory', async () => {
    await expect(
      resolvers.Mutation.updateMemory({}, { id: memory.id, maxRevCount: 0 }, ctx()),
    ).rejects.toThrow(/at least 1/);
  });

  it('rejects maxRevCount < 1 on createMemory', async () => {
    await expect(
      resolvers.Mutation.createMemory({}, { orgId: org.id, name: 'bad', maxRevCount: 0 }, ctx()),
    ).rejects.toThrow(/at least 1/);
  });
});
