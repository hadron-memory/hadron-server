/**
 * #3021: Apollo Server must not install its own SIGTERM/SIGINT handlers.
 *
 * With Apollo's default `stopOnTerminationSignals` (on whenever NODE_ENV is not
 * 'test'), its handler runs `stop()` and then re-raises the signal with
 * `process.kill(process.pid, signal)` once src/index.ts's one-shot handler is gone,
 * so the process died in about 0.3 s (exit 255 under `doppler run`, Otto's rehearsal
 * on the real image) before the stopping drain window could run. src/index.ts owns
 * shutdown; Apollo's default is switched off in `createServer`.
 *
 * Apollo reads NODE_ENV when the server is constructed and registers nothing under
 * 'test', so this pin runs `createServer` under another NODE_ENV and counts the
 * signal listeners it leaves behind.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from '../server.js';

const SIGNALS = ['SIGTERM', 'SIGINT'] as const;
const originalEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalEnv;
});

describe('#3021 createServer leaves termination signals to src/index.ts', () => {
  it('adds no SIGTERM or SIGINT listener when NODE_ENV is not test', async () => {
    process.env.NODE_ENV = 'development';
    const before = SIGNALS.map(s => process.listenerCount(s));
    await createServer();
    const after = SIGNALS.map(s => process.listenerCount(s));
    expect(after).toEqual(before);
  });
});
