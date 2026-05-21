/**
 * Spec 026 — minimal structured-logger-ready log emission for the new
 * App-identification resolver paths (research §R-5).
 *
 * Format matches the existing `[mcp] multiple_apps_resolved` precedent at
 * `src/mcp/server.ts` (the spec-025 multi-App warning that uses
 * `console.warn` with a free-text suffix). This helper adds:
 *   - Consistent event name (parseable in grep / log aggregators).
 *   - A payload object so structured-logger migration is one-line
 *     (`console.warn` → `logger.warn(payload, event)` style).
 *
 * **Levels:**
 *   - `info` — happy-path observability (selection set, envelope
 *     accepted). Uses `console.warn` today because the codebase has no
 *     `console.info` precedent and `console.log` is too noisy. Logger
 *     migration will route these to `logger.info`.
 *   - `warn` — recoverable errors (envelope rejected, ambiguous
 *     selection, legacy 409 fired). Used as the SC-003 measurement
 *     source.
 *   - `error` — unexpected failures (DB hiccup, revocation cascade
 *     surprising path).
 */

export type McpLogLevel = 'info' | 'warn' | 'error';

export interface McpLogFields {
  userId?: string;
  mcpSessionId?: string;
  appId?: string;
  appUrn?: string;
  reason?: string;
  [key: string]: unknown;
}

/**
 * Emit a structured log line for an MCP resolver event. The first arg is
 * the event name (becomes the grep target — e.g. `regime_c_selection_set`),
 * the second is the structured payload.
 */
export function mcpLog(level: McpLogLevel, event: string, fields: McpLogFields): void {
  const payload = { event, ...fields };
  // TODO(structured-logger): when the project picks up a structured logger
  // (winston / pino / similar), replace `console.warn`/`console.error`
  // with the logger's level-routed method. Until then, the existing
  // `[mcp] multiple_apps_resolved` precedent (server.ts:2036) is the
  // operator-facing format.
  if (level === 'error') {
    // eslint-disable-next-line no-console
    console.error(`[mcp] ${event}`, payload);
  } else {
    // eslint-disable-next-line no-console
    console.warn(`[mcp] ${event}`, payload);
  }
}
