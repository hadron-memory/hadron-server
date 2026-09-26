/**
 * #1373 — the connect-time guard for an AI config's EXPLICIT endpoint (its
 * `endpoint`, or the legacy `params.baseUrl`). Either is chosen by an org
 * admin, and the server then POSTs to it with the config's key as a bearer, so
 * it is a server-originated request to a caller-chosen destination and gets
 * the egress posture of cor:api:130:02:
 *
 *   - every resolved address must be public (`isForbiddenAddress`), checked at
 *     REQUEST time, since a hostname validated at write time can be re-pointed;
 *   - the socket is pinned to exactly the addresses checked (`pinnedLookup`),
 *     closing the DNS-rebinding window (#645);
 *   - redirects are refused outright, as a non-retryable error: an LLM API
 *     does not redirect, and a redirect to an IP literal would bypass the pin
 *     (no lookup happens);
 *   - the scheme is http or https; https-only is enforced when `endpoint` is
 *     WRITTEN, not here, so a legacy http `params.baseUrl` keeps working;
 *   - loopback is allowed only outside production (a local Ollama or a test's
 *     capture server), and private addresses only under the self-hosted
 *     operator opt-in `AI_ENDPOINT_ALLOW_PRIVATE_NETWORKS=true` (D4).
 *
 * Provider DEFAULT hosts are constants and do not pass through here.
 */

import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import { Agent } from 'undici';
import { isForbiddenAddress, pinnedLookup } from '../webFetch.js';
import { isLoopbackAddress, loopbackAllowed, privateEndpointsAllowed } from '../aiEndpoint.js';

export class AiEndpointForbiddenError extends Error {
  constructor(readonly host: string, reason: string) {
    super(`AI endpoint host "${host}" is not allowed: ${reason}.`);
    this.name = 'AiEndpointForbiddenError';
  }
}

async function allowedAddresses(url: URL, forbidden: (ip: string) => boolean): Promise<LookupAddress[]> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(host);
  let addrs: LookupAddress[];
  if (family) {
    addrs = [{ address: host, family }];
  } else {
    try {
      addrs = await lookup(host, { all: true, verbatim: true });
    } catch {
      throw new AiEndpointForbiddenError(host, 'it does not resolve');
    }
  }
  if (addrs.length === 0) throw new AiEndpointForbiddenError(host, 'it does not resolve');
  // EVERY address: a mixed answer is the rebinding trick.
  if (addrs.some((a) => forbidden(a.address))) {
    throw new AiEndpointForbiddenError(host, 'it resolves to a private or reserved address');
  }
  return addrs;
}

/** A `fetch` for the AI SDK that enforces the posture above on every request. */
export function guardedEndpointFetch(env: NodeJS.ProcessEnv = process.env): typeof fetch {
  const allowLoopback = loopbackAllowed(env);
  const allowPrivate = privateEndpointsAllowed(env);
  const forbidden = (ip: string) =>
    !allowPrivate && isForbiddenAddress(ip) && !(allowLoopback && isLoopbackAddress(ip));
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    // The scheme is NOT narrowed here: https-only is the write-time rule for
    // `endpoint`, and narrowing at connect time would break a legacy
    // `params.baseUrl` that works today. The egress protection is the address.
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new AiEndpointForbiddenError(url.hostname, `unsupported scheme ${url.protocol}`);
    }
    const addrs = await allowedAddresses(url, forbidden);
    const dispatcher = new Agent({ connect: { lookup: pinnedLookup(addrs, forbidden) as unknown as LookupFunction } });
    try {
      // 'manual', then refuse: 'error' rejects with a TypeError the AI SDK
      // reads as a network failure and RETRIES with backoff.
      const res = await fetch(input, { ...init, redirect: 'manual', dispatcher } as RequestInit & { dispatcher: Agent });
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => {});
        throw new AiEndpointForbiddenError(url.hostname, `it redirected (${res.status}); an AI endpoint must answer directly`);
      }
      return res;
    } finally {
      // Graceful: undici's close() lets the in-flight request, body included,
      // finish before tearing the per-request agent down.
      dispatcher.close().catch(() => {});
    }
  };
}
