/** #4036 / cor:cht:030:02: shared turn routing and locked-origin application; S4 adds stage targets and detour returns. */
import type { ScriptNode, ScriptRule } from './chatScript.js';

export interface GoalStackEntry {
  description: string;
  language?: string;
  createdAt: string;
  createdBy: 'ASSISTANT' | 'USER';
  topicUrn?: string;
  conversationUrn?: string;
  nodeUrn?: string;
  edgeUrn?: string;
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
}
export interface ChatRoutingDecision {
  origin: RoutingOrigin;
  edits: Array<(data: Record<string, unknown>) => void>;
  result: ChatRoutingResult;
}
const unchanged = (): ChatRoutingResult => ({ stageTransitioned: false, newStageName: null, conversationHandoff: null, conversationCompleted: null, detourReturned: false, routingSkipped: false });

/**
 * Decide one turn using the pinned script supplied by the caller. No database or locks here; the callbacks only read
 * script nodes/evaluate conditions. Existing stage-target fallthrough and empty-conversation detour push+stop stay
 * unchanged until S4. Completion with no firing rule stays put in S3 (released with S4/S8, never alone).
 */
export async function decideChatRouting(input: {
  origin: RoutingOrigin;
  nextStage?: string;
  goalReached?: unknown;
  rules: readonly ScriptRule[];
  node: (loc: string) => Promise<ScriptNode | null>;
  evaluate: (rule: ScriptRule) => Promise<boolean>;
}): Promise<ChatRoutingDecision> {
  const origin = { ...input.origin }, edits: ChatRoutingDecision['edits'] = [], result = unchanged();
  const decision = { origin, edits, result };
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
  if (input.nextStage && !completed) {
    if (input.nextStage !== origin.stageName) {
      result.stageTransitioned = true; result.newStageName = input.nextStage;
      edits.push(data => {
        data.stageName = input.nextStage;
        appendRouteEntry(data, { conversationUrn: conversationLoc, nodeUrn: `${conversationLoc}:${input.nextStage}`, action: 'ENTER',
          trigger: { type: 'STAGE_TRANSITION', content: `next_stage: ${input.nextStage}` } });
      });
    }
    return decision;
  }
  // The script reader already orders by priority with its stable tiebreak. First firing conversation target wins.
  for (const rule of input.rules) {
    const timing = (rule.data.timing as string) ?? 'on_complete';
    if (timing !== 'always' && !(timing === 'on_complete' && completed)) continue;
    if (!await input.evaluate(rule)) continue;
    const targetLoc = rule.targetLoc;
    if (!targetLoc?.startsWith('conversations:') || targetLoc.split(':').length !== 2) continue;
    const targetName = targetLoc.split(':')[1];
    const behavior = (rule.data.behavior as string) ?? 'transition';
    if (behavior === 'detour') edits.push(data => {
      pushGoal(data, { description: (rule.data.label as string) ?? `Detour to ${targetName}`, createdBy: 'ASSISTANT', conversationUrn: targetLoc });
    });
    const target = await input.node(targetLoc);
    const stages = ((target?.data as Record<string, unknown> | undefined)?.stageOrder as string[] | undefined) ?? [];
    if (stages[0]) {
      const firstStage = stages[0];
      result.conversationHandoff = targetName; result.stageTransitioned = true; result.newStageName = firstStage;
      edits.push(data => {
        data.conversationName = targetName; data.stageName = firstStage;
        appendRouteEntry(data, { conversationUrn: targetLoc, nodeUrn: `${targetLoc}:${firstStage}`, action: 'ENTER', edgeUrn: rule.id,
          trigger: { type: behavior === 'detour' ? 'DETOUR_EDGE' : 'TRANSITION_EDGE', content: (rule.data.label as string) ?? undefined } });
      });
    }
    break;
  }
  return decision;
}

/** D6: call ONLY on the fresh root under updateChatRootData's existing lock. Judge the whole origin before any edit. */
export function applyChatRoutingDecision(fresh: Record<string, unknown>, decision: ChatRoutingDecision): ChatRoutingResult {
  if (fresh.conversationName !== decision.origin.conversationName || fresh.stageName !== decision.origin.stageName) {
    return { ...unchanged(), routingSkipped: true };
  }
  for (const edit of decision.edits) edit(fresh);
  return { ...decision.result };
}
