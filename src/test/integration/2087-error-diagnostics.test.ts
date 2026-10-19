/** #2087: concealment at the real HTTP boundaries in DEVELOPMENT, independent of Apollo's defaults. */
import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GraphQLError } from 'graphql';
import { Prisma } from '../../generated/prisma/index.js';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { signJwt } from '../../auth/jwt.js';
import { generateId } from '../../lib/id.js';
import { formatGraphQLError } from '../../api/graphql/formatError.js';
import { UrnNotQualifiedError } from '../../lib/urn.js';
import { resolvers } from '../../api/graphql/schema/resolvers.js';

vi.mock('../../api/graphql/formatError.js', async (original) => {
  const actual = await original<typeof import('../../api/graphql/formatError.js')>();
  return { ...actual, formatGraphQLError: vi.fn(actual.formatGraphQLError) };
});
vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));
let server: Server, origin: string, token: string, appId: string, sid: string;
const absent = 'hrn:app:diagnostics2087.example:absent';
const foreign = 'hrn:app:diagnostics2087.example:foreign';
const fields = 'batchWindowSeconds busyDelaySeconds stuckWindowSeconds standbyEnabled standbyEffective';
const query = `query($a:String!){appDeliverySettings(appRef:$a){${fields}}}`;
const mutation = `mutation($a:String!){setAppDeliverySettings(appRef:$a,input:{busyDelaySeconds:501}){${fields}}}`;
const diagnostics = { stacktrace: ['PRIVATE_STACK_2087'], exception: { stacktrace: ['PRIVATE_EXCEPTION_2087'] } };
function noDiagnostics(value: unknown) { expect(JSON.stringify(value)).not.toMatch(/stacktrace|exception|PRIVATE_/i); }
function normalized(value: unknown, ref: string) { return JSON.stringify(value).split(ref).join('<caller-appRef>'); }
async function post(path: string, body: unknown, extra: Record<string,string> = {}) {
  return fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...extra }, body: JSON.stringify(body) });
}
async function gql(operation: string, ref: string) {
  const response = await post('/graphql', { query: operation, variables: { a: ref } });
  expect(response.status).toBe(200); return await response.json() as any;
}
let rpcId = 1;
async function mcpOpen() {
  const r = await post('/mcp', { jsonrpc:'2.0', id:rpcId++, method:'initialize', params:{ protocolVersion:'2025-03-26', capabilities:{}, clientInfo:{ name:'diagnostics2087', version:'1' } } }, { accept:'application/json, text/event-stream' });
  expect(r.status).toBe(200); const id = r.headers.get('mcp-session-id')!; await r.text(); return id;
}
async function tool(id: string, name: string, args: Record<string,unknown>) {
  const r = await post('/mcp', { jsonrpc:'2.0', id:rpcId++, method:'tools/call', params:{ name, arguments:args } }, { accept:'application/json, text/event-stream', 'mcp-session-id':id });
  expect(r.status).toBe(200); const raw=await r.text();
  const json=JSON.parse(raw.split('\n').find(l=>l.startsWith('data:'))?.slice(5) ?? raw);
  expect(json.error).toBeUndefined(); return json.result;
}
beforeAll(async () => {
  vi.stubEnv('NODE_ENV','development');
  await cleanDb(db);
  const manager=await db.user.create({data:{handle:`diag-${generateId()}`,roles:['READER']}});
  const other=await db.user.create({data:{handle:`diag-other-${generateId()}`,roles:['READER']}});
  const org=await db.organization.create({data:{name:'Diagnostics',urn:'diagnostics2087.example'}});
  await db.orgMember.create({data:{organizationId:org.id,userId:manager.id,role:'ADMIN'}});
  appId=(await db.app.create({data:{name:'Own',urn:'diagnostics2087.example:own',organizationId:org.id}})).id;
  await db.app.create({data:{name:'Foreign',urn:'diagnostics2087.example:foreign',ownerUserId:other.id}});
  sid=(await db.session.create({data:{id:generateId(),userId:manager.id,appId}})).id;
  token=await signJwt({sub:manager.id,roles:['READER']});
  server=httpServer(await createServer()); await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async()=>{ if(server) await new Promise<void>(r=>server.close(()=>r())); vi.unstubAllEnvs(); });
afterEach(()=>{vi.mocked(formatGraphQLError).mockClear();vi.restoreAllMocks();});
describe('#2087 development diagnostic boundaries',()=>{
  it.each([query,mutation])('GraphQL foreign and absent errors match, with stable code and no state change (%s)',async operation=>{
    const before=await db.app.findMany({orderBy:{id:'asc'}});
    const a=await gql(operation,foreign), b=await gql(operation,absent);
    for(const result of [a,b]) { expect(result.errors?.[0].extensions.code).toBe('APP_NOT_FOUND'); noDiagnostics(result); }
    expect(normalized(a,foreign)).toBe(normalized(b,absent));
    expect(await db.app.findMany({orderBy:{id:'asc'}})).toEqual(before);
  });
  it('manager GraphQL read and write succeed',async()=>{
    for(const operation of [query,mutation]) { const result=await gql(operation,appId); expect(result.errors).toBeUndefined(); expect(Object.values(result.data)[0]).toMatchObject({busyDelaySeconds:operation===mutation?501:600}); }
  });
  it('Apollo itself suppresses generated stacks even when formatter is passthrough',async()=>{
    vi.mocked(formatGraphQLError).mockImplementationOnce(formatted=>formatted);
    const result=await gql(query,absent); expect(result.errors[0].extensions.code).toBe('APP_NOT_FOUND'); noDiagnostics(result);
  });
  it.each(['hadron_delivery_settings_get','hadron_delivery_settings_set'])('real MCP %s keeps concealment and state',async name=>{
    const id=await mcpOpen(), before=await db.app.findMany({orderBy:{id:'asc'}});
    const args=(appRef:string)=>({appRef,...(name.endsWith('_set')?{session:sid,input:{busyDelaySeconds:502}}:{})});
    const a=await tool(id,name,args(foreign)),b=await tool(id,name,args(absent));
    for(const result of [a,b]) { expect(result.isError).toBe(true); expect(result.content[0].text).toMatch(/^\[app_not_found\]/); noDiagnostics(result); }
    expect(normalized(a,foreign)).toBe(normalized(b,absent));
    expect(await db.app.findMany({orderBy:{id:'asc'}})).toEqual(before);
    const success=await tool(id,name,args(appId)); expect(success.isError).not.toBe(true); expect(JSON.parse(success.content[0].text)).toMatchObject({busyDelaySeconds:name.endsWith('_set')?502:501,standbyEnabled:false});
    if(name.endsWith('_set')) expect((await db.app.findUniqueOrThrow({where:{id:appId}})).deliveryBusyDelaySeconds).toBe(502);
  });
  it.each([
    ['hadron_task_list','agentTasks',{appRef:absent}],
    ['hadron_get_comment','comment',{commentRef:'hrn:node:diagnostics2087.example:kb:comment'}],
  ])('MCP %s also strips diagnostics without changing public fields',async(name,resolver,args)=>{
    const id=await mcpOpen();
    const spy=vi.spyOn(resolvers.Query as any,resolver).mockRejectedValueOnce(new GraphQLError('refused',{extensions:{code:'FORBIDDEN',appRef:absent,...diagnostics}}));
    const result=await tool(id,name,args);
    spy.mockRestore(); expect(result.content[0].text).toContain('[forbidden] refused');
    expect(result.content[0].text).toContain(`appRef: ${absent}`); noDiagnostics(result);
  });
  it('MCP typed-error mapping strips supplied diagnostic extensions, preserving public extras',async()=>{
    const id=await mcpOpen();
    const spy=vi.spyOn(resolvers.Query as any,'appDeliverySettings').mockRejectedValueOnce(new GraphQLError('App not found.',{extensions:{code:'APP_NOT_FOUND',appRef:absent,...diagnostics}}));
    const result=await tool(id,'hadron_delivery_settings_get',{appRef:absent});
    spy.mockRestore(); expect(result.isError).toBe(true); expect(result.content[0].text).toContain(`appRef: ${absent}`); noDiagnostics(result);
  });
});
describe('#2087 formatter diagnostics supplied by callers',()=>{
  it('keeps Prisma internals redacted and the original error available to reporting',()=>{
    const error=new Prisma.PrismaClientValidationError('PRIVATE_QUERY_2087',{clientVersion:Prisma.prismaVersion.client});
    const result=formatGraphQLError({message:error.message,extensions:{code:'INTERNAL_SERVER_ERROR',...diagnostics}},error);
    noDiagnostics(result); expect(result.extensions?.code).toBe('INTERNAL_SERVER_ERROR');
    expect(result.message).toBe('Unable to complete this request. Please try again.');
    expect(error.message).toBe('PRIVATE_QUERY_2087');
  });
  it.each([new UrnNotQualifiedError('bad',undefined,'app'),new GraphQLError('typed',{extensions:{code:'APP_NOT_FOUND'}}),new Error('internal')])('strips diagnostics without losing public metadata (%s)',error=>{
    const result=formatGraphQLError({message:error.message,extensions:{code:'INTERNAL_SERVER_ERROR',appRef:absent,...diagnostics}},error);
    noDiagnostics(result); expect(result.extensions?.appRef).toBe(absent);
    expect(result.extensions?.code).toBe(error instanceof UrnNotQualifiedError?'URN_NOT_QUALIFIED':'INTERNAL_SERVER_ERROR');
  });
});
