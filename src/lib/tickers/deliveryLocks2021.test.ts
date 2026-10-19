import {afterAll,expect,it} from 'vitest';
import {PrismaClient,type Prisma} from '../../generated/prisma/index.js';
import {lockDeliveryWorkers,assertDeliveryWorkerLocked,transitionDeliveryException} from './deliveryState.js';
const db=new PrismaClient();
afterAll(()=>db.$disconnect());
const fake=()=>{
 const keys:string[]=[];
 const tx={$executeRaw:async(_s:TemplateStringsArray,...values:unknown[])=>{keys.push(String(values[0]));return 1;}} as unknown as Prisma.TransactionClient;
 return {tx,keys};
};
it('takes budget once then a deduplicated sorted complete wake set, including planned IDs',async()=>{
 const {tx,keys}=fake();
 await lockDeliveryWorkers(tx,'app',['z','a','z']);
 expect(keys).toEqual(['wakebudget:app','wake:a','wake:z']);
 assertDeliveryWorkerLocked(tx,'a');assertDeliveryWorkerLocked(tx,'z');
 await lockDeliveryWorkers(tx,'app',['z']);expect(keys).toHaveLength(3);
});
it('refuses a newly discovered worker or App without acquiring anything late',async()=>{
 const {tx,keys}=fake();await lockDeliveryWorkers(tx,'app',['a']);
 await expect(lockDeliveryWorkers(tx,'app',['a','b'])).rejects.toThrow('DELIVERY_LOCK_SET_STALE');
 await expect(lockDeliveryWorkers(tx,'other',['a'])).rejects.toThrow('DELIVERY_LOCK_SET_STALE');
 expect(keys).toEqual(['wakebudget:app','wake:a']);
 expect(()=>assertDeliveryWorkerLocked(tx,'b')).toThrow('DELIVERY_LOCK_NOT_HELD');
});
it('requires an interactive transaction and rejects use from a different transaction',async()=>{
 await expect(lockDeliveryWorkers(db as unknown as Prisma.TransactionClient,'app',['a'])).rejects.toThrow('DELIVERY_TRANSACTION_REQUIRED');
 const a=fake(),b=fake();await lockDeliveryWorkers(a.tx,'app',['a']);
 expect(()=>assertDeliveryWorkerLocked(b.tx,'a')).toThrow('DELIVERY_LOCK_NOT_HELD');
});
it('refuses a producer write before touching persistence without its held worker',async()=>{
 await db.$transaction(async tx=>{
  await expect(transitionDeliveryException(tx,{workerId:'unheld',cause:'isolated',coverage:{kind:'worker'},effectiveAt:new Date(),active:true})).rejects.toThrow('DELIVERY_LOCK_NOT_HELD');
 });
});
it('holds real budget/wake locks through rollback and releases them together',async()=>{
 let release!:()=>void,ready!:()=>void;
 const held=new Promise<void>(r=>{ready=r;}),gate=new Promise<void>(r=>{release=r;});
 const holder=db.$transaction(async tx=>{await lockDeliveryWorkers(tx,'lock-test-app',['lock-test-worker']);ready();await gate;throw new Error('ROLLBACK');});
 const outcome=holder.then(()=>null,error=>error as Error);
 await Promise.race([held,outcome.then(error=>{throw error??new Error('holder exited before locking');})]);
 try{
  const rows=await db.$queryRaw<Array<{budget:boolean;worker:boolean}>>`SELECT pg_try_advisory_xact_lock(hashtextextended(${'wakebudget:lock-test-app'},0)) AS budget, pg_try_advisory_xact_lock(hashtextextended(${'wake:lock-test-worker'},0)) AS worker`;
  expect(rows[0]).toEqual({budget:false,worker:false});
 }finally{release();expect(await outcome).toMatchObject({message:'ROLLBACK'});}
 const rows=await db.$queryRaw<Array<{budget:boolean;worker:boolean}>>`SELECT pg_try_advisory_xact_lock(hashtextextended(${'wakebudget:lock-test-app'},0)) AS budget, pg_try_advisory_xact_lock(hashtextextended(${'wake:lock-test-worker'},0)) AS worker`;
 expect(rows[0]).toEqual({budget:true,worker:true});
});

it('never treats a partially acquired set as held or extends it during a wait',async()=>{
 let release!:()=>void;
 const gate=new Promise<void>(r=>{release=r;});
 const tx={$executeRaw:async()=>{await gate;return 1;}} as unknown as Prisma.TransactionClient;
 const acquiring=lockDeliveryWorkers(tx,'app',['a']);
 expect(()=>assertDeliveryWorkerLocked(tx,'a')).toThrow('DELIVERY_LOCK_NOT_HELD');
 await expect(lockDeliveryWorkers(tx,'app',['b'])).rejects.toThrow('DELIVERY_LOCK_SET_STALE');
 release();await acquiring;assertDeliveryWorkerLocked(tx,'a');
});
it('failed acquisition cannot be reused as a held set',async()=>{
 const tx={$executeRaw:async()=>{throw new Error('LOCK_FAILED');}} as unknown as Prisma.TransactionClient;
 await expect(lockDeliveryWorkers(tx,'app',['a'])).rejects.toThrow('LOCK_FAILED');
 expect(()=>assertDeliveryWorkerLocked(tx,'a')).toThrow('DELIVERY_LOCK_NOT_HELD');
 await expect(lockDeliveryWorkers(tx,'app',['a'])).rejects.toThrow('DELIVERY_LOCK_SET_STALE');
});
