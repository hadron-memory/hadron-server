/** #3494: MCP forwards true/false/omitted; registered schema and text stay separate from timestamp projection. */
import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { createTestableMcpServer } from './server.js';
import { resolvers } from '../api/graphql/schema/resolvers.js';
vi.mock('../integrations/github/writeNodeToGit.js', () => ({writeNodeToGit:vi.fn().mockResolvedValue(undefined)}));
let memoryId:string, memoryUrn:string, userId:string, mcp:ReturnType<typeof createTestableMcpServer>;
beforeEach(async()=>{
 await cleanDb(db);
 const org=await db.organization.create({data:{name:'MCP grooming',urn:`mcp-groom-${generateId()}.test`}});
 userId=(await db.user.create({data:{handle:`mcp-groom-${generateId()}`}})).id;
 await db.orgMember.create({data:{organizationId:org.id,userId,role:'ADMIN'}});
 const memory=await resolvers.Mutation.createMemory(null,{orgId:org.id,name:'groom'}, {db,userId,roles:[]});memoryId=memory.id;memoryUrn=`hrn:mem:${memory.urn}`;
 for(const loc of ['open','closed','none']){
  const node=await db.node.create({data:{memoryId,loc,name:`mcpgroom ${loc}`,content:'mcpgroom'}});
  if(loc!=='none'){
   const c=await resolvers.Mutation.createComment(null,{targetRef:node.id,body:'feedback'},{db,userId,roles:[]});
   if(loc==='closed')await resolvers.Mutation.resolveCommentThread(null,{commentRef:c.id,expectedRevision:1},{db,userId,roles:[]});
  }
 }
 mcp=createTestableMcpServer({userId,roles:[],clientId:`user:${userId}`});
});
it('registered boolean, forwarding, same GraphQL sets and unchanged hit text (no timestamp)',async()=>{
 const shape=mcp.toolParamSchema('hadron_find_nodes','hasOpenThreads');
 expect(()=>shape.parse(true)).not.toThrow();expect(()=>shape.parse(false)).not.toThrow();expect(()=>shape.parse(undefined)).not.toThrow();expect(()=>shape.parse('true')).toThrow();
 for(const value of [true,false,undefined]){
  const gql=await resolvers.Query.findNodes(null,{query:'mcpgroom',mode:'keyword',filter:{memoryIds:[memoryId],hasOpenThreads:value}},{db,userId,roles:[]});
  const text=await mcp.callToolText('hadron_find_nodes',{memoryUrn,query:'mcpgroom',hasOpenThreads:value});
  for(const loc of ['open','closed','none']){
   const label=`:${loc}`;if(gql.hits.some(h=>(h.node as {loc:string}).loc===loc))expect(text).toContain(label);else expect(text).not.toContain(label);
  }
  expect(text).not.toContain('oldestOpenThreadAt');
 }
 const omitted=await mcp.callToolText('hadron_find_nodes',{memoryUrn,query:'mcpgroom'});
 const explicitUndefined=await mcp.callToolText('hadron_find_nodes',{memoryUrn,query:'mcpgroom',hasOpenThreads:undefined});
 expect(explicitUndefined).toBe(omitted);
});
