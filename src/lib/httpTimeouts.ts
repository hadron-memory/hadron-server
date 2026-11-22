/**
 * #851: the HTTP server's keep-alive and headers timeouts.
 *
 * Node closes an idle keep-alive connection after `keepAliveTimeout` (5 s by default). A reverse proxy in front of
 * the server (Traefik reuses an idle backend connection for up to 90 s by default: its `serversTransport`
 * `forwardingTimeouts.idleConnTimeout`, not the client-side `respondingTimeouts`) that reuses a connection the origin
 * has just closed gets a reset on the next request, which the proxy surfaces as an intermittent 502. Keeping the
 * origin's window ABOVE the idle reuse of the proxy that connects to it removes that race: the proxy always closes
 * first. (On alpha that proxy is Traefik; if another proxy ever connects to the origin directly, its idle reuse must be
 * below this value too.)
 *
 * Defaults: `keepAliveTimeout` 120 s, `headersTimeout` 125 s. 120 s clears Traefik's 90 s default (Hugo's and Yuri's
 * read of alpha, hadron-server#851: no `respondingTimeouts` set) with margin; `headersTimeout` must stay above
 * `keepAliveTimeout` (Node's own guidance: otherwise a connection can be cut between requests).
 *
 * `HTTP_KEEP_ALIVE_TIMEOUT_MS` and `HTTP_HEADERS_TIMEOUT_MS` accept only a plain integer from 1000 to 290000 (below
 * Node's default 300 s `requestTimeout`, which `headersTimeout` may not exceed). Anything else (unset, empty, signed,
 * fractional, exponent, hex, out of range) falls back to the default, so a typo can neither switch the window off nor
 * widen it past what Node accepts. A headers value that is not above the effective keep-alive value is raised to
 * keep-alive + 5 s rather than honoured, so the ordering invariant cannot be configured away (a 290000 keep-alive
 * therefore yields a 295000 headers value, which Node accepts).
 */
export const HTTP_KEEP_ALIVE_TIMEOUT_DEFAULT_MS = 120_000;
export const HTTP_HEADERS_TIMEOUT_DEFAULT_MS = 125_000;
export const HTTP_TIMEOUT_MIN_MS = 1_000;
export const HTTP_TIMEOUT_MAX_MS = 290_000;
export const HTTP_HEADERS_MARGIN_MS = 5_000;

function boundedMs(raw: string | undefined): number | null {
  if (raw === undefined || !/^[1-9][0-9]{3,5}$/.test(raw)) return null;
  const ms = Number(raw);
  return ms >= HTTP_TIMEOUT_MIN_MS && ms <= HTTP_TIMEOUT_MAX_MS ? ms : null;
}

export function httpTimeoutsFromEnv(env: NodeJS.ProcessEnv = process.env): { keepAliveTimeoutMs: number; headersTimeoutMs: number } {
  const keepAliveTimeoutMs = boundedMs(env.HTTP_KEEP_ALIVE_TIMEOUT_MS) ?? HTTP_KEEP_ALIVE_TIMEOUT_DEFAULT_MS;
  const configuredHeaders = boundedMs(env.HTTP_HEADERS_TIMEOUT_MS);
  const headersTimeoutMs = configuredHeaders !== null && configuredHeaders > keepAliveTimeoutMs
    ? configuredHeaders
    // Unset/invalid: the default, unless a longer keep-alive was configured; then keep-alive + margin.
    : Math.max(configuredHeaders === null ? HTTP_HEADERS_TIMEOUT_DEFAULT_MS : 0, keepAliveTimeoutMs + HTTP_HEADERS_MARGIN_MS);
  return { keepAliveTimeoutMs, headersTimeoutMs };
}

/** Apply the configured timeouts to a listening or not-yet-listening server. Returns what it applied. */
export function applyHttpTimeouts(
  server: { keepAliveTimeout: number; headersTimeout: number },
  env: NodeJS.ProcessEnv = process.env,
): { keepAliveTimeoutMs: number; headersTimeoutMs: number } {
  const applied = httpTimeoutsFromEnv(env);
  server.keepAliveTimeout = applied.keepAliveTimeoutMs;
  server.headersTimeout = applied.headersTimeoutMs;
  return applied;
}
