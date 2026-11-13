/** #4037 (S4): stage targets, detour push and return, completion with nowhere to go. Pure decider + guarded apply. */
import { describe, expect, it } from 'vitest';
import { decideChatRouting, applyChatRoutingDecision, type GoalStackEntry } from './chatRouting.js';
import { validEngineValue } from './chatRootEngineState.js';

const CONVS: Record<string, string[]> = { a: ['s1', 's2'], anger: ['hot', 'cool'], b: ['b1'], empty: [], recent: ['s1', 's2'] };
const node = async (loc: string) => {
  const name = loc.replace('conversations:', '');
  return name in CONVS && !name.includes(':') ? { loc, name, data: { stageOrder: CONVS[name] } } : null;
};
const rule = (id: string, targetLoc: string, data: Record<string, unknown> = {}) => ({ id, priority: 0, condition: null, data: { timing: 'on_complete', ...data }, targetLoc });
const goal = (extra: Partial<GoalStackEntry>): GoalStackEntry => ({ description: 'g', createdBy: 'ASSISTANT', createdAt: '2026-11-13T00:00:00.000Z', status: 'ACTIVE', ...extra });
const decide = (extra: Partial<Parameters<typeof decideChatRouting>[0]> = {}) => decideChatRouting({
  origin: { conversationName: 'a', stageName: 's1' }, stageOrder: CONVS.a, goalReached: true, rules: [], node, evaluate: async () => true, goalStack: [], fallback: null, ...extra,
});
const run = (decision: Awaited<ReturnType<typeof decide>>, fresh: Record<string, unknown>) => ({ result: applyChatRoutingDecision(fresh, decision), fresh });
const trail = (d: Record<string, unknown>) => (d.routeHistory as Array<{ action: string; conversationUrn?: string; nodeUrn?: string; trigger?: { type: string } }>).map(e => `${e.action} ${e.conversationUrn?.replace('conversations:', '')}${e.trigger ? ` (${e.trigger.type})` : ''}`);

describe('#4037 stage targets (pin 1)', () => {
  it('a firing stage-target rule moves to the stage and stops evaluation', async () => {
    const decision = await decide({ goalReached: false, rules: [rule('r1', 'conversations:a:s2', { timing: 'always' }), rule('r2', 'conversations:b', { timing: 'always' })] });
    const { result, fresh } = run(decision, { conversationName: 'a', stageName: 's1' });
    expect(result).toMatchObject({ stageTransitioned: true, newStageName: 's2', conversationHandoff: null });
    expect(fresh).toMatchObject({ conversationName: 'a', stageName: 's2' });
  });
  it('a stage not in stageOrder, or an unknown conversation, does not fire: evaluation continues, nothing pushed', async () => {
    for (const bad of ['conversations:a:nope', 'conversations:ghost:x']) {
      const decision = await decide({ goalReached: false, rules: [rule('r1', bad, { timing: 'always', behavior: 'detour' }), rule('r2', 'conversations:b', { timing: 'always' })] });
      const { fresh } = run(decision, { conversationName: 'a', stageName: 's1' });
      expect(fresh).toMatchObject({ conversationName: 'b', stageName: 'b1' }); expect(fresh.goalStack).toBeUndefined();
    }
  });
  it('a stage target in another conversation records EXIT and ENTER', async () => {
    const decision = await decide({ goalReached: false, rules: [rule('r1', 'conversations:anger:cool', { timing: 'always' })] });
    const { result, fresh } = run(decision, { conversationName: 'a', stageName: 's1' });
    expect(result).toMatchObject({ conversationHandoff: 'anger', newStageName: 'cool' });
    expect(trail(fresh)).toEqual(['EXIT a', 'ENTER anger (TRANSITION_EDGE)']);
  });
});

describe('#4037 detour push (pin 2 first half, pin 5)', () => {
  it('records where the chat leaves plus detourTo, with an EXIT then ENTER (DETOUR_EDGE)', async () => {
    const decision = await decide({ origin: { conversationName: 'a', stageName: 's2' }, goalReached: false, rules: [rule('edge1', 'conversations:anger', { timing: 'always', behavior: 'detour', label: 'Calm down' })] });
    const { fresh } = run(decision, { conversationName: 'a', stageName: 's2' });
    expect(fresh.goalStack).toEqual([expect.objectContaining({ description: 'Calm down', conversationUrn: 'conversations:a', nodeUrn: 'conversations:a:s2', detourTo: 'conversations:anger', edgeUrn: 'edge1', status: 'ACTIVE' })]);
    expect(trail(fresh)).toEqual(['EXIT a', 'ENTER anger (DETOUR_EDGE)']);
    expect(fresh).toMatchObject({ conversationName: 'anger', stageName: 'hot' });
  });
  it('a detour to a conversation with no stages pushes nothing, moves nothing, and evaluation continues', async () => {
    const decision = await decide({ goalReached: false, rules: [rule('r1', 'conversations:empty', { timing: 'always', behavior: 'detour' }), rule('r2', 'conversations:b', { timing: 'always' })] });
    const { fresh } = run(decision, { conversationName: 'a', stageName: 's1' });
    expect(fresh.goalStack).toBeUndefined(); expect(fresh).toMatchObject({ conversationName: 'b' });
  });
  it('a detour to a conversation with no stages and no later rule leaves the chat untouched', async () => {
    const decision = await decide({ goalReached: false, rules: [rule('r1', 'conversations:empty', { timing: 'always', behavior: 'detour' })] });
    const { fresh } = run(decision, { conversationName: 'a', stageName: 's1' });
    expect(fresh).toEqual({ conversationName: 'a', stageName: 's1' });
  });
});

describe('#4037 detour return (pins 2, 3, 4, 7)', () => {
  const detour = (from: string, stage: string, to: string, extra: Partial<GoalStackEntry> = {}) =>
    goal({ conversationUrn: `conversations:${from}`, nodeUrn: `conversations:${from}:${stage}`, detourTo: `conversations:${to}`, edgeUrn: 'e', ...extra });
  it('completion with no firing rule returns to the left stage; the route reads the spec order', async () => {
    const stack = [detour('recent', 's2', 'anger')];
    const fresh: Record<string, unknown> = { conversationName: 'anger', stageName: 'hot', goalStack: structuredClone(stack),
      routeHistory: [{ action: 'EXIT', conversationUrn: 'conversations:recent', timestamp: 't' }, { action: 'ENTER', conversationUrn: 'conversations:anger', timestamp: 't', trigger: { type: 'DETOUR_EDGE' } }] };
    const decision = await decide({ origin: { conversationName: 'anger', stageName: 'hot' }, stageOrder: CONVS.anger, goalStack: stack });
    const { result } = run(decision, fresh);
    expect(result).toMatchObject({ detourReturned: true, stageTransitioned: true, newStageName: 's2', conversationHandoff: 'recent', conversationCompleted: 'anger' });
    expect(fresh).toMatchObject({ conversationName: 'recent', stageName: 's2' });
    expect((fresh.goalStack as GoalStackEntry[])[0]).toMatchObject({ status: 'COMPLETED', completedAt: expect.any(String) });
    expect(trail(fresh)).toEqual(['EXIT recent', 'ENTER anger (DETOUR_EDGE)', 'COMPLETED anger (GOAL_REACHED)', 'EXIT anger', 'ENTER recent (DETOUR_RETURN)']);
  });
  it('nested detours return one level at a time', async () => {
    const stack = [detour('a', 's1', 'b'), detour('b', 'b1', 'anger')];
    const fresh: Record<string, unknown> = { conversationName: 'anger', stageName: 'hot', goalStack: structuredClone(stack) };
    run(await decide({ origin: { conversationName: 'anger', stageName: 'hot' }, goalStack: stack }), fresh);
    expect(fresh).toMatchObject({ conversationName: 'b', stageName: 'b1' });
    expect((fresh.goalStack as GoalStackEntry[]).map(g => g.status)).toEqual(['ACTIVE', 'COMPLETED']);
    run(await decide({ origin: { conversationName: 'b', stageName: 'b1' }, goalStack: fresh.goalStack as GoalStackEntry[] }), fresh);
    expect(fresh).toMatchObject({ conversationName: 'a', stageName: 's1' });
    expect((fresh.goalStack as GoalStackEntry[]).map(g => g.status)).toEqual(['COMPLETED', 'COMPLETED']);
  });
  it('a firing completion rule wins over the return (Q3); the detour goal stays active', async () => {
    const stack = [detour('recent', 's2', 'anger')];
    const fresh: Record<string, unknown> = { conversationName: 'anger', stageName: 'hot', goalStack: structuredClone(stack) };
    const { result } = run(await decide({ origin: { conversationName: 'anger', stageName: 'hot' }, goalStack: stack, rules: [rule('r', 'conversations:b')] }), fresh);
    expect(result).toMatchObject({ conversationHandoff: 'b', detourReturned: false });
    expect((fresh.goalStack as GoalStackEntry[])[0].status).toBe('ACTIVE');
  });
  it('the seed goal and a legacy detour goal (no detourTo) are never returned to', async () => {
    for (const stack of [[goal({ conversationUrn: 'conversations:a', nodeUrn: 'conversations:a:s1' })], [goal({ conversationUrn: 'conversations:anger' })]]) {
      const fresh: Record<string, unknown> = { conversationName: 'anger', stageName: 'hot', goalStack: structuredClone(stack) };
      const { result } = run(await decide({ origin: { conversationName: 'anger', stageName: 'hot' }, goalStack: stack }), fresh);
      expect(result).toMatchObject({ detourReturned: false, newStageName: null }); expect(fresh).toMatchObject({ conversationName: 'anger', stageName: 'hot' });
      expect((fresh.goalStack as GoalStackEntry[])[0].status).toBe('ACTIVE');
    }
  });
  it('a stored stage that no longer resolves returns to the first stage of the conversation left (ruling item 2 = c)', async () => {
    const stack = [detour('recent', 'deleted', 'anger')];
    const fresh: Record<string, unknown> = { conversationName: 'anger', stageName: 'hot', goalStack: structuredClone(stack) };
    run(await decide({ origin: { conversationName: 'anger', stageName: 'hot' }, goalStack: stack }), fresh);
    expect(fresh).toMatchObject({ conversationName: 'recent', stageName: 's1' });
  });
  it('a newest detour goal whose conversation has no stages is skipped: an older resolvable goal still returns', async () => {
    const stack = [detour('recent', 's2', 'anger'), detour('empty', 'x', 'anger')];
    const fresh: Record<string, unknown> = { conversationName: 'anger', stageName: 'hot', goalStack: structuredClone(stack) };
    const { result } = run(await decide({ origin: { conversationName: 'anger', stageName: 'hot' }, goalStack: stack }), fresh);
    expect(result).toMatchObject({ detourReturned: true, conversationHandoff: 'recent', newStageName: 's2' });
    expect((fresh.goalStack as GoalStackEntry[]).map(g => g.status)).toEqual(['COMPLETED', 'ACTIVE']);
  });
  it('D6: the guarded apply drops the return when the goal changed between decision and apply', async () => {
    const stack = [detour('recent', 's2', 'anger')];
    const decision = await decide({ origin: { conversationName: 'anger', stageName: 'hot' }, goalStack: stack });
    for (const goalStack of [[goal({ description: 'shifted in front' }), stack[0]], [{ ...stack[0], status: 'COMPLETED' }], [{ ...stack[0], createdAt: '2026-11-13T09:09:09.000Z' }], []]) {
      const fresh: Record<string, unknown> = { conversationName: 'anger', stageName: 'hot', goalStack };
      const before = structuredClone(fresh);
      expect(applyChatRoutingDecision(fresh, decision)).toMatchObject({ routingSkipped: true, detourReturned: false });
      expect(fresh).toEqual(before);
    }
  });
});

describe('#4037 completion with nowhere to go (pin 6)', () => {
  const fallback = { name: 'b', stageOrder: CONVS.b };
  it('moves to the fallback conversation with EXIT and ENTER and reports it as bound', async () => {
    const fresh: Record<string, unknown> = { conversationName: 'a', stageName: 's1' };
    const { result } = run(await decide({ fallback }), fresh);
    expect(result).toMatchObject({ stageTransitioned: true, newStageName: 'b1', conversationCompleted: 'a', conversationHandoff: 'b', detourReturned: false });
    expect(trail(fresh)).toEqual(['COMPLETED a (GOAL_REACHED)', 'EXIT a', expect.stringMatching(/^ENTER b/)]);
  });
  it.each([{ fallback: null }, { fallback: { name: 'a', stageOrder: CONVS.a } }, { fallback: { name: 'empty', stageOrder: [] as string[] } }])('stays put with %j', async extra => {
    const fresh: Record<string, unknown> = { conversationName: 'a', stageName: 's1' };
    const { result } = run(await decide(extra), fresh);
    expect(result).toMatchObject({ stageTransitioned: false, conversationHandoff: null, conversationCompleted: 'a' });
    expect(trail(fresh)).toEqual(['COMPLETED a (GOAL_REACHED)']);
  });
  it('an unflagged turn never takes the fallback or the return', async () => {
    const fresh: Record<string, unknown> = { conversationName: 'a', stageName: 's1' };
    run(await decide({ goalReached: false, fallback, goalStack: [goal({ detourTo: 'conversations:anger', conversationUrn: 'conversations:b' })] }), fresh);
    expect(fresh).toEqual({ conversationName: 'a', stageName: 's1' });
  });
});

describe('#4037 engine state validator', () => {
  it('accepts a string detourTo and rejects a non-string one', () => {
    const base = { description: 'd', createdBy: 'ASSISTANT', status: 'ACTIVE', createdAt: '2026-11-13T00:00:00.000Z' };
    expect(validEngineValue('goalStack', [{ ...base, detourTo: 'conversations:anger' }])).toBe(true);
    for (const bad of [5, {}, ['x'], null]) expect(validEngineValue('goalStack', [{ ...base, detourTo: bad }])).toBe(false);
  });
});
