/**
 * Spec 025-oauth-for-mcp Phase 2 — MCP-compliant OAuth 2.1
 * Authorization Server.
 *
 * **Phase 2A (this commit):** discovery endpoints only —
 *   - `GET /.well-known/oauth-protected-resource` (PRM per RFC 9728)
 *   - `GET /.well-known/oauth-authorization-server` (AS metadata per RFC 8414)
 *
 * The AS metadata response is what Claude Desktop fetches before
 * walking the OAuth dance — see spec §"Design constraints from
 * empirical findings (PR 137)" for the two empirical findings these
 * endpoints have to satisfy:
 *
 *   - **EF-001** — Claude Desktop's backend probes AS metadata and
 *     silently bails when `registration_endpoint` is absent. We MUST
 *     advertise the DCR endpoint, even though the actual handler
 *     ships in Phase 2B; advertising it now is a no-op for clients
 *     that don't follow up with a registration request.
 *   - **EF-002** — RFC 8414's default `token_endpoint_auth_methods_supported`
 *     is `["client_secret_basic"]`, which leads spec-compliant
 *     clients to expect a client secret. Public-client / PKCE-only
 *     auth issues no secret; we MUST explicitly declare `["none"]`.
 *
 * Phase 2B (DCR) + 2C (/authorize) + 2D (/token) land in follow-on
 * PRs; until 2B ships, the `registration_endpoint` URL advertised
 * here will 404 if a client actually POSTs to it. That's fine for
 * the EF-001 "silently bails" trigger — Claude Desktop checks the
 * metadata before the registration attempt.
 */

import type { Request, Response, Express } from 'express';

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

/**
 * Mount the OAuth Authorization Server's HTTP surface on the given
 * Express app. Called from `src/server.ts:createServer()`.
 *
 * Phase 2A advertises the discovery endpoints; later phases add
 * `/oauth/register` (2B), `/oauth/authorize` (2C), `/oauth/token` (2D).
 */
export function mountOAuthRoutes(app: Express): void {
  app.get('/.well-known/oauth-protected-resource', handleProtectedResourceMetadata);
  app.get('/.well-known/oauth-authorization-server', handleAuthorizationServerMetadata);
}
