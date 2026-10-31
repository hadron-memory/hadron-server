/**
 * #2998 / cor:api:270:01: GET /ready answers ready once the FIRST startup
 * attempt has settled and the database answers, beside an unchanged /health.
 *
 * Scenarios S1 to S6 of the spec, plus the gate's pins: only the first attempt
 * counts, the body is one of five fixed objects, and /ready shares /health's
 * single in-flight probe.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../test/helpers.js';
import { startup } from '../controller/startup.js';
import * as health from './health.js';
import type { HealthDb } from './health.js';

// S2: a memory whose sync fails. The real startup() runs; only the per-memory
// sync is replaced, and it reports a failure the way a bad clone does.
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn(async () => ({ error: 'clone failed: secret-host' })),
}));

/** The readiness inputs as the route reads them, for pins that set a state directly. */
type Source = { startup(): 'starting' | 'startup_failed' | 'settled'; stopping(): boolean };

const servers: Server[] = [];

async function listen(app: express.Express): Promise<string> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

async function serve(healthDb: HealthDb, readiness: Source, timeoutMs?: number): Promise<string> {
  const app = express();
  health.mountHealthRoutes(app, healthDb, { readiness, ...(timeoutMs === undefined ? {} : { timeoutMs }) } as never);
  return listen(app);
}

const source = (state: ReturnType<Source['startup']>, stopping = false): Source => ({
  startup: () => state,
  stopping: () => stopping,
});

/** The readiness tracker the entry point creates (src/index.ts). */
function tracker() {
  const create = (health as Record<string, unknown>).createReadiness as undefined | (() => {
    startup(): 'starting' | 'startup_failed' | 'settled';
    stopping(): boolean;
    trackFirstStartup(attempt: Promise<unknown>, onError?: (err: unknown) => void): void;
    markStopping(): void;
  });
  if (typeof create !== 'function') throw new Error('health.ts exports no createReadiness (#2998 not built)');
  return create();
}

async function get(base: string, path: string) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.text(), cache: res.headers.get('cache-control') };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

describe('GET /ready (#2998, cor:api:270:01)', () => {
  it('S1: 503 starting while the first startup is pending, while /health answers 200', async () => {
    const base = await serve(db, source('starting'));
    const ready = await get(base, '/ready');
    expect(ready.status).toBe(503);
    expect(JSON.parse(ready.body)).toEqual({ ok: false, error: 'starting' });
    expect(ready.cache).toBe('no-store');
    const live = await get(base, '/health');
    expect(live.status).toBe(200);
    expect(JSON.parse(live.body)).toEqual({ ok: true });
  });

  it('S1 through the tracker: a pending first attempt is starting, then 200 once it settles', async () => {
    const r = tracker();
    let finish!: () => void;
    r.trackFirstStartup(new Promise<void>((res) => (finish = res)));
    const base = await serve(db, r);
    expect(JSON.parse((await get(base, '/ready')).body)).toEqual({ ok: false, error: 'starting' });
    finish();
    await settle();
    const ready = await get(base, '/ready');
    expect(ready.status).toBe(200);
    expect(JSON.parse(ready.body)).toEqual({ ok: true });
    expect(ready.cache).toBe('no-store');
  });

  it('a tracker that never saw a startup attempt is starting, not ready', async () => {
    const base = await serve(db, tracker());
    expect(JSON.parse((await get(base, '/ready')).body)).toEqual({ ok: false, error: 'starting' });
  });

  describe('S2: settled is not synced clean', () => {
    beforeEach(async () => {
      await cleanDb(db);
      const { graph } = await createDbOrgAndGraph(db, { orgName: 'ready-org', graphName: 'ready-memory' });
      await db.memory.update({ where: { id: graph.id }, data: { source: 'git@github.com:fixture/repo.git' } });
    });

    it('200 after the real startup settles with a memory that failed to sync', async () => {
      vi.stubEnv('DISABLE_STARTUP_SYNC', '');
      try {
        const r = tracker();
        const attempt = startup();
        r.trackFirstStartup(attempt);
        await expect(attempt).resolves.toBe('ran');
        await settle();
        const base = await serve(db, r);
        const ready = await get(base, '/ready');
        expect(ready.status).toBe(200);
        expect(JSON.parse(ready.body)).toEqual({ ok: true });
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  it('S3: startup sync turned off reads 200 once startup settles', async () => {
    vi.stubEnv('DISABLE_STARTUP_SYNC', 'true');
    try {
      const r = tracker();
      const attempt = startup();
      r.trackFirstStartup(attempt);
      await attempt;
      await settle();
      const base = await serve(db, r);
      expect((await get(base, '/ready')).status).toBe(200);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('S4: a rejected first attempt is 503 startup_failed with the fixed body and no error text', async () => {
    const r = tracker();
    const logged: unknown[] = [];
    r.trackFirstStartup(Promise.reject(new Error('P1001: cannot reach secret-host:5432')), (err) => logged.push(err));
    await settle();
    const base = await serve(db, r);
    const ready = await get(base, '/ready');
    expect(ready.status).toBe(503);
    expect(ready.body).toBe(JSON.stringify({ ok: false, error: 'startup_failed' }));
    expect(ready.body).not.toContain('secret-host');
    expect(ready.cache).toBe('no-store');
    // The detail goes to the log, not the wire.
    expect(logged).toHaveLength(1);
    // /health never reads startup state.
    expect((await get(base, '/health')).status).toBe(200);
  });

  it('S5: ready, then the database stops answering: both routes 503 database_unavailable over one shared query', async () => {
    let calls = 0;
    let rejectQuery!: (err: Error) => void;
    const failing: HealthDb = {
      $queryRaw: (() => {
        calls += 1;
        return new Promise<void>((_r, rej) => (rejectQuery = rej));
      }) as never,
    };
    const base = await serve(failing, source('settled'), 5_000);
    const probes = [fetch(`${base}/ready`), fetch(`${base}/health`), fetch(`${base}/ready`)];
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toBe(1);
    rejectQuery(new Error('P1001: cannot reach secret-host:5432'));
    const answers = await Promise.all(probes);
    expect(answers.map((a) => a.status)).toEqual([503, 503, 503]);
    for (const a of answers) {
      const body = await a.text();
      expect(body).toBe(JSON.stringify({ ok: false, error: 'database_unavailable' }));
      expect(a.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('S5: a database that hangs past the bound reads database_unavailable', async () => {
    const hung: HealthDb = { $queryRaw: (() => new Promise<void>(() => {})) as never };
    const base = await serve(hung, source('settled'), 200);
    const ready = await get(base, '/ready');
    expect(ready.status).toBe(503);
    expect(JSON.parse(ready.body)).toEqual({ ok: false, error: 'database_unavailable' });
  });

  it('S6: after the shutdown signal a probe on an open connection gets 503 stopping', async () => {
    const r = tracker();
    r.trackFirstStartup(Promise.resolve('ran'));
    await settle();
    const base = await serve(db, r);
    expect((await get(base, '/ready')).status).toBe(200);
    r.markStopping();
    const ready = await get(base, '/ready');
    expect(ready.status).toBe(503);
    expect(ready.body).toBe(JSON.stringify({ ok: false, error: 'stopping' }));
    expect(ready.cache).toBe('no-store');
    // /health keeps answering liveness while the server drains.
    expect((await get(base, '/health')).status).toBe(200);
  });

  it('stopping wins over every other state', async () => {
    for (const state of ['starting', 'startup_failed', 'settled'] as const) {
      const base = await serve(db, source(state, true));
      expect(JSON.parse((await get(base, '/ready')).body)).toEqual({ ok: false, error: 'stopping' });
    }
  });

  it('only the first attempt counts: a later attempt that rejects leaves /ready at 200', async () => {
    const r = tracker();
    r.trackFirstStartup(Promise.resolve('ran'));
    await settle();
    r.trackFirstStartup(Promise.reject(new Error('reload failed')), () => {});
    await settle();
    const base = await serve(db, r);
    expect((await get(base, '/ready')).status).toBe(200);
  });

  it('only the first attempt counts: a later attempt that succeeds does not rescue a failed first one', async () => {
    const r = tracker();
    r.trackFirstStartup(Promise.reject(new Error('first failed')), () => {});
    await settle();
    r.trackFirstStartup(Promise.resolve('ran'));
    await settle();
    const base = await serve(db, r);
    expect(JSON.parse((await get(base, '/ready')).body)).toEqual({ ok: false, error: 'startup_failed' });
  });

  it('records no usage', async () => {
    const before = await db.usageEvent.count();
    const base = await serve(db, source('settled'));
    for (let i = 0; i < 3; i += 1) expect((await get(base, '/ready')).status).toBe(200);
    expect(await db.usageEvent.count()).toBe(before);
  });
});

describe('createServer mounts /ready from the readiness it is given (#2998)', () => {
  it('serves the passed readiness', async () => {
    const { createServer } = await import('../server.js');
    const r = tracker();
    const app = await (createServer as (opts?: unknown) => Promise<express.Express>)({ readiness: r });
    const base = await listen(app);
    expect(JSON.parse((await get(base, '/ready')).body)).toEqual({ ok: false, error: 'starting' });
    r.trackFirstStartup(Promise.resolve('ran'));
    await settle();
    expect((await get(base, '/ready')).status).toBe(200);
  });
});
