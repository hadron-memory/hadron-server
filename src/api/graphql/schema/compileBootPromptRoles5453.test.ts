/**
 * #5453 PR A (Asks 1, 3, 4) — the boot-prompt family by leaf, against a real database.
 *
 * A compile writes `system` / `boot-prompt.compiled`; the source address takes a source (the leaf or the bare
 * legacy role) and neither a rule nor a compiled node; a pointer names a compiled node by role; a rule is a
 * first-class member of the family (manager approval, lint, a read that shows variables as written) and a base
 * Agent's rule is still inherited, where a base's boot prompt itself never is.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppAgent, createDbAppWithKey } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { withCompileWrite } from '../../../lib/bootPrompt.js';
import { loadBootPromptPointerOwner, validateBootPromptPointer } from '../../../lib/bootPromptPointer.js';
import { findEffectiveNodeIdByLoc } from '../../../lib/effectiveSystemMemory.js';
import { inheritable } from '../../../lib/actionRegister/lookup.js';
import { lintSourceWarnings } from '../../../lib/bootPromptLint.js';
import { sourceForCompile } from '../../../lib/bootCompile/sourceForCompile.js';
import { approveNodeInTransaction } from '../../../lib/nodeApproval.js';
import { compileBootPrompt, type CompileTargetInput } from './compileBootPrompt.js';
import type { Context } from './resolvers.helpers.js';
import { resolvers } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const COMPILED = 'boot-prompt.compiled';
const SOURCE = 'boot-prompt.source';
const RULE = 'boot-prompt.rule';
const M = resolvers.Mutation as any;

let orgId: string;
const ctxOf = (userId: string | undefined, extra: Partial<Context> = {}): Context =>
  ({ db, userId, roles: [], clientId: userId ? `user:${userId}` : undefined, ...extra }) as Context;
const put = (memoryId: string, loc: string, content: string, extra: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content, ...extra } });

async function fixture() {
  const user = (name: string) => db.user.create({ data: { id: generateId(), name, handle: `r5453-${name}-${generateId().slice(-6)}` } });
  const admin = await user('admin');
  await db.orgMember.create({ data: { organizationId: orgId, userId: admin.id, role: 'ADMIN' } });
  const writer = await user('writer');
  await db.orgMember.create({ data: { organizationId: orgId, userId: writer.id, role: 'CONTRIBUTOR' } });
  const baseMem = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'base-sys', urn: 'r5453-org:base-sys', organizationId: orgId } });
  const base = await db.agent.create({ data: { id: generateId(), name: 'Base', urn: 'r5453-org:base', organizationId: orgId, systemMemoryId: baseMem.id } });
  const agentMem = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'agent-sys', urn: 'r5453-org:agent-sys', organizationId: orgId } });
  const agent = await db.agent.create({ data: { id: generateId(), name: 'Agent', urn: 'r5453-org:agent', organizationId: orgId, systemMemoryId: agentMem.id, extendsAgentId: base.id } });
  const { app } = await createDbAppWithKey(db, 'r5453-app', orgId);
  await createDbAppAgent(db, app.id, agent.id);
  const worker = await db.worker.create({ data: { id: generateId(), appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris', signature: '', trailer: '' } });
  return { admin, writer, base, baseMem, agent, agentMem, app, worker };
}
type F = Awaited<ReturnType<typeof fixture>>;
const agentTarget = (f: F): CompileTargetInput => ({ kind: 'AGENT', agentId: f.agent.id });
const codeOf = async (p: Promise<unknown>) => {
  try { await p; return 'NO_ERROR'; } catch (e) { return String((e as { extensions?: { code?: string } }).extensions?.code ?? (e as { code?: string }).code ?? (e as Error).message); }
};

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'r5453-org', urn: 'r5453-org' } })).id;
});

describe('#5453 Ask 1: the compile writes system / boot-prompt.compiled', () => {
  it('a first compile creates the node as type system with the compiled role, and a recompile revises that same node', async () => {
    const f = await fixture();
    await put(f.agentMem.id, 'boot:source', 'You are {{worker.name}}.', { nodeType: 'system', role: SOURCE });
    const one = await compileBootPrompt(ctxOf(f.admin.id), agentTarget(f));
    expect(await db.node.findUniqueOrThrow({ where: { id: one.nodeId } })).toMatchObject({ nodeType: 'system', role: COMPILED, loc: 'boot:compiled' });
    const two = await compileBootPrompt(ctxOf(f.admin.id), agentTarget(f));
    expect([two.nodeId, two.revNo]).toEqual([one.nodeId, 2]);
    expect(await db.node.findUniqueOrThrow({ where: { id: one.nodeId } })).toMatchObject({ nodeType: 'system', role: COMPILED });
    expect(await db.node.count({ where: { nodeType: 'compiled-boot-prompt' } })).toBe(0);
  });

  it('a compiled address held by a node that is not compiled (a source, by role) is a CONFLICT, as before', async () => {
    const f = await fixture();
    await put(f.agentMem.id, 'boot:source', 'x', { nodeType: 'system', role: SOURCE });
    await put(f.agentMem.id, 'boot:compiled', 'squatter', { nodeType: 'system', role: SOURCE });
    expect(await codeOf(compileBootPrompt(ctxOf(f.admin.id), agentTarget(f)))).toBe('CONFLICT');
  });
});

describe('#5453 Ask 3: the source address', () => {
  it.each([
    ['the source leaf', { nodeType: 'system', role: SOURCE }],
    ['the bare legacy role a Git-synced source may still carry', { nodeType: 'info', role: 'boot-prompt' }],
  ])('%s compiles', async (_name, kind) => {
    const f = await fixture();
    await put(f.agentMem.id, 'boot:source', 'plain text', kind);
    expect((await compileBootPrompt(ctxOf(f.admin.id), agentTarget(f))).revNo).toBe(1);
  });

  it.each([
    ['a rule', { nodeType: 'system', role: RULE }],
    ['a compiled node', { nodeType: 'system', role: COMPILED }],
    ['a node outside the family', { nodeType: 'system', role: 'notes' }],
  ])('%s at the source address is BOOT_PROMPT_SOURCE_INVALID and nothing is written', async (_name, kind) => {
    const f = await fixture();
    await withCompileWrite(() => put(f.agentMem.id, 'boot:source', 'not a source', kind));
    const before = await db.node.count();
    expect(await codeOf(db.$transaction((tx) => sourceForCompile(tx, { kind: 'AGENT', agentMemoryId: f.agentMem.id } as never)))).toBe('BOOT_PROMPT_SOURCE_INVALID');
    expect(await codeOf(compileBootPrompt(ctxOf(f.admin.id), agentTarget(f)))).toBe('BOOT_PROMPT_SOURCE_INVALID');
    expect(await db.node.count()).toBe(before);
  });
});

describe('#5453 Ask 4: a base Agent\'s rule is inherited; its boot prompt is not', () => {
  it('a derived Agent whose source includes its base\'s boot:rules:* node compiles, with the rule\'s text in the output', async () => {
    const f = await fixture();
    await put(f.baseMem.id, 'boot:rules:core-channel', 'Post in the team channel.', { nodeType: 'system', role: RULE });
    await put(f.agentMem.id, 'boot:source', 'You are a worker.\n{{> boot:rules:core-channel}}', { nodeType: 'system', role: SOURCE });
    const r = await compileBootPrompt(ctxOf(f.admin.id), agentTarget(f));
    expect((await db.node.findUniqueOrThrow({ where: { id: r.nodeId } })).content).toBe('You are a worker.\nPost in the team channel.');
  });

  it.each([
    ['source', SOURCE], ['compiled node', COMPILED], ['bare boot-prompt node', 'boot-prompt'], ['unknown sub-kind', 'boot-prompt.coordinator'],
  ])('a base\'s %s is still never inherited by an include', async (_name, role) => {
    const f = await fixture();
    await withCompileWrite(() => put(f.baseMem.id, 'parts:boot', 'base boot', { nodeType: 'system', role }));
    await put(f.agentMem.id, 'boot:source', '{{> parts:boot}}', { nodeType: 'system', role: SOURCE });
    expect(await codeOf(compileBootPrompt(ctxOf(f.admin.id), agentTarget(f)))).toBe('BOOT_PROMPT_INCLUDE_UNAVAILABLE');
  });

  it('the effective system memory and the action register inherit a base rule, and still not a base source or compiled node', async () => {
    const f = await fixture();
    const rule = await put(f.baseMem.id, 'boot:rules:core', 'rule', { nodeType: 'system', role: RULE });
    await put(f.baseMem.id, 'boot:source', 'base source', { nodeType: 'system', role: SOURCE });
    await withCompileWrite(() => put(f.baseMem.id, 'boot:compiled', 'base compiled', { nodeType: 'system', role: COMPILED }));
    expect((await findEffectiveNodeIdByLoc(db, f.agentMem.id, 'boot:rules:core'))?.id).toBe(rule.id);
    expect(await findEffectiveNodeIdByLoc(db, f.agentMem.id, 'boot:source')).toBeNull();
    expect(await findEffectiveNodeIdByLoc(db, f.agentMem.id, 'boot:compiled')).toBeNull();
    expect(inheritable({ nodeType: 'system', role: RULE })).toBe(true);
    for (const role of [SOURCE, COMPILED, 'boot-prompt', 'boot-prompt.coordinator']) expect(inheritable({ nodeType: 'system', role })).toBe(false);
  });
});

describe('#5453: a pointer names a compiled node, by role', () => {
  const validate = (f: F, nodeId: string) => db.$transaction(async (tx) => {
    const owner = await loadBootPromptPointerOwner(tx, { field: 'AGENT', agentId: f.agent.id });
    return validateBootPromptPointer(tx, owner!, nodeId, async () => true);
  });

  it('accepts a system / boot-prompt.compiled node in the Agent\'s system memory', async () => {
    const f = await fixture();
    const c = await withCompileWrite(() => put(f.agentMem.id, 'boot:compiled', 'c', { nodeType: 'system', role: COMPILED }));
    expect((await validate(f, c.id)).id).toBe(c.id);
  });

  it.each([
    ['a source', SOURCE], ['a rule', RULE], ['a bare boot-prompt node', 'boot-prompt'], ['a plain system node', null],
  ])('refuses %s with BOOT_PROMPT_POINTER_NOT_COMPILED', async (_name, role) => {
    const f = await fixture();
    const n = await put(f.agentMem.id, 'boot:other', 'x', { nodeType: 'system', role });
    expect(await codeOf(validate(f, n.id))).toBe('BOOT_PROMPT_POINTER_NOT_COMPILED');
  });
});

describe('#5453 Ask 4: a rule is a first-class member of the family', () => {
  it('only whoever manages the Agent approves a rule placed in its system memory; a worker session never does', async () => {
    const f = await fixture();
    const rule = await put(f.agentMem.id, 'boot:rules:core', 'a rule', { nodeType: 'system', role: RULE });
    const legacy = await put(f.agentMem.id, 'boot:rules:legacy', 'a rule under the old role', { role: 'boot-prompt-rule' });
    // The gate a caller who may write the memory but does not manage the Agent gets (bootPromptApprovalGate), applied
    // to the locked row by role: the rule is refused; the role it carried before #5453 was outside the family and passes.
    const asWriter = (nodeId: string) => db.$transaction((tx) => approveNodeInTransaction(tx, nodeId, {
      memoryId: f.agentMem.id, approver: { userId: f.writer.id }, key: null,
      bootPromptGate: { placed: true, refusal: 'BOOT_PROMPT_APPROVAL_FORBIDDEN' },
    }));
    expect(await codeOf(asWriter(rule.id))).toBe('BOOT_PROMPT_APPROVAL_FORBIDDEN');
    expect(await codeOf(asWriter(legacy.id))).toBe('NO_ERROR');
    expect(await codeOf(runAsActor({ workerId: f.worker.id, agentId: null }, () => M.approveNode(null, { nodeRef: rule.id }, ctxOf(f.admin.id)))))
      .toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect((await db.node.findUniqueOrThrow({ where: { id: rule.id } })).approvedRevNo).toBeNull();
    expect(await codeOf(M.approveNode(null, { nodeRef: rule.id }, ctxOf(f.admin.id)))).toBe('NO_ERROR');
    expect((await db.node.findUniqueOrThrow({ where: { id: rule.id } })).approvedRevNo).toBe(1);
  });

  it('link lint reports a broken include in a rule', async () => {
    const f = await fixture();
    const rule = await put(f.agentMem.id, 'boot:rules:core', 'See {{> boot:rules:missing}}.', { nodeType: 'system', role: RULE });
    const warnings = await lintSourceWarnings(ctxOf(f.admin.id), { id: rule.id, memoryId: rule.memoryId, content: rule.content, role: rule.role, nodeType: rule.nodeType });
    expect(warnings).toHaveLength(1);
  });

  it('a direct read of a rule resolves its includes and shows platform variables as written', async () => {
    const f = await fixture();
    await put(f.agentMem.id, 'boot:rules:inc', 'INCLUDED {{greeting}}');
    await put(f.agentMem.id, 'boot:rules:core', 'You are {{worker.name}}. [{{> boot:rules:inc}}]', { nodeType: 'system', role: RULE, data: { worker: { name: 'DATA' } } });
    const mcp = (await import('../../../mcp/server.js')).createTestableMcpServer({ userId: f.admin.id, roles: [], clientId: `user:${f.admin.id}` });
    const text = await mcp.callToolText('hadron_get_node', { urn: 'hrn:node:r5453-org:agent-sys:boot:rules:core' });
    expect(text).toContain('You are {{worker.name}}. [INCLUDED {{greeting}}]');
  });
});
