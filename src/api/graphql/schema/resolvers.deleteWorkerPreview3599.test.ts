/** #3599: preview the real delete's census and act gate, without performing the delete. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSchema } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { generateDataKey } from '../../../lib/crypto.js';
import { encryptNodeFieldsWithKey } from '../../../lib/nodeCrypto.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const instruction = { kind: 'LIVE_CHAT', ref: 'client-chat:preview3599' };
let f: any;
const ctx = (extra: Partial<Context> = {}): Context => ({ db, userId: f.holder.id, roles: ['READER'], ...extra });
const bound = (extra: Partial<Context> = {}) => ctx({ sessionId: f.session.id, ...extra });
const preview = (c = ctx(), workerRef = f.target.id, claim?: unknown) => Q.deleteWorkerPreview({}, { workerRef, instruction: claim }, c);
const remove = (workerRef = f.target.id) => M.deleteWorker({}, { workerRef, confirmNoExternalAttribution: true }, ctx());
async function error(p: Promise<unknown>) {
 try { await p; throw new Error('expected refusal'); } catch (e: any) {
  if (!e.extensions) throw e;
  return { message: e.message, extensions: e.extensions };
 }
}
const fences = () => db.$queryRaw<Array<{subject_id:string;version:bigint}>>`SELECT subject_id,version FROM worker_reference_fences ORDER BY subject_id`;
const events = () => db.agentTeamEvent.findMany({ where: { appId: f.app.id }, orderBy: { id: 'asc' } });
const state = async () => ({
 workers: await db.worker.findMany({where:{appId:f.app.id},orderBy:{id:'asc'}}),
 memories: await db.memory.findMany({where:{appId:f.app.id},orderBy:{id:'asc'}}),
 sessions: await db.session.findMany({where:{appId:f.app.id},orderBy:{id:'asc'}}),
 tickers: await db.ticker.findMany({where:{appId:f.app.id},orderBy:{id:'asc'}}),
 events: await events(), fences: await fences(),
});
beforeEach(async () => {
 await cleanDb(db);
 const holder = await db.user.create({data:{handle:'preview-holder',roles:['READER']}});
 const outsider = await db.user.create({data:{handle:'preview-outsider',roles:['READER']}});
 const org = await db.organization.create({data:{name:'Preview',urn:'preview3599.test'}});
 await db.orgMember.create({data:{organizationId:org.id,userId:holder.id,role:'ADMIN'}});
 const app = await db.app.create({data:{organizationId:org.id,name:'Team',urn:'preview3599.test:team'}});
 f={holder,outsider,org,app};
 const agent = await M.createAgent({}, {orgId:org.id,name:'Role',personaRole:'server-engineer'},ctx());
 await db.appAgent.create({data:{appId:app.id,agentId:agent.id}});
 const caller = await db.worker.create({data:{...WORKER_SIGNATURE_DEFAULTS,appId:app.id,agentId:agent.id,name:'Caller',slug:'caller',heldByUserId:holder.id}});
 const session = await db.session.create({data:{id:generateId(),appId:app.id,agentId:agent.id,workerId:caller.id,userId:holder.id,tool:'vitest'}});
 const target = await M.castWorker({}, {appRef:app.id,agentRef:agent.id,name:'Miscast',noTeam:true},ctx());
 f={...f,agent,caller,session,target};
});
afterEach(() => sessionKeyCache.clear());

describe('#3599 deleteWorkerPreview contract', () => {
 it('returns only workerId and always-required attestation; pristine state and all fences are unchanged', async () => {
  const before=await state();
  expect(await preview()).toEqual({workerId:f.target.id,attestationRequired:true});
  expect(await state()).toEqual(before);
 });
 it('instructed preview records one subject-qualified claim and does not poison the later real delete', async () => {
  const before=await events();
  expect(await preview(bound(),f.target.id,instruction)).toEqual({workerId:f.target.id,attestationRequired:true});
  const after=(await events()).filter(e=>!before.some(x=>x.id===e.id));
  expect(after).toHaveLength(1);
  expect(after[0]).toMatchObject({type:'worker.instruction-claimed',subjectWorkerId:f.target.id,actorWorkerId:f.caller.id,actorUserId:f.holder.id});
  expect(after[0].payload).toEqual({operation:'worker.delete-preview',workerId:f.target.id,instruction});
  expect(await remove()).toBe(true);
  expect(await db.worker.findUnique({where:{id:f.target.id}})).toBeNull();
 });
 it('a granted worker previews without an instruction claim or any durable changes', async () => {
  await M.grantApp({}, {appRef:f.app.id,workerRef:f.caller.id,name:'WORKERS_STAFF'},ctx());
  const before=await state();
  expect(await preview(bound())).toEqual({workerId:f.target.id,attestationRequired:true});
  expect(await state()).toEqual(before);
 });
 for (const principal of ['app-key','impersonation','run','headless','launched','ambiguous'] as const) it(`${principal} is refused like real delete without writes`,async()=>{
  let c:Context;
  if(principal==='app-key') c={db,appId:f.app.id,appKeyId:generateId(),roles:[]} as Context;
  else if(principal==='impersonation') c=ctx({impersonation:{sessionId:generateId(),actorUserId:f.outsider.id,orgId:f.org.id,expiresAt:new Date('2099-01-01')}} as any);
  else if(principal==='run') c=ctx({clientId:'run:preview3599',appId:f.app.id});
  else {
   c=bound();
   if(principal==='launched') await db.session.update({where:{id:f.session.id},data:{launchOperationId:generateId(),launchHostId:generateId(),launchIssuedBy:'manager'}});
   if(principal==='ambiguous') c=bound({sessionId:generateId()});
  }
  const before=await state();
  const got=await error(preview(c,f.target.id,principal==='headless'?undefined:instruction));
  const actual=await error(M.deleteWorker({}, {workerRef:f.target.id,confirmNoExternalAttribution:true,instruction:principal==='headless'?undefined:instruction},c));
  expect(got).toEqual(actual);expect(got.extensions.code).toBe('FORBIDDEN');
  expect(await state()).toEqual(before);
 });
 it('missing and unreadable collapse byte-identically for a caller not entitled to the target', async()=>{
  const c=ctx({userId:f.outsider.id});
  const a=await error(preview(c));
  // Same caller-supplied selector in both states: do not normalize any public field.
  await db.worker.delete({where:{id:f.target.id}});
  const b=await error(preview(c));
  expect(a).toEqual(b);expect(a.extensions.code).toBe('WORKER_NOT_FOUND');
 });
 for(const kind of ['persisted-reference','unreleased-stint','unverifiable-encryption'] as const) it(`same closed WORKER_IN_USE for ${kind}, with no preview writes`,async()=>{
  if(kind==='persisted-reference') await db.node.create({data:{memoryId:f.agent.systemMemoryId,loc:'work',name:'Work',createdByWorkerId:f.target.id}});
  if(kind==='unreleased-stint') await db.session.create({data:{appId:f.app.id,workerId:f.target.id,userId:f.holder.id}});
  if(kind==='unverifiable-encryption') {
   const data=encryptNodeFieldsWithKey({data:{authorWorkerId:f.target.id}},generateDataKey()).data;
   await db.node.create({data:{memoryId:f.agent.systemMemoryId,loc:'sealed',name:'Sealed',data:data as never}});
  }
  const before=await state();const denied=await error(preview());
  expect(denied).toEqual(await error(remove()));
  expect(denied.extensions).toEqual({code:'WORKER_IN_USE',workerId:f.target.id});
  expect(await state()).toEqual(before);
 });
 it('does not take a target Worker FOR UPDATE or the real delete fence/isolation',async()=>{
  let unlock!:()=>void;let locked!:()=>void;
  const ready=new Promise<void>(r=>locked=r);const release=new Promise<void>(r=>unlock=r);
  const holder=db.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM workers WHERE id=${f.target.id} FOR UPDATE`;locked();await release;},{timeout:15000});
  await ready;
  try {
   // A READ COMMITTED census can read the committed target while another transaction holds its row.
   expect(await preview()).toEqual({workerId:f.target.id,attestationRequired:true});
  } finally {unlock();await holder;}
 },20000);
 it('schema has the Query closed shape with no attestation input; real delete signature unchanged',()=>{
  const schema=buildSchema(typeDefs);const q=schema.getQueryType()!.getFields().deleteWorkerPreview;
  expect(q).toBeDefined();expect(String(q.type)).toBe('DeleteWorkerPreview!');
  expect(q.args.map(a=>[a.name,String(a.type)])).toEqual([['workerRef','ID!'],['instruction','ActInstructionInput']]);
  const fields=(schema.getType('DeleteWorkerPreview') as any).getFields();
  expect(Object.keys(fields)).toEqual(['workerId','attestationRequired']);
  const d=schema.getMutationType()!.getFields().deleteWorker;
  expect(String(d.type)).toBe('Boolean!');
  expect(d.args.map(a=>[a.name,String(a.type)])).toEqual([['workerRef','ID!'],['confirmNoExternalAttribution','Boolean'],['instruction','ActInstructionInput']]);
 });
});
