/**
 * The generic internal-error envelope (#1789, cor:api:260:01).
 *
 * An error that is not a typed domain refusal shows the caller ONE code, a fixed message and a request id. The detail goes
 * to the server log under that id, so an operator can find it from what the caller reports. Clients key on the code and
 * the id, never the text.
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
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
