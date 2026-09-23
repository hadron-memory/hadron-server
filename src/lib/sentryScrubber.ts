import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { ErrorEvent, NodeOptions } from '@sentry/node';

type TransactionEvent = Parameters<
  NonNullable<NodeOptions['beforeSendTransaction']>
>[0];
type SpanJSON = Parameters<NonNullable<NodeOptions['beforeSendSpan']>>[0];

const ID_PSEUDONYM_KEY = deriveIdPseudonymKey();

function deriveIdPseudonymKey(): Buffer {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) return randomBytes(32);

  // Different services can use different DSN public keys for one project.
  // Remove credentials and hash only the shared host/path identity. This is a
  // project-scoped salt (not a secret), so high-entropy trace IDs correlate
  // across services without being exported.
  let projectIdentity = dsn;
  try {
    const url = new URL(dsn);
    projectIdentity = `${url.host}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    // Sentry.init will reject an invalid DSN. Keeping the raw value here makes
    // the scrubber fail safe and deterministic until that validation occurs.
  }
  return createHash('sha256')
    .update('hadron-sentry-trace-pseudonym-v1\0')
    .update(projectIdentity)
    .digest();
}

/**
 * Keep only request metadata that cannot carry credentials or caller content.
 *
 * Sentry's RequestData integration copies headers, cookies, query strings and
 * parsed request bodies into error events. That includes bearer credentials,
 * encrypted-memory keys and GraphQL variables. An allow-list is intentional:
 * a deny-list silently becomes incomplete whenever a new credential header or
 * body field is introduced. See cor:sec:040:01 and hadron-server#1268.
 */
export function scrubSentryEvent(event: ErrorEvent): ErrorEvent {
  scrubFreeformPayload(event);
  scrubRequest(event);
  scrubTracePayload(event, false);
  return event;
}

/**
 * Transaction events bypass `beforeSend`. Remove request data, transaction
 * names and span payloads that can contain raw URLs or route credentials.
 */
export function scrubSentryTransaction(
  event: TransactionEvent,
): TransactionEvent {
  scrubFreeformPayload(event);
  scrubRequest(event);
  // With the configured static lifecycle Sentry runs beforeSendSpan for the
  // root and children before assembling the beforeSendTransaction event. Keep
  // those already-pseudonymized identities while rebuilding every payload.
  scrubTracePayload(event, true);
  return event;
}

/** Keep span timing while replacing caller-influenced identity and payloads. */
export function scrubSentrySpan(span: SpanJSON): SpanJSON {
  return rebuildSpan(span, true);
}

function rebuildSpan(span: SpanJSON, pseudonymizeIds: boolean): SpanJSON {
  const { start_timestamp, timestamp, is_segment } = span;
  const translate = (domain: 'trace' | 'span', value: string, bytes: number) =>
    pseudonymizeIds ? pseudonymizeId(domain, value, bytes) : value;
  return {
    trace_id: translate('trace', span.trace_id, 16),
    span_id: translate('span', span.span_id, 8),
    start_timestamp,
    data: {},
    ...(span.parent_span_id
      ? {
          parent_span_id: translate('span', span.parent_span_id, 8),
        }
      : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(is_segment !== undefined ? { is_segment } : {}),
    ...(span.segment_id
      ? {
          segment_id: translate('span', span.segment_id, 8),
        }
      : {}),
  };
}

function scrubFreeformPayload(event: ErrorEvent | TransactionEvent): void {
  // Parser and router errors can echo caller-controlled URL segments in their
  // message. Sentry can also parse newline-delimited fake V8 frames out of an
  // attacker-controlled message. Every parsed frame field is untrusted: even
  // numeric line/column values can encode credential bytes. Drop stacktraces,
  // replace every exception title with a fixed value, and remove other
  // free-form payloads.
  delete event.message;
  delete event.logentry;
  delete event.extra;

  if (!event.exception?.values) return;
  event.exception = {
    values: event.exception.values.map(() => ({
      type: 'Error',
    })),
  };
}

function scrubRequest(event: ErrorEvent | TransactionEvent): void {
  // RequestData keeps the original request here, and incoming trace/baggage
  // headers populate SDK metadata with caller-controlled identifiers/strings.
  delete event.sdkProcessingMetadata;

  // HTTP/fetch breadcrumbs may contain full caller-provided URLs. Drop the
  // whole collection rather than trying to predict every integration shape.
  delete event.breadcrumbs;

  // Apollo adds the client-controlled GraphQL operation name as a tag. Keep
  // only the fixed service discriminator configured by instrument.ts.
  const service = event.tags?.service;
  delete event.tags;
  if (service === 'hadron-server') event.tags = { service };

  if (!event.request) return;

  const { method } = event.request;
  event.request = {
    ...(method ? { method } : {}),
  };
}

function scrubTracePayload(
  event: ErrorEvent | TransactionEvent,
  idsAlreadyPseudonymized: boolean,
): void {
  delete event.transaction;
  const trace = event.contexts?.trace;
  if (!trace) {
    // Without a root context there is no trusted anchor for correlation or for
    // proving that child identifiers already passed through the span hook.
    // Fail closed on both error and transaction events.
    delete event.spans;
    return;
  }
  if (!trace && !event.spans?.length) return;

  if (event.spans) {
    event.spans = event.spans.map((span) =>
      rebuildSpan(span, !idsAlreadyPseudonymized),
    );
  }

  const traceId = trace
    ? idsAlreadyPseudonymized
      ? trace.trace_id
      : pseudonymizeId('trace', trace.trace_id, 16)
    : event.spans![0]!.trace_id;

  if (trace) {
    event.contexts!.trace = {
      trace_id: traceId,
      span_id: idsAlreadyPseudonymized
        ? trace.span_id
        : pseudonymizeId('span', trace.span_id, 8),
      ...(trace.parent_span_id
        ? {
            parent_span_id: idsAlreadyPseudonymized
              ? trace.parent_span_id
              : pseudonymizeId('span', trace.parent_span_id, 8),
          }
        : {}),
    };
  }
  event.sdkProcessingMetadata = {
    dynamicSamplingContext: { trace_id: traceId },
  };
}

function pseudonymizeId(
  domain: 'trace' | 'span',
  value: string,
  bytes: number,
): string {
  return createHmac('sha256', ID_PSEUDONYM_KEY)
    .update(domain)
    .update('\0')
    .update(value)
    .digest('hex')
    .slice(0, bytes * 2);
}
