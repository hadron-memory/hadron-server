/** #1148 / ruling0235: current owner membership is a live licence condition, not a one-time install grant. */
import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAgentImport, createDbAgentOrgGrant } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { isAgentInstalledAndLicensed, activeAppInstallLicenseIdsForAgent } from '../../../lib/appAgent.js';
import { installMemoryAudience, readableInstallMemoryIds } from '../../../lib/auth/installMemory.js';
import { resolveServedBootPrompt } from '../../../lib/bootPrompt/serve.js';
import { canReadMemory, participantSystemMemoryFolds, getAppMemoryAccess } from '../../../mcp/access-control.js';
import { sessionScopedMemoryIds } from '../../../lib/auth/sessionScopedMemoryIds.js';
import { serveAgentBootPrompt } from '../../../test/servedBootPrompt.js';
vi.mock('../../../integrations/github/writeNodeToGit.js',()=>({writeNodeToGit:vi.fn().mockResolvedValue(undefined)}));
const mutation=resolvers.Mutation as any;
let ownerId:string, outsiderId:string, orgId:string, agentId:string, appId:string, installMemoryId:string;
const context=(userId=ownerId):Context=>({db,userId,roles:['READER']});
beforeEach(async()=>{
 await cleanDb(db);
 ownerId=(await db.user.create({data:{id:generateId(),handle:'personal-owner',roles:['READER']}})).id;
 outsiderId=(await db.user.create({data:{id:generateId(),handle:'outside-member',roles:['READER']}})).id;
 orgId=(await db.organization.create({data:{id:generateId(),name:'Publisher',urn:'publisher1148.test'}})).id;
 const otherOrg=await db.organization.create({data:{id:generateId(),name:'Other',urn:'other1148.test'}});
 await db.orgMember.create({data:{organizationId:orgId,userId:ownerId,role:'READER'}});
 await db.orgMember.create({data:{organizationId:otherOrg.id,userId:outsiderId,role:'READER'}});
 const memory=await db.memory.create({data:{class:'system',organizationId:orgId,name:'Agent system',urn:'publisher1148.test:system'}});
 agentId=(await db.agent.create({data:{id:generateId(),organizationId:orgId,name:'Assistant',urn:'publisher1148.test:assistant',visibility:'ORGANIZATION',systemMemoryId:memory.id}})).id;
 await db.agentSubscription.create({data:{userId:ownerId,agentId,activatedAt:new Date('2020-01-01')}});
 appId=(await db.app.create({data:{id:generateId(),ownerUserId:ownerId,name:'Personal',urn:'@personal-owner:personal'}})).id;
 await db.appAgent.create({data:{appId,agentId}});
 await db.appMember.createMany({data:[{appId,userId:ownerId,role:'owner'},{appId,userId:outsiderId,role:'member'}]});
 installMemoryId=(await db.memory.create({data:{class:'system',appId,ownerUserId:ownerId,isInstallMemory:true,installOfAgentId:agentId,name:'Install',urn:'@personal-owner:install'}})).id;
});
const installRow=()=>db.memory.findUniqueOrThrow({where:{id:installMemoryId}});
it('current member creates a personal App referencing the org-visible Agent',async()=>{
 const app=await mutation.createApp({}, {agentRef:agentId,name:'New personal'},context());
 expect(app).toMatchObject({ownerUserId:ownerId,organizationId:null});
 expect(await db.appAgent.findUnique({where:{appId_agentId:{appId:app.id,agentId}}})).not.toBeNull();
});
it('the same owner installs through the existing-App door',async()=>{
 await db.appAgent.delete({where:{appId_agentId:{appId,agentId}}});
 expect(await mutation.installAgentIntoApp({}, {appRef:appId,agentRef:agentId},context())).toMatchObject({appAgent:{agentId,appId}});
});
it('owner membership revoke and rejoin changes live install readers without deleting anything',async()=>{
 expect(await isAgentInstalledAndLicensed(db,appId,agentId)).toBe(true);
 await db.orgMember.update({where:{organizationId_userId:{organizationId:orgId,userId:ownerId}},data:{deletedAt:new Date()}});
 expect(await isAgentInstalledAndLicensed(db,appId,agentId)).toBe(false);
 expect(await activeAppInstallLicenseIdsForAgent(db,agentId,[appId])).toEqual(new Set());
 expect((await installMemoryAudience(db,context(),await installRow())).read).toBe(false);
 expect(await readableInstallMemoryIds(db,context())).not.toContain(installMemoryId);
 expect(await db.appAgent.count({where:{appId,agentId}})).toBe(1);
 expect(await db.memory.count({where:{id:installMemoryId}})).toBe(1);
 await db.orgMember.update({where:{organizationId_userId:{organizationId:orgId,userId:ownerId}},data:{deletedAt:null}});
 expect(await isAgentInstalledAndLicensed(db,appId,agentId)).toBe(true);
});
it('an App participant outside the Agent org does not inherit the org text',async()=>{
 expect((await installMemoryAudience(db,context(outsiderId),await installRow())).read).toBe(false);
 expect(await readableInstallMemoryIds(db,context(outsiderId))).not.toContain(installMemoryId);
});
for(const state of ['revoked','expired','private'] as const) it(`retained install memory does not bypass ${state} licence`,async()=>{
 if(state==='private')await db.agent.update({where:{id:agentId},data:{visibility:'PERSONAL'}});
 else await db.agentSubscription.update({where:{userId_agentId:{userId:ownerId,agentId}},data:state==='revoked'?{revokedAt:new Date()}:{expiresAt:new Date('2020-01-01')}});
 expect(await isAgentInstalledAndLicensed(db,appId,agentId)).toBe(false);
 expect((await installMemoryAudience(db,context(),await installRow())).read).toBe(false);
});
for(const surface of ['bind','chat','run'] as const) it(`${surface} refuses a retained org install after owner membership ends`,async()=>{
 await serveAgentBootPrompt(db,agentId,'Synthetic served content.');
 expect((await resolveServedBootPrompt(db,{surface,appId,agent:{id:agentId,name:'Assistant'}})).content).toBeDefined();
 await db.orgMember.update({where:{organizationId_userId:{organizationId:orgId,userId:ownerId}},data:{deletedAt:new Date()}});
 await expect(resolveServedBootPrompt(db,{surface,appId,agent:{id:agentId,name:'Assistant'}})).rejects.toMatchObject({extensions:{code:'BOOT_PROMPT_INSTALL_LICENSE_INACTIVE'}});
});
it('PUBLIC personal creation remains available to a non-member',async()=>{
 await db.agent.update({where:{id:agentId},data:{visibility:'PUBLIC'}});
 expect(await mutation.createApp({}, {agentRef:agentId,name:'Public control'},context(outsiderId))).toMatchObject({ownerUserId:outsiderId,organizationId:null});
});
it('non-members and deleted Agents are concealed at install',async()=>{
 await expect(mutation.createApp({}, {agentRef:agentId,name:'No member'},context(outsiderId))).rejects.toMatchObject({code:'AGENT_NOT_FOUND'});
 await db.agent.update({where:{id:agentId},data:{deletedAt:new Date()}});
 await expect(mutation.createApp({}, {agentRef:agentId,name:'Gone'},context())).rejects.toMatchObject({code:'AGENT_NOT_FOUND'});
});
it('required and explicitly requested optional dependencies remain rejected before personal-App writes',async()=>{
 await db.agent.update({where:{id:agentId},data:{visibility:'PUBLIC'}});
 const dependency=await db.agent.create({data:{name:'Dependency',urn:'publisher1148.test:dependency',organizationId:orgId,visibility:'PUBLIC'}});
 await createDbAgentOrgGrant(db,orgId,dependency.id);
 await createDbAgentImport(db,agentId,dependency.id,{required:true,position:100});
 const count=await db.app.count();
 await expect(mutation.createApp({}, {agentRef:agentId,name:'Required'},context())).rejects.toMatchObject({extensions:{code:'BAD_USER_INPUT'}});
 await db.agentImport.update({where:{parentAgentId_importedAgentId:{parentAgentId:agentId,importedAgentId:dependency.id}},data:{required:false}});
 await expect(mutation.createApp({}, {agentRef:agentId,name:'Optional',installOptional:[dependency.id]},context())).rejects.toMatchObject({extensions:{code:'BAD_USER_INPUT'}});
 expect(await db.app.count()).toBe(count);
});

it('system-definition point and participant folds agree for current, foreign and revoked principals',async()=>{
 const agent=await db.agent.findUniqueOrThrow({where:{id:agentId},select:{systemMemoryId:true}});
 const id=agent.systemMemoryId!;
 expect(await canReadMemory(db,context(),id)).toBe(true);
 expect(await canReadMemory(db,context(outsiderId),id)).toBe(false);
 expect((await participantSystemMemoryFolds(db,context(outsiderId))).some(fold=>fold.map.has(id))).toBe(false);
 expect((await getAppMemoryAccess(db,appId,{callerUserId:outsiderId,memberAdmitted:true})).has(id)).toBe(false);
 await db.orgMember.update({where:{organizationId_userId:{organizationId:orgId,userId:ownerId}},data:{deletedAt:new Date()}});
 expect(await canReadMemory(db,context(),id)).toBe(false);
 expect((await participantSystemMemoryFolds(db,context())).some(fold=>fold.map.has(id))).toBe(false);
});
it('platform definition access without membership is not a personal-install licence',async()=>{
 await db.user.update({where:{id:outsiderId},data:{roles:['ADMIN']}});
 await expect(mutation.createApp({}, {agentRef:agentId,name:'No membership bypass'},{...context(outsiderId),roles:['ADMIN']} )).rejects.toMatchObject({extensions:{code:'ORGANIZATION_MISMATCH'}});
});
it('the owner own-Agent control needs no subscription',async()=>{
 const own=await mutation.createAgent({}, {name:'Own personal'},context());
 const created=await mutation.createApp({}, {agentRef:own.id,name:'Own App'},context());
 expect(created).toMatchObject({organizationId:null,ownerUserId:ownerId});
 expect(await isAgentInstalledAndLicensed(db,created.id,own.id)).toBe(true);
 expect(await db.agentSubscription.count({where:{agentId:own.id,userId:ownerId}})).toBe(0);
});

it('session App-key system-memory provenance still requires the individual current membership',async()=>{
 const id=(await db.agent.findUniqueOrThrow({where:{id:agentId},select:{systemMemoryId:true}})).systemMemoryId!;
 const own=await db.session.create({data:{id:generateId(),appId,agentId,userId:ownerId}});
 const other=await db.session.create({data:{id:generateId(),appId,agentId,userId:outsiderId}});
 expect(await sessionScopedMemoryIds(db,appId,own.id)).toContain(id);
 expect(await sessionScopedMemoryIds(db,appId,other.id)).not.toContain(id);
 await db.orgMember.update({where:{organizationId_userId:{organizationId:orgId,userId:ownerId}},data:{deletedAt:new Date()}});
 expect(await sessionScopedMemoryIds(db,appId,own.id)).not.toContain(id);
});
it('the real chat entry refuses an owner whose retained personal install lost membership with the common licence code',async()=>{
 await serveAgentBootPrompt(db,agentId,'Synthetic served content.');
 await db.orgMember.update({where:{organizationId_userId:{organizationId:orgId,userId:ownerId}},data:{deletedAt:new Date()}});
 const before=await db.node.count();
 await expect(mutation.startChat({}, {agentId,scope:'private'},context())).rejects.toMatchObject({extensions:{code:'BOOT_PROMPT_INSTALL_LICENSE_INACTIVE'}});
 expect(await db.node.count()).toBe(before);
});
