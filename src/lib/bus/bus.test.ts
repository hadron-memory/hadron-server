/**
 * Spec 039 Phase 1 — bus foundation.
 *
 * Unit layer (always runs, no broker): the null fallback (D-2026-06-17-004),
 * stream-name derivation, and the reserved-verb NotImplementedError.
 *
 * Integration layer (gated on BUS_TEST_NATS_URL): echo round-trip, dedup
 * window, malformed-payload termination, and pub/sub fan-out (event pivot)
 * against a real broker — start
 * one with `docker compose up -d nats` and run
 * `BUS_TEST_NATS_URL=nats://localhost:4222 pnpm vitest run src/lib/bus`.
 * CI doesn't set the var, so the suite skips there (plan §6: no broker
 * needed in CI). Instead of fixed sleeps, the tests wait on the consumer's
 * actual pending/ack state (PR-462 review).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { connect, type NatsConnection } from '@nats-io/transport-node';
import { jetstream, jetstreamManager } from '@nats-io/jetstream';
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

  it('rejects a dotless subject (would never match its own stream filter)', () => {
    // Stream WEBIMPORT filters `webimport.>`, which does NOT match the bare
    // subject `webimport` — publishing it would fail at the broker with a
    // confusing "no stream matches" (PR-462 review).
    expect(() => streamNameForSubject('webimport')).toThrow(/dot-delimited/);
  });
});

describe.runIf(!!BROKER)('NATS integration', () => {
  let raw: NatsConnection;

  beforeEach(async () => {
    raw = await connect({ servers: BROKER as string, token: process.env.BUS_TEST_NATS_TOKEN });
  });

  afterEach(async () => {
    await raw.drain();
  });

  /**
   * Wait until the consumer has fully settled: nothing left to deliver and
   * nothing awaiting ack. This is the real "the broker is done with this
   * consumer" signal — no fixed sleeps (PR-462 review). Polls every 50ms.
   */
  async function waitForConsumerQuiet(stream: string, durable: string, timeoutMs = 5000) {
    const jsm = await jetstreamManager(raw);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const info = await jsm.consumers.info(stream, durable);
      if (info.num_pending === 0 && info.num_ack_pending === 0 && info.num_redelivered === 0) {
        return;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `consumer ${stream}/${durable} not quiet after ${timeoutMs}ms: ` +
            `pending=${info.num_pending} ackPending=${info.num_ack_pending} redelivered=${info.num_redelivered}`,
        );
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

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

  it('reconciles a pre-existing stream whose subject set drifted', async () => {
    // Simulate an earlier release having provisioned ECHO with a narrower
    // subject filter: ensureStream must widen it to `echo.>` instead of
    // trusting whatever exists (PR-462 review). Uses a marker consumer on a
    // NEW subject under the token to prove delivery works post-heal.
    const jsm = await jetstreamManager(raw);
    const drifted = `echo.drift-probe.${Date.now()}`;
    try {
      const info = await jsm.streams.info('ECHO');
      // Narrow the stream to only the classic test subject.
      await jsm.streams.update('ECHO', { ...info.config, subjects: ['echo.test.v1'] });
    } catch {
      await jsm.streams.add({ name: 'ECHO', subjects: ['echo.test.v1'] });
    }
    const client = await NatsBusClient.connect(BROKER as string, process.env.BUS_TEST_NATS_TOKEN);
    try {
      await client.publish(drifted, { ok: true });
      const post = await jsm.streams.info('ECHO');
      expect(post.config.subjects).toContain('echo.>');
    } finally {
      await client.close();
    }
  });

  it('dedups a re-publish with the same idempotency key (broker msgID window)', async () => {
    const client = await NatsBusClient.connect(BROKER as string, process.env.BUS_TEST_NATS_TOKEN);
    try {
      const marker = `dedup-${process.pid}-${Date.now()}`;
      const seen: string[] = [];
      await client.subscribeQueue('echo.dedup.v1', 'echo-dedup-worker', async (msg) => {
        const m = (msg.payload as { marker?: string })?.marker;
        if (m === marker) seen.push(m);
      });
      await client.publish('echo.dedup.v1', { marker }, { idempotencyKey: marker });
      await client.publish('echo.dedup.v1', { marker }, { idempotencyKey: marker });
      await waitForConsumerQuiet('ECHO', 'echo-dedup-worker');
      expect(seen).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it('terminates (no redelivery) on a malformed JSON payload', async () => {
    const client = await NatsBusClient.connect(BROKER as string, process.env.BUS_TEST_NATS_TOKEN);
    try {
      let handled = 0;
      await client.subscribeQueue('echo.badjson.v1', 'echo-badjson-worker', async () => {
        handled += 1;
      });
      // Bypass publish()'s JSON encoding — raw bytes that aren't JSON.
      await jetstream(raw).publish('echo.badjson.v1', new TextEncoder().encode('{not json'));
      // term() = the broker is done with the message without a handler
      // delivery; quiet-state (no pending, no ack-pending, no redelivered)
      // is the positive signal that it was terminated, not parked.
      await waitForConsumerQuiet('ECHO', 'echo-badjson-worker');
      expect(handled).toBe(0);
    } finally {
      await client.close();
    }
  });

  it('reserved verbs throw NotImplementedError', async () => {
    const client = await NatsBusClient.connect(BROKER as string, process.env.BUS_TEST_NATS_TOKEN);
    try {
      await expect(client.requestReply('echo.rpc.v1', {}, 1000)).rejects.toBeInstanceOf(
        NotImplementedError,
      );
    } finally {
      await client.close();
    }
  });

  it('subscribePubSub rejects job subjects and bad subscriber names', async () => {
    const client = await NatsBusClient.connect(BROKER as string, process.env.BUS_TEST_NATS_TOKEN);
    try {
      await expect(
        client.subscribePubSub('echo.ping.v1', 'sub-a', async () => {}),
      ).rejects.toThrow(/event subjects/);
      await expect(
        client.subscribePubSub('evt.thing.done.v1', 'has.dots', async () => {}),
      ).rejects.toThrow(/subscriberName/);
    } finally {
      await client.close();
    }
  });

  it('subscribePubSub fans out: every subscriber gets every event', async () => {
    const client = await NatsBusClient.connect(BROKER as string, process.env.BUS_TEST_NATS_TOKEN);
    try {
      // Unique marker per run — the EVT stream retains events (Limits, not
      // WorkQueue), so a dirty dev broker can replay earlier runs into a
      // resumed durable. Idempotent-handler contract in miniature.
      const marker = `fan-${process.pid}-${Date.now()}`;
      const hits: Record<string, boolean> = {};
      const done: Promise<void>[] = [];
      for (const name of ['fan-sub-a', 'fan-sub-b']) {
        let resolveHit!: () => void;
        done.push(new Promise<void>((resolve) => (resolveHit = resolve)));
        await client.subscribePubSub('evt.thing.done.v1', name, async (msg) => {
          if ((msg.payload as { marker?: string })?.marker === marker) {
            hits[name] = true;
            resolveHit();
          }
        });
      }
      await client.publish('evt.thing.done.v1', { marker }, { idempotencyKey: marker });
      await Promise.race([
        Promise.all(done),
        new Promise((_, reject) => setTimeout(() => reject(new Error('fan-out timeout (5s)')), 5000)),
      ]);
      expect(hits).toEqual({ 'fan-sub-a': true, 'fan-sub-b': true });
    } finally {
      await client.close();
    }
  });
});
