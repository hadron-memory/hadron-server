/**
 * plan-tools phase 1 — always-on tools + registry resolution. Pure units,
 * no LLM, no DB.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  hadronLog,
  hadronFail,
  resolveRunTools,
  ALWAYS_ON_TOOLS,
  AuthorFailError,
} from './index.js';

describe('hadron_log', () => {
  it('writes to the hop trail sink and reports success', async () => {
    const log = vi.fn();
    const out = await hadronLog.execute({ log }, { message: 'branching on urgency' });
    expect(log).toHaveBeenCalledWith('branching on urgency');
    expect(out).toEqual({ logged: true });
    expect(hadronLog.cost).toBe(0);
  });
});

describe('hadron_fail', () => {
  it('throws AuthorFailError carrying the author reason (D-TL-6: intent, not malfunction)', async () => {
    await expect(
      hadronFail.execute({ log: vi.fn() }, { reason: 'note lacks a recipient' }),
    ).rejects.toThrowError(new AuthorFailError('note lacks a recipient'));
  });

  it('a missing reason still fails, with a stand-in message', async () => {
    await expect(hadronFail.execute({ log: vi.fn() }, {})).rejects.toBeInstanceOf(AuthorFailError);
  });
});

describe('resolveRunTools', () => {
  it('always-on set is present exactly once, even when redundantly declared', () => {
    const { tools, unknown } = resolveRunTools(['hadron_log']);
    expect(unknown).toEqual([]);
    expect(tools.filter((t) => t.name === 'hadron_log')).toHaveLength(1);
    expect(tools.map((t) => t.name).sort()).toEqual(['hadron_fail', 'hadron_log']);
  });

  it('reports unknown names for the loud NODE_LOAD_FAILED path (D-TL-6)', () => {
    const { unknown } = resolveRunTools(['hadron_teleport', 'hadron_log']);
    expect(unknown).toEqual(['hadron_teleport']);
  });

  it('empty declaration still yields the always-on pair', () => {
    const { tools } = resolveRunTools([]);
    expect(tools).toHaveLength(ALWAYS_ON_TOOLS.length);
  });
});
