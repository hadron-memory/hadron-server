import { withIncludeHistoryTransaction } from './includes/includeHistoryFence.js';
import { waitForLockWaitersOfType } from '../test/lockWait.js';
/** #1449: backlinks, unresolved references and renumber in a draft spec corpus. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { specCorpusRenumberMutations, specCorpusMintMutations } from '../api/graphql/schema/resolvers.specCorpus.js';
import { resolveNodeRefForCaller } from '../api/graphql/schema/resolvers.nodeRefAccess.js';
import { resolveNodeRef } from './entityRef/nodeRef.js';
import { AmbiguousLegacyUrnError, NodeNotFoundError } from './entityRef/errors.js';
import { nodeMoveOps } from '../api/graphql/schema/resolvers.mutation.node.js';
import { mirrorNodeMoveToGit } from '../integrations/github/mirrorNodeMove.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/mirrorNodeMove.js', () => ({
  mirrorNodeMoveToGit: vi.fn().mockResolvedValue(undefined),
}));

let admin: { id: string };
let outsider: { id: string };
let org: { id: string; urn: string };
let draft: { id: string; urn: string };
let minted: { id: string; urn: string };

const as = (userId = admin.id): Context => ({ db, userId, roles: [] });
/** A portal link to a spec in the draft, as Micromentor's corpus writes it. */
const link = (label: string, loc: string) => `[${label} [${loc}]](https://hadronmemory.com/app/u/hrn:node:${draft.urn}:${loc})`;
const spec = (loc: string, name: string, content: string | null) => db.node.create({
  data: { id: generateId(), memoryId: draft.id, loc, name, content, role: 'spec', nodeType: 'info' },
});
const codeOf = async (p: Promise<unknown>) => {
  try { await p; return 'NO_ERROR'; } catch (e) {
    return e instanceof GraphQLError ? String(e.extensions.code) : (e as Error).name;
  }
};
const content = async (loc: string) => (await db.node.findFirstOrThrow({ where: { memoryId: draft.id, loc, deletedAt: null } })).content;

let feature: { id: string };
let rule: { id: string };
let other: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'Corpus Org', urn: 'corpus.example' } });
  admin = await db.user.create({ data: { githubId: 145101, githubUsername: 'refs-admin', roles: [] } });
  outsider = await db.user.create({ data: { githubId: 145102, githubUsername: 'refs-outsider', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  draft = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'specs-draft', draftCorpus: true }, as());
  minted = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'specs' }, as());

  feature = await spec('pas:010', 'Feature: Vacation mode [pas:010]', `Rules:\n\n- ${link('Rule: hidden while away', 'pas:010:01')}`);
  rule = await spec('pas:010:01', 'Rule: hidden while away [pas:010:01]', 'A member on vacation is not shown.');
  await resolvers.Mutation.reserveSpecCitation(null, { memoryRef: draft.id, loc: 'pas:030' }, as());
  other = await spec('pas:020', 'Feature: Search [pas:020]',
    `Builds on ${link('Vacation', 'pas:010')}. See hrn:node:${draft.urn}:pas:099 and ${link('Later', 'pas:030')}.`);
  await db.edge.create({ data: { memoryId: draft.id, sourceId: other.id, targetId: feature.id, loc: 'pas:020:depends-on:pas:010', name: 'depends-on' } });
});

describe('specBacklinks (#1449)', () => {
  it('unions URN references in the text (inside URLs) with real edges, for the exact citation', async () => {
    const refs = await resolvers.Query.specBacklinks(null, { memoryRef: draft.id, loc: 'pas:010' }, as());
    expect(refs.map((r) => [r.kind, r.sourceLoc, r.field])).toEqual([
      ['URN', 'pas:020', 'content'],
      ['EDGE', 'pas:020', 'edge'],
    ]);
    const toRule = await resolvers.Query.specBacklinks(null, { memoryRef: draft.id, loc: 'pas:010:01' }, as());
    expect(toRule.map((r) => r.sourceLoc)).toEqual(['pas:010']);
  });

  it('includes a live edge into a deleted target spec at its old citation (#1478)', async () => {
    const target = await spec('pas:080', 'Soon deleted', 'Old rule.');
    await db.edge.create({ data: {
      memoryId: draft.id, sourceId: other.id, targetId: target.id,
      loc: 'pas:020:cites:pas:080', name: 'cites',
    } });
    await db.node.update({ where: { id: target.id }, data: { deletedAt: new Date() } });
    const refs = await resolvers.Query.specBacklinks(null, { memoryRef: draft.id, loc: 'pas:080' }, as());
    expect(refs.map((ref) => [ref.kind, ref.sourceLoc, ref.targetLoc]))
      .toEqual([['EDGE', 'pas:020', 'pas:080']]);
  });

  it('scans any memory (#1591), and conceals an unreadable one as not found', async () => {
    expect(await resolvers.Query.specBacklinks(null, { memoryRef: minted.id, loc: 'x' }, as())).toEqual([]);
    const hidden = await codeOf(resolvers.Query.specBacklinks(null, { memoryRef: draft.id, loc: 'pas:010' }, as(outsider.id)));
    expect(hidden).toBe('MemoryNotFoundError');
    const missing = await codeOf(resolvers.Query.specBacklinks(null, { memoryRef: `hrn:mem:${org.urn}:no-such`, loc: 'pas:010' }, as(outsider.id)));
    expect(missing).toBe(hidden);
  });
});

describe('specUnresolvedReferences (#1449)', () => {
  it('reports a URN to a missing spec and one to a placeholder, and nothing that resolves', async () => {
    const refs = await resolvers.Query.specUnresolvedReferences(null, { memoryRef: draft.id }, as());
    expect(refs.map((r) => [r.sourceLoc, r.targetLoc, r.reason])).toEqual([
      ['pas:020', 'pas:099', 'MISSING'],
      ['pas:020', 'pas:030', 'PLACEHOLDER'],
    ]);
  });

  it('reports an edge that points at a placeholder', async () => {
    const placeholder = await db.node.findFirstOrThrow({ where: { memoryId: draft.id, loc: 'pas:030' } });
    await db.edge.create({ data: { memoryId: draft.id, sourceId: rule.id, targetId: placeholder.id, loc: 'pas:010:01:see:pas:030', name: 'see' } });
    const refs = await resolvers.Query.specUnresolvedReferences(null, { memoryRef: draft.id }, as());
    expect(refs.filter((r) => r.kind === 'EDGE').map((r) => [r.sourceLoc, r.targetLoc, r.reason])).toEqual([
      ['pas:010:01', 'pas:030', 'PLACEHOLDER'],
    ]);
  });
});

describe('renumberSpec (#1449)', () => {
  const renumber = (dryRun?: boolean, fromLoc = 'pas:010', toLoc = 'pas:040') =>
    specCorpusRenumberMutations.renumberSpec(null, { memoryRef: draft.id, fromLoc, toLoc, ...(dryRun !== undefined ? { dryRun } : {}) }, as());

  it('mirrors the moved subtree once, after its own references have been rewritten (#1478)', async () => {
    vi.mocked(mirrorNodeMoveToGit).mockClear();
    let mirroredContent: string | null | undefined;
    vi.mocked(mirrorNodeMoveToGit).mockImplementationOnce(async () => {
      mirroredContent = (await db.node.findUniqueOrThrow({ where: { id: feature.id } })).content;
    });
    await renumber();
    await vi.waitFor(() => expect(mirroredContent).toContain(`hrn:node:${draft.urn}:pas:040:01`));
    expect(mirrorNodeMoveToGit).toHaveBeenCalledTimes(1);
  });

  it('still schedules the move mirror when the post-move corpus reload fails', async () => {
    let moved = false;
    const failingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'node') {
          const node = Reflect.get(target, prop, receiver) as typeof db.node;
          return new Proxy(node, {
            get(t, p, r) {
              if (p === 'findMany' && moved) return () => { throw new Error('post-move reload failed'); };
              return Reflect.get(t, p, r);
            },
          });
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const spy = vi.spyOn(nodeMoveOps, 'moveWithResult').mockImplementationOnce(async (...args) => {
      spy.mockRestore();
      const result = await nodeMoveOps.moveWithResult(...args);
      moved = true;
      return result;
    });
    vi.mocked(mirrorNodeMoveToGit).mockClear();
    await expect(specCorpusRenumberMutations.renumberSpec(
      null, { memoryRef: draft.id, fromLoc: 'pas:010', toLoc: 'pas:040' }, { ...as(), db: failingDb },
    )).rejects.toThrow('post-move reload failed');
    expect((await db.node.findUniqueOrThrow({ where: { id: feature.id } })).loc).toBe('pas:040');
    expect(mirrorNodeMoveToGit).toHaveBeenCalledTimes(1);
  });

  it('dry run: returns the plan and writes nothing', async () => {
    const before = await content('pas:020');
    const plan = await renumber(true);
    expect(plan.dryRun).toBe(true);
    expect(plan.moved).toEqual([{ fromLoc: 'pas:010', toLoc: 'pas:040' }, { fromLoc: 'pas:010:01', toLoc: 'pas:040:01' }]);
    expect(plan.rewrites.map((r) => [r.loc, r.count, r.status])).toEqual(
      expect.arrayContaining([['pas:010', 1, 'PLANNED'], ['pas:020', 1, 'PLANNED']]),
    );
    expect(plan.rewrites).toHaveLength(2);
    expect(await content('pas:020')).toBe(before);
    expect(await db.node.count({ where: { memoryId: draft.id, loc: 'pas:010', deletedAt: null } })).toBe(1);
  });

  it('moves the subtree without aliases, rewrites every URN reference as a revisioned edit, and reports bare-text citations', async () => {
    const revBefore = (await db.node.findUniqueOrThrow({ where: { id: other.id } })).revSeq;
    const result = await renumber();

    expect(result.rewrites.map((r) => [r.loc, r.status])).toEqual(
      expect.arrayContaining([['pas:040', 'REWRITTEN'], ['pas:020', 'REWRITTEN']]),
    );
    expect((await db.node.findUniqueOrThrow({ where: { id: feature.id } })).loc).toBe('pas:040');
    expect((await db.node.findUniqueOrThrow({ where: { id: rule.id } })).loc).toBe('pas:040:01');
    expect(await db.urnAlias.count({ where: { entityType: 'NODE', entityId: { in: [feature.id, rule.id] } } })).toBe(0);

    // The URN inside each href is rewritten; the label and anything else is left alone.
    expect(await content('pas:020')).toContain(`[Vacation [pas:010]](https://hadronmemory.com/app/u/hrn:node:${draft.urn}:pas:040)`);
    expect(await content('pas:020')).toContain(`hrn:node:${draft.urn}:pas:099`);
    expect(await content('pas:040')).toContain(`hrn:node:${draft.urn}:pas:040:01)`);
    expect((await db.node.findUniqueOrThrow({ where: { id: other.id } })).revSeq).toBeGreaterThan(revBefore);

    // Stale labels and names are reported with their location, not rewritten.
    const cites = result.textCitations.map((c) => [c.sourceLoc, c.field, c.citation]);
    expect(cites).toEqual(expect.arrayContaining([
      ['pas:040', 'name', 'pas:010'],
      ['pas:040', 'content', 'pas:010:01'],
      ['pas:040:01', 'name', 'pas:010:01'],
      ['pas:020', 'content', 'pas:010'],
    ]));

    // Nothing the renumber moved is left unresolved.
    const unresolved = await resolvers.Query.specUnresolvedReferences(null, { memoryRef: draft.id }, as());
    expect(unresolved.map((r) => r.targetLoc).sort()).toEqual(['pas:030', 'pas:099']);
  });

  it('refuses an occupied destination, the spec\'s own subtree, and a minted node in the subtree, writing nothing', async () => {
    expect(await codeOf(renumber(false, 'pas:010', 'pas:020'))).toBe('NodeLocConflictError');
    expect(await codeOf(renumber(false, 'pas:010', 'pas:010:02'))).toBe('BAD_USER_INPUT');
    // #1591: draft rights are per node, so one minted descendant refuses the whole renumber.
    await db.node.updateMany({ where: { memoryId: draft.id, loc: 'pas:010:01' }, data: { mintedAt: new Date(), mintedByInfo: 'test' } });
    // A dry run refuses exactly as the real run does (Atilla, PR #1593).
    expect(await codeOf(renumber(true, 'pas:010', 'pas:040'))).toBe('NODE_MINTED');
    expect(await codeOf(renumber(false, 'pas:010', 'pas:040'))).toBe('NODE_MINTED');
    expect((await db.node.findUniqueOrThrow({ where: { id: feature.id } })).loc).toBe('pas:010');
    expect(await db.node.count({ where: { memoryId: draft.id, loc: { startsWith: 'pas:040' } } })).toBe(0);
  });

  it('does not let a reader renumber', async () => {
    const reader = await db.user.create({ data: { githubId: 145103, githubUsername: 'refs-reader', roles: [] } });
    await db.orgMember.create({ data: { organizationId: org.id, userId: reader.id, role: 'READER' } });
    // A dry run only reads, so a reader may plan one; the real run needs write access.
    expect(await codeOf(specCorpusRenumberMutations.renumberSpec(null, { memoryRef: draft.id, fromLoc: 'pas:010', toLoc: 'pas:040', dryRun: true }, as(reader.id))))
      .toBe('NO_ERROR');
    const code = await codeOf(specCorpusRenumberMutations.renumberSpec(null, { memoryRef: draft.id, fromLoc: 'pas:010', toLoc: 'pas:040' }, as(reader.id)));
    expect(code).not.toBe('NO_ERROR');
    expect((await db.node.findUniqueOrThrow({ where: { id: feature.id } })).loc).toBe('pas:010');
  });

  it('allows a renumber next to an unrelated node under toLoc, and an upward renumber (@codex P2)', async () => {
    const notes = await spec('pas:040:notes', 'Notes', 'Unrelated.');
    await renumber(false, 'pas:010', 'pas:040');
    expect((await db.node.findUniqueOrThrow({ where: { id: feature.id } })).loc).toBe('pas:040');
    expect((await db.node.findUniqueOrThrow({ where: { id: notes.id } })).loc).toBe('pas:040:notes');

    // pas:060:01 exists with no pas:060 node: moving it up to pas:060 is valid
    // even though the source sits beneath the target.
    const orphan = await spec('pas:060:01', 'Orphan rule', 'Body.');
    await renumber(false, 'pas:060:01', 'pas:060');
    expect((await db.node.findUniqueOrThrow({ where: { id: orphan.id } })).loc).toBe('pas:060');
  });

  it('refuses a destination held by a soft-deleted node, even in a dry run', async () => {
    const gone = await spec('pas:070', 'Gone', 'x');
    await db.node.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
    expect(await codeOf(renumber(true, 'pas:010', 'pas:070'))).toBe('NodeLocConflictError');
  });
});

describe('deleted edges are not references (@codex P2 on #1453)', () => {
  it('drops a soft-deleted edge from backlinks and unresolved', async () => {
    await db.edge.updateMany({ where: { sourceId: other.id, targetId: feature.id }, data: { deletedAt: new Date() } });
    const refs = await resolvers.Query.specBacklinks(null, { memoryRef: draft.id, loc: 'pas:010' }, as());
    expect(refs.map((r) => r.kind)).toEqual(['URN']);

    const placeholder = await db.node.findFirstOrThrow({ where: { memoryId: draft.id, loc: 'pas:030' } });
    await db.edge.create({ data: {
      memoryId: draft.id, sourceId: rule.id, targetId: placeholder.id, loc: 'pas:010:01:see:pas:030', name: 'see', deletedAt: new Date(),
    } });
    const unresolved = await resolvers.Query.specUnresolvedReferences(null, { memoryRef: draft.id }, as());
    expect(unresolved.filter((r) => r.kind === 'EDGE')).toEqual([]);
  });
});

describe('former URNs use live-address precedence (@codex P2 on #1453)', () => {
  it('does not claim a corpus row when a hidden current holder owns the former published address', async () => {
    const formerUrn = draft.urn;
    await resolvers.Mutation.updateMemory(null, { id: draft.id, urn: 'specs-draft-renamed' } as never, as());
    const holder = await db.memory.create({ data: {
      id: generateId(), urn: formerUrn, name: 'Private published holder',
      class: 'private', organizationId: org.id, userId: outsider.id,
    } });
    await db.node.update({ where: { id: other.id }, data: {
      content: `Published: hrn:node:${formerUrn}:pas:010.`,
    } });
    const beforeBacklinks = await resolvers.Query.specBacklinks(null, { memoryRef: draft.id, loc: 'pas:010' }, as());
    const beforePlan = await specCorpusRenumberMutations.renumberSpec(
      null, { memoryRef: draft.id, fromLoc: 'pas:010', toLoc: 'pas:040', dryRun: true }, as(),
    );
    const hiddenNode = await db.node.create({ data: {
      id: generateId(), memoryId: holder.id, loc: 'pas:010', name: 'Private published node',
    } });

    await expect(resolveNodeRefForCaller(as(), `hrn:node:${formerUrn}:pas:010`))
      .resolves.toEqual({ id: hiddenNode.id });
    const backlinks = await resolvers.Query.specBacklinks(null, { memoryRef: draft.id, loc: 'pas:010' }, as());
    expect(backlinks).toEqual(beforeBacklinks);
    expect(backlinks.filter((ref) => ref.kind === 'URN' && ref.sourceLoc === 'pas:020')).toEqual([]);
    const plan = await specCorpusRenumberMutations.renumberSpec(
      null, { memoryRef: draft.id, fromLoc: 'pas:010', toLoc: 'pas:040', dryRun: true }, as(),
    );
    expect(plan.rewrites).toEqual(beforePlan.rewrites);
    expect(plan.rewrites.filter((row) => row.nodeId === other.id)).toEqual([]);
  });

  it('does not rewrite an unconfirmed former-name descendant even when a hidden holder owns it', async () => {
    const formerUrn = draft.urn;
    await resolvers.Mutation.updateMemory(null, { id: draft.id, urn: 'specs-draft-renamed' } as never, as());
    const holder = await db.memory.create({ data: {
      id: generateId(), urn: formerUrn, name: 'Private published holder',
      class: 'private', organizationId: org.id, userId: outsider.id,
    } });
    const citation = `hrn:node:${formerUrn}:pas:010:99`;
    await db.node.update({ where: { id: other.id }, data: { content: `Foreign: ${citation}.` } });
    const args = { memoryRef: draft.id, fromLoc: 'pas:010', toLoc: 'pas:040', dryRun: true };
    const without = await specCorpusRenumberMutations.renumberSpec(null, args, as());
    const hiddenNode = await db.node.create({ data: {
      id: generateId(), memoryId: holder.id, loc: 'pas:010:99', name: 'Private published child',
    } });
    await expect(resolveNodeRefForCaller(as(), citation)).resolves.toEqual({ id: hiddenNode.id });
    const withNode = await specCorpusRenumberMutations.renumberSpec(null, args, as());
    expect(withNode.rewrites).toEqual(without.rewrites);
    expect(withNode.rewrites.filter((row) => row.nodeId === other.id)).toEqual([]);

    await specCorpusRenumberMutations.renumberSpec(null, { ...args, dryRun: false }, as());
    expect(await content('pas:020')).toBe(`Foreign: ${citation}.`);
  });

  it('leaves a reference through a reused former URN to the memory that now holds it, and still counts one it cannot resolve there', async () => {
    const oldUrn = draft.urn;
    await resolvers.Mutation.updateMemory(null, { id: draft.id, urn: 'specs-draft-renamed' } as never, as());
    const newUrn = (await db.memory.findUniqueOrThrow({ where: { id: draft.id } })).urn;
    // Another memory now holds the old URN, with its own live pas:010.
    const squatter = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'specs-draft' }, as());
    expect(squatter.urn).toBe(oldUrn);
    await db.node.create({ data: { id: generateId(), memoryId: squatter.id, loc: 'pas:010', name: 'Theirs' } });

    await db.node.update({ where: { id: other.id }, data: {
      content: `Theirs: hrn:node:${oldUrn}:pas:010. Ours via the old name: hrn:node:${oldUrn}:pas:010:01.`,
    } });

    const toFeature = await resolvers.Query.specBacklinks(null, { memoryRef: draft.id, loc: 'pas:010' }, as());
    expect(toFeature.filter((r) => r.kind === 'URN' && r.sourceLoc === 'pas:020')).toEqual([]);
    const toRule = await resolvers.Query.specBacklinks(null, { memoryRef: draft.id, loc: 'pas:010:01' }, as());
    expect(toRule.map((r) => r.sourceLoc).sort()).toEqual(['pas:010', 'pas:020']);

    const res = await specCorpusRenumberMutations.renumberSpec(null, { memoryRef: draft.id, fromLoc: 'pas:010', toLoc: 'pas:040' }, as());
    // pas:020 was edited with a raw write above (unrevisioned drift); the
    // rewrite must still land rather than conflict on every retry.
    expect(res.rewrites.find((r) => r.loc === 'pas:020')).toMatchObject({ status: 'REWRITTEN', count: 1 });
    const after = await content('pas:020');
    expect(after).toContain(`hrn:node:${oldUrn}:pas:010.`);      // the squatter's node: untouched
    expect(after).toContain(`hrn:node:${newUrn}:pas:040:01`);    // ours: canonical current memory
    expect(newUrn).not.toBe(oldUrn);
  });

  it('keeps a former-URN alias whose live target moved into this corpus', async () => {
    const formerUrn = draft.urn;
    await resolvers.Mutation.updateMemory(null, { id: draft.id, urn: 'specs-draft-renamed' } as never, as());
    const newUrn = (await db.memory.findUniqueOrThrow({ where: { id: draft.id } })).urn;
    const squatter = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'specs-draft' }, as());
    expect(squatter.urn).toBe(formerUrn);
    // The former holder no longer has the address; its NODE alias resolves to
    // this corpus's live spec at the cited loc.
    await db.urnAlias.create({ data: {
      urn: `${formerUrn}:pas:010`, entityType: 'NODE', entityId: feature.id, reason: 'RENAME',
    } });
    await db.node.update({ where: { id: other.id }, data: {
      content: `Ours through the alias: hrn:node:${formerUrn}:pas:010.`,
    } });

    const backlinks = await resolvers.Query.specBacklinks(null, { memoryRef: draft.id, loc: 'pas:010' }, as());
    expect(backlinks.some((ref) => ref.kind === 'URN' && ref.sourceLoc === 'pas:020')).toBe(true);
    const result = await specCorpusRenumberMutations.renumberSpec(
      null, { memoryRef: draft.id, fromLoc: 'pas:010', toLoc: 'pas:040' }, as(),
    );
    expect(result.rewrites.find((row) => row.nodeId === other.id)).toMatchObject({ status: 'REWRITTEN', count: 1 });
    expect(await content('pas:020')).toContain(`hrn:node:${newUrn}:pas:040`);
  });

  it('rewrites a former-URN alias to the corpus current URN when the published destination is occupied', async () => {
    const formerUrn = draft.urn;
    await resolvers.Mutation.updateMemory(null, { id: draft.id, urn: 'specs-draft-renamed' } as never, as());
    const currentUrn = (await db.memory.findUniqueOrThrow({ where: { id: draft.id } })).urn;
    const holder = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'specs-draft' }, as());
    const occupant = await db.node.create({ data: {
      id: generateId(), memoryId: holder.id, loc: 'pas:040', name: 'Published destination occupant',
    } });
    await db.urnAlias.create({ data: {
      urn: `${formerUrn}:pas:500`, entityType: 'NODE', entityId: feature.id, reason: 'RENAME',
    } });
    await db.node.update({ where: { id: other.id }, data: {
      content: `Alias: hrn:node:${formerUrn}:pas:500.`,
    } });

    const result = await specCorpusRenumberMutations.renumberSpec(
      null, { memoryRef: draft.id, fromLoc: 'pas:010', toLoc: 'pas:040' }, as(),
    );
    expect(result.rewrites.find((row) => row.nodeId === other.id)).toMatchObject({ status: 'REWRITTEN', count: 1 });
    expect(await content('pas:020')).toContain(`hrn:node:${currentUrn}:pas:040`);
    await expect(resolveNodeRefForCaller(as(), `hrn:node:${currentUrn}:pas:040`)).resolves.toEqual({ id: feature.id });
    await expect(resolveNodeRefForCaller(as(), `hrn:node:${formerUrn}:pas:040`)).resolves.toEqual({ id: occupant.id });
  });

  it('uses the target loc when a former-URN alias reaches this corpus at a different loc', async () => {
    const formerUrn = draft.urn;
    await resolvers.Mutation.updateMemory(null, { id: draft.id, urn: 'specs-draft-renamed' } as never, as());
    const newUrn = (await db.memory.findUniqueOrThrow({ where: { id: draft.id } })).urn;
    const squatter = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'specs-draft' }, as());
    expect(squatter.urn).toBe(formerUrn);
    await db.urnAlias.create({ data: {
      urn: `${formerUrn}:pas:500`, entityType: 'NODE', entityId: feature.id, reason: 'RENAME',
    } });
    await db.node.update({ where: { id: other.id }, data: {
      content: `Alias: hrn:node:${formerUrn}:pas:500.`,
    } });

    const unresolved = await resolvers.Query.specUnresolvedReferences(null, { memoryRef: draft.id }, as());
    expect(unresolved.map((ref) => ref.targetLoc)).not.toContain('pas:500');
    const backlinks = await resolvers.Query.specBacklinks(null, { memoryRef: draft.id, loc: 'pas:010' }, as());
    expect(backlinks.some((ref) => ref.kind === 'URN' && ref.sourceLoc === 'pas:020' && ref.targetLoc === 'pas:500')).toBe(true);

    const result = await specCorpusRenumberMutations.renumberSpec(
      null, { memoryRef: draft.id, fromLoc: 'pas:010', toLoc: 'pas:040' }, as(),
    );
    expect(result.rewrites.find((row) => row.nodeId === other.id)).toMatchObject({ status: 'REWRITTEN', count: 1 });
    expect(await content('pas:020')).toContain(`hrn:node:${newUrn}:pas:040`);
  });

  it('does not choose arbitrarily among multiple live aliases for one former address', async () => {
    const formerUrn = draft.urn;
    await resolvers.Mutation.updateMemory(null, { id: draft.id, urn: 'specs-draft-renamed' } as never, as());
    const squatter = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'specs-draft' }, as());
    const address = `${formerUrn}:pas:500`;
    await db.urnAlias.createMany({ data: [feature.id, rule.id].map((entityId) => ({
      urn: address, entityType: 'NODE' as const, entityId, reason: 'RENAME' as const,
    })) });
    await db.node.update({ where: { id: other.id }, data: { content: `Ambiguous: hrn:node:${address}.` } });

    const noAliasBacklink = async () => {
      const refs = await resolvers.Query.specBacklinks(null, { memoryRef: draft.id, loc: 'pas:010' }, as());
      return refs.filter((ref) => ref.kind === 'URN' && ref.sourceLoc === 'pas:020');
    };
    const noAliasRewrite = async () => {
      const plan = await specCorpusRenumberMutations.renumberSpec(
        null, { memoryRef: draft.id, fromLoc: 'pas:010', toLoc: 'pas:040', dryRun: true }, as(),
      );
      return plan.rewrites.filter((row) => row.nodeId === other.id);
    };
    expect(await noAliasBacklink()).toEqual([]);
    expect(await noAliasRewrite()).toEqual([]);

    // A readable foreign target also makes the same address ambiguous.
    const foreign = await db.node.create({ data: {
      id: generateId(), memoryId: squatter.id, loc: 'pas:900', name: 'Foreign target',
    } });
    await db.urnAlias.delete({ where: {
      urn_entityType_entityId: { urn: address, entityType: 'NODE', entityId: rule.id },
    } });
    await db.urnAlias.create({ data: { urn: address, entityType: 'NODE', entityId: foreign.id, reason: 'RENAME' } });
    expect(await noAliasBacklink()).toEqual([]);
    expect(await noAliasRewrite()).toEqual([]);
  });

  it('finds a former holder’s moved-node alias under that holder’s current memory URN', async () => {
    const formerUrn = draft.urn;
    await resolvers.Mutation.updateMemory(null, { id: draft.id, urn: 'specs-draft-renamed' } as never, as());
    const holder = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'specs-draft' }, as());
    expect(holder.urn).toBe(formerUrn);
    await resolvers.Mutation.updateMemory(null, { id: holder.id, urn: 'former-holder-renamed' } as never, as());
    const holderUrn = (await db.memory.findUniqueOrThrow({ where: { id: holder.id } })).urn;
    const foreign = await db.node.create({ data: {
      id: generateId(), memoryId: holder.id, loc: 'pas:900', name: 'Moved foreign node',
    } });
    await db.urnAlias.createMany({ data: ['pas:010', 'pas:500'].map((loc) => ({
      urn: `${holderUrn}:${loc}`, entityType: 'NODE' as const, entityId: foreign.id, reason: 'RENAME' as const,
    })) });
    await db.node.update({ where: { id: other.id }, data: {
      content: `Ambiguous: hrn:node:${formerUrn}:pas:010. Foreign: hrn:node:${formerUrn}:pas:500.`,
    } });

    const backlinks = await resolvers.Query.specBacklinks(null, { memoryRef: draft.id, loc: 'pas:010' }, as());
    expect(backlinks.filter((ref) => ref.kind === 'URN' && ref.sourceLoc === 'pas:020')).toEqual([]);
    const unresolved = await resolvers.Query.specUnresolvedReferences(null, { memoryRef: draft.id }, as());
    expect(unresolved.map((ref) => ref.targetLoc)).not.toContain('pas:500');
    const plan = await specCorpusRenumberMutations.renumberSpec(
      null, { memoryRef: draft.id, fromLoc: 'pas:010', toLoc: 'pas:040', dryRun: true }, as(),
    );
    expect(plan.rewrites.filter((row) => row.nodeId === other.id)).toEqual([]);
  });

  it('uses a deleted historical holder only to translate a live moved-node alias', async () => {
    const formerUrn = draft.urn;
    await resolvers.Mutation.updateMemory(null, { id: draft.id, urn: 'specs-draft-renamed' } as never, as());
    const holder = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'specs-draft' }, as());
    await resolvers.Mutation.updateMemory(null, { id: holder.id, urn: 'deleted-holder-renamed' } as never, as());
    const holderUrn = (await db.memory.findUniqueOrThrow({ where: { id: holder.id } })).urn;
    const foreign = await db.node.create({ data: {
      id: generateId(), memoryId: minted.id, loc: 'pas:900', name: 'Moved into readable memory',
    } });
    await db.urnAlias.create({ data: {
      urn: `${holderUrn}:pas:500`, entityType: 'NODE', entityId: foreign.id, reason: 'RENAME',
    } });
    await db.memory.update({ where: { id: holder.id }, data: { deletedAt: new Date() } });
    await db.node.update({ where: { id: other.id }, data: {
      content: `Foreign: hrn:node:${formerUrn}:pas:500.`,
    } });

    await expect(resolveNodeRefForCaller(as(), `hrn:node:${formerUrn}:pas:500`)).resolves.toEqual({ id: foreign.id });
    const unresolved = await resolvers.Query.specUnresolvedReferences(null, { memoryRef: draft.id }, as());
    expect(unresolved.map((ref) => ref.targetLoc)).not.toContain('pas:500');
    const backlinks = await resolvers.Query.specBacklinks(null, { memoryRef: draft.id, loc: 'pas:500' }, as());
    expect(backlinks.filter((ref) => ref.kind === 'URN' && ref.sourceLoc === 'pas:020')).toEqual([]);
  });

  it('does not select a readable corpus alias over a hidden live alias at the same address', async () => {
    const formerUrn = draft.urn;
    await resolvers.Mutation.updateMemory(null, { id: draft.id, urn: 'specs-draft-renamed' } as never, as());
    const hidden = await db.memory.create({ data: {
      id: generateId(), urn: `${org.urn}:hidden-alias-holder`, name: 'Hidden alias holder',
      class: 'private', organizationId: org.id, userId: outsider.id,
    } });
    const hiddenNode = await db.node.create({ data: {
      id: generateId(), memoryId: hidden.id, loc: 'pas:900', name: 'Hidden target',
    } });
    await db.urnAlias.createMany({ data: [feature.id, hiddenNode.id].map((entityId) => ({
      urn: `${formerUrn}:pas:010`, entityType: 'NODE' as const, entityId, reason: 'RENAME' as const,
    })) });
    await db.node.update({ where: { id: other.id }, data: {
      content: `Ambiguous: hrn:node:${formerUrn}:pas:010.`,
    } });

    await expect(resolveNodeRefForCaller(as(), `hrn:node:${formerUrn}:pas:010`))
      .rejects.toMatchObject({ name: 'AmbiguousLegacyUrnError' });
    const backlinks = await resolvers.Query.specBacklinks(null, { memoryRef: draft.id, loc: 'pas:010' }, as());
    expect(backlinks.filter((ref) => ref.kind === 'URN' && ref.sourceLoc === 'pas:020')).toEqual([]);
    const plan = await specCorpusRenumberMutations.renumberSpec(
      null, { memoryRef: draft.id, fromLoc: 'pas:010', toLoc: 'pas:040', dryRun: true }, as(),
    );
    expect(plan.rewrites.filter((row) => row.nodeId === other.id)).toEqual([]);

    // The corpus's historical live row is itself a resolver candidate. Even
    // without a corpus NODE alias, the hidden alias makes this address
    // ambiguous to a caller who can read that corpus row.
    await db.urnAlias.delete({ where: {
      urn_entityType_entityId: { urn: `${formerUrn}:pas:010`, entityType: 'NODE', entityId: feature.id },
    } });
    await expect(resolveNodeRefForCaller(as(), `hrn:node:${formerUrn}:pas:010`))
      .rejects.toMatchObject({ name: 'AmbiguousLegacyUrnError' });
    const stillAmbiguous = await resolvers.Query.specBacklinks(null, { memoryRef: draft.id, loc: 'pas:010' }, as());
    expect(stillAmbiguous.filter((ref) => ref.kind === 'URN' && ref.sourceLoc === 'pas:020')).toEqual([]);
    const stillNoRewrite = await specCorpusRenumberMutations.renumberSpec(
      null, { memoryRef: draft.id, fromLoc: 'pas:010', toLoc: 'pas:040', dryRun: true }, as(),
    );
    expect(stillNoRewrite.rewrites.filter((row) => row.nodeId === other.id)).toEqual([]);
  });
});

describe('renumber moves by address, atomically (@codex P2 on #1453)', () => {
  it('refuses, and rewrites nothing, when the spec was moved after the scan', async () => {
    const before = await content('pas:020');
    const spy = vi.spyOn(nodeMoveOps, 'moveWithResult').mockImplementationOnce(async (...args) => {
      // A concurrent request moves the spec away between the scan and the move.
      await db.node.update({ where: { id: feature.id }, data: { loc: 'pas:777' } });
      await db.node.update({ where: { id: rule.id }, data: { loc: 'pas:777:01' } });
      spy.mockRestore();
      return nodeMoveOps.moveWithResult(...args);
    });
    expect(await codeOf(specCorpusRenumberMutations.renumberSpec(null, { memoryRef: draft.id, fromLoc: 'pas:010', toLoc: 'pas:040' }, as())))
      .not.toBe('NO_ERROR');
    expect((await db.node.findUniqueOrThrow({ where: { id: feature.id } })).loc).toBe('pas:777');
    expect(await content('pas:020')).toBe(before);
  });
});

describe('renumber reports what it actually wrote (@codex P2 on #1453)', () => {
  it('marks a node UNCHANGED when a concurrent edit removed its references before the rewrite', async () => {
    let armed = false;
    let fired = false;
    // After the move completes, the next transaction (the first rewrite's
    // reconcile) first sees a concurrent edit strip pas:020's references.
    const racingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === '$transaction' && armed && !fired) {
          return async (...args: unknown[]) => {
            fired = true;
            await db.node.update({ where: { id: other.id }, data: { content: 'No references any more.' } });
            return (target.$transaction as (...a: unknown[]) => unknown)(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const spy = vi.spyOn(nodeMoveOps, 'moveWithResult').mockImplementationOnce(async (...args) => {
      spy.mockRestore();
      const out = await nodeMoveOps.moveWithResult(...args);
      armed = true;
      return out;
    });
    const res = await specCorpusRenumberMutations.renumberSpec(
      null, { memoryRef: draft.id, fromLoc: 'pas:010', toLoc: 'pas:040' }, { ...as(), db: racingDb },
    );
    expect(fired).toBe(true);
    expect(res.rewrites.find((r) => r.loc === 'pas:020')).toMatchObject({ status: 'UNCHANGED', count: 0, fields: [] });
    expect(res.rewrites.find((r) => r.loc === 'pas:040')).toMatchObject({ status: 'REWRITTEN', count: 1 });
    expect(await content('pas:020')).toBe('No references any more.');
  });
});

describe('historical alias claimants make a reference ambiguous (@codex P2 on #1453)', () => {
  it('does not claim a former URN reference when another live memory also held that URN and has the cited loc', async () => {
    // Another memory held "corpus.example:shared" first and was renamed away.
    const otherMem = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'shared' }, as());
    const shared = otherMem.urn;
    await resolvers.Mutation.updateMemory(null, { id: otherMem.id, urn: 'someone-else' } as never, as());
    await db.node.create({ data: { id: generateId(), memoryId: otherMem.id, loc: 'pas:010', name: 'Theirs' } });
    // Our corpus then held the same URN and was renamed away too.
    await resolvers.Mutation.updateMemory(null, { id: draft.id, urn: 'shared' } as never, as());
    await resolvers.Mutation.updateMemory(null, { id: draft.id, urn: 'specs-final' } as never, as());
    expect(await db.urnAlias.count({ where: { entityType: 'MEMORY', urn: shared } })).toBe(2);

    await db.node.update({ where: { id: other.id }, data: {
      content: `Ambiguous: hrn:node:${shared}:pas:010. Only ours: hrn:node:${shared}:pas:010:01.`,
    } });

    const toFeature = await resolvers.Query.specBacklinks(null, { memoryRef: draft.id, loc: 'pas:010' }, as());
    expect(toFeature.filter((r) => r.kind === 'URN' && r.sourceLoc === 'pas:020')).toEqual([]);
    const toRule = await resolvers.Query.specBacklinks(null, { memoryRef: draft.id, loc: 'pas:010:01' }, as());
    expect(toRule.map((r) => r.sourceLoc).sort()).toEqual(['pas:010', 'pas:020']);
  });
});

describe('renumber cost does not grow with the number of citing nodes (@codex P2 on #1453)', () => {
  it('reads the corpus a fixed number of times, not once per rewrite', async () => {
    for (let i = 0; i < 8; i++) {
      await spec(`pas:2${i}0`, `Citing ${i}`, `See hrn:node:${draft.urn}:pas:010 and ${link('Rule', 'pas:010:01')}.`);
    }
    let pageReads = 0;
    const countingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'node') {
          const node = Reflect.get(target, prop, receiver) as typeof db.node;
          return new Proxy(node, {
            get(t, p, r) {
              if (p === 'findMany') return (...a: Parameters<typeof db.node.findMany>) => { pageReads++; return t.findMany(...a); };
              return Reflect.get(t, p, r);
            },
          });
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const res = await specCorpusRenumberMutations.renumberSpec(
      null, { memoryRef: draft.id, fromLoc: 'pas:010', toLoc: 'pas:040' }, { ...as(), db: countingDb },
    );
    expect(res.rewrites.filter((r) => r.status === 'REWRITTEN').length).toBeGreaterThanOrEqual(9);
    // Corpus loads before and after the move plus a handful of fixed lookups;
    // a per-rewrite corpus reload would add one per citing node (9+).
    expect(pageReads).toBeLessThan(9);
  });
});

describe('renumber reports where each rewrite landed (@codex P2 on #1453)', () => {
  it('reports the reloaded loc when a citing node moved between the plan and its rewrite', async () => {
    let armed = false;
    let fired = false;
    const racingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === '$transaction' && armed && !fired) {
          return async (...args: unknown[]) => {
            fired = true;
            // A concurrent request moves the citing node within the corpus.
            await db.node.update({ where: { id: other.id }, data: { loc: 'pas:021' } });
            return (target.$transaction as (...a: unknown[]) => unknown)(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const spy = vi.spyOn(nodeMoveOps, 'moveWithResult').mockImplementationOnce(async (...args) => {
      spy.mockRestore();
      const out = await nodeMoveOps.moveWithResult(...args);
      armed = true;
      return out;
    });
    const res = await specCorpusRenumberMutations.renumberSpec(
      null, { memoryRef: draft.id, fromLoc: 'pas:010', toLoc: 'pas:040' }, { ...as(), db: racingDb },
    );
    expect(fired).toBe(true);
    expect(res.rewrites.find((r) => r.nodeId === other.id)).toMatchObject({ loc: 'pas:021', status: 'REWRITTEN' });
    // (@codex P2) the bare-text report is built from current rows too
    const cites = res.textCitations.filter((c) => c.sourceNodeId === other.id);
    expect(cites.length).toBeGreaterThan(0);
    expect(cites.every((c) => c.sourceLoc === 'pas:021')).toBe(true);
  });
});

describe('historical holders of the CURRENT corpus URN (@codex P2 on #1453)', () => {
  it('does not report a citation as missing when a prior holder of our URN has that loc, and keeps ours first', async () => {
    const prior = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'shared' }, as());
    const shared = prior.urn;
    await db.node.create({ data: { id: generateId(), memoryId: prior.id, loc: 'pas:500', name: 'Theirs only' } });
    await db.node.create({ data: { id: generateId(), memoryId: prior.id, loc: 'pas:010', name: 'Theirs too' } });
    await resolvers.Mutation.updateMemory(null, { id: prior.id, urn: 'renamed-away' } as never, as());
    await resolvers.Mutation.updateMemory(null, { id: draft.id, urn: 'shared' } as never, as());
    expect((await db.memory.findUniqueOrThrow({ where: { id: draft.id } })).urn).toBe(shared);

    await db.node.update({ where: { id: other.id }, data: {
      content: `Falls through: hrn:node:${shared}:pas:500. Ours first: hrn:node:${shared}:pas:010.`,
    } });

    const unresolved = await resolvers.Query.specUnresolvedReferences(null, { memoryRef: draft.id }, as());
    expect(unresolved.map((r) => r.targetLoc)).not.toContain('pas:500');
    const toFeature = await resolvers.Query.specBacklinks(null, { memoryRef: draft.id, loc: 'pas:010' }, as());
    expect(toFeature.some((r) => r.kind === 'URN' && r.sourceLoc === 'pas:020')).toBe(true);
  });
});

describe('an alias claimant the caller cannot read decides nothing (@codex P1 on #1453)', () => {
  /** A prior holder of the corpus's CURRENT urn, owned by someone else: org-anchored and private to `outsider`. */
  const unreadablePriorHolder = async () => {
    await db.orgMember.create({ data: { organizationId: org.id, userId: outsider.id, role: 'READER' } });
    const prior = await db.memory.create({ data: {
      id: generateId(), urn: `${org.urn}:outsiders-private`, name: 'outsiders-private', class: 'private',
      organizationId: org.id, userId: outsider.id,
    } });
    await db.urnAlias.create({ data: { urn: draft.urn, entityType: 'MEMORY', entityId: prior.id, reason: 'RENAME' } });
    return prior;
  };
  const cites500 = () => db.node.update({ where: { id: other.id }, data: { content: `Probe: hrn:node:${draft.urn}:pas:500.` } });
  const unresolvedLocs = async () =>
    (await resolvers.Query.specUnresolvedReferences(null, { memoryRef: draft.id }, as())).map((r) => r.targetLoc);

  it('reports the same thing whether or not the unreadable holder has the cited loc', async () => {
    const prior = await unreadablePriorHolder();
    await cites500();
    const without = await unresolvedLocs();
    await db.node.create({ data: { id: generateId(), memoryId: prior.id, loc: 'pas:500', name: 'Hidden' } });
    const withNode = await unresolvedLocs();

    expect(withNode).toEqual(without);
    expect(withNode).toContain('pas:500');
    const backlinks = await resolvers.Query.specBacklinks(null, { memoryRef: draft.id, loc: 'pas:500' }, as());
    expect(backlinks.map((r) => r.sourceLoc)).toEqual(['pas:020']);
  });

  it('CONTROL: a claimant the caller CAN read still takes the reference', async () => {
    const prior = await unreadablePriorHolder();
    await cites500();
    await db.node.create({ data: { id: generateId(), memoryId: prior.id, loc: 'pas:500', name: 'Theirs' } });
    const readableCtx: Context = { db, userId: outsider.id, roles: [] };
    await db.orgMember.updateMany({ where: { organizationId: org.id, userId: outsider.id }, data: { role: 'ADMIN' } });
    const unresolved = await resolvers.Query.specUnresolvedReferences(null, { memoryRef: draft.id }, readableCtx);
    expect(unresolved.map((r) => r.targetLoc)).not.toContain('pas:500');
  });

  it('follows a moved claimant node alias only when its target memory is readable (#1478)', async () => {
    const prior = await unreadablePriorHolder();
    await cites500();
    const moved = await db.node.create({ data: {
      id: generateId(), memoryId: prior.id, loc: 'pas:900', name: 'Moved foreign node',
    } });
    await db.urnAlias.create({ data: {
      urn: `${draft.urn}:pas:500`, entityType: 'NODE', entityId: moved.id, reason: 'RENAME',
    } });

    expect(await unresolvedLocs()).toContain('pas:500');
    expect((await resolvers.Query.specBacklinks(null, { memoryRef: draft.id, loc: 'pas:500' }, as())).map((r) => r.sourceLoc))
      .toEqual(['pas:020']);

    await db.orgMember.updateMany({ where: { organizationId: org.id, userId: outsider.id }, data: { role: 'ADMIN' } });
    const visible = await resolvers.Query.specUnresolvedReferences(null, { memoryRef: draft.id }, as(outsider.id));
    expect(visible.map((r) => r.targetLoc)).not.toContain('pas:500');
  });
});

describe('renumber decides reference ownership before the move (@codex P2 on #1453)', () => {
  it('rewrites our citations even when a prior holder of our URN also has the old loc', async () => {
    const prior = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'shared' }, as());
    const shared = prior.urn;
    await db.node.create({ data: { id: generateId(), memoryId: prior.id, loc: 'pas:010', name: 'Theirs too' } });
    await resolvers.Mutation.updateMemory(null, { id: prior.id, urn: 'renamed-away' } as never, as());
    await resolvers.Mutation.updateMemory(null, { id: draft.id, urn: 'shared' } as never, as());
    await db.node.update({ where: { id: other.id }, data: { content: `Ours: hrn:node:${shared}:pas:010.` } });

    const res = await specCorpusRenumberMutations.renumberSpec(null, { memoryRef: draft.id, fromLoc: 'pas:010', toLoc: 'pas:040' }, as());
    expect(res.rewrites).toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: other.id, status: 'REWRITTEN', count: 1 })]));
    expect((await db.node.findUniqueOrThrow({ where: { id: other.id } })).content).toBe(`Ours: hrn:node:${shared}:pas:040.`);
  });
});

describe('#1478 item 6 — a corpus stored with the canonical double-colon Memory URN', () => {
  const storeCanonicalUrn = async () => {
    const canonical = `${org.urn}::specs-draft`;
    await db.memory.update({ where: { id: draft.id }, data: { urn: canonical } });
    draft.urn = canonical;
    return canonical;
  };

  it('renumbers through the shared node URN shape and preserves both reference spellings', async () => {
    const canonical = await storeCanonicalUrn();
    const legacy = `${org.urn}:specs-draft`;
    await db.node.update({ where: { id: feature.id }, data: {
      content: `Rule: hrn:node:${canonical}::pas:010:01`,
    } });
    await db.node.update({ where: { id: other.id }, data: {
      content: `Canonical: hrn:node:${canonical}::pas:010. Legacy: hrn:node:${legacy}:pas:010.`,
    } });

    const result = await specCorpusRenumberMutations.renumberSpec(
      null, { memoryRef: draft.id, fromLoc: 'pas:010', toLoc: 'pas:040' }, as(),
    );
    expect(result.moved).toEqual([
      { fromLoc: 'pas:010', toLoc: 'pas:040' },
      { fromLoc: 'pas:010:01', toLoc: 'pas:040:01' },
    ]);
    expect(await content('pas:040')).toBe(`Rule: hrn:node:${canonical}::pas:040:01`);
    expect(await content('pas:020')).toBe(
      `Canonical: hrn:node:${canonical}::pas:040. Legacy: hrn:node:${legacy}:pas:040.`,
    );
  });

  it('lets a prior holder claim an absent loc under either spelling of the current URN', async () => {
    const canonical = await storeCanonicalUrn();
    const legacy = `${org.urn}:specs-draft`;
    const prior = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'prior-holder' }, as());
    const foreign = await db.node.create({ data: {
      id: generateId(), memoryId: prior.id, loc: 'pas:500', name: 'Prior holder spec',
    } });
    await db.urnAlias.create({ data: {
      urn: legacy, entityType: 'MEMORY', entityId: prior.id, reason: 'RENAME',
    } });
    await db.node.update({ where: { id: other.id }, data: {
      content: `Canonical: hrn:node:${canonical}::pas:500. Legacy: hrn:node:${legacy}:pas:500.`,
    } });

    expect(await resolveNodeRef(db, `hrn:node:${canonical}::pas:500`)).toEqual({ id: foreign.id });
    expect(await resolveNodeRef(db, `hrn:node:${legacy}:pas:500`)).toEqual({ id: foreign.id });
    const unresolved = await resolvers.Query.specUnresolvedReferences(null, { memoryRef: draft.id }, as());
    expect(unresolved.filter((r) => r.targetLoc === 'pas:500')).toEqual([]);
    expect(await resolvers.Query.specBacklinks(null, { memoryRef: draft.id, loc: 'pas:500' }, as())).toEqual([]);
  });
});

describe('renumber\'s minted check reads only this corpus (Atilla, PR #1593)', () => {
  it('never names a node\'s loc in another memory it moved into after the scan', async () => {
    const hidden = await db.memory.create({ data: {
      id: generateId(), urn: `${org.urn}:outsiders-private`, name: 'outsiders-private',
      class: 'private', organizationId: org.id, userId: outsider.id,
    } });
    // Move the rule (part of the moving set) into the unreadable memory, minted,
    // right after renumber's scan: its collision check is the next node read.
    let moved = false;
    const interleaved = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'node') return Reflect.get(target, prop, receiver);
        return new Proxy(target.node, {
          get(n, np, nr) {
            if (np !== 'findFirst') return Reflect.get(n, np, nr);
            return async (args: Parameters<typeof n.findFirst>[0]) => {
              if (!moved) {
                moved = true;
                await db.node.update({ where: { id: rule.id }, data: {
                  memoryId: hidden.id, loc: 'secret', mintedAt: new Date(), mintedByInfo: 'test',
                } });
              }
              return n.findFirst(args);
            };
          },
        });
      },
    }) as typeof db;
    const outcome = await specCorpusRenumberMutations.renumberSpec(
      null, { memoryRef: draft.id, fromLoc: 'pas:010', toLoc: 'pas:040', dryRun: true },
      { db: interleaved, userId: admin.id, roles: [] },
    ).then((r) => JSON.stringify(r), (e: unknown) => JSON.stringify({ message: (e as Error).message, ext: (e as GraphQLError).extensions }));
    expect(moved).toBe(true);
    expect(outcome).not.toContain('secret');
  });
});

describe('renumber re-decides draft state under the move\'s lock (@codex P1 on #1453)', () => {
  it('refuses, moving nothing, when the spec is minted between the check and the move', async () => {
    const spy = vi.spyOn(nodeMoveOps, 'moveWithResult').mockImplementationOnce(async (...args) => {
      spy.mockRestore();
      // A mint that commits after renumber's own scan, before the move's locks (#1591: per node).
      await db.node.update({ where: { id: feature.id }, data: { mintedAt: new Date(), mintedByInfo: 'test' } });
      return nodeMoveOps.moveWithResult(...args);
    });
    expect(await codeOf(specCorpusRenumberMutations.renumberSpec(null, { memoryRef: draft.id, fromLoc: 'pas:010', toLoc: 'pas:040' }, as())))
      .toBe('NODE_MINTED');
    expect(await db.node.findUniqueOrThrow({ where: { id: feature.id } })).toMatchObject({ loc: 'pas:010' });
    expect(await db.node.count({ where: { memoryId: draft.id, loc: { startsWith: 'pas:040' } } })).toBe(0);
  });
});

describe('renumber moves only the scanned node (@codex P2 on #1453)', () => {
  it('refuses, moving nothing, when the source left fromLoc and a former holder of our URN has that loc', async () => {
    const prior = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'shared', draftCorpus: true }, as());
    const theirs = await db.node.create({ data: { id: generateId(), memoryId: prior.id, loc: 'pas:010', name: 'Theirs', role: 'spec', nodeType: 'info', tags: ['spec'], content: 'Theirs.' } });
    await resolvers.Mutation.updateMemory(null, { id: prior.id, urn: 'renamed-away' } as never, as());
    await resolvers.Mutation.updateMemory(null, { id: draft.id, urn: 'shared' } as never, as());

    const spy = vi.spyOn(nodeMoveOps, 'moveWithResult').mockImplementationOnce(async (...args) => {
      spy.mockRestore();
      // Another request moves our scanned spec away just before the move.
      await db.node.update({ where: { id: feature.id }, data: { loc: 'pas:011' } });
      return nodeMoveOps.moveWithResult(...args);
    });
    expect(await codeOf(specCorpusRenumberMutations.renumberSpec(null, { memoryRef: draft.id, fromLoc: 'pas:010', toLoc: 'pas:040' }, as())))
      .toBe('CONFLICT');
    expect(await db.node.findUniqueOrThrow({ where: { id: theirs.id } })).toMatchObject({ memoryId: prior.id, loc: 'pas:010' });
    expect(await db.node.count({ where: { memoryId: draft.id, loc: { startsWith: 'pas:040' } } })).toBe(0);
  });
});

describe('renumber reports exactly what the mover moved (@codex P2 on #1453)', () => {
  it('does not report a node created under toLoc right after the move', async () => {
    const spy = vi.spyOn(nodeMoveOps, 'moveWithResult').mockImplementationOnce(async (...args) => {
      spy.mockRestore();
      const out = await nodeMoveOps.moveWithResult(...args);
      // A concurrent request creates an unrelated node under the new number.
      await spec('pas:040:99', 'Unrelated newcomer', 'x');
      return out;
    });
    const res = await specCorpusRenumberMutations.renumberSpec(null, { memoryRef: draft.id, fromLoc: 'pas:010', toLoc: 'pas:040' }, as());
    expect(res.moved).toEqual([{ fromLoc: 'pas:010', toLoc: 'pas:040' }, { fromLoc: 'pas:010:01', toLoc: 'pas:040:01' }]);
  });

  it('does not rewrite a node created at the freed citation after the move (#1478)', async () => {
    let newcomerId = '';
    const original = `hrn:node:${draft.urn}:pas:010`;
    const spy = vi.spyOn(nodeMoveOps, 'moveWithResult').mockImplementationOnce(async (...args) => {
      spy.mockRestore();
      const out = await nodeMoveOps.moveWithResult(...args);
      newcomerId = (await spec('pas:010', 'New claimant', original)).id;
      return out;
    });
    const res = await specCorpusRenumberMutations.renumberSpec(null, {
      memoryRef: draft.id, fromLoc: 'pas:010', toLoc: 'pas:040',
    }, as());
    expect(res.rewrites.some((row) => row.nodeId === newcomerId)).toBe(false);
    expect(await db.node.findUniqueOrThrow({ where: { id: newcomerId } })).toMatchObject({ content: original });
  });
});

describe('an ambiguous citation blocks the mint as MISSING (#1505)', () => {
  /** Rename the draft away and let a new memory take its former URN; return that former URN and the squatter. */
  const vacateFormerUrn = async () => {
    const formerUrn = draft.urn;
    await resolvers.Mutation.updateMemory(null, { id: draft.id, urn: 'specs-draft-renamed' } as never, as());
    const squatter = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'specs-draft' }, as());
    expect(squatter.urn).toBe(formerUrn);
    return { formerUrn, squatter };
  };
  const cite = (address: string) => db.node.update({ where: { id: other.id }, data: { content: `Cites hrn:node:${address}.` } });
  const unresolvedAt = async (targetLoc: string, userId = admin.id) =>
    (await resolvers.Query.specUnresolvedReferences(null, { memoryRef: draft.id }, as(userId)))
      .filter((r) => r.sourceLoc === 'pas:020' && r.targetLoc === targetLoc);
  const mintBlocksOn = async (targetLoc: string) => {
    const report = await specCorpusMintMutations.mintSpecCorpus(null, { memoryRef: draft.id, dryRun: true }, as());
    return report.blockers.some((b) => b.kind === 'UNRESOLVED_REFERENCE' && b.targetLoc === targetLoc);
  };
  /** The shared resolver's verdict on the same address: the report must agree with it. */
  const resolverRefuses = async (address: string) => {
    try { await resolveNodeRef(db, `hrn:node:${address}`); return false; } catch (e) { return e instanceof AmbiguousLegacyUrnError; }
  };
  const neitherAttributedNorRewritten = async () => {
    for (const loc of ['pas:010', 'pas:010:01']) {
      const refs = await resolvers.Query.specBacklinks(null, { memoryRef: draft.id, loc }, as());
      expect(refs.filter((r) => r.kind === 'URN' && r.sourceLoc === 'pas:020'), loc).toEqual([]);
    }
    const plan = await specCorpusRenumberMutations.renumberSpec(
      null, { memoryRef: draft.id, fromLoc: 'pas:010', toLoc: 'pas:040', dryRun: true }, as(),
    );
    expect(plan.rewrites.filter((row) => row.nodeId === other.id)).toEqual([]);
  };

  it('two corpus targets at one address (its own row and an alias to another spec): MISSING, and the mint blocks', async () => {
    const { formerUrn } = await vacateFormerUrn();
    // Cite the loc being renumbered, so a wrongful rewrite would be visible.
    const address = `${formerUrn}:pas:010`;
    await db.urnAlias.createMany({ data: [feature.id, rule.id].map((entityId) => ({
      urn: address, entityType: 'NODE' as const, entityId, reason: 'RENAME' as const,
    })) });
    await cite(address);

    expect(await resolverRefuses(address)).toBe(true);
    expect((await unresolvedAt('pas:010')).map((r) => r.reason)).toEqual(['MISSING']);
    expect(await mintBlocksOn('pas:010')).toBe(true);
    await neitherAttributedNorRewritten();
  });

  it('a corpus alias target plus a READABLE foreign one: MISSING, and the mint blocks', async () => {
    const { formerUrn, squatter } = await vacateFormerUrn();
    // Cite the loc being renumbered, so a wrongful rewrite would be visible.
    const address = `${formerUrn}:pas:010`;
    const foreign = await db.node.create({ data: { id: generateId(), memoryId: squatter.id, loc: 'pas:900', name: 'Foreign target' } });
    await db.urnAlias.createMany({ data: [feature.id, foreign.id].map((entityId) => ({
      urn: address, entityType: 'NODE' as const, entityId, reason: 'RENAME' as const,
    })) });
    await cite(address);

    expect(await resolverRefuses(address)).toBe(true);
    expect((await unresolvedAt('pas:010')).map((r) => r.reason)).toEqual(['MISSING']);
    expect(await mintBlocksOn('pas:010')).toBe(true);
    await neitherAttributedNorRewritten();
  });

  it('two historical holders of a former URN with the cited loc (the corpus one of them): MISSING', async () => {
    // Another memory held "shared" first and was renamed away; then the corpus
    // held it and was renamed away too. Both have a live pas:010.
    const otherMem = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'shared' }, as());
    const shared = otherMem.urn;
    await resolvers.Mutation.updateMemory(null, { id: otherMem.id, urn: 'someone-else' } as never, as());
    await db.node.create({ data: { id: generateId(), memoryId: otherMem.id, loc: 'pas:010', name: 'Theirs' } });
    await resolvers.Mutation.updateMemory(null, { id: draft.id, urn: 'shared' } as never, as());
    await resolvers.Mutation.updateMemory(null, { id: draft.id, urn: 'specs-final' } as never, as());
    await cite(`${shared}:pas:010`);

    expect(await resolverRefuses(`${shared}:pas:010`)).toBe(true);
    expect((await unresolvedAt('pas:010')).map((r) => r.reason)).toEqual(['MISSING']);
    expect(await mintBlocksOn('pas:010')).toBe(true);
    await neitherAttributedNorRewritten();
  });

  it('CONTROL: the corpus row and an alias to that SAME node are one candidate, not an ambiguity', async () => {
    const { formerUrn } = await vacateFormerUrn();
    const address = `${formerUrn}:pas:010`;
    await db.urnAlias.create({ data: { urn: address, entityType: 'NODE', entityId: feature.id, reason: 'RENAME' } });
    await cite(address);

    expect(await resolverRefuses(address)).toBe(false);
    expect(await unresolvedAt('pas:010')).toEqual([]);
    const refs = await resolvers.Query.specBacklinks(null, { memoryRef: draft.id, loc: 'pas:010' }, as());
    expect(refs.some((r) => r.kind === 'URN' && r.sourceLoc === 'pas:020')).toBe(true);
  });

  it('CONTROL: an unclaimed former-name citation is still rewritten, canonicalized to the current URN (@codex P2 on #1506)', async () => {
    // Renamed, and nothing else claims the former URN: no holder, no alias.
    // The corpus's own row is then the only thing that confirms the target.
    const formerUrn = draft.urn;
    await resolvers.Mutation.updateMemory(null, { id: draft.id, urn: 'specs-draft-renamed' } as never, as());
    const currentUrn = (await db.memory.findUniqueOrThrow({ where: { id: draft.id } })).urn;
    await cite(`${formerUrn}:pas:010`);

    expect(await unresolvedAt('pas:010')).toEqual([]);
    const res = await specCorpusRenumberMutations.renumberSpec(
      null, { memoryRef: draft.id, fromLoc: 'pas:010', toLoc: 'pas:040' }, as(),
    );
    expect(res.rewrites.find((row) => row.nodeId === other.id)).toMatchObject({ status: 'REWRITTEN', count: 1 });
    expect(await content('pas:020')).toContain(`hrn:node:${currentUrn}:pas:040`);
  });

  it('CONTROL: a live node at the published address wins; that is not ambiguity', async () => {
    const { formerUrn, squatter } = await vacateFormerUrn();
    const address = `${formerUrn}:pas:500`;
    await db.node.create({ data: { id: generateId(), memoryId: squatter.id, loc: 'pas:500', name: 'Published' } });
    await db.urnAlias.create({ data: { urn: address, entityType: 'NODE', entityId: feature.id, reason: 'RENAME' } });
    await cite(address);

    expect(await resolverRefuses(address)).toBe(false);
    expect(await unresolvedAt('pas:500')).toEqual([]);
    expect(await mintBlocksOn('pas:500')).toBe(false);
  });

  it('CONTROL: an address claimed only by readable foreign targets stays foreign, even when ambiguous there', async () => {
    const { formerUrn, squatter } = await vacateFormerUrn();
    const address = `${formerUrn}:pas:500`;
    const [a, b] = await Promise.all(['pas:901', 'pas:902'].map((loc) =>
      db.node.create({ data: { id: generateId(), memoryId: squatter.id, loc, name: loc } })));
    await db.urnAlias.createMany({ data: [a.id, b.id].map((entityId) => ({
      urn: address, entityType: 'NODE' as const, entityId, reason: 'RENAME' as const,
    })) });
    await cite(address);

    expect(await unresolvedAt('pas:500')).toEqual([]);
    expect(await mintBlocksOn('pas:500')).toBe(false);
  });

  /** A private memory of another user: the caller (admin) cannot read it. */
  const hiddenMemory = async (slug: string) => {
    await db.orgMember.upsert({
      where: { organizationId_userId: { organizationId: org.id, userId: outsider.id } },
      create: { organizationId: org.id, userId: outsider.id, role: 'READER' }, update: {},
    });
    return db.memory.create({ data: {
      id: generateId(), urn: `${org.urn}:${slug}`, name: slug, class: 'private', organizationId: org.id, userId: outsider.id,
    } });
  };
  /** What the CALLER's own resolver says about the address: the shared concealment rule applied. */
  const callerSees = async (address: string) => {
    try { await resolveNodeRefForCaller(as(), `hrn:node:${address}`); return 'RESOLVED'; } catch (e) {
      if (e instanceof AmbiguousLegacyUrnError) return 'AMBIGUOUS';
      if (e instanceof NodeNotFoundError) return 'NOT_FOUND';
      throw e;
    }
  };

  it.each(['readable', 'hidden'] as const)(
    'a former-name citation counts a %s alias under the corpus current URN (#1511)',
    async (visibility) => {
      const formerUrn = draft.urn;
      const prior = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'specs-current' }, as());
      const currentUrn = prior.urn;
      await resolvers.Mutation.updateMemory(null, { id: prior.id, urn: 'prior-renamed' } as never, as());
      await resolvers.Mutation.updateMemory(null, { id: draft.id, urn: 'specs-current' } as never, as());
      expect((await db.memory.findUniqueOrThrow({ where: { id: draft.id } })).urn).toBe(currentUrn);
      const address = `${formerUrn}:pas:010`;
      await cite(address);

      // Before the moved-node alias, the corpus row is the sole candidate.
      expect(await callerSees(address)).toBe('RESOLVED');
      const before = await resolvers.Query.specBacklinks(null, { memoryRef: draft.id, loc: 'pas:010' }, as());
      expect(before.some((r) => r.kind === 'URN' && r.sourceLoc === 'pas:020')).toBe(true);

      const targetMemory = visibility === 'hidden' ? await hiddenMemory('private-target') : minted;
      const foreign = await db.node.create({ data: {
        id: generateId(), memoryId: targetMemory.id, loc: 'pas:900', name: 'Prior holder target',
      } });
      await db.urnAlias.create({ data: {
        urn: `${currentUrn}:pas:010`, entityType: 'NODE', entityId: foreign.id, reason: 'RENAME',
      } });

      expect(await callerSees(address)).toBe('AMBIGUOUS');
      expect((await unresolvedAt('pas:010')).map((r) => r.reason)).toEqual(['MISSING']);
      expect(await mintBlocksOn('pas:010')).toBe(true);
      await neitherAttributedNorRewritten();
    },
  );

  it('a corpus alias target plus an UNREADABLE foreign one: MISSING, as the reader\'s own resolver refuses it (@codex P1 on #1506)', async () => {
    const { formerUrn } = await vacateFormerUrn();
    const address = `${formerUrn}:pas:010`;
    const hidden = await hiddenMemory('outsiders-private');
    const target = await db.node.create({ data: { id: generateId(), memoryId: hidden.id, loc: 'pas:777', name: 'Hidden' } });
    await db.urnAlias.createMany({ data: [feature.id, target.id].map((entityId) => ({
      urn: address, entityType: 'NODE' as const, entityId, reason: 'RENAME' as const,
    })) });
    await cite(address);

    // The corpus target is readable, so the shared concealment rule does NOT
    // hide the ambiguity: this caller already gets the refusal from node(ref:).
    expect(await callerSees(address)).toBe('AMBIGUOUS');
    expect((await unresolvedAt('pas:010')).map((r) => r.reason)).toEqual(['MISSING']);
    expect(await mintBlocksOn('pas:010')).toBe(true);
    await neitherAttributedNorRewritten();
  });

  it('renumber does not rewrite a former-name citation with no confirmed corpus target (8eacfc78 rule)', async () => {
    // Renamed, nothing else holds the former name, and the cited child exists
    // nowhere. Under the CURRENT name such a citation would follow the move;
    // under a former name only a confirmed corpus target is rewritten.
    const formerUrn = draft.urn;
    await resolvers.Mutation.updateMemory(null, { id: draft.id, urn: 'specs-draft-renamed' } as never, as());
    await cite(`${formerUrn}:pas:010:99`);
    const plan = await specCorpusRenumberMutations.renumberSpec(
      null, { memoryRef: draft.id, fromLoc: 'pas:010', toLoc: 'pas:040', dryRun: true }, as(),
    );
    expect(plan.rewrites.filter((row) => row.nodeId === other.id)).toEqual([]);
  });

  it('an UNREADABLE current holder of a former name: MISSING uniformly, with or without its row (29c2245c + #1505)', async () => {
    // The draft is renamed and a private memory of another user takes its
    // former name. Every citation under that name must read the same whether
    // or not the hidden holder has a row at the cited loc: no probe on any
    // surface. And a reader's resolver lands on the hidden holder, so for the
    // mint it is unresolvable -- MISSING, blocking.
    const formerUrn = draft.urn;
    await resolvers.Mutation.updateMemory(null, { id: draft.id, urn: 'specs-draft-renamed' } as never, as());
    const hidden = await hiddenMemory('scratch-holder');
    await db.memory.update({ where: { id: hidden.id }, data: { urn: formerUrn } });
    await cite(`${formerUrn}:pas:010`);

    const snapshot = async () => ({
      unresolved: (await unresolvedAt('pas:010')).map((r) => r.reason),
      blocks: await mintBlocksOn('pas:010'),
      backlinks: (await resolvers.Query.specBacklinks(null, { memoryRef: draft.id, loc: 'pas:010' }, as()))
        .filter((r) => r.kind === 'URN' && r.sourceLoc === 'pas:020'),
      rewrites: (await specCorpusRenumberMutations.renumberSpec(
        null, { memoryRef: draft.id, fromLoc: 'pas:010', toLoc: 'pas:040', dryRun: true }, as(),
      )).rewrites.filter((row) => row.nodeId === other.id),
    });
    const withoutRow = await snapshot();
    await db.node.create({ data: { id: generateId(), memoryId: hidden.id, loc: 'pas:010', name: 'Hidden' } });
    const withRow = await snapshot();

    expect(withRow).toEqual(withoutRow);
    expect(withRow.unresolved).toEqual(['MISSING']);
    expect(withRow.blocks).toBe(true);
    expect(withRow.backlinks).toEqual([]);
    expect(withRow.rewrites).toEqual([]);
  });

  it('an UNREADABLE historical holder with the cited loc, next to the corpus row: MISSING', async () => {
    // A private memory held "shared" and was renamed away; then the corpus
    // held it and was renamed away too. Both have a live pas:010.
    const hidden = await hiddenMemory('shared');
    const shared = hidden.urn;
    await db.memory.update({ where: { id: hidden.id }, data: { urn: `${org.urn}:hidden-renamed` } });
    await db.urnAlias.create({ data: { urn: shared, entityType: 'MEMORY', entityId: hidden.id, reason: 'RENAME' } });
    await db.node.create({ data: { id: generateId(), memoryId: hidden.id, loc: 'pas:010', name: 'Hidden' } });
    await resolvers.Mutation.updateMemory(null, { id: draft.id, urn: 'shared' } as never, as());
    await resolvers.Mutation.updateMemory(null, { id: draft.id, urn: 'specs-final' } as never, as());
    await cite(`${shared}:pas:010`);

    expect(await callerSees(`${shared}:pas:010`)).toBe('AMBIGUOUS');
    expect((await unresolvedAt('pas:010')).map((r) => r.reason)).toEqual(['MISSING']);
    expect(await mintBlocksOn('pas:010')).toBe(true);
  });

  it('CONTROL: when EVERY candidate is unreadable the ambiguity is concealed, and the report is what no alias at all would give', async () => {
    const { formerUrn } = await vacateFormerUrn();
    const address = `${formerUrn}:pas:500`;
    await cite(address);
    const baseline = await unresolvedAt('pas:500');
    const baselineMint = await mintBlocksOn('pas:500');
    const baselineBacklinks = await resolvers.Query.specBacklinks(null, { memoryRef: draft.id, loc: 'pas:500' }, as());

    const hidden = await hiddenMemory('outsiders-private');
    const [a, b] = await Promise.all(['pas:771', 'pas:772'].map((loc) =>
      db.node.create({ data: { id: generateId(), memoryId: hidden.id, loc, name: loc } })));
    await db.urnAlias.createMany({ data: [a.id, b.id].map((entityId) => ({
      urn: address, entityType: 'NODE' as const, entityId, reason: 'RENAME' as const,
    })) });

    expect(await callerSees(address)).toBe('NOT_FOUND');
    expect(await unresolvedAt('pas:500')).toEqual(baseline);
    expect(await mintBlocksOn('pas:500')).toBe(baselineMint);
    expect(await resolvers.Query.specBacklinks(null, { memoryRef: draft.id, loc: 'pas:500' }, as())).toEqual(baselineBacklinks);
  });
});


describe('#2063 standalone renumber reconciliation boundary', () => {
  it.each([false, true])('waits before standalone reconciliation and rechecks write authority (revoked=%s)', async (revoked) => {
    await db.node.update({ where: { id: other.id }, data: { content: (await content('pas:020')) + '\nRaw drift.' } });
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((r) => { entered = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const holder = withIncludeHistoryTransaction(db, async () => { entered(); await gate; });
    await ready;
    const pending = specCorpusRenumberMutations.renumberSpec(null, { memoryRef: draft.id, fromLoc: 'pas:010', toLoc: 'pas:040' }, as());
    const outcome = pending.then((value) => ({ value }), (error: unknown) => ({ error }));
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1, 750);
      expect((await db.node.findUniqueOrThrow({ where: { id: other.id } })).revSeq).toBe(1);
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM nodes WHERE memory_id = ${draft.id} ORDER BY id FOR UPDATE NOWAIT`;
      });
      if (revoked) await db.orgMember.deleteMany({ where: { userId: admin.id } });
    } finally {
      release();
      await holder;
      await outcome;
    }
    await pending;
    if (revoked) {
      expect((await db.node.findUniqueOrThrow({ where: { id: other.id } })).revSeq).toBe(1);
      expect(await content('pas:020')).toContain('pas:010');
      expect(await db.nodeRevision.count({ where: { nodeId: other.id } })).toBe(0);
    } else expect(await content('pas:020')).toContain('pas:040');
  });
});
