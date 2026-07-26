/**
 * Dev-only login endpoint (#792) — one-navigation authenticated portal
 * sessions for local agent/browser driving and future E2E, with no Resend
 * side effects.
 *
 *   GET /auth/dev/login?email=<email>&redirect=<portal-path>
 *
 * Signs the caller in as an EXISTING user by reusing the exact magic-link
 * completion path: mint a #477 login handoff code and 302 into the portal's
 * /auth/callback, whose server `load` redeems it at POST /auth/session for
 * the JWT cookie. The code carries no clientStateHash, so redemption skips
 * the #505 session-fixation binding — acceptable ONLY because this route
 * exists solely on localhost dev (see the gates). No portal changes needed.
 *
 * Three hard gates, ALL required per-request:
 *   1. DEV_LOGIN_ENABLED=true  — explicit opt-in, never set in a deployed env.
 *   2. NODE_ENV !== 'production' — belt and braces if the flag leaks.
 *   3. The request is genuinely local: the TCP peer address is loopback
 *      (req.socket.remoteAddress — src/index.ts listens on all interfaces, and
 *      a LAN/tunnel peer fully controls its Host header, so the header alone
 *      is no proof of locality; PR #793 review) AND the RAW Host header is
 *      localhost/127.0.0.1 (raw, not req.hostname, which honors
 *      X-Forwarded-Host under `trust proxy`).
 *
 * When any gate fails the handler calls next(), so the request falls through
 * to Express's default 404 — byte-identical to a route that doesn't exist
 * (no 403 hint that the endpoint is present).
 *
 * Non-goals (by design): no user creation, no token-in-URL variant, no role
 * elevation, no production escape hatch.
 */

import type { Express, Request } from 'express';
import type { PrismaClient } from '../generated/prisma/index.js';
import { resolveUserRefOrEmail } from '../lib/entityRef/userRef.js';
import { issueLoginCode } from './authHandoff.js';
import { isServerLocalPath } from './server-local-path.js';

/** Landing page when the caller doesn't ask for one. */
const DEFAULT_REDIRECT = '/app/dashboard';

/** Gate 1+2: flag explicitly on AND not a production build. Read per-call so
 *  tests can stub the env without re-creating the app. */
function devLoginEnabled(): boolean {
  return (
    process.env.DEV_LOGIN_ENABLED === 'true' &&
    process.env.NODE_ENV !== 'production'
  );
}

/** The loopback peer addresses Node reports for a local TCP connection. */
const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Gate 3: the connection is genuinely local. The TCP peer address must be
 * loopback — the one signal a remote caller cannot forge (the server listens
 * on all interfaces, so a LAN peer could otherwise just send `Host:
 * localhost`) — and the RAW Host header must name the loopback host (so a
 * proxied/forwarded request that happens to originate on this machine still
 * doesn't qualify).
 */
export function isLocalhostRequest(req: Pick<Request, 'headers' | 'socket'>): boolean {
  if (!LOOPBACK_PEERS.has(req.socket.remoteAddress ?? '')) return false;
  const host = req.headers.host?.replace(/:\d+$/, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1';
}

/**
 * Mount GET /auth/dev/login. Called unconditionally from createServer(); the
 * handler re-checks the gates on every request (env may differ from boot,
 * e.g. under test), answering as a nonexistent route whenever they fail.
 */
export function mountDevLoginRoutes(app: Express, db: PrismaClient): void {
  if (devLoginEnabled()) {
    console.warn(
      '⚠️  DEV LOGIN ENABLED — GET /auth/dev/login signs in as any existing ' +
        'user without credentials. Local development only.',
    );
  }

  app.get('/auth/dev/login', async (req, res, next) => {
    if (!devLoginEnabled() || !isLocalhostRequest(req)) {
      next(); // fall through to the default 404 — route "does not exist"
      return;
    }

    const { email, redirect: redirectParam } = req.query as {
      email?: string;
      redirect?: string;
    };
    if (!email || typeof email !== 'string') {
      res.status(400).json({ error: 'email query param is required' });
      return;
    }

    // Keep the surface email-only (never a handle/ID resolver): a non-email
    // input must not fall through to resolveUserRef's URN path.
    if (!email.includes('@')) {
      res.status(400).json({ error: 'email query param must be an email address' });
      return;
    }

    // Existing users only — never auto-create (unlike the magic-link verify
    // upsert; a dev convenience must not become a user-minting surface).
    // Shared resolver (#769/#774 semantics): exact case-sensitive match wins,
    // single case-insensitive match falls back, a case-only pair is rejected
    // as ambiguous — `User.email` is only case-sensitively unique and some
    // surfaces store it verbatim (PR #793 review).
    let userId: string;
    try {
      ({ id: userId } = await resolveUserRefOrEmail(db, email));
    } catch {
      res.status(404).json({ error: 'No user with that email' });
      return;
    }

    // Same open-redirect guard as /auth/email/verify: only a strict
    // server-local path may become the post-login destination.
    const dest =
      redirectParam && isServerLocalPath(redirectParam)
        ? redirectParam
        : DEFAULT_REDIRECT;

    // #477 Sink 1, exactly as the email-verify completion: single-use handoff
    // code into the portal callback; the JWT is minted at POST /auth/session
    // from the authoritative user row, so claims stay in lockstep with the
    // real flows. Unbound (no clientStateHash) — see the module docstring.
    const code = await issueLoginCode({
      userId,
      redirect: dest,
      isNew: false,
    });
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const callbackUrl = new URL('/auth/callback', frontendUrl);
    callbackUrl.searchParams.set('code', code);
    res.redirect(callbackUrl.toString());
  });
}
