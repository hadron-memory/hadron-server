import { createHmac, randomBytes } from 'node:crypto';
import type { ErrorEvent, NodeOptions } from '@sentry/node';

type TransactionEvent = Parameters<
  NonNullable<NodeOptions['beforeSendTransaction']>
>[0];
type SpanJSON = Parameters<NonNullable<NodeOptions['beforeSendSpan']>>[0];

const ID_PSEUDONYM_KEY = randomBytes(32);
const REMEMBERED_SAFE_ID_LIMIT = 10_000;
const safeTraceIds = new Set<string>();
const safeSpanIds = new Set<string>();

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
  const { start_timestamp, timestamp, is_segment } = span;
  return {
    trace_id: pseudonymizeId('trace', span.trace_id, 16, safeTraceIds),
    span_id: pseudonymizeId('span', span.span_id, 8, safeSpanIds),
    start_timestamp,
    data: {},
    ...(span.parent_span_id
      ? {
          parent_span_id: pseudonymizeId(
            'span',
            span.parent_span_id,
            8,
            safeSpanIds,
          ),
        }
      : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(is_segment !== undefined ? { is_segment } : {}),
    ...(span.segment_id
      ? {
          segment_id: pseudonymizeId(
            'span',
            span.segment_id,
            8,
            safeSpanIds,
          ),
        }
      : {}),
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

function scrubTracePayload(event: ErrorEvent | TransactionEvent): void {
  delete event.transaction;
  const trace = event.contexts?.trace;
  if (!trace && !event.spans?.length) return;

  if (event.spans) event.spans = event.spans.map(scrubSentrySpan);

  const traceId = trace
    ? pseudonymizeId('trace', trace.trace_id, 16, safeTraceIds)
    : event.spans![0]!.trace_id;

  if (trace) {
    event.contexts!.trace = {
      trace_id: traceId,
      span_id: pseudonymizeId('span', trace.span_id, 8, safeSpanIds),
      ...(trace.parent_span_id
        ? {
            parent_span_id: pseudonymizeId(
              'span',
              trace.parent_span_id,
              8,
              safeSpanIds,
            ),
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
  rememberedSafeIds: Set<string>,
): string {
  if (rememberedSafeIds.has(value)) return value;

  const pseudonym = createHmac('sha256', ID_PSEUDONYM_KEY)
    .update(domain)
    .update('\0')
    .update(value)
    .digest('hex')
    .slice(0, bytes * 2);

  if (rememberedSafeIds.size >= REMEMBERED_SAFE_ID_LIMIT) {
    const oldest = rememberedSafeIds.values().next().value;
    if (oldest) rememberedSafeIds.delete(oldest);
  }
  rememberedSafeIds.add(pseudonym);
  return pseudonym;
}
