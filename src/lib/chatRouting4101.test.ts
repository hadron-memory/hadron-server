/** #4101: operator-only bounded counts, never flag values or chat content. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let route: typeof import('./chatRouting.js').decideChatRouting;
let now: number;
let info: ReturnType<typeof vi.spyOn>;
const rule = (id = 'private-rule', timing?: string) => ({ id, priority: 0, condition: null, data: { timing }, targetLoc: 'conversations:private-target' });
const decide = (goalReached?: unknown, rules = [rule()], nextStage?: unknown) => route({
  origin: { conversationName: 'private-conversation', stageName: 'private-stage' }, stageOrder: ['private-stage', 'next'],
  goalReached, rules, nextStage, node: async () => ({ loc: 'conversations:private-target', name: 'private target', data: { stageOrder: ['arrive'] } }), evaluate: async () => true,
});
const snapshot = (kind: 'absent' | 'false' | 'non_boolean', decisions = 1, rules = 1) => ({
  event: 'chat.on_complete_skipped', minimumIntervalMs: 60_000,
  skippedDecisions: { absent: 0, false: 0, non_boolean: 0, [kind]: decisions },
  skippedRules: { absent: 0, false: 0, non_boolean: 0, [kind]: rules },
});
beforeEach(async () => {
  vi.resetModules(); vi.stubEnv('HADRON_CHAT_ON_COMPLETE_SKIP_METRICS', 'true'); now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
  route = (await import('./chatRouting.js')).decideChatRouting;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('#4101 skipped on_complete observability', () => {
  it.each([[undefined, 'absent'], [false, 'false'], [null, 'non_boolean'], ['PRIVATE RAW FLAG', 'non_boolean'], [1, 'non_boolean'], [{ secret: 'PRIVATE RAW OBJECT' }, 'non_boolean']] as const)('classifies %s by kind, never value', async (flag, kind) => {
    const result = await decide(flag);
    expect(result.result.conversationHandoff).toBeNull();
    expect(info).toHaveBeenCalledExactlyOnceWith(JSON.stringify(snapshot(kind)));
    expect(info.mock.calls.flat().join('')).not.toMatch(/PRIVATE|private-/);
  });
  it('defaults off and records no warning/error for a normal incomplete turn', async () => {
    vi.stubEnv('HADRON_CHAT_ON_COMPLETE_SKIP_METRICS', '');
    const warn = vi.spyOn(console, 'warn'), error = vi.spyOn(console, 'error');
    await decide(); expect(info).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  });
  it('true still completes and fires the rule, with no skip signal', async () => {
    expect((await decide(true)).result.conversationHandoff).toBe('private-target'); expect(info).not.toHaveBeenCalled();
  });
  it('counts only visited on_complete rules, including default timing', async () => {
    await decide(false, [rule('one'), rule('default', undefined), rule('unknown', 'on_enter'), rule('fires', 'always'), rule('unvisited')]);
    expect(info).toHaveBeenCalledExactlyOnceWith(JSON.stringify(snapshot('false', 1, 2)));
  });
  it('does not count rules bypassed by an explicit next stage or prior firing rule', async () => {
    await decide(false, [rule()], 'next'); await decide(false, [rule('fires', 'always'), rule()]); await decide(false, []);
    expect(info).not.toHaveBeenCalled();
  });
  it('aggregates fixed buckets and emits at most once per monotonic minute, without timers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
    await decide();
    for (let i = 0; i < 1000; i++) await decide(false, [rule('one'), rule('two')]);
    await decide('RAW SECRET'); now += 59_999; await decide(); expect(info).toHaveBeenCalledTimes(1);
    now += 1; await decide(false);
    expect(info).toHaveBeenCalledTimes(2);
    expect(JSON.parse(info.mock.calls[1][0] as string)).toEqual({ event: 'chat.on_complete_skipped', minimumIntervalMs: 60_000,
      skippedDecisions: { absent: 1, false: 1001, non_boolean: 1 }, skippedRules: { absent: 1, false: 2001, non_boolean: 1 } });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('saturates counts, and ignores true or empty observations defensively', async () => {
    const { recordSkippedOnComplete } = await import('./chatRouting/skipMetrics.js');
    recordSkippedOnComplete(true, 2); recordSkippedOnComplete(false, 0); expect(info).not.toHaveBeenCalled();
    recordSkippedOnComplete(false, Number.MAX_SAFE_INTEGER);
    recordSkippedOnComplete(false, Number.MAX_SAFE_INTEGER); now += 60_000;
    recordSkippedOnComplete(false, 2);
    expect(JSON.parse(info.mock.calls[1][0] as string)).toEqual(snapshot('false', 2, Number.MAX_SAFE_INTEGER));
  });
  it('preserves the original routing error even when the diagnostic sink also fails', async () => {
    info.mockImplementation(() => { throw new Error('broken log sink'); });
    const original = new Error('original evaluation failure');
    await expect(route({ origin: {}, goalReached: false, rules: [rule(), rule('always', 'always')], node: async () => null,
      evaluate: async () => { throw original; } })).rejects.toBe(original);
    expect(info).toHaveBeenCalledTimes(1);
  });
  it('diagnostic failure cannot change routing, and a failed emission consumes its rate slot', async () => {
    info.mockImplementation(() => { throw new Error('broken log sink'); });
    await expect(decide()).resolves.toMatchObject({ result: { conversationHandoff: null } });
    await decide(); expect(info).toHaveBeenCalledTimes(1);
  });
});
