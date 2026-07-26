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
 *   3. Host header is localhost/127.0.0.1 — the RAW Host header, not
 *      req.hostname, which honors X-Forwarded-Host under `trust proxy` and
 *      would let a proxied request forge localhost.
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

/** Gate 3: the RAW Host header (port stripped) names the loopback host. */
function isLocalhostRequest(req: Request): boolean {
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

    // Existing users only — never auto-create (unlike the magic-link verify
    // upsert; a dev convenience must not become a user-minting surface).
    const user = await db.user.findUnique({
      where: { email: email.trim().toLowerCase() },
    });
    if (!user) {
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
      userId: user.id,
      redirect: dest,
      isNew: false,
    });
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const callbackUrl = new URL('/auth/callback', frontendUrl);
    callbackUrl.searchParams.set('code', code);
    res.redirect(callbackUrl.toString());
  });
}
