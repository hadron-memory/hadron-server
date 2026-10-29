/** #2704 (S14, B7): the audit and the migration of the legacy `{{name}}` / `{{role}}` boot-prompt tokens. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbAppAgent, createDbAppWithKey } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { composeWorkerPrompt } from '../api/graphql/schema/resolvers.worker.js';
import type { Context } from '../api/graphql/schema/resolvers.helpers.js';
import { applyPlatformVariables } from '../lib/personaDescription.js';
import { compileBootPrompt } from '../api/graphql/schema/compileBootPrompt.js';
import { createOperatorConversionContext } from '../lib/auth/operatorConversion.js';
import { convertBootPrompts } from './convert-boot-prompts.js';
import { approveCheckedRevision, auditBootPromptTokens, migrateBootPromptVariables, renameLegacyTokens } from './migrate-boot-prompt-variables.js';

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
    expect(before.text).toContain('You are iris, the coordinator.'); // #2705: the served path binds the legacy tokens

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
    expect(after.text).toBe(before.text); // the rename changes nothing a worker is served
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
    expect(await migrate(false)).toMatchObject({ applied: false, migrated: 0, candidates: 1 });
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
    // The approved revision still served holds the legacy token, so the audit must not call the binder removable.
    expect((await auditBootPromptTokens(db)).legacyBindingRemovable).toBe(false);
    // The text a worker is served is still the approved revision, unedited.
    const served = await db.nodeRevision.findFirst({ where: { nodeId: now.id, revNo: now.approvedRevNo! }, select: { content: true } });
    expect(served?.content ?? now.content).toBe('Hi {{name}}');
    // A retry (source already renamed, compiled still holding the token) completes.
    expect(await migrate()).toMatchObject({ migrated: 1, failed: 0 });
    expect((await compiledOf('agent', agent.id)).content).toBe('Hi {{worker.name}}');
  });

  it('renames tokens without changing the rendered text, for a worker whose own role differs from the persona role', () => {
    const vars = { 'worker.name': 'Ada', 'worker.role': 'reviewer', 'agent.name': 'Coord', 'worker.reportsTo.name': '', 'worker.signature': '', 'worker.trailer': '', 'worker.url': '', 'session.llmModel': '' };
    const before = 'I am {{name}}, a {{role}}.';
    const legacy = { name: vars['worker.name'], role: vars['worker.role'] };
    expect(applyPlatformVariables(renameLegacyTokens(before), vars)).toBe(applyPlatformVariables(before, vars, legacy));
  });

  it('a dry run fails a row whose source drifted from the served text, as apply would', async () => {
    const agent = await agentWith('coord', 'Hi {{name}}');
    await convert();
    const mem = agent.systemMemoryId!;
    await db.node.updateMany({ where: { memoryId: mem, loc: 'boot:source' }, data: { content: 'Hi {{name}} and more', revSeq: { increment: 1 } } });
    const preview = await migrate(false);
    expect(preview).toMatchObject({ migrated: 0, candidates: 0, failed: 1, rows: [{ outcome: 'failed', reason: 'COMPILED_TEXT_DIFFERS' }] });
    expect(await migrate()).toMatchObject({ migrated: 0, failed: 1, rows: [{ outcome: 'failed', reason: 'NODE_WRITE_CONFLICT' }] });
  });

  it('a dry run byte-compares a worker row too: a worker source that drifted fails as apply would', async () => {
    const agent = await agentWith('coord', 'Agent {{name}}');
    const app = await appWith('mg-app', agent.id);
    const w = await workerOf(app.id, agent.id, 'iris', 'Override {{role}}');
    await convert();
    expect(await migrate(false)).toMatchObject({ migrated: 0, candidates: 2, failed: 0 });
    const install = await db.memory.findFirstOrThrow({ where: { appId: app.id, installOfAgentId: agent.id, isInstallMemory: true } });
    await db.node.updateMany({ where: { memoryId: install.id, loc: `boot:workers:${w.id}:source` }, data: { content: 'Override {{role}} and more', revSeq: { increment: 1 } } });
    const preview = await migrate(false);
    expect(preview).toMatchObject({ applied: false, migrated: 0, candidates: 1, failed: 1 });
    expect(preview.rows.find((r) => r.kind === 'WORKER')).toMatchObject({ outcome: 'failed', reason: 'COMPILED_TEXT_DIFFERS' });
    expect(await migrate()).toMatchObject({ failed: 1 });
  });

  it('refuses to overwrite a source edited between the read and the write', async () => {
    const agent = await agentWith('coord', 'Hi {{name}}');
    await convert();
    const find = db.node.findFirst.bind(db.node) as (...a: unknown[]) => Promise<unknown>;
    let raced = false;
    const spy = vi.spyOn(db.node, 'findFirst').mockImplementation(((...a: unknown[]) => {
      const r = find(...a);
      const sel = (a[0] as { select?: { nodeType?: boolean } })?.select;
      if (!raced && sel?.nodeType) {
        raced = true;
        return r.then(async (v) => {
          await db.node.updateMany({ where: { memoryId: agent.systemMemoryId!, loc: 'boot:source' }, data: { content: 'Hi {{name}} edited', revSeq: { increment: 1 } } });
          return v;
        });
      }
      return r;
    }) as never);
    const report = await migrate();
    spy.mockRestore();
    expect(raced).toBe(true);
    expect(report).toMatchObject({ migrated: 0, failed: 1, rows: [{ outcome: 'failed', reason: 'NODE_WRITE_CONFLICT' }] });
    expect((await db.node.findFirstOrThrow({ where: { memoryId: agent.systemMemoryId!, loc: 'boot:source' } })).content).toBe('Hi {{name}} edited');
  });

  it('a dry run agrees with apply on an include that holds a legacy token apply never renames', async () => {
    const agent = await agentWith('coord', 'Hi {{name}}');
    await convert();
    // The source later gains an include of a part that is not one of the migrated sources, and the Agent is recompiled and approved.
    await db.node.create({ data: { id: generateId(), memoryId: agent.systemMemoryId!, loc: 'parts:a', name: 'a', content: 'Part {{name}}' } });
    await db.node.updateMany({ where: { memoryId: agent.systemMemoryId!, loc: 'boot:source' }, data: { content: 'Hi {{name}} {{> parts:a}}', revSeq: { increment: 1 } } });
    const compiled = await compileBootPrompt(createOperatorConversionContext(db), { kind: 'AGENT', agentId: agent.id }, { setPointer: false });
    await approveCheckedRevision(db, compiled.node.id, compiled.node.content ?? '');
    expect(compiled.node.content).toBe('Hi {{name}} Part {{name}}');
    const preview = await migrate(false);
    expect(preview).toMatchObject({ migrated: 0, candidates: 0, failed: 1, rows: [{ outcome: 'failed', reason: 'COMPILED_TEXT_DIFFERS' }] });
    // The fixture's out-of-band source edit is itself refused by the revision guard; what matters is that apply fails the row too.
    expect(await migrate()).toMatchObject({ migrated: 0, failed: 1 });
  });

  it('a dry run fails a worker row whose include is pinned to the Agent source revision apply is about to supersede', async () => {
    const agent = await agentWith('coord', 'Agent {{name}}');
    const app = await appWith('mg-app', agent.id);
    const w = await workerOf(app.id, agent.id, 'iris', 'Override {{role}}');
    await convert();
    const agentSource = await db.node.findFirstOrThrow({ where: { memoryId: agent.systemMemoryId!, loc: 'boot:source' } });
    const install = await db.memory.findFirstOrThrow({ where: { appId: app.id, installOfAgentId: agent.id, isInstallMemory: true } });
    await db.node.updateMany({ where: { memoryId: install.id, loc: `boot:workers:${w.id}:source` }, data: { content: `{{> boot:source rev=${agentSource.revSeq}}}\n\nOverride {{role}}`, revSeq: { increment: 1 } } });
    const compiled = await compileBootPrompt(createOperatorConversionContext(db), { kind: 'WORKER', workerId: w.id }, { setPointer: false });
    await approveCheckedRevision(db, compiled.node.id, compiled.node.content ?? '');
    const preview = await migrate(false);
    expect(preview.rows.find((r) => r.kind === 'WORKER')).toMatchObject({ outcome: 'failed', reason: 'COMPILED_TEXT_DIFFERS' });
    expect((await migrate()).rows.find((r) => r.kind === 'WORKER')).toMatchObject({ outcome: 'failed' });
  });

  it('reports a converted Agent whose source is gone while its served text still holds a legacy token', async () => {
    const agent = await agentWith('coord', 'Hi {{name}}');
    await convert();
    await db.node.updateMany({ where: { memoryId: agent.systemMemoryId!, loc: 'boot:source' }, data: { deletedAt: new Date() } });
    expect(await migrate()).toMatchObject({ migrated: 0, failed: 1, rows: [{ kind: 'AGENT', id: agent.id, outcome: 'failed', reason: 'SOURCE_MISSING' }] });
  });

  it('approves only the revision whose text was checked', async () => {
    const agent = await agentWith('coord', 'Hi {{name}}');
    await convert();
    const node = await compiledOf('agent', agent.id);
    await db.node.update({ where: { id: node.id }, data: { content: 'edited after the check' } });
    await expect(approveCheckedRevision(db, node.id, node.content ?? '')).rejects.toThrow();
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).approvedRevNo).toBe(node.approvedRevNo);
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
