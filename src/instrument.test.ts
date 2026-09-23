import { afterEach, describe, expect, it, vi } from 'vitest';

describe('Sentry production instrumentation', () => {
  const previousDsn = process.env.SENTRY_DSN;
  const previousNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (previousDsn === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = previousDsn;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    vi.doUnmock('@sentry/node');
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('installs every scrubber with the static trace lifecycle', async () => {
    const init = vi.fn();
    vi.doMock('@sentry/node', () => ({ init }));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    process.env.NODE_ENV = 'test';
    process.env.SENTRY_DSN = 'https://public@sentry.example/1';

    await import('./instrument.js');

    expect(init).toHaveBeenCalledOnce();
    const options = init.mock.calls[0]![0];
    expect(options).toMatchObject({
      dsn: process.env.SENTRY_DSN,
      traceLifecycle: 'static',
      beforeSend: expect.any(Function),
      beforeSendTransaction: expect.any(Function),
      beforeSendSpan: expect.any(Function),
    });

    const event = options.beforeSend({
      type: undefined,
      request: {
        method: 'POST',
        url: 'https://srv.example/hooks/wiring-secret/name',
      },
      exception: {
        values: [{ type: 'URIError', value: 'wiring-exception-secret' }],
      },
    });
    expect(event.request).toEqual({ method: 'POST' });
    expect(JSON.stringify(event)).not.toMatch(
      /wiring-secret|wiring-exception-secret/,
    );
  });
});
