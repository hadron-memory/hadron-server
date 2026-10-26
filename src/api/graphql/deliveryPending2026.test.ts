/** #2026: real authenticated HTTP + SDK responses count the pull's pre-cap admitted set, with no footer writes. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../server.js';
import { createMcpServerInstance, createTestableMcpServer } from '../../mcp/server.js';
import { resolvers } from './schema/resolvers.js';
import { currentActor, publishActor, publishAmbiguousActor, runAsActor } from '../../lib/requestActor.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../lib/workerSignature.js';
import { USER_API_KEY_PREFIX, hashUserApiKey } from '../../middleware/auth.js';
import { ensureChannelWithRoot } from '../../lib/channels.js';
import { appendChatMessage } from '../../lib/chatRoot.js';
import { getMemoryEncryptionInfo } from '../../lib/nodeCrypto.js';
import * as deliveryBatchModule from '../../lib/tickers/deliveryBatch.js';
import { deliveryPending, appendDeliveryPending } from '../../lib/tickers/deliveryPending.js';
import { loadDeliveryBatches } from '../../lib/tickers/deliveryBatch.js';
import { generateId } from '../../lib/id.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
let http: Server; let base: string;
let user: any; let app: any; let worker: any; let session: any; let key: any; let raw: string; let channel: any;
beforeAll(async () => {
 http=httpServer(await createServer()); await new Promise<void>(r=>http.listen(0,'127.0.0.1',r));
 base=`http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(async()=>{await new Promise<void>(r=>http.close(()=>r()));});
beforeEach(async()=>{
 await cleanDb(db);
 const org=await db.organization.create({data:{name:'Footer',urn:'footer2026'}});
 user=await db.user.create({data:{handle:'footer-kit',roles:['READER']}});
 await db.orgMember.create({data:{organizationId:org.id,userId:user.id,role:'ADMIN'}});
 const agent=await db.agent.create({data:{organizationId:org.id,name:'Agent',urn:'footer2026:agent'}});
 app=await db.app.create({data:{organizationId:org.id,name:'Team',urn:'footer2026:team'}});
 await db.appAgent.create({data:{appId:app.id,agentId:agent.id}});
 worker=await db.worker.create({data:{...WORKER_SIGNATURE_DEFAULTS,appId:app.id,agentId:agent.id,name:'Kit',slug:'kit',heldByUserId:user.id}});
 session=await db.session.create({data:{id:generateId(),appId:app.id,userId:user.id,workerId:worker.id,agentId:agent.id}});
 raw=`${USER_API_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
 key=await db.userApiKey.create({data:{userId:user.id,oauthScopes:[],keyHash:hashUserApiKey(raw),keyPreview:raw.slice(-4)}});
 const memory=await db.memory.create({data:{organizationId:org.id,urn:'footer2026:shared',name:'Shared',class:'app',appId:app.id,sharedMemoryOfAgentId:agent.id}});
 const made=await ensureChannelWithRoot(db,{memoryId:memory.id,loc:'chats:team',name:'Team',createdBy:user.id});
 channel={...made.channel,rootId:made.rootId};
 await db.registerEntry.create({data:{appId:app.id,channelId:channel.id,attendeeWorkerId:worker.id,role:'BOTH'}});
 for(let i=0;i<13;i++) {
  const enc=await getMemoryEncryptionInfo(db,memory.id);
  await appendChatMessage(db,{id:channel.rootId,memoryId:memory.id,loc:channel.loc},enc,
   async({tx,seq,msgNum})=>tx.node.create({data:{id:generateId(),memoryId:memory.id,loc:`chats:team:messages:${msgNum}`,name:msgNum,nodeType:'chat-message',seq,messageChannelId:channel.id,content:`private-body-${i}`,data:{authorName:'Private Author',mentions:['kit']}}}),{asChannel:true});
 }
 await db.node.updateMany({where:{messageChannelId:channel.id},data:{createdAt:new Date(Date.now()-3600_000)}});
});
const context=()=>({db,appId:app.id,userId:user.id,apiKeyId:key.id,sessionId:session.id,roles:['READER']});
const metadata=(count:number)=>({v:1,count,complete:true,asOf:expect.any(String)});
async function request(binding=true,query='{ serverInfo { version } }'): Promise<any> {
 return (await fetch(base+'/graphql',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${raw}`,...(binding?{'x-hadron-session':session.id}:{})},body:JSON.stringify({query})})).json();
}
describe('#2026 response footer',()=>{
 it('HTTP carries13 while C7 renders10 plus overflow3, without message metadata',async()=>{
  const now=new Date(); const pull=await loadDeliveryBatches({ctx:context() as any,app,hostId:null,workerIds:[worker.id],now});
  expect(pull.batches[0].overflow).toBe(3);
  const out=await request();expect(out.errors).toBeUndefined();
  expect(out.extensions?.hadron?.deliveryPending).toEqual(metadata(13));
  expect(JSON.stringify(out.extensions)).not.toMatch(/private-body|Private Author|chats:team/);
  expect(await db.channelReadState.count()).toBe(0);expect(await db.workerDeliveryChannel.count()).toBe(0);expect(await db.appLogEntry.count()).toBe(0);
 });
 it('SDK carries the same metadata and one separate attention text',async()=>{
  const server=createMcpServerInstance({appId:app.id,userId:user.id,apiKeyId:key.id,sessionId:session.id,roles:['READER'],clientId:`app:${app.id}`} as any,()=>undefined,{kind:'multi-app'});
  const client=new Client({name:'footer2026',version:'1'});const [local,remote]=InMemoryTransport.createLinkedPair();
  await server.connect(remote);await client.connect(local);
  try {
   const out=await client.callTool({name:'hadron_server_info',arguments:{}});
   expect(out._meta?.['hadron/deliveryPending']).toEqual(metadata(13));
   expect((out.content as any[]).filter(x=>x.type==='text'&&x.text.includes('13 messages waiting'))).toHaveLength(1);
  } finally {await client.close();await server.close();}
 });
 it('omits on unbound and errored operations, preserving their results',async()=>{
  const unbound=await request(false);expect(unbound.data.serverInfo.version).toBeTruthy();expect(unbound.extensions?.hadron?.deliveryPending).toBeUndefined();
  const error=await request(true,'{ missingFooterField }');expect(error.errors).toBeTruthy();expect(error.extensions?.hadron?.deliveryPending).toBeUndefined();
 });
});

async function snapshot() {
 const tables=await db.$queryRaw<Array<{name:string}>>`SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename`;
 const out:Record<string,unknown>={};
 for(const {name} of tables) out[name]=await db.$queryRawUnsafe(`SELECT to_jsonb(t)::text AS row FROM public."${name.replaceAll('"','""')}" t ORDER BY 1`);
 return out;
}
describe('#2026 count boundaries and omission',()=>{
 it('has zero effects on every public table',async()=>{
  const before=await snapshot();
  expect(await deliveryPending(context() as any)).toEqual(metadata(13));
  expect(await snapshot()).toEqual(before);
 });
 it('enforces no effects in PostgreSQL even if a future count helper attempts a write',async()=>{
  const before=await snapshot();
  const spy=vi.spyOn(deliveryBatchModule,'loadPendingDeliverySummary').mockImplementation(async args=>{
   await args.ctx.db.worker.update({where:{id:worker.id},data:{name:'accidental footer write'}});return 13;
  });
  try {expect(await deliveryPending(context() as any)).toBeUndefined();expect(await snapshot()).toEqual(before);}
  finally {spy.mockRestore();}
 });
 it('counts a complete empty set as zero and never emits a zero attention line',async()=>{
  await db.channelReadState.create({data:{workerId:worker.id,channelId:channel.id,lastSeenSeq:13}});
  const result={content:[{type:'text',text:'original'}],structuredContent:{ok:true},_meta:{old:1}};
  const out=await appendDeliveryPending(result,context() as any);
  expect(out._meta).toEqual({old:1,'hadron/deliveryPending':metadata(0)});expect(out.content).toEqual(result.content);expect(out.structuredContent).toEqual(result.structuredContent);
 });
 it.each(['encrypted','post-only','holder-refused'])('omits %s channels from the admitted set',async mode=>{
  if(mode==='encrypted') await db.memory.update({where:{id:channel.memoryId},data:{isEncrypted:true}});
  if(mode==='post-only') await db.registerEntry.updateMany({where:{attendeeWorkerId:worker.id},data:{role:'POST'}});
  if(mode==='holder-refused') {
   const outsider=await db.user.create({data:{handle:'footer-outsider'}});
   await db.worker.update({where:{id:worker.id},data:{heldByUserId:outsider.id}});
  }
  expect(await deliveryPending(context() as any)).toEqual(metadata(0));
 });
 it('shares the timing boundary with the pull',async()=>{
  await db.node.updateMany({where:{messageChannelId:channel.id},data:{createdAt:new Date(Date.now()+60_000)}});
  expect((await loadDeliveryBatches({ctx:context() as any,app,hostId:null,workerIds:[worker.id]})).batches).toEqual([]);
  expect(await deliveryPending(context() as any)).toEqual(metadata(0));
 });
 it.each(['ended','foreign','refused','unbound'])('omits a %s binding',async mode=>{
  let ctx=context() as any;
  if(mode==='ended') await db.session.update({where:{id:session.id},data:{endedAt:new Date()}});
  if(mode==='foreign') {const other=await db.user.create({data:{handle:'foreign-footer'}});await db.session.update({where:{id:session.id},data:{userId:other.id}});}
  if(mode==='refused') ctx={...ctx,sessionBindingRefused:true};
  if(mode==='unbound') ctx={...ctx,sessionId:undefined};
  expect(await deliveryPending(ctx)).toBeUndefined();
 });
 it('omits faults and unsafe counts while preserving successful HTTP data',async()=>{
  const spy=vi.spyOn(deliveryBatchModule,'loadPendingDeliverySummary').mockRejectedValue(new Error('synthetic count failure'));
  try {
   const out=await request();expect(out.errors).toBeUndefined();expect(out.data.serverInfo.version).toBeTruthy();expect(out.extensions?.hadron?.deliveryPending).toBeUndefined();
   spy.mockResolvedValue(Number.MAX_SAFE_INTEGER+1);expect(await deliveryPending(context() as any)).toBeUndefined();
   spy.mockResolvedValue(-1);expect(await deliveryPending(context() as any)).toBeUndefined();
  } finally {spy.mockRestore();}
 });
 it('cancels a slow backend count and omits it, with no outstanding Promise.race',async()=>{
  const spy=vi.spyOn(deliveryBatchModule,'loadPendingDeliverySummary').mockImplementation(async args=>{
   await args.ctx.db.$queryRaw`SELECT pg_sleep(0.5)`;return 13;
  });
  try {const start=performance.now();expect(await deliveryPending(context() as any)).toBeUndefined();expect(performance.now()-start).toBeLessThan(450);}
  finally {spy.mockRestore();}
 });
 it('does not modify an MCP error result',async()=>{
  const error={isError:true,content:[{type:'text',text:'original failure'}],_meta:{old:1}};
  expect(await appendDeliveryPending(error,context() as any)).toBe(error);
 });
});


describe('#2026 per-call SDK and committed marks',()=>{
 it('keeps parallel named read sessions local to each call on one connection',async()=>{
  const other=await db.worker.create({data:{...WORKER_SIGNATURE_DEFAULTS,appId:app.id,agentId:worker.agentId,name:'Other',slug:'other',heldByUserId:user.id}});
  const otherSession=await db.session.create({data:{id:generateId(),appId:app.id,userId:user.id,workerId:other.id,agentId:worker.agentId}});
  const server=createMcpServerInstance({appId:app.id,userId:user.id,apiKeyId:key.id,roles:['READER'],clientId:`app:${app.id}`} as any,()=>undefined,{kind:'multi-app'});
  const client=new Client({name:'footer-parallel',version:'1'});const [local,remote]=InMemoryTransport.createLinkedPair();
  await server.connect(remote);await client.connect(local);
  try {
   const [kit,empty]=await Promise.all([session.id,otherSession.id].map(session=>client.callTool({name:'hadron_delivery_settings_get',arguments:{appRef:app.id,session}})));
   expect(kit.isError).not.toBe(true);expect(empty.isError).not.toBe(true);
   expect(kit._meta?.['hadron/deliveryPending']).toEqual(metadata(13));
   expect(empty._meta?.['hadron/deliveryPending']).toEqual(metadata(0));
   const invalid=await client.callTool({name:'hadron_delivery_settings_get',arguments:{appRef:app.id,session:generateId()}});
   expect(invalid.isError).toBe(true);expect(invalid._meta?.['hadron/deliveryPending']).toBeUndefined();
  } finally {await client.close();await server.close();}
 });
 it('uses the current read/delivered floor and restarts old-incarnation delivery marks',async()=>{
  await db.channelReadState.create({data:{workerId:worker.id,channelId:channel.id,lastSeenSeq:3}});
  await db.workerDeliveryChannel.create({data:{workerId:worker.id,channelId:channel.id,channelIncarnation:1,deliveredThroughSeq:8,deliveredAt:new Date()}});
  expect(await deliveryPending(context() as any)).toEqual(metadata(5));
  await db.channel.update({where:{id:channel.id},data:{incarnation:2}});
  expect(await deliveryPending(context() as any)).toEqual(metadata(10));
 });
 it('counts the remaining messages after a real signed batch acknowledgement commits',async()=>{
  const pulled=await request(true,`query { deliveryBatches(appRef: "${app.id}") { batches { id } } }`);
  expect(pulled.errors).toBeUndefined();
  const id=pulled.data.deliveryBatches.batches[0].id;
  const acked=await request(true,`mutation { acknowledgeDeliveryBatches(batchIds: ["${id}"]) { acknowledged unchanged } }`);
  expect(acked.errors).toBeUndefined();expect(acked.data.acknowledgeDeliveryBatches.acknowledged).toBe(1);
  expect(acked.extensions?.hadron?.deliveryPending).toEqual(metadata(3));
 });
 it('counts each reached message once and omits own-authored or deleted rows',async()=>{
  const rows=await db.node.findMany({where:{messageChannelId:channel.id},orderBy:{seq:'asc'}});
  await db.node.update({where:{id:rows[0].id},data:{data:{mentions:['kit','@all']}}});
  await db.node.update({where:{id:rows[1].id},data:{data:{mentions:['kit'],authorWorkerId:worker.id}}});
  await db.node.update({where:{id:rows[2].id},data:{deletedAt:new Date()}});
  expect(await deliveryPending(context() as any)).toEqual(metadata(11));
 });
 it('omits a named session after its operation ended it',async()=>{
  const result=await request(true,`mutation { endSession(id: "${session.id}") { id } }`);
  expect(result.errors).toBeUndefined();expect(result.extensions?.hadron?.deliveryPending).toBeUndefined();
  expect((await db.session.findUniqueOrThrow({where:{id:session.id}})).endedAt).not.toBeNull();
 });
});


describe('#2026 review closure controls', () => {
 it('preserves the ambient actor semantics of an actor-neutral callback', async () => {
  const server = createTestableMcpServer({userId:user.id,apiKeyId:key.id,appId:app.id,roles:['READER']});
  const spy = vi.spyOn(resolvers.Mutation, 'startSession').mockImplementation(async () => {
   publishActor({workerId:worker.id,agentId:worker.agentId});
   return session;
  });
  try {
   await runAsActor({workerId:null,agentId:null}, async () => {
    await server.callTool('hadron_start_session', {description:'neutral callback scope control'});
    expect(currentActor().workerId).toBe(worker.id);
   });
  } finally {spy.mockRestore();}
 });
 it('emits a fixed diagnostic class on count faults without raw error details', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const spy = vi.spyOn(deliveryBatchModule, 'loadPendingDeliverySummary').mockRejectedValue(new Error('PRIVATE_FOOTER_ERROR_SENTINEL'));
  try {
   expect(await deliveryPending(context() as any)).toBeUndefined();
   const log = warn.mock.calls.map(args => args.join(' ')).join('\n');
   expect(log).toContain('delivery.pending.omitted');
   expect(log).not.toContain('PRIVATE_FOOTER_ERROR_SENTINEL');
   expect(log).not.toContain(session.id);
  } finally {spy.mockRestore();warn.mockRestore();}
 });
 it('omits run principals and ambiguous unnamed callers, while a valid named session stays self-only', async () => {
  expect(await deliveryPending({...context(),clientId:'run:synthetic-footer-run'} as any)).toBeUndefined();
  await runAsActor({workerId:null,agentId:null}, async () => {
   publishAmbiguousActor([session.id,generateId()]);
   expect(await deliveryPending(context() as any)).toBeUndefined();
   expect(await deliveryPending(context() as any, session.id)).toEqual(metadata(13));
  });
 });
 it('counts two admitted channels in one aggregate, with the same total as pull', async () => {
  const made=await ensureChannelWithRoot(db,{memoryId:channel.memoryId,loc:'chats:second',name:'Second',createdBy:user.id});
  await db.registerEntry.create({data:{appId:app.id,channelId:made.channel.id,attendeeWorkerId:worker.id,role:'BOTH'}});
  const enc=await getMemoryEncryptionInfo(db,channel.memoryId);
  for(let i=0;i<2;i++) await appendChatMessage(db,{id:made.rootId,memoryId:channel.memoryId,loc:made.channel.loc},enc,
   async({tx,seq,msgNum})=>tx.node.create({data:{id:generateId(),memoryId:channel.memoryId,loc:`chats:second:messages:${msgNum}`,name:msgNum,nodeType:'chat-message',seq,messageChannelId:made.channel.id,content:'second',data:{mentions:['kit']}}}),{asChannel:true});
  const pull=await loadDeliveryBatches({ctx:context() as any,app,hostId:null,workerIds:[worker.id]});
  expect(pull.batches[0].overflow).toBe(5);
  const counts:string[]=[];
  const count=await db.$transaction(async tx=>{
   const traced=new Proxy(tx,{get(target,prop){
    const value=Reflect.get(target,prop);
    if(prop!=='$queryRaw') return typeof value==='function'?value.bind(target):value;
    return (...args:unknown[])=>{
     const q=args[0] as {strings?:string[]};
     const sql=(q.strings??(Array.isArray(q)?q:[])).join('');
     if(sql.includes(' AS total')) counts.push(sql);
     return Reflect.apply(value,target,args);
    };
   }});
   return deliveryBatchModule.loadPendingDeliverySummary({ctx:{...context(),db:traced} as any,app,hostId:null,workerIds:[worker.id],now:new Date()});
  });
  expect(count).toBe(15);expect(counts).toHaveLength(1);
 });
});
