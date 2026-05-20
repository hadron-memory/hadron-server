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
 *   no leading `/` → rejected. The leading-`/` check is sufficient
 *   on its own; an earlier draft also rejected any `://` substring
 *   as belt-and-braces, but that bogusly rejected legitimate paths
 *   like `/foo://bar` (the colon-in-path comment below applies to
 *   protocol prefixes too — only the **leading** scheme matters).
 *   PR #149 review caught and removed the `://` substring check.
 *
 * - **Control-byte injection** (`\x00`–`\x1F`, `\x7F`):
 *   `/foo\nbar`, `/foo\x00bar`, `/foo\r\nLocation: //evil` →
 *   rejected. Express URL-decodes `%0A`/`%0D`/`%00` from query
 *   strings, so an attacker controls these bytes via `return_to`.
 *   Node's HTTP layer would refuse a `res.redirect()` containing
 *   CR/LF/NUL (turning the request into a 500 rather than a CRLF
 *   header injection), but rejecting at the predicate level
 *   converts the latent 500 into a clean 400 with a diagnostic.
 *
 * Accepted shapes: any string that starts with a single `/`,
 * second char neither `/` nor `\`, no embedded backslashes, no
 * control bytes. `/`, `/app/setup`, `/oauth/authorize?state=…`,
 * `/foo:bar`, `/foo://bar` (colon-in-path is fine — only the
 * leading scheme matters for protocol detection) all pass.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/;

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
  // Reject control bytes (\x00–\x1F + \x7F) anywhere. CRLF would
  // otherwise crash res.redirect() at runtime; NUL and other
  // control bytes have similar header-injection / parsing risks.
  if (CONTROL_CHAR_RE.test(value)) return false;
  return true;
}
