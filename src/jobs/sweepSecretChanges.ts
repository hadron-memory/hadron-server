/** #3999 R23; cor:sec:070:02. Clear expired staged bytes independently of polling; never log request data. */
import type { PrismaClient } from '../generated/prisma/index.js';
import { sweepExpiredSecretChanges } from '../lib/secrets/changeRequests.js';
export function startSecretChangeSweepLoop(db: PrismaClient): { stop: () => Promise<void> } | null {
 if (process.env.NODE_ENV === 'test') return null;
 if (process.env.DISABLE_SECRET_SWEEP === 'true') { console.warn('secret.sweep.disabled'); return null; }
 let stopped=false, timer:NodeJS.Timeout, running:Promise<void>|null=null;
 const tick=()=>{
  running=db.$transaction(tx=>sweepExpiredSecretChanges(tx)).then(()=>undefined).catch(()=>{console.warn('secret.change_sweep.failed');}).finally(()=>{
   running=null;if(!stopped){timer=setTimeout(tick,60_000);timer.unref();}
  });
 };
 timer=setTimeout(tick,60_000);timer.unref();
 return {stop:async()=>{stopped=true;clearTimeout(timer);await running;}};
}
