import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { computeContentHash } from '../../../lib/contentHash.js';
import { ensureChannelWithRoot } from '../../../lib/channels.js';
import { parseDataKey, isCiphertext } from '../../../lib/crypto.js';
import { decryptNodeFieldsWithKey } from '../../../lib/nodeCrypto.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let admin: { id: string };
let org: { id: string; urn: string };
let draft: { id: string; urn: string };
const ctx = (): Context => ({ db, roles: ['ADMIN'], userId: admin.id });
const server = new ApolloServer<Context>({ typeDefs, resolvers });

async function memory(name: string, draftCorpus: boolean) {
  return resolvers.Mutation.createMemory(null, { orgId: org.id, name, draftCorpus }, ctx());
}
async function node(loc: string, fields: Record<string, unknown> = {}, memoryId = draft.id) {
  return db.node.create({
    data: { id: generateId(), memoryId, loc, name: loc, content: 'cat cat scatter', role: 'spec', ...fields },
  });
}
const call = (input: Record<string, unknown>) => resolvers.Mutation.searchReplaceInSpecNodes(
  null, { input } as never, ctx(),
);
const request = (nodeIds: string[], rest: Record<string, unknown> = {}) => ({
  memoryRef: draft.id,
  nodeIds,
  oldText: 'cat',
  newText: 'dog',
  fields: ['content'],
  dryRun: true,
  ...rest,
});

beforeEach(async () => {
  await cleanDb(db);
  sessionKeyCache.clear();
  org = await db.organization.create({ data: { id: generateId(), name: 'Spec Replace Org', urn: 'spec-replace.example' } });
  admin = await db.user.create({ data: { githubId: 1294001, githubUsername: 'spec-replace-admin', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  draft = await memory('specs-draft', true);
});

describe('searchReplaceInSpecNodes', () => {
  it('binds a revisioned apply to its exact preview, with CLI word boundaries', async () => {
    const spec = await node('pas:010:01');
    const before = await db.node.findUniqueOrThrow({ where: { id: spec.id } });
    const preview = await call(request([spec.id], { reason: 'draft typo' }));
    expect(preview).toMatchObject({
      nodesSelected: 1, nodesScanned: 1, nodesSkipped: 0,
      nodesChanged: 1, totalReplacements: 2, dryRun: true,
    });
    expect(preview.plan).toMatch(/^[0-9a-f]{64}$/);
    expect((await db.node.findUniqueOrThrow({ where: { id: spec.id } })).content).toBe(before.content);

    const applied = await call(request([spec.id], { dryRun: false, expectedPlan: preview.plan, reason: 'draft typo' }));
    expect(applied.nodesChanged).toBe(1);
    const after = await db.node.findUniqueOrThrow({ where: { id: spec.id } });
    expect(after.content).toBe('dog dog scatter');
    expect(after.revSeq).toBe(before.revSeq + 1);
    expect(await db.nodeRevision.findFirst({ where: { nodeId: spec.id }, select: { revLabel: true } }))
      .toMatchObject({ revLabel: 'draft typo' });
  });

  it('refuses a changed plan, including a different reason, without any write', async () => {
    const spec = await node('pas:010:01');
    const preview = await call(request([spec.id]));
    await expect(call(request([spec.id], { dryRun: false, expectedPlan: preview.plan, reason: 'different' })))
      .rejects.toMatchObject({ extensions: { code: 'SEARCH_REPLACE_PLAN_STALE' } });
    expect((await db.node.findUniqueOrThrow({ where: { id: spec.id } })).content).toBe('cat cat scatter');
    expect(await db.nodeRevision.count({ where: { nodeId: spec.id } })).toBe(0);
  });

  it('refuses content drift and corpus minting after preview with zero writes', async () => {
    const spec = await node('pas:010:01');
    const preview = await call(request([spec.id]));
    await db.node.update({ where: { id: spec.id }, data: { content: 'cat revised' } });
    await expect(call(request([spec.id], { dryRun: false, expectedPlan: preview.plan })))
      .rejects.toMatchObject({ extensions: { code: 'SEARCH_REPLACE_PLAN_STALE' } });
    expect((await db.node.findUniqueOrThrow({ where: { id: spec.id } })).content).toBe('cat revised');

    // Minting is not exposed by #1451 yet; flip only this disposable fixture.
    await db.memory.update({ where: { id: draft.id }, data: { corpusDraft: false } });
    await expect(call(request([spec.id], { dryRun: false, expectedPlan: preview.plan })))
      .rejects.toMatchObject({ extensions: { code: 'SEARCH_REPLACE_PLAN_STALE' } });
  });

  it('keeps drifted previews read-only and recovers through a canonical node read', async () => {
    const spec = await node('pas:010:05');
    const oldPlan = (await call(request([spec.id]))).plan;
    await db.node.update({ where: { id: spec.id }, data: { content: 'cat revised' } });
    const drifted = await db.node.findUniqueOrThrow({ where: { id: spec.id } });

    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(call(request([spec.id])))
        .rejects.toMatchObject({
          message: expect.stringContaining(`node(ref: "${spec.id}", raw: true)`),
          extensions: { code: 'NODE_WRITE_CONFLICT' },
        });
    }
    await expect(call(request([spec.id], { dryRun: false, expectedPlan: oldPlan })))
      .rejects.toMatchObject({ extensions: { code: 'SEARCH_REPLACE_PLAN_STALE' } });
    expect(await db.node.findUniqueOrThrow({ where: { id: spec.id } })).toMatchObject({
      content: drifted.content,
      revSeq: drifted.revSeq,
      revisionContentHash: drifted.revisionContentHash,
    });
    expect(await db.nodeRevision.count({ where: { nodeId: spec.id } })).toBe(0);

    const read = await resolvers.Query.node({}, { ref: spec.id, raw: true }, ctx());
    expect(read?.content).toBe('cat revised');
    expect(await db.nodeRevision.count({ where: { nodeId: spec.id } })).toBe(1);

    const fresh = await call(request([spec.id]));
    expect(fresh).toMatchObject({ nodesChanged: 1, totalReplacements: 1, dryRun: true });
    expect(fresh.plan).not.toBe(oldPlan);
    await call(request([spec.id], { dryRun: false, expectedPlan: fresh.plan }));
    expect((await db.node.findUniqueOrThrow({ where: { id: spec.id } })).content).toBe('dog revised');
  });

  it('returns plan-stale when a selected node moved, even if its draft URN no longer resolves', async () => {
    const spec = await node('pas:010:01');
    const urn = `hrn:node:${draft.urn}:pas:010:01`;
    const preview = await call(request([urn]));
    await db.node.update({ where: { id: spec.id }, data: { loc: 'pas:010:02' } });
    await expect(call(request([urn], { dryRun: false, expectedPlan: preview.plan })))
      .rejects.toMatchObject({ extensions: { code: 'SEARCH_REPLACE_PLAN_STALE' } });
    expect((await db.node.findUniqueOrThrow({ where: { id: spec.id } })).content).toBe('cat cat scatter');
  });

  it('deduplicates ID and URN selectors and refuses a deleted selection', async () => {
    const spec = await node('pas:010:01');
    const urn = `hrn:node:${draft.urn}:pas:010:01`;
    const preview = await call(request([spec.id, urn]));
    expect(preview).toMatchObject({ nodesSelected: 1, nodesScanned: 1, nodesChanged: 1 });
    await db.node.update({ where: { id: spec.id }, data: { deletedAt: new Date() } });
    await expect(call(request([spec.id, urn], { dryRun: false, expectedPlan: preview.plan })))
      .rejects.toMatchObject({ extensions: { code: 'SEARCH_REPLACE_PLAN_STALE' } });
    expect(await db.nodeRevision.count({ where: { nodeId: spec.id } })).toBe(0);
  });

  it('never follows a selected id into another memory after preview', async () => {
    const spec = await node('pas:010:01');
    const preview = await call(request([spec.id]));
    const destination = await memory('another-draft', true);
    await db.node.update({ where: { id: spec.id }, data: { memoryId: destination.id } });
    await expect(call(request([spec.id], { dryRun: false, expectedPlan: preview.plan })))
      .rejects.toMatchObject({ extensions: { code: 'SEARCH_REPLACE_PLAN_STALE' } });
    const after = await db.node.findUniqueOrThrow({ where: { id: spec.id } });
    expect(after.memoryId).toBe(destination.id);
    expect(after.content).toBe('cat cat scatter');
    expect(await db.nodeRevision.count({ where: { nodeId: spec.id } })).toBe(0);
  });

  it('refuses a corpus deleted after apply resolved its reference', async () => {
    const spec = await node('pas:010:03');
    const preview = await call(request([spec.id]));
    const findNode = db.node.findUnique.bind(db.node);
    let reached!: () => void;
    let release!: () => void;
    const atSelection = new Promise<void>((resolve) => { reached = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    const lookup = vi.spyOn(db.node, 'findUnique').mockImplementation((async (args: Parameters<typeof findNode>[0]) => {
      const row = await findNode(args);
      if (!held && Object.keys(args.select ?? {}).sort().join(',') === 'deletedAt,memoryId') {
        held = true;
        reached();
        await resume;
      }
      return row;
    }) as unknown as typeof db.node.findUnique);
    try {
      const applying = call(request([spec.id], { dryRun: false, expectedPlan: preview.plan }));
      await atSelection;
      await resolvers.Mutation.deleteMemory(null, { id: draft.id }, ctx());
      release();
      await expect(applying).rejects.toMatchObject({ extensions: { code: 'SEARCH_REPLACE_PLAN_STALE' } });
    } finally {
      release();
      lookup.mockRestore();
    }
    expect((await db.node.findUniqueOrThrow({ where: { id: spec.id } })).content).toBe('cat cat scatter');
    expect(await db.nodeRevision.count({ where: { nodeId: spec.id } })).toBe(0);
  });

  it('waits for selected node rows before locking the corpus memory row', async () => {
    const spec = await node('pas:010:04');
    const preview = await call(request([spec.id]));
    let signalHeld!: () => void;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { signalHeld = resolve; });
    const mayRelease = new Promise<void>((resolve) => { release = resolve; });
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${spec.id} FOR UPDATE`;
      signalHeld();
      await mayRelease;
    }, { timeout: 20_000 });
    await held;
    const applying = call(request([spec.id], { dryRun: false, expectedPlan: preview.plan }));
    try {
      await vi.waitFor(async () => {
        const waiting = await db.$queryRaw<Array<{ pid: number }>>`
          SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE '%nodes%' AND pid <> pg_backend_pid()
        `;
        expect(waiting.length).toBeGreaterThan(0);
      }, { timeout: 5_000, interval: 25 });
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '500ms'`;
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM memories WHERE id = ${draft.id} FOR SHARE
        `;
        expect(rows).toHaveLength(1);
      });
    } finally {
      release();
      await holder;
    }
    await applying;
    expect((await db.node.findUniqueOrThrow({ where: { id: spec.id } })).content).toBe('dog dog scatter');
  }, 20_000);

  it('rejects minted nodes and mixed corpora while the generic door still skips specs', async () => {
    const spec = await node('pas:010:01');
    const minted = await memory('minted', false);
    const outside = await node('pas:020:01', {}, minted.id);
    await expect(call(request([spec.id, outside.id])))
      .rejects.toMatchObject({ extensions: { code: 'SEARCH_REPLACE_MIXED_CORPUS' } });
    // #1591: per node. An unminted node in any memory is a draft; a minted one is not.
    await expect(call(request([outside.id], { memoryRef: minted.id }))).resolves.toBeTruthy();
    await db.node.update({ where: { id: outside.id }, data: { mintedAt: new Date(), mintedByInfo: 'test' } });
    await expect(call(request([outside.id], { memoryRef: minted.id })))
      .rejects.toMatchObject({ extensions: { code: 'SEARCH_REPLACE_NOT_DRAFT' } });
    const generic = await resolvers.Mutation.searchReplaceInNodes(null, {
      input: { nodeIds: [spec.id], oldText: 'cat', newText: 'dog', fields: ['content'], dryRun: true },
    }, ctx());
    expect(generic).toMatchObject({ nodesSelected: 1, nodesScanned: 0, nodesSkipped: 1 });
  });

  it('requires memory write access for preview and apply', async () => {
    const spec = await node('pas:020:02');
    const preview = await call(request([spec.id]));
    const outsider = await db.user.create({
      data: { githubId: 1294002, githubUsername: 'spec-replace-outsider', roles: [] },
    });
    const outsiderCtx: Context = { db, roles: [], userId: outsider.id };
    await expect(resolvers.Mutation.searchReplaceInSpecNodes(
      null, { input: request([spec.id]) } as never, outsiderCtx,
    )).rejects.toThrow();
    await expect(resolvers.Mutation.searchReplaceInSpecNodes(
      null, { input: request([spec.id], { dryRun: false, expectedPlan: preview.plan }) } as never, outsiderCtx,
    )).rejects.toThrow();
    expect((await db.node.findUniqueOrThrow({ where: { id: spec.id } })).content).toBe('cat cat scatter');
  });

  it('reports other governed kinds and no-match separately', async () => {
    const spec = await node('pas:010:01', { content: 'no match' });
    const task = await node('pas:010:02', { role: 'task', isRunnable: true });
    const preview = await call(request([spec.id, task.id]));
    expect(preview).toMatchObject({
      nodesSelected: 2, nodesScanned: 1, nodesSkipped: 1, nodesChanged: 0,
      skipCounts: { governed: 1, protectedAddress: 0 },
    });
    expect(preview.skips).toEqual([expect.objectContaining({
      nodeId: task.id, reason: 'OTHER_GOVERNED_KIND', governedKinds: ['task'],
    })]);
  });

  it('skips Channel addresses and refuses a newly governed target after preview', async () => {
    const target = await node('pas:030:01');
    const { rootId } = await ensureChannelWithRoot(db, {
      memoryId: draft.id, loc: 'chats:team', name: 'team', createdBy: admin.id,
    });
    await db.node.update({ where: { id: rootId }, data: { content: 'cat' } });
    const preview = await call(request([target.id, rootId]));
    expect(preview).toMatchObject({
      nodesSelected: 2, nodesScanned: 1, nodesSkipped: 1,
      skipCounts: { governed: 0, protectedAddress: 1 },
    });
    expect(preview.skips).toEqual([expect.objectContaining({
      nodeId: rootId, reason: 'PROTECTED_ADDRESS',
    })]);
    await db.node.update({ where: { id: target.id }, data: { role: 'review' } });
    await expect(call(request([target.id, rootId], { dryRun: false, expectedPlan: preview.plan })))
      .rejects.toMatchObject({ extensions: { code: 'SEARCH_REPLACE_PLAN_STALE' } });
    expect((await db.node.findUniqueOrThrow({ where: { id: target.id } })).content).toBe('cat cat scatter');
  });

  it('marks an abstract stale after a content-only edit and refreshes its hash when edited', async () => {
    const spec = await node('pas:040:01', {
      abstract: 'cat summary', abstractOriginHash: computeContentHash('cat cat scatter'),
    });
    const contentPreview = await call(request([spec.id]));
    await call(request([spec.id], { dryRun: false, expectedPlan: contentPreview.plan }));
    const afterContent = await db.node.findUniqueOrThrow({ where: { id: spec.id } });
    expect(afterContent.abstractOriginHash).toBe(computeContentHash('cat cat scatter'));
    expect(afterContent.abstractOriginHash).not.toBe(computeContentHash(afterContent.content));

    const abstractPreview = await call(request([spec.id], { fields: ['abstract'] }));
    await call(request([spec.id], { fields: ['abstract'], dryRun: false, expectedPlan: abstractPreview.plan }));
    const afterAbstract = await db.node.findUniqueOrThrow({ where: { id: spec.id } });
    expect(afterAbstract.abstract).toBe('dog summary');
    expect(afterAbstract.abstractOriginHash).toBe(computeContentHash(afterAbstract.content));
  });

  it('refuses an abstract over the cap before creating any revision', async () => {
    const spec = await node('pas:045:01', { abstract: 'cat' });
    await expect(call(request([spec.id], { fields: ['abstract'], newText: 'x'.repeat(2001) })))
      .rejects.toMatchObject({ extensions: { code: 'NodeAbstractTooLongError' } });
    expect((await db.node.findUniqueOrThrow({ where: { id: spec.id } })).abstract).toBe('cat');
    expect(await db.nodeRevision.count({ where: { nodeId: spec.id } })).toBe(0);
  });

  it('keeps an encrypted draft corpus encrypted through preview, apply, and revision history', async () => {
    const privateDraft = await resolvers.Mutation.createMemory(null, {
      orgId: org.id, name: 'private-draft', memoryClass: 'private', draftCorpus: true,
    }, ctx());
    const spec = await node('pas:050:01', { abstract: 'cat summary' }, privateDraft.id);
    const dataKey = Buffer.alloc(32, 9).toString('base64');
    await resolvers.Mutation.encryptMemory(null, { memoryId: privateDraft.id, dataKey }, ctx());
    const key = parseDataKey(dataKey);
    sessionKeyCache.set('spec-replace-test', privateDraft.id, key);

    const input = request([spec.id], {
      memoryRef: privateDraft.id, fields: ['content', 'abstract'],
    });
    const preview = await call(input);
    expect(preview).toMatchObject({ nodesChanged: 1, totalReplacements: 3 });
    await call({ ...input, dryRun: false, expectedPlan: preview.plan });

    const stored = await db.node.findUniqueOrThrow({ where: { id: spec.id } });
    expect(isCiphertext(stored.content)).toBe(true);
    expect(isCiphertext(stored.abstract)).toBe(true);
    expect(decryptNodeFieldsWithKey({ ...stored }, key)).toMatchObject({
      content: 'dog dog scatter', abstract: 'dog summary',
    });
    const revision = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: spec.id } });
    expect(isCiphertext(revision.content)).toBe(true);
    expect(isCiphertext(revision.abstract)).toBe(true);
    expect(decryptNodeFieldsWithKey({ ...revision }, key)).toMatchObject({
      content: 'cat cat scatter', abstract: 'cat summary',
    });
  });

  it('refuses an encrypted draft preview when its session key is unavailable', async () => {
    const privateDraft = await resolvers.Mutation.createMemory(null, {
      orgId: org.id, name: 'locked-draft', memoryClass: 'private', draftCorpus: true,
    }, ctx());
    const spec = await node('pas:051:01', {}, privateDraft.id);
    await resolvers.Mutation.encryptMemory(null, {
      memoryId: privateDraft.id, dataKey: Buffer.alloc(32, 10).toString('base64'),
    }, ctx());
    sessionKeyCache.clear();
    await expect(call(request([spec.id], { memoryRef: privateDraft.id })))
      .rejects.toMatchObject({ extensions: { code: 'SESSION_EXPIRED' } });
    expect(await db.nodeRevision.count({ where: { nodeId: spec.id } })).toBe(0);
  });

  it('enforces maxNodesChanged atomically', async () => {
    const first = await node('pas:010:01');
    const second = await node('pas:010:02');
    const preview = await call(request([first.id, second.id], { maxNodesChanged: 1 }));
    await expect(call(request([first.id, second.id], {
      dryRun: false, expectedPlan: preview.plan, maxNodesChanged: 1,
    }))).rejects.toMatchObject({ extensions: { code: 'SEARCH_REPLACE_MAX_NODES_CHANGED' } });
    expect((await db.node.findUniqueOrThrow({ where: { id: first.id } })).content).toBe('cat cat scatter');
    expect((await db.node.findUniqueOrThrow({ where: { id: second.id } })).content).toBe('cat cat scatter');
  });

  it('exposes the strict result through GraphQL', async () => {
    const spec = await node('pas:010:01');
    const response = await server.executeOperation({
      query: `mutation($input: SpecSearchReplaceInput!) {
        searchReplaceInSpecNodes(input: $input) {
          plan nodesSelected nodesScanned nodesSkipped nodesChanged
          skips { nodeId reason governedKinds }
        }
      }`,
      variables: { input: request([spec.id]) },
    }, { contextValue: ctx() });
    if (response.body.kind !== 'single') throw new Error('unexpected incremental response');
    expect(response.body.singleResult.errors).toBeUndefined();
    expect(response.body.singleResult.data?.searchReplaceInSpecNodes).toMatchObject({
      nodesSelected: 1, nodesScanned: 1, nodesSkipped: 0, nodesChanged: 1,
    });
  });

  it('refuses an apply that adds an include to a missing target, storing nothing (Ruth, #2226 P3)', async () => {
    const spec = await node('pas:010:02');
    const before = await db.node.findUniqueOrThrow({ where: { id: spec.id } });
    const input = request([spec.id], { oldText: 'scatter', newText: '{{> pas:nowhere}}' });
    const preview = await call(input);
    await expect(call({ ...input, dryRun: false, expectedPlan: preview.plan }))
      .rejects.toMatchObject({ extensions: { code: 'INCLUDE_TARGET_UNAVAILABLE', tag: '{{> pas:nowhere}}' } });
    const after = await db.node.findUniqueOrThrow({ where: { id: spec.id } });
    expect(after.content).toBe('cat cat scatter');
    expect(after.revSeq).toBe(before.revSeq);
  });
});
