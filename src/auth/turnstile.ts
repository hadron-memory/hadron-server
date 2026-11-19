/**
 * Cloudflare Turnstile bot check on sign-up (#2257, R210, cor:aut:030:01).
 *
 * Slice 1: a verify-token helper plus the gate on the email sign-in send paths
 * (`POST /auth/email`, `POST /oauth/authorize/email`), behind
 * `SIGNUP_TURNSTILE_ENABLED`. The first-account-creation gate, the invited
 * skip and the per-identity limits are later slices.
 *
 * Fail closed: anything short of Cloudflare answering `success: true` refuses
 * the request (cor:aut:030:01, "creation is refused if the check fails"). Only
 * the secret, the client's token and the client IP leave the platform; the
 * email address never does. The token and secret are never logged.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
/** Cloudflare's own form field, so the stock widget works unchanged. */
export const TURNSTILE_RESPONSE_FIELD = 'cf-turnstile-response';
const VERIFY_TIMEOUT_MS = 5000;

export type TurnstileRefusal = 'missing_token' | 'invalid_token' | 'provider_error' | 'not_configured';
export type TurnstileResult = { ok: true } | { ok: false; reason: TurnstileRefusal };

/** Read per call (like the other deployment gates): only the exact value `true` turns it on. */
export function signupTurnstileEnabled(): boolean {
  return process.env.SIGNUP_TURNSTILE_ENABLED === 'true';
}

/**
 * Verify one Turnstile token. Never throws: every failure path is a refusal.
 * A provider problem (network, timeout, non-2xx, unparseable or malformed
 * answer) is `provider_error`, distinct from Cloudflare rejecting the token.
 */
export async function verifyTurnstileToken(token: unknown, remoteIp: string | undefined): Promise<TurnstileResult> {
  if (typeof token !== 'string' || token.trim() === '') return { ok: false, reason: 'missing_token' };
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return { ok: false, reason: 'not_configured' };

  const form = new URLSearchParams({ secret, response: token });
  if (remoteIp) form.set('remoteip', remoteIp);
  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, reason: 'provider_error' };
    const body = (await res.json()) as { success?: unknown; 'error-codes'?: unknown } | null;
    if (typeof body?.success !== 'boolean') return { ok: false, reason: 'provider_error' };
    if (body.success) return { ok: true };
    // `success:false` also carries Cloudflare's own verdict on OUR side of the
    // exchange: a bad or missing secret is a deployment fault and an internal
    // error is the provider's, neither is the visitor's token being wrong.
    const codes = (body as { 'error-codes'?: unknown })['error-codes'];
    const list = Array.isArray(codes) ? codes : [];
    if (list.includes('invalid-input-secret') || list.includes('missing-input-secret')) {
      return { ok: false, reason: 'not_configured' };
    }
    if (list.includes('internal-error')) return { ok: false, reason: 'provider_error' };
    return { ok: false, reason: 'invalid_token' };
  } catch {
    return { ok: false, reason: 'provider_error' };
  }
}

/**
 * Express gate for an email send path. A no-op unless the flag is on.
 *
 * Mount it AFTER the route's no-send validation (a request refused there never
 * burns a single-use token) and BEFORE the per-recipient limiter (a refused
 * request sends nothing, so it must not spend a victim's budget: the same
 * ordering rule as the existing limiters). The per-IP limiter may sit before
 * it, which also bounds how many Cloudflare calls one address can cause.
 */
export const requireSignupBotCheck: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
  if (!signupTurnstileEnabled()) {
    next();
    return;
  }
  const token = (req.body as Record<string, unknown> | undefined)?.[TURNSTILE_RESPONSE_FIELD];
  const result = await verifyTurnstileToken(token, req.ip);
  if (result.ok) {
    next();
    return;
  }
  if (result.reason === 'provider_error' || result.reason === 'not_configured') {
    console.warn(`[auth] signup turnstile unavailable reason=${result.reason}`);
    res.status(503).json({ error: 'bot_check_failed', reason: result.reason });
    return;
  }
  res.status(403).json({ error: 'bot_check_failed', reason: result.reason });
};
