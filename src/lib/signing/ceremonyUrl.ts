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

/** #3649 slice C (cor:acl:140:07): the grant signing ceremony's path prefix, beside node signing's; its own cookie path. */
export const GRANT_SIGNING_CEREMONY_PATH = '/grant-signing';

/** The absolute link a grant signing request hands over: the server origin plus the id. No token, query or fragment. */
export function grantSigningCeremonyUrl(requestId: string): string {
  return `${getProjectBaseUrl()}${GRANT_SIGNING_CEREMONY_PATH}/${requestId}`;
}
