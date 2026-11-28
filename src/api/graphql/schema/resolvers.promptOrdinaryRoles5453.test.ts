/**
 * #5453 (Holger's rulings of 2026-11-28, decision record sections 16 and 17) — a role in `prompt.*` outside `prompt.boot.*` is an
 * ORDINARY instruction node.
 *
 * The boot-prompt family is `prompt.boot` (`prompt.boot.compiled`, `.source`, `.rule`). The bare role `prompt` and a
 * made-up `prompt.other` sit under the same base kind and must pick up none of its rules. One pin per rule it must NOT
 * inherit, each beside the same act on a `prompt.boot.source` node (the contrast that proves the pin could fail), in
 * an Agent's system memory, where every boot-prompt rule applies.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import {
  BOOT_PROMPT_ROLE_WHERE, isBootPromptItselfRole, isBootPromptRole, isBootPromptRuleRole,
  isBootPromptSourceRole, isCompiledBootPromptRole,
} from '../../../lib/bootPrompt.js';
import { lintSourceWarnings } from '../../../lib/bootPromptLint.js';
import { inheritedNodeIds, systemMemoryChain } from '../../../lib/effectiveSystemMemory.js';
import { resolveNodeContent } from '../../../lib/includes/resolveNodeContent.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as any;
const TEMPLATE = 'prompt';
const OTHER = 'prompt.other';
const REFUSALS = ['BOOT_PROMPT_COMPILED_WRITE', 'BOOT_PROMPT_WORKER_SESSION_REFUSED', 'BOOT_PROMPT_APPROVAL_FORBIDDEN'];

let orgId: string;
let adminId: string;
let writerId: string;
let agentMem: string;
let agentId: string;
let workerId: string;
const ctxOf = (userId: string) => ({ db, userId, roles: [], clientId: `user:${userId}` }) as unknown as Context;
const codeOf = async (p: Promise<unknown>) => {
  try { await p; return 'NO_ERROR'; } catch (e) {
    return e instanceof GraphQLError ? String(e.extensions.code) : (e as Error).message;
  }
};
const asWorker = <T>(fn: () => Promise<T>) => runAsActor({ workerId, agentId: null }, fn);
const mk = (loc: string, role: string | null, extra: Record<string, unknown> = {}, memoryId = agentMem) => db.node.create({
  data: { id: generateId(), memoryId, loc, name: loc, content: 'You are {{name}}.', nodeType: 'system', ...(role ? { role } : {}), ...extra },
});

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'tpl-org', urn: 'tpl-org' } })).id;
  adminId = (await db.user.create({ data: { id: generateId(), githubId: 545302, githubUsername: 'tpl-admin', handle: 'tpl-admin', roles: [] } })).id;
  writerId = (await db.user.create({ data: { id: generateId(), githubId: 545303, githubUsername: 'tpl-writer', handle: 'tpl-writer', roles: [] } })).id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: adminId, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: orgId, userId: writerId, role: 'CONTRIBUTOR' } });
  agentMem = (await db.memory.create({ data: { id: generateId(), class: 'system', name: 'sys', urn: 'tpl-org:sys', organizationId: orgId } })).id;
  agentId = (await db.agent.create({ data: { id: generateId(), name: 'Ada', urn: 'tpl-org:ada', organizationId: orgId, systemMemoryId: agentMem } })).id;
  const appId = (await db.app.create({ data: { id: generateId(), name: 'App', urn: 'tpl-org:app', organizationId: orgId } })).id;
  await db.appAgent.create({ data: { appId, agentId } });
  workerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId, name: 'Iris', slug: 'iris' } })).id;
});

describe('#5453 the bare prompt and prompt.other roles are not in the boot-prompt family', () => {
  it('every predicate that names the boot-prompt kinds answers no for it, and yes for the three leaves and the legacy forms', () => {
    for (const role of [TEMPLATE, OTHER, 'prompt.bootleg']) {
      expect([role, isBootPromptRole(role), isBootPromptItselfRole(role), isBootPromptRuleRole(role), isBootPromptSourceRole(role), isCompiledBootPromptRole(role)])
        .toEqual([role, false, false, false, false, false]);
    }
    for (const role of ['prompt.boot.compiled', 'prompt.boot.source', 'prompt.boot.rule', 'boot-prompt', 'boot-prompt.coordinator']) expect(isBootPromptRole(role), role).toBe(true);
    // The Prisma filter used by the copy and delete doors agrees.
    expect(BOOT_PROMPT_ROLE_WHERE.OR).not.toContainEqual({ role: TEMPLATE });
  });

  it('rule 1, guard A (compile-only writes): a generic create, update and delete of a template is allowed', async () => {
    const ctx = ctxOf(adminId);
    const created = await M.createNode(null, { input: { memoryRef: agentMem, loc: 'prompts:t1', name: 'T1', content: 'x', nodeType: 'system', role: TEMPLATE } }, ctx);
    expect(created.role).toBe(TEMPLATE);
    expect(await codeOf(M.updateNode(null, { input: { ref: created.id, content: 'y' } }, ctx))).toBe('NO_ERROR');
    expect(await codeOf(M.updateNode(null, { input: { ref: created.id, role: 'notes' } }, ctx))).toBe('NO_ERROR');
    expect(await codeOf(M.deleteNode(null, { nodeRef: created.id }, ctx))).toBe('NO_ERROR');
    // Contrast: a generic write may not produce a compiled node.
    expect(await codeOf(M.createNode(null, { input: { memoryRef: agentMem, loc: 'boot:compiled', name: 'C', content: 'x', nodeType: 'system', role: 'prompt.boot.compiled' } }, ctx)))
      .toBe('BOOT_PROMPT_COMPILED_WRITE');
  });

  it('rule 2, guard B (no worker-session write): a worker session creates, updates and deletes a template, and is refused a source', async () => {
    const ctx = ctxOf(adminId);
    const created: any = await asWorker(() => M.createNode(null, { input: { memoryRef: agentMem, loc: 'prompts:t2', name: 'T2', content: 'x', nodeType: 'system', role: TEMPLATE } }, ctx));
    expect(created.role).toBe(TEMPLATE);
    expect(await codeOf(asWorker(() => M.updateNode(null, { input: { ref: created.id, content: 'y' } }, ctx)))).toBe('NO_ERROR');
    expect(await codeOf(asWorker(() => M.deleteNode(null, { nodeRef: created.id }, ctx)))).toBe('NO_ERROR');
    const source = await mk('boot:source', 'prompt.boot.source');
    expect(await codeOf(asWorker(() => M.updateNode(null, { input: { ref: source.id, content: 'z' } }, ctx)))).toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
  });

  it('rule 3, manager-only approval: a template takes no boot-prompt approval refusal for an ordinary writer', async () => {
    const template = await mk('prompts:t3', TEMPLATE);
    expect(REFUSALS).not.toContain(await codeOf(M.approveNode(null, { nodeRef: template.id }, ctxOf(writerId))));
  });

  it('rule 3, manager-only approval: a worker session is not refused approving a template', async () => {
    const template = await mk('prompts:t3b', TEMPLATE);
    const source = await mk('boot:source3b', 'prompt.boot.source');
    expect(await asWorker(() => codeOf(M.approveNode(null, { nodeRef: source.id }, ctxOf(adminId))))).toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect(REFUSALS).not.toContain(await asWorker(() => codeOf(M.approveNode(null, { nodeRef: template.id }, ctxOf(adminId)))));
  });

  it('rule 4, approval entry: a role flip into a template keeps an outside approval, a flip into a source ends it', async () => {
    const a = await mk('notes:a', null);
    const b = await mk('notes:b', null);
    for (const n of [a, b]) await db.$executeRaw`UPDATE nodes SET approved_rev_no = rev_seq, approved_at = now(), approved_by = ${adminId}, approval_hash = ${'b'.repeat(64)} WHERE id = ${n.id}`;
    await db.$executeRaw`UPDATE nodes SET role = ${TEMPLATE} WHERE id = ${a.id}`;
    await db.$executeRaw`UPDATE nodes SET role = 'prompt.boot.source' WHERE id = ${b.id}`;
    expect((await db.node.findUniqueOrThrow({ where: { id: a.id } })).approvalHash).toBe('b'.repeat(64));
    expect((await db.node.findUniqueOrThrow({ where: { id: b.id } })).approvalHash).toBeNull();
  });

  it('rule 5, reads: a direct read renders the template over its data and serves a source with its variables as written', async () => {
    const ctx = ctxOf(adminId);
    const template = await mk('prompts:t5', TEMPLATE, { data: { name: 'Basil' } });
    const source = await mk('boot:source', 'prompt.boot.source', { data: { name: 'Basil' } });
    expect(await resolveNodeContent(ctx, template as never)).toBe('You are Basil.');
    expect(await resolveNodeContent(ctx, source as never)).toBe('You are {{name}}.');
  });

  it('rule 6, link lint: a template has no boot-prompt lint (a source with the same text is linted)', async () => {
    const ctx = ctxOf(adminId);
    const text = 'See {{> boot:rules:missing}}.';
    const template = await mk('prompts:t6', TEMPLATE, { content: text });
    const source = await mk('boot:source', 'prompt.boot.source', { content: text });
    expect(await lintSourceWarnings(ctx, template as never)).toEqual([]);
    expect(((await lintSourceWarnings(ctx, source as never)) ?? []).length).toBeGreaterThan(0);
  });

  it('rule 7, pointers: a template is not a compiled prompt, so no pointer takes it (BOOT_PROMPT_POINTER_NOT_COMPILED, as for any ordinary node)', async () => {
    const template = await mk('prompts:t7', TEMPLATE);
    const ctx = ctxOf(adminId);
    expect(await codeOf(M.setAgentBootPrompt(null, { agentRef: agentId, nodeRef: template.id }, ctx))).toBe('BOOT_PROMPT_POINTER_NOT_COMPILED');
    const other = await mk('prompts:t7b', OTHER);
    expect(await codeOf(M.setAgentBootPrompt(null, { agentRef: agentId, nodeRef: other.id }, ctx))).toBe('BOOT_PROMPT_POINTER_NOT_COMPILED');
    expect(isCompiledBootPromptRole(TEMPLATE)).toBe(false);
  });

  it('rule 8, base inheritance: a base Agent\'s template is inherited by a derived Agent, its source and compiled prompt are not, its rule is', async () => {
    const baseMem = (await db.memory.create({ data: { id: generateId(), class: 'system', name: 'base-sys', urn: 'tpl-org:base-sys', organizationId: orgId } })).id;
    const baseAgent = await db.agent.create({ data: { id: generateId(), name: 'Base', urn: 'tpl-org:base', organizationId: orgId, systemMemoryId: baseMem } });
    await db.agent.update({ where: { id: agentId }, data: { extendsAgentId: baseAgent.id } });
    const template = await mk('prompts:base-t', TEMPLATE, {}, baseMem);
    const other = await mk('prompts:base-other', 'prompt.other', {}, baseMem);
    const rule = await mk('boot:rules:r', 'prompt.boot.rule', {}, baseMem);
    const source = await mk('boot:source', 'prompt.boot.source', {}, baseMem);
    const compiled = await mk('boot:compiled', 'prompt.boot.compiled', {}, baseMem);
    const bare = await mk('boot:legacy', 'boot-prompt', {}, baseMem);
    const inherited = await inheritedNodeIds(db, await systemMemoryChain(db, agentMem));
    expect([...inherited.keys()].sort()).toEqual([template.id, other.id, rule.id].sort());
    for (const n of [source, compiled, bare]) expect(inherited.has(n.id), n.loc).toBe(false);
  });

  it('rule 9, the source address: a template at boot:source is not a valid source for a compile', () => {
    expect(isBootPromptSourceRole(TEMPLATE)).toBe(false);
    expect(isBootPromptSourceRole('prompt.boot.source')).toBe(true);
    expect(isBootPromptSourceRole('boot-prompt')).toBe(true);
  });
});
