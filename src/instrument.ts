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
  });
  console.log(`[sentry] initialized (environment=${environment})`);
} else {
  console.log('[sentry] SENTRY_DSN not set — error reporting disabled');
}
