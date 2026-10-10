/** #1719 R5a: principal-kind refusal, independent of memory shape or trigger input. */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbAgentSubscription } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { canReadMemory, canWriteToMemory, filterReadableMemoryIds } from './access-control.js';
import type { AuthContext } from '../middleware/auth.js';
import { runContext } from '../jobs/appRunDeps.js';
import { hadronReadNode, hadronUpdateNode } from '../lib/runner/tools/nodeTools.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));
beforeEach(async () => { await cleanDb(db); });

async function fixture(cls: 'private' | 'personal', scoped: boolean) {
  const owner = await db.user.create({ data: { handle: 'r5-owner' } });
  const org = await db.organization.create({ data: { name: 'R5', urn: 'r5.test' } });
  const agent = await db.agent.create({ data: { name: 'R5', urn: 'r5.test:agent', organizationId: org.id } });
  const app = await db.app.create({ data: { name: 'R5', urn: 'r5.test:app', organizationId: org.id,
    appAgents: { create: { agentId: agent.id } } } });
  await createDbAgentSubscription(db, owner.id, agent.id);
  const memory = await db.memory.create({ data: { name: cls, urn: `r5.test:${cls}`, class: cls,
    organizationId: org.id, userId: owner.id, ...(scoped ? { appId: app.id, userMemoryOfAgentId: agent.id } : {}) } });
  const node = await db.node.create({ data: { memoryId: memory.id, loc: 'secret', name: 'Secret', content: 'unchanged' } });
  const auth: AuthContext = { userId: owner.id, appId: app.id, clientId: 'run:test' };
  return { owner, org, agent, app, memory, node, auth };
}

for (const scoped of [false, true]) {
  describe(scoped ? 'App-scoped' : 'free-standing', () => {
    it('refuses private read, write and batched discovery even with forged grant data', async () => {
      const f = await fixture('private', scoped);
      const auth = { ...f.auth, roles: ['ADMIN'], runGrants: [f.memory.id] } as AuthContext;
      expect(await canReadMemory(db, auth, f.memory.id)).toBe(false);
      expect(await canWriteToMemory(db, auth, f.memory.id)).toBe(false);
      expect(await filterReadableMemoryIds(db, auth, [f.memory.id])).toEqual(new Set());
      expect(await db.node.findUnique({ where: { id: f.node.id } })).toEqual(f.node);
    });
    it('retains personal reach for runs', async () => {
      const f = await fixture('personal', scoped);
      expect(await canReadMemory(db, f.auth, f.memory.id)).toBe(true);
      expect(await canWriteToMemory(db, f.auth, f.memory.id)).toBe(true);
    });
    it('retains private reach for direct credentials and user-bound worker sessions', async () => {
      const f = await fixture('private', scoped);
      const sessionMemory = await db.memory.create({ data: { name: 'Session', urn: 'r5.test:session', class: 'app', organizationId: f.org.id, appId: f.app.id } });
      const worker = await db.worker.create({ data: { appId: f.app.id, agentId: f.agent.id, name: 'Owner worker', slug: 'owner-worker', heldByUserId: f.owner.id } });
      const session = await db.session.create({ data: { id: generateId(), appId: f.app.id, agentId: f.agent.id, workerId: worker.id, userId: f.owner.id, memoryId: sessionMemory.id } });
      for (const sessionId of [undefined, session.id]) {
        const auth = { ...f.auth, clientId: 'user:owner', sessionId };
        expect(await canReadMemory(db, auth, f.memory.id)).toBe(true);
        expect(await canWriteToMemory(db, auth, f.memory.id)).toBe(true);
      }
    });
    it.each(['private', 'personal'] as const)('refuses impersonated %s read and write', async cls => {
      const f = await fixture(cls, scoped);
      const auth = { ...f.auth, clientId: 'user:owner', impersonation: { orgId: f.org.id } } as AuthContext;
      expect(await canReadMemory(db, auth, f.memory.id)).toBe(false);
      expect(await canWriteToMemory(db, auth, f.memory.id)).toBe(false);
    });
    it.each(['MANUAL', 'SCHEDULE', 'WEBHOOK', 'INTEGRATION', 'SPAWN'] as const)('%s run tools refuse private data and preserve the node', async triggerKind => {
      const f = await fixture('private', scoped);
      const run = await db.appRun.create({ data: { id: generateId(), appId: f.app.id, organizationId: f.org.id,
        userId: f.owner.id, triggerKind, entryNodeUrn: 'hrn:node:r5.test:private:secret',
        eventData: { grants: [f.memory.id], userId: f.owner.id } } });
      const ctx = { db, run, principal: runContext(db, run), log: vi.fn() };
      const urn = 'hrn:node:r5.test:private:secret';
      const [read, write] = await Promise.allSettled([
        hadronReadNode.execute(ctx, { urn }),
        hadronUpdateNode.execute(ctx, { urn, content: 'stolen' }),
      ]);
      expect(read.status).toBe('rejected');
      expect(write.status).toBe('rejected');
      expect(await db.node.findUnique({ where: { id: f.node.id } })).toEqual(f.node);
    });
  });
}


it('inventory finds routed literal references, legacy entries and unresolved triggers without claiming safety', async () => {
  const f = await fixture('private', false);
  const flows = await db.memory.create({ data: { name: 'Flows', urn: 'r5.test::flows', class: 'knowledge', organizationId: f.org.id } });
  const entry = await db.node.create({ data: { memoryId: flows.id, loc: 'entry', name: 'Entry' } });
  const routed = await db.node.create({ data: { memoryId: flows.id, loc: 'routed', name: 'Routed', data: { output: { writeTo: 'hrn:node:r5.test:private:secret' } } } });
  await db.edge.createMany({ data: [
    { memoryId: flows.id, sourceId: entry.id, targetId: routed.id, name: 'next', loc: 'entry:next:routed' },
    { memoryId: flows.id, sourceId: routed.id, targetId: entry.id, name: 'next', loc: 'routed:next:entry' },
  ] });
  for (const [name, entryNodeUrn] of [
    ['routed', 'hrn:node:r5.test:flows:entry'],
    ['legacy', 'r5.test::private::secret'],
    ['unresolved', 'hrn:node:r5.test:missing:entry'],
  ]) {
    await db.agentSchedule.create({ data: { id: generateId(), name, appId: f.app.id, organizationId: f.org.id,
      userId: f.owner.id, entryNodeUrn, cron: '* * * * *' } });
  }
  const sql = readFileSync(new URL('../../scripts/audits/private-run-triggers-1719.sql', import.meta.url), 'utf8')
    .replace('BEGIN TRANSACTION READ ONLY;', '').replace('ROLLBACK;', '');
  const rows = await db.$queryRawUnsafe<Array<{ name: string; inventory_status: string; private_memory_id: string | null }>>(sql);
  expect(rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'routed', inventory_status: 'PRIVATE_CANDIDATE', private_memory_id: f.memory.id }),
    expect.objectContaining({ name: 'legacy', inventory_status: 'PRIVATE_CANDIDATE', private_memory_id: f.memory.id }),
    expect.objectContaining({ name: 'unresolved', inventory_status: 'REQUIRES_OWNER_REVIEW', private_memory_id: null }),
  ]));
});
