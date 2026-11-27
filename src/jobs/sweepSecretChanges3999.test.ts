/** R23 cleanup remains on when an operator pauses version-retention purges. No real timer, database or stack. */
import { afterEach, expect, it, vi } from 'vitest';
import { startSecretChangeSweepLoop } from './sweepSecretChanges.js';
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
it('clears expired staging independently of DISABLE_SECRET_SWEEP, and stops cleanly',async()=>{
 vi.useFakeTimers();vi.stubEnv('NODE_ENV','development');vi.stubEnv('DISABLE_SECRET_SWEEP','true');
 const execute=vi.fn().mockResolvedValue(1),transaction=vi.fn(async(f:Function)=>f({$queryRaw:vi.fn().mockResolvedValue([]),$executeRaw:execute}));
 const loop=startSecretChangeSweepLoop({$transaction:transaction} as never);expect(loop).not.toBeNull();
 await vi.advanceTimersByTimeAsync(60_000);expect(execute).toHaveBeenCalledTimes(2); // #5333: the expiry drain, then the retention phase
 await loop!.stop();await vi.advanceTimersByTimeAsync(120_000);expect(execute).toHaveBeenCalledTimes(2);
});
