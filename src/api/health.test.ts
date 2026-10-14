/**
 * #1906 — GET /health must fail the way the app fails.
 *
 * The 2026-10-14 outage was Prisma pool exhaustion (P2024) with Postgres
 * itself healthy, and the old `/health` answered 200 throughout. The check
 * therefore runs through the app's OWN pool; the wedged-pool case below is
 * the reproduction, and a raw ping would pass it.
 */

import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { PrismaClient } from '../generated/prisma/index.js';
import { db } from '../integrations/db/client.js';
import { mountHealthRoutes, type HealthDb } from './health.js';

const servers: Server[] = [];
const clients: PrismaClient[] = [];

async function serve(healthDb: HealthDb, timeoutMs?: number): Promise<string> {
  const app = express();
  mountHealthRoutes(app, healthDb, timeoutMs === undefined ? {} : { timeoutMs });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

/** A client with ONE pooled connection, so holding it wedges the pool. */
function singleConnectionClient(): PrismaClient {
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set('connection_limit', '1');
  // Longer than the health timeout, so only the health check's own timeout
  // can end the wait — exactly the production shape (pool_timeout 10s).
  url.searchParams.set('pool_timeout', '30');
  const client = new PrismaClient({ datasourceUrl: url.toString() });
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  await Promise.all(clients.splice(0).map((c) => c.$disconnect()));
});

describe('GET /health (#1906)', () => {
  it('answers 200 through the real pool, uncached', async () => {
    const base = await serve(db);
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('answers 503 within its timeout when every pool connection is held', async () => {
    const wedged = singleConnectionClient();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let acquired!: () => void;
    const holding = new Promise<void>((r) => (acquired = r));
    // Hold the pool's only connection open, as five 12-minute queries did.
    const holder = wedged.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1`;
        acquired();
        await held;
      },
      { maxWait: 5_000, timeout: 60_000 },
    );
    await holding;

    const base = await serve(wedged, 300);
    const started = Date.now();
    const res = await fetch(`${base}/health`);
    const elapsed = Date.now() - started;
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'database_unavailable' });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(elapsed).toBeLessThan(5_000);

    // Releasing the pool recovers the endpoint: the check is not latched.
    release();
    await holder;
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it('answers 503 without the error text when the query fails', async () => {
    const failing: HealthDb = {
      $queryRaw: (() =>
        Promise.reject(new Error('P1001: cannot reach db at secret-host:5432'))) as never,
    };
    const base = await serve(failing);
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ ok: false, error: 'database_unavailable' });
    expect(body).not.toContain('secret-host');
  });

  it('shares one in-flight query across concurrent probes', async () => {
    let calls = 0;
    let resolveQuery!: () => void;
    const slow: HealthDb = {
      $queryRaw: (() => {
        calls += 1;
        return new Promise<void>((r) => (resolveQuery = r));
      }) as never,
    };
    const base = await serve(slow, 5_000);
    const probes = [fetch(`${base}/health`), fetch(`${base}/health`), fetch(`${base}/health`)];
    // Let all three requests reach the handler before the query settles.
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toBe(1);
    resolveQuery();
    expect((await Promise.all(probes)).map((r) => r.status)).toEqual([200, 200, 200]);

    // Settled ⇒ the next probe runs a fresh query.
    const next = fetch(`${base}/health`);
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toBe(2);
    resolveQuery();
    expect((await next).status).toBe(200);
  });

  it('records no usage', async () => {
    const before = await db.usageEvent.count();
    const base = await serve(db);
    for (let i = 0; i < 3; i += 1) expect((await fetch(`${base}/health`)).status).toBe(200);
    expect(await db.usageEvent.count()).toBe(before);
  });
});
