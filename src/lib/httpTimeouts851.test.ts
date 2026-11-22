/**
 * #851 — the HTTP server's keep-alive and headers timeouts, and the image's readiness HEALTHCHECK.
 *
 * Node's default keep-alive window (5 s) is far below the 90 s Traefik reuses an idle backend connection for, so the
 * proxy can send a request down a connection the origin has just closed: an intermittent 502 with nothing in the app's
 * log. The fix is a window above the proxy's, set from named env vars with safe fallbacks (cor-free: server tuning).
 *
 * The Docker HEALTHCHECK is pinned by what it DOES, not only by its text: the probe command is lifted out of the
 * Dockerfile and run against a real listener, so the pin fails if it stops following PORT, probes the wrong path or
 * treats a non-200 as healthy. The readiness-only condition (cor:api:270:01) is pinned as Dockerfile text.
 */
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  applyHttpTimeouts,
  httpTimeoutsFromEnv,
  HTTP_HEADERS_TIMEOUT_DEFAULT_MS,
  HTTP_KEEP_ALIVE_TIMEOUT_DEFAULT_MS,
} from './httpTimeouts.js';

const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv;
const TRAEFIK_DEFAULT_IDLE_MS = 90_000;

describe('#851 timeout configuration', () => {
  it('defaults to 120 s keep-alive and 125 s headers, both above Traefik\'s 90 s reuse', () => {
    const t = httpTimeoutsFromEnv(env({}));
    expect(t).toEqual({ keepAliveTimeoutMs: 120_000, headersTimeoutMs: 125_000 });
    expect(HTTP_KEEP_ALIVE_TIMEOUT_DEFAULT_MS).toBeGreaterThan(TRAEFIK_DEFAULT_IDLE_MS);
    expect(HTTP_HEADERS_TIMEOUT_DEFAULT_MS).toBeGreaterThan(HTTP_KEEP_ALIVE_TIMEOUT_DEFAULT_MS);
  });

  it('reads both from their named variables', () => {
    expect(httpTimeoutsFromEnv(env({ HTTP_KEEP_ALIVE_TIMEOUT_MS: '95000', HTTP_HEADERS_TIMEOUT_MS: '100000' })))
      .toEqual({ keepAliveTimeoutMs: 95_000, headersTimeoutMs: 100_000 });
  });

  it.each(['', ' ', '0', '-1', '+120000', '1.5e5', '0x1d4c0', '120.5', '999', '290001', '999999', 'abc', '120000ms'])(
    'falls back to the default for the invalid value %j',
    (bad) => {
      expect(httpTimeoutsFromEnv(env({ HTTP_KEEP_ALIVE_TIMEOUT_MS: bad, HTTP_HEADERS_TIMEOUT_MS: bad })))
        .toEqual({ keepAliveTimeoutMs: 120_000, headersTimeoutMs: 125_000 });
    },
  );

  it('keeps headers above keep-alive however it is configured', () => {
    // Headers at or below keep-alive is raised to keep-alive + 5 s, never honoured.
    expect(httpTimeoutsFromEnv(env({ HTTP_KEEP_ALIVE_TIMEOUT_MS: '130000', HTTP_HEADERS_TIMEOUT_MS: '130000' })))
      .toEqual({ keepAliveTimeoutMs: 130_000, headersTimeoutMs: 135_000 });
    expect(httpTimeoutsFromEnv(env({ HTTP_KEEP_ALIVE_TIMEOUT_MS: '130000', HTTP_HEADERS_TIMEOUT_MS: '60000' })))
      .toEqual({ keepAliveTimeoutMs: 130_000, headersTimeoutMs: 135_000 });
    // A longer keep-alive with headers unset or invalid moves headers with it.
    expect(httpTimeoutsFromEnv(env({ HTTP_KEEP_ALIVE_TIMEOUT_MS: '200000' })))
      .toEqual({ keepAliveTimeoutMs: 200_000, headersTimeoutMs: 205_000 });
    expect(httpTimeoutsFromEnv(env({ HTTP_KEEP_ALIVE_TIMEOUT_MS: '200000', HTTP_HEADERS_TIMEOUT_MS: 'junk' })))
      .toEqual({ keepAliveTimeoutMs: 200_000, headersTimeoutMs: 205_000 });
    // A lone headers value below the default keep-alive is raised too.
    expect(httpTimeoutsFromEnv(env({ HTTP_HEADERS_TIMEOUT_MS: '50000' })))
      .toEqual({ keepAliveTimeoutMs: 120_000, headersTimeoutMs: 125_000 });
  });

  it('applies the values to a real http.Server (Node accepts them and keeps them)', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    expect(server.keepAliveTimeout).toBe(5_000); // Node's own default, the thing this replaces
    const applied = applyHttpTimeouts(server, env({}));
    expect(applied).toEqual({ keepAliveTimeoutMs: 120_000, headersTimeoutMs: 125_000 });
    expect(server.keepAliveTimeout).toBe(120_000);
    expect(server.headersTimeout).toBe(125_000);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    // Still what we set once listening, and the server still serves.
    expect(server.keepAliveTimeout).toBe(120_000);
    const port = (server.address() as AddressInfo).port;
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('ok');
    await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
  });
});

describe('#851 Dockerfile readiness HEALTHCHECK', () => {
  const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
  const instruction = dockerfile.split('\n').reduce<string[]>((acc, line) => {
    if (acc.length === 0 ? line.startsWith('HEALTHCHECK') : /\\\s*$/.test(acc[acc.length - 1])) acc.push(line);
    return acc;
  }, []).join('\n');

  it('declares exactly one HEALTHCHECK, with a start period and retries tolerant of a long first sync', () => {
    expect(dockerfile.match(/^HEALTHCHECK/gm)).toHaveLength(1);
    const startPeriod = Number(/--start-period=(\d+)s/.exec(instruction)?.[1]);
    const retries = Number(/--retries=(\d+)/.exec(instruction)?.[1]);
    const interval = Number(/--interval=(\d+)s/.exec(instruction)?.[1]);
    expect(startPeriod).toBeGreaterThanOrEqual(120);
    expect(retries).toBeGreaterThanOrEqual(3);
    expect(interval).toBeGreaterThan(0);
  });

  it('states in the Dockerfile that the status is readiness only and nothing may restart on unhealthy', () => {
    expect(dockerfile).toMatch(/READINESS, not liveness/);
    expect(dockerfile).toMatch(/nothing may restart or replace the\s+# container on `unhealthy`/);
    expect(dockerfile).toMatch(/Liveness stays `\/health`/);
  });

  // The probe, lifted out of the instruction's exec-form CMD.
  it('states the deploy consequence: a reader of the status acts on it (Traefik routes on it, Swarm would replace)', () => {
    expect(dockerfile).toMatch(/DEPLOY CONSEQUENCE/);
    expect(dockerfile).toMatch(/Traefik's Docker\s+# provider drops a container that is `starting` or `unhealthy` from routing/);
    expect(dockerfile).toMatch(/Docker Swarm would\s+# instead REPLACE an unhealthy task/);
    expect(dockerfile).not.toMatch(/advisory/i);
  });

  // Lazy, so a missing HEALTHCHECK fails the Dockerfile pins one by one instead of the whole file at collection.
  const probeScriptOf = (): string => {
    const m = /CMD\s+(\[.*\])\s*$/m.exec(instruction);
    expect(m, 'the HEALTHCHECK has an exec-form CMD').not.toBeNull();
    const cmd = JSON.parse(m![1]) as string[];
    expect(cmd.slice(0, 2)).toEqual(['node', '-e']);
    return cmd[2];
  };
  const probe = (port: string | undefined) =>
    new Promise<number>((resolve) => {
      const childEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH };
      if (port !== undefined) childEnv.PORT = port;
      execFile(process.execPath, ['-e', probeScriptOf()], { env: childEnv, timeout: 10_000 }, (err) => {
        resolve(err ? ((err as NodeJS.ErrnoException & { code?: number }).code as number | undefined) ?? 1 : 0);
      });
    });
  const listener = async (status: number) => {
    const seen: string[] = [];
    const server = http.createServer((req, res) => { seen.push(req.url ?? ''); res.statusCode = status; res.end('{}'); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return {
      port: String((server.address() as AddressInfo).port),
      seen,
      close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
    };
  };

  it('probes GET /ready on the container\'s PORT and is healthy only on a 200', async () => {
    const ok = await listener(200);
    expect(await probe(ok.port)).toBe(0);
    expect(ok.seen).toEqual(['/ready']);
    await ok.close();
  });

  it.each([503, 500, 404, 204, 302])('is not healthy on a %i answer', async (status) => {
    const l = await listener(status);
    expect(await probe(l.port)).toBe(1);
    await l.close();
  });

  it('is not healthy when nothing is listening', async () => {
    const l = await listener(200);
    const { port } = l;
    await l.close();
    expect(await probe(port)).toBe(1);
  });

  it('defaults to the server\'s own default port, 4000, when PORT is unset', () => {
    expect(probeScriptOf()).toContain('process.env.PORT||4000');
    const indexSrc = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(indexSrc).toMatch(/Number\(process\.env\.PORT \?\? 4000\)/);
  });
});
