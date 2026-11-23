import type { Request, RequestHandler } from 'express';
import { errors as joseErrors } from 'jose';
import type { PrismaClient } from '../generated/prisma/index.js';
import { verifyAuthenticatedJwt, SignInNotLive } from './signIn.js';
import { admitRate, RateLimited } from '../lib/rateLimit/index.js';
import { transportRateIdentity } from '../lib/rateLimit/identity.js';
import { respondOAuthServerError } from '../lib/internalFault.js';
import { AUTH_COOKIE_NAME } from './cookieName.js';

/** #419: authentication evidence is never a claimed body/query user, OAuth client id or one-use code.
 * JWT-authenticated routes use exactly their handler’s credential source (cookie OR bearer);
 * an unrelated header cannot hide an authenticated consent cookie. Pre-auth routes use IP only.
 * None authenticates an API key, so there is no key dimension. A JWT may
 * contribute a principal only after verification and a live-account check. Invalid credentials
 * remain anonymous for admission; the original handler still gives its existing auth refusal.
 */
export type CredentialSource = 'none' | 'bearer' | 'cookie';
export type RefusalProtocol = 'rest' | 'oauth';
/** #4677 (item 4): both choices are named at every mount; there are no positional defaults to swap by accident. */
export interface AuthRateOptions { protocol: RefusalProtocol; credential: CredentialSource }
async function authRateIdentity(req: Request, db: PrismaClient, source: CredentialSource) {
  const bearer = req.headers.authorization;
  const token = source === 'cookie' ? req.cookies?.[AUTH_COOKIE_NAME]
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

/** #419 auth-route adoption of #1793 ("Rate-limit API fields across the GraphQL and MCP surface", the shared
 * rate-admission core in `src/lib/rateLimit/`): one committed admission BEFORE handler effects; never
 * refund an admitted attempt when a provider fails or the client disconnects. The shared core
 * owns policy modes, windows, HMAC subjects, atomic counters and store-outage decisions.
 * This adapter changes no policy and grants no permission to activate ENFORCING.
 */
export function buildAuthRateAdmission(db: PrismaClient, { protocol, credential }: AuthRateOptions): RequestHandler {
  const handler: RequestHandler = async (req, res, next) => {
    let refusal: RateLimited | undefined;
    try {
      // Holger's #419 contract includes token refresh and /auth/me in this SAME CREDENTIALS/IP budget
      // (the approved seed is DEFAULTS.CREDENTIALS.ipLimit per DEFAULTS.CREDENTIALS.windowSeconds in
      // src/lib/rateLimit/config.ts; the live limits are the policy rows and can be tuned). A NAT-heavy client can
      // exhaust interactive-login capacity. Ada accepted that rollout risk in team chat (#128137); that is not a
      // ruling to activate ENFORCING. LOG_ONLY first; policy tuning is separate.
      // Contract and risk evidence: https://hadronmemory.com/app/u/hrn:node:hadronmemory.com:hadron-server:ops:auth-rate-admission-419
      await admitRate(db, 'CREDENTIALS', await authRateIdentity(req, db, credential));
    } catch (error) {
      if (error instanceof RateLimited) refusal = error;
      else {
        if (protocol === 'oauth') respondOAuthServerError(res, 'Authentication admission failed.', error);
        else next(error);
        return;
      }
    }
    if (!refusal) {
      // #4677 (item 1): the downstream chain runs OUTSIDE the admission try, so a synchronous throw from a
      // later handler is Express's to route and is never reclassified as an admission fault or re-entered.
      next();
      return;
    }
    // Intentional #1793 contract: Holger's 2026-10-31 ruling on #1793 (issue comment 6549880032, recorded by
    // Piona; the gate comment 6549891443 carried it). An unreadable policy row
    // refuses fail-closed classes in BOTH modes, even LOG_ONLY, without a cached mode. CREDENTIALS
    // therefore returns RATE_LIMITED with Retry-After set to the CREDENTIALS class window (seed
    // DEFAULTS.CREDENTIALS.windowSeconds) during that outage; LOG_ONLY is no availability promise.
    // Accepted outage semantics: https://hadronmemory.com/app/u/hrn:node:hadronmemory.com:hadron-server:ops:auth-rate-admission-419
    const retryAfterSeconds = refusal.extensions.retryAfterSeconds;
    if (typeof retryAfterSeconds !== 'number' || !Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds <= 0) {
      // #4677 (item 2): the core always supplies a positive integer. Anything else is a defect, refused loudly
      // as an admission fault: no invented retry value, and never a fail-open next().
      const fault = new Error('Rate admission refused without a positive integer retryAfterSeconds.');
      if (protocol === 'oauth') respondOAuthServerError(res, 'Authentication admission failed.', fault);
      else next(fault);
      return;
    }
    res.set({ 'Retry-After': String(retryAfterSeconds), 'Cache-Control': 'no-store' });
    res.status(429).json({
      error: protocol === 'oauth' ? 'temporarily_unavailable' : 'RATE_LIMITED',
      ...(protocol === 'oauth' ? { error_description: 'Too many requests.' } : {}),
      code: 'RATE_LIMITED', fieldClass: 'CREDENTIALS', retryAfterSeconds,
    });
  };
  // #4677 (item 4/16): the name carries the choices, so the route inventory test reads them off the mounted stack.
  Object.defineProperty(handler, 'name', { value: authRateAdmissionName(protocol, credential) });
  return handler;
}
export const AUTH_RATE_ADMISSION_PREFIX = 'authRateAdmission';
export const authRateAdmissionName = (protocol: RefusalProtocol, credential: CredentialSource) =>
  `${AUTH_RATE_ADMISSION_PREFIX}:${protocol}:${credential}`;
