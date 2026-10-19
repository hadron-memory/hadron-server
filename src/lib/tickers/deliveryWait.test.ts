import { describe, expect, it } from 'vitest';
import { deliveryWait, oldestStuckMessage, nextDeliveryOwnerDue, type DeliveryMessage, type WaitException } from './deliveryWait.js';

const at = (time: string) => new Date(`2026-10-18T${time}:00Z`);
const message = (seq = 1, channelId = 'c1', time = '10:00'): DeliveryMessage => ({ workerId: 'w', channelId, channelIncarnation: 1, seq, dueSince: at(time) });
const interval = (start: string, end: string | null, extra: Partial<WaitException> = {}): WaitException => ({ workerId: 'w', cause: 'wake-paused', startedAt: at(start), endedAt: end ? at(end) : null, coverage: { kind: 'worker' }, ...extra });
const coverage = { trackedFrom: at('09:00'), observedThrough: at('12:00') };
const minutes = (n: number) => n * 60_000;

describe('cor:agt:050:26 S6–S8: uncovered wait', () => {
  it('S6: exact window is due, one instant before is not', () => {
    expect(oldestStuckMessage([message()], [], coverage, new Date(at('10:15').getTime() - 1), 900)).toBeNull();
    expect(oldestStuckMessage([message()], [], coverage, at('10:15'), 900)?.message.seq).toBe(1);
  });
  it('S7: deducts the pause, carrying five minutes across restart', () => {
    const persisted = JSON.parse(JSON.stringify([interval('10:05', '11:00')]), (k, v) => ['startedAt', 'endedAt'].includes(k) && v ? new Date(v) : v);
    expect(deliveryWait(message(), persisted, coverage, at('11:05')).waitedMs).toBe(minutes(10));
    expect(oldestStuckMessage([message()], persisted, coverage, at('11:05'), 900)).toBeNull();
    expect(oldestStuckMessage([message()], persisted, coverage, at('11:10'), 900)?.waitedMs).toBe(minutes(15));
  });
  it('S8: an older selectively held message cannot hide a later mention', () => {
    const selective = interval('10:00', null, { cause: 'standby', coverage: { kind: 'range', channelId: 'c1', channelIncarnation: 1, fromSeq: 1, throughSeq: 1 } });
    expect(oldestStuckMessage([message(), message(2, 'c1', '10:02')], [selective], coverage, at('10:17'), 900)?.message.seq).toBe(2);
  });
  it('unions overlapping worker and selective pauses without double deduction', () => {
    const intervals = [interval('10:03', '10:08'), interval('10:06', '10:10', { cause: 'isolated' })];
    expect(deliveryWait(message(), intervals, coverage, at('10:15')).waitedMs).toBe(minutes(8));
    expect(deliveryWait(message(), intervals, coverage, at('10:07')).suppressed).toBe(true);
  });
  it('covers messages arriving during a worker pause; interval expiry is effective time', () => {
    expect(deliveryWait(message(2, 'c1', '10:06'), [interval('10:05', '10:10')], coverage, at('10:15')).waitedMs).toBe(minutes(5));
  });
  it('budget-only coverage excludes only that range and incarnation', () => {
    const budget = interval('10:00', null, { cause: 'wake-budget', coverage: { kind: 'range', channelId: 'c1', channelIncarnation: 1, fromSeq: 1, throughSeq: 10 } });
    expect(deliveryWait(message(), [budget], coverage, at('10:15')).suppressed).toBe(true);
    expect(deliveryWait(message(1, 'c2'), [budget], coverage, at('10:15')).waitedMs).toBe(minutes(15));
    expect(deliveryWait({ ...message(), channelIncarnation: 2 }, [budget], coverage, at('10:15')).waitedMs).toBe(minutes(15));
  });
  it('rollout excludes unobserved age and incomplete history fails closed', () => {
    expect(deliveryWait(message(), [], { ...coverage, trackedFrom: at('10:10') }, at('10:15')).waitedMs).toBe(minutes(5));
    expect(() => deliveryWait(message(), [], { ...coverage, observedThrough: at('10:10') }, at('10:15'))).toThrow('DELIVERY_WAIT_INCOMPLETE');
  });
  it('selects one worker anchor across channels by due time, with deterministic ties', () => {
    expect(oldestStuckMessage([message(2, 'c2'), message(3, 'c1')], [], coverage, at('10:15'), 900)?.message.channelId).toBe('c1');
  });
  it('escalation requires another uncovered window and stops under suppression or ack', () => {
    const state = deliveryWait(message(), [interval('10:20', '11:00')], coverage, at('11:10'));
    expect(nextDeliveryOwnerDue(state, minutes(15), 900, false)).toBe(true);
    expect(nextDeliveryOwnerDue(state, minutes(15), 900, true)).toBe(false);
    expect(nextDeliveryOwnerDue({ ...state, suppressed: true }, minutes(15), 900, false)).toBe(false);
    expect(nextDeliveryOwnerDue({ ...state, waitedMs: minutes(29) }, minutes(15), 900, false)).toBe(false);
  });
});
