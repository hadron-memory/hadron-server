/** #2661: real HTTP MCP request binding cannot turn a worker into its driver. */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../server.js';
import { signJwt } from '../auth/jwt.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
let server: Server, url: string, token: string, appId: string, bound: string;
let rpc = 1;
const opened: string[] = [];
beforeAll(async () => {
  server = httpServer(await createServer());
  await new Promise<void>(r => server.listen(0,'127.0.0.1',r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});
afterEach(async () => {
  for (const id of opened.splice(0)) await (await fetch(url,{method:'DELETE',headers:{authorization:`Bearer ${token}`,'mcp-session-id':id}})).text();
});
afterAll(async () => { server.closeAllConnections?.(); await new Promise<void>(r => server.close(() => r())); });
beforeEach(async () => {
  await cleanDb(db);
  const user = await db.user.create({data:{githubId:266199,githubUsername:'wire2661',roles:['READER']}});
  const org = await db.organization.create({data:{name:'Wire',urn:'wire2661.test'}});
  await db.orgMember.create({data:{organizationId:org.id,userId:user.id,role:'ADMIN'}});
  const app = await db.app.create({data:{organizationId:org.id,name:'Wire',urn:`${org.urn}:app`}}); appId=app.id;
  await db.appMember.create({data:{appId,userId:user.id,role:'owner'}});
  const agent = await db.agent.create({data:{name:'A',urn:`${org.urn}:agent`,organizationId:org.id}});
  await db.appAgent.create({data:{appId,agentId:agent.id}});
  const worker = await db.worker.create({data:{...WORKER_SIGNATURE_DEFAULTS,name:'Fixture',slug:'fixture',appId,agentId:agent.id,heldByUserId:user.id,heldAt:new Date()}});
  bound=(await db.session.create({data:{id:generateId(),appId,userId:user.id,workerId:worker.id,agentId:agent.id}})).id;
  token=await signJwt({sub:user.id,githubId:266199,githubUsername:'wire2661',roles:['READER']});
});
const post = (body: any, id?: string, session?: string) => fetch(url,{method:'POST',headers:{
  authorization:`Bearer ${token}`,accept:'application/json, text/event-stream','content-type':'application/json',
  ...(id?{'mcp-session-id':id}:{}),...(session?{'x-hadron-session':session}:{}),
},body:JSON.stringify(body)});
async function open(session?: string) {
  const r=await post({jsonrpc:'2.0',id:rpc++,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'app2661',version:'1'}}},undefined,session);
  expect(r.status).toBe(200); await r.text(); const id=r.headers.get('mcp-session-id')!; opened.push(id);
  await (await post({jsonrpc:'2.0',method:'notifications/initialized'},id,session)).text(); return id;
}
async function call(id: string, session?: string) {
  const r=await post({jsonrpc:'2.0',id:rpc++,method:'tools/call',params:{name:'hadron_create_app_memory',arguments:{app:appId,name:`Notes ${rpc}`}}},id,session);
  expect(r.status).toBe(200); const raw=await r.text(); const b=JSON.parse(raw.split('\n').find(l=>l.startsWith('data:'))?.slice(5)??raw);
  return b.result;
}
it('human succeeds, late worker binding and invalid header refuse, then clean human request succeeds',async()=>{
  const id=await open(); expect((await call(id)).isError).not.toBe(true);
  for (const session of [bound,generateId()]) {
    const before=await db.memory.count(); const r=await call(id,session);
    expect(r).toMatchObject({isError:true,content:[{type:'text',text:'Error: Forbidden'}]});
    expect(await db.memory.count()).toBe(before);
  }
  expect((await call(id)).isError).not.toBe(true);
});
it('a bound initialization cannot drop its worker by omitting the later header',async()=>{
  const id=await open(bound); const r=await call(id);
  expect(r).toMatchObject({isError:true,content:[{type:'text',text:'Error: Forbidden'}]});
  expect(await db.memory.count()).toBe(0);
});
