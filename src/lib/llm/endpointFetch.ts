/**
 * #1373 — the connect-time guard for an AI config's EXPLICIT `endpoint`.
 * (The legacy `params.baseUrl` is not read at all since D2, so it never
 * reaches this path.) The endpoint is chosen by an org admin, and the
 * server then POSTs to it with the config's key as a bearer, so it is a
 * server-originated request to a caller-chosen destination and gets
 * the egress posture of cor:api:130:02:
 *
 *   - every resolved address must be public (`isForbiddenAddress`), checked at
 *     REQUEST time, since a hostname validated at write time can be re-pointed;
 *   - the socket is pinned to exactly the addresses checked (`pinnedLookup`),
 *     closing the DNS-rebinding window (#645);
 *   - redirects are refused outright, as a non-retryable error: an LLM API
 *     does not redirect, and a redirect to an IP literal would bypass the pin
 *     (no lookup happens);
 *   - plain http only when EVERY resolved address is private-network or
 *     loopback: a key and a prompt never cross the public internet
 *     unencrypted;
 *   - loopback is allowed only outside production (a local Ollama or a test's
 *     capture server), and private-network addresses only under the
 *     self-hosted operator opt-in `AI_ENDPOINT_ALLOW_PRIVATE_NETWORKS=true`
 *     (D4) — which never admits link-local/metadata, multicast or reserved;
 *   - a temporary resolver failure is a retryable `AiEndpointResolveError`, not
 *     a refusal, so a run is redelivered instead of failed for good;
 *
 * Provider DEFAULT hosts are constants and do not pass through here.
 */

import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import { Agent } from 'undici';
import { isForbiddenAddress, pinnedLookup } from '../webFetch.js';
import { isLoopbackAddress, isPrivateNetworkAddress, loopbackAllowed, privateEndpointsAllowed } from '../aiEndpoint.js';

/**
 * A resolver failure that may clear on its own (#1380 review, Codex P2): kept
 * distinct from a refusal so the run is RETRIED rather than failed for good.
 * The message names a network failure, which `isTransient` classifies as
 * transient.
 */
export class AiEndpointResolveError extends Error {
  constructor(readonly host: string, readonly code: string) {
    super(`AI endpoint host "${host}" could not be resolved right now (${code}): a temporary DNS or network failure.`);
    this.name = 'AiEndpointResolveError';
  }
}

/** Resolver codes that describe a temporary condition, not a missing host. */
const TRANSIENT_DNS_CODES = new Set(['EAI_AGAIN', 'ETIMEOUT', 'ESERVFAIL', 'ECONNREFUSED', 'ECANCELLED']);

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
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code && TRANSIENT_DNS_CODES.has(code)) throw new AiEndpointResolveError(host, code);
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

/** `work`, or the signal's reason as soon as it aborts, whichever comes first. */
async function untilAborted<T>(work: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) return work;
  signal.throwIfAborted();
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** A `fetch` for the AI SDK that enforces the posture above on every request. */
export function guardedEndpointFetch(env: NodeJS.ProcessEnv = process.env): typeof fetch {
  const allowLoopback = loopbackAllowed(env);
  const allowPrivate = privateEndpointsAllowed(env);
  const forbidden = (ip: string) =>
    isForbiddenAddress(ip) &&
    !(allowLoopback && isLoopbackAddress(ip)) &&
    !(allowPrivate && isPrivateNetworkAddress(ip));
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new AiEndpointForbiddenError(url.hostname, `unsupported scheme ${url.protocol}`);
    }
    // The caller's deadline covers resolution too: a resolver that hangs
    // must not hold the request past it (#1385 review).
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const addrs = await untilAborted(allowedAddresses(url, forbidden), signal);
    // Plaintext only inside a private network (#1380 review, Codex P1): the
    // key and the prompt must never cross the public internet unencrypted.
    // Checked on the RESOLVED addresses, since a hostname's class is only
    // known now.
    if (url.protocol === 'http:' && !addrs.every((a) => isPrivateNetworkAddress(a.address))) {
      throw new AiEndpointForbiddenError(url.hostname, 'plain http is allowed only to a private-network address; use https');
    }
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
