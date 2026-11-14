import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildSchema, parse, validate } from 'graphql';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { listPolls } from '../../../lib/webfetchClient.js';
vi.mock('../../../lib/webfetchClient.js',()=>({listPolls:vi.fn(),cancelPoll:vi.fn(),fetchUrl:vi.fn(),httpRequest:vi.fn(),createPoll:vi.fn(),getPoll:vi.fn()}));
const Q=resolvers.Query as unknown as Record<string,(p:unknown,a:any,c:Context)=>Promise<any>>;
const N=(resolvers as unknown as {Node:typeof Q}).Node;
let orgId:string,userId:string,appId:string,runId:string,nodeId:string;
afterEach(()=>vi.useRealTimers());
const ctx=():Context=>({db,userId,roles:[]});
beforeEach(async()=>{
 await cleanDb(db); vi.clearAllMocks();vi.mocked(listPolls).mockResolvedValue({jobs:[]});
 const org=await db.organization.create({data:{name:'Paging',urn:'paging4123.example'}});orgId=org.id;
 userId=(await db.user.create({data:{email:'paging4123@example.test'}})).id;
 await db.orgMember.create({data:{organizationId:orgId,userId,role:'ADMIN'}});
 const app=await db.app.create({data:{organizationId:orgId,name:'Paging',urn:'paging4123.example:app'}});appId=app.id;
 const agent=await db.agent.create({data:{organizationId:orgId,name:'Paging',urn:'paging4123.example:agent',visibility:'ORGANIZATION'}});
 runId=(await db.appRun.create({data:{organizationId:orgId,appId,agentId:agent.id,triggerKind:'MANUAL',entryNodeUrn:'flow:start',status:'RUNNING'}})).id;
 const mem=await resolvers.Mutation.createMemory(null,{orgId,name:'Paging'},ctx());
 nodeId=(await db.node.create({data:{memoryId:mem.id,loc:'sign',name:'Sign'}})).id;
});
it('SDL preserves the portal page type and exposes distinct marketplace/page/cursor contracts',()=>{
 const schema=buildSchema(typeDefs);
 expect(schema.getType('MarketplaceResourcePage')).toBeDefined();expect(schema.getType('PublicResourceRefPage')).toBeUndefined();
 expect(validate(schema,parse('query { publicOrganization(ref:"x") { publicMemoriesPage { items { id } total hasMore } } }')).map(x=>x.message)).toEqual([]);
 const errors=validate(schema,parse('query { webPollsPage(orgRef:"x",first:20,after:null) { items { jobId } hasMore nextCursor } node(ref:"x") { signingRequestsPage(state:OPEN,first:20,after:null) { items { id } hasMore nextCursor } } }'));
 expect(errors.map(x=>x.message)).toEqual([]);
});
it('poll pages default to 20, continue without duplicates, clamp at cap, and retain legacy array shape',async()=>{
 const ids=Array.from({length:105},(_,i)=>`job-${String(i).padStart(3,'0')}`);
 await db.webFetchPollBinding.createMany({data:ids.map(jobId=>({jobId,sourceRunId:runId,organizationId:orgId,appId,entryNodeUrn:'flow:start',url:'https://example.test/watch'}))});
 vi.mocked(listPolls).mockResolvedValue({jobs:ids.toReversed().map(jobId=>({jobId,status:'active',expiresAt:'2030-01-01T00:00:00Z',triggerCount:0,consecutiveFailures:0}))});
 const a=await Q.webPollsPage(null,{orgRef:orgId},ctx());expect(a.items.map((x:any)=>x.jobId)).toEqual(ids.slice(0,20));expect(a.hasMore).toBe(true);expect(a.nextCursor).toEqual(expect.any(String));
 const b=await Q.webPollsPage(null,{orgRef:orgId,after:a.nextCursor},ctx());expect(b.items.map((x:any)=>x.jobId)).toEqual(ids.slice(20,40));
 expect((await Q.webPollsPage(null,{orgRef:orgId,first:10000},ctx())).items).toHaveLength(100);
 expect(await Q.webPolls(null,{orgRef:orgId},ctx())).toHaveLength(20);
 await expect(Q.webPollsPage(null,{orgRef:orgId,after:'garbage'},ctx())).rejects.toMatchObject({extensions:{code:'BAD_USER_INPUT'}});
});
it('poll authorization and policy run before the sidecar read on the new field',async()=>{
 const other=await db.user.create({data:{email:'other4123@example.test'}});
 await expect(Q.webPollsPage(null,{orgRef:orgId},{...ctx(),userId:other.id})).rejects.toThrow('Forbidden');expect(listPolls).not.toHaveBeenCalled();
 await db.organization.update({where:{id:orgId},data:{policy:{allow:[]}}});
 await expect(Q.webPollsPage(null,{orgRef:orgId},ctx())).rejects.toMatchObject({extensions:{code:'POLICY_DENIED'}});expect(listPolls).not.toHaveBeenCalled();
});
it('signing pages filter effective expiry before paging and continue through the rest',async()=>{
 const now=Date.now();
 const ids=Array.from({length:25},()=>generateId());
 await db.signingRequest.createMany({data:ids.map((id,i)=>({id,nodeId,revision:1,requesterUserId:userId,approvalHash:'a'.repeat(64),payloadVersion:'hadron-signature-v3',state:'open',createdAt:new Date(now-60000-i*1000),expiresAt:new Date(i%2===0?now+60000:now+3600000)}))});
 const ordered=await db.signingRequest.findMany({where:{nodeId},orderBy:[{createdAt:'desc'},{id:'desc'}]});
 const expired=new Set(ids.filter((_,i)=>i%2===0)); const expected=ordered.filter(x=>expired.has(x.id)).map(x=>x.id);
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(now+120000);
 const a=await N.signingRequestsPage({id:nodeId},{state:'EXPIRED',first:5},ctx());expect(a.items.map((x:any)=>x.id)).toEqual(expected.slice(0,5));expect(a.hasMore).toBe(true);
 const b=await N.signingRequestsPage({id:nodeId},{state:'EXPIRED',first:100,after:a.nextCursor},ctx());expect(b.items.map((x:any)=>x.id)).toEqual(expected.slice(5));expect(b.hasMore).toBe(false);expect(b.nextCursor).toBeNull();
 expect((await N.signingRequests({id:nodeId},{state:'EXPIRED',first:5,after:a.nextCursor},ctx()))).toHaveLength(5);
});
