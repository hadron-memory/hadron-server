/**
 * #2261 / #2259 — bounds on how many MCP transports a process holds.
 *
 * The registry in `server.ts` used to grow without limit: an entry left only on `onclose` or an explicit
 * DELETE, so a client that re-initialized without `Mcp-Session-Id` and never closed leaked one ~15 MB
 * session per attempt. These are the pure pieces of the policy (principal key, env tunables, the response-
 * lifetime in-flight guard); the registry and the eviction itself stay in `server.ts` beside `transports`.
 *
 * TTL and cap are bounded-resource policy, not authorization: neither widens any access, and evicting a
 * transport drops connection-local state only. It never ends a durable worker Session or releases a hold.
 */
import { randomUUID } from 'node:crypto';
import type { AuthContext } from '../middleware/auth.js';
import { mcpLog } from './mcp-log.js';

export const IDLE_TTL_ENV = 'MCP_TRANSPORT_IDLE_TTL_MS';
export const MAX_SESSIONS_ENV = 'MCP_MAX_SESSIONS_PER_PRINCIPAL';
export const DEFAULT_IDLE_TTL_MS = 3_600_000;
export const MIN_IDLE_TTL_MS = 60_000;
export const MAX_IDLE_TTL_MS = 604_800_000;
export const DEFAULT_MAX_SESSIONS_PER_PRINCIPAL = 25;
export const MAX_SESSIONS_CEILING = 1000;
/** How often the sweep looks for idle transports. */
export const SWEEP_INTERVAL_MS = 60_000;
/** `Retry-After` on the at-cap refusal, in seconds. */
export const CAP_RETRY_AFTER_SECONDS = 30;

/**
 * The credential that authenticated a session's `initialize`, tagged by kind. Same precedence as
 * `sameMcpPrincipal` (server.ts) so the cap's idea of "same principal" cannot drift from the auth gate's.
 * Built only from fields the server sets after verifying the bearer; `clientId` is never a key. A principal
 * with none of the three gets a random `anon:` bucket: it isolates that caller from everyone else but is NOT
 * a per-attacker or global bound (only the idle TTL bounds it).
 */
export function mcpPrincipalKey(auth: AuthContext): string {
  if (auth.userId) return `user:${auth.userId}`;
  if (auth.appKeyId) return `appkey:${auth.appKeyId}`;
  if (auth.appId) return `app:${auth.appId}`;
  return `anon:${randomUUID()}`;
}

/** Reads an integer env value in `[min, max]`; anything else warns once per call and yields the default. */
function boundedIntEnv(name: string, min: number, max: number, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    mcpLog('warn', 'mcp_transport_bound_env_invalid', { variable: name, fallback });
    return fallback;
  }
  return n;
}

/** Idle window before an unused transport is evicted. Never "off": invalid values fall back to the default. */
export function idleTtlMs(): number {
  return boundedIntEnv(IDLE_TTL_ENV, MIN_IDLE_TTL_MS, MAX_IDLE_TTL_MS, DEFAULT_IDLE_TTL_MS);
}

/** Live transports one principal may hold. Never "off": invalid values fall back to the default. */
export function maxSessionsPerPrincipal(): number {
  return boundedIntEnv(MAX_SESSIONS_ENV, 1, MAX_SESSIONS_CEILING, DEFAULT_MAX_SESSIONS_PER_PRINCIPAL);
}

/** The slice of a Node `ServerResponse` the guard listens to. */
export type ResponseLike = { once(event: 'close' | 'finish', listener: () => void): unknown };

/**
 * Runs `release` exactly once, on the first of the response's `close`/`finish` or an explicit call. The
 * lifetime of a request is the lifetime of its response (an SSE stream outlives a returned handler), so a
 * handler returning is never the release signal on its own; only a throw or an early return that has not yet
 * produced a response should call the returned function directly.
 */
export function releaseOnceOnResponseEnd(res: ResponseLike, release: () => void): () => void {
  let done = false;
  const once = (): void => {
    if (done) return;
    done = true;
    release();
  };
  res.once('close', once);
  res.once('finish', once);
  return once;
}
