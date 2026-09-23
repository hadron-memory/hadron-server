import type { ErrorEvent, NodeOptions } from '@sentry/node';

type TransactionEvent = Parameters<
  NonNullable<NodeOptions['beforeSendTransaction']>
>[0];
type SpanJSON = Parameters<NonNullable<NodeOptions['beforeSendSpan']>>[0];

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
  scrubRequest(event);
  scrubTracePayload(event);
  return event;
}

/**
 * Transaction events bypass `beforeSend`. Remove request data, transaction
 * names and span payloads that can contain raw URLs or route credentials.
 */
export function scrubSentryTransaction(
  event: TransactionEvent,
): TransactionEvent {
  scrubRequest(event);
  scrubTracePayload(event);
  return event;
}

/** Keep span timing/identity while discarding request descriptions and data. */
export function scrubSentrySpan(span: SpanJSON): SpanJSON {
  const {
    trace_id,
    span_id,
    start_timestamp,
    parent_span_id,
    timestamp,
    op,
    status,
    origin,
    is_segment,
    segment_id,
  } = span;
  return {
    trace_id,
    span_id,
    start_timestamp,
    data: {},
    ...(parent_span_id ? { parent_span_id } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(op ? { op } : {}),
    ...(status ? { status } : {}),
    ...(origin ? { origin } : {}),
    ...(is_segment !== undefined ? { is_segment } : {}),
    ...(segment_id ? { segment_id } : {}),
  };
}

function scrubRequest(event: ErrorEvent | TransactionEvent): void {
  if (event.sdkProcessingMetadata) {
    const { normalizedRequest: _sensitiveRequest, ...safeMetadata } =
      event.sdkProcessingMetadata;
    event.sdkProcessingMetadata = safeMetadata;
  }

  if (!event.request) return;

  const { method } = event.request;
  event.request = {
    ...(method ? { method } : {}),
  };
}

function scrubTracePayload(event: ErrorEvent | TransactionEvent): void {
  delete event.transaction;
  if (event.spans) event.spans = event.spans.map(scrubSentrySpan);

  const trace = event.contexts?.trace;
  if (!trace) return;

  const { trace_id, span_id, parent_span_id, op, status, origin } = trace;
  event.contexts!.trace = {
    trace_id,
    span_id,
    ...(parent_span_id ? { parent_span_id } : {}),
    ...(op ? { op } : {}),
    ...(status ? { status } : {}),
    ...(origin ? { origin } : {}),
  };
}
