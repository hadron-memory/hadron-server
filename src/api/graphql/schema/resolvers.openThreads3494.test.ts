/** #3494: the same open-root state set must be filtered before candidate caps and counted once. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { postgresRetrievalProvider as provider } from '../../../lib/retrieval/postgres.js';
import { resolvers, type Context } from './resolvers.js';
import { randomUUID } from 'node:crypto';
import { setEmbeddingClientForTests, resetEmbeddingClientForTests } from '../../../lib/embedding/index.js';
import { embedNode } from '../../../jobs/embedNodes.js';
import { runContext } from '../../../jobs/appRunDeps.js';
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

afterEach(() => { resetEmbeddingClientForTests(); vi.unstubAllEnvs(); });
it('sparse browse counts and pages matches beyond the first 27 rows; absent count stays null', async () => {
  for(let i=0;i<30;i++) {const n=await create(`sparse:${String(i).padStart(3,'0')}`);if(i>=27)await comment(n.id);}
  const f={memoryIds:[memoryId],locPrefix:'sparse:',hasOpenThreads:true};
  const p1=await Q.findNodes(null,{filter:f,includeTotal:true,limit:2},ctx());
  const p2=await Q.findNodes(null,{filter:f,includeTotal:true,limit:2,offset:2},ctx());
  expect(p1.total).toBe(3);expect(p2.total).toBe(3);
  expect([...p1.hits,...p2.hits].map((h:any)=>h.node.loc)).toEqual(['sparse:027','sparse:028','sparse:029']);
  expect((await Q.findNodes(null,{filter:f,limit:2},ctx())).total).toBeNull();
});
it('ANDs role/prefix/direct-child/type/runnability and preserves SYSTEM memory exclusion', async () => {
  await db.node.update({where:{id:nodes.A.id},data:{role:'process.groom',isRunnable:true,nodeType:'task'}});
  const base={...filter(true),role:'process',nodeTypes:['task'],isRunnable:true,childrenOf:'case',locPrefix:'case:A'};
  expect(locs(await Q.findNodes(null,{filter:base},ctx()))).toEqual(['A']);
  expect(locs(await Q.findNodes(null,{filter:{...base,role:'other'}},ctx()))).toEqual([]);
  const mem=await db.memory.findUniqueOrThrow({where:{id:memoryId}});
  const sys=await db.memory.create({data:{class:'system',organizationId:mem.organizationId,name:'boot',urn:`boot-${generateId()}.test`}});
  await db.agent.create({data:{id:generateId(),organizationId:mem.organizationId,name:'boot agent',urn:`boot-agent-${generateId()}.test`,systemMemoryId:sys.id,visibility:'ORGANIZATION'}});
  const boot=await db.node.create({data:{memoryId:sys.id,loc:'boot:source',name:'boot',role:'boot-prompt'}});
  await comment(boot.id);
  const f={role:'boot-prompt',hasOpenThreads:true};
  expect((await Q.findNodes(null,{filter:f},ctx())).hits.map((h:any)=>h.node.id)).not.toContain(boot.id);
  expect((await Q.findNodes(null,{filter:{...f,memoryClasses:['system']}},ctx())).hits.map((h:any)=>h.node.id)).toEqual([boot.id]);
});
it('outsider, App key and a real persisted run never discover or count another tenant', async () => {
  const out=await db.user.create({data:{handle:`outsider-${generateId()}`}});
  const org=await db.organization.create({data:{name:'elsewhere',urn:`elsewhere-${generateId()}.test`}});
  const {app}=await createDbAppWithKey(db,'elsewhere',org.id);
  const run=await db.appRun.create({data:{id:generateId(),organizationId:org.id,appId:app.id,triggerKind:'SCHEDULE',triggerId:generateId(),entryNodeUrn:'hrn:node:elsewhere.test:missing:entry',status:'RUNNING'}});
  for(const principal of [ctx(out.id),{db,appId:app.id,roles:[],organizationId:org.id}, {...runContext(db,run),db}]) {
    const result=await Q.findNodes(null,{filter:filter(true),includeTotal:true},principal);
    expect(result.hits).toEqual([]);expect(result.total).toBe(0);
  }
});
it('expansion preserves candidate-only filters as context but rejects the wrong thread flag', async () => {
  await db.node.update({where:{id:nodes.A.id},data:{name:'uniquegroomseed',role:'process.groom'}});
  await db.node.update({where:{id:nodes.F.id},data:{role:'other.context'}});
  for(const k of ['F','E'])await db.edge.create({data:{memoryId,sourceId:nodes.A.id,targetId:nodes[k].id,name:'near',loc:`edge:${k}`}});
  for(const mode of ['keyword','hybrid']) {
    const out=await Q.findNodes(null,{query:'uniquegroomseed',mode,expand:1,includeTotal:true,filter:{...filter(true),locPrefix:'case:A',role:'process.groom'}},ctx());
    // F fails the candidate role and prefix, but is retained as unscored context. E has no open thread.
    expect(locs(out)).toEqual(['A','F']);expect(out.total).toBeNull();
  }
});
it('true/false root filtering is inside BOTH real vector/chunk candidate windows and hybrid fusion', async () => {
  vi.stubEnv('EMBEDDING_API_URL','http://synthetic.invalid');
  setEmbeddingClientForTests({provider:'test',model:'open-thread-fixture',dim:768,async embed(texts:string[]){return texts.map(()=>[1,...Array(767).fill(0)]);}});
  await db.memory.update({where:{id:memoryId},data:{vectorIndexEnabled:true,embeddingSource:'contentChunks'}});
  for(const n of Object.values(nodes)) {
    await db.node.update({where:{id:n.id},data:{embeddingWorkToken:randomUUID(),embeddingPendingAt:new Date()}});
    expect(await embedNode(db,n.id)).toBe('embedded');
  }
  const vec=[1,...Array(767).fill(0)];
  for(const value of [true,false]){
   const options={db,memoryIds:[memoryId],queryEmbedding:vec,limit:100,hasOpenThreads:value,syntheticCommentMemoryIds:[memoryId]};
   const expected=value?new Set():new Set(Object.values(nodes).map(n=>n.id));
   expect(new Set((await provider.vectorSearch(options)).map(h=>h.nodeId))).toEqual(expected);
   expect(new Set((await provider.vectorSearchChunks(options)).map(h=>h.nodeId))).toEqual(expected);
  }

  for(const [value,expected] of variants) {
    const ids=new Set(expected.map(k=>nodes[k].id));
    // Direct provider pins distinguish pre-window SQL from resolver hydration.
    expect(new Set((await provider.vectorSearch({db,memoryIds:[memoryId],queryEmbedding:vec,limit:100,hasOpenThreads:value} as any)).map(h=>h.nodeId))).toEqual(ids);
    expect(new Set((await provider.vectorSearchChunks({db,memoryIds:[memoryId],queryEmbedding:vec,limit:100,hasOpenThreads:value} as any)).map(h=>h.nodeId))).toEqual(ids);
    for(const mode of ['vector','hybrid'])expect(locs(await Q.findNodes(null,{query:'groommarker',mode,filter:filter(value),limit:100},ctx()))).toEqual(expected);
    const chunks=await Q.findNodes(null,{query:'groommarker',mode:'vector',granularity:'chunk',filter:filter(value),limit:100},ctx());
    expect(new Set(chunks.passages.map((p:any)=>p.parentNodeId))).toEqual(ids);
  }
});
it('ordinary org reader sees the same live thread set and summary, without platform privileges', async()=>{
 const mem=await db.memory.findUniqueOrThrow({where:{id:memoryId}});
 const reader=await db.user.create({data:{handle:`groom-reader-${generateId()}`}});
 await db.orgMember.create({data:{organizationId:mem.organizationId!,userId:reader.id,role:'READER'}});
 const result=await Q.findNodes(null,{filter:filter(true),includeTotal:true},ctx(reader.id));
 expect(locs(result)).toEqual(['A','F']);expect(result.total).toBe(2);
 const summary=await (resolvers.Node as any).commentSummary(nodes.A,{},ctx(reader.id));
 expect(summary.openThreads).toBe(2);expect(summary.oldestOpenThreadAt).toBeInstanceOf(Date);expect(summary.viewerOpenThreadId).toBeNull();
});
it('equal creation times stay exact, while replies and edits never move oldest root time',async()=>{
 const roots=await db.commentMeta.findMany({where:{targetNodeId:nodes.A.id,threadRootId:null}});
 const time=new Date('2026-03-01T00:00:00.123Z');
 await db.node.updateMany({where:{id:{in:roots.map(r=>r.nodeId)},memoryId},data:{createdAt:time}});
 const root=roots[0];const id=root.authorKey===`u:${otherId}`?otherId:userId;
 await M.replyToComment(null,{commentRef:root.nodeId,body:'new reply'},ctx(id));
 await M.editComment(null,{commentRef:root.nodeId,body:'new text',expectedRevision:1},ctx(id));
 const summary=(await openThreadCounts(db,[nodes.A.id,nodes.E.id]));
 expect(summary.get(nodes.A.id)).toMatchObject({openThreads:2,resolvedThreads:0,comments:3,oldestOpenThreadAt:time});
 expect(summary.has(nodes.E.id)).toBe(false);
 const noComments=await (resolvers.Node as any).commentSummary(nodes.E,{},ctx());
 expect(noComments).toEqual({openThreads:0,resolvedThreads:0,comments:0,viewerOpenThreadId:null,oldestOpenThreadAt:null});
});
it('summary aggregate is one query for hundreds of targets and exposes minimum, not per-hit reads', async () => {
  const targets=await db.node.createManyAndReturn({data:Array.from({length:240},(_,i)=>({id:generateId(),memoryId,loc:`batch:${i}`,name:'batch'})),select:{id:true}});
  await comment(targets[239].id);
  const spy=vi.spyOn(db,'$queryRaw');
  try { const summaries=await openThreadCounts(db,targets.map(n=>n.id));expect(spy).toHaveBeenCalledTimes(1);expect(summaries.size).toBe(1);expect(summaries.get(targets[239].id)?.openThreads).toBe(1); }
  finally{spy.mockRestore();}
});
it('soft-deleted complete thread directly in provider never counts as open', async()=>{
 const target=await create('deleted-whole');const root=await comment(target.id);
 await M.deleteCommentThread(null,{commentRef:root.id,reason:'test whole deletion'},ctx());
 const meta=await db.commentMeta.findUniqueOrThrow({where:{nodeId:root.id},include:{node:true}});
 expect(meta.retractedAt).toBeNull();expect(meta.threadState).toBe('OPEN');expect(meta.node.deletedAt).not.toBeNull();
 for(const value of [true,false]){
  const filter={locPrefix:'deleted-whole',hasOpenThreads:value};
  expect(await provider.filterSearch({db,memoryIds:[memoryId],filter,limit:100})).toEqual(value?[]:[target.id]);
  expect(await provider.filterCount({db,memoryIds:[memoryId],filter})).toBe(value?0:1);
 }
});
it('omitted and null filters preserve the entire ordinary GraphQL result byte for byte',async()=>{
 const args={query:'groommarker',mode:'keyword' as const,filter:{memoryIds:[memoryId]}};
 const omitted=await Q.findNodes(null,args,ctx());
 const nulled=await Q.findNodes(null,{...args,filter:{...args.filter,hasOpenThreads:null}},ctx());
 expect(JSON.stringify(nulled)).toBe(JSON.stringify(omitted));
});

it('appNodes and appNodesPage keep omitted/null behavior on an actual installed memory', async()=>{
 const memory=await db.memory.findUniqueOrThrow({where:{id:memoryId}});
 const {app}=await createDbAppWithKey(db,'groom-app',memory.organizationId!);
 const agent=await db.agent.create({data:{organizationId:memory.organizationId!,name:'Groom agent',urn:`groom-agent-${generateId()}.test`}});
 await db.appAgent.create({data:{appId:app.id,agentId:agent.id}});
 await db.agentMemoryItem.create({data:{agentId:agent.id,memoryId,role:'read-write'}});
 for(const name of ['appNodes','appNodesPage']){
  const omitted=await Q[name](null,{appRef:app.id},ctx());
  const nulled=await Q[name](null,{appRef:app.id,filter:{hasOpenThreads:null}},ctx());
  expect(JSON.stringify(nulled)).toBe(JSON.stringify(omitted));
 }
});
