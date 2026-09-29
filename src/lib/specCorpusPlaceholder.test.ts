/** #1450: reserve a citation in a draft spec corpus as a server-marked placeholder. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { mergeMemoryGraph } from '../controller/operations/mergeMemories.js';

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
  it('creates a spec node at the citation, marked as a placeholder by the server', async () => {
    const node = await reserve(draft.id, 'pas:010:01');
    expect(node).toMatchObject({ loc: 'pas:010:01', name: 'pas:010:01', isPlaceholder: true });
    expect(await row(draft.id, 'pas:010:01')).toMatchObject({
      role: 'spec', nodeType: 'info', isPlaceholder: true, content: null,
    });
    // An explicit name is kept; the citation is the loc either way.
    expect(await reserve(draft.id, 'pas:010:02', 'Consent')).toMatchObject({ name: 'Consent', isPlaceholder: true });
  });

  it('refuses in a minted memory and leaves nothing behind', async () => {
    expect(await codeOf(reserve(minted.id, 'cor:010:01'))).toBe('SPEC_CORPUS_NOT_DRAFT');
    expect(await db.node.count({ where: { memoryId: minted.id, loc: 'cor:010:01' } })).toBe(0);
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
    await resolvers.Mutation.deleteNode(null, { nodeRef: reserved.id }, as(admin.id));
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

describe('placeholders never leave draft corpora (@codex P1 on #1452)', () => {
  it('refuses to move a placeholder into a minted memory, and nothing moves', async () => {
    const reserved = await reserve(draft.id, 'pas:050:01');
    const code = await codeOf(resolvers.Mutation.moveNode(null, {
      sourceRef: reserved.id, targetUrn: `hrn:node:${minted.urn}:pas:050:01`,
    }, as(admin.id)));
    expect(code).toBe('SPEC_PLACEHOLDER_OUTSIDE_DRAFT');
    expect(await db.node.findUniqueOrThrow({ where: { id: reserved.id } })).toMatchObject({ memoryId: draft.id, isPlaceholder: true });
  });

  it('refuses a subtree that carries a placeholder among its descendants', async () => {
    const parent = await resolvers.Mutation.createSpecNode(null, {
      input: { memoryId: draft.id, loc: 'pas:060', name: 'Feature', role: 'spec', nodeType: 'info', content: 'Body.' },
    } as never, as(admin.id));
    await reserve(draft.id, 'pas:060:01');
    const code = await codeOf(resolvers.Mutation.moveNode(null, {
      sourceRef: parent.id, targetUrn: `hrn:node:${minted.urn}:pas:060`,
    }, as(admin.id)));
    expect(code).toBe('SPEC_PLACEHOLDER_OUTSIDE_DRAFT');
    expect((await db.node.findUniqueOrThrow({ where: { id: parent.id } })).memoryId).toBe(draft.id);
  });

  it('allows a placeholder to move into another draft corpus, still a placeholder', async () => {
    const other = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'specs-draft-2', draftCorpus: true }, as(admin.id));
    const reserved = await reserve(draft.id, 'pas:070:01');
    await resolvers.Mutation.moveNode(null, { sourceRef: reserved.id, targetUrn: `hrn:node:${other.urn}:pas:070:01` }, as(admin.id));
    expect(await db.node.findUniqueOrThrow({ where: { id: reserved.id } })).toMatchObject({ memoryId: other.id, isPlaceholder: true });
  });
});

describe('copies and merges never publish a placeholder (@codex P1 on #1452)', () => {
  it('refuses to clone a draft that still has a placeholder; the clone is not created', async () => {
    await reserve(draft.id, 'pas:080:01');
    const code = await codeOf(resolvers.Mutation.cloneMemory(null, { ref: draft.id, targetUrn: `hrn:mem:${org.urn}:specs-copy` }, as(admin.id)));
    expect(code).toBe('SPEC_PLACEHOLDER_OUTSIDE_DRAFT');
    expect(await db.memory.count({ where: { urn: `${org.urn}:specs-copy` } })).toBe(0);
  });

  it('refuses to extract a subtree that contains a placeholder into a new memory', async () => {
    const parent = await resolvers.Mutation.createSpecNode(null, {
      input: { memoryId: draft.id, loc: 'pas:090', name: 'Feature', role: 'spec', nodeType: 'info', content: 'Body.' },
    } as never, as(admin.id));
    await reserve(draft.id, 'pas:090:01');
    const code = await codeOf(resolvers.Mutation.extractParentNodeToMemory(
      {}, { parentRef: parent.id, targetUrn: `hrn:mem:${org.urn}:extracted`, move: false } as never, as(admin.id),
    ));
    expect(code).toBe('SPEC_PLACEHOLDER_OUTSIDE_DRAFT');
    expect(await db.memory.count({ where: { urn: `${org.urn}:extracted` } })).toBe(0);
  });

  it('refuses to merge a placeholder into a minted memory, even one whose spec role was removed', async () => {
    // A role-less placeholder is not stopped by the governed merge guard, so the
    // placeholder rule itself must hold.
    // Plenty of ordinary rows ahead of it, so a per-batch-only check would
    // already have committed some of them.
    for (const n of ['pas:091', 'pas:092', 'pas:093']) {
      await db.node.create({ data: { id: generateId(), memoryId: draft.id, loc: n, name: n, content: 'x' } });
    }
    await db.node.create({ data: { id: generateId(), memoryId: draft.id, loc: 'pas:095:01', name: 'x', isPlaceholder: true } });
    const code = await codeOf(mergeMemoryGraph(db, {
      sourceMemoryId: draft.id, targetMemoryId: minted.id, fields: new Set(['CONTENT', 'EDGES']),
      deleteSourceMem: false, editor: { userId: admin.id }, batchSize: 1, classifyPageSize: 1,
    }));
    expect(code).toBe('SPEC_PLACEHOLDER_OUTSIDE_DRAFT');
    expect(await db.node.count({ where: { memoryId: minted.id, loc: 'pas:095:01' } })).toBe(0);
    // Refused up front: nothing from the draft was relocated, not even rows in
    // an earlier batch than the placeholder's.
    expect(await db.node.count({ where: { memoryId: minted.id, loc: { startsWith: 'pas:' } } })).toBe(0);
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

  it('re-saving real content that is already there clears a stuck placeholder', async () => {
    const reserved = await reserve(draft.id, 'pas:130:01');
    // A write outside the fill hook left real content on a still-marked placeholder.
    await db.node.update({ where: { id: reserved.id }, data: { content: 'Already written.' } });
    await updateSpec(draft.id, 'pas:130:01', { content: 'Already written.' });
    expect(await row(draft.id, 'pas:130:01')).toMatchObject({ isPlaceholder: false, content: 'Already written.' });
  });
});
