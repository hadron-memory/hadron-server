/**
 * Bus entry point (spec 039 Phase 1).
 *
 * `getBusClient()` is the ONLY way features obtain a bus handle:
 *   - `NATS_URL` set   → a lazily-connected, process-wide NATS client.
 *   - `NATS_URL` unset → `null`, always. The open core runs standalone
 *     (D-2026-06-17-004): features MUST degrade to their DB-backed sweep
 *     loops when this returns null — absence of a broker never breaks boot
 *     or the API.
 *
 * Env:
 *   NATS_URL    e.g. nats://172.17.0.1:4222 (alpha: the Docker bridge
 *               gateway — NATS runs bare-metal on the host) or
 *               nats://localhost:4222 (compose `nats` service in dev).
 *   NATS_TOKEN  static-token auth (D-2026-06-11-007 V1 tier). Optional in
 *               dev; required on alpha once the ops checklist lands.
 */

import { NatsBusClient } from './natsBusClient.js';
import type { BusClient } from './types.js';

export type { BusClient, BusMessage, BusPublishOpts, BusQueueHandler } from './types.js';
export { NotImplementedError } from './types.js';

let clientPromise: Promise<BusClient | null> | null = null;

export function getBusClient(): Promise<BusClient | null> {
  if (clientPromise) return clientPromise;
  const url = process.env.NATS_URL;
  if (!url) {
    clientPromise = Promise.resolve(null);
    return clientPromise;
  }
  clientPromise = NatsBusClient.connect(url, process.env.NATS_TOKEN).catch((err) => {
    // A broker that's configured but unreachable at first touch: log, return
    // null for THIS process lifetime (features fall back to their sweep
    // loops), and let the next boot retry. Never throw past this boundary.
    console.error(`[bus] failed to connect to NATS at ${url}:`, err);
    return null;
  });
  return clientPromise;
}

/** Close and forget the process-wide client (shutdown + tests). */
export async function closeBusClient(): Promise<void> {
  const p = clientPromise;
  clientPromise = null;
  const client = p ? await p : null;
  if (client) {
    await client.close().catch((err) => console.error('[bus] close error:', err));
  }
}
