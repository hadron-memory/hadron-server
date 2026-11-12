/** #4036: direct CAS pins make a resolver interleave unable to hide a missing predicate. */
import { describe, expect, it } from 'vitest';
import { decideChatRouting, applyChatRoutingDecision } from './chatRouting.js';
import { validEngineValue } from './chatRootEngineState.js';
import { respondToolDefinition } from '../api/graphql/schema/resolvers.helpers.js';

const decide = (extra: Partial<Parameters<typeof decideChatRouting>[0]> = {}) => decideChatRouting({
  origin: { conversationName: 'main', stageName: 'one' }, goalReached: true, rules: [], node: async () => null, evaluate: async () => true, ...extra,
});
describe('#4036 routing edits', () => {
  it.each([
    { conversationName: 'moved', stageName: 'one' },
    { conversationName: 'main', stageName: 'moved' },
  ])('drops every edit if either origin component differs: %s', async origin => {
    const decision = await decide(); let ran = false;
    decision.edits.push(data => { ran = true; data.goalStack = ['must not write']; data.stageName = 'wrong'; });
    const fresh = { ...origin, routeHistory: ['prior'], lastMessageAt: 'keep' };
    const before = structuredClone(fresh);
    expect(applyChatRoutingDecision(fresh, decision)).toMatchObject({ routingSkipped: true, conversationCompleted: null, stageTransitioned: false, newStageName: null, conversationHandoff: null });
    expect(ran).toBe(false); expect(fresh).toEqual(before);
  });
  it('judges the whole batch once, not again after the first edit changes the stage', async () => {
    const decision = await decide();
    decision.edits.unshift(data => { data.stageName = 'new'; });
    const fresh: Record<string, unknown> = { conversationName: 'main', stageName: 'one' };
    expect(applyChatRoutingDecision(fresh, decision)).toMatchObject({ routingSkipped: false, conversationCompleted: 'main' });
    expect(fresh.completedConversations).toHaveLength(1); expect(fresh.routeHistory).toHaveLength(1);
  });
  it('flag ignores a named stage for always timing; on_complete and always share the existing priority order', async () => {
    const decision = await decide({ nextStage: 'ignored', rules: [
      { id: 'always-first', priority: 0, condition: null, data: { timing: 'always' }, targetLoc: 'conversations:always' },
      { id: 'complete-second', priority: 1, condition: null, data: { timing: 'on_complete' }, targetLoc: 'conversations:complete' },
    ], node: async loc => ({ loc, name: loc, data: { stageOrder: ['first'] } }) });
    expect(decision.result).toMatchObject({ conversationCompleted: 'main', conversationHandoff: 'always', newStageName: 'first' });
  });
  it('carries S2: an unknown named stage is reported without routing or rule evaluation', async () => {
    let evaluated = 0;
    const decision = await decide({ goalReached: false, nextStage: 'unknown', stageOrder: ['one', 'two'],
      rules: [{ id: 'always', priority: 0, condition: null, data: { timing: 'always' }, targetLoc: 'conversations:other' }],
      evaluate: async () => { evaluated++; return true; } });
    expect(decision.result).toMatchObject({ rejectedNextStage: 'unknown', stageTransitioned: false, newStageName: null });
    expect(decision.edits).toEqual([]); expect(evaluated).toBe(0);
    const stale = applyChatRoutingDecision({ conversationName: 'changed', stageName: 'one' }, decision);
    expect(stale).toMatchObject({ routingSkipped: true }); expect(stale.rejectedNextStage).toBeUndefined();
  });
  it('completion wins over S2 rejection of an unknown named stage', async () => {
    const decision = await decide({ nextStage: 'unknown', stageOrder: ['one', 'two'] });
    expect(decision.result).toMatchObject({ conversationCompleted: 'main', stageTransitioned: false });
    expect(decision.result.rejectedNextStage).toBeUndefined();
  });
  it('regression: ordinary named-stage progression evaluates no rule', async () => {
    let evaluated = 0;
    const decision = await decide({ goalReached: false, nextStage: 'two', rules: [{ id: 'always', priority: 0, condition: null, data: { timing: 'always' }, targetLoc: 'conversations:other' }], evaluate: async () => { evaluated++; return true; } });
    expect(decision.result).toMatchObject({ conversationCompleted: null, newStageName: 'two', detourReturned: false }); expect(evaluated).toBe(0);
  });
});
describe('#4036 completion state and tool contract', () => {
  it('validates completion arrays independently of goal-stack entries, including calendar times', () => {
    expect(validEngineValue('completedConversations', [{ conversation: 'main', completedAt: '2026-11-12T01:02:03.000Z' }])).toBe(true);
    for (const entry of [null, { conversation: '', completedAt: '2026-11-12T01:02:03Z' }, { conversation: 'main', completedAt: '2026-02-30T01:02:03Z' }, { conversation: 'main', completedAt: 'not-a-time' }]) {
      expect(validEngineValue('completedConversations', [entry])).toBe(false);
    }
  });
  it('adds an optional boolean goal_reached to the shared respond schema', () => {
    const parameters = respondToolDefinition({})[0].parameters as any;
    expect(parameters.properties.goal_reached).toMatchObject({ type: 'boolean', description: expect.any(String) });
    expect(parameters.required).not.toContain('goal_reached');
  });
});
