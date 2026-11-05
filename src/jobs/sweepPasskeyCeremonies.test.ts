/** #3122: transient ceremony retention never deletes live flow state or credentials. */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { insertSoftPasskey, softPasskey } from '../test/softPasskey.js';
import { sweepPasskeyCeremonies, passkeyCeremonyRetentionSeconds, startPasskeyCeremonySweepLoop } from './sweepPasskeyCeremonies.js';

beforeEach(async()=>{ await cleanDb(db); });
afterEach(()=>{ vi.unstubAllEnvs(); vi.useRealTimers(); });
async function row(id:string, ageSeconds:number, consumedAge?:number) {
 await db.$executeRaw`INSERT INTO passkey_ceremonies(id,purpose,browser_nonce_hash,challenge_hash,expires_at,consumed_at)
 VALUES(${id},'SIGN_IN',${'a'.repeat(64)},${'b'.repeat(64)},
 (clock_timestamp() AT TIME ZONE 'UTC') - make_interval(secs => ${ageSeconds}),
 CASE WHEN ${consumedAge ?? null}::integer IS NULL THEN NULL ELSE (clock_timestamp() AT TIME ZONE 'UTC') - make_interval(secs => ${consumedAge ?? 0}) END)`;
}
it('deletes old unconsumed rows; retains recently expired and TTL-minus-one-second rows on the DB clock',async()=>{
 await row('old',31*86400); await row('recent',1); await row('live',-599);
 expect(await sweepPasskeyCeremonies(db)).toBe(1);
 expect((await db.passkeyCeremony.findMany()).map(r=>r.id).sort()).toEqual(['live','recent']);
 expect(await sweepPasskeyCeremonies(db)).toBe(0);
});
it('consumed rows wait until both expiry and consumption are past retention; even consumed live rows stay',async()=>{
 await row('old',31*86400,31*86400); await row('recent-consume',31*86400,1);
 await row('recent-expiry',1,31*86400); await row('live',-600,31*86400);
 expect(await sweepPasskeyCeremonies(db)).toBe(1);
 expect((await db.passkeyCeremony.findMany()).map(r=>r.id).sort()).toEqual(['live','recent-consume','recent-expiry']);
});
it('bounds batch size and passes, leaving backlog for the next run',async()=>{
 for(let i=0;i<5;i++)await row(`old${i}`,31*86400);
 expect(await sweepPasskeyCeremonies(db,{batchSize:2,maxPasses:2})).toBe(4);
 expect(await db.passkeyCeremony.count()).toBe(1);
 expect(await sweepPasskeyCeremonies(db,{batchSize:2,maxPasses:2})).toBe(1);
});
it('sweeping a later REGISTER preserves the vouching credential byte for byte',async()=>{
 const user=await db.user.create({data:{handle:'sweep-owner',roles:[]}});
 const id=await insertSoftPasskey(db,user.id,softPasskey());
 const before=await db.passkeyCredential.findUniqueOrThrow({where:{id}});
 await row('later',31*86400);
 await db.passkeyCeremony.update({where:{id:'later'},data:{purpose:'REGISTER',kind:'later',userId:user.id,vouchPasskeyId:id,userHandle:Buffer.alloc(32,1)}});
 expect(await sweepPasskeyCeremonies(db)).toBe(1);
 expect(await db.passkeyCredential.findUniqueOrThrow({where:{id}})).toEqual(before);
});
it('default and smallest retention strictly exceed every production ceremony TTL (including SIGN/PROOF)',()=>{
 const sources=['src/api/passkeyCeremonyRoutes.ts','src/api/passkeySignInRoutes.ts','src/lib/signing/signingCeremony.ts'];
 const ttls=sources.flatMap(p=>[...readFileSync(p,'utf8').matchAll(/(?:CEREMONY|SIGN_PROOF|SIGN)_TTL_SECONDS = (\d+);/g)].map(m=>Number(m[1])));
 expect(ttls.sort((a,b)=>a-b)).toEqual([300,300,300,600]);
 expect(passkeyCeremonyRetentionSeconds()).toBeGreaterThan(Math.max(...ttls));
 vi.stubEnv('PASSKEY_CEREMONY_RETENTION_SECONDS','86400');
 expect(passkeyCeremonyRetentionSeconds()).toBeGreaterThan(Math.max(...ttls));
 for(const value of ['600','0','-1','NaN','86400.5','Infinity']){
  vi.stubEnv('PASSKEY_CEREMONY_RETENTION_SECONDS',value); expect(()=>passkeyCeremonyRetentionSeconds()).toThrow();
 }
});
it('skips automatic scheduling in tests and under the disable flag',()=>{
 expect(startPasskeyCeremonySweepLoop(db)).toBeNull();
 vi.stubEnv('NODE_ENV','production');vi.stubEnv('DISABLE_PASSKEY_CEREMONY_SWEEP','true');
 expect(startPasskeyCeremonySweepLoop(db)).toBeNull();
});
it('schedules, avoids overlapping runs, drains in-flight work on stop, then never restarts',async()=>{
 vi.useFakeTimers();vi.stubEnv('NODE_ENV','production');vi.stubEnv('DISABLE_PASSKEY_CEREMONY_SWEEP','false');
 let finish!:(v:unknown[])=>void;
 const query=vi.fn().mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 const loop=startPasskeyCeremonySweepLoop({$queryRaw:query} as unknown as typeof db,{initialDelayMs:1,intervalMs:10})!;
 await vi.advanceTimersByTimeAsync(1);expect(query).toHaveBeenCalledTimes(1);
 await vi.advanceTimersByTimeAsync(30);expect(query).toHaveBeenCalledTimes(1);
 let stopped=false;const drain=loop.stop().then(()=>{stopped=true;});await Promise.resolve();expect(stopped).toBe(false);
 finish([]);await drain;await vi.advanceTimersByTimeAsync(100);expect(query).toHaveBeenCalledTimes(1);
});

it('refuses larger work caps before any query and supports a smaller retention dial',async()=>{
 for(const options of [{batchSize:501},{batchSize:0},{maxPasses:21},{maxPasses:0}])
  await expect(sweepPasskeyCeremonies(db,options)).rejects.toThrow('bounds');
 vi.stubEnv('PASSKEY_CEREMONY_RETENTION_SECONDS','86400');
 await row('two-days',2*86400); await row('one-hour',3600);
 expect(await sweepPasskeyCeremonies(db)).toBe(1);
 expect((await db.passkeyCeremony.findMany()).map(r=>r.id)).toEqual(['one-hour']);
});
it('concurrent sweeps divide a backlog without charging or deleting anything twice',async()=>{
 for(let i=0;i<5;i++)await row(`parallel${i}`,31*86400);
 const counts=await Promise.all([sweepPasskeyCeremonies(db,{batchSize:2}),sweepPasskeyCeremonies(db,{batchSize:2})]);
 expect(counts[0]+counts[1]).toBe(5); expect(await db.passkeyCeremony.count()).toBe(0);
});
it('a failed run logs no artifacts and schedules the next run',async()=>{
 vi.useFakeTimers();vi.stubEnv('NODE_ENV','production');vi.stubEnv('DISABLE_PASSKEY_CEREMONY_SWEEP','false');
 const error=vi.spyOn(console,'error').mockImplementation(()=>{});
 const query=vi.fn().mockRejectedValueOnce(new Error('private browser hash')).mockResolvedValue([]);
 const loop=startPasskeyCeremonySweepLoop({$queryRaw:query} as unknown as typeof db,{initialDelayMs:1,intervalMs:10})!;
 try {
  await vi.advanceTimersByTimeAsync(1);expect(error.mock.calls).toEqual([['[passkey-ceremony-sweep] failed']]);
  await vi.advanceTimersByTimeAsync(10);expect(query).toHaveBeenCalledTimes(2);
 } finally {await loop.stop();error.mockRestore();}
});
