/**
 * #5330 (hrn:node:hadronmemory.com:specs:cor:dmo:150:03, Holger's ruling B on #4965; with
 * hrn:node:hadronmemory.com:specs:cor:dmo:080:02): resolving an include writes no read event for its target. A read stays one
 * event per RETURNED node, so a node whose text holds an include has one read event of its own and none for what it includes.
 *
 * The pins go through the surfaces that record (`node(ref:) { content }` and `hadron_get_node`), never `Node.content` called
 * directly (it records nothing, so such a pin could not fail), read as the person themselves (impersonation suppresses events),
 * and count only after `drainNodeUsage` (the insert is fire-and-forget). The returned node's own event is asserted in the same
 * test as the control that shows the drain worked. The target is matched by loc as well as by node id: an event the recorder
 * cannot attribute still records the raw path (cor:dmo:080:02).
 *
 * Written against main 312663dd6: the pins land GREEN there (include resolution calls no recorder), as the issue expects.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { typeDefs } from '../../api/graphql/schema/typeDefs.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { BROKEN_INCLUDE_NOTICE } from './resolveNodeContent.js';
import { createTestableMcpServer } from '../../mcp/server.js';
import { drainNodeUsage } from '../usageRecorder.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const server = new ApolloServer<Context>({ typeDefs, resolvers });
async function run(query: string, ctx: Context, variables?: Record<string, unknown>) {
  const res = await server.executeOperation({ query, variables }, { contextValue: ctx });
  if (res.body.kind !== 'single') throw new Error('unexpected incremental result');
  return res.body.singleResult;
}

const NODE_Q = `query($ref: ID!) { node(ref: $ref) { content } }`;
const BATCH_Q = `query($refs: [ID!]) { nodeBatch(refs: $refs) { nodes { loc content(raw: false) } } }`;
// nodeBatch returns the stored text by default: only `content(raw: false)` resolves includes, so a pin without it would resolve none.

let reader: { id: string };
let home: { id: string; urn: string };
let shared: { id: string; urn: string };
let sealed: { id: string; urn: string };
let ids: Record<string, string>;
const ctx = (): Context => ({ db, userId: reader.id, roles: [], clientId: `user:${reader.id}` });
const mcp = () => createTestableMcpServer({ userId: reader.id, roles: [], clientId: `user:${reader.id}` });
const urnOf = (m: { urn: string }, loc: string) => `hrn:node:${m.urn}:${loc}`;
const mk = async (memoryId: string, loc: string, content: string) => {
  const n = await db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content } });
  ids[loc] = n.id;
  return n;
};

/** Every read event now in the table, after the deferred insert has settled. */
async function readEvents() {
  await drainNodeUsage(db);
  return db.usageEvent.findMany({ where: { type: 'read' }, select: { nodeLoc: true, nodeId: true, memoryId: true } });
}

beforeEach(async () => {
  await cleanDb(db);
  ids = {};
  const org = await db.organization.create({ data: { id: generateId(), name: 'Ev Org', urn: 'ev.example' } });
  const other = await db.organization.create({ data: { id: generateId(), name: 'Ev Other', urn: 'evother.example' } });
  reader = await db.user.create({ data: { githubId: 533001, githubUsername: 'ev-reader', handle: 'ev-reader', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: reader.id, role: 'ADMIN' } });
  home = await resolvers.Mutation.createMemory(null, { orgRef: org.id, name: 'home' }, ctx());
  shared = await resolvers.Mutation.createMemory(null, { orgRef: org.id, name: 'shared' }, ctx());
  // The reader belongs to nothing in this organization: the include's target is unreadable.
  sealed = await db.memory.create({
    data: { name: 'Sealed', urn: 'evother.example:sealed', organizationId: other.id, class: 'knowledge', visibility: 'ORGANIZATION' },
  });
  await mk(home.id, 'same-target', 'SAME-TARGET-TEXT');
  await mk(shared.id, 'cross-target', 'CROSS-TARGET-TEXT');
  await mk(sealed.id, 'sealed-target', 'SEALED-TARGET-TEXT');
  await mk(home.id, 'holder', `a {{> same-target}} b {{> ${urnOf(shared, 'cross-target')}}} c`);
  await mk(home.id, 'broken-holder', `x {{> ${urnOf(sealed, 'sealed-target')}}} y`);
  // The unreadable target must not have been read by anything here: start from an empty table.
  await db.usageEvent.deleteMany({});
});

const targetLocs = ['same-target', 'cross-target', 'sealed-target'];
/** No event names an include target, by loc (with or without ids) or by node id. */
function expectNoTargetEvents(events: Awaited<ReturnType<typeof readEvents>>) {
  for (const loc of targetLocs) {
    expect(events.filter((e) => e.nodeLoc === loc)).toEqual([]);
    expect(events.filter((e) => e.nodeId === ids[loc])).toEqual([]);
  }
}

describe('#5330 GraphQL: node(ref:) { content }', () => {
  it('a readable same-memory and a readable cross-memory include: one event for the returned node, none for either target', async () => {
    const res = await run(NODE_Q, ctx(), { ref: urnOf(home, 'holder') });
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ node: { content: 'a SAME-TARGET-TEXT b CROSS-TARGET-TEXT c' } });
    const events = await readEvents();
    // The control: the returned node's own event, so an empty table means "no target event", not "the drain did not work".
    expect(events).toEqual([{ nodeLoc: 'holder', nodeId: ids['holder'], memoryId: home.id }]);
    expectNoTargetEvents(events);
  });

  it('a broken include (unreadable target): the notice renders, still one event for the returned node and none for the target', async () => {
    const res = await run(NODE_Q, ctx(), { ref: urnOf(home, 'broken-holder') });
    expect((res.data as any).node.content).toContain(BROKEN_INCLUDE_NOTICE);
    expect((res.data as any).node.content).not.toContain('SEALED-TARGET-TEXT');
    const events = await readEvents();
    expect(events).toEqual([{ nodeLoc: 'broken-holder', nodeId: ids['broken-holder'], memoryId: home.id }]);
    expectNoTargetEvents(events);
  });

  it('the batch read: one event per returned node, none for the targets', async () => {
    const res = await run(BATCH_Q, ctx(), { refs: [urnOf(home, 'holder'), urnOf(home, 'broken-holder')] });
    expect(res.errors).toBeUndefined();
    const nodes = (res.data as any).nodeBatch.nodes;
    expect(nodes.map((n: any) => n.content)).toEqual(['a SAME-TARGET-TEXT b CROSS-TARGET-TEXT c', expect.stringContaining(BROKEN_INCLUDE_NOTICE)]);
    const events = await readEvents();
    expect(events.map((e) => e.nodeLoc).sort()).toEqual(['broken-holder', 'holder']);
    expectNoTargetEvents(events);
  });
});

describe('#5330 MCP: hadron_get_node and hadron_get_nodes', () => {
  it('hadron_get_node: one event for the returned node, none for a readable same-memory or cross-memory target', async () => {
    const text = await mcp().callToolText('hadron_get_node', { urn: urnOf(home, 'holder') });
    expect(text).toContain('a SAME-TARGET-TEXT b CROSS-TARGET-TEXT c');
    const events = await readEvents();
    expect(events).toEqual([{ nodeLoc: 'holder', nodeId: ids['holder'], memoryId: home.id }]);
    expectNoTargetEvents(events);
  });

  it('hadron_get_node on a broken include: the notice, one event for the returned node, none for the target', async () => {
    const text = await mcp().callToolText('hadron_get_node', { urn: urnOf(home, 'broken-holder') });
    expect(text).toContain(BROKEN_INCLUDE_NOTICE);
    expect(text).not.toContain('SEALED-TARGET-TEXT');
    const events = await readEvents();
    expect(events).toEqual([{ nodeLoc: 'broken-holder', nodeId: ids['broken-holder'], memoryId: home.id }]);
    expectNoTargetEvents(events);
  });

  it('hadron_get_nodes: one event per returned node, none for the targets', async () => {
    const text = await mcp().callToolText('hadron_get_nodes', { refs: [urnOf(home, 'holder'), urnOf(home, 'broken-holder')] });
    expect(text).toContain('CROSS-TARGET-TEXT');
    const events = await readEvents();
    expect(events.map((e) => e.nodeLoc).sort()).toEqual(['broken-holder', 'holder']);
    expectNoTargetEvents(events);
  });

  it('control: reading a target as a node of its own does record its event (the pin can see a target event when there is one)', async () => {
    await mcp().callToolText('hadron_get_node', { urn: urnOf(shared, 'cross-target') });
    const events = await readEvents();
    expect(events).toEqual([{ nodeLoc: 'cross-target', nodeId: ids['cross-target'], memoryId: shared.id }]);
  });
});
