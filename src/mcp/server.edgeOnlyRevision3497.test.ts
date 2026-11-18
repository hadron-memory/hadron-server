/** #3497: registered MCP inline writer keeps edge-only current tokens reusable. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { createTestableMcpServer } from './server.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
let userId:string,memoryId:string,source:any,a:any,b:any;
const ctx=():Context=>({db,userId,roles:['ADMIN']});
const mcp=()=>createTestableMcpServer({userId,roles:['ADMIN'],clientId:`user:${userId}`});
const urn=(n:any)=>`hrn:node:edges3497-mcp.example:edges:${n.loc}`;
const edges=(n:any)=>[{targetUrn:urn(n),name:'uses'}];
async function state(){const row=await db.node.findUniqueOrThrow({where:{id:source.id}});return{revision:await resolvers.Node.revision(row as never,{},ctx()),count:await db.nodeRevision.count({where:{nodeId:source.id}}),edges:await db.edge.findMany({where:{sourceId:source.id,deletedAt:null},select:{targetId:true,name:true},orderBy:{targetId:'asc'}})};}
beforeEach(async()=>{
 await cleanDb(db);const org=await db.organization.create({data:{name:'MCP edges',urn:'edges3497-mcp.example'}});
 userId=(await db.user.create({data:{handle:'edges3497-mcp-admin',roles:['ADMIN']}})).id;
 await db.orgMember.create({data:{organizationId:org.id,userId,role:'ADMIN'}});
 memoryId=(await db.memory.create({data:{name:'Edges',urn:'edges3497-mcp.example:edges',class:'knowledge',organizationId:org.id}})).id;
 [source,a,b]=await Promise.all(['source','a','b'].map(loc=>(resolvers.Mutation as any).createNode(null,{input:{memoryId,loc,name:loc,content:'original'}},ctx())));
});
describe('#3497 MCP inline edges',()=>{
 it('changed and identical edge-only writes preserve revision/history',async()=>{
  const before=await state(),client=mcp();
  for(const e of [edges(a),edges(a),[]]){
   expect(await client.callToolText('hadron_update_node',{urn:urn(source),edges:e})).toContain('Node updated:');
   expect(await state()).toEqual({...before,edges:e.length?[{targetId:a.id,name:'uses'}]:[]});
  }
 });
 it('identical inline edges alone append no revision',async()=>{
  const client=mcp();expect(await client.callToolText('hadron_create_edge',{sourceUrn:urn(source),targetUrn:urn(a),name:'uses'})).toContain('Edge saved:');
  const before=await state();expect(await client.callToolText('hadron_update_node',{urn:urn(source),edges:edges(a)})).toContain('Node updated:');
  expect(await state()).toEqual(before);
 });
 it('reuses the current token for changed edges; stale token refuses with no writes',async()=>{
  const before=await state(),client=mcp();
  for(const target of [a,b]){
   expect(await client.callToolText('hadron_update_node',{urn:urn(source),expectedRevision:before.revision,edges:edges(target)})).toContain('Node updated:');
   expect(await state()).toEqual({...before,edges:[{targetId:target.id,name:'uses'}]});
  }
  expect(await client.callToolText('hadron_update_node',{urn:urn(source),content:'advance revision'})).toContain('Node updated:');
  const after=await state();expect(after.revision).toBe(before.revision+1);
  expect(await client.callToolText('hadron_update_node',{urn:urn(source),expectedRevision:before.revision,edges:edges(a)})).toMatch(/^\[node_write_conflict\]/);
  expect(await state()).toEqual(after);
 });
 it.each([false,true])('mixed scalar+edges appends exactly one revision (guarded=%s)',async guarded=>{
  const before=await state(),client=mcp();
  expect(await client.callToolText('hadron_update_node',{urn:urn(source),content:'changed',edges:edges(a),...(guarded?{expectedRevision:before.revision}:{})})).toContain('Node updated:');
  const after=await state();expect(after).toEqual({revision:before.revision+1,count:before.count+1,edges:[{targetId:a.id,name:'uses'}]});
  if(guarded){expect(await client.callToolText('hadron_update_node',{urn:urn(source),expectedRevision:before.revision,content:'stale',edges:edges(b)})).toMatch(/^\[node_write_conflict\]/);expect(await state()).toEqual(after);}
 });
 it('standalone MCP create edge remains revision-free',async()=>{
  const before=await state();expect(await mcp().callToolText('hadron_create_edge',{sourceUrn:urn(source),targetUrn:urn(a),name:'uses'})).toContain('Edge saved:');
  expect(await state()).toEqual({...before,edges:[{targetId:a.id,name:'uses'}]});
 });
});
