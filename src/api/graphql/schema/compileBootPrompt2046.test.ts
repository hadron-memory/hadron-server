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
import { compileBootPrompt, workerCompiledLoc, type CompileTargetInput } from './compileBootPrompt.js';
import type { Context } from './resolvers.helpers.js';
import { resolvers } from './resolvers.js';

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
    expect(await codeOf(compileBootPrompt(ctxOf(f.member.id), { kind: 'APP_AGENT', appId: f.app.id, agentId: f.agent.id }))).toBe('FORBIDDEN');
    expect(await codeOf(compileBootPrompt(ctxOf(undefined), agentTarget(f)))).toBe('FORBIDDEN');
    expect(await codeOf(compileBootPrompt(ctxOf(f.admin.id, { impersonation: { actorId: f.member.id } } as never), agentTarget(f)))).toBe('FORBIDDEN');
    expect(await codeOf(compileBootPrompt(ctxOf(f.admin.id), { kind: 'AGENT', agentId: generateId() }))).toBe('FORBIDDEN');
    expect(await codeOf(compileBootPrompt(ctxOf(f.admin.id), { kind: 'WORKER', workerId: generateId() }))).toBe('FORBIDDEN');
    expect(await runAsActor({ workerId: f.worker.id, agentId: null }, () => codeOf(compileBootPrompt(ctxOf(f.admin.id), agentTarget(f))))).toBe('BOOT_PROMPT_POINTER_SESSION_REFUSED');
    expect(await snapshot()).toEqual(before);
  });

  it('refuses a retired worker only to a caller who may compile it', async () => {
    const f = await fixture();
    await f.source(f.install.id, `boot:workers:${f.worker.id}:source`, 'x');
    await db.worker.update({ where: { id: f.worker.id }, data: { retiredAt: new Date() } });
    const before = await snapshot();
    expect(await codeOf(compileBootPrompt(ctxOf(f.admin.id), { kind: 'WORKER', workerId: f.worker.id }))).toBe('BOOT_PROMPT_TARGET_RETIRED');
    expect(await codeOf(compileBootPrompt(ctxOf(f.member.id), { kind: 'WORKER', workerId: f.worker.id }))).toBe('FORBIDDEN');
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
    expect(await codeOf(M.compileAgentBootPrompt!(null, { agentRef: 'no-such-agent' }, ctxOf(f.admin.id)))).toBe('FORBIDDEN');
    expect(await codeOf(M.compileAgentBootPrompt!(null, { agentRef: f.agent.id }, ctxOf(f.member.id)))).toBe('FORBIDDEN');
    expect(await codeOf(M.compileWorkerBootPrompt!(null, { workerRef: 'nope' }, ctxOf(f.admin.id)))).toBe('FORBIDDEN');
    expect(await codeOf(M.compileAppAgentBootPrompt!(null, { appRef: 'nope', agentRef: f.agent.id }, ctxOf(f.admin.id)))).toBe('FORBIDDEN');
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
});
