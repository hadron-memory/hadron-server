import crypto from 'crypto';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import { decodeJwt } from 'jose';
import { db } from './integrations/db/client.js';
import { serializeJson } from './integrations/db/provider.js';
import {
  buildAuthUrl,
  exchangeCode,
  fetchUser,
  checkOrgMembership,
  signJwt,
  verifyJwt,
  sendMagicLink,
  verifyMagicLink,
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  verifyGoogleIdToken,
  resolveGoogleUser,
} from './auth/index.js';
import {
  issueLoginCode,
  redeemLoginCode,
  issueExchangeStartNonce,
  redeemExchangeStartNonce,
} from './auth/authHandoff.js';
import { resolveAuthContext } from './middleware/auth.js';
import { initCloudflareIps } from './auth/cloudflare-ips.js';
import { isServerLocalPath } from './auth/server-local-path.js';
import { mountOAuthRoutes } from './auth/oauth.js';
import { resolvers } from './api/graphql/schema/resolvers.js';
import { requireOrgRole } from './api/graphql/schema/resolvers.helpers.js';
import { typeDefs } from './api/graphql/schema/typeDefs.js';
import { UrnNotQualifiedError } from './lib/urn.js';
import { normalizeHandleOrNull } from './lib/userHandle.js';
import { controller } from './controller/controller.js';
import { syncGraphFromGithub } from './integrations/github/syncGraphFromGithub.js';
import { handleMcpRequest, handleMcpDelete } from './mcp/server.js';
import {
  provisionPersonalWorkspace,
  hasPersonalWorkspace,
} from './provisioning/personal-workspace.js';
import { startAnonymousMemoryCleanupLoop } from './jobs/cleanupAnonymousMemories.js';
import { startEmbeddingWorkerLoop, startEmbeddingBusListener } from './jobs/embedNodes.js';
import { startGitMirrorSubscriber } from './integrations/github/nodeWrittenSubscriber.js';
import { GraphQLError, buildSchema, printSchema } from 'graphql';
import {
  stageRequestMemoryKeys,
  MemoryUnlockError,
  REQUEST_KEYS_HEADER,
} from './lib/memoryUnlock.js';
import { requestKeyStorage } from './lib/requestKeys.js';
import { isEmbeddingConfigured } from './lib/embedding/index.js';
import { getBusClient } from './lib/bus/index.js';
import { startAppRunBusListener, startAppRunSweepLoop } from './jobs/appRuns.js';
import { makeProdRunDeps } from './jobs/appRunDeps.js';
import { startSchedulerLoop } from './jobs/scheduler.js';
import { mountWebhookRoutes } from './api/webhooks.js';
import { mountEmailEventRoutes } from './api/emailEvents.js';
import { createToolConnection, deleteToolConnection, subscribeToolFolder } from './lib/emailClient.js';
import { buildMicrosoftAuthUrl, getMicrosoftRedirectUri } from './integrations/exchange/auth.js';

export async function createServer(): Promise<Express> {
  const app = express();

  // Trust-proxy for spec 025-oauth-for-mcp (FR-006). Express must know
  // which upstream proxies it can trust so `req.protocol` resolves to
  // 'https' via X-Forwarded-Proto (otherwise the RFC 9728
  // `WWW-Authenticate: resource_metadata="..."` URL emitted on /mcp 401
  // would be `http://` and Claude Desktop refuses non-HTTPS metadata;
  // see EF-003) and `req.ip` returns the real client IP (matters for
  // the /oauth/register per-IP rate limit in Phase 2).
  //
  // - Dev: permissive `true` is fine for tunnel testing (cloudflared,
  //   ngrok). Anyone on the dev box can spoof X-Forwarded-* but that's
  //   not the production threat model.
  // - Production: trust only Cloudflare's published IP ranges. The
  //   list is fetched at boot from api.cloudflare.com/client/v4/ips
  //   with a 5s timeout, disk-cached for fail-safe-stale, refreshed
  //   daily (see src/auth/cloudflare-ips.ts and research §R-4).
  //
  // If the fetch AND cache both fail in NODE_ENV=production, boot
  // refuses (fail-closed) — emitting permissive `true` URLs in prod
  // is a security regression we won't accept silently. Dev tolerates
  // the failure path by retaining the permissive setting.
  if (process.env.NODE_ENV === 'production') {
    const ips = await initCloudflareIps();
    app.set('trust proxy', [...ips.ipv4_cidrs, ...ips.ipv6_cidrs]);
  } else {
    app.set('trust proxy', true);
  }

  app.use(
    cors({
      origin: process.env.FRONTEND_URL || 'http://localhost:5173',
      credentials: true,
    }),
  );
  // Default express.json cap is 100kb, which rejects large payloads such as
  // full-page HTML clips from the Web Clipper with 413. Raise it for
  // /graphql only — every other JSON endpoint (auth, webhooks, usage, ...)
  // keeps the default so oversized payloads can't tie up parsing there.
  const jsonParser = express.json();
  const jsonParserLarge = express.json({ limit: '25mb' });
  app.use((req, res, next) => {
    if (req.path === '/graphql' || req.path.startsWith('/graphql/')) {
      jsonParserLarge(req, res, next);
    } else {
      jsonParser(req, res, next);
    }
  });

  // Spec 025-oauth-for-mcp FR-016: mount cookie-parser globally so
  // downstream handlers can READ cookies via `req.cookies` (notably
  // Phase 2's /oauth/authorize consent screen, which checks for the
  // server-domain `hadron_token` cookie). Cookie *writing* via
  // `res.cookie(...)` is provided by Express itself and doesn't need
  // this middleware; we mount it now so it's ready for Phase 2.
  // Replaces PR 137's hand-rolled `parseCookies` (R-3).
  app.use(cookieParser());

  // ---------------------------------------------------------------------------
  // GitHub OAuth
  // ---------------------------------------------------------------------------

  // Spec 025-oauth-for-mcp FR-007: pendingStates carries the OAuth
  // state-CSRF token plus an optional `returnTo` (Option-C). When
  // `returnTo` is set, the callback writes a server-domain
  // `hadron_token` cookie and redirects to `returnTo` instead of
  // bouncing the JWT through the frontend.
  const pendingStates = new Map<
    string,
    { redirect: string; returnTo?: string; clientState?: string; expiresAt: number }
  >();

  app.get('/auth/github', (req, res) => {
    const redirect = (req.query.redirect as string) || '/';

    // Option-C: optional `return_to` query param routes the post-
    // callback redirect through this server's domain (rather than the
    // frontend). Validated with the strict server-local-path predicate
    // — open-redirect mitigation per FR-007. The candidate is bound
    // to a local so the predicate's type-guard narrowing flows into
    // the assignment below (without the local, TS sees two separate
    // accesses of req.query.return_to and re-widens to the union).
    let returnTo: string | undefined;
    const candidate = req.query.return_to;
    if (candidate !== undefined) {
      if (!isServerLocalPath(candidate)) {
        res.status(400).json({
          error: 'Invalid return_to: must be a server-local path (starts with / and not //, no protocol, no backslash, no control bytes).',
        });
        return;
      }
      returnTo = candidate;
    }

    // Prune expired entries on every /auth/github hit. pendingStates
    // is in-process memory; entries are deleted on a successful
    // callback hit (line below the callback handler), but users who
    // abandon the flow mid-redirect leave stale rows. O(n) sweep is
    // cheap at our /auth/github call rate (a few per minute at peak).
    // Multi-worker deploys (pm2 cluster, k8s replicas) don't share
    // this map — flagged as a known limitation; revisit when an OAuth
    // request rate justifies a Redis-backed store.
    const now = Date.now();
    for (const [s, p] of pendingStates) {
      if (p.expiresAt < now) pendingStates.delete(s);
    }

    // #477 session-fixation binding: the portal sets an HttpOnly browser nonce
    // at login start (/auth/start/github) and forwards it here as `client_state`.
    // We carry it through the OAuth round-trip and stamp it onto the login
    // handoff code so the browser that FINISHES login must be the one that
    // STARTED it.
    const clientStateRaw = req.query.client_state;
    const clientState = typeof clientStateRaw === 'string' && clientStateRaw !== ''
      ? clientStateRaw
      : undefined;

    // The binding is MANDATORY on the portal-handoff path (Codex #504 P2): an
    // unbound login code redeems for any browser, which reopens the very
    // session-fixation vector this change closes (an attacker mints a code for
    // their own account by hitting this backend URL directly, then lures a
    // victim to /auth/callback?code=… within the TTL). Option-C (`return_to`)
    // is exempt — it sets the hadron_token cookie on this server's origin and
    // mints NO handoff code, so there is nothing to bind.
    if (!returnTo && !clientState) {
      res.status(400).json({
        error: 'client_state is required — start login via the portal (/auth/start/github), not the backend URL directly.',
      });
      return;
    }

    const state = crypto.randomBytes(16).toString('hex');
    pendingStates.set(state, {
      redirect,
      returnTo,
      clientState,
      expiresAt: now + 10 * 60 * 1000,
    });
    res.redirect(buildAuthUrl(state));
  });

  app.get('/auth/github/callback', async (req, res) => {
    const { code, state } = req.query as { code?: string; state?: string };

    if (!code || !state) {
      res.status(400).json({ error: 'Missing code or state' });
      return;
    }

    const pending = pendingStates.get(state);
    pendingStates.delete(state);

    if (!pending || pending.expiresAt < Date.now()) {
      res.status(400).json({ error: 'Invalid or expired state' });
      return;
    }

    try {
      const ghToken = await exchangeCode(code);
      const ghUser = await fetchUser(ghToken);

      const requiredOrg = process.env.GITHUB_ORG;
      if (requiredOrg) {
        const isMember = await checkOrgMembership(ghToken, requiredOrg);
        if (!isMember) {
          res.status(403).json({
            error: `Must be a member of the ${requiredOrg} GitHub organization`,
          });
          return;
        }
      }

      // Upsert user — first check by githubUsername to handle seed data
      // that may have a placeholder githubId
      const existing = await db.user.findUnique({
        where: { githubUsername: ghUser.login },
      });
      const user = existing
        ? await db.user.update({
            where: { id: existing.id },
            data: {
              githubId: ghUser.id,
              name: ghUser.name,
              avatarUrl: ghUser.avatar_url,
            },
          })
        : await db.user.upsert({
            where: { githubId: ghUser.id },
            create: {
              githubId: ghUser.id,
              githubUsername: ghUser.login,
              // Lowercase-canonical, URN-legal handle (#325); a GitHub login that
              // isn't URN-legal drops to null rather than blocking signup.
              handle: normalizeHandleOrNull(ghUser.login),
              identityProvider: 'GITHUB',
              name: ghUser.name,
              avatarUrl: ghUser.avatar_url,
              roles: ['READER'],
            },
            update: {
              githubUsername: ghUser.login,
              name: ghUser.name,
              avatarUrl: ghUser.avatar_url,
            },
          });

      // Provision personal workspace for new users
      let isNew = !(await hasPersonalWorkspace(db, user.id));
      if (isNew) {
        try {
          await provisionPersonalWorkspace(
            db,
            user.id,
            user.name ?? user.githubUsername ?? 'My Workspace',
          );
        } catch (err: any) {
          // P2002 = unique constraint violation — another concurrent request already provisioned
          if (err?.code === 'P2002') {
            isNew = false;
          } else {
            throw err;
          }
        }
      }

      // Issue JWT
      const jwt = await signJwt({
        sub: user.id,
        githubUsername: user.githubUsername ?? undefined,
        roles: user.roles as ('OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER')[],
        githubId: ghUser.id,
      });

      // Spec 025 FR-007 Option-C: when `returnTo` is set in the
      // pending state, the caller wants to remain on the server
      // domain (e.g., Phase 2's /oauth/authorize consent screen).
      // Set the JWT as an HttpOnly `hadron_token` cookie on the
      // server's own origin and redirect to the server-local path.
      // The predicate in /auth/github already validated returnTo.
      //
      // **Cookie maxAge is derived from the JWT's `exp` claim**
      // (rather than hardcoded to 7d) so cookie lifetime tracks
      // JWT_EXPIRY env var changes automatically. Both expire
      // together; the cookie's HttpOnly bit prevents a stale token
      // from being read after expiry by JavaScript anyway.
      //
      // **`path: '/'`** is a deliberately broad scope: hadron_token
      // is the universal session cookie. /mcp does NOT consume
      // cookies (resolveAuthContext reads Authorization headers
      // only; see src/middleware/auth.ts), so this doesn't bypass
      // the explicit Bearer-token requirement at the MCP boundary.
      //
      // **New-user handling differs from the standard flow**: the
      // standard flow redirects new users to /app/setup; Option-C
      // honors the caller's returnTo regardless of isNew, because
      // the OAuth flow (the only Option-C caller in v1) needs to
      // remain on the AS domain. Onboarding gating for new OAuth
      // users is a Phase 2 concern (the consent screen can check
      // user state and surface a setup hint inline).
      if (pending.returnTo) {
        const { exp } = decodeJwt(jwt);
        const maxAge = exp ? exp * 1000 - Date.now() : 7 * 24 * 60 * 60 * 1000;
        res.cookie('hadron_token', jwt, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge,
          path: '/',
        });
        res.redirect(pending.returnTo);
        return;
      }

      // #477 Sink 1: hand off via a single-use, short-TTL code instead of
      // putting the 30-day JWT in the redirect URL. The portal's server `load`
      // redeems it at POST /auth/session (server-to-server) and sets the cookie
      // itself. redirect + isNew ride in the code record, not the URL. The
      // GitHub-flow clientState binds the finishing browser (session fixation).
      const handoffCode = await issueLoginCode({
        userId: user.id,
        redirect: isNew ? '/app/setup' : pending.redirect,
        isNew,
        clientState: pending.clientState ?? null,
      });
      const frontendUrl =
        process.env.FRONTEND_URL || 'http://localhost:5173';
      const callbackUrl = new URL('/auth/callback', frontendUrl);
      callbackUrl.searchParams.set('code', handoffCode);
      res.redirect(callbackUrl.toString());
    } catch (err) {
      console.error('OAuth callback error:', err);
      res.status(500).json({ error: 'OAuth authentication failed' });
    }
  });

  // ---------------------------------------------------------------------------
  // Google OAuth (Sign-in-with-Google, #581) — near-verbatim sibling of the
  // GitHub pair above; see those handlers for the rationale comments. Own
  // pendingStates map so a state minted for one provider can never be replayed
  // against the other's callback, and so the GitHub machinery stays untouched.
  // ---------------------------------------------------------------------------

  const pendingGoogleStates = new Map<
    string,
    { redirect: string; returnTo?: string; clientState?: string; expiresAt: number }
  >();

  app.get('/auth/google', (req, res) => {
    // Fail loud and early when the deployment doesn't carry the Google OAuth
    // client — a 302 built with an undefined client_id would send the user to
    // a Google error page instead.
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      res.status(503).json({ error: 'Google login is not configured on this server' });
      return;
    }

    const redirect = (req.query.redirect as string) || '/';

    let returnTo: string | undefined;
    const candidate = req.query.return_to;
    if (candidate !== undefined) {
      if (!isServerLocalPath(candidate)) {
        res.status(400).json({
          error: 'Invalid return_to: must be a server-local path (starts with / and not //, no protocol, no backslash, no control bytes).',
        });
        return;
      }
      returnTo = candidate;
    }

    const now = Date.now();
    for (const [s, p] of pendingGoogleStates) {
      if (p.expiresAt < now) pendingGoogleStates.delete(s);
    }

    const clientStateRaw = req.query.client_state;
    const clientState = typeof clientStateRaw === 'string' && clientStateRaw !== ''
      ? clientStateRaw
      : undefined;

    // #477 session-fixation binding, mandatory on the portal-handoff path —
    // same contract as /auth/github (Codex #504 P2).
    if (!returnTo && !clientState) {
      res.status(400).json({
        error: 'client_state is required — start login via the portal (/auth/start/google), not the backend URL directly.',
      });
      return;
    }

    const state = crypto.randomBytes(16).toString('hex');
    pendingGoogleStates.set(state, {
      redirect,
      returnTo,
      clientState,
      expiresAt: now + 10 * 60 * 1000,
    });
    res.redirect(buildGoogleAuthUrl(state));
  });

  app.get('/auth/google/callback', async (req, res) => {
    const { code, state } = req.query as { code?: string; state?: string };

    if (!code || !state) {
      res.status(400).json({ error: 'Missing code or state' });
      return;
    }

    const pending = pendingGoogleStates.get(state);
    pendingGoogleStates.delete(state);

    if (!pending || pending.expiresAt < Date.now()) {
      res.status(400).json({ error: 'Invalid or expired state' });
      return;
    }

    try {
      // Identity comes from the VERIFIED ID-token claims (issuer, audience,
      // signature against Google's JWKS) — never a bare decode.
      const idToken = await exchangeGoogleCode(code);
      const identity = await verifyGoogleIdToken(idToken);

      // Match order per #581: by googleId → by verified email (link) → create.
      const user = await resolveGoogleUser(identity);

      // Provision personal workspace for new users — same block as the GitHub
      // callback, including the concurrent-provision P2002 tolerance.
      let isNew = !(await hasPersonalWorkspace(db, user.id));
      if (isNew) {
        try {
          await provisionPersonalWorkspace(
            db,
            user.id,
            user.name ?? user.email ?? 'My Workspace',
          );
        } catch (err: any) {
          if (err?.code === 'P2002') {
            isNew = false;
          } else {
            throw err;
          }
        }
      }

      // Same claim shape POST /auth/session rebuilds from the user row.
      const jwt = await signJwt({
        sub: user.id,
        roles: user.roles as ('OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER')[],
        ...(user.email ? { email: user.email } : {}),
      });

      // Spec 025 FR-007 Option-C — cookie maxAge derived from the JWT exp so
      // both expire together (see the GitHub callback for the full rationale).
      if (pending.returnTo) {
        const { exp } = decodeJwt(jwt);
        const maxAge = exp ? exp * 1000 - Date.now() : 7 * 24 * 60 * 60 * 1000;
        res.cookie('hadron_token', jwt, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge,
          path: '/',
        });
        res.redirect(pending.returnTo);
        return;
      }

      // #477 Sink 1: single-use handoff code; the JWT never rides a URL.
      const handoffCode = await issueLoginCode({
        userId: user.id,
        redirect: isNew ? '/app/setup' : pending.redirect,
        isNew,
        clientState: pending.clientState ?? null,
      });
      const frontendUrl =
        process.env.FRONTEND_URL || 'http://localhost:5173';
      const callbackUrl = new URL('/auth/callback', frontendUrl);
      callbackUrl.searchParams.set('code', handoffCode);
      res.redirect(callbackUrl.toString());
    } catch (err) {
      console.error('Google OAuth callback error:', err);
      res.status(500).json({ error: 'OAuth authentication failed' });
    }
  });

  // ---------------------------------------------------------------------------
  // OAuth 2.1 Authorization Server (spec 025 Phase 2)
  // ---------------------------------------------------------------------------

  // Phase 2A advertises the RFC 9728 PRM + RFC 8414 AS metadata
  // endpoints. /oauth/register, /oauth/authorize, /oauth/token land
  // in later sub-PRs (2B/2C/2D). The metadata endpoint MUST advertise
  // /oauth/register even before the handler exists — per EF-001,
  // Claude Desktop silently bails when registration_endpoint is
  // absent from AS metadata, so advertising it (even if the URL
  // 404s until 2B lands) is what unblocks the OAuth dance discovery.
  mountOAuthRoutes(app);

  // ---------------------------------------------------------------------------
  // Email magic-link auth
  // ---------------------------------------------------------------------------

  app.post('/auth/email', async (req, res) => {
    const { email, redirect, clientState, client_state } = req.body as {
      email?: string;
      redirect?: string;
      clientState?: string;
      client_state?: string;
    };
    if (!email || typeof email !== 'string') {
      res.status(400).json({ error: 'Email is required' });
      return;
    }
    // #505: require the portal's request-time browser nonce so every email
    // handoff code is bound (session-fixation defense). The portal supplies it
    // via /auth/start/email; a direct caller without it would otherwise mint an
    // unbound, transferable code that any browser could redeem. Accept either
    // casing so a direct caller following the error message can't trip on it.
    const effectiveClientState = clientState ?? client_state;
    if (!effectiveClientState || typeof effectiveClientState !== 'string') {
      res.status(400).json({
        error: 'client_state is required — request the sign-in link through the portal.',
      });
      return;
    }
    const clientStateHash = crypto.createHash('sha256').update(effectiveClientState).digest('hex');
    try {
      await sendMagicLink(email.trim(), db, redirect, clientStateHash);
      res.json({ ok: true });
    } catch (err) {
      console.error('Email auth error:', err);
      res.status(500).json({ error: 'Failed to send verification email' });
    }
  });

  app.get('/auth/email/verify', async (req, res) => {
    const { token, redirect: redirectParam } = req.query as { token?: string; redirect?: string };
    if (!token) {
      res.status(400).json({ error: 'Missing token' });
      return;
    }

    try {
      const result = await verifyMagicLink(token, db);
      if (!result) {
        res.status(400).json({ error: 'Invalid or expired token' });
        return;
      }
      // #505 (Codex #511 P2): a token minted before this deploy — or by any path
      // that skipped the clientState requirement — carries no binding hash.
      // Refuse it rather than mint an UNBOUND, transferable handoff code (which
      // would leave the email fixation gap open for still-valid legacy tokens).
      // Fail closed: the user re-requests and gets a bound link. verifyMagicLink
      // has already consumed the token, so there's nothing to clean up.
      if (!result.clientStateHash) {
        res.status(400).json({ error: 'Invalid or expired token' });
        return;
      }

      // Upsert user by email
      const user = await db.user.upsert({
        where: { email: result.email },
        create: {
          email: result.email,
          identityProvider: 'EMAIL',
          roles: ['READER'],
        },
        update: {},
      });

      // Provision personal workspace for new users
      const isNew = !(await hasPersonalWorkspace(db, user.id));
      if (isNew) {
        await provisionPersonalWorkspace(
          db,
          user.id,
          user.name ?? user.email ?? 'My Workspace',
        );
      }

      // #477 Sink 1: hand off via a single-use code, not the JWT-in-URL.
      // #505 session-fixation binding: the handoff code inherits the
      // clientStateHash stored on the token at request time (the SHA-256 of the
      // portal's browser nonce). At /auth/session the redeeming browser must
      // present the matching raw nonce from its cookie — so the browser that
      // REQUESTED the link is the only one that can complete sign-in. (This
      // makes email magic links same-browser-only by design; cross-device open
      // is intentionally no longer supported — the fixation defense requires it.)
      // Custom redirect (e.g., from invite link) takes priority, then setup for new users.
      const dest = redirectParam ? redirectParam : isNew ? '/app/setup' : '/';
      const code = await issueLoginCode({
        userId: user.id,
        redirect: dest,
        isNew,
        clientStateHash: result.clientStateHash,
      });
      const frontendUrl =
        process.env.FRONTEND_URL || 'http://localhost:5173';
      const callbackUrl = new URL('/auth/callback', frontendUrl);
      callbackUrl.searchParams.set('code', code);
      res.redirect(callbackUrl.toString());
    } catch (err) {
      console.error('Email verify error:', err);
      res.status(500).json({ error: 'Email verification failed' });
    }
  });

  // #477 Sink 1 — login handoff exchange. The portal's server `load` (NOT the
  // browser) POSTs the one-time code from /auth/callback?code=… here and gets
  // the session JWT back in the response body, which it seats as an HttpOnly
  // cookie on the portal origin. The JWT never rides in a browser-visible URL.
  // `clientState` (GitHub flow) is the raw browser nonce the portal read from
  // its HttpOnly cookie; the code's stored hash must match (session fixation).
  app.post('/auth/session', async (req, res) => {
    const body = (req.body ?? {}) as { code?: unknown; clientState?: unknown };
    const code = typeof body.code === 'string' ? body.code : '';
    const clientState = typeof body.clientState === 'string' ? body.clientState : undefined;
    if (!code) {
      res.status(400).json({ error: 'Missing code' });
      return;
    }

    const redeemed = await redeemLoginCode(code, clientState);
    if (!redeemed) {
      // Unknown / expired / already-redeemed / clientState mismatch all collapse
      // to one uninformative error (no probing signal).
      res.status(400).json({ error: 'Invalid or expired code' });
      return;
    }

    const user = await db.user.findUnique({ where: { id: redeemed.userId } });
    if (!user) {
      res.status(400).json({ error: 'Invalid or expired code' });
      return;
    }

    // Rebuild the same claim set the GitHub/email flows used to mint, from the
    // authoritative user row (roles may have changed since the code was issued).
    const jwt = await signJwt({
      sub: user.id,
      roles: user.roles as ('OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER')[],
      ...(user.githubUsername ? { githubUsername: user.githubUsername } : {}),
      ...(user.githubId != null ? { githubId: user.githubId } : {}),
      ...(user.email ? { email: user.email } : {}),
    });

    res.json({ token: jwt, redirect: redeemed.redirect, isNew: redeemed.isNew });
  });

  app.get('/auth/me', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'No token provided' });
      return;
    }
    try {
      const payload = await verifyJwt(authHeader.slice(7));
      const user = await db.user.findUnique({ where: { id: payload.sub } });
      if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      res.json({
        id: user.id,
        githubId: user.githubId,
        githubUsername: user.githubUsername,
        identityProvider: user.identityProvider,
        name: user.name,
        email: user.email,
        avatarUrl: user.avatarUrl,
        roles: user.roles,
      });
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  });

  // ---------------------------------------------------------------------------
  // Setup info (returns API key for first-time setup)
  // ---------------------------------------------------------------------------

  app.get('/setup/info', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'No token provided' });
      return;
    }
    try {
      const payload = await verifyJwt(authHeader.slice(7));
      const setup = await db.pendingSetup.findUnique({
        where: { userId: payload.sub },
      });
      if (!setup || setup.consumed) {
        res.json({ hasSetup: false });
        return;
      }

      // Find the personal org and bundle for context. deletedAt: null so a
      // (theoretically impossible) revoked personal-org membership doesn't
      // resolve a workspace its owner can no longer read.
      const membership = await db.orgMember.findFirst({
        where: { userId: payload.sub, deletedAt: null, organization: { isVisible: { not: true } } },
        include: {
          organization: {
            include: {
              agents: true,
              memories: true,
            },
          },
        },
      });

      // Mark as consumed — API key is shown only once
      await db.pendingSetup.update({
        where: { id: setup.id },
        data: { consumed: true },
      });

      res.json({
        hasSetup: true,
        apiKey: setup.rawKeyEncrypted, // TODO: decrypt when encryption is added
        // App-keyed identity for the new workspace. provisionPersonalWorkspace
        // is App-only since Phase 3a-1 of 003-station-to-app, so PendingSetup
        // rows always carry appId.
        appId: setup.appId,
        orgId: membership?.organization.id,
        orgName: membership?.organization.name,
        agentId: membership?.organization.agents[0]?.id,
        memories: membership?.organization.memories.map((g) => ({
          id: g.id,
          name: g.name,
        })) ?? [],
      });
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  });

  // ---------------------------------------------------------------------------
  // GraphQL
  // ---------------------------------------------------------------------------

  const apollo = new ApolloServer({
    typeDefs,
    resolvers,
    formatError: (formattedError, error) => {
      // Spec 022: surface UrnNotQualifiedError with a stable error code so
      // external callers can branch on it programmatically. The unwrap
      // pattern matches Apollo's: thrown errors are wrapped in
      // `GraphQLError` with the original on `.originalError`.
      const original =
        (error as { originalError?: unknown })?.originalError ?? error;
      if (original instanceof UrnNotQualifiedError) {
        return {
          ...formattedError,
          message: original.message,
          extensions: {
            ...formattedError.extensions,
            code: 'URN_NOT_QUALIFIED',
            offendingValue: original.offendingValue,
            expectedType: original.expectedType,
          },
        };
      }
      return formattedError;
    },
  });
  await apollo.start();

  // #499 — schema discovery for CLI / raw-`hadron api` agents. Apollo
  // introspection is disabled in production (its default), yet `hadron api
  // <raw GraphQL>` is the documented fallback for anything the curated CLI
  // commands don't cover — which is unusable without the schema. Serve the SDL
  // at a stable route for any AUTHENTICATED principal (an anonymous scraper
  // still can't enumerate the API). Registered BEFORE the '/graphql' Apollo
  // mount so this exact path wins over that catch-all `app.use`.
  let sdlCache: string | null = null;
  const graphqlSdl = (): string => {
    if (sdlCache == null) {
      try {
        // Round-trip through the type system → validated, canonical SDL.
        sdlCache = printSchema(buildSchema(typeDefs));
      } catch {
        // typeDefs is already valid SDL (Apollo parsed it above); if the
        // stricter buildSchema ever rejects it, serve the raw source rather
        // than 500 the discovery route.
        sdlCache = typeDefs;
      }
    }
    return sdlCache;
  };
  app.get('/graphql/schema', async (req, res, next) => {
    // Express 4 does not catch a rejected async handler, so an unexpected throw
    // (e.g. resolveAuthContext hitting a DB failure) would hang the request —
    // forward it to the error middleware instead.
    try {
      const auth = await resolveAuthContext(req, db);
      if (!auth.userId && !auth.appId) {
        res.status(401).json({ error: 'Authentication required to read the GraphQL schema.' });
        return;
      }
      res.type('text/plain; charset=utf-8').send(graphqlSdl());
    } catch (err) {
      next(err);
    }
  });

  app.use(
    '/graphql',
    // Spec 041: establish the request-scoped key store BEFORE Apollo so the
    // context builder and every resolver run inside it. Keys staged here are
    // invisible to concurrent requests and vanish with the request's async
    // context — aborted responses included (PR-514 review, Codex P1 ×2).
    (_req, _res, next) => requestKeyStorage.run(new Map(), next),
    expressMiddleware(apollo, {
      context: async ({ req }) => {
        const auth = await resolveAuthContext(req, db);
        // Stage caller-held unlock keys from the request header. Every
        // encrypt/decrypt call site consults sessionKeyCache.getByMemoryId,
        // which checks the request store first — this is the whole
        // stateless-unlock integration. A wrong key fails HERE (typed),
        // before any resolver.
        await stageRequestMemoryKeys(
          db,
          req.headers[REQUEST_KEYS_HEADER],
          (auth as { userId?: string | null }).userId,
        ).catch((err) => {
          if (err instanceof MemoryUnlockError) {
            throw new GraphQLError(err.message, { extensions: { code: err.code } });
          }
          throw err;
        });
        return { db, ...auth };
      },
    }),
  );

  // ---------------------------------------------------------------------------
  // REST endpoints
  // ---------------------------------------------------------------------------

  app.post('/usage', async (req, res) => {
    const result = await controller.operations.createUsageEvent(req.body);
    if (result.error) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ ok: true });
  });

  app.post('/sessions/:id/outcome', async (req, res) => {
    const { id } = req.params;
    const { outcome, outcomeRef, outcomeMeta } = req.body ?? {};
    if (typeof outcome !== 'number' || outcome < 0 || outcome > 1) {
      res
        .status(400)
        .json({ error: 'outcome must be a number between 0 and 1' });
      return;
    }
    try {
      await db.session.update({
        where: { id },
        data: {
          outcome,
          outcomeRef,
          outcomeMeta: serializeJson(outcomeMeta) as typeof outcomeMeta,
        },
      });
      res.json({ ok: true });
    } catch (err) {
      console.error('Outcome report error:', err);
      res.status(404).json({ error: 'Session not found' });
    }
  });

  app.post('/reload', async (_req, res) => {
    try {
      await controller.startup();
      res.json({ ok: true });
    } catch (err) {
      console.error('Reload error:', err);
      res.status(500).json({ error: 'Reload failed' });
    }
  });

  // ---------------------------------------------------------------------------
  // GitHub App webhook
  // ---------------------------------------------------------------------------

  app.post('/github/webhook', async (req, res) => {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (secret) {
      const sig = req.headers['x-hub-signature-256'] as string | undefined;
      if (!sig) {
        res.status(401).json({ error: 'Missing signature' });
        return;
      }
      const expected = `sha256=${crypto
        .createHmac('sha256', secret)
        .update(JSON.stringify(req.body))
        .digest('hex')}`;
      if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }
    }

    const event = req.headers['x-github-event'] as string | undefined;
    const { action, installation } = req.body ?? {};

    if (event === 'installation' && installation?.id) {
      const ghOrgLogin: string | undefined = installation.account?.login;
      if (ghOrgLogin) {
        if (action === 'created') {
          const updated = await db.organization.updateMany({
            where: { urn: ghOrgLogin, githubInstallationId: null },
            data: { githubInstallationId: installation.id },
          });
          if (updated.count > 0) {
            console.log(`[webhook] Linked GitHub App installation ${installation.id} → org "${ghOrgLogin}"`);
          } else {
            console.warn(`[webhook] No unlinked org found with urn "${ghOrgLogin}"`);
          }
        } else if (action === 'deleted') {
          await db.organization.updateMany({
            where: { githubInstallationId: installation.id },
            data: { githubInstallationId: null },
          });
          console.log(`[webhook] Unlinked GitHub App installation ${installation.id} (org "${ghOrgLogin}")`);
        }
      }
    }

    // Push to default branch → sync the matching memory
    if (event === 'push') {
      const { ref, repository } = req.body ?? {};
      const defaultBranch = repository?.default_branch ?? 'main';
      if (ref === `refs/heads/${defaultBranch}` && repository?.full_name) {
        const fullName = repository.full_name as string;
        // Match memories whose source URL contains the repo's full_name (e.g. "org/repo")
        const memories = await db.memory.findMany({
          where: {
            deletedAt: null,
            source: { not: null },
            OR: [
              { source: { contains: fullName } },
            ],
          },
          include: { organization: true },
        });
        for (const memory of memories) {
          // Skip if the memory tracks a specific branch that doesn't match
          if (memory.readBranch && ref !== `refs/heads/${memory.readBranch}`) continue;
          console.log(`[webhook] Push to ${fullName}/${defaultBranch} → syncing memory "${memory.name}"`);
          syncGraphFromGithub(memory).catch((err) => {
            console.error(`[webhook] Sync failed for memory "${memory.name}":`, err);
          });
        }
      }
    }

    res.json({ ok: true });
  });

  // ---------------------------------------------------------------------------
  // Microsoft OAuth (Exchange email integration — delegated permissions)
  // ---------------------------------------------------------------------------

  const pendingMsStates = new Map<
    string,
    { orgId: string; userId: string; redirect: string; expiresAt: number }
  >();

  // #477 Sink 2 — Exchange OAuth start. The portal calls this server-to-server
  // (Bearer-authed, NOT a browser redirect) and gets back a single-use, short-
  // TTL nonce. The 30-day JWT authenticates the initiating user HERE, over a
  // header on a server-to-server POST — it never rides in the /auth/microsoft
  // redirect URL (where it would land in access logs + browser history).
  app.post('/auth/microsoft/start', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'No token provided' });
      return;
    }
    let userId: string;
    let roles: ('OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER')[] | undefined;
    try {
      const payload = await verifyJwt(authHeader.slice(7));
      userId = payload.sub;
      roles = payload.roles;
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    const body = (req.body ?? {}) as { orgId?: unknown; redirect?: unknown };
    const orgId = typeof body.orgId === 'string' ? body.orgId : '';
    const redirect = typeof body.redirect === 'string' && body.redirect ? body.redirect : '/';
    if (!orgId) {
      res.status(400).json({ error: 'orgId is required' });
      return;
    }

    // #506: the Bearer JWT authenticates the caller but says nothing about
    // which org they may act on. Without this gate any authenticated user could
    // attach their own Microsoft mailbox to an ARBITRARY org (the nonce carries
    // orgId straight to /auth/microsoft/callback's ExchangeConnection upsert).
    // Require org ADMIN — the same role deleteExchangeConnection enforces.
    // requireOrgRole short-circuits for platform ADMIN/OWNER and rejects
    // revoked (soft-deleted) members.
    try {
      await requireOrgRole({ db, userId, roles }, orgId, 'ADMIN');
    } catch (err) {
      // Only the explicit authorization failure is a 403 — an unexpected fault
      // (DB outage, transient Prisma error) must surface as 500, not masquerade
      // as "not an admin" (PR-509 Copilot review).
      if (err instanceof Error && err.message === 'Forbidden') {
        res.status(403).json({ error: 'Forbidden: you must be an admin of this organization.' });
        return;
      }
      console.error('microsoft/start authorization error:', err);
      res.status(500).json({ error: 'Internal error' });
      return;
    }

    const nonce = await issueExchangeStartNonce({ userId, orgId, redirect });
    res.json({ nonce });
  });

  app.get('/auth/microsoft', async (req, res) => {
    // #477 Sink 2: the browser arrives with a single-use nonce (minted by
    // POST /auth/microsoft/start), not the session JWT. Look it up, discard it,
    // and proceed with the Microsoft OAuth round-trip.
    const nonce = req.query.nonce as string | undefined;
    if (!nonce) {
      res.status(400).json({ error: 'Missing nonce' });
      return;
    }
    const started = await redeemExchangeStartNonce(nonce);
    if (!started) {
      res.status(400).json({ error: 'Invalid or expired nonce' });
      return;
    }

    const state = crypto.randomBytes(16).toString('hex');
    pendingMsStates.set(state, {
      orgId: started.orgId,
      userId: started.userId,
      redirect: started.redirect,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    res.redirect(buildMicrosoftAuthUrl(state));
  });

  app.get('/auth/microsoft/callback', async (req, res) => {
    const { code, state, error: oauthError } = req.query as {
      code?: string;
      state?: string;
      error?: string;
    };

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

    if (oauthError) {
      const errorUrl = new URL('/app/dashboard', frontendUrl);
      errorUrl.searchParams.set('exchangeError', oauthError);
      res.redirect(errorUrl.toString());
      return;
    }

    if (!code || !state) {
      res.status(400).json({ error: 'Missing code or state' });
      return;
    }

    const pending = pendingMsStates.get(state);
    pendingMsStates.delete(state);

    if (!pending || pending.expiresAt < Date.now()) {
      res.status(400).json({ error: 'Invalid or expired state' });
      return;
    }

    // #506 defense-in-depth: /auth/microsoft/start already gated on org ADMIN,
    // but authority can narrow during the OAuth round-trip (the ~2-min nonce
    // window — e.g. the user's membership is revoked). Re-verify before writing
    // the connection. Roles aren't carried on this browser redirect, so fetch
    // them for requireOrgRole's platform-admin short-circuit.
    try {
      const initiator = await db.user.findUnique({
        where: { id: pending.userId },
        select: { roles: true },
      });
      // A deleted initiator (null) has no roles and no membership → requireOrgRole
      // rejects it. Cast the Prisma Role[] to the Context.roles union (they are
      // the same string set) for the platform-admin short-circuit.
      await requireOrgRole(
        {
          db,
          userId: pending.userId,
          roles: initiator?.roles as ('OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER')[] | undefined,
        },
        pending.orgId,
        'ADMIN',
      );
    } catch (err) {
      // Distinguish the authorization failure from an operational fault so a DB
      // outage doesn't masquerade as "not authorized" (PR-509 Copilot review).
      const forbidden = err instanceof Error && err.message === 'Forbidden';
      if (!forbidden) console.error('microsoft/callback re-check error:', err);
      const errorUrl = new URL('/app/dashboard', frontendUrl);
      errorUrl.searchParams.set('exchangeError', forbidden ? 'not_authorized' : 'server_error');
      res.redirect(errorUrl.toString());
      return;
    }

    // #396: core does NOT exchange the code — the provider tool holds the
    // client secret. Forward the code (with the SAME redirect URI the
    // authorize URL carried); the tool exchanges it, derives the mailbox
    // identity (ID-token claims first — personal accounts may fail Graph
    // /me — then the profile), stores the encrypted refresh token, and
    // returns the identity (shape-validated by emailClient). Core stores
    // only that identity.
    let identity: Awaited<ReturnType<typeof createToolConnection>> | undefined;
    try {
      identity = await createToolConnection('ms-exchange', {
        code,
        redirectUri: getMicrosoftRedirectUri(),
      });

      // Reconnecting an existing mailbox mints a NEW tool connection; tear
      // down the superseded one so it doesn't keep a live token +
      // subscriptions on the tool side. Fire-and-forget (never throws) —
      // the browser redirect must not wait on the tool.
      const existing = await db.exchangeConnection.findUnique({
        where: {
          organizationId_mailboxEmail: {
            organizationId: pending.orgId,
            mailboxEmail: identity.mailboxEmail,
          },
        },
        select: { toolConnectionId: true, provider: true },
      });
      if (existing?.toolConnectionId && existing.toolConnectionId !== identity.id) {
        void deleteToolConnection(existing.provider, existing.toolConnectionId);
      }

      await db.exchangeConnection.upsert({
        where: {
          organizationId_mailboxEmail: {
            organizationId: pending.orgId,
            mailboxEmail: identity.mailboxEmail,
          },
        },
        create: {
          organizationId: pending.orgId,
          userId: pending.userId,
          mailboxEmail: identity.mailboxEmail,
          displayName: identity.displayName,
          provider: identity.provider,
          toolConnectionId: identity.id,
          syncStatus: 'OK',
          lastSyncAt: new Date(),
          createdBy: pending.userId,
        },
        update: {
          displayName: identity.displayName,
          provider: identity.provider,
          toolConnectionId: identity.id,
          // Reconnect transfers OWNERSHIP: mail operations are owner-only,
          // and the initiator just proved control of the mailbox via OAuth
          // (and passed the #506 org-ADMIN gate). Without this, a reconnect
          // by a different user would strand the row on the old owner.
          userId: pending.userId,
          // A reconnect also REVIVES a previously-disconnected row —
          // otherwise the flow reports success while the row stays
          // soft-deleted and invisible.
          deletedAt: null,
          deletedBy: null,
          // The legacy core-held token (if any) is superseded by the tool's.
          refreshTokenEncrypted: null,
          syncStatus: 'OK',
          lastSyncAt: new Date(),
          lastError: null,
          updatedBy: pending.userId,
        },
      });

      // Subscribe the inbox to provider change notifications (the event
      // plane). Best-effort: until the tool's public webhook route +
      // WEBHOOK_BASE_URL are configured this fails, and the connection is
      // still fully usable for request/reply operations.
      subscribeToolFolder(identity.provider, identity.id, 'inbox').catch((err) => {
        console.log(
          `[microsoft-oauth] inbox subscription not created for ${identity!.mailboxEmail} (event plane off?): ${err instanceof Error ? err.message : err}`,
        );
      });

      console.log(`[microsoft-oauth] Connected Exchange for ${identity.mailboxEmail} → org ${pending.orgId} (tool connection ${identity.id})`);

      const successUrl = new URL(pending.redirect, frontendUrl);
      successUrl.searchParams.set('exchangeConnected', '1');
      res.redirect(successUrl.toString());
    } catch (err) {
      console.error('[microsoft-oauth] Callback error:', err);
      // If the tool already minted a connection but core failed to record it,
      // tear the orphan down — otherwise every failed attempt leaks a live
      // refresh token + auto-renewing subscriptions with no core record.
      if (identity) {
        void deleteToolConnection(identity.provider, identity.id);
      }
      const errorUrl = new URL(pending.redirect, frontendUrl);
      errorUrl.searchParams.set('exchangeError', err instanceof Error ? err.message : 'Microsoft authentication failed');
      res.redirect(errorUrl.toString());
    }
  });
  // ---------------------------------------------------------------------------
  // Email events ingress (tool → core, #396 Phase 4)
  // ---------------------------------------------------------------------------

  // Normalized email events (email.received / email.sent) arrive here from
  // the provider capability tools over internal HTTP. The legacy
  // /exchange/webhook POC route (Graph notifications straight into core) is
  // gone — Graph now notifies the tool, which normalizes and forwards.
  mountEmailEventRoutes(app);


  // ---------------------------------------------------------------------------
  // MCP endpoint (Streamable HTTP transport)
  // ---------------------------------------------------------------------------

  app.post('/mcp', async (req, res) => {
    await handleMcpRequest(req, res);
  });

  app.get('/mcp', async (req, res) => {
    await handleMcpRequest(req, res);
  });

  app.delete('/mcp', async (req, res) => {
    await handleMcpDelete(req, res);
  });

  // OAuth dynamic client registration is not supported. MCP/LLM SDKs that
  // probe RFC 7591's /register endpoint when they see a 401 from /mcp expect
  // a JSON error (RFC 6749 §5.2 shape) — Express's default HTML 404 makes
  // them blow up with "JSON Parse error: Unrecognized token '<'". Return a
  // valid OAuth-shaped JSON error instead so the SDK surfaces a useful
  // message, and tell the caller to use Bearer auth with an App Key.
  app.all('/register', (_req, res) => {
    res.status(404).json({
      error: 'unsupported_grant_type',
      error_description:
        'OAuth dynamic client registration is not supported. Authenticate to /mcp with an App Key via the Authorization: Bearer hdr_app_… header.',
    });
  });

  // Spec 040 §8 — webhook triggers (/hooks/<secret>/<name>?hpt=...).
  mountWebhookRoutes(app, db);

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Background job: purge expired anonymous memories hourly.
  // Skipped in test environments to avoid leaking timers.
  if (process.env.NODE_ENV !== 'test' && process.env.DISABLE_ANON_CLEANUP !== 'true') {
    startAnonymousMemoryCleanupLoop(db);
  }

  // 033 — embedding worker sweep (retries / restarts / backfill). Skipped in
  // tests (which drive embedNode/drainEmbeddingQueue directly). Warns if any
  // memory is vector-indexed but no embedding endpoint is configured.
  if (process.env.NODE_ENV !== 'test' && process.env.DISABLE_EMBED_WORKER !== 'true') {
    startEmbeddingWorkerLoop(db);
    // Same-process bus listener (spec 039): near-instant retries + backfill
    // drains via embed.wake.v1. No-op (null) when NATS_URL is unset — the
    // sweep loop above is the standalone fallback (D-2026-06-17-004).
    startEmbeddingBusListener(db).catch((err) => {
      // A subscribe/consumer failure (broker auth, incompatible durable)
      // must not become an unhandled rejection that can take boot down —
      // the sweep loop above keeps draining regardless (PR-489 review,
      // Codex P2 + Gemini).
      console.error('[embed-worker] failed to start bus listener (sweep continues):', err);
    });
    void db.memory
      .count({ where: { vectorIndexEnabled: true, deletedAt: null } })
      .then((n) => {
        if (n > 0 && !isEmbeddingConfigured()) {
          console.warn(
            `[embed-worker] ${n} memory(ies) have vectorIndexEnabled but EMBEDDING_API_URL is unset — ` +
              `nodes will queue (embeddingPendingAt) but not embed until an endpoint is configured.`,
          );
        }
      })
      .catch(() => {});
  }

  // Event pivot: the git mirror consumes evt.node.written.v1. Registers its
  // in-process fallback unconditionally (bus-off deployments keep mirroring)
  // and adds the durable bus subscription when a broker is up. Skipped in
  // tests, which drive handleNodeWrittenForGit directly.
  if (process.env.NODE_ENV !== 'test') {
    startGitMirrorSubscriber(db).catch((err) => {
      // Same boot posture as the embed listener: a subscribe failure must
      // not take boot down — the local fallback registered above the bus
      // attempt keeps mirroring.
      console.error('[git-mirror] failed to start bus subscriber (local fallback active):', err);
    });
  }

  // Spec 040 — headless runs: scheduler + run listener + sweep. The same
  // optional-bus posture: with NATS off the sweep executes runs directly.
  if (process.env.NODE_ENV !== 'test' && process.env.DISABLE_RUN_WORKER !== 'true') {
    const runDeps = makeProdRunDeps(db);
    startAppRunBusListener(db, runDeps).catch((err) => {
      console.error('[run-worker] failed to start bus listener (sweep continues):', err);
    });
    startAppRunSweepLoop(db, runDeps);
    if (process.env.DISABLE_SCHEDULER !== 'true') {
      startSchedulerLoop(db);
    }
  }

  // 039 Phase 1 — platform message bus (NATS JetStream). Optional by design
  // (D-2026-06-17-004): with NATS_URL unset getBusClient() resolves null and
  // features fall back to their DB-backed sweep loops — absence of a broker
  // never breaks boot or the API. Boot only establishes + logs the
  // connection; consumers are started by their features (the spec-039
  // webimport worker lands in Phase 4).
  if (process.env.NODE_ENV !== 'test' && process.env.NATS_URL) {
    void getBusClient().then((bus) => {
      if (bus) {
        console.log(`[bus] connected to NATS at ${process.env.NATS_URL}`);
      }
      // The unreachable-broker case already logged inside getBusClient().
    });
  }

  return app;
}
