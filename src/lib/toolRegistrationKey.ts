/**
 * #4829 (cor:dmo:080:04) — the registration key core sends when it registers a connection on a `hadrontool-*`.
 *
 * A registration whose response is lost leaves the tool holding a connection no core row points to, and the tool
 * refuses a second registration of the same bot or install. The key lets the tool recognise a retry as the SAME
 * registration: it is a pure function of (provider, App, credentials), so a retry after a lost response reproduces
 * it with no state in core, and a different App (or different credentials) can never produce it. The tool adopts an
 * existing connection only when its stored key equals the supplied one, so a registration another App created is
 * never adopted.
 *
 * The key is a one-way digest: the credential cannot be recovered from it. It is not a secret on its own, but it is
 * still never logged or echoed.
 */
import { createHash } from 'node:crypto';

export function toolRegistrationKey(provider: string, appId: string, credentials: readonly string[]): string {
  const h = createHash('sha256');
  // Length-prefixed parts: no choice of values can make two different inputs hash the same byte stream.
  for (const part of ['hadron-tool-registration:v1', provider, appId, ...credentials]) {
    h.update(`${part.length}:`);
    h.update(part);
  }
  return h.digest('hex');
}
