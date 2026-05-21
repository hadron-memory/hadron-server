/**
 * Spec 025 follow-up — `HADRON_PUBLIC_BASE_URL` env-var override.
 *
 * Two layers:
 *   - Unit tests on `validatePublicBaseUrl` (the parser/validator —
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

// ── Unit tests on validatePublicBaseUrl ──────────────────────────────

describe('validatePublicBaseUrl (boot-time parser)', () => {
  // Import the validator directly. Module-load env var is irrelevant
  // here — these tests pass the input as a function arg.
  let validatePublicBaseUrl: (raw: string | undefined) => string | null;

  beforeEach(async () => {
    // Fresh import per test so the unrelated module-load IIFE doesn't
    // throw (no env var → null → no throw).
    vi.resetModules();
    vi.unstubAllEnvs();
    const mod = await import('./oauth.js');
    validatePublicBaseUrl = mod.validatePublicBaseUrl;
  });

  it('returns null when the input is undefined', () => {
    expect(validatePublicBaseUrl(undefined)).toBeNull();
  });

  it('returns null when the input is the empty string', () => {
    // Production deployments commonly default to `''` for unset env
    // vars (e.g., docker-compose with no value); treat same as unset.
    expect(validatePublicBaseUrl('')).toBeNull();
  });

  it.each([
    'https://srv.hadronmemory.com',
    'https://srv.hadronmemory.com:8443',
    'http://localhost:4000', // local dev / cloudflared tunnel
    'https://hadron.example.org:443', // explicit default port
  ])('accepts well-formed origin %s', (input) => {
    expect(validatePublicBaseUrl(input)).toBe(input);
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
  ])('throws on malformed input (%s)', (_label, input) => {
    expect(() => validatePublicBaseUrl(input)).toThrow(
      /HADRON_PUBLIC_BASE_URL must be of the form/,
    );
  });

  it('throw message includes the offending value (verbatim, JSON-encoded)', () => {
    const bad = 'https://srv.hadronmemory.com/';
    expect(() => validatePublicBaseUrl(bad)).toThrow(JSON.stringify(bad));
  });
});

// ── Integration tests on getServerOrigin's env-var behavior ──────────

describe('getServerOrigin — HADRON_PUBLIC_BASE_URL precedence', () => {
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

  it('uses HADRON_PUBLIC_BASE_URL verbatim when set, ignoring request headers', async () => {
    vi.stubEnv('HADRON_PUBLIC_BASE_URL', 'https://srv.hadronmemory.com');
    const { getServerOrigin } = await import('./oauth.js');
    // Pathological request: claims http + a different host. The env
    // var must win — this is the whole point.
    const req = makeReq('attacker.example:80', 'http');
    expect(getServerOrigin(req)).toBe('https://srv.hadronmemory.com');
  });

  it('falls back to ${protocol}://${host} when env var is unset', async () => {
    // No stubEnv — env var is whatever the test runner inherited, but
    // vitest's process env usually doesn't define HADRON_PUBLIC_BASE_URL.
    // Defensive: explicitly unstub anyway.
    vi.stubEnv('HADRON_PUBLIC_BASE_URL', '');
    const { getServerOrigin } = await import('./oauth.js');
    const req = makeReq('127.0.0.1:4000', 'http');
    expect(getServerOrigin(req)).toBe('http://127.0.0.1:4000');
  });

  it('returns null when env var is unset AND request has no Host header', async () => {
    vi.stubEnv('HADRON_PUBLIC_BASE_URL', '');
    const { getServerOrigin } = await import('./oauth.js');
    const req = makeReq(undefined, 'http');
    expect(getServerOrigin(req)).toBeNull();
  });

  it('with env var set, missing Host header is irrelevant (env wins)', async () => {
    vi.stubEnv('HADRON_PUBLIC_BASE_URL', 'https://canonical.example');
    const { getServerOrigin } = await import('./oauth.js');
    const req = makeReq(undefined, 'http');
    expect(getServerOrigin(req)).toBe('https://canonical.example');
  });

  it('module load throws when HADRON_PUBLIC_BASE_URL is malformed', async () => {
    vi.stubEnv('HADRON_PUBLIC_BASE_URL', 'not-a-url');
    // The import() promise rejects because the module's IIFE throws.
    await expect(import('./oauth.js')).rejects.toThrow(
      /HADRON_PUBLIC_BASE_URL must be of the form/,
    );
  });
});
