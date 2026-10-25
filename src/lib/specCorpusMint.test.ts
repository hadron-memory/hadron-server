/** #1448: minting a draft spec corpus, once and one-way, refused while anything blocks. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../integrations/db/client.js';
import { cleanDb, tombstoneNodes } from '../test/helpers.js';
import { generateId } from './id.js';
import { computeContentHash } from './contentHash.js';
import { computeApprovalHash } from './approvalHash.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { specCorpusMintMutations } from '../api/graphql/schema/resolvers.specCorpus.js';
import { pendingEdgeStableTargetKey } from './pendingEdgePromotion.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/mirrorNodeMove.js', () => ({
  mirrorNodeMoveToGit: vi.fn().mockResolvedValue(undefined),
}));

let admin: { id: string };
let reader: { id: string };
let outsider: { id: string };
let org: { id: string; urn: string };
let draft: { id: string; urn: string };

const as = (userId = admin.id): Context => ({ db, userId, roles: [] });
/**
 * #1591: minting requires each unminted node's current revision to be
 * approved. These tests are about the other checks, so record the approvals
 * directly (revision + hash), bypassing the approve gate; the approval flow
 * and NOT_APPROVED have their own tests in nodeMint.test.ts.
 */
const approveAllInDb = (memoryId: string) => db.$transaction(async (tx) => {
  // SKIP LOCKED: the race tests hold a node row while the mint waits on it;
  // approving must not wait on that hold. A skipped node stays unapproved,
  // which those tests never reach (the mint refuses or blocks first).
  const nodes = await tx.$queryRaw<Array<{ id: string; rev_seq: number; name: string; abstract: string | null; content: string | null }>>`
    SELECT id, rev_seq, name, abstract, content FROM nodes
    WHERE memory_id = ${memoryId} AND deleted_at IS NULL AND minted_at IS NULL
    FOR UPDATE SKIP LOCKED`;
  for (const n of nodes) {
    await tx.node.update({
      where: { id: n.id },
      data: {
        approvedRevNo: n.rev_seq, approvedByInfo: 'test', approvedAt: new Date(),
        approvalHash: computeApprovalHash({ title: n.name, abstract: n.abstract, content: n.content }),
      },
    });
  }
});
const mint = async (dryRun?: boolean, userId = admin.id, memoryRef = draft.id) => {
  if (await db.memory.findUnique({ where: { id: memoryRef }, select: { id: true } })) await approveAllInDb(memoryRef);
  return specCorpusMintMutations.mintSpecCorpus(null, { memoryRef, ...(dryRun !== undefined ? { dryRun } : {}) }, as(userId));
};
const spec = (loc: string, content: string, extra: Record<string, unknown> = {}) => db.node.create({
  data: { id: generateId(), memoryId: draft.id, loc, name: loc, content, role: 'spec', nodeType: 'info', tags: ['spec'], ...extra },
});
const codeOf = async (p: Promise<unknown>) => {
  try { await p; return 'NO_ERROR'; } catch (e) {
    return e instanceof GraphQLError ? String(e.extensions.code) : (e as Error).name;
  }
};
const stateOf = async () => resolvers.Memory.corpusState({ id: draft.id }, {}, as());

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'Mint Org', urn: 'mint.example' } });
  admin = await db.user.create({ data: { githubId: 146001, githubUsername: 'mint-admin', roles: [] } });
  reader = await db.user.create({ data: { githubId: 146002, githubUsername: 'mint-reader', roles: [] } });
  outsider = await db.user.create({ data: { githubId: 146003, githubUsername: 'mint-outsider', roles: [] } });
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
    { organizationId: org.id, userId: reader.id, role: 'READER' },
  ] });
  draft = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'specs-draft', draftCorpus: true }, as());
  await spec('pas:010', `Feature. See [Rule [pas:010:01]](https://h/app/u/hrn:node:${draft.urn}:pas:010:01).`);
  await spec('pas:010:01', 'Rule body.');
});

describe('encrypted-memory mint refusal (#1861)', () => {
  it('keeps the existing code and states that encrypted memories are unsupported', async () => {
    await db.memory.update({where:{id:draft.id},data:{isEncrypted:true,vectorIndexEnabled:false}});
    await expect(specCorpusMintMutations.mintSpecCorpus(null,{memoryRef:draft.id},as())).rejects.toMatchObject({
      message:'Reference scans do not support encrypted memories.',
      extensions:{code:'SPEC_CORPUS_ENCRYPTED_UNSUPPORTED',memoryId:draft.id},
    });
  });
});

describe('mintSpecCorpus: a clean corpus (#1448)', () => {
  it('dry run reports nothing blocking and changes nothing; the real run mints once, one-way', async () => {
    const dry = await mint(true);
    expect(dry).toMatchObject({ dryRun: true, minted: false, blockers: [], staleAbstractsBlock: false });
    expect(await stateOf()).toBe('DRAFT');

    const done = await mint();
    expect(done).toMatchObject({ dryRun: false, minted: true, blockers: [] });
    expect(await stateOf()).toBe('MINTED');
    const row = await db.memory.findUniqueOrThrow({ where: { id: draft.id } });
    expect(row.corpusMintedAt).toBeInstanceOf(Date);
    expect(row.corpusMintedBy).toBe(admin.id);

    // #1591: per node. A second mint has nothing left to mint; a new
    // reservation is an unminted node, which the next mint must clear; and a
    // minted node's move records its alias.
    expect(await mint()).toMatchObject({ minted: false, mintedCount: 0, mintLocs: [] });
    expect(await codeOf(resolvers.Mutation.reserveSpecCitation(null, { memoryRef: draft.id, loc: 'pas:020' }, as())))
      .toBe('NO_ERROR');
    expect((await mint(true)).blockers).toEqual([expect.objectContaining({ kind: 'PLACEHOLDER', loc: 'pas:020' })]);
    const rule = await db.node.findFirstOrThrow({ where: { memoryId: draft.id, loc: 'pas:010:01' } });
    await resolvers.Mutation.moveNode(null, { sourceRef: rule.id, targetUrn: `hrn:node:${draft.urn}:pas:010:02` }, as());
    expect(await db.urnAlias.count({ where: { entityType: 'NODE', entityId: rule.id } })).toBe(1);
  });

  it('does not lint the memory\'s own root node (not a citation)', async () => {
    const root = await db.node.findFirstOrThrow({ where: { memoryId: draft.id, loc: 'specs-draft' } });
    expect(root.role).not.toBe('spec');
    expect((await mint(true)).blockers).toEqual([]);
  });
});

describe('mintSpecCorpus lints exactly the CLI --all scope (ruling (a); @codex P2s on #1462)', () => {
  it('lints a memory root that sits at a citation-shaped name, as the CLI does', async () => {
    const pas = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'pas', draftCorpus: true }, as());
    expect((await mint(true, admin.id, pas.id)).blockers.map((b) => [b.loc, b.rule])).toEqual([['pas', 'tag-spec']]);
    // Marked as the module's spec, it passes like any spec.
    await db.node.updateMany({ where: { memoryId: pas.id, loc: 'pas' }, data: { tags: ['spec'] } });
    expect((await mint(true, admin.id, pas.id)).blockers).toEqual([]);
  });

  it('lints a spec-marked node at a non-citation loc, and leaves an ordinary unmarked node alone', async () => {
    await db.node.create({ data: {
      id: generateId(), memoryId: draft.id, loc: 'guides:intro', name: 'Intro', content: 'Body.', role: 'spec', nodeType: 'data',
    } });
    await db.node.create({ data: { id: generateId(), memoryId: draft.id, loc: 'guides:notes', name: 'Notes', nodeType: 'data' } });
    expect((await mint(true)).blockers.map((b) => [b.loc, b.rule])).toEqual([['guides:intro', 'nodetype-info']]);
  });
});

describe('mintSpecCorpus: blockers (#1448)', () => {
  it('lists every blocker, and a real run refuses and leaves the corpus a draft', async () => {
    await resolvers.Mutation.reserveSpecCitation(null, { memoryRef: draft.id, loc: 'pas:030' }, as());
    await spec('pas:040', `Cites a missing spec: hrn:node:${draft.urn}:pas:099.`);
    await spec('pas:050', 'Wrong type.', { nodeType: 'data' });
    await spec('pas:060', 'Leaked </abstract><content> markup.');

    const report = await mint(true);
    expect(report.blockers.map((b) => [b.kind, b.loc, b.rule ?? b.targetLoc])).toEqual(expect.arrayContaining([
      ['PLACEHOLDER', 'pas:030', null],
      ['UNRESOLVED_REFERENCE', 'pas:040', 'MISSING'],
      ['LINT', 'pas:050', 'nodetype-info'],
      ['LINT', 'pas:060', 'serialization-leak'],
    ]));
    expect(report.blockers.find((b) => b.kind === 'UNRESOLVED_REFERENCE')?.targetLoc).toBe('pas:099');

    let refusal: GraphQLError | undefined;
    try { await mint(); } catch (e) { refusal = e as GraphQLError; }
    expect(refusal?.extensions).toMatchObject({ code: 'SPEC_CORPUS_MINT_BLOCKED', blockerCount: report.blockers.length });
    expect(await stateOf()).toBe('DRAFT');
    expect((await db.memory.findUniqueOrThrow({ where: { id: draft.id } })).corpusMintedAt).toBeNull();
  });

  it('counts a reference to a placeholder as unresolved', async () => {
    await resolvers.Mutation.reserveSpecCitation(null, { memoryRef: draft.id, loc: 'pas:070' }, as());
    await spec('pas:080', `Depends on hrn:node:${draft.urn}:pas:070.`);
    const blockers = (await mint(true)).blockers;
    expect(blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'UNRESOLVED_REFERENCE', loc: 'pas:080', rule: 'PLACEHOLDER', targetLoc: 'pas:070' }),
    ]));
  });
});

describe('mintSpecCorpus: an edge to a deleted spec is unresolved (@codex P2 on #1462)', () => {
  it('blocks while a live corpus edge points at a soft-deleted spec, and not once that edge is gone', async () => {
    const source = await db.node.findFirstOrThrow({ where: { memoryId: draft.id, loc: 'pas:010' } });
    const doomed = await spec('pas:030', 'Soon deleted.');
    const edge = await db.edge.create({ data: {
      memoryId: draft.id, sourceId: source.id, targetId: doomed.id, loc: 'pas:010:depends-on:pas:030', name: 'depends-on',
    } });
    expect((await mint(true)).blockers).toEqual([]);
    await tombstoneNodes(db, [doomed.id]);

    expect((await mint(true)).blockers).toEqual([
      expect.objectContaining({ kind: 'UNRESOLVED_REFERENCE', loc: 'pas:010', rule: 'MISSING', targetLoc: 'pas:030' }),
    ]);
    expect(await codeOf(mint())).toBe('SPEC_CORPUS_MINT_BLOCKED');

    await db.edge.delete({ where: { id: edge.id } });
    expect((await mint(true)).blockers).toEqual([]);
  });
});

describe('mintSpecCorpus: an edge into another memory can point at a placeholder (@codex P2 on #1462)', () => {
  const edgeFrom010To = async (targetId: string) => {
    const source = await db.node.findFirstOrThrow({ where: { memoryId: draft.id, loc: 'pas:010' } });
    await db.edge.create({ data: { memoryId: draft.id, sourceId: source.id, targetId, loc: `pas:010:uses:${targetId}`, name: 'uses' } });
  };

  it('blocks on a placeholder in another draft the caller can read, named by its node URN', async () => {
    const other = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'other-draft', draftCorpus: true }, as());
    const reserved = await resolvers.Mutation.reserveSpecCitation(null, { memoryRef: other.id, loc: 'pas:900' }, as());
    await edgeFrom010To(reserved.id);
    expect((await mint(true)).blockers).toEqual([expect.objectContaining({
      kind: 'UNRESOLVED_REFERENCE', loc: 'pas:010', rule: 'PLACEHOLDER', targetLoc: `hrn:node:${other.urn}:pas:900`,
    })]);
  });

  it('blocks on a deleted node in another readable memory as MISSING (@codex P2 on #1462)', async () => {
    const other = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'other-specs' }, as());
    const gone = await db.node.create({ data: {
      id: generateId(), memoryId: other.id, loc: 'cor:010', name: 'cor:010', role: 'spec', nodeType: 'info', tags: ['spec'], content: 'Old.',
    } });
    await edgeFrom010To(gone.id);
    // #1591: a live target that is not minted is CITES_UNMINTED; minted, it is fine.
    expect((await mint(true)).blockers).toEqual([expect.objectContaining({
      kind: 'CITES_UNMINTED', loc: 'pas:010', targetLoc: `hrn:node:${other.urn}:cor:010`,
    })]);
    await db.node.update({ where: { id: gone.id }, data: { mintedAt: new Date(), mintedByInfo: 'test' } });
    expect((await mint(true)).blockers).toEqual([]);
    await tombstoneNodes(db, [gone.id]);
    expect((await mint(true)).blockers).toEqual([expect.objectContaining({
      kind: 'UNRESOLVED_REFERENCE', loc: 'pas:010', rule: 'MISSING', targetLoc: `hrn:node:${other.urn}:cor:010`,
    })]);
  });

  it('checks CITES_UNMINTED only for sources in the mint scope (#1612): a minted unchanged source is skipped, an edited one blocks', async () => {
    const other = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'other-specs' }, as());
    const target = await db.node.create({ data: {
      id: generateId(), memoryId: other.id, loc: 'cor:010', name: 'cor:010', role: 'spec', nodeType: 'info', tags: ['spec'], content: 'Draft.',
    } });
    await edgeFrom010To(target.id);
    const source = await db.node.findFirstOrThrow({ where: { memoryId: draft.id, loc: 'pas:010' } });
    await db.node.update({ where: { id: source.id }, data: { mintedAt: new Date(), mintedByInfo: 'test', mintedRevNo: 1, mintedHash: 'h', contentRevSeq: 1 } });
    expect((await mint(true)).blockers.filter((b: { kind: string }) => b.kind === 'CITES_UNMINTED')).toEqual([]);
    await db.node.update({ where: { id: source.id }, data: { contentRevSeq: 2 } });
    expect((await mint(true)).blockers).toContainEqual(expect.objectContaining({
      kind: 'CITES_UNMINTED', loc: 'pas:010', targetLoc: `hrn:node:${other.urn}:cor:010`,
    }));
  });

  it('blocks uniformly, revealing nothing, on edges into a memory the caller cannot read', async () => {
    await db.orgMember.create({ data: { organizationId: org.id, userId: outsider.id, role: 'READER' } });
    const hidden = await db.memory.create({ data: {
      id: generateId(), urn: `${org.urn}:outsiders-draft`, name: 'outsiders-draft', class: 'private',
      organizationId: org.id, userId: outsider.id, corpusDraft: true,
    } });
    const placeholder = await db.node.create({ data: {
      id: generateId(), memoryId: hidden.id, loc: 'pas:900', name: 'pas:900', role: 'spec', nodeType: 'info', isPlaceholder: true,
    } });
    const deleted = await db.node.create({ data: {
      id: generateId(), memoryId: hidden.id, loc: 'pas:901', name: 'pas:901', role: 'spec', nodeType: 'info', deletedAt: new Date(),
    } });
    const written = await db.node.create({ data: {
      id: generateId(), memoryId: hidden.id, loc: 'pas:902', name: 'pas:902', role: 'spec', nodeType: 'info', content: 'Written.',
    } });
    await edgeFrom010To(placeholder.id);
    await edgeFrom010To(deleted.id);
    await edgeFrom010To(written.id);
    // (@codex P2 on #1462) Every edge into the unreadable memory blocks the
    // same way, whatever its target's state, named only by its target id.
    const blockers = (await mint(true)).blockers;
    expect(blockers.map((b) => [b.rule, b.targetLoc]).sort()).toEqual(
      [placeholder.id, deleted.id, written.id].map((t) => ['MISSING', t]).sort(),
    );
    expect(JSON.stringify(blockers)).not.toMatch(/pas:90[012]/);
  });
});

describe('mintSpecCorpus: pending edges are references too (@codex P2s on #1462)', () => {
  const pendingFrom = async (loc: string, targetId: string, name = 'depends-on') => {
    const source = await db.node.findFirstOrThrow({ where: { memoryId: draft.id, loc } });
    await db.pendingEdge.create({ data: { id: generateId(), sourceId: source.id, targetId, name } });
  };

  it('blocks on an unresolved pending edge, and a real run refuses', async () => {
    await pendingFrom('pas:010:01', 'pas:099');
    expect((await mint(true)).blockers).toEqual([
      expect.objectContaining({ kind: 'UNRESOLVED_REFERENCE', loc: 'pas:010:01', rule: 'MISSING', targetLoc: 'pas:099' }),
    ]);
    expect(await codeOf(mint())).toBe('SPEC_CORPUS_MINT_BLOCKED');
    expect(await stateOf()).toBe('DRAFT');
  });

  it('never reads an unresolved target as a node id, even when it equals one', async () => {
    const written = await db.node.findFirstOrThrow({ where: { memoryId: draft.id, loc: 'pas:010' } });
    await pendingFrom('pas:010:01', written.id);
    expect((await mint(true)).blockers).toEqual([
      expect.objectContaining({ kind: 'UNRESOLVED_REFERENCE', rule: 'MISSING', targetLoc: written.id }),
    ]);
  });

  it('never lets an unreadable memory decide a stable pending edge (@codex P1 on #1462)', async () => {
    await db.orgMember.create({ data: { organizationId: org.id, userId: outsider.id, role: 'READER' } });
    const hidden = await db.memory.create({ data: {
      id: generateId(), urn: `${org.urn}:outsiders-specs`, name: 'outsiders-specs', class: 'private',
      organizationId: org.id, userId: outsider.id,
    } });
    const target = await db.node.create({ data: {
      id: generateId(), memoryId: hidden.id, loc: 'pas:700', name: 'pas:700', role: 'spec', nodeType: 'info', isPlaceholder: true,
    } });
    await pendingFrom('pas:010:01', pendingEdgeStableTargetKey(target.id));
    const asPlaceholder = (await mint(true)).blockers;
    await db.node.update({ where: { id: target.id }, data: { isPlaceholder: false, content: 'Written.' } });
    const asWritten = (await mint(true)).blockers;
    await db.node.update({ where: { id: target.id }, data: { deletedAt: new Date() } });
    const asDeleted = (await mint(true)).blockers;
    expect(asPlaceholder).toEqual(asWritten);
    expect(asDeleted).toEqual(asWritten);
    expect(JSON.stringify(asWritten)).not.toContain('pas:700');
    // ...but the pending relationship still blocks, whatever the target's state (@codex P2 on #1462).
    expect(asWritten).toEqual([expect.objectContaining({
      kind: 'UNRESOLVED_REFERENCE', loc: 'pas:010:01', rule: 'MISSING', targetLoc: pendingEdgeStableTargetKey(target.id),
    })]);
    expect(await codeOf(mint())).toBe('SPEC_CORPUS_MINT_BLOCKED');
  });

  it('decodes a stable key: skipped for a written spec, PLACEHOLDER for a placeholder, MISSING once deleted', async () => {
    const reserved = await resolvers.Mutation.reserveSpecCitation(null, { memoryRef: draft.id, loc: 'pas:020' }, as());
    const written = await db.node.findFirstOrThrow({ where: { memoryId: draft.id, loc: 'pas:010' } });
    const gone = await spec('pas:030', 'Soon deleted.');
    await db.node.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
    await pendingFrom('pas:010:01', pendingEdgeStableTargetKey(reserved.id));
    await pendingFrom('pas:010:01', pendingEdgeStableTargetKey(written.id), 'refines');
    await pendingFrom('pas:010:01', pendingEdgeStableTargetKey(gone.id), 'replaces');
    const unresolved = await resolvers.Query.specUnresolvedReferences(null, { memoryRef: draft.id }, as());
    expect(unresolved.map((r) => [r.field, r.text, r.targetLoc, r.reason])).toEqual(expect.arrayContaining([
      ['pendingEdge', 'depends-on', 'pas:020', 'PLACEHOLDER'],
      ['pendingEdge', 'replaces', 'pas:030', 'MISSING'],
    ]));
    expect(unresolved.filter((r) => r.field === 'pendingEdge')).toHaveLength(2);
  });
});

describe('mintSpecCorpus: report-only items (#1448)', () => {
  it('lists stale abstracts without blocking while #1408 is pending, and groups open questions by decider', async () => {
    await spec('pas:090', 'New body.', { abstract: 'Summary of an older body.', abstractOriginHash: computeContentHash('Old body.') });
    await spec('pas:091', [
      '## Open Questions, Need Ruling', '',
      '- **Log out asks first?** Duygu decides.',
      '- **Which help centre?** Duygu decides.',
      '- **Nobody owns this?** Still open.',
    ].join('\n'));

    const report = await mint(true);
    expect(report.staleAbstracts.map((s) => s.loc)).toEqual(['pas:090']);
    expect(report.staleAbstractsBlock).toBe(false);
    expect(report.blockers).toEqual([]);
    expect(report.openQuestions).toEqual([
      { decider: 'Duygu', questions: [
        { loc: 'pas:091', question: 'Log out asks first?' },
        { loc: 'pas:091', question: 'Which help centre?' },
      ] },
      { decider: null, questions: [{ loc: 'pas:091', question: 'Nobody owns this?' }] },
    ]);
    // Report-only items never stop a mint.
    expect((await mint()).minted).toBe(true);
  });
});

describe('mintSpecCorpus: who may mint (#1448)', () => {
  it('refuses a reader and conceals the corpus from an outsider, minting nothing', async () => {
    expect(await codeOf(mint(false, reader.id))).not.toBe('NO_ERROR');
    const hidden = await codeOf(mint(false, outsider.id));
    const missing = await codeOf(mint(false, outsider.id, `hrn:mem:${org.urn}:no-such-corpus`));
    expect(hidden).toBe(missing);
    expect(await stateOf()).toBe('DRAFT');
  });

  it('lets the principal of an org-anchored private corpus mint it, and nobody else (@codex P2 on #1462)', async () => {
    const own = await db.memory.create({ data: {
      id: generateId(), urn: `${org.urn}:readers-draft`, name: 'readers-draft', class: 'private',
      organizationId: org.id, userId: reader.id, corpusDraft: true,
    } });
    await db.node.create({ data: {
      id: generateId(), memoryId: own.id, loc: 'pas:010', name: 'pas:010', content: 'Body.', role: 'spec', nodeType: 'info', tags: ['spec'],
    } });
    // An org ADMIN cannot read it, so it is concealed from them.
    const concealed = await codeOf(mint(false, admin.id, own.id));
    expect(concealed).toBe(await codeOf(mint(false, admin.id, `hrn:mem:${org.urn}:no-such-corpus`)));
    // The principal (a READER of the org) mints it.
    expect(await mint(false, reader.id, own.id)).toMatchObject({ minted: true });
  });

  it('mints a memory that was never asked to be a draft: minting is per node (#1591)', async () => {
    const plain = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'plain' }, as());
    expect(await resolvers.Memory.corpusState({ id: plain.id }, {}, as())).toBe('DRAFT');
    expect(await mint(false, admin.id, plain.id)).toMatchObject({ minted: true, mintedCount: 1 });
    expect(await resolvers.Memory.corpusState({ id: plain.id }, {}, as())).toBe('MINTED');
  });
});

describe('mintSpecCorpus serializes with in-flight node writes (#1448)', () => {
  it('waits for a write holding the memory lock, and judges the corpus as that write left it', async () => {
    let release!: () => void;
    let held!: () => void;
    const lockHeld = new Promise<void>((r) => { held = r; });
    const hold = new Promise<void>((r) => { release = r; });
    // What every node write holds until it commits (writeNodeCore's encryption fence).
    const writer = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM memories WHERE id = ${draft.id} FOR SHARE`;
      held();
      await hold;
      // The write lands a missing reference just before it commits.
      await tx.node.create({ data: {
        id: generateId(), memoryId: draft.id, loc: 'pas:100', name: 'late', role: 'spec', nodeType: 'info', tags: ['spec'],
        content: `Late: hrn:node:${draft.urn}:pas:404.`,
      } });
    }, { timeout: 20_000 });
    await lockHeld;

    const minting = codeOf(mint());
    try {
      await vi.waitFor(async () => {
        const waiting = await db.$queryRaw<Array<{ pid: number }>>`
          SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE '%FROM memories WHERE id%' AND query LIKE '%FOR UPDATE%'
        `;
        expect(waiting.length).toBeGreaterThan(0);
      }, { timeout: 5_000, interval: 25 });
    } finally {
      release();
    }
    await writer;
    // The mint ran after the write committed, so it saw the missing reference.
    expect(await minting).toBe('SPEC_CORPUS_MINT_BLOCKED');
    expect(await stateOf()).toBe('DRAFT');
  });
});

describe('mintSpecCorpus does not rely on writers taking its fence (@codex P2s on #1462)', () => {
  it('waits for a direct insert that took no memory lock, and judges the corpus as it left it', async () => {
    let release!: () => void;
    let held!: () => void;
    const inserted = new Promise<void>((r) => { held = r; });
    const hold = new Promise<void>((r) => { release = r; });
    // Like a Channel message post: a plain insert, no FOR SHARE on the memory.
    const writer = db.$transaction(async (tx) => {
      await tx.node.create({ data: {
        id: generateId(), memoryId: draft.id, loc: 'pas:100', name: 'late', role: 'spec', nodeType: 'info', tags: ['spec'],
        content: `Late: hrn:node:${draft.urn}:pas:404.`,
      } });
      held();
      await hold;
    }, { timeout: 20_000 });
    await inserted;

    const minting = codeOf(mint());
    try {
      await vi.waitFor(async () => {
        const waiting = await db.$queryRaw<Array<{ pid: number }>>`
          SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE '%FROM memories WHERE id%' AND query LIKE '%FOR UPDATE%'
        `;
        expect(waiting.length).toBeGreaterThan(0);
      }, { timeout: 5_000, interval: 25 });
    } finally {
      release();
    }
    await writer;
    expect(await minting).toBe('SPEC_CORPUS_MINT_BLOCKED');
    expect(await stateOf()).toBe('DRAFT');
  });

  it('refuses as retryable, minting nothing, while a direct update holds a node of the corpus', async () => {
    let release!: () => void;
    let held!: () => void;
    const updated = new Promise<void>((r) => { held = r; });
    const hold = new Promise<void>((r) => { release = r; });
    const writer = db.$transaction(async (tx) => {
      await tx.node.updateMany({
        where: { memoryId: draft.id, loc: 'pas:010:01' },
        data: { content: `Now cites hrn:node:${draft.urn}:pas:404.` },
      });
      held();
      await hold;
    }, { timeout: 20_000 });
    await updated;

    try {
      expect(await codeOf(mint())).toBe('SPEC_CORPUS_BUSY');
      expect(await stateOf()).toBe('DRAFT');
    } finally {
      release();
    }
    await writer;
    // Once the write lands, the mint judges it.
    expect(await codeOf(mint())).toBe('SPEC_CORPUS_MINT_BLOCKED');
  });
});

describe('an extraction that moves specs out serializes with minting (@codex P2 on #1462)', () => {
  it('waits while a mint holds the corpus, so it cannot delete specs between the mint\'s read and its flip', async () => {
    let release!: () => void;
    let held!: () => void;
    const lockHeld = new Promise<void>((r) => { held = r; });
    const hold = new Promise<void>((r) => { release = r; });
    let seenByMint = -1;
    // What mintSpecCorpus holds from its report to its flip.
    const minter = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM memories WHERE id = ${draft.id} FOR NO KEY UPDATE`;
      held();
      await hold;
      seenByMint = await tx.node.count({ where: { memoryId: draft.id, deletedAt: null, loc: { startsWith: 'pas:010' } } });
      // …and flips the corpus, as a real mint does before it commits.
      await tx.$executeRaw`UPDATE memories SET corpus_draft = false WHERE id = ${draft.id}`;
    }, { timeout: 20_000 });
    await lockHeld;

    const parent = await db.node.findFirstOrThrow({ where: { memoryId: draft.id, loc: 'pas:010' } });
    const extracting = codeOf(resolvers.Mutation.extractParentNodeToMemory(
      {}, { parentRef: parent.id, targetUrn: `${org.urn}::extracted-specs`, move: true } as never, as(),
    ));
    try {
      await vi.waitFor(async () => {
        const waiting = await db.$queryRaw<Array<{ pid: number }>>`
          SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE '%FROM memories WHERE id%' AND query LIKE '%FOR SHARE%'
        `;
        expect(waiting.length).toBeGreaterThan(0);
      }, { timeout: 5_000, interval: 25 });
    } finally {
      release();
    }
    await minter;
    // The mint's snapshot still had both specs: the extraction had not landed.
    expect(seenByMint).toBe(2);
    // Ordered after the mint, the extraction is an ordinary edit of a MINTED
    // corpus. Extract has no draft-only behavior, and today's rules (which
    // apply unchanged after minting, #1447 §5) do not refuse removing a spec.
    expect(await extracting).toBe('NO_ERROR');
    expect(await db.node.count({ where: { memoryId: draft.id, deletedAt: null, loc: { startsWith: 'pas:010' } } })).toBe(0);
  });
});

describe('mintSpecCorpus re-authorizes under the lock (@codex P2 on #1462)', () => {
  it('refuses when the corpus moved to an org the caller cannot manage after the pre-check', async () => {
    const otherOrg = await db.organization.create({ data: { id: generateId(), name: 'Other Org', urn: 'other-mint.example' } });
    // Only a READER there: can still read the corpus, so the read gate alone
    // would not stop the mint; the re-run MANAGE gate must.
    await db.orgMember.create({ data: { organizationId: otherOrg.id, userId: admin.id, role: 'READER' } });
    let fired = false;
    // The org transfer commits between the pre-check and the mint's row lock.
    const racingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === '$transaction' && !fired) {
          return async (...args: unknown[]) => {
            fired = true;
            await db.memory.update({ where: { id: draft.id }, data: { organizationId: otherOrg.id } });
            return (target.$transaction as (...a: unknown[]) => unknown)(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const code = await codeOf(specCorpusMintMutations.mintSpecCorpus(null, { memoryRef: draft.id }, { ...as(), db: racingDb }));
    expect(fired).toBe(true);
    expect(code).not.toBe('NO_ERROR');
    expect((await db.memory.findUniqueOrThrow({ where: { id: draft.id } })).corpusDraft).toBe(true);
  });
});

describe('Memory.corpusMintedAt is derived from the nodes (#1591)', () => {
  it('is the latest node mint time, whatever the parent carries', async () => {
    expect(await resolvers.Memory.corpusMintedAt({ id: draft.id }, {}, as())).toBeNull();
    await mint();
    const latest = (await db.node.aggregate({ where: { memoryId: draft.id }, _max: { mintedAt: true } }))._max.mintedAt;
    expect(latest).toBeInstanceOf(Date);
    expect(await resolvers.Memory.corpusMintedAt({ id: draft.id }, {}, as())).toEqual(latest);
  });
});
