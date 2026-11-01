import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { PrismaClient } from '../../generated/prisma/index.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { admitRate, admitRateInTx, assertRateReadiness, cleanupRateBuckets, configFence, RateLimited } from './index.js';
import { beginRateKeyOverlap, retireRateKey } from './lifecycle.js';
import { readRateKeys } from './config.js';
import { transportRateIdentity, internalRateIdentity } from './identity.js';
import { toolErrorResult } from '../../mcp/toolError.js';

const ring = { current:'old',keys:{old:'1'.repeat(64),new:'2'.repeat(64)} };
const id = { principal:'USER:a',key:'USER_KEY:a',ip:'192.0.2.1',internal:false };
beforeEach(async () => { vi.stubEnv('RATE_LIMIT_KEYRING',JSON.stringify(ring)); await cleanDb(db); await assertRateReadiness(db); });
afterEach(() => vi.unstubAllEnvs());
async function policy(fieldClass = 'FAN_OUT_READS', data: Record<string,unknown> = {}) {
  await db.rateLimitPolicy.update({where:{fieldClass},data:{principalLimit:2,keyLimit:100,ipLimit:100,enforcementMode:'ENFORCING',...data}});
}
const used = async () => (await db.rateLimitBucket.findMany({orderBy:{id:'asc'}})).map(r => ({...r,used:String(r.used)}));
describe('#1793 atomic shared admission', () => {
  it.each(['principal','key','ip'] as const)('exhausts %s independently, refusal changes no bucket', async dimension => {
    await policy('FAN_OUT_READS',{principalLimit:100,keyLimit:100,ipLimit:100,[dimension+'Limit']:1});
    await admitRate(db,'FAN_OUT_READS',id);
    const before = await used();
    await expect(admitRate(db,'FAN_OUT_READS',id)).rejects.toMatchObject({extensions:{code:'RATE_LIMITED',fieldClass:'FAN_OUT_READS'}});
    expect(await used()).toEqual(before);
    expect(JSON.stringify(before)).not.toContain('192.0.2.1');
    expect(JSON.stringify(before)).not.toContain('USER:a');
  });
  it('two connections at L-1 admit exactly one, counters never partially charge', async () => {
    await policy();await admitRate(db,'FAN_OUT_READS',id);
    const other = new PrismaClient();
    let release!:()=>void,entered!:()=>void,started!:()=>void;
    const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r),waiterReady=new Promise<void>(r=>started=r);
    let secondRead=false,pid=0;
    const first=db.$transaction(async tx=>{
      let once=true;
      const proxy=new Proxy(tx,{get(target,key){
        if(key==='rateLimitBucket')return {...target.rateLimitBucket,findMany:async(args:any)=>{
          const rows=await target.rateLimitBucket.findMany(args);
          if(once){once=false;entered();await gate;}return rows;
        }};
        return Reflect.get(target,key);
      }});
      return admitRateInTx(proxy,'FAN_OUT_READS',id);
    },{timeout:20_000});
    await ready;
    const second=other.$transaction(async tx=>{
      pid=(await tx.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`)[0].pid;started();
      const proxy=new Proxy(tx,{get(target,key){
        if(key==='rateLimitBucket')return {...target.rateLimitBucket,findMany:async(args:any)=>{secondRead=true;return target.rateLimitBucket.findMany(args);}};
        return Reflect.get(target,key);
      }});
      return admitRateInTx(proxy,'FAN_OUT_READS',id);
    },{timeout:20_000});
    const both=Promise.allSettled([first,second]);
    let blocked=false,readBeforeRelease=false;
    try {
      await waiterReady;
      for(let i=0;i<200&&!secondRead&&!blocked;i++){
        const rows=await db.$queryRaw<Array<{wait:string|null}>>`SELECT wait_event AS wait FROM pg_stat_activity WHERE pid=${pid}`;
        blocked=rows[0]?.wait==='advisory';if(!blocked&&!secondRead)await new Promise(r=>setTimeout(r,10));
      }
    } finally {readBeforeRelease=secondRead;release();}
    try {
      const results=await both;
      expect(blocked || readBeforeRelease).toBe(true);
      expect(readBeforeRelease).toBe(false);
      expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
      expect((await used()).every(r=>r.used==='2')).toBe(true);
    } finally {await other.$disconnect();}
  });
  it('rolls counters back with a failed deciding transaction', async () => {
    await policy();
    await expect(db.$transaction(async tx=>{await admitRateInTx(tx,'FAN_OUT_READS',id);throw new Error('insert failed');})).rejects.toThrow('insert failed');
    expect(await used()).toEqual([]);
  });
  it('LOG_ONLY counts over limit; same window refuses after activation without reset', async () => {
    await policy('FAN_OUT_READS',{enforcementMode:'LOG_ONLY',principalLimit:1});
    await admitRate(db,'FAN_OUT_READS',id);await admitRate(db,'FAN_OUT_READS',id);
    const before=await used();expect(before.every(r=>r.used==='2')).toBe(true);
    await policy('FAN_OUT_READS',{principalLimit:1});
    await expect(admitRate(db,'FAN_OUT_READS',id)).rejects.toBeInstanceOf(RateLimited);
    expect(await used()).toEqual(before);
  });
  it('overlap carries old budget, dual-writes max rather than sum, and cannot retire early', async () => {
    await policy();await admitRate(db,'FAN_OUT_READS',id);
    await beginRateKeyOverlap(db,'new');
    await admitRate(db,'FAN_OUT_READS',id);
    expect(await db.rateLimitBucket.count()).toBe(6);
    expect((await used()).every(r=>r.used==='2')).toBe(true);
    await expect(admitRate(db,'FAN_OUT_READS',id)).rejects.toBeInstanceOf(RateLimited);
    await expect(retireRateKey(db)).rejects.toThrow('readiness');
    await db.rateLimitManifest.update({where:{id:'global'},data:{overlapStartedAt:new Date(Date.now()-86401_000)}});
    await retireRateKey(db);
    await expect(admitRate(db,'FAN_OUT_READS',id)).rejects.toBeInstanceOf(RateLimited);
  });
  it('missing/changed configured HMAC key refuses readiness, no secret in error', async () => {
    vi.stubEnv('RATE_LIMIT_KEYRING',JSON.stringify({current:'old',keys:{old:'3'.repeat(64)}}));
    await expect(assertRateReadiness(db)).rejects.toThrow('readiness');
    vi.stubEnv('RATE_LIMIT_KEYRING','private-secret');expect(()=>readRateKeys()).toThrow('readiness');
  });
  it('env/restart preserves stored policy and current counts', async () => {
    await policy();await admitRate(db,'FAN_OUT_READS',id);
    vi.stubEnv('RATE_LIMIT_FAN_OUT_READS_PRINCIPAL','99');await assertRateReadiness(db);
    expect((await db.rateLimitPolicy.findUniqueOrThrow({where:{fieldClass:'FAN_OUT_READS'}})).principalLimit).toBe(2);
    expect((await used()).every(r=>r.used==='1')).toBe(true);
    expect((await cleanupRateBuckets(db)).count).toBe(0);
  });
  it('JWT omits key, impersonation charges actor, mapped IPv4 and /56 normalize', () => {
    expect(transportRateIdentity({userId:'u'},'::ffff:192.0.2.1')).toEqual({principal:'USER:u',key:undefined,ip:'192.0.2.1',internal:false});
    expect(transportRateIdentity({userId:'target',impersonation:{actorUserId:'actor'} as any},'2001:db8:1234:56aa::1').principal).toBe('USER:actor');
    expect(transportRateIdentity({},'2001:db8:1234:56aa::1').ip).toBe(transportRateIdentity({},'2001:db8:1234:56ff::2').ip);
    expect(internalRateIdentity('app')).toEqual({principal:'APP:app',internal:true});
  });
  it('missing external IP refuses credentials but trusted internal has no IP bucket', async () => {
    await policy('CREDENTIALS');
    await expect(admitRate(db,'CREDENTIALS',{principal:'USER:a',internal:false})).rejects.toBeInstanceOf(RateLimited);
    await admitRate(db,'CREDENTIALS',internalRateIdentity('app'));
    expect((await used()).map(r=>r.dimension)).toEqual(['principal']);
    await expect(admitRate(db,'FAN_OUT_READS',{internal:false})).rejects.toMatchObject({extensions:{code:'FORBIDDEN'}});
  });
  it('MCP typed refusal uses the existing structured error carrier, no prose parsing', () => {
    const r=toolErrorResult(new RateLimited('FAN_OUT_READS',5),()=> 'not used');
    expect(r).toMatchObject({isError:true,structuredContent:{error:{code:'RATE_LIMITED',retryAfterSeconds:5,fieldClass:'FAN_OUT_READS',message:'Too many requests.'}}});
  });
  it('waits on config before deciding; admin flip fences the attempt', async () => {
    await policy('FAN_OUT_READS',{enforcementMode:'LOG_ONLY',principalLimit:1});await admitRate(db,'FAN_OUT_READS',id);
    let unlock!:()=>void;const gate=new Promise<void>(r=>unlock=r);let locked!:()=>void;const entered=new Promise<void>(r=>locked=r);
    const writer=db.$transaction(async tx=>{await configFence(tx,true);await tx.rateLimitPolicy.update({where:{fieldClass:'FAN_OUT_READS'},data:{enforcementMode:'ENFORCING'}});locked();await gate;});
    await entered;const attempt=admitRate(db,'FAN_OUT_READS',id);unlock();await writer;
    await expect(attempt).rejects.toBeInstanceOf(RateLimited);
  });
});

it('#1793 class-row outage serves fail-open reads without any cached mode', async () => {
  const unavailable = Object.assign(new Error('private DB diagnostic'),{code:'P1001'});
  const fake = { $transaction: vi.fn().mockRejectedValue(unavailable) } as any;
  await expect(admitRate(fake,'FAN_OUT_READS',id)).resolves.toMatchObject({admitted:true});
  await expect(admitRate(fake,'WRITES',id)).resolves.toMatchObject({admitted:true});
  const programming = { $transaction: vi.fn().mockRejectedValue(new Error('bad implementation')) } as any;
  await expect(admitRate(programming,'FAN_OUT_READS',id)).rejects.toThrow('bad implementation');
});

it('#1793 valid snapshot counter outage is contained by a savepoint and follows mode', async () => {
  for (const enforcementMode of ['LOG_ONLY','ENFORCING']) {
    await policy('CREDENTIALS',{enforcementMode});
    await db.$transaction(async tx => {
      const proxy = new Proxy(tx,{get(target,key){
        if(key==='rateLimitBucket')return {findMany:async()=>{throw Object.assign(new Error('counter unavailable'),{code:'P1001'});}};
        return Reflect.get(target,key);
      }});
      if(enforcementMode==='ENFORCING')await expect(admitRateInTx(proxy,'CREDENTIALS',id)).rejects.toBeInstanceOf(RateLimited);
      else await expect(admitRateInTx(proxy,'CREDENTIALS',id)).resolves.toMatchObject({admitted:true});
      expect(await tx.rateLimitBucket.count()).toBe(0);
    });
  }
});

it('#1793 subject lock wait crossing UTC window charges the post-wait window', async () => {
  await policy('FAN_OUT_READS',{principalLimit:1});
  let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r);
  let oldStart:Date;
  const holder=db.$transaction(async tx=>{
    await admitRateInTx(tx,'FAN_OUT_READS',id);
    oldStart=(await tx.rateLimitBucket.findFirstOrThrow()).windowStart;
    entered();await gate;
  },{timeout:85_000});
  await ready;
  const waiter=db.$transaction(tx=>admitRateInTx(tx,'FAN_OUT_READS',id),{timeout:85_000});
  // The holder owns this subject's real advisory locks until after the next DB-clock boundary.
  const [{now}]=await db.$queryRaw<Array<{now:Date}>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
  const delay=60_000-(now.getTime()%60_000)+30;
  await new Promise(r=>setTimeout(r,delay));release();await holder;await waiter;
  const windows=await db.rateLimitBucket.findMany({where:{dimension:'principal'},orderBy:{windowStart:'asc'}});
  expect(windows).toHaveLength(2);
  expect(windows[0].windowStart).toEqual(oldStart!);
  expect(windows[1].windowStart.getTime()).toBeGreaterThan(oldStart!.getTime());
  expect(windows.every(r=>r.used===1n)).toBe(true);
},90_000);

it('#1793 unequal overlap aliases count max not sum, on one common window', async () => {
  await policy('FAN_OUT_READS',{principalLimit:10});await admitRate(db,'FAN_OUT_READS',id);
  await beginRateKeyOverlap(db,'new');await admitRate(db,'FAN_OUT_READS',id);
  await db.rateLimitBucket.updateMany({where:{subject:{startsWith:'new:'}},data:{used:1n}});
  await admitRate(db,'FAN_OUT_READS',id);
  expect((await used()).every(r=>r.used==='3')).toBe(true);
});

it('#1793 two rotated key rows still share their authenticated principal allowance', async () => {
  await policy('FAN_OUT_READS',{principalLimit:1});
  await admitRate(db,'FAN_OUT_READS',id);
  const before=await used();
  await expect(admitRate(db,'FAN_OUT_READS',{...id,key:'USER_KEY:rotated'})).rejects.toBeInstanceOf(RateLimited);
  expect(await used()).toEqual(before);
});

it('#1793 LOG_ONLY logs would-refusals with no raw subject or identity', async () => {
  const log=vi.spyOn(console,'info').mockImplementation(()=>{});
  try {
    await policy('FAN_OUT_READS',{enforcementMode:'LOG_ONLY',principalLimit:1});
    await admitRate(db,'FAN_OUT_READS',id);await admitRate(db,'FAN_OUT_READS',id);
    expect(log).toHaveBeenCalledWith('rate-limit-observation',{fieldClass:'FAN_OUT_READS',dimension:'principal',mode:'LOG_ONLY'});
    expect(JSON.stringify(log.mock.calls)).not.toContain('USER:a');
    expect(JSON.stringify(log.mock.calls)).not.toContain('192.0.2.1');
  } finally {log.mockRestore();}
});

it('#1793 fail-open rolls back an actually written partial dimension before continuing', async () => {
  await policy();
  await db.$transaction(async tx=>{
    let writes=0;
    const proxy=new Proxy(tx,{get(target,key){
      if(key==='rateLimitBucket')return {...target.rateLimitBucket,upsert:async(args:any)=>{
        if(++writes===2)throw Object.assign(new Error('counter connection lost'),{code:'P1001'});
        return target.rateLimitBucket.upsert(args);
      }};
      return Reflect.get(target,key);
    }});
    await expect(admitRateInTx(proxy,'FAN_OUT_READS',id)).resolves.toMatchObject({admitted:true});
    expect(writes).toBe(2);
    expect(await tx.rateLimitBucket.count()).toBe(0);
  });
  expect(await used()).toEqual([]);
});

it('#1793 a genuinely terminated caller backend preserves the original store error and commits no state', async () => {
  await policy('CREDENTIALS',{enforcementMode:'LOG_ONLY'});
  let originalFailure: unknown;
  let terminated=false;
  const operation=db.$transaction(async tx=>{
    const [{pid}]=await tx.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`;
    const proxy=new Proxy(tx,{get(target,key){
      if(key==='rateLimitBucket')return {...target.rateLimitBucket,findMany:async(args:any)=>{
        // This pid belongs only to THIS test's open transaction on its
        // fingerprinted private clone; never select/terminate another backend.
        const [result]=await db.$queryRaw<Array<{stopped:boolean}>>`SELECT pg_terminate_backend(${pid}::integer) AS stopped`;
        terminated=result.stopped;
        try {return await target.rateLimitBucket.findMany(args);}
        catch(error){originalFailure=error;throw error;}
      }};
      return Reflect.get(target,key);
    }});
    await admitRateInTx(proxy,'CREDENTIALS',id);
  },{timeout:20_000});
  const caught=await operation.then(()=>undefined,error=>error);
  expect(terminated).toBe(true);
  expect(originalFailure).toBeDefined();
  expect(caught).toBe(originalFailure);
  expect(await db.rateLimitBucket.count()).toBe(0);
  expect(await db.userMergeConsent.count()).toBe(0);
  // A live replacement connection can still admit; LOG_ONLY is not a promise
  // that an already dead caller transaction can perform its downstream write.
  await expect(admitRate(db,'CREDENTIALS',id)).resolves.toMatchObject({admitted:true});
},25_000);

it('#1793 cleanup deletes expired windows in bounded batches and preserves the current allowance',async()=>{
  await policy();await admitRate(db,'FAN_OUT_READS',id);
  const now=new Date();
  await db.rateLimitBucket.updateMany({data:{windowStart:new Date(now.getTime()-48*3600_000),expiresAt:new Date(now.getTime()-24*3600_000)}});
  await admitRate(db,'FAN_OUT_READS',id);
  const current=await db.rateLimitBucket.findMany({where:{expiresAt:{gt:now}},orderBy:{dimension:'asc'}});
  expect(current).toHaveLength(3);
  expect(await cleanupRateBuckets(db,2)).toEqual({count:2});
  expect(await cleanupRateBuckets(db)).toEqual({count:1});
  expect(await db.rateLimitBucket.findMany({orderBy:{dimension:'asc'}})).toEqual(current);
  await admitRate(db,'FAN_OUT_READS',id);
  expect((await used()).every(r=>r.used==='2')).toBe(true);
});

it('#1793 a concurrent maintenance owner prevents duplicate candidate selection without waiting',async()=>{
  await admitRate(db,'FAN_OUT_READS',id);
  await db.rateLimitBucket.updateMany({data:{expiresAt:new Date(0)}});
  let entered!:()=>void,release!:()=>void;
  const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
  const holder=db.$transaction(async tx=>{
    await configFence(tx);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1793,1)`;
    entered();await gate;
  });
  await ready;
  try {
    expect(await cleanupRateBuckets(db)).toEqual({count:0});
    expect(await db.rateLimitBucket.count()).toBe(3);
  } finally {release();await holder;}
  expect(await cleanupRateBuckets(db)).toEqual({count:3});
});

it('#1793 a partially missing policy set is readiness failure, not env re-seeding',async()=>{
  await db.rateLimitPolicy.delete({where:{fieldClass:'FAN_OUT_READS'}});
  await expect(assertRateReadiness(db)).rejects.toThrow('readiness');
  expect(await db.rateLimitPolicy.count()).toBe(4);
});

it('#1793 store outage cannot turn an empty or forged internal identity into an exemption',async()=>{
  const fake={$transaction:vi.fn().mockRejectedValue(Object.assign(new Error('down'),{errorCode:'P1001'}))} as any;
  await expect(admitRate(fake,'FAN_OUT_READS',{internal:false})).rejects.toMatchObject({extensions:{code:'FORBIDDEN'}});
  await expect(admitRate(fake,'FAN_OUT_READS',{principal:'USER:a',internal:true})).rejects.toMatchObject({extensions:{code:'FORBIDDEN'}});
  expect(fake.$transaction).not.toHaveBeenCalled();
});

it('#1793 only a transaction-start timeout is a pool outage, not every P2028',async()=>{
  const poolError=Object.assign(new Error('pool wait expired'),{code:'P2028',meta:{error:'Unable to start a transaction in the given time.'}});
  const pool={$transaction:vi.fn().mockRejectedValue(poolError)} as any;
  await expect(admitRate(pool,'FAN_OUT_READS',id)).resolves.toMatchObject({admitted:true});
  await expect(admitRate(pool,'CREDENTIALS',id)).rejects.toBeInstanceOf(RateLimited);
  const invalid=Object.assign(new Error('invalid transaction use'),{code:'P2028',meta:{error:'Transaction already closed'}});
  const broken={$transaction:vi.fn().mockRejectedValue(invalid)} as any;
  await expect(admitRate(broken,'FAN_OUT_READS',id)).rejects.toBe(invalid);
});

it('#1793 unreadable policy row is not a malformed row and leaves a usable fail-open transaction',async()=>{
  await db.$transaction(async tx=>{
    const proxy=new Proxy(tx,{get(target,key){
      if(key==='rateLimitPolicy')return {findUnique:async()=>{throw Object.assign(new Error('unreadable'),{code:'P1001'});}};
      return Reflect.get(target,key);
    }});
    await expect(admitRateInTx(proxy,'FAN_OUT_READS',id)).resolves.toMatchObject({admitted:true});
    expect(await tx.rateLimitBucket.count()).toBe(0);
  });
});

it('#1793 a missing manifest cannot re-seed a fresh secret over retained allowance state',async()=>{
  await policy();await admitRate(db,'FAN_OUT_READS',id);
  const before=await used();await db.rateLimitManifest.delete({where:{id:'global'}});
  vi.stubEnv('RATE_LIMIT_KEYRING',JSON.stringify({current:'different',keys:{different:'4'.repeat(64)}}));
  await expect(assertRateReadiness(db)).rejects.toThrow('readiness');
  expect(await db.rateLimitManifest.count()).toBe(0);
  expect(await used()).toEqual(before);
});

it.each(['CREDENTIALS','OUTBOUND'] as const)('#1793 ruled unknown-mode %s policy outage refuses even during LOG_ONLY, no cache',async fieldClass=>{
  for(const enforcementMode of ['LOG_ONLY','ENFORCING']){
    await policy(fieldClass,{enforcementMode});
    await db.$transaction(async tx=>{
      const proxy=new Proxy(tx,{get(target,key){
        if(key==='rateLimitPolicy')return {findUnique:async()=>{throw Object.assign(new Error('policy unavailable'),{code:'P1001'});}};
        return Reflect.get(target,key);
      }});
      await expect(admitRateInTx(proxy,fieldClass,id)).rejects.toMatchObject({extensions:{code:'RATE_LIMITED',fieldClass,retryAfterSeconds:fieldClass==='CREDENTIALS'?900:3600}});
      expect(await tx.rateLimitBucket.count()).toBe(0);
    });
  }
});
