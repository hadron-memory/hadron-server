/**
 * #4005 — the chat turn's tool-choice decision, owned by the server in ONE
 * place (cor:dmo:050:10: the model id is judged verbatim, never normalised).
 *
 * A chat turn offers the model one `respond` tool. Most models are sent a
 * FORCED choice of that tool. A few reject a forced choice outright (a 400
 * whatever the thinking settings), so they get the provider-supported `auto`
 * and the turn tells them to answer by calling the tool.
 *
 * The decision is exposed on the ordinary chat path (`ChatAiConfigChoice.toolChoice`)
 * and used by the saved-config Test's chat probe, so the two can never
 * disagree. The ids are exact and verbatim: a suffix, a case variant, an
 * unlisted model or another provider is FORCED. Nothing here is inferred
 * from a prefix or a family name.
 *
 * Source of the lists: the portal's own table at the time of the move
 * (portal AUTO_TOOL_CHOICE_ANTHROPIC_MODELS, #1979, and the Bedrock model-card
 * IDs, #2031), so adopting the server decision changes no emitted request.
 */

export type ChatToolChoice = 'AUTO' | 'FORCED';

const AUTO_ANTHROPIC_MODELS: ReadonlySet<string> = new Set([
  'claude-sonnet-5-5',
  'claude-opus-5-5',
  'claude-fable-5-2',
]);

const AUTO_BEDROCK_MODELS: ReadonlySet<string> = new Set([
  'anthropic.claude-sonnet-5-5',
  'us.anthropic.claude-sonnet-5-5',
  'eu.anthropic.claude-sonnet-5-5',
  'au.anthropic.claude-sonnet-5-5',
  'global.anthropic.claude-sonnet-5-5',
  'anthropic.claude-opus-5-5',
  'us.anthropic.claude-opus-5-5',
  'eu.anthropic.claude-opus-5-5',
  'au.anthropic.claude-opus-5-5',
  'jp.anthropic.claude-opus-5-5',
  'global.anthropic.claude-opus-5-5',
  'anthropic.claude-fable-5-2',
  'us.anthropic.claude-fable-5-2',
  'global.anthropic.claude-fable-5-2',
]);

/** The one decision: AUTO for the exact listed (provider, model) pairs, FORCED for everything else. */
export function chatToolChoiceFor(provider: string, model: string): ChatToolChoice {
  if (provider === 'anthropic' && AUTO_ANTHROPIC_MODELS.has(model)) return 'AUTO';
  if (provider === 'bedrock' && AUTO_BEDROCK_MODELS.has(model)) return 'AUTO';
  return 'FORCED';
}

/** The AI SDK `toolChoice` a request for that decision carries. */
export function sdkToolChoiceFor(choice: ChatToolChoice): 'auto' | { type: 'tool'; toolName: 'respond' } {
  return choice === 'AUTO' ? 'auto' : { type: 'tool', toolName: 'respond' };
}

/**
 * Added to the system text of a turn that is sent `auto` (never stored),
 * because `auto`, unlike a forced choice, lets the model answer in text.
 * Verbatim the portal's RESPOND_ONCE_INSTRUCTION.
 */
export const RESPOND_ONCE_INSTRUCTION =
  'Respond by calling the respond tool exactly once. Do not answer in free text.';
