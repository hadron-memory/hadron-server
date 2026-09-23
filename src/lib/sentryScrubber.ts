import type { ErrorEvent } from '@sentry/node';

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
  if (event.sdkProcessingMetadata) {
    const { normalizedRequest: _sensitiveRequest, ...safeMetadata } =
      event.sdkProcessingMetadata;
    event.sdkProcessingMetadata = safeMetadata;
  }

  if (!event.request) return event;

  const { method, url } = event.request;
  event.request = {
    ...(method ? { method } : {}),
    ...(url ? { url: stripUrlSecrets(url) } : {}),
  };

  return event;
}

/** Remove query, fragment and URL user-info while retaining route identity. */
function stripUrlSecrets(value: string): string {
  try {
    const absolute = /^[a-z][a-z\d+.-]*:\/\//i.test(value);
    const parsed = new URL(value, 'http://sentry.invalid');
    return absolute
      ? `${parsed.protocol}//${parsed.host}${parsed.pathname}`
      : parsed.pathname;
  } catch {
    // Preserve useful malformed-path context without retaining a query or
    // fragment. Request URLs should be valid, but telemetry must fail closed.
    return value.split(/[?#]/, 1)[0] ?? '';
  }
}
