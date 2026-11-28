/** #3999 R23; cor:sec:070:02. Clear expired staged bytes independently of polling; #5333: then delete ended requests past retention. Never log request data. */
import type { PrismaClient } from '../generated/prisma/index.js';
import { drainEndedSecretChanges, drainExpiredSecretChanges } from '../lib/secrets/changeRequests.js';
export function startSecretChangeSweepLoop(db: PrismaClient): { stop: () => Promise<void> } | null {
 if (process.env.NODE_ENV === 'test') return null;
 let stopped=false, timer:NodeJS.Timeout, running:Promise<void>|null=null;
 const tick=()=>{
  const warn=()=>{console.warn('secret.change_sweep.failed');};
  running=drainExpiredSecretChanges(db,{shouldStop:()=>stopped}).then(()=>undefined).catch(warn)
   .then(()=>stopped?undefined:drainEndedSecretChanges(db,{shouldStop:()=>stopped}).then(()=>undefined)).catch(warn).finally(()=>{
   running=null;if(!stopped){timer=setTimeout(tick,60_000);timer.unref();}
  });
 };
 timer=setTimeout(tick,60_000);timer.unref();
 return {stop:async()=>{stopped=true;clearTimeout(timer);await running;}};
}
