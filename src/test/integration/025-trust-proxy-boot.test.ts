/**
 * Spec 025-oauth-for-mcp FR-006 boot-policy integration test.
 *
 * Verifies that the server refuses to start in NODE_ENV=production
 * when Cloudflare's IP-range list cannot be loaded (neither via
 * fetch nor from disk cache). The Vitest in-process runner can't
 * exercise this — `createServer` would throw an unhandled async
 * rejection that crashes the test runner itself — so we spawn the
 * server as a child process and assert on the exit code + stderr.
 *
 * Tasks: T015 per spec-kits tasks.md.
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn `tsx src/index.ts` with the given env overrides and a hard
 * timeout. Returns the captured exit shape. The child inherits the
 * parent's PATH but starts with a fresh env to keep test runs
 * hermetic (we explicitly pass through only what's needed to import
 * the entry point).
 */
// Boot retries can consume ~16.563s before cache fallback, plus module startup.
async function spawnServer(env: Record<string, string>, timeoutMs = 25_000): Promise<SpawnResult> {
  // Spawn `tsx` directly via the resolved binary in node_modules. We used to
  // go through `pnpm exec tsx`, but pnpm 10+ runs an implicit `install`
  // before `exec` and the install was failing on this repo's legacy
  // package.json `pnpm` field (warnings + ERR_PNPM_IGNORED_BUILDS), which
  // meant the server never spawned and the stderr assertions matched the
  // pnpm warnings instead of the boot-policy log lines. Bypassing pnpm
  // sidesteps both problems.
  const tsxBin = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
  return new Promise((resolve) => {
    const child = spawn(tsxBin, ['src/index.ts'], {
      cwd: REPO_ROOT,
      env: {
        // Inherit shell essentials so node/pnpm/tsx can resolve.
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        // Pass through everything from .env that index.ts / Prisma /
        // initCloudflareIps need to even start importing. The test
        // env vars below override per-test behavior.
        ...process.env,
        // Inert DATABASE_URL by default — overridable per-test if
        // needed. Prevents any accidental writes against the dev DB
        // if the boot sequence ever ends up reaching Prisma-touching
        // code (today the Cloudflare init throws before that, so
        // this is defense-in-depth).
        DATABASE_URL: 'postgresql://nobody@127.0.0.1:1/__nonexistent__',
        // src/auth/oauth.ts validates BASE_URL at module-import time —
        // without it the child crashes before reaching the Cloudflare
        // init path the boot policy under test exercises.
        BASE_URL: 'http://127.0.0.1:4000',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => {
      stdout += b.toString();
    });
    child.stderr.on('data', (b) => {
      stderr += b.toString();
    });

    const killTimer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('exit', (code, signal) => {
      clearTimeout(killTimer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

describe('spec 025 FR-006: trust-proxy boot policy', () => {
  it(
    'refuses to boot in NODE_ENV=production when Cloudflare API + cache both fail',
    async () => {
      // Point the Cloudflare API URL at a route that won't resolve;
      // point the cache at a path that doesn't exist. Result: both
      // failure modes triggered. initCloudflareIps MUST throw, the
      // top-level await in src/index.ts MUST propagate the error,
      // and the process MUST exit non-zero before app.listen runs.
      const emptyCacheDir = mkdtempSync(join(tmpdir(), '025-boot-policy-test-'));
      try {
        const result = await spawnServer({
          NODE_ENV: 'production',
          CLOUDFLARE_IPS_API_URL: 'http://127.0.0.1:1/this-port-rejects',
          CLOUDFLARE_IPS_CACHE_PATH: join(emptyCacheDir, 'nonexistent.json'),
          // Bind a port that we DON'T actually plan to occupy; even if
          // by some bug the server reaches listen(), this surfaces it.
          PORT: '0',
        });

        // Fail closed through the real error, not through our safety timeout.
        expect(result.signal).toBeNull();
        expect(result.code).not.toBeNull();
        expect(result.code).not.toBe(0);

        // stderr carries the diagnostic from initCloudflareIps.
        expect(result.stderr).toMatch(/Failed to load Cloudflare IP ranges/);

        // The "ready" log line MUST NOT appear — if app.listen had
        // run, this would be in stdout.
        expect(result.stdout).not.toMatch(/hadron-server listening/);
      } finally {
        rmSync(emptyCacheDir, { recursive: true, force: true });
      }
    },
    // Generous per-test timeout — child process startup + Prisma
    // generate cost a few seconds before the failure path runs.
    30_000,
  );

  it(
    'boots successfully in NODE_ENV=production when the disk cache holds a valid list',
    async () => {
      // API unreachable, but the cache file holds a previously-fetched
      // list. The fallback-stale path MUST engage and the fail-closed
      // path MUST NOT trip (per R-4 / Q-025-011).
      //
      // We can't drive the full boot in CI (no DB), but we can pin
      // two positive signals: the fallback-stale warning is emitted
      // (proving the cache path engaged) AND the refuse-to-boot
      // error is absent (proving fail-closed wasn't tripped). Both
      // are checked below.
      const cacheDir = mkdtempSync(join(tmpdir(), '025-boot-policy-test-'));
      const cachePath = join(cacheDir, 'cloudflare-ips.json');
      const { writeFileSync } = await import('node:fs');
      writeFileSync(
        cachePath,
        JSON.stringify({
          ipv4_cidrs: ['173.245.48.0/20'],
          ipv6_cidrs: ['2400:cb00::/32'],
          fetched_at: '2026-05-19T00:00:00.000Z',
        }),
      );
      try {
        const result = await spawnServer({
          NODE_ENV: 'production',
          CLOUDFLARE_IPS_API_URL: 'http://127.0.0.1:1/this-port-rejects',
          CLOUDFLARE_IPS_CACHE_PATH: cachePath,
          PORT: '0',
        });

        // Positive signal: the fallback-stale warning fires with the
        // cached fetched_at timestamp interpolated. This is the
        // load-bearing assertion that the cache fallback engaged.
        expect(result.stderr).toMatch(
          /Boot fetch failed; using cached list from 2026-05-19T00:00:00\.000Z/,
        );
        // Negative signal: fail-closed path was NOT taken.
        expect(result.stderr).not.toMatch(/Failed to load Cloudflare IP ranges/);
      } finally {
        rmSync(cacheDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
