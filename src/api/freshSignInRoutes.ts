import { getProjectBaseUrl } from '../lib/baseUrl.js';
/**
 * #1631 PR1b slice 2 (cor:aut:040:09): the passkey ceremony's sign-in legs, on the server origin.
 *
 * A leg proves who the person is to ONE ceremony browser and signs them in to nothing: no JWT, no handoff code,
 * no `hadron_token`. Mounted only when `signingSurfacePolicy().registration` is on (#1895), like the other ceremony
 * routes; while off nothing is mounted.
 *
 * - `POST /passkeys/sign-in/<github|google|apple>/start` sets the `hadron_ceremony_browser` cookie and writes a
 *   pending login state carrying its SHA-256. The provider's ordinary callback sees that column and hands off to
 *   {@link completeCeremonyLeg}, which looks the identity up (never links, never creates), records an unconfirmed
 *   fresh sign-in, and redirects to the confirm page with a leg id minted there, so the starting browser never
 *   learns it (Ruth's §10 condition 1, #1631 6309332208). The leg id travels only in the Strict
 *   `hadron_ceremony_leg` cookie scoped to the confirm path, never in a URL a person could be asked to paste
 *   (Rook, #1631 6316353964).
 * - `POST /passkeys/sign-in/email` sets the same cookie and, for a live user only, emails a link. The response is
 *   the same whether or not the address belongs to anyone, and no account is ever created (Vera 6309336028).
 * - `GET /passkeys/sign-in/confirm` and `GET /passkeys/sign-in/email/verify` only RENDER a confirm form (a mail
 *   scanner's GET spends nothing). `POST /passkeys/sign-in/confirm` is the same-origin POST that carries the Strict
 *   cookies, and confirms only when the leg secret (the leg cookie, or the emailed token in the form) and the
 *   browser cookie both match. The leg cookie is cleared whatever the outcome.
 *
 * Every refusal is one uniform answer. Consuming a confirmed fresh sign-in is `consumeFreshSignIn`, for the
 * ceremony steps (PR2 register, PR3 revoke); the step that consumes clears the cookie with
 * {@link clearCeremonyBrowserCookie}.
 */
import { createHash, randomBytes } from 'node:crypto';
import express, { type Express, type Request, type RequestHandler, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import * as Sentry from '@sentry/node';
import { db } from '../integrations/db/client.js';
import { buildAuthUrl } from '../auth/github.js';
import { buildGoogleAuthUrl } from '../auth/google.js';
import { buildAppleAuthUrl, isAppleConfigured } from '../auth/apple.js';
import { EMAIL_MAX_LENGTH, sendCeremonySignInLink } from '../auth/email.js';
import { mintProviderNonce } from '../auth/providerNonce.js';
import { createPendingLoginState, LOGIN_STATE_TTL_MS, type LoginProvider } from '../auth/pendingLoginState.js';
import {
  confirmFreshSignIn, FRESH_SIGN_IN_LEG_TTL_SECONDS, recordIdpSignIn, startEmailSignIn, sweepFreshSignIns,
} from '../lib/passkeys/freshSignIn.js';
import { signingCeremonyOrigins } from '../lib/signing/config.js';
import { signingSurfacePolicy } from '../lib/signing/surface.js';
import { page, PAGE_HEADERS } from './ceremonyPages.js';

export const CEREMONY_BROWSER_COOKIE = 'hadron_ceremony_browser';
/** The IdP leg id, set by the callback for the confirm path only. */
export const CEREMONY_LEG_COOKIE = 'hadron_ceremony_leg';
/** Which passkey page the leg was started from, so the confirm page can link back. Not a secret; allowlisted. */
export const CEREMONY_NEXT_COOKIE = 'hadron_ceremony_next';
// 'sign-in' (#1897 B2): the person came from an email sign-in that has no passkey yet; after the second link confirms
// them, the confirm page leads back to the registration page, which then leads to the sign-in page.
export const CEREMONY_NEXT_PAGES = { register: '/passkeys/register', window: '/passkeys/window/end', revoke: '/passkeys/revoke', 'sign-in': '/passkeys/register?next=sign-in' } as const;
type NextPage = keyof typeof CEREMONY_NEXT_PAGES;
const nextPageOf = (v: unknown): NextPage => (v === 'window' || v === 'revoke' || v === 'sign-in' ? v : 'register');
/** The browser binding outlives an IdP round trip, but never the pending login state it rides with. */
export const CEREMONY_BROWSER_TTL_SECONDS = FRESH_SIGN_IN_LEG_TTL_SECONDS;
if (CEREMONY_BROWSER_TTL_SECONDS * 1000 > LOGIN_STATE_TTL_MS) {
  throw new Error('the ceremony browser cookie must not outlive the pending login state');
}
/** Requests a minute per client IP, across the IdP start and confirm routes (the email leg has its own limiters). */
export const FRESH_SIGN_IN_RATE_LIMIT_PER_MINUTE = 30;
export const FRESH_SIGN_IN_CONFIRM_PATH = '/passkeys/sign-in/confirm';
export const FRESH_SIGN_IN_EMAIL_VERIFY_PATH = '/passkeys/sign-in/email/verify';

const sha256Hex = (v: string) => createHash('sha256').update(v).digest('hex');
const LEG_SECRET = /^[A-Za-z0-9_-]{43}$/;

function cookieValue(req: Request, name = CEREMONY_BROWSER_COOKIE): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=') || null;
  }
  return null;
}

/** Exact allowlist match on the Origin header; absent, unlisted or an empty allowlist refuses. */
function originAllowed(req: Request): boolean {
  const origin = req.headers.origin;
  return typeof origin === 'string' && signingCeremonyOrigins().includes(origin);
}

const cookieOptions = (req: Request, path = '/passkeys') => ({
  httpOnly: true, sameSite: 'strict' as const, path,
  secure: process.env.NODE_ENV === 'production' || req.secure,
});

/** Mint the ceremony browser's nonce, set it as the Strict cookie, and return its SHA-256 (all the server keeps). */
function issueCeremonyBrowser(req: Request, res: Response): string {
  const nonce = randomBytes(32).toString('base64url');
  res.cookie(CEREMONY_BROWSER_COOKIE, nonce, { ...cookieOptions(req), maxAge: CEREMONY_BROWSER_TTL_SECONDS * 1000 });
  return sha256Hex(nonce);
}

/** Remember which page started the leg (register by default). */
function rememberNextPage(req: Request, res: Response, next: unknown): void {
  res.cookie(CEREMONY_NEXT_COOKIE, nextPageOf(next), { ...cookieOptions(req), maxAge: CEREMONY_BROWSER_TTL_SECONDS * 1000 });
}

/** Clear the ceremony browser cookie. The ceremony step that consumes a fresh sign-in calls this on success. */
export function clearCeremonyBrowserCookie(req: Request, res: Response): void {
  res.clearCookie(CEREMONY_BROWSER_COOKIE, cookieOptions(req));
}

function refusePage(res: Response, status = 403): void {
  res.status(status).set(PAGE_HEADERS).type('html').send(page('Not confirmed',
    '<h1>This confirmation can\'t be used</h1><p>Start again from the passkey page, in the same browser.</p>'));
}

/** The confirm form. An IdP leg's page carries no secret (its leg id is in the cookie); the email leg's carries the token. */
function confirmFormPage(res: Response, emailToken?: string): void {
  res.status(200).set(PAGE_HEADERS).type('html').send(page('Confirm it is you',
    `<h1>Confirm it is you</h1><p>This confirms your identity to the passkey page in this browser. It does not sign you in.</p>
<p><strong>Never share this page's address with anyone</strong>, including a person or assistant who asks for it.</p>
<form method="post" action="${FRESH_SIGN_IN_CONFIRM_PATH}">${emailToken ? `<input type="hidden" name="token" value="${emailToken}">` : ''}
<button type="submit">Confirm</button></form>`));
}

/** A uniform JSON refusal for the start routes. */
const refuseJson = (res: Response) =>
  res.status(403).type('application/json').set('Cache-Control', 'no-store').send('{"error":"forbidden"}');

/**
 * The provider callback's ceremony branch. `lookup` must find the user by the PROVIDER'S OWN id only (no email
 * linking, no creation) and return null for an unknown or deleted user (Ruth's §10 condition 3). `method` is the
 * provider whose callback ran, never request input (condition 5). Writes the response in every case.
 */
export async function completeCeremonyLeg(
  req: Request,
  res: Response,
  input: { provider: LoginProvider; ceremonyNonceHash: string; lookup: () => Promise<{ id: string } | null> },
): Promise<void> {
  // A state minted while the switch was on must not complete after it was turned off.
  if (!signingSurfacePolicy().registration) return refusePage(res);
  const user = await input.lookup();
  if (!user) return refusePage(res);
  const { legId } = await recordIdpSignIn(db, { userId: user.id, method: input.provider, browserNonceHash: input.ceremonyNonceHash });
  res.cookie(CEREMONY_LEG_COOKIE, legId, { ...cookieOptions(req, FRESH_SIGN_IN_CONFIRM_PATH), maxAge: CEREMONY_BROWSER_TTL_SECONDS * 1000 });
  res.status(303).set(PAGE_HEADERS).location(FRESH_SIGN_IN_CONFIRM_PATH).end();
}

const PROVIDERS: Record<LoginProvider, { configured: () => boolean; url: (state: string, nonce: string) => string }> = {
  github: { configured: () => !!process.env.GITHUB_OAUTH_APP_CLIENT_ID, url: (s) => buildAuthUrl(s) },
  google: {
    configured: () => !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET,
    // R154: Google supports re-authentication, so request it; the callback checks auth_time.
    url: (s, nonce) => buildGoogleAuthUrl(s, nonce, { reauthenticate: true }),
  },
  // GitHub and Apple offer no re-authentication request: a silent provider session is accepted (R154 known limit).
  apple: { configured: isAppleConfigured, url: (s, nonce) => buildAppleAuthUrl(s, nonce) },
};

async function sweep(): Promise<void> {
  try { await sweepFreshSignIns(db); } catch (err) { Sentry.captureException(err); }
}

/** Mount the sign-in legs when the registration switch is on; the switch is read once, at mount. */
export function mountFreshSignInRoutes(
  app: Express,
  limits: { emailSendPerIpRateLimit: RequestHandler; emailRecipientRateLimit: RequestHandler },
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!signingSurfacePolicy(env).registration) return;
  const limiter = rateLimit({
    windowMs: 60_000, limit: FRESH_SIGN_IN_RATE_LIMIT_PER_MINUTE, standardHeaders: false, legacyHeaders: false,
    handler: (_req, res) => { res.status(429).end(); },
  });
  const json = express.json({ limit: '4kb' });
  const form = express.urlencoded({ extended: false, limit: '4kb' });

  app.post('/passkeys/sign-in/:provider/start', limiter, form, async (req: Request, res: Response) => {
    try {
      const provider = req.params.provider as LoginProvider;
      if (!Object.hasOwn(PROVIDERS, provider) || !originAllowed(req) || !PROVIDERS[provider].configured()) {
        return void refuseJson(res);
      }
      await sweep();
      const ceremonyNonceHash = issueCeremonyBrowser(req, res);
      rememberNextPage(req, res, (req.body as { next?: unknown } | undefined)?.next);
      const state = randomBytes(16).toString('hex');
      // #2204: Google and Apple get an OIDC nonce on this leg too (GitHub has no ID token).
      const { nonce, nonceHash } = mintProviderNonce();
      await createPendingLoginState(state, provider === 'github'
        ? { provider, data: { redirect: '/', ceremonyNonceHash } }
        : { provider, data: { redirect: '/', ceremonyNonceHash, providerNonceHash: nonceHash } });
      res.status(303).set('Cache-Control', 'no-store').location(PROVIDERS[provider].url(state, nonce)).end();
    } catch (err) {
      Sentry.captureException(err);
      res.removeHeader('Set-Cookie');
      refuseJson(res);
    }
  });

  // Validate before the shared limiters, so they only ever count a request that will look a user up
  // (the `validateEmailSendRequest` ordering, #560).
  const validateEmailLeg: RequestHandler = (req, res, next) => {
    const email = (req.body as { email?: unknown } | undefined)?.email;
    if (!originAllowed(req)) return void refuseJson(res);
    if (typeof email !== 'string' || !email.trim() || email.trim().length > EMAIL_MAX_LENGTH || !email.includes('@')) {
      return void res.status(400).json({ error: 'Email is required' });
    }
    next();
  };

  app.post('/passkeys/sign-in/email', json, validateEmailLeg, limits.emailSendPerIpRateLimit, limits.emailRecipientRateLimit,
    async (req: Request, res: Response) => {
      const email = String((req.body as { email: string }).email).trim().toLowerCase();
      const browserNonceHash = issueCeremonyBrowser(req, res);
      rememberNextPage(req, res, (req.body as { next?: unknown } | undefined)?.next);
      try {
        await sweep();
        const user = await db.user.findFirst({ where: { email, deletedAt: null }, select: { id: true, email: true } });
        if (user?.email) {
          const { token } = await startEmailSignIn(db, { userId: user.id, browserNonceHash });
          const baseUrl = getProjectBaseUrl();
          await sendCeremonySignInLink(user.email, `${baseUrl}${FRESH_SIGN_IN_EMAIL_VERIFY_PATH}?token=${token}`);
        }
      } catch (err) {
        // Same answer either way: a failure only for known addresses would be an enumeration oracle.
        Sentry.captureException(err);
      }
      res.status(200).set('Cache-Control', 'no-store').json({ ok: true });
    });

  // Renders only, and carries no secret: the leg id is in the cookie, which the POST below will carry.
  app.get(FRESH_SIGN_IN_CONFIRM_PATH, (_req, res) => { confirmFormPage(res); });

  // Renders only: the token is spent by the confirming POST, so a mail scanner's GET spends nothing.
  app.get(FRESH_SIGN_IN_EMAIL_VERIFY_PATH, (req, res) => {
    const token = req.query.token;
    if (typeof token !== 'string' || !LEG_SECRET.test(token)) return void refusePage(res, 400);
    confirmFormPage(res, token);
  });

  app.post(FRESH_SIGN_IN_CONFIRM_PATH, limiter, form, async (req: Request, res: Response) => {
    try {
      // The leg cookie is single-purpose: clear it whatever the outcome.
      const legCookie = cookieValue(req, CEREMONY_LEG_COOKIE);
      if (legCookie) res.clearCookie(CEREMONY_LEG_COOKIE, cookieOptions(req, FRESH_SIGN_IN_CONFIRM_PATH));
      const token = (req.body as { token?: unknown } | undefined)?.token;
      // An emailed token arrives in the form; an IdP leg id only in its cookie. No URL or form fallback for an IdP leg.
      const [secret, channel] = token !== undefined ? [token, 'email' as const] : [legCookie, 'idp' as const];
      const nonce = cookieValue(req);
      if (!originAllowed(req) || !nonce || typeof secret !== 'string' || !LEG_SECRET.test(secret)) return void refusePage(res);
      if (!(await confirmFreshSignIn(db, { legSecret: secret, browserNonceHash: sha256Hex(nonce), channel }))) return void refusePage(res);
      const back = CEREMONY_NEXT_PAGES[nextPageOf(cookieValue(req, CEREMONY_NEXT_COOKIE))];
      res.status(200).set(PAGE_HEADERS).type('html').send(page('Confirmed',
        `<h1>Confirmed</h1><p>You have not been signed in. Continue on the passkey page in this browser, within 10 minutes.</p>
<p><a href="${back}">Continue</a></p>`));
    } catch (err) {
      Sentry.captureException(err);
      refusePage(res);
    }
  });
}
