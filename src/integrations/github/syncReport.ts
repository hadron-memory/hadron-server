/** #1507: public sync-report DTO. Only source facts and fixed codes enter it. */
export type SyncReportKind = 'protected' | 'object_type_rejected' | 'undeclared_role' | 'invalid_include' | 'deferred' | 'held_move';
export type SyncReportCode =
  | 'PROTECTED_LOC' | 'PROTECTED_COMMENT' | 'PROTECTED_BOOT_PROMPT' | 'PROTECTED_DECISION'
  | 'OBJECT_TYPE_REJECTED' | 'ROLE_NOT_DECLARED'
  | 'INVALID_INCLUDE' | 'INCLUDE_CYCLE' | 'INCLUDE_TARGET_UNAVAILABLE'
  | 'ROW_CHANGED' | 'MOVE_HELD' | 'DESTINATION_PROTECTED';
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

/** Rebuild the public projection; never serialize caller objects/messages/ids. */
export function committedSyncReport(entries: readonly SyncReportEntry[], now = new Date()): string | null {
  if (entries.length === 0) return null;
  const publicEntries = entries.map(e => ({ kind: e.kind, loc: e.loc, ...(e.fromLoc === undefined ? {} : { fromLoc: e.fromLoc }), code: e.code }));
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  publicEntries.sort((a, b) => compare(a.loc, b.loc) || compare(a.kind, b.kind) || compare(a.fromLoc ?? '', b.fromLoc ?? '') || compare(a.code, b.code));
  return JSON.stringify({ version: 1, outcome: 'partial', recordedAt: now.toISOString(), entries: publicEntries } satisfies SyncReport);
}

export function failedSyncReport(code: 'SYNC_FAILED' | 'BAD_USER_INPUT', now = new Date()): string {
  return JSON.stringify({ version: 1, outcome: 'failed', recordedAt: now.toISOString(), entries: [], code } satisfies SyncReport);
}
