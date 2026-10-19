import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
/** #1719 R5a: principal-kind refusal, independent of memory shape or trigger input. */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbAgentSubscription } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { canReadMemory, canWriteToMemory, filterReadableMemoryIds } from './access-control.js';
import type { AuthContext } from '../middleware/auth.js';
import { executeAppRun } from '../jobs/appRuns.js';
import { resolvers } from '../api/graphql/schema/resolvers.js';
import { getAccessibleMemoryIds } from '../api/graphql/schema/resolvers.helpers.js';
import { renderAttentionSection } from '../lib/channelReadState.js';
import { makeProdRunDeps, runContext } from '../jobs/appRunDeps.js';
import { hadronStoreFile } from '../lib/runner/tools/storeTools.js';
import { putObject } from '../integrations/r2/client.js';
import { hadronReadNode, hadronUpdateNode, hadronCreateNode } from '../lib/runner/tools/nodeTools.js';

vi.mock('../integrations/r2/client.js', () => ({ putObject: vi.fn(), deleteObject: vi.fn() }));
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
      const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: f.app.id, agentId: f.agent.id, name: 'Owner worker', slug: 'owner-worker', heldByUserId: f.owner.id } });
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


async function assemblyFixture(orgless = false, cls: 'private' | 'personal' = 'private') {
  const f = await fixture(cls, false);
  await db.orgMember.create({ data: { organizationId: f.org.id, userId: f.owner.id, role: 'READER' } });
  if (orgless) await db.memory.update({ where: { id: f.memory.id }, data: { organizationId: null, ownerUserId: f.owner.id } });
  const flow = await db.memory.create({ data: { name: 'Flow', urn: 'r5.test:flow', class: 'knowledge', organizationId: f.org.id } });
  const entry = await db.node.create({ data: { memoryId: flow.id, loc: 'entry', name: 'Entry', isRunnable: true, content: 'approved root' } });
  await db.edge.create({ data: { memoryId: flow.id, sourceId: entry.id, targetId: f.node.id, name: 'documents', loc: 'entry:documents:secret' } });
  return { ...f, flow, entry };
}
for (const orgless of [false, true]) {
  it.each(['SCHEDULE', 'MANUAL'] as const)(`real %s assembly refuses private dependency (orgless=${orgless}) before LLM/output`, async triggerKind => {
    const f = await assemblyFixture(orgless);
    const run = await db.appRun.create({ data: { id: generateId(), organizationId: f.org.id, appId: f.app.id, userId: f.owner.id, triggerKind, entryNodeUrn: 'hrn:node:r5.test:flow:entry' } });
    const llm = vi.fn(async () => ({ text: 'output', tokensIn: 1, tokensOut: 1, provider: 'test', model: 'test' }));
    const writeOutput = vi.fn(async () => null);
    const deps = { ...makeProdRunDeps(db), resolveConfig: vi.fn(async () => ({ config: {} }) as never), llm, writeOutput };
    // Exercise assembly directly too: after R5b lands the synthetic legacy
    // activation is refused by consent before it reaches the assembly seam.
    await expect(deps.assemble(run, run.entryNodeUrn, {})).rejects.toThrow('not readable');
    expect(await executeAppRun(db, run.id, deps)).toBe('failed');
    expect(llm).not.toHaveBeenCalled();
    expect(writeOutput).not.toHaveBeenCalled();
    expect((await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).failure).toMatchObject({ code: expect.stringMatching(/^(ASSEMBLY_FAILED|AUTOMATION_UNADOPTED)$/) });
    expect(await db.node.findUniqueOrThrow({ where: { id: f.node.id } })).toEqual(f.node);
  });
}
it('personal dependencies remain in a run prompt, while own user/worker-session private dependencies remain admitted', async () => {
  for (const cls of ['personal', 'private'] as const) {
    await cleanDb(db);
    const f = await assemblyFixture(false, cls);
    const run = await db.appRun.create({ data: { id: generateId(), organizationId: f.org.id, appId: f.app.id, userId: f.owner.id, triggerKind: 'MANUAL', entryNodeUrn: 'hrn:node:r5.test:flow:entry' } });
    if (cls === 'personal') expect(await makeProdRunDeps(db).assemble(run, run.entryNodeUrn, {})).toContain('unchanged');
    const sessionMem = await db.memory.create({ data: { name: 'Work', urn: 'r5.test:work', class: 'app', appId: f.app.id, organizationId: f.org.id } });
    const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: f.app.id, agentId: f.agent.id, name: 'W', slug: 'w', heldByUserId: f.owner.id } });
    const session = await db.session.create({ data: { id: generateId(), appId: f.app.id, workerId: worker.id, agentId: f.agent.id, memoryId: sessionMem.id, userId: f.owner.id } });
    for (const sessionId of [undefined, session.id]) {
      const prompt = await resolvers.Mutation.runTask({}, { nodeRef: run.entryNodeUrn }, { db, userId: f.owner.id, clientId: 'user:owner', appId: f.app.id, sessionId, roles: [] });
      expect(prompt).toContain('unchanged');
    }
  }
});
it('render-mode runTask omits another user’s private dependency (#1730)', async () => {
  const f = await assemblyFixture();
  const other = await db.user.create({ data: { handle: 'r5-render-other' } });
  await db.orgMember.create({ data: { organizationId: f.org.id, userId: other.id, role: 'READER' } });
  const prompt = await resolvers.Mutation.runTask({}, { nodeRef: 'hrn:node:r5.test:flow:entry' }, { db, userId: other.id, roles: [] });
  expect(prompt).toContain('approved root');
  expect(prompt).not.toContain('unchanged');
  expect(prompt).not.toContain('secret');
});
it('private hop metadata is gated before its tool names can reach the AppRun log', async () => {
  const f = await fixture('private', false);
  await db.node.update({ where: { id: f.node.id }, data: { data: { tools: ['secret-tool-name'] } } });
  const run = await db.appRun.create({ data: { id: generateId(), organizationId: f.org.id, appId: f.app.id, userId: f.owner.id, triggerKind: 'MANUAL', entryNodeUrn: 'hrn:node:r5.test:private:secret' } });
  await expect(makeProdRunDeps(db).loadNodeSpec(run, run.entryNodeUrn)).rejects.toThrow('not readable');
});
it('the GraphQL accessible set refuses private to a run but retains personal', async () => {
  const f = await fixture('private', false);
  const personal = await db.memory.create({ data: { name: 'Personal', urn: 'r5.test:personal2', class: 'personal', organizationId: f.org.id, userId: f.owner.id } });
  const ids = await getAccessibleMemoryIds({ db, ...f.auth });
  expect(ids).not.toContain(f.memory.id);
  expect(ids).toContain(personal.id);
});
it('create/store/output into private are refused before any persisted or storage effect', async () => {
  const f = await assemblyFixture();
  await db.node.update({ where: { id: f.entry.id }, data: { data: { output: { writeTo: 'hrn:node:r5.test:private:secret' } } } });
  const run = await db.appRun.create({ data: { id: generateId(), organizationId: f.org.id, appId: f.app.id, userId: f.owner.id, triggerKind: 'MANUAL', entryNodeUrn: 'hrn:node:r5.test:flow:entry' } });
  const ctx = { db, run, principal: runContext(db, run), log: vi.fn() };
  vi.mocked(putObject).mockClear();
  await expect(hadronCreateNode.execute(ctx, { urn: 'hrn:node:r5.test:private:new', name: 'New', content: 'written' })).rejects.toThrow();
  await expect(hadronStoreFile.execute(ctx, { urn: 'hrn:node:r5.test:private:file', filename: 'file.txt', content: 'written' })).rejects.toThrow();
  await expect(makeProdRunDeps(db).writeOutput(run, run.entryNodeUrn, 'written')).rejects.toThrow();
  expect(putObject).not.toHaveBeenCalled();
  expect(await db.node.count({ where: { memoryId: f.memory.id } })).toBe(1);
  expect(await db.node.findUniqueOrThrow({ where: { id: f.node.id } })).toEqual(f.node);
});

it('inventory includes org-less private dependencies and live webfetch poll bindings', async () => {
  const f = await assemblyFixture(true);
  const source = await db.appRun.create({ data: { id: generateId(), organizationId: f.org.id, appId: f.app.id, userId: f.owner.id, triggerKind: 'MANUAL', entryNodeUrn: 'hrn:node:r5.test:flow:entry' } });
  const schedule = await db.agentSchedule.create({ data: { id: generateId(), organizationId: f.org.id, appId: f.app.id, userId: f.owner.id, name: 'Orgless reference', cron: '* * * * *', entryNodeUrn: source.entryNodeUrn } });
  const binding = await db.webFetchPollBinding.create({ data: { jobId: 'private-inventory-job', sourceRunId: source.id, organizationId: f.org.id, appId: f.app.id, userId: f.owner.id, entryNodeUrn: source.entryNodeUrn, url: 'https://example.com/poll' } });
  const sql = readFileSync(new URL('../../scripts/audits/private-run-triggers-1719.sql', import.meta.url), 'utf8')
    .replace('BEGIN TRANSACTION READ ONLY;', '').replace('ROLLBACK;', '');
  const rows = await db.$queryRawUnsafe<Array<{ kind: string; id: string; private_memory_id: string | null; inventory_status: string }>>(sql);
  expect(rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'schedule', id: schedule.id, private_memory_id: f.memory.id, inventory_status: 'PRIVATE_CANDIDATE' }),
    expect.objectContaining({ kind: 'webfetch', id: binding.jobId, private_memory_id: f.memory.id, inventory_status: 'PRIVATE_CANDIDATE' }),
  ]));
});

it('a private channel contributes neither attention text nor a cursor advance to a run', async () => {
  const f = await fixture('private', false);
  await db.node.update({ where: { id: f.node.id }, data: { loc: 'chats:team', nodeType: 'chat' } });
  const channel = await db.channel.create({ data: { memoryId: f.memory.id, loc: 'chats:team', name: 'Private channel name', chatRootNodeId: f.node.id, lastSeq: 5 } });
  const attention = await renderAttentionSection(db, { id: generateId(), agentId: f.agent.id, appId: f.app.id,
    userId: f.owner.id, organizationId: f.org.id,
    registerSnapshot: { attendee: { agentId: f.agent.id, appId: f.app.id }, rows: [{ channelId: channel.id, role: 'WATCH', mentionOnly: false }] } });
  expect(attention.text).toBe('');
  expect(attention.captured.size).toBe(0);
});
