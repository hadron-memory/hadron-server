/**
 * #1925 — GET /capabilities: which deployment switches are on, readable before sign-in.
 *
 * Holger (2026-10-14): an unauthenticated, rate-limited endpoint outside GraphQL, using MCP's token words; no
 * GraphQL field. The answer is `{"capabilities":[...]}` from `switchCapabilities()`, the function MCP's
 * capabilities line also reads, so the two cannot disagree. An off switch is left out, never `false`: with signing
 * off, body and headers are byte-identical to a build without the feature (#11049).
 *
 * - **Computed once, at mount.** The switches change only on restart, so the body and its ETag are fixed for the
 *   process. No DB access, no usage event, no session.
 * - **Cacheable.** `Cache-Control: public, max-age=60` and a strong ETag, so Cloudflare absorbs repeat traffic;
 *   `If-None-Match` answers 304.
 * - **Rate limited per client IP** (`trust proxy` already resolves Cloudflare's client IP): a bodiless 429 over the
 *   limit, with `Access-Control-Allow-Origin: *` and `Retry-After: 60` (the fixed window; #1964), the same for every
 *   caller. The limiter sends no RateLimit headers, so the cacheable 200 carries nothing per-client.
 * - **Hardened.** GET (Express answers HEAD from it) only; other methods fall through to the ordinary 404. Nothing
 *   is read from the request (no query, no body, no cookies) and nothing is echoed. Mounted BEFORE the global CORS
 *   middleware, which allows the portal's origin WITH credentials: this route answers `*` without credentials.
 */

import { createHash } from 'node:crypto';
import type { Express } from 'express';
import rateLimit from 'express-rate-limit';
import { switchCapabilities } from '../lib/signing/surface.js';

/** Requests a minute per client IP. Generous: one cached read per page load is the expected use. */
export const CAPABILITIES_RATE_LIMIT_PER_MINUTE = 60;

const WINDOW_MS = 60_000;

export function mountCapabilitiesRoute(
  app: Express,
  { limitPerMinute = CAPABILITIES_RATE_LIMIT_PER_MINUTE }: { limitPerMinute?: number } = {},
): void {
  const body = JSON.stringify({ capabilities: switchCapabilities() });
  const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
  const limiter = rateLimit({
    windowMs: WINDOW_MS,
    limit: limitPerMinute,
    standardHeaders: false,
    legacyHeaders: false,
    // #1964: readable cross-origin like the 200 (`*`, no credentials), or a browser reports a CORS failure instead
    // of a rate limit. Retry-After is the fixed window, never this client's remaining time, so the refusal stays
    // identical for every caller and carries nothing per-client.
    handler: (_req, res) => {
      res.set({ 'Access-Control-Allow-Origin': '*', 'Retry-After': String(WINDOW_MS / 1000) }).status(429).end();
    },
  });
  app.get('/capabilities', limiter, (req, res) => {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=60',
      ETag: etag,
    });
    if (req.fresh) {
      res.status(304).end();
      return;
    }
    res.type('application/json').send(body);
  });
}
