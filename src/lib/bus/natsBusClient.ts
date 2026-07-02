/**
 * NATS JetStream implementation of BusClient (spec 039 Phase 1).
 *
 * Broker specifics live HERE and nowhere else (D-2026-06-11-007).
 *
 * Stream layout: one stream per top-level subject token — the stream for
 * `webimport.requested.v1` is `WEBIMPORT` with subjects `webimport.>`
 * (naming precedent: D-2026-06-17-003). Streams are auto-provisioned on
 * first publish/subscribe.
 *
 * Retention (plan §11 D10, decided here): **WorkQueue** — a message is
 * removed once acknowledged, which is exactly job semantics (the DB task row
 * is the durable source of truth, the stream is the wake-up transport,
 * D-2026-06-17-004). The trade-off vs Limits+durable: WorkQueue allows only
 * ONE consumer (filter) per subject — fine for job queues, and the
 * subscribePubSub verb (fan-out, NOT WorkQueue) is reserved for when a
 * feature actually needs multi-consumer delivery.
 */

import {
  connect,
  JSONCodec,
  AckPolicy,
  DeliverPolicy,
  RetentionPolicy,
  StorageType,
  type NatsConnection,
  type ConsumerMessages,
} from 'nats';
import {
  NotImplementedError,
  type BusClient,
  type BusPublishOpts,
  type BusQueueHandler,
} from './types.js';

const jc = JSONCodec();

/** `webimport.requested.v1` → `WEBIMPORT` (stream per top-level token). */
export function streamNameForSubject(subject: string): string {
  const tokens = subject.split('.');
  const token = tokens[0];
  // Require ≥2 tokens: a bare `webimport` would derive stream WEBIMPORT with
  // subject filter `webimport.>` — which does NOT match the bare subject
  // itself, so the publish would fail at the broker with a confusing
  // "no stream matches" error (PR-462 review).
  if (tokens.length < 2 || !token || !/^[a-z][a-z0-9-]*$/.test(token)) {
    throw new Error(
      `Bus subject "${subject}" must be dot-delimited with a lowercase top-level token, ` +
        `e.g. "webimport.requested.v1" (D-2026-06-17-003).`,
    );
  }
  return token.toUpperCase();
}

/**
 * True for the NATS "thing doesn't exist" errors (HTTP-shaped code '404' or
 * the JetStream api_error codes: 10059 stream-not-found, 10014
 * consumer-not-found). Anything else — auth, network, transient JetStream
 * hiccups — must NOT fall into a create branch, or the real cause surfaces
 * as a misleading stream/consumer-create error (PR-462 review).
 */
function isNotFound(err: unknown): boolean {
  const e = err as { code?: string; api_error?: { err_code?: number } };
  return e?.code === '404' || e?.api_error?.err_code === 10059 || e?.api_error?.err_code === 10014;
}

// Fetch+convert+LLM pipelines can be slow — give a worker two minutes per
// message before the broker assumes it died and redelivers (plan §6).
const ACK_WAIT_NS = 120 * 1_000_000_000;
// Aligned with the task-row attempts cap (plan §4); poison messages stop
// being redelivered after this many attempts.
const MAX_DELIVER = 5;
// Broker-level idempotency-key dedup window.
const DUPE_WINDOW_NS = 2 * 60 * 60 * 1_000_000_000; // 2h
const NAK_DELAY_MS = 15_000;
// Ceiling on un-acked in-flight deliveries per consumer (see the consumer
// config comment). 8 is generous for LLM-scale handlers; job features can
// add their own tighter throttle.
const MAX_ACK_PENDING = 8;

export class NatsBusClient implements BusClient {
  private readonly ensuredStreams = new Set<string>();
  private readonly consumers: ConsumerMessages[] = [];

  private constructor(private readonly nc: NatsConnection) {}

  static async connect(url: string, token?: string): Promise<NatsBusClient> {
    const nc = await connect({
      servers: url,
      token,
      name: 'hadron-server',
      // Keep retrying forever — the sweep-loop fallback covers the gap, and
      // a broker restart must not permanently sever the app (mirrors the
      // reconnect posture the embedding worker takes toward its endpoint).
      maxReconnectAttempts: -1,
      waitOnFirstConnect: false,
    });
    return new NatsBusClient(nc);
  }

  /** Idempotently provision the subject's stream (WorkQueue, file storage). */
  private async ensureStream(subject: string): Promise<string> {
    const stream = streamNameForSubject(subject);
    if (this.ensuredStreams.has(stream)) return stream;
    const jsm = await this.nc.jetstreamManager();
    try {
      await jsm.streams.info(stream);
    } catch (err) {
      if (!isNotFound(err)) throw err;
      // Genuinely absent (or racing another node) — add() is idempotent for
      // an identical config and throws only on a conflicting one, which is
      // a deploy bug we WANT loud.
      await jsm.streams.add({
        name: stream,
        subjects: [`${stream.toLowerCase()}.>`],
        retention: RetentionPolicy.Workqueue,
        storage: StorageType.File,
        duplicate_window: DUPE_WINDOW_NS,
      });
    }
    this.ensuredStreams.add(stream);
    return stream;
  }

  async publish(subject: string, payload: unknown, opts?: BusPublishOpts): Promise<void> {
    await this.ensureStream(subject);
    const js = this.nc.jetstream();
    await js.publish(subject, jc.encode(payload), {
      msgID: opts?.idempotencyKey,
    });
  }

  async subscribeQueue(
    subject: string,
    queueGroup: string,
    handler: BusQueueHandler,
  ): Promise<() => Promise<void>> {
    const stream = await this.ensureStream(subject);
    const jsm = await this.nc.jetstreamManager();
    try {
      await jsm.consumers.info(stream, queueGroup);
    } catch (err) {
      if (!isNotFound(err)) throw err;
      await jsm.consumers.add(stream, {
        durable_name: queueGroup,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.All,
        filter_subject: subject,
        ack_wait: ACK_WAIT_NS,
        max_deliver: MAX_DELIVER,
        // Concurrency safety net: the broker stops delivering when this many
        // messages are un-acked, so a burst can't fan out into unbounded
        // concurrent handlers racing the ack window (PR-462 review). Phase 4
        // may lower effective concurrency further in the worker itself.
        max_ack_pending: MAX_ACK_PENDING,
      });
    }
    const consumer = await this.nc.jetstream().consumers.get(stream, queueGroup);
    const messages = await consumer.consume({
      callback: (m) => {
        void (async () => {
          // Decode failures are permanent, not transient — a malformed
          // payload would just burn all MAX_DELIVER redeliveries. term()
          // drops it for good (PR-462 review).
          let payload: unknown;
          try {
            payload = jc.decode(m.data);
          } catch (err) {
            console.error(`[bus] malformed JSON payload on ${m.subject} — terminating message:`, err);
            m.term();
            return;
          }
          try {
            await handler({
              subject: m.subject,
              payload,
              redeliveries: m.info.redeliveryCount - 1,
            });
            m.ack();
          } catch (err) {
            console.error(`[bus] handler error on ${m.subject} (delivery ${m.info.redeliveryCount}):`, err);
            m.nak(NAK_DELAY_MS);
          }
        })();
      },
    });
    this.consumers.push(messages);
    return async () => {
      await messages.close();
    };
  }

  async subscribePubSub(
    _subjectPattern: string,
    _handler: BusQueueHandler,
  ): Promise<() => Promise<void>> {
    throw new NotImplementedError('subscribePubSub');
  }

  async requestReply(
    _subject: string,
    _payload: unknown,
    _timeoutMs: number,
  ): Promise<unknown> {
    throw new NotImplementedError('requestReply');
  }

  async close(): Promise<void> {
    for (const c of this.consumers) {
      try {
        await c.close();
      } catch {
        // closing anyway
      }
    }
    await this.nc.drain();
  }
}
