/** #2048 S11b: real revision-owned provenance, public fields and caller-sensitive lint. */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildSchema, isObjectType } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { withCompileWrite } from '../../../lib/bootPrompt.js';
import { sha256Hex } from '../../../lib/bootCompile/provenance.js';
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
  it('computes from provenance without live include tags, and clears on recompile', async () => {
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
});
