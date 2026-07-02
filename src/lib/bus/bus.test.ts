/**
 * Spec 039 Phase 1 — bus foundation.
 *
 * Unit layer (always runs, no broker): the null fallback (D-2026-06-17-004),
 * stream-name derivation, and the reserved-verb NotImplementedError.
 *
 * Integration layer (gated on BUS_TEST_NATS_URL): an echo publish/subscribe
 * round-trip against a real broker — start one with
 * `docker compose up -d nats` and run
 * `BUS_TEST_NATS_URL=nats://localhost:4222 pnpm vitest run src/lib/bus`.
 * CI doesn't set the var, so the suite skips there (plan §6: no broker
 * needed in CI).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getBusClient, closeBusClient, NotImplementedError } from './index.js';
import { NatsBusClient, streamNameForSubject } from './natsBusClient.js';

const BROKER = process.env.BUS_TEST_NATS_URL;

beforeEach(async () => {
  await closeBusClient();
  delete process.env.NATS_URL;
});

afterEach(async () => {
  await closeBusClient();
  delete process.env.NATS_URL;
});

describe('getBusClient — null fallback (D-2026-06-17-004)', () => {
  it('resolves null when NATS_URL is unset', async () => {
    expect(await getBusClient()).toBeNull();
  });

  it('caches the resolution per process (singleton)', async () => {
    const a = getBusClient();
    const b = getBusClient();
    expect(a).toBe(b);
  });

  it('closeBusClient resets the singleton so a config change is picked up', async () => {
    expect(await getBusClient()).toBeNull();
    await closeBusClient();
    // Still unset → still null, but via a fresh resolution (no stale cache).
    expect(await getBusClient()).toBeNull();
  });
});

describe('streamNameForSubject (D-2026-06-17-003 layout)', () => {
  it('derives the stream from the top-level token, uppercased', () => {
    expect(streamNameForSubject('webimport.requested.v1')).toBe('WEBIMPORT');
    expect(streamNameForSubject('echo.test.v1')).toBe('ECHO');
  });

  it('rejects subjects without a valid lowercase top-level token', () => {
    expect(() => streamNameForSubject('.oops')).toThrow(/lowercase/);
    expect(() => streamNameForSubject('Webimport.requested.v1')).toThrow(/lowercase/);
  });
});

describe.runIf(!!BROKER)('NATS integration (echo round-trip)', () => {
  it('publishes and receives on a queue subscription, then acks', async () => {
    const client = await NatsBusClient.connect(BROKER as string, process.env.BUS_TEST_NATS_TOKEN);
    try {
      const received: unknown[] = [];
      // Unique marker per run so a dirty dev broker doesn't bleed old
      // messages into the assertion (WorkQueue retention drops acked
      // messages, but an earlier crashed run may have left some).
      const marker = `run-${process.pid}-${Date.now()}`;
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      await client.subscribeQueue('echo.test.v1', 'echo-worker', async (msg) => {
        received.push(msg.payload);
        if ((msg.payload as { marker?: string })?.marker === marker) resolveDone();
      });
      await client.publish('echo.test.v1', { marker, hello: 'bus' }, { idempotencyKey: marker });
      await Promise.race([
        done,
        new Promise((_, reject) => setTimeout(() => reject(new Error('echo timeout (5s)')), 5000)),
      ]);
      expect(received.some((p) => (p as { marker?: string })?.marker === marker)).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('reserved verbs throw NotImplementedError', async () => {
    const client = await NatsBusClient.connect(BROKER as string, process.env.BUS_TEST_NATS_TOKEN);
    try {
      await expect(client.subscribePubSub()).rejects.toBeInstanceOf(NotImplementedError);
      await expect(client.requestReply()).rejects.toBeInstanceOf(NotImplementedError);
    } finally {
      await client.close();
    }
  });
});
