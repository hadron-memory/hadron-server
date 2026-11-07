/** #1148 / ruling0235: current owner membership is a live licence condition, not a one-time install grant. */
import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, chatNodeByLocOrThrow, createDbAgentImport, createDbAgentOrgGrant } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { isAgentInstalledAndLicensed, activeAppInstallLicenseIdsForAgent } from '../../../lib/appAgent.js';
import { installMemoryAudience, readableInstallMemoryIds, writableInstallMemoryIds } from '../../../lib/auth/installMemory.js';
import { serveChatPrompt } from './resolvers.mutation.chat.js';
import { resolveServedBootPrompt } from '../../../lib/bootPrompt/serve.js';
import { canReadMemory, participantSystemMemoryFolds, getAppMemoryAccess } from '../../../mcp/access-control.js';
import { requirePersonalAppAgentInstall } from './resolvers.helpers.js';
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
 await db.agentSubscription.deleteMany({where:{userId:ownerId,agentId}});
 const app=await mutation.createApp({}, {agentRef:agentId,name:'New personal'},context());
 expect(app).toMatchObject({ownerUserId:ownerId,organizationId:null});
 expect(await isAgentInstalledAndLicensed(db,app.id,agentId)).toBe(true);
 expect(await db.appAgent.findUnique({where:{appId_agentId:{appId:app.id,agentId}}})).not.toBeNull();
});
it('the same owner installs through the existing-App door',async()=>{
 await db.appAgent.delete({where:{appId_agentId:{appId,agentId}}});
 await db.agentSubscription.deleteMany({where:{userId:ownerId,agentId}});
 expect(await mutation.installAgentIntoApp({}, {appRef:appId,agentRef:agentId},context())).toMatchObject({appAgent:{agentId,appId}});
 expect(await isAgentInstalledAndLicensed(db,appId,agentId)).toBe(true);
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
it('a foreign outsider without an App participation still gets the concealed chat refusal',async()=>{
 await db.appMember.deleteMany({where:{appId,userId:outsiderId}});
 await expect(mutation.startChat({}, {agentId,scope:'private'},context(outsiderId))).rejects.toMatchObject({code:'AGENT_NOT_FOUND'});
});
it('a scoped chat cannot use an owned install in another App as a refusal oracle',async()=>{
 await db.orgMember.update({where:{organizationId_userId:{organizationId:orgId,userId:ownerId}},data:{deletedAt:new Date()}});
 const other=await db.app.create({data:{id:generateId(),ownerUserId:ownerId,name:'Empty',urn:'@personal-owner:empty'}});
 await expect(mutation.startChat({}, {agentId,scope:'private'},{...context(),appId:other.id})).rejects.toMatchObject({code:'AGENT_NOT_FOUND'});
});
it('a recorded worker briefing stops returning org text when the owner membership ends without ending the session',async()=>{
 await db.agent.update({where:{id:agentId},data:{personaRole:'engineer'}});
 await serveAgentBootPrompt(db,agentId,'PRIVATE ORGANIZATION BRIEFING');
 const made=await mutation.castWorker({}, {appRef:appId,agentRef:agentId,name:'Member'},context());
 const worker=await db.worker.findUniqueOrThrow({where:{id:made.id}});
 const open=await mutation.startSession({}, {input:{id:generateId(),tool:'vitest',appRef:appId,workerRef:worker.id,force:true}},context());
 const bound={...context(),sessionId:open.id};
 const {composeWorkerPrompt}=await import('./resolvers.worker.js');
 expect((await composeWorkerPrompt(bound,worker)).text).toContain('PRIVATE ORGANIZATION BRIEFING');
 await db.orgMember.update({where:{organizationId_userId:{organizationId:orgId,userId:ownerId}},data:{deletedAt:new Date()}});
 const refused=await composeWorkerPrompt(bound,worker);
 expect(refused.text).toBeNull();
 expect(refused.refusal).toBe('FORBIDDEN');
 expect((await db.session.findUniqueOrThrow({where:{id:open.id}})).endedAt).toBeNull();
});

async function seedChatConversation() {
 const memoryId=(await db.agent.findUniqueOrThrow({where:{id:agentId}})).systemMemoryId!;
 const nodes=[
  {loc:'conversations',name:'conversations'},
  {loc:'conversations:research',name:'research',data:{stageOrder:['scope'],isSetup:false}},
  {loc:'conversations:research:scope',name:'scope',data:{promptRef:'prompts:research:scope'}},
  {loc:'prompts',name:'prompts'},
  {loc:'prompts:research',name:'research'},
  {loc:'prompts:research:scope',name:'scope',content:'Scope the research.'},
 ];
 for(const n of nodes) await db.node.create({data:{...n,id:generateId(),memoryId,nodeType:'system'}});
 await serveAgentBootPrompt(db,agentId,'PRIVATE ORG CHAT SENTINEL');
}
it('startChat never returns organization boot text to a non-member App participant',async()=>{
 await seedChatConversation();
 expect((await mutation.startChat({}, {agentId,scope:'private'},{...context(),appId})).systemMessage).toContain('PRIVATE ORG CHAT SENTINEL');
 await expect(mutation.startChat({}, {agentId,scope:'private'},{...context(outsiderId),appId}))
  .rejects.toMatchObject({code:'AGENT_NOT_FOUND'});
});
it('a later chat turn cannot re-serve org text after the individual participant loses membership',async()=>{
 await seedChatConversation();
 await db.orgMember.create({data:{organizationId:orgId,userId:outsiderId,role:'READER'}});
 const caller={...context(outsiderId),appId};
 const started=await mutation.startChat({}, {agentId,scope:'private'},caller);
 expect(started.systemMessage).toContain('PRIVATE ORG CHAT SENTINEL');
 // Use a legal user-owned holding memory so its independent write right survives org removal.
 const chat=await chatNodeByLocOrThrow(db,started.chatId);
 await db.memory.update({where:{id:chat.memoryId},data:{organizationId:null,ownerUserId:outsiderId,appId:null}});
 expect((await mutation.sendChatMessage({}, {chatId:started.chatId,userMessage:'Member control'},caller)).systemMessage).toContain('PRIVATE ORG CHAT SENTINEL');
 await db.orgMember.update({where:{organizationId_userId:{organizationId:orgId,userId:outsiderId}},data:{deletedAt:new Date()}});
 await expect(mutation.sendChatMessage({}, {chatId:started.chatId,userMessage:'Continue'},caller))
  .rejects.toMatchObject({code:'AGENT_NOT_FOUND'});
});
it('a missing personal owner cannot match a null Agent owner in the shared install predicate',async()=>{
 const agent=await db.agent.findUniqueOrThrow({where:{id:agentId}});
 await expect(requirePersonalAppAgentInstall(context(),agent,agentId,null))
  .rejects.toMatchObject({extensions:{code:'ORGANIZATION_MISMATCH'}});
});
it('the database excludes the dual-owned Agent assumed by the own-org licence finding',async()=>{
 await expect(db.agent.update({where:{id:agentId},data:{ownerUserId:ownerId}})).rejects.toThrow(/chk_agent_owner_xor/);
});
it('retained-install chat refusal does not disclose an unreadable Agent current name',async()=>{
 await db.orgMember.update({where:{organizationId_userId:{organizationId:orgId,userId:ownerId}},data:{deletedAt:new Date()}});
 await db.agent.update({where:{id:agentId},data:{name:'UNREADABLE CURRENT NAME'}});
 try {
  await mutation.startChat({}, {agentId,scope:'private'},context());
  throw new Error('expected refusal');
 } catch(error) {
  expect(error).toMatchObject({extensions:{code:'BOOT_PROMPT_INSTALL_LICENSE_INACTIVE'}});
  expect(JSON.stringify(error)).not.toContain('UNREADABLE CURRENT NAME');
 }
});
it('install-memory write point and list agree for a non-member manager and after membership is granted',async()=>{
 await db.appMember.update({where:{appId_userId:{appId,userId:outsiderId}},data:{role:'owner'}});
 expect((await installMemoryAudience(db,context(outsiderId),await installRow())).write).toBe(false);
 expect(await writableInstallMemoryIds(db,context(outsiderId))).not.toContain(installMemoryId);
 await db.orgMember.create({data:{organizationId:orgId,userId:outsiderId,role:'READER'}});
 expect((await installMemoryAudience(db,context(outsiderId),await installRow())).write).toBe(true);
 expect(await writableInstallMemoryIds(db,context(outsiderId))).toContain(installMemoryId);
});

for(const state of ['deleted','personal'] as const) it(`retained chat ${state} visibility never discloses the current Agent name`,async()=>{
 if(state==='personal') await db.orgMember.update({where:{organizationId_userId:{organizationId:orgId,userId:ownerId}},data:{deletedAt:new Date()}});
 await db.agent.update({where:{id:agentId},data:{name:'UNREADABLE RENAMED AGENT',...(state==='deleted'?{deletedAt:new Date()}:{visibility:'PERSONAL'})}});
 try {
  await mutation.startChat({}, {agentId,scope:'private'},context());
  throw new Error('expected refusal');
 } catch(error) {
  if(state==='deleted') expect(error).toMatchObject({code:'AGENT_NOT_FOUND'});
  else expect(error).toMatchObject({extensions:{code:'BOOT_PROMPT_INSTALL_LICENSE_INACTIVE'}});
  expect(JSON.stringify(error)).not.toContain('UNREADABLE RENAMED AGENT');
 }
});

for (const state of ['ex-member', 'personal'] as const) {
 for (const door of ['cast', 'preview'] as const) it(`${door} refuses a retained org install after ${state} licence loss`, async () => {
  await db.agent.update({where:{id:agentId},data:{personaRole:'researcher'}});
  if(state==='ex-member') await db.orgMember.update({where:{organizationId_userId:{organizationId:orgId,userId:ownerId}},data:{deletedAt:new Date()}});
  else await db.agent.update({where:{id:agentId},data:{visibility:'PERSONAL'}});
  const args={appRef:appId,agentRef:agentId,name:'RefusedCast'};
  const call=door==='cast' ? mutation.castWorker({},args,context()) : (resolvers.Query as any).castWorkerPreview({},args,context());
  await expect(call).rejects.toMatchObject({extensions:{code:'BOOT_PROMPT_INSTALL_LICENSE_INACTIVE'}});
  expect(await db.worker.count({where:{appId}})).toBe(0);
 });
}
it('reusing a retired Agent name preserves the retained org-text install memory audience', async () => {
 await db.orgMember.update({where:{organizationId_userId:{organizationId:orgId,userId:ownerId}},data:{role:'ADMIN'}});
 await mutation.uninstallAgentFromApp({}, {appRef:appId,agentRef:agentId},context());
 expect(await mutation.deleteAgent({}, {ref:agentId},context())).toBe(true);
 await expect(mutation.createAgent({}, {orgId,name:'Assistant',visibility:'ORGANIZATION'},context())).rejects.toMatchObject({extensions:{code:'AGENT_URN_TAKEN'}});
 expect((await installRow()).installOfAgentId).toBe(agentId);
 expect((await installMemoryAudience(db,context(outsiderId),await installRow())).read).toBe(false);
 expect(await readableInstallMemoryIds(db,context(outsiderId))).not.toContain(installMemoryId);
});

it('the App-scoped chat serve refuses when the individual stays a member but the owner licence ends',async()=>{
 await seedChatConversation();
 await db.orgMember.create({data:{organizationId:orgId,userId:outsiderId,role:'READER'}});
 const agent=await db.agent.findUniqueOrThrow({where:{id:agentId}});
 const caller={...context(outsiderId),appId};
 expect((await serveChatPrompt(db,agent,appId,null,caller)).text).toContain('PRIVATE ORG CHAT SENTINEL');
 await db.orgMember.update({where:{organizationId_userId:{organizationId:orgId,userId:ownerId}},data:{deletedAt:new Date()}});
 expect(await db.orgMember.findFirst({where:{organizationId:orgId,userId:outsiderId,deletedAt:null}})).not.toBeNull();
 await expect(serveChatPrompt(db,agent,appId,null,caller)).rejects.toMatchObject({code:'AGENT_NOT_FOUND'});
});

it('a refused bind conceals the current name of an unreadable retained Agent',async()=>{
 await db.agent.update({where:{id:agentId},data:{personaRole:'engineer'}});
 await serveAgentBootPrompt(db,agentId,'PRIVATE ORGANIZATION BRIEFING');
 const worker=await mutation.castWorker({}, {appRef:appId,agentRef:agentId,name:'Retained'},context());
 await db.agent.update({where:{id:agentId},data:{name:'UNREADABLE CURRENT AGENT NAME',visibility:'PERSONAL'}});
 await db.orgMember.update({where:{organizationId_userId:{organizationId:orgId,userId:ownerId}},data:{deletedAt:new Date()}});
 await expect(mutation.startSession({}, {input:{id:generateId(),tool:'vitest',appRef:appId,workerRef:worker.id,force:true}},context()))
  .rejects.toMatchObject({extensions:{code:'BOOT_PROMPT_INSTALL_LICENSE_INACTIVE',surface:'bind',agentName:''}});
 expect(await db.session.count({where:{workerId:worker.id}})).toBe(0);
 expect(await db.servedPrompt.count({where:{workerId:worker.id}})).toBe(0);
});
for(const clientId of ['app-key','run:synthetic1148']) it(`userless ${clientId} gains no personal org chat text`,async()=>{
 await expect(mutation.startChat({}, {agentId,scope:'private'},{db,appId,clientId,roles:[]}))
  .rejects.toMatchObject({code:'AGENT_NOT_FOUND'});
});
it('fresh chat serving preserves PUBLIC and own-Agent controls outside the personal-org rule',async()=>{
 await serveAgentBootPrompt(db,agentId,'PUBLIC CONTROL');
 await db.agent.update({where:{id:agentId},data:{visibility:'PUBLIC'}});
 await db.orgMember.update({where:{organizationId_userId:{organizationId:orgId,userId:ownerId}},data:{deletedAt:new Date()}});
 const publicAgent=await db.agent.findUniqueOrThrow({where:{id:agentId}});
 expect((await serveChatPrompt(db,publicAgent,appId,null,context(outsiderId))).text).toContain('PUBLIC CONTROL');
 const own=await mutation.createAgent({}, {name:'Own control'},context());
 await serveAgentBootPrompt(db,own.id,'OWN CONTROL');
 expect((await serveChatPrompt(db,own,null,null,context())).text).toContain('OWN CONTROL');
});
