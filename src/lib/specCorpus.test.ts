/** #1448: a spec corpus can be created in draft; draft moves record no URN alias. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { resolveNodeRef } from './entityRef/nodeRef.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/mirrorNodeMove.js', () => ({
  mirrorNodeMoveToGit: vi.fn().mockResolvedValue(undefined),
}));

let admin: { id: string };
let org: { id: string; urn: string };

const ctx = (): Context => ({ db, userId: admin.id, roles: [] });
const nodeUrn = (memory: { urn: string }, loc: string) => `hrn:node:${memory.urn}:${loc}`;
const createNode = (memoryId: string, loc: string) => db.node.create({
  data: { id: generateId(), memoryId, loc, name: loc, content: `body of ${loc}` },
});
const aliasesFor = (id: string) => db.urnAlias.findMany({ where: { entityType: 'NODE', entityId: id } });
const createMemory = (name: string, draftCorpus?: boolean | null) =>
  resolvers.Mutation.createMemory(null, { orgId: org.id, name, ...(draftCorpus !== undefined ? { draftCorpus } : {}) }, ctx());
const corpusState = (memory: { id: string; corpusDraft?: boolean }) =>
  resolvers.Memory.corpusState(memory, {}, ctx());

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'Corpus Org', urn: 'corpus.example' } });
  admin = await db.user.create({ data: { githubId: 144801, githubUsername: 'corpus-admin', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
});

describe('draft spec corpus state (#1448)', () => {
  it('is DRAFT only when asked for at creation; omitted or null is MINTED', async () => {
    const draft = await createMemory('specs-draft', true);
    const plain = await createMemory('plain');
    const explicitNull = await createMemory('null-draft', null);
    const explicitFalse = await createMemory('false-draft', false);

    expect(await corpusState(draft)).toBe('DRAFT');
    expect(await corpusState(plain)).toBe('MINTED');
    expect(await corpusState(explicitNull)).toBe('MINTED');
    expect(await corpusState(explicitFalse)).toBe('MINTED');
  });

  it('reads the stored flag when the parent row was projected without it', async () => {
    const draft = await createMemory('specs-draft', true);
    // A narrowed parent must not silently read as MINTED.
    expect(await corpusState({ id: draft.id })).toBe('DRAFT');
  });

  it('cannot be switched into draft by an update', async () => {
    const plain = await createMemory('plain');
    // updateMemory has no draftCorpus argument; a caller smuggling one is ignored.
    await resolvers.Mutation.updateMemory(
      null,
      { id: plain.id, description: 'edited', draftCorpus: true } as unknown as Parameters<typeof resolvers.Mutation.updateMemory>[1],
      ctx(),
    );
    expect(await corpusState({ id: plain.id })).toBe('MINTED');
  });

  it('is not carried by a clone: a clone of a draft corpus is MINTED', async () => {
    const draft = await createMemory('specs-draft', true);
    const clone = await resolvers.Mutation.cloneMemory(null, { ref: draft.id, targetUrn: `hrn:mem:${org.urn}:specs-clone` }, ctx());
    expect(await corpusState({ id: clone.id })).toBe('MINTED');
    expect(await corpusState({ id: draft.id })).toBe('DRAFT');
  });
});

describe('draft corpus moves record no URN alias (#1448)', () => {
  it('records no alias for the root or descendants of a move inside a draft corpus', async () => {
    const draft = await createMemory('specs-draft', true);
    const root = await createNode(draft.id, 'pas:010');
    const child = await createNode(draft.id, 'pas:010:01');

    await resolvers.Mutation.moveNode(null, { sourceRef: root.id, targetUrn: nodeUrn(draft, 'pas:020') }, ctx());

    expect(await aliasesFor(root.id)).toEqual([]);
    expect(await aliasesFor(child.id)).toEqual([]);
    expect((await db.node.findUniqueOrThrow({ where: { id: child.id } })).loc).toBe('pas:020:01');
    // The draft number is simply gone; it does not resolve to the moved spec.
    await expect(resolveNodeRef(db, nodeUrn(draft, 'pas:010:01'))).rejects.toThrow();
  });

  it('lets two specs swap numbers without leaving an ambiguous or stale address', async () => {
    const draft = await createMemory('specs-draft', true);
    const a = await createNode(draft.id, 'pas:010:01');
    const b = await createNode(draft.id, 'pas:010:02');

    await resolvers.Mutation.moveNode(null, { sourceRef: a.id, targetUrn: nodeUrn(draft, 'pas:010:99') }, ctx());
    await resolvers.Mutation.moveNode(null, { sourceRef: b.id, targetUrn: nodeUrn(draft, 'pas:010:01') }, ctx());
    await resolvers.Mutation.moveNode(null, { sourceRef: a.id, targetUrn: nodeUrn(draft, 'pas:010:02') }, ctx());

    expect(await resolveNodeRef(db, nodeUrn(draft, 'pas:010:01'))).toEqual({ id: b.id });
    expect(await resolveNodeRef(db, nodeUrn(draft, 'pas:010:02'))).toEqual({ id: a.id });
    await expect(resolveNodeRef(db, nodeUrn(draft, 'pas:010:99'))).rejects.toThrow();
    expect(await db.urnAlias.count({ where: { entityType: 'NODE', entityId: { in: [a.id, b.id] } } })).toBe(0);
  });

  it('keys on the SOURCE memory: out of a draft records none, into a draft from a minted memory records one', async () => {
    const draft = await createMemory('specs-draft', true);
    const minted = await createMemory('specs');

    const leaving = await createNode(draft.id, 'pas:030');
    await resolvers.Mutation.moveNode(null, { sourceRef: leaving.id, targetUrn: nodeUrn(minted, 'pas:030') }, ctx());
    expect(await aliasesFor(leaving.id)).toEqual([]);

    const arriving = await createNode(minted.id, 'cor:010');
    await resolvers.Mutation.moveNode(null, { sourceRef: arriving.id, targetUrn: nodeUrn(draft, 'cor:010') }, ctx());
    expect((await aliasesFor(arriving.id)).map((a) => a.urn)).toEqual([`${minted.urn}:cor:010`]);
    expect(await resolveNodeRef(db, nodeUrn(minted, 'cor:010'))).toEqual({ id: arriving.id });
  });

  it('still records aliases for moves inside an ordinary (minted) memory', async () => {
    const minted = await createMemory('specs');
    const node = await createNode(minted.id, 'cor:040:01');
    await resolvers.Mutation.moveNode(null, { sourceRef: node.id, targetUrn: nodeUrn(minted, 'cor:040:02') }, ctx());
    expect((await aliasesFor(node.id)).map((a) => a.urn)).toEqual([`${minted.urn}:cor:040:01`]);
  });
});
