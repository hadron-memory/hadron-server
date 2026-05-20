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
 * **Phase 2C (this commit):** consent + AuthCode issuance —
 *   - `GET  /oauth/authorize` (consent screen + Option-C sign-in)
 *   - `POST /oauth/authorize` (CSRF-protected approve/deny + AuthCode mint)
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
 *
 * Phase 2D (/token redemption) ships next. Until then, the AuthCode
 * minted by `POST /oauth/authorize` can't be exchanged for a token —
 * the dance reaches the redirect-with-code step but stops there.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { doubleCsrf, type DoubleCsrfUtilities } from 'csrf-csrf';
import { decodeJwt } from 'jose';
import { db } from '../integrations/db/client.js';
import { verifyJwt } from './jwt.js';
import { CONSENT_TEMPLATE } from './consent.template.js';

/** Derive the canonical server origin from request headers. */
export function getServerOrigin(req: Request): string | null {
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
  const secret =
    process.env.CSRF_SECRET ||
    process.env.JWT_SECRET ||
    // Test/dev convenience: when neither env var is set, the
    // server is running in a context where CSRF protection isn't
    // load-bearing (no real users). Production deployments set
    // JWT_SECRET; the boot-policy check in src/auth/jwt.ts will
    // already have refused to start without it.
    'dev-only-csrf-secret-not-for-production';
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
 * Build a redirect URL by appending query params to a base. Handles
 * the case where the base already has a query string (the
 * registered redirect_uri can legitimately include one, e.g.
 * `https://app.example.com/cb?env=prod`).
 *
 * Param values are URL-encoded by `URLSearchParams`. Empty / null /
 * undefined values are skipped so we don't emit
 * `…?error=invalid_request&state=` (RFC 6749 §4.1.2 makes the
 * `state` param echo optional when the caller didn't send one).
 */
function buildRedirectWithParams(
  base: string,
  params: Record<string, string | undefined | null>,
): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.append(key, value);
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
const CODE_CHALLENGE_MAX_LENGTH = 128; // RFC 7636 §4.2
const RESOURCE_MAX_LENGTH = 2048;

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
    if (codeChallenge.length === 0 || codeChallenge.length > CODE_CHALLENGE_MAX_LENGTH) {
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
  if (codeChallenge.length === 0 || codeChallenge.length > CODE_CHALLENGE_MAX_LENGTH) {
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
 *   - POST /oauth/token                               → Phase 2D
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

  return router;
}

/**
 * Mount the OAuth Authorization Server's HTTP surface on the given
 * Express app. Called from `src/server.ts:createServer()`.
 */
export function mountOAuthRoutes(app: Express): void {
  app.use(buildOAuthRouter());
}
