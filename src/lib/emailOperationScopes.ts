/**
 * Operation→scope table for `ConnectionGrant` delegation (spec-042 Track B, #593).
 *
 * A `ConnectionGrant` lets a connection owner delegate SCOPED access to a
 * specific App install. `requireEmailConnection` consults this table to map the
 * spec-002 operation string a resolver is running to the grant scope it
 * requires. Single source of truth, reused by the enforcement gate and by
 * `createConnectionGrant` scope validation.
 *
 * FAIL-CLOSED: an operation with **no entry here** requires no representable
 * scope, so a grantee can never satisfy it — it stays owner-only. Mailbox
 * mutations that are deliberately NOT delegable in v1 (delete/move/mark-read/
 * flag/categorize) are simply absent. Adding a new email op without a mapping
 * therefore defaults to owner-only, never fail-open.
 */

/** The scopes a `ConnectionGrant` may carry — the create-time allow-list. */
export const CONNECTION_GRANT_SCOPES = [
  'mail.read',
  'mail.send',
  'calendar.freebusy',
  'calendar.read',
] as const;

export type ConnectionGrantScope = (typeof CONNECTION_GRANT_SCOPES)[number];

const SCOPE_SET: ReadonlySet<string> = new Set(CONNECTION_GRANT_SCOPES);

/** True iff `s` is a valid, grantable scope. */
export function isConnectionGrantScope(s: string): s is ConnectionGrantScope {
  return SCOPE_SET.has(s);
}

/**
 * Maps a spec-002 email/calendar operation to the scope a non-owner grantee
 * must hold to run it. Absent ⇒ owner-only (see fail-closed note above).
 *
 * `get-schedule` / `list-events` are listed ahead of the hadrontool-ms-exchange
 * ops shipping (Track B follow-up) so the gate is ready the day the tool adds
 * them — a grantee holding `calendar.freebusy` is structurally capped at
 * yes/no free/busy, never event contents.
 */
export const OPERATION_SCOPES: Readonly<Record<string, ConnectionGrantScope>> = Object.freeze({
  // mail.read
  'list-messages': 'mail.read',
  'list-folders': 'mail.read',
  // mail.send (compose + send share one scope — there is no compose/send split)
  'reply-to-message': 'mail.send',
  'save-draft': 'mail.send',
  'update-draft': 'mail.send',
  'send-draft': 'mail.send',
  // calendar (ops land in hadrontool-ms-exchange later; table is ready now)
  'get-schedule': 'calendar.freebusy',
  'list-events': 'calendar.read',
});

/** The scope an operation requires, or `undefined` when it is owner-only. */
export function scopeForOperation(operation: string): ConnectionGrantScope | undefined {
  return OPERATION_SCOPES[operation];
}
