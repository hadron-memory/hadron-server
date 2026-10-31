/** #2734: every remaining node-write door uses the live App manager audience. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey, createDbAppAgent, createDbAppMember } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers } from './resolvers.js';
import type { Context } from './resolvers.helpers.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
const M = resolvers.Mutation as any;
const context = (userId: string): Context => ({ db, userId, roles: [], clientId: `user:${userId}` });
beforeEach(async () => { await cleanDb(db); });
async function fixture() {
 const org = await db.organization.create({ data: { name: 'Door org', urn: `doors-${generateId().toLowerCase()}` } });
 const agent = await db.agent.create({ data: { name: 'Door Agent', urn: `${org.urn}:agent`, organizationId: org.id } });
 const { app } = await createDbAppWithKey(db, 'doors-app', org.id);
 await createDbAppAgent(db, app.id, agent.id);
 const admin = await db.user.create({ data: { name: 'manager' } });
 await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
 await createDbAppMember(db, app.id, admin.id, 'member');
 const member = await db.user.create({ data: { name: 'participant' } });
 await createDbAppMember(db, app.id, member.id, 'member');
 const outsider = await db.user.create({ data: { name: 'outsider' } });
 const node = await M.createNode({}, { input: { install: { appRef: app.id, agentRef: agent.id }, loc: 'source', name: 'Source', content: 'before' } }, context(admin.id));
 const target = await M.createNode({}, { input: { memoryId: node.memoryId, loc: 'target', name: 'Target', content: 'target' } }, context(admin.id));
 const edge = await db.edge.create({ data: { memoryId: node.memoryId, sourceId: node.id, targetId: target.id, loc: 'link', name: 'link' } });
 const revision = await db.nodeRevision.create({ data: { nodeId: node.id, memoryId: node.memoryId, loc: 'source', name: 'Earlier', content: 'earlier', tags: [], changes: [], revNo: 0 } });
 const memory = await db.memory.findUniqueOrThrow({ where: { id: node.memoryId } });
 return { org, agent, app, admin, member, outsider, node, target, edge, revision, memory };
}
type F = Awaited<ReturnType<typeof fixture>>;
const doors: Array<[string, (f: F, ctx: Context) => Promise<unknown>]> = [
 ['moveNode', (f,c) => M.moveNode({}, { sourceRef: f.node.id, targetUrn: `hrn:node:${f.memory.urn}:moved` }, c)],
 ['searchReplaceInNodes', (f,c) => M.searchReplaceInNodes({}, { input: { nodeIds: [f.node.id], oldText: 'before', newText: 'after', fields: ['content'] } }, c)],
 ['deleteNode', (f,c) => M.deleteNode({}, { nodeRef: f.node.id }, c)],
 ['createEdge', (f,c) => M.createEdge({}, { sourceRef: f.node.id, targetRef: f.target.id, loc: 'newlink', name: 'new' }, c)],
 ['updateEdge', (f,c) => M.updateEdge({}, { edgeRef: f.edge.id, name: 'after' }, c)],
 ['deleteEdge', (f,c) => M.deleteEdge({}, { edgeRef: f.edge.id }, c)],
 ['mergeNodes', (f,c) => M.mergeNodes({}, { input: { source: f.node.id, target: f.target.id, include: ['CONTENT'] } }, c)],
 ['restoreNodeRevision', (f,c) => M.restoreNodeRevision({}, { revisionId: f.revision.id }, c)],
 ['deleteNodeRevision', (f,c) => M.deleteNodeRevision({}, { revisionId: f.revision.id }, c)],
 ['updateNodeRevision', (f,c) => M.updateNodeRevision({}, { revisionId: f.revision.id, revLabel: 'after' }, c)],
 ['clearNodeHistory', (f,c) => M.clearNodeHistory({}, { nodeRef: f.node.id }, c)],
];
async function snapshot(f: F) {
 return { nodes: await db.node.findMany({ where: { memoryId: f.node.memoryId }, orderBy: { id: 'asc' } }), edges: await db.edge.findMany({ where: { memoryId: f.node.memoryId }, orderBy: { id: 'asc' } }), revisions: await db.nodeRevision.findMany({ where: { nodeId: f.node.id }, orderBy: { id: 'asc' } }) };
}
describe.each(doors)('#2734 %s', (name, call) => {
 it('opens to the live App manager and changes the persisted state', async () => {
  const f=await fixture();const before=await snapshot(f);await call(f,context(f.admin.id));expect(await snapshot(f)).not.toEqual(before);
 });
 it.each(['member','outsider','detached','uninstalled','deleted'] as const)('refuses %s without changing content, edges or history', async mode => {
  const f=await fixture();
  if(mode==='detached') await db.memory.update({where:{id:f.node.memoryId},data:{installOfAgentId:null}});
  if(mode==='uninstalled') await db.appAgent.delete({where:{appId_agentId:{appId:f.app.id,agentId:f.agent.id}}});
  if(mode==='deleted') await db.app.update({where:{id:f.app.id},data:{deletedAt:new Date()}});
  const before=await snapshot(f);const user=mode==='member'?f.member:mode==='outsider'?f.outsider:f.admin;
  const failure = call(f,context(user.id));
  if(mode==='outsider') {
   const error:any=await failure.catch(e=>e);
   expect(error.extensions?.code ?? error.code).toBe(name.includes('Edge')&&name!=='createEdge'?'EDGE_NOT_FOUND':name.includes('Revision')?'NOT_FOUND':'NODE_NOT_FOUND');
  }
  else await expect(failure).rejects.toThrow();
  expect(await snapshot(f)).toEqual(before);
 });
 it('holds App authority until its transaction settles', async () => {
  const f=await fixture();let checked=false;
  const wrapped = new Proxy(db, { get(target,key) {
   if(key==='$transaction') return (work:any,options:any) => target.$transaction(async tx => {
    const result=await work(tx);
    const rows=await db.$queryRaw<Array<{ acquired:boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext('authorization:app'), hashtext(${f.app.id})) AS acquired`;
    expect(rows[0]?.acquired).toBe(false);checked=true;return result;
   },options);
   const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  await call(f,{...context(f.admin.id),db:wrapped});expect(checked).toBe(true);
 });
 it('rechecks authority inside its own transaction after manager demotion', async () => {
  const f=await fixture();const before=await snapshot(f);let crossed=false;
  const wrapped = new Proxy(db, { get(target,key) {
   if(key==='$transaction') return async (work: any, options: any) => {
    crossed=true;
    await db.orgMember.update({where:{organizationId_userId:{organizationId:f.org.id,userId:f.admin.id}},data:{role:'READER'}});
    return target.$transaction(work,options);
   };
   const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  await expect(call(f,{...context(f.admin.id),db:wrapped})).rejects.toThrow();
  expect(crossed).toBe(true);expect(await snapshot(f)).toEqual(before);
 });
 it('preserves compile-only protection (history is allowed; bulk replacement skips)', async () => {
  const f=await fixture();
  await db.node.update({where:{id:f.node.id},data:{nodeType:'compiled-boot-prompt',role:'boot-prompt'}});
  const before=await snapshot(f);
  if(['deleteNodeRevision','updateNodeRevision','clearNodeHistory'].includes(name)) {
   await call(f,context(f.admin.id));expect(await snapshot(f)).not.toEqual(before);
  } else if(name==='searchReplaceInNodes') {
   const result:any=await call(f,context(f.admin.id));expect(result.nodesChanged).toBe(0);expect(result.skipCounts.governed).toBe(1);expect(await snapshot(f)).toEqual(before);
  } else {
   await expect(call(f,context(f.admin.id))).rejects.toMatchObject({extensions:{code:'BOOT_PROMPT_COMPILED_WRITE'}});
   expect(await snapshot(f)).toEqual(before);
  }
 });
 if(['deleteNodeRevision','updateNodeRevision','clearNodeHistory','restoreNodeRevision'].includes(name)) {
  it('never edits decision-family history', async () => {
   const f=await fixture();await db.node.update({where:{id:f.node.id},data:{role:'decision'}});const before=await snapshot(f);
   await expect(call(f,context(f.admin.id))).rejects.toThrow();expect(await snapshot(f)).toEqual(before);
  });
 }

});

it('keeps replaceSubtree retired after a manager gate and conceals outsiders', async () => {
 const f=await fixture();const before=await snapshot(f);
 await expect(M.replaceSubtree({}, {memoryId:f.node.memoryId}, context(f.admin.id))).rejects.toMatchObject({extensions:{code:'REPLACE_SUBTREE_RETIRED'}});
 await expect(M.replaceSubtree({}, {memoryId:f.node.memoryId}, context(f.outsider.id))).rejects.toThrow();
 expect(await snapshot(f)).toEqual(before);
});

it.each([['moveNode',false],['moveNode',true],['mergeNodes',false],['mergeNodes',true]] as const)('%s requires independent system-memory write (source system=%s)', async (door,sourceSystem) => {
 const f=await fixture();
 const system=await db.memory.create({data:{urn:`${f.org.urn}:agent-brain`,name:'Agent brain',class:'system',organizationId:f.org.id}});
 await db.agent.update({where:{id:f.agent.id},data:{systemMemoryId:system.id}});
 const brain=await M.createNode({}, {input:{memoryId:system.id,loc:'brain',name:'Brain',content:'private brain'}},context(f.admin.id));
 await db.orgMember.update({where:{organizationId_userId:{organizationId:f.org.id,userId:f.admin.id}},data:{role:'READER'}});
 await db.appMember.update({where:{appId_userId:{appId:f.app.id,userId:f.admin.id}},data:{role:'owner'}});
 const before=await snapshot(f);
 const source=sourceSystem?brain:f.node;const target=sourceSystem?f.target:brain;
 const call=door==='moveNode'?M.moveNode({}, {sourceRef:source.id,targetMemoryRef:target.memoryId},context(f.admin.id))
  :M.mergeNodes({}, {input:{source:source.id,target:target.id,include:['CONTENT'],deleteSource:true}},context(f.admin.id));
 await expect(call).rejects.toThrow();expect(await snapshot(f)).toEqual(before);
 expect((await db.node.findUniqueOrThrow({where:{id:brain.id}})).content).toBe('private brain');
});

it('collects both install App anchors before the first authority row lock on a cross-memory move', async () => {
 const f=await fixture();const {app}=await createDbAppWithKey(db,'second-app',f.org.id);
 await createDbAppAgent(db,app.id,f.agent.id);await createDbAppMember(db,app.id,f.admin.id,'member');
 const second=await M.createNode({}, {input:{install:{appRef:app.id,agentRef:f.agent.id},loc:'other',name:'Other'}},context(f.admin.id));
 const apps=new Set<string>();let observed=false;
 const wrapped=new Proxy(db,{get(target,key){
  if(key==='$transaction')return(work:any,options:any)=>target.$transaction(tx=>work(new Proxy(tx,{get(t,k){
   const value=Reflect.get(t,k);
   if(k==='$executeRaw'||k==='$queryRaw') return (...args:any[])=>{
    const query=args[0];const values=Array.isArray(query?.values)?query.values:args.slice(1);const text=(query?.strings??query).join('');
    if(k==='$executeRaw'&&values.includes('authorization:app'))for(const id of [f.app.id,app.id])if(values.includes(id))apps.add(id);
    if(!observed&&/FOR SHARE/.test(text)){expect(apps).toEqual(new Set([f.app.id,app.id]));observed=true;}
    return value.apply(t,args);
   };
   return typeof value==='function'?value.bind(t):value;
  }})),options);
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 await M.moveNode({}, {sourceRef:f.node.id,targetMemoryRef:second.memoryId},{...context(f.admin.id),db:wrapped});
 expect(observed).toBe(true);expect((await db.node.findUniqueOrThrow({where:{id:f.node.id}})).memoryId).toBe(second.memoryId);
});

it.each(['retired','tombstone','dry-run'] as const)('rechecks %s authority despite producing no write', async mode => {
 const f=await fixture();
 if(mode==='tombstone')await db.node.update({where:{id:f.node.id},data:{deletedAt:new Date()}});
 const before=await snapshot(f);let crossed=false;
 const wrapped=new Proxy(db,{get(target,key){
  if(key==='$transaction')return async(work:any,options:any)=>{
   crossed=true;await db.orgMember.update({where:{organizationId_userId:{organizationId:f.org.id,userId:f.admin.id}},data:{role:'READER'}});
   return target.$transaction(work,options);
  };
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 const c={...context(f.admin.id),db:wrapped};
 const call=mode==='retired'?M.replaceSubtree({}, {memoryId:f.node.memoryId},c)
  :mode==='tombstone'?M.deleteNode({}, {nodeRef:f.node.id},c)
  :M.searchReplaceInNodes({}, {input:{nodeIds:[f.node.id],oldText:'before',newText:'after',fields:['content'],dryRun:true}},c);
 await expect(call).rejects.toMatchObject({extensions:{code:'FORBIDDEN'}});expect(crossed).toBe(true);expect(await snapshot(f)).toEqual(before);
});

it.each(['updateEdge','deleteEdge'] as const)('%s refuses when a real move puts the source in another memory after preflight', async door => {
 const f=await fixture();await createDbAppMember(db,f.app.id,f.outsider.id,'owner');
 const privateMemory=await db.memory.create({data:{name:'Private destination',urn:`${f.org.urn}:private-destination`,class:'private',ownerUserId:f.outsider.id,userId:f.outsider.id}});
 let moved=false;
 const wrapped=new Proxy(db,{get(target,key){
  if(key==='$transaction')return async(work:any,options:any)=>{
   await M.moveNode({}, {sourceRef:f.node.id,targetMemoryRef:privateMemory.id},context(f.outsider.id));
   expect((await db.edge.findUniqueOrThrow({where:{id:f.edge.id}})).memoryId).toBe(privateMemory.id);moved=true;
   return target.$transaction(work,options);
  };
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 const args=door==='updateEdge'?{edgeRef:f.edge.id,name:'unauthorized'}:{edgeRef:f.edge.id};
 await expect(M[door]({},args,{...context(f.admin.id),db:wrapped})).rejects.toMatchObject({extensions:{code:'NODE_WRITE_CONFLICT'}});
 expect(moved).toBe(true);expect((await db.edge.findUniqueOrThrow({where:{id:f.edge.id}})).name).toBe('link');
});
