/**
 * #1631 S2a PR1a — the ceremony routes' gate.
 *
 * Mounted only when `signingSurfacePolicy().registration` is on (#1895); while off nothing is
 * mounted, so the paths are ordinary 404s with no switch oracle. Every failure is one uniform
 * 403 `{"error":"forbidden"}`: nothing says whether a proof was missing, forged, expired or consumed.
 *
 * - Registration (#1631 PR2, cor:aut:040:02): `register/challenge` opens a REGISTER ceremony;
 *   `register/start` binds it, from the ONE fresh sign-in on this browser (a first passkey) or from an
 *   out-of-window passkey's assertion (a later one), and returns the creation options naming whose
 *   account it is; `register/finish` verifies the creation response and registers. No bearer
 *   credential, session cookie or request field ever names the user. See `lib/passkeys/registration.ts`.
 * - `window/end` (cor:aut:040:07): this browser's one fresh sign-in, by a method other than the
 *   registration's, ends its user's first passkey's cooling-off window early.
 * - The cancel link (cor:aut:040:08, Exceptions): `GET /passkeys/cancel` only renders; the POST
 *   revokes a first passkey in its window, once, with no sign-in, and ends the sign-ins it completed.
 * - Revocation (#1631 PR3, cor:aut:040:08): `revoke/challenge` opens a REVOKE ceremony; `revoke/start`
 *   binds it to the owner by another passkey's assertion over the ceremony's challenge (the ceremony id's
 *   own random bytes; a credential counts only while its enrollment RP ID equals the deployment's, #2202,
 *   and each has its own attempt budget across client addresses) or by this browser's ONE fresh
 *   identity-provider sign-in, and lists the owner's passkeys; `revoke/finish` revokes one of them, never
 *   the prover. The browser is the HttpOnly cookie holder (stored only as its SHA-256), the Origin must be
 *   on the SIGNING_CEREMONY_ORIGINS allowlist (an empty list refuses), and no durable session is minted.
 *   See `lib/passkeys/revoke.ts` for the order of verification, anchor and decision.
 */
import { createHash, randomBytes } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { db } from '../integrations/db/client.js';
import { createCeremony } from '../lib/passkeys/ceremony.js';
import { bindRevokeByIdp, bindRevokeByPasskey, finishRevoke } from '../lib/passkeys/revoke.js';
import { bindFirstRegistration, bindLaterRegistration, finishRegistration, firstPasskeyWindowHours, type RegistrationBinding } from '../lib/passkeys/registration.js';
import { CANCEL_TOKEN, cancelFirstPasskey } from '../lib/passkeys/cancel.js';
import { endWindowEarly, previewWindowEnd } from '../lib/passkeys/endWindow.js';
import { CEREMONY_BROWSER_COOKIE, clearCeremonyBrowserCookie } from './freshSignInRoutes.js';
import { sendPage } from './ceremonyPages.js';
import { mountCeremonyClientPages } from './ceremonyClientPages.js';
import { PASSKEY_CANCEL_PATH } from '../jobs/sendPasskeyRegistrationNotices.js';
import { passkeyRpId, signingCeremonyOrigins } from '../lib/signing/config.js';
import { signingSurfacePolicy } from '../lib/signing/surface.js';

export const PASSKEY_CEREMONY_START_PATHS = ['/passkeys/register/start', '/passkeys/revoke/start'] as const;
export const PASSKEY_REVOKE_CHALLENGE_PATH = '/passkeys/revoke/challenge';
const COOKIE = 'hadron_ceremony';
const CEREMONY_TTL_SECONDS = 300;
/** Requests a minute per client IP, across the ceremony routes. */
export const PASSKEY_CEREMONY_RATE_LIMIT_PER_MINUTE = 30;
/** revoke/start attempts per credential per 15 minutes, whatever client address they come from. */
export const PASSKEY_REVOKE_PER_CREDENTIAL_LIMIT = 10;

const sha256Hex = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const refuse = (res: Response) => res.status(403).type('application/json').set('Cache-Control', 'no-store').send('{"error":"forbidden"}');

/** The browser's cookie value, parsed locally so route order never depends on a global parser. */
function cookieValue(req: Request, name = COOKIE): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=') || null;
  }
  return null;
}

export const PASSKEY_REGISTER_CHALLENGE_PATH = '/passkeys/register/challenge';
export const PASSKEY_REGISTER_FINISH_PATH = '/passkeys/register/finish';
export const PASSKEY_END_WINDOW_PATH = '/passkeys/window/end';
export const PASSKEY_REVOKE_FINISH_PATH = '/passkeys/revoke/finish';
/** Cancel POSTs a minute per client IP. */
export const PASSKEY_CANCEL_RATE_LIMIT_PER_MINUTE = 10;
const RP_NAME = 'Hadron';
const ceremonyIdOf = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(v) ? v : null);

/** WebAuthn creation options for a bound ceremony. The page shows `user.name` before the prompt (Rook Q2.3). */
function creationOptions(ceremonyId: string, b: RegistrationBinding, rpId: string) {
  return {
    rp: { id: rpId, name: RP_NAME },
    user: { id: b.userHandle.toString('base64url'), name: b.handle, displayName: b.handle },
    challenge: ceremonyId,
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    // cor:aut:040:05: every credential is discoverable; the vouch flow asks with an empty allowCredentials.
    authenticatorSelection: { userVerification: 'required', residentKey: 'required', requireResidentKey: true },
    extensions: { credProps: true },
    attestation: 'none',
    excludeCredentials: b.excludeCredentialIds.map((id) => ({ type: 'public-key', id: id.toString('base64url') })),
    timeout: CEREMONY_TTL_SECONDS * 1000,
  };
}

/** Exact allowlist match on the Origin header; absent or unlisted refuses, and an empty allowlist refuses. */
function originAllowed(req: Request): string | null {
  const origin = req.headers.origin;
  return typeof origin === 'string' && signingCeremonyOrigins().includes(origin) ? origin : null;
}

const b64 = (v: unknown, max = 4096): Buffer | null => {
  if (typeof v !== 'string' || v.length === 0 || v.length > max || !/^[A-Za-z0-9_-]+$/.test(v)) return null;
  return Buffer.from(v, 'base64url');
};

/** Mount the ceremony routes when the registration switch is on; the switch is read once, at mount. */
export function mountPasskeyCeremonyRoutes(app: Express, env: NodeJS.ProcessEnv = process.env): void {
  if (!signingSurfacePolicy(env).registration) return;
  // cor:aut:040:07: a misconfigured window (shorter than 72 hours, or not an integer) fails here, at boot.
  const windowHours = firstPasskeyWindowHours(env);
  mountCeremonyClientPages(app, { windowHours });
  const limiter = rateLimit({
    windowMs: 60_000, limit: PASSKEY_CEREMONY_RATE_LIMIT_PER_MINUTE, standardHeaders: false, legacyHeaders: false,
    handler: (_req, res) => { res.status(429).end(); },
  });
  const json = express.json({ limit: '16kb' });
  // Keyed on the DECODED credential id, so base64url spellings of the same bytes share one budget.
  // A body with no usable id is skipped here: it is refused anyway, and the per-IP limiter still counts it.
  const perCredential = rateLimit({
    windowMs: 15 * 60_000, limit: PASSKEY_REVOKE_PER_CREDENTIAL_LIMIT, standardHeaders: false, legacyHeaders: false,
    skip: (req) => !b64((req.body as Record<string, unknown> | undefined)?.credentialId, 512),
    keyGenerator: (req) => `credential:${sha256Hex(b64((req.body as Record<string, unknown>).credentialId, 512)!)}`,
    handler: (_req, res) => { res.status(429).end(); },
  });

  const cancelLimiter = rateLimit({
    windowMs: 60_000, limit: PASSKEY_CANCEL_RATE_LIMIT_PER_MINUTE, standardHeaders: false, legacyHeaders: false,
    handler: (_req, res) => { res.status(429).end(); },
  });
  const ceremonyCookie = (req: Request) => ({
    httpOnly: true, sameSite: 'strict' as const, path: '/passkeys',
    secure: req.secure || req.headers.origin?.startsWith('https://') === true,
  });

  // Open a REGISTER ceremony for this browser. Nothing here proves anyone or names a user.
  app.post(PASSKEY_REGISTER_CHALLENGE_PATH, limiter, async (req, res) => {
    try {
      if (!originAllowed(req)) return void refuse(res);
      const nonce = randomBytes(32).toString('base64url');
      const { id } = await db.$transaction((tx) => createCeremony(tx, {
        purpose: 'REGISTER', browserNonceHash: sha256Hex(nonce), ttlSeconds: CEREMONY_TTL_SECONDS, challengeIsId: true,
      }));
      res.cookie(COOKIE, nonce, { ...ceremonyCookie(req), maxAge: CEREMONY_TTL_SECONDS * 1000 });
      res.status(200).set('Cache-Control', 'no-store').json({ ceremonyId: id, challenge: id });
    } catch { refuse(res); }
  });

  // The step begins here: bind the ceremony to who registers and which kind, then return the creation options.
  // The user comes ONLY from this browser's fresh sign-in or from the vouching passkey's owner, never from a bearer
  // credential, a session cookie or a request field (Rook Q2.2).
  app.post('/passkeys/register/start', limiter, json, async (req: Request, res: Response) => {
    try {
      if (!originAllowed(req)) return void refuse(res);
      const nonce = cookieValue(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const ceremonyId = ceremonyIdOf(body.ceremonyId);
      if (!nonce || !ceremonyId) return void refuse(res);
      const rpId = passkeyRpId();
      let bound: RegistrationBinding | null;
      if (body.vouch !== undefined) {
        const v = (body.vouch ?? {}) as Record<string, unknown>;
        const credentialId = b64(v.credentialId, 512);
        const authenticatorData = b64(v.authenticatorData);
        const clientDataJson = b64(v.clientDataJson);
        const signature = b64(v.signature);
        if (!credentialId || !authenticatorData || !clientDataJson || !signature) return void refuse(res);
        bound = await bindLaterRegistration(db, {
          ceremonyId, ceremonyNonceHash: sha256Hex(nonce), vouch: { credentialId, authenticatorData, clientDataJson, signature },
          rpId, origins: signingCeremonyOrigins(),
        });
      } else {
        const signInNonce = cookieValue(req, CEREMONY_BROWSER_COOKIE);
        if (!signInNonce) return void refuse(res);
        bound = await bindFirstRegistration(db, { ceremonyId, ceremonyNonceHash: sha256Hex(nonce), signInBrowserHash: sha256Hex(signInNonce) });
      }
      if (!bound) return void refuse(res);
      res.status(200).set('Cache-Control', 'no-store').json({ publicKey: creationOptions(ceremonyId, bound, rpId), account: { handle: bound.handle } });
    } catch { refuse(res); }
  });

  app.post(PASSKEY_REGISTER_FINISH_PATH, limiter, express.json({ limit: '64kb' }), async (req: Request, res: Response) => {
    try {
      if (!originAllowed(req)) return void refuse(res);
      const nonce = cookieValue(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const ceremonyId = ceremonyIdOf(body.ceremonyId);
      const response = body.response;
      if (!nonce || !ceremonyId || typeof response !== 'object' || response === null || typeof body.label !== 'string') return void refuse(res);
      const signInNonce = cookieValue(req, CEREMONY_BROWSER_COOKIE);
      const registered = await finishRegistration(db, {
        ceremonyId, ceremonyNonceHash: sha256Hex(nonce), signInBrowserHash: signInNonce ? sha256Hex(signInNonce) : null,
        response: response as Parameters<typeof finishRegistration>[1]['response'], label: body.label,
        rpId: passkeyRpId(), origins: signingCeremonyOrigins(), windowHours,
      });
      if (!registered) return void refuse(res);
      // The ceremony and the fresh sign-in are spent: clear both browser cookies.
      res.clearCookie(COOKIE, ceremonyCookie(req));
      clearCeremonyBrowserCookie(req, res);
      res.status(200).set('Cache-Control', 'no-store').json({ ok: true, kind: registered.kind });
    } catch { refuse(res); }
  });

  // End a first passkey's window early (cor:aut:040:07): the acting user is this browser's ONE fresh sign-in, whose
  // method must differ from the registration's. No bearer, session or request field names the user or the passkey.
  app.post(PASSKEY_END_WINDOW_PATH, limiter, async (req: Request, res: Response) => {
    try {
      if (!originAllowed(req)) return void refuse(res);
      const signInNonce = cookieValue(req, CEREMONY_BROWSER_COOKIE);
      if (!signInNonce) return void refuse(res);
      const ended = await endWindowEarly(db, { signInBrowserHash: sha256Hex(signInNonce) });
      if (!ended) return void refuse(res);
      clearCeremonyBrowserCookie(req, res);
      res.status(200).set('Cache-Control', 'no-store').json({ ok: true });
    } catch { refuse(res); }
  });

  // What window/end would act on, shown before the POST so a person talked into confirming sees a passkey they never
  // added (Rook P3-2). Spends nothing; the same identity source and refusal as window/end.
  app.post('/passkeys/window/preview', limiter, async (req: Request, res: Response) => {
    try {
      if (!originAllowed(req)) return void refuse(res);
      const signInNonce = cookieValue(req, CEREMONY_BROWSER_COOKIE);
      const preview = signInNonce ? await previewWindowEnd(db, { signInBrowserHash: sha256Hex(signInNonce) }) : null;
      if (!preview) return void refuse(res);
      const methods: Record<string, string> = { github: 'GitHub', google: 'Google', apple: 'Apple', email: 'an email link' };
      res.status(200).set('Cache-Control', 'no-store').json({ label: preview.label, registeredAt: preview.registeredAt.toISOString(), method: methods[preview.method] ?? preview.method });
    } catch { refuse(res); }
  });

  // Uma P2-2: "Not my account: stop" forgets this browser's ceremony and confirmation. Nothing is registered; a
  // spent sign-in stays spent.
  app.post('/passkeys/register/stop', limiter, (req: Request, res: Response) => {
    if (!originAllowed(req)) return void refuse(res);
    res.clearCookie(COOKIE, ceremonyCookie(req));
    clearCeremonyBrowserCookie(req, res);
    res.status(200).set('Cache-Control', 'no-store').json({ ok: true });
  });

  // The cancel link. The GET only renders, so a mail scanner spends nothing; the POST is the cancel.
  app.get(PASSKEY_CANCEL_PATH, (req, res) => {
    const token = req.query.token;
    if (typeof token !== 'string' || !CANCEL_TOKEN.test(token)) return void cancelRefused(res, 400);
    sendPage(res, 200, 'Remove this passkey', `<h1>Remove this passkey?</h1>
<p>This removes the passkey that was just added to your Hadron account, and signs out any sessions it started. Do it if you did not add it.</p>
<form method="post" action="${PASSKEY_CANCEL_PATH}"><input type="hidden" name="token" value="${token}">
<button type="submit">Remove this passkey</button></form>`);
  });

  app.post(PASSKEY_CANCEL_PATH, cancelLimiter, express.urlencoded({ extended: false, limit: '4kb' }), async (req: Request, res: Response) => {
    try {
      const token = (req.body as { token?: unknown } | undefined)?.token;
      if (!originAllowed(req) || typeof token !== 'string') return void cancelRefused(res);
      const userAgent = String(req.headers['user-agent'] ?? '').slice(0, 512) || 'unknown';
      if (!(await cancelFirstPasskey(db, { token, ip: req.ip ?? 'unknown', userAgent }))) return void cancelRefused(res);
      sendPage(res, 200, 'Passkey removed', '<h1>Passkey removed</h1><p>The passkey was removed, and any sessions it started are signed out. Nothing it signed will count.</p>');
    } catch { cancelRefused(res); }
  });

  // Open a REVOKE ceremony for this browser. Nothing here proves anyone; it only opens a ceremony.
  app.post(PASSKEY_REVOKE_CHALLENGE_PATH, limiter, async (req, res) => {
    try {
      if (!originAllowed(req)) return void refuse(res);
      const nonce = randomBytes(32).toString('base64url');
      const { id } = await db.$transaction((tx) => createCeremony(tx, {
        purpose: 'REVOKE', browserNonceHash: sha256Hex(nonce), ttlSeconds: CEREMONY_TTL_SECONDS, challengeIsId: true,
      }));
      res.cookie(COOKIE, nonce, { ...ceremonyCookie(req), maxAge: CEREMONY_TTL_SECONDS * 1000 });
      res.status(200).set('Cache-Control', 'no-store').json({ ceremonyId: id, challenge: id });
    } catch { refuse(res); }
  });

  // #1631 PR3 (cor:aut:040:08): prove who you are, binding the REVOKE ceremony to the owner, and get the owner's
  // passkeys. The proof is another passkey's assertion (body) or, with none in the body, this browser's ONE fresh
  // identity-provider sign-in (never a magic link). No bearer credential, session or body field names the user.
  app.post('/passkeys/revoke/start', limiter, json, perCredential, async (req: Request, res: Response) => {
    try {
      if (!originAllowed(req)) return void refuse(res);
      const nonce = cookieValue(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const ceremonyId = ceremonyIdOf(body.ceremonyId);
      if (!nonce || !ceremonyId) return void refuse(res);
      let bound;
      if (body.credentialId !== undefined) {
        const credentialId = b64(body.credentialId, 512);
        const authenticatorData = b64(body.authenticatorData);
        const clientDataJson = b64(body.clientDataJson);
        const signature = b64(body.signature);
        if (!credentialId || !authenticatorData || !clientDataJson || !signature) return void refuse(res);
        bound = await bindRevokeByPasskey(db, {
          ceremonyId, ceremonyNonceHash: sha256Hex(nonce), proof: { credentialId, authenticatorData, clientDataJson, signature },
          rpId: passkeyRpId(), origins: signingCeremonyOrigins(),
        });
      } else {
        const signInNonce = cookieValue(req, CEREMONY_BROWSER_COOKIE);
        if (!signInNonce) return void refuse(res);
        bound = await bindRevokeByIdp(db, { ceremonyId, ceremonyNonceHash: sha256Hex(nonce), signInBrowserHash: sha256Hex(signInNonce) });
      }
      if (!bound) return void refuse(res);
      res.status(200).set('Cache-Control', 'no-store').json({
        passkeys: bound.passkeys.map((p) => ({
          credentialId: p.credentialId.toString('base64url'), label: p.label, registeredAt: p.registeredAt.toISOString(),
          lastUsedAt: p.lastUsedAt?.toISOString() ?? null, revokedAt: p.revokedAt?.toISOString() ?? null,
          inWindow: p.inWindow, prover: p.prover,
          cancel: p.cancel ? { at: p.cancel.at.toISOString(), ip: p.cancel.ip, userAgent: p.cancel.userAgent } : null,
        })),
      });
    } catch { refuse(res); }
  });

  // Revoke one of the owner's passkeys, consuming the bound ceremony, and end the sign-ins it completed (cor:aut:040:08;
  // Holger, 2026-10-21, #29507).
  app.post(PASSKEY_REVOKE_FINISH_PATH, limiter, json, async (req: Request, res: Response) => {
    try {
      if (!originAllowed(req)) return void refuse(res);
      const nonce = cookieValue(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const ceremonyId = ceremonyIdOf(body.ceremonyId);
      const target = b64(body.credentialId, 512);
      if (!nonce || !ceremonyId || !target) return void refuse(res);
      const signInNonce = cookieValue(req, CEREMONY_BROWSER_COOKIE);
      const done = await finishRevoke(db, {
        ceremonyId, ceremonyNonceHash: sha256Hex(nonce), signInBrowserHash: signInNonce ? sha256Hex(signInNonce) : null,
        targetCredentialId: target,
      });
      if (!done) return void refuse(res);
      res.clearCookie(COOKIE, ceremonyCookie(req));
      clearCeremonyBrowserCookie(req, res);
      res.status(200).set('Cache-Control', 'no-store').json({ ok: true, windowCancelled: done.windowCancelled });
    } catch { refuse(res); }
  });
}

/** One answer for an unknown, used or out-of-window cancel link (Rook 6316353964): it says nothing about which. */
function cancelRefused(res: Response, status = 403): void {
  // Uma P2-3: one answer for every refusal, but never a dead end.
  sendPage(res, status, 'Link not usable', `<h1>This link can't be used</h1><p>It may have been used already, or the passkey's cooling-off window has ended.</p>
<p><strong>If you didn't add this passkey</strong>, sign in to Hadron and remove it from your account's passkeys, or contact Hadron support.</p>`);
}
