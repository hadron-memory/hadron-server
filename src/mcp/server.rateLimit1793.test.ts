import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { createServer } from '../server.js';
import { signJwt } from '../auth/jwt.js';
import { APP_KEY_PREFIX, hashAppKey } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';

vi.mock('../integrations/github/writeNodeToGit.js',()=>({writeNodeToGit:vi.fn().mockResolvedValue(undefined)}));
vi.mock('../integrations/github/syncGraphFromGithub.js',()=>({syncGraphFromGithub:vi.fn().mockResolvedValue({error:null})}));
let server:Server|undefined,client:Client|undefined;
beforeEach(async()=>{client=undefined;server=undefined;await cleanDb(db);});
afterEach(async()=>{await client?.close();server?.closeAllConnections();if(server)await new Promise<void>(r=>server!.close(()=>r()));});
it('#1793 actual SDK and GraphQL share one search allowance and structured refusal',async()=>{
  const u=await db.user.create({data:{githubId:179399,githubUsername:'rate-wire',roles:['ADMIN']}});
  server=httpServer(await createServer());await new Promise<void>(r=>server!.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token=await signJwt({sub:u.id,githubId:u.githubId!,githubUsername:u.githubUsername!,roles:['ADMIN']});
  await db.rateLimitPolicy.update({where:{fieldClass:'FAN_OUT_READS'},data:{principalLimit:1,enforcementMode:'ENFORCING'}});
  client=new Client({name:'rate1793',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
  const first=await client.callTool({name:'hadron_find_nodes',arguments:{query:'*',allMemories:true,limit:1}});
  expect(first.isError).not.toBe(true);
  expect((await db.rateLimitBucket.findMany({where:{dimension:'principal'}})).map(r=>r.used)).toEqual([1n]);
  const second=await client.callTool({name:'hadron_find_nodes',arguments:{query:'*',allMemories:true,limit:1}});
  expect(second).toMatchObject({isError:true,structuredContent:{error:{code:'RATE_LIMITED',fieldClass:'FAN_OUT_READS',retryAfterSeconds:expect.any(Number)}}});
  const r=await fetch(base+'/graphql',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({query:'query { findNodes(limit:0) { total } }'})});
  expect(((await r.json()) as { errors: Array<{extensions:Record<string,unknown>}> }).errors[0].extensions).toMatchObject({code:'RATE_LIMITED',fieldClass:'FAN_OUT_READS'});
  expect((await db.rateLimitBucket.findMany({where:{dimension:'principal'}})).map(r=>r.used)).toEqual([1n]);
});

it('#1793 GraphQL threads the trusted transport IP into search and consent admission',async()=>{
  const u=await db.user.create({data:{githubId:179398,githubUsername:'rate-http-ip',roles:['ADMIN']}});
  const target=await db.user.create({data:{githubId:179397,githubUsername:'rate-http-target'}});
  const app=await createServer();
  // The loopback peer is NOT a trusted production ingress. Forged forwarding
  // headers must not replace the socket address under this CIDR predicate.
  app.set('trust proxy',['203.0.113.0/24']);
  server=httpServer(app);await new Promise<void>(r=>server!.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token=await signJwt({sub:u.id,githubId:u.githubId!,githubUsername:u.githubUsername!,roles:['ADMIN']});
  await db.rateLimitPolicy.update({where:{fieldClass:'CREDENTIALS'},data:{enforcementMode:'ENFORCING'}});
  const post=async(query:string,ip:string)=>{
    const r=await fetch(base+'/graphql',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,'X-Forwarded-For':ip},body:JSON.stringify({query})});
    const body=await r.json() as {errors?:unknown};expect(body.errors).toBeUndefined();return body;
  };
  await post('query { findNodes(limit:0) { total } }','198.51.100.1');
  await post('query { findNodes(limit:0) { total } }','198.51.100.2');
  const buckets=await db.rateLimitBucket.findMany({where:{fieldClass:'FAN_OUT_READS',dimension:'ip'}});
  expect(buckets).toHaveLength(1);expect(buckets[0].used).toBe(2n);
  await post(`mutation { beginMergeUsersConsent(source:"${u.id}",target:"${target.id}") { proof expiresAt } }`,'198.51.100.3');
  expect(await db.rateLimitBucket.count({where:{fieldClass:'CREDENTIALS',dimension:'ip'}})).toBe(1);
  expect(await db.userMergeConsent.count()).toBe(1);
});

it('#1793 each MCP tool call uses its current request IP, not the initialize address',async()=>{
  const u=await db.user.create({data:{githubId:179396,githubUsername:'rate-mcp-ip',roles:['ADMIN']}});
  server=httpServer(await createServer());await new Promise<void>(r=>server!.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token=await signJwt({sub:u.id,githubId:u.githubId!,githubUsername:u.githubUsername!,roles:['ADMIN']});
  let ip='198.51.100.10';
  client=new Client({name:'rate1793-ip',version:'1'});
  // Test-mode proxy trust permits this controlled synthetic ingress identity.
  // This does not assert that production trusts client-supplied forwarding.
  await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{
    requestInit:{headers:{Authorization:`Bearer ${token}`}},
    fetch:(url,init)=>{const headers=new Headers(init?.headers);headers.set('X-Forwarded-For',ip);return fetch(url,{...init,headers});},
  }));
  const read=()=>client!.callTool({name:'hadron_find_nodes',arguments:{query:'*',allMemories:true,limit:1}});
  expect((await read()).isError).not.toBe(true);
  ip='198.51.100.11';
  expect((await read()).isError).not.toBe(true);
  const buckets=await db.rateLimitBucket.findMany({where:{fieldClass:'FAN_OUT_READS',dimension:'ip'}});
  expect(buckets).toHaveLength(2);expect(buckets.map(r=>r.used)).toEqual([1n,1n]);
  expect((await db.rateLimitBucket.findMany({where:{dimension:'principal'}})).map(r=>r.used)).toEqual([2n]);
});

it('#1793 an App key charges principal, actual key and IP identically over GraphQL and MCP',async()=>{
  const suffix=generateId();
  const org=await db.organization.create({data:{name:'rate-app',urn:`rate-org-${suffix}`}});
  const app=await db.app.create({data:{name:'rate-app',urn:`${org.urn}:rate-app`,organizationId:org.id}});
  const raw=APP_KEY_PREFIX+'a'.repeat(64);
  await db.appKey.create({data:{appId:app.id,keyHash:hashAppKey(raw),keyPreview:'test'}});
  server=httpServer(await createServer());await new Promise<void>(r=>server!.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const r=await fetch(base+'/graphql',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${raw}`},body:JSON.stringify({query:'query { findNodes(limit:0) { total } }'})});
  expect((await r.json() as {errors?:unknown}).errors).toBeUndefined();
  const before=await db.rateLimitBucket.findMany({where:{fieldClass:'FAN_OUT_READS'},orderBy:{dimension:'asc'}});
  expect(before.map(r=>r.dimension)).toEqual(['ip','key','principal']);
  expect(before.map(r=>r.used)).toEqual([1n,1n,1n]);
  client=new Client({name:'rate1793-app-key',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${raw}`}}}));
  const result=await client.callTool({name:'hadron_find_nodes',arguments:{query:'*',allMemories:true,limit:1}});
  expect(result.isError).not.toBe(true);
  const after=await db.rateLimitBucket.findMany({where:{fieldClass:'FAN_OUT_READS'},orderBy:{dimension:'asc'}});
  expect(after.map(r=>({dimension:r.dimension,subject:r.subject,used:r.used})))
    .toEqual(before.map(r=>({dimension:r.dimension,subject:r.subject,used:2n})));
});

it('#1793 an empty named MCP scope is still one admitted search attempt',async()=>{
  const u=await db.user.create({data:{githubId:179395,githubUsername:'rate-empty-scope',roles:['READER']}});
  server=httpServer(await createServer());await new Promise<void>(r=>server!.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token=await signJwt({sub:u.id,githubId:u.githubId!,githubUsername:u.githubUsername!,roles:['READER']});
  await db.rateLimitPolicy.update({where:{fieldClass:'FAN_OUT_READS'},data:{principalLimit:1,enforcementMode:'ENFORCING'}});
  client=new Client({name:'rate1793-empty',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
  const read=()=>client!.callTool({name:'hadron_find_nodes',arguments:{query:'*',scope:'global',limit:1}});
  const first=await read();expect(first.isError).not.toBe(true);
  expect(JSON.stringify(first.content)).toContain('Found 0 node(s)');
  expect((await db.rateLimitBucket.findMany({where:{dimension:'principal'}})).map(r=>r.used)).toEqual([1n]);
  expect(await read()).toMatchObject({isError:true,structuredContent:{error:{code:'RATE_LIMITED',fieldClass:'FAN_OUT_READS'}}});
});

it('#1793 live manifest/key disagreement refuses readiness without restarting healthy liveness',async()=>{
  const {beginRateKeyOverlap}=await import('../lib/rateLimit/lifecycle.js');
  const initial=process.env.RATE_LIMIT_KEYRING!;
  try {
    server=httpServer(await createServer({readiness:{startup:()=> 'settled',stopping:()=>false}}));await new Promise<void>(r=>server!.listen(0,'127.0.0.1',r));
    const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const url=base+'/ready';
    expect((await fetch(url)).status).toBe(200);
    const ring=JSON.parse(initial);const oldId=ring.current;
    process.env.RATE_LIMIT_KEYRING=JSON.stringify({...ring,keys:{...ring.keys,next:'2'.repeat(64)}});
    await beginRateKeyOverlap(db,'next');
    process.env.RATE_LIMIT_KEYRING=initial; // a non-prepared process must not remain ready after overlap begins
    const r=await fetch(url);expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ok:false,error:'database_unavailable'});
    expect((await fetch(base+'/health')).status).toBe(200);
    expect(await db.rateLimitManifest.count()).toBe(1);
    expect(oldId).toBeTruthy();
  } finally {process.env.RATE_LIMIT_KEYRING=initial;}
});


it('#1793 merged /ready keeps startup and stopping precedence and rejects a live key mismatch',async()=>{
  const {beginRateKeyOverlap}=await import('../lib/rateLimit/lifecycle.js');
  const initial=process.env.RATE_LIMIT_KEYRING!;
  let state:'starting'|'settled'='starting';let stopping=false;
  try {
    server=httpServer(await createServer({readiness:{startup:()=>state,stopping:()=>stopping}}));
    await new Promise<void>(r=>server!.listen(0,'127.0.0.1',r));
    const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const ready=()=>fetch(base+'/ready');
    expect(await (await ready()).json()).toEqual({ok:false,error:'starting'});
    expect((await fetch(base+'/health')).status).toBe(200);
    state='settled';expect((await ready()).status).toBe(200);
    const ring=JSON.parse(initial);
    process.env.RATE_LIMIT_KEYRING=JSON.stringify({...ring,keys:{...ring.keys,next:'2'.repeat(64)}});
    await beginRateKeyOverlap(db,'next');process.env.RATE_LIMIT_KEYRING=initial;
    const refused=await ready();expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ok:false,error:'database_unavailable'});
    expect((await fetch(base+'/health')).status).toBe(200);
    stopping=true;
    const stopped=await ready();expect(stopped.status).toBe(503);
    expect(await stopped.json()).toEqual({ok:false,error:'stopping'});
  } finally {process.env.RATE_LIMIT_KEYRING=initial;}
});


it('#1793 transient policy read failure leaves /ready healthy when the DB probe answers',async()=>{
  server=httpServer(await createServer({readiness:{startup:()=> 'settled',stopping:()=>false}}));
  await new Promise<void>(r=>server!.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const failure=Object.assign(new Error('synthetic policy connection loss'),{code:'P1001'});
  const policyRead=vi.spyOn(db,'$transaction').mockRejectedValueOnce(failure);
  try {
    const ready=await fetch(base+'/ready');
    expect(ready.status).toBe(200);expect(await ready.json()).toEqual({ok:true});
    expect(policyRead).toHaveBeenCalledTimes(1);
    expect((await fetch(base+'/health')).status).toBe(200);
  } finally {policyRead.mockRestore();}
});
