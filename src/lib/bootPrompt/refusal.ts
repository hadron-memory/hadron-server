/**
 * #2047 (S10, cor:agt:040:10, R26/R27/R35/R36) — the one typed refusal for serving a boot prompt.
 *
 * A bind, a chatbot chat and a headless run are refused by the same mechanism, so every surface builds its error here
 * and the codes cannot drift. The list is closed and is the one list #2045 and #2047 agreed (NOT_SET is canonical;
 * #2045's MISSING is a superseded alias that is never emitted). The error names the surface and the Agent only: no node
 * id, loc, revision or pointer, because an end user's chat refusal must not disclose the compiled node's identity.
 */
import { GraphQLError } from 'graphql';

export const BOOT_PROMPT_REFUSAL_CODES = [
  'BOOT_PROMPT_NOT_SET',
  'BOOT_PROMPT_TARGET_DELETED',
  'BOOT_PROMPT_NOT_APPROVED',
  'BOOT_PROMPT_NOT_SIGNED',
  'BOOT_PROMPT_RECORDED_REVISION_DELETED',
] as const;

export type BootPromptRefusalCode = (typeof BOOT_PROMPT_REFUSAL_CODES)[number];
export type BootPromptSurface = 'bind' | 'chat' | 'run';

const MESSAGES: Record<BootPromptRefusalCode, string> = {
  BOOT_PROMPT_NOT_SET: 'No boot prompt is set for this Agent, so it cannot be served.',
  BOOT_PROMPT_TARGET_DELETED: "This Agent's boot prompt was deleted, so it cannot be served.",
  BOOT_PROMPT_NOT_APPROVED: "This Agent's boot prompt has no approved revision, so it cannot be served.",
  BOOT_PROMPT_NOT_SIGNED: "This Agent's boot prompt has no signed revision, so it cannot be served.",
  BOOT_PROMPT_RECORDED_REVISION_DELETED: 'The boot prompt revision this session was given has been deleted.',
};

export function bootPromptRefusal(
  code: BootPromptRefusalCode,
  where: { surface: BootPromptSurface; agentName: string },
): GraphQLError {
  return new GraphQLError(MESSAGES[code], {
    extensions: { code, surface: where.surface, agentName: where.agentName },
  });
}
