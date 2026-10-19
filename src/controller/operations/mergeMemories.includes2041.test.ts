/**
 * #2041 D5 (cor:dmo:150:04) — a merge cannot carry an include its merger can't
 * read. RED-FIRST: written ahead of the implementation; the refusal cases fail
 * on main, the authorized control passes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { mergeMemoryGraph } from './mergeMemories.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let admin: { id: string };
let stranger: { id: string };
let src: { id: string; urn: string };
let dst: { id: string; urn: string };
let readableMem: { id: string; urn: string };
let hiddenMem: { id: string; urn: string };

const as = (userId: string): Context => ({ db, userId, roles: [] });
const errorOf = async (p: Promise<unknown>): Promise<GraphQLError> => {
  try { await p; } catch (e) { return e as GraphQLError; }
  throw new Error('expected a refusal');
};
const node = (memoryId: string, id: string, loc: string, content: string) =>
  db.node.create({ data: { id, memoryId, loc, name: `Title ${loc}`, content } });
const merge = (batchSize = 1) => mergeMemoryGraph(db, {
  sourceMemoryId: src.id, targetMemoryId: dst.id, fields: new Set(['CONTENT']),
  deleteSourceMem: false, editor: { userId: admin.id, info: null, workerId: null, agentId: null } as never,
  principal: as(admin.id), batchSize, classifyPageSize: 1,
});
const live = (memoryId: string) => db.node.count({ where: { memoryId, deletedAt: null, nodeType: { not: 'comment' } } });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'D5 Org', urn: 'd5.example' } });
  const other = await db.organization.create({ data: { id: generateId(), name: 'D5 Other', urn: 'd5other.example' } });
  admin = await db.user.create({ data: { githubId: 204101, githubUsername: 'd5-admin', handle: 'd5-admin', roles: [] } });
  stranger = await db.user.create({ data: { githubId: 204102, githubUsername: 'd5-stranger', handle: 'd5-stranger', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: other.id, userId: stranger.id, role: 'ADMIN' } });
  src = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'd5-src' }, as(admin.id));
  dst = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'd5-dst' }, as(admin.id));
  readableMem = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'd5-readable' }, as(admin.id));
  hiddenMem = await resolvers.Mutation.createMemory(null, { orgId: other.id, name: 'd5-hidden' }, as(stranger.id));
  await node(readableMem.id, generateId(), 'ok', 'readable body');
  await node(hiddenMem.id, generateId(), 'secret', 'hidden body');
});

describe('#2041 D5 — mergeMemories include read check', () => {
  it('control: an include the merger can read merges', async () => {
    await node(src.id, generateId(), 'page', `see {{> ${readableMem.urn}:ok }}`);
    await merge();
    expect(await db.node.count({ where: { memoryId: dst.id, loc: 'page', deletedAt: null } })).toBe(1);
  });

  it('preflight: an unreadable URN include refuses uniformly and nothing moves', async () => {
    await node(src.id, '00000000000000000000000000000001', 'a', 'plain');
    await node(src.id, 'ffffffffffffffffffffffffffffff09', 'page', `see {{> ${hiddenMem.urn}:secret }}`);
    const before = await live(src.id);
    const e = await errorOf(merge());
    expect(e.extensions).toMatchObject({ code: 'INCLUDE_TARGET_UNAVAILABLE' });
    expect(e.extensions.partialMerge).toBeUndefined();
    expect(await live(src.id)).toBe(before);
    expect(await live(dst.id)).toBe(1); // only the target's own root
  });

  it('drift: a target made unreadable after the preflight is refused by the batch that carries it', async () => {
    await node(src.id, '00000000000000000000000000000001', 'a', 'plain');
    await node(src.id, 'ffffffffffffffffffffffffffffff09', 'page', `see {{> ${readableMem.urn}:ok }}`);
    const before = await live(src.id);
    const transaction = db.$transaction.bind(db);
    let moved = false;
    const spy = vi.spyOn(db, '$transaction').mockImplementation((async (...args: unknown[]) => {
      if (!moved && (await live(src.id)) === 1) {
        moved = true; // the first batch committed: hide the target before the next one
        await db.memory.update({ where: { id: readableMem.id }, data: { organizationId: (await db.organization.findFirstOrThrow({ where: { urn: 'd5other.example' } })).id } });
      }
      return (transaction as (...a: unknown[]) => unknown)(...args);
    }) as never);
    let e: GraphQLError;
    try { e = await errorOf(merge()); } finally { spy.mockRestore(); }
    expect(e.extensions).toMatchObject({
      code: 'INCLUDE_TARGET_UNAVAILABLE',
      partialMerge: { applied: true, relocated: before - 1, remainingSourceNodes: 1, sourceIntact: true },
    });
    expect(await db.node.count({ where: { memoryId: dst.id, loc: 'page' } })).toBe(0);
  });

  it('fold: content folded into a target counterpart is checked too', async () => {
    await node(src.id, generateId(), 'page', `see {{> ${hiddenMem.urn}:secret }}`);
    await node(dst.id, generateId(), 'page', 'target body');
    const e = await errorOf(merge());
    expect(e.extensions).toMatchObject({ code: 'INCLUDE_TARGET_UNAVAILABLE' });
    expect((await db.node.findFirstOrThrow({ where: { memoryId: dst.id, loc: 'page' } })).content).toBe('target body');
  });

  it('retry control: after the drift refusal, restoring readability and re-running finishes the merge', async () => {
    await node(src.id, '00000000000000000000000000000001', 'a', 'plain');
    await node(src.id, 'ffffffffffffffffffffffffffffff09', 'page', `see {{> ${readableMem.urn}:ok }}`);
    const orgId = (await db.memory.findUniqueOrThrow({ where: { id: readableMem.id } })).organizationId!;
    const otherId = (await db.organization.findFirstOrThrow({ where: { urn: 'd5other.example' } })).id;
    const transaction = db.$transaction.bind(db);
    let moved = false;
    const spy = vi.spyOn(db, '$transaction').mockImplementation((async (...args: unknown[]) => {
      if (!moved && (await live(src.id)) === 1) {
        moved = true;
        await db.memory.update({ where: { id: readableMem.id }, data: { organizationId: otherId } });
      }
      return (transaction as (...a: unknown[]) => unknown)(...args);
    }) as never);
    try { await errorOf(merge()); } finally { spy.mockRestore(); }
    await db.memory.update({ where: { id: readableMem.id }, data: { organizationId: orgId } });
    await merge();
    expect(await live(src.id)).toBe(0);
    expect(await db.node.count({ where: { memoryId: dst.id, loc: 'page', deletedAt: null } })).toBe(1);
  });

  it('a relative include whose loc relocates in the same merge is not refused (judged against the destination)', async () => {
    await node(src.id, generateId(), 'intro', 'intro body');
    await node(src.id, generateId(), 'page', 'see {{> intro }}');
    await merge();
    expect(await db.node.count({ where: { memoryId: dst.id, loc: { in: ['intro', 'page'] }, deletedAt: null } })).toBe(2);
  });
});
