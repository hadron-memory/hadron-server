import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { setImmediate } from 'node:timers/promises';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { acquireLockSet } from '../../../lib/nodeSubtreeLock.js';
import { resolvers, type Context } from './resolvers.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import type { AuthContext } from '../../../middleware/auth.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
let memoryId: string, adminId: string;
const ctx = (): Context => ({ db, roles: ['ADMIN'], userId: adminId, clientId: `user:${adminId}` });
beforeEach(async () => {
 await cleanDb(db);
 const org = await db.organization.create({ data: { id: generateId(), name: 'seq443', urn: 'seq443' } });
 const user = await db.user.create({ data: { githubId: 443, githubUsername: 'seq443', roles: ['ADMIN'] } }); adminId=user.id;
 await db.orgMember.create({ data: { organizationId: org.id, userId: adminId, role: 'ADMIN' } });
 const memory=await resolvers.Mutation.createMemory(null,{orgId:org.id,name:'seq443'},ctx()); memoryId=memory.id;
 await db.node.create({ data: { id:generateId(),memoryId,loc:'parent:a',name:'a',seq:1 } });
});
afterEach(() => vi.restoreAllMocks());
async function create(surface: string, loc: string) {
 if(surface==='graphql') return resolvers.Mutation.createNode(null,{input:{memoryId,loc,name:loc}},ctx());
 const srv=createTestableMcpServer({userId:adminId,roles:['ADMIN'],clientId:`user:${adminId}`} as AuthContext);
 return srv.callToolText('hadron_create_node',{urn:`hrn:node:seq443:seq443:${loc}`,name:loc});
}
for(const surface of ['graphql','mcp']) {
 it(`${surface}: reads the next seq AFTER its observed parent-lock wait #443`,async()=>{
  let release!:()=>void, ready!:()=>void;
  const gate=new Promise<void>(r=>{release=r;}); const held=new Promise<void>(r=>{ready=r;});
  const holder=db.$transaction(async tx=>{
   await acquireLockSet(tx,[{memoryId,loc:'parent'}]);
   await tx.node.create({data:{id:generateId(),memoryId,loc:'parent:b',name:'b',seq:2}});
   ready(); await gate;
  },{timeout:15000});
  await held;
  let pending:Promise<unknown>|undefined;
  try {
   pending=create(surface,'parent:c');
   const deadline=Date.now()+3000; let waiter=false;
   while(Date.now()<deadline){
    const locks=await db.$queryRaw<Array<{pid:number}>>`SELECT pid FROM pg_locks WHERE locktype='advisory' AND NOT granted AND classid=(hashtext(${memoryId})::bigint & 4294967295)::oid AND objid=(hashtext('parent')::bigint & 4294967295)::oid AND objsubid=2 AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`;
    if(locks.length){waiter=true;break;} await setImmediate();
   }
   expect(waiter).toBe(true);
   release(); await holder; await pending;
   const row=await db.node.findUniqueOrThrow({where:{loc_memoryId:{memoryId,loc:'parent:c'}}});
   expect(row.seq).toBe(3);
  } finally { release(); await holder; await pending?.catch(()=>{}); }
 },15000);
 it(`${surface}: a refusal after insert rolls back seq allocation and releases the parent lock #443`,async()=>{
  const original=db.$transaction.bind(db);
  let inserted=false;
  vi.spyOn(db,'$transaction').mockImplementationOnce(((work:any,opts:any)=>original(async(tx:any)=>{
   const node=new Proxy(tx.node,{get(target,key){
    if(key==='upsert')return async(args:any)=>{const result=await target.upsert(args);inserted=true;throw new Error('443 forced rollback after insert');};
    const value=target[key];return typeof value==='function'?value.bind(target):value;
   }});
   const proxy=new Proxy(tx,{get(target,key){if(key==='node')return node;const value=target[key];return typeof value==='function'?value.bind(target):value;}});
   return work(proxy);
  },opts)) as any);
  await create(surface,'parent:failed').catch(()=>{});
  expect(inserted).toBe(true);
  expect(await db.node.findUnique({where:{loc_memoryId:{memoryId,loc:'parent:failed'}}})).toBeNull();
  vi.restoreAllMocks();
  await create(surface,'parent:next');
  expect((await db.node.findUniqueOrThrow({where:{loc_memoryId:{memoryId,loc:'parent:next'}}})).seq).toBe(2);
 },15000);
}

it('reserveSpecCitation reuses its existing transaction and parent locks for nested allocation #443', async () => {
 const reserved=await (resolvers.Mutation as any).reserveSpecCitation(null,{memoryRef:memoryId,loc:'parent:reserved'},ctx());
 const id=reserved.id ?? reserved.node?.id;
 const row=id ? await db.node.findUnique({where:{id}}) : await db.node.findUnique({where:{loc_memoryId:{memoryId,loc:'parent:reserved'}}});
 expect(row?.seq).toBe(2);
});
