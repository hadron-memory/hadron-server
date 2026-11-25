import { GraphQLError } from 'graphql';
import { ownerId, ownerType, type OwnerRef } from '../owner.js';
import { OWNER_LIMIT_KEYS, type OwnerLimitKey } from './keys.js';

/** The message of the form that names no owner and no number (#5009); also the text a stored record keeps (#5015). */
export const OWNER_LIMIT_NO_NUMBER_MESSAGE = 'The owner of this memory has reached a limit of their account.';

/**
 * An owner has reached a limit (#5009). Three forms, so a caller learns only what they may:
 * - the limited person, or an OWNER or ADMIN of the limited organization: the owner's id and the limit;
 * - anyone else, or no caller: neither, and no number in the message. A level is defined by its limit, so the number would tell a
 *   writer in someone else's memory which level its owner is on.
 * Registered in `CLIENT_ERROR_MAPPINGS` (formatError.ts). The extensions are the contract the CLI and the portal read.
 */
export class OwnerLimitReachedError extends GraphQLError {
  constructor(args: { key: OwnerLimitKey; owner: OwnerRef; limit: bigint; callerCanManageOwner: boolean }) {
    const type = ownerType(args.owner);
    const noun = OWNER_LIMIT_KEYS[args.key].unitNoun;
    const amount = `${args.limit} ${args.limit === 1n ? noun.one : noun.many}`;
    const message = !args.callerCanManageOwner
      ? OWNER_LIMIT_NO_NUMBER_MESSAGE
      : `${type === 'user' ? 'Your account' : 'This organization'} has reached its limit of ${amount}.`;
    super(message, {
      extensions: {
        code: 'OWNER_LIMIT_REACHED',
        limitKey: args.key,
        ownerType: type,
        callerCanManageOwner: args.callerCanManageOwner,
        ...(args.callerCanManageOwner ? { ownerId: ownerId(args.owner), limit: args.limit.toString() } : {}),
      },
    });
    this.name = 'OwnerLimitReachedError';
  }
}

/**
 * #5015 (cor:agt:010:03, issue step 12): a run tool that creates a node hands an owner-limit refusal to the model as the
 * tool's own error and the run goes on. A handler throw is terminal (`TOOL_FAILED`, D-TL-6), so the tools return this
 * result instead of throwing. The fields are the refusal's own, already in the form for the run's caller.
 */
export function ownerLimitToolError(err: unknown): { error: Record<string, unknown> } | null {
  if (!(err instanceof OwnerLimitReachedError)) return null;
  return { error: { ...err.extensions, message: err.message } };
}
