/**
 * #2046 (S9-4, cor:agt:040:12) — the compile coordinator against a real database:
 * who may call it, the refusals, and that a success writes node, provenance, edge
 * and pointer together while a refusal writes nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppAgent, createDbAppMember, createDbAppWithKey } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { readCompiledRevision, sha256Hex } from '../../../lib/bootCompile/provenance.js';
import { compileBootPrompt, compileNotPermitted, workerCompiledLoc, type CompileTargetInput } from './compileBootPrompt.js';
import type { Context } from './resolvers.helpers.js';
import { resolvers } from './resolvers.js';
import { lockWorkersForAssignment } from '../../../lib/agentTasks/workerLock.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

let orgId: string;
const ctxOf = (userId: string | undefined, extra: Partial<Context> = {}): Context =>
  ({ db, userId, roles: [], clientId: userId ? `user:${userId}` : undefined, ...extra }) as Context;

async function fixture() {
  const user = (name: string) => db.user.create({ data: { id: generateId(), name } });
  const admin = await user('admin');
  await db.orgMember.create({ data: { organizationId: orgId, userId: admin.id, role: 'ADMIN' } });
  const member = await user('member');
  await db.orgMember.create({ data: { organizationId: orgId, userId: member.id, role: 'CONTRIBUTOR' } });
  const agentMem = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'agent-sys', urn: 'cb-org:agent-sys', organizationId: orgId } });
  const agent = await db.agent.create({ data: { id: generateId(), name: 'Agent', urn: 'cb-org:agent', organizationId: orgId, systemMemoryId: agentMem.id } });
  const { app } = await createDbAppWithKey(db, 'cb-app', orgId);
  await createDbAppAgent(db, app.id, agent.id);
  await createDbAppMember(db, app.id, member.id, 'member');
  const install = await db.memory.create({
    data: { id: generateId(), class: 'system', name: 'install', urn: 'cb-org:install', organizationId: orgId, appId: app.id, installOfAgentId: agent.id, isInstallMemory: true },
  });
  const worker = await db.worker.create({ data: { id: generateId(), appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris', signature: '', trailer: '' } });
  const source = (memoryId: string, loc: string, content: string) =>
    db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content, role: 'boot-prompt' } });
  return { admin, member, agent, agentMem, app, install, worker, source };
}
type F = Awaited<ReturnType<typeof fixture>>;

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'cb-org', urn: 'cb-org' } })).id;
});

const codeOf = async (p: Promise<unknown>) => {
  try { await p; return 'NO_ERROR'; } catch (e) { return String((e as { extensions?: { code?: string } }).extensions?.code ?? (e as Error).message); }
};
const snapshot = async () => ({
  nodes: await db.node.count(), revisions: await db.compiledPromptRevision.count(), edges: await db.edge.count(),
  pointers: (await db.agent.findMany({ select: { bootPromptNodeId: true } })).map((a) => a.bootPromptNodeId),
});
const agentTarget = (f: F): CompileTargetInput => ({ kind: 'AGENT', agentId: f.agent.id });

describe('#2046 S9-4 — compileBootPrompt', () => {
  it('S1: an Agent manager gets revision 1, unapproved, with provenance, the compiled-from edge and the pointer', async () => {
    const f = await fixture();
    const src = await f.source(f.agentMem.id, 'boot:source', 'You are {{worker.name}}.');
    const r = await compileBootPrompt(ctxOf(f.admin.id), agentTarget(f));
    expect(r).toMatchObject({ loc: 'boot:compiled', revNo: 1, pointerSet: true, memoryId: f.agentMem.id, contentHash: sha256Hex('You are {{worker.name}}.') });
    const node = await db.node.findUniqueOrThrow({ where: { id: r.nodeId } });
    expect(node).toMatchObject({ content: 'You are {{worker.name}}.', nodeType: 'compiled-boot-prompt', role: 'boot-prompt' });
    expect((await readCompiledRevision(db, r.nodeId, 1))!.provenance.occurrences[0]).toMatchObject({ nodeId: src.id, revNo: src.revSeq });
    expect((await db.compiledPromptRevision.findUniqueOrThrow({ where: { compiledNodeId_compiledRevNo: { compiledNodeId: r.nodeId, compiledRevNo: 1 } } })).compiledBy).toBe(f.admin.id);
    const edge = await db.edge.findFirstOrThrow({ where: { sourceId: r.nodeId, name: 'compiled-from' } });
    expect(edge.targetId).toBe(src.id);
    expect((await db.agent.findUniqueOrThrow({ where: { id: f.agent.id } })).bootPromptNodeId).toBe(r.nodeId);
  });

  it('S4: a recompile with identical text is a NEW revision, one provenance row each, and one live edge', async () => {
    const f = await fixture();
    await f.source(f.agentMem.id, 'boot:source', 'same');
    const one = await compileBootPrompt(ctxOf(f.admin.id), agentTarget(f));
    const two = await compileBootPrompt(ctxOf(f.admin.id), agentTarget(f));
    expect([one.revNo, two.revNo, two.nodeId]).toEqual([1, 2, one.nodeId]);
    expect(await db.compiledPromptRevision.count({ where: { compiledNodeId: one.nodeId } })).toBe(2);
    expect(await db.edge.count({ where: { sourceId: one.nodeId, name: 'compiled-from' } })).toBe(1);
  });

  it('setPointer:false leaves the Agent pointer alone', async () => {
    const f = await fixture();
    await f.source(f.agentMem.id, 'boot:source', 'x');
    const r = await compileBootPrompt(ctxOf(f.admin.id), agentTarget(f), { setPointer: false });
    expect(r.pointerSet).toBe(false);
    expect((await db.agent.findUniqueOrThrow({ where: { id: f.agent.id } })).bootPromptNodeId).toBeNull();
  });

  it('S2: an App compile writes into the install memory and always sets AppAgent.bootPromptRef', async () => {
    const f = await fixture();
    await f.source(f.agentMem.id, 'boot:source', 'agent text');
    const r = await compileBootPrompt(ctxOf(f.admin.id), { kind: 'APP_AGENT', appId: f.app.id, agentId: f.agent.id }, { setPointer: false });
    expect(r).toMatchObject({ memoryId: f.install.id, loc: 'boot:compiled', pointerSet: true });
    const row = await db.appAgent.findUniqueOrThrow({ where: { appId_agentId: { appId: f.app.id, agentId: f.agent.id } } });
    expect(row.bootPromptNodeId).toBe(r.nodeId);
  });

  it('S3: a worker compile writes at the per-worker loc keyed by the stable worker id', async () => {
    const f = await fixture();
    await f.source(f.install.id, `boot:workers:${f.worker.id}:source`, 'for iris');
    const r = await compileBootPrompt(ctxOf(f.admin.id), { kind: 'WORKER', workerId: f.worker.id });
    expect(r).toMatchObject({ memoryId: f.install.id, loc: workerCompiledLoc(f.worker.id), pointerSet: true });
    expect((await db.worker.findUniqueOrThrow({ where: { id: f.worker.id } })).bootPromptNodeId).toBe(r.nodeId);
  });

  it('S6: not permitted for a non-manager, an anonymous caller and a worker session; a missing target answers the same', async () => {
    const f = await fixture();
    await f.source(f.agentMem.id, 'boot:source', 'x');
    const before = await snapshot();
    expect(await codeOf(compileBootPrompt(ctxOf(f.member.id), { kind: 'APP_AGENT', appId: f.app.id, agentId: f.agent.id }))).toBe('BOOT_PROMPT_COMPILE_NOT_PERMITTED');
    expect(await codeOf(compileBootPrompt(ctxOf(undefined), agentTarget(f)))).toBe('BOOT_PROMPT_COMPILE_NOT_PERMITTED');
    expect(await codeOf(compileBootPrompt(ctxOf(f.admin.id, { impersonation: { actorId: f.member.id } } as never), agentTarget(f)))).toBe('BOOT_PROMPT_COMPILE_NOT_PERMITTED');
    expect(await codeOf(compileBootPrompt(ctxOf(f.admin.id), { kind: 'AGENT', agentId: generateId() }))).toBe('BOOT_PROMPT_COMPILE_NOT_PERMITTED');
    expect(await codeOf(compileBootPrompt(ctxOf(f.admin.id), { kind: 'WORKER', workerId: generateId() }))).toBe('BOOT_PROMPT_COMPILE_NOT_PERMITTED');
    expect(await runAsActor({ workerId: f.worker.id, agentId: null }, () => codeOf(compileBootPrompt(ctxOf(f.admin.id), agentTarget(f))))).toBe('BOOT_PROMPT_COMPILE_NOT_PERMITTED');
    expect(await snapshot()).toEqual(before);
  });

  it('refuses a retired worker only to a caller who may compile it', async () => {
    const f = await fixture();
    await f.source(f.install.id, `boot:workers:${f.worker.id}:source`, 'x');
    await db.worker.update({ where: { id: f.worker.id }, data: { retiredAt: new Date() } });
    const before = await snapshot();
    expect(await codeOf(compileBootPrompt(ctxOf(f.admin.id), { kind: 'WORKER', workerId: f.worker.id }))).toBe('BOOT_PROMPT_TARGET_RETIRED');
    expect(await codeOf(compileBootPrompt(ctxOf(f.member.id), { kind: 'WORKER', workerId: f.worker.id }))).toBe('BOOT_PROMPT_COMPILE_NOT_PERMITTED');
    expect(await snapshot()).toEqual(before);
  });

  it('NO_SOURCE writes nothing and produces no empty compiled prompt', async () => {
    const f = await fixture();
    const before = await snapshot();
    expect(await codeOf(compileBootPrompt(ctxOf(f.admin.id), agentTarget(f)))).toBe('BOOT_PROMPT_NO_SOURCE');
    expect(await snapshot()).toEqual(before);
  });

  it('an assembler refusal writes nothing', async () => {
    const f = await fixture();
    await f.source(f.agentMem.id, 'boot:source', 'a {{> parts:missing}} b');
    const before = await snapshot();
    expect(await codeOf(compileBootPrompt(ctxOf(f.admin.id), agentTarget(f)))).toBe('BOOT_PROMPT_INCLUDE_UNAVAILABLE');
    expect(await snapshot()).toEqual(before);
  });

  it('a failure AFTER the node, row and pointer are written (the edge) rolls all of them back', async () => {
    const f = await fixture();
    const src = await f.source(f.agentMem.id, 'boot:source', 'x');
    const other = await f.source(f.agentMem.id, 'boot:other', 'y');
    // Occupy the derived edge's loc so the compile's edge insert fails last.
    await db.edge.create({ data: { id: generateId(), memoryId: f.agentMem.id, sourceId: other.id, targetId: src.id, loc: 'boot:compiled:compiled-from:boot:source', name: 'x' } });
    const before = await snapshot();
    expect(await codeOf(compileBootPrompt(ctxOf(f.admin.id), agentTarget(f)))).not.toBe('NO_ERROR');
    expect(await snapshot()).toEqual(before);
  });

  it('the GraphQL doors: success returns the unapproved revision; an unknown ref and a non-manager are alike FORBIDDEN', async () => {
    const f = await fixture();
    await f.source(f.agentMem.id, 'boot:source', 'door');
    const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<{ revNo: number; approvalIssued: boolean; pointerSet: boolean; node: { id: string } }>>;
    const ok = await M.compileAgentBootPrompt!(null, { agentRef: f.agent.id }, ctxOf(f.admin.id));
    expect(ok).toMatchObject({ revNo: 1, approvalIssued: false, pointerSet: true });
    expect(await codeOf(M.compileAgentBootPrompt!(null, { agentRef: 'no-such-agent' }, ctxOf(f.admin.id)))).toBe('BOOT_PROMPT_COMPILE_NOT_PERMITTED');
    expect(await codeOf(M.compileAgentBootPrompt!(null, { agentRef: f.agent.id }, ctxOf(f.member.id)))).toBe('BOOT_PROMPT_COMPILE_NOT_PERMITTED');
    expect(await codeOf(M.compileWorkerBootPrompt!(null, { workerRef: 'nope' }, ctxOf(f.admin.id)))).toBe('BOOT_PROMPT_COMPILE_NOT_PERMITTED');
    expect(await codeOf(M.compileAppAgentBootPrompt!(null, { appRef: 'nope', agentRef: f.agent.id }, ctxOf(f.admin.id)))).toBe('BOOT_PROMPT_COMPILE_NOT_PERMITTED');
  });

  it('S2: an App compile carries the install memory replacing node and records it as a replacement', async () => {
    const f = await fixture();
    await f.source(f.agentMem.id, 'boot:source', 'Style: {{> policies:style}}');
    const own = await db.node.create({ data: { id: generateId(), memoryId: f.agentMem.id, loc: 'policies:style', name: 's', content: 'agent style' } });
    await db.node.create({ data: { id: generateId(), memoryId: f.install.id, loc: 'policies:style', name: 's', content: 'app style' } });
    const r = await compileBootPrompt(ctxOf(f.admin.id), { kind: 'APP_AGENT', appId: f.app.id, agentId: f.agent.id });
    expect((await db.node.findUniqueOrThrow({ where: { id: r.nodeId } })).content).toBe('Style: app style');
    const prov = (await readCompiledRevision(db, r.nodeId, 1))!.provenance.occurrences;
    expect(prov[1]).toMatchObject({ kind: 'replacement', replacesNodeId: own.id });
  });

  it('a same-organisation base part with no grant is provisioned by the compile; a foreign Agent without one refuses and writes nothing', async () => {
    const f = await fixture();
    const partMem = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'part-sys', urn: 'cb-org:part-sys', organizationId: orgId } });
    const part = await db.agent.create({ data: { id: generateId(), name: 'Part', urn: 'cb-org:part', organizationId: orgId, systemMemoryId: partMem.id, visibility: 'ORGANIZATION' } });
    await db.agent.update({ where: { id: f.agent.id }, data: { extendsAgentId: part.id } });
    await db.node.create({ data: { id: generateId(), memoryId: partMem.id, loc: 'parts:rules', name: 'r', content: 'base rules' } });
    await f.source(f.agentMem.id, 'boot:source', '{{> parts:rules}}');
    expect(await db.agentOrgGrant.count({ where: { orgId, agentId: part.id } })).toBe(0);
    const r = await compileBootPrompt(ctxOf(f.admin.id), agentTarget(f));
    expect((await db.node.findUniqueOrThrow({ where: { id: r.nodeId } })).content).toBe('base rules');
    expect(await db.agentOrgGrant.count({ where: { orgId, agentId: part.id, revokedAt: null } })).toBe(1);
  });

  it('a foreign Agent base with no grant is refused BOOT_PROMPT_GRANT_REQUIRED and nothing is written or granted', async () => {
    const f = await fixture();
    const other = (await db.organization.create({ data: { id: generateId(), name: 'cb-other', urn: 'cb-other' } })).id;
    const fm = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'f-sys', urn: 'cb-other:f-sys', organizationId: other } });
    const foreign = await db.agent.create({ data: { id: generateId(), name: 'Foreign', urn: 'cb-other:foreign', organizationId: other, systemMemoryId: fm.id, visibility: 'PUBLIC' } });
    await db.agent.update({ where: { id: f.agent.id }, data: { extendsAgentId: foreign.id } });
    await db.node.create({ data: { id: generateId(), memoryId: fm.id, loc: 'parts:rules', name: 'r', content: 'foreign' } });
    await f.source(f.agentMem.id, 'boot:source', '{{> parts:rules}}');
    const before = { ...(await snapshot()), grants: await db.agentOrgGrant.count() };
    expect(await codeOf(compileBootPrompt(ctxOf(f.admin.id), agentTarget(f)))).toBe('BOOT_PROMPT_GRANT_REQUIRED');
    expect({ ...(await snapshot()), grants: await db.agentOrgGrant.count() }).toEqual(before);
  });

  it('Rook P2-1: a stranger and an anonymous caller are refused at once while the platform fence is held; a manager waits on the budget and gets the sanitized conflict', async () => {
    const f = await fixture();
    await f.source(f.agentMem.id, 'boot:source', 'x');
    const stranger = (await db.user.create({ data: { id: generateId(), name: 'stranger' } })).id;
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const lockTaken = new Promise<void>((r) => { locked = r; });
    const holder = db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(2063, 1772)`;
      locked();
      await held;
    }, { timeout: 20_000 });
    await lockTaken;
    try {
      const quick = async (c: Context) => Promise.race([
        codeOf(compileBootPrompt(c, agentTarget(f))),
        new Promise<string>((r) => setTimeout(() => r('BLOCKED'), 1500)),
      ]);
      expect(await quick(ctxOf(stranger))).toBe('BOOT_PROMPT_COMPILE_NOT_PERMITTED');
      expect(await quick(ctxOf(undefined))).toBe('BOOT_PROMPT_COMPILE_NOT_PERMITTED');
      expect(await quick(ctxOf(f.member.id))).toBe('BOOT_PROMPT_COMPILE_NOT_PERMITTED');
      // The manager does queue, but only for the operation budget, then gets one fixed answer.
      const started = Date.now();
      expect(await codeOf(compileBootPrompt(ctxOf(f.admin.id), agentTarget(f), { budgetMs: 400 }))).toBe('CONFLICT');
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      release();
      await holder;
    }
  });

  it('an exhausted budget refuses before any transaction opens', async () => {
    const f = await fixture();
    await f.source(f.agentMem.id, 'boot:source', 'x');
    const before = await snapshot();
    expect(await codeOf(compileBootPrompt(ctxOf(f.admin.id), agentTarget(f), { budgetMs: 0 }))).toBe('CONFLICT');
    expect(await snapshot()).toEqual(before);
  });

  it('Anne P2-2/P2-3: the door tells a retired Agent\'s manager TARGET_RETIRED, everyone else NOT_PERMITTED, and a DB fault is not a denial', async () => {
    const f = await fixture();
    await f.source(f.agentMem.id, 'boot:source', 'x');
    await db.agent.update({ where: { id: f.agent.id }, data: { deletedAt: new Date() } });
    const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<unknown>>;
    expect(await codeOf(M.compileAgentBootPrompt!(null, { agentRef: f.agent.id }, ctxOf(f.admin.id)))).toBe('BOOT_PROMPT_TARGET_RETIRED');
    expect(await codeOf(M.compileAgentBootPrompt!(null, { agentRef: f.agent.id }, ctxOf(f.member.id)))).toBe('BOOT_PROMPT_COMPILE_NOT_PERMITTED');
    expect(await codeOf(M.compileAppAgentBootPrompt!(null, { appRef: f.app.id, agentRef: f.agent.id }, ctxOf(f.admin.id)))).toBe('BOOT_PROMPT_TARGET_RETIRED');
    const broken = { ...ctxOf(f.admin.id), db: new Proxy(db, { get: (t, k) => (k === 'agent' ? { findFirst: () => { throw new Error('connection lost'); } } : (t as never)[k]) }) } as Context;
    expect(await codeOf(M.compileAgentBootPrompt!(null, { agentRef: f.agent.id }, broken))).toBe('connection lost');
  });

  it('Dara P2-1: the target Agent is qualified even when the source is install-only text', async () => {
    const f = await fixture();
    await f.source(f.install.id, 'boot:source', 'literal only');
    // A same-org Agent with no grant is provisioned, a revoked one is refused and never revived.
    const app = { kind: 'APP_AGENT', appId: f.app.id, agentId: f.agent.id } as const;
    await compileBootPrompt(ctxOf(f.admin.id), app);
    expect(await db.agentOrgGrant.count({ where: { orgId, agentId: f.agent.id, revokedAt: null } })).toBe(1);
    await db.agentOrgGrant.updateMany({ where: { orgId, agentId: f.agent.id }, data: { revokedAt: new Date() } });
    expect(await codeOf(compileBootPrompt(ctxOf(f.admin.id), app))).toBe('BOOT_PROMPT_GRANT_REQUIRED');
    expect(await db.agentOrgGrant.count({ where: { orgId, agentId: f.agent.id, revokedAt: null } })).toBe(0);
  });

  it('Dara P2-1: a foreign PUBLIC Agent installed in an App with install-only text, no grant, is refused GRANT_REQUIRED and nothing is written', async () => {
    const f = await fixture();
    const other = (await db.organization.create({ data: { id: generateId(), name: 'cb-foreign', urn: 'cb-foreign' } })).id;
    const fm = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'fa-sys', urn: 'cb-foreign:fa-sys', organizationId: other } });
    const fa = await db.agent.create({ data: { id: generateId(), name: 'FA', urn: 'cb-foreign:fa', organizationId: other, systemMemoryId: fm.id, visibility: 'PUBLIC' } });
    await createDbAppAgent(db, f.app.id, fa.id);
    const inst = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'fa-install', urn: 'cb-org:fa-install', organizationId: orgId, appId: f.app.id, installOfAgentId: fa.id, isInstallMemory: true } });
    await f.source(inst.id, 'boot:source', 'literal only');
    const before = await snapshot();
    expect(await codeOf(compileBootPrompt(ctxOf(f.admin.id), { kind: 'APP_AGENT', appId: f.app.id, agentId: fa.id }))).toBe('BOOT_PROMPT_GRANT_REQUIRED');
    expect(await snapshot()).toEqual(before);
  });

  it('Dara P2-2: an App with no install memory yet compiles the Agent source and creates the memory; a refusal leaves none', async () => {
    const f = await fixture();
    await db.worker.deleteMany({ where: { appId: f.app.id } });
    await db.memory.delete({ where: { id: f.install.id } });
    const app = { kind: 'APP_AGENT', appId: f.app.id, agentId: f.agent.id } as const;
    const installs = () => db.memory.count({ where: { appId: f.app.id, installOfAgentId: f.agent.id, isInstallMemory: true } });
    expect(await codeOf(compileBootPrompt(ctxOf(f.admin.id), app))).toBe('BOOT_PROMPT_NO_SOURCE');
    expect(await installs()).toBe(0);
    await f.source(f.agentMem.id, 'boot:source', 'agent text');
    expect(await codeOf(compileBootPrompt(ctxOf(f.member.id), app))).toBe('BOOT_PROMPT_COMPILE_NOT_PERMITTED');
    expect(await installs()).toBe(0);
    const r = await compileBootPrompt(ctxOf(f.admin.id), app);
    expect(await installs()).toBe(1);
    expect((await db.node.findUniqueOrThrow({ where: { id: r.nodeId } })).content).toBe('agent text');
  });

  it('Anne/Dara P3: a failure at the POINTER stage, after a provisioned grant, rolls back node, revision, row, edge, grant and pointers', async () => {
    const f = await fixture();
    const partMem = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'part-sys', urn: 'cb-org:part-sys', organizationId: orgId } });
    const part = await db.agent.create({ data: { id: generateId(), name: 'Part', urn: 'cb-org:part', organizationId: orgId, systemMemoryId: partMem.id, visibility: 'ORGANIZATION' } });
    await db.agent.update({ where: { id: f.agent.id }, data: { extendsAgentId: part.id } });
    await db.node.create({ data: { id: generateId(), memoryId: partMem.id, loc: 'parts:rules', name: 'r', content: 'base rules' } });
    await f.source(f.agentMem.id, 'boot:source', '{{> parts:rules}}');
    await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION cb_fail_pointer() RETURNS trigger AS $$ BEGIN
      IF NEW.boot_prompt_node_id IS DISTINCT FROM OLD.boot_prompt_node_id THEN RAISE EXCEPTION 'pointer stage fault'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await db.$executeRawUnsafe('CREATE TRIGGER cb_fail_pointer BEFORE UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION cb_fail_pointer()');
    try {
      const full = async () => ({ ...(await snapshot()), grants: await db.agentOrgGrant.count(), nodeRevisions: await db.nodeRevision.count() });
      const before = await full();
      expect(await codeOf(compileBootPrompt(ctxOf(f.admin.id), agentTarget(f)))).not.toBe('NO_ERROR');
      expect(await full()).toEqual(before);
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS cb_fail_pointer ON agents');
      await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS cb_fail_pointer()');
    }
  });

  it('Rook P3-2: an include in a memory the caller cannot read is UNAVAILABLE, in one they can read but may not include from, DISALLOWED', async () => {
    const f = await fixture();
    const readable = await db.memory.create({ data: { id: generateId(), class: 'knowledge', name: 'k', urn: 'cb-org:know', organizationId: orgId, visibility: 'ORGANIZATION' } });
    await db.node.create({ data: { id: generateId(), memoryId: readable.id, loc: 'parts:k', name: 'k', content: 'k' } });
    const otherOrg = (await db.organization.create({ data: { id: generateId(), name: 'cb-hidden', urn: 'cb-hidden' } })).id;
    const hidden = await db.memory.create({ data: { id: generateId(), class: 'knowledge', name: 'h', urn: 'cb-hidden:know', organizationId: otherOrg, visibility: 'ORGANIZATION' } });
    await db.node.create({ data: { id: generateId(), memoryId: hidden.id, loc: 'parts:k', name: 'k', content: 'k' } });
    const src = await f.source(f.agentMem.id, 'boot:source', '{{> hrn:node:cb-org:know:parts:k}}');
    expect(await codeOf(compileBootPrompt(ctxOf(f.admin.id), agentTarget(f)))).toBe('BOOT_PROMPT_INCLUDE_SOURCE_DISALLOWED');
    await db.node.update({ where: { id: src.id }, data: { content: '{{> hrn:node:cb-hidden:know:parts:k}}' } });
    expect(await codeOf(compileBootPrompt(ctxOf(f.admin.id), agentTarget(f)))).toBe('BOOT_PROMPT_INCLUDE_UNAVAILABLE');
  });

  it('Vera: only a compile writes a compiled node; an ordinary update or create at a compiled address is refused', async () => {
    const f = await fixture();
    await f.source(f.agentMem.id, 'boot:source', 'x');
    const r = await compileBootPrompt(ctxOf(f.admin.id), agentTarget(f));
    const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<unknown>>;
    expect(await codeOf(M.updateNode!(null, { input: { id: r.nodeId, content: 'forged' } }, ctxOf(f.admin.id)))).toBe('BOOT_PROMPT_COMPILED_WRITE');
    expect(await codeOf(M.createNode!(null, { input: { memoryId: f.agentMem.id, loc: 'boot:other', name: 'x', content: 'y', role: 'boot-prompt', nodeType: 'compiled-boot-prompt' } }, ctxOf(f.admin.id)))).toBe('BOOT_PROMPT_COMPILED_WRITE');
    expect((await db.node.findUniqueOrThrow({ where: { id: r.nodeId } })).content).toBe('x');
  });

  it('Anne P2-1: an owner probe that stalls past the budget ends in the sanitized CONFLICT, not after it', async () => {
    const f = await fixture();
    await f.source(f.agentMem.id, 'boot:source', 'x');
    const slow = { ...ctxOf(f.admin.id), db: new Proxy(db, { get: (t, k) => (k === 'agent' ? { findUnique: () => new Promise((r) => setTimeout(() => r(null), 1500)) } : (t as never)[k]) }) } as Context;
    const started = Date.now();
    expect(await codeOf(compileBootPrompt(slow, agentTarget(f), { budgetMs: 200 }))).toBe('CONFLICT');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('Xylon: the assembler runs on the deciding transaction, after the locks (it sees an uncommitted part written inside the fence)', async () => {
    const f = await fixture();
    await f.source(f.agentMem.id, 'boot:source', 'A {{> parts:late}} B');
    const r = await compileBootPrompt(ctxOf(f.admin.id), agentTarget(f), {
      seams: {
        beforeAssemble: async (tx) => {
          await tx.node.create({ data: { id: generateId(), memoryId: f.agentMem.id, loc: 'parts:late', name: 'l', content: 'late part' } });
        },
      },
    });
    expect((await db.node.findUniqueOrThrow({ where: { id: r.nodeId } })).content).toBe('A late part B');
  });

  it('Xylon: an owner that drifts between the pre-read and the fence is retried with the new anchors; the third drift is the sanitized CONFLICT', async () => {
    const f = await fixture();
    await f.source(f.agentMem.id, 'boot:source', 'x');
    const second = (await db.organization.create({ data: { id: generateId(), name: 'cb-two', urn: 'cb-two' } })).id;
    await db.orgMember.create({ data: { organizationId: second, userId: f.admin.id, role: 'ADMIN' } });
    let attempts = 0;
    const orgs = [orgId, second];
    const drift = async (attempt: number) => {
      attempts = attempt + 1;
      await db.agent.update({ where: { id: f.agent.id }, data: { organizationId: orgs[(attempt + 1) % 2]! } });
    };
    // Drifts on attempts 0 and 1 only: attempt 2 settles.
    const r = await compileBootPrompt(ctxOf(f.admin.id), agentTarget(f), { seams: { beforeFence: async (a) => { if (a < 2) await drift(a); } } });
    expect(attempts).toBe(2);
    expect(r.revNo).toBe(1);
    // Drifts every time: exhausted.
    const before = await snapshot();
    expect(await codeOf(compileBootPrompt(ctxOf(f.admin.id), agentTarget(f), { seams: { beforeFence: drift } }))).toBe('CONFLICT');
    expect((await snapshot()).revisions).toBe(before.revisions);
  });

  it('Xylon: a caller denied on the FRESH owner is refused at once, never retried or reported as drift', async () => {
    const f = await fixture();
    await f.source(f.agentMem.id, 'boot:source', 'x');
    const foreignOrg = (await db.organization.create({ data: { id: generateId(), name: 'cb-nomember', urn: 'cb-nomember' } })).id;
    let beforeFenceCalls = 0;
    expect(await codeOf(compileBootPrompt(ctxOf(f.admin.id), agentTarget(f), {
      seams: { beforeFence: async () => { beforeFenceCalls++; await db.agent.update({ where: { id: f.agent.id }, data: { organizationId: foreignOrg } }); } },
    }))).toBe('BOOT_PROMPT_COMPILE_NOT_PERMITTED');
    expect(beforeFenceCalls).toBe(1);
  });

  it('Xylon: the budget spans the drift retries (a slow first attempt leaves nothing for the second)', async () => {
    const f = await fixture();
    await f.source(f.agentMem.id, 'boot:source', 'x');
    const second = (await db.organization.create({ data: { id: generateId(), name: 'cb-three', urn: 'cb-three' } })).id;
    await db.orgMember.create({ data: { organizationId: second, userId: f.admin.id, role: 'ADMIN' } });
    expect(await codeOf(compileBootPrompt(ctxOf(f.admin.id), agentTarget(f), {
      budgetMs: 250,
      seams: { beforeFence: async (a) => { if (a === 0) { await new Promise((r) => setTimeout(r, 400)); await db.agent.update({ where: { id: f.agent.id }, data: { organizationId: second } }); } } },
    }))).toBe('CONFLICT');
  });
});

describe('#2047 PR-C (§10 #2698): a worker compile locks its pointer owner before it writes the compiled node', () => {
  it('parked on the worker assignment lock, the compile holds no lock on the compiled node (bind order: assignment, worker, node)', async () => {
    const f = await fixture();
    await f.source(f.install.id, `boot:workers:${f.worker.id}:source`, 'for iris');
    const first = await compileBootPrompt(ctxOf(f.admin.id), { kind: 'WORKER', workerId: f.worker.id });
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => { locked = r; });
    const holder = db.$transaction(async (tx) => {
      await lockWorkersForAssignment(tx, [f.worker.id]);
      locked();
      await held;
    });
    await lockedP;
    let done = false;
    const recompiling = compileBootPrompt(ctxOf(f.admin.id), { kind: 'WORKER', workerId: f.worker.id }).then((r) => { done = true; return r; });
    await new Promise((r) => setTimeout(r, 500));
    expect(done).toBe(false); // parked behind the assignment lock
    // A bind that already holds the assignment lock wants the node next: it must be free to take it.
    await expect(db.$transaction((tx) => tx.$queryRaw`SELECT id FROM nodes WHERE id = ${first.nodeId} FOR SHARE NOWAIT`)).resolves.toBeTruthy();
    release();
    await holder;
    expect((await recompiling).revNo).toBe(2);
  });
});
