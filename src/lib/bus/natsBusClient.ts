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
  const token = subject.split('.')[0];
  if (!token || !/^[a-z][a-z0-9-]*$/.test(token)) {
    throw new Error(
      `Bus subject "${subject}" must start with a lowercase dot-delimited token (D-2026-06-17-003).`,
    );
  }
  return token.toUpperCase();
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
    } catch {
      // Not found (or racing another node) — add() is idempotent for an
      // identical config and throws only on a conflicting one, which is a
      // deploy bug we WANT loud.
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
    } catch {
      await jsm.consumers.add(stream, {
        durable_name: queueGroup,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.All,
        filter_subject: subject,
        ack_wait: ACK_WAIT_NS,
        max_deliver: MAX_DELIVER,
      });
    }
    const consumer = await this.nc.jetstream().consumers.get(stream, queueGroup);
    const messages = await consumer.consume({
      callback: (m) => {
        void (async () => {
          try {
            await handler({
              subject: m.subject,
              payload: jc.decode(m.data),
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

  async subscribePubSub(): Promise<() => Promise<void>> {
    throw new NotImplementedError('subscribePubSub');
  }

  async requestReply(): Promise<unknown> {
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
