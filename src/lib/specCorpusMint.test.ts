/** #1448: minting a draft spec corpus, once and one-way, refused while anything blocks. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { computeContentHash } from './contentHash.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { specCorpusMintMutations } from '../api/graphql/schema/resolvers.specCorpus.js';

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
const mint = (dryRun?: boolean, userId = admin.id, memoryRef = draft.id) =>
  specCorpusMintMutations.mintSpecCorpus(null, { memoryRef, ...(dryRun !== undefined ? { dryRun } : {}) }, as(userId));
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

    // One-way: no second mint, no reservation, and moves record aliases again.
    expect(await codeOf(mint())).toBe('SPEC_CORPUS_NOT_DRAFT');
    expect(await codeOf(resolvers.Mutation.reserveSpecCitation(null, { memoryRef: draft.id, loc: 'pas:020' }, as())))
      .toBe('SPEC_CORPUS_NOT_DRAFT');
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

  it('refuses a memory that was never a draft', async () => {
    const plain = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'plain' }, as());
    expect(await codeOf(mint(true, admin.id, plain.id))).toBe('SPEC_CORPUS_NOT_DRAFT');
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
            AND query LIKE '%FROM memories WHERE id%' AND query LIKE '%FOR NO KEY UPDATE%'
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

describe('Memory.corpusMintedAt reads through a narrowed parent (@codex P2 on #1462)', () => {
  it('reloads the column when the parent was projected without it', async () => {
    await mint();
    const at = (await db.memory.findUniqueOrThrow({ where: { id: draft.id } })).corpusMintedAt;
    expect(at).toBeInstanceOf(Date);
    expect(await resolvers.Memory.corpusMintedAt({ id: draft.id }, {}, as())).toEqual(at);
    expect(await resolvers.Memory.corpusMintedAt({ id: draft.id, corpusMintedAt: null }, {}, as())).toBeNull();
  });
});
