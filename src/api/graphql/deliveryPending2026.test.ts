/** #2026: real authenticated HTTP + SDK responses count the pull's pre-cap admitted set, with no footer writes. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../server.js';
import { createMcpServerInstance } from '../../mcp/server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../lib/workerSignature.js';
import { APP_KEY_PREFIX, hashAppKey } from '../../middleware/auth.js';
import { ensureChannelWithRoot } from '../../lib/channels.js';
import { appendChatMessage } from '../../lib/chatRoot.js';
import { getMemoryEncryptionInfo } from '../../lib/nodeCrypto.js';
import { loadDeliveryBatches } from '../../lib/tickers/deliveryBatch.js';
import { generateId } from '../../lib/id.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
let http: Server; let base: string;
let app: any; let worker: any; let session: any; let key: any; let raw: string; let channel: any;
beforeAll(async () => {
 http=httpServer(await createServer()); await new Promise<void>(r=>http.listen(0,'127.0.0.1',r));
 base=`http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(async()=>{await new Promise<void>(r=>http.close(()=>r()));});
beforeEach(async()=>{
 await cleanDb(db);
 const org=await db.organization.create({data:{name:'Footer',urn:'footer2026'}});
 const agent=await db.agent.create({data:{organizationId:org.id,name:'Agent',urn:'footer2026:agent'}});
 app=await db.app.create({data:{organizationId:org.id,name:'Team',urn:'footer2026:team'}});
 await db.appAgent.create({data:{appId:app.id,agentId:agent.id}});
 worker=await db.worker.create({data:{...WORKER_SIGNATURE_DEFAULTS,appId:app.id,agentId:agent.id,name:'Kit',slug:'kit'}});
 session=await db.session.create({data:{appId:app.id,workerId:worker.id,agentId:agent.id}});
 raw=`${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
 key=await db.appKey.create({data:{appId:app.id,keyHash:hashAppKey(raw),keyPreview:raw.slice(-4)}});
 const memory=await db.memory.create({data:{organizationId:org.id,urn:'footer2026:shared',name:'Shared',class:'app',appId:app.id,sharedMemoryOfAgentId:agent.id}});
 const made=await ensureChannelWithRoot(db,{memoryId:memory.id,loc:'chats:team',name:'Team'});
 channel={...made.channel,rootId:made.rootId};
 await db.registerEntry.create({data:{appId:app.id,channelId:channel.id,attendeeWorkerId:worker.id,role:'BOTH'}});
 for(let i=0;i<13;i++) {
  const enc=await getMemoryEncryptionInfo(db,memory.id);
  await appendChatMessage(db,{id:channel.rootId,memoryId:memory.id,loc:channel.loc},enc,
   async({tx,seq,msgNum})=>tx.node.create({data:{id:generateId(),memoryId:memory.id,loc:`chats:team:messages:${msgNum}`,name:msgNum,nodeType:'chat-message',seq,messageChannelId:channel.id,content:`private-body-${i}`,data:{authorName:'Private Author',mentions:['kit']}}}),{asChannel:true});
 }
 await db.node.updateMany({where:{messageChannelId:channel.id},data:{createdAt:new Date(Date.now()-3600_000)}});
});
const context=()=>({db,appId:app.id,appKeyId:key.id,sessionId:session.id,roles:[]});
const metadata=(count:number)=>({v:1,count,complete:true,asOf:expect.any(String)});
async function request(binding=true,query='{ serverInfo { version } }') {
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
  const server=createMcpServerInstance({appId:app.id,appKeyId:key.id,sessionId:session.id,roles:[],clientId:`app:${app.id}`} as any,()=>undefined,{kind:'multi-app'});
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
