import { randomBytes } from 'node:crypto';
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

/** Keep span timing while replacing caller-influenced identity and payloads. */
export function scrubSentrySpan(span: SpanJSON): SpanJSON {
  return rebuildSpan(span, randomHex(16), randomHex(8));
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

function scrubTracePayload(event: ErrorEvent | TransactionEvent): void {
  delete event.transaction;
  const trace = event.contexts?.trace;
  if (!trace && !event.spans?.length) return;

  const traceId = randomHex(16);
  const rootSpanId = randomHex(8);
  const oldRootSpanId = trace?.span_id;
  const spanIds = new Map(
    event.spans?.map((span) => [span.span_id, randomHex(8)]) ?? [],
  );

  if (event.spans) {
    event.spans = event.spans.map((span) => {
      const parentSpanId =
        span.parent_span_id === oldRootSpanId
          ? rootSpanId
          : span.parent_span_id
            ? spanIds.get(span.parent_span_id)
            : undefined;
      return rebuildSpan(
        span,
        traceId,
        spanIds.get(span.span_id) ?? randomHex(8),
        parentSpanId,
      );
    });
  }

  if (trace) {
    event.contexts!.trace = {
      trace_id: traceId,
      span_id: rootSpanId,
    };
  }
  event.sdkProcessingMetadata = {
    dynamicSamplingContext: { trace_id: traceId },
  };
}

function rebuildSpan(
  span: SpanJSON,
  traceId: string,
  spanId: string,
  parentSpanId?: string,
): SpanJSON {
  const { start_timestamp, timestamp, is_segment } = span;
  return {
    trace_id: traceId,
    span_id: spanId,
    start_timestamp,
    data: {},
    ...(parentSpanId ? { parent_span_id: parentSpanId } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(is_segment !== undefined ? { is_segment } : {}),
  };
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}
