/** #1178: allocateSpecNode mints-or-refuses the next citation server-side. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { safeNodeUrnV2 } from './urnEmit.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/mirrorNodeMove.js', () => ({
  mirrorNodeMoveToGit: vi.fn().mockResolvedValue(undefined),
}));

let admin: { id: string };
let reader: { id: string };
let outsider: { id: string };
let org: { id: string };
let mem: { id: string; urn: string };

const as = (userId: string): Context => ({ db, userId, roles: [] });
const allocate = (parentLoc: string, extra: Record<string, unknown> = {}, userId = admin.id, memoryRef = mem.id) =>
  resolvers.Mutation.allocateSpecNode(null, { memoryRef, parentLoc, ...extra } as never, as(userId));
const reserve = (loc: string) =>
  resolvers.Mutation.reserveSpecCitation(null, { memoryRef: mem.id, loc }, as(admin.id));
const codeOf = async (p: Promise<unknown>) => {
  try { await p; return 'NO_ERROR'; } catch (e) {
    return e instanceof GraphQLError ? String(e.extensions.code) : (e as Error).name;
  }
};
const mk = (loc: string, extra: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId: mem.id, loc, name: loc, role: 'spec', nodeType: 'info', ...extra } as never });
const minted = { mintedAt: new Date(), mintedByInfo: 'test' };
const locsUnder = async (prefix: string) =>
  (await db.node.findMany({ where: { memoryId: mem.id, loc: { startsWith: prefix }, deletedAt: null }, select: { loc: true }, orderBy: { loc: 'asc' } })).map((n) => n.loc);

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'Alloc Org', urn: 'alloc.example' } });
  admin = await db.user.create({ data: { githubId: 178001, githubUsername: 'alloc-admin', roles: [] } });
  reader = await db.user.create({ data: { githubId: 178002, githubUsername: 'alloc-reader', roles: [] } });
  outsider = await db.user.create({ data: { githubId: 178003, githubUsername: 'alloc-outsider', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: reader.id, role: 'READER' } });
  mem = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'specs' }, as(admin.id));
  await mk('cor');
  await mk('cor:dmo');
  await mk('cor:dmo:060');
});

describe('allocateSpecNode (#1178)', () => {
  it('reserves the next number as a placeholder spec node, by the grammar', async () => {
    const first = await allocate('cor:dmo:060');
    expect(first).toMatchObject({ loc: 'cor:dmo:060:01', isPlaceholder: true });
    expect(await db.node.findFirstOrThrow({ where: { memoryId: mem.id, loc: 'cor:dmo:060:01' } })).toMatchObject({
      role: 'spec', nodeType: 'info', isPlaceholder: true, content: null, mintedAt: null,
    });
    expect((await allocate('cor:dmo:060', { name: 'Consent' }))).toMatchObject({ loc: 'cor:dmo:060:02', name: 'Consent' });
    expect((await allocate('cor:dmo')).loc).toBe('cor:dmo:010');
    expect((await allocate('cor:dmo')).loc).toBe('cor:dmo:020');
  });

  it('allocates a flow under a rule and refuses below it', async () => {
    await mk('cor:dmo:060:15');
    expect((await allocate('cor:dmo:060:15')).loc).toBe('cor:dmo:060:15:01');
    expect(await codeOf(allocate('cor:dmo:060:15:01'))).toBe('SPEC_PARENT_NOT_NUMBERED');
  });

  it('parallel allocations all succeed with distinct consecutive numbers, overwriting nothing', async () => {
    await mk('cor:dmo:060:01', { content: 'KEEP ME', ...minted });
    const got = await Promise.all(Array.from({ length: 8 }, (_, i) => allocate('cor:dmo:060', { name: `N${i}` })));
    expect(got.map((n) => n.loc).sort()).toEqual(Array.from({ length: 8 }, (_, i) => `cor:dmo:060:0${i + 2}`));
    expect(await db.node.findFirstOrThrow({ where: { memoryId: mem.id, loc: 'cor:dmo:060:01' } })).toMatchObject({ content: 'KEEP ME' });
    for (const n of got) expect((await db.node.findFirstOrThrow({ where: { memoryId: mem.id, loc: n.loc } })).name).toBe(n.name);
  });

  it('never reuses a minted number whose node was soft-deleted', async () => {
    await mk('cor:dmo:060:07', { ...minted, deletedAt: new Date() });
    expect((await allocate('cor:dmo:060')).loc).toBe('cor:dmo:060:08');
    expect(await db.node.findFirstOrThrow({ where: { memoryId: mem.id, loc: 'cor:dmo:060:07' } })).toMatchObject({ deletedAt: expect.any(Date) });
  });

  it('counts an archived __deleted-<id> minted sibling toward the floor', async () => {
    await mk('cor:dmo:060:09__deleted-abc123', { ...minted, deletedAt: new Date() });
    expect((await allocate('cor:dmo:060')).loc).toBe('cor:dmo:060:10');
  });

  it('never produces the number of a minted node moved out (alias, no node at the loc)', async () => {
    const moved = await mk('cor:dmo:070:01', minted);
    await db.urnAlias.create({ data: {
      id: generateId(), urn: safeNodeUrnV2(mem.urn, 'cor:dmo:060:05').slice('hrn:node:'.length),
      entityType: 'NODE', entityId: moved.id, reason: 'RENAME',
    } });
    expect((await allocate('cor:dmo:060')).loc).toBe('cor:dmo:060:06');
  });

  it('skips an unminted soft-deleted loc above the minted floor, never resurrecting it', async () => {
    await mk('cor:dmo:060:03', minted);
    const draft = await mk('cor:dmo:060:04', { content: 'old draft', deletedAt: new Date() });
    expect((await allocate('cor:dmo:060')).loc).toBe('cor:dmo:060:05');
    expect(await db.node.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({ content: 'old draft', deletedAt: expect.any(Date) });
  });

  it('never produces the number of a live placeholder or live unminted node', async () => {
    await mk('cor:dmo:060:03', minted);
    await mk('cor:dmo:060:04', { content: 'draft' });
    await mk('cor:dmo:060:05', { isPlaceholder: true });
    expect((await allocate('cor:dmo:060')).loc).toBe('cor:dmo:060:06');
  });

  it('honours the after floor strictly, the feature grid and the rule-00 exclusion', async () => {
    expect((await allocate('cor:dmo:060', { after: 12 })).loc).toBe('cor:dmo:060:13');
    expect((await allocate('cor:dmo', { after: 15 })).loc).toBe('cor:dmo:020');
    expect(await locsUnder('cor:dmo:060:00')).toEqual([]);
    expect(await codeOf(allocate('cor:dmo:060', { after: -1 }))).toBe('BAD_USER_INPUT');
  });

  it('refuses SPEC_NUMBER_SPACE_EXHAUSTED and writes nothing', async () => {
    await mk('cor:dmo:060:99', minted);
    const before = await db.node.count({ where: { memoryId: mem.id } });
    expect(await codeOf(allocate('cor:dmo:060'))).toBe('SPEC_NUMBER_SPACE_EXHAUSTED');
    expect(await db.node.count({ where: { memoryId: mem.id } })).toBe(before);
  });

  it('refuses a missing parent, a deleted parent and a product root', async () => {
    expect(await codeOf(allocate('cor:dmo:080'))).toBe('SPEC_PARENT_NOT_FOUND');
    await mk('cor:dmo:090', { deletedAt: new Date() });
    expect(await codeOf(allocate('cor:dmo:090'))).toBe('SPEC_PARENT_NOT_FOUND');
    expect(await codeOf(allocate('cor'))).toBe('SPEC_PARENT_NOT_NUMBERED');
  });

  it('answers a caller who cannot read the memory as not found, taking no lock and writing nothing', async () => {
    const tx = vi.spyOn(db, '$transaction');
    const unreadable = await codeOf(allocate('cor:dmo:060', {}, outsider.id));
    const missing = await codeOf(allocate('cor:dmo:060', {}, outsider.id, generateId()));
    expect(unreadable).not.toBe('NO_ERROR');
    expect(unreadable).toBe(missing);
    expect(tx).not.toHaveBeenCalled();
    tx.mockRestore();
    expect(await locsUnder('cor:dmo:060:')).toEqual([]);
  });

  it('refuses a reader who has no write access', async () => {
    expect(await codeOf(allocate('cor:dmo:060', {}, reader.id))).not.toBe('NO_ERROR');
    expect(await locsUnder('cor:dmo:060:')).toEqual([]);
  });

  it('a racing reserveSpecCitation at the next loc never overwrites: one wins, the other conflicts or moves on', async () => {
    const [allocated, reservedCode] = await Promise.all([allocate('cor:dmo:060', { name: 'ALLOCATED' }), codeOf(reserve('cor:dmo:060:01'))]);
    const first = await db.node.findFirstOrThrow({ where: { memoryId: mem.id, loc: 'cor:dmo:060:01' } });
    if (allocated.loc === 'cor:dmo:060:01') {
      expect(reservedCode).toBe('NodeLocConflictError');
      expect(first.name).toBe('ALLOCATED');
    } else {
      expect(reservedCode).toBe('NO_ERROR');
      expect(allocated.loc).toBe('cor:dmo:060:02');
      expect(first.name).toBe('cor:dmo:060:01');
    }
  });
});
