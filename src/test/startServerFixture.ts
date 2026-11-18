/**
 * #3066: the one way a test file starts the real app. A worker's database clone keeps the
 * previous file's rows, including the synthetic rate-limit key manifest a rate-limit file
 * plants; `createServer()` reads that manifest at startup (`assertRateReadiness`) and refuses
 * to boot if the current ring cannot account for it. Cleaning first restores the valid
 * seeded state, so production readiness and rate code stay untouched and a genuinely
 * invalid configuration (missing key, fingerprint mismatch) still refuses.
 *
 * `startServerFixture.guard3066.test.ts` fails any test file that calls `createServer()`
 * in a hook without going through this helper.
 */
import type { Express } from 'express';
import type { Server } from 'node:http';
import { createServer } from '../server.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from './helpers.js';

/** Empty the worker database, then build the app. */
export async function createServerOnCleanDb(): Promise<Express> {
  await cleanDb(db);
  return createServer();
}

/**
 * Close a listener from `afterAll`. When `beforeAll` failed before the server was assigned,
 * this is a no-op, so the startup error stays the one that is reported.
 */
export async function closeServerIfStarted(server: Server | undefined): Promise<void> {
  if (!server?.listening) return; // never assigned, or startup failed before listen: nothing to close
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}
