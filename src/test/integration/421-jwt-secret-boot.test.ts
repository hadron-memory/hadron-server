/**
 * #421: production refuses to boot on a weak JWT_SECRET.
 *
 * Spawns `tsx src/index.ts` as a child, as the spec-025 boot-policy test
 * does: `createServer` throwing in-process would take the runner down. The
 * guard runs before the Cloudflare trust-proxy init, so reaching that init's
 * log proves the guard passed, and its absence after a refusal proves the
 * refusal came first.
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

async function spawnServer(env: Record<string, string>, timeoutMs = 15_000): Promise<SpawnResult> {
  const tsxBin = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
  return new Promise((resolve) => {
    const child = spawn(tsxBin, ['src/index.ts'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        // Inert: nothing in this test should reach Prisma.
        DATABASE_URL: 'postgresql://nobody@127.0.0.1:1/__nonexistent__',
        BASE_URL: 'http://127.0.0.1:4000',
        PORT: '0',
        NODE_ENV: 'production',
        CLOUDFLARE_IPS_API_URL: 'http://127.0.0.1:1/this-port-rejects',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b.toString()));
    child.stderr.on('data', (b) => (stderr += b.toString()));
    // The accepting case boots on into the listener; stop it once the guard
    // is behind it.
    const killTimer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stderr.on('data', () => {
      if (/Boot fetch failed; using cached list/.test(stderr)) child.kill('SIGKILL');
    });
    child.on('exit', (code, signal) => {
      clearTimeout(killTimer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

const REFUSAL = /JWT_SECRET is missing or shorter than 32 bytes/;

describe('#421: production JWT_SECRET boot guard', () => {
  it(
    'refuses a 31-byte secret before serving, without printing it',
    async () => {
      const secret = 'Fx31-' + 'q'.repeat(26);
      expect(Buffer.byteLength(secret)).toBe(31);
      const result = await spawnServer({ JWT_SECRET: secret });

      expect(result.code === null ? result.signal : result.code).not.toBe(0);
      expect(result.stderr).toMatch(REFUSAL);
      // The guard ran first: the Cloudflare init never started.
      expect(result.stderr).not.toMatch(/Cloudflare/);
      expect(result.stdout).not.toMatch(/hadron-server listening/);
      expect(result.stdout + result.stderr).not.toContain(secret);
      expect(result.stdout + result.stderr).not.toContain('qqqq');
    },
    30_000,
  );

  it(
    'gets past the guard with a 32-byte secret',
    async () => {
      const cacheDir = mkdtempSync(join(tmpdir(), '421-boot-guard-test-'));
      const cachePath = join(cacheDir, 'cloudflare-ips.json');
      writeFileSync(
        cachePath,
        JSON.stringify({
          ipv4_cidrs: ['173.245.48.0/20'],
          ipv6_cidrs: ['2400:cb00::/32'],
          fetched_at: '2026-05-19T00:00:00.000Z',
        }),
      );
      try {
        const secret = 'Fx32-' + 'q'.repeat(27);
        expect(Buffer.byteLength(secret)).toBe(32);
        const result = await spawnServer({ JWT_SECRET: secret, CLOUDFLARE_IPS_CACHE_PATH: cachePath });

        expect(result.stderr).not.toMatch(REFUSAL);
        // Positive signal: boot reached the trust-proxy init behind the guard.
        expect(result.stderr).toMatch(/Boot fetch failed; using cached list/);
        expect(result.stdout + result.stderr).not.toContain(secret);
      } finally {
        rmSync(cacheDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
