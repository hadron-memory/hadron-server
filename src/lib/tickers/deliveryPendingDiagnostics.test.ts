import { describe, expect, it, vi } from 'vitest';
import { createFooterOmissionReporter, footerFailureReason } from './deliveryPendingDiagnostics.js';

describe('footer omission telemetry', () => {
  it.each([
    ['P2024', 'pool'], ['P2028', 'transaction'], ['57014', 'statement'],
    ['25006', 'read-only'], ['FOOTER_UNSAFE_COUNT', 'unsafe-count'],
    ['FOOTER_APP_UNAVAILABLE', 'unavailable-app'], ['UNKNOWN_PRIVATE_CODE', 'failure'],
  ])('maps %s to a finite class without inspecting prose', (code, expected) => {
    expect(footerFailureReason({ code, message: 'PRIVATE_CREDENTIAL' })).toBe(expected);
  });
  it('recognizes a raw-query PostgreSQL code nested under Prisma P2010', () => {
    expect(footerFailureReason({ code: 'P2010', meta: { code: '57014', message: 'PRIVATE' } })).toBe('statement');
    expect(footerFailureReason({ code: 'P2010', meta: { code: '25006' } })).toBe('read-only');
  });
  it('bounds each class to one log per thirty seconds and reports suppression', () => {
    let now = 1000;
    const write = vi.fn();
    const report = createFooterOmissionReporter(write, () => now);
    report('pool');
    for (let i = 0; i < 1000; i++) report('pool');
    report('failure');
    expect(write).toHaveBeenCalledTimes(2);
    now += 29_999; report('pool');
    expect(write).toHaveBeenCalledTimes(2);
    now++; report('pool');
    expect(JSON.parse(write.mock.calls[2][0])).toEqual({ event: 'delivery.pending.omitted', reason: 'pool', suppressed: 1001 });
  });
  it('never admits arbitrary reason text, error objects, or failing sinks', () => {
    const write = vi.fn();
    const report = createFooterOmissionReporter(write);
    report('PRIVATE_CREDENTIAL');
    expect(write).toHaveBeenCalledWith('{"event":"delivery.pending.omitted","reason":"failure"}');
    expect(() => createFooterOmissionReporter(() => { throw new Error('sink'); })('pool')).not.toThrow();
    expect(footerFailureReason(new Proxy({}, { get() { throw new Error('getter'); } }))).toBe('failure');
  });
});
