/**
 * #1897 slice B1 (cor:aut:030:02): the server-hosted passkey step of an email sign-in.
 *
 * Mounted only when `signingSurfacePolicy().registration` is on (#1895); while off nothing is mounted, so the
 * paths are ordinary 404s with no switch oracle. `/auth/email/verify` creates the pending row
 * ({@link beginPasskeySignIn}) and redirects here; nothing is published until `complete` succeeds.
 *
 * - `GET  /auth/passkey/sign-in`          the page, or the one fixed invalid-flow page. Never completes anything.
 * - `GET  /auth/passkey/sign-in.js`       the page's script (same-origin, so the CSP needs no inline script).
 * - `POST /auth/passkey/sign-in/options`  opens a SIGN_IN ceremony bound to this browser, replacing any earlier one.
 * - `POST /auth/passkey/sign-in/complete` verifies the assertion OUTSIDE any transaction, then in ONE transaction
 *   takes the user authority anchor, decides the ceremony, creates the sign-in, completes the pending row and
 *   (portal) issues the handoff code. Cookies and redirects are produced only after the commit.
 *
 * Every POST failure is one uniform 403 `{"error":"forbidden"}`; the page is one fixed invalid-flow answer for a
 * missing, expired, completed or foreign pending flow.
 */
import { createHash } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { db } from '../integrations/db/client.js';
import { lockAuthorityAnchors } from '../lib/auth/authorityAnchors.js';
import { createCeremony, decideCeremonyAssertion, verifyCeremonyAssertion } from '../lib/passkeys/ceremony.js';
import { passkeyRpId, signingCeremonyOrigins } from '../lib/signing/config.js';
import { signingSurfacePolicy } from '../lib/signing/surface.js';
import { verifiedLoginEvidence } from '../auth/loginEvidence.js';
import { issueLoginCode } from '../auth/authHandoff.js';
import { signJwt } from '../auth/jwt.js';
import { createSignIn } from '../auth/signIn.js';
import {
  completePending, createPendingEmailSignIn, loadLivePending, setPendingCeremony, sweepPendingEmailSignIns,
  PENDING_EMAIL_SIGN_IN_TTL_SECONDS, type PendingContinuation,
} from '../auth/pendingEmailSignIn.js';

export const PENDING_SIGN_IN_COOKIE = 'hadron_pending_signin';
export const PASSKEY_SIGN_IN_PATH = '/auth/passkey/sign-in';
const COOKIE_PATH = '/auth/passkey';
const CEREMONY_TTL_SECONDS = 300;
/** Requests a minute per client IP, across the sign-in routes. */
export const PASSKEY_SIGN_IN_RATE_LIMIT_PER_MINUTE = 30;
/** complete attempts per credential per 15 minutes, whatever client address they come from. */
export const PASSKEY_SIGN_IN_PER_CREDENTIAL_LIMIT = 10;

const sha256Hex = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const refuse = (res: Response) => res.status(403).type('application/json').set('Cache-Control', 'no-store').send('{"error":"forbidden"}');
const b64 = (v: unknown, max = 4096): Buffer | null => {
  if (typeof v !== 'string' || v.length === 0 || v.length > max || !/^[A-Za-z0-9_-]+$/.test(v)) return null;
  return Buffer.from(v, 'base64url');
};

function pendingCookie(req: Request): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === PENDING_SIGN_IN_COOKIE) return v.join('=') || null;
  }
  return null;
}

/** Exact allowlist match on the Origin header; absent or unlisted refuses, and an empty allowlist refuses. */
function originAllowed(req: Request): string | null {
  const origin = req.headers.origin;
  return typeof origin === 'string' && signingCeremonyOrigins().includes(origin) ? origin : null;
}

const secureCookie = (req: Request) => process.env.NODE_ENV === 'production' || req.secure;

/** Does this user have a passkey that can answer a sign-in here: live, enrolled for this deployment's RP ID? */
export async function userHasUsablePasskey(userId: string): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ n: number }>>`SELECT 1 AS n FROM passkey_credentials
    WHERE owner_id = ${userId} AND revoked_at IS NULL AND enrollment_rp_id = ${passkeyRpId()} LIMIT 1`;
  return rows.length > 0;
}

/**
 * Called by `/auth/email/verify` when the registration switch is on and the claimed address belongs to a user.
 * Creates the pending row, sets its cookie and redirects to the page. Publishes nothing. Returns false (and writes
 * nothing) when the user has no usable passkey, so the caller can show the fixed refusal; enrollment is B2.
 */
export async function beginPasskeySignIn(
  req: Request, res: Response,
  input: { userId: string; continuation: PendingContinuation },
): Promise<boolean> {
  if (!(await userHasUsablePasskey(input.userId))) return false;
  await sweepPendingEmailSignIns(db).catch(() => undefined);
  const { cookieSecret } = await createPendingEmailSignIn(db, input);
  res.cookie(PENDING_SIGN_IN_COOKIE, cookieSecret, {
    httpOnly: true, sameSite: 'lax', secure: secureCookie(req), path: COOKIE_PATH, maxAge: PENDING_EMAIL_SIGN_IN_TTL_SECONDS * 1000,
  });
  res.redirect(PASSKEY_SIGN_IN_PATH);
  return true;
}

const SECURITY_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in</title></head><body><main><h1>Confirm it's you</h1><p>Use your passkey to finish signing in.</p><button id="go" type="button">Use passkey</button><p id="msg" role="status"></p></main><script src="${PASSKEY_SIGN_IN_PATH}.js"></script></body></html>`;
const INVALID_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in</title></head><body><main><h1>This sign-in link can't be used</h1><p>It may have expired or already been used. Start again from the sign-in page.</p></main></body></html>`;

const SCRIPT = `(()=>{
const b2u=(b)=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
const u2b=(s)=>{s=s.replace(/-/g,'+').replace(/_/g,'/');const p=atob(s+'==='.slice((s.length+3)%4));return Uint8Array.from(p,(c)=>c.charCodeAt(0)).buffer;};
const msg=document.getElementById('msg');const go=document.getElementById('go');
const post=(p,b)=>fetch(p,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(b||{})});
go.addEventListener('click',async()=>{
 go.disabled=true;msg.textContent='';
 try{
  const o=await post('${PASSKEY_SIGN_IN_PATH}/options');if(!o.ok)throw 0;const opt=await o.json();
  const cred=await navigator.credentials.get({publicKey:{challenge:u2b(opt.challenge),rpId:opt.rpId,userVerification:'required',timeout:120000,
   allowCredentials:opt.allowCredentials.map((id)=>({type:'public-key',id:u2b(id)}))}});
  const r=cred.response;
  const c=await post('${PASSKEY_SIGN_IN_PATH}/complete',{ceremonyId:opt.ceremonyId,credentialId:b2u(cred.rawId),authenticatorData:b2u(r.authenticatorData),clientDataJson:b2u(r.clientDataJSON),signature:b2u(r.signature)});
  if(!c.ok)throw 0;const out=await c.json();window.location.assign(out.next);
 }catch(e){msg.textContent='That did not work. Try again, or start over from the sign-in page.';go.disabled=false;}
});
})();`;

/** Mount the sign-in routes when the registration switch is on; the switch is read once, at mount. */
export function mountPasskeySignInRoutes(app: Express, env: NodeJS.ProcessEnv = process.env): void {
  if (!signingSurfacePolicy(env).registration) return;
  const limiter = rateLimit({
    windowMs: 60_000, limit: PASSKEY_SIGN_IN_RATE_LIMIT_PER_MINUTE, standardHeaders: false, legacyHeaders: false,
    handler: (_req, res) => { res.status(429).end(); },
  });
  const json = express.json({ limit: '16kb' });
  const perCredential = rateLimit({
    windowMs: 15 * 60_000, limit: PASSKEY_SIGN_IN_PER_CREDENTIAL_LIMIT, standardHeaders: false, legacyHeaders: false,
    skip: (req) => !b64((req.body as Record<string, unknown> | undefined)?.credentialId, 512),
    keyGenerator: (req) => `credential:${sha256Hex(b64((req.body as Record<string, unknown>).credentialId, 512)!)}`,
    handler: (_req, res) => { res.status(429).end(); },
  });
  const perPending = rateLimit({
    windowMs: 15 * 60_000, limit: PASSKEY_SIGN_IN_PER_CREDENTIAL_LIMIT, standardHeaders: false, legacyHeaders: false,
    skip: (req) => !pendingCookie(req),
    keyGenerator: (req) => `pending:${sha256Hex(pendingCookie(req)!)}`,
    handler: (_req, res) => { res.status(429).end(); },
  });

  app.get(PASSKEY_SIGN_IN_PATH, limiter, async (req, res) => {
    res.set(SECURITY_HEADERS).type('html');
    try {
      const live = await loadLivePending(db, pendingCookie(req));
      res.status(live ? 200 : 400).send(live ? PAGE : INVALID_PAGE);
    } catch { res.status(400).send(INVALID_PAGE); }
  });

  app.get(`${PASSKEY_SIGN_IN_PATH}.js`, limiter, (_req, res) => {
    res.set(SECURITY_HEADERS).type('application/javascript').status(200).send(SCRIPT);
  });

  // Open a ceremony for the browser that holds the pending cookie. Proves nothing; the assertion does.
  app.post(`${PASSKEY_SIGN_IN_PATH}/options`, limiter, perPending, async (req, res) => {
    try {
      if (!originAllowed(req)) return void refuse(res);
      const cookie = pendingCookie(req);
      const issued = await db.$transaction(async (tx) => {
        const pending = await loadLivePending(tx, cookie, { forUpdate: true });
        if (!pending) return null;
        // One bounded challenge per flow: an earlier ceremony of this pending row can no longer be used.
        if (pending.ceremonyId) {
          await tx.$executeRaw`UPDATE passkey_ceremonies SET consumed_at = (clock_timestamp() AT TIME ZONE 'UTC')
            WHERE id = ${pending.ceremonyId} AND consumed_at IS NULL`;
        }
        const { id } = await createCeremony(tx, {
          purpose: 'SIGN_IN', browserNonceHash: pending.browserHash, ttlSeconds: CEREMONY_TTL_SECONDS, challengeIsId: true,
        });
        await setPendingCeremony(tx, pending.id, id);
        const creds = await tx.$queryRaw<Array<{ credential_id: Buffer }>>`SELECT credential_id FROM passkey_credentials
          WHERE owner_id = ${pending.userId} AND revoked_at IS NULL AND enrollment_rp_id = ${passkeyRpId()}`;
        return { id, allowCredentials: creds.map((c) => Buffer.from(c.credential_id).toString('base64url')) };
      });
      if (!issued || issued.allowCredentials.length === 0) return void refuse(res);
      res.status(200).set('Cache-Control', 'no-store').json({
        ceremonyId: issued.id, challenge: issued.id, rpId: passkeyRpId(), allowCredentials: issued.allowCredentials,
      });
    } catch { refuse(res); }
  });

  app.post(`${PASSKEY_SIGN_IN_PATH}/complete`, limiter, json, perCredential, perPending, async (req: Request, res: Response) => {
    try {
      if (!originAllowed(req)) return void refuse(res);
      const cookie = pendingCookie(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const credentialId = b64(body.credentialId, 512);
      const authenticatorData = b64(body.authenticatorData);
      const clientDataJson = b64(body.clientDataJson);
      const signature = b64(body.signature);
      const ceremonyId = typeof body.ceremonyId === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(body.ceremonyId) ? body.ceremonyId : null;
      if (!cookie || !credentialId || !authenticatorData || !clientDataJson || !signature || !ceremonyId) return void refuse(res);

      // Snapshots without locks; the deciding transaction revalidates them under lock.
      const pendingSnap = await loadLivePending(db, cookie);
      if (!pendingSnap || pendingSnap.ceremonyId !== ceremonyId) return void refuse(res);
      const [row] = await db.$queryRaw<Array<{ id: string; owner_id: string; public_key: Buffer; counter: bigint; revoked_at: Date | null; enrollment_rp_id: string }>>`
        SELECT id, owner_id, public_key, counter, revoked_at, enrollment_rp_id FROM passkey_credentials WHERE credential_id = ${credentialId}`;
      const rpId = passkeyRpId();
      // The credential must belong to the user this pending flow is for: the client's userHandle supplies no authority.
      if (!row || row.revoked_at !== null || row.enrollment_rp_id !== rpId || row.owner_id !== pendingSnap.userId) return void refuse(res);

      const verified = await verifyCeremonyAssertion({
        assertion: { authenticatorData, clientDataJson, signature },
        credential: { passkeyId: row.id, ownerId: row.owner_id, credentialId, publicKey: row.public_key, counter: row.counter },
        expectedChallenge: Buffer.from(ceremonyId, 'base64url'),
        rpId,
        origins: signingCeremonyOrigins(),
      });

      const done = await db.$transaction(async (tx) => {
        await lockAuthorityAnchors(tx, [{ kind: 'user', id: row.owner_id }], 'exclusive');
        const user = await tx.user.findFirst({ where: { id: row.owner_id, deletedAt: null } });
        if (!user) return null;
        const pending = await loadLivePending(tx, cookie, { forUpdate: true });
        if (!pending || pending.id !== pendingSnap.id || pending.userId !== user.id || pending.ceremonyId !== ceremonyId) return null;
        const decided = await decideCeremonyAssertion(tx, {
          ceremonyId, browserNonceHash: pending.browserHash, purpose: 'SIGN_IN', verified: verified.snapshot,
        });
        if (!decided || decided.ownerId !== user.id) return null;
        const signIn = await createSignIn(tx, { userId: user.id, method: 'email', passkeyId: decided.passkeyId });
        if (!(await completePending(tx, pending.id, signIn.id))) return null;
        const login = await verifiedLoginEvidence(db, 'email');
        if (pending.continuation === 'PORTAL') {
          const code = await issueLoginCode({
            login, userId: user.id, redirect: pending.redirect ?? '/', isNew: pending.isNew ?? false,
            clientStateHash: pending.clientStateHash, signInId: signIn.id,
          }, tx);
          return { kind: 'PORTAL' as const, code };
        }
        return { kind: 'OAUTH' as const, user, signInId: signIn.id, login, returnTo: pending.returnTo! };
      });
      if (!done) return void refuse(res);

      res.clearCookie(PENDING_SIGN_IN_COOKIE, { path: COOKIE_PATH });
      if (done.kind === 'PORTAL') {
        const callbackUrl = new URL('/auth/callback', process.env.FRONTEND_URL || 'http://localhost:5173');
        callbackUrl.searchParams.set('code', done.code);
        return void res.status(200).set('Cache-Control', 'no-store').json({ next: callbackUrl.toString() });
      }
      const u = done.user;
      const jwt = await signJwt({
        login: done.login, sid: done.signInId, sub: u.id,
        roles: u.roles as ('OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER')[],
        ...(u.email ? { email: u.email } : {}),
      });
      const exp = JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString()).exp as number | undefined;
      res.cookie('hadron_token', jwt, {
        httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax',
        maxAge: exp ? exp * 1000 - Date.now() : 7 * 24 * 60 * 60 * 1000, path: '/',
      });
      res.status(200).set('Cache-Control', 'no-store').json({ next: done.returnTo });
    } catch { refuse(res); }
  });
}
