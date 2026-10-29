/** #2048 S11b: real revision-owned provenance, public fields and caller-sensitive lint. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSchema, isObjectType } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { withCompileWrite } from '../../../lib/bootPrompt.js';
import { sha256Hex } from '../../../lib/bootCompile/provenance.js';
import * as pointerGate from '../../../lib/bootPromptPointer.js';
import { lintWarningPageForNodeId } from '../../../lib/bootPromptLint.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
let ctx: Context, memoryId: string, agentId: string, sourceId: string, compiledId: string;
beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'compiled lint', urn: 'compiled-lint' } });
  const user = await db.user.create({ data: { name: 'manager' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  memoryId = (await db.memory.create({ data: { name: 'system', urn: 'compiled-lint:system', class: 'system', organizationId: org.id } })).id;
  agentId = (await db.agent.create({ data: { name: 'Agent', urn: 'compiled-lint:agent', organizationId: org.id, systemMemoryId: memoryId } })).id;
  sourceId = (await db.node.create({ data: { memoryId, loc: 'boot:source', name: 'source', content: 'source', role: 'boot-prompt' } })).id;
  compiledId = (await withCompileWrite(() => db.node.create({ data: { memoryId, loc: 'boot:compiled', name: 'compiled', content: 'expanded text without tags', role: 'boot-prompt', nodeType: 'compiled-boot-prompt' } }))).id;
  await record(1);
  ctx = { db, userId: user.id, roles: [] } as Context;
});
async function record(rev: number, pin: number | null = null) {
  await db.compiledPromptRevision.create({ data: {
    compiledNodeId: compiledId, compiledRevNo: rev, targetKind: 'AGENT', targetAgentId: agentId, contentHash: sha256Hex('expanded text without tags'), occurrenceCount: 1,
    provenance: { version: 1, occurrences: [{ order: 0, depth: 0, parent: null, kind: 'source', nodeId: sourceId, revNo: 1, hash: sha256Hex('source'), selection: { rev: pin, approved: false, signed: false } }] },
  } });
}
async function newerSource() {
  await db.node.update({ where: { id: sourceId }, data: { content: 'source 2', revSeq: 2 } });
}
const page = () => lintWarningPageForNodeId(ctx, compiledId);
describe('S11b compiled lint', () => {
  it('offers nullable paged fields on compile, worker and recorded serve', () => {
    const schema = buildSchema(typeDefs);
    for (const [name, field] of [['CompiledBootPrompt', 'lintWarnings'], ['Worker', 'promptLintWarnings'], ['ServedPrompt', 'currentLint']]) {
      const type = schema.getType(name);
      expect(isObjectType(type)).toBe(true);
      if (!isObjectType(type)) throw new Error(name);
      expect(String(type.getFields()[field]?.type)).toBe('LintWarningPage');
    }
  });
  it('computes from provenance without live include tags', async () => {
    expect(await page()).toMatchObject({ total: 0, items: [] });
    await newerSource();
    expect(await page()).toMatchObject({ items: [{ kind: 'RECOMPILE_AVAILABLE' }], total: 1 });
  });
  it('reports retired provenance targets on next read and clears after restore', async () => {
    await db.node.update({ where: { id: sourceId }, data: { deletedAt: new Date() } });
    expect(await page()).toMatchObject({ items: [{ kind: 'RETIRED_TARGET' }] });
    await db.node.update({ where: { id: sourceId }, data: { deletedAt: null } });
    expect(await page()).toMatchObject({ total: 0 });
  });
  it('keeps missing provenance unavailable, never a clean empty page', async () => {
    await withCompileWrite(() => db.node.update({ where: { id: compiledId }, data: { revSeq: 2 } }));
    expect(await page()).toBeNull();
  });
  it('uses the served compile revision rather than a newer current compile', async () => {
    await newerSource();
    await withCompileWrite(() => db.node.update({ where: { id: compiledId }, data: { revSeq: 2 } }));
    await record(2, 1);
    const field = (resolvers as any).ServedPrompt.currentLint;
    expect(field).toBeTypeOf('function');
    const old = await field({ compiledNodeId: compiledId, provenanceRevSeq: 1 }, {}, ctx);
    expect(old).toMatchObject({ items: [{ kind: 'RECOMPILE_AVAILABLE' }] });
    // Current compile pins revision 1, which is now pruned: it may warn, but must not claim a recompile selects newer.
    expect((await page())?.items.some(x => x.kind === 'RECOMPILE_AVAILABLE')).toBe(false);
  });
  it('conceals compiled content from a non-reader while a compiler gets only generic availability', async () => {
    await newerSource();
    const foreign = await db.organization.create({ data: { name: 'private', urn: 'private-lint' } });
    const hidden = await db.memory.create({ data: { name: 'hidden', urn: 'private-lint:system', class: 'system', organizationId: foreign.id } });
    await db.agent.create({ data: { name: 'hidden', urn: 'private-lint:agent', organizationId: foreign.id, systemMemoryId: hidden.id } });
    await withCompileWrite(() => db.node.update({ where: { id: compiledId }, data: { memoryId: hidden.id } }));
    const got = await page();
    expect(got).toMatchObject({ total: 1, items: [{ kind: 'RECOMPILE_AVAILABLE', position: 0, targetUrn: null, newerRevision: null }] });
    expect(JSON.stringify(got)).not.toContain('compiled-lint:system');
    const outsider = await db.user.create({ data: { name: 'outsider' } });
    expect(await lintWarningPageForNodeId({ ...ctx, userId: outsider.id }, compiledId)).toBeNull();
  });
  it('a readable compiled node does not grant compile authority to its reader', async () => {
    await newerSource();
    const org = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
    await db.orgMember.update({ where: { organizationId_userId: { organizationId: org.organizationId!, userId: ctx.userId! } }, data: { role: 'READER' } });
    await db.agent.update({ where: { id: agentId }, data: { visibility: 'ORGANIZATION' } });
    const publicMemory = await db.memory.create({ data: { name: 'public artifact', urn: 'public-artifact', class: 'knowledge', visibility: 'PUBLIC', organizationId: org.organizationId } });
    await withCompileWrite(() => db.node.update({ where: { id: compiledId }, data: { memoryId: publicMemory.id } }));
    expect(await page()).toMatchObject({ total: 1, items: [{ kind: 'BROKEN_INCLUDE' }] });
  });
  it('keeps a pinned revision while reporting its newer approved revision', async () => {
    await newerSource();
    await (resolvers.Mutation as any).approveNode(null, { nodeRef: sourceId }, ctx);
    await withCompileWrite(() => db.node.update({ where: { id: compiledId }, data: { revSeq: 2 } }));
    await record(2, 1);
    const got = await page();
    expect(got?.items).toContainEqual(expect.objectContaining({ kind: 'PINNED_NEWER_APPROVED', pinnedRevision: 1, newerRevision: 3 }));
    expect(got?.items.some(x => x.kind === 'RECOMPILE_AVAILABLE')).toBe(false);
  });
  it('pages a bounded list deterministically and clamps over-cap requests', async () => {
    await db.node.update({ where: { id: sourceId }, data: { deletedAt: new Date() } });
    await withCompileWrite(() => db.node.update({ where: { id: compiledId }, data: { revSeq: 2 } }));
    const occurrences = Array.from({ length: 103 }, (_, order) => ({ order, depth: order ? 1 : 0, parent: order ? 0 : null,
      kind: order ? 'include' : 'source', nodeId: sourceId, revNo: 1, hash: sha256Hex('source'), selection: { rev: null, approved: false, signed: false } }));
    await db.compiledPromptRevision.create({ data: { compiledNodeId: compiledId, compiledRevNo: 2, targetKind: 'AGENT', targetAgentId: agentId,
      contentHash: sha256Hex('expanded text without tags'), occurrenceCount: 103, provenance: { version: 1, occurrences } } });
    const first = await lintWarningPageForNodeId(ctx, compiledId, { first: 999 });
    expect(first).toMatchObject({ total: 103 });
    expect(first?.items).toHaveLength(100);
    const last = await lintWarningPageForNodeId(ctx, compiledId, { after: first?.nextCursor });
    expect(last?.items.map(x => x.position)).toEqual([100, 101, 102]);
    expect(last?.nextCursor).toBeNull();
  });

  it('approval payload and later compiled read use the same compile provenance after an approval revision', async () => {
    await newerSource();
    const receipt = await (resolvers.Mutation as any).approveNode(null, { nodeRef: compiledId }, ctx);
    const field = (resolvers as any).NodeApprovalReceipt.lintWarnings;
    const got = await field(receipt, {}, ctx);
    expect(got).toMatchObject({ items: [{ kind: 'RECOMPILE_AVAILABLE' }] });
    expect(got).toEqual(await page());
  });

  it('real App compile exposes neutral override lint on its result and later node read; full URNs bypass overlays', async () => {
    const memory = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
    const app = await db.app.create({ data: { name: 'override app', urn: 'compiled-lint:app', organizationId: memory.organizationId } });
    await db.appAgent.create({ data: { appId: app.id, agentId } });
    await db.appMember.create({ data: { appId: app.id, userId: ctx.userId!, role: 'owner' } });
    const install = await db.memory.create({ data: { name: 'install', urn: 'compiled-lint:install', class: 'system', organizationId: memory.organizationId,
      appId: app.id, installOfAgentId: agentId, isInstallMemory: true } });
    await db.node.create({ data: { memoryId, loc: 'policies:conduct', name: 'conduct', content: 'original' } });
    await db.node.create({ data: { memoryId: install.id, loc: 'policies:conduct', name: 'conduct', content: 'replacement' } });
    await db.node.update({ where: { id: sourceId }, data: { content: '{{> policies:conduct}}' } });
    const result = await (resolvers.Mutation as any).compileAppAgentBootPrompt(null, { appRef: app.id, agentRef: agentId }, ctx);
    expect(result.node.content).toBe('replacement');
    const field = (resolvers as any).CompiledBootPrompt.lintWarnings;
    const got = await field(result, {}, ctx);
    expect(got?.items).toContainEqual(expect.objectContaining({ kind: 'POLICY_OVERRIDE', overriddenNodeLoc: 'policies:conduct', text: 'This App overrides Agent node policies:conduct.' }));
    expect(got).toEqual(await lintWarningPageForNodeId(ctx, result.node.id));
    const worker = await db.worker.create({ data: { name: 'Lint', slug: 'lint', appId: app.id, agentId, signature: '{{worker.url}}', trailer: '{{worker.url}}' } });
    await db.node.create({ data: { memoryId: install.id, loc: `boot:workers:${worker.id}:source`, name: 'worker source', role: 'boot-prompt', content: '{{> policies:conduct}}' } });
    const workerCompile = await (resolvers.Mutation as any).compileWorkerBootPrompt(null, { workerRef: worker.id }, ctx);
    expect((await field(workerCompile, {}, ctx))?.items).toContainEqual(expect.objectContaining({ kind: 'POLICY_OVERRIDE', overriddenNodeLoc: 'policies:conduct' }));
    const foreign = await db.organization.create({ data: { name: 'hidden original', urn: 'hidden-original' } });
    const hiddenMemory = await db.memory.create({ data: { name: 'hidden original', urn: 'hidden-original:system', class: 'system', organizationId: foreign.id } });
    await db.agent.create({ data: { name: 'hidden original', urn: 'hidden-original:agent', organizationId: foreign.id, systemMemoryId: hiddenMemory.id } });
    const original = await db.node.findUniqueOrThrow({ where: { loc_memoryId: { loc: 'policies:conduct', memoryId } } });
    await db.node.update({ where: { id: original.id }, data: { memoryId: hiddenMemory.id } });
    expect((await field(result, {}, ctx))?.items).toContainEqual(expect.objectContaining({ kind: 'POLICY_OVERRIDE', overriddenNodeLoc: null, text: 'This App overrides an Agent node.' }));
    await db.node.update({ where: { id: original.id }, data: { memoryId } });
    await db.node.update({ where: { id: sourceId }, data: { content: '{{> hrn:node:compiled-lint:system:policies:conduct}}' } });
    const next = await (resolvers.Mutation as any).compileAppAgentBootPrompt(null, { appRef: app.id, agentRef: agentId }, ctx);
    expect(next.node.content).toBe('original');
    expect((await field(next, {}, ctx))?.items.some((x: any) => x.kind === 'POLICY_OVERRIDE')).toBe(false);
  });

  it('serializes hidden and missing provenance targets identically, with no target state or signing detail', async () => {
    const foreign = await db.organization.create({ data: { name: 'foreign', urn: 'foreign-parts' } });
    const hiddenMemory = await db.memory.create({ data: { name: 'hidden', urn: 'foreign-parts:system', class: 'system', organizationId: foreign.id } });
    await db.agent.create({ data: { name: 'hidden', urn: 'foreign-parts:agent', organizationId: foreign.id, systemMemoryId: hiddenMemory.id } });
    await db.node.update({ where: { id: sourceId }, data: { memoryId: hiddenMemory.id } });
    const hidden = await page();
    expect(hidden).toMatchObject({ items: [{ kind: 'BROKEN_INCLUDE', position: 0, targetUrn: null, pinnedRevision: null, newerRevision: null, overriddenNodeLoc: null }] });
    await db.node.delete({ where: { id: sourceId } });
    expect(await page()).toEqual(hidden);
  });
  it('does not change a committed artifact when a later lint read faults', async () => {
    const before = await db.node.findUniqueOrThrow({ where: { id: compiledId } });
    expect(await page()).toMatchObject({ total: 0 });
    const fault = vi.spyOn(db.compiledPromptRevision, 'findUnique').mockRejectedValueOnce(new Error('synthetic provenance read fault'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const got = await (resolvers as any).CompiledBootPrompt.lintWarnings({ node: { id: compiledId }, revNo: 1 }, {}, ctx);
      expect(got).toBeNull();
      expect(fault).toHaveBeenCalledOnce();
      expect(logged).toHaveBeenCalledWith('[bootPromptLint] compiled warnings unavailable:', 'synthetic provenance read fault');
    } finally { fault.mockRestore(); logged.mockRestore(); }
    expect(await db.node.findUniqueOrThrow({ where: { id: compiledId } })).toEqual(before);
    expect(await db.compiledPromptRevision.count({ where: { compiledNodeId: compiledId } })).toBe(1);
  });
  it('returns unavailable on an unexpected compile-authority fault, even for a compiled reader', async () => {
    expect(await page()).toMatchObject({ total: 0 });
    const fault = vi.spyOn(pointerGate, 'assertMayWriteBootPromptPointer').mockRejectedValueOnce(new Error('synthetic compile-authority fault'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await page()).toBeNull();
      expect(fault).toHaveBeenCalledOnce();
      expect(logged).toHaveBeenCalledWith('[bootPromptLint] compiled warnings unavailable:', 'synthetic compile-authority fault');
    } finally { fault.mockRestore(); logged.mockRestore(); }
    expect(await page()).toMatchObject({ total: 0 });
  });
  it('missing normalized settings are unavailable rather than reconstructed from current source text', async () => {
    await withCompileWrite(() => db.node.update({ where: { id: compiledId }, data: { revSeq: 2 } }));
    await db.compiledPromptRevision.create({ data: { compiledNodeId: compiledId, compiledRevNo: 2, targetKind: 'AGENT', targetAgentId: agentId,
      contentHash: sha256Hex('expanded text without tags'), occurrenceCount: 1, provenance: { version: 1, occurrences: [{ order: 0, depth: 0, parent: null, kind: 'source', nodeId: sourceId, revNo: 1, hash: sha256Hex('source') }] } } });
    expect(await page()).toBeNull();
  });

});
