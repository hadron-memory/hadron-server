/**
 * #3301 (refs #2895, #1376): an Agent's system memory is never a startChat target on ANY branch
 * (cor:cht:010:02; Vera's #2895 ruling, option a: refuse). #3295 refused it only in the session
 * branch. Every case here is a raw-DB fixture: no API path stamps a system memory with the per-user provenance
 * column (userMemoryOfAgentId) or links one where a branch would select it, so each row is inserted directly, the way a corrupt or hand-made row would be.
 *
 * Per branch (the schedule in the issue):
 *   session  — already refused by #3295 (GREEN control on main)
 *   user     — class='system' + userMemoryOfAgentId + createdBy the caller (RED on main)
 *   shared   — UNREACHABLE: chk_memory_class_app_id stops a system row carrying the (App, Agent) key (pin-only decline)
 *   legacy   — UNREACHABLE: the item link cap gives a system memory no level (pin-only decline, green control)
 * The refusal is the same "No target memory available" answer as any unreadable target, and a
 * refused call creates no Chat, Message, node or memory.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey, createDbAppAgent, createDbAppMember } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { resolvers } from '../../api/graphql/schema/resolvers.js';
import { serveAgentBootPrompt } from '../servedBootPrompt.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let suffix: string;
let orgId: string;

/** A fresh agent with a servable conversation in its own system memory, installed in a fresh App. */
async function fixture() {
  const label = `s3301-${generateId()}`;
  const agent = await db.agent.create({
    data: { id: generateId(), organizationId: orgId, name: label, urn: `org-${suffix}:ag-${label}` } as never,
  });
  const { app } = await createDbAppWithKey(db, `app-${label}`, orgId);
  await createDbAppAgent(db, app.id, agent.id);
  const sys = await db.memory.create({
    data: { id: generateId(), urn: `org-${suffix}:sys-${generateId()}`, name: 'sys', organizationId: orgId, class: 'system' } as never,
  });
  await db.agent.update({ where: { id: agent.id }, data: { systemMemoryId: sys.id } as never });
  for (const [loc, data, content] of [
    ['conversations', null, null],
    ['conversations:c', { stageOrder: ['s'], isSetup: false }, null],
    ['conversations:c:s', { promptRef: 'prompts:c:s' }, null],
    ['prompts', null, null], ['prompts:c', null, null], ['prompts:c:s', null, 'Hi.'],
  ] as const) {
    await db.node.create({ data: { id: generateId(), memoryId: sys.id, loc, name: loc.split(':').pop()!, nodeType: 'system', data: data as never, content } });
  }
  await serveAgentBootPrompt(db, agent.id, 'Hi.');
  const user = await db.user.create({ data: { id: generateId(), handle: `u-${generateId()}`, githubUsername: `u-${generateId()}` } });
  await createDbAppMember(db, app.id, user.id, 'member');
  return { agentId: agent.id, appId: app.id, systemId: sys.id, userId: user.id, agentUrn: agent.urn, appUrn: app.urn };
}

type Ctx = Record<string, unknown>;
const start = (agentId: string, ctx: Ctx, args: Record<string, unknown> = {}) =>
  resolvers.Mutation.startChat({}, { agentId, ...args }, { db, roles: ['READER'], ...ctx } as never)
    .then(() => null as string | null, (e: Error) => e.message);

/** Everything a refused call must leave alone. */
async function footprint(systemId: string) {
  return {
    memories: await db.memory.count(),
    systemNodes: await db.node.count({ where: { memoryId: systemId } }),
    nodes: await db.node.count(),
  };
}

beforeAll(async () => {
  await cleanDb(db);
  suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'o', urn: `org-${suffix}` } })).id;
});

describe('#3301 — an Agent\'s system memory is refused as a startChat target on every branch', () => {
  it('control (green on main): the session branch refuses it, byte-identical to an unreadable target (#3295)', async () => {
    const f = await fixture();
    const session = await db.session.create({ data: { id: generateId(), appId: f.appId, agentId: f.agentId, memoryId: f.systemId } as never });
    const before = await footprint(f.systemId);
    expect(await start(f.agentId, { appId: f.appId, sessionId: session.id })).toMatch(/No target memory available/);
    expect(await footprint(f.systemId)).toEqual(before);
  });

  it('user branch: a class=system row carrying userMemoryOfAgentId is refused, not chatted into or replaced by a fresh memory (RED on main)', async () => {
    const f = await fixture();
    // the corrupt row: the system memory ALSO carries the per-user provenance column for this caller
    await db.memory.update({ where: { id: f.systemId }, data: { userMemoryOfAgentId: f.agentId, createdBy: f.userId } as never });
    const before = await footprint(f.systemId);
    const refused = await start(f.agentId, { userId: f.userId });
    expect(refused).toMatch(/No target memory available/);
    // nothing written into the system memory, and nothing provisioned in its place
    expect(await footprint(f.systemId)).toEqual(before);
  });

  it("user branch: ANOTHER Agent's system memory carrying userMemoryOfAgentId=A is refused when chatting with A (Rico §10 P2)", async () => {
    // The reachable user-branch row is not the chat's own Agent's system memory: the lookup keys on
    // userMemoryOfAgentId + createdBy, so Agent B's system memory stamped with A's id is what it selects.
    // A guard narrowed to "A's own systemMemoryId" would pass every other pin here; this one is red for it.
    const a = await fixture();
    const b = await fixture();
    await db.memory.update({ where: { id: b.systemId }, data: { userMemoryOfAgentId: a.agentId, createdBy: a.userId } as never });
    const before = await footprint(b.systemId);
    expect(await start(a.agentId, { userId: a.userId })).toMatch(/No target memory available/);
    expect(await footprint(b.systemId)).toEqual(before);
  });

  it('shared branch (pin-only decline, green on main): unreachable, the DB refuses a system row on the (App, Agent) shared key', async () => {
    // chk_memory_class_app_id: a class=system memory cannot carry appId, and the canonical shared key
    // (appId, sharedMemoryOfAgentId) needs one, so findOrCreateAppClassMemory can never select a system row.
    const f = await fixture();
    await expect(
      db.memory.update({ where: { id: f.systemId }, data: { appId: f.appId, sharedMemoryOfAgentId: f.agentId } as never }),
    ).rejects.toThrow(/chk_memory_class_app_id/);
    // the pre-#723 adopt scan is scoped to class='app', so it never adopts a system row either
    expect(await start(f.agentId, { userId: f.userId }, { scope: 'shared' })).toBeNull();
    expect((await db.memory.findUniqueOrThrow({ where: { id: f.systemId } })).sharedMemoryOfAgentId).toBeNull();
  });

  it('legacy branch (pin-only decline, green on main): a read-write item to the system memory is refused for a run principal — the link cap grants a system memory nothing (agentMemoryLinkCap.ts table)', async () => {
    const f = await fixture();
    await db.agentMemoryItem.create({ data: { id: generateId(), agentId: f.agentId, memoryId: f.systemId, role: 'read-write' } as never });
    const before = await footprint(f.systemId);
    const refused = await start(f.agentId, { appId: f.appId, clientId: `run:${generateId()}` });
    expect(refused).toMatch(/No target memory available/);
    expect(await footprint(f.systemId)).toEqual(before);
  });

  it('#3292 parity: a hypothetical userless run is refused for linked org knowledge too', async () => {
    const f = await fixture();
    const knowledge = await db.memory.create({
      data: { id: generateId(), urn: `org-${suffix}:k-${generateId()}`, name: 'k', organizationId: orgId, class: 'knowledge', visibility: 'ORGANIZATION' } as never,
    });
    await db.agentMemoryItem.create({ data: { id: generateId(), agentId: f.agentId, memoryId: knowledge.id, role: 'read-write' } as never });
    // #3292 deliberately removes the old hypothetical run exception; no run transport is exercised here.
    const before = await footprint(f.systemId);
    expect(await start(f.agentId, { appId: f.appId, clientId: `run:${generateId()}` })).toMatch(/No target memory available/);
    expect(await footprint(f.systemId)).toEqual(before);
    expect(await db.node.count({ where: { memoryId: knowledge.id } })).toBe(0);
  });

  it('refusal is byte-identical across branches and to the unreadable-target answer', async () => {
    const a = await fixture();
    await db.memory.update({ where: { id: a.systemId }, data: { userMemoryOfAgentId: a.agentId, createdBy: a.userId } as never });
    const userRefusal = await start(a.agentId, { userId: a.userId });
    const b = await fixture();
    // an unreadable target: a session naming a memory outside the session's verified reach
    const outside = await db.memory.create({
      data: { id: generateId(), urn: `org-${suffix}:out-${generateId()}`, name: 'out', organizationId: orgId, class: 'knowledge', visibility: 'ORGANIZATION' } as never,
    });
    const session = await db.session.create({ data: { id: generateId(), appId: b.appId, agentId: b.agentId, memoryId: outside.id } as never });
    const unreadable = await start(b.agentId, { appId: b.appId, sessionId: session.id });
    expect(unreadable).toMatch(/No target memory available/);
    expect(userRefusal).toBe(unreadable);
  });

  it('control: a normal user chat still starts when no system row is in the way', async () => {
    const f = await fixture();
    const before = await footprint(f.systemId);
    expect(await start(f.agentId, { userId: f.userId })).toBeNull();
    // the chat landed in a per-user memory (a new one), never in the system memory
    const after = await footprint(f.systemId);
    expect(after.nodes).toBeGreaterThan(before.nodes);
    expect(after.systemNodes).toBe(before.systemNodes);
  });
});
