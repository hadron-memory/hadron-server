/** #1507: public sync-report DTO. Only source facts and fixed codes enter it. */
import type { IncludeRefusalCode } from '../../lib/includes/writeIncludes.js';

export type SyncReportKind = 'protected' | 'object_type_rejected' | 'undeclared_role' | 'invalid_include' | 'deferred' | 'held_move';
export type SyncReportCode =
  | 'PROTECTED_LOC' | 'PROTECTED_COMMENT' | 'PROTECTED_BOOT_PROMPT' | 'PROTECTED_DECISION'
  | 'OBJECT_TYPE_REJECTED' | 'ROLE_NOT_DECLARED'
  | 'INVALID_INCLUDE' | 'INCLUDE_CYCLE' | 'INCLUDE_TARGET_UNAVAILABLE'
  | 'ROW_CHANGED' | 'MOVE_HELD' | 'DESTINATION_PROTECTED';
// #2369: an include refusal code outside this vocabulary would make the whole v1 report unusable (cor:int:010:01).
// Widening the admitted set without widening SyncReportCode fails `tsc` here, as the `true` becomes `never`.
const includeRefusalCodesAreReportable: [IncludeRefusalCode] extends [SyncReportCode] ? true : never = true;
void includeRefusalCodesAreReportable;
export interface SyncReportEntry {
  kind: SyncReportKind;
  loc: string;
  fromLoc?: string;
  code: SyncReportCode;
}
export interface SyncReport {
  version: 1;
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
  return JSON.stringify({ version: 1, outcome: hasUnsupportedSkips ? 'unknown' : 'partial', recordedAt: now.toISOString(), entries: publicEntries } satisfies SyncReport);
}

export function failedSyncReport(code: 'SYNC_FAILED' | 'BAD_USER_INPUT', now = new Date()): string {
  return JSON.stringify({ version: 1, outcome: 'failed', recordedAt: now.toISOString(), entries: [], code } satisfies SyncReport);
}
