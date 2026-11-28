/**
 * The generic internal-error envelope (#1789, cor:api:260:01).
 *
 * An error that is not a typed domain refusal shows the caller ONE code, a fixed message and a request id. The detail goes
 * to the server log under that id, so an operator can find it from what the caller reports. Clients key on the code and
 * the id, never the text.
 */
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { respondSessionSuperseded } from './sessionSuperseded.js';
import { authStoreBusyMessage, isAuthStoreBusyError, normalizeAuthStoreBusyReason } from './authStoreBusy.js';
import { currentRequestId } from './requestContext.js';

export const INTERNAL_ERROR_CODE = 'INTERNAL_SERVER_ERROR';
export const INTERNAL_ERROR_MESSAGE = 'Internal server error.';

export interface InternalFaultEnvelope {
  code: typeof INTERNAL_ERROR_CODE;
  requestId: string;
  message: typeof INTERNAL_ERROR_MESSAGE;
}

/** The request's id, or a fresh one outside a request (a job, a test) so the log line and the envelope still correlate. */
export function faultRequestId(): string {
  return currentRequestId() ?? randomUUID();
}

export function internalFaultEnvelope(requestId: string): InternalFaultEnvelope {
  return { code: INTERNAL_ERROR_CODE, requestId, message: INTERNAL_ERROR_MESSAGE };
}

/** Human fallback for a transport that cannot carry structured data. Never parsed by clients. */
export function internalFaultText(requestId: string): string {
  return `[${INTERNAL_ERROR_CODE}] ${INTERNAL_ERROR_MESSAGE} Request id: ${requestId}`;
}

/** Log the complete exception under the request id; the only place the detail goes. */
export function logInternalFault(surface: string, site: string, requestId: string, error: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[${surface}] internal_fault`, { requestId, site, error });
}

/**
 * A plain HTTP endpoint's fault response. `error` keeps its string shape so existing callers that read it still work;
 * `code` and `requestId` are the machine-readable parts. The response's own X-Request-Id header, set when the request
 * arrived, is the same value.
 */
export function respondInternalFault(res: Response, site: string, error: unknown, status = 500): void {
  const requestId = typeof res.locals?.requestId === 'string' ? res.locals.requestId : faultRequestId();
  logInternalFault('http', site, requestId, error);
  if (res.headersSent) return;
  res.status(status).json({ error: INTERNAL_ERROR_MESSAGE, code: INTERNAL_ERROR_CODE, requestId });
}

/**
 * The same fault on an OAuth endpoint, whose body shape RFC 6749 §5.2 / RFC 7591 §3.2.2 fixes: `error: server_error` plus
 * a description. The description stays a fixed phrase; `request_id` is the additive correlation field.
 */
export function respondOAuthServerError(res: Response, description: string, error: unknown): void {
  const requestId = typeof res.locals?.requestId === 'string' ? res.locals.requestId : faultRequestId();
  logInternalFault('oauth', description, requestId, error);
  if (res.headersSent) return;
  res.status(500).json({ error: 'server_error', error_description: description, request_id: requestId });
}

/**
 * #4471: the plain-HTTP render of the typed store-busy fault (the `/graphql/schema`, `/reload`,
 * `/sessions/:id/outcome` routes see it via `next(err)`). Like respondSessionSuperseded above, a
 * typed auth-path fault is not genericized by the #1789 envelope — the caller must see
 * AUTH_STORE_BUSY to back off and resend the same key, not read the generic 500 as "bad key".
 * Unlike the envelope it answers 503 retryable — and (BLIND P2-2) it is no logging blind spot
 * either: the fault is logged under the request id with the driver error on `.cause` reaching
 * only that log, exactly as respondInternalFault does, so "countable evidence" holds on this
 * surface too.
 *
 * #4504, on the log/headersSent order (Bradley's "could log twice"): the log fires BEFORE the
 * headersSent check on purpose — a request whose headers already went out is precisely the one
 * where the log is the ONLY evidence left, so it must not be skipped. The double-log cannot
 * happen in this wiring: when headersSent makes this return false, internalFaultErrorHandler's
 * own headersSent guard delegates via next(err) instead of falling through to
 * respondInternalFault. That coupling is load-bearing — reorder those checks and the fault logs
 * twice. Pinned in internalFaultHttp1789.test.ts (exactly one internal_fault line on the
 * headersSent path).
 */
export function respondAuthStoreBusy(res: Response, error: unknown): boolean {
  if (!isAuthStoreBusyError(error)) return false;
  const requestId = typeof res.locals?.requestId === 'string' ? res.locals.requestId : faultRequestId();
  logInternalFault('http', 'auth-store-busy', requestId, error);
  if (res.headersSent) return false; // Delegate to Express's final handler, as #3818 does.
  // Normalize at the boundary: instanceof proves the class, not that a subclass or late
  // mutation kept its extensions intact. The GraphQL boundary reads the same normalizer (#4591).
  const reason = normalizeAuthStoreBusyReason(error.extensions?.reason);
  res.status(503).json({
    error: authStoreBusyMessage(reason),
    code: 'AUTH_STORE_BUSY',
    retryable: true,
    reason,
    requestId,
  });
  return true;
}

/**
 * Express's final error handler. A client-class status (body-parser's 400/413, ...) is a framework refusal and keeps
 * today's handling until it is ruled on; only a fault is genericized.
 */
export function internalFaultErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (respondSessionSuperseded(res, err)) return;
  // #4471: a typed retryable store-busy fault from the auth middleware is not genericized — the
  // caller must see AUTH_STORE_BUSY to back off and resend the same key, not read the generic
  // envelope as "bad key". The same carve-out shape respondSessionSuperseded established.
  if (respondAuthStoreBusy(res, err)) return;
  const e = err as { status?: unknown; statusCode?: unknown } | null;
  const status = e?.status ?? e?.statusCode;
  if (res.headersSent || (typeof status === 'number' && status >= 400 && status < 500)) {
    next(err);
    return;
  }
  respondInternalFault(res, 'express', err);
}
