/**
 * Event pivot — evt.node.written.v1 publish + local fallback.
 *
 * The bus is OFF in vitest (vitest.config.ts pins NATS_URL=''), so these
 * tests exercise exactly the D-2026-06-17-004 standalone path: publish
 * dispatches to registered local handlers instead of the broker.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  publishNodeWritten,
  registerNodeWrittenLocalHandler,
  clearNodeWrittenLocalHandlers,
  isNodeWrittenEvent,
} from './nodeWritten.js';
import { closeBusClient } from '../bus/index.js';

beforeEach(async () => {
  await closeBusClient();
  clearNodeWrittenLocalHandlers();
});

afterEach(async () => {
  await closeBusClient();
  clearNodeWrittenLocalHandlers();
});

/** Flush setImmediate-scheduled local dispatches. */
const flush = () => new Promise((r) => setImmediate(r));

describe('isNodeWrittenEvent', () => {
  it('accepts the minimal shape and rejects junk', () => {
    expect(isNodeWrittenEvent({ nodeId: 'n1', memoryId: 'm1' })).toBe(true);
    expect(isNodeWrittenEvent({ nodeId: 'n1', memoryId: 'm1', ownerRepo: '', clientId: null })).toBe(true);
    expect(isNodeWrittenEvent(null)).toBe(false);
    expect(isNodeWrittenEvent('nope')).toBe(false);
    expect(isNodeWrittenEvent([])).toBe(false);
    expect(isNodeWrittenEvent({ nodeId: 'n1' })).toBe(false);
    expect(isNodeWrittenEvent({ nodeId: 1, memoryId: 'm1' })).toBe(false);
  });
});

describe('publishNodeWritten — bus off → local fallback', () => {
  it('dispatches to every registered local handler', async () => {
    const got: string[] = [];
    registerNodeWrittenLocalHandler('a', async (evt) => {
      got.push(`a:${evt.nodeId}`);
    });
    registerNodeWrittenLocalHandler('b', async (evt) => {
      got.push(`b:${evt.nodeId}`);
    });
    await publishNodeWritten({ nodeId: 'n1', memoryId: 'm1' });
    await flush();
    expect(got.sort()).toEqual(['a:n1', 'b:n1']);
  });

  it('re-registering under the same name replaces (no double dispatch)', async () => {
    const got: string[] = [];
    registerNodeWrittenLocalHandler('a', async () => {
      got.push('old');
    });
    registerNodeWrittenLocalHandler('a', async () => {
      got.push('new');
    });
    await publishNodeWritten({ nodeId: 'n1', memoryId: 'm1' });
    await flush();
    expect(got).toEqual(['new']);
  });

  it('a throwing handler is logged and never propagates to the caller', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const got: string[] = [];
    registerNodeWrittenLocalHandler('boom', async () => {
      throw new Error('subscriber bug');
    });
    registerNodeWrittenLocalHandler('ok', async (evt) => {
      got.push(evt.nodeId);
    });
    await expect(publishNodeWritten({ nodeId: 'n2', memoryId: 'm1' })).resolves.toBeUndefined();
    await flush();
    expect(got).toEqual(['n2']);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('local node.written handler "boom"'),
      expect.any(Error),
    );
    errSpy.mockRestore();
  });

  it('no handlers registered → a silent no-op', async () => {
    await expect(publishNodeWritten({ nodeId: 'n3', memoryId: 'm1' })).resolves.toBeUndefined();
  });
});
