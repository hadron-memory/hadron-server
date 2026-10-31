import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import * as busClient from '../../../lib/bus/index.js';
import * as nodeEvents from '../../../lib/events/nodeWritten.js';
import * as runKernel from '../../../jobs/appRuns.js';
import * as nodeWrite from './resolvers.mutation.node.js';
import * as manualRun from './resolvers.appRun.js';
import { writeNodeToGit } from '../../../integrations/github/writeNodeToGit.js';
import { setQuotaLimit } from '../../../jobs/appRuns.js';
import { resolvers, type Context } from './resolvers.js';
import { serveAgentBootPrompt } from '../../../test/servedBootPrompt.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({writeNodeToGit:vi.fn().mockResolvedValue(undefined)}));
let ctx: Context, memoryId: string, appId: string, taskId: string, agentId: string;
beforeEach(async () => {
  vi.clearAllMocks();
  await cleanDb(db);
  const org = await db.organization.create({data:{name:'Import refusal',urn:'import2737.test'}});
  const user = await db.user.create({data:{githubId:273701,githubUsername:'import2737-admin',roles:['ADMIN']}});
  await db.orgMember.create({data:{organizationId:org.id,userId:user.id,role:'ADMIN'}});
  ctx={db,userId:user.id,roles:['ADMIN'],clientId:`user:${user.id}`};
  const memory=await db.memory.create({data:{name:'Imports',urn:'import2737.test:imports',organizationId:org.id,class:'knowledge'}});
  memoryId=memory.id;
  const app=await db.app.create({data:{name:'Import App',urn:'import2737.test:app',organizationId:org.id}});
  appId=app.id;
  // #2712: serving is always on, so the run needs an installed Agent with a served prompt.
  agentId=(await db.agent.create({data:{name:'Importer',urn:'import2737.test:importer',organizationId:org.id}})).id;
  await db.appAgent.create({data:{appId,agentId} as never});
  await serveAgentBootPrompt(db,agentId,'You import.');
  const task=await db.node.create({data:{id:generateId(),memoryId,loc:'tasks:import',name:'Import',isRunnable:true,nodeType:'task',content:'Process {{importedNodeUrn}}'}});
  taskId=task.id;
});
afterEach(() => {vi.restoreAllMocks();vi.unstubAllEnvs();});
// The installed Agent loses its prompt, so the run is refused BOOT_PROMPT_NOT_SET (cor:agt:040:10).
const unserve=()=>db.agent.update({where:{id:agentId},data:{bootPromptNodeId:null,bootPromptUrn:null}});
const input=()=>({memoryId,loc:'clips:refused',content:'# Imported',contentType:'text/markdown',taskRef:taskId,appRef:appId});
describe('#2737 importNode run refusal',()=>{
  it('BOOT_PROMPT_NOT_SET leaves no imported node or run',async()=>{
    await unserve();
    await expect(resolvers.Mutation.importNode({}, {input:input()},ctx)).rejects.toMatchObject({extensions:{code:'BOOT_PROMPT_NOT_SET'}});
    expect(await db.node.findUnique({where:{loc_memoryId:{loc:'clips:refused',memoryId}}}),'refused import must not persist its node').toBeNull();
    expect(await db.appRun.count()).toBe(0);
    expect(await db.quotaCounter.count()).toBe(0);
  });
  it('a quota refusal leaves no imported node or node-write side effect', async()=>{
    await setQuotaLimit(db,'app',appId,'run.execute',0);
    await expect(resolvers.Mutation.importNode({}, {input:input()},ctx)).rejects.toMatchObject({extensions:{code:'QUOTA_EXCEEDED'}});
    expect(await db.node.findUnique({where:{loc_memoryId:{loc:'clips:refused',memoryId}}})).toBeNull();
    expect(await db.appRun.count()).toBe(0);
    expect(writeNodeToGit).not.toHaveBeenCalled();
  });
  it('a refused re-import preserves existing content and revision history', async()=>{
    const prior=await db.node.create({data:{memoryId,loc:'clips:refused',name:'Curated',content:'Original'}});
    const revisions=await db.nodeRevision.findMany({where:{nodeId:prior.id}});
    await unserve();
    await expect(resolvers.Mutation.importNode({}, {input:input()},ctx)).rejects.toMatchObject({extensions:{code:'BOOT_PROMPT_NOT_SET'}});
    expect(await db.node.findUnique({where:{id:prior.id}})).toMatchObject({content:'Original',name:'Curated',revSeq:prior.revSeq});
    expect(await db.nodeRevision.findMany({where:{nodeId:prior.id}})).toEqual(revisions);
  });
  it('an unexpected mint error rolls back the imported node', async()=>{
    vi.spyOn(manualRun,'mintManualRun').mockRejectedValueOnce(new Error('injected mint outage'));
    await expect(resolvers.Mutation.importNode({}, {input:input()},ctx)).rejects.toThrow('injected mint outage');
    expect(await db.node.findUnique({where:{loc_memoryId:{loc:'clips:refused',memoryId}}})).toBeNull();
  });
  it('successful import still creates its run and passes imported URN and args', async()=>{
    const result=await resolvers.Mutation.importNode({}, {input:{...input(),taskArgs:{tone:'brief'}}},ctx);
    expect(result.status).toBe('FETCH_PENDING');
    const run=await db.appRun.findUniqueOrThrow({where:{id:result.jobId!}});
    expect(run).toMatchObject({appId,triggerKind:'MANUAL',status:'PENDING',eventData:{tone:'brief',importedNodeUrn:'hrn:node:import2737.test:imports:clips:refused'}});
    expect(result.node.content).toBe('# Imported');
    // Positive control for the zero-count rollback assertions below.
    const quotaWhere={scopeKind:'app',scopeId:appId,action:'run.execute'};
    expect(await db.quotaCounter.count({where:quotaWhere})).toBe(1);
    expect((await db.quotaCounter.findFirstOrThrow({where:quotaWhere})).used).toBe(1);
  });
  it('import without task still returns STORED and creates no run', async()=>{
    const result=await resolvers.Mutation.importNode({}, {input:{...input(),taskRef:null}},ctx);
    expect(result).toMatchObject({status:'STORED',jobId:null});
    expect(await db.appRun.count()).toBe(0);
  });
  it('the pre-write launch gate still denies a cross-org App before mint', async()=>{
    const other=await db.organization.create({data:{name:'Other',urn:'other2737.test'}});
    const app=await db.app.create({data:{name:'Other',urn:'other2737.test:app',organizationId:other.id}});
    const mint=vi.spyOn(manualRun,'mintManualRun');
    await expect(resolvers.Mutation.importNode({}, {input:{...input(),appRef:app.id}},ctx)).rejects.toMatchObject({extensions:{code:'BAD_USER_INPUT'}});
    expect(mint).not.toHaveBeenCalled();
    expect(await db.node.findUnique({where:{loc_memoryId:{loc:'clips:refused',memoryId}}})).toBeNull();
  });

  it('refusal publishes neither node nor run wake effects', async()=>{
    const nodeWritten=vi.spyOn(nodeEvents,'publishNodeWritten');
    const runRequested=vi.spyOn(runKernel,'publishRunRequested');
    await unserve();
    await expect(resolvers.Mutation.importNode({}, {input:input()},ctx)).rejects.toMatchObject({extensions:{code:'BOOT_PROMPT_NOT_SET'}});
    expect(nodeWritten).not.toHaveBeenCalled();
    expect(runRequested).not.toHaveBeenCalled();
  });
  it('publishes effects only when the committed node and run are visible', async()=>{
    const observed: boolean[]=[];
    const runRequested=vi.spyOn(runKernel,'publishRunRequested').mockImplementation(async (pooled,id)=>{
      observed.push(!!await pooled.appRun.findUnique({where:{id}}) && !!await pooled.node.findUnique({where:{loc_memoryId:{loc:'clips:refused',memoryId}}}));
    });
    const nodeWritten=vi.spyOn(nodeEvents,'publishNodeWritten');
    await resolvers.Mutation.importNode({}, {input:input()},ctx);
    expect(runRequested).toHaveBeenCalledTimes(1);
    expect(observed).toEqual([true]);
    expect(nodeWritten).toHaveBeenCalledTimes(1);
  });
  it('a node write refusal creates no run and preserves quota', async()=>{
    await expect(resolvers.Mutation.importNode({}, {input:{...input(),name:'',nodeType:'comment'}},ctx)).rejects.toThrow();
    expect(await db.appRun.count()).toBe(0);
    expect(await db.quotaCounter.count({where:{scopeId:appId}})).toBe(0);
  });

  it('the broker never receives a run wake for uncommitted state', async()=>{
    const observed: boolean[]=[];
    const publish=vi.fn(async(subject:string, event:unknown)=>{
      if(subject===runKernel.RUN_REQUESTED_SUBJECT) {
        const {runId}=event as {runId:string};
        observed.push(!!await db.appRun.findUnique({where:{id:runId}}));
      }
    });
    vi.spyOn(busClient,'getBusClient').mockResolvedValue({publish} as never);
    await resolvers.Mutation.importNode({}, {input:input()},ctx);
    expect(observed).toEqual([true]);
  });

  it('an error after a real mint rolls back its run and consumed quota', async()=>{
    const mint=manualRun.mintManualRun;
    vi.spyOn(manualRun,'mintManualRun').mockImplementation(async (...args)=>{
      await mint(...args);
      throw new Error('injected after successful mint');
    });
    await expect(resolvers.Mutation.importNode({}, {input:input()},ctx)).rejects.toThrow('injected after successful mint');
    expect(await db.appRun.count()).toBe(0);
    expect(await db.quotaCounter.count()).toBe(0);
    expect(await db.node.findUnique({where:{loc_memoryId:{loc:'clips:refused',memoryId}}})).toBeNull();
  });
  for(const asyncEffect of [false,true]) it(`a failing ${asyncEffect?'async':'sync'} committed effect does not reject the import or skip its wake`, async()=>{
    const write=nodeWrite.writeNodeCore;
    let injectedEffects=0;
    vi.spyOn(console,'error').mockImplementation(()=>{});
    vi.spyOn(nodeWrite,'writeNodeCore').mockImplementation((node,context,mode,options)=>{
      const transaction=options!.transaction!;
      transaction.afterCommit(()=>{
        injectedEffects++;
        if(asyncEffect) return Promise.reject(new Error('injected effect failure'));
        throw new Error('injected effect failure');
      });
      return write(node,context,mode,options);
    });
    const wake=vi.spyOn(runKernel,'publishRunRequested');
    const written=vi.spyOn(nodeEvents,'publishNodeWritten');
    const result=await resolvers.Mutation.importNode({}, {input:input()},ctx);
    expect(result.status).toBe('FETCH_PENDING');
    expect(await db.appRun.count()).toBe(1);
    expect(injectedEffects, 'the injected failing callback must actually run').toBe(1);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(written).toHaveBeenCalledTimes(1);
  });
  it('a rejected post-commit run wake preserves the successful result',async()=>{
    vi.spyOn(console,'error').mockImplementation(()=>{});
    const wake=vi.spyOn(runKernel,'publishRunRequested').mockRejectedValueOnce(new Error('injected wake failure'));
    const result=await resolvers.Mutation.importNode({}, {input:input()},ctx);
    expect(result.status).toBe('FETCH_PENDING');
    expect(wake).toHaveBeenCalledTimes(1);
    expect(await db.appRun.findUniqueOrThrow({where:{id:result.jobId!}})).toMatchObject({status:'PENDING',publishedAt:null});
    expect(await db.appRun.count()).toBe(1);
    expect(await db.node.findUnique({where:{loc_memoryId:{loc:'clips:refused',memoryId}}})).not.toBeNull();
  });
  it('a non-import manual run still publishes its wake by default',async()=>{
    const observed:string[]=[];
    vi.spyOn(busClient,'getBusClient').mockResolvedValue({publish:async(subject:string)=>{observed.push(subject);}} as never);
    const run=await manualRun.triggerManualRun(ctx,{appRef:appId,entryNodeUrn:'hrn:node:import2737.test:imports:tasks:import'});
    expect(observed.filter(s=>s===runKernel.RUN_REQUESTED_SUBJECT)).toHaveLength(1);
    expect((await db.appRun.findUniqueOrThrow({where:{id:run.id}})).publishedAt).not.toBeNull();
  });

});
