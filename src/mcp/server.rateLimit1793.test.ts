import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { createServer } from '../server.js';
import { signJwt } from '../auth/jwt.js';

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

it('#1793 live manifest/key disagreement makes existing health readiness fail without exposing secrets',async()=>{
  const {beginRateKeyOverlap}=await import('../lib/rateLimit/lifecycle.js');
  const initial=process.env.RATE_LIMIT_KEYRING!;
  try {
    server=httpServer(await createServer());await new Promise<void>(r=>server!.listen(0,'127.0.0.1',r));
    const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/health`;
    expect((await fetch(url)).status).toBe(200);
    const ring=JSON.parse(initial);const oldId=ring.current;
    process.env.RATE_LIMIT_KEYRING=JSON.stringify({...ring,keys:{...ring.keys,next:'2'.repeat(64)}});
    await beginRateKeyOverlap(db,'next');
    process.env.RATE_LIMIT_KEYRING=initial; // a non-prepared process must not remain ready after overlap begins
    const r=await fetch(url);expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ok:false,error:'database_unavailable'});
    expect(await db.rateLimitManifest.count()).toBe(1);
    expect(oldId).toBeTruthy();
  } finally {process.env.RATE_LIMIT_KEYRING=initial;}
});
