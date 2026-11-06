import { isIP } from 'node:net';
import { ipKeyGenerator } from 'express-rate-limit';
import type { AuthContext } from '../../middleware/auth.js';

/** Server-created at authentication, before an MCP active-App selection can alter auth.appId. */
export interface RateIdentity {
  readonly principal?: string;
  readonly key?: string;
  readonly ip?: string;
  readonly internal: boolean;
}
export function transportRateIdentity(auth: AuthContext, trustedIP?: string): Readonly<RateIdentity> {
  const principal = auth.impersonation?.actorUserId
    ? `USER:${auth.impersonation.actorUserId}`
    : auth.userId ? `USER:${auth.userId}` : auth.appId ? `APP:${auth.appId}` : undefined;
  let ip = trustedIP;
  if (ip?.startsWith('::ffff:') && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  ip = ip && isIP(ip) ? ipKeyGenerator(ip, 56) : undefined;
  return Object.freeze({ principal, key: auth.apiKeyId ? `USER_KEY:${auth.apiKeyId}` : auth.appKeyId ? `APP_KEY:${auth.appKeyId}` : undefined, ip, internal: false });
}
/** Only a trusted run/job factory may supply this; no missing transport is inferred to be internal. */
export function internalRateIdentity(appId: string): Readonly<RateIdentity> {
  if (!appId) throw new Error('Authenticated App required');
  return Object.freeze({ principal: `APP:${appId}`, internal: true });
}
