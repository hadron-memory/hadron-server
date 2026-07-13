import { GraphQLError } from 'graphql';

/**
 * Client for the internal, stateless hadrontool-websearch capability tool
 * (#647). The core-side counterpart to webfetchClient.ts (#628) — and, per the
 * spec, a SEPARATE capability delivered by a SEPARATE tool, not a mode of
 * fetch (`cor:web:020:00`). hadron-server stays the front door: the policy
 * chain has already authorized the run under `tool.web_search` before anything
 * here is called, and this module only ships an already-authorized query to the
 * tool and returns its typed, normalized result.
 *
 * NORMALIZED, VERSIONED CONTRACT (`cor:web:020:01`). Callers depend on the
 * envelope below — a query plus optional generic refinements (count, freshness,
 * locale) and an opaque provider-options bag → an ordered list of result
 * references `{title, url, snippet, rank}` tagged `source: 'external'` — and
 * NEVER on which provider or tool answered. A conforming tool declares the
 * contract version it satisfies (`WEB_SEARCH_CONTRACT_VERSION`), so a better
 * implementation can be swapped in with no caller change. This is why the run
 * tool never branches on provider identity.
 *
 * PROVIDER DESTINATIONS & CREDENTIALS (`cor:web:020:02`). Unlike the fetch
 * surface, the caller never supplies a destination host: a request names a
 * PROVIDER, which the tool resolves to an endpoint from its own fixed
 * allowlist. Because the destination is configuration and not caller-directed,
 * this surface carries a materially lower SSRF risk than fetch and needs none
 * of its connection-pinning apparatus. Core SOURCES the provider API key (env /
 * Doppler) and passes it INLINE per request via `auth` (bearer / basic / named
 * header — never a URL query string); the tool stores none. This module reads
 * that credential from env (`providerCredentialFromEnv`) — a deliberately
 * minimal single-provider seam; the org-scoped multi-provider trust-tier
 * registry (`cor:web:020:02`) is the deferred follow-up.
 *
 * STATELESS + RETRY-SAFE. The tool holds nothing between calls. A search is a
 * GET-idempotent read, so — unlike the non-GET fetch path — retry IS safe here;
 * the run tool is cost 0 for exactly that reason. This client still performs
 * exactly ONE request per call and leaves any retry policy to the caller.
 *
 * Configured by env:
 *   WEBSEARCH_TOOL_URL          base URL, e.g. http://hadrontool-websearch:8080 (required)
 *   WEBSEARCH_TOOL_TOKEN        shared bearer token for the internal plane (optional; sent when set)
 *   WEBSEARCH_PROVIDER          provider slug the tool resolves to an endpoint (optional; tool default otherwise)
 *   WEBSEARCH_PROVIDER_API_KEY  the provider's API key, passed inline per request (optional)
 *   WEBSEARCH_PROVIDER_AUTH     'bearer' (default) | 'header' — how the key is carried
 *   WEBSEARCH_PROVIDER_HEADER   header name when WEBSEARCH_PROVIDER_AUTH='header' (e.g. X-Subscription-Token)
 *
 * Error surface: WEBSEARCH_TOOL_NOT_CONFIGURED / WEBSEARCH_TOOL_UNREACHABLE /
 * WEBSEARCH_TOOL_ERROR as GraphQL extensions.code — plus pass-through of the
 * tool's own stable, typed codes (validation_error, provider_not_configured,
 * provider_unauthorized, provider_rejected, provider_rate_limited,
 * upstream_unreachable, upstream_timeout) via extensions.webSearchErrorCode.
 *
 * SECRET HYGIENE: the provider credential is sourced here and placed only in
 * the request body's `auth`. It is NEVER attached to an error path — error
 * extensions carry only the tool's typed code + a capped message, never the
 * request input (which carries the credential). Config half of the containment
 * rule the spec holds: the key never rides in a URL, and never in storage.
 */

/**
 * The versioned, provider-agnostic contract this client speaks
 * (`cor:web:020:01`). Sent to the tool so a conforming implementation can
 * confirm it satisfies the version the caller depends on; additive change bumps
 * it. "Interchangeable" means "passes the same conformance set for this
 * version", not "looks similar".
 */
export const WEB_SEARCH_CONTRACT_VERSION = 'web-search@1' as const;

/**
 * Core-sourced provider credential, passed inline per request (`cor:web:020:02`).
 * The same three shapes the fetch surface uses (bearer / basic / named header);
 * a URL query-string credential is intentionally NOT representable here — the
 * containment rule the spec holds. Provider credentials are disfavored when they
 * force the key into a URL.
 */
export type WebSearchAuth =
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'header'; name: string; value: string };

/** Generic refinements every conforming provider understands (`cor:web:020:01`). */
export interface WebSearchInput {
  /** The search query (caller-controlled data — a parameter to a fixed endpoint, not a destination). */
  query: string;
  /** Desired number of results (the tool clamps to its own maximum). */
  count?: number;
  /** Freshness window, e.g. 'day' | 'week' | 'month' | 'year' (provider-normalized by the tool). */
  freshness?: string;
  /** Locale/region hint, e.g. 'en-US'. */
  locale?: string;
  /**
   * Opaque provider-specific knobs the tool MAY honor and MUST safely ignore
   * when unknown. Never becomes a first-class field — that is what would tie a
   * caller to one provider and break substitutability (`cor:web:020:01`).
   */
  providerOptions?: Record<string, unknown>;
}

/** A single result reference — the canonical unit callers depend on. */
export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  /** 1-based position in the ordered list. */
  rank: number;
}

export interface WebSearchResponse {
  results: WebSearchResult[];
  /** The contract version the answering tool declared it satisfies. */
  contractVersion?: string;
  /** Results are untrusted external input — the tool tags the envelope (`cor:web:020:00`). */
  source?: 'external';
}

/**
 * Client timeout. Set ABOVE the tool's own search budget so a genuinely slow
 * provider surfaces as the tool's typed `upstream_timeout` (a
 * WEBSEARCH_TOOL_ERROR carrying the stable code) rather than a client-side abort
 * that a caller can't distinguish from an unreachable tool (webfetchClient
 * posture).
 */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Cheap config preflight — true once the internal tool plane is configured.
 * Mirrors isSmsConfigured(): lets a caller fail before touching governance.
 */
export function isWebSearchConfigured(): boolean {
  return Boolean(process.env.WEBSEARCH_TOOL_URL);
}

function toolConfig(): { baseUrl: string; token?: string } {
  const baseUrl = process.env.WEBSEARCH_TOOL_URL;
  if (!baseUrl) {
    throw new GraphQLError('Web search is not configured (WEBSEARCH_TOOL_URL unset).', {
      extensions: { code: 'WEBSEARCH_TOOL_NOT_CONFIGURED' },
    });
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), token: process.env.WEBSEARCH_TOOL_TOKEN || undefined };
}

/**
 * Source the provider name + inline credential from env (`cor:web:020:02`, the
 * single-provider seam). Returns `undefined` fields when unset — a deployment
 * may point at a tool that owns its own provider relationship, in which case
 * core sends no credential and the tool answers from its own key (the
 * "third-party brings its own relationship" branch). A half-configured `header`
 * auth (WEBSEARCH_PROVIDER_AUTH='header' with no WEBSEARCH_PROVIDER_HEADER)
 * throws — a silent fall-through to no-auth would look like an anonymous search
 * succeeding when the operator meant to send a key.
 */
export function providerCredentialFromEnv(): { provider?: string; auth?: WebSearchAuth } {
  const provider = process.env.WEBSEARCH_PROVIDER || undefined;
  const apiKey = process.env.WEBSEARCH_PROVIDER_API_KEY || undefined;
  if (!apiKey) return { provider };

  const authKind = (process.env.WEBSEARCH_PROVIDER_AUTH || 'bearer').toLowerCase();
  if (authKind === 'header') {
    const name = process.env.WEBSEARCH_PROVIDER_HEADER;
    if (!name) {
      throw new GraphQLError(
        'Web search provider auth is misconfigured (WEBSEARCH_PROVIDER_AUTH=header requires WEBSEARCH_PROVIDER_HEADER).',
        { extensions: { code: 'WEBSEARCH_TOOL_NOT_CONFIGURED' } },
      );
    }
    return { provider, auth: { type: 'header', name, value: apiKey } };
  }
  if (authKind === 'bearer') {
    return { provider, auth: { type: 'bearer', token: apiKey } };
  }
  throw new GraphQLError(
    `Web search provider auth is misconfigured (WEBSEARCH_PROVIDER_AUTH="${authKind}" — use "bearer" or "header").`,
    { extensions: { code: 'WEBSEARCH_TOOL_NOT_CONFIGURED' } },
  );
}

/**
 * Run a search against the stateless tool's `/ops/search` plane with a timeout
 * and typed-error mapping. Core sources the provider + inline credential and
 * declares the contract version; the caller supplies only the query and generic
 * refinements. One request, no retry (retry policy belongs to the caller).
 */
export async function webSearch(input: WebSearchInput): Promise<WebSearchResponse> {
  const { baseUrl, token } = toolConfig();
  const { provider, auth } = providerCredentialFromEnv();

  const requestBody = {
    version: WEB_SEARCH_CONTRACT_VERSION,
    ...(provider ? { provider } : {}),
    query: input.query,
    ...(input.count != null ? { count: input.count } : {}),
    ...(input.freshness ? { freshness: input.freshness } : {}),
    ...(input.locale ? { locale: input.locale } : {}),
    ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
    ...(auth ? { auth } : {}),
  };

  // Serialize BEFORE opening the network try: a serialization failure (a
  // circular ref in providerOptions) is a caller-input error, not an
  // unreachable tool. Never attach the request to the error — it carries the
  // provider credential.
  let body: string;
  try {
    body = JSON.stringify(requestBody);
  } catch (err) {
    throw new GraphQLError('Web search request could not be serialized.', {
      extensions: { code: 'WEBSEARCH_TOOL_ERROR', cause: String(err) },
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  let res: Response;
  let payload: Record<string, unknown> | null;
  try {
    res = await fetch(`${baseUrl}/ops/search`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body,
      signal: controller.signal,
    });
    // Keep the body read inside the timeout window — a tool that sends headers
    // and then stalls mid-body must abort too, not hang the run (webfetchClient
    // posture; PR-486).
    try {
      payload = (await res.json()) as Record<string, unknown> | null;
    } catch (err) {
      if (controller.signal.aborted) throw err; // timed out mid-body → outer catch
      payload = null; // malformed/empty body — handled below
    }
  } catch (err) {
    const timedOut = controller.signal.aborted;
    // NB: never attach the request here — it carries the provider credential.
    throw new GraphQLError(timedOut ? 'Web search service timed out.' : 'Web search service is unreachable.', {
      extensions: { code: 'WEBSEARCH_TOOL_UNREACHABLE', cause: String(err) },
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // The tool's typed error body: { error: <code>, message, ... }. Surface the
    // stable code so callers react to the contract, not to HTTP statuses. Cap
    // the message; a misbehaving tool must not inflate the response.
    const webSearchErrorCode = typeof payload?.error === 'string' ? payload.error : undefined;
    const message =
      typeof payload?.message === 'string'
        ? payload.message.slice(0, 500)
        : `Web search service error (${res.status}).`;
    throw new GraphQLError(message, {
      extensions: {
        code: 'WEBSEARCH_TOOL_ERROR',
        ...(webSearchErrorCode ? { webSearchErrorCode } : {}),
        status: res.status,
      },
    });
  }

  if (!payload || !Array.isArray(payload.results)) {
    throw new GraphQLError('Web search service returned an unexpected response.', {
      extensions: { code: 'WEBSEARCH_TOOL_ERROR' },
    });
  }
  return payload as unknown as WebSearchResponse;
}
