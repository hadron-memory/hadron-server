import * as Sentry from '@sentry/node';
import type { ErrorEvent } from '@sentry/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
      initialScope: { tags: { service: 'hadron-server' } },
      integrations: (defaults) =>
        defaults.filter((integration) => integration.name !== 'ContextLines'),
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
      scope.addBreadcrumb({
        category: 'http',
        data: {
          url: 'https://srv.example/import?token=breadcrumb-secret',
        },
      });
      scope.setTag('graphql_operation', 'operation-tag-secret');

      Sentry.captureException(
        new URIError("Failed to decode param 'whs_exception-secret%'"),
      );
      await Sentry.flush(2_000);
    });

    // Positive control: RequestData really did attach the sensitive values.
    expect(before).toHaveLength(1);
    expect(before[0]?.sdk?.integrations).toContain('Http');
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
    expect(before[0]?.breadcrumbs).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          url: 'https://srv.example/import?token=breadcrumb-secret',
        }),
      }),
    );
    expect(before[0]?.tags).toMatchObject({
      service: 'hadron-server',
      graphql_operation: 'operation-tag-secret',
    });
    expect(JSON.stringify(before[0]?.exception)).toContain(
      'whs_exception-secret',
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]?.request).toEqual({
      method: 'POST',
    });
    expect(sent[0]?.tags).toEqual({ service: 'hadron-server' });

    const serialized = JSON.stringify(sent[0]);
    for (const secret of [
      'hdr_user_secret',
      'cookie-secret',
      'memory-secret',
      'custom-secret',
      'query-secret',
      'body-secret',
      'env-secret',
      'breadcrumb-secret',
      'operation-tag-secret',
      'whs_exception-secret',
      'url-user',
      'url-pass',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('removes credential-bearing URL paths from error events', () => {
    const event: ErrorEvent = {
      type: undefined,
      transaction: 'POST /hooks/error-transaction-secret/name',
      request: {
        method: 'POST',
        url: 'https://srv.example/hooks/hook-secret/name?hpt=query-secret',
      },
      contexts: {
        trace: {
          trace_id: 'a'.repeat(32),
          span_id: 'b'.repeat(16),
          op: 'http.server',
          description:
            'POST /hooks/root-span-secret/name?hpt=root-query-secret',
          data: {
            'http.url': 'https://srv.example/hooks/root-data-secret/name',
          },
          tags: { secret: 'root-tag-secret' },
          links: [
            {
              trace_id: 'c'.repeat(32),
              span_id: 'd'.repeat(16),
              attributes: { secret: 'root-link-secret' },
            },
          ],
        },
      },
    };

    expect(scrubSentryEvent(event).request).toEqual({ method: 'POST' });
    expect(event.transaction).toBeUndefined();
    expect(event.contexts?.trace).toMatchObject({
      trace_id: expect.stringMatching(/^[0-9a-f]{32}$/),
      span_id: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    expect(event.contexts?.trace?.trace_id).not.toBe('a'.repeat(32));
    expect(event.contexts?.trace?.span_id).not.toBe('b'.repeat(16));
    expect(event.sdkProcessingMetadata).toEqual({
      dynamicSamplingContext: {
        trace_id: event.contexts?.trace?.trace_id,
      },
    });
    const relatedEvent: ErrorEvent = {
      type: undefined,
      contexts: {
        trace: {
          trace_id: 'a'.repeat(32),
          span_id: 'b'.repeat(16),
        },
      },
    };
    scrubSentryEvent(relatedEvent);
    expect(relatedEvent.contexts?.trace).toEqual(event.contexts?.trace);
    expect(JSON.stringify(event)).not.toMatch(
      /hook-secret|query-secret|error-transaction-secret|root-(span|query|data|tag|link)-secret/,
    );
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
    const rawSpan = {
      trace_id: 'a'.repeat(32),
      span_id: 'b'.repeat(16),
      start_timestamp: 1,
      timestamp: 2,
    } as SpanJSON;
    const span = {
      ...scrubSentrySpan(rawSpan),
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
      tags: { secret: 'span-tag-secret' },
      unknownRequestField: 'span-unknown-secret',
    } as SpanJSON;
    const rootIdentity = scrubSentrySpan({
      trace_id: 'a'.repeat(32),
      span_id: 'f'.repeat(16),
      start_timestamp: 1,
    } as SpanJSON);
    const event: TransactionEvent = {
      type: 'transaction',
      transaction: 'POST /hooks/transaction-secret/name',
      message: 'transaction-message-secret',
      logentry: {
        message: 'transaction-log-secret',
        params: ['transaction-log-param-secret'],
      },
      extra: { secret: 'transaction-extra-secret' },
      exception: {
        values: [
          {
            type: 'URIError',
            value: 'transaction-exception-secret',
          },
        ],
      },
      request: {
        method: 'POST',
        url: 'https://srv.example/hooks/request-secret/name?hpt=request-query-secret',
        headers: { authorization: 'Bearer transaction-header-secret' },
      },
      sdkProcessingMetadata: {
        normalizedRequest: {
          headers: { 'x-hadron-memory-keys': 'transaction-memory-secret' },
        },
        dynamicSamplingContext: {
          trace_id: '1'.repeat(32),
          transaction: 'POST /hooks/dsc-secret/name',
          public_key: 'public-key-secret',
          release: 'release-secret',
          environment: 'environment-secret',
          replay_id: 'replay-secret',
          org_id: 'org-secret',
          sample_rate: '0.123456789012345678901234567890',
          sampled: 'true',
          sample_rand: '0.987654321098765432109876543210',
        },
      },
      breadcrumbs: [
        {
          category: 'http',
          data: {
            url: 'https://srv.example/import?token=transaction-breadcrumb-secret',
          },
        },
      ],
      contexts: {
        trace: {
          trace_id: rootIdentity.trace_id,
          span_id: rootIdentity.span_id,
          description: 'POST /hooks/root-secret/name',
          data: { 'http.url': 'https://srv.example/root-data-secret' },
        },
      },
      spans: [span],
    };

    const scrubbed = scrubSentryTransaction(event);
    expect(scrubbed.request).toEqual({ method: 'POST' });
    expect(scrubbed.transaction).toBeUndefined();
    expect(scrubbed.breadcrumbs).toBeUndefined();
    expect(scrubbed.contexts?.trace).toMatchObject({
      trace_id: expect.stringMatching(/^[0-9a-f]{32}$/),
      span_id: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    expect(scrubbed.contexts?.trace?.trace_id).not.toBe('a'.repeat(32));
    expect(scrubbed.contexts?.trace?.span_id).not.toBe('f'.repeat(16));
    expect(scrubbed.sdkProcessingMetadata).toEqual({
      dynamicSamplingContext: {
        trace_id: scrubbed.contexts?.trace?.trace_id,
      },
    });
    expect(scrubbed.spans?.[0]).toMatchObject({
      trace_id: scrubbed.contexts?.trace?.trace_id,
      span_id: expect.stringMatching(/^[0-9a-f]{16}$/),
      data: {},
    });
    expect(scrubbed.spans?.[0]?.span_id).not.toBe('b'.repeat(16));

    const standalone = scrubSentrySpan(rawSpan);
    expect(standalone).toMatchObject({
      trace_id: expect.stringMatching(/^[0-9a-f]{32}$/),
      span_id: expect.stringMatching(/^[0-9a-f]{16}$/),
      start_timestamp: 1,
      timestamp: 2,
      data: {},
    });
    expect(standalone.trace_id).not.toBe('a'.repeat(32));
    expect(standalone.span_id).not.toBe('b'.repeat(16));
    expect(scrubbed.spans).toEqual([standalone]);

    const serialized = JSON.stringify(scrubbed);
    for (const secret of [
      'transaction-secret',
      'transaction-message-secret',
      'transaction-log-secret',
      'transaction-log-param-secret',
      'transaction-extra-secret',
      'transaction-exception-secret',
      'request-secret',
      'request-query-secret',
      'transaction-header-secret',
      'transaction-memory-secret',
      'dsc-secret',
      'public-key-secret',
      'release-secret',
      'environment-secret',
      'replay-secret',
      'org-secret',
      'transaction-breadcrumb-secret',
      'span-secret',
      'span-query-secret',
      'span-header-secret',
      'span-link-secret',
      'span-tag-secret',
      'span-unknown-secret',
      'root-secret',
      'root-data-secret',
      'a'.repeat(32),
      'b'.repeat(16),
      'e'.repeat(32),
      'f'.repeat(16),
      '1'.repeat(32),
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('drops transaction spans when the sanitized root trace is missing', () => {
    const event = {
      type: 'transaction',
      spans: [
        {
          trace_id: 'a'.repeat(32),
          span_id: 'b'.repeat(16),
          start_timestamp: 1,
          data: { secret: 'orphan-span-secret' },
        },
      ],
      sdkProcessingMetadata: {
        dynamicSamplingContext: { trace_id: 'a'.repeat(32) },
      },
    } as TransactionEvent;

    const scrubbed = scrubSentryTransaction(event);
    expect(scrubbed.spans).toBeUndefined();
    expect(scrubbed.sdkProcessingMetadata).toBeUndefined();
    expect(JSON.stringify(scrubbed)).not.toMatch(
      /orphan-span-secret|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|bbbbbbbbbbbbbbbb/,
    );
  });

  it('derives the same trace pseudonym in separate project processes', async () => {
    const previousDsn = process.env.SENTRY_DSN;
    process.env.SENTRY_DSN = 'https://public@sentry.example/1';

    try {
      vi.resetModules();
      const firstModule = await import('./sentryScrubber.js');
      const first: ErrorEvent = {
        type: undefined,
        contexts: {
          trace: {
            trace_id: 'a'.repeat(32),
            span_id: 'b'.repeat(16),
          },
        },
      };
      firstModule.scrubSentryEvent(first);

      vi.resetModules();
      const secondModule = await import('./sentryScrubber.js');
      const second: ErrorEvent = {
        type: undefined,
        contexts: {
          trace: {
            trace_id: 'a'.repeat(32),
            span_id: 'b'.repeat(16),
          },
        },
      };
      secondModule.scrubSentryEvent(second);

      expect(first.contexts?.trace).toEqual(second.contexts?.trace);
      expect(first.contexts?.trace?.trace_id).not.toBe('a'.repeat(32));
    } finally {
      if (previousDsn === undefined) delete process.env.SENTRY_DSN;
      else process.env.SENTRY_DSN = previousDsn;
      vi.resetModules();
    }
  });

  it('sanitizes transaction and span payloads in the SDK pipeline', async () => {
    const rawTransactions: TransactionEvent[] = [];
    const sentTransactions: TransactionEvent[] = [];
    const rawSpans: SpanJSON[] = [];
    const sentSpans: SpanJSON[] = [];

    Sentry.init({
      dsn: 'https://public@example.com/1',
      defaultIntegrations: false,
      tracesSampleRate: 1,
      traceLifecycle: 'static',
      beforeSendTransaction(event) {
        rawTransactions.push(structuredClone(event));
        const scrubbed = scrubSentryTransaction(event);
        sentTransactions.push(structuredClone(scrubbed));
        return scrubbed;
      },
      beforeSendSpan(span) {
        rawSpans.push(structuredClone(span));
        const scrubbed = scrubSentrySpan(span);
        sentSpans.push(structuredClone(scrubbed));
        return scrubbed;
      },
      transport: (options) =>
        Sentry.createTransport(options, async () => ({ statusCode: 200 })),
    });

    expect(Sentry.getClient()?.getOptions().traceLifecycle).toBe('static');

    Sentry.captureEvent({
      type: 'transaction',
      transaction: 'POST /hooks/root-pipeline-secret/name',
      start_timestamp: 1,
      timestamp: 2,
      contexts: {
        trace: {
          trace_id: 'a'.repeat(32),
          span_id: 'b'.repeat(16),
          data: {
            'http.url':
              'https://srv.example/hooks/root-pipeline-secret/name?hpt=root-query-secret',
            secret: 'root-attribute-secret',
          },
        },
      },
      spans: [
        {
          trace_id: 'a'.repeat(32),
          span_id: 'c'.repeat(16),
          parent_span_id: 'b'.repeat(16),
          start_timestamp: 1.25,
          timestamp: 1.75,
          op: 'http.client',
          description: 'GET /hooks/child-pipeline-secret/name',
          data: {
            'http.url':
              'https://srv.example/hooks/child-pipeline-secret/name',
            secret: 'child-attribute-secret',
          },
        },
      ],
    });
    await Sentry.flush(2_000);

    expect(rawTransactions).toHaveLength(1);
    expect(rawSpans.length).toBeGreaterThan(0);
    expect(JSON.stringify(rawSpans)).toMatch(
      /root-pipeline-secret|child-pipeline-secret/,
    );
    expect(rawTransactions[0]?.contexts?.trace?.trace_id).not.toBe(
      'a'.repeat(32),
    );
    expect(rawTransactions[0]?.contexts?.trace?.span_id).not.toBe(
      'b'.repeat(16),
    );
    expect(rawTransactions[0]?.spans?.[0]?.trace_id).not.toBe('a'.repeat(32));
    expect(rawTransactions[0]?.spans?.[0]?.span_id).not.toBe('c'.repeat(16));
    expect(sentTransactions[0]?.contexts?.trace?.trace_id).toBe(
      rawTransactions[0]?.contexts?.trace?.trace_id,
    );
    expect(sentTransactions[0]?.contexts?.trace?.span_id).toBe(
      rawTransactions[0]?.contexts?.trace?.span_id,
    );
    expect(sentTransactions[0]?.spans?.[0]?.trace_id).toBe(
      rawTransactions[0]?.spans?.[0]?.trace_id,
    );
    expect(sentTransactions[0]?.spans?.[0]?.span_id).toBe(
      rawTransactions[0]?.spans?.[0]?.span_id,
    );
    expect(sentTransactions[0]?.contexts?.trace).toMatchObject({
      trace_id: expect.stringMatching(/^[0-9a-f]{32}$/),
      span_id: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    expect(sentTransactions[0]?.sdkProcessingMetadata).toEqual({
      dynamicSamplingContext: {
        trace_id: sentTransactions[0]?.contexts?.trace?.trace_id,
      },
    });
    const transactionSpanIds = new Set(
      sentTransactions[0]?.spans?.map((span) => span.span_id),
    );
    expect(sentSpans.some((span) => transactionSpanIds.has(span.span_id))).toBe(
      true,
    );

    const serialized = JSON.stringify({ sentTransactions, sentSpans });
    for (const secret of [
      'root-pipeline-secret',
      'root-query-secret',
      'root-attribute-secret',
      'child-pipeline-secret',
      'child-attribute-secret',
      'a'.repeat(32),
      'b'.repeat(16),
      'c'.repeat(16),
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
