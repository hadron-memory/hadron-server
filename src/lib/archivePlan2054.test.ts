/** Bounded protocol and real transport rollback/refusal pins for #2054. */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { typeDefs } from '../api/graphql/schema/typeDefs.js';
import { createTestableMcpServer } from '../mcp/server.js';
import { ArchivePlanStaleError, ArchivePlanExhaustedError, discoverArchivePlan, validateArchivePlan, withArchivePlanRetries } from './tombstoneArchive.js';
import { writeNodeToGit } from '../integrations/github/writeNodeToGit.js';
import { publishNodeWritten } from './events/nodeWritten.js';
import { acquireLockSet } from './nodeSubtreeLock.js';
import { observeTransactionBackend, waitForAdvisoryWaiter } from '../test/advisoryWaiter.js';
import { mirrorNodeMoveToGit } from '../integrations/github/mirrorNodeMove.js';
vi.mock('../integrations/github/writeNodeToGit.js',()=>({writeNodeToGit:vi.fn().mockResolvedValue(undefined)}));
vi.mock('../integrations/github/mirrorNodeMove.js',()=>({mirrorNodeMoveToGit:vi.fn().mockResolvedValue(undefined)}));
vi.mock('./events/nodeWritten.js',()=>({publishNodeWritten:vi.fn().mockResolvedValue(undefined)}));
vi.mock('./tombstoneArchive.js',async original=>{
  const actual=await original<typeof import('./tombstoneArchive.js')>();
  return {...actual,validateArchivePlan:vi.fn(actual.validateArchivePlan)};
});
let user:{id:string};let memory:{id:string;urn:string};
const context=():Context=>({db,userId:user.id,roles:['ADMIN']});
const auth=()=>({userId:user.id,roles:['ADMIN'],clientId:`user:${user.id}`}) as never;
const urn=(loc:string)=>`urn:node:${memory.urn}:${loc}`;
const node=(loc:string,deleted=false)=>db.node.create({data:{id:generateId(),memoryId:memory.id,loc,name:loc,nodeType:'info',content:`body-${loc}`,deletedAt:deleted?new Date():null}});
const validation=vi.mocked(validateArchivePlan);
let realValidate:typeof validateArchivePlan;
beforeEach(async()=>{
  realValidate=(await vi.importActual<typeof import('./tombstoneArchive.js')>('./tombstoneArchive.js')).validateArchivePlan;
  validation.mockReset();validation.mockImplementation(realValidate);
  vi.mocked(publishNodeWritten).mockClear();vi.mocked(writeNodeToGit).mockClear();vi.mocked(mirrorNodeMoveToGit).mockClear();
  await cleanDb(db);
  const org=await db.organization.create({data:{name:'plan2054',urn:'plan2054'}});
  user=await db.user.create({data:{githubId:2054001,githubUsername:'plan2054',roles:['ADMIN']}});
  await db.orgMember.create({data:{organizationId:org.id,userId:user.id,role:'ADMIN'}});
  memory=await resolvers.Mutation.createMemory({}, {orgId:org.id,name:'plan2054'},context());
});
afterEach(()=>{vi.restoreAllMocks();});

describe('bounded stale-plan retry policy',()=>{
  it.each([2,3])('succeeds on total attempt %s, with fresh attempts',async n=>{
    const attempt=vi.fn(async()=>{if(attempt.mock.calls.length<n)throw new ArchivePlanStaleError();return 'ok';});
    expect(await withArchivePlanRetries(attempt)).toBe('ok');expect(attempt).toHaveBeenCalledTimes(n);
  });
  it('exhausts after initial plus two retries only',async()=>{
    const attempt=vi.fn(async()=>{throw new ArchivePlanStaleError();});
    await expect(withArchivePlanRetries(attempt)).rejects.toBeInstanceOf(ArchivePlanExhaustedError);
    expect(attempt).toHaveBeenCalledTimes(3);
  });
  it.each(['40P01','FORBIDDEN','P2028','unavailable'])('does not retry %s',async code=>{
    const error=Object.assign(new Error('failure'),{code});const attempt=vi.fn(async()=>{throw error;});
    await expect(withArchivePlanRetries(attempt)).rejects.toBe(error);expect(attempt).toHaveBeenCalledTimes(1);
  });
  it('shares an outer deadline instead of renewing each transaction budget',async()=>{
    const clock=vi.spyOn(performance,'now');clock.mockReturnValueOnce(0).mockReturnValueOnce(10).mockReturnValueOnce(40).mockReturnValueOnce(70);
    const budgets:number[]=[];
    try {await withArchivePlanRetries(async remaining=>{budgets.push(remaining);if(budgets.length<3)throw new ArchivePlanStaleError();return true;},100);}
    finally {clock.mockRestore();}
    expect(budgets).toEqual([90,60,30]);
  });
});

async function gqlReserve(loc='target', caller=context()){
  const server=new ApolloServer<Context>({typeDefs,resolvers:resolvers as never,includeStacktraceInErrorResponses:false});
  try {
    const response=await server.executeOperation({query:'mutation($mem:ID!,$loc:String!){ reserveSpecCitation(memoryRef:$mem,loc:$loc){ id loc isPlaceholder } }',variables:{mem:memory.id,loc}}, {contextValue:caller});
    if(response.body.kind!=='single')throw new Error('expected single result');
    return response.body.singleResult;
  } finally {await server.stop();}
}

describe('real caller transports and rolled-back state',()=>{
  it('GraphQL exhaustion has fixed CONFLICT output and no committed placeholder/archive/effects',async()=>{
    const old=await node('target',true);await node('target:child',true);
    validation.mockRejectedValue(new ArchivePlanStaleError());
    const result=await gqlReserve();
    expect(validation).toHaveBeenCalledTimes(3);expect(result.data).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(result.errors![0]).toMatchObject({message:'Node addresses changed concurrently; re-read and retry.',extensions:{code:'CONFLICT'}});
    expect(Object.keys(result.errors![0].extensions??{})).toEqual(['code']);
    expect((await db.node.findUniqueOrThrow({where:{id:old.id}})).loc).toBe('target');
    expect(await db.node.count({where:{isPlaceholder:true}})).toBe(0);
    expect(await db.nodeRevision.count()).toBe(0);
    expect(writeNodeToGit).not.toHaveBeenCalled();expect(publishNodeWritten).not.toHaveBeenCalled();
  });
  it('MCP exhaustion retains exact existing message and ordinary refusal envelope',async()=>{
    const source=await node('source');const target=await node('target',true);
    validation.mockRejectedValue(new ArchivePlanStaleError());
    const result=await createTestableMcpServer(auth()).callTool('hadron_move_node',{urn:urn('source'),targetUrn:urn('target'),overwrite:true});
    expect(validation).toHaveBeenCalledTimes(3);
    expect(result).toHaveProperty('isError',true); // #1789: every refusal is a failed call
    expect(result.content).toEqual([{type:'text',text:'The node was moved concurrently; re-read it and retry.'}]);
    expect((await db.node.findUniqueOrThrow({where:{id:source.id}})).loc).toBe('source');
    expect((await db.node.findUniqueOrThrow({where:{id:target.id}})).loc).toBe('target');
    expect(await db.nodeRevision.count()).toBe(0);expect(mirrorNodeMoveToGit).not.toHaveBeenCalled();
  });
  it.each([2,3])('GraphQL success on attempt %s publishes only the successful effect set',async n=>{
    const old=await node('target',true);
    for(let i=1;i<n;i++)validation.mockRejectedValueOnce(new ArchivePlanStaleError());
    const result=await gqlReserve();expect(result.errors).toBeUndefined();expect(validation).toHaveBeenCalledTimes(n);
    expect(await db.node.count({where:{memoryId:memory.id,loc:'target',isPlaceholder:true}})).toBe(1);
    expect((await db.node.findUniqueOrThrow({where:{id:old.id}})).loc).toBe(`target__deleted-${old.id}`);
    expect(publishNodeWritten).toHaveBeenCalledTimes(1);
  });
  it('actual changed descendants invalidate a discovered plan before any row mutation',async()=>{
    const old=await node('target',true);
    const plan=await db.$transaction(tx=>discoverArchivePlan(tx,memory.id,'target'));
    await node('target:new-child');
    await expect(db.$transaction(tx=>realValidate(tx,plan))).rejects.toBeInstanceOf(ArchivePlanStaleError);
    expect((await db.node.findUniqueOrThrow({where:{id:old.id}})).loc).toBe('target');
  });
});

function latch(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};}
async function whileFirstAcquisitionWaits(change:(tx:any)=>Promise<unknown>){
  const held=latch(),release=latch();
  const blocker=db.$transaction(async tx=>{
    await acquireLockSet(tx,[{memoryId:memory.id,loc:'target'},{memoryId:memory.id,loc:'target:late'}]);
    held.resolve();await release.promise;await change(tx);
  },{timeout:20000});
  await held.promise;
  const observed=observeTransactionBackend(db);
  const pending=gqlReserve('target',{...context(),db:observed.db});
  try {
    const pid=await observed.backendFor(pending);
    await waitForAdvisoryWaiter(db,{pid,key:{form:'int-pair',first:memory.id,second:'target'}});
  } finally {release.resolve();await blocker;}
  return pending;
}

describe('changes after discovery and before the first address set is granted',()=>{
  it('replans a descendant inserted by the root-lock holder, before archive mutation/effects',async()=>{
    const old=await node('target',true);
    const result=await whileFirstAcquisitionWaits(tx=>tx.node.create({data:{id:generateId(),memoryId:memory.id,loc:'target:late',name:'late',nodeType:'info'}}));
    expect(result.errors).toBeUndefined();expect(validation).toHaveBeenCalledTimes(2);
    expect((await db.node.findUniqueOrThrow({where:{id:old.id}})).loc).toBe(`target__deleted-${old.id}`);
    expect(await db.node.count({where:{memoryId:memory.id,loc:'target:late',deletedAt:null}})).toBe(1);
    expect(await db.node.count({where:{memoryId:memory.id,isPlaceholder:true}})).toBe(1);
    expect(publishNodeWritten).toHaveBeenCalledTimes(1);
  });
  it('current denial wins over stale-plan exhaustion after a queued access revocation',async()=>{
    const old=await node('target',true);
    const result=await whileFirstAcquisitionWaits(async tx=>{
      await tx.user.update({where:{id:user.id},data:{roles:['READER']}});
      await tx.orgMember.deleteMany({where:{userId:user.id}});
    });
    const ordinary=await gqlReserve('target',{...context(),roles:['READER']});
    expect(result.errors?.map(e=>[e.message,e.extensions?.code])).toEqual(ordinary.errors?.map(e=>[e.message,e.extensions?.code]));
    expect(result.errors).toHaveLength(1);expect(result.errors![0].extensions?.code).not.toBe('CONFLICT');
    expect(validation).not.toHaveBeenCalled();expect((await db.node.findUniqueOrThrow({where:{id:old.id}})).loc).toBe('target');
    expect(publishNodeWritten).not.toHaveBeenCalled();
  });
  it('does not retry an authorization denial between two stale-plan attempts',async()=>{
    await node('target',true);
    validation.mockImplementationOnce(async()=>{
      await db.user.update({where:{id:user.id},data:{roles:['READER']}});
      await db.orgMember.deleteMany({where:{userId:user.id}});
      throw new ArchivePlanStaleError();
    });
    const result=await gqlReserve();
    expect(result.errors).toHaveLength(1);expect(result.errors![0].extensions?.code).not.toBe('CONFLICT');
    expect(validation).toHaveBeenCalledTimes(1);expect(await db.node.count({where:{isPlaceholder:true}})).toBe(0);
    expect(publishNodeWritten).not.toHaveBeenCalled();
  });
  it.each([2,3])('MCP move succeeds on attempt %s with one successful mirror',async n=>{
    const source=await node('source');const old=await node('target',true);
    for(let i=1;i<n;i++)validation.mockRejectedValueOnce(new ArchivePlanStaleError());
    const result=await createTestableMcpServer(auth()).callTool('hadron_move_node',{urn:urn('source'),targetUrn:urn('target'),overwrite:true});
    expect(result).not.toHaveProperty('isError',true);expect(validation).toHaveBeenCalledTimes(n);
    expect((await db.node.findUniqueOrThrow({where:{id:source.id}})).loc).toBe('target');
    expect((await db.node.findUniqueOrThrow({where:{id:old.id}})).loc).toBe(`target__deleted-${old.id}`);
    expect(mirrorNodeMoveToGit).toHaveBeenCalledTimes(1);
    expect(await db.nodeRevision.count({where:{nodeId:source.id}})).toBe(1);
  });
});

it('replans an occupant state changed by the root-lock holder, then preserves the ordinary live-collision refusal',async()=>{
  const old=await node('target',true);
  const result=await whileFirstAcquisitionWaits(tx=>tx.node.update({where:{id:old.id},data:{deletedAt:null}}));
  expect(validation).toHaveBeenCalledTimes(2);
  const ordinary=await gqlReserve();
  expect(result.errors?.map(e=>[e.message,e.extensions?.code])).toEqual(ordinary.errors?.map(e=>[e.message,e.extensions?.code]));
  expect(result.errors).toHaveLength(1);expect((await db.node.findUniqueOrThrow({where:{id:old.id}})).loc).toBe('target');
  expect(await db.node.count({where:{isPlaceholder:true}})).toBe(0);expect(publishNodeWritten).not.toHaveBeenCalled();
});
it('a late non-retryable failure rolls back archive and placeholder without publishing the queued effect',async()=>{
  const old=await node('target',true);const transaction=db.$transaction.bind(db);
  const observed=new Proxy(db,{get(target,key){
    if(key!=='$transaction')return Reflect.get(target,key,target);
    return (action:any,options:any)=>transaction(async tx=>action(new Proxy(tx,{get(t,k){
      if(k!=='node')return Reflect.get(t,k,t);
      return new Proxy(t.node,{get(model,method){
        if(method!=='update')return Reflect.get(model,method,model);
        return (args:any)=>{if(args.data?.isPlaceholder===true)throw new Error('forced late rollback');return model.update(args);};
      }});
    }})),options);
  }});
  const result=await gqlReserve('target',{...context(),db:observed});
  expect(result.errors).toHaveLength(1);expect(validation).toHaveBeenCalledTimes(1);
  expect((await db.node.findUniqueOrThrow({where:{id:old.id}})).loc).toBe('target');
  expect(await db.node.count({where:{isPlaceholder:true}})).toBe(0);
  expect(publishNodeWritten).not.toHaveBeenCalled();expect(await db.nodeRevision.count()).toBe(0);
});

describe('MCP source/destination revocation does not become plan conflict',()=>{
  it.each(['source','target'] as const)('between attempts: %s grant revocation stops retries and effects',async side=>{
    const source=await node('source');
    const other=await db.organization.create({data:{name:'other2054',urn:'other2054'}});
    await db.orgMember.create({data:{organizationId:other.id,userId:user.id,role:'ADMIN'}});
    const destination=await resolvers.Mutation.createMemory({}, {orgId:other.id,name:'destination2054'},context());
    await db.node.create({data:{id:generateId(),memoryId:destination.id,loc:'target',name:'target',nodeType:'info',deletedAt:new Date()}});
    const from=await db.memory.findUniqueOrThrow({where:{id:memory.id}});
    await db.user.update({where:{id:user.id},data:{roles:['READER']}});
    validation.mockImplementationOnce(async()=>{
      await db.orgMember.deleteMany({where:{userId:user.id,organizationId:side==='source'?from.organizationId!:other.id}});
      throw new ArchivePlanStaleError();
    });
    const caller={userId:user.id,roles:['READER'],clientId:`user:${user.id}`} as never;
    const text=await createTestableMcpServer(caller).callToolText('hadron_move_node',{urn:urn('source'),targetUrn:`urn:node:${destination.urn}:target`,overwrite:true});
    expect(text).toContain('Memory write access changed');expect(text).not.toContain('The node was moved concurrently');
    expect(validation).toHaveBeenCalledTimes(1);
    expect((await db.node.findUniqueOrThrow({where:{id:source.id}})).loc).toBe('source');
    expect(mirrorNodeMoveToGit).not.toHaveBeenCalled();expect(await db.nodeRevision.count()).toBe(0);
  });
  it.each(['source','target'] as const)('queued on first address: %s grant revocation wins',async side=>{
    const source=await node('source');
    const other=await db.organization.create({data:{name:'other2054',urn:'other2054'}});
    await db.orgMember.create({data:{organizationId:other.id,userId:user.id,role:'ADMIN'}});
    const destination=await resolvers.Mutation.createMemory({}, {orgId:other.id,name:'destination2054'},context());
    await db.node.create({data:{id:generateId(),memoryId:destination.id,loc:'target',name:'target',nodeType:'info',deletedAt:new Date()}});
    const from=await db.memory.findUniqueOrThrow({where:{id:memory.id}});
    await db.user.update({where:{id:user.id},data:{roles:['READER']}});
    const held=latch(),release=latch();
    const blocker=db.$transaction(async tx=>{
      await acquireLockSet(tx,[{memoryId:destination.id,loc:'target'}]);held.resolve();await release.promise;
      await tx.orgMember.deleteMany({where:{userId:user.id,organizationId:side==='source'?from.organizationId!:other.id}});
    },{timeout:20000});
    await held.promise;
    const observed=observeTransactionBackend(db);
    const spy=vi.spyOn(db,'$transaction').mockImplementation(observed.db.$transaction as never);
    const caller={userId:user.id,roles:['READER'],clientId:`user:${user.id}`} as never;
    const pending=createTestableMcpServer(caller).callToolText('hadron_move_node',{urn:urn('source'),targetUrn:`urn:node:${destination.urn}:target`,overwrite:true});
    try {
      const pid=await observed.backendFor(pending);
      await waitForAdvisoryWaiter(db,{pid,key:{form:'int-pair',first:destination.id,second:'target'}});
    } finally {release.resolve();await blocker;}
    const text=await pending;spy.mockRestore();
    expect(text).toContain('Memory write access changed');expect(validation).not.toHaveBeenCalled();
    expect((await db.node.findUniqueOrThrow({where:{id:source.id}})).loc).toBe('source');
    expect(mirrorNodeMoveToGit).not.toHaveBeenCalled();expect(await db.nodeRevision.count()).toBe(0);
  });
});

it.each(['queued','between'] as const)('a user deleted %s attempts cannot keep cached roles or create a placeholder',async stage=>{
  const old=await node('target',true);
  let result;
  if(stage==='queued') result=await whileFirstAcquisitionWaits(tx=>tx.user.update({where:{id:user.id},data:{deletedAt:new Date()}}));
  else {
    validation.mockImplementationOnce(async()=>{
      await db.user.update({where:{id:user.id},data:{deletedAt:new Date()}});
      throw new ArchivePlanStaleError();
    });
    result=await gqlReserve();
  }
  expect(result.errors).toHaveLength(1);expect(result.errors![0]).toMatchObject({message:'Forbidden',extensions:{code:'FORBIDDEN'}});
  expect(validation).toHaveBeenCalledTimes(stage==='queued'?0:1);
  expect((await db.node.findUniqueOrThrow({where:{id:old.id}})).loc).toBe('target');
  expect(await db.node.count({where:{isPlaceholder:true}})).toBe(0);expect(publishNodeWritten).not.toHaveBeenCalled();
});

describe('MCP move re-reads the caller per attempt (platform-role demotion, soft-deletion)',()=>{
  const revoke={
    demoted:(tx:Pick<typeof db,'user'>,id:string)=>tx.user.update({where:{id},data:{roles:['READER']}}),
    deleted:(tx:Pick<typeof db,'user'>,id:string)=>tx.user.update({where:{id},data:{deletedAt:new Date()}}),
  };
  // Write access here rests on the caller's PLATFORM role alone: no org membership at either end.
  const setup=async()=>{
    const source=await node('source');
    const other=await db.organization.create({data:{name:'other2054b',urn:'other2054b'}});
    await db.orgMember.create({data:{organizationId:other.id,userId:user.id,role:'ADMIN'}});
    const destination=await resolvers.Mutation.createMemory({}, {orgId:other.id,name:'destination2054b'},context());
    await db.node.create({data:{id:generateId(),memoryId:destination.id,loc:'target',name:'target',nodeType:'info',deletedAt:new Date()}});
    await db.orgMember.deleteMany({where:{userId:user.id}});
    return {source,destination};
  };
  const caller=()=>({userId:user.id,roles:['ADMIN'],clientId:`user:${user.id}`}) as never;
  it.each(['demoted','deleted'] as const)('between attempts: a %s caller stops retries and effects',async kind=>{
    const {source,destination}=await setup();
    validation.mockImplementationOnce(async()=>{await revoke[kind](db,user.id);throw new ArchivePlanStaleError();});
    const text=await createTestableMcpServer(caller()).callToolText('hadron_move_node',{urn:urn('source'),targetUrn:`urn:node:${destination.urn}:target`,overwrite:true});
    expect(text).toContain('Memory write access changed');expect(text).not.toContain('The node was moved concurrently');
    expect(validation).toHaveBeenCalledTimes(1);
    expect((await db.node.findUniqueOrThrow({where:{id:source.id}})).loc).toBe('source');
    expect(mirrorNodeMoveToGit).not.toHaveBeenCalled();expect(await db.nodeRevision.count()).toBe(0);
  });
  it.each(['demoted','deleted'] as const)('queued on the first address: a %s caller wins over the held lock',async kind=>{
    const {source,destination}=await setup();
    const held=latch(),release=latch();
    const blocker=db.$transaction(async tx=>{
      await acquireLockSet(tx,[{memoryId:destination.id,loc:'target'}]);held.resolve();await release.promise;
      await revoke[kind](tx,user.id);
    },{timeout:20000});
    await held.promise;
    const observed=observeTransactionBackend(db);
    const spy=vi.spyOn(db,'$transaction').mockImplementation(observed.db.$transaction as never);
    const pending=createTestableMcpServer(caller()).callToolText('hadron_move_node',{urn:urn('source'),targetUrn:`urn:node:${destination.urn}:target`,overwrite:true});
    try {
      const pid=await observed.backendFor(pending);
      await waitForAdvisoryWaiter(db,{pid,key:{form:'int-pair',first:destination.id,second:'target'}});
    } finally {release.resolve();await blocker;}
    const text=await pending;spy.mockRestore();
    expect(text).toContain('Memory write access changed');expect(validation).not.toHaveBeenCalled();
    expect((await db.node.findUniqueOrThrow({where:{id:source.id}})).loc).toBe('source');
    expect(mirrorNodeMoveToGit).not.toHaveBeenCalled();expect(await db.nodeRevision.count()).toBe(0);
  });
});
