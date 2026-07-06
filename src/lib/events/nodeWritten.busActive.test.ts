/**
 * Event pivot — per-handler delivery selection when a broker IS reachable
 * (PR-507 review, Codex P2). Separate file from nodeWritten.test.ts because
 * this one mocks the bus module (vi.mock is file-scoped) while that one
 * exercises the real bus-off path.
 *
 * Contract: a successful publish suppresses local dispatch ONLY for handlers
 * whose bus subscription is confirmed active — a reachable broker with a
 * dead/never-started subscriber must fall back to local dispatch, or events
 * park in the stream until a restart.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const publish = vi.fn(async () => {});
let busAvailable = true;
vi.mock('../bus/index.js', () => ({
  getBusClient: vi.fn(async () => (busAvailable ? { publish } : null)),
}));

import {
  publishNodeWritten,
  registerNodeWrittenLocalHandler,
  clearNodeWrittenLocalHandlers,
  setNodeWrittenBusActive,
} from './nodeWritten.js';

/** Flush setImmediate-scheduled local dispatches. */
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  vi.clearAllMocks();
  busAvailable = true;
  clearNodeWrittenLocalHandlers();
});

describe('publishNodeWritten — bus reachable', () => {
  it('skips locally ONLY the handlers whose bus subscription is confirmed active', async () => {
    const got: string[] = [];
    registerNodeWrittenLocalHandler('confirmed', async () => {
      got.push('confirmed');
    });
    registerNodeWrittenLocalHandler('unconfirmed', async () => {
      got.push('unconfirmed');
    });
    setNodeWrittenBusActive('confirmed', true);
    await publishNodeWritten({ nodeId: 'n1', memoryId: 'm1' });
    await flush();
    expect(publish).toHaveBeenCalledTimes(1);
    // The broker serves 'confirmed'; 'unconfirmed' (boot subscribe failed /
    // never started) still gets the local dispatch.
    expect(got).toEqual(['unconfirmed']);
  });

  it('unsubscribing (bus-active false) flips a handler back to local dispatch', async () => {
    const got: string[] = [];
    registerNodeWrittenLocalHandler('h', async () => {
      got.push('h');
    });
    setNodeWrittenBusActive('h', true);
    await publishNodeWritten({ nodeId: 'n1', memoryId: 'm1' });
    setNodeWrittenBusActive('h', false);
    await publishNodeWritten({ nodeId: 'n2', memoryId: 'm1' });
    await flush();
    expect(got).toEqual(['h']); // only the second publish dispatched locally
  });

  it('a publish FAILURE dispatches locally to every handler, bus-active or not', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const got: string[] = [];
    registerNodeWrittenLocalHandler('confirmed', async () => {
      got.push('confirmed');
    });
    setNodeWrittenBusActive('confirmed', true);
    publish.mockRejectedValueOnce(new Error('broker hiccup'));
    await publishNodeWritten({ nodeId: 'n1', memoryId: 'm1' });
    await flush();
    expect(got).toEqual(['confirmed']);
    errSpy.mockRestore();
  });

  it('bus unavailable dispatches locally to every handler, bus-active or not', async () => {
    busAvailable = false;
    const got: string[] = [];
    registerNodeWrittenLocalHandler('confirmed', async () => {
      got.push('confirmed');
    });
    // A stale bus-active mark (broker vanished without an unsubscribe) must
    // not black-hole the event.
    setNodeWrittenBusActive('confirmed', true);
    await publishNodeWritten({ nodeId: 'n1', memoryId: 'm1' });
    await flush();
    expect(publish).not.toHaveBeenCalled();
    expect(got).toEqual(['confirmed']);
  });
});
