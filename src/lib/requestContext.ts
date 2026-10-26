/**
 * Per-HTTP-request id for the generic internal-error envelope (#1789, cor:api:260:01).
 *
 * One server-generated opaque UUIDv4 per request, shared by every fault and log record that request produces and
 * different for two identical faults on separate requests. An incoming `X-Request-Id` is deliberately ignored: a caller
 * must not choose the value an operator greps for.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const storage = new AsyncLocalStorage<{ requestId: string }>();

export const REQUEST_ID_HEADER = 'X-Request-Id';

/** First middleware: mint the id and put it on the response before any body parser or handler can fail. */
export function assignRequestId(_req: Request, res: Response, next: NextFunction): void {
  const requestId = randomUUID();
  res.locals.requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);
  next();
}

/**
 * Enter the request's async context. Body parsers resume on stream events, which can drop AsyncLocalStorage, so this runs
 * again next to the handler that needs the id (the requestKeyStorage pattern).
 */
export function bindRequestId(_req: Request, res: Response, next: NextFunction): void {
  const requestId = typeof res.locals?.requestId === 'string' ? res.locals.requestId : randomUUID();
  storage.run({ requestId }, next);
}

/** The id of the request being served, or undefined outside one (jobs, tests). */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
