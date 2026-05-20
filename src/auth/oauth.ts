/**
 * Spec 025-oauth-for-mcp Phase 2 — MCP-compliant OAuth 2.1
 * Authorization Server.
 *
 * **Phase 2A:** discovery endpoints —
 *   - `GET /.well-known/oauth-protected-resource` (PRM per RFC 9728)
 *   - `GET /.well-known/oauth-authorization-server` (AS metadata per RFC 8414)
 *
 * **Phase 2B (this commit):** Dynamic Client Registration —
 *   - `POST /oauth/register` (DCR per RFC 7591)
 *
 * The AS metadata response is what Claude Desktop fetches before
 * walking the OAuth dance — see spec §"Design constraints from
 * empirical findings (PR 137)" for the two empirical findings these
 * endpoints have to satisfy:
 *
 *   - **EF-001** — Claude Desktop's backend probes AS metadata and
 *     silently bails when `registration_endpoint` is absent. We MUST
 *     advertise the DCR endpoint (Phase 2A) AND it must respond
 *     successfully when the client follows up (Phase 2B, this PR).
 *   - **EF-002** — RFC 8414's default `token_endpoint_auth_methods_supported`
 *     is `["client_secret_basic"]`, which leads spec-compliant
 *     clients to expect a client secret. Public-client / PKCE-only
 *     auth issues no secret; we MUST explicitly declare `["none"]`.
 *
 * Phase 2C (/authorize) + 2D (/token) land in follow-on PRs; until
 * those ship, `POST /oauth/authorize` and `POST /oauth/token` will
 * 404. That's acceptable for Claude Desktop's discovery + registration
 * phases (which complete after this PR).
 */

import { randomBytes } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { db } from '../integrations/db/client.js';

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

// ── Router assembly ──────────────────────────────────────────────────

/**
 * Build the Express sub-router for the OAuth surface. Returns a fresh
 * `Router` instance with fresh rate-limit middleware each time —
 * production calls this exactly once during `createServer()`; tests
 * call it per-test so each test gets clean rate-limit counters.
 *
 * Routes (paths are absolute from app root because the router is
 * mounted without a prefix in `mountOAuthRoutes`):
 *   - GET  /.well-known/oauth-protected-resource     (Phase 2A)
 *   - GET  /.well-known/oauth-authorization-server   (Phase 2A)
 *   - POST /oauth/register                            (Phase 2B)
 *   - POST /oauth/authorize  → Phase 2C
 *   - POST /oauth/token      → Phase 2D
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

  return router;
}

/**
 * Mount the OAuth Authorization Server's HTTP surface on the given
 * Express app. Called from `src/server.ts:createServer()`.
 */
export function mountOAuthRoutes(app: Express): void {
  app.use(buildOAuthRouter());
}
