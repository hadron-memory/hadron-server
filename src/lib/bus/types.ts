/**
 * BusClient — the platform message-bus abstraction (spec 039 Phase 1).
 *
 * The interface is DELIBERATELY narrow (D-2026-06-11-007): four verbs, no
 * broker-specific types past this boundary. NATS JetStream is the V1
 * implementation (natsBusClient.ts), but nothing outside src/lib/bus/ may
 * depend on that — swapping brokers must stay a this-directory change.
 *
 * Delivery contract: AT-LEAST-ONCE. Every queue handler MUST be idempotent —
 * pass an idempotency key with publish() and make the handler's first action
 * an atomic claim (the spec-033 embedding worker / prisma-upsert-not-race-safe
 * pattern). Duplicate delivery is normal operation, not an error.
 *
 * Tenancy is application-level in V1: org/app identifiers travel in the
 * payload and subject convention, not in broker ACLs.
 *
 * Subjects are versioned and dot-delimited, owned by hadron-server
 * (D-2026-06-17-003): e.g. `webimport.requested.v1`.
 */

/** A decoded message delivered to a queue handler. */
export interface BusMessage {
  subject: string;
  /** JSON-decoded payload (publish() JSON-encodes). */
  payload: unknown;
  /**
   * How many times this message has been delivered BEFORE this attempt
   * (0 = first delivery). At-least-once: use with the idempotency claim.
   */
  redeliveries: number;
}

/**
 * Queue handler. Resolve → the message is acknowledged (done, never
 * redelivered). Throw → negative-ack; the broker redelivers after a delay,
 * up to the subscription's max-deliver cap.
 */
export type BusQueueHandler = (msg: BusMessage) => Promise<void>;

export interface BusPublishOpts {
  /**
   * Broker-level dedup key (REQUIRED by convention for job subjects — see
   * the delivery contract above). Re-publishing the same key within the
   * broker's dedup window is a no-op.
   */
  idempotencyKey?: string;
}

/**
 * The narrow platform bus interface (D-2026-06-11-007, verbatim shape).
 * V1 implements publish + subscribeQueue for real; subscribePubSub and
 * requestReply throw NotImplementedError until a feature needs them —
 * interface complete, implementation on demand.
 */
export interface BusClient {
  /** JSON-encode and durably publish payload on subject. */
  publish(subject: string, payload: unknown, opts?: BusPublishOpts): Promise<void>;

  /**
   * Durable work-queue subscription: messages on `subject` are distributed
   * across the members of `queueGroup` (one delivery per message per group),
   * with explicit ack and redelivery on failure. Returns an unsubscribe
   * function (stops consuming; the durable consumer itself is retained so a
   * restart resumes where it left off).
   */
  subscribeQueue(
    subject: string,
    queueGroup: string,
    handler: BusQueueHandler,
  ): Promise<() => Promise<void>>;

  /** Fan-out pub/sub over a subject pattern. NOT IMPLEMENTED in V1. */
  subscribePubSub(
    subjectPattern: string,
    handler: BusQueueHandler,
  ): Promise<() => Promise<void>>;

  /** Request/reply RPC. NOT IMPLEMENTED in V1. */
  requestReply(subject: string, payload: unknown, timeoutMs: number): Promise<unknown>;

  /** Drain in-flight work and close the connection. */
  close(): Promise<void>;
}

/** Thrown by the V1 client for the two not-yet-needed verbs. */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not implemented in the V1 bus client (interface reserved by D-2026-06-11-007).`);
    this.name = 'NotImplementedError';
  }
}
