/** #2676 (S13, P9): the operator script converting Agent.systemPrompt and Worker.promptOverride to approved, compiled boot-prompt nodes as-is. */
import { COMPILED_BOOT_PROMPT_NODE_TYPE } from '../lib/bootPrompt.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbAppAgent, createDbAppWithKey } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { composeWorkerPrompt } from '../api/graphql/schema/resolvers.worker.js';
import type { Context } from '../api/graphql/schema/resolvers.helpers.js';
import { resolvers } from '../api/graphql/schema/resolvers.js';
import { convertBootPrompts } from './convert-boot-prompts.js';
import { OPERATOR_CONVERSION_INFO, createOperatorConversionContext, isOperatorConversionContext } from '../lib/auth/operatorConversion.js';
import { assertMayWriteBootPromptPointer, loadBootPromptPointerOwner } from '../lib/bootPromptPointer.js';
import { requireMemoryWriteAccess } from '../api/graphql/schema/resolvers.helpers.js';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// A mutant seam for the compile (the drift pin): off unless a test turns it on.
const drift = vi.hoisted(() => ({ on: false }));
vi.mock('../api/graphql/schema/compileBootPrompt.js', async (orig) => {
  const m = await orig<typeof import('../api/graphql/schema/compileBootPrompt.js')>();
  return {
    ...m,
    compileBootPrompt: async (...a: Parameters<typeof m.compileBootPrompt>) => {
      const r = await m.compileBootPrompt(...a);
      return drift.on ? { ...r, node: { ...r.node, content: `${r.node.content} (edited)` } } : r;
    },
  };
});

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
const run = (apply = true) => convertBootPrompts(db, { apply });
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

  it('an override holding {{name}} / {{role}} converts as written and is listed as a row whose rendering will differ', async () => {
    const agent = await agentWith('tok', 'Agent text.');
    const app = await appWith('cv-tok', agent.id);
    const worker = await workerOf(app.id, agent.id, 'w', 'I am {{name}}, {{role}} and {{name}}.');
    const plain = await workerOf(app.id, agent.id, 'p', 'No tokens.');
    for (const apply of [false, true]) {
      const report = await run(apply);
      expect(report.failed).toBe(0);
      expect(report.renderedDifferences).toEqual([
        { kind: 'WORKER', id: worker.id, name: 'w', reason: 'OVERRIDE_LEGACY_TOKEN_NOW_BINDS', tokens: ['{{name}}', '{{role}}'] },
      ]);
      if (!apply) continue;
      const w = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
      expect((await db.node.findUniqueOrThrow({ where: { id: w.bootPromptNodeId! } })).content).toBe('Agent text.\n\nI am {{name}}, {{role}} and {{name}}.');
      expect((await db.worker.findUniqueOrThrow({ where: { id: plain.id } })).bootPromptNodeId).not.toBeNull();
    }
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

  it('a user-owned Agent and App convert too: the operator is no manager of anything', async () => {
    const owner = await db.user.create({ data: { id: generateId(), name: 'owner' } });
    const mem = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'uo-sys', urn: 'uo:uo-sys', ownerUserId: owner.id } });
    const agent = await db.agent.create({ data: { id: generateId(), name: 'uo', urn: 'uo:uo', ownerUserId: owner.id, systemMemoryId: mem.id, systemPrompt: 'Agent text.' } });
    const { app } = await createDbAppWithKey(db, 'cv-uo', orgId);
    await db.app.update({ where: { id: app.id }, data: { organizationId: null, ownerUserId: owner.id } });
    await createDbAppAgent(db, app.id, agent.id);
    const worker = await workerOf(app.id, agent.id, 'w', 'Override.');
    const report = await run();
    expect(report.rows.map((r) => r.reason ?? r.outcome)).toEqual(['converted', 'converted']);
    const w = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
    expect((await db.node.findUniqueOrThrow({ where: { id: w.bootPromptNodeId! } })).content).toBe('Agent text.\n\nOverride.');
  });

  it('a compile that returns other text than the old composition fails the row: nothing approved, no pointer', async () => {
    const agent = await agentWith('drift', 'Agent text.');
    drift.on = true;
    const report = await run();
    drift.on = false;
    expect(report.rows[0]).toMatchObject({ outcome: 'failed', reason: 'COMPILED_TEXT_DIFFERS' });
    expect((await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).bootPromptNodeId).toBeNull();
    const compiled = await db.node.findFirstOrThrow({ where: { memoryId: agent.systemMemoryId!, loc: 'boot:compiled' } });
    expect(compiled.approvedRevNo).toBeNull();
    const source = await db.node.findFirstOrThrow({ where: { memoryId: agent.systemMemoryId!, loc: 'boot:source' } });
    expect(source.approvedRevNo).toBeNull();
    expect(source.approvalHash).toBeNull();
  });

  it('a node at the compiled address with other text or a non-compiled shape is ADDRESS_OCCUPIED and is never written over', async () => {
    for (const [key, nodeType] of [['occc1', COMPILED_BOOT_PROMPT_NODE_TYPE], ['occc2', null]] as const) {
      const agent = await agentWith(key, 'Agent text.');
      const other = await db.node.create({ data: { id: generateId(), memoryId: agent.systemMemoryId!, loc: 'boot:compiled', name: 'Mine', role: 'boot-prompt', ...(nodeType ? { nodeType } : {}), content: 'independent text' } });
      const report = await run();
      const r = report.rows.find((x) => x.id === agent.id)!;
      expect(r).toMatchObject({ outcome: 'failed', reason: 'ADDRESS_OCCUPIED' });
      expect((await db.node.findUniqueOrThrow({ where: { id: other.id } })).content).toBe('independent text');
      const source = await db.node.findFirst({ where: { memoryId: agent.systemMemoryId!, loc: 'boot:source' } });
      expect(source?.approvedRevNo ?? null).toBeNull();
    }
  });

  it('approvals are recorded as the operator conversion: no user id, the info string', async () => {
    const agent = await agentWith('ap', 'Agent text.');
    await run();
    for (const loc of ['boot:source', 'boot:compiled']) {
      const n = await db.node.findFirstOrThrow({ where: { memoryId: agent.systemMemoryId!, loc } });
      expect(n).toMatchObject({ approvedBy: null, approvedByInfo: OPERATOR_CONVERSION_INFO });
    }
  });
});

describe('#2676 — the operator seam is narrow', () => {
  it('the GraphQL compile and pointer mutations still refuse a user who does not manage the Agent', async () => {
    const agent = await agentWith('gq', 'Agent text.');
    await run();
    const plain = await db.user.create({ data: { id: generateId(), name: 'plain' } });
    const ctx = { db, userId: plain.id, roles: [], clientId: `user:${plain.id}` } as Context;
    const m = resolvers.Mutation as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    await expect(m.compileAgentBootPrompt(null, { agentRef: agent.id, setPointer: false }, ctx)).rejects.toThrow();
    const row = await db.agent.findUniqueOrThrow({ where: { id: agent.id } });
    await expect(m.setAgentBootPrompt(null, { agentRef: agent.id, nodeRef: row.bootPromptNodeId }, ctx)).rejects.toThrow();
  });

  it('the marker cannot be carried by anything a request or a payload can build', () => {
    const ctx = createOperatorConversionContext(db);
    expect(isOperatorConversionContext(ctx)).toBe(true);
    expect(isOperatorConversionContext({ ...ctx })).toBe(true);
    expect(isOperatorConversionContext(JSON.parse(JSON.stringify({ ...ctx, db: undefined })))).toBe(false);
    expect(isOperatorConversionContext({ db, userId: null, roles: [], clientId: OPERATOR_CONVERSION_INFO })).toBe(false);
    expect(isOperatorConversionContext({ operatorConversion: true, [Symbol('operatorConversion')]: true })).toBe(false);
    expect(isOperatorConversionContext({ operatorConversion: true, [Symbol.for('operatorConversion')]: true })).toBe(false);
    expect(isOperatorConversionContext(null)).toBe(false);
  });

  it('the pointer gate itself refuses a plain user and admits only the operator Context', async () => {
    const agent = await agentWith('gate', 'Agent text.');
    const owner = (await loadBootPromptPointerOwner(db, { field: 'AGENT', agentId: agent.id }))!;
    const plain = await db.user.create({ data: { id: generateId(), name: 'plain-gate' } });
    const plainCtx = { db, userId: plain.id, roles: [], clientId: `user:${plain.id}` } as Context;
    await expect(assertMayWriteBootPromptPointer(plainCtx, owner)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    await expect(assertMayWriteBootPromptPointer(createOperatorConversionContext(db), owner)).resolves.toBeUndefined();
  });

  it('the operator is refused a soft-deleted system memory', async () => {
    const ctx = createOperatorConversionContext(db);
    const gone = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'g', urn: 'cv-org:g-sys', organizationId: orgId, deletedAt: new Date() } });
    await expect(requireMemoryWriteAccess(ctx, gone.id)).rejects.toThrow();
  });

  it('a failed row restores the source\'s earlier approval of record rather than clearing it', async () => {
    const agent = await agentWith('restore', 'Agent text.');
    const src = await db.node.create({ data: { id: generateId(), memoryId: agent.systemMemoryId!, loc: 'boot:source', name: 'Boot prompt', role: 'boot-prompt', content: 'Agent text.' } });
    const manager = await db.user.create({ data: { id: generateId(), name: 'earlier-approver' } });
    await db.node.update({ where: { id: src.id }, data: { revSeq: 2, approvedRevNo: 1, approvedBy: manager.id, approvedAt: new Date(), approvalHash: 'earlier' } });
    drift.on = true;
    const report = await run();
    drift.on = false;
    expect(report.rows[0]).toMatchObject({ outcome: 'failed', reason: 'COMPILED_TEXT_DIFFERS' });
    expect(await db.node.findUniqueOrThrow({ where: { id: src.id } })).toMatchObject({ approvedRevNo: 1, approvedBy: manager.id, approvalHash: 'earlier' });
  });

  it('the operator writes system memories only', async () => {
    const ctx = createOperatorConversionContext(db);
    const system = await db.memory.create({ data: { id: generateId(), class: 'system', name: 's', urn: 'cv-org:s-sys', organizationId: orgId } });
    const knowledge = await db.memory.create({ data: { id: generateId(), class: 'knowledge', name: 'k', urn: 'cv-org:k', organizationId: orgId } });
    await expect(requireMemoryWriteAccess(ctx, system.id)).resolves.toBeUndefined();
    await expect(requireMemoryWriteAccess(ctx, knowledge.id)).rejects.toThrow();
  });

  it('only src/admin and scripts import the operator constructor', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) { walk(path); continue; }
        if (!/\.(ts|tsx)$/.test(name) || /\.test\.ts$/.test(name)) continue;
        if (path.startsWith(join('src', 'admin')) || path === join('src', 'lib', 'auth', 'operatorConversion.ts')) continue;
        if (readFileSync(path, 'utf8').includes('createOperatorConversionContext')) offenders.push(path);
      }
    };
    walk('src');
    expect(offenders).toEqual([]);
  });
});
