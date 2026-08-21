/**
 * #1061 — the read/write surfaces actually record usage events.
 *
 * Regression cover for the defect these tests exist because of: before #1061
 * only four MCP tools emitted `read`/`write` UsageEvents, so the Usage Activity
 * chart under-reported by roughly an order of magnitude. Every case below is a
 * surface that recorded NOTHING at the time it was written.
 *
 * These assert the COUNT and the ATTRIBUTION, not the aggregation — the
 * bucketing is `resolvers.usageActivity.test.ts`'s job. Recording is
 * fire-and-forget by contract, so each assertion polls briefly rather than
 * reading immediately: the insert is deliberately not awaited by the resolver.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resolvers } from './resolvers.js';
import type { Context } from './resolvers.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';

const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;

let mem: { id: string; urn: string };
let user: { id: string };
let admin: { id: string };
let orgId: string;

const asUser = (): Context =>
  ({ db, userId: user.id, clientId: `github:ur-user`, roles: ['CONTRIBUTOR'] }) as Context;

/**
 * Events of `type` attributed to the test user, waited for.
 *
 * `recordNodeUsage` is fire-and-forget by contract (metering must never delay
 * the work it measures), so the row lands shortly AFTER the resolver returns.
 * Polling is the honest way to observe that — an immediate read would be
 * testing scheduler luck, and a bare `await` would be asserting a contract the
 * module deliberately does not offer.
 */
const eventsOfType = async (
  type: 'read' | 'write',
  opts: { minCount?: number; userId?: string | null } = {},
): Promise<Array<{ nodeId: string | null; nodeLoc: string | null; memoryId: string | null; userId: string | null; sessionId: string | null }>> => {
  const want = opts.minCount ?? 1;
  const where = {
    type,
    ...(opts.userId === undefined ? { userId: user.id } : { userId: opts.userId }),
  };
  for (let i = 0; i < 50; i++) {
    const rows = await db.usageEvent.findMany({
      where,
      select: { nodeId: true, nodeLoc: true, memoryId: true, userId: true, sessionId: true },
    });
    if (rows.length >= want) return rows;
    await new Promise((r) => setTimeout(r, 20));
  }
  return db.usageEvent.findMany({
    where,
    select: { nodeId: true, nodeLoc: true, memoryId: true, userId: true, sessionId: true },
  });
};

/** Total events of `type`, after giving async inserts a moment to land. */
const countOfType = async (type: 'read' | 'write'): Promise<number> => {
  await new Promise((r) => setTimeout(r, 150));
  return db.usageEvent.count({ where: { type } });
};

/** Create `count` nodes in the fixture memory, returning their locs. */
const seedNodes = async (count: number, prefix = 'n'): Promise<string[]> => {
  const locs: string[] = [];
  for (let i = 0; i < count; i++) {
    const loc = `${prefix}-${i}`;
    await db.node.create({
      data: {
        id: generateId(),
        memoryId: mem.id,
        loc,
        name: `node ${i}`,
        nodeType: 'info',
        content: `body of ${loc}`,
      },
    });
    locs.push(loc);
  }
  return locs;
};

beforeEach(async () => {
  await cleanDb(db);

  const org = await db.organization.create({
    data: { id: generateId(), name: 'ur-org', urn: `ur-org-${generateId().slice(-8)}` },
  });
  orgId = org.id;

  mem = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:mem`,
      name: 'mem',
      class: 'knowledge',
      visibility: 'ORGANIZATION',
    },
  });

  user = await db.user.create({
    data: { id: generateId(), githubId: 9301, githubUsername: 'ur-user', roles: ['CONTRIBUTOR'] },
  });
  admin = await db.user.create({
    data: { id: generateId(), githubId: 9302, githubUsername: 'ur-admin', roles: ['CONTRIBUTOR'] },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: user.id, role: 'CONTRIBUTOR' },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
});

describe('#1061 — reads are recorded on every surface that returns node content', () => {
  it('records one read for the single-node query, attributed to the caller and memory', async () => {
    const [loc] = await seedNodes(1);

    await Q.node(null, { ref: loc }, asUser());

    const events = await eventsOfType('read');
    expect(events).toHaveLength(1);
    expect(events[0].nodeLoc).toBe(loc);
    expect(events[0].memoryId).toBe(mem.id);
    expect(events[0].userId).toBe(user.id);
  });

  it('records one read PER HIT for a search — the defect that made the chart 10x low', async () => {
    await seedNodes(5, 'searchable');

    const r = await Q.findNodes(null, { filter: { memoryIds: [mem.id] } }, asUser());
    expect(r.hits).toHaveLength(5);

    const events = await eventsOfType('read', { minCount: 5 });
    expect(events).toHaveLength(5);
    // Every hit, not just the first: a search returning N nodes IS N reads.
    expect(new Set(events.map((e) => e.nodeLoc))).toEqual(
      new Set(['searchable-0', 'searchable-1', 'searchable-2', 'searchable-3', 'searchable-4']),
    );
  });

  it('records reads for nodeBatch, one per node actually returned', async () => {
    const locs = await seedNodes(3, 'batch');
    const ids = (
      await db.node.findMany({ where: { memoryId: mem.id }, select: { id: true } })
    ).map((n) => n.id);

    const r = await Q.nodeBatch(null, { refs: ids }, asUser());
    expect(r.nodes).toHaveLength(3);

    const events = await eventsOfType('read', { minCount: 3 });
    expect(events).toHaveLength(3);
    expect(new Set(events.map((e) => e.nodeLoc))).toEqual(new Set(locs));
  });

  it('records NO read when the ref resolves to nothing — an event must never name an unreadable node', async () => {
    await Q.node(null, { ref: 'does-not-exist' }, asUser());
    expect(await countOfType('read')).toBe(0);
  });
});

describe('#1061 — writes are recorded on every node-write surface', () => {
  it('records a write for createNode and again for updateNode', async () => {
    const created = await M.createNode(
      null,
      { input: { memoryId: mem.id, loc: 'w-1', name: 'w', nodeType: 'info' } },
      asUser(),
    );
    expect(created.loc).toBe('w-1');

    let events = await eventsOfType('write');
    expect(events).toHaveLength(1);
    expect(events[0].nodeLoc).toBe('w-1');
    expect(events[0].memoryId).toBe(mem.id);
    expect(events[0].userId).toBe(user.id);

    await M.updateNode(null, { input: { memoryId: mem.id, loc: 'w-1', name: 'w2' } }, asUser());
    events = await eventsOfType('write', { minCount: 2 });
    expect(events).toHaveLength(2);
  });

  it('records a write for a soft delete, and none for a hard delete', async () => {
    await seedNodes(1, 'del');
    const node = await db.node.findUniqueOrThrow({
      where: { loc_memoryId: { loc: 'del-0', memoryId: mem.id } },
    });

    await M.deleteNode(null, { nodeRef: node.id }, asUser());
    let events = await eventsOfType('write');
    expect(events).toHaveLength(1);
    expect(events[0].nodeLoc).toBe('del-0');

    // Hard delete removes the row, so an event naming it could not satisfy the
    // nodeId FK — and there is no surviving node the write belongs to.
    await seedNodes(1, 'hard');
    const hard = await db.node.findUniqueOrThrow({
      where: { loc_memoryId: { loc: 'hard-0', memoryId: mem.id } },
    });
    await M.deleteNode(null, { nodeRef: hard.id, hard: true }, asUser());
    events = await eventsOfType('write', { minCount: 1 });
    expect(events).toHaveLength(1);
  });

  it('records one write per node a bulk search-and-replace rewrites — and none for a dry run', async () => {
    await seedNodes(3, 'bulk');

    await M.searchReplaceInNodes(
      null,
      {
        input: {
          oldText: 'body',
          newText: 'BODY',
          memoryIds: [mem.id],
          fields: ['content'],
          dryRun: true,
        },
      },
      asUser(),
    );
    expect(await countOfType('write')).toBe(0);

    await M.searchReplaceInNodes(
      null,
      {
        input: { oldText: 'body', newText: 'BODY', memoryIds: [mem.id], fields: ['content'] },
      },
      asUser(),
    );
    const events = await eventsOfType('write', { minCount: 3 });
    expect(events).toHaveLength(3);
    expect(new Set(events.map((e) => e.nodeLoc))).toEqual(
      new Set(['bulk-0', 'bulk-1', 'bulk-2']),
    );
  });

  it('records a write for an edge create, attributed to the SOURCE node', async () => {
    await seedNodes(2, 'edge');
    const [src, tgt] = await db.node.findMany({
      where: { memoryId: mem.id },
      orderBy: { loc: 'asc' },
      select: { id: true, loc: true },
    });

    await M.createEdge(null, { sourceRef: src.id, targetRef: tgt.id, name: 'links-to' }, asUser());

    const events = await eventsOfType('write');
    expect(events).toHaveLength(1);
    expect(events[0].nodeId).toBe(src.id);
    expect(events[0].nodeLoc).toBe(src.loc);
  });

  it('records a write at the POST-move address when a node is relocated', async () => {
    await seedNodes(1, 'mv');
    const node = await db.node.findUniqueOrThrow({
      where: { loc_memoryId: { loc: 'mv-0', memoryId: mem.id } },
    });

    await M.moveNode(null, { sourceRef: node.id, targetUrn: `hrn:node:${mem.urn}:moved` }, asUser());

    const events = await eventsOfType('write');
    expect(events).toHaveLength(1);
    // The new loc, because that is where a reader of the series will look.
    expect(events[0].nodeLoc).toBe('moved');
    expect(events[0].nodeId).toBe(node.id);
  });
});

describe('#1061 — what deliberately does NOT record', () => {
  it('records nothing for an impersonated read — support browsing is not the target user\'s activity', async () => {
    const [loc] = await seedNodes(1, 'imp');

    // ctx.userId is the TARGET in an impersonated session, so recording
    // normally would file an admin's browsing as the target's own usage.
    const impersonated = {
      db,
      userId: user.id,
      roles: [],
      impersonation: { sessionId: generateId(), adminUserId: admin.id, orgId },
    } as unknown as Context;

    const node = await Q.node(null, { ref: loc }, impersonated);
    expect(node).toBeTruthy(); // the READ itself still works

    expect(await countOfType('read')).toBe(0);
  });

  it('records nothing for resolveUrn — locating a node is not reading it', async () => {
    const [loc] = await seedNodes(1, 'loc');

    await Q.resolveUrn(null, { urn: `${mem.urn}::${loc}` }, asUser());

    expect(await countOfType('read')).toBe(0);
  });
});
