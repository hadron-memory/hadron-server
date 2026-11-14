/**
 * #4102 F5: repository regression pins for the script reader's rule ordering, read through the real
 * `loadChatScript().outgoingRules` (no second sort in the test) against live and pinned readers.
 *
 * The law is cor:cht:030:02's "outgoing rules are evaluated in priority order, first-fires-wins"; the
 * tiebreak (createdAt on a live read, snapshot array order on a pinned one) is BUILT, NOT RULED — the
 * spec lists the priority numbering scheme as tunable and says nothing on ties — so these pins protect
 * current behaviour without claiming a rule. Both readers matter because cor:cht:020:01 reads rules from
 * the published snapshot a chat is pinned to, and from the live script for a pre-v2 snapshot (ruling Q9).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { deriveEdgeLoc } from '../../../lib/edgeLoc.js';
import { loadChatScript } from '../../../lib/chatScript.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let adminUser: { id: string };
let agent: { id: string };
let systemMemory: { id: string };
let ids: Record<string, string>;

const adminCtx = (): Context => ({ db, roles: ['ADMIN'], userId: adminUser.id });

const STAGE = 'conversations:main:check';

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'rule-order-org', urn: 'rule-order-org' } });
  adminUser = await db.user.create({ data: { githubId: 84102, githubUsername: 'rule-order', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: adminUser.id, role: 'ADMIN' } });
  const created = await resolvers.Mutation.createAgent({}, { orgId: org.id, name: 'orderly', visibility: 'PERSONAL' }, adminCtx());
  agent = created;
  systemMemory = await db.memory.findUniqueOrThrow({ where: { id: created.systemMemoryId! } });
  await serveEveryAgent(db);
  ids = {};
  for (const [loc, data] of [
    ['conversations', {}],
    ['conversations:main', { stageOrder: ['check'], isSetup: false }],
    [STAGE, {}],
    ['conversations:alpha', { stageOrder: ['a1'], isSetup: false }],
    ['conversations:alpha:a1', {}],
    ['conversations:beta', { stageOrder: ['b1'], isSetup: false }],
    ['conversations:beta:b1', {}],
    ['conversations:gamma', { stageOrder: ['g1'], isSetup: false }],
    ['conversations:gamma:g1', {}],
  ] as const) {
    ids[loc] = (await db.node.create({
      data: { id: generateId(), memoryId: systemMemory.id, loc, name: loc.split(':').pop()!, nodeType: 'system', data: data as never },
    })).id;
  }
});

type Seeded = { id: string; target: string };
/** Create one outgoing rule of STAGE; `createdAt` is set explicitly so equal-priority ties are deterministic. */
async function rule(target: string, priority: number, createdAt: Date): Promise<Seeded> {
  const row = await db.edge.create({
    data: {
      id: generateId(), memoryId: systemMemory.id, loc: deriveEdgeLoc(STAGE, `rule-${target}`, `conversations:${target}`),
      sourceId: ids[STAGE], targetId: ids[`conversations:${target}`], name: `rule-${target}`,
      priority, data: { timing: 'on_complete', behavior: 'transition' } as never,
    },
  });
  await db.edge.update({ where: { id: row.id }, data: { createdAt } });
  return { id: row.id, target };
}

/** The read under test: targets in the reader's order, straight from outgoingRules (never re-sorted here). */
async function readOrder(revisionLoc: string | null) {
  const script = await loadChatScript(db, systemMemory.id, revisionLoc);
  return { source: script.source, targets: (await script.outgoingRules(STAGE)).map((r) => r.targetLoc.split(':')[1]) };
}

async function publish(): Promise<string> {
  const rev = await resolvers.Mutation.createRevision({}, { agentId: agent.id }, adminCtx());
  await resolvers.Mutation.publishRevision({}, { agentId: agent.id, revisionLoc: rev.revisionLoc }, adminCtx());
  return rev.revisionLoc as string;
}

describe('#4102 F5 script-reader rule ordering (priority ascending; the tiebreak is built, not ruled)', () => {
  it('live reader: rules come back priority-ascending regardless of insertion order', async () => {
    await rule('gamma', 7, new Date('2026-01-01T00:00:03Z'));
    await rule('beta', 1, new Date('2026-01-01T00:00:02Z'));
    await rule('alpha', 4, new Date('2026-01-01T00:00:01Z'));
    expect(await readOrder(null)).toMatchObject({ source: 'live', targets: ['beta', 'alpha', 'gamma'] });
  });

  it('live reader: equal priorities keep createdAt order (the built tiebreak, not a rule)', async () => {
    await rule('gamma', 0, new Date('2026-01-01T00:00:09Z'));
    await rule('beta', 2, new Date('2026-01-01T00:00:05Z')); // inserted first, created later
    await rule('alpha', 2, new Date('2026-01-01T00:00:01Z')); // inserted last, created earlier
    expect(await readOrder(null)).toMatchObject({ source: 'live', targets: ['gamma', 'alpha', 'beta'] });
  });

  it('pinned v2 reader: snapshot rules sort by priority with the snapshot array order on ties, ignoring later live edits', async () => {
    const gamma = await rule('gamma', 0, new Date('2026-01-01T00:00:09Z'));
    const beta = await rule('beta', 2, new Date('2026-01-01T00:00:05Z'));
    const alpha = await rule('alpha', 2, new Date('2026-01-01T00:00:01Z'));
    const revLoc = await publish();
    // The draft re-orders everything after the publish; the pinned read must not see any of it.
    await db.edge.update({ where: { id: beta.id }, data: { priority: 0 } }); // beta to the front, live
    await db.edge.update({ where: { id: alpha.id }, data: { priority: 5 } }); // alpha to the back, live
    await db.edge.update({ where: { id: gamma.id }, data: { priority: 3 } }); // gamma into the middle, live
    // The reader's OWN sort is under test, not only the writer's: store the snapshot's edge array
    // out of priority order (it is data in the revision node), so only sorting on read restores it.
    // The reversal also flips the equal-priority pair against createdAt order, proving the pinned
    // tiebreak is the snapshot's ARRAY order, not the live createdAt order the live reader uses.
    const revNode = await db.node.findFirstOrThrow({ where: { memoryId: systemMemory.id, loc: revLoc } });
    const data = revNode.data as any;
    data.snapshot.edges = [...data.snapshot.edges].reverse();
    await db.node.update({ where: { id: revNode.id }, data: { data } });
    expect(await readOrder(revLoc)).toMatchObject({ source: 'snapshot', targets: ['gamma', 'beta', 'alpha'] });
  });

  it('pre-v2 pinned reader: rules are read live (ruling Q9), so live ordering edits show through', async () => {
    const beta = await rule('beta', 2, new Date('2026-01-01T00:00:05Z'));
    const alpha = await rule('alpha', 2, new Date('2026-01-01T00:00:01Z'));
    const revLoc = await publish();
    // Make the snapshot a pre-v2 one: no format marker, no condition/priority on its edges.
    const revNode = await db.node.findFirstOrThrow({ where: { memoryId: systemMemory.id, loc: revLoc } });
    const data = revNode.data as any;
    delete data.snapshot.edgeFormat;
    data.snapshot.edges = data.snapshot.edges.map(({ condition: _c, priority: _p, ...rest }: any) => rest);
    await db.node.update({ where: { id: revNode.id }, data: { data } });
    // A live edit that only the live read can reflect (Q9): alpha drops below beta, so the delegated
    // live read's order diverges from the (stripped) snapshot array's own order.
    await db.edge.update({ where: { id: alpha.id }, data: { priority: 9 } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await readOrder(revLoc)).toMatchObject({ source: 'snapshot-pre-v2', targets: ['beta', 'alpha'] });
    } finally {
      warn.mockRestore();
    }
  });
});
