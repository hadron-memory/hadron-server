import { describe, expect, it } from 'vitest';
import { createFooterSlots, FOOTER_MAX_CONCURRENT } from './deliveryPendingSlots.js';

describe('footer concurrency slots', () => {
  it('defaults to a small per-process cap', () => {
    expect(FOOTER_MAX_CONCURRENT).toBe(4);
  });
  it('grants up to the limit, refuses beyond it without waiting, and frees a slot on release', () => {
    const slots = createFooterSlots(2);
    const a = slots.tryAcquire(); const b = slots.tryAcquire();
    expect(a).toBeTypeOf('function'); expect(b).toBeTypeOf('function');
    expect(slots.tryAcquire()).toBeNull();
    a!();
    const c = slots.tryAcquire();
    expect(c).toBeTypeOf('function');
    expect(slots.tryAcquire()).toBeNull();
    b!(); c!();
    expect(slots.inUse()).toBe(0);
  });
  it('treats a repeated release as a no-op, so one holder can never free a second slot', () => {
    const slots = createFooterSlots(1);
    const release = slots.tryAcquire()!;
    release(); release(); release();
    expect(slots.inUse()).toBe(0);
    const again = slots.tryAcquire()!;
    expect(slots.tryAcquire()).toBeNull();
    again();
  });
});
