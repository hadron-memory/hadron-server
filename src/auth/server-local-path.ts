/**
 * Spec 025-oauth-for-mcp FR-007 — Option-C `return_to` predicate.
 *
 * Validates that a query-string `return_to=<…>` value is a strict
 * server-local path before the `/auth/github/callback` handler
 * redirects to it. Defends against open-redirect (attacker sets
 * `return_to=https://evil.example/grab-cookie`) and protocol-
 * injection (`return_to=javascript:alert(1)`) attacks.
 *
 * The predicate is intentionally **conservative**: server-local
 * URLs in Hadron's threat model never need backslashes, protocol
 * prefixes, or leading double-slash. Anything that smells like
 * it could be normalized to a non-server origin by a browser is
 * rejected.
 *
 * Defended attack classes:
 *
 * - **Absolute URLs to external origins**:
 *   `https://evil.example/x` → first char 'h', not '/'  → rejected.
 * - **Protocol-relative URLs**:
 *   `//evil.example/x` → second char '/' → rejected. Browsers treat
 *   `//host/path` as scheme-inheriting; redirecting to one would
 *   land on `evil.example`.
 * - **Backslash normalization**:
 *   `/\evil.example` and `/foo\bar` → contain '\\' → rejected.
 *   Browsers normalize `\` → `/` in URLs (per WHATWG); `/\host`
 *   becomes equivalent to `//host` (protocol-relative).
 * - **Protocol-injection schemes**:
 *   `javascript:alert(1)`, `data:text/html,…`, `file://…` →
 *   no leading `/` → rejected (the leading-`/` check is sufficient,
 *   but we also explicitly look for `://` inside the value as
 *   belt-and-braces against creative encodings).
 *
 * Accepted shapes: any string that starts with a single `/`,
 * second char neither `/` nor `\`, no embedded backslashes, no
 * `://` substring. `/`, `/app/setup`, `/oauth/authorize?state=…`,
 * `/foo:bar` (colon-in-path is fine — only protocols matter) all
 * pass.
 */
export function isServerLocalPath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0) return false;
  // Must start with exactly one '/'.
  if (value.charCodeAt(0) !== 47 /* '/' */) return false;
  // Second char must not be '/' (protocol-relative) or '\\'
  // (browser-normalized to '/'). `/` alone (length 1) is fine
  // — second char is undefined, which is neither '/' nor '\\'.
  const second = value.charCodeAt(1);
  if (second === 47 /* '/' */ || second === 92 /* '\\' */) return false;
  // Any backslash anywhere in the string is suspect — browsers
  // normalize `\` → `/`, so `/foo\\bar.example` could be coaxed
  // into a protocol-relative form on some clients.
  if (value.includes('\\')) return false;
  // Belt-and-braces: a `://` anywhere in the value indicates a
  // protocol prefix that snuck past the leading-/ check (e.g.,
  // some browsers tolerate creative whitespace before the scheme).
  // Legitimate server-local paths never contain `://`.
  if (value.includes('://')) return false;
  return true;
}
