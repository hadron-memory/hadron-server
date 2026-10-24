import { describe, expect, it } from 'vitest';
import { committedSyncReport, failedSyncReport, type SyncReportEntry } from './syncReport.js';

const now = new Date('2026-10-24T00:00:00.000Z');
describe('public sync report wire format', () => {
  it('roundtrips all six categories with deterministic ordering and a strict public projection', () => {
    const entries: SyncReportEntry[] = [
      { kind: 'protected', loc: 'z', code: 'PROTECTED_LOC' },
      { kind: 'object_type_rejected', loc: 'b', code: 'OBJECT_TYPE_REJECTED' },
      { kind: 'undeclared_role', loc: 'c', code: 'ROLE_NOT_DECLARED' },
      { kind: 'invalid_include', loc: 'd', code: 'INVALID_INCLUDE' },
      { kind: 'deferred', loc: 'e', fromLoc: 'old-e', code: 'ROW_CHANGED' },
      { kind: 'held_move', loc: 'f', fromLoc: 'old-f', code: 'MOVE_HELD' },
    ];
    const extra = entries.map(e => ({ ...e, nodeId: 'foreign-id', message: 'secret exception', source: '/private/checkout' }));
    const text = committedSyncReport(extra, now)!;
    expect(text).toBe(committedSyncReport([...extra].reverse(), now));
    const wire = JSON.parse(text);
    expect(wire).toEqual({ version: 1, outcome: 'partial', recordedAt: now.toISOString(), entries: [entries[1], entries[2], entries[3], entries[4], entries[5], entries[0]] });
    expect(text).not.toMatch(/foreign-id|secret exception|private\/checkout|nodeId|message|source/);
    expect(JSON.parse(JSON.stringify(wire))).toEqual(wire);
  });
  it('represents committed clean separately from failed with no committed file claims', () => {
    expect(committedSyncReport([], now)).toBeNull();
    expect(JSON.parse(failedSyncReport('BAD_USER_INPUT', now))).toEqual({ version: 1, outcome: 'failed', recordedAt: now.toISOString(), entries: [], code: 'BAD_USER_INPUT' });
  });
});
