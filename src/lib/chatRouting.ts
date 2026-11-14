/** #4036 / cor:cht:030:02: shared turn routing and locked-origin application; S4 adds stage targets and detour returns. */
import type { ScriptNode, ScriptRule } from './chatScript.js';
import { decideNextStage } from './chatRouting/nextStage.js';
import { recordSkippedOnComplete } from './chatRouting/skipMetrics.js';

export interface GoalStackEntry {
  description: string;
  language?: string;
  createdAt: string;
  createdBy: 'ASSISTANT' | 'USER';
  topicUrn?: string;
  conversationUrn?: string;
  nodeUrn?: string;
  edgeUrn?: string;
  /** #4037: set only on a detour push; the return selects goals that carry it (the seed goal and legacy goals never do). */
  detourTo?: string;
  status: 'ACTIVE' | 'COMPLETED' | 'ABANDONED';
  completedAt?: string;
}

export function getGoalStack(chatData: Record<string, unknown>): GoalStackEntry[] {
  return (chatData.goalStack as GoalStackEntry[]) ?? [];
}

export function pushGoal(
  chatData: Record<string, unknown>,
  goal: Omit<GoalStackEntry, 'status' | 'createdAt'>,
): GoalStackEntry[] {
  const stack = getGoalStack(chatData);
  stack.push({
    ...goal,
    status: 'ACTIVE',
    createdAt: new Date().toISOString(),
  });
  chatData.goalStack = stack;
  return stack;
}

export function popGoal(chatData: Record<string, unknown>): GoalStackEntry | null {
  const stack = getGoalStack(chatData);
  // Find the topmost ACTIVE entry and mark it COMPLETED
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].status === 'ACTIVE') {
      stack[i].status = 'COMPLETED';
      stack[i].completedAt = new Date().toISOString();
      chatData.goalStack = stack;
      return stack[i];
    }
  }
  return null;
}

export function currentGoal(chatData: Record<string, unknown>): GoalStackEntry | null {
  const stack = getGoalStack(chatData);
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].status === 'ACTIVE') return stack[i];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Route history helpers
// ---------------------------------------------------------------------------

export interface RouteHistoryEntry {
  nodeUrn?: string;
  topicUrn?: string;
  conversationUrn?: string;
  action: 'ENTER' | 'EXIT' | 'COMPLETED' | 'FOLLOWED';
  trigger?: { type: string; content?: string };
  edgeUrn?: string;
  timestamp: string;
}

export function getRouteHistory(chatData: Record<string, unknown>): RouteHistoryEntry[] {
  return (chatData.routeHistory as RouteHistoryEntry[]) ?? [];
}

export function appendRouteEntry(
  chatData: Record<string, unknown>,
  entry: Omit<RouteHistoryEntry, 'timestamp'>,
): void {
  const history = getRouteHistory(chatData);
  history.push({ ...entry, timestamp: new Date().toISOString() });
  chatData.routeHistory = history;
}

/**
 * Check if a conversation was recently visited (within the last N entries)
 * and left — used for loop prevention.
 */
export function wasRecentlyVisited(
  chatData: Record<string, unknown>,
  conversationName: string,
  lookback = 3,
): boolean {
  const history = getRouteHistory(chatData);
  const recentExits = history
    .slice(-lookback * 2)  // each visit is ENTER + EXIT, so look back 2x
    .filter((e) =>
      e.action === 'EXIT' &&
      e.conversationUrn?.endsWith(`:${conversationName}`),
    );
  return recentExits.length > 0;
}

export interface RoutingOrigin { conversationName?: string; stageName?: string }
export interface ChatRoutingResult {
  stageTransitioned: boolean;
  newStageName: string | null;
  conversationHandoff: string | null;
  conversationCompleted: string | null;
  detourReturned: boolean;
  routingSkipped: boolean;
  rejectedNextStage?: string;
}
export interface ChatRoutingDecision {
  origin: RoutingOrigin;
  edits: Array<(data: Record<string, unknown>) => void>;
  /** D6: predicates over the fresh root, judged with the origin before any edit runs. */
  guards: Array<(data: Record<string, unknown>) => boolean>;
  result: ChatRoutingResult;
}
/** A conversation node's stage names in order; anything unreadable is no stages. */
const stagesOf = (node: ScriptNode | null): string[] => {
  const list = (node?.data as Record<string, unknown> | undefined)?.stageOrder;
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
};
const unchanged = (): ChatRoutingResult => ({ stageTransitioned: false, newStageName: null, conversationHandoff: null, conversationCompleted: null, detourReturned: false, routingSkipped: false });

/**
 * Decide one turn using the pinned script supplied by the caller. No database or locks here; the callbacks only read
 * script nodes/evaluate conditions. Rules are first-fires-wins: a rule that resolves (a conversation with a first stage,
 * or a stage that is in its conversation's `stageOrder`) ends evaluation; one that does not resolve fires nothing, pushes
 * nothing and evaluation goes on (a detour to a conversation with no stages included). Only when the turn completed
 * and no rule fired does the chat return to the most recent active detour goal (Q3/Q5/Q6), else move to the fallback
 * conversation (Q8/Q8a), else stay put.
 */
export async function decideChatRouting(input: {
  origin: RoutingOrigin;
  nextStage?: unknown;
  stageOrder?: readonly string[] | null;
  goalReached?: unknown;
  rules: readonly ScriptRule[];
  node: (loc: string) => Promise<ScriptNode | null>;
  evaluate: (rule: ScriptRule) => Promise<boolean>;
  /** The goal stack as read for this turn (the guard re-finds the chosen goal in the fresh one). */
  goalStack?: readonly GoalStackEntry[];
  /** The fallback conversation (ruling 0127 pick) with its stage list, or null when the Agent has none. */
  fallback?: { name: string; stageOrder: readonly string[] } | null;
}): Promise<ChatRoutingDecision> {
  const origin = { ...input.origin }, edits: ChatRoutingDecision['edits'] = [], result = unchanged();
  const guards: ChatRoutingDecision['guards'] = [];
  const decision = { origin, edits, guards, result };
  const completed = input.goalReached === true;
  const conversationLoc = `conversations:${origin.conversationName}`;
  if (completed && origin.conversationName) {
    result.conversationCompleted = origin.conversationName;
    edits.push(data => {
      const done = (data.completedConversations as Array<{ conversation: string; completedAt: string }> | undefined) ?? [];
      if (!done.some(entry => entry.conversation === origin.conversationName)) {
        data.completedConversations = [...done, { conversation: origin.conversationName!, completedAt: new Date().toISOString() }];
      }
      appendRouteEntry(data, { conversationUrn: conversationLoc, nodeUrn: origin.stageName ? `${conversationLoc}:${origin.stageName}` : undefined,
        action: 'COMPLETED', trigger: { type: 'GOAL_REACHED' } });
    });
  }
  // A flagged turn ignores the named stage, including for Q1's always-rule timing.
  if (!completed) {
    const stage = decideNextStage(input.nextStage, origin.stageName, input.stageOrder ?? null);
    if (stage.kind === 'rejected') {
      result.rejectedNextStage = stage.name;
      return decision;
    }
    if (stage.kind === 'stay') return decision;
    if (stage.kind === 'move') {
      const moveTo = stage.stage;
      result.stageTransitioned = true; result.newStageName = moveTo;
      edits.push(data => {
        data.stageName = moveTo;
        appendRouteEntry(data, { conversationUrn: conversationLoc, nodeUrn: `${conversationLoc}:${moveTo}`, action: 'ENTER',
          trigger: { type: 'STAGE_TRANSITION', content: `next_stage: ${moveTo}` } });
      });
      return decision;
    }
  }
  /** Leave the current conversation (when it changes) and enter `stage` of `conv`. */
  const moveTo = (data: Record<string, unknown>, conv: string, stage: string, trigger: { type: string; content?: string }, edgeUrn?: string) => {
    if (conv !== origin.conversationName && origin.conversationName) {
      appendRouteEntry(data, { conversationUrn: conversationLoc, nodeUrn: origin.stageName ? `${conversationLoc}:${origin.stageName}` : undefined, action: 'EXIT' });
    }
    data.conversationName = conv; data.stageName = stage;
    appendRouteEntry(data, { conversationUrn: `conversations:${conv}`, nodeUrn: `conversations:${conv}:${stage}`, action: 'ENTER', edgeUrn, trigger });
  };
  const note = (conv: string, stage: string) => {
    result.stageTransitioned = true; result.newStageName = stage;
    result.conversationHandoff = conv !== origin.conversationName ? conv : null;
  };
  let skippedOnCompleteRules = 0;
  try {
    // The script reader already orders by priority with its stable tiebreak. First firing target wins.
    for (const rule of input.rules) {
      const timing = (rule.data.timing as string) ?? 'on_complete';
      if (timing === 'on_complete' && !completed) skippedOnCompleteRules++;
      if (timing !== 'always' && !(timing === 'on_complete' && completed)) continue;
      if (!await input.evaluate(rule)) continue;
      const parts = rule.targetLoc?.split(':') ?? [];
      if (parts[0] !== 'conversations' || (parts.length !== 2 && parts.length !== 3) || !parts[1]) continue;
      const targetName = parts[1], targetConv = `conversations:${targetName}`;
      const order = stagesOf(await input.node(targetConv));
      const stage = parts.length === 3 ? (order.includes(parts[2]) ? parts[2] : undefined) : order[0];
      if (!stage) continue; // unresolvable: fires nothing, pushes nothing, evaluation continues
      const behavior = (rule.data.behavior as string) ?? 'transition';
      const label = (rule.data.label as string) ?? undefined;
      if (behavior === 'detour' && origin.conversationName) {
        edits.push(data => {
          pushGoal(data, { description: label ?? `Detour to ${targetName}`, createdBy: 'ASSISTANT', conversationUrn: conversationLoc,
            nodeUrn: origin.stageName ? `${conversationLoc}:${origin.stageName}` : undefined, edgeUrn: rule.id, detourTo: targetConv });
        });
      }
      note(targetName, stage);
      edits.push(data => moveTo(data, targetName, stage, { type: behavior === 'detour' ? 'DETOUR_EDGE' : 'TRANSITION_EDGE', content: label }, rule.id));
      return decision;
    }
  } finally {
    recordSkippedOnComplete(input.goalReached, skippedOnCompleteRules);
  }
  if (!completed || !origin.conversationName) return decision;
  // No rule fired. Return to the most recent active detour goal (the seed goal and legacy goals carry no detourTo).
  const stack = input.goalStack ?? [];
  for (let i = stack.length - 1; i >= 0; i--) {
    const g = stack[i];
    if (g.status !== 'ACTIVE' || typeof g.detourTo !== 'string' || !g.conversationUrn?.startsWith('conversations:')) continue;
    const conv = g.conversationUrn.split(':')[1];
    const order = stagesOf(await input.node(`conversations:${conv}`));
    // Ruling item 2 (c): a stored stage that no longer resolves returns to the first stage of the conversation left.
    const stored = g.nodeUrn?.split(':')[2];
    const stage = stored && order.includes(stored) ? stored : order[0];
    const { createdAt } = g;
    guards.push(data => {
      const fresh = (data.goalStack as GoalStackEntry[] | undefined)?.[i];
      return !!fresh && fresh.status === 'ACTIVE' && fresh.createdAt === createdAt && fresh.detourTo === g.detourTo;
    });
    const close = (data: Record<string, unknown>) => {
      const goal = (data.goalStack as GoalStackEntry[])[i];
      goal.status = 'COMPLETED'; goal.completedAt = new Date().toISOString();
    };
    if (!stage) {
      // Specs-engineer reading (Vera, #4100): the completion closes the MOST RECENT active detour goal (the detour did complete),
      // one level per return. With no stage to return to the turn has nowhere to go: Q8a below. Never an older goal in this turn.
      edits.push(close);
      break;
    }
    result.detourReturned = true; note(conv, stage);
    edits.push(data => { close(data); moveTo(data, conv, stage, { type: 'DETOUR_RETURN' }); });
    return decision;
  }
  const fb = input.fallback;
  if (fb && fb.name !== origin.conversationName && fb.stageOrder[0]) {
    const stage = fb.stageOrder[0];
    note(fb.name, stage);
    edits.push(data => moveTo(data, fb.name, stage, { type: 'GOAL_REACHED_FALLBACK' }));
  }
  return decision;
}

/** D6: call ONLY on the fresh root under updateChatRootData's existing lock. Judge the whole origin before any edit. */
export function applyChatRoutingDecision(fresh: Record<string, unknown>, decision: ChatRoutingDecision): ChatRoutingResult {
  if (fresh.conversationName !== decision.origin.conversationName || fresh.stageName !== decision.origin.stageName) {
    return { ...unchanged(), routingSkipped: true };
  }
  if (!decision.guards.every(guard => guard(fresh))) return { ...unchanged(), routingSkipped: true };
  for (const edit of decision.edits) edit(fresh);
  return { ...decision.result };
}
