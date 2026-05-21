/**
 * Spec 025-oauth-for-mcp Phase 2 — MCP-compliant OAuth 2.1
 * Authorization Server.
 *
 * **Phase 2A:** discovery endpoints —
 *   - `GET /.well-known/oauth-protected-resource` (PRM per RFC 9728)
 *   - `GET /.well-known/oauth-authorization-server` (AS metadata per RFC 8414)
 *
 * **Phase 2B:** Dynamic Client Registration —
 *   - `POST /oauth/register` (DCR per RFC 7591)
 *
 * **Phase 2C:** consent + AuthCode issuance —
 *   - `GET  /oauth/authorize` (consent screen + Option-C sign-in)
 *   - `POST /oauth/authorize` (CSRF-protected approve/deny + AuthCode mint)
 *
 * **Phase 2D (this commit):** token redemption — the final piece that
 * closes the OAuth dance —
 *   - `POST /oauth/token` (PKCE verify + race-safe redemption + mint)
 *
 * The AS metadata response is what Claude Desktop fetches before
 * walking the OAuth dance — see spec §"Design constraints from
 * empirical findings (PR 137)" for the two empirical findings these
 * endpoints have to satisfy:
 *
 *   - **EF-001** — Claude Desktop's backend probes AS metadata and
 *     silently bails when `registration_endpoint` is absent. We MUST
 *     advertise the DCR endpoint (Phase 2A) AND it must respond
 *     successfully when the client follows up (Phase 2B).
 *   - **EF-002** — RFC 8414's default `token_endpoint_auth_methods_supported`
 *     is `["client_secret_basic"]`, which leads spec-compliant
 *     clients to expect a client secret. Public-client / PKCE-only
 *     auth issues no secret; we MUST explicitly declare `["none"]`.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { doubleCsrf, type DoubleCsrfUtilities } from 'csrf-csrf';
import { decodeJwt } from 'jose';
import { db } from '../integrations/db/client.js';
import { verifyJwt } from './jwt.js';
import { CONSENT_TEMPLATE } from './consent.template.js';
import { USER_API_KEY_LABEL_MAX_LEN, mintUserApiKey } from '../middleware/auth.js';

/**
 * Validate a `HADRON_PUBLIC_BASE_URL` env-var value. Exported for direct
 * unit testing. Returns the validated string when valid, `null` when
 * unset, throws on malformed input.
 *
 * The strict shape is `scheme://host[:port]` with **no trailing slash**
 * and **no path component**. Scheme MUST be `http://` or `https://`.
 * Host MUST be non-empty.
 *
 * Rationale for strictness: this string flows into RFC 8414's `issuer`
 * field and is compared for exact equality by spec-compliant clients
 * (Claude Desktop, MCP Inspector) against the issuer claim they cached
 * at discovery time. A trailing slash, or a path, or a port mismatch
 * causes silent rejection at the client side. Failing loud at boot is
 * the right posture.
 */
export function validatePublicBaseUrl(raw: string | undefined): string | null {
  if (raw === undefined || raw === '') return null;
  // Strict: scheme + DNS-style host + optional port. Explicitly NOT
  // allowed: trailing slash, path, query (`?`), fragment (`#`), any
  // whitespace, IPv6 bracket notation. The charset is the ASCII
  // hostname subset (alphanumeric + `.` + `-`). IPv6 origins in this
  // env var are out of scope; if needed, widen the regex carefully.
  if (!/^https?:\/\/[A-Za-z0-9.\-]+(:\d+)?$/.test(raw)) {
    throw new Error(
      `HADRON_PUBLIC_BASE_URL must be of the form 'https://host' or ` +
        `'https://host:port' with no trailing slash, no path, no query, ` +
        `no fragment, and no whitespace. Got: ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

/**
 * Resolved at module load. When set, every consumer of `getServerOrigin`
 * uses this value verbatim — bypassing the per-request `req.protocol +
 * req.get('host')` derivation. That removes the dependency on
 * `trust proxy` + `X-Forwarded-Proto` correctness for OAuth metadata
 * URLs, which are advertised once at discovery time and must be stable.
 *
 * Production deployments behind any TLS-terminating proxy (Cloudflare,
 * load balancer, etc.) SHOULD set this. Without it, a single
 * misconfigured request (or a momentary `trust proxy` mishap) emits
 * `http://` URLs in the AS metadata, which Claude Desktop refuses to
 * accept (EF-003).
 *
 * Local dev / tests leave it unset and use the per-request derivation
 * (so the listener's random port is reflected naturally; setting a
 * fixed value would break `127.0.0.1:<port>`-bound tests).
 */
const PUBLIC_BASE_URL = validatePublicBaseUrl(process.env.HADRON_PUBLIC_BASE_URL);

/**
 * Canonical server-origin resolver. Used by every public-facing URL
 * builder (PRM, AS metadata, `/mcp` 401 `WWW-Authenticate`).
 *
 * Precedence:
 *   1. `HADRON_PUBLIC_BASE_URL` env var (production-recommended).
 *   2. `${req.protocol}://${req.get('host')}` (dev fallback).
 *
 * Returns `null` only when the env var is unset AND the request lacks
 * a Host header (RFC 7230 §5.4 says that can't happen on a well-formed
 * HTTP/1.1 request; the caller emits a 400 in that case).
 */
export function getServerOrigin(req: Request): string | null {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const host = req.get('host');
  if (!host) return null;
  return `${req.protocol}://${host}`;
}

/**
 * RFC 9728 Protected Resource Metadata. Tells MCP-spec-compliant
 * clients (Claude Desktop, MCP Inspector) which Authorization Server
 * to use to obtain credentials for the `/mcp` resource.
 *
 * Note: this builder bakes in the assumption that the Authorization
 * Server and the Resource Server are co-located on the same origin.
 * Today they are (Hadron runs both on the same listener). RFC 9728
 * explicitly allows a split deployment (`authorization_servers` can
 * be any URL); if that's ever needed, accept an explicit AS origin
 * rather than reusing the resource origin.
 *
 * Shape spec: <https://datatracker.ietf.org/doc/html/rfc9728#section-3>.
 */
export function buildProtectedResourceMetadata(origin: string): Record<string, unknown> {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: ['mcp'],
    bearer_methods_supported: ['header'],
  };
}

/**
 * RFC 8414 OAuth Authorization Server Metadata. Tells MCP-spec-
 * compliant clients which endpoints to use for the OAuth dance.
 *
 * Critical fields per spec/research:
 *   - `registration_endpoint` — must be advertised (EF-001).
 *   - `code_challenge_methods_supported: ["S256"]` — PKCE S256 only
 *     (no "plain"; see contracts/oauth-endpoints.md).
 *   - `token_endpoint_auth_methods_supported: ["none"]` — explicit
 *     declaration that this is a public client / PKCE-only AS
 *     (EF-002; RFC 8414 default would otherwise be client_secret_basic).
 *   - `grant_types_supported: ["authorization_code"]` — refresh is
 *     stubbed (see spec Out of Scope).
 *
 * Shape spec: <https://datatracker.ietf.org/doc/html/rfc8414#section-2>.
 */
export function buildAuthorizationServerMetadata(origin: string): Record<string, unknown> {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['mcp'],
    token_endpoint_auth_methods_supported: ['none'],
  };
}

/**
 * Cache-Control value for discovery metadata. Metadata changes only
 * when the AS surface itself changes, which is rare. A 1-day TTL
 * keeps Cloudflare's edge + per-client caches from re-hitting Express
 * for every probe (Claude Desktop refreshes on every reconnect).
 */
const DISCOVERY_CACHE_CONTROL = 'public, max-age=86400';

/** Express request handler for PRM. Emits 400 when Host is missing. */
export function handleProtectedResourceMetadata(req: Request, res: Response): void {
  const origin = getServerOrigin(req);
  if (!origin) {
    // RFC 7230 §5.4 requires Host on every HTTP/1.1 request. Without
    // it we can't synthesize the `resource` URL. Same posture as
    // /mcp's missing-Host branch.
    res.status(400).json({ error: 'Missing Host header' });
    return;
  }
  res.setHeader('Cache-Control', DISCOVERY_CACHE_CONTROL);
  res.json(buildProtectedResourceMetadata(origin));
}

/** Express request handler for AS metadata. Emits 400 when Host is missing. */
export function handleAuthorizationServerMetadata(req: Request, res: Response): void {
  const origin = getServerOrigin(req);
  if (!origin) {
    res.status(400).json({ error: 'Missing Host header' });
    return;
  }
  res.setHeader('Cache-Control', DISCOVERY_CACHE_CONTROL);
  res.json(buildAuthorizationServerMetadata(origin));
}

// ── /oauth/register (RFC 7591 Dynamic Client Registration) ───────────

/**
 * Validate the `redirect_uris` field of a DCR request per FR-010.
 *
 * RFC 7591 §2 is permissive about URI shape (any URI scheme is
 * formally allowed); we tighten to the subset that's actually safe
 * to use as an OAuth callback:
 *   - non-empty array;
 *   - each entry parses as an absolute URL with scheme + authority;
 *   - no fragment (`#…`) — fragments leak via Referer + can't carry
 *     OAuth callback params anyway (RFC 6749 §3.1.2).
 *
 * Returned cause string flows verbatim into the
 * `error_description` field of the 400 response, so it's
 * human-readable but contains no PII.
 */
/**
 * Caps that bound the size of a single DCR request. Without these,
 * Express's 100kb JSON limit still allows ~1500 URLs or a single
 * ~50kb URL through — silly shapes that legitimate clients never
 * send but that bloat the DB row.
 *
 * 20 redirect_uris is generous (Claude Desktop registers exactly 1);
 * 2048 chars matches the most common URL-length cap in browsers and
 * HTTP servers.
 */
const REDIRECT_URIS_MAX_ENTRIES = 20;
const REDIRECT_URI_MAX_LENGTH = 2048;

function validateRedirectUris(
  value: unknown,
):
  | { ok: true; uris: string[] }
  | { ok: false; cause: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, cause: 'redirect_uris must be a non-empty array' };
  }
  if (value.length > REDIRECT_URIS_MAX_ENTRIES) {
    return {
      ok: false,
      cause: `redirect_uris must contain at most ${REDIRECT_URIS_MAX_ENTRIES} entries`,
    };
  }
  const uris: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) {
      return { ok: false, cause: 'redirect_uris must contain only non-empty strings' };
    }
    if (entry.length > REDIRECT_URI_MAX_LENGTH) {
      return {
        ok: false,
        cause: `each redirect_uri must be at most ${REDIRECT_URI_MAX_LENGTH} characters`,
      };
    }
    let parsed: URL;
    try {
      parsed = new URL(entry);
    } catch {
      return {
        ok: false,
        cause: `redirect_uri "${entry}" is not a valid absolute URL`,
      };
    }
    // The `!parsed.host` check rejects `javascript:`, `data:`, and
    // `file:` URLs — they parse successfully but have an empty host.
    // This is the protocol-injection defense for the OAuth callback
    // surface; a regression test pins it.
    if (!parsed.protocol || !parsed.host) {
      return {
        ok: false,
        cause: `redirect_uri "${entry}" must include scheme + authority`,
      };
    }
    if (parsed.hash.length > 0) {
      return {
        ok: false,
        cause: `redirect_uri "${entry}" must not contain a fragment`,
      };
    }
    uris.push(entry);
  }
  return { ok: true, uris };
}

/** Length cap for the optional `client_name` field. */
const CLIENT_NAME_MAX_LENGTH = 200;

/**
 * RFC 7591 §3 — DCR registration handler. The endpoint is
 * unauthenticated by RFC; abuse is bounded by the two rate limiters
 * mounted in front of it (`buildDcrPerIpRateLimit` +
 * `buildDcrDailyCapRateLimit`).
 *
 * On valid input → 201 + persisted `OAuthClient` row + the RFC 7591
 * client information response. On any validation failure → 400 +
 * `{ error: 'invalid_redirect_uri', error_description }` per
 * RFC 7591 §3.2.2. We deliberately do NOT redirect on failure (the
 * caller hasn't proved it owns the redirect_uri).
 */
export async function handleClientRegistration(
  req: Request,
  res: Response,
): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;

  const validation = validateRedirectUris(body.redirect_uris);
  if (!validation.ok) {
    res.status(400).json({
      error: 'invalid_redirect_uri',
      error_description: validation.cause,
    });
    return;
  }

  // client_name is optional per RFC 7591 §2. Cap length to avoid
  // unbounded writes; fall back to a stable placeholder so the
  // persisted row is always usable downstream (consent screen
  // renders client.clientName).
  const rawName = body.client_name;
  const clientName =
    typeof rawName === 'string' && rawName.length > 0
      ? rawName.slice(0, CLIENT_NAME_MAX_LENGTH)
      : 'Unnamed MCP Client';

  // 16 bytes / 128 bits / 32 hex chars per data-model.md OAuthClient
  // docstring. The `dcr_` prefix distinguishes DCR-minted clients
  // from seeded fixtures (e.g., `'test'`).
  const clientId = `dcr_${randomBytes(16).toString('hex')}`;
  const issuedAt = Math.floor(Date.now() / 1000);

  // Express 4 does NOT auto-forward rejected async-handler promises
  // to its error middleware, so an unhandled DB failure (Prisma
  // timeout, connection exhaustion, constraint regression in a
  // future migration) would surface as `unhandledRejection` and —
  // since Node 15 — crash the process. That turns a DB blip into a
  // remote-attacker-controlled DOS for an unauthenticated endpoint.
  // Catch + 500 keeps the failure mode local to the request.
  try {
    await db.oAuthClient.create({
      data: {
        clientId,
        clientName,
        redirectUris: validation.uris,
      },
    });
  } catch (err) {
    // Don't echo the DB error message back — it may name internal
    // identifiers or constraints. `server_error` is RFC 7591 §3.2.2's
    // catch-all error code.
    res.status(500).json({
      error: 'server_error',
      error_description: 'Failed to persist registration',
    });
    return;
  }

  res.status(201).json({
    client_id: clientId,
    client_name: clientName,
    redirect_uris: validation.uris,
    // We only support public-client / PKCE-only flows; echo the EF-002
    // declaration back so clients don't have to re-parse AS metadata.
    token_endpoint_auth_method: 'none',
    client_id_issued_at: issuedAt,
  });
}

// ── Rate-limit middleware factories (FR-019 / R-2) ───────────────────
//
// Multi-worker note: express-rate-limit defaults to an in-process
// `MemoryStore`. In a pm2-cluster or k8s-replicas deployment, each
// worker holds its own counter — effective burst becomes
// `10 × workers/min/IP` rather than the documented 10/min/IP. That's
// acceptable for Phase 2B (the limit exists to stop accidental DOS,
// not to enforce a hard quota). If we ever need a true cluster-wide
// ceiling, swap to a Redis store via `rate-limit-redis`.

/**
 * Body shape returned by both rate-limit middlewares on exceedance.
 * Spec contract allows either an empty body or `{ error: 'rate_limit_exceeded' }`;
 * we emit the explicit shape so clients can disambiguate.
 */
const RATE_LIMITED_BODY = { error: 'rate_limit_exceeded' };

/**
 * Per-IP burst limiter — 10 req/IP/min. Catches the typical accidental
 * DOS shape (client retries every ~100ms after a failure).
 * `Retry-After` is emitted by express-rate-limit via
 * `standardHeaders: 'draft-7'` and is bounded above by `windowMs / 1000`.
 */
export function buildDcrPerIpRateLimit() {
  return rateLimit({
    windowMs: 60_000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: RATE_LIMITED_BODY,
  });
}

/**
 * Per-IP daily quota — 100 req/IP/24h. Second tier behind the burst
 * limit; catches slow-and-steady abuse that stays under 10/min.
 * `Retry-After` is bounded above by `86_400` seconds.
 */
export function buildDcrDailyCapRateLimit() {
  return rateLimit({
    windowMs: 86_400_000,
    limit: 100,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: RATE_LIMITED_BODY,
  });
}

// ── /oauth/authorize (FR-011 / FR-012 / FR-014) ──────────────────────

/**
 * HTML-escape a value for safe insertion into the consent template.
 * Every consent-template substitution flows through this — there are
 * no raw-insertion points in `consent.template.ts`.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface ConsentParams {
  clientName: string;
  scope: string;
  resource: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string;
  csrfToken: string;
}

/**
 * Render the consent HTML. All values are HTML-escaped before
 * substitution; `clientName` and `resource` in particular are
 * attacker-influenced (DCR-supplied / caller-supplied) so escaping
 * is load-bearing for the XSS posture.
 */
export function renderConsent(params: ConsentParams): string {
  let html = CONSENT_TEMPLATE;
  for (const [key, value] of Object.entries(params)) {
    const placeholder = `{{${key}}}`;
    const safe = escapeHtml(value ?? '');
    html = html.split(placeholder).join(safe);
  }
  return html;
}

/**
 * Resolve the CSRF HMAC secret. **Fail-loud** in production when
 * neither `CSRF_SECRET` nor `JWT_SECRET` is set — the original
 * `|| 'dev-only-…'` fallback silently flowed into prod if the
 * JWT boot-policy check ever changed or was bypassed. The dev
 * secret must be unreachable in any deployment where real users
 * are reaching the consent flow.
 *
 * Test and local dev fall back to a fixed dev secret; CI sets
 * `NODE_ENV !== 'production'`.
 */
function resolveCsrfSecret(): string {
  const secret = process.env.CSRF_SECRET || process.env.JWT_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'CSRF_SECRET (or JWT_SECRET fallback) is required in production for /oauth/authorize',
    );
  }
  return 'dev-only-csrf-secret-not-for-production';
}

/**
 * Build the `csrf-csrf` Double-Submit-Cookie protection utilities for
 * `POST /oauth/authorize`. Per REV-1 / FR-014.
 *
 * Bound to the signed-in user via `getSessionIdentifier` (reads the
 * `hadron_token` JWT's `sub`). `decodeJwt` is used (NOT `verifyJwt`)
 * because csrf-csrf's hook is synchronous; this is safe because
 * (a) the session id is only an HMAC input — it does NOT grant
 * authorization, and (b) the handler verifies the JWT properly
 * after CSRF passes. The actual access check is enforced by the
 * handler's own `getUserIdFromCookie`, which DOES verify.
 *
 * The token is read from the form body (`_csrf` field) rather than
 * the default `X-CSRF-Token` header — that's the only way the
 * consent form (a plain HTML POST) can submit it.
 *
 * Cookie config:
 *   - `httpOnly: true` — the cookie carries the second half of the
 *     double-submit; not readable from JS so XSS can't forge it.
 *   - `secure` in production, `sameSite: 'lax'` so the cookie does
 *     survive the same-origin POST from the consent form.
 *   - `path: '/'` so the cookie covers the entire AS surface (the
 *     POST endpoint is at /oauth/authorize, set during the GET at
 *     the same path; lax sameSite alone isn't enough scope-wise).
 */
function buildAuthorizeCsrfProtection(): DoubleCsrfUtilities {
  const secret = resolveCsrfSecret();
  return doubleCsrf({
    getSecret: () => secret,
    getSessionIdentifier: (req) => {
      const token = req.cookies?.hadron_token;
      if (typeof token !== 'string' || token.length === 0) return 'anonymous';
      try {
        const payload = decodeJwt(token);
        return typeof payload.sub === 'string' ? payload.sub : 'anonymous';
      } catch {
        return 'anonymous';
      }
    },
    cookieName: '_hadron_csrf',
    cookieOptions: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
    },
    getCsrfTokenFromRequest: (req) => {
      const body = req.body as Record<string, unknown> | undefined;
      const v = body?._csrf;
      return typeof v === 'string' ? v : '';
    },
  });
}

/**
 * Extract the signed-in user's id from the `hadron_token` cookie.
 * Returns `null` for "not signed in or invalid token" — the caller
 * treats both as anonymous (which under Option-C means redirecting
 * to `/auth/github`).
 */
async function getUserIdFromCookie(req: Request): Promise<string | null> {
  const token = req.cookies?.hadron_token;
  if (typeof token !== 'string' || token.length === 0) return null;
  try {
    const payload = await verifyJwt(token);
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

/**
 * Build a redirect URL by setting OAuth-reserved query params on a
 * base. Handles the case where the base already has a query string
 * (the registered redirect_uri can legitimately include one, e.g.
 * `https://app.example.com/cb?env=prod`).
 *
 * Uses `searchParams.set` (NOT `append`) — the OAuth-reserved keys
 * `code`, `error`, `state`, `error_description` are authoritative
 * from THIS response. If the registered URI carries a pre-existing
 * `?code=fixed`, that's a client-side mistake at best and a fixation
 * attack at worst; either way our response is the source of truth.
 * `set` overwrites any pre-existing value for the same key, so a
 * tampered `?code=…` registered URI can't end up with two `code`
 * params in the final redirect (RFC 6749 §3.1.2 doesn't prohibit
 * registered URIs with query strings; client parsing of duplicate
 * `code` is undefined).
 *
 * Empty / null / undefined values are skipped so we don't emit
 * `…?error=invalid_request&state=` (RFC 6749 §4.1.2 makes the
 * `state` echo optional when the caller didn't send one).
 */
function buildRedirectWithParams(
  base: string,
  params: Record<string, string | undefined | null>,
): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

/**
 * Post-client-validation error redirect. Used for any /authorize
 * request shape error where we've ALREADY verified that
 * `client_id` + `redirect_uri` are legitimate, so it's safe to
 * redirect to the caller's URL with an OAuth-spec error parameter.
 */
function redirectWithOAuthError(
  res: Response,
  redirectUri: string,
  error: string,
  state: string | undefined,
): void {
  const url = buildRedirectWithParams(redirectUri, { error, state });
  res.redirect(302, url);
}

interface ValidatedClient {
  clientId: string;
  clientName: string;
  redirectUri: string;
}

/**
 * Pre-redirect validation. Per FR-011: if `client_id` is unknown OR
 * `redirect_uri` is not in the client's allow-list, respond `400`
 * with JSON — do NOT redirect (the caller hasn't proved redirect_uri
 * ownership, so any redirect at this point is an open-redirect vector).
 *
 * Returns the validated tuple on success; on failure, writes the
 * 400 response and returns `null` so the caller short-circuits.
 */
async function validateClientAndRedirectUri(
  res: Response,
  rawClientId: unknown,
  rawRedirectUri: unknown,
): Promise<ValidatedClient | null> {
  if (typeof rawClientId !== 'string' || rawClientId.length === 0) {
    res.status(400).json({
      error: 'invalid_client',
      error_description: 'client_id is required',
    });
    return null;
  }
  if (typeof rawRedirectUri !== 'string' || rawRedirectUri.length === 0) {
    res.status(400).json({
      error: 'invalid_redirect_uri',
      error_description: 'redirect_uri is required',
    });
    return null;
  }
  const client = await db.oAuthClient.findUnique({
    where: { clientId: rawClientId },
  });
  if (!client || client.deletedAt) {
    res.status(400).json({
      error: 'invalid_client',
      error_description: 'client_id is unknown',
    });
    return null;
  }
  if (!client.redirectUris.includes(rawRedirectUri)) {
    res.status(400).json({
      error: 'invalid_redirect_uri',
      error_description: 'redirect_uri is not registered for this client',
    });
    return null;
  }
  return {
    clientId: client.clientId,
    clientName: client.clientName,
    redirectUri: rawRedirectUri,
  };
}

/** v1 caps on the variable-size /authorize params. */
const STATE_MAX_LENGTH = 512;
/**
 * PKCE S256 challenges are base64url-encoded SHA-256 outputs:
 * exactly 43 chars without padding. RFC 7636 §4.2 mandates a
 * 43–128 char range and the `[A-Z][a-z][0-9]-._~` charset
 * ("base64url + unreserved"). Rejecting at the gate is fail-fast
 * — the /token PKCE verifier would also reject a malformed
 * challenge, but doing it here means consent never renders for
 * a bad challenge.
 */
const CODE_CHALLENGE_MIN_LENGTH = 43;
const CODE_CHALLENGE_MAX_LENGTH = 128;
const CODE_CHALLENGE_CHARSET = /^[A-Za-z0-9\-._~]+$/;
const RESOURCE_MAX_LENGTH = 2048;

/** True iff `v` is a valid PKCE S256 code_challenge per RFC 7636 §4.2. */
function isValidCodeChallenge(v: string): boolean {
  return (
    v.length >= CODE_CHALLENGE_MIN_LENGTH &&
    v.length <= CODE_CHALLENGE_MAX_LENGTH &&
    CODE_CHALLENGE_CHARSET.test(v)
  );
}

/**
 * `GET /oauth/authorize` per the contract in contracts/oauth-endpoints.md.
 * Validation order (load-bearing):
 *   1. `client_id` + `redirect_uri` — pre-redirect 400 if invalid.
 *   2. Sign-in check — Option-C bounce to /auth/github with return_to.
 *   3. Other param shape — post-client-validated → redirect with
 *      `?error=invalid_request|invalid_scope`.
 *   4. Happy path — issue CSRF token + render consent HTML.
 *
 * `generateCsrfToken` is closured-in by `buildOAuthRouter` so each
 * router instance binds to its own CSRF utilities.
 */
function buildHandleAuthorizeGet(
  csrf: DoubleCsrfUtilities,
): (req: Request, res: Response) => Promise<void> {
  return async function handleAuthorizeGet(req: Request, res: Response): Promise<void> {
    const q = req.query as Record<string, unknown>;

    // 1. Pre-redirect validation.
    const validated = await validateClientAndRedirectUri(res, q.client_id, q.redirect_uri);
    if (!validated) return;
    const { clientName, redirectUri } = validated;

    // RFC 8707 §2 allows multiple `resource` values; v1 limits to 1.
    if (Array.isArray(q.resource)) {
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'multiple resource values are not supported in v1',
      });
      return;
    }

    // Pre-redirect: capture state for echo. If state is malformed
    // (not a string, or oversized) we drop it rather than try to
    // echo garbage back.
    const state =
      typeof q.state === 'string' && q.state.length > 0 && q.state.length <= STATE_MAX_LENGTH
        ? q.state
        : '';

    // 2. Sign-in check. Not signed in → Option-C bounce.
    const userId = await getUserIdFromCookie(req);
    if (!userId) {
      // req.originalUrl is the path + query that hit Express
      // (e.g., `/oauth/authorize?client_id=…&state=…`). The
      // `/auth/github` handler's `isServerLocalPath` predicate
      // accepts paths starting with `/` and not `//`, which
      // matches.
      res.redirect(302, `/auth/github?return_to=${encodeURIComponent(req.originalUrl)}`);
      return;
    }

    // 3. Post-client-validation shape checks — redirect with OAuth error.
    const responseType = typeof q.response_type === 'string' ? q.response_type : '';
    if (responseType !== 'code') {
      redirectWithOAuthError(res, redirectUri, 'invalid_request', state);
      return;
    }
    const codeChallenge = typeof q.code_challenge === 'string' ? q.code_challenge : '';
    if (codeChallenge.length === 0 || !isValidCodeChallenge(codeChallenge)) {
      redirectWithOAuthError(res, redirectUri, 'invalid_request', state);
      return;
    }
    const codeChallengeMethod =
      typeof q.code_challenge_method === 'string' ? q.code_challenge_method : '';
    if (codeChallengeMethod !== 'S256') {
      redirectWithOAuthError(res, redirectUri, 'invalid_request', state);
      return;
    }
    const resource = typeof q.resource === 'string' ? q.resource : '';
    if (resource.length === 0 || resource.length > RESOURCE_MAX_LENGTH) {
      redirectWithOAuthError(res, redirectUri, 'invalid_request', state);
      return;
    }
    // Repeated `?scope=` (Express qs parser yields an array) is
    // a malformed request — fail loudly rather than silently
    // coerce to the default 'mcp'.
    if (Array.isArray(q.scope)) {
      redirectWithOAuthError(res, redirectUri, 'invalid_request', state);
      return;
    }
    const scope = typeof q.scope === 'string' && q.scope.length > 0 ? q.scope : 'mcp';
    if (scope !== 'mcp') {
      redirectWithOAuthError(res, redirectUri, 'invalid_scope', state);
      return;
    }

    // 4. Happy path — issue CSRF token and render consent HTML.
    const csrfToken = csrf.generateCsrfToken(req, res);
    const html = renderConsent({
      clientName,
      scope,
      resource,
      clientId: validated.clientId,
      redirectUri,
      codeChallenge,
      codeChallengeMethod,
      state,
      csrfToken,
    });
    res.type('html').send(html);
  };
}

/**
 * `POST /oauth/authorize` per FR-012 / FR-014. CSRF middleware has
 * already validated `_csrf` (or rejected with 403). Re-validates
 * `client_id` + `redirect_uri` (open-redirect mitigation — never
 * trust the form data alone for the redirect target).
 *
 * `decision === 'approve'` is the ONLY decision that mints an
 * AuthCode. Anything else — `'deny'`, `'yes'`, missing, malformed,
 * other Unicode — falls through to the deny path. **Fail-closed.**
 */
async function handleAuthorizePost(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;

  // 1. Auth check — same as GET. Without a signed-in user we can't
  // mint an AuthCode, but we ALSO can't safely redirect (we haven't
  // re-validated the redirect_uri yet). Treat as 401.
  const userId = await getUserIdFromCookie(req);
  if (!userId) {
    res.status(401).json({ error: 'unauthorized', error_description: 'Not signed in' });
    return;
  }

  // 2. Re-validate client_id + redirect_uri (open-redirect mitigation).
  const validated = await validateClientAndRedirectUri(res, body.client_id, body.redirect_uri);
  if (!validated) return;
  const { redirectUri } = validated;

  // 3. RFC 8707 single-resource enforcement (v1).
  if (Array.isArray(body.resource)) {
    res.status(400).json({
      error: 'invalid_request',
      error_description: 'multiple resource values are not supported in v1',
    });
    return;
  }

  const state =
    typeof body.state === 'string' && body.state.length > 0 && body.state.length <= STATE_MAX_LENGTH
      ? body.state
      : '';

  // 4. Fail-closed decision check. ONLY literal 'approve' mints.
  if (body.decision !== 'approve') {
    redirectWithOAuthError(res, redirectUri, 'access_denied', state);
    return;
  }

  // 5. Re-validate the post-body shape. The GET handler should have
  // pre-validated these, but the form could be tampered with.
  const codeChallenge = typeof body.code_challenge === 'string' ? body.code_challenge : '';
  if (codeChallenge.length === 0 || !isValidCodeChallenge(codeChallenge)) {
    redirectWithOAuthError(res, redirectUri, 'invalid_request', state);
    return;
  }
  const resource = typeof body.resource === 'string' ? body.resource : '';
  if (resource.length === 0 || resource.length > RESOURCE_MAX_LENGTH) {
    redirectWithOAuthError(res, redirectUri, 'invalid_request', state);
    return;
  }

  // 6. Mint the AuthCode.
  // Per REV-5: store SHA-256(code), never plaintext. The raw `code`
  // is handed to the client via the redirect query param exactly
  // once; we only ever look it up by hash at /token.
  // Per REV-3: resource is `String[]` — the v1 contract limits to
  // one element but the storage shape is future-proof.
  const rawCode = randomBytes(32).toString('hex'); // 64 hex / 256 bits entropy
  const codeHash = createHash('sha256').update(rawCode).digest('hex');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10-minute expiry

  try {
    await db.authCode.create({
      data: {
        codeHash,
        clientId: validated.clientId,
        userId,
        redirectUri,
        codeChallenge,
        resource: [resource],
        expiresAt,
        createdBy: userId,
      },
    });
  } catch {
    // Same posture as /oauth/register: a thrown Prisma error must
    // not become an unhandled rejection. 500 is the catch-all per
    // RFC 7591 §3.2.2.
    res.status(500).json({
      error: 'server_error',
      error_description: 'Failed to issue authorization code',
    });
    return;
  }

  // 7. Redirect with the RAW code (not the hash). Single-use; the
  // /token handler atomically claims it via updateMany-with-conditional.
  const url = buildRedirectWithParams(redirectUri, { code: rawCode, state });
  res.redirect(302, url);
}

// ── /oauth/token (FR-013, FR-015) ────────────────────────────────────

/**
 * Verify a PKCE S256 challenge/verifier pair per RFC 7636 §4.6.
 *
 *   challenge MUST equal base64url(sha256(verifier))
 *
 * `timingSafeEqual` defends against timing oracles on the comparison
 * step (the attacker controls `verifier`; if equality were a
 * short-circuit string compare, the attacker could byte-by-byte
 * probe the stored `challenge`).
 */
function verifyPkceS256(verifier: string, storedChallenge: string): boolean {
  const computed = createHash('sha256').update(verifier).digest('base64url');
  const a = Buffer.from(computed, 'utf8');
  const b = Buffer.from(storedChallenge, 'utf8');
  // The length check is necessary because `timingSafeEqual` throws
  // on unequal-length inputs. It IS a mild timing oracle (an attacker
  // could distinguish "wrong length" from "right length, wrong bytes"
  // in nanoseconds) but it's not exploitable: SHA-256 base64url output
  // is ALWAYS 43 chars, and `storedChallenge` came from /authorize's
  // strict 43-char min validator (PR #157). A length mismatch here
  // means the stored value was tampered with at the DB layer, which
  // is outside the threat model this check defends against.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Defensive revocation. Per the spec Edge Cases, any non-match on a
 * looked-up AuthCode that ISN'T just "code expired" → mark the row
 * `redeemedAt = NOW()` so the same code can't be tried again with
 * a different parameter set (probing defense). The same
 * `updateMany`-with-conditional pattern as the normal redemption —
 * race-safe + idempotent + no error if the row's already redeemed.
 *
 * Errors are intentionally swallowed: this is a defense-in-depth
 * write, not a load-bearing step. The caller has already decided
 * to fail the request; a DB hiccup here shouldn't change the
 * response code.
 */
async function revokeAuthCodeByHash(codeHash: string): Promise<void> {
  try {
    await db.authCode.updateMany({
      where: { codeHash, redeemedAt: null },
      data: { redeemedAt: new Date() },
    });
  } catch {
    // Swallow — see docstring.
  }
}

/**
 * PKCE-only verifier range per RFC 7636 §4.1: 43-128 chars, same
 * unreserved-URI charset as the challenge. Without these caps a
 * pathological client could send a multi-megabyte verifier and
 * make SHA-256 work proportional to it.
 */
const CODE_VERIFIER_MIN_LENGTH = 43;
const CODE_VERIFIER_MAX_LENGTH = 128;
const CODE_VERIFIER_CHARSET = /^[A-Za-z0-9\-._~]+$/;

function isValidCodeVerifier(v: string): boolean {
  return (
    v.length >= CODE_VERIFIER_MIN_LENGTH &&
    v.length <= CODE_VERIFIER_MAX_LENGTH &&
    CODE_VERIFIER_CHARSET.test(v)
  );
}

/**
 * `POST /oauth/token` — RFC 6749 §4.1.3 authorization-code exchange.
 *
 * Auth: none (public client; PKCE is the proof of possession).
 *
 * Validation order:
 *   0. `grant_type` MUST be `'authorization_code'` (the only one
 *      we support; refresh-token is stubbed per spec Out of Scope).
 *   1. Look up AuthCode by `sha256(code)` (REV-5: plaintext code is
 *      never stored, only its hash). Unknown / already redeemed →
 *      400 `invalid_grant`.
 *   2. Verify `client_id`, `redirect_uri`, and the single-element
 *      `resource` array element-for-element (REV-3 storage shape).
 *      Mismatch → 400 + revoke (probing defense).
 *   3. PKCE: `base64url(sha256(verifier)) === storedChallenge`,
 *      constant-time. Mismatch → 400 + revoke.
 *   4. Expiry. Past → 400 (no revoke; already irretrievable).
 *   5. Atomic claim via `updateMany({ where: { codeHash, redeemedAt:
 *      null }, data: { redeemedAt: NOW() } })`. count !== 1 →
 *      lost the race; some concurrent request just redeemed it →
 *      400 `invalid_grant`. This is the SC-005 / R-9 race guard.
 *   6. Mint a `hdr_user_*` token via the shared `mintUserApiKey`
 *      helper (FR-015 — same insert path as the GraphQL
 *      `createUserApiKey` resolver). `issuedVia: 'oauth:<clientId>'`
 *      so the audit trail names the OAuth client that owns the
 *      token.
 *   7. Respond per RFC 6749 §5.1: `access_token`, `token_type:
 *      'Bearer'`, `scope: 'mcp'`. No `expires_in` (opaque tokens
 *      are long-lived per D-2026-05-17-001). No `refresh_token`
 *      (spec Out of Scope).
 */
async function handleOAuthToken(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;

  // **Error-code privacy posture**: RFC 6749 §5.2 distinguishes
  // `invalid_request` (missing required parameter) from `invalid_grant`
  // (parameter present but credential is unknown / expired / mismatched).
  // We deliberately collapse "missing code / client_id / redirect_uri /
  // verifier" into `invalid_grant`, identical to the "present-but-
  // unknown" path. The distinction would tell an attacker which
  // branch they hit (was the credential malformed, or did it not
  // match a real row?). Uniform `invalid_grant` keeps both
  // indistinguishable. Spec-compliant clients should never
  // differentiate retry logic on error code anyway. The
  // `unsupported_grant_type` and `invalid_request` (multi-value
  // resource) codes still surface where they're useful diagnostics
  // for client developers without leaking back-end state.

  // 0. grant_type.
  if (body.grant_type !== 'authorization_code') {
    res.status(400).json({
      error: 'unsupported_grant_type',
      error_description: 'only authorization_code is supported',
    });
    return;
  }

  // 1. Look up by hash.
  const rawCode = typeof body.code === 'string' ? body.code : '';
  if (rawCode.length === 0) {
    res.status(400).json({
      error: 'invalid_grant',
      error_description: 'code is required',
    });
    return;
  }
  const codeHash = createHash('sha256').update(rawCode).digest('hex');
  const authCode = await db.authCode.findUnique({ where: { codeHash } });
  if (!authCode) {
    res.status(400).json({
      error: 'invalid_grant',
      error_description: 'code is unknown',
    });
    return;
  }
  if (authCode.redeemedAt) {
    // Spec Edge Case: already-redeemed code is indistinguishable
    // from unknown to the caller (same response). The row stays
    // marked so subsequent attempts hit this branch.
    res.status(400).json({
      error: 'invalid_grant',
      error_description: 'code is unknown',
    });
    return;
  }

  // 2. Bindings. Each mismatch revokes the code (probing defense).
  const submittedClientId = typeof body.client_id === 'string' ? body.client_id : '';
  if (submittedClientId !== authCode.clientId) {
    await revokeAuthCodeByHash(codeHash);
    res.status(400).json({
      error: 'invalid_grant',
      error_description: 'client_id does not match the authorization code',
    });
    return;
  }
  const submittedRedirectUri =
    typeof body.redirect_uri === 'string' ? body.redirect_uri : '';
  if (submittedRedirectUri !== authCode.redirectUri) {
    await revokeAuthCodeByHash(codeHash);
    res.status(400).json({
      error: 'invalid_grant',
      error_description: 'redirect_uri does not match the authorization code',
    });
    return;
  }
  // resource: REV-3 stored as String[]; v1 contract is exactly 1
  // element (the same constraint as /authorize). Multi-occurrence
  // in the request → reject.
  if (Array.isArray(body.resource)) {
    await revokeAuthCodeByHash(codeHash);
    res.status(400).json({
      error: 'invalid_request',
      error_description: 'multiple resource values are not supported in v1',
    });
    return;
  }
  const submittedResource = typeof body.resource === 'string' ? body.resource : '';
  if (
    authCode.resource.length !== 1 ||
    authCode.resource[0] !== submittedResource
  ) {
    await revokeAuthCodeByHash(codeHash);
    res.status(400).json({
      error: 'invalid_grant',
      error_description: 'resource does not match the authorization code',
    });
    return;
  }

  // 3. PKCE.
  const codeVerifier = typeof body.code_verifier === 'string' ? body.code_verifier : '';
  if (codeVerifier.length === 0 || !isValidCodeVerifier(codeVerifier)) {
    await revokeAuthCodeByHash(codeHash);
    res.status(400).json({
      error: 'invalid_grant',
      error_description: 'PKCE code_verifier is malformed',
    });
    return;
  }
  if (!verifyPkceS256(codeVerifier, authCode.codeChallenge)) {
    await revokeAuthCodeByHash(codeHash);
    res.status(400).json({
      error: 'invalid_grant',
      error_description: 'PKCE verification failed',
    });
    return;
  }

  // 4. Expiry. No revoke needed — the row is already unreachable
  // by anyone via this code.
  if (authCode.expiresAt.getTime() <= Date.now()) {
    res.status(400).json({
      error: 'invalid_grant',
      error_description: 'code has expired',
    });
    return;
  }

  // 5. Atomic claim (SC-005 / R-9 race guard).
  // Postgres handles the UPDATE under the row lock; under concurrent
  // attempts, exactly one query sees count=1 + the others see count=0.
  // No transaction / SELECT FOR UPDATE needed — the conditional WHERE
  // is the lock.
  let claimedCount: number;
  try {
    const result = await db.authCode.updateMany({
      where: { codeHash, redeemedAt: null },
      data: { redeemedAt: new Date() },
    });
    claimedCount = result.count;
  } catch {
    res.status(500).json({
      error: 'server_error',
      error_description: 'failed to claim authorization code',
    });
    return;
  }
  if (claimedCount !== 1) {
    // Lost the race. The other side just minted a token; we don't.
    res.status(400).json({
      error: 'invalid_grant',
      error_description: 'code is unknown',
    });
    return;
  }

  // 6. Mint via the shared FR-015 insert path.
  // The client lookup is post-claim because: (a) we already validated
  // submittedClientId against the AuthCode.clientId binding above, and
  // (b) by claiming first, a concurrent client-deletion can't
  // double-mint. RFC 7591 §2 leaves clientName optional, so fall back
  // to clientId so the label never reads "OAuth: undefined".
  const client = await db.oAuthClient.findUnique({
    where: { clientId: authCode.clientId },
  });
  const clientNameForLabel =
    client?.clientName && client.clientName.length > 0
      ? client.clientName
      : authCode.clientId;

  let rawKey: string;
  try {
    // Cap the label at the same length as the GraphQL resolver's
    // user-supplied label. Today the implicit cap depends on DCR's
    // 200-char client_name cap from PR #154; if that ever changes,
    // we'd want the OAuth label to stay bounded regardless. Defense
    // in depth via a single shared constant.
    const label = `OAuth: ${clientNameForLabel}`.slice(0, USER_API_KEY_LABEL_MAX_LEN);
    const minted = await mintUserApiKey(db, {
      userId: authCode.userId,
      label,
      createdBy: authCode.userId,
      issuedVia: `oauth:${authCode.clientId}`,
    });
    rawKey = minted.rawKey;
  } catch {
    // The AuthCode is already claimed; we can't un-claim it
    // safely. The user can retry the OAuth dance from scratch.
    // Better to fail-loud than to silently leave them with a
    // dead code.
    res.status(500).json({
      error: 'server_error',
      error_description: 'failed to issue access token',
    });
    return;
  }

  // 7. RFC 6749 §5.1 token response. No `expires_in` — opaque
  // tokens are long-lived per D-2026-05-17-001. No `refresh_token`
  // — out of scope.
  res.status(200).json({
    access_token: rawKey,
    token_type: 'Bearer',
    scope: 'mcp',
  });
}

// ── Router assembly ──────────────────────────────────────────────────

/**
 * Build the Express sub-router for the OAuth surface. Returns a fresh
 * `Router` instance with fresh rate-limit middleware AND a fresh
 * CSRF utility chain each time — production calls this exactly once
 * during `createServer()`; tests call it per-test so each test gets
 * clean rate-limit counters + cookie-bound CSRF tokens.
 *
 * Routes (paths are absolute from app root because the router is
 * mounted without a prefix in `mountOAuthRoutes`):
 *   - GET  /.well-known/oauth-protected-resource     (Phase 2A)
 *   - GET  /.well-known/oauth-authorization-server   (Phase 2A)
 *   - POST /oauth/register                            (Phase 2B)
 *   - GET  /oauth/authorize                           (Phase 2C)
 *   - POST /oauth/authorize                           (Phase 2C, CSRF-protected)
 *   - POST /oauth/token                               (Phase 2D)
 */
export function buildOAuthRouter(): Router {
  const router = Router();

  router.get('/.well-known/oauth-protected-resource', handleProtectedResourceMetadata);
  router.get('/.well-known/oauth-authorization-server', handleAuthorizationServerMetadata);

  // Middleware order matters: burst first (cheaper to reject the
  // tight-loop case), then daily quota, then handler. Both limiters
  // key on `req.ip`, which depends on `app.set('trust proxy', …)` —
  // see FR-006 and src/server.ts.
  router.post(
    '/oauth/register',
    buildDcrPerIpRateLimit(),
    buildDcrDailyCapRateLimit(),
    handleClientRegistration,
  );

  // /oauth/authorize: GET renders the consent screen (after issuing
  // a CSRF token cookie); POST processes the decision. Both depend
  // on the `cookie-parser` middleware mounted in server.ts.
  const csrf = buildAuthorizeCsrfProtection();
  router.get('/oauth/authorize', buildHandleAuthorizeGet(csrf));
  router.post(
    '/oauth/authorize',
    // The consent form is application/x-www-form-urlencoded.
    // express.json (mounted globally in server.ts) does NOT parse
    // form bodies; mount urlencoded here so both the CSRF
    // middleware (reads body._csrf) and the handler see the form
    // fields.
    express.urlencoded({ extended: false }),
    csrf.doubleCsrfProtection,
    handleAuthorizePost,
  );

  // /oauth/token: form-encoded (RFC 6749 §4.1.3); unauthenticated
  // (public client; PKCE is the proof). No CSRF — this is a
  // machine-to-machine endpoint, not a browser-form endpoint.
  router.post(
    '/oauth/token',
    express.urlencoded({ extended: false }),
    handleOAuthToken,
  );

  return router;
}

/**
 * Mount the OAuth Authorization Server's HTTP surface on the given
 * Express app. Called from `src/server.ts:createServer()`.
 */
export function mountOAuthRoutes(app: Express): void {
  app.use(buildOAuthRouter());
}
