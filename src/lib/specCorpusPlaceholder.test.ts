/** #1450: reserve a citation in a draft spec corpus as a server-marked placeholder. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';

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
