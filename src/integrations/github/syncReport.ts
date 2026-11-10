/** #1507: public sync-report DTO. Only source facts and fixed codes enter it. */
import type { IncludeRefusalCode } from '../../lib/includes/writeIncludes.js';

import type { AttestationRefusalCode } from '../../lib/authoringAttestation.js';
export type SyncReportKind = 'protected' | 'object_type_rejected' | 'undeclared_role' | 'attestation_refused' | 'invalid_include' | 'deferred' | 'held_move';
// cor:int:010:01 / #3612: this reviewed set is fixed independently of producer types.
type SyncReportAttestationCode =
  | 'AUTHORING_ATTESTATION_MISSING' | 'AUTHORING_ATTESTATION_WRONG_TASK'
  | 'AUTHORING_ATTESTATION_STALE' | 'AUTHOR_TASK_BROKEN';
export type SyncReportVersion = 1 | 2;
export type SyncReportCode =
  | 'PROTECTED_LOC' | 'PROTECTED_COMMENT' | 'PROTECTED_BOOT_PROMPT' | 'PROTECTED_DECISION'
  | 'OBJECT_TYPE_REJECTED' | 'ROLE_NOT_DECLARED' | SyncReportAttestationCode
  | 'INVALID_INCLUDE' | 'INCLUDE_CYCLE' | 'INCLUDE_TARGET_UNAVAILABLE'
  | 'ROW_CHANGED' | 'MOVE_HELD' | 'DESTINATION_PROTECTED';
// #2369: an include refusal code outside this vocabulary would make the whole v1 report unusable (cor:int:010:01).
// Widening the admitted set without widening SyncReportCode fails `tsc` here, as the `true` becomes `never`.
const includeRefusalCodesAreReportable: [IncludeRefusalCode] extends [SyncReportCode] ? true : never = true;
void includeRefusalCodesAreReportable;
// A new producer code must be explicitly reviewed before it enters a report version.
const attestationRefusalCodesAreReportable: [AttestationRefusalCode] extends [SyncReportAttestationCode] ? true : never = true;
void attestationRefusalCodesAreReportable;

// Exhaustive version ledgers: widening either DTO vocabulary without classifying its
// reviewed wire version fails typecheck. Preserve v1 for every report it can express.
const kindVersion: Record<SyncReportKind, SyncReportVersion> = {
  protected: 1, object_type_rejected: 1, undeclared_role: 1,
  invalid_include: 1, deferred: 1, held_move: 1, attestation_refused: 2,
};
const codeVersion: Record<SyncReportCode, SyncReportVersion> = {
  PROTECTED_LOC: 1, PROTECTED_COMMENT: 1, PROTECTED_BOOT_PROMPT: 1, PROTECTED_DECISION: 1,
  OBJECT_TYPE_REJECTED: 1, ROLE_NOT_DECLARED: 1,
  INVALID_INCLUDE: 1, INCLUDE_CYCLE: 1, INCLUDE_TARGET_UNAVAILABLE: 1,
  ROW_CHANGED: 1, MOVE_HELD: 1, DESTINATION_PROTECTED: 1,
  AUTHORING_ATTESTATION_MISSING: 2, AUTHORING_ATTESTATION_WRONG_TASK: 2,
  AUTHORING_ATTESTATION_STALE: 2, AUTHOR_TASK_BROKEN: 2,
};
export interface SyncReportEntry {
  kind: SyncReportKind;
  loc: string;
  fromLoc?: string;
  code: SyncReportCode;
}
export interface SyncReport {
  version: SyncReportVersion;
  outcome: 'partial' | 'failed' | 'unknown';
  recordedAt: string;
  entries: SyncReportEntry[];
  code?: 'SYNC_FAILED' | 'BAD_USER_INPUT';
}

/**
 * #1507 / cor:int:010:01: rebuild only the public projection. Unsupported
 * invalid-loc skips make completion unknown, retaining safe supported entries;
 * only a completion with no skips is clean. Never serialize messages or IDs.
 */
export function committedSyncReport(entries: readonly SyncReportEntry[], now = new Date(), hasUnsupportedSkips = false): string | null {
  if (entries.length === 0 && !hasUnsupportedSkips) return null;
  const publicEntries = entries.map(e => ({ kind: e.kind, loc: e.loc, ...(e.fromLoc === undefined ? {} : { fromLoc: e.fromLoc }), code: e.code }));
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  publicEntries.sort((a, b) => compare(a.loc, b.loc) || compare(a.kind, b.kind) || compare(a.fromLoc ?? '', b.fromLoc ?? '') || compare(a.code, b.code));
  const version: SyncReportVersion = publicEntries.some(e => kindVersion[e.kind] === 2 || codeVersion[e.code] === 2) ? 2 : 1;
  return JSON.stringify({ version, outcome: hasUnsupportedSkips ? 'unknown' : 'partial', recordedAt: now.toISOString(), entries: publicEntries } satisfies SyncReport);
}

export function failedSyncReport(code: 'SYNC_FAILED' | 'BAD_USER_INPUT', now = new Date()): string {
  return JSON.stringify({ version: 1, outcome: 'failed', recordedAt: now.toISOString(), entries: [], code } satisfies SyncReport);
}
