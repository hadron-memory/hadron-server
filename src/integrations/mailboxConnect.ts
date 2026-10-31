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
import express, { type Express, type Response } from 'express';
import {
  EXCHANGE_START_TTL_MS,
  connectInterstitialToken,
  connectInterstitialTokenValid,
  issueExchangeStartNonce,
  peekExchangeStartNonce,
  redeemExchangeStartNonce,
  type ExchangeStartOrigin,
} from '../auth/authHandoff.js';
import { verifyAuthenticatedJwt } from '../auth/index.js';
import { requireOrgRole } from '../api/graphql/schema/resolvers.helpers.js';
import { createToolConnection, deleteToolConnection, subscribeToolFolder } from '../lib/emailClient.js';
import { db } from './db/client.js';
import { respondInternalFault } from '../lib/internalFault.js';
import { isPortalPath, portalPathOrRoot } from './portalRedirect.js';

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

/** The provider's connect flow is not configured on this server (REST 503, GraphQL CONNECTION_PROVIDER_NOT_CONFIGURED). */
export class ConnectProviderNotConfiguredError extends Error {
  constructor(public readonly provider: string) {
    super(`${provider} connections are not configured on this server`);
    this.name = 'ConnectProviderNotConfiguredError';
  }
}

const connectProviders = new Map<string, MailboxConnectConfig>();

/** The mounted connect flow for an emailClient provider key, or undefined when none is mounted. */
export function getConnectProvider(provider: string): MailboxConnectConfig | undefined {
  return connectProviders.get(provider);
}

export interface ConnectStart {
  nonce: string;
  expiresAt: Date;
}

/**
 * The ONE start of a mailbox/calendar/Drive connect flow (#477, #506, #2897), shared by `POST /auth/{provider}/start`
 * and the GraphQL `startConnection`: the caller must be an ADMIN of the org (#506), the provider must be configured,
 * and the result is a single-use, short-TTL nonce bound to this provider. The caller has already authenticated the
 * principal; this decides what that principal may start.
 *
 * Role first, configuration second: a caller who may not connect in this org learns nothing about whether the
 * provider is configured. Throws the org gate's own error, or {@link ConnectProviderNotConfiguredError}.
 */
export async function issueConnectStart(
  cfg: MailboxConnectConfig,
  args: {
    userId: string;
    roles: ('OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER')[] | undefined;
    orgId: string;
    redirect: string;
    origin: ExchangeStartOrigin;
  },
): Promise<ConnectStart> {
  await requireOrgRole({ db, userId: args.userId, roles: args.roles }, args.orgId, 'ADMIN');
  if (!cfg.isConfigured()) throw new ConnectProviderNotConfiguredError(cfg.routeName);
  const issuedAt = Date.now();
  const nonce = await issueExchangeStartNonce({
    userId: args.userId,
    orgId: args.orgId,
    redirect: args.redirect,
    provider: cfg.provider,
    origin: args.origin,
  });
  return { nonce, expiresAt: new Date(issuedAt + EXCHANGE_START_TTL_MS) };
}

const PROVIDER_LABELS: Record<string, string> = {
  'ms-exchange': 'Microsoft 365',
  gmail: 'Gmail',
  'google-cal': 'Google Calendar',
  'google-drive': 'Google Drive',
};

/** RFC 6749 §4.1.2.1 and OIDC error codes; anything else a provider sends is shown as `provider_error`. */
const STABLE_PROVIDER_ERRORS = new Set([
  'access_denied',
  'invalid_request',
  'unauthorized_client',
  'unsupported_response_type',
  'invalid_scope',
  'server_error',
  'temporarily_unavailable',
  'interaction_required',
  'login_required',
  'consent_required',
]);

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * The server-hosted end of a flow started from GraphQL (#2897): plain HTML with no portal dependency. Success names
 * the provider and the org; the error form shows only a generic sentence and a stable code, never provider text, a
 * thrown message or a token. The CLI confirms by listing connections, so this page is informational.
 */
function sendConnectDonePage(
  res: Response,
  page: { provider: string; ok: true; orgName: string | null } | { provider: string; ok: false; code: string },
): void {
  const label = escapeHtml(PROVIDER_LABELS[page.provider] ?? page.provider);
  const body = page.ok
    ? `<h1>${label} connected</h1><p>${page.orgName ? `Connected to <strong>${escapeHtml(page.orgName)}</strong>. ` : ''}You can close this tab and return to the terminal.</p>`
    : `<h1>${label} was not connected</h1><p>The connection could not be completed. You can close this tab and return to the terminal.</p><p>Error code: <code>${escapeHtml(page.code)}</code></p>`;
  res
    .status(200)
    .set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    })
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${label}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5}code{background:#eee;padding:0 .25rem}</style></head><body>${body}</body></html>`,
    );
}

const BINDING_COOKIE = 'hadron_connect_bind';
const BINDING_PATTERN = /^[0-9a-f]{32}$/;

/** The browser-binding value a request carries, or null (absent or malformed). Cookies are parsed by hand: no parser is mounted. */
function readBindingCookie(header: string | undefined): string | null {
  for (const part of (header ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === BINDING_COOKIE) {
      const value = rest.join('=');
      return BINDING_PATTERN.test(value) ? value : null;
    }
  }
  return null;
}

/**
 * The connect confirmation page (#2908): server-hosted HTML naming the provider, the organization and who asked, with
 * one Continue button that POSTs the nonce and a per-page token back. Every interpolated value is escaped. No
 * `form-action` directive: Chromium enforces it on the whole redirect chain after the POST, which ends at the provider.
 */
function sendConnectConfirmPage(
  res: Response,
  page: { provider: string; action: string; nonce: string; token: string; binding: string; orgName: string; initiator: string },
): void {
  const label = escapeHtml(PROVIDER_LABELS[page.provider] ?? page.provider);
  res
    .status(200)
    .set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      // Strict: the confirming POST is same-site from this very page, and a cross-site form post must not carry it.
      'Set-Cookie': `${BINDING_COOKIE}=${page.binding}; Path=${page.action}; Max-Age=${Math.ceil(EXCHANGE_START_TTL_MS / 1000)}; HttpOnly; SameSite=Strict${(process.env.BASE_URL ?? '').startsWith('https://') ? '; Secure' : ''}`,
    })
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect ${label}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5}button{font:inherit;padding:.5rem 1rem}</style></head><body><h1>Connect ${label}</h1><p><strong>${escapeHtml(page.initiator)}</strong> asked to connect ${label} to <strong>${escapeHtml(page.orgName)}</strong>.</p><p>Continue only if you expect this. You will be sent to ${label} to sign in and approve.</p><form method="post" action="${escapeHtml(page.action)}"><input type="hidden" name="nonce" value="${escapeHtml(page.nonce)}"><input type="hidden" name="token" value="${escapeHtml(page.token)}"><button type="submit">Continue</button></form></body></html>`,
    );
}

/** Mount the three mailbox-connect routes for one provider. */
export function mountMailboxConnectRoutes(app: Express, cfg: MailboxConnectConfig): void {
  connectProviders.set(cfg.provider, cfg);
  const pendingStates = new Map<
    string,
    { orgId: string; userId: string; redirect: string; origin: ExchangeStartOrigin; expiresAt: number }
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
    if (!orgId) {
      res.status(400).json({ error: 'orgId is required' });
      return;
    }
    // #2909: the value lands in the callback's browser redirect, so it must be a path inside the portal. Refused
    // before the org gate and before any nonce exists. Omitted or empty keeps meaning the portal root.
    const provided = body.redirect === undefined || body.redirect === null || body.redirect === '' ? '/' : body.redirect;
    if (!isPortalPath(provided, process.env.FRONTEND_URL || 'http://localhost:5173')) {
      res.status(400).json({ error: 'redirect must be a path inside the portal, such as /app/dashboard' });
      return;
    }
    const redirect = provided;

    // #506: the Bearer JWT authenticates the caller but says nothing about
    // which org they may act on. Without this gate any authenticated user
    // could attach their own mailbox to an ARBITRARY org (the nonce carries
    // orgId straight to the callback's ExchangeConnection upsert). Require
    // org ADMIN — the same role deleteExchangeConnection enforces.
    // requireOrgRole short-circuits for platform ADMIN/OWNER and rejects
    // revoked (soft-deleted) members. The gate and the provider-bound nonce
    // are the shared start (#2897), the same one GraphQL `startConnection` uses.
    try {
      const { nonce } = await issueConnectStart(cfg, { userId, roles, orgId, redirect, origin: 'portal' });
      res.json({ nonce });
    } catch (err) {
      if (err instanceof ConnectProviderNotConfiguredError) {
        res.status(503).json({ error: `${cfg.routeName} connections are not configured on this server` });
        return;
      }
      // Only the explicit authorization failure is a 403 — an unexpected
      // fault (DB outage, transient Prisma error) must surface as 500, not
      // masquerade as "not an admin" (PR-509 Copilot review).
      if (err instanceof Error && err.message === 'Forbidden') {
        res.status(403).json({ error: 'Forbidden: you must be an admin of this organization.' });
        return;
      }
      respondInternalFault(res, `${cfg.routeName}/start`, err);
    }
  });

  // One refusal for every shape (unknown, expired, redeemed, wrong provider, deleted org or user, ex-admin): same
  // status, body and headers, so the response says nothing about which one it was.
  const refuseNonce = (res: Response): void => {
    res.status(400).json({ error: 'Invalid or expired nonce' });
  };

  /**
   * Whether the nonce's initiator may still connect into its org, judged BEFORE anything is consumed or shown (#506
   * again: authority can narrow between start and the browser arriving). Returns what the page names, or null.
   */
  const judgeNonce = async (
    started: { userId: string; orgId: string },
  ): Promise<{ orgName: string; initiator: string } | null> => {
    const [initiator, org] = await Promise.all([
      db.user.findFirst({
        where: { id: started.userId, deletedAt: null },
        select: { roles: true, name: true, handle: true },
      }),
      db.organization.findFirst({ where: { id: started.orgId, deletedAt: null }, select: { name: true } }),
    ]);
    if (!initiator || !org) return null;
    try {
      await requireOrgRole(
        { db, userId: started.userId, roles: initiator.roles as ('OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER')[] },
        started.orgId,
        'ADMIN',
      );
    } catch (err) {
      if (err instanceof Error && err.message === 'Forbidden') return null;
      throw err;
    }
    return { orgName: org.name, initiator: initiator.name?.trim() || `@${initiator.handle}` };
  };

  // #2908: opening the link is a read. The browser arrives with a single-use nonce (minted by POST
  // /auth/<provider>/start or GraphQL `startConnection`); this page names the organization and who asked, and the
  // person confirms with a button. A link preview or a prefetch that only GETs consumes nothing and starts nothing.
  app.get(`/auth/${cfg.routeName}`, async (req, res) => {
    const nonce = typeof req.query.nonce === 'string' ? req.query.nonce : undefined;
    if (!nonce) {
      res.status(400).json({ error: 'Missing nonce' });
      return;
    }
    if (!cfg.isConfigured()) {
      res.status(503).json({ error: `${cfg.routeName} connections are not configured on this server` });
      return;
    }
    try {
      const started = await peekExchangeStartNonce(nonce, cfg.provider);
      const who = started ? await judgeNonce(started) : null;
      if (!who) {
        refuseNonce(res);
        return;
      }
      // A second tab in the same browser reuses the binding, so the first page's token keeps working.
      const binding = readBindingCookie(req.headers.cookie) ?? crypto.randomBytes(16).toString('hex');
      sendConnectConfirmPage(res, {
        provider: cfg.provider,
        action: `/auth/${cfg.routeName}`,
        nonce,
        token: connectInterstitialToken(cfg.provider, nonce, binding),
        binding,
        orgName: who.orgName,
        initiator: who.initiator,
      });
    } catch (err) {
      respondInternalFault(res, `${cfg.routeName}/confirm`, err);
    }
  });

  app.post(`/auth/${cfg.routeName}`, express.urlencoded({ extended: false }), async (req, res) => {
    const body = (req.body ?? {}) as { nonce?: unknown; token?: unknown };
    const nonce = typeof body.nonce === 'string' ? body.nonce : undefined;
    if (!nonce) {
      res.status(400).json({ error: 'Missing nonce' });
      return;
    }
    if (!cfg.isConfigured()) {
      res.status(503).json({ error: `${cfg.routeName} connections are not configured on this server` });
      return;
    }
    let started: Awaited<ReturnType<typeof redeemExchangeStartNonce>>;
    try {
      // A wrong or missing token or browser binding, or an initiator who may no longer connect, is refused before the claim, so it
      // does not burn a nonce the right page could still use.
      const binding = readBindingCookie(req.headers.cookie);
      if (!binding || !connectInterstitialTokenValid(cfg.provider, nonce, binding, body.token)) {
        refuseNonce(res);
        return;
      }
      const peeked = await peekExchangeStartNonce(nonce, cfg.provider);
      if (!peeked || !(await judgeNonce(peeked))) {
        refuseNonce(res);
        return;
      }
      started = await redeemExchangeStartNonce(nonce, cfg.provider);
    } catch (err) {
      respondInternalFault(res, `${cfg.routeName}/confirm`, err);
      return;
    }
    if (!started) {
      refuseNonce(res);
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
      origin: started.origin,
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
      // A refused flow consumes its state too, so it cannot be replayed into a success. #2897: the origin lives on
      // the pending state, so a GraphQL-started flow ends on the server page instead of the portal.
      const refused = state ? pendingStates.get(state) : undefined;
      if (state) pendingStates.delete(state);
      if (refused?.origin === 'graphql') {
        sendConnectDonePage(res, {
          provider: cfg.provider,
          ok: false,
          code: STABLE_PROVIDER_ERRORS.has(oauthError) ? oauthError : 'provider_error',
        });
        return;
      }
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
      if (pending.origin === 'graphql') {
        sendConnectDonePage(res, { provider: cfg.provider, ok: false, code: forbidden ? 'not_authorized' : 'server_error' });
        return;
      }
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
      if (pending.origin === 'graphql') {
        const org = await db.organization
          .findUnique({ where: { id: pending.orgId }, select: { name: true } })
          .catch(() => null);
        sendConnectDonePage(res, { provider: cfg.provider, ok: true, orgName: org?.name ?? null });
        return;
      }
      const successUrl = new URL(portalPathOrRoot(pending.redirect, frontendUrl), frontendUrl);
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
      if (pending.origin === 'graphql') {
        sendConnectDonePage(res, { provider: cfg.provider, ok: false, code: 'connection_failed' });
        return;
      }
      const errorUrl = new URL(portalPathOrRoot(pending.redirect, frontendUrl), frontendUrl);
      errorUrl.searchParams.set(
        'exchangeError',
        err instanceof Error ? err.message : 'Mailbox authentication failed',
      );
      errorUrl.searchParams.set('provider', cfg.provider);
      res.redirect(errorUrl.toString());
    }
  });
}
