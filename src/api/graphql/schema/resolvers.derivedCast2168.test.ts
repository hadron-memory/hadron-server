/** #2168 / cor:dmo:050:06,:11: one-hop installation without an AppAgent row. */
import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { serveAgentBootPrompt } from '../../../test/servedBootPrompt.js';
import { loadOfferedMemberRoles } from '../../../lib/memberRoles.js';
import { resolvers, type Context } from './resolvers.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
let user: {id:string}, org: {id:string}, app: {id:string}, parent: {id:string}, role: {id:string};
const ctx = (): Context => ({db, userId:user.id, roles:['READER']});
async function agent(name:string, personaRole:string) {
  const a = await M.createAgent({}, {orgId:org.id, name, personaRole}, ctx());
  await serveAgentBootPrompt(db, a.id, 'DERIVED {{worker.role}}');
  return a;
}
async function edge(p=parent.id, child=role.id, required=true) {
  await db.agentOrgGrant.upsert({where:{orgId_agentId:{orgId:org.id,agentId:child}},create:{orgId:org.id,agentId:child,activatedAt:new Date(),revokedAt:null},update:{activatedAt:new Date(),revokedAt:null}});
  return db.agentImport.create({data:{parentAgentId:p,importedAgentId:child,position:100,required,agentOrgGrantOrgId:org.id,agentOrgGrantAgentId:child}});
}
const cast = (extra:Record<string,unknown>={}) => M.castWorker({}, {appRef:app.id,agentRef:role.id,name:'Derived',...extra},ctx());
const refuse = async () => {
  await expect(cast()).rejects.toMatchObject({extensions:{code:'WORKER_AGENT_NOT_INSTALLED',appId:app.id}});
  expect(await db.worker.count({where:{appId:app.id}})).toBe(0);
};
beforeEach(async()=>{
  await cleanDb(db);
  org=await db.organization.create({data:{name:'Derived',urn:`derived-${generateId().toLowerCase()}.example`}});
  user=await db.user.create({data:{handle:`derived-${generateId()}`,roles:['READER']}});
  await db.orgMember.create({data:{organizationId:org.id,userId:user.id,role:'ADMIN'}});
  app=await db.app.create({data:{organizationId:org.id,name:'Derived',urn:`derived-${generateId().toLowerCase()}.example:team`}});
  parent=await agent('Importer','suite'); role=await agent('Imported','engineer');
  await db.appAgent.create({data:{appId:app.id,agentId:parent.id}});
  await edge();
});
it.each([true,false])('casts a direct import (required=%s), renders its own prompt, and writes no install row',async required=>{
  await db.agentImport.update({where:{parentAgentId_importedAgentId:{parentAgentId:parent.id,importedAgentId:role.id}},data:{required}});
  const preview=await (resolvers.Query as any).castWorkerPreview({}, {appRef:app.id,agentRef:role.id,name:'Derived'},ctx());
  expect(preview.prompt).toContain('DERIVED engineer');
  const w=await cast();
  expect(await db.worker.findUnique({where:{id:w.id}})).toMatchObject({agentId:role.id,role:'engineer'});
  expect(await db.appAgent.count({where:{appId:app.id,agentId:role.id}})).toBe(0);
});
it('casts by role from the derived tier',async()=>{
  const w=await cast({agentRef:undefined,role:' ENGINEER '});
  expect(await db.worker.findUnique({where:{id:w.id}})).toMatchObject({agentId:role.id});
});
it('prefers an installed role over its derived twin',async()=>{
  await db.agent.update({where:{id:parent.id},data:{personaRole:'engineer'}});
  const w=await cast({agentRef:undefined,role:'engineer'});
  expect(await db.worker.findUnique({where:{id:w.id}})).toMatchObject({agentId:parent.id});
});
it('refuses ambiguity within the derived tier',async()=>{
  const twin=await agent('Twin','engineer');
  await db.agentOrgGrant.create({data:{orgId:org.id,agentId:twin.id,activatedAt:new Date(),revokedAt:null}});
  await db.agentImport.create({data:{parentAgentId:parent.id,importedAgentId:twin.id,position:200,agentOrgGrantOrgId:org.id,agentOrgGrantAgentId:twin.id}});
  await expect(cast({agentRef:undefined,role:'engineer'})).rejects.toMatchObject({extensions:{code:'WORKER_AGENT_AMBIGUOUS'}});
});
it('refuses a non-imported agent',async()=>{await db.agentImport.deleteMany({});await refuse();});
it('removal stops new casts but leaves the existing Worker unchanged',async()=>{
  const w=await cast(); const before=await db.worker.findUnique({where:{id:w.id}});
  await db.agentImport.deleteMany({});
  await expect(cast({name:'Second'})).rejects.toMatchObject({extensions:{code:'WORKER_AGENT_NOT_INSTALLED'}});
  expect(await db.worker.findUnique({where:{id:w.id}})).toEqual(before);
});
it('does not borrow an importer installed in another App',async()=>{
  const other=await db.app.create({data:{organizationId:org.id,name:'Other',urn:`other-${generateId().toLowerCase()}.example:team`}});
  await db.appAgent.update({where:{appId_agentId:{appId:app.id,agentId:parent.id}},data:{appId:other.id}});
  await refuse();
});
it('does not derive through another derived import',async()=>{
  const next=await agent('Next','next'); await edge(role.id,next.id);
  role=next; await refuse();
});
it('refuses a deleted importer',async()=>{await db.agent.update({where:{id:parent.id},data:{deletedAt:new Date()}});await refuse();});
it('uses the App org grant and never reactivates a revoked grant',async()=>{
  await db.agentOrgGrant.update({where:{orgId_agentId:{orgId:org.id,agentId:role.id}},data:{revokedAt:new Date()}});
  await expect(cast()).rejects.toMatchObject({extensions:{code:'AGENT_ORG_GRANT_INACTIVE'}});
  expect(await db.worker.count()).toBe(0);
});
it('offers the derived Agent member roles',async()=>{
  await db.agent.update({where:{id:role.id},data:{installationPolicy:{memberRoles:['derived-member']}}});
  expect((await loadOfferedMemberRoles(db,app.id)).roles).toContain('derived-member');
});
it('explicit install survives import removal',async()=>{
  await db.appAgent.create({data:{appId:app.id,agentId:role.id}});
  await db.agentImport.deleteMany({});
  const w=await cast(); expect(w.id).toBeTruthy();
});
