/**
 * #1632 S2b-2 (hrn:node:hadronmemory.com:specs:cor:dmo:130:08) — where a signing request's ceremony page lives.
 * The page, and every route under it, is mounted only through `signingSurfacePolicy()` (#1895).
 */
import { getProjectBaseUrl } from '../baseUrl.js';

/** The ceremony page's path prefix; the request id is the only path parameter. */
export const SIGNING_CEREMONY_PATH = '/signing';

/** The absolute link a request hands over: the server origin plus the id. No token, query or fragment. */
export function signingCeremonyUrl(requestId: string): string {
  return `${getProjectBaseUrl()}${SIGNING_CEREMONY_PATH}/${requestId}`;
}
