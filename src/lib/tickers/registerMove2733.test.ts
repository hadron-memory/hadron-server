import { resolveRegisters } from '../../api/graphql/schema/resolvers.taskWarnings.js';
import { runAsActor } from '../requestActor.js';
import { afterEach, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { tickFixture2733, tickNow2733, tickTaskLoc2733 } from '../../test/tickRegister2733.js';
import { computeDueWakes } from './dueWakes.js';
import * as effectiveMemory from '../effectiveSystemMemory.js';
import { canReadMemory } from '../../mcp/access-control.js';
import { resolvers } from '../../api/graphql/schema/resolvers.js';
vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
afterEach(() => vi.restoreAllMocks());
it('pins the task final fetch to the authorized memory across a real move', async () => {
  const f = await tickFixture2733();
  await db.appMember.create({ data: { appId: f.app.id, userId: f.outside.id, role: 'owner' } });
  const org = await db.organization.create({ data: { name: 'Private destination', urn: f.org.urn + '-hidden' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: f.admin.id, role: 'ADMIN' } });
  const foreign = await f.agent('Hidden', org.id);
  expect(await canReadMemory(db, f.context(f.outside.id), foreign.systemMemoryId)).toBe(false);
  await f.entry('tick.shared');
  const task = await f.node(f.roleA.systemMemoryId, tickTaskLoc2733, { isRunnable: true });
  const w = await f.worker('Alpha');
  const t = await f.ticker('Shared');
  await db.tickerSubscription.create({ data: { tickerId: t.id, workerId: w.id } });
  const original = effectiveMemory.findEffectiveNodeIdByLoc;
  let moved = false;
  vi.spyOn(effectiveMemory, 'findEffectiveNodeIdByLoc').mockImplementation(async (tx, memoryId, loc, inheritRoot) => {
    const hit = await original(tx, memoryId, loc, inheritRoot);
    if (!moved && memoryId === f.roleA.systemMemoryId && loc === tickTaskLoc2733) {
      moved = true;
      await (resolvers.Mutation as any).moveNode(null, { sourceRef: task.id, targetMemoryRef: foreign.systemMemoryId }, f.context());
    }
    return hit;
  });
  const out = await computeDueWakes({ ctx: f.context(f.outside.id), app: f.app, reader: { manager: true, userId: f.outside.id }, requester: { userId: f.outside.id }, now: tickNow2733 });
  expect(moved).toBe(true);
  expect((await db.node.findUniqueOrThrow({ where: { id: task.id } })).memoryId).toBe(foreign.systemMemoryId);
  expect(JSON.stringify(out)).not.toContain(foreign.memory.urn);
});

it.each(['entry', 'task'])('keeps warning %s resolution inside its gated memory during a move', async kind => {
  const f = await tickFixture2733();
  const org = await db.organization.create({ data: { name: 'Private destination', urn: f.org.urn + '-hidden' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: f.admin.id, role: 'ADMIN' } });
  const foreign = await f.agent('Hidden', org.id);
  expect(await canReadMemory(db, f.context(f.member.id), foreign.systemMemoryId)).toBe(false);
  const code = 'ticker.code.unmapped' as const;
  const entry = await f.entry(code);
  const task = await f.node(f.roleA.systemMemoryId, tickTaskLoc2733, { isRunnable: true });
  const w = await f.worker('Alpha');
  const selected = kind === 'entry' ? entry : task;
  const memory = kind === 'entry' ? f.team.systemMemoryId : f.roleA.systemMemoryId;
  const loc = kind === 'entry' ? 'register:' + code : tickTaskLoc2733;
  const original = effectiveMemory.findEffectiveNodeIdByLoc;
  let moved = false;
  vi.spyOn(effectiveMemory, 'findEffectiveNodeIdByLoc').mockImplementation(async (tx, memoryId, candidateLoc, inheritRoot) => {
    const hit = await original(tx, memoryId, candidateLoc, inheritRoot);
    if (!moved && memoryId === memory && candidateLoc === loc) {
      moved = true;
      await runAsActor({ workerId: null, agentId: null, userId: f.admin.id }, () => (resolvers.Mutation as any).moveNode(null, { sourceRef: selected.id, targetMemoryRef: foreign.systemMemoryId }, f.context()));
    }
    return hit;
  });
  const out = await runAsActor({ workerId: w.id, agentId: f.roleA.id, userId: f.member.id }, () => resolveRegisters(f.context(f.member.id), f.app.id, [code]));
  expect(moved).toBe(true);
  expect((await db.node.findUniqueOrThrow({ where: { id: selected.id } })).memoryId).toBe(foreign.systemMemoryId);
  expect(out.get(code)).toEqual({ state: kind === 'entry' ? 'unmapped' : 'unresolved' });
  expect(JSON.stringify([...out])).not.toContain(foreign.memory.urn);
});
