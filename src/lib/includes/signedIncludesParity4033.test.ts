/**
 * #4033 (follow-ups to #4026): while the deployment does not check signatures `signed` is ignored (cor:dmo:150:02),
 * so a tag with it must answer exactly as the same tag without it; with signing on, a pin that names no stored
 * revision is a missing include (R79) even with `signed`; both lints share one deployment-policy warning text.
 *
 * Red on main: only the copy pin (the old text says "signing has not shipped"). The parity, R79 and control pins
 * describe behavior main already has and guard the refactor that makes the ignored-`signed` path structural
 * (the existence pre-check and the null-body fast path no longer look at `signed` while it is not checked).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { assembleBootPrompt, type AssembleInput } from '../bootCompile/assemble.js';
import { lintWarningPageForNodeId } from '../bootPromptLint.js';
import { withCompileWrite } from '../bootPrompt.js';
import { sha256Hex } from '../bootCompile/provenance.js';
import { BROKEN_INCLUDE_NOTICE, IncludeReadMemo, selectIncludeRevision } from './spliceIncludes.js';
import { NEWEST_APPROVED_REVISION_SCAN_BATCHES, NEWEST_APPROVED_REVISION_SCAN_CAP } from '../nodeApproval.js';
import { setResolutionLimits } from './resolutionBudget.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

interface NodeResolvers { content(node: unknown, args: object, ctx: Context, info: object): Promise<string> }
const nodeResolvers = (resolvers as unknown as { Node: NodeResolvers }).Node;

let orgId: string, memoryId: string, agentId: string, adminId: string, partId: string, sourceId: string;
const context = (): Context => ({ db, userId: adminId, roles: [] });

beforeEach(async () => {
  await cleanDb(db);
  vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'false');
  orgId = (await db.organization.create({ data: { name: 'Parity', urn: 'parity4033.test', bootPromptSigningRequired: false } })).id;
  adminId = (await db.user.create({ data: { handle: 'parity-admin' } })).id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: adminId, role: 'ADMIN' } });
  memoryId = (await db.memory.create({ data: { name: 'System', urn: 'parity4033.test:system', class: 'system', organizationId: orgId } })).id;
  agentId = (await db.agent.create({ data: { name: 'Engineer', urn: 'parity4033.test:engineer', organizationId: orgId, systemMemoryId: memoryId } })).id;
  partId = (await db.node.create({ data: { memoryId, loc: 'part', name: 'Part', content: 'v1' } })).id;
  sourceId = (await db.node.create({ data: { memoryId, loc: 'boot:source', name: 'Source', role: 'boot-prompt', content: '' } })).id;
});
afterEach(() => { vi.unstubAllEnvs(); setResolutionLimits(null); });

const source = (settings: string) => db.node.update({ where: { id: sourceId }, data: { content: `before {{> part ${settings}}} after` } });
const input = (): AssembleInput => ({ target: { kind: 'AGENT', agentId }, source: { nodeId: sourceId, memoryId }, installMemoryId: null,
  recipient: { kind: 'org', orgId }, callerCanRead: async () => true });
const compile = () => assembleBootPrompt(db, input());
async function read(): Promise<string> {
  const n = await resolvers.Query.node(null, { ref: sourceId } as never, context());
  return nodeResolvers.content(n, {}, context(), {});
}
/** Stored revisions 1 and 2 with the live row at revision 4: revision 3 was pruned (never stored). */
async function withPrunedRevision3() {
  for (const revNo of [1, 2]) {
    await db.nodeRevision.create({ data: { nodeId: partId, memoryId, loc: 'part', name: 'Part', content: `v${revNo}`, revNo, tags: [] } });
  }
  await db.node.update({ where: { id: partId }, data: { revSeq: 4, contentRevSeq: 4, content: 'v4' } });
}
async function outcome(settings: string) {
  await source(settings);
  const compiled = await compile().then(p => ({ text: p.text, revNo: p.occurrences[1]?.revNo }), (e: { code?: string }) => ({ code: e.code }));
  return { read: await read(), compiled };
}

describe('#4033 P3-1/P3-2: signed is ignored while the deployment does not check it', () => {
  it.each([
    ['rev=1', 'rev=1 signed'],
    ['rev=3', 'rev=3 signed'], // pruned: names no stored revision
    ['rev=9', 'rev=9 signed'], // beyond the newest
    ['approved', 'approved signed'],
    ['rev=3 approved', 'rev=3 approved signed'],
    ['', 'signed'],
  ])('%j and %j read and compile alike', async (plain, withSigned) => {
    await withPrunedRevision3();
    const a = await outcome(plain);
    const b = await outcome(withSigned);
    expect(b).toEqual(a);
  });

  it('a pin naming no stored revision is a missing include, with or without signed', async () => {
    await withPrunedRevision3();
    for (const settings of ['rev=3', 'rev=3 signed']) {
      await source(settings);
      expect(await read()).toBe(`before ${BROKEN_INCLUDE_NOTICE} after`);
      await expect(compile()).rejects.toMatchObject({ code: 'BOOT_PROMPT_INCLUDE_UNAVAILABLE' });
    }
  });

  it('an include whose live body is null serves nothing, with the same budget as without signed', async () => {
    await db.node.update({ where: { id: partId }, data: { content: null } });
    for (const limit of [{ maxLookups: 2 }, { maxBytes: 10 }, { maxExpansions: 1 }]) {
      setResolutionLimits({ limits: limit });
      const results: string[] = [];
      for (const settings of ['', 'signed']) {
        await source(settings);
        results.push(await read().catch((e: { extensions?: { code?: string; limit?: string } }) => `${e.extensions?.code}:${e.extensions?.limit}`));
      }
      expect(results[1]).toBe(results[0]);
    }
    setResolutionLimits({ limits: { maxLookups: 1 } });
    await source('');
    const plain = await read().catch((e: { extensions?: { code?: string } }) => e.extensions?.code);
    await source('signed');
    expect(await read().catch((e: { extensions?: { code?: string } }) => e.extensions?.code)).toBe(plain);
  });
});

describe('#4033 R79 with signing on (Riana)', () => {
  beforeEach(() => { vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true'); });

  it('rev=<unstored> signed refuses BOOT_PROMPT_INCLUDE_UNAVAILABLE, not REVISION_UNAVAILABLE', async () => {
    await withPrunedRevision3();
    await source('rev=3 signed');
    await expect(compile()).rejects.toMatchObject({ code: 'BOOT_PROMPT_INCLUDE_UNAVAILABLE' });
    await source('rev=3 approved signed');
    await expect(compile()).rejects.toMatchObject({ code: 'BOOT_PROMPT_INCLUDE_UNAVAILABLE' });
  });

  it('a stored but unsigned pin is REVISION_UNAVAILABLE (no qualifying revision)', async () => {
    await withPrunedRevision3();
    await source('rev=1 signed');
    await expect(compile()).rejects.toMatchObject({ code: 'BOOT_PROMPT_INCLUDE_REVISION_UNAVAILABLE' });
  });
});

describe('#4033 P3-6 controls with signing on', () => {
  beforeEach(() => { vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true'); });

  it('an encrypted signed target selects nothing and reads no revision', async () => {
    const target = { id: partId, memoryId, content: 'v1', revSeq: 1, memory: { id: memoryId, isEncrypted: true } };
    let queries = 0;
    const counted = db.$extends({ query: { $allModels: { async $allOperations({ args, query }) { queries += 1; return query(args); } } } });
    for (const settings of [{ signed: true }, { signed: true, approved: true }, { signed: true, rev: 1 }]) {
      expect(await selectIncludeRevision(counted as never, new IncludeReadMemo(), target, { approved: false, ...settings })).toBeNull();
    }
    expect(queries).toBe(0);
  });

  it('the signed search stops at its scan ceiling and fails closed', async () => {
    const reach = NEWEST_APPROVED_REVISION_SCAN_CAP * NEWEST_APPROVED_REVISION_SCAN_BATCHES;
    // The only candidate there is lies below the ceiling; nothing above it is signed, so the include does not resolve.
    await db.nodeRevision.createMany({ data: Array.from({ length: reach + 5 }, (_, i) => ({
      nodeId: partId, memoryId, loc: 'part', name: 'Part', content: 'unsigned', revNo: i + 1, tags: [],
    })) });
    await db.node.update({ where: { id: partId }, data: { revSeq: reach + 6, contentRevSeq: reach + 6 } });
    await source('signed');
    expect(await read()).toBe(`before ${BROKEN_INCLUDE_NOTICE} after`);
    await expect(compile()).rejects.toMatchObject({ code: 'BOOT_PROMPT_INCLUDE_REVISION_UNAVAILABLE' });
  });

  it('an include without signed pays no signature lookups, so a tight lookup budget still resolves', async () => {
    await db.nodeRevision.create({ data: { nodeId: partId, memoryId, loc: 'part', name: 'Part', content: 'v1', revNo: 1, tags: [] } });
    await db.node.update({ where: { id: partId }, data: { revSeq: 2, contentRevSeq: 2, content: 'v2' } });
    setResolutionLimits({ limits: { maxLookups: 2 } });
    await source('rev=1');
    expect(await read()).toBe('before v1 after');
    await source('rev=1 signed');
    await expect(read()).rejects.toMatchObject({ extensions: { code: 'CONTENT_RESOLUTION_LIMIT_EXCEEDED', limit: 'lookups' } });
  });
});

describe('#4033 P3-4: one deployment-policy warning text for both lints', () => {
  it('names the deployment, not "signing has not shipped", and is identical on source and compiled lint', async () => {
    await source('signed');
    const plan = await compile();
    const compiled = await withCompileWrite(() => db.node.create({ data: { memoryId, loc: 'boot:compiled', name: 'Compiled', content: plan.text, role: 'boot-prompt', nodeType: 'compiled-boot-prompt' } }));
    await db.compiledPromptRevision.create({ data: { compiledNodeId: compiled.id, compiledRevNo: 1, targetKind: 'AGENT', targetAgentId: agentId,
      contentHash: sha256Hex(plan.text), occurrenceCount: plan.occurrences.length, provenance: { version: 1, occurrences: plan.occurrences } as never } });
    const texts: string[] = [];
    for (const id of [sourceId, compiled.id]) {
      const page = await lintWarningPageForNodeId(context(), id);
      const warning = page!.items.find(w => w.kind === 'SIGNING_NOT_CHECKED');
      expect(warning).toBeDefined();
      texts.push(warning!.text);
    }
    expect(texts[1]).toBe(texts[0]);
    expect(texts[0]).not.toMatch(/has not shipped/);
    expect(texts[0]).toMatch(/this deployment/);
  });
});
