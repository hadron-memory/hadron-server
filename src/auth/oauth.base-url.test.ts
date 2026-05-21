/**
 * Spec 025 follow-up — `BASE_URL` env-var override.
 *
 * Two layers:
 *   - Unit tests on `validateBaseUrl` (the parser/validator —
 *     pure function, easy to assert directly).
 *   - Module-load integration tests that exercise `getServerOrigin`'s
 *     env-var-aware behavior end-to-end. These use `vi.stubEnv` +
 *     `vi.resetModules` + dynamic `import()` because the env var is
 *     read at module load via an IIFE (intentional — strict validation
 *     fails fast at boot rather than silently emitting bad URLs).
 *
 * Production behavior pinned here:
 *   - Env var set → `getServerOrigin(req)` returns the env value
 *     regardless of `req.protocol` + `req.get('host')`. This is the
 *     defense against the original "every URL is http://" production
 *     bug (Cloudflare DNS-only mode + X-Forwarded-Proto missing).
 *   - Env var unset → falls back to per-request derivation (so
 *     local-dev `127.0.0.1:<port>` works without configuration).
 *   - Env var malformed → throws at boot (failing module-load).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request } from 'express';

// ── Unit tests on validateBaseUrl ──────────────────────────────

describe('validateBaseUrl (boot-time parser)', () => {
  // Import the validator directly. Module-load env var is irrelevant
  // here — these tests pass the input as a function arg.
  let validateBaseUrl: (raw: string | undefined) => string | null;

  beforeEach(async () => {
    // Fresh import per test so the unrelated module-load IIFE doesn't
    // throw (no env var → null → no throw).
    vi.resetModules();
    vi.unstubAllEnvs();
    const mod = await import('./oauth.js');
    validateBaseUrl = mod.validateBaseUrl;
  });

  it('returns null when the input is undefined', () => {
    expect(validateBaseUrl(undefined)).toBeNull();
  });

  it('returns null when the input is the empty string', () => {
    // Production deployments commonly default to `''` for unset env
    // vars (e.g., docker-compose with no value); treat same as unset.
    expect(validateBaseUrl('')).toBeNull();
  });

  it.each([
    'https://srv.hadronmemory.com',
    'https://srv.hadronmemory.com:8443',
    'http://localhost:4000', // local dev / cloudflared tunnel
    'https://hadron.example.org:443', // explicit default port
  ])('accepts well-formed origin %s', (input) => {
    expect(validateBaseUrl(input)).toBe(input);
  });

  it.each([
    ['trailing slash', 'https://srv.hadronmemory.com/'],
    ['path component', 'https://srv.hadronmemory.com/mcp'],
    ['query string', 'https://srv.hadronmemory.com?foo=bar'],
    ['fragment', 'https://srv.hadronmemory.com#frag'],
    ['empty host', 'https://'],
    ['no scheme', 'srv.hadronmemory.com'],
    ['wrong scheme', 'ftp://srv.hadronmemory.com'],
    ['javascript: scheme', 'javascript:alert(1)'],
    ['protocol-relative', '//srv.hadronmemory.com'],
    ['leading space', ' https://srv.hadronmemory.com'],
    ['trailing space', 'https://srv.hadronmemory.com '],
    // Pin two known-rejected cases explicitly so future maintainers
    // don't loosen the regex thinking they're fixing a bug:
    // (1) Uppercase scheme. RFC 3986 says schemes are case-insensitive,
    //     but the OAuth issuer claim is compared verbatim by clients
    //     (RFC 8414 §2). Canonical-lowercase is the strict posture.
    ['uppercase scheme', 'HTTPS://srv.hadronmemory.com'],
    ['mixed-case scheme', 'HtTpS://srv.hadronmemory.com'],
    // (2) IPv6 host with bracket notation. Real shape per RFC 3986
    //     §3.2.2 but explicitly out of scope for this env var (DNS-style
    //     hostnames only). Operators with v6-only deployments would
    //     need to widen the regex to add `\[[0-9a-fA-F:]+\]` as an
    //     alternative for the host portion.
    ['ipv6 host', 'https://[::1]:4000'],
    ['ipv6 full address', 'https://[2001:db8::1]'],
    // (3) Underscore in hostname. RFC 1035 forbids them; some internal
    //     DNS (k8s service DNS like `service_name.namespace.svc.cluster.local`)
    //     tolerates them in practice. Documented in the validator's
    //     docstring as DNS-safe-hostnames-only.
    ['underscore in hostname', 'https://my_service.internal:4000'],
  ])('throws on malformed input (%s)', (_label, input) => {
    expect(() => validateBaseUrl(input)).toThrow(
      /BASE_URL must be of the form/,
    );
  });

  it('throw message includes the offending value (verbatim, JSON-encoded)', () => {
    const bad = 'https://srv.hadronmemory.com/';
    expect(() => validateBaseUrl(bad)).toThrow(JSON.stringify(bad));
  });
});

// ── Integration tests on getServerOrigin's env-var behavior ──────────

describe('getServerOrigin — BASE_URL precedence', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  /** Tiny synthetic Express request stub — only `protocol` + `get`. */
  function makeReq(host: string | undefined, protocol = 'http'): Request {
    return {
      protocol,
      get: (name: string) =>
        name.toLowerCase() === 'host' ? host : undefined,
    } as unknown as Request;
  }

  it('uses BASE_URL verbatim when set, ignoring request headers', async () => {
    vi.stubEnv('BASE_URL', 'https://srv.hadronmemory.com');
    const { getServerOrigin } = await import('./oauth.js');
    // Pathological request: claims http + a different host. The env
    // var must win — this is the whole point.
    const req = makeReq('attacker.example:80', 'http');
    expect(getServerOrigin(req)).toBe('https://srv.hadronmemory.com');
  });

  it('falls back to ${protocol}://${host} when env var is unset', async () => {
    // No stubEnv — env var is whatever the test runner inherited, but
    // vitest's process env usually doesn't define BASE_URL.
    // Defensive: explicitly unstub anyway.
    vi.stubEnv('BASE_URL', '');
    const { getServerOrigin } = await import('./oauth.js');
    const req = makeReq('127.0.0.1:4000', 'http');
    expect(getServerOrigin(req)).toBe('http://127.0.0.1:4000');
  });

  it('returns null when env var is unset AND request has no Host header', async () => {
    vi.stubEnv('BASE_URL', '');
    const { getServerOrigin } = await import('./oauth.js');
    const req = makeReq(undefined, 'http');
    expect(getServerOrigin(req)).toBeNull();
  });

  it('with env var set, missing Host header is irrelevant (env wins)', async () => {
    vi.stubEnv('BASE_URL', 'https://canonical.example');
    const { getServerOrigin } = await import('./oauth.js');
    const req = makeReq(undefined, 'http');
    expect(getServerOrigin(req)).toBe('https://canonical.example');
  });

  it('module load throws when BASE_URL is malformed', async () => {
    vi.stubEnv('BASE_URL', 'not-a-url');
    // The import() promise rejects because the module's IIFE throws.
    await expect(import('./oauth.js')).rejects.toThrow(
      /BASE_URL must be of the form/,
    );
  });

  it('BASE_URL === "/" is treated as the Vite-sentinel for unset (test-mode collision avoidance)', async () => {
    // Vite/vitest derives BASE_URL from config.base (default `/`) and
    // writes it to process.env.BASE_URL globally during test runs.
    // Without filtering `/`, the strict validator throws at module
    // load during every vitest run, blocking the whole suite. `/` is
    // never a valid origin (no scheme, no host), so no legitimate
    // caller would set it; treating it as unset costs nothing in
    // production and unblocks tests.
    vi.stubEnv('BASE_URL', '/');
    const { getServerOrigin } = await import('./oauth.js');
    // Module-load must NOT throw, AND `getServerOrigin` must fall
    // back to per-request derivation since the override is treated
    // as unset.
    const req = {
      protocol: 'http',
      get: (name: string) =>
        name.toLowerCase() === 'host' ? '127.0.0.1:4000' : undefined,
    } as unknown as Request;
    expect(getServerOrigin(req)).toBe('http://127.0.0.1:4000');
  });
});
