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
} from './auth/index.js';
import { resolveAuthContext } from './middleware/auth.js';
import { initCloudflareIps } from './auth/cloudflare-ips.js';
import { isServerLocalPath } from './auth/server-local-path.js';
import { mountOAuthRoutes } from './auth/oauth.js';
import { resolvers } from './api/graphql/schema/resolvers.js';
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
import { startEmbeddingWorkerLoop } from './jobs/embedNodes.js';
import { isEmbeddingConfigured } from './lib/embedding/index.js';

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
    { redirect: string; returnTo?: string; expiresAt: number }
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

    const state = crypto.randomBytes(16).toString('hex');
    pendingStates.set(state, {
      redirect,
      returnTo,
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

      const frontendUrl =
        process.env.FRONTEND_URL || 'http://localhost:5173';
      const callbackUrl = new URL('/auth/callback', frontendUrl);
      callbackUrl.searchParams.set('token', jwt);
      // New users go to setup page instead of their intended redirect
      callbackUrl.searchParams.set('redirect', isNew ? '/app/setup' : pending.redirect);
      res.redirect(callbackUrl.toString());
    } catch (err) {
      console.error('OAuth callback error:', err);
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
    const { email, redirect } = req.body as {
      email?: string;
      redirect?: string;
    };
    if (!email || typeof email !== 'string') {
      res.status(400).json({ error: 'Email is required' });
      return;
    }
    try {
      await sendMagicLink(email.trim(), db, redirect);
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

      const jwt = await signJwt({
        sub: user.id,
        email: user.email ?? undefined,
        roles: user.roles as ('OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER')[],
      });

      const frontendUrl =
        process.env.FRONTEND_URL || 'http://localhost:5173';
      const callbackUrl = new URL('/auth/callback', frontendUrl);
      callbackUrl.searchParams.set('token', jwt);
      // Custom redirect (e.g., from invite link) takes priority, then setup for new users
      if (redirectParam) callbackUrl.searchParams.set('redirect', redirectParam);
      else if (isNew) callbackUrl.searchParams.set('redirect', '/app/setup');
      res.redirect(callbackUrl.toString());
    } catch (err) {
      console.error('Email verify error:', err);
      res.status(500).json({ error: 'Email verification failed' });
    }
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

      // Find the personal org and bundle for context
      const membership = await db.orgMember.findFirst({
        where: { userId: payload.sub, organization: { isVisible: { not: true } } },
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

  app.use(
    '/graphql',
    expressMiddleware(apollo, {
      context: async ({ req }) => {
        const auth = await resolveAuthContext(req, db);
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

  app.get('/auth/microsoft', async (req, res) => {
    // Token passed as query param (redirect-based flow, no Bearer header)
    const token = req.query.token as string | undefined;
    if (!token) {
      res.status(401).json({ error: 'No token provided' });
      return;
    }

    let userId: string;
    try {
      const payload = await verifyJwt(token);
      userId = payload.sub;
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    const orgId = req.query.orgId as string;
    const redirect = (req.query.redirect as string) || '/';
    if (!orgId) {
      res.status(400).json({ error: 'orgId is required' });
      return;
    }

    const state = crypto.randomBytes(16).toString('hex');
    pendingMsStates.set(state, {
      orgId,
      userId,
      redirect,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    const { buildMicrosoftAuthUrl } = await import('./integrations/exchange/exchange.js');
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

    try {
      const { exchangeMicrosoftCode, fetchMicrosoftProfile } = await import('./integrations/exchange/exchange.js');

      // Exchange code for tokens
      const tokenRes = await exchangeMicrosoftCode(code);

      // Fetch user's Microsoft profile to get their email
      const profile = await fetchMicrosoftProfile(tokenRes.access_token);
      const mailboxEmail = profile.mail || profile.userPrincipalName;

      // Encrypt and store the refresh token
      const { createCipheriv, randomBytes } = await import('crypto');
      const encKey = Buffer.from(process.env.HADRON_ENCRYPTION_KEY ?? '', 'hex');
      function encrypt(plaintext: string): string {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', encKey, iv);
        const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        return Buffer.concat([iv, tag, encrypted]).toString('base64');
      }

      // Upsert the exchange connection
      await db.exchangeConnection.upsert({
        where: {
          organizationId_mailboxEmail: {
            organizationId: pending.orgId,
            mailboxEmail,
          },
        },
        create: {
          organizationId: pending.orgId,
          userId: pending.userId,
          mailboxEmail,
          displayName: profile.displayName,
          refreshTokenEncrypted: encrypt(tokenRes.refresh_token),
          syncStatus: 'OK',
          lastSyncAt: new Date(),
          createdBy: pending.userId,
        },
        update: {
          refreshTokenEncrypted: encrypt(tokenRes.refresh_token),
          displayName: profile.displayName,
          syncStatus: 'OK',
          lastSyncAt: new Date(),
          lastError: null,
          updatedBy: pending.userId,
        },
      });

      console.log(`[microsoft-oauth] Connected Exchange for ${mailboxEmail} → org ${pending.orgId}`);

      const successUrl = new URL(pending.redirect, frontendUrl);
      successUrl.searchParams.set('exchangeConnected', '1');
      res.redirect(successUrl.toString());
    } catch (err) {
      console.error('[microsoft-oauth] Callback error:', err);
      const errorUrl = new URL(pending.redirect, frontendUrl);
      errorUrl.searchParams.set('exchangeError', err instanceof Error ? err.message : 'Microsoft authentication failed');
      res.redirect(errorUrl.toString());
    }
  });

  // ---------------------------------------------------------------------------
  // Exchange webhook (Microsoft Graph change notifications)
  // ---------------------------------------------------------------------------

  app.post('/exchange/webhook', async (req, res) => {
    // Step 1: Validation handshake — Graph sends a validationToken on subscription creation
    const validationToken = req.query.validationToken as string | undefined;
    if (validationToken) {
      res.set('Content-Type', 'text/plain');
      res.status(200).send(validationToken);
      return;
    }

    // Step 2: Process notifications — respond 202 quickly, process async
    res.status(202).json({ ok: true });

    const notifications = req.body?.value as Array<{
      clientState?: string;
      resourceData?: { id?: string };
      resource?: string;
    }> | undefined;

    if (!notifications?.length) return;

    for (const notification of notifications) {
      const connectionId = notification.clientState;
      if (!connectionId) continue;

      try {
        const connection = await db.exchangeConnection.findUnique({
          where: { id: connectionId },
        });
        if (!connection || connection.deletedAt || !connection.syncEnabled) continue;

        // Decrypt refresh token
        const { createDecipheriv } = await import('crypto');
        const keyBuf = Buffer.from(process.env.HADRON_ENCRYPTION_KEY ?? '', 'hex');
        function decrypt(ciphertext: string): string {
          const buf = Buffer.from(ciphertext, 'base64');
          const iv = buf.subarray(0, 12);
          const tag = buf.subarray(12, 28);
          const data = buf.subarray(28);
          const decipher = createDecipheriv('aes-256-gcm', keyBuf, iv);
          decipher.setAuthTag(tag);
          return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
        }

        const refreshToken = decrypt(connection.refreshTokenEncrypted);

        // Import exchange client functions
        const { getMessage, replyToMessage } = await import('./integrations/exchange/exchange.js');

        // Extract message ID from resource path (e.g. "Users/{id}/Messages/{messageId}")
        const resourceParts = notification.resource?.split('/') ?? [];
        const messageId = notification.resourceData?.id ?? resourceParts[resourceParts.length - 1];
        if (!messageId) continue;

        const msgResult = await getMessage(refreshToken, messageId);
        const message = msgResult.data;
        console.log(`[exchange-webhook] New email in ${connection.mailboxEmail}: "${message.subject}" from ${message.from?.emailAddress?.address}`);

        // POC auto-reply: if subject is "Hadron respond test", reply with "Hadron test passed"
        if (message.subject?.trim().toLowerCase() === 'hadron respond test') {
          await replyToMessage(refreshToken, messageId, 'Hadron test passed');
          console.log(`[exchange-webhook] Auto-replied to "${message.subject}" in ${connection.mailboxEmail}`);
        }
      } catch (err) {
        console.error(`[exchange-webhook] Error processing notification for connection ${connectionId}:`, err);
      }
    }
  });

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

  return app;
}
