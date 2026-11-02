/** #3096 / hrn:node:hadronmemory.com:specs:cor:dmo:150:08 (ruling0066=A).
 * A client report is bounded prompt/record text, never a model selection or an authority/billing signal.
 * Omission and null mean unspecified for THIS call. Preserve printable text literally; the platform-variable
 * substitution is one pass and must not interpret tokens in a reported value. Refusals never echo it.
 */
import { GraphQLError } from 'graphql';

export function clientReportedChatModel(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 256 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) {
    throw new GraphQLError('Invalid client-reported chat model.', { extensions: { code: 'BAD_USER_INPUT' } });
  }
  return value;
}
