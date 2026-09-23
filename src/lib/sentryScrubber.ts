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
  const safeUrl = url ? stripUrlSecrets(url) : undefined;
  event.request = {
    ...(method ? { method } : {}),
    ...(safeUrl ? { url: safeUrl } : {}),
  };

  return event;
}

/** Remove query, fragment and URL user-info while retaining route identity. */
function stripUrlSecrets(value: string): string | undefined {
  try {
    const absolute = /^[a-z][a-z\d+.-]*:\/\//i.test(value);
    const parsed = new URL(value, 'http://sentry.invalid');
    return absolute
      ? `${parsed.protocol}//${parsed.host}${parsed.pathname}`
      : parsed.pathname;
  } catch {
    // Any string-level fallback can retain user-info from a malformed absolute
    // URL. Lose the route rather than risk transmitting a credential.
    return undefined;
  }
}
