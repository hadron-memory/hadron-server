/**
 * NATS JetStream implementation of BusClient (spec 039 Phase 1).
 *
 * Broker specifics live HERE and nowhere else (D-2026-06-11-007). Built on
 * the @nats-io/* v3 family (transport-node + jetstream) — the legacy `nats`
 * v2 package is deprecated/maintenance-mode (PR-462 review).
 *
 * Stream layout: one stream per top-level subject token — the stream for
 * `webimport.requested.v1` is `WEBIMPORT` with subjects `webimport.>`
 * (naming precedent: D-2026-06-17-003). Streams are auto-provisioned on
 * first publish/subscribe, and an EXISTING stream whose subject set drifted
 * (e.g. provisioned by an earlier release with a narrower filter) is
 * self-healed to include the token wildcard — otherwise publishes to new
 * subjects under the token fail with a mystifying "no stream matches".
 *
 * Retention is decided by subject kind (see the conventions in types.ts):
 *
 *   JOB streams (any non-`evt` token): **WorkQueue** — a message is removed
 *   once acknowledged, which is exactly job semantics (the DB task row is
 *   the durable source of truth, the stream is the wake-up transport,
 *   D-2026-06-17-004). The trade-off: WorkQueue allows only ONE consumer
 *   (filter) per subject — fine for job queues.
 *
 *   The EVENT stream (`EVT`, subjects `evt.>`): **Limits** with a bounded
 *   max_age — WorkQueue physically can't fan out (one consumer per subject),
 *   so events retain messages for a window and each subscriber tracks its
 *   own durable cursor. The age bound (not ack-based removal) is what lets a
 *   restarting subscriber resume and a NEW subscriber replay recent history.
 */

import { connect, type NatsConnection } from '@nats-io/transport-node';
import {
  jetstream,
  jetstreamManager,
  AckPolicy,
  DeliverPolicy,
  RetentionPolicy,
  StorageType,
  JetStreamApiError,
  JetStreamApiCodes,
  type ConsumerMessages,
} from '@nats-io/jetstream';
import {
  NotImplementedError,
  type BusClient,
  type BusPublishOpts,
  type BusQueueHandler,
} from './types.js';

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
// Event-stream retention window (Limits streams): long enough that a
// restarting/redeployed subscriber never misses events, short enough that a
// BRAND-NEW subscriber's DeliverPolicy.All replay stays cheap. Event
// handlers are idempotent by contract, so the exact value is operational
// tuning, not correctness.
const EVENT_MAX_AGE_NS = 48 * 60 * 60 * 1_000_000_000; // 48h
// The single fan-out stream for `evt.>` subjects (types.ts conventions).
const EVENT_STREAM = 'EVT';

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

  /**
   * Idempotently provision the subject's stream (WorkQueue, file storage) —
   * and reconcile an existing stream whose subject set doesn't cover the
   * token wildcard (config drift from an earlier release; PR-462 review).
   */
  private async ensureStream(subject: string): Promise<string> {
    const stream = streamNameForSubject(subject);
    if (this.ensuredStreams.has(stream)) return stream;
    const wildcard = `${stream.toLowerCase()}.>`;
    const jsm = await jetstreamManager(this.nc);
    try {
      const info = await jsm.streams.info(stream);
      if (!info.config.subjects?.includes(wildcard)) {
        // REPLACE the subject set — the wildcard covers every subject under
        // the token, and JetStream rejects overlapping subjects within a
        // stream, so appending would fail with "overlaps with".
        await jsm.streams.update(stream, { ...info.config, subjects: [wildcard] });
      }
    } catch (err) {
      // Only a genuine not-found may fall into the create branch — auth or
      // network failures must surface as themselves (PR-462 review).
      if (!(err instanceof JetStreamApiError && err.code === JetStreamApiCodes.StreamNotFound)) {
        throw err;
      }
      // Genuinely absent (or racing another node) — add() is idempotent for
      // an identical config and throws only on a conflicting one, which is
      // a deploy bug we WANT loud. Retention by subject kind: the EVT stream
      // fans out (Limits + age window), job streams are queues (WorkQueue).
      await jsm.streams.add({
        name: stream,
        subjects: [wildcard],
        retention: stream === EVENT_STREAM ? RetentionPolicy.Limits : RetentionPolicy.Workqueue,
        storage: StorageType.File,
        duplicate_window: DUPE_WINDOW_NS,
        ...(stream === EVENT_STREAM ? { max_age: EVENT_MAX_AGE_NS } : {}),
      });
    }
    this.ensuredStreams.add(stream);
    return stream;
  }

  async publish(subject: string, payload: unknown, opts?: BusPublishOpts): Promise<void> {
    await this.ensureStream(subject);
    const js = jetstream(this.nc);
    await js.publish(subject, JSON.stringify(payload), {
      msgID: opts?.idempotencyKey,
    });
  }

  /**
   * Idempotently provision a durable consumer on `stream` filtered to
   * `filterSubject`, then attach `handler` with the shared ack discipline:
   * malformed JSON terminates the message (permanent, don't burn
   * redeliveries — PR-462 review), handler errors nak with a delay for
   * spaced redelivery up to MAX_DELIVER, success acks. Shared by
   * subscribeQueue (jobs) and subscribePubSub (events) — the delivery
   * contract is identical; only stream retention differs.
   */
  private async consumeDurable(
    stream: string,
    durableName: string,
    filterSubject: string,
    handler: BusQueueHandler,
  ): Promise<() => Promise<void>> {
    const jsm = await jetstreamManager(this.nc);
    try {
      await jsm.consumers.info(stream, durableName);
    } catch (err) {
      if (!(err instanceof JetStreamApiError && err.code === JetStreamApiCodes.ConsumerNotFound)) {
        throw err;
      }
      await jsm.consumers.add(stream, {
        durable_name: durableName,
        ack_policy: AckPolicy.Explicit,
        // All (not New): covers the gap between stream creation and this
        // consumer's first registration — for events it also means a new
        // subscriber replays the retained window, which idempotent handlers
        // absorb (types.ts contract).
        deliver_policy: DeliverPolicy.All,
        filter_subject: filterSubject,
        ack_wait: ACK_WAIT_NS,
        max_deliver: MAX_DELIVER,
        // Concurrency safety net: the broker stops delivering when this many
        // messages are un-acked, so a burst can't fan out into unbounded
        // concurrent handlers racing the ack window (PR-462 review). Phase 4
        // may lower effective concurrency further in the worker itself.
        max_ack_pending: MAX_ACK_PENDING,
      });
    }
    const consumer = await jetstream(this.nc).consumers.get(stream, durableName);
    const messages = await consumer.consume({
      callback: (m) => {
        void (async () => {
          // Decode failures are permanent, not transient — a malformed
          // payload would just burn all MAX_DELIVER redeliveries. term()
          // drops it for good (PR-462 review).
          let payload: unknown;
          try {
            payload = m.json();
          } catch (err) {
            console.error(`[bus] malformed JSON payload on ${m.subject} — terminating message:`, err);
            m.term();
            return;
          }
          try {
            await handler({
              subject: m.subject,
              payload,
              // deliveryCount is 1 on first delivery → 0-based redeliveries.
              redeliveries: m.info.deliveryCount - 1,
            });
            m.ack();
          } catch (err) {
            console.error(`[bus] handler error on ${m.subject} (delivery ${m.info.deliveryCount}):`, err);
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

  async subscribeQueue(
    subject: string,
    queueGroup: string,
    handler: BusQueueHandler,
  ): Promise<() => Promise<void>> {
    const stream = await this.ensureStream(subject);
    return this.consumeDurable(stream, queueGroup, subject, handler);
  }

  async subscribePubSub(
    subjectPattern: string,
    subscriberName: string,
    handler: BusQueueHandler,
  ): Promise<() => Promise<void>> {
    // Event subjects live on the fan-out stream — reject a job subject here
    // loudly: subscribing it via pub/sub would silently compete with the
    // queue consumer for WorkQueue-retained messages.
    if (streamNameForSubject(subjectPattern) !== EVENT_STREAM) {
      throw new Error(
        `subscribePubSub is for event subjects ("evt.…"); got "${subjectPattern}". ` +
          `Use subscribeQueue for job subjects (src/lib/bus/types.ts conventions).`,
      );
    }
    // The durable-consumer name must be broker-safe (no dots — JetStream
    // reserves them) and stable across releases: it IS the subscriber's
    // resume cursor.
    if (!/^[A-Za-z0-9_-]+$/.test(subscriberName)) {
      throw new Error(
        `Invalid subscriberName "${subscriberName}" — use [A-Za-z0-9_-]+ (it names the durable consumer).`,
      );
    }
    const stream = await this.ensureStream(subjectPattern);
    return this.consumeDurable(stream, subscriberName, subjectPattern, handler);
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
