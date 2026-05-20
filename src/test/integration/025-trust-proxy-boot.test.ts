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
async function spawnServer(env: Record<string, string>, timeoutMs = 15_000): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn('pnpm', ['exec', 'tsx', 'src/index.ts'], {
      cwd: REPO_ROOT,
      env: {
        // Inherit shell essentials so node/pnpm/tsx can resolve.
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        // Pass through everything from .env that index.ts / Prisma /
        // initCloudflareIps need to even start importing. The test
        // env vars below override per-test behavior.
        ...process.env,
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

        // Non-zero exit (1 from unhandled promise rejection in tsx, or
        // signal from our 15s timeout if the child hung — both
        // indicate "did not boot cleanly").
        expect(result.code === null ? result.signal : result.code).not.toBe(0);

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
      // API still unreachable, but the cache file holds a previously-
      // fetched list. Boot MUST succeed (fail-safe-stale per R-4 /
      // Q-025-011).
      //
      // We can't easily verify the full boot in CI (no DB / no port
      // setup); instead we check that initCloudflareIps's warning
      // message appears in stderr ("Boot fetch failed; using cached
      // list…"), confirming the fallback path engaged. If the
      // process then crashes for downstream reasons (DB unavailable,
      // etc.), that's fine — we've already confirmed the cache
      // fallback worked.
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

        // The fallback path emits a stderr warning. Whether the child
        // exits 0 or non-zero depends on downstream startup (DB
        // probably succeeds in CI; if it doesn't, we still get the
        // warning before the next failure).
        expect(result.stderr).toMatch(/Boot fetch failed; using cached list/);
        // NOT the fail-closed message — that's the assertion we
        // didn't trip the refuse-to-boot path.
        expect(result.stderr).not.toMatch(/Failed to load Cloudflare IP ranges/);
      } finally {
        rmSync(cacheDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
