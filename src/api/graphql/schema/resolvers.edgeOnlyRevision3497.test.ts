/** #3497 / cor:dmo:060:04 / rulings0149+0198: edges are not node revision state. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
let userId: string, memoryId: string, source: any, a: any, b: any;
const ctx = (): Context => ({ db, userId, roles: ['ADMIN'] });
const edges = (target: any) => [{ targetId: target.id, name: 'uses' }];
const update = (input: Record<string, unknown>) => M.updateNode(null, { input: { id: source.id, ...input } }, ctx());
async function state() {
 const row = await db.node.findUniqueOrThrow({ where: { id: source.id } });
 return { revision: await resolvers.Node.revision(row as never, {}, ctx()), count: await db.nodeRevision.count({ where: { nodeId: source.id } }),
  edges: await db.edge.findMany({where:{sourceId:source.id,deletedAt:null},select:{targetId:true,name:true},orderBy:{targetId:'asc'}}) };
}
beforeEach(async () => {
 await cleanDb(db);
 const org=await db.organization.create({data:{name:'Edge revision',urn:'edges3497.example'}});
 userId=(await db.user.create({data:{handle:'edges3497-admin',roles:['ADMIN']}})).id;
 await db.orgMember.create({data:{organizationId:org.id,userId,role:'ADMIN'}});
 memoryId=(await db.memory.create({data:{name:'Edges',urn:'edges3497.example:edges',class:'knowledge',organizationId:org.id}})).id;
 [source,a,b]=await Promise.all(['source','a','b'].map(loc=>M.createNode(null,{input:{memoryId,loc,name:loc,content:'original'}},ctx())));
});
describe('#3497 GraphQL inline edges', () => {
 it('changed and identical edge-only writes preserve the exposed revision and history', async () => {
  const before=await state();
  await update({edges:edges(a)});
  expect(await state()).toEqual({...before,edges:[{targetId:a.id,name:'uses'}]});
  await update({edges:edges(a)});
  expect(await state()).toEqual({...before,edges:[{targetId:a.id,name:'uses'}]});
  await update({edges:[]});
  expect(await state()).toEqual(before);
 });
 it('identical inline edges alone append no revision',async()=>{
  await M.createEdge(null,{sourceRef:source.id,targetRef:a.id,name:'uses'},ctx());
  const before=await state();await update({edges:edges(a)});expect(await state()).toEqual(before);
 });
 it('current token is reusable for changed edge sets, stale token writes nothing', async () => {
  const before=await state(); const token=before.revision;
  await update({expectedRevision:token,edges:edges(a)});
  expect(await state()).toEqual({...before,edges:[{targetId:a.id,name:'uses'}]});
  await update({expectedRevision:token,edges:edges(b)});
  expect(await state()).toEqual({...before,edges:[{targetId:b.id,name:'uses'}]});
  await update({content:'advance revision'}); const after=await state();
  expect(after.revision).toBe(token+1);
  await expect(update({expectedRevision:token,edges:edges(a)})).rejects.toMatchObject({extensions:{code:'NODE_WRITE_CONFLICT'}});
  expect(await state()).toEqual(after);
 });
 it.each([false,true])('mixed scalar+edges appends exactly one revision (guarded=%s)',async guarded=>{
  const before=await state();
  await update({content:'changed',edges:edges(a),...(guarded?{expectedRevision:before.revision}:{})});
  const after=await state();expect(after).toEqual({revision:before.revision+1,count:before.count+1,edges:[{targetId:a.id,name:'uses'}]});
  if(guarded){await expect(update({expectedRevision:before.revision,content:'stale',edges:edges(b)})).rejects.toMatchObject({extensions:{code:'NODE_WRITE_CONFLICT'}});expect(await state()).toEqual(after);}
 });
 it('guarded ownerRepo-only change still consumes the token',async()=>{
  const before=await state();await update({expectedRevision:before.revision,ownerRepo:'example/repo'});
  expect(await state()).toEqual({...before,revision:before.revision+1,count:before.count+1});
  await expect(update({expectedRevision:before.revision,ownerRepo:'example/other'})).rejects.toMatchObject({extensions:{code:'NODE_WRITE_CONFLICT'}});
 });
 it('standalone create/update/delete edges remain revision-free',async()=>{
  const before=await state();
  const e=await M.createEdge(null,{sourceRef:source.id,targetRef:a.id,name:'uses'},ctx());
  expect(await state()).toEqual({...before,edges:[{targetId:a.id,name:'uses'}]});
  await M.updateEdge(null,{edgeRef:e.id,name:'needs'},ctx());
  expect(await state()).toEqual({...before,edges:[{targetId:a.id,name:'needs'}]});
  await M.deleteEdge(null,{edgeRef:e.id},ctx());expect(await state()).toEqual(before);
 });
});
