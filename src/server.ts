import { deliveryPendingPlugin } from './api/graphql/deliveryPendingPlugin.js';
import { verifiedLoginEvidence } from './auth/loginEvidence.js';
import crypto from 'crypto';
import { mountTeamSpecSchemaRoutes } from './api/teamSpecSchema.js';
import { readTeamRecordKeys } from './lib/teamSpec/record.js';
import * as Sentry from '@sentry/node';
import { ApolloServer, type ApolloServerPlugin, type BaseContext } from '@apollo/server';
import { memoryPressurePlugin } from './api/graphql/memoryPressurePlugin.js';
import { expressMiddleware } from '@apollo/server/express4';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import express, { type Express } from 'express';
import { decodeJwt } from 'jose';
import { db } from './integrations/db/client.js';
import {
  buildAuthUrl,
  exchangeCode,
  fetchUser,
  checkOrgMembership,
  signJwt,
  verifyAuthenticatedJwt,
  sendMagicLink,
  verifyMagicLink,
  buildEmailSendPerIpRateLimit,
  buildEmailRecipientRateLimit,
  validateEmailSendRequest,
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  verifyGoogleIdToken,
  resolveGoogleUser,
  isAppleConfigured,
  buildAppleAuthUrl,
  exchangeAppleCode,
  verifyAppleIdToken,
  parseAppleUserField,
  resolveAppleUser,
} from './auth/index.js';
import { requireSignupBotCheck } from './auth/turnstile.js';
import { issueLoginCode, redeemLoginCode } from './auth/authHandoff.js';
import { startUserDeletionNoticeLoop } from './jobs/sendUserDeletionNotices.js';
import { startPasskeyRegistrationNoticeLoop } from './jobs/sendPasskeyRegistrationNotices.js';
import {
  createPendingLoginState,
  claimPendingLoginState,
  type ClaimResult,
  type ClaimedLoginState,
  type LoginProvider,
  type NewPendingLogin,
} from './auth/pendingLoginState.js';
import { mintProviderNonce, nonceExpectation, recordNonceRefusal } from './auth/providerNonce.js';
import { failLoginCallback, type LoginFailureReason } from './auth/login-error.template.js';
import { mountDevLoginRoutes } from './auth/devLogin.js';
import { mountPasskeyCeremonyRoutes } from './api/passkeyCeremonyRoutes.js';
import { beginPasskeySignIn, mountPasskeySignInRoutes } from './api/passkeySignInRoutes.js';
import { signingSurfacePolicy } from './lib/signing/surface.js';
import { completeCeremonyLeg, mountFreshSignInRoutes } from './api/freshSignInRoutes.js';
import { googleReauthenticatedSince } from './auth/google.js';
import {
  oauthSurfaceRefusal,
  oauthSurfaceRefusalMessage,
  hasCurrentPlatformAdminRole,
  resolveAuthContext,
} from './middleware/auth.js';
import { initCloudflareIps } from './auth/cloudflare-ips.js';
import { assertProductionSigningSecret } from './auth/signingSecret.js';
import { isServerLocalPath } from './auth/server-local-path.js';
import { mountOAuthRoutes } from './auth/oauth.js';
import { impersonationReadOnlyPlugin } from './api/graphql/impersonationReadOnlyPlugin.js';
import { taskWarningsPlugin } from './api/graphql/taskWarningsPlugin.js';
import { requireOrgRole } from './api/graphql/schema/resolvers.helpers.js';
import type { Context } from './api/graphql/schema/resolvers.js';
import { querySourceCap, readGraphqlAdmissionConfig } from './api/graphql/admission.js';
import { complexityAdmissionPlugin } from './api/graphql/admissionComplexity.js';
import { deploymentSchema } from './api/graphql/schema/deploymentSchema.js';
import {
  formatGraphQLError,
  isExpectedClientError,
} from './api/graphql/formatError.js';
import { safeEqual } from './lib/constantTime.js';
import { sourceNamesRepo } from './lib/gitSource.js';
import { provisionEmailUser, provisionGithubUser } from './auth/userProvision.js';
import { controller } from './controller/controller.js';
import { syncGraphFromGithub } from './integrations/github/syncGraphFromGithub.js';
import { assignRequestId, bindRequestId, REQUEST_ID_HEADER } from './lib/requestContext.js';
import { internalFaultErrorHandler, respondInternalFault } from './lib/internalFault.js';
import { handleMcpRequest, handleMcpDelete, startMcpTransportSweepLoop } from './mcp/server.js';
import { startAnonymousMemoryCleanupLoop } from './jobs/cleanupAnonymousMemories.js';
import { startMergeConsentSweepLoop } from './jobs/sweepMergeConsents.js';
import { startOauthClientGcLoop } from './jobs/gcOauthClients.js';
import { startAssetJanitorLoop } from './jobs/janitorAssets.js';
import { startAssetScanSweepLoop } from './jobs/scanPendingAssets.js';
import { startOrphanObjectReaperLoop } from './jobs/reapOrphanAssetObjects.js';
import { startAssetBytesSweepLoop } from './jobs/sweepAssetBytes.js';
import { startSessionKeySweepLoop } from './lib/sessionKeyCache.js';
import { startSessionReaperLoop } from './jobs/reapSessions.js';
import { startPendingEdgePromotionSweepLoop } from './jobs/promotePendingEdges.js';
import { startEmbeddingWorkerLoop, startEmbeddingBusListener, stopEmbeddingWorker, assertEmbeddingObligationsReconciled } from './jobs/embedNodes.js';
import { stopEmbeddingPublisher } from './services/embedding/enqueue.js';
import { startGitMirrorSubscriber } from './integrations/github/nodeWrittenSubscriber.js';
import { GraphQLError, buildSchema, printSchema } from 'graphql';
import {
  stageRequestMemoryKeys,
  MemoryUnlockError,
  REQUEST_KEYS_HEADER,
} from './lib/memoryUnlock.js';
import { requestKeyStorage } from './lib/requestKeys.js';
import { OPERATION_KEY_HEADER, requestOperationKeyStorage, stageRequestOperationKey } from './lib/requestOperationKey.js';
import { emptyActor, requestActorStorage } from './lib/requestActor.js';
import { isEmbeddingConfigured } from './lib/embedding/index.js';
import { getBusClient } from './lib/bus/index.js';
import { startAppRunBusListener, startAppRunSweepLoop } from './jobs/appRuns.js';
import { makeProdRunDeps } from './jobs/appRunDeps.js';
import { startSchedulerLoop } from './jobs/scheduler.js';
import { startTaskStallEvaluatorLoop } from './jobs/taskStallEvaluator.js';
import { startTaskMatcherLoop } from './jobs/taskMatcher.js';
import { mountWebhookRoutes } from './api/webhooks.js';
import { mountHealthRoutes } from './api/health.js';
import { mountCapabilitiesRoute } from './api/capabilities.js';
import { mountPublicAssetRoutes } from './api/assetPublic.js';
import { mountEmailEventRoutes } from './api/emailEvents.js';
import { mountSlackEventRoutes } from './api/slackEvents.js';
import { mountWebFetchEventRoutes } from './api/webfetchEvents.js';
import { buildMicrosoftAuthUrl, getMicrosoftRedirectUri } from './integrations/exchange/auth.js';
import { buildGmailAuthUrl, getGmailRedirectUri, isGmailConnectConfigured } from './integrations/gmail/auth.js';
import {
  buildGoogleCalAuthUrl,
  getGoogleCalRedirectUri,
  isGoogleCalConnectConfigured,
} from './integrations/googleCal/auth.js';
import {
  buildGoogleDriveAuthUrl,
  getGoogleDriveRedirectUri,
  isGoogleDriveConnectConfigured,
} from './integrations/googleDrive/auth.js';
import { mountMailboxConnectRoutes } from './integrations/mailboxConnect.js';
import { recordSessionOutcome } from './lib/sessionOutcome.js';
import { INDEXED_MEMORY_WHERE } from './lib/embedding/indexing.js';

/**
 * #557: named once, because the raw-body capture in the body parser and the
 * route that consumes it have to agree. Two string literals that must match,
 * mounted a thousand lines apart, is how a signature check quietly stops being
 * fed the bytes it verifies.
 */
const GITHUB_WEBHOOK_PATH = '/github/webhook';

// Report only unexpected GraphQL faults to Sentry — caller mistakes must not
// flood the issue stream.
//
// Timing gotcha: `didEncounterErrors` fires DURING execution, before
// `formatError` reshapes the response. So the typed client errors that
// `formatError` maps to stable codes (URN_NOT_QUALIFIED, BAD_USER_INPUT,
// AmbiguousLegacyUrnError, and the asset refusals) do NOT yet carry those
// codes here — Apollo has them as the default INTERNAL_SERVER_ERROR. We
// therefore classify the *original* error by TYPE, then fall back to the error
// code for Apollo's own client-error classes (validation, parse, …).
//
// BEING MAPPED IS NOT BEING SKIPPED (@copilot, PR #924). `isExpectedClientError`
// consults one shared list with `formatError` — so no second hand-kept
// `instanceof` chain lives here — but each entry declares `silenceInSentry`
// separately. The asset refusals are mapped for the wire and deliberately still
// REPORTED, because ASSET_BYTES_GONE is real server-state inconsistency and
// this is currently its only alarm (#1140). Do not read the list as "everything
// formatError touches is silent here"; read the flag.
const sentryApolloPlugin: ApolloServerPlugin<BaseContext> = {
  async requestDidStart() {
    return {
      async didEncounterErrors(ctx) {
        for (const err of ctx.errors) {
          const original = err.originalError ?? err;
          // Expected client errors reshaped by formatError — skip (they look
          // like INTERNAL_SERVER_ERROR at this stage).
          if (isExpectedClientError(original)) continue;
          // Apollo's own client-error codes (GRAPHQL_VALIDATION_FAILED,
          // GRAPHQL_PARSE_FAILED, BAD_USER_INPUT, …) are already on the raw
          // error and are never server faults.
          const code = err.extensions?.code as string | undefined;
          if (code && code !== 'INTERNAL_SERVER_ERROR') continue;
          Sentry.captureException(original, {
            tags: { graphql_operation: ctx.operationName ?? 'anonymous' },
          });
        }
      },
    };
  },
};

export async function createServer(): Promise<Express> {
  // #421: before anything else, so a weak signing secret never serves.
  assertProductionSigningSecret();
  // AM Q13: absent leaves team record operations unavailable; an invalid
  // configured keyring refuses boot without echoing secret values.
  readTeamRecordKeys();
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

  // #557: a production deploy with no webhook secret refuses deliveries (the
  // route answers 503), so say so at BOOT rather than letting the operator
  // discover it from GitHub's delivery log. This warns instead of refusing to
  // boot on purpose: webhooks are one feature, and taking the whole API down
  // over them would trade a known-narrow exposure for a total outage.
  if (process.env.NODE_ENV === 'production' && !process.env.GITHUB_WEBHOOK_SECRET) {
    console.warn(
      '[webhook] GITHUB_WEBHOOK_SECRET is not set — POST /github/webhook will refuse ' +
        'every delivery with 503. Register it in Doppler to enable GitHub App ' +
        'installation events and push-triggered memory syncs.',
    );
  }

  // #1925: before the global CORS middleware, which allows the portal's origin WITH credentials; this
  // unauthenticated read answers any origin without them. See src/api/capabilities.ts.
  mountCapabilitiesRoute(app);
  // #1789: the request id exists before anything that can fail, including body parsing and auth. After the capabilities
  // route on purpose: its answer is byte-identical and ETag-cached, and a per-request header would break both.
  app.use(assignRequestId);
  app.use(
    cors({
      origin: process.env.FRONTEND_URL || 'http://localhost:5173',
      credentials: true,
      // #1789: the portal reads the request id off a failed response to show it to the person.
      exposedHeaders: [REQUEST_ID_HEADER],
    }),
  );
  mountTeamSpecSchemaRoutes(app);
  // Default express.json cap is 100kb, which rejects large payloads such as
  // full-page HTML clips from the Web Clipper with 413. Raise it for
  // /graphql only — every other JSON endpoint (auth, webhooks, usage, ...)
  // keeps the default so oversized payloads can't tie up parsing there.
  const jsonParser = express.json();
  const jsonParserLarge = express.json({ limit: '25mb' });

  // #557: `/github/webhook` must HMAC the bytes GitHub actually signed, so it
  // gets its own parser that keeps the raw buffer as `req.rawBody`. Only that
  // route does — a global capture would pin a second copy of every request
  // body in memory until its response ended, to serve one endpoint.
  //
  // Mounted with `app.use(PATH, …)` so EXPRESS'S ROUTER decides what matches,
  // rather than a hand-rolled comparison that has to re-implement the same
  // rules. The first version of this compared `req.path === GITHUB_WEBHOOK_PATH`
  // and @codex caught it on PR #1237: Express's default non-strict routing
  // dispatches `/github/webhook/` to the handler while that equality is false,
  // so a correctly signed delivery to the trailing-slash URL would capture no
  // rawBody and be refused 400. Default routing is also case-INsensitive, so
  // `/GitHub/Webhook` had the same problem — two divergences from one string
  // compare, which is the argument for not writing the compare at all.
  //
  // This runs BEFORE the global parser below; body-parser sets `req._body`
  // once it has read the stream, so the global one then skips this route.
  app.use(
    GITHUB_WEBHOOK_PATH,
    express.json({
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
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

  // Spec 025-oauth-for-mcp FR-007: the pending login state carries the OAuth
  // state-CSRF token plus an optional `returnTo` (Option-C). When
  // `returnTo` is set, the callback writes a server-domain
  // `hadron_token` cookie and redirects to `returnTo` instead of
  // bouncing the JWT through the frontend.
  //
  // The state store is DB-backed (`src/auth/pendingLoginState.ts`,
  // `pending_login_states`) — the former per-provider in-process Maps lost
  // every in-flight login on deploy/restart (the callback then 400d), which
  // is the failure mode behind the Apple App Review login rejection. The
  // per-provider-Map replay isolation survives as the row's `provider`
  // column; single use is an atomic delete-by-PK claim.

  /**
   * Persist a freshly minted login state or answer a 500. Returns false when
   * the response has been written — Express 4 does not catch async throws,
   * so a DB hiccup on the start route must not hang the request.
   */
  const persistStateOrFail = async (
    res: express.Response,
    state: string,
    login: NewPendingLogin,
  ): Promise<boolean> => {
    const { provider } = login;
    try {
      await createPendingLoginState(state, login);
      return true;
    } catch (err) {
      Sentry.captureException(err);
      respondInternalFault(res, `auth/${provider}/start`, err);
      return false;
    }
  };

  /**
   * Single-use atomic claim of a callback's pending state. On any failure
   * (unknown / expired / another provider's state / store error) the
   * response has been written — the friendly HTML page, since these
   * endpoints are only ever hit by browsers — and null is returned.
   */
  const claimStateOrFail = async (
    res: express.Response,
    state: string,
    provider: LoginProvider,
  ): Promise<ClaimedLoginState | null> => {
    let claim: ClaimResult;
    try {
      claim = await claimPendingLoginState(state, provider);
    } catch (err) {
      Sentry.captureException(err);
      failLoginCallback(res, provider, 'state_claim_failed', { status: 500, err });
      return null;
    }
    if (!claim.ok) {
      failLoginCallback(res, provider, claim.reason);
      return null;
    }
    return claim.pending;
  };

  app.get('/auth/github', async (req, res) => {
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
    if (!(await persistStateOrFail(res, state, { provider: 'github', data: { redirect, returnTo, clientState } }))) {
      return;
    }
    res.redirect(buildAuthUrl(state));
  });

  app.get('/auth/github/callback', async (req, res) => {
    const { code, state } = req.query as { code?: string; state?: string };

    if (!code || !state) {
      failLoginCallback(res, 'github', 'state_missing');
      return;
    }

    const pending = await claimStateOrFail(res, state, 'github');
    if (!pending) return;

    // Diagnostics phase marker: which stage the try block is in, so the
    // catch can log a stable short reason code (never tokens, codes, or
    // emails) — App Review reports arrive with no client-side logs.
    let phase: LoginFailureReason = 'exchange_failed';
    try {
      // #627 / spec 048: `isNew` is derived from whether THIS callback created
      // the user row (`createdAt` on/after `startedAt`, captured before the
      // lookup). App and DB share a host clock, so the comparison is exact.
      const startedAt = Date.now();
      const ghToken = await exchangeCode(code);
      const ghUser = await fetchUser(ghToken);

      const requiredOrg = process.env.GITHUB_ORG;
      if (requiredOrg) {
        const isMember = await checkOrgMembership(ghToken, requiredOrg);
        if (!isMember) {
          console.error('[auth] github login callback failed: org_membership_denied');
          res.status(403).json({
            error: `Must be a member of the ${requiredOrg} GitHub organization`,
          });
          return;
        }
      }
      phase = 'internal_error';

      // #1631 PR1b: a passkey ceremony's sign-in leg. Look up by the GitHub id only: a username can be renamed
      // and re-registered by someone else, and the leg must never link or create (Ruth §10 condition 3).
      if (pending.ceremonyNonceHash) {
        await completeCeremonyLeg(req, res, {
          provider: 'github', ceremonyNonceHash: pending.ceremonyNonceHash,
          lookup: () => db.user.findFirst({ where: { githubId: ghUser.id, deletedAt: null }, select: { id: true } }),
        });
        return;
      }

      // Upsert user — first check by githubUsername to handle seed data
      // that may have a placeholder githubId
      const existing = await db.user.findUnique({
        where: { githubUsername: ghUser.login },
      });
      // Handle is NOT NULL (spec 047): a NEW GitHub user gets a legal,
      // currently-free handle seeded from the login then the display name.
      // Returning logins skip generation; the create path retries on a lost
      // handle race, mirroring the Google/Apple paths.
      const user = existing
        ? await db.user.update({
            where: { id: existing.id },
            data: {
              githubId: ghUser.id,
              name: ghUser.name,
              avatarUrl: ghUser.avatar_url,
            },
          })
        : await provisionGithubUser(db, ghUser);

      // #627 / spec 048: no workspace is provisioned at signup (the auto-personal
      // org is retired). `isNew` is now purely an onboarding hint for the portal.
      const isNew = user.createdAt.getTime() >= startedAt;

      // Issue JWT
      const login = await verifiedLoginEvidence(db, 'github');
      const jwt = await signJwt({
        login,
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
      // **Option-C honors the caller's returnTo regardless of isNew**,
      // because the OAuth flow (the only Option-C caller in v1) needs to
      // remain on the AS domain. Onboarding gating for new OAuth users is
      // a Phase 2 concern (the consent screen can check user state inline).
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
        login,
        userId: user.id,
        redirect: pending.redirect,
        isNew,
        clientState: pending.clientState ?? null,
      });
      const frontendUrl =
        process.env.FRONTEND_URL || 'http://localhost:5173';
      const callbackUrl = new URL('/auth/callback', frontendUrl);
      callbackUrl.searchParams.set('code', handoffCode);
      res.redirect(callbackUrl.toString());
    } catch (err) {
      Sentry.captureException(err);
      failLoginCallback(res, 'github', phase, { status: 500, err });
    }
  });

  // ---------------------------------------------------------------------------
  // Google OAuth (Sign-in-with-Google, #581) — near-verbatim sibling of the
  // GitHub pair above; see those handlers for the rationale comments. The
  // shared pending-login-state store keys rows by provider, so a state minted
  // for one provider can never be replayed against the other's callback.
  // ---------------------------------------------------------------------------

  app.get('/auth/google', async (req, res) => {
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
    // #2204: the OIDC nonce, independent of `state` and `client_state`; only its hash is stored.
    const { nonce, nonceHash } = mintProviderNonce();
    if (!(await persistStateOrFail(res, state, { provider: 'google', data: { redirect, returnTo, clientState, providerNonceHash: nonceHash } }))) {
      return;
    }
    res.redirect(buildGoogleAuthUrl(state, nonce));
  });

  app.get('/auth/google/callback', async (req, res) => {
    const { code, state } = req.query as { code?: string; state?: string };

    if (!code || !state) {
      failLoginCallback(res, 'google', 'state_missing');
      return;
    }

    const pending = await claimStateOrFail(res, state, 'google');
    if (!pending) return;

    // #2204: what the ID token's nonce must match. Null = a ceremony row with no nonce hash, refused before any
    // exchange (the legacy skip never reaches passkey step-up).
    const nonceExpected = nonceExpectation(pending);
    if (!nonceExpected) {
      recordNonceRefusal('google', 'ceremony_unbound');
      failLoginCallback(res, 'google', 'verify_failed');
      return;
    }

    // Diagnostics phase marker — see the GitHub callback.
    let phase: LoginFailureReason = 'exchange_failed';
    try {
      // #627 / spec 048: `isNew` derived from user-creation time (see the GitHub
      // callback). Captured before the lookup.
      const startedAt = Date.now();
      // Identity comes from the VERIFIED ID-token claims (issuer, audience,
      // signature against Google's JWKS) — never a bare decode.
      const idToken = await exchangeGoogleCode(code);
      phase = 'verify_failed';
      const identity = await verifyGoogleIdToken(idToken, nonceExpected);
      phase = 'internal_error';

      // #1631 PR1b: a passkey ceremony's sign-in leg. Google was asked to re-authenticate (max_age=0, R154), so an
      // auth_time older than this leg refuses. Lookup by the Google id only: no email link, no creation.
      if (pending.ceremonyNonceHash) {
        const reauthenticated = googleReauthenticatedSince(identity.authTime, pending.startedAt);
        await completeCeremonyLeg(req, res, {
          provider: 'google', ceremonyNonceHash: pending.ceremonyNonceHash,
          lookup: async () => reauthenticated
            ? db.user.findFirst({ where: { googleId: identity.sub, deletedAt: null }, select: { id: true } })
            : null,
        });
        return;
      }

      // Match order per #581: by googleId → by verified email (link) → create.
      const user = await resolveGoogleUser(identity);

      // #627 / spec 048: no workspace provisioned at signup; `isNew` is an
      // onboarding hint only.
      const isNew = user.createdAt.getTime() >= startedAt;

      // Same claim shape POST /auth/session rebuilds from the user row.
      const login = await verifiedLoginEvidence(db, 'google');
      const jwt = await signJwt({
        login,
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
        login,
        userId: user.id,
        redirect: pending.redirect,
        isNew,
        clientState: pending.clientState ?? null,
      });
      const frontendUrl =
        process.env.FRONTEND_URL || 'http://localhost:5173';
      const callbackUrl = new URL('/auth/callback', frontendUrl);
      callbackUrl.searchParams.set('code', handoffCode);
      res.redirect(callbackUrl.toString());
    } catch (err) {
      Sentry.captureException(err);
      failLoginCallback(res, 'google', phase, { status: 500, err });
    }
  });

  // ---------------------------------------------------------------------------
  // Apple OAuth (Sign in with Apple, #584) — sibling of the Google pair above;
  // see the GitHub handlers for the shared-machinery rationale. Apple-specific:
  // the callback is a POST (response_mode=form_post is forced by the `name
  // email` scopes) carrying code/state/user as urlencoded form fields, and the
  // user's name arrives in the `user` field on the FIRST authorization only.
  // The shared pending-login-state store keys rows by provider, so a state
  // minted for one provider can never be replayed against another's callback.
  // ---------------------------------------------------------------------------

  app.get('/auth/apple', async (req, res) => {
    // All four vars are required together (client id for the authorize URL,
    // team id + key id + private key for the token-call client secret) — a
    // half-configured deployment must fail loud here, not 500 mid-callback.
    if (!isAppleConfigured()) {
      res.status(503).json({ error: 'Apple login is not configured on this server' });
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

    const clientStateRaw = req.query.client_state;
    const clientState = typeof clientStateRaw === 'string' && clientStateRaw !== ''
      ? clientStateRaw
      : undefined;

    // #477 session-fixation binding, mandatory on the portal-handoff path —
    // same contract as /auth/github and /auth/google (Codex #504 P2).
    if (!returnTo && !clientState) {
      res.status(400).json({
        error: 'client_state is required — start login via the portal (/auth/start/apple), not the backend URL directly.',
      });
      return;
    }

    const state = crypto.randomBytes(16).toString('hex');
    // #2204: see the Google start route.
    const { nonce, nonceHash } = mintProviderNonce();
    if (!(await persistStateOrFail(res, state, { provider: 'apple', data: { redirect, returnTo, clientState, providerNonceHash: nonceHash } }))) {
      return;
    }
    res.redirect(buildAppleAuthUrl(state, nonce));
  });

  // POST, not GET: Apple form_posts the result cross-site. The state lives in
  // the server-side pending-login-state store (a DB row keyed by the body's
  // `state`), NOT in a cookie — which is load-bearing: SameSite=Lax cookies
  // are not sent on a cross-site POST, so a cookie-based state check here
  // would always fail. Don't "fix" this into cookies. The route-scoped
  // urlencoded parser is needed because the app only mounts JSON parsers
  // globally.
  app.post('/auth/apple/callback', express.urlencoded({ extended: false }), async (req, res) => {
    // typeof guards, not a cast: repeated form fields (`code=a&code=b`) parse
    // to arrays, which would slip past a bare truthiness check and 500 inside
    // the exchange. Non-string shapes collapse to the same 400 as absent
    // fields (mirrors POST /auth/session).
    const body = (req.body ?? {}) as Record<string, unknown>;
    const code = typeof body.code === 'string' ? body.code : '';
    const state = typeof body.state === 'string' ? body.state : '';
    const userField = body.user;

    if (!code || !state) {
      failLoginCallback(res, 'apple', 'state_missing');
      return;
    }

    const pending = await claimStateOrFail(res, state, 'apple');
    if (!pending) return;

    // #2204: what the ID token's nonce must match. Null = a ceremony row with no nonce hash, refused before any
    // exchange (the legacy skip never reaches passkey step-up).
    const nonceExpected = nonceExpectation(pending);
    if (!nonceExpected) {
      recordNonceRefusal('apple', 'ceremony_unbound');
      failLoginCallback(res, 'apple', 'verify_failed');
      return;
    }

    // Diagnostics phase marker — see the GitHub callback.
    let phase: LoginFailureReason = 'exchange_failed';
    try {
      // #627 / spec 048: `isNew` derived from user-creation time (see the GitHub
      // callback). Captured before the lookup.
      const startedAt = Date.now();
      // Identity comes from the VERIFIED ID-token claims (issuer, audience,
      // signature against Apple's JWKS) — never a bare decode.
      const idToken = await exchangeAppleCode(code);
      phase = 'verify_failed';
      const identity = await verifyAppleIdToken(idToken, nonceExpected);
      phase = 'internal_error';

      // #1631 PR1b: a passkey ceremony's sign-in leg. Lookup by the Apple id only: no email link, no creation.
      // Apple offers no re-authentication request, so a silent Apple session is accepted (R154 known limit).
      if (pending.ceremonyNonceHash) {
        await completeCeremonyLeg(req, res, {
          provider: 'apple', ceremonyNonceHash: pending.ceremonyNonceHash,
          lookup: () => db.user.findFirst({ where: { appleId: identity.sub, deletedAt: null }, select: { id: true } }),
        });
        return;
      }

      // First-authorization-only name capture; null on every later login.
      const name = parseAppleUserField(userField);

      // Match order per #584: by appleId → by verified email (link) → create.
      const user = await resolveAppleUser(identity, name);

      // #627 / spec 048: no workspace provisioned at signup; `isNew` is an
      // onboarding hint only.
      const isNew = user.createdAt.getTime() >= startedAt;

      // Same claim shape POST /auth/session rebuilds from the user row.
      const login = await verifiedLoginEvidence(db, 'apple');
      const jwt = await signJwt({
        login,
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
        login,
        userId: user.id,
        redirect: pending.redirect,
        isNew,
        clientState: pending.clientState ?? null,
      });
      const frontendUrl =
        process.env.FRONTEND_URL || 'http://localhost:5173';
      const callbackUrl = new URL('/auth/callback', frontendUrl);
      callbackUrl.searchParams.set('code', handoffCode);
      res.redirect(callbackUrl.toString());
    } catch (err) {
      Sentry.captureException(err);
      failLoginCallback(res, 'apple', phase, { status: 500, err });
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
  //
  // #560/#1239: build both email-send limiters ONCE and share their stores
  // across /auth/email and /oauth/authorize/email. Alternating routes must
  // neither double one recipient's cap nor give one IP two send budgets.
  const emailSendPerIpRateLimit = buildEmailSendPerIpRateLimit();
  const emailRecipientRateLimit = buildEmailRecipientRateLimit();
  mountOAuthRoutes(app, { emailSendPerIpRateLimit, emailRecipientRateLimit });

  // ---------------------------------------------------------------------------
  // Email magic-link auth
  // ---------------------------------------------------------------------------

  // #560: both brakes run BEFORE the handler, so a throttled request never
  // reaches Resend. Per-IP bounds one attacker; per-address bounds what one
  // victim's inbox receives, which per-IP cannot do — spreading a single
  // target across many source addresses is how an email bomb is actually sent.
  app.post(
    '/auth/email',
    // Validate FIRST: the limiters must only ever count requests that will
    // actually attempt a send. See validateEmailSendRequest for why this
    // ordering is the fix rather than a style choice.
    validateEmailSendRequest,
    emailSendPerIpRateLimit,
    // #2257: bot check after the no-send validation and before the recipient
    // limiter, so a refused request neither burns a token nor a victim's budget.
    requireSignupBotCheck,
    emailRecipientRateLimit,
    async (req, res) => {
      const { redirect } = req.body as { redirect?: string };

      // Already validated by `validateEmailSendRequest` above, which answered
      // 400 for anything unsendable BEFORE the limiters counted it. The handler
      // reads that result rather than re-deriving it: a second copy of the rule
      // here is exactly what drifted from the first (@codex, PR #1238), where a
      // whitespace-only `client_state` was skipped by both budgets and still
      // sent mail.
      //
      // #505: the nonce binds every handoff code to one browser
      // (session-fixation defense). The portal supplies it via
      // /auth/start/email; a direct caller without it would otherwise mint an
      // unbound, transferable code any browser could redeem.
      const { emailSend } = req as typeof req & { emailSend: { email: string; clientState: string } };
      const clientStateHash = crypto
        .createHash('sha256')
        .update(emailSend.clientState)
        .digest('hex');
      try {
        await sendMagicLink(emailSend.email, db, redirect, clientStateHash);
        res.json({ ok: true });
      } catch (err) {
        Sentry.captureException(err);
        respondInternalFault(res, 'auth/email', err);
      }
    },
  );

  // #1897 B1: read once, at mount, with the routes it pairs with (restart semantics are #1895's).
  const passkeySignInOn = signingSurfacePolicy().registration;

  app.get('/auth/email/verify', async (req, res) => {
    const { token, redirect: redirectParam, return_to: returnToRaw } = req.query as {
      token?: string;
      redirect?: string;
      return_to?: unknown;
    };
    if (!token) {
      res.status(400).json({ error: 'Missing token' });
      return;
    }

    // #804 Option-C: `return_to` rides in the emailed verify URL (appended by
    // sendMagicLink for links requested from the OAuth email-entry page).
    // Validate with the SAME strict server-local-path predicate as the
    // github/google/apple legs — and BEFORE consuming the single-use token, so
    // a tampered value 400s without burning a link the user could still use.
    let returnTo: string | undefined;
    if (returnToRaw !== undefined) {
      if (!isServerLocalPath(returnToRaw)) {
        res.status(400).json({
          error: 'Invalid return_to: must be a server-local path (starts with / and not //, no protocol, no backslash, no control bytes).',
        });
        return;
      }
      returnTo = returnToRaw;
    }

    try {
      // #627 / spec 048: `isNew` derived from user-creation time (see the GitHub
      // callback). Captured before the upsert.
      const startedAt = Date.now();
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
      //
      // #804 Option-C exemption: a token minted via /oauth/authorize/email
      // carries NO clientStateHash by design — the magic link opens out-of-band
      // (on iOS, the system browser OUTSIDE the app's auth session), so binding
      // to the requesting browser is impossible. The Option-C branch below
      // mints no handoff code (it sets the hadron_token cookie on THIS origin
      // and redirects to the validated server-local return_to), so there is
      // nothing to bind — the same exemption the github/google/apple Option-C
      // legs document. An unbound token WITHOUT a return_to still fails closed
      // here; a BOUND (portal) token always takes the handoff path below, so
      // appending return_to to a portal link cannot bypass the #505 binding.
      const isOptionC = !result.clientStateHash && returnTo !== undefined;
      if (!result.clientStateHash && !isOptionC) {
        res.status(400).json({ error: 'Invalid or expired token' });
        return;
      }

      // Upsert user by email (+ pool principal, #692; one retry on a lost email-unique race, #442).
      const user = await provisionEmailUser(db, result.email);

      // #627 / spec 048: no workspace provisioned at signup; `isNew` is an
      // onboarding hint only.
      const isNew = user.createdAt.getTime() >= startedAt;

      // #1897 slice B1 (cor:aut:030:02): with the registration switch on, a magic link alone signs nobody in.
      // The account exists as above (R82), but no handoff code, JWT, cookie or key is published until the
      // person's passkey completes the server-hosted step. The portal continuation carries the ORIGINAL
      // clientStateHash through unchanged. A user with no usable passkey gets the same fixed refusal as a bad
      // token: enrollment is B2, and signing in without the factor is never the fallback.
      if (passkeySignInOn) {
        const dest = redirectParam && isServerLocalPath(redirectParam) ? redirectParam : '/';
        const begun = await beginPasskeySignIn(req, res, {
          userId: user.id,
          continuation: isOptionC
            ? { kind: 'OAUTH', returnTo: returnTo! }
            : { kind: 'PORTAL', clientStateHash: result.clientStateHash, redirect: dest, isNew },
        });
        if (!begun) res.status(400).json({ error: 'Invalid or expired token' });
        return;
      }

      // #804 Option-C: same contract as the github/google/apple callbacks —
      // set the JWT as an HttpOnly `hadron_token` cookie on THIS server's
      // origin and 302 to the validated server-local return_to (the original
      // /oauth/authorize URL), which then renders consent and completes the
      // standard code+PKCE dance. Cookie maxAge derived from the JWT exp so
      // both expire together (see the GitHub callback for the full
      // rationale). Option-C honors return_to regardless of isNew.
      const login = await verifiedLoginEvidence(db, 'email');
      if (isOptionC) {
        const jwt = await signJwt({
          login,
          sub: user.id,
          roles: user.roles as ('OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER')[],
          ...(user.email ? { email: user.email } : {}),
        });
        const { exp } = decodeJwt(jwt);
        const maxAge = exp ? exp * 1000 - Date.now() : 7 * 24 * 60 * 60 * 1000;
        res.cookie('hadron_token', jwt, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge,
          path: '/',
        });
        res.redirect(returnTo!);
        return;
      }

      // #477 Sink 1: hand off via a single-use code, not the JWT-in-URL.
      // #505 session-fixation binding: the handoff code inherits the
      // clientStateHash stored on the token at request time (the SHA-256 of the
      // portal's browser nonce). At /auth/session the redeeming browser must
      // present the matching raw nonce from its cookie — so the browser that
      // REQUESTED the link is the only one that can complete sign-in. (This
      // makes email magic links same-browser-only by design; cross-device open
      // is intentionally no longer supported — the fixation defense requires it.)
      // Custom redirect (e.g., from invite link) takes priority; otherwise the
      // portal's default landing (it branches on `isNew` itself for onboarding).
      // `redirectParam` rides in the emailed verify URL, so validate it with the
      // strict server-local-path predicate before using it as the post-login
      // redirect — a tampered `&redirect=https://evil` must not become an open
      // redirect (PR #770 review, Copilot). Falls back to `/` when not local.
      const dest = redirectParam && isServerLocalPath(redirectParam) ? redirectParam : '/';
      const code = await issueLoginCode({
        login,
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
      Sentry.captureException(err);
      respondInternalFault(res, 'auth/email/verify', err);
    }
  });

  // #792 — dev-only login (triple-gated: DEV_LOGIN_ENABLED + non-production
  // NODE_ENV + localhost Host; otherwise indistinguishable from a 404).
  mountDevLoginRoutes(app, db);
  mountPasskeyCeremonyRoutes(app);
  mountPasskeySignInRoutes(app);
  mountFreshSignInRoutes(app, { emailSendPerIpRateLimit, emailRecipientRateLimit });

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
      login: redeemed.login,
      ...(redeemed.signInId ? { sid: redeemed.signInId } : {}),
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
      const payload = await verifyAuthenticatedJwt(authHeader.slice(7), db);
      // Admin impersonation: this endpoint bypasses resolveAuthContext (and so
      // the session-row re-validation), so an impersonation token is rejected
      // outright rather than echoing the target's profile.
      if (payload.imp) {
        res.status(401).json({ error: 'Impersonation tokens are not accepted here' });
        return;
      }
      // findFirst + deletedAt so a soft-deleted user's still-unexpired JWT
      // stops returning their profile here too. `resolveJwt` has had this
      // liveness check since #662 ("deleteUser must cut off ALL credentials
      // immediately"); this endpoint verifies the JWT directly and had been
      // missing it, so the two disagreed for up to a token lifetime.
      const user = await db.user.findFirst({ where: { id: payload.sub, deletedAt: null } });
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
  // GraphQL
  // ---------------------------------------------------------------------------

  const { typeDefs, resolvers: deploymentResolvers } = deploymentSchema();
  // hadron-internal#3 L1-L3: fleet-wide bounds on every client-supplied document,
  // read here so a malformed value refuses boot.
  const admission = readGraphqlAdmissionConfig();
  // The effective L4 configuration, on one line, so ops can confirm the mode a deploy actually booted with.
  console.log(JSON.stringify({
    event: 'graphql.admission.config', mode: admission.complexityMode, maxDepth: admission.maxDepth,
    maxCost: admission.maxCost, listFactor: admission.listFactor, maxQueryBytes: admission.maxQueryBytes,
    maxTokens: admission.maxTokens, maxSelections: admission.maxSelections,
  }));
  const apollo = new ApolloServer({
    // #2087: concealed errors must not depend on the deployment's NODE_ENV.
    includeStacktraceInErrorResponses: false,
    typeDefs,
    resolvers: deploymentResolvers,
    plugins: [sentryApolloPlugin, impersonationReadOnlyPlugin, taskWarningsPlugin, deliveryPendingPlugin, complexityAdmissionPlugin(admission), memoryPressurePlugin()],
    // #918 — typed client errors carry their stable `extensions.code`.
    // The mapping list lives beside the Sentry predicate that reads it.
    formatError: formatGraphQLError,
    // L2: graphql-js aborts the lexer at this many tokens (GRAPHQL_PARSE_FAILED, 400).
    parseOptions: { maxTokens: admission.maxTokens },
    // L3: Apollo's document-level rule, fragments expanded and memoized (GRAPHQL_VALIDATION_FAILED, 400).
    maxRecursiveSelections: admission.maxSelections,
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
      const surfaceRefusal = oauthSurfaceRefusal(auth, 'account');
      if (surfaceRefusal) {
        // #1303: the prose is unchanged; `code` + `reason` make it matchable.
        res.status(403).json({ error: oauthSurfaceRefusalMessage(surfaceRefusal, 'This OAuth credential is limited to the MCP surface.'), code: 'FORBIDDEN', ...surfaceRefusal });
        return;
      }
      res.type('text/plain; charset=utf-8').send(graphqlSdl());
    } catch (err) {
      next(err);
    }
  });

  app.use(
    '/graphql',
    // L1 (hadron-internal#3): the query source bound, before anything else runs.
    querySourceCap(admission.maxQueryBytes),
    // Spec 041: establish the request-scoped key store BEFORE Apollo so the
    // context builder and every resolver run inside it. Keys staged here are
    // invisible to concurrent requests and vanish with the request's async
    // context — aborted responses included (PR-514 review, Codex P1 ×2).
    bindRequestId,
    (_req, _res, next) => requestKeyStorage.run(new Map(), next),
    (_req, _res, next) => requestOperationKeyStorage.run({}, next),
    // #1610: the Worker / Agent behind this request's writes, filled by
    // resolveAuthContext from the validated session binding.
    (_req, _res, next) => requestActorStorage.run(emptyActor(), next),
    expressMiddleware(apollo, {
      context: async ({ req }) => {
        const auth = await resolveAuthContext(req, db);
        const surfaceRefusal = oauthSurfaceRefusal(auth, 'account');
        if (surfaceRefusal) {
          // #1303: `code` and prose unchanged; `reason` & co. are additive.
          // `http.status: 403` replaces Apollo's context-failure 500 for THIS
          // error only (no global mapping change). The CLI keys on the envelope,
          // not the status, so the move is safe (hadron-cli, team chat #1313).
          throw new GraphQLError(oauthSurfaceRefusalMessage(surfaceRefusal, 'This OAuth credential is limited to the MCP surface.'), {
            extensions: { code: 'FORBIDDEN', ...surfaceRefusal, http: { status: 403 } },
          });
        }
        stageRequestOperationKey(req.headers[OPERATION_KEY_HEADER], auth);
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

  // REMOVED (#825): `POST /usage`. It was UNAUTHENTICATED — the only global
  // middleware is CORS, JSON, cookies, and the /graphql key store — and
  // resolved a caller-supplied `nodeLoc` with no memory scope and no access
  // check, stamping the resolved node's memoryId onto the row. Since #796/#799
  // scope usage analytics on UsageEvent.memoryId, anyone who could reach the
  // server could write events into another org's dashboards by naming a
  // guessable loc (`preflight`, `instructions`, …).
  //
  // Deleted rather than authenticated: nothing called it — verified across
  // every sibling repo, portal and CLI included — and `Mutation.recordUsage`
  // already covers the capability on the authenticated GraphQL surface, with
  // the metering chokepoint (`recordLlmUsage`) covering token-bearing spend.
  // An unauthenticated write endpoint with no callers is pure attack surface.

  /**
   * #556 — `POST /sessions/:id/outcome` requires a credential.
   *
   * It was reachable with none, so possession of a session id was enough to
   * overwrite a session's `outcome`, `outcomeRef` and arbitrary `outcomeMeta`
   * — and ids travel in the `x-hadron-session` header, in logs and in client
   * state, which makes "knows the id" a weak boundary.
   *
   * ## This RESTORES the design rather than reversing it
   *
   * The 2026-02-21 usage-data design is often quoted as "Hadron doesn't care
   * who sends it", which reads as deliberately open. That sentence is a lossy
   * summary. The design document it summarizes specifies:
   *
   *     POST /sessions/:sessionId/outcome
   *     Authorization: Bearer <api-key>
   *
   *     "The server doesn't care who sent it — it just stamps the session. The
   *      API key is still required (it's the access control layer), but the
   *      role is only `contributor` or higher. Any machine client with a valid
   *      key can report outcomes for any session. That keeps edge devices and
   *      CRM webhooks on equal footing."
   *
   * So "doesn't care who" means WHICH AUTHENTICATED CLIENT, not "no
   * credential". Two decisions had been collapsed into one sentence, and the
   * credential half was never implemented — the route has had no auth since
   * its first commit (6c3cfd1, the same day as the design).
   *
   * ## What changed in #1647 (supersedes the "any session" reading above)
   *
   * The per-session ownership check #556 asked for now exists, on Holger's rulings (cor:dmo:070:05): an outcome is a
   * session WRITE, so it takes the shared `requireSessionWriteAccess` gate, and strict-owner binding (cor:acl:010:02)
   * binds platform admins too. The "third system holding only the id" case is served by a pure App key reporting on
   * its own App's user-less session; it no longer reaches sessions a person is behind.
   */
  app.post('/sessions/:id/outcome', async (req, res) => {
    const { id } = req.params;
    const { outcome, outcomeRef, outcomeMeta } = req.body ?? {};
    try {
      // #2896: the validation, the surface refusal, the credential check and the write gate are ONE function shared
      // with the GraphQL `recordSessionOutcome`; this route only maps each answer onto its status and body.
      // `resolveAuthContext` does DB lookups, and in Express 4 a rejection above the try is an unhandled rejection
      // rather than a response (the #555 class), so the whole call stays inside it.
      const result = await recordSessionOutcome(db, async () => ({ db, ...(await resolveAuthContext(req, db)) }) as Context, {
        sessionId: id,
        outcome,
        outcomeRef,
        outcomeMeta,
      });
      switch (result.kind) {
        case 'out_of_range':
          res.status(400).json({ error: 'outcome must be a number between 0 and 1' });
          return;
        case 'oauth_surface':
          // #1303: the prose is unchanged; `code` + `reason` make it matchable.
          res.status(403).json({ error: oauthSurfaceRefusalMessage(result.refusal, 'This OAuth credential is limited to the MCP surface.'), code: 'FORBIDDEN', ...result.refusal });
          return;
        case 'no_credential':
          res.status(401).json({ error: 'A credential is required' });
          return;
        case 'not_found':
          res.status(404).json({ error: 'Session not found' });
          return;
        case 'forbidden':
          // A refusal returns before any write: no outcome, metadata or liveness moves.
          res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
          return;
        case 'ok':
          res.json({ ok: true });
          return;
      }
    } catch (err) {
      // A database fault is a 500, never "Session not found": reporting a connection-pool blip as a missing session
      // would send the caller chasing a session id that is perfectly fine.
      Sentry.captureException(err);
      respondInternalFault(res, 'sessions/outcome', err);
    }
  });

  /**
   * #556 — a brake on `POST /reload`. Defined here rather than in a shared
   * limiter module because it guards exactly one route and nothing else, the
   * same way the OAuth limiters sit beside theirs.
   *
   * Counted regardless of outcome, unlike the email send limiters: a 403 flood
   * is exactly what probing for an admin token looks like, and it should cost
   * the prober something. Ten a minute is far above the documented use (a CI
   * job after a push) and far below a loop.
   *
   * IN-PROCESS STORE, so the budget is per worker rather than per deployment
   * (@copilot, PR #1250 — the same caveat the OAuth limiters carry). Today
   * that is a distinction without a difference: the container runs ONE node
   * process (`Dockerfile` CMD is a single `pnpm tsx src/index.ts`), so
   * per-worker and per-deployment are the same number. It stops being true
   * the moment anything runs this behind pm2 or more than one replica, and
   * this limiter guards a more expensive operation than the others — so if
   * that day comes, this is the one that needs a shared store first.
   */
  const reloadRateLimit = rateLimit({
    windowMs: 60_000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'rate_limit_exceeded' },
  });

  // #556: `POST /reload` re-runs `controller.startup()` — a full graph sync of
  // every memory with a source, against the DB and against GitHub. It was
  // reachable with NO credential, so anyone who could reach the server could
  // hold it in a startup loop: DB churn, connection and CPU exhaustion, and
  // outbound git traffic, all unauthenticated and all free.
  //
  // Now platform ADMIN/OWNER only. There is no global auth guard on this file
  // — `resolveAuthContext` is invoked by the GraphQL context builder, so every
  // REST route added here is unauthenticated BY DEFAULT rather than by
  // decision, which is the structural half of #556 and is not fixed by this
  // commit.
  //
  // Checked for callers before gating, across 49 sibling repos and every CI
  // workflow: none. The README and hadronmem-core describe it as a CI
  // trigger ("called by CI after a push"), so it is documented surface rather
  // than dead code — which is why this authenticates rather than deleting it
  // the way #825 deleted `POST /usage`. A CI job can carry a token; an
  // anonymous internet cannot.
  app.post('/reload', reloadRateLimit, async (req, res) => {
    // Authentication runs INSIDE the try (@codex, PR #1250). `resolveAuthContext`
    // does DB lookups on the App-key and user-API-key paths, so a pool blip
    // rejects this await — and in Express 4 an async handler's rejection is not
    // forwarded to error middleware, which leaves the request hanging and
    // raises an unhandled rejection. That is the #555 class of defect, fixed
    // this week, reintroduced by putting an await above the try.
    try {
      const auth = await resolveAuthContext(req, db);
      const surfaceRefusal = oauthSurfaceRefusal(auth, 'account');
      if (surfaceRefusal) {
        // #1303: the prose is unchanged; `code` + `reason` make it matchable.
        res.status(403).json({ error: oauthSurfaceRefusalMessage(surfaceRefusal, 'This OAuth credential is limited to the MCP surface.'), code: 'FORBIDDEN', ...surfaceRefusal });
        return;
      }

      // Roles come from the CURRENT user row, not from a token or transport
      // snapshot (@copilot, PR #1250; #1251). Re-reading costs one indexed
      // lookup on a route that is about to do far more than that.
      //
      // An IMPERSONATION session is refused outright rather than having its
      // roles checked: it carries the TARGET user's identity with `roles: []`,
      // and an admin acting as someone else should not be re-sync'ing the
      // fleet through that seat.
      const isPlatformAdmin = await hasCurrentPlatformAdminRole(db, auth);

      if (!isPlatformAdmin) {
        // 404 rather than 403 for an ANONYMOUS caller would hide the route,
        // but it is documented in the README, so hiding it buys nothing and
        // costs a confusing error for the operator meant to use it.
        res.status(403).json({ error: 'Platform admin required' });
        return;
      }

      // #556: single-flight lives on the OPERATION (controller/startup.ts),
      // not here. A guard in this handler covered reloads and nothing else,
      // while `src/index.ts` calls `startup()` directly at boot — so a CI
      // trigger arriving during the initial sync, which is the likeliest
      // moment for one, started a second sync over the same checkouts
      // (@codex, PR #1250).
      //
      // 409 rather than joining the running sync: a CI job calling this after
      // a push wants ITS commit synced, and a sync that began before that push
      // does not include it. A coalesced 200 would report "done" about work
      // that never saw the caller's change.
      const outcome = await controller.startup();
      if (outcome === 'skipped') {
        res.status(409).json({ error: 'A sync is already running' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      Sentry.captureException(err);
      respondInternalFault(res, 'reload', err);
    }
  });

  // ---------------------------------------------------------------------------
  // GitHub App webhook
  // ---------------------------------------------------------------------------

  /**
   * Log REFUSED webhook deliveries, throttled per reason.
   *
   * Two opposing failure modes, and the first version only avoided one of
   * them. Silence was the original problem: a 401 storm, or the fail-closed
   * 503 after a deploy whose secret never reached the running process, emitted
   * nothing at all, and "no errors in the logs" was not evidence because there
   * were no lines to be absent.
   *
   * But this endpoint is UNAUTHENTICATED, so logging every refusal hands an
   * attacker an amplifier (@copilot, PR #1236): a sustained flood fills log
   * storage, costs ingestion money, and buries the real failure among a
   * million copies of itself. An unbounded log on an unauthenticated path is
   * itself a denial-of-service vector.
   *
   * So: FIRST refusal of each reason logs immediately, then that reason goes
   * quiet for a window and the next line reports how many were suppressed. One
   * attacker hammering `Invalid signature` therefore costs one line a minute
   * AND cannot hide a different reason appearing — a flood that silenced the
   * 503 you needed to see would reintroduce the original bug by other means.
   *
   * The reason set is a fixed internal vocabulary, never caller input, so this
   * map cannot grow without bound.
   */
  const refusalLogState = new Map<string, { windowStart: number; suppressed: number }>();

  /**
   * Throttle window, read per call so a test can drive both sides of the
   * behaviour against one booted server: 0 makes every refusal log (which is
   * what the per-reason cases assert), the default throttles.
   * `WEBHOOK_REFUSAL_LOG_WINDOW_MS` is not expected to be set in a deployment.
   */
  const refusalLogWindowMs = (): number => {
    const raw = process.env.WEBHOOK_REFUSAL_LOG_WINDOW_MS;
    if (raw === undefined || raw.trim() === '') return 60_000;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 60_000;
  };

  /**
   * `x-github-event` and `x-github-delivery` are attacker-controlled on an
   * unauthenticated route, so they are bounded and stripped to a conservative
   * charset before reaching a log line. Node already rejects CR/LF in header
   * values, so this is about length and legibility rather than log injection —
   * but a 64KB header echoed into an aggregator is its own amplifier.
   */
  const safeHeader = (value: unknown): string => {
    if (typeof value !== 'string' || value.length === 0) return 'unknown';
    const cleaned = value.slice(0, 64).replace(/[^A-Za-z0-9._-]/g, '?');
    return cleaned.length === 0 ? 'unknown' : cleaned;
  };

  const refuseWebhook = (
    req: express.Request,
    res: express.Response,
    status: number,
    reason: string,
  ) => {
    const now = Date.now();
    const state = refusalLogState.get(reason) ?? { windowStart: 0, suppressed: 0 };

    const windowMs = refusalLogWindowMs();
    if (now - state.windowStart >= windowMs) {
      const suppressed = state.suppressed;
      refusalLogState.set(reason, { windowStart: now, suppressed: 0 });
      const event = safeHeader(req.headers['x-github-event']);
      const delivery = safeHeader(req.headers['x-github-delivery']);
      console.warn(
        `[webhook] REFUSED ${status} — ${reason} (event=${event} delivery=${delivery}). ` +
          'No payload was processed.' +
          (suppressed > 0
            ? ` ${suppressed} further "${reason}" refusal(s) were suppressed in the previous ` +
              `${windowMs / 1000}s.`
            : ''),
      );
    } else {
      state.suppressed += 1;
      refusalLogState.set(reason, state);
    }

    res.status(status).json({ error: reason });
  };

  app.post(GITHUB_WEBHOOK_PATH, async (req, res) => {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) {
      // #557, first half: verification used to be simply SKIPPED when the
      // secret was unset, which left the route below reachable unauthenticated
      // — forged `installation` events relink a GitHub App installation
      // (`organization.updateMany`) and forged `push` events trigger
      // `syncGraphFromGithub`. Outside production that stays permitted, because
      // it is how the route is exercised locally; in production it now fails
      // CLOSED. The boot warning above fires at the same time, so a
      // misconfigured deploy is loud before the first delivery rather than
      // after it.
      if (process.env.NODE_ENV === 'production') {
        refuseWebhook(req, res, 503, 'Webhook signature verification is not configured');
        return;
      }
    } else {
      const sig = req.headers['x-hub-signature-256'] as string | undefined;
      if (!sig) {
        refuseWebhook(req, res, 401, 'Missing signature');
        return;
      }
      // #557, second half: HMAC the bytes GitHub signed, not a re-serialization
      // of the parsed body. `JSON.stringify(req.body)` does not round-trip:
      // `\/` escapes are dropped, integer-like keys reorder to the front,
      // integers beyond 2^53 lose precision and `1.0` becomes `1`. Whether a
      // given delivery survived that depended on its CONTENT, which is worse
      // than failing always — an intermittent signature failure reads as a
      // flaky webhook and pressures an operator into unsetting the secret,
      // straight into the unauthenticated path above.
      //
      // `rawBody` is captured by the express.json `verify` hook for this path.
      // Its absence means the body never went through that parser, so there is
      // nothing trustworthy to compare and the delivery is refused rather than
      // silently falling back to the re-serialized form.
      const rawBody = (req as express.Request & { rawBody?: Buffer }).rawBody;
      if (!rawBody) {
        refuseWebhook(req, res, 400, 'Missing request body');
        return;
      }
      const expected = `sha256=${crypto
        .createHmac('sha256', secret)
        .update(rawBody)
        .digest('hex')}`;
      // #555: compare through `safeEqual`, which length-checks BEFORE calling
      // `timingSafeEqual`. The bare call this replaces threw a RangeError on any
      // header whose length differed from the expected 71 bytes — and since this
      // handler is `async` and Express 4 does not forward async rejections to
      // error middleware, that throw became an unhandled rejection and
      // TERMINATED THE PROCESS. One unauthenticated `curl` was a full DoS.
      //
      // `safeEqual` is the shared helper in lib/constantTime.ts, whose own
      // docstring already named this line as one of the private copies to
      // consolidate. Reusing it is the point: a hardening change must not fork
      // four ways.
      if (!safeEqual(sig, expected)) {
        refuseWebhook(req, res, 401, 'Invalid signature');
        return;
      }
    }

    const event = req.headers['x-github-event'] as string | undefined;
    const { action, installation } = req.body ?? {};

    if (event === 'installation' && installation?.id) {
      const ghOrgLogin: string | undefined = installation.account?.login;
      if (ghOrgLogin) {
        if (action === 'created') {
          // urn-alias-exempt: `urn` here is a WHERE selector, not a write — the
          // data payload sets only githubInstallationId, so no URN moves and
          // there is nothing to alias. Flagged because the checker matches
          // `urn:` anywhere in the call rather than parsing out the data block,
          // which over-flags on purpose: a stray waiver costs one line, a missed
          // rename costs a published URN.
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
        // #1145: `contains` is a cheap NARROWING, not an identity match. Prisma
        // compiles it to LIKE '%…%', and `_` and `%` are legal in a GitHub repo
        // name — `_` being a single-character wildcard, so a push to
        // `acme/my_repo` also selected a memory whose source was
        // `acme/myXrepo`: another tenant's repo, synced on our say-so, with no
        // ownership predicate anywhere beside it. The exact filter below
        // decides which rows are actually ours.
        const candidates = await db.memory.findMany({
          where: {
            deletedAt: null,
            source: { not: null },
            OR: [
              // Insensitive to match `sourceNamesRepo` below — a
              // case-sensitive LIKE in front of a case-insensitive comparison
              // drops the rows it exists to find (@copilot, PR #1247).
              { source: { contains: fullName, mode: 'insensitive' } },
            ],
          },
          include: { organization: true },
        });
        const memories = candidates.filter((m) => sourceNamesRepo(m.source, fullName));
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
  // Mailbox-connect OAuth (email capability tools — delegated permissions)
  // ---------------------------------------------------------------------------

  // One shared trio per provider (src/integrations/mailboxConnect.ts): the
  // #477 start-nonce handoff, the authorize redirect, and the callback that
  // forwards {code, redirectUri} to the provider tool. Microsoft = Exchange
  // (hadrontool-ms-exchange); Gmail = hadrontool-gmail (#580) — NOT
  // /auth/google, which is Sign-in-with-Google (#581).
  mountMailboxConnectRoutes(app, {
    provider: 'ms-exchange',
    routeName: 'microsoft',
    buildAuthUrl: buildMicrosoftAuthUrl,
    getRedirectUri: getMicrosoftRedirectUri,
    logPrefix: 'microsoft-oauth',
    // Fails safe (503) when unset — previously buildMicrosoftAuthUrl threw
    // inside the redirect handler AFTER burning the nonce.
    isConfigured: () => Boolean(process.env.MICROSOFT_CLIENT_ID),
  });
  mountMailboxConnectRoutes(app, {
    provider: 'gmail',
    routeName: 'gmail',
    buildAuthUrl: buildGmailAuthUrl,
    getRedirectUri: getGmailRedirectUri,
    logPrefix: 'gmail-oauth',
    // Fails safe until the mailbox GCP project's client is provisioned —
    // same posture as Google login (#583).
    isConfigured: isGmailConnectConfigured,
  });
  // Google Calendar = hadrontool-google-cal — a CALENDAR connection on the
  // same rails (ExchangeConnection row, provider 'google-cal'). Separate
  // OAuth client from both Google login and the Gmail mailbox client
  // (sensitive vs restricted scope verification — see googleCal/auth.ts).
  mountMailboxConnectRoutes(app, {
    provider: 'google-cal',
    routeName: 'google-cal',
    buildAuthUrl: buildGoogleCalAuthUrl,
    getRedirectUri: getGoogleCalRedirectUri,
    logPrefix: 'google-cal-oauth',
    isConfigured: isGoogleCalConnectConfigured,
    // The calendar tool has no folder-subscription surface (no event plane
    // in v1) — don't POST a doomed inbox subscription on every connect.
    subscribeInbox: false,
  });
  // Google Drive = hadrontool-google-drive — a DRIVE connection on the same
  // rails (ExchangeConnection row, provider 'google-drive'). Its own OAuth
  // client again: drive.readonly is a RESTRICTED scope (Gmail-tier CASA,
  // #750) and must not touch the login/gmail/calendar clients — see
  // googleDrive/auth.ts.
  mountMailboxConnectRoutes(app, {
    provider: 'google-drive',
    routeName: 'google-drive',
    buildAuthUrl: buildGoogleDriveAuthUrl,
    getRedirectUri: getGoogleDriveRedirectUri,
    logPrefix: 'google-drive-oauth',
    isConfigured: isGoogleDriveConnectConfigured,
    // No folder-subscription surface (no event plane in v1).
    subscribeInbox: false,
  });

  // ---------------------------------------------------------------------------
  // Email events ingress (tool → core, #396 Phase 4)
  // ---------------------------------------------------------------------------

  // Normalized email events (email.received / email.sent) arrive here from
  // the provider capability tools over internal HTTP. The legacy
  // /exchange/webhook POC route (Graph notifications straight into core) is
  // gone — Graph now notifies the tool, which normalizes and forwards.
  mountEmailEventRoutes(app);

  // Normalized Slack events (slack.command / slack.interaction /
  // slack.message.received / slack.gap) arrive here from hadrontool-slack
  // (spec 043 Phase 2) — same CORE_EVENTS_TOKEN contract; dispatch dedupes
  // on (connectionId, envelopeId) because the tool's inbox is at-least-once.
  mountSlackEventRoutes(app);

  // Durable webfetch poll events (poll.triggered / expired / failed) arrive
  // from hadrontool-webfetch. The core validates the origin-run binding,
  // dedupes, frames external excerpts, and mints an INTEGRATION AppRun before
  // acknowledging the sidecar's at-least-once delivery.
  mountWebFetchEventRoutes(app);


  // ---------------------------------------------------------------------------
  // MCP endpoint (Streamable HTTP transport)
  // ---------------------------------------------------------------------------

  // #1610: each MCP request gets its own actor holder (see requestActor.ts).
  app.post('/mcp', bindRequestId, async (req, res) => {
    await requestActorStorage.run(emptyActor(), () => handleMcpRequest(req, res));
  });

  app.get('/mcp', bindRequestId, async (req, res) => {
    await requestActorStorage.run(emptyActor(), () => handleMcpRequest(req, res));
  });

  app.delete('/mcp', bindRequestId, async (req, res) => {
    await requestActorStorage.run(emptyActor(), () => handleMcpDelete(req, res));
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

  // Unauthenticated asset hotlinks (GET /assets/:id). Deliberately
  // public and deliberately temporary — see the header of
  // src/api/assetPublic.ts before touching or extending it.
  mountPublicAssetRoutes(app, db);

  // #1906: /health runs SELECT 1 through this pool, so a wedged pool reads
  // unhealthy. See src/api/health.ts.
  mountHealthRoutes(app, db);

  // Background job: purge expired anonymous memories hourly.
  // Skipped in test environments to avoid leaking timers.
  if (process.env.NODE_ENV !== 'test' && process.env.DISABLE_ANON_CLEANUP !== 'true') {
    startAnonymousMemoryCleanupLoop(db);
  }

  // #1770 — retention for account-merge consent requests: a retired request
  // is deleted 30 days after the later of its expiry and consumption
  // (cor:api:010:02), in bounded batches. Live proofs and sealed receipts stay.
  if (process.env.NODE_ENV !== 'test' && process.env.DISABLE_MERGE_CONSENT_SWEEP !== 'true') {
    startMergeConsentSweepLoop(db);
  }

  // #155 — collect unused DCR OAuth clients 7 days past their expiry (soft delete). Dry run, logging
  // the count it would collect, until OAUTH_CLIENT_GC_ENABLED=true (R220).
  if (process.env.NODE_ENV !== 'test' && process.env.DISABLE_OAUTH_CLIENT_GC !== 'true') {
    startOauthClientGcLoop(db);
  }

  // #1647 — resume pending notices of admin-initiated account erasures (restart-safe outbox).
  if (process.env.NODE_ENV !== 'test' && process.env.DISABLE_USER_DELETION_NOTICES !== 'true') {
    startUserDeletionNoticeLoop(db);
  }

  // #1631 PR2 — send every passkey registration's email notice (restart-safe outbox). Dark with the
  // registration switch: nothing registers while it is off, so the loop doesn't run either.
  if (process.env.NODE_ENV !== 'test' && signingSurfacePolicy().registration) {
    startPasskeyRegistrationNoticeLoop(db);
  }

  // Background job: purge soft-deleted assets past their 24h recovery
  // window (object first, then the row). Before this the janitor had no
  // schedule at all — it only ran when someone invoked the file by hand,
  // so expired assets' bytes accumulated in the bucket indefinitely.
  if (process.env.NODE_ENV !== 'test' && process.env.DISABLE_ASSET_JANITOR !== 'true') {
    startAssetJanitorLoop(db);
  }

  // #896 — retry sweep for assets stuck in scanStatus PENDING (inline
  // scan at complete-upload is the primary path; this settles rows the
  // inline pass couldn't). No-ops per run when SCAN_TOOL_URL is unset.
  if (
    process.env.NODE_ENV !== 'test' &&
    process.env.DISABLE_ASSET_SCAN_SWEEP !== 'true'
  ) {
    startAssetScanSweepLoop(db);
  }

  // Background job (#889): daily sweep for object-store objects with no
  // Asset row — the catch-all for every leak path the retention janitor
  // cannot see (cascaded rows, encrypted memories, abandoned uploads).
  // Deletes on the ABSENCE of a row, so it is dry-run until an operator
  // sets ASSET_ORPHAN_REAP_ENABLED=true.
  if (
    process.env.NODE_ENV !== 'test' &&
    process.env.DISABLE_ASSET_ORPHAN_SWEEP !== 'true'
  ) {
    startOrphanObjectReaperLoop(db);
  }

  // Background job (#1140): hourly bounded sweep for Asset rows whose bytes are
  // missing from object storage — the mirror of the orphan sweep. Read-only
  // against the store; raises the `asset.bytes_missing` alarm.
  if (
    process.env.NODE_ENV !== 'test' &&
    process.env.DISABLE_ASSET_BYTES_SWEEP !== 'true'
  ) {
    startAssetBytesSweepLoop(db);
  }

  // Background job (#930, narrowed by #1114): end sessions past `expiresAt`,
  // stamping `autoExpiredAt`. Inactivity no longer ends anything — liveness is
  // derived at read time — so this loop honours the hard-expiry promise and
  // nothing else.
  if (process.env.NODE_ENV !== 'test' && process.env.DISABLE_SESSION_REAPER !== 'true') {
    startSessionReaperLoop(db);
  }

  // #2261 — idle eviction of MCP transports. Its own timer on purpose: DISABLE_SESSION_REAPER must not also
  // switch off the bound on what the process holds in memory (the #2259 leak).
  if (process.env.NODE_ENV !== 'test') {
    startMcpTransportSweepLoop();
  }

  // #1706 — agent-task stall evaluator: the four stall rules, owner-chain
  // escalation, and clearing stall marks. Idempotent per episode, so it needs
  // no claim race across instances.
  if (process.env.NODE_ENV !== 'test' && process.env.DISABLE_TASK_STALL_EVALUATOR !== 'true') {
    startTaskStallEvaluatorLoop(db);
  }

  // #1707 — the matcher's sweep: records lapsed host registrations and assigns
  // queued tasks to workers free for work. Each assignment is a guarded update
  // under a per-worker lock, so overlapping runs never double-assign.
  if (process.env.NODE_ENV !== 'test' && process.env.DISABLE_TASK_MATCHER !== 'true') {
    startTaskMatcherLoop(db);
  }

  // PendingEdge rows retargeted to stable node ids are durable retry work.
  // The inline timer is only a latency optimization; this sweep recovers the
  // relationship after a restart or transient promotion failure.
  if (
    process.env.NODE_ENV !== 'test' &&
    process.env.DISABLE_PENDING_EDGE_SWEEP !== 'true'
  ) {
    startPendingEdgePromotionSweepLoop(db);
  }

  // #1114 — the session-key cache's TTL sweep, on its OWN timer.
  // Deliberately NOT gated on DISABLE_SESSION_REAPER: an eviction policy for
  // process-held key material must not be reachable through another
  // subsystem's off switch (#1120 review, Codex P2).
  if (process.env.NODE_ENV !== 'test') {
    startSessionKeySweepLoop();
  }

  // 033 — embedding worker sweep (retries / restarts / backfill). Skipped in
  // tests (which drive embedNode/drainEmbeddingQueue directly). Warns if any
  // memory is vector-indexed but no embedding endpoint is configured.
  if (process.env.NODE_ENV !== 'test' && process.env.DISABLE_EMBED_WORKER !== 'true') {
    // No legacy timestamp-only work may slip into the new token worker. Serving writes
    // remains available with explicit pending status if operator reconciliation is needed.
    let embeddingReady = false;
    try { await assertEmbeddingObligationsReconciled(db); embeddingReady = true; }
    catch (error) { console.error('[embed-worker] admission stays closed:', error); }
    if (embeddingReady) startEmbeddingWorkerLoop(db);
    // Same-process bus listener (spec 039): near-instant retries + backfill
    // drains via embed.wake.v1. No-op (null) when NATS_URL is unset — the
    // sweep loop above is the standalone fallback (D-2026-06-17-004).
    if (embeddingReady) startEmbeddingBusListener(db).catch((err) => {
      // A subscribe/consumer failure (broker auth, incompatible durable)
      // must not become an unhandled rejection that can take boot down —
      // the sweep loop above keeps draining regardless (PR-489 review,
      // Codex P2 + Gemini).
      console.error('[embed-worker] failed to start bus listener (sweep continues):', err);
    });
    void db.memory
      .count({ where: { ...INDEXED_MEMORY_WHERE, deletedAt: null } })
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

  // Sentry — must be the last middleware, after every route/controller is
  // mounted, so it observes errors forwarded via next(err) from the auth,
  // OAuth, webhook and schema-discovery routes. GraphQL resolver errors do not
  // reach here (Apollo handles them internally) — they are captured by
  // sentryApolloPlugin instead. No-op when SENTRY_DSN is unset.
  Sentry.setupExpressErrorHandler(app);

  // #1789: a fault that reaches Express shows the caller the generic envelope, not Express's default stack page.
  app.use(internalFaultErrorHandler);

  app.locals.stopEmbeddingWorker = () => Promise.all([
    stopEmbeddingWorker(db), stopEmbeddingPublisher(),
  ]).then(results => results.every(Boolean));
  return app;
}
