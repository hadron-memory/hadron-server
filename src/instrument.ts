// Sentry initialization.
//
// This module MUST be imported before any other application module (it is the
// first import in index.ts) so the SDK installs its instrumentation before
// Express/HTTP are evaluated.
//
// Config is injected by Doppler at process start (SENTRY_DSN). When the DSN is
// absent — local dev, tests, CI — Sentry.init() is skipped and every Sentry.*
// call becomes a no-op, so nothing is sent and boot logs stay quiet.
//
// One shared Sentry project fronts every hadron service; the `service` tag is
// how the services are told apart in the issue stream. Errors are reported by
// default; tracing is opt-in (SENTRY_TRACES_SAMPLE_RATE) because spans multiply
// event volume against the free-tier quota and, under ESM, need the
// `--import ./dist/instrument.js` loader flag to instrument correctly.
import 'dotenv/config';
import * as Sentry from '@sentry/node';
import {
  scrubSentryEvent,
  scrubSentrySpan,
  scrubSentryTransaction,
} from './lib/sentryScrubber.js';

const dsn = process.env.SENTRY_DSN?.trim();
const environment =
  process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development';

if (dsn) {
  Sentry.init({
    dsn,
    initialScope: { tags: { service: 'hadron-server' } },
    environment,
    release: process.env.SENTRY_RELEASE || undefined,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
    // scrubSentrySpan consumes the static SpanJSON shape. Pin this explicitly
    // so an SDK default change cannot move spans onto the streamed path and
    // bypass the sanitizer.
    traceLifecycle: 'static',
    beforeSend: scrubSentryEvent,
    beforeSendTransaction: scrubSentryTransaction,
    beforeSendSpan: scrubSentrySpan,
  });
  console.log(`[sentry] initialized (environment=${environment})`);
} else if (process.env.NODE_ENV !== 'test') {
  // Informative for a real boot with no DSN configured; stays silent under
  // vitest so the test/CI logs aren't flooded on every server boot.
  console.log('[sentry] SENTRY_DSN not set — error reporting disabled');
}
