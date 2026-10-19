import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
/** #2021/#2023: head-fixed mode spans consume only internal coverage decisions. */
import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {PrismaClient} from '../../generated/prisma/index.js';
import {generateId} from '../id.js';
import {deliveryWait} from './deliveryWait.js';
import {beginDeliveryTracking,deliveryStateTransaction,loadDeliveryWait,observeDeliveryPolicyThrough,transitionDeliveryException,type StandbyCoverageClassifier} from './deliveryState.js';
const db=new PrismaClient();
const at=(m:number)=>new Date(Date.UTC(2026,9,19,10,m));
const orgId=generateId(),appId=generateId(),agentId=generateId(),workerId=generateId();
const message={workerId,channelId:'standby-channel',channelIncarnation:1,seq:1,dueSince:at(0)};
const tracking={trackedFrom:at(0),observedThrough:at(30)};
const span=(headWorkerId:string,from=5,to=20)=>({workerId,cause:'standby' as const,coverage:{kind:'standby-mode' as const,headWorkerId},startedAt:at(from),endedAt:at(to)});
const run=<T>(fn:Parameters<typeof deliveryStateTransaction<T>>[3])=>deliveryStateTransaction(db,appId,workerId,fn);
beforeAll(async()=>{
 await db.organization.create({data:{id:orgId,name:'Mode span',urn:`mode-${orgId}.example`}});
 await db.agent.create({data:{id:agentId,organizationId:orgId,name:'Mode',urn:`mode-${orgId}.example:agent`}});
 await db.app.create({data:{id:appId,organizationId:orgId,name:'Mode',urn:`mode-${orgId}.example:app`}});
 await db.worker.create({data:{ ...WORKER_SIGNATURE_DEFAULTS,id:workerId,appId,agentId,name:'Mode worker',slug:'mode-worker'}});
});
beforeEach(async()=>{
 await db.workerDeliveryWaitException.deleteMany({where:{workerId}});
 await db.workerDeliveryWaitState.deleteMany({where:{workerId}});
 await run(tx=>beginDeliveryTracking(tx,workerId,at(0)));
});
afterAll(async()=>{
 await db.worker.delete({where:{id:workerId}});await db.app.delete({where:{id:appId}});
 await db.agent.delete({where:{id:agentId}});await db.organization.delete({where:{id:orgId}});await db.$disconnect();
});
it('deducts only held mode time and preserves wait earned before entry and after exit',()=>{
 const classified={...message,standbyCoverage:new Map([['head-a',true]])};
 expect(deliveryWait(classified,[span('head-a')],tracking,at(25)).waitedMs).toBe(10*60000);
 expect(deliveryWait({...classified,dueSince:at(12)},[span('head-a')],tracking,at(25)).waitedMs).toBe(5*60000);
});
it('a message allowed for that captured head remains waiting throughout standby',()=>{
 expect(deliveryWait({...message,standbyCoverage:new Map([['head-a',false]])},[span('head-a')],tracking,at(25)).waitedMs).toBe(25*60000);
});
it('missing classification is unavailable rather than assuming either held or allowed',()=>{
 expect(()=>deliveryWait(message,[span('head-a')],tracking,at(25))).toThrow('DELIVERY_WAIT_INCOMPLETE');
});
it('a changed head uses each historical span head without resetting earlier wait',()=>{
 const classified={...message,standbyCoverage:new Map([['head-a',true],['head-b',false]])};
 expect(deliveryWait(classified,[span('head-a',5,10),span('head-b',10,20)],tracking,at(25)).waitedMs).toBe(20*60000);
});
it('persists mode coverage and calls the internal classifier with exact message identity',async()=>{
 await run(tx=>transitionDeliveryException(tx,{workerId,cause:'standby',coverage:span('head-a').coverage,effectiveAt:at(5),until:at(20),active:true}));
 await run(tx=>observeDeliveryPolicyThrough(tx,workerId,at(30)));
 await expect(run(tx=>loadDeliveryWait(tx,message,at(25)))).rejects.toThrow('DELIVERY_WAIT_INCOMPLETE');
 const classify=vi.fn<StandbyCoverageClassifier>(async(_tx,args)=>({held:true,headWorkerId:args.headWorkerId}));
 const answer=await run(tx=>loadDeliveryWait(tx,message,at(25),classify));
 expect(answer.waitedMs).toBe(10*60000);
 expect(classify).toHaveBeenCalledTimes(1);
 expect(classify.mock.calls[0][1]).toEqual({workerId,channelId:message.channelId,incarnation:1,seq:1,headWorkerId:'head-a'});
 const stored=await db.workerDeliveryWaitException.findMany({where:{workerId}});
 expect(stored).toHaveLength(1);expect(stored[0].coverageKey).toBe('standby-mode:head-a');
 expect(stored[0]).toMatchObject({channelId:null,channelIncarnation:null,fromSeq:null,throughSeq:null});
});
it('rejects mismatched classifier head and never certifies policy time from its answer',async()=>{
 await run(tx=>transitionDeliveryException(tx,{workerId,cause:'standby',coverage:span('head-a').coverage,effectiveAt:at(5),until:at(20),active:true}));
 await run(tx=>observeDeliveryPolicyThrough(tx,workerId,at(30)));
 const before=await db.workerDeliveryWaitState.findUniqueOrThrow({where:{workerId}});
 await expect(run(tx=>loadDeliveryWait(tx,message,at(25),async()=>({held:true,headWorkerId:'other'})))).rejects.toThrow('DELIVERY_WAIT_INCOMPLETE');
 expect(await db.workerDeliveryWaitState.findUniqueOrThrow({where:{workerId}})).toEqual(before);
});
it.each(['wake-budget','wake-paused','isolated'] as const)('mode coverage is not admitted for %s',async cause=>{
 await expect(run(tx=>transitionDeliveryException(tx,{workerId,cause,coverage:span('head-a').coverage,effectiveAt:at(5),active:true}))).rejects.toThrow('DELIVERY_COVERAGE_INVALID');
 expect(await db.workerDeliveryWaitException.count({where:{workerId}})).toBe(0);
});

it('does not trust a caller-supplied coverage map when the canonical classifier is absent',async()=>{
 await run(tx=>transitionDeliveryException(tx,{workerId,cause:'standby',coverage:span('head-a').coverage,effectiveAt:at(5),until:at(20),active:true}));
 await run(tx=>observeDeliveryPolicyThrough(tx,workerId,at(30)));
 await expect(run(tx=>loadDeliveryWait(tx,{...message,standbyCoverage:new Map([['head-a',false]])},at(25)))).rejects.toThrow('DELIVERY_WAIT_INCOMPLETE');
});
it('ignores mode intervals ending before a message becomes due without requiring classification',async()=>{
 await run(tx=>transitionDeliveryException(tx,{workerId,cause:'standby',coverage:span('head-a').coverage,effectiveAt:at(5),until:at(20),active:true}));
 await run(tx=>observeDeliveryPolicyThrough(tx,workerId,at(30)));
 expect((await run(tx=>loadDeliveryWait(tx,{...message,dueSince:at(20)},at(25)))).waitedMs).toBe(5*60000);
});
it('rolls back an atomic head split with its deciding transaction',async()=>{
 await run(tx=>transitionDeliveryException(tx,{workerId,cause:'standby',coverage:span('head-a').coverage,effectiveAt:at(5),active:true}));
 await expect(run(async tx=>{
  await transitionDeliveryException(tx,{workerId,cause:'standby',coverage:span('head-a').coverage,effectiveAt:at(10),active:false});
  await transitionDeliveryException(tx,{workerId,cause:'standby',coverage:span('head-b').coverage,effectiveAt:at(10),active:true});
  throw new Error('DECIDING_WRITE_FAILED');
 })).rejects.toThrow('DECIDING_WRITE_FAILED');
 expect(await db.workerDeliveryWaitException.findMany({where:{workerId},select:{coverageKey:true,endedAt:true}})).toEqual([{coverageKey:'standby-mode:head-a',endedAt:null}]);
});
it.each([
 ['standby','standby-mode:'],['standby','standby-mode:bad/head'],['isolated','standby-mode:head-a'],['wake-budget','standby-mode:head-a'],
])('database refuses invalid mode shape %s %s',async(cause,coverageKey)=>{
 await expect(db.workerDeliveryWaitException.create({data:{id:generateId(),workerId,cause,coverageKey,startedAt:at(5)}})).rejects.toThrow(/23514[\s\S]*chk_delivery_wait_exception/);
});
