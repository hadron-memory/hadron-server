// D-2026-05-17-001 / D-2026-05-17-002 — minimal OAuth 2.1 authorization
// server for MCP clients. Public-client model (PKCE-only, no
// client_secret). DCR (RFC 7591) is supported for dynamic client
// onboarding — required for clients like Claude Desktop that have no
// pre-configured client_id for arbitrary servers.
//
// Endpoints:
//   GET  /.well-known/oauth-protected-resource   (RFC 9728)
//   GET  /.well-known/oauth-authorization-server (RFC 8414)
//   GET  /oauth/authorize  (server-rendered consent page, Option C)
//   POST /oauth/authorize  (consent decision → AuthCode + redirect)
//   POST /oauth/token      (AuthCode + PKCE verifier → hdr_user_ token)
//   POST /oauth/register   (RFC 7591 DCR → dcr_<…> client_id)
//
// Tokens minted at /token share the user_api_keys table with portal-
// issued user API keys — same credential shape at the server (D1).

import { createHash, randomBytes } from 'crypto';
import express, { type Express, type Request, type Response } from 'express';
import type { PrismaClient } from '../generated/prisma/index.js';
import { verifyJwt } from './jwt.js';
import { hashUserApiKey, USER_API_KEY_PREFIX } from '../middleware/auth.js';

const AUTH_CODE_TTL_MS = 5 * 60 * 1000;

function getBaseUrl(req: Request): string {
  return `${req.protocol}://${req.get('host') ?? 'localhost'}`;
}

// Minimal cookie parser — we only need to read `hadron_token`. Adding
// cookie-parser as a dep just for one cookie is overkill for the
// prototype.
function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function getCurrentUser(
  req: Request,
  db: PrismaClient,
): Promise<{ id: string; name: string | null; email: string | null; githubUsername: string | null } | null> {
  const cookies = parseCookies(req);
  const token = cookies.hadron_token;
  if (!token) return null;
  try {
    const payload = await verifyJwt(token);
    const user = await db.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, name: true, email: true, githubUsername: true, deletedAt: true },
    });
    if (!user || user.deletedAt) return null;
    return user;
  } catch {
    return null;
  }
}

interface ConsentParams {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  resource: string;
  state: string;
  scope: string;
}

function renderConsentPage(opts: {
  clientName: string;
  user: { name: string | null; email: string | null; githubUsername: string | null };
  params: ConsentParams;
}): string {
  const userDisplay =
    opts.user.name ?? opts.user.githubUsername ?? opts.user.email ?? 'your account';
  const inputs = (Object.entries(opts.params) as [string, string][])
    .map(
      ([k, v]) =>
        `<input type="hidden" name="${htmlEscape(k)}" value="${htmlEscape(v)}">`,
    )
    .join('\n        ');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Authorize ${htmlEscape(opts.clientName)} · Hadron</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 4rem auto; padding: 0 1rem; color: #1a1a1a; }
    h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
    .user { color: #666; font-size: 0.9rem; margin-bottom: 1.5rem; }
    p { line-height: 1.5; }
    .actions { display: flex; gap: 0.75rem; margin-top: 1.5rem; }
    button { padding: 0.625rem 1.25rem; font-size: 0.95rem; border-radius: 6px; border: 1px solid #ccc; background: #fff; cursor: pointer; font-family: inherit; }
    button.approve { background: #1a1a1a; color: #fff; border-color: #1a1a1a; }
    form { display: inline-block; margin: 0; }
  </style>
</head>
<body>
  <h1>Authorize ${htmlEscape(opts.clientName)}?</h1>
  <div class="user">Signed in as ${htmlEscape(userDisplay)}</div>
  <p>${htmlEscape(opts.clientName)} is requesting access to your Hadron data. Approving creates an API token scoped to your account.</p>
  <div class="actions">
    <form method="POST" action="/oauth/authorize">
      ${inputs}
        <input type="hidden" name="decision" value="approve">
      <button class="approve" type="submit">Approve</button>
    </form>
    <form method="POST" action="/oauth/authorize">
      ${inputs}
        <input type="hidden" name="decision" value="deny">
      <button type="submit">Deny</button>
    </form>
  </div>
</body>
</html>`;
}

export function mountOAuthRoutes(app: Express, db: PrismaClient): void {
  // Route-scoped form parser — only the OAuth POST endpoints that
  // expect application/x-www-form-urlencoded bodies (RFC 6749 §3.2 /
  // §4.1.3 and the consent HTML form). /oauth/register takes JSON.
  const formBody = express.urlencoded({ extended: false });

  // §4 — RFC 9728 Protected Resource Metadata
  app.get('/.well-known/oauth-protected-resource', (req: Request, res: Response) => {
    const base = getBaseUrl(req);
    res.json({
      resource: `${base}/`,
      authorization_servers: [`${base}/`],
      bearer_methods_supported: ['header'],
      resource_documentation: 'https://docs.hadronmemory.com/',
    });
  });

  // §5 — RFC 8414 Authorization Server Metadata.
  // registration_endpoint advertised (DCR enabled §8 reinstated — Claude
  // Desktop's backend bails on AS metadata that lacks it, since without
  // pre-config it has no way to learn its client_id otherwise).
  // token_endpoint_auth_methods_supported=["none"] signals public-client
  // PKCE-only — RFC 8414's default of client_secret_basic would mislead
  // clients into expecting a client secret.
  app.get('/.well-known/oauth-authorization-server', (req: Request, res: Response) => {
    const base = getBaseUrl(req);
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp'],
    });
  });

  // §8 — RFC 7591 Dynamic Client Registration.
  // Public clients only (token_endpoint_auth_method=none) — no client
  // secret is issued. PKCE is the authentication. Note this is the
  // OAuth-canonical /oauth/register path; the legacy /register at
  // server.ts (a deliberate 404 + JSON error from before D1b) is left
  // as-is for SDKs that probe the older path.
  app.post('/oauth/register', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const clientName = (typeof body.client_name === 'string' ? body.client_name : null) ?? 'Unnamed MCP Client';
    const redirectUris = Array.isArray(body.redirect_uris)
      ? (body.redirect_uris.filter((u) => typeof u === 'string') as string[])
      : [];
    const tokenAuthMethod = typeof body.token_endpoint_auth_method === 'string'
      ? body.token_endpoint_auth_method
      : 'none';

    if (tokenAuthMethod !== 'none') {
      res.status(400).json({
        error: 'invalid_client_metadata',
        error_description: 'Only token_endpoint_auth_method=none is supported (public clients / PKCE only)',
      });
      return;
    }
    if (!redirectUris.length) {
      res.status(400).json({
        error: 'invalid_redirect_uri',
        error_description: 'At least one redirect_uri is required',
      });
      return;
    }
    // RFC 7591 §2 + RFC 6749 §3.1.2: redirect URIs MUST be absolute
    // URIs and MUST NOT include a fragment component. Validate before
    // storing so a malformed value can't leak through /authorize later.
    for (const uri of redirectUris) {
      let parsed: URL;
      try {
        parsed = new URL(uri);
      } catch {
        res.status(400).json({
          error: 'invalid_redirect_uri',
          error_description: `redirect_uri is not an absolute URL: ${uri}`,
        });
        return;
      }
      if (parsed.hash) {
        res.status(400).json({
          error: 'invalid_redirect_uri',
          error_description: `redirect_uri must not contain a fragment: ${uri}`,
        });
        return;
      }
    }

    const clientId = `dcr_${randomBytes(16).toString('hex')}`;
    await db.oAuthClient.create({
      data: { clientId, clientName, redirectUris },
    });

    res.status(201).json({
      client_id: clientId,
      client_name: clientName,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    });
  });

  // §6 — /authorize (GET). Server-rendered (Option C per artifact
  // pre-implementation finding #3) so we sidestep cross-domain cookies
  // between portal and server.
  app.get('/oauth/authorize', async (req: Request, res: Response) => {
    const q = req.query as Record<string, string | undefined>;
    const { response_type, client_id, redirect_uri, code_challenge,
      code_challenge_method, resource, state, scope } = q;

    // Per OAuth 2.1: client_id / redirect_uri validation errors must NOT
    // redirect (could be CSRF / open-redirect). Render plain JSON 400.
    if (!client_id || !redirect_uri) {
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'client_id and redirect_uri are required',
      });
      return;
    }
    const client = await db.oAuthClient.findUnique({ where: { clientId: client_id } });
    if (!client) {
      res.status(400).json({ error: 'invalid_client', error_description: 'Unknown client_id' });
      return;
    }
    if (!client.redirectUris.includes(redirect_uri)) {
      res.status(400).json({
        error: 'invalid_redirect_uri',
        error_description: 'redirect_uri not registered for this client',
      });
      return;
    }

    // Past this point, errors are safe to redirect back to the client.
    const errorRedirect = (error: string, description?: string): string => {
      const url = new URL(redirect_uri);
      url.searchParams.set('error', error);
      if (description) url.searchParams.set('error_description', description);
      if (state) url.searchParams.set('state', state);
      return url.toString();
    };

    if (response_type !== 'code') {
      res.redirect(errorRedirect('unsupported_response_type', 'Only response_type=code is supported'));
      return;
    }
    if (!code_challenge || code_challenge_method !== 'S256') {
      res.redirect(errorRedirect('invalid_request', 'PKCE code_challenge with method=S256 is required'));
      return;
    }
    if (!resource) {
      res.redirect(errorRedirect('invalid_request', 'RFC 8707 resource parameter is required'));
      return;
    }

    // Check the server-domain session cookie.
    const user = await getCurrentUser(req, db);
    if (!user) {
      // Bounce through the existing GitHub flow with return_to set so the
      // callback knows to write a server-domain cookie and come back here.
      const ret = req.originalUrl;
      res.redirect(`/auth/github?return_to=${encodeURIComponent(ret)}`);
      return;
    }

    const html = renderConsentPage({
      clientName: client.clientName,
      user,
      params: {
        client_id,
        redirect_uri,
        code_challenge,
        code_challenge_method: 'S256',
        resource,
        state: state ?? '',
        scope: scope ?? '',
      },
    });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });

  // §6 — /authorize (POST consent decision).
  app.post('/oauth/authorize', formBody, async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const { decision, client_id, redirect_uri, code_challenge, resource, state } = body;

    const user = await getCurrentUser(req, db);
    if (!user) {
      res.status(401).json({
        error: 'unauthorized',
        error_description: 'Session expired during consent — restart at /oauth/authorize',
      });
      return;
    }

    if (!client_id || !redirect_uri) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const client = await db.oAuthClient.findUnique({ where: { clientId: client_id } });
    if (!client || !client.redirectUris.includes(redirect_uri)) {
      res.status(400).json({ error: 'invalid_client' });
      return;
    }

    if (decision === 'deny') {
      const url = new URL(redirect_uri);
      url.searchParams.set('error', 'access_denied');
      if (state) url.searchParams.set('state', state);
      res.redirect(url.toString());
      return;
    }

    // Fail-closed on the decision parameter: only an explicit 'approve'
    // is allowed to mint an AuthCode. A missing or unknown value
    // (forged form post, browser-extension interference, future
    // additional decisions) must not silently default to approval.
    if (decision !== 'approve') {
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'decision must be "approve" or "deny"',
      });
      return;
    }

    if (!code_challenge || !resource) {
      res.status(400).json({ error: 'invalid_request', error_description: 'Missing code_challenge or resource' });
      return;
    }

    const code = randomBytes(32).toString('hex');
    await db.authCode.create({
      data: {
        code,
        clientId: client_id,
        userId: user.id,
        redirectUri: redirect_uri,
        codeChallenge: code_challenge,
        resource,
        expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS),
      },
    });

    const url = new URL(redirect_uri);
    url.searchParams.set('code', code);
    if (state) url.searchParams.set('state', state);
    res.redirect(url.toString());
  });

  // §7 — /token. Exchanges an AuthCode + PKCE verifier for a
  // hdr_user_ access token (long-lived; no refresh per D6 out-of-v1).
  app.post('/oauth/token', formBody, async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const { grant_type, code, redirect_uri, client_id, code_verifier, resource } = body;

    if (grant_type !== 'authorization_code') {
      res.status(400).json({ error: 'unsupported_grant_type' });
      return;
    }
    if (!code || !redirect_uri || !client_id || !code_verifier || !resource) {
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'Missing required parameter',
      });
      return;
    }

    const authCode = await db.authCode.findUnique({ where: { code } });
    if (!authCode) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'Unknown code' });
      return;
    }
    if (authCode.redeemedAt) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'Code already redeemed' });
      return;
    }
    if (authCode.expiresAt < new Date()) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'Code expired' });
      return;
    }
    if (authCode.clientId !== client_id) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'client_id mismatch' });
      return;
    }
    if (authCode.redirectUri !== redirect_uri) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      return;
    }
    // RFC 8707 §2.2: resource at /token MUST match what /authorize captured.
    if (authCode.resource !== resource) {
      res.status(400).json({ error: 'invalid_target', error_description: 'resource mismatch (RFC 8707)' });
      return;
    }
    // PKCE S256: base64url(SHA256(verifier)) === stored challenge
    const expectedChallenge = createHash('sha256').update(code_verifier).digest('base64url');
    if (expectedChallenge !== authCode.codeChallenge) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
      return;
    }

    // OAuth 2.1 single-use enforcement, race-safe: atomic conditional
    // update on redeemedAt=NULL. The earlier findUnique-then-update path
    // had a TOCTOU window where two concurrent /token calls could both
    // pass the redeemedAt check and both mint tokens. updateMany returns
    // count=0 when the row was already redeemed by a concurrent caller.
    const updateResult = await db.authCode.updateMany({
      where: { id: authCode.id, redeemedAt: null },
      data: { redeemedAt: new Date() },
    });
    if (updateResult.count === 0) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'Code already redeemed' });
      return;
    }

    // Same minting path as Mutation.createUserApiKey — the token shape
    // and storage are identical (D1).
    const rawKey = USER_API_KEY_PREFIX + randomBytes(32).toString('hex');
    const keyHash = hashUserApiKey(rawKey);
    const keyPreview = rawKey.slice(0, 13) + '...' + rawKey.slice(-4);
    await db.userApiKey.create({
      data: {
        userId: authCode.userId,
        keyHash,
        keyPreview,
        label: `oauth:${client_id}`,
        createdBy: authCode.userId,
      },
    });

    res.json({
      access_token: rawKey,
      token_type: 'Bearer',
      scope: 'mcp',
    });
  });
}
