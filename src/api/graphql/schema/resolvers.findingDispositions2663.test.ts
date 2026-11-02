/** #2663 / hrn:node:hadronmemory.com:specs:cor:agt:050:30: dispositions beside an immutable result. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSchema, defaultFieldResolver, graphql } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { resolvers } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
vi.mock('../../../integrations/github/writeNodeToGit.js',()=>({writeNodeToGit:vi.fn().mockResolvedValue(undefined)}));
const R=resolvers as any,M=R.Mutation,Q=R.Query;
let org:any,app:any,owner:any,assignee:any,manager:any,sibling:any,outsider:any,task:any,agent:any,head:any,worker:any;
const ctx=(userId=owner.id)=>({db,userId,roles:['READER']});
const stored=(id=task.id)=>db.agentTask.findUniqueOrThrow({where:{id}});
const result=async()=>R.AgentTask.result(await stored());
const events=()=>db.agentTeamEvent.findMany({where:{taskId:task.id,type:'task.finding-disposed'},orderBy:[{createdAt:'asc'},{id:'asc'}]});
const dispose=(code:any='fixed',findingId='F1',reference:any=undefined,c:any=ctx(),id=task.id)=>M.disposeAgentTaskFinding({}, {taskRef:id,findingId,disposition:code,...(reference===undefined?{}:{reference})},c);
const read=async(args={})=>R.AgentTask.findingDispositions(await stored(),args,ctx());
const list=(args={},c:any=ctx())=>Q.agentTasks({}, {appRef:app.id,unresolvedFindings:true,...args},c);
const code=(value:string)=>({extensions:{code:value}});
beforeEach(async()=>{
 await cleanDb(db);
 org=await db.organization.create({data:{name:'Disposition',urn:`disposition-${generateId()}.test`}});
 [owner,assignee,manager,sibling,outsider]=await Promise.all(['owner','assignee','manager','sibling','outsider'].map(handle=>db.user.create({data:{handle}})));
 app=await db.app.create({data:{organizationId:org.id,name:'Disposition',urn:`${org.urn}:disposition`}});
 for(const [u,role] of [[owner,'member'],[assignee,'member'],[manager,'owner'],[sibling,'member']]) await db.appMember.create({data:{appId:app.id,userId:u.id,role}});
 const memory=await db.memory.create({data:{organizationId:org.id,name:'System',urn:`${org.urn}:system`,class:'system'}});
 agent=await db.agent.create({data:{organizationId:org.id,name:'Team',urn:`${org.urn}:team`,systemMemoryId:memory.id}});
 await db.appAgent.create({data:{appId:app.id,agentId:agent.id}});
 head=await db.worker.create({data:{...WORKER_SIGNATURE_DEFAULTS,appId:app.id,agentId:agent.id,name:'Head',slug:'head',heldByUserId:owner.id}});
 worker=await db.worker.create({data:{...WORKER_SIGNATURE_DEFAULTS,appId:app.id,agentId:agent.id,name:'Worker',slug:'worker',heldByUserId:owner.id,reportsToWorkerId:head.id}});
 task=await M.createAgentTask({}, {input:{appRef:app.id,title:'T',assignee:{user:assignee.id}}},ctx());
 await M.startAgentTask({}, {taskId:task.id},ctx(assignee.id));
 await M.finishAgentTask({}, {taskId:task.id,result:{outcome:'done',summary:'immutable',evidence:'original',findings:[{severity:'P1',text:'secret one'},{severity:'note',text:'secret two'}]}},ctx(assignee.id));
});
describe('#2663 disposition write',()=>{
 it.each(['fixed','accepted','deferred','rejected'])('%s resolves a finding, preserving result bytes',async d=>{
  const before=JSON.stringify(await result()); await dispose(d);
  expect(JSON.stringify(await result())).toBe(before);
  expect((await read()).items).toEqual([{findingId:'F1',disposition:d,reference:null}]);
  expect((await list()).map((t:any)=>t.id)).toContain(task.id);
  await dispose(d,'F2');expect(await list()).toEqual([]);
 });
 it('latest wins, including identical repeats, with one content-free event per call',async()=>{
  const ref={kind:'ISSUE',target:'https://example.test/private-followup',label:'private label'};
  await dispose('deferred','F1',ref);await dispose('fixed');await dispose('fixed');await dispose('fixed','F1',null);
  expect((await read()).items).toEqual([{findingId:'F1',disposition:'fixed',reference:null}]);
  expect((await events()).map(e=>e.payload)).toEqual([{findingId:'F1',disposition:'deferred'},{findingId:'F1',disposition:'fixed'},{findingId:'F1',disposition:'fixed'},{findingId:'F1',disposition:'fixed'}]);
  const text=JSON.stringify(await events());for(const value of ['secret one','private-followup','private label']) expect(text).not.toContain(value);
  expect((await events()).every(e=>e.severity===null)).toBe(true);
 });
 it('stores the optional task-reference shape verbatim and pages beside, never inside, result',async()=>{
  const ref={kind:'PULL_REQUEST',target:'https://example.test/pull/7',label:'Review'};
  await dispose('fixed','F1',ref);await dispose('accepted','F2');
  expect(await read({limit:1})).toEqual({items:[{findingId:'F1',disposition:'fixed',reference:ref}],total:2,hasMore:true});
  expect(await read({limit:1,offset:1})).toEqual({items:[{findingId:'F2',disposition:'accepted',reference:null}],total:2,hasMore:false});
  expect(await read({limit:0})).toEqual({items:[],total:2,hasMore:true});
  expect(JSON.stringify(await result())).not.toContain('disposition');
 });
 it('allows an App manager after finish and refuses ordinary assignment after finish',async()=>{
  await dispose('accepted','F1',undefined,ctx(manager.id));
  await expect(M.assignAgentTask({}, {taskId:task.id,assignee:{user:sibling.id}},ctx())).rejects.toMatchObject(code('TASK_ENDED'));
 });
 it('allows an up-chain worker while holding the existing reports-to graph protocol',async()=>{
  await db.agentTask.update({where:{id:task.id},data:{ownerUserId:null,ownerWorkerId:worker.id}});
  await runAsActor({workerId:head.id,agentId:agent.id},()=>dispose());
  expect((await events())[0].actorWorkerId).toBe(head.id);
 });
 it.each(['assignee','sibling','outsider','appKey','impersonation'])('refuses %s with no task or event writes',async who=>{
  let c:any=ctx(who==='assignee'?assignee.id:who==='sibling'?sibling.id:who==='outsider'?outsider.id:owner.id);
  if(who==='appKey') {const key=await db.appKey.create({data:{appId:app.id,keyHash:generateId(),keyPreview:'test'}});c={db,appId:app.id,appKeyId:key.id,roles:[]};}
  if(who==='impersonation') c={...ctx(owner.id),impersonation:{sessionId:generateId(),actorUserId:manager.id,orgId:org.id,expiresAt:new Date(Date.now()+3600000)}};
  const before=await stored();await expect(dispose('fixed','F1',undefined,c)).rejects.toBeDefined();
  expect(await stored()).toEqual(before);expect(await events()).toEqual([]);
 });
 it.each([null,'','unknown','FIXED'])('refuses disposition %s; no clearing or writes',async d=>{
  await dispose();const before=await stored(),count=(await events()).length;
  await expect(dispose(d)).rejects.toMatchObject(code('BAD_USER_INPUT'));
  expect(await stored()).toEqual(before);expect(await events()).toHaveLength(count);
 });
 it.each([{kind:'URL',target:'https://user:pass@example.test/'},{kind:'ISSUE',target:'https:example.test'},{kind:'NODE',target:'hrn:node:example.test:m:x',label:'x\u202e'}])('refuses malformed or hidden reference without echo or writes',async ref=>{
  const before=await stored();const error=await dispose('fixed','F1',ref).catch((e:any)=>e);
  expect(error).toMatchObject(code('BAD_USER_INPUT'));expect(error.message).not.toContain(ref.target);
  expect(await stored()).toEqual(before);expect(await events()).toEqual([]);
 });
 it('refuses an unknown finding only after task admission, concealing unreadable tasks as absent',async()=>{
  await expect(dispose('fixed','unknown')).rejects.toMatchObject(code('TASK_FINDING_NOT_FOUND'));
  const hidden=await dispose('fixed','F1',undefined,ctx(outsider.id)).catch((e:any)=>e);
  const absent=await dispose('fixed','F1',undefined,ctx(outsider.id),generateId()).catch((e:any)=>e);
  expect(hidden.extensions.code).toBe('TASK_NOT_FOUND');expect(absent.extensions.code).toBe('TASK_NOT_FOUND');
  expect(hidden.message.replace(task.id,'ID')).toBe(absent.message.replace(absent.extensions.taskId,'ID'));
 });
 it.each(['pending','started','cancelled'])('refuses %s tasks',async status=>{
  const t=await M.createAgentTask({}, {input:{appRef:app.id,title:'No result',assignee:{user:assignee.id}}},ctx());
  if(status==='started') await M.startAgentTask({}, {taskId:t.id},ctx(assignee.id));
  if(status==='cancelled') await M.cancelAgentTask({}, {taskId:t.id},ctx());
  await expect(dispose('fixed','F1',undefined,ctx(),t.id)).rejects.toMatchObject(code('TASK_NOT_FINISHED'));
 });
 it('serializes concurrent dispositions without losing either finding or event',async()=>{
  const {Client}=await import('pg');
  const holder=new Client({connectionString:process.env.DATABASE_URL});await holder.connect();
  await holder.query('BEGIN');
  await holder.query('SELECT id FROM agent_tasks WHERE id = $1 FOR UPDATE',[task.id]);
  let completed=false;
  const writes=Promise.allSettled([dispose('fixed','F1'),dispose('deferred','F2')]).then(rows=>{completed=true;return rows;});
  try {
   const deadline=Date.now()+4000;let waiting=0;
   do {
    const [row]=await db.$queryRaw<{n:bigint}[]>`SELECT count(*) AS n FROM pg_stat_activity
     WHERE datname=current_database() AND wait_event_type='Lock'
       AND query ILIKE '%FROM agent_tasks%FOR UPDATE%'`;
    waiting=Number(row.n);
    if(waiting<2) await new Promise(resolve=>setTimeout(resolve,10));
   } while(waiting<2 && Date.now()<deadline);
   expect(waiting).toBe(2);expect(completed).toBe(false); // both real writers reached the held task lock
  } finally {
   try {await holder.query('ROLLBACK');} finally {await holder.end();await writes;}
  }
  expect((await writes).map(row=>row.status)).toEqual(['fulfilled','fulfilled']);
  expect((await read()).items.map((d:any)=>d.findingId).sort()).toEqual(['F1','F2']);
  expect(await events()).toHaveLength(2);expect(await list()).toEqual([]);
 },15000);
});
it('unresolved filter runs before paging, composes other filters and keeps App read scope',async()=>{
 const other=await M.createAgentTask({}, {input:{appRef:app.id,title:'Newer no findings',assignee:{user:assignee.id}}},ctx());
 await M.startAgentTask({}, {taskId:other.id},ctx(assignee.id));
 await M.finishAgentTask({}, {taskId:other.id,result:{outcome:'done'}},ctx(assignee.id));
 expect((await list({limit:1})).map((t:any)=>t.id)).toEqual([task.id]);expect(await list({offset:1})).toEqual([]);
 expect(await list({status:['STARTED']})).toEqual([]);expect((await list({unresolvedFindings:false})).map((t:any)=>t.id)).toContain(other.id);
 const a=await list({},ctx(outsider.id)).catch((e:any)=>e),b=await list({unresolvedFindings:false},ctx(outsider.id)).catch((e:any)=>e);
 expect({message:a.message,extensions:a.extensions}).toEqual({message:b.message,extensions:b.extensions});
 await dispose('deferred','F1');await dispose('rejected','F2');expect(await list()).toEqual([]);
});
it('GraphQL exposes the mutation, separate paged disposition read and unresolved filter',async()=>{
 const schema=buildSchema(typeDefs);const fieldResolver=(p:any,a:any,c:any,i:any)=>typeof R[i.parentType.name]?.[i.fieldName]==='function'?R[i.parentType.name][i.fieldName](p,a,c,i):defaultFieldResolver(p,a,c,i);
 const out=await graphql({schema,source:'mutation($id:ID!){disposeAgentTaskFinding(taskRef:$id,findingId:"F1",disposition:fixed){id findingDispositions(limit:1){total hasMore items{findingId disposition reference{kind target label}}}}}',variableValues:{id:task.id},contextValue:ctx(),fieldResolver});
 expect(out.errors).toBeUndefined();expect(out.data).toEqual({disposeAgentTaskFinding:{id:task.id,findingDispositions:{total:1,hasMore:false,items:[{findingId:'F1',disposition:'fixed',reference:null}]}}});
});
it('database derives open ids, rejects clearing a disposition and rejects an unknown target',async()=>{
 expect((await stored() as any).unresolvedFindingIds).toEqual(['F1','F2']);
 await db.$executeRaw`UPDATE agent_tasks SET unresolved_finding_ids = ARRAY[]::text[] WHERE id = ${task.id}`;
 expect((await stored() as any).unresolvedFindingIds).toEqual(['F1','F2']);
 await dispose();const before=await stored();
 await expect(db.agentTask.update({where:{id:task.id},data:{findingDispositions:[]}})).rejects.toThrow();
 await expect(db.agentTask.update({where:{id:task.id},data:{findingDispositions:[{findingId:'missing',disposition:'fixed',reference:null}]}})).rejects.toThrow();
 expect(await stored()).toEqual(before);
});
it('migration uses the same disposition guards and backfills only the separate open-id projection',async()=>{
 const {readFileSync}=await import('node:fs');const guard=readFileSync('prisma/agent-task-dispositions-invariants.sql','utf8');
 const migration=readFileSync('prisma/migrations/20261102210000_agent_task_finding_dispositions/migration.sql','utf8');
 expect(migration).toContain(guard);expect(migration).toContain('SET finding_dispositions = finding_dispositions');
});
it('wide task rows read disposition pages in finding order without loading the immutable result',async()=>{
 await dispose('fixed','F1');await dispose('accepted','F2');await dispose('deferred','F1');
 const [row]=await Q.agentTasks({}, {appRef:app.id},ctx());
 expect(Object.hasOwn(row,'resultFindings')).toBe(false);
 expect((await R.AgentTask.findingDispositions(row,{},ctx())).items.map((d:any)=>d.findingId)).toEqual(['F1','F2']);
});
it('post-push backfills pre-existing findings and preserves their current dispositions and result',async()=>{
 const {Client}=await import('pg');const {readFileSync}=await import('node:fs');
 // Static repository DDL on THIS test worker's private DB; never TEST_DATABASE_URL or a shared DB.
 const sql=readFileSync('prisma/agent-task-dispositions-invariants.sql','utf8');
 const client=new Client({connectionString:process.env.DATABASE_URL});await client.connect();
 try {
  await dispose('fixed','F1');const original=JSON.stringify(await result());
  await client.query('DROP TRIGGER agent_task_dispositions ON agent_tasks');
  await db.agentTask.update({where:{id:task.id},data:{unresolvedFindingIds:[]}});
  const legacy=await M.createAgentTask({}, {input:{appRef:app.id,title:'Before post-push',assignee:{user:assignee.id}}},ctx());
  await M.startAgentTask({}, {taskId:legacy.id},ctx(assignee.id));
  await M.finishAgentTask({}, {taskId:legacy.id,result:{outcome:'done',findings:[{severity:'note',text:'legacy finding'}]}},ctx(assignee.id));
  expect((await stored(legacy.id) as any).unresolvedFindingIds).toEqual([]); // establish the old-row state
  await client.query(sql);
  expect((await stored() as any).unresolvedFindingIds).toEqual(['F2']);
  expect((await stored(legacy.id) as any).unresolvedFindingIds).toEqual(['F1']);
  expect(JSON.stringify(await result())).toBe(original);
  expect((await read()).items).toEqual([{findingId:'F1',disposition:'fixed',reference:null}]);
 } finally {
  try {await client.query(sql);} finally {await client.end();}
 }
});

// #3252 ruling0086: use the existing normalizer through this new writer, never a parallel validator.
it.each([0x115f,0x1160,0x3164,0xffa0,0x2800,0x034f])('disposition references reject ruled blank U+%s in target and label without writes',async cp=>{
 const ch=String.fromCodePoint(cp);
 for(const ref of [{kind:'URL',target:`https://example.test/a${ch}b`,label:'safe'},
                   {kind:'URL',target:'https://example.test/safe',label:`a${ch}b`}]) {
  const before=await stored();const error=await dispose('fixed','F1',ref).catch((e:any)=>e);
  expect(error).toMatchObject(code('BAD_USER_INPUT'));
  expect(error.message).not.toContain(ref.target);expect(error.message).not.toContain(ref.label);
  expect(await stored()).toEqual(before);expect(await events()).toEqual([]);
 }
});
it.each([0xfe00,0xfe0f,0xe0100,0xe01ef])('disposition references reject target selector U+%s but preserve label selectors',async cp=>{
 const ch=String.fromCodePoint(cp),before=await stored();
 const error=await dispose('fixed','F1',{kind:'URL',target:`https://example.test/a${ch}b`,label:'safe'}).catch((e:any)=>e);
 expect(error).toMatchObject(code('BAD_USER_INPUT'));expect(error.message).not.toContain('https://example.test');
 expect(await stored()).toEqual(before);expect(await events()).toEqual([]);
 const reference={kind:'URL',target:'https://example.test/safe',label:`Review${ch}`};
 await dispose('fixed','F1',reference);expect((await read()).items[0].reference).toEqual(reference);
});

// #3262: shared JSON-text guard inherited through normalizeTaskReferences.
it.each([0,0xd800,0xdc00].flatMap(cp=>['target','label'].map(field=>({cp,field}))))('disposition reference rejects unstorable $field U+$cp before any write',async({cp,field})=>{
 const ch=String.fromCharCode(cp);
 const reference={kind:'URL',target:field==='target'?`https://example.test/a${ch}b`:'https://example.test/safe',label:field==='label'?`private${ch}label`:'Review'};
 const before=await stored(),error=await dispose('fixed','F1',reference).catch((e:any)=>e);
 expect(error).toMatchObject(code('BAD_USER_INPUT'));
 expect(error.message).not.toContain(reference.target);expect(error.message).not.toContain(reference.label);
 expect(await stored()).toEqual(before);expect(await events()).toEqual([]);
});
it('disposition reference preserves a valid paired-surrogate label',async()=>{
 const reference={kind:'URL',target:'https://example.test/safe',label:'Review 😀'};
 await dispose('fixed','F1',reference);expect((await read()).items[0].reference).toEqual(reference);
});
