/** #3276 / ruling0090A: the host's only node write is one atomic reset checkpoint. */
import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { code, ctx, M, PROC, NEW_PROC, setUpResetFixture, type ResetFixture } from '../../test/contextResetFixture.js';
import { createTestableMcpServer } from '../../mcp/server.js';
import { buildSchema, graphql, defaultFieldResolver } from 'graphql';
import { resolvers } from '../../api/graphql/schema/resolvers.js';
import { typeDefs } from '../../api/graphql/schema/typeDefs.js';
import { generateId } from '../id.js';
import { registerContextResetRecovery } from './contextReset.js';
vi.mock('../../integrations/github/writeNodeToGit.js',()=>({writeNodeToGit:vi.fn().mockResolvedValue(undefined)}));
vi.mock('../bus/index.js',()=>({getBusClient:vi.fn(async()=>null)}));
let f:ResetFixture;
beforeEach(async()=>{f=await setUpResetFixture();});
const nodeCount=()=>db.node.count();
async function claimed(){const s=await f.collectedReset();await f.step('claimContextReset',{resetId:s.resetId,epoch:0,process:PROC});return s;}
function input(s:{resetId:string;taskId:string},extra={}){return {resetId:s.resetId,epoch:1,sessionId:f.session.id,taskId:s.taskId,checkpoint:{title:'Recovery',content:'private checkpoint'},...extra};}
const call=(s:{resetId:string;taskId:string},extra={},key=f.orca1)=>f.step('registerContextResetRecovery',input(s,extra),key);
const uses=()=>db.hostKeyUse.findMany({where:{appKeyId:f.orca1.id,action:'checkpoint'}});
it('writes exactly one plain node in the working memory, with host-key authorship and atomic registration',async()=>{
 const s=await claimed(),n=await nodeCount(),edges=await db.edge.count();
 const out=await call(s);expect(out).toMatchObject({refused:null,replayed:false,reset:{phase:'checkpointed'}});
 const ref=out.reset.recoveryRef;const node=await db.node.findUniqueOrThrow({where:{id:ref.checkpointNodeId}});
 expect(node).toMatchObject({memoryId:f.kitMemory.id,name:'Recovery',content:'private checkpoint',nodeType:'info',role:null,isRunnable:false,createdBy:f.orca1.id});
 expect(node.loc).toMatch(/^sheds:auto-\d{4}-\d{2}-\d{2}T\d{6}Z$/);
 expect(ref).toMatchObject({sessionId:f.session.id,taskId:s.taskId});
 expect(await nodeCount()).toBe(n+1);expect(await db.edge.count()).toBe(edges);
 expect(await db.node.count({where:{memoryId:f.kitMemory.id,loc:'sheds'}})).toBe(0);
 expect(await uses()).toHaveLength(1);
});
it('replays the stored node through each registered nonended phase, ignoring changed checkpoint content',async()=>{
 const s=await claimed();const first=await call(s);const n=await nodeCount();
 const replay=async()=>{const before=(await uses()).length;const r=await call(s,{checkpoint:{title:'Changed',content:'ignore me'}});expect(r.replayed).toBe(true);expect(r.reset.recoveryRef).toEqual(first.reset.recoveryRef);expect(await nodeCount()).toBe(n);expect(await uses()).toHaveLength(before+1);};
 await replay();await f.step('authorizeContextResetStop',{resetId:s.resetId,epoch:1,process:PROC});await replay();
 await f.step('reportContextResetAgentStopped',{resetId:s.resetId,epoch:1});await replay();
 await f.step('reportContextResetRelaunched',{resetId:s.resetId,epoch:1,process:NEW_PROC});await replay();
 await db.contextReset.update({where:{id:s.resetId},data:{phase:'done',endedAt:new Date()}});
 expect(await code(call(s))).toBe('CONTEXT_RESET_WRONG_PHASE');expect(await nodeCount()).toBe(n);
});
it.each(['both','neither'])('refuses %s checkpoint inputs without a node or phase change',async mode=>{
 const s=await claimed(),n=await nodeCount();
 expect(await code(call(s,mode==='both'?{checkpointNode:(await f.checkpoint()).id}:{checkpoint:undefined}))).toBe('RECOVERY_REF_INVALID');
 expect(await nodeCount()).toBe(n+(mode==='both'?1:0));
 expect((await db.contextReset.findUniqueOrThrow({where:{id:s.resetId}})).phase).toBe('claimed');
 expect((await db.hostKeyUse.findMany({where:{appKeyId:f.orca1.id,action:mode==='both'?'checkpoint':'reset'}})).at(-1)?.refusedCode).toBe('RECOVERY_REF_INVALID');
});
it.each(['missing-memory','encrypted'])('refuses %s working memory and writes nothing',async kind=>{
 const s=await claimed(),n=await nodeCount();
 if(kind==='missing-memory')await db.worker.update({where:{id:f.kit.id},data:{memoryId:null}});
 else await db.memory.update({where:{id:f.kitMemory.id},data:{isEncrypted:true}});
 expect(await code(call(s))).toBe(kind==='encrypted'?'CHECKPOINT_MEMORY_ENCRYPTED':'RECOVERY_REF_INVALID');expect(await nodeCount()).toBe(n);
});
it.each(['epoch','phase','lease','collected','host','app','missing','malformed','scope','revoked','person','plain-key'])('refuses %s without a node, recording the host refusal',async kind=>{
 let s:{taskId:string;resetId:string;operationId:string};
 if(kind==='collected'){const t=await f.startedTask();await f.finish(t.id);const r=await db.contextReset.findUniqueOrThrow({where:{taskId:t.id}});s={taskId:t.id,resetId:r.id,operationId:r.hostOperationId!};}
 else if(kind==='phase')s=await f.collectedReset();else s=await claimed();
 const n=await nodeCount();let p:Promise<unknown>,expected:string|undefined;
 if(kind==='epoch'){p=call(s,{epoch:0});expected='STALE_EPOCH';}
 else if(kind==='phase'){p=call(s,{epoch:0});expected='CONTEXT_RESET_WRONG_PHASE';}
 else if(kind==='lease'){await db.contextReset.update({where:{id:s.resetId},data:{claimedAt:new Date(0)}});p=call(s);expected='CLAIM_LAPSED';}
 else if(kind==='collected'){p=call(s,{epoch:0});expected='HOST_OPERATION_NOT_COLLECTED';}
 else if(kind==='host'){const k=await f.hostKey('other');p=call(s,{},k);expected='CONTEXT_RESET_NOT_FOUND';}
 else if(kind==='app'){const other=await db.app.create({data:{organizationId:f.orgId,name:'Other',urn:`other-${generateId()}`}});const key=await db.appKey.create({data:{appId:other.id,keyHash:generateId(),keyPreview:'test'}});await M.grantAppKeyScope({}, {id:key.id,scope:'host:operate',hostId:'orca1'},ctx(f.manager.id));p=M.registerContextResetRecovery({}, {input:{...input(s),appRef:other.id}}, {...f.keyCtx(key),appId:other.id});expected='CONTEXT_RESET_NOT_FOUND';}
 else if(kind==='missing'||kind==='malformed'){p=call(s,{resetId:kind==='missing'?generateId():'invalid/id'});expected='CONTEXT_RESET_NOT_FOUND';}
 else if(kind==='scope'||kind==='revoked'){if(kind==='scope')await M.revokeAppKeyScope({}, {id:f.orca1.id,scope:'host:operate'},ctx(f.manager.id));else await db.appKey.update({where:{id:f.orca1.id},data:{revokedAt:new Date()}});p=call(s);expected='APP_KEY_SCOPE_REQUIRED';}
 else if(kind==='person'){p=M.registerContextResetRecovery({}, {input:{appRef:f.app.id,...input(s)}},ctx(f.manager.id));}
 else {const k=await db.appKey.create({data:{appId:f.app.id,keyHash:generateId(),keyPreview:'test'}});p=call(s,{},k);expected='APP_KEY_SCOPE_REQUIRED';}
 if(kind==='lease'){expect(await p).toMatchObject({refused:'CLAIM_LAPSED'});}else {const c=await code(p);if(expected)expect(c).toBe(expected);else expect(c).toBeDefined();}
 expect(await nodeCount()).toBe(n);
 if(!['host','app','person','plain-key'].includes(kind)){expect(await uses()).toHaveLength(1);if(kind!=='lease')expect((await uses())[0]?.refusedCode).toBe(expected);}
});
it('keeps the legacy checkpoint-node input and rejects memory redirection on the new input',async()=>{
 const s=await claimed();const node=await f.checkpoint();
 expect(await call(s,{checkpoint:undefined,checkpointNode:node.id})).toMatchObject({reset:{phase:'checkpointed'}});
});
it.each([false,true])('generic GraphQL and MCP writes stay refused, claimed=%s',async during=>{
 if(during)await claimed();
 const other=await db.memory.create({data:{organizationId:f.orgId,name:'Other',urn:`other-${generateId()}`,class:'knowledge'}});
 const memories=await db.memory.findMany({where:{id:{in:[f.kitMemory.id,other.id]}}});
 const server=createTestableMcpServer({appId:f.app.id,appKeyId:f.orca1.id,clientId:`app:${f.app.id}`});
 for(const mem of memories){
  const node=await f.checkpoint(mem.id),before=await db.node.findMany({orderBy:{id:'asc'}}),edgeCount=await db.edge.count();
  for(const loc of ['ordinary:probe','sheds:auto-test']){
   await expect(M.createNode({}, {input:{memoryId:mem.id,loc,name:'No',content:'No'}},f.keyCtx())).rejects.toBeDefined();
   const text=await server.callToolText('hadron_create_node',{urn:`hrn:node:${mem.urn}:${loc}`,name:'No',content:'No'});
   expect(text).toMatch(/forbidden|not found|cannot write|does not have write/i);
  }
  await expect(M.updateNode({}, {input:{id:node.id,name:'No'}},f.keyCtx())).rejects.toBeDefined();
  await expect(M.deleteNode({}, {nodeRef:node.id},f.keyCtx())).rejects.toBeDefined();
  for(const verb of ['hadron_update_node','hadron_delete_node']){
   const row=await db.node.findUniqueOrThrow({where:{id:node.id}});
   const text=await server.callToolText(verb,{urn:`hrn:node:${mem.urn}:${row.loc}`,...(verb==='hadron_update_node'?{name:'No'}:{})});
   expect(text).toMatch(/forbidden|not found|cannot write|does not have write/i);
  }
  expect(await db.node.findMany({orderBy:{id:'asc'}})).toEqual(before);expect(await db.edge.count()).toBe(edgeCount);
 }
});
it.each([false,true])('refuses a taken loc, soft-deleted=%s, without overwriting or phase change',async deleted=>{
 const s=await claimed();
 await db.$transaction(async tx=>{
  const [stamp]=await tx.$queryRaw<{stamp:string}[]>`SELECT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24MISS"Z"') AS stamp`;
  const existing=await tx.node.create({data:{memoryId:f.kitMemory.id,loc:`sheds:auto-${stamp!.stamp}`,name:'Existing',content:'Keep',deletedAt:deleted?new Date():null}});
  // SAVEPOINT isolates expected constraint/refusal from the test's outer transaction.
  await tx.$executeRawUnsafe('SAVEPOINT collision');
  const e=await registerContextResetRecovery(tx,{appId:f.app.id,hostId:'orca1',appKeyId:f.orca1.id} as any,s.resetId,1,input(s) as any,new Date()).catch(e=>e);
  await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT collision');
  expect(e.code).toBe('CHECKPOINT_LOC_TAKEN');
  expect(await tx.node.findUniqueOrThrow({where:{id:existing.id}})).toEqual(existing);
  expect((await tx.contextReset.findUniqueOrThrow({where:{id:s.resetId}})).phase).toBe('claimed');
 });
});

it.each([
 ['content-max','é'.repeat(32768),'Title',true],
 ['content-over','é'.repeat(32768)+'a','Title',false],
 ['title-max','body','a'.repeat(200),true],
 ['title-over','body','a'.repeat(201),false],
 ['title-empty','body','',false],
 ['title-space','body','   ',false],
] as const)('checkpoint bounds %s',async(_name,content,title,ok)=>{
 const s=await claimed(),n=await nodeCount();const p=call(s,{checkpoint:{title,content}});
 if(ok){expect(await p).toMatchObject({reset:{phase:'checkpointed'}});expect(await nodeCount()).toBe(n+1);}
 else {expect(await code(p)).toBe('RECOVERY_REF_INVALID');expect(await nodeCount()).toBe(n);expect((await db.contextReset.findUniqueOrThrow({where:{id:s.resetId}})).phase).toBe('claimed');}
});

it('GraphQL admits only the narrow input and conceals all unknown targets identically',async()=>{
 const s=await claimed();const schema=buildSchema(typeDefs);
 const fieldResolver=(p:any,a:any,c:any,i:any)=>typeof (resolvers as any)[i.parentType.name]?.[i.fieldName]==='function'?(resolvers as any)[i.parentType.name][i.fieldName](p,a,c,i):defaultFieldResolver(p,a,c,i);
 const source='mutation($input:RegisterContextResetRecoveryInput!){registerContextResetRecovery(input:$input){replayed}}';
 const results=[];
 for(const id of [generateId(),'malformed/id']){
  const out=await graphql({schema,source,variableValues:{input:{appRef:f.app.id,...input(s,{resetId:id})}},contextValue:f.keyCtx(),fieldResolver});
  results.push(out.errors?.map(e=>({message:e.message,extensions:e.extensions})));
 }
 expect(results[0]).toEqual(results[1]);expect(results[0]?.[0]?.extensions.code).toBe('CONTEXT_RESET_NOT_FOUND');
 const n=await nodeCount();
 const out=await graphql({schema,source,variableValues:{input:{appRef:f.app.id,...input(s,{checkpoint:{title:'No',content:'No',memoryId:generateId(),loc:'other'}})}},contextValue:f.keyCtx(),fieldResolver});
 expect(out.errors?.[0]?.message).toMatch(/not defined/);expect(await nodeCount()).toBe(n);
 const good=await graphql({schema,source,variableValues:{input:{appRef:f.app.id,...input(s)}},contextValue:f.keyCtx(),fieldResolver});
 expect(good.errors).toBeUndefined();expect(good.data).toEqual({registerContextResetRecovery:{replayed:false}});
});
it('registration failure rolls back its new checkpoint as well',async()=>{
 const s=await claimed(),n=await nodeCount();
 await db.$executeRawUnsafe(`CREATE FUNCTION checkpoint3276_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.phase='checkpointed' THEN RAISE EXCEPTION 'injected register failure'; END IF; RETURN NEW; END $$`);
 await db.$executeRawUnsafe('CREATE TRIGGER checkpoint3276_fail BEFORE UPDATE ON context_resets FOR EACH ROW EXECUTE FUNCTION checkpoint3276_fail()');
 try {await expect(call(s)).rejects.toThrow('injected register failure');expect(await nodeCount()).toBe(n);expect((await db.contextReset.findUniqueOrThrow({where:{id:s.resetId}})).phase).toBe('claimed');}
 finally {await db.$executeRawUnsafe('DROP TRIGGER checkpoint3276_fail ON context_resets');await db.$executeRawUnsafe('DROP FUNCTION checkpoint3276_fail()');}
});

it('checkpoint audit obeys the real closed CHECK and append-only trigger',async()=>{
 const s=await claimed();await call(s);const [use]=await uses();expect(use?.operationId).toBe(s.operationId);
 await expect(db.hostKeyUse.create({data:{appKeyId:f.orca1.id,appId:f.app.id,hostId:'orca1',action:'invented'}})).rejects.toThrow(/chk_host_key_uses_shape/);
 await expect(db.hostKeyUse.update({where:{id:use!.id},data:{action:'reset'}})).rejects.toThrow();
 await expect(db.hostKeyUse.delete({where:{id:use!.id}})).rejects.toThrow();
 expect(await uses()).toEqual([use]);
});

it.each(['\u0000','\ud800'])('unstorable checkpoint text is a typed refusal, no orphan: %j',async ch=>{
 const s=await claimed(),n=await nodeCount();
 for(const checkpoint of [{title:`a${ch}`,content:'safe'},{title:'safe',content:`a${ch}`}]){
  expect(await code(call(s,{checkpoint}))).toBe('RECOVERY_REF_INVALID');expect(await nodeCount()).toBe(n);
 }
});
it('the deploy migration widens only the audit CHECK and keeps append-only protection',async()=>{
 const {Client}=await import('pg');const {readFileSync}=await import('node:fs');const client=new Client({connectionString:process.env.DATABASE_URL});await client.connect();
 const migration=readFileSync(new URL('../../../prisma/migrations/20261103014500_host_checkpoint_use_action/migration.sql',import.meta.url),'utf8');
 const s=await claimed();const action={appKeyId:f.orca1.id,appId:f.app.id,hostId:'orca1',action:'checkpoint',operationId:s.operationId};
 const trigger=()=>client.query("SELECT pg_get_functiondef('host_key_use_append_only()'::regprocedure) AS body");
 try{
  const before=(await trigger()).rows;
  await client.query(migration.replaceAll(", 'checkpoint'",''));
  await expect(db.hostKeyUse.create({data:action})).rejects.toThrow(/chk_host_key_uses_shape/);
  await client.query(migration);
  const row=await db.hostKeyUse.create({data:action});expect(row.action).toBe('checkpoint');
  expect((await trigger()).rows).toEqual(before);
  await expect(db.hostKeyUse.update({where:{id:row.id},data:{action:'reset'}})).rejects.toThrow();
  await expect(db.hostKeyUse.delete({where:{id:row.id}})).rejects.toThrow();
 }finally{try{await client.query(migration);}finally{await client.end();}}
});
