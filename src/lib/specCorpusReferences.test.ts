/** #1449: backlinks, unresolved references and renumber in a draft spec corpus. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { specCorpusRenumberMutations } from '../api/graphql/schema/resolvers.specCorpus.js';
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

  it('refuses a minted corpus, and conceals an unreadable one as not found', async () => {
    expect(await codeOf(resolvers.Query.specBacklinks(null, { memoryRef: minted.id, loc: 'x' }, as()))).toBe('SPEC_CORPUS_NOT_DRAFT');
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

  it('refuses an occupied destination, the spec\'s own subtree, and a minted corpus, writing nothing', async () => {
    expect(await codeOf(renumber(false, 'pas:010', 'pas:020'))).toBe('NodeLocConflictError');
    expect(await codeOf(renumber(false, 'pas:010', 'pas:010:02'))).toBe('BAD_USER_INPUT');
    expect(await codeOf(specCorpusRenumberMutations.renumberSpec(null, { memoryRef: minted.id, fromLoc: 'a', toLoc: 'b' }, as())))
      .toBe('SPEC_CORPUS_NOT_DRAFT');
    expect((await db.node.findUniqueOrThrow({ where: { id: feature.id } })).loc).toBe('pas:010');
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
    expect(after).toContain(`hrn:node:${oldUrn}:pas:040:01`);    // ours: rewritten, spelling kept
    expect(newUrn).not.toBe(oldUrn);
  });

  it('keeps a former-URN alias whose live target moved into this corpus', async () => {
    const formerUrn = draft.urn;
    await resolvers.Mutation.updateMemory(null, { id: draft.id, urn: 'specs-draft-renamed' } as never, as());
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
    expect(await content('pas:020')).toContain(`hrn:node:${formerUrn}:pas:040`);
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

describe('renumber re-decides draft state under the move\'s lock (@codex P1 on #1453)', () => {
  it('refuses, moving nothing, when the corpus is minted between the check and the move', async () => {
    const spy = vi.spyOn(nodeMoveOps, 'moveWithResult').mockImplementationOnce(async (...args) => {
      spy.mockRestore();
      // A mint that wins the memory lock after renumber's own draft check.
      await db.memory.update({ where: { id: draft.id }, data: { corpusDraft: false } });
      return nodeMoveOps.moveWithResult(...args);
    });
    expect(await codeOf(specCorpusRenumberMutations.renumberSpec(null, { memoryRef: draft.id, fromLoc: 'pas:010', toLoc: 'pas:040' }, as())))
      .toBe('SPEC_CORPUS_NOT_DRAFT');
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
