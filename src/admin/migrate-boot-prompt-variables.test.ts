/** #2704 (S14, B7): the audit and the migration of the legacy `{{name}}` / `{{role}}` boot-prompt tokens. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbAppAgent, createDbAppWithKey } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { composeWorkerPrompt } from '../api/graphql/schema/resolvers.worker.js';
import type { Context } from '../api/graphql/schema/resolvers.helpers.js';
import { convertBootPrompts } from './convert-boot-prompts.js';
import { auditBootPromptTokens, migrateBootPromptVariables, renameLegacyTokens } from './migrate-boot-prompt-variables.js';

// A mutant seam for the byte comparison: off unless a test turns it on.
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
const served = process.env.BOOT_PROMPT_SERVE_ENABLED;
beforeEach(async () => {
  drift.on = false;
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'mg-org', urn: 'mg-org' } })).id;
  adminId = (await db.user.create({ data: { id: generateId(), name: 'org admin' } })).id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: adminId, role: 'ADMIN' } });
});
afterEach(() => {
  if (served === undefined) delete process.env.BOOT_PROMPT_SERVE_ENABLED; else process.env.BOOT_PROMPT_SERVE_ENABLED = served;
});

async function agentWith(slug: string, systemPrompt: string | null, personaRole: string | null = null) {
  const mem = await db.memory.create({ data: { id: generateId(), class: 'system', name: `${slug}-sys`, urn: `mg-org:${slug}-sys`, organizationId: orgId } });
  return db.agent.create({ data: { id: generateId(), name: slug, urn: `mg-org:${slug}`, organizationId: orgId, systemMemoryId: mem.id, systemPrompt, personaRole } });
}
async function appWith(slug: string, agentId: string) {
  const { app } = await createDbAppWithKey(db, slug, orgId);
  await createDbAppAgent(db, app.id, agentId);
  return app;
}
const workerOf = (appId: string, agentId: string, slug: string, promptOverride: string | null, role: string | null = null) =>
  db.worker.create({ data: { id: generateId(), appId, agentId, name: slug, slug, signature: '', trailer: '', promptOverride, role } });
const convert = () => convertBootPrompts(db, { apply: true });
const migrate = (apply = true) => migrateBootPromptVariables(db, { apply });
const compiledOf = async (table: 'agent' | 'worker', id: string) => {
  const owner = await (db[table] as any).findUniqueOrThrow({ where: { id } });
  return db.node.findUniqueOrThrow({ where: { id: owner.bootPromptNodeId } });
};
const approved = (n: { revSeq: number; approvedRevNo: number | null }) => n.approvedRevNo === n.revSeq;

describe('renameLegacyTokens', () => {
  it('renames only the exact legacy tokens', () => {
    expect(renameLegacyTokens('{{name}} {{role}} {{ name }} {{Name}} {{worker.name}} {{agent.name}} `{{role}}`'))
      .toBe('{{worker.name}} {{worker.role}} {{ name }} {{Name}} {{worker.name}} {{agent.name}} `{{worker.role}}`');
  });
});

describe('#2704 — audit', () => {
  it('reports ids and counts: legacy and unknown tokens, includes ignored, retired columns apart, no text', async () => {
    const agent = await agentWith('coord', 'Hi {{name}}, you are {{role}}. {{worker.name}} {{bogus.var}}.');
    const clean = await agentWith('clean', 'Plain {{worker.name}} text {{> some:include}}');
    const app = await appWith('mg-app', agent.id);
    await createDbAppAgent(db, app.id, clean.id);
    const w = await workerOf(app.id, agent.id, 'iris', 'Override {{name}}');
    const before = await auditBootPromptTokens(db);
    expect(before.rows.map((r) => [r.surface, r.id, r.legacy, r.unknown])).toEqual([
      ['AGENT_SYSTEM_PROMPT', agent.id, 2, 1],
      ['WORKER_PROMPT_OVERRIDE', w.id, 1, 0],
    ]);
    expect(JSON.stringify(before)).not.toMatch(/Hi |Override|bogus/);
    expect(before.legacyBySurface).toMatchObject({ AGENT_SYSTEM_PROMPT: 1, WORKER_PROMPT_OVERRIDE: 1, SOURCE_NODE: 0, COMPILED_NODE: 0 });
    expect(before.unknownBySurface.AGENT_SYSTEM_PROMPT).toBe(1);
    expect(before.legacyBindingRemovable).toBe(false);

    await convert();
    const after = await auditBootPromptTokens(db);
    // The source and compiled nodes now hold the tokens; the columns are retired (pointer set), counted apart.
    expect(after.legacyBySurface).toMatchObject({ SOURCE_NODE: 2, COMPILED_NODE: 2, AGENT_SYSTEM_PROMPT: 0, WORKER_PROMPT_OVERRIDE: 0 });
    expect(after.retiredColumnLegacy).toBe(2);
    expect(after.legacyBindingRemovable).toBe(false);
  });
});

describe('#2704 — migration', () => {
  it('renames an Agent source, recompiles in place, approves, keeps the pointer, and the served text binds', async () => {
    process.env.BOOT_PROMPT_SERVE_ENABLED = 'true';
    const agent = await agentWith('coord', 'You are {{name}}, the {{role}}.', 'coordinator');
    const app = await appWith('mg-app', agent.id);
    const w = await workerOf(app.id, agent.id, 'iris', null);
    await convert();
    const pointerBefore = (await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).bootPromptNodeId;
    const before = await composeWorkerPrompt({ db, userId: adminId, roles: [], clientId: `user:${adminId}` } as Context, { ...w, role: null });
    expect(before.refusal ?? null).toBeNull();
    expect(before.text).toContain('{{name}}'); // the served path leaves the legacy token literal today (#2702)

    const report = await migrate();
    expect(report).toMatchObject({ applied: true, migrated: 1, failed: 0 });
    const row = await db.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(row.bootPromptNodeId).toBe(pointerBefore);
    const compiled = await compiledOf('agent', agent.id);
    expect(compiled.content).toBe('You are {{worker.name}}, the {{worker.role}}.');
    expect(approved(compiled)).toBe(true);
    const source = await db.node.findFirstOrThrow({ where: { memoryId: agent.systemMemoryId!, loc: 'boot:source' } });
    expect(source.content).toBe(compiled.content);
    expect(approved(source)).toBe(true);
    expect(row.systemPrompt).toBe('You are {{name}}, the {{role}}.'); // the retired column is not edited
    const after = await composeWorkerPrompt({ db, userId: adminId, roles: [], clientId: `user:${adminId}` } as Context, { ...w, role: null });
    expect(after.text).toContain('You are iris, the coordinator.');
    expect(after.text).not.toMatch(/\{\{(name|role|worker\.[a-zA-Z.]+|agent\.name|session\.llmModel)\}\}/);
    expect((await auditBootPromptTokens(db)).legacyBindingRemovable).toBe(true);
  });

  it('migrates a worker source that includes its Agent source, Agent first, in both parts', async () => {
    const agent = await agentWith('coord', 'Agent {{name}}');
    const app = await appWith('mg-app', agent.id);
    const w = await workerOf(app.id, agent.id, 'iris', 'Override {{role}}');
    await convert();
    expect(await migrate()).toMatchObject({ migrated: 2, failed: 0 });
    expect((await compiledOf('agent', agent.id)).content).toBe('Agent {{worker.name}}');
    const wc = await compiledOf('worker', w.id);
    expect(wc.content).toBe('Agent {{worker.name}}\n\nOverride {{worker.role}}');
    expect(approved(wc)).toBe(true);
    expect((await auditBootPromptTokens(db)).legacyBindingRemovable).toBe(true);
  });

  it('is a dry run by default of nothing written, and idempotent after apply', async () => {
    const agent = await agentWith('coord', 'Hi {{name}}');
    await convert();
    const snapshot = async () => JSON.stringify(await db.node.findMany({ orderBy: { id: 'asc' }, select: { id: true, revSeq: true, approvedRevNo: true, content: true } }));
    const s0 = await snapshot();
    expect(await migrate(false)).toMatchObject({ applied: false, migrated: 1 });
    expect(await snapshot()).toBe(s0);
    await migrate();
    const s1 = await snapshot();
    expect(s1).not.toBe(s0);
    expect(await migrate()).toMatchObject({ migrated: 0, skipped: 0, failed: 0, rows: [] });
    expect(await snapshot()).toBe(s1);
    expect(agent.id).toBeTruthy();
  });

  it('fails a row whose compiled text is not the served text renamed, leaving the served revision as it was', async () => {
    const agent = await agentWith('coord', 'Hi {{name}}');
    await convert();
    const was = await compiledOf('agent', agent.id);
    drift.on = true;
    const report = await migrate();
    drift.on = false;
    expect(report).toMatchObject({ migrated: 0, failed: 1, rows: [{ kind: 'AGENT', id: agent.id, outcome: 'failed', reason: 'COMPILED_TEXT_DIFFERS' }] });
    const now = await compiledOf('agent', agent.id);
    expect(now.approvedRevNo).toBe(was.approvedRevNo);
    expect(approved(now)).toBe(false);
    // The text a worker is served is still the approved revision, unedited.
    const served = await db.nodeRevision.findFirst({ where: { nodeId: now.id, revNo: now.approvedRevNo! }, select: { content: true } });
    expect(served?.content ?? now.content).toBe('Hi {{name}}');
    // A retry (source already renamed, compiled still holding the token) completes.
    expect(await migrate()).toMatchObject({ migrated: 1, failed: 0 });
    expect((await compiledOf('agent', agent.id)).content).toBe('Hi {{worker.name}}');
  });

  it('lists the workers whose own role differs from the persona role (the one rendered difference)', async () => {
    const agent = await agentWith('coord', 'Role: {{role}}', 'coordinator');
    const app = await appWith('mg-app', agent.id);
    await workerOf(app.id, agent.id, 'same', null, null);
    await workerOf(app.id, agent.id, 'alike', null, 'coordinator');
    const own = await workerOf(app.id, agent.id, 'own', null, 'reviewer');
    await convert();
    const report = await migrate();
    expect(report.roleDifferences).toEqual([{ sourceOwnerId: agent.id, workerIds: [own.id] }]);
  });

  it('leaves an unconverted Agent and a source with no legacy token alone', async () => {
    await agentWith('plain', 'No tokens {{worker.name}}');
    await agentWith('unconverted', 'Legacy {{name}}');
    await convertBootPrompts(db, { apply: true });
    await db.agent.updateMany({ where: { name: 'unconverted' }, data: { bootPromptNodeId: null, bootPromptUrn: null } });
    const report = await migrate();
    expect(report.rows).toEqual([]);
  });
});
