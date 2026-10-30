/**
 * #2909: the portal connect flow's post-callback `redirect` is a PATH inside the portal, never a place elsewhere.
 *
 * `POST /auth/{provider}/start` stores the value in the nonce row and the callback resolves it against
 * FRONTEND_URL, so a value that parses as an absolute or protocol-relative URL would send the admin's browser to
 * another origin. Two checks, both required: a textual shape check (the WHATWG URL parser treats `\` as `/` and
 * strips tab and newline, so `/\host` and `/\t/host` look like paths to a naive `startsWith('/')`), and a
 * resolved-origin comparison as the backstop for anything the shape check does not anticipate.
 */

/** Shape of a portal path: one leading `/`, then not `/` or `\`, and no control characters or whitespace anywhere. */
const PORTAL_PATH = /^\/(?![/\\])[^\u0000- \u007f-\u009f\\]*$/;

export function isPortalPath(value: unknown, frontendUrl: string): value is string {
  if (typeof value !== 'string' || !PORTAL_PATH.test(value)) return false;
  try {
    return new URL(value, frontendUrl).origin === new URL(frontendUrl).origin;
  } catch {
    return false;
  }
}

/** A stored value (a nonce minted before #2909 may carry anything) that is not a portal path fails closed to `/`. */
export function portalPathOrRoot(value: string, frontendUrl: string): string {
  return isPortalPath(value, frontendUrl) ? value : '/';
}
