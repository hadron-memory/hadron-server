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

describe('#3612 reviewed report versions', () => {
 const attestationCodes = [
  'AUTHORING_ATTESTATION_MISSING', 'AUTHORING_ATTESTATION_WRONG_TASK',
  'AUTHORING_ATTESTATION_STALE', 'AUTHOR_TASK_BROKEN',
 ] as const;
 for (const code of attestationCodes) {
  it.each([false, true])(`uses v2 for ${code}, retaining projection and ordering (unsupported=%s)`, unsupported => {
   const refusal = { kind: 'attestation_refused', loc: 'a', code } as const;
   const entries = [
    { kind: 'protected', loc: 'z', code: 'PROTECTED_LOC' } as const,
    { ...refusal, message: 'secret', taskId: 'private-id', role: 'guide', attestation: { task: 'hidden' } },
   ];
   const text = committedSyncReport(entries, now, unsupported)!;
   expect(text).toBe(committedSyncReport([...entries].reverse(), now, unsupported));
   expect(JSON.parse(text)).toEqual({
    version: 2, outcome: unsupported ? 'unknown' : 'partial', recordedAt: now.toISOString(),
    entries: [refusal, { kind: 'protected', loc: 'z', code: 'PROTECTED_LOC' }],
   });
   expect(text).not.toMatch(/secret|private-id|guide|hidden|taskId|role|attestation":/);
   expect(JSON.stringify(JSON.parse(text))).toBe(text);
  });
 }
 it('keeps unknown, failed and old-vocabulary reports at the lowest expressible v1', () => {
  expect(JSON.parse(committedSyncReport([], now, true)!)).toEqual({
   version: 1, outcome: 'unknown', recordedAt: now.toISOString(), entries: [],
  });
  for (const code of ['SYNC_FAILED', 'BAD_USER_INPUT'] as const)
   expect(JSON.parse(failedSyncReport(code, now))).toEqual({
    version: 1, outcome: 'failed', recordedAt: now.toISOString(), entries: [], code,
   });
  const v1: SyncReportEntry[] = [
   ...(['PROTECTED_LOC', 'PROTECTED_COMMENT', 'PROTECTED_BOOT_PROMPT', 'PROTECTED_DECISION'] as const).map(code => ({ kind: 'protected' as const, loc: 'p', code })),
   { kind: 'object_type_rejected', loc: 'o', code: 'OBJECT_TYPE_REJECTED' },
   { kind: 'undeclared_role', loc: 'u', code: 'ROLE_NOT_DECLARED' },
   ...(['INVALID_INCLUDE', 'INCLUDE_CYCLE', 'INCLUDE_TARGET_UNAVAILABLE'] as const).map(code => ({ kind: 'invalid_include' as const, loc: 'i', code })),
   { kind: 'deferred', loc: 'd', code: 'ROW_CHANGED' },
   ...(['MOVE_HELD', 'DESTINATION_PROTECTED'] as const).map(code => ({ kind: 'held_move' as const, loc: 'h', fromLoc: 'old', code })),
  ];
  for (const entry of v1) expect(JSON.parse(committedSyncReport([entry], now)!)).toEqual({
   version: 1, outcome: 'partial', recordedAt: now.toISOString(), entries: [entry],
  });
  expect(committedSyncReport([], now)).toBeNull();
 });
 it.each(attestationCodes)('uses v2 with only the attestation refusal %s', code => {
  expect(JSON.parse(committedSyncReport([{kind:'attestation_refused',loc:'refused',code}],now)!)).toEqual({
   version:2,outcome:'partial',recordedAt:now.toISOString(),
   entries:[{kind:'attestation_refused',loc:'refused',code}],
  });
 });
});
