/**
 * Spec 026 — typed errors for App-identification regimes (b) and (c).
 *
 * These error codes are distinct from spec-025's `multiple_apps_resolved`
 * HTTP 409 (preserved per FR-016 as the fall-through for legacy callers).
 * They surface as MCP **tool-error** envelopes — `{ isError: true,
 * content: [{ type: 'text', text: '[<code>] <message>' }] }` — returned
 * from `hadron_list_apps`, `hadron_set_active_app`, and the resolver dispatch when
 * a session has engaged with the new regimes.
 *
 * The `[<code>] ` prefix carries the machine-readable code inline so tests
 * (and disciplined clients) can assert on the code without a separate
 * structured field. Choice rationale: the MCP SDK's tool-result type
 * doesn't pass through extra top-level fields predictably; inline-prefix
 * is the standard MCP-spec pattern for surfacing error categories.
 */

export const APP_SELECTION_ERROR_CODES = {
  /** Short-form identifier matched 2+ accessible Apps. */
  APP_IDENTIFIER_AMBIGUOUS: 'app_identifier_ambiguous',
  /** URN or short form matched zero accessible Apps. */
  APP_NOT_FOUND: 'app_not_found',
  /** Match found but App is soft-deleted or soft-uninstalled. */
  APP_UNAVAILABLE: 'app_unavailable',
  /** Caller's AppMember row was deleted (revocation, App delete, App uninstall) since selection. */
  APP_MEMBER_REVOKED: 'app_member_revoked',
  /** Multi-App user called a strict-list tool without selecting first (engaged-client path; the session has used `hadron_list_apps` / `hadron_set_active_app` since session-init). */
  NO_ACTIVE_APP: 'no_active_app',
  /** Spec-025 FR-016 fall-through: multi-App user called a strict-list tool from an un-engaged session (never used the new App-selection surface). The literal `multiple_apps_resolved` token is preserved verbatim in the envelope's text prefix so SC-003's production-log grep continues to work. */
  MULTIPLE_APPS_RESOLVED: 'multiple_apps_resolved',
} as const;

export type AppSelectionErrorCode =
  (typeof APP_SELECTION_ERROR_CODES)[keyof typeof APP_SELECTION_ERROR_CODES];

/**
 * MCP tool-error envelope shape. `isError: true` flags the tool result as
 * a failure per MCP convention; `content[0].text` carries the prefixed
 * human-readable message.
 */
export interface AppSelectionErrorEnvelope {
  isError: true;
  content: Array<{ type: 'text'; text: string }>;
}

/**
 * Build an MCP tool-error envelope for an App-selection failure. The
 * resulting text is `[<code>] <message>` so callers can both display the
 * human-readable message and (if they care) parse the code from the prefix.
 */
export function appSelectionError(
  code: AppSelectionErrorCode,
  message: string,
): AppSelectionErrorEnvelope {
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: `[${code}] ${message}` }],
  };
}

/**
 * Extract the error code from an envelope's text prefix (test-helper-grade).
 * Returns null if the envelope's text doesn't start with a known code.
 */
export function extractErrorCode(
  envelope: AppSelectionErrorEnvelope,
): AppSelectionErrorCode | null {
  const text = envelope.content[0]?.text ?? '';
  const match = text.match(/^\[([a-z_]+)\]/);
  if (!match) return null;
  const code = match[1];
  const known = Object.values(APP_SELECTION_ERROR_CODES) as string[];
  return known.includes(code) ? (code as AppSelectionErrorCode) : null;
}
