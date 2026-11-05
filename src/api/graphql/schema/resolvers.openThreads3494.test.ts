/** #3494: the same open-root state set must be filtered before candidate caps and counted once. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { postgresRetrievalProvider as provider } from '../../../lib/retrieval/postgres.js';
import { resolvers, type Context } from './resolvers.js';
import { openThreadCounts } from '../../../lib/comments/summary.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const Q = resolvers.Query as any, M = resolvers.Mutation as any;
let userId: string, otherId: string, memoryId: string;
const ctx = (id = userId): Context => ({ db, userId: id, roles: [] });
const create = (loc: string) => db.node.create({ data: { id: generateId(), memoryId, loc, name: `groommarker ${loc}`, content: 'groommarker', properties: { selected: true } } });
const comment = (targetRef: string, id = userId) => M.createComment(null, { targetRef, body: 'groommarker' }, ctx(id));
let nodes: Record<string, any>;
beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Groom', urn: `groom-${generateId()}.test` } });
  [userId, otherId] = await Promise.all([0, 1].map(async i => (await db.user.create({ data: { handle: `groom-${i}-${generateId()}` } })).id));
  await db.orgMember.createMany({ data: [userId, otherId].map(id => ({ organizationId: org.id, userId: id, role: 'ADMIN' as const })) });
  const mem = await M.createMemory(null, { orgId: org.id, name: 'groom' }, ctx()); memoryId = mem.id;
  nodes = Object.fromEntries(await Promise.all(['A','B','B2','C','D','E','F'].map(async k => [k, await create(`case:${k}`)])));
  await comment(nodes.A.id); await comment(nodes.A.id, otherId);
  for (const k of ['B','B2','F']) {
    const root = await comment(nodes[k].id);
    const resolved = await M.resolveCommentThread(null, { commentRef: root.id, expectedRevision: 1 }, ctx());
    if (k === 'B2') await M.replyToComment(null, { commentRef: root.id, body: 'groommarker' }, ctx());
    if (k === 'F') await M.reopenCommentThread(null, { commentRef: root.id, expectedRevision: resolved.revSeq }, ctx());
  }
  const stub = await comment(nodes.C.id); await M.replyToComment(null, { commentRef: stub.id, body: 'groommarker' }, ctx(otherId));
  await M.deleteComment(null, { commentRef: stub.id, expectedRevision: 1 }, ctx());
  const gone = await comment(nodes.D.id); await M.deleteComment(null, { commentRef: gone.id, expectedRevision: 1 }, ctx());
});
const variants: Array<[boolean | null | undefined, string[]]> = [[true,['A','F']],[false,['B','B2','C','D','E']],[null,['A','B','B2','C','D','E','F']],[undefined,['A','B','B2','C','D','E','F']]];
const filter = (value: boolean | null | undefined) => ({ memoryIds:[memoryId], locPrefix:'case:', hasOpenThreads:value });
const locs = (out: any) => out.hits.map((h: any) => h.node.loc.replace('case:','')).sort();
describe('open root state parity', () => {
  for (const [value, expected] of variants) for (const mode of [undefined,'keyword','regex','hybrid']) {
    it(`${String(value)} in ${mode ?? 'Prisma browse'}`, async () => {
      const out = await Q.findNodes(null, { filter:filter(value), ...(mode ? { mode, query:'groommarker' } : {}) }, ctx());
      expect(locs(out)).toEqual(expected);
    });
  }
  for (const [value, expected] of variants) {
    it(`${String(value)} directly in provider browse/count/keyword/regex, before hydration`, async () => {
      const f = { hasOpenThreads:value, locPrefix:'case:' } as any;
      const ids = new Set(expected.map(k => nodes[k].id));
      expect(new Set(await provider.filterSearch({ db, memoryIds:[memoryId], filter:f, limit:100 }))).toEqual(ids);
      expect(await provider.filterCount({ db, memoryIds:[memoryId], filter:f })).toBe(ids.size);
      for (const hits of [await provider.lexicalSearch({ db, memoryIds:[memoryId], filter:f, query:'groommarker', limit:100 }), await provider.regexSearch({ db, memoryIds:[memoryId], filter:f, pattern:'groommarker', limit:100 })]) expect(new Set(hits.map(h => h.nodeId))).toEqual(ids);
    });
  }
  it('SQL children/where browse and exact counts filter before offset/limit', async () => {
    const out = await Q.findNodes(null, { filter:{...filter(true), childrenOf:'case', where:{path:['selected'],eq:true}}, includeTotal:true, limit:1, offset:1 }, ctx());
    expect(locs(out)).toEqual(['F']); expect(out.total).toBe(2);
  });
  it('Comments scope true has no hits, false retains every live comment; ALL combines', async () => {
    const read = (value: boolean, scope: string) => Q.findNodes(null, {filter:{memoryIds:[memoryId],hasOpenThreads:value,contentScope:scope},limit:200},ctx());
    expect((await read(true,'COMMENTS')).hits).toHaveLength(0);
    const comments = await read(false,'COMMENTS'); expect(comments.hits.length).toBeGreaterThan(0);
    expect((await read(false,'ALL')).hits.length).toBe(comments.hits.length + 6); // five case nodes + memory root
  });
  for (const name of ['appNodes','appNodesPage']) for (const value of [true,false]) it(`${name} refuses ${value} before lookup`, async () => {
    const spy = vi.spyOn(db.app, 'findFirst');
    try { await expect(Q[name](null,{appRef:'not-an-app',filter:{hasOpenThreads:value}},ctx())).rejects.toMatchObject({extensions:{code:'BAD_USER_INPUT'}}); expect(spy).not.toHaveBeenCalled(); }
    finally { spy.mockRestore(); }
  });
  it('summary uses the earliest root creation and changes on resolution/deletion/reopen', async () => {
    const roots = await db.commentMeta.findMany({where:{targetNodeId:nodes.A.id,threadRootId:null},orderBy:{nodeId:'asc'}});
    const t1 = new Date('2026-01-01Z'), t2 = new Date('2026-02-01Z');
    await db.node.update({where:{id:roots[0].nodeId},data:{createdAt:t1}}); await db.node.update({where:{id:roots[1].nodeId},data:{createdAt:t2}});
    const summary = async () => (await openThreadCounts(db,[nodes.A.id])).get(nodes.A.id) as any;
    expect((await summary()).oldestOpenThreadAt).toEqual(t1);
    const r = await M.resolveCommentThread(null,{commentRef:roots[0].nodeId,expectedRevision:1},ctx());
    expect((await summary()).oldestOpenThreadAt).toEqual(t2);
    await M.replyToComment(null,{commentRef:roots[1].nodeId,body:'keep stub'},ctx());
    const author = roots[1].authorKey === `u:${otherId}` ? otherId : userId;
    await M.deleteComment(null,{commentRef:roots[1].nodeId,expectedRevision:1},ctx(author));
    expect((await summary()).oldestOpenThreadAt).toBeNull();
    await M.reopenCommentThread(null,{commentRef:roots[0].nodeId,expectedRevision:r.revSeq},ctx());
    expect((await summary()).oldestOpenThreadAt).toEqual(t1);
  });
});
