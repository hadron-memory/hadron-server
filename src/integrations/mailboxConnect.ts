/**
 * Mailbox-connect OAuth flow — the ONE implementation of the
 * start-nonce → authorize-redirect → callback trio, mounted once per email
 * provider (Microsoft, Gmail). Extracted verbatim from the Microsoft block
 * in server.ts (#580) so the second provider cannot drift from the review
 * fixes baked into the first (#477 nonce handoff, both #506 org-ADMIN
 * gates, superseded-connection teardown, ownership transfer + soft-delete
 * revival, orphaned-tool-connection cleanup).
 *
 * Per provider, the config supplies only the user-facing OAuth pieces
 * (authorize URL, redirect URI) and the emailClient dispatch key — the
 * provider tool holds the client secret and does the code exchange.
 */
import crypto from 'crypto';
import type { Express } from 'express';
import { issueExchangeStartNonce, redeemExchangeStartNonce } from '../auth/authHandoff.js';
import { verifyAuthenticatedJwt } from '../auth/index.js';
import { requireOrgRole } from '../api/graphql/schema/resolvers.helpers.js';
import { createToolConnection, deleteToolConnection, subscribeToolFolder } from '../lib/emailClient.js';
import { db } from './db/client.js';

export interface MailboxConnectConfig {
  /** emailClient PROVIDER_TOOLS key; stored on ExchangeConnection.provider. */
  provider: string;
  /** Route segment: /auth/<routeName>/start, /auth/<routeName>, /auth/<routeName>/callback. */
  routeName: string;
  /** Build the provider's authorize URL for a state value. */
  buildAuthUrl: (state: string) => string;
  /** The registered redirect URI — the tool's token exchange repeats it verbatim. */
  getRedirectUri: () => string;
  /** Log prefix, e.g. `microsoft-oauth`. */
  logPrefix: string;
  /**
   * When false, the start/redirect routes answer 503 instead of redirecting
   * to a misconfigured provider (#582 posture). Checked BEFORE the nonce is
   * redeemed so a retry after configuration still works. Required so every
   * provider fails the same way — an unset client id must never surface as
   * an unhandled throw inside the authorize redirect.
   */
  isConfigured: () => boolean;
  /**
   * Whether the callback subscribes the connection's inbox to the provider
   * event plane (default true — the email tools). Providers whose tool has
   * no folder-subscription surface (hadrontool-google-cal: calendar, no
   * event plane in v1) set false so every connect doesn't log a spurious
   * best-effort failure.
   */
  subscribeInbox?: boolean;
}

/** Mount the three mailbox-connect routes for one provider. */
export function mountMailboxConnectRoutes(app: Express, cfg: MailboxConnectConfig): void {
  const pendingStates = new Map<
    string,
    { orgId: string; userId: string; redirect: string; expiresAt: number }
  >();

  // #477 Sink 2 — mailbox-connect OAuth start. The portal calls this
  // server-to-server (Bearer-authed, NOT a browser redirect) and gets back a
  // single-use, short-TTL nonce. The 30-day JWT authenticates the initiating
  // user HERE, over a header on a server-to-server POST — it never rides in
  // the browser redirect URL (where it would land in access logs + history).
  app.post(`/auth/${cfg.routeName}/start`, async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'No token provided' });
      return;
    }
    let userId: string;
    let roles: ('OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER')[] | undefined;
    try {
      const payload = await verifyAuthenticatedJwt(authHeader.slice(7), db);
      // Admin impersonation: read-only sessions cannot start a mailbox
      // connection (a state-changing OAuth flow as the target).
      if (payload.imp) {
        res.status(401).json({ error: 'Impersonation tokens are not accepted here' });
        return;
      }
      userId = payload.sub;
      roles = payload.roles;
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    if (!cfg.isConfigured()) {
      res.status(503).json({ error: `${cfg.routeName} connections are not configured on this server` });
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
    // which org they may act on. Without this gate any authenticated user
    // could attach their own mailbox to an ARBITRARY org (the nonce carries
    // orgId straight to the callback's ExchangeConnection upsert). Require
    // org ADMIN — the same role deleteExchangeConnection enforces.
    // requireOrgRole short-circuits for platform ADMIN/OWNER and rejects
    // revoked (soft-deleted) members.
    try {
      await requireOrgRole({ db, userId, roles }, orgId, 'ADMIN');
    } catch (err) {
      // Only the explicit authorization failure is a 403 — an unexpected
      // fault (DB outage, transient Prisma error) must surface as 500, not
      // masquerade as "not an admin" (PR-509 Copilot review).
      if (err instanceof Error && err.message === 'Forbidden') {
        res.status(403).json({ error: 'Forbidden: you must be an admin of this organization.' });
        return;
      }
      console.error(`${cfg.routeName}/start authorization error:`, err);
      res.status(500).json({ error: 'Internal error' });
      return;
    }

    // Provider-bound: this nonce redeems only at THIS provider's authorize
    // route — the ADMIN approval above is for connecting this provider.
    const nonce = await issueExchangeStartNonce({ userId, orgId, redirect, provider: cfg.provider });
    res.json({ nonce });
  });

  app.get(`/auth/${cfg.routeName}`, async (req, res) => {
    // #477 Sink 2: the browser arrives with a single-use nonce (minted by
    // POST /auth/<provider>/start), not the session JWT. Look it up, discard
    // it, and proceed with the provider OAuth round-trip.
    const nonce = req.query.nonce as string | undefined;
    if (!nonce) {
      res.status(400).json({ error: 'Missing nonce' });
      return;
    }
    if (!cfg.isConfigured()) {
      res.status(503).json({ error: `${cfg.routeName} connections are not configured on this server` });
      return;
    }
    const started = await redeemExchangeStartNonce(nonce, cfg.provider);
    if (!started) {
      res.status(400).json({ error: 'Invalid or expired nonce' });
      return;
    }

    // Evict expired pending states — abandoned consent screens would
    // otherwise grow the map unboundedly (the sibling login flows prune the
    // same way).
    const now = Date.now();
    for (const [key, value] of pendingStates) {
      if (value.expiresAt < now) pendingStates.delete(key);
    }

    const state = crypto.randomBytes(16).toString('hex');
    pendingStates.set(state, {
      orgId: started.orgId,
      userId: started.userId,
      redirect: started.redirect,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    res.redirect(cfg.buildAuthUrl(state));
  });

  app.get(`/auth/${cfg.routeName}/callback`, async (req, res) => {
    const { code, state, error: oauthError } = req.query as {
      code?: string;
      state?: string;
      error?: string;
    };

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

    if (oauthError) {
      const errorUrl = new URL('/app/dashboard', frontendUrl);
      errorUrl.searchParams.set('exchangeError', oauthError);
      errorUrl.searchParams.set('provider', cfg.provider);
      res.redirect(errorUrl.toString());
      return;
    }

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

    // #506 defense-in-depth: /start already gated on org ADMIN, but authority
    // can narrow during the OAuth round-trip (the ~2-min nonce window — e.g.
    // the user's membership is revoked). Re-verify before writing the
    // connection. Roles aren't carried on this browser redirect, so fetch
    // them for requireOrgRole's platform-admin short-circuit.
    try {
      const initiator = await db.user.findUnique({
        where: { id: pending.userId },
        select: { roles: true },
      });
      // A deleted initiator (null) has no roles and no membership →
      // requireOrgRole rejects it. Cast the Prisma Role[] to the Context.roles
      // union (they are the same string set) for the platform-admin
      // short-circuit.
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
      // Distinguish the authorization failure from an operational fault so a
      // DB outage doesn't masquerade as "not authorized" (PR-509 Copilot
      // review).
      const forbidden = err instanceof Error && err.message === 'Forbidden';
      if (!forbidden) console.error(`${cfg.routeName}/callback re-check error:`, err);
      const errorUrl = new URL('/app/dashboard', frontendUrl);
      errorUrl.searchParams.set('exchangeError', forbidden ? 'not_authorized' : 'server_error');
      errorUrl.searchParams.set('provider', cfg.provider);
      res.redirect(errorUrl.toString());
      return;
    }

    // #396: core does NOT exchange the code — the provider tool holds the
    // client secret. Forward the code (with the SAME redirect URI the
    // authorize URL carried); the tool exchanges it, derives the mailbox
    // identity, stores the encrypted refresh token, and returns the identity
    // (shape-validated by emailClient). Core stores only that identity.
    let identity: Awaited<ReturnType<typeof createToolConnection>> | undefined;
    try {
      identity = await createToolConnection(cfg.provider, {
        code,
        redirectUri: cfg.getRedirectUri(),
      });

      // Reconnecting an existing connection mints a NEW tool connection;
      // tear down the superseded one so it doesn't keep a live token +
      // subscriptions on the tool side. Fire-and-forget (never throws) —
      // the browser redirect must not wait on the tool. The key is
      // PROVIDER-SCOPED: a calendar connect for an address that already has
      // a mail connection (same Google account) must never tear down or
      // overwrite the mail row (PR-638 Codex P1).
      const existing = await db.exchangeConnection.findUnique({
        where: {
          organizationId_provider_mailboxEmail: {
            organizationId: pending.orgId,
            provider: cfg.provider,
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
          organizationId_provider_mailboxEmail: {
            organizationId: pending.orgId,
            provider: cfg.provider,
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
      // plane). Best-effort: until the tool's public ingress route is
      // configured this fails, and the connection is still fully usable for
      // request/reply operations. Skipped for providers without a
      // folder-subscription surface (subscribeInbox: false).
      if (cfg.subscribeInbox !== false) {
        subscribeToolFolder(identity.provider, identity.id, 'inbox').catch((err) => {
          console.log(
            `[${cfg.logPrefix}] inbox subscription not created for ${identity!.mailboxEmail} (event plane off?): ${err instanceof Error ? err.message : err}`,
          );
        });
      }

      console.log(
        `[${cfg.logPrefix}] Connected ${cfg.provider} for ${identity.mailboxEmail} → org ${pending.orgId} (tool connection ${identity.id})`,
      );

      // `exchangeError`/`exchangeConnected` are the pre-#580 portal contract
      // (Microsoft-era names, kept for compatibility); `provider` tells the
      // portal WHICH connect flow this outcome belongs to.
      const successUrl = new URL(pending.redirect, frontendUrl);
      successUrl.searchParams.set('exchangeConnected', '1');
      successUrl.searchParams.set('provider', cfg.provider);
      res.redirect(successUrl.toString());
    } catch (err) {
      console.error(`[${cfg.logPrefix}] Callback error:`, err);
      // If the tool already minted a connection but core failed to record it,
      // tear the orphan down — otherwise every failed attempt leaks a live
      // refresh token + auto-renewing subscriptions with no core record.
      if (identity) {
        void deleteToolConnection(identity.provider, identity.id);
      }
      const errorUrl = new URL(pending.redirect, frontendUrl);
      errorUrl.searchParams.set(
        'exchangeError',
        err instanceof Error ? err.message : 'Mailbox authentication failed',
      );
      errorUrl.searchParams.set('provider', cfg.provider);
      res.redirect(errorUrl.toString());
    }
  });
}
