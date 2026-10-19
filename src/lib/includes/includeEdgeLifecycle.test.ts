/** #2040 S1 — the INCLUDE governed-edge lifecycle in the database (kind-aware triggers). */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let memoryId: string;
let admin: { id: string };
const as = (): Context => ({ db, userId: admin.id, roles: [] });
const node = (loc: string) => db.node.create({
  data: { id: generateId(), memoryId, loc, name: loc, abstract: loc, content: `Body ${loc}` },
});
const include = (sourceId: string, targetId: string, loc: string) => db.edge.create({
  data: { id: generateId(), memoryId, sourceId, targetId, loc, name: 'includes', governedKind: 'INCLUDE' },
});

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Inc Org', urn: 'inc.example' } });
  admin = await db.user.create({ data: { githubId: 204001, githubUsername: 'inc-admin', handle: 'inc-admin', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const m = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'inc' }, as());
  memoryId = m.id;
});

describe('INCLUDE governed edges (#2040)', () => {
  it('are inserted, deleted and replaced freely by the derived-edge sync', async () => {
    const a = await node('a'); const b = await node('b'); const c = await node('c');
    const e = await include(a.id, b.id, 'inc:a-b');
    await db.edge.delete({ where: { id: e.id } });
    await include(a.id, c.id, 'inc:a-c');
    expect(await db.edge.count({ where: { sourceId: a.id, governedKind: 'INCLUDE' } })).toBe(1);
  });

  it('cannot be rewritten in place or change kind', async () => {
    const a = await node('a'); const b = await node('b'); const c = await node('c');
    const e = await include(a.id, b.id, 'inc:a-b');
    await expect(db.edge.update({ where: { id: e.id }, data: { targetId: c.id } })).rejects.toThrow(/immutable/);
    await expect(db.edge.update({ where: { id: e.id }, data: { governedKind: null } })).rejects.toThrow(/immutable/);
    await expect(db.edge.update({ where: { id: e.id }, data: { governedKind: 'COMMENT_REPLY' } })).rejects.toThrow(/immutable/);
  });

  it('an ordinary edge cannot become governed', async () => {
    const a = await node('a'); const b = await node('b');
    const plain = await db.edge.create({ data: { id: generateId(), memoryId, sourceId: a.id, targetId: b.id, loc: 'e:plain', name: 'x' } });
    await expect(db.edge.update({ where: { id: plain.id }, data: { governedKind: 'INCLUDE' } })).rejects.toThrow(/immutable/);
  });

  it('does not count toward, or disturb, a comment\'s one-edge invariant', async () => {
    const target = await node('t'); const other = await node('o');
    const c = await (resolvers.Mutation as any).createComment(null, { targetRef: target.id, body: 'hi' }, as());
    await include(c.id, other.id, 'inc:c-o');
    await db.node.update({ where: { id: c.id }, data: { name: 'edited' } });
    const edge = await db.edge.findFirstOrThrow({ where: { sourceId: c.id, governedKind: 'COMMENT_ANCHOR' } });
    await expect(db.edge.delete({ where: { id: edge.id } })).rejects.toThrow(/removed only with its comment/);
  });

  it('keeps the memory CHECK: an INCLUDE edge carries no anchor columns', async () => {
    const a = await node('a'); const b = await node('b');
    await expect(db.edge.create({ data: { id: generateId(), memoryId, sourceId: a.id, targetId: b.id, loc: 'inc:x', name: 'includes', governedKind: 'INCLUDE', anchorRevNo: 1 } }))
      .rejects.toThrow(/chk_edges_governed_anchor/);
  });
});
