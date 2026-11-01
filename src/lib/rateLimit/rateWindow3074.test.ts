import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { rateWindowWaitMs, untilBeforeRateBoundary, withinOneRateWindow } from '../../test/rateWindow.js';
import { admitRate, assertRateReadiness } from './index.js';

const ring = { current:'old',keys:{old:'1'.repeat(64)} };
const id = { principal:'USER:w',key:'USER_KEY:w',ip:'192.0.2.9',internal:false };
beforeEach(async () => { vi.stubEnv('RATE_LIMIT_KEYRING',JSON.stringify(ring)); await cleanDb(db); await assertRateReadiness(db); });
afterEach(() => vi.unstubAllEnvs());

describe('#3074 withinOneRateWindow', () => {
  it('waits only when less than the margin remains, per the class window length', () => {
    expect(rateWindowWaitMs(0, 60)).toBe(0);
    expect(rateWindowWaitMs(54_999, 60)).toBe(0);
    expect(rateWindowWaitMs(55_000, 60)).toBe(0);
    expect(rateWindowWaitMs(55_001, 60)).toBe(5_029);
    expect(rateWindowWaitMs(59_990, 60)).toBe(40);
    // 15 min and 1 h classes: 55 s into a 60 s minute is nowhere near their boundary.
    expect(rateWindowWaitMs(55_000, 900)).toBe(0);
    expect(rateWindowWaitMs(900_000 - 1_000, 900)).toBe(1_030);
    expect(rateWindowWaitMs(3_600_000 - 1_000, 3600)).toBe(1_030);
  });

  it('a sequence forced across the boundary escapes the limit; the helper keeps it in one window', async () => {
    await db.rateLimitPolicy.update({ where:{fieldClass:'FAN_OUT_READS'},data:{principalLimit:1,keyLimit:100,ipLimit:100,enforcementMode:'ENFORCING'} });
    // Without the helper: first admission 1 s before a boundary, second just past it.
    await untilBeforeRateBoundary(db,60,1_000);
    await admitRate(db,'FAN_OUT_READS',id);
    await new Promise(r => setTimeout(r,1_100));
    await expect(admitRate(db,'FAN_OUT_READS',id)).resolves.toMatchObject({admitted:true});
    expect(await db.rateLimitBucket.count({where:{dimension:'principal'}})).toBe(2);
    // With the helper, from the same just-past-boundary position the sequence stays in one window.
    await cleanDb(db); await assertRateReadiness(db);
    await db.rateLimitPolicy.update({ where:{fieldClass:'FAN_OUT_READS'},data:{principalLimit:1,keyLimit:100,ipLimit:100,enforcementMode:'ENFORCING'} });
    await untilBeforeRateBoundary(db,60,1_000);
    await withinOneRateWindow(db,'FAN_OUT_READS');
    await admitRate(db,'FAN_OUT_READS',id);
    await new Promise(r => setTimeout(r,1_100)); // the same gap that crossed the boundary above
    await expect(admitRate(db,'FAN_OUT_READS',id)).rejects.toMatchObject({extensions:{code:'RATE_LIMITED'}});
    expect(await db.rateLimitBucket.count({where:{dimension:'principal'}})).toBe(1);
  }, 150_000);
});
