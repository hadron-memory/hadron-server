/** #2168 security regressions. Three-org fixture adapted from Riana's private
 * review reproduction; committed assertions and controls are the author's. */
import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey, createDbAgentOrgGrant, createDbAgentSubscription, createDbAgentImport } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { serveAgentBootPrompt } from '../../../test/servedBootPrompt.js';
import { loadOfferedMemberRoles } from '../../../lib/memberRoles.js';
import { appContextIfReadable } from '../../../lib/scopes.js';
import { hasAppRelationship } from '../../../lib/auth/appRelationship.js';
import { isAgentInstalled, isAgentInstalledAndLicensed } from '../../../lib/appAgent.js';
import { mintAppRun } from '../../../jobs/appRuns.js';
import { assertManualRunAllowed } from './resolvers.appRun.js';
import { resolvers, type Context } from './resolvers.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
const org = (name: string) => db.organization.create({ data: { name, urn: `license-${generateId().toLowerCase()}.example` } });
const user = () => db.user.create({ data: { handle: `license-${generateId()}`, roles: ['READER'] } });
let holder: {id:string}, owner: {id:string}, target: {id:string}, app: {id:string}, admin: {id:string}, stranger: {id:string}, entry: string;
const ctx = (): Context => ({ db, userId: admin.id, roles: ['READER'] });
beforeEach(async () => {
  await cleanDb(db);
  const importerOrg = await org('Importer');
  owner = await org('Target'); holder = await org('Holder');
  admin = await user(); stranger = await user();
  for (const organizationId of [owner.id, importerOrg.id, holder.id])
    await db.orgMember.create({ data: { organizationId, userId: admin.id, role: 'ADMIN' } });
  target = await M.createAgent({}, {orgId:owner.id,name:'Target',personaRole:'reviewer'},ctx());
  const parent = await M.createAgent({}, {orgId:importerOrg.id,name:'Parent',personaRole:'suite'},ctx());
  await serveAgentBootPrompt(db,target.id,'PRIVATE TARGET PROMPT');
  await serveAgentBootPrompt(db,parent.id,'PARENT PROMPT');
  await createDbAgentOrgGrant(db,importerOrg.id,target.id);
  await createDbAgentOrgGrant(db,holder.id,parent.id);
  await createDbAgentImport(db,parent.id,target.id);
  ({app} = await createDbAppWithKey(db,'License app',holder.id));
  await db.app.update({where:{id:app.id},data:{createUserPermission:'IMPLICIT'}});
  await db.appAgent.create({data:{appId:app.id,agentId:parent.id}});
  const memory = await db.memory.create({data:{name:'Entry',urn:`${holder.id}:entry`,class:'app',appId:app.id,organizationId:holder.id}});
  await db.node.create({data:{memoryId:memory.id,loc:'flow:entry',name:'Entry',content:'Run',nodeType:'record'}});
  entry = `hrn:node:${holder.id}:entry:flow:entry`;
  expect(await isAgentInstalled(db,app.id,target.id)).toBe(true);
  expect(await isAgentInstalledAndLicensed(db,app.id,target.id)).toBe(false);
});
const mint = () => mintAppRun(db,{organizationId:holder.id,appId:app.id,agentId:target.id,triggerKind:'MANUAL',entryNodeUrn:entry,publish:false});
const session = () => M.startAgentSession({}, {agentId:target.id,externalUserId:'synthetic'}, {db,appId:app.id,organizationId:holder.id,roles:[]} as Context);
it('mint refuses an unlicensed derived Agent before a run or served prompt is written',async()=>{
  const prompts = await db.servedPrompt.count();
  await expect(mint()).rejects.toMatchObject({code:'AGENT_NOT_INSTALLED'});
  expect(await db.appRun.count()).toBe(0);
  expect(await db.servedPrompt.count()).toBe(prompts);
});
it('manual run selection refuses the same unlicensed derived Agent',async()=>{
  await expect(assertManualRunAllowed(ctx(),{appRef:app.id,entryNodeUrn:entry,agentRef:target.id})).rejects.toMatchObject({extensions:{code:'BAD_USER_INPUT'}});
  expect(await db.appRun.count()).toBe(0);
});
it('an App key cannot provision a session or foreign personal memory through an unlicensed import',async()=>{
  const memories = await db.memory.count(); const users = await db.user.count();
  await expect(session()).rejects.toMatchObject({extensions:{code:'FORBIDDEN'}});
  expect(await db.session.count()).toBe(0);
  expect(await db.memory.count()).toBe(memories);
  expect(await db.user.count()).toBe(users);
});
it('a subscription to an unlicensed derived Agent is not an App relationship',async()=>{
  expect(await hasAppRelationship(db,app.id,stranger.id)).toBe(false);
  await createDbAgentSubscription(db,stranger.id,target.id);
  await expect(hasAppRelationship(db,app.id,stranger.id)).resolves.toBe(false);
});
it('the App holder own live grant admits mint and session, and revocation closes both again',async()=>{
  await createDbAgentOrgGrant(db,holder.id,target.id);
  expect(await isAgentInstalledAndLicensed(db,app.id,target.id)).toBe(true);
  const run = await mint(); expect(run.agentId).toBe(target.id);
  expect(await db.servedPrompt.findFirst({where:{runId:run.id}})).not.toBeNull();
  expect(await session()).toMatchObject({agentId:target.id});
  await db.agentOrgGrant.update({where:{orgId_agentId:{orgId:holder.id,agentId:target.id}},data:{revokedAt:new Date()}});
  await expect(mint()).rejects.toMatchObject({code:'AGENT_NOT_INSTALLED'});
  await expect(session()).rejects.toMatchObject({extensions:{code:'FORBIDDEN'}});
});

it.each(['roles','scope'] as const)('unlicensed derived Agents confer no %s authority',async(surface)=>{
  await db.agent.update({where:{id:target.id},data:{installationPolicy:{memberRoles:['foreign-role']}}});
  const offered=async()=>surface==='roles'?(await loadOfferedMemberRoles(db,app.id)).roles:(await appContextIfReadable(ctx(),app.id))!.agentIds;
  const value=surface==='roles'?'foreign-role':target.id;
  expect(await offered()).not.toContain(value);
  await createDbAgentOrgGrant(db,holder.id,target.id);
  expect(await offered()).toContain(value);
});

it('scoped FIT6637143908: a licensed derived subscription counts as an App relationship',async()=>{
  await createDbAgentSubscription(db,stranger.id,target.id);
  await createDbAgentOrgGrant(db,holder.id,target.id);
  expect(await hasAppRelationship(db,app.id,stranger.id)).toBe(true);
});

it.each(['inactive','revoked','expired'] as const)('same-org derived entries cannot use a retained %s grant',async(state)=>{
 await db.agent.update({where:{id:target.id},data:{organizationId:holder.id,installationPolicy:{memberRoles:['foreign-role']}}});
 await createDbAgentSubscription(db,stranger.id,target.id);
 await createDbAgentOrgGrant(db,holder.id,target.id);
 expect(await isAgentInstalledAndLicensed(db,app.id,target.id)).toBe(true);
 await db.agentOrgGrant.update({where:{orgId_agentId:{orgId:holder.id,agentId:target.id}},data:
  state==='inactive'?{activatedAt:null}:state==='revoked'?{revokedAt:new Date()}:{expiresAt:new Date(0)}});
 expect(await isAgentInstalled(db,app.id,target.id)).toBe(true);
 expect(await isAgentInstalledAndLicensed(db,app.id,target.id)).toBe(false);
 expect(await hasAppRelationship(db,app.id,stranger.id)).toBe(false);
 expect((await loadOfferedMemberRoles(db,app.id)).roles).not.toContain('foreign-role');
 expect((await appContextIfReadable(ctx(),app.id))!.agentIds).not.toContain(target.id);
 await expect(mint()).rejects.toMatchObject({code:'AGENT_NOT_INSTALLED'});
 await expect(session()).rejects.toMatchObject({extensions:{code:'FORBIDDEN'}});
});

// Operation doors historically accept a physical ROW without an App-holder
// license. The same target reached only by an import must not inherit that.
it.each(['mint', 'manual', 'session'] as const)('preserves physical ROW membership at the %s operation door', async (surface) => {
  const call = () => surface === 'mint' ? mint() : surface === 'manual'
    ? assertManualRunAllowed(ctx(), {appRef:app.id,entryNodeUrn:entry,agentRef:target.id}) : session();
  await expect(call()).rejects.toBeDefined();
  await db.appAgent.create({data:{appId:app.id,agentId:target.id}});
  expect(await isAgentInstalledAndLicensed(db,app.id,target.id)).toBe(false);
  await expect(call()).resolves.toMatchObject({agentId:target.id});
});

// #2168 changes the installation source, not mint's pre-existing subscriber
// lifecycle predicate. Shared manual/trigger relationship gates stay stricter.
it.each(['unactivated', 'expired'] as const)('preserves mint subscriber semantics for a physical ROW with an %s subscription', async (state) => {
  await db.appAgent.create({data:{appId:app.id,agentId:target.id}});
  await createDbAgentSubscription(db,stranger.id,target.id);
  await db.agentSubscription.updateMany({where:{userId:stranger.id,agentId:target.id},data:
    state === 'unactivated' ? {activatedAt:null} : {expiresAt:new Date(0)}});
  expect(await hasAppRelationship(db,app.id,stranger.id)).toBe(false);
  const run = await mintAppRun(db,{organizationId:holder.id,appId:app.id,agentId:target.id,userId:stranger.id,
    triggerKind:'MANUAL',entryNodeUrn:entry,publish:false});
  expect(run.userId).toBe(stranger.id);
  await db.agentSubscription.updateMany({where:{userId:stranger.id,agentId:target.id},data:{revokedAt:new Date()}});
  await expect(mintAppRun(db,{organizationId:holder.id,appId:app.id,agentId:target.id,userId:stranger.id,
    triggerKind:'MANUAL',entryNodeUrn:entry,publish:false})).rejects.toMatchObject({code:'RELATIONSHIP_MISSING'});
});
