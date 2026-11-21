import type { Request, RequestHandler } from 'express';
import { errors as joseErrors } from 'jose';
import type { PrismaClient } from '../generated/prisma/index.js';
import { verifyAuthenticatedJwt, SignInNotLive } from './signIn.js';
import { admitRate, RateLimited } from '../lib/rateLimit/index.js';
import { transportRateIdentity } from '../lib/rateLimit/identity.js';
import { respondOAuthServerError } from '../lib/internalFault.js';

/** #419: authentication evidence is never a claimed body/query user, OAuth client id or one-use code.
 * JWT-authenticated routes use exactly their handler’s credential source (cookie OR bearer);
 * an unrelated header cannot hide an authenticated consent cookie. Pre-auth routes use IP only.
 * None authenticates an API key, so there is no key dimension. A JWT may
 * contribute a principal only after verification and a live-account check. Invalid credentials
 * remain anonymous for admission; the original handler still gives its existing auth refusal.
 */
type CredentialSource = 'none' | 'bearer' | 'cookie';
async function authRateIdentity(req: Request, db: PrismaClient, source: CredentialSource) {
  const bearer = req.headers.authorization;
  const token = source === 'cookie' ? req.cookies?.hadron_token
    : source === 'bearer' && bearer?.startsWith('Bearer ') ? bearer.slice(7) : undefined;
  let userId: string | undefined;
  if (typeof token === 'string' && token) {
    try {
      const payload = await verifyAuthenticatedJwt(token, db);
      // These endpoints do not accept support impersonation as authentication. Do not charge its target.
      if (!payload.imp && typeof payload.sub === 'string' && payload.sub &&
          await db.user.findFirst({ where: { id: payload.sub, deletedAt: null }, select: { id: true } })) {
        userId = payload.sub;
      }
    } catch (error) {
      // Database/configuration/programming failures must not masquerade as an invalid credential.
      if (!(error instanceof joseErrors.JOSEError) && !(error instanceof SignInNotLive)) throw error;
    }
  }
  return transportRateIdentity({ userId }, req.ip);
}

/** #419 auth-route adoption of #1793: one committed admission BEFORE handler effects; never
 * refund an admitted attempt when a provider fails or the client disconnects. The shared core
 * owns policy modes, windows, HMAC subjects, atomic counters and store-outage decisions.
 * This adapter changes no policy and grants no permission to activate ENFORCING.
 */
export function buildAuthRateAdmission(
  db: PrismaClient, protocol: 'rest' | 'oauth' = 'rest', source: CredentialSource = 'none',
): RequestHandler {
  return async (req, res, next) => {
    try {
      // Holger's #419 contract includes token refresh and /auth/me in this SAME CREDENTIALS/IP budget
      // (approved seed: 60/IP per 900s). A NAT-heavy client can exhaust interactive-login capacity;
      // Ada #128137 accepts that rollout risk, not activation. LOG_ONLY first; policy tuning is separate.
      // Contract and risk evidence: https://hadronmemory.com/app/u/hrn:node:hadronmemory.com:hadron-server:ops:auth-rate-admission-419
      await admitRate(db, 'CREDENTIALS', await authRateIdentity(req, db, source));
      next();
    } catch (error) {
      if (!(error instanceof RateLimited)) {
        if (protocol === 'oauth') respondOAuthServerError(res, 'Authentication admission failed.', error);
        else next(error);
        return;
      }
      // Intentional #1793 contract (Holger comment6549880032, CHECKED6549891443): unreadable policy
      // refuses closed classes in BOTH modes, even LOG_ONLY, without a cached mode. CREDENTIALS
      // therefore returns RATE_LIMITED/Retry-After 900 during that outage; LOG_ONLY is no availability promise.
      // Accepted outage semantics: https://hadronmemory.com/app/u/hrn:node:hadronmemory.com:hadron-server:ops:auth-rate-admission-419
      const retryAfterSeconds = error.extensions.retryAfterSeconds as number;
      res.set({ 'Retry-After': String(retryAfterSeconds), 'Cache-Control': 'no-store' });
      res.status(429).json({
        error: protocol === 'oauth' ? 'temporarily_unavailable' : 'RATE_LIMITED',
        ...(protocol === 'oauth' ? { error_description: 'Too many requests.' } : {}),
        code: 'RATE_LIMITED', fieldClass: 'CREDENTIALS', retryAfterSeconds,
      });
    }
  };
}
