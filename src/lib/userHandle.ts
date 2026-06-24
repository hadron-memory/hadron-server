/**
 * User-handle normalization (issue #325).
 *
 * A handle is the slug of the `hrn:user:<handle>` URN (spec cor:urn:010:01), so
 * it must be URN-atom-legal AND lowercase-canonical: handles are stored and
 * compared in lowercase, giving case-insensitive uniqueness (enforced by the
 * `users (lower(handle))` unique index) and predictable URNs. New / changed
 * handles go through here on write; legacy rows are grandfathered (see #325).
 */

import { validateUserSlug } from './urn.js';

/**
 * Normalize a user-supplied handle to its canonical lowercase form and validate
 * it against the URN atom charset. **Throws** (`UrnParseError`) on an illegal
 * handle — use on user-facing setters where the caller should fix the input.
 */
export function normalizeHandle(input: string): string {
  const handle = input.trim().toLowerCase();
  validateUserSlug(handle); // throws on charset / reserved-word violation
  return handle;
}

/**
 * Lenient variant for **defaulted / programmatic** handles (e.g. a GitHub login
 * copied to the handle on signup, or an app-supplied handle): returns the
 * normalized handle, or `null` when the input is empty or not URN-legal — so
 * account creation / login is never blocked by a bad handle. A null handle just
 * means the user has no URN until they set a legal one.
 */
export function normalizeHandleOrNull(input: string | null | undefined): string | null {
  if (!input || !input.trim()) return null;
  try {
    return normalizeHandle(input);
  } catch {
    return null;
  }
}
