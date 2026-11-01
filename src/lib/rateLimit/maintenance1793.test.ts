import { afterEach, expect, it, vi } from 'vitest';
import { startRateBucketCleanupLoop } from './maintenance.js';

afterEach(() => vi.useRealTimers());

it('continues a full expired backlog beyond twenty batches without waiting another minute', async () => {
  vi.useFakeTimers();
  let batches=0;
  const clean=vi.fn(async()=>({count:++batches<=20?200:0}));
  const stop=startRateBucketCleanupLoop(clean,vi.fn());
  try {
    await vi.advanceTimersByTimeAsync(63_000);
    expect(clean).toHaveBeenCalledTimes(21);
  } finally {stop();}
});

it('never overlaps a pending batch and stops scheduling after shutdown', async () => {
  vi.useFakeTimers();
  let release!:()=>void;
  const pending=new Promise<void>(r=>release=r);
  const clean=vi.fn(async()=>{await pending;return {count:200};});
  const stop=startRateBucketCleanupLoop(clean,vi.fn());
  try {
    await vi.advanceTimersByTimeAsync(180_000);
    expect(clean).toHaveBeenCalledTimes(1);
  } finally {stop();release();await vi.advanceTimersByTimeAsync(0);}
  await vi.advanceTimersByTimeAsync(180_000);
  expect(clean).toHaveBeenCalledTimes(1);
});
