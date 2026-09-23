import * as Sentry from '@sentry/node';
import type { ErrorEvent } from '@sentry/node';
import { afterEach, describe, expect, it } from 'vitest';
import {
  scrubSentryEvent,
  scrubSentrySpan,
  scrubSentryTransaction,
} from './sentryScrubber.js';

type SpanJSON = Parameters<typeof scrubSentrySpan>[0];
type TransactionEvent = Parameters<typeof scrubSentryTransaction>[0];

describe('scrubSentryEvent', () => {
  afterEach(async () => {
    await Sentry.close(2_000);
  });

  it('removes credentials and GraphQL variables from the SDK event pipeline', async () => {
    const before: ErrorEvent[] = [];
    const sent: ErrorEvent[] = [];

    Sentry.init({
      dsn: 'https://public@example.com/1',
      defaultIntegrations: false,
      integrations: [Sentry.requestDataIntegration()],
      beforeSend(event) {
        before.push(structuredClone(event));
        const scrubbed = scrubSentryEvent(event);
        sent.push(structuredClone(scrubbed));
        return scrubbed;
      },
      transport: (options) =>
        Sentry.createTransport(options, async () => ({ statusCode: 200 })),
    });

    await Sentry.withIsolationScope(async (scope) => {
      scope.setSDKProcessingMetadata({
        normalizedRequest: {
          method: 'POST',
          url: 'https://url-user:url-pass@srv.example/graphql?token=query-secret#fragment',
          query_string: 'token=query-secret',
          headers: {
            authorization: 'Bearer hdr_user_secret',
            cookie: 'hadron_token=cookie-secret',
            'x-hadron-memory-keys': '[{"dataKey":"memory-secret"}]',
            'x-api-key': 'custom-secret',
          },
          cookies: { hadron_token: 'cookie-secret' },
          data: {
            query: 'mutation Encrypt($passphrase: String!) { encryptMemory(passphrase: $passphrase) }',
            variables: { passphrase: 'body-secret' },
          },
          env: { HTTP_AUTHORIZATION: 'Bearer env-secret' },
        },
      });

      Sentry.captureException(new Error('positive-control resolver fault'));
      await Sentry.flush(2_000);
    });

    // Positive control: RequestData really did attach the sensitive values.
    expect(before).toHaveLength(1);
    expect(before[0]?.request).toMatchObject({
      headers: {
        authorization: 'Bearer hdr_user_secret',
        'x-hadron-memory-keys': '[{"dataKey":"memory-secret"}]',
      },
      data: {
        variables: { passphrase: 'body-secret' },
      },
      query_string: 'token=query-secret',
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.request).toEqual({
      method: 'POST',
    });

    const serialized = JSON.stringify(sent[0]);
    for (const secret of [
      'hdr_user_secret',
      'cookie-secret',
      'memory-secret',
      'custom-secret',
      'query-secret',
      'body-secret',
      'env-secret',
      'url-user',
      'url-pass',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('removes credential-bearing URL paths from error events', () => {
    const event: ErrorEvent = {
      type: undefined,
      request: {
        method: 'POST',
        url: 'https://srv.example/hooks/hook-secret/name?hpt=query-secret',
      },
    };

    expect(scrubSentryEvent(event).request).toEqual({ method: 'POST' });
    expect(JSON.stringify(event)).not.toMatch(/hook-secret|query-secret/);
  });

  it('drops malformed request URLs instead of retaining user-info', () => {
    const event: ErrorEvent = {
      type: undefined,
      request: {
        method: 'GET',
        url: 'https://url-user:url-pass@[bad]/path?token=query-secret#fragment',
        headers: { authorization: 'Bearer secret' },
      },
    };

    expect(scrubSentryEvent(event).request).toEqual({
      method: 'GET',
    });
    expect(JSON.stringify(event)).not.toMatch(/url-user|url-pass|query-secret/);
  });

  it('scrubs transaction events and their spans', () => {
    const span: SpanJSON = {
      trace_id: 'a'.repeat(32),
      span_id: 'b'.repeat(16),
      start_timestamp: 1,
      timestamp: 2,
      op: 'http.server',
      description: 'POST /hooks/span-secret/name?hpt=span-query-secret',
      data: {
        'http.request.header.authorization': 'Bearer span-header-secret',
        'http.url': 'https://srv.example/hooks/span-secret/name',
      },
      links: [
        {
          trace_id: 'c'.repeat(32),
          span_id: 'd'.repeat(16),
          attributes: { secret: 'span-link-secret' },
        },
      ],
    };
    const event: TransactionEvent = {
      type: 'transaction',
      transaction: 'POST /hooks/transaction-secret/name',
      request: {
        method: 'POST',
        url: 'https://srv.example/hooks/request-secret/name?hpt=request-query-secret',
        headers: { authorization: 'Bearer transaction-header-secret' },
      },
      sdkProcessingMetadata: {
        normalizedRequest: {
          headers: { 'x-hadron-memory-keys': 'transaction-memory-secret' },
        },
      },
      spans: [span],
    };

    const scrubbed = scrubSentryTransaction(event);
    expect(scrubbed.request).toEqual({ method: 'POST' });
    expect(scrubbed.transaction).toBeUndefined();
    expect(scrubbed.spans).toEqual([scrubSentrySpan(span)]);
    expect(scrubbed.spans?.[0]).toMatchObject({
      trace_id: 'a'.repeat(32),
      span_id: 'b'.repeat(16),
      op: 'http.server',
      data: {},
    });

    const serialized = JSON.stringify(scrubbed);
    for (const secret of [
      'transaction-secret',
      'request-secret',
      'request-query-secret',
      'transaction-header-secret',
      'transaction-memory-secret',
      'span-secret',
      'span-query-secret',
      'span-header-secret',
      'span-link-secret',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
