import { withIncludeHistoryClientTransaction } from './includes/includeHistoryFence.js';
/** #1450: reserve a citation in a draft spec corpus as a server-marked placeholder. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../integrations/db/client.js';
import { observeTransactionBackend, waitForAdvisoryWaiter } from '../test/advisoryWaiter.js';
import { cleanDb, tombstoneNodes } from '../test/helpers.js';
import { generateId } from './id.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { mergeMemoryGraph } from '../controller/operations/mergeMemories.js';
import { updateNodeFromGitSync } from '../integrations/github/syncGraphFromGithub.js';
import { acquireLockSet, ancestorLocs } from './nodeSubtreeLock.js';
import { lockEdgeEndpointMemories } from './edgeEndpointLock.js';
import { generateDataKey } from './crypto.js';
import { sessionKeyCache } from './sessionKeyCache.js';
import { writeNodeToGit } from '../integrations/github/writeNodeToGit.js';
import { archiveTombstone } from './tombstoneArchive.js';

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

const as = (userId: string): Context => ({ db, userId, roles: [] });
const reserve = (memoryRef: string, loc: string, name?: string, userId = admin.id) =>
  resolvers.Mutation.reserveSpecCitation(null, { memoryRef, loc, ...(name ? { name } : {}) }, as(userId));
const updateSpec = (memoryId: string, loc: string, patch: Record<string, unknown>) =>
  resolvers.Mutation.updateSpecNode(null, { input: { memoryId, loc, ...patch } } as never, as(admin.id));
const codeOf = async (p: Promise<unknown>) => {
  try { await p; return 'NO_ERROR'; } catch (e) {
    return e instanceof GraphQLError ? String(e.extensions.code) : (e as Error).name;
  }
};
const row = (memoryId: string, loc: string) => db.node.findFirst({ where: { memoryId, loc, deletedAt: null } });

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'Corpus Org', urn: 'corpus.example' } });
  admin = await db.user.create({ data: { githubId: 145001, githubUsername: 'corpus-admin', roles: [] } });
  outsider = await db.user.create({ data: { githubId: 145002, githubUsername: 'corpus-outsider', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  draft = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'specs-draft', draftCorpus: true }, as(admin.id));
  minted = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'specs' }, as(admin.id));
});

describe('reserveSpecCitation (#1450)', () => {
  it('exports the committed marker through the direct encrypted mirror path', async () => {
    await db.memory.update({ where: { id: draft.id }, data: { isEncrypted: true, vectorIndexEnabled: false } });
    sessionKeyCache.set('placeholder-encrypted-mirror', draft.id, generateDataKey());
    const mirror = vi.mocked(writeNodeToGit);
    mirror.mockClear();
    try {
      const reserved = await reserve(draft.id, 'pas:010:09');
      await vi.waitFor(() => expect(mirror).toHaveBeenCalled());
      expect(mirror.mock.calls.at(-1)?.[0]).toMatchObject({ id: reserved.id, isPlaceholder: true });
      expect(await row(draft.id, 'pas:010:09')).toMatchObject({ isPlaceholder: true });
    } finally {
      sessionKeyCache.clear();
    }
  });

  it('creates a spec node at the citation, marked as a placeholder by the server', async () => {
    const node = await reserve(draft.id, 'pas:010:01');
    expect(node).toMatchObject({ loc: 'pas:010:01', name: 'pas:010:01', isPlaceholder: true });
    expect(await row(draft.id, 'pas:010:01')).toMatchObject({
      role: 'spec', nodeType: 'info', isPlaceholder: true, content: null,
    });
    // An explicit name is kept; the citation is the loc either way.
    expect(await reserve(draft.id, 'pas:010:02', 'Consent')).toMatchObject({ name: 'Consent', isPlaceholder: true });
  });

  it('reserves in any memory, unminted, even one with minted nodes (#1591)', async () => {
    const published = await db.node.create({ data: {
      id: generateId(), memoryId: minted.id, loc: 'cor:010', name: 'cor:010', content: 'Body.', role: 'spec',
      nodeType: 'info', mintedAt: new Date(), mintedByInfo: 'test',
    } });
    const reserved = await reserve(minted.id, 'cor:010:01');
    expect(await db.node.findUniqueOrThrow({ where: { id: reserved.id } })).toMatchObject({ isPlaceholder: true, mintedAt: null });
    expect((await db.node.findUniqueOrThrow({ where: { id: published.id } })).mintedAt).not.toBeNull();
  });

  it('does not reveal a memory\'s draft state to a caller who cannot write it', async () => {
    const code = await codeOf(reserve(minted.id, 'cor:010:01', undefined, outsider.id));
    expect(code).not.toBe('SPEC_CORPUS_NOT_DRAFT');
    expect(code).not.toBe('NO_ERROR');
    expect(await db.node.count({ where: { memoryId: minted.id, loc: 'cor:010:01' } })).toBe(0);
  });

  it('refuses a citation that is already live', async () => {
    await reserve(draft.id, 'pas:010:01');
    expect(await codeOf(reserve(draft.id, 'pas:010:01'))).toBe('NodeLocConflictError');
  });
});

describe('a placeholder becomes a real spec when its content is written (#1450)', () => {
  it('stays a placeholder through a blank write, and becomes a spec at the same citation on real content', async () => {
    const reserved = await reserve(draft.id, 'pas:010:01');

    await updateSpec(draft.id, 'pas:010:01', { name: 'Consent', content: '   ' });
    expect(await row(draft.id, 'pas:010:01')).toMatchObject({ isPlaceholder: true, name: 'Consent' });

    await updateSpec(draft.id, 'pas:010:01', { content: '## Definition\n\nConsent is recorded.' });
    const written = await row(draft.id, 'pas:010:01');
    expect(written).toMatchObject({ id: reserved.id, loc: 'pas:010:01', isPlaceholder: false });
  });

  it('cannot be set or cleared by a client: the flag is not part of any node input', async () => {
    await resolvers.Mutation.createSpecNode(null, {
      input: { memoryId: draft.id, loc: 'pas:020:01', name: 'Real', role: 'spec', nodeType: 'info', content: 'Body.', isPlaceholder: true },
    } as never, as(admin.id));
    expect(await row(draft.id, 'pas:020:01')).toMatchObject({ isPlaceholder: false });

    await reserve(draft.id, 'pas:020:02');
    await updateSpec(draft.id, 'pas:020:02', { name: 'Renamed', isPlaceholder: false });
    expect(await row(draft.id, 'pas:020:02')).toMatchObject({ isPlaceholder: true });
  });

  it('does not let a spec created over a deleted placeholder inherit its flag', async () => {
    const reserved = await reserve(draft.id, 'pas:030:01');
    await tombstoneNodes(db, [reserved.id]);
    await resolvers.Mutation.createSpecNode(null, {
      input: { memoryId: draft.id, loc: 'pas:030:01', name: 'Written', role: 'spec', nodeType: 'info', content: 'Body.' },
    } as never, as(admin.id));
    expect(await row(draft.id, 'pas:030:01')).toMatchObject({ isPlaceholder: false });
  });

  it('keeps the flag when the placeholder is renumbered', async () => {
    const reserved = await reserve(draft.id, 'pas:040:01');
    await resolvers.Mutation.moveNode(null, { sourceRef: reserved.id, targetUrn: `hrn:node:${draft.urn}:pas:040:05` }, as(admin.id));
    expect(await row(draft.id, 'pas:040:05')).toMatchObject({ id: reserved.id, isPlaceholder: true });
  });
});

describe('placeholders may live in any memory (#1591; was draft-only, @codex P1 on #1452)', () => {
  // A placeholder is an unminted node, and any memory's mint refuses while one
  // remains, so moving, copying or merging it publishes nothing.
  it('moves a placeholder, or a subtree carrying one, into a memory with minted nodes, still a placeholder', async () => {
    await db.node.updateMany({ where: { memoryId: minted.id }, data: { mintedAt: new Date(), mintedByInfo: 'test' } });
    const reserved = await reserve(draft.id, 'pas:050:01');
    await resolvers.Mutation.moveNode(null, {
      sourceRef: reserved.id, targetUrn: `hrn:node:${minted.urn}:pas:050:01`,
    }, as(admin.id));
    expect(await db.node.findUniqueOrThrow({ where: { id: reserved.id } }))
      .toMatchObject({ memoryId: minted.id, isPlaceholder: true, mintedAt: null });

    const parent = await resolvers.Mutation.createSpecNode(null, {
      input: { memoryId: draft.id, loc: 'pas:060', name: 'Feature', role: 'spec', nodeType: 'info', content: 'Body.' },
    } as never, as(admin.id));
    const child = await reserve(draft.id, 'pas:060:01');
    await resolvers.Mutation.moveNode(null, { sourceRef: parent.id, targetUrn: `hrn:node:${minted.urn}:pas:060` }, as(admin.id));
    expect(await db.node.findUniqueOrThrow({ where: { id: child.id } })).toMatchObject({ memoryId: minted.id, isPlaceholder: true });
  });
});

describe('copies and merges keep a placeholder a placeholder (#1591; was refused, @codex P1 on #1452)', () => {
  it('clones a memory with a placeholder; the copy is an unminted placeholder', async () => {
    await reserve(draft.id, 'pas:080:01');
    const clone = await resolvers.Mutation.cloneMemory(null, { ref: draft.id, targetUrn: `hrn:mem:${org.urn}:specs-copy` }, as(admin.id));
    expect(await db.node.findFirstOrThrow({ where: { memoryId: clone.id, loc: 'pas:080:01' } }))
      .toMatchObject({ isPlaceholder: true, mintedAt: null });
  });

  it('extracts a subtree containing a placeholder; the copy is a placeholder', async () => {
    const parent = await resolvers.Mutation.createSpecNode(null, {
      input: { memoryId: draft.id, loc: 'pas:090', name: 'Feature', role: 'spec', nodeType: 'info', content: 'Body.' },
    } as never, as(admin.id));
    await reserve(draft.id, 'pas:090:01');
    const extracted = await resolvers.Mutation.extractParentNodeToMemory(
      {}, { parentRef: parent.id, targetUrn: `hrn:mem:${org.urn}:extracted`, move: false } as never, as(admin.id),
    ) as { id: string };
    const copies = await db.node.findMany({ where: { memoryId: extracted.id, isPlaceholder: true }, select: { loc: true } });
    expect(copies.map((c) => c.loc)).toEqual([expect.stringMatching(/:01$/)]);
  });

  it('merges a placeholder into another memory; it relocates, still a placeholder', async () => {
    await db.node.create({ data: { id: generateId(), memoryId: draft.id, loc: 'pas:095:01', name: 'x', isPlaceholder: true } });
    await mergeMemoryGraph(db, {
      sourceMemoryId: draft.id, targetMemoryId: minted.id, fields: new Set(['CONTENT', 'EDGES']),
      deleteSourceMem: false, editor: { userId: admin.id }, batchSize: 1, classifyPageSize: 1,
    });
    expect(await db.node.findFirstOrThrow({ where: { memoryId: minted.id, loc: 'pas:095:01' } })).toMatchObject({ isPlaceholder: true });
  });
});

describe('a placeholder stays a spec until written; cloneNode never copies one (@codex P1 on #1452)', () => {
  it('refuses to drop the spec role from an unwritten placeholder, but allows it with content in the same write', async () => {
    await reserve(draft.id, 'pas:100:01');
    expect(await codeOf(updateSpec(draft.id, 'pas:100:01', { role: null }))).toBe('SPEC_PLACEHOLDER_ROLE_LOCKED');
    expect(await codeOf(updateSpec(draft.id, 'pas:100:01', { role: 'note', content: '   ' }))).toBe('SPEC_PLACEHOLDER_ROLE_LOCKED');
    expect(await row(draft.id, 'pas:100:01')).toMatchObject({ role: 'spec', isPlaceholder: true });

    await updateSpec(draft.id, 'pas:100:01', { role: null, content: 'Now it is written.' });
    expect(await row(draft.id, 'pas:100:01')).toMatchObject({ role: null, isPlaceholder: false });
  });

  it('accepts an unchanged dotted spec role on an imported placeholder but locks a different role', async () => {
    await db.node.create({ data: {
      id: generateId(), memoryId: draft.id, loc: 'pas:105:01', name: 'Imported',
      role: 'spec.rule', isPlaceholder: true,
    } });
    await updateSpec(draft.id, 'pas:105:01', { role: 'spec.rule', name: 'Renamed' });
    expect(await row(draft.id, 'pas:105:01')).toMatchObject({
      name: 'Renamed', role: 'spec.rule', isPlaceholder: true,
    });
    expect(await codeOf(updateSpec(draft.id, 'pas:105:01', { role: 'spec.flow' })))
      .toBe('SPEC_PLACEHOLDER_ROLE_LOCKED');
    expect(await row(draft.id, 'pas:105:01')).toMatchObject({ role: 'spec.rule', isPlaceholder: true });
  });

  it('refuses to cloneNode a placeholder, even one whose role was removed behind the API', async () => {
    const reserved = await reserve(draft.id, 'pas:110:01');
    expect(await codeOf(resolvers.Mutation.cloneNode(null, {
      sourceRef: reserved.id, targetUrn: `hrn:node:${minted.urn}:pas:110:01`,
    }, as(admin.id)))).toBe('SPEC_PLACEHOLDER_NOT_COPYABLE');

    await db.node.update({ where: { id: reserved.id }, data: { role: null } });
    expect(await codeOf(resolvers.Mutation.cloneNode(null, {
      sourceRef: reserved.id, targetUrn: `hrn:node:${minted.urn}:pas:110:01`,
    }, as(admin.id)))).toBe('SPEC_PLACEHOLDER_NOT_COPYABLE');
    expect(await db.node.count({ where: { memoryId: minted.id, loc: 'pas:110:01' } })).toBe(0);
  });
});

describe('every content write fills a placeholder (@codex P2 on #1452)', () => {
  it('mergeNodes: merging real content into a placeholder makes it a spec', async () => {
    const reserved = await reserve(draft.id, 'pas:120:01');
    const donor = await db.node.create({ data: { id: generateId(), memoryId: draft.id, loc: 'scratch:donor', name: 'Donor', content: 'The written rule.' } });
    const result = await codeOf(resolvers.Mutation.mergeNodes({}, {
      input: { source: donor.id, target: reserved.id, include: ['CONTENT'] },
    } as never, as(admin.id)));
    // mergeNodes admits a governed spec target, so this is a real write path.
    expect(result).toBe('NO_ERROR');
    expect(await db.node.findUniqueOrThrow({ where: { id: reserved.id } }))
      .toMatchObject({ content: 'The written rule.', isPlaceholder: false });
  });

  it('mergeMemoryGraph: a collision fold with real content fills the destination placeholder (#1478)', async () => {
    const placeholder = await reserve(draft.id, 'pas:121:01');
    // The generic merge door refuses governed spec rows. This follow-up is
    // reachable only for the legacy role-drifted placeholder in the issue.
    await db.node.update({ where: { id: placeholder.id }, data: { role: null } });
    const source = await resolvers.Mutation.createMemory(null, {
      orgId: org.id, name: 'source-draft', draftCorpus: true,
    }, as(admin.id));
    await db.node.create({ data: {
      id: generateId(), memoryId: source.id, loc: 'pas:121:01', name: 'Written spec',
      nodeType: 'info', content: 'The real rule.',
    } });
    await mergeMemoryGraph(db, {
      sourceMemoryId: source.id, targetMemoryId: draft.id,
      fields: new Set(['CONTENT']), deleteSourceMem: false, editor: { userId: admin.id },
    });
    expect(await db.node.findUniqueOrThrow({ where: { id: placeholder.id } })).toMatchObject({
      content: 'The real rule.', isPlaceholder: false,
    });
  });

  it('re-saving real content that is already there clears a stuck placeholder', async () => {
    const reserved = await reserve(draft.id, 'pas:130:01');
    // A write outside the fill hook left real content on a still-marked placeholder.
    await db.node.update({ where: { id: reserved.id }, data: { content: 'Already written.' } });
    await updateSpec(draft.id, 'pas:130:01', { content: 'Already written.' });
    expect(await row(draft.id, 'pas:130:01')).toMatchObject({ isPlaceholder: false, content: 'Already written.' });
  });
});

describe('reserving over a deleted spec (@codex P2 on #1452)', () => {
  it('does not revive the deleted spec\'s text inside the placeholder', async () => {
    const old = await resolvers.Mutation.createSpecNode(null, {
      input: { memoryId: draft.id, loc: 'pas:140:01', name: 'Old', role: 'spec', nodeType: 'info',
        content: 'Deleted spec text.', abstract: 'Deleted abstract.', description: 'Deleted headline.' },
    } as never, as(admin.id));
    await tombstoneNodes(db, [old.id]);

    await reserve(draft.id, 'pas:140:01');
    expect(await row(draft.id, 'pas:140:01')).toMatchObject({
      isPlaceholder: true, content: null, abstract: null, description: null,
    });
  });

  it('archives recursively deleted descendants and their derived edge addresses with the parent', async () => {
    const target = await db.node.create({ data: {
      id: generateId(), memoryId: draft.id, loc: 'pas:149', name: 'Target', role: 'spec', nodeType: 'info',
    } });
    const parent = await db.node.create({ data: {
      id: generateId(), memoryId: draft.id, loc: 'pas:140', name: 'Old parent', role: 'spec', nodeType: 'info',
    } });
    const child = await db.node.create({ data: {
      id: generateId(), memoryId: draft.id, loc: 'pas:140:01', name: 'Old child', role: 'spec', nodeType: 'info',
    } });
    await db.edge.create({ data: {
      memoryId: draft.id, sourceId: child.id, targetId: target.id,
      loc: 'pas:140:01:cites:pas:149', name: 'cites',
    } });
    await tombstoneNodes(db, [parent.id, child.id]);

    const reserved = await reserve(draft.id, 'pas:140');
    const archived = `pas:140__deleted-${parent.id}`;
    expect(await db.node.findUniqueOrThrow({ where: { id: child.id } })).toMatchObject({
      loc: `${archived}:01`, deletedAt: expect.any(Date),
    });
    expect(await db.edge.findFirstOrThrow({ where: { sourceId: child.id } }))
      .toMatchObject({ loc: `${archived}:01:cites:pas:149` });
    expect(await db.node.count({ where: { memoryId: draft.id, loc: { startsWith: 'pas:140:' } } })).toBe(0);

    const newChild = await db.node.create({ data: {
      id: generateId(), memoryId: draft.id, loc: 'pas:140:01', name: 'New child', role: 'spec', nodeType: 'info',
    } });
    const edge = await resolvers.Mutation.createEdge(null, {
      sourceRef: newChild.id, targetRef: target.id, name: 'cites',
    }, as(admin.id));
    expect(edge).toMatchObject({ loc: 'pas:140:01:cites:pas:149', sourceId: newChild.id });
    expect(reserved.id).not.toBe(parent.id);
  });

  it('reserves over a tombstone while retaining live child branches at the old address', async () => {
    const deletedAt = new Date();
    const parent = await db.node.create({ data: {
      id: generateId(), memoryId: draft.id, loc: 'pas:141', name: 'Old parent',
      role: 'spec', nodeType: 'info', deletedAt,
    } });
    const liveChild = await db.node.create({ data: {
      id: generateId(), memoryId: draft.id, loc: 'pas:141:01', name: 'Live child',
      role: 'spec', nodeType: 'info',
    } });
    const deletedGrandchild = await db.node.create({ data: {
      id: generateId(), memoryId: draft.id, loc: 'pas:141:01:a', name: 'Deleted grandchild',
      role: 'spec', nodeType: 'info', deletedAt,
    } });
    const deletedSibling = await db.node.create({ data: {
      id: generateId(), memoryId: draft.id, loc: 'pas:141:02', name: 'Deleted sibling',
      role: 'spec', nodeType: 'info', deletedAt,
    } });

    const reserved = await reserve(draft.id, 'pas:141');
    const archived = `pas:141__deleted-${parent.id}`;
    expect(reserved.id).not.toBe(parent.id);
    expect(await db.node.findUniqueOrThrow({ where: { id: parent.id } })).toMatchObject({ loc: archived });
    expect(await db.node.findUniqueOrThrow({ where: { id: liveChild.id } })).toMatchObject({ loc: 'pas:141:01', deletedAt: null });
    expect(await db.node.findUniqueOrThrow({ where: { id: deletedGrandchild.id } })).toMatchObject({ loc: 'pas:141:01:a' });
    expect(await db.node.findUniqueOrThrow({ where: { id: deletedSibling.id } })).toMatchObject({ loc: `${archived}:02` });
  });

  it.each([
    { change: 'deleted', initialDeletedAt: null, finalDeletedAt: new Date(), archiveChild: true },
    { change: 'revived', initialDeletedAt: new Date(), finalDeletedAt: null, archiveChild: false },
  ])('re-reads a child $change after the initial descendant scan', async ({ initialDeletedAt, finalDeletedAt, archiveChild }) => {
    const parent = await db.node.create({ data: {
      id: generateId(), memoryId: draft.id, loc: 'pas:142', name: 'Old parent', deletedAt: new Date(),
    } });
    const child = await db.node.create({ data: {
      id: generateId(), memoryId: draft.id, loc: 'pas:142:01', name: 'Changing child', deletedAt: initialDeletedAt,
    } });
    let scanned!: () => void;
    let resume!: () => void;
    const scannedPromise = new Promise<void>((resolve) => { scanned = resolve; });
    const pause = new Promise<void>((resolve) => { resume = resolve; });
    const archive = db.$transaction(async (tx) => {
      await lockEdgeEndpointMemories(tx, [draft.id]);
      await acquireLockSet(tx, [...ancestorLocs(parent.loc), parent.loc].map((loc) => ({ memoryId: draft.id, loc })));
      const gatedTx = new Proxy(tx, {
        get(target, key, receiver) {
          if (key !== 'node') return Reflect.get(target, key, receiver);
          return new Proxy(target.node, {
            get(delegate, method, delegateReceiver) {
              if (method !== 'findMany') return Reflect.get(delegate, method, delegateReceiver);
              return async (...args: unknown[]) => {
                const rows = await (Reflect.get(delegate, method, delegateReceiver) as (...a: unknown[]) => Promise<unknown>)(...args);
                scanned();
                await pause;
                return rows;
              };
            },
          });
        },
      });
      await archiveTombstone(gatedTx, { id: parent.id, loc: parent.loc, memoryId: draft.id });
    }, { timeout: 20_000 });
    await scannedPromise;
    try {
      await db.node.update({ where: { id: child.id }, data: { deletedAt: finalDeletedAt } });
    } finally {
      resume();
    }
    await archive;
    expect(await db.node.findUniqueOrThrow({ where: { id: child.id } }))
      .toMatchObject({
        loc: archiveChild ? `pas:142__deleted-${parent.id}:01` : 'pas:142:01',
        deletedAt: archiveChild ? expect.any(Date) : null,
      });
  });
});

describe('reserve authorizes before touching the tombstone (@codex P2 on #1452)', () => {
  it('refuses an outsider without waiting on the tenant\'s locks, exactly as for a missing memory', async () => {
    const old = await resolvers.Mutation.createSpecNode(null, {
      input: { memoryId: draft.id, loc: 'pas:171:01', name: 'Old', role: 'spec', nodeType: 'info', content: 'Old.' },
    } as never, as(admin.id));
    await tombstoneNodes(db, [old.id]);
    let release!: () => void;
    let held!: () => void;
    const lockHeld = new Promise<void>((r) => { held = r; });
    const hold = new Promise<void>((r) => { release = r; });
    // A legitimate writer holding the loc's address lock.
    const writer = db.$transaction(async (tx) => {
      await acquireLockSet(tx, [{ memoryId: draft.id, loc: 'pas:171:01' }]);
      held();
      await hold;
    }, { timeout: 20_000 });
    await lockHeld;
    try {
      const refused = await Promise.race([
        codeOf(reserve(draft.id, 'pas:171:01', undefined, outsider.id)),
        new Promise<string>((r) => setTimeout(() => r('WAITED_ON_LOCK'), 2_000)),
      ]);
      expect(refused).toBe(await codeOf(reserve(`hrn:mem:${org.urn}:no-such-memory`, 'pas:171:01', undefined, outsider.id)));
    } finally {
      release();
    }
    await writer;
    expect(await db.node.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ loc: 'pas:171:01' });
  });
});

describe('a filled placeholder cannot be restored back to a blank non-placeholder (@codex P1 on #1452)', () => {
  it('refuses restoring the pre-fill revision: a spec is governed, and the generic restore has no spec door', async () => {
    const reserved = await reserve(draft.id, 'pas:170:01');
    await updateSpec(draft.id, 'pas:170:01', { content: 'Written.' });
    const revisions = await db.nodeRevision.findMany({ where: { nodeId: reserved.id }, orderBy: { createdAt: 'asc' } });
    const blank = revisions.find((r) => (r.content ?? '').trim() === '');
    expect(blank).toBeDefined();
    expect(await codeOf(resolvers.Mutation.restoreNodeRevision(null, { revisionId: blank!.id }, as(admin.id))))
      .toBe('ROLE_GOVERNED');
    expect(await row(draft.id, 'pas:170:01')).toMatchObject({ content: 'Written.', isPlaceholder: false });
  });
});

describe('git sync fills a placeholder too (@codex P2 on #1452)', () => {
  it('clears the flag when a synced file writes real content, and keeps it for a content-less update', async () => {
    const reserved = await reserve(draft.id, 'pas:150:01');
    const current = await db.node.findUniqueOrThrow({ where: { id: reserved.id } });
    await withIncludeHistoryClientTransaction(db, (tx) => updateNodeFromGitSync(tx, current, { name: 'Renamed in git' }, undefined, draft.id));
    expect(await row(draft.id, 'pas:150:01')).toMatchObject({ isPlaceholder: true, name: 'Renamed in git' });

    const again = await db.node.findUniqueOrThrow({ where: { id: reserved.id } });
    await withIncludeHistoryClientTransaction(db, (tx) => updateNodeFromGitSync(tx, again, { content: 'Written in the mirror.' }, undefined, draft.id));
    expect(await row(draft.id, 'pas:150:01')).toMatchObject({ isPlaceholder: false, content: 'Written in the mirror.' });
  });
});

describe('reserving over a deleted spec with edges (@codex P2 on #1452)', () => {
  it('does not revive the deleted spec\'s outgoing edges', async () => {
    const target = await resolvers.Mutation.createSpecNode(null, {
      input: { memoryId: draft.id, loc: 'pas:160', name: 'Target', role: 'spec', nodeType: 'info', content: 'Body.' },
    } as never, as(admin.id));
    const old = await resolvers.Mutation.createSpecNode(null, {
      input: { memoryId: draft.id, loc: 'pas:160:01', name: 'Old', role: 'spec', nodeType: 'info', content: 'Old.',
        edges: [{ targetId: target.id, name: 'depends-on' }] },
    } as never, as(admin.id));
    expect(await db.edge.count({ where: { sourceId: old.id, deletedAt: null } })).toBe(1);
    await tombstoneNodes(db, [old.id]);

    const reserved = await reserve(draft.id, 'pas:160:01');
    // A FRESH node: the tombstone is archived, not revived.
    expect(reserved.id).not.toBe(old.id);
    expect(await db.edge.count({ where: { sourceId: reserved.id, deletedAt: null } })).toBe(0);
    expect(await db.node.findUniqueOrThrow({ where: { id: old.id } }))
      .toMatchObject({ loc: `pas:160:01__deleted-${old.id}`, deletedAt: expect.any(Date) });
  });

  it('frees the tombstone\'s edge addresses, so filling the placeholder with the same relationship writes it', async () => {
    const target = await resolvers.Mutation.createSpecNode(null, {
      input: { memoryId: draft.id, loc: 'pas:161', name: 'Target', role: 'spec', nodeType: 'info', content: 'Body.' },
    } as never, as(admin.id));
    const old = await resolvers.Mutation.createSpecNode(null, {
      input: { memoryId: draft.id, loc: 'pas:161:01', name: 'Old', role: 'spec', nodeType: 'info', content: 'Old.',
        edges: [{ targetId: target.id, name: 'depends-on' }] },
    } as never, as(admin.id));
    await tombstoneNodes(db, [old.id]);

    const reserved = await reserve(draft.id, 'pas:161:01');
    await updateSpec(draft.id, 'pas:161:01', {
      content: 'Written.', edges: [{ targetId: target.id, name: 'depends-on' }],
    });

    // createMany({ skipDuplicates }) would have dropped this edge silently.
    expect(await db.edge.findMany({ where: { sourceId: reserved.id }, select: { loc: true, targetId: true } }))
      .toEqual([{ loc: 'pas:161:01:depends-on:pas:161', targetId: target.id }]);
    // The tombstone keeps its edge, at the address derived from its archived loc.
    expect(await db.edge.findMany({ where: { sourceId: old.id }, select: { loc: true } }))
      .toEqual([{ loc: `pas:161:01__deleted-${old.id}:depends-on:pas:161` }]);
  });

  it('frees incoming edge addresses in the same memory, so a live source can link to the placeholder', async () => {
    const source = await resolvers.Mutation.createSpecNode(null, {
      input: { memoryId: draft.id, loc: 'pas:162', name: 'Source', role: 'spec', nodeType: 'info', content: 'Body.' },
    } as never, as(admin.id));
    const old = await resolvers.Mutation.createSpecNode(null, {
      input: { memoryId: draft.id, loc: 'pas:162:01', name: 'Old', role: 'spec', nodeType: 'info', content: 'Old.' },
    } as never, as(admin.id));
    await resolvers.Mutation.createEdge(null, { sourceRef: source.id, targetRef: old.id, name: 'cites' }, as(admin.id));
    await tombstoneNodes(db, [old.id]);

    const reserved = await reserve(draft.id, 'pas:162:01');
    const linked = await resolvers.Mutation.createEdge(
      null, { sourceRef: source.id, targetRef: reserved.id, name: 'cites' }, as(admin.id),
    );

    expect(linked).toMatchObject({ loc: 'pas:162:cites:pas:162:01', targetId: reserved.id });
    expect(await db.edge.findMany({ where: { targetId: old.id }, select: { loc: true } }))
      .toEqual([{ loc: `pas:162:cites:pas:162:01__deleted-${old.id}` }]);
  });
});

describe('reserve archives an edge that was in flight when the spec was deleted (Chip QA on #1452)', () => {
  it('takes the edge-endpoint memory key first, so it waits for an edge writer holding it', async () => {
    let release!: () => void;
    let held!: () => void;
    const keyHeld = new Promise<void>((r) => { held = r; });
    const hold = new Promise<void>((r) => { release = r; });
    // What every edge writer holds from endpoint validation to commit.
    const edgeWriter = db.$transaction(async (tx) => {
      await lockEdgeEndpointMemories(tx, [draft.id]);
      held();
      await hold;
    }, { timeout: 20_000 });
    await keyHeld;

    const reserving = reserve(draft.id, 'pas:164');
    try {
      await vi.waitFor(async () => {
        const waiting = await db.$queryRaw<Array<{ pid: number }>>`
          SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'
        `;
        expect(waiting.length).toBeGreaterThan(0);
      }, { timeout: 5_000, interval: 25 });
      // It waits holding no address lock: another writer can still lock the loc.
      await db.$transaction((tx) => acquireLockSet(tx, [{ memoryId: draft.id, loc: 'pas:164' }]), { timeout: 5_000 });
    } finally {
      release();
    }
    await edgeWriter;
    expect(await reserving).toMatchObject({ loc: 'pas:164', isPlaceholder: true });
  });


  it('waits for the edge insert holding the tombstone, then re-keys that edge too', async () => {
    const source = await resolvers.Mutation.createSpecNode(null, {
      input: { memoryId: draft.id, loc: 'pas:163', name: 'Source', role: 'spec', nodeType: 'info', content: 'Body.' },
    } as never, as(admin.id));
    const target = await resolvers.Mutation.createSpecNode(null, {
      input: { memoryId: draft.id, loc: 'pas:163:01', name: 'Target', role: 'spec', nodeType: 'info', content: 'Old.' },
    } as never, as(admin.id));

    // 1. An edge insert begins while the target is live, and stays open (its FK
    //    holds KEY SHARE on the target row).
    let release!: () => void;
    let inserted!: () => void;
    const edgeOpen = new Promise<void>((r) => { inserted = r; });
    const hold = new Promise<void>((r) => { release = r; });
    const edgeWriter = db.$transaction(async (tx) => {
      await tx.edge.create({ data: {
        memoryId: draft.id, sourceId: source.id, targetId: target.id, loc: 'pas:163:cites:pas:163:01', name: 'cites',
      } });
      inserted();
      await hold;
    }, { timeout: 20_000 });
    await edgeOpen;

    // 2. The target is soft-deleted (a non-key column: it does not wait).
    await tombstoneNodes(db, [target.id]);

    // 3. Reserve at the freed citation, and let it reach the archive.
    const reserving = reserve(draft.id, 'pas:163:01');
    try {
      await vi.waitFor(async () => {
        const waiting = await db.$queryRaw<Array<{ pid: number }>>`
          SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%UPDATE "public"."nodes"%'
        `;
        expect(waiting.length).toBeGreaterThan(0);
      }, { timeout: 5_000, interval: 25 });
    } finally {
      // 4. The edge commits.
      release();
    }
    await edgeWriter;
    const reserved = await reserving;

    expect(reserved.id).not.toBe(target.id);
    expect(await db.edge.findMany({ where: { targetId: target.id }, select: { loc: true } }))
      .toEqual([{ loc: `pas:163:cites:pas:163:01__deleted-${target.id}` }]);
  });
});

describe('git sync keeps an unwritten placeholder a spec (@codex P2 on #1452)', () => {
  it('keeps role spec (and applies the rest of the file) when the file drops the role without writing the spec', async () => {
    const reserved = await reserve(draft.id, 'pas:170:01');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const current = await db.node.findUniqueOrThrow({ where: { id: reserved.id } });
    await withIncludeHistoryClientTransaction(db, (tx) => updateNodeFromGitSync(tx, current, { role: null, name: 'Renamed in git' }, undefined, draft.id));
    expect(await row(draft.id, 'pas:170:01')).toMatchObject({ role: 'spec', isPlaceholder: true, name: 'Renamed in git' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('pas:170:01'));
    warn.mockRestore();

    const again = await db.node.findUniqueOrThrow({ where: { id: reserved.id } });
    await withIncludeHistoryClientTransaction(db, (tx) => updateNodeFromGitSync(tx, again, { role: null, content: 'Written in the mirror.' }, undefined, draft.id));
    expect(await row(draft.id, 'pas:170:01')).toMatchObject({ role: null, isPlaceholder: false });
  });
});

describe('a placeholder over a tombstone is indistinguishable from a fresh one (@codex P2 on #1452)', () => {
  // Columns that legitimately differ between two separate reservations.
  const IDENTITY_AND_BOOKKEEPING = new Set([
    'id', 'loc', 'name', 'seq', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy',
    'deletedAt', 'deletedBy', 'revSeq', 'revisionContentHash', 'lastAccessedAt',
    // Embedding-queue bookkeeping, not authored content: with no content there
    // is nothing to embed, so a stale pending stamp only means an empty pass.
    'embeddingPendingAt',
  ]);

  it('inherits nothing from the deleted spec: every other column matches a fresh reservation', async () => {
    const fresh = await reserve(draft.id, 'pas:180:01');
    const old = await resolvers.Mutation.createSpecNode(null, {
      input: {
        memoryId: draft.id, loc: 'pas:180:02', name: 'Old', role: 'spec', nodeType: 'info',
        content: 'Old body.', abstract: 'Old abstract.', description: 'Old headline.', contentType: 'text/markdown',
        alias: 'old-alias', tags: ['old', 'tags'], data: { old: true }, properties: { old: 1 },
        llmModel: 'old-model', aiAgent: 'old-agent',
      },
    } as never, as(admin.id));
    // Git-sync provenance is not an input field, so seed it directly.
    await db.node.update({ where: { id: old.id }, data: { contentHash: 'deadbeef', ownerRepo: 'acme/specs' } });
    await tombstoneNodes(db, [old.id]);
    const revived = await reserve(draft.id, 'pas:180:02');
    expect(revived.id).not.toBe(old.id); // fresh identity, the tombstone is archived
    // The mutation's own result reports the reset provenance, not the tombstone's.
    expect(revived).toMatchObject({ ownerRepo: null, contentHash: null, isPlaceholder: true });

    const a = await db.node.findUniqueOrThrow({ where: { id: fresh.id } });
    const b = await db.node.findUniqueOrThrow({ where: { id: revived.id } });
    const differing = Object.keys(a).filter((k) => !IDENTITY_AND_BOOKKEEPING.has(k)
      && JSON.stringify((a as Record<string, unknown>)[k]) !== JSON.stringify((b as Record<string, unknown>)[k]));
    expect(differing.map((k) => `${k}: ${JSON.stringify((b as Record<string, unknown>)[k])}`)).toEqual([]);
  });
});

describe('a kept placeholder role is not a sync change (@codex P2 on #1452)', () => {
  it('records no revision for a role-only mismatch, sync after sync', async () => {
    const reserved = await reserve(draft.id, 'pas:190:01');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const revisions = () => db.nodeRevision.count({ where: { nodeId: reserved.id } });
    const before = await revisions();
    for (let i = 0; i < 2; i++) {
      const current = await db.node.findUniqueOrThrow({ where: { id: reserved.id } });
      await withIncludeHistoryClientTransaction(db, (tx) => updateNodeFromGitSync(tx, current, { role: null }, undefined, draft.id));
    }
    warn.mockRestore();
    expect(await revisions()).toBe(before);
    expect(await row(draft.id, 'pas:190:01')).toMatchObject({ role: 'spec', isPlaceholder: true });
  });
});

describe('a revived placeholder has no vectors (@codex P1 on #1452)', () => {
  it('deletes the deleted spec\'s embeddings so its text cannot surface through vector search', async () => {
    const old = await resolvers.Mutation.createSpecNode(null, {
      input: { memoryId: draft.id, loc: 'pas:200:01', name: 'Old', role: 'spec', nodeType: 'info', content: 'Secret deleted text.' },
    } as never, as(admin.id));
    await db.nodeEmbedding.create({ data: { nodeId: old.id, memoryId: draft.id, kind: 'abstract', provider: 'local', model: 'test', dim: 768 } });
    await db.nodeEmbedding.create({ data: {
      nodeId: old.id, memoryId: draft.id, kind: 'chunk', provider: 'local', model: 'test', dim: 768,
      chunkIndex: 0, chunkText: 'Secret deleted text.',
    } as never });
    await tombstoneNodes(db, [old.id]);

    const revived = await reserve(draft.id, 'pas:200:01');
    expect(revived.id).not.toBe(old.id);
    expect(await db.nodeEmbedding.count({ where: { nodeId: revived.id } })).toBe(0);
    // The deleted spec keeps its own vectors on its own still-deleted row.
    expect(await db.nodeEmbedding.count({ where: { nodeId: old.id } })).toBe(2);
  });
});

describe('a placeholder over a deleted spec is a fresh node (@codex P2 on #1452)', () => {
  it('has no revision history, and the deleted spec keeps its own, still deleted', async () => {
    const old = await resolvers.Mutation.createSpecNode(null, {
      input: { memoryId: draft.id, loc: 'pas:210:01', name: 'Old', role: 'spec', nodeType: 'info', content: 'v1' },
    } as never, as(admin.id));
    await updateSpec(draft.id, 'pas:210:01', { content: 'v2 secret' });
    const oldHistory = await db.nodeRevision.count({ where: { nodeId: old.id } });
    expect(oldHistory).toBeGreaterThan(0);
    await tombstoneNodes(db, [old.id]);

    const reserved = await reserve(draft.id, 'pas:210:01');
    expect(reserved.id).not.toBe(old.id);
    expect(await db.nodeRevision.count({ where: { nodeId: reserved.id } })).toBe(0);
    expect(await db.nodeRevision.count({ where: { nodeId: old.id } })).toBe(oldHistory);
    expect(await db.node.findUniqueOrThrow({ where: { id: old.id } }))
      .toMatchObject({ loc: `pas:210:01__deleted-${old.id}`, deletedAt: expect.any(Date) });
  });
});

describe('reserve takes the address locks before the tombstone row (@codex P2 on #1452)', () => {
  it('waits on the loc\'s advisory lock without holding the tombstone row meanwhile', async () => {
    const old = await resolvers.Mutation.createSpecNode(null, {
      input: { memoryId: draft.id, loc: 'pas:220:01', name: 'Old', role: 'spec', nodeType: 'info', content: 'x' },
    } as never, as(admin.id));
    await tombstoneNodes(db, [old.id]);

    let release!: () => void;
    let held!: () => void;
    const lockHeld = new Promise<void>((r) => { held = r; });
    const hold = new Promise<void>((r) => { release = r; });
    // A competing writer at the same address, holding its advisory locks.
    const competitor = db.$transaction(async (tx) => {
      await acquireLockSet(tx, [...ancestorLocs('pas:220:01').map((l) => ({ memoryId: draft.id, loc: l })), { memoryId: draft.id, loc: 'pas:220:01' }]);
      held();
      await hold;
    }, { timeout: 20_000 });
    await lockHeld;

    const observed = observeTransactionBackend(db);
    const reserving = resolvers.Mutation.reserveSpecCitation(null, { memoryRef: draft.id, loc: 'pas:220:01' }, { ...as(admin.id), db: observed.db });
    void reserving.catch(() => {});
    try {
      const pid = await observed.backendFor(reserving);
      await waitForAdvisoryWaiter(db, { pid, key: { form: 'int-pair', first: draft.id, second: 'pas' } });
      // While reserve waits on the address, the tombstone row is NOT locked by it.
      const probe = await db.$transaction(async (tx) =>
        tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM nodes WHERE id = ${old.id} FOR UPDATE NOWAIT`);
      expect(probe).toHaveLength(1);
    } finally {
      release();
      await Promise.allSettled([competitor, reserving]);
    }
    await competitor;
    const placeholder = await reserving;
    expect(placeholder).toMatchObject({ loc: 'pas:220:01', isPlaceholder: true });
    expect(placeholder.id).not.toBe(old.id);
  });
});
