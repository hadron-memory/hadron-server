/**
 * #4035 (Know Yourself engine S2; cor:cht:030:02 mechanism 1, ruling Q4): what a turn's `next_stage` means.
 *
 * A model names the stage it wants next as free text. A name that is not one of the conversation's stages
 * moves nothing and is reported back as `rejectedNextStage`; the turn itself is still recorded.
 * Pure so the routing module (S3) can absorb it unchanged.
 */
import type { ChatScript } from '../chatScript.js';

export type NextStageDecision =
  /** The turn named no stage (null, absent or empty): the rules run as before. */
  | { kind: 'none' }
  /** The turn named the stage the chat is already in: no move, not a rejection (R2). */
  | { kind: 'stay' }
  | { kind: 'move'; stage: string }
  /** The turn named something that is not one of the conversation's stages: no move, and the rules do not run (R1). */
  | { kind: 'rejected'; name: string };

/**
 * `stageOrder` is null when the conversation's stage list could not be read; the name is then taken as before
 * (there is nothing to check it against).
 */
export function decideNextStage(
  nextStage: unknown,
  currentStage: string | null | undefined,
  stageOrder: readonly string[] | null,
): NextStageDecision {
  if (nextStage === null || nextStage === undefined || nextStage === '') return { kind: 'none' };
  if (typeof nextStage !== 'string') return { kind: 'rejected', name: String(nextStage) };
  if (nextStage === currentStage) return { kind: 'stay' };
  if (stageOrder !== null && !stageOrder.includes(nextStage)) return { kind: 'rejected', name: nextStage };
  return { kind: 'move', stage: nextStage };
}

/** The conversation's stage names, from the script the chat is pinned to; null when the conversation is not there. */
export async function conversationStageOrder(script: ChatScript, convName: string | null): Promise<string[] | null> {
  if (!convName) return null;
  const conv = await script.node(`conversations:${convName}`);
  if (!conv) return null;
  const order = ((conv.data as Record<string, unknown> | null)?.stageOrder as unknown);
  return Array.isArray(order) ? order.filter((s): s is string => typeof s === 'string') : [];
}
