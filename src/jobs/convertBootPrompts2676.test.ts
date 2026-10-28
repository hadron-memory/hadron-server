/** #2676 (S13): the as-is conversion of Agent.systemPrompt and Worker.promptOverride to approved, compiled boot-prompt nodes. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbAppAgent, createDbAppWithKey } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { composeWorkerPrompt } from '../api/graphql/schema/resolvers.worker.js';
import type { Context } from '../api/graphql/schema/resolvers.helpers.js';
import { resolvers } from '../api/graphql/schema/resolvers.js';
import { convertBootPrompts } from './convertBootPrompts.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

let orgId: string;
let adminId: string;

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'cv-org', urn: 'cv-org' } })).id;
  // A manager as themselves: an org ADMIN, with no platform role. Install memories are read by an App's participants.
  adminId = (await db.user.create({ data: { id: generateId(), name: 'org admin' } })).id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: adminId, role: 'ADMIN' } });
});

async function agentWith(slug: string, systemPrompt: string | null) {
  const mem = await db.memory.create({ data: { id: generateId(), class: 'system', name: `${slug}-sys`, urn: `cv-org:${slug}-sys`, organizationId: orgId } });
  return db.agent.create({ data: { id: generateId(), name: slug, urn: `cv-org:${slug}`, organizationId: orgId, systemMemoryId: mem.id, systemPrompt } });
}
async function appWith(slug: string, agentId: string) {
  const { app } = await createDbAppWithKey(db, slug, orgId);
  await createDbAppAgent(db, app.id, agentId);
  return app;
}
const workerOf = (appId: string, agentId: string, slug: string, promptOverride: string | null) =>
  db.worker.create({ data: { id: generateId(), appId, agentId, name: slug, slug, signature: '', trailer: '', promptOverride } });
const run = (apply = true) => convertBootPrompts(db, { actingUserId: adminId, apply });
const nodeCount = () => db.node.count();
const approved = (n: { revSeq: number; approvedRevNo: number | null }) => n.approvedRevNo === n.revSeq;

describe('#2676 — Agent conversion', () => {
  it('writes the text unchanged to an approved source, compiles and approves it, and sets the pointer', async () => {
    const text = 'You are the coordinator.\n\nKeep `{{name}}` and {{worker.role}} as written.\n';
    const agent = await agentWith('coord', text);
    const report = await run();
    expect(report).toMatchObject({ applied: true, converted: 1, skipped: 0, failed: 0 });
    const source = await db.node.findFirstOrThrow({ where: { memoryId: agent.systemMemoryId!, loc: 'boot:source' } });
    expect(source).toMatchObject({ content: text, role: 'boot-prompt', nodeType: 'info' });
    expect(approved(source)).toBe(true);
    const row = await db.agent.findUniqueOrThrow({ where: { id: agent.id } });
    const compiled = await db.node.findUniqueOrThrow({ where: { id: row.bootPromptNodeId! } });
    expect(compiled).toMatchObject({ content: text, nodeType: 'compiled-boot-prompt', loc: 'boot:compiled' });
    expect(approved(compiled)).toBe(true);
    expect(row.systemPrompt).toBe(text);
  });

  it('leaves an Agent with no prompt text alone: no node, no pointer', async () => {
    const none = await agentWith('none', null);
    const empty = await agentWith('empty', '');
    const before = await nodeCount();
    const report = await run();
    expect(report).toMatchObject({ converted: 0, failed: 0 });
    expect(await nodeCount()).toBe(before);
    for (const a of [none, empty]) expect((await db.agent.findUniqueOrThrow({ where: { id: a.id } })).bootPromptNodeId).toBeNull();
  });
});

describe('#2676 — Worker conversion keeps the effective text', () => {
  it('a worker with an override gets the Agent prompt, a blank line, then the override, identical to the old composition', async () => {
    const agent = await agentWith('eng', 'You are an engineer.');
    const app = await appWith('cv-app', agent.id);
    const worker = await workerOf(app.id, agent.id, 'iris', 'Lane: server only.');
    const ctx = { db, userId: adminId, roles: [], clientId: `user:${adminId}` } as Context;
    const before = (await composeWorkerPrompt(ctx, { ...worker, role: null })).text;
    expect(before).toBe('You are an engineer.\n\nLane: server only.');
    const report = await run();
    expect(report).toMatchObject({ converted: 2, failed: 0 });
    const w = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
    const compiled = await db.node.findUniqueOrThrow({ where: { id: w.bootPromptNodeId! } });
    expect(compiled.content).toBe(before);
    expect(compiled).toMatchObject({ nodeType: 'compiled-boot-prompt', loc: `boot:workers:${worker.id}:compiled` });
    expect(approved(compiled)).toBe(true);
    const install = await db.memory.findFirstOrThrow({ where: { isInstallMemory: true, appId: app.id, installOfAgentId: agent.id } });
    expect(compiled.memoryId).toBe(install.id);
    const source = await db.node.findFirstOrThrow({ where: { memoryId: install.id, loc: `boot:workers:${worker.id}:source` } });
    expect(approved(source)).toBe(true);
    expect(source.content).toMatch(/^\{\{> hrn:node:[^}]+:boot:source\}\}\n\nLane: server only\.$/);
    expect(w.promptOverride).toBe('Lane: server only.');
  });

  it('a worker whose Agent has no prompt gets just the override', async () => {
    const agent = await agentWith('bare', null);
    const app = await appWith('cv-bare', agent.id);
    const worker = await workerOf(app.id, agent.id, 'mel', 'Only me.');
    expect(await run()).toMatchObject({ converted: 1, failed: 0 });
    const w = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
    expect((await db.node.findUniqueOrThrow({ where: { id: w.bootPromptNodeId! } })).content).toBe('Only me.');
  });

  it('a worker with no override is left alone (no node, no pointer, no install memory)', async () => {
    const agent = await agentWith('plain', 'Agent text.');
    const app = await appWith('cv-plain', agent.id);
    const worker = await workerOf(app.id, agent.id, 'none', null);
    await run();
    expect((await db.worker.findUniqueOrThrow({ where: { id: worker.id } })).bootPromptNodeId).toBeNull();
    expect(await db.memory.count({ where: { isInstallMemory: true } })).toBe(0);
  });
});

describe('#2676 — repeatable, preview, and what as-is cannot carry', () => {
  it('a second run changes nothing and reports every row skipped', async () => {
    const agent = await agentWith('rr', 'Agent text.');
    const app = await appWith('cv-rr', agent.id);
    await workerOf(app.id, agent.id, 'w1', 'Override.');
    await run();
    const snap = async () => ({
      nodes: await db.node.count(), revisions: await db.nodeRevision.count(), compiled: await db.compiledPromptRevision.count(),
      pointers: (await db.worker.findMany({ select: { bootPromptNodeId: true } })).map((w) => w.bootPromptNodeId),
    });
    const before = await snap();
    const again = await run();
    expect(again).toMatchObject({ converted: 0, failed: 0, skipped: 2 });
    expect(again.rows.every((r) => r.reason === 'POINTER_ALREADY_SET')).toBe(true);
    expect(await snap()).toEqual(before);
  });

  it('a re-run after a partial run reuses the existing source and never overwrites it', async () => {
    const agent = await agentWith('part', 'Agent text.');
    const src = await db.node.create({ data: { id: generateId(), memoryId: agent.systemMemoryId!, loc: 'boot:source', name: 'Boot prompt', role: 'boot-prompt', content: 'Agent text.' } });
    expect(await run()).toMatchObject({ converted: 1, failed: 0 });
    expect((await db.node.findUniqueOrThrow({ where: { id: src.id } })).revSeq).toBe(src.revSeq);
  });

  it('refuses to overwrite a different node at the source address and reports the row failed', async () => {
    const agent = await agentWith('occ', 'Agent text.');
    const other = await db.node.create({ data: { id: generateId(), memoryId: agent.systemMemoryId!, loc: 'boot:source', name: 'Mine', role: 'boot-prompt', content: 'someone else wrote this' } });
    const report = await run();
    expect(report).toMatchObject({ converted: 0, failed: 1 });
    expect(report.rows[0]).toMatchObject({ outcome: 'failed', reason: 'ADDRESS_OCCUPIED' });
    expect((await db.node.findUniqueOrThrow({ where: { id: other.id } })).content).toBe('someone else wrote this');
    expect((await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).bootPromptNodeId).toBeNull();
  });

  it('preview writes nothing and reports what would convert', async () => {
    const agent = await agentWith('pv', 'Agent text.');
    const app = await appWith('cv-pv', agent.id);
    await workerOf(app.id, agent.id, 'w', 'Override.');
    const before = { nodes: await nodeCount(), memories: await db.memory.count() };
    const report = await run(false);
    expect(report).toMatchObject({ applied: false, converted: 2, failed: 0 });
    expect({ nodes: await nodeCount(), memories: await db.memory.count() }).toEqual(before);
  });

  it('text with an include tag fails (the compile would resolve it) and is not edited; the other rows still convert', async () => {
    const bad = await agentWith('bad', 'See {{> parts:other}} for more.');
    const good = await agentWith('good', 'Fine.');
    const report = await run();
    expect(report).toMatchObject({ converted: 1, failed: 1 });
    expect(report.rows.find((r) => r.id === bad.id)).toMatchObject({ outcome: 'failed', reason: 'TEXT_HAS_INCLUDE_TAG' });
    expect((await db.agent.findUniqueOrThrow({ where: { id: bad.id } })).bootPromptNodeId).toBeNull();
    expect((await db.agent.findUniqueOrThrow({ where: { id: good.id } })).bootPromptNodeId).not.toBeNull();
    expect(await db.node.count({ where: { memoryId: bad.systemMemoryId! } })).toBe(0);
  });

  it('an override holding {{name}} or {{role}} fails: a combined text would bind what the override keeps as written', async () => {
    const agent = await agentWith('tok', 'Agent text.');
    const app = await appWith('cv-tok', agent.id);
    const worker = await workerOf(app.id, agent.id, 'w', 'I am {{name}}.');
    const report = await run();
    expect(report.rows.find((r) => r.id === worker.id)).toMatchObject({ outcome: 'failed', reason: 'OVERRIDE_HAS_LEGACY_TOKEN' });
    expect((await db.worker.findUniqueOrThrow({ where: { id: worker.id } })).bootPromptNodeId).toBeNull();
  });

  it('an override holding an include tag fails, and no install memory is made for it', async () => {
    const agent = await agentWith('ovinc', 'Agent text.');
    const app = await appWith('cv-ovinc', agent.id);
    const worker = await workerOf(app.id, agent.id, 'w', 'Lane. See {{> parts:lane}}.');
    const report = await run();
    expect(report.rows.find((r) => r.id === worker.id)).toMatchObject({ outcome: 'failed', reason: 'TEXT_HAS_INCLUDE_TAG' });
    expect(await db.memory.count({ where: { isInstallMemory: true } })).toBe(0);
  });

  it('a worker whose Agent prompt could not be converted fails rather than dropping the Agent text', async () => {
    const agent = await agentWith('noconv', 'Has {{> parts:x}} tag.');
    const app = await appWith('cv-noconv', agent.id);
    const worker = await workerOf(app.id, agent.id, 'w', 'Override.');
    const report = await run();
    expect(report.rows.find((r) => r.id === worker.id)).toMatchObject({ outcome: 'failed', reason: 'AGENT_NOT_CONVERTED' });
    expect(await db.memory.count({ where: { isInstallMemory: true } })).toBe(0);
  });

  it('a user-owned App is refused by the manager gate and shows as a failed row, with nothing left behind', async () => {
    const agent = await agentWith('uo', 'Agent text.');
    const owner = await db.user.create({ data: { id: generateId(), name: 'owner' } });
    const { app } = await createDbAppWithKey(db, 'cv-uo', orgId);
    await db.app.update({ where: { id: app.id }, data: { organizationId: null, ownerUserId: owner.id } });
    await createDbAppAgent(db, app.id, agent.id);
    const worker = await workerOf(app.id, agent.id, 'w', 'Override.');
    const report = await run();
    expect(report.rows.find((r) => r.id === worker.id)).toMatchObject({ outcome: 'failed' });
    expect((await db.worker.findUniqueOrThrow({ where: { id: worker.id } })).bootPromptNodeId).toBeNull();
    expect(report.rows.find((r) => r.kind === 'AGENT')).toMatchObject({ outcome: 'converted' });
  });

  it('a compile that returns other text than the old composition fails the row: nothing approved, no pointer', async () => {
    const agent = await agentWith('drift', 'Agent text.');
    const real = resolvers.Mutation.compileAgentBootPrompt as (...a: unknown[]) => Promise<{ node: { content: string } }>;
    const spy = vi.spyOn(resolvers.Mutation as unknown as { compileAgentBootPrompt: typeof real }, 'compileAgentBootPrompt').mockImplementation(async (...a: unknown[]) => {
      const r = await real(...a);
      return { ...r, node: { ...r.node, content: `${r.node.content} (edited)` } };
    });
    const report = await run();
    spy.mockRestore();
    expect(report.rows[0]).toMatchObject({ outcome: 'failed', reason: 'COMPILED_TEXT_DIFFERS' });
    expect((await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).bootPromptNodeId).toBeNull();
    const compiled = await db.node.findFirstOrThrow({ where: { memoryId: agent.systemMemoryId!, loc: 'boot:compiled' } });
    expect(compiled.approvedRevNo).toBeNull();
  });

  it('an unknown user is refused, and a user who manages nothing converts nothing and writes nothing', async () => {
    const agent = await agentWith('guard', 'Agent text.');
    const plain = await db.user.create({ data: { id: generateId(), name: 'plain' } });
    await expect(convertBootPrompts(db, { actingUserId: generateId(), apply: true })).rejects.toThrow(/no user/);
    const report = await convertBootPrompts(db, { actingUserId: plain.id, apply: true });
    expect(report).toMatchObject({ converted: 0, failed: 1 });
    expect(await db.node.count()).toBe(0);
    expect((await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).bootPromptNodeId).toBeNull();
  });
});
