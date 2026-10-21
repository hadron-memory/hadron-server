/**
 * #1631 S2a PR1a — the ceremony routes' gate.
 *
 * Mounted only when `signingSurfacePolicy().registration` is on (#1895); while off nothing is
 * mounted, so the paths are ordinary 404s with no switch oracle. Every failure is one uniform
 * 403 `{"error":"forbidden"}`: nothing says whether a proof was missing, forged, expired or consumed.
 *
 * - `register/start` still refuses everyone: a first credential has no passkey to prove with, and
 *   the fresh-IdP/email-bound proof is PR1b.
 * - `revoke/start` is opened only by an existing passkey's assertion over a server-issued challenge:
 *   the challenge is the ceremony id's own random bytes, the browser is the HttpOnly cookie holder
 *   (stored only as its SHA-256), the Origin must be on the SIGNING_CEREMONY_ORIGINS allowlist (an
 *   empty list refuses), and no durable session is minted. A credential counts only while its
 *   enrollment RP ID equals the deployment's (#1631 PR1b, Eden #10470), and each credential has its
 *   own attempt budget across client addresses, on top of the per-IP one.
 *
 * Order for `revoke/start`: load the credential snapshot without locks, verify OUTSIDE any
 * transaction, then in one transaction take the user authority anchor, recheck the live owner and
 * decide against the locked rows (`decideCeremonyAssertion`).
 */
import { createHash, randomBytes } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { db } from '../integrations/db/client.js';
import { lockAuthorityAnchors } from '../lib/auth/authorityAnchors.js';
import { createCeremony, decideCeremonyAssertion, verifyCeremonyAssertion } from '../lib/passkeys/ceremony.js';
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
function cookieValue(req: Request): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=') || null;
  }
  return null;
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

  app.post('/passkeys/register/start', limiter, (_req, res) => { refuse(res); });

  // Issue a challenge to the browser that will answer it. Nothing here proves anyone; it only opens a ceremony.
  app.post(PASSKEY_REVOKE_CHALLENGE_PATH, limiter, async (req, res) => {
    try {
      if (!originAllowed(req)) return void refuse(res);
      const nonce = randomBytes(32).toString('base64url');
      const { id } = await db.$transaction((tx) => createCeremony(tx, {
        purpose: 'STEP_UP_ONLY', browserNonceHash: sha256Hex(nonce), ttlSeconds: CEREMONY_TTL_SECONDS,
        challengeIsId: true,
      }));
      res.cookie(COOKIE, nonce, { httpOnly: true, sameSite: 'strict', secure: req.secure || req.headers.origin?.startsWith('https://') === true, path: '/passkeys', maxAge: CEREMONY_TTL_SECONDS * 1000 });
      res.status(200).set('Cache-Control', 'no-store').json({ ceremonyId: id, challenge: id });
    } catch { refuse(res); }
  });

  app.post('/passkeys/revoke/start', limiter, json, perCredential, async (req: Request, res: Response) => {
    try {
      if (!originAllowed(req)) return void refuse(res);
      const nonce = cookieValue(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const credentialId = b64(body.credentialId, 512);
      const authenticatorData = b64(body.authenticatorData);
      const clientDataJson = b64(body.clientDataJson);
      const signature = b64(body.signature);
      const ceremonyId = typeof body.ceremonyId === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(body.ceremonyId) ? body.ceremonyId : null;
      if (!nonce || !credentialId || !authenticatorData || !clientDataJson || !signature || !ceremonyId) return void refuse(res);

      // Snapshot without locks; the deciding transaction revalidates it under lock.
      const [row] = await db.$queryRaw<Array<{ id: string; owner_id: string; public_key: Buffer; counter: bigint; revoked_at: Date | null; enrollment_rp_id: string }>>`
        SELECT id, owner_id, public_key, counter, revoked_at, enrollment_rp_id FROM passkey_credentials WHERE credential_id = ${credentialId}`;
      const rpId = passkeyRpId();
      // Immutable column, so the unlocked read is final: no decide-time recheck needed.
      if (!row || row.revoked_at !== null || row.enrollment_rp_id !== rpId) return void refuse(res);

      const verified = await verifyCeremonyAssertion({
        assertion: { authenticatorData, clientDataJson, signature },
        credential: { passkeyId: row.id, ownerId: row.owner_id, credentialId, publicKey: row.public_key, counter: row.counter },
        expectedChallenge: Buffer.from(ceremonyId, 'base64url'),
        rpId,
        origins: signingCeremonyOrigins(),
      });

      const decided = await db.$transaction(async (tx) => {
        await lockAuthorityAnchors(tx, [{ kind: 'user', id: row.owner_id }], 'exclusive');
        if (!(await tx.user.findFirst({ where: { id: row.owner_id, deletedAt: null }, select: { id: true } }))) return null;
        return decideCeremonyAssertion(tx, {
          ceremonyId, browserNonceHash: sha256Hex(nonce), purpose: 'STEP_UP_ONLY', verified: verified.snapshot,
        });
      });
      if (!decided) return void refuse(res);
      // PR1a ends here: the proof is valid for this request only. Revocation itself is PR3.
      res.status(200).set('Cache-Control', 'no-store').json({ ok: true });
    } catch { refuse(res); }
  });
}
