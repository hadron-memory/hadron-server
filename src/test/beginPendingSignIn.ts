/**
 * #4339: nothing on a sign-in path begins a passkey step any more, so the server-hosted pending-sign-in machinery
 * (#1897 B1/B2, kept for the add-a-passkey slice) is no longer reachable from /auth/email/verify. Tests that exercise
 * that machinery start a flow here: the REAL beginPasskeySignIn, called directly with a stand-in response that records
 * the cookie and redirect it would send.
 */
import type { Request, Response } from 'express';
import { beginPasskeySignIn } from '../api/passkeySignInRoutes.js';
import type { PendingContinuation } from '../auth/pendingEmailSignIn.js';

/** One res.cookie call, whole: the options Express would turn into the Set-Cookie flags (httpOnly, sameSite, secure, path, maxAge). */
export interface RecordedCookie { name: string; value: string; opts: Record<string, unknown> }
/** `cookie` / `maxAgeMs` stay as the first-cookie shortcuts the existing tests read; `cookies` is every call, in order. */
export interface BegunPending { begun: boolean; cookie?: string; maxAgeMs?: number; location?: string; cookies: RecordedCookie[] }

/** `secure` is the request's own flag (`req.secure`); the cookie's Secure flag follows it outside production. */
export async function beginPending(userId: string, continuation: PendingContinuation, opts: { secure?: boolean } = {}): Promise<BegunPending> {
  const out: BegunPending = { begun: false, cookies: [] };
  const res = {
    cookie: (name: string, value: string, o: { maxAge?: number }) => {
      out.cookies.push({ name, value, opts: { ...o } });
      out.cookie = `${name}=${value}`; out.maxAgeMs = o.maxAge; return res;
    },
    redirect: (location: string) => { out.location = location; },
  } as unknown as Response;
  out.begun = await beginPasskeySignIn({ secure: opts.secure ?? false } as unknown as Request, res, { userId, continuation });
  return out;
}

/** The PORTAL continuation the email verify route used to pass. */
export const portalContinuation = (clientStateHash: string | null): PendingContinuation => ({ kind: 'PORTAL', clientStateHash, redirect: '/', isNew: false });
export const oauthContinuation = (returnTo: string): PendingContinuation => ({ kind: 'OAUTH', returnTo });
